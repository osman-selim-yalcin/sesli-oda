#!/usr/bin/env node
// Arayüz ikon setlerini üretir.
// 1) Lucide (varsayılan set): public/icons/ui/lucide.svg ve index.html'deki gömülü kopya (<svg id="ui-icons">).
//    Kaynak: Lucide 1.77.0 sürüm paketi (github.com/lucide-icons/lucide/releases, lucide-icons-1.77.0.zip),
//    açılmış "icons" klasörü. Yalnız aşağıdaki tablodaki ikonlar alınır; çizgi rengi/kalınlığı CSS'ten (.ic) gelir.
// 2) Piksel (Piksel Oda teması): public/icons/ui/piksel.svg. Kaynak: Pixelarticons 2.4.2
//    (github.com/halfmage/pixelarticons, MIT, depo arşivinin "svg" klasörü) + Pixelarticons'ta karşılığı olmayan
//    ikonlar için aşağıda aynı ızgarada (24×24, 2 birimlik piksel) elle çizilen ikonlar (PIXEL_DRAWN).
//    Piksel ikonlar doludur: her sembol kendi dolgusunu taşır (<g fill="currentColor" stroke="none">), böylece
//    .ic'nin çizgi kuralları (Lucide için) piksel sete dokunmaz; shape-rendering="crispEdges" kenarları keskin tutar.
// Her iki çalıştırma test/tools/components.html'deki vitrin kopyasını da (iki set) günceller.
//
// Kullanım:
//   node test/tools/icons.js <lucide-icons-klasörü>
//   node test/tools/icons.js --piksel <pixelarticons-svg-klasörü>
//
// Gömülü kopya ilk boyamada ikon olsun diye vardır (dosya gelene kadar boş kare görünmez);
// test/icons.test.js iki kopyanın aynı olduğunu ve kullanılan her #i-… adının sette bulunduğunu denetler.
// Bu dosya bir test değildir; `npm test` yalnız *.test.js dosyalarını çalıştırır.
const fs = require('fs');
const path = require('path');

// Bizim ad → Lucide ikonu. Başka bir set (ör. piksel tema) aynı adları kendi çizimiyle verir.
const MAP = {
  play: 'play', pause: 'pause', skip: 'skip-forward', prev: 'skip-back',
  back5: 'rotate-ccw', fwd5: 'rotate-cw',
  volume: 'volume-2', 'volume-x': 'volume-x', party: 'party-popper', settings: 'settings-2',
  mic: 'mic', 'mic-off': 'mic-off', gate: 'audio-lines', screen: 'screen-share',
  rec: 'circle-dot', stop: 'square', clip: 'paperclip',
  smile: 'face-slightly-smiling', 'smile-plus': 'face-slightly-smiling-plus',
  x: 'x', plus: 'plus', check: 'check', like: 'thumbs-up', dislike: 'thumbs-down',
  send: 'send', link: 'link', logout: 'log-out', expand: 'maximize', heart: 'heart',
  search: 'search', globe: 'globe', locate: 'navigation', minus: 'minus', shuffle: 'shuffle',
  radio: 'radio', music: 'eighth-notes', playlist: 'list-music', upload: 'upload',
  activity: 'activity', chevron: 'chevron-down', users: 'users', trophy: 'trophy',
  image: 'image', up: 'chevron-up', back: 'chevron-left', loader: 'loader-circle',
  // Aşama 2'de eklenenler
  lock: 'lock', unlock: 'lock-open', door: 'door-open', crown: 'crown', merge: 'merge',
  split: 'split', palette: 'palette', key: 'key-round', bell: 'bell', user: 'user',
  shield: 'shield', home: 'house', gamepad: 'gamepad-2', message: 'message-circle',
  list: 'list', history: 'rotate-ccw-clock', trash: 'trash', edit: 'pencil', copy: 'copy',
  info: 'info', alert: 'triangle-exclamation-point', bot: 'bot', timer: 'timer',
  undo: 'undo-2', sparkles: 'sparkles',
  // Oda çerçevesi (Task 5)
  more: 'ellipsis', cog: 'settings',
};

