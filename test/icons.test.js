// İkon seti: gömülü kopya dosyayla aynı mı, kullanılan her #i-… adı sette var mı, tema → set eşlemesi tutarlı mı.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
const symbolIds = (svg) => [...svg.matchAll(/<symbol id="(i-[a-z0-9-]+)"/g)].map((m) => m[1]);
const symbolsOf = (svg) => [...svg.matchAll(/<symbol [\s\S]*?<\/symbol>/g)].map((m) => m[0]);

// Bir çağrının n. argümanını (0'dan) metin olarak döndürür: parantez/tırnak derinliğini izler.
function arg(src, start, n) {
  let depth = 0, i = start, quote = null, idx = 0, from = start;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      if (depth === 0) break;
      depth--;
    } else if (c === ',' && depth === 0) {
      if (idx === n) return src.slice(from, i);
      idx++;
      from = i + 1;
    }
  }
  return idx === n ? src.slice(from, i) : '';
}

// Bütün ikon başvuruları: { name, where } ve adı değişkenden gelen çağrılar.
function references() {
  const refs = [];
  const dynamic = [];
  const files = ['index.html', ...fs.readdirSync(PUB).filter((f) => f.endsWith('.js') && !f.endsWith('.min.js'))];
  for (const file of files) {
    const src = read(file);
    const line = (i) => src.slice(0, i).split('\n').length;
    // index.html'deki gömülü set başvuru değildir
    const body = file === 'index.html' ? src.replace(/<svg id="ui-icons"[\s\S]*?<\/svg><!-- \/ui-icons -->/, '') : src;
    for (const m of body.matchAll(/#i-([a-z0-9-]+)/g)) {
      if (m[1].endsWith('-')) continue; // href="#i-${name}" kalıbı
      refs.push({ name: `i-${m[1]}`, where: `${file}:${line(m.index)}` });
    }
    if (!file.endsWith('.js')) continue;
    for (const m of src.matchAll(/(?<![\w.])(setIcon|icon)\(/g)) {
      const a = arg(src, m.index + m[0].length, m[1] === 'setIcon' ? 1 : 0).trim();
      if (/^function|^name$/.test(a) || src.slice(m.index - 9, m.index) === 'function ') continue; // tanımlar
      const lits = [...a.matchAll(/'([a-z0-9-]+)'/g)].map((x) => x[1]);
      if (!lits.length) dynamic.push(`${file}:${line(m.index)} ${m[1]}(${a})`);
      for (const n of lits) refs.push({ name: `i-${n}`, where: `${file}:${line(m.index)}` });
    }
  }
  return { refs, dynamic };
}

test('gömülü ikon kopyası public/icons/ui/lucide.svg ile aynı', () => {
  const html = read('index.html');
  const block = html.match(/<svg id="ui-icons"[^>]*data-set="lucide"[^>]*>([\s\S]*?)<\/svg><!-- \/ui-icons -->/);
  assert.ok(block, 'index.html içinde <svg id="ui-icons" data-set="lucide"> yok');
  assert.deepStrictEqual(symbolsOf(block[1]), symbolsOf(read('icons/ui/lucide.svg')));
  assert.ok(fs.existsSync(path.join(PUB, 'icons/ui/LICENSE-lucide')), 'Lucide lisans dosyası yok');
});

test('kullanılan her ikon adı sette var; set renk/kalınlık taşımaz', () => {
  const svg = read('icons/ui/lucide.svg');
  const ids = new Set(symbolIds(svg));
  assert.strictEqual(ids.size, symbolIds(svg).length, 'aynı ad iki kez');
  const { refs, dynamic } = references();
  const missing = refs.filter((r) => !ids.has(r.name));
  const used = new Set(refs.map((r) => r.name));
  if (process.env.ICONS_REPORT) {
    console.log(`set: ${ids.size} ikon; başvuru: ${refs.length} (${used.size} farklı ad); eksik: ${missing.length}`);
    console.log(`değişkenden gelen ad: ${dynamic.join(' | ') || 'yok'}`);
    console.log(`kullanılmayan: ${[...ids].filter((n) => !used.has(n)).join(' ') || 'yok'}`);
  }
  assert.deepStrictEqual(missing, []);
  assert.ok(!/stroke-width|stroke="(?!none)|fill="(?!currentColor|none)/.test(svg), 'sette sabit renk/kalınlık var');
});

test('public/icons/ui altındaki her set aynı ikon adlarını taşır; lisansı yanında', () => {
  const sets = fs.readdirSync(path.join(PUB, 'icons/ui')).filter((f) => f.endsWith('.svg'));
  assert.ok(sets.includes('lucide.svg') && sets.includes('piksel.svg'), sets.join(' '));
  const want = symbolIds(read('icons/ui/lucide.svg')).sort();
  for (const f of sets) {
    const svg = read(`icons/ui/${f}`);
    assert.deepStrictEqual(symbolIds(svg).sort(), want, f);
    // XML olarak ayrıştırılır (theme.js DOMParser): yorumun içinde "--" olamaz
    for (const c of svg.matchAll(/<!--([\s\S]*?)-->/g)) assert.ok(!c[1].includes('--'), `${f}: yorumda "--"`);
    const lic = f === 'lucide.svg' ? 'LICENSE-lucide' : `LICENSE-${svg.match(/<!-- (\w+)/)[1].toLowerCase()}`;
    assert.ok(fs.existsSync(path.join(PUB, 'icons/ui', lic)), `${f}: ${lic} yok`);
  }
});

test('piksel set dolu ve keskin: her sembol kendi dolgusunu taşır, başka renk yok', () => {
  const { INNER_STYLE } = require('./tools/icons');
  const svg = read('icons/ui/piksel.svg');
  for (const s of symbolsOf(svg)) {
    assert.match(s, /^<symbol id="i-[a-z0-9-]+" viewBox="0 0 24 24"><g fill="currentColor" stroke="none" shape-rendering="crispEdges">/, s.slice(0, 80));
    // Tek izin verilen renk: dolu durumun iç boşluğu (kural --ic-fill verir, yoksa saydam)
    const body = s.replace(/^<symbol[^>]*><g[^>]*>/, '').replaceAll(`style="${INNER_STYLE}" `, '');
    assert.ok(!/fill=|stroke|opacity|style=|<text/.test(body), s.slice(0, 80));
  }
});

// Üreticinin depodaki girdileri (elle çizilen ızgaralar, iç dolgular) sprite ile birebir aynı mı. Pixelarticons'tan
// alınan 60 ikonun kaynağı depoda değil (ağ kullanılmaz): onlar için yalnız ad eşlemesi denetlenir.
test('piksel set üreticiyle tutarlı: elle çizilenler ve dolu durumlar yeniden üretilince aynı', () => {
  const { MAP, PIXEL_MAP, PIXEL_DRAWN, PIXEL_INNER, INNER_STYLE, gridPath, PIXEL_G } = require('./tools/icons');
  assert.deepStrictEqual(Object.keys(MAP).filter((n) => !PIXEL_MAP[n] && !PIXEL_DRAWN[n]), [], 'piksel karşılığı olmayan ikon');
  assert.deepStrictEqual(Object.keys(MAP).filter((n) => PIXEL_MAP[n] && PIXEL_DRAWN[n]), [], 'iki kaynaktan gelen ikon');
  const bySym = Object.fromEntries(symbolsOf(read('icons/ui/piksel.svg')).map((s) => [s.match(/id="i-([a-z0-9-]+)"/)[1], s]));
  for (const name of Object.keys(PIXEL_DRAWN)) {
    const fill = PIXEL_INNER[name] ? `<path style="${INNER_STYLE}" d="${PIXEL_INNER[name]}"/>` : '';
    assert.strictEqual(bySym[name], `<symbol id="i-${name}" viewBox="0 0 24 24">${PIXEL_G}${gridPath(PIXEL_DRAWN[name])}${fill}</g></symbol>`, name);
  }
  for (const name of Object.keys(PIXEL_INNER)) assert.ok(bySym[name].endsWith(`<path style="${INNER_STYLE}" d="${PIXEL_INNER[name]}"/></g></symbol>`), name);
});

test('her temanın bir ikon seti var ve dosyası duruyor', () => {
  const src = read('theme.js');
  const list = JSON.parse(src.match(/const LIST = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  const sets = Object.fromEntries([...src.match(/const ICON_SETS = \{([^}]*)\}/)[1].matchAll(/(\w+): '([\w-]+)'/g)].map((m) => [m[1], m[2]]));
  for (const id of list) {
    assert.ok(sets[id], `${id} temasının ikon seti yok`);
    assert.ok(fs.existsSync(path.join(PUB, 'icons/ui', `${sets[id]}.svg`)), `${sets[id]}.svg yok`);
  }
});

test('icon() yalnız güvenli adları kabul eder', () => {
  // app.js tarayıcı betiği; icon() DOM'a dokunmadığı için kaynağından alınıp ayrı çalıştırılır.
  const src = read('app.js').match(/\nfunction icon\(name\) \{[\s\S]*?\n\}/);
  assert.ok(src, 'app.js içinde icon() yok');
  const icon = new Function(`${src[0]}; return icon;`)();
  assert.match(icon('mic-off'), /href="#i-mic-off"/);
  for (const bad of ['x"><img src=x onerror=alert(1)>', 'Mic', 'a b', '', '../x', null, undefined, 5]) {
    assert.throws(() => icon(bad), /Geçersiz ikon adı/, String(bad));
  }
});