// 5 sn geri/ileri: ok çizgisinin ortasına "5" (yazı tipi düğmeden miras kalır). Düğmede 22 px çizilir:
// 12 birim = 11 px kalın rakam (okunur en küçük boy).
const EXTRA = {
  back5: '<text x="12" y="16.4" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor" stroke="none">5</text>',
  fwd5: '<text x="12" y="16.4" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor" stroke="none">5</text>',
};

// Bizim ad → Pixelarticons ikonu (MAP ile aynı adlar; eksik kalanlar PIXEL_DRAWN'da).
const PIXEL_MAP = {
  play: 'play', pause: 'pause', volume: 'volume-2', 'volume-x': 'volume-x', party: 'party-popper',
  settings: 'sliders-horizontal', mic: 'mic', 'mic-off': 'mic-off', gate: 'audio-waveform', screen: 'airplay',
  stop: 'square', clip: 'attachment', smile: 'smile', x: 'close', plus: 'plus', check: 'check',
  like: 'thumbs-up', dislike: 'thumbs-down', send: 'send', link: 'link', logout: 'logout', heart: 'heart',
  search: 'search', globe: 'globe', locate: 'gps', minus: 'minus', shuffle: 'shuffle', radio: 'radio',
  music: 'music', upload: 'upload', chevron: 'chevron-down', users: 'users', trophy: 'trophy', image: 'image',
  up: 'chevron-up', back: 'chevron-left', loader: 'loader', lock: 'lock', unlock: 'unlock', door: 'door-closed',
  crown: 'crown', merge: 'git-merge', split: 'git-branch', palette: 'colors-swatch', key: 'key', bell: 'bell',
  user: 'user', shield: 'shield', home: 'home', gamepad: 'gamepad', message: 'message', list: 'bulletlist',
  history: 'clock', trash: 'trash', edit: 'pencil', copy: 'copy', info: 'info-box', bot: 'robot',
  timer: 'hourglass', undo: 'undo', sparkles: 'sparkles', more: 'more-horizontal', cog: 'settings-cog',
};

// Elle çizilen piksel ikonlar: 12×12 ızgara, "#" = dolu 2×2 birimlik piksel (24×24 görünümde).
const PIXEL_DRAWN = {
  // Sonraki / önceki: çerçeve üçgen + çubuk (prev = skip'in aynası)
  skip: [
    '............',
    '..#......#..',
    '..##.....#..',
    '..#.#....#..',
    '..#..#...#..',
    '..#...#..#..',
    '..#...#..#..',
    '..#..#...#..',
    '..#.#....#..',
    '..##.....#..',
    '..#......#..',
    '............',
  ],
  // 5 sn geri: saat yönünün tersine dönen ok (sol yanda aşağı bakan uç) + ortada piksel "5"
  back5: [
    '...######...',
    '..#......#..',
    '.#..###...#.',
    '.#..#......#',
    '###.###....#',
    '.#....#....#',
    '......#....#',
    '....###....#',
    '...........#',
    '..#.......#.',
    '...#######..',
    '............',
  ],
  // 5 sn ileri: aynı okun aynası, rakam düz
  fwd5: [
    '...######...',
    '..#......#..',
    '.#...###..#.',
    '#....#....#.',
    '#....###.###',
    '#......#..#.',
    '#......#....',
    '#....###....',
    '#...........',
    '.#.......#..',
    '..#######...',
    '............',
  ],
  // Kayıt: halka + dolu orta
  rec: [
    '............',
    '...######...',
    '..#......#..',
    '.#........#.',
    '.#..####..#.',
    '.#..####..#.',
    '.#..####..#.',
    '.#..####..#.',
    '.#........#.',
    '..#......#..',
    '...######...',
    '............',
  ],
  // Emoji ekle: yüz + sağ üstte artı
  'smile-plus': [
    '.........#..',
    '........###.',
    '.........#..',
    '..####......',
    '.#....#.....',
    '#.#..#.#....',
    '#......#....',
    '#.#..#.#....',
    '#..##..#....',
    '.#....#.....',
    '..####......',
    '............',
  ],
  // Tam ekran: dört köşe
  expand: [
    '............',
    '.###....###.',
    '.#........#.',
    '.#........#.',
    '............',
    '............',
    '............',
    '............',
    '.#........#.',
    '.#........#.',
    '.###....###.',
    '............',
  ],
  // Çalma listesi: üç satır + nota
  playlist: [
    '............',
    '.#######....',
    '............',
    '.#######.#..',
    '.........##.',
    '.#####...#.#',
    '.........#..',
    '.#####...#..',
    '.......###..',
    '......####..',
    '.......##...',
    '............',
  ],
  // Etkinlik: nabız çizgisi
  activity: [
    '............',
    '....#.......',
    '....#.......',
    '...#.#......',
    '...#.#......',
    '...#.#......',
    '###...#..###',
    '......#..#..',
    '......#..#..',
    '.......##...',
    '............',
    '............',
  ],
  // Uyarı: üçgen + ünlem
  alert: [
    '.....##.....',
    '....#..#....',
    '....#..#....',
    '...#....#...',
    '...#.##.#...',
    '..#..##..#..',
    '..#..##..#..',
    '.#........#.',
    '.#...##...#.',
    '#..........#',
    '############',
    '............',
  ],
};
PIXEL_DRAWN.prev = PIXEL_DRAWN.skip.map((row) => [...row].reverse().join(''));

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'public', 'icons', 'ui', 'lucide.svg');
const HTML = path.join(ROOT, 'public', 'index.html');
const START = '<svg id="ui-icons"';
const END = '</svg><!-- /ui-icons -->';

function inner(file) {
  const src = fs.readFileSync(file, 'utf8');
  const body = src.slice(src.indexOf('>', src.indexOf('<svg')) + 1, src.lastIndexOf('</svg>'));
  return body.split('\n').map((l) => l.trim()).filter(Boolean).join('').replace(/\s*\/>/g, '/>');
}

function symbols(dir) {
  return Object.entries(MAP).map(([name, lucide]) =>
    `<symbol id="i-${name}" viewBox="0 0 24 24">${inner(path.join(dir, `${lucide}.svg`))}${EXTRA[name] || ''}</symbol>`);
}

// 12×12 ızgarayı tek bir yola çevirir: her satırdaki ardışık dolu pikseller tek dikdörtgen.
function gridPath(rows) {
  if (rows.length !== 12 || rows.some((r) => r.length !== 12 || /[^#.]/.test(r))) throw new Error(`ızgara 12×12 değil: ${rows.join('/')}`);
  let d = '';
  rows.forEach((row, y) => {
    for (const m of row.matchAll(/#+/g)) d += `M${m.index * 2} ${y * 2}h${m[0].length * 2}v2h-${m[0].length * 2}z`;
  });
  return `<path d="${d}"/>`;
}

// Pixelarticons dosyasının iç yolları (dış <svg> ve onun fill'i atılır; iç öğelerde renk yok).
function pixelInner(file) {
  const body = inner(file);
  if (/fill=|stroke|opacity/.test(body)) throw new Error(`beklenmeyen renk/saydamlık: ${file}`);
  return body;
}

const PIXEL_G = '<g fill="currentColor" stroke="none" shape-rendering="crispEdges">';
function pixelSymbols(dir) {
  return Object.keys(MAP).map((name) => {
    const body = PIXEL_DRAWN[name] ? gridPath(PIXEL_DRAWN[name]) : pixelInner(path.join(dir, `${PIXEL_MAP[name]}.svg`));
    if (!body) throw new Error(`piksel ikon yok: ${name}`);
    return `<symbol id="i-${name}" viewBox="0 0 24 24">${PIXEL_G}${body}</g></symbol>`;
  });
}

// Vitrin (test/tools/components.html): iki setin kopyası. Lucide <svg id="ui-icons"> içinde (varsayılan),
// piksel set <template id="icons-piksel"> içinde (vitrin ?tema=piksel ile açılınca yerine geçer).
const SHOWCASE = path.join(ROOT, 'test', 'tools', 'components.html');
function showcase(set, syms) {
  const [start, end] = set === 'lucide'
    ? ['<svg id="ui-icons" xmlns="http://www.w3.org/2000/svg" hidden>', '</svg><!-- /ui-icons -->']
    : ['<template id="icons-piksel"><svg xmlns="http://www.w3.org/2000/svg">', '</svg></template><!-- /icons-piksel -->'];
  const html = fs.readFileSync(SHOWCASE, 'utf8');
  const a = html.indexOf(start);
  const b = html.indexOf(end);
  if (a < 0 || b < 0) throw new Error(`components.html içinde ${start} … ${end} bulunamadı`);
  fs.writeFileSync(SHOWCASE, `${html.slice(0, a)}${start}\n${syms.map((s) => `    ${s}`).join('\n')}\n  ${end}${html.slice(b + end.length)}`);
}

function mainPiksel(dir) {
  const syms = pixelSymbols(dir);
  const out = path.join(ROOT, 'public', 'icons', 'ui', 'piksel.svg');
  fs.writeFileSync(out, `<svg xmlns="http://www.w3.org/2000/svg">\n<!-- Pixelarticons 2.4.2 (github.com/halfmage/pixelarticons, MIT lisansı: LICENSE-pixelarticons) + aynı ızgarada elle çizilenler (${Object.keys(PIXEL_DRAWN).sort().join(', ')}). Üretim: test/tools/icons.js, piksel kipi -->\n${syms.join('\n')}\n</svg>\n`);
  showcase('piksel', syms);
  console.log(`${syms.length} piksel ikon yazıldı: ${path.relative(ROOT, out)} ve test/tools/components.html`);
}

function main() {
  if (process.argv[2] === '--piksel') {
    if (!process.argv[3]) {
      console.error('Kullanım: node test/tools/icons.js --piksel <pixelarticons-svg-klasörü>');
      process.exit(1);
    }
    return mainPiksel(process.argv[3]);
  }
  const dir = process.argv[2];
  if (!dir) {
    console.error('Kullanım: node test/tools/icons.js <lucide-icons-klasörü>');
    process.exit(1);
  }
  const syms = symbols(dir);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `<svg xmlns="http://www.w3.org/2000/svg">\n<!-- Lucide 1.77.0 (lucide.dev, ISC lisansı: LICENSE-lucide). Üretim: test/tools/icons.js -->\n${syms.join('\n')}\n</svg>\n`);
  showcase('lucide', syms);

  const html = fs.readFileSync(HTML, 'utf8');
  const a = html.indexOf(START);
  const b = html.indexOf(END);
  if (a < 0 || b < 0) throw new Error('index.html içinde <svg id="ui-icons"> … </svg><!-- /ui-icons --> bulunamadı');
  const block = `${START} xmlns="http://www.w3.org/2000/svg" data-set="lucide" hidden>\n${syms.map((s) => `    ${s}`).join('\n')}\n  ${END}`;
  fs.writeFileSync(HTML, html.slice(0, a) + block + html.slice(b + END.length));
  console.log(`${syms.length} ikon yazıldı: ${path.relative(ROOT, OUT)} ve public/index.html`);
}

if (require.main === module) main();
module.exports = { MAP, PIXEL_MAP, PIXEL_DRAWN };
