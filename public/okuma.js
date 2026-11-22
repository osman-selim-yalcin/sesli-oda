'use strict';

// ---------- Hızlı okuma alıştırmaları ----------
// app.js ve tr-words.js'ten sonra yüklenir; $, TR_WORDS oradan gelir. Hepsi tek kişilik, sunucuya bir şey gitmez;
// en iyi sonuçlar bu tarayıcıda (localStorage) kişiye göre tutulur.
// - Göz açısı (yatay), Kademeli blok görme, Göz açısı (dikey): ortadaki noktaya bakarken çevresinde bir an
//   rakamlar görünür, gördüğünü yazarsın. Her seviyede 6 kademe; doğru bildikçe rakamlar merkezden uzaklaşır,
//   seviye arttıkça rakam sayısı çoğalır. Doğru cevap puan kazandırır, yanlış aynı kadar götürür.
// - Takistoskop: kelime(ler) çok kısa süre görünür, gördüğünü yazarsın. Seviye 1-10 gösterim süresini kısaltır.
// - Sayı tablosu: 1'den başlayıp sırayla bütün sayılara bas; gözünü ortada tutmaya çalış.

// Blok egzersizleri: seviye (d) ve kademe (k) 1'den başlar. items(d, k) gösterilecekleri {x, y (yüzde), text}
// olarak verir; focus varsa (kademeli) göz önce soldaki, sonra sağdaki bloğa yönlendirilir.
const BLOK_STEPS = 6; // her seviyede kademe sayısı
const randDigits = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
const spread = (fix, k) => fix + ((100 - fix) / 5) * (k - 1); // kademe arttıkça açılan genişlik (yüzde)
const rowX = (n, w) => Array.from({ length: n }, (_, i) => (n === 1 ? 50 : 50 - w / 2 + (w * i) / (n - 1)));

const BLOK = {
  yatay: {
    levels: 5, pts: 20,
    ms: (d) => 100 + 25 * (d - 1),
    question: (d) => randDigits(d + 1),
    // Çift sayıda rakamda ortadaki nokta iki rakamın arasında kalır (boş yer); tekte ortadaki rakam noktanın üstünde.
    items(answer, d, k) {
      const chars = answer.split('');
      if (chars.length % 2 === 0) chars.splice(chars.length / 2, 0, null);
      const xs = rowX(chars.length, spread([12, 12, 21, 21, 29][d - 1], k) * 0.92);
      return chars.map((c, i) => c && { x: xs[i], y: 50, text: c }).filter(Boolean);
    },
    hint: 'Ortadaki noktaya bak, iki yanında beliren rakamları soldan sağa yaz.',
  },
  kademeli: {
    levels: 4, pts: 40,
    ms: (d) => Math.round(250 * 1.6 ** (d - 1)),
    question: (d) => randDigits(2 * (d + 1)),
    items(answer, d, k) {
      const half = answer.length / 2;
      const w = spread([18, 24, 31, 37][d - 1], k) * 0.86;
      return [{ x: 50 - w / 2, y: 50, text: answer.slice(0, half), block: 0 }, { x: 50 + w / 2, y: 50, text: answer.slice(half), block: 1 }];
    },
    focus: true,
    hint: 'Başını oynatmadan önce soldaki sayıyı, sonra sağdakini bir bakışta gör. Önce soldakini, sonra sağdakini yaz.',
  },
  dikey: {
    levels: 3, pts: 50,
    ms: (d) => 175 + 50 * (d - 1),
    question: (d) => randDigits(d + 3),
    // Üstte ve altta üçer yer; 4 rakamda iki ortası boş, 5 rakamda üst ortası boş.
    items(answer, d, k) {
      const chars = answer.split('');
      if (d === 1) chars.splice(1, 0, null), chars.splice(4, 0, null);
      if (d === 2) chars.splice(1, 0, null);
      const xs = rowX(3, 14 + 13 * (k - 1));
      const dy = 12 + 5.5 * (k - 1);
      return chars.map((c, i) => c && { x: xs[i % 3], y: i < 3 ? 50 - dy : 50 + dy, text: c }).filter(Boolean);
    },
    hint: 'Ortadaki noktaya bak, üstünde ve altında beliren rakamları önce üst satırı, sonra alt satırı soldan sağa yaz.',
  },
};

const OKUMA_EXERCISES = [
  { key: 'yatay', title: 'Göz açısı (yatay)', icon: '↔️', desc: 'Noktanın sağında ve solunda bir an beliren rakamları gör. Doğru bildikçe rakamlar açılır.' },
  { key: 'kademeli', title: 'Kademeli blok görme', icon: '👀', desc: 'Sağda ve solda iki sayı bloğu: başını oynatmadan önce soldakini, sonra sağdakini bir bakışta gör.' },
  { key: 'dikey', title: 'Göz açısı (dikey)', icon: '↕️', desc: 'Noktanın üstünde ve altında bir an beliren rakamları gör; rakamlar dört yöne açılır.' },
  { key: 'takisto', title: 'Takistoskop', icon: '⚡', desc: 'Bir anlık gördüğün kelimeyi yaz. Seviye arttıkça süre kısalır.' },
  { key: 'tablo', title: 'Sayı tablosu', icon: '🎯', desc: "1'den başlayıp sırayla bütün sayılara bas. Gözün ortada kalsın, kenarları görmeye çalış." },
];

// Seviye -> gösterim süresi (ms)
const TAKISTO_MS = [200, 150, 125, 100, 75, 50, 30, 20, 15, 10];
const TAKISTO_SET = 10; // bir turda kaç deneme

const okumaKey = (k) => `okuma:${myName}:${k}`;
const okumaGet = (k) => {
  try { return JSON.parse(localStorage.getItem(okumaKey(k))); } catch { return null; }
};
const okumaSet = (k, v) => {
  try { localStorage.setItem(okumaKey(k), JSON.stringify(v)); } catch {}
};
const okEl = (tag, className, text) => Object.assign(document.createElement(tag), { className: className || '', ...(text != null ? { textContent: text } : {}) });
const okBtn = (text, cls, onclick) => Object.assign(document.createElement('button'), { type: 'button', className: cls || '', textContent: text, onclick });
const okPick = (list) => list[Math.floor(Math.random() * list.length)];
const okShuffle = (list) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

let okumaEx = null;     // açık alıştırma anahtarı
let okumaStop = () => {}; // açık alıştırmanın zamanlayıcılarını durdurur

function okumaOpen(key) {
  okumaStop();
  okumaStop = () => {};
  okumaEx = key;
  renderOkuma();
}

function renderOkuma() {
  if (!$('game-okuma') || $('game-okuma').hidden) return;
  const menu = $('okuma-menu');
  const ex = $('okuma-ex');
  menu.hidden = Boolean(okumaEx);
  ex.hidden = !okumaEx;
  if (!okumaEx) {
    okumaStop();
    menu.replaceChildren(...OKUMA_EXERCISES.map((e) => {
      const b = okBtn('', 'okuma-card', () => okumaOpen(e.key));
      b.append(okEl('span', 'okuma-card-icon', e.icon), okEl('strong', '', e.title), okEl('small', '', e.desc));
      const best = okumaBestText(e.key);
      if (best) b.append(okEl('span', 'okuma-card-best', best));
      return b;
    }));
    return;
  }
  const def = OKUMA_EXERCISES.find((e) => e.key === okumaEx);
  const head = okEl('div', 'okuma-head');
  head.append(okBtn('‹ Alıştırmalar', 'sm ghost', () => okumaOpen(null)), okEl('strong', 'okuma-title', `${def.icon} ${def.title}`));
  const body = okEl('div', 'okuma-body');
  ex.replaceChildren(head, okEl('p', 'muted small okuma-desc', def.desc), body);
  if (BLOK[okumaEx]) blokView(body, okumaEx);
  else ({ takisto: takistoView, tablo: tabloView })[okumaEx](body);
}

function okumaBestText(key) {
  if (BLOK[key]) {
    const b = okumaGet(key);
    return b?.score ? `En iyi: ${b.score} puan (seviye ${b.d}, kademe ${b.k})` : '';
  }
  if (key === 'takisto') {
    const b = okumaGet('takisto');
    return b?.level ? `En iyi: seviye ${b.level} (${TAKISTO_MS[b.level - 1]} ms)` : '';
  }
  if (key === 'tablo') {
    const b = okumaGet('tablo:5');
    return b?.ms ? `En iyi 5×5: ${(b.ms / 1000).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} sn` : '';
  }
  return '';
}

// ---------- Blok egzersizleri (yatay, kademeli, dikey) ----------
function blokView(body, key) {
  const cfg = BLOK[key];
  const st = { d: 1, k: 1, score: 0, answer: '', phase: 'idle', timers: [], right: 0, wrong: 0, best: { d: 1, k: 1 } };
  okumaStop = () => st.timers.forEach(clearTimeout);
  const later = (ms, fn) => st.timers.push(setTimeout(fn, ms));

  const bar = okEl('div', 'blok-bar');
  const stage = okEl('div', `blok-stage ${key}`);
  const form = okEl('form', 'okuma-answer');
  const input = Object.assign(okEl('input'), { inputMode: 'numeric', autocomplete: 'off', placeholder: key === 'kademeli' ? 'Önce sol, sonra sağ' : 'Gördüğün rakamlar', enterKeyHint: 'send' });
  const send = okBtn('Gönder', 'primary');
  send.type = 'submit';
  form.append(input, send);
  const info = okEl('p', 'muted small okuma-info');
  const startBtn = okBtn('Başla', 'lobby-start okuma-start', () => begin());
  const endBtn = okBtn('Bitir', 'sm ghost danger', () => finish(false));
  const actions = okEl('div', 'okuma-opts');
  actions.append(startBtn, endBtn);
  body.append(bar, stage, form, actions, info);

  function drawBar() {
    bar.replaceChildren(
      okEl('span', '', `Seviye ${st.d}/${cfg.levels}`),
      okEl('span', '', `Kademe ${st.k}/${BLOK_STEPS}`),
      okEl('span', '', `${cfg.question(st.d).length} rakam · ${cfg.ms(st.d)} ms`),
      okEl('strong', '', `${st.score} puan`));
  }
  const dot = () => okEl('span', 'blok-dot');

  function idle(text) {
    st.phase = 'idle';
    form.hidden = true;
    startBtn.hidden = false;
    endBtn.hidden = true;
    stage.replaceChildren(dot());
    const best = okumaGet(key);
    info.textContent = text || `${cfg.hint} Doğru bildikçe kademe, 6 kademede bir seviye artar.${best ? ` Rekorun: ${best.score} puan.` : ''}`;
    drawBar();
  }

  function begin() {
    Object.assign(st, { d: 1, k: 1, score: 0, right: 0, wrong: 0, best: { d: 1, k: 1 } });
    startBtn.hidden = true;
    endBtn.hidden = false;
    next();
  }

  function next() {
    st.phase = 'show';
    form.hidden = true;
    drawBar();
    info.textContent = cfg.hint;
    st.answer = cfg.question(st.d);
    stage.replaceChildren(dot());
    const items = cfg.items(st.answer, st.d, st.k);
    const ms = cfg.ms(st.d);
    later(800, () => {
      const els = items.map((it) => {
        const el = okEl('span', 'blok-item', it.text);
        // En açık kademede de sahneden taşmasın: yarım genişlik/yükseklik kadar kenardan içeride kalır
        const half = it.text.length * 0.33 + 0.3;
        el.style.left = `clamp(${half}em, ${it.x}%, calc(100% - ${half}em))`;
        el.style.top = `clamp(0.8em, ${it.y}%, calc(100% - 1.2em))`;
        return el;
      });
      if (cfg.focus) {
        // Kademeli: noktalar sayıların altında; göz önce soldakine, yarı sürede sağdakine
        stage.replaceChildren(...els);
        els[0].classList.add('focus');
        later(ms / 2, () => {
          els[0].classList.remove('focus');
          els[1].classList.add('focus');
        });
      } else stage.append(...els);
      later(ms, ask);
    });
  }

  function ask() {
    st.phase = 'answer';
    stage.replaceChildren(okEl('span', 'blok-q', '?'));
    form.hidden = false;
    input.value = '';
    input.focus();
  }

  form.onsubmit = (e) => {
    e.preventDefault();
    if (st.phase !== 'answer') return;
    const given = input.value.replace(/\D/g, '');
    const ok = given === st.answer;
    const pts = (st.d + 1) * st.k * cfg.pts;
    st.score += ok ? pts : -pts;
    st.phase = 'feedback';
    form.hidden = true;
    stage.replaceChildren(okEl('span', `blok-q ${ok ? 'right' : 'wrong'}`, `${ok ? '✓' : '✗'} ${st.answer}${ok ? '' : given ? ` (sen: ${given})` : ''}`));
    if (ok) {
      st.right++;
      st.best = { d: st.d, k: st.k };
      st.k++;
      if (st.k > BLOK_STEPS) {
        st.k = 1;
        st.d++;
        if (st.d > cfg.levels) return later(900, () => finish(true));
      }
    } else st.wrong++;
    drawBar();
    later(ok ? 700 : 1300, next);
  };

  function finish(all) {
    okumaStop();
    st.timers = [];
    st.d = Math.min(st.d, cfg.levels);
    const best = okumaGet(key);
    const rec = st.right > 0 && (!best || st.score > best.score);
    if (rec) okumaSet(key, { score: st.score, d: st.best.d, k: st.best.k });
    idle(`${all ? 'Bütün seviyeleri bitirdin! ' : ''}${st.right} doğru, ${st.wrong} yanlış → ${st.score} puan.${rec ? ' Yeni rekor!' : best ? ` Rekorun: ${best.score} puan.` : ''}`);
    startBtn.textContent = 'Tekrar';
  }

  idle();
}

// ---------- Takistoskop ----------
function takistoView(body) {
  const saved = okumaGet('takisto-set') || { level: 1, count: 1 };
  const st = { level: saved.level, count: saved.count, trial: 0, right: 0, phase: 'idle', answer: '', timers: [] };
  okumaStop = () => st.timers.forEach(clearTimeout);
  const later = (ms, fn) => st.timers.push(setTimeout(fn, ms));

  const opts = okEl('div', 'okuma-opts');
  const stage = okEl('div', 'takisto-stage');
  const word = okEl('div', 'takisto-word');
  stage.append(word);
  const form = okEl('form', 'okuma-answer');
  const input = Object.assign(okEl('input'), { placeholder: 'Gördüğünü yaz, Enter', autocomplete: 'off', autocapitalize: 'off', spellcheck: false });
  form.append(input, okBtn('Gönder', 'primary'));
  form.querySelector('button').type = 'submit';
  const info = okEl('p', 'muted small okuma-info');
  const startBtn = okBtn('Başla', 'lobby-start okuma-start', () => begin());
  body.append(opts, stage, form, startBtn, info);

  function drawOpts() {
    opts.replaceChildren(okEl('span', 'muted small', 'Seviye:'));
    TAKISTO_MS.forEach((ms, i) => {
      const b = okBtn(String(i + 1), 'sm' + (st.level === i + 1 ? ' active' : ''), () => { st.level = i + 1; save(); drawOpts(); });
      b.title = `${ms} ms`;
      b.disabled = st.phase !== 'idle';
      opts.append(b);
    });
    opts.append(okEl('span', 'muted small okuma-gap', 'Kelime:'));
    for (const n of [1, 2, 3]) {
      const b = okBtn(String(n), 'sm' + (st.count === n ? ' active' : ''), () => { st.count = n; save(); drawOpts(); });
      b.disabled = st.phase !== 'idle';
      opts.append(b);
    }
  }
  const save = () => okumaSet('takisto-set', { level: st.level, count: st.count });

  function idle(text) {
    st.phase = 'idle';
    form.hidden = true;
    startBtn.hidden = false;
    word.textContent = '';
    word.className = 'takisto-word';
    info.textContent = text || `Her turda ${TAKISTO_SET} deneme. Ortadaki noktaya bak; kelime ${TAKISTO_MS[st.level - 1]} ms görünecek. ${TAKISTO_SET} denemede 8 ve üstü doğru yaparsan seviye artar, 5 ve altında azalır.`;
    drawOpts();
  }

  function begin() {
    st.trial = 0;
    st.right = 0;
    st.phase = 'run';
    startBtn.hidden = true;
    drawOpts();
    next();
  }

  function next() {
    if (st.trial >= TAKISTO_SET) return endSet();
    st.phase = 'run';
    form.hidden = true;
    st.answer = Array.from({ length: st.count }, () => okPick(TR_WORDS.filter((w) => w.length >= 3 && w.length <= 3 + st.level))).join(' ');
    word.className = 'takisto-word dot';
    word.textContent = '•';
    info.textContent = `Deneme ${st.trial + 1}/${TAKISTO_SET} · doğru ${st.right}`;
    later(700, () => {
      word.className = 'takisto-word show';
      word.textContent = st.answer;
      later(TAKISTO_MS[st.level - 1], () => {
        word.className = 'takisto-word mask';
        word.textContent = st.answer.replace(/\S/g, '#');
        later(250, () => {
          word.className = 'takisto-word';
          word.textContent = '?';
          st.phase = 'answer';
          form.hidden = false;
          input.value = '';
          input.focus();
        });
      });
    });
  }

  form.onsubmit = (e) => {
    e.preventDefault();
    if (st.phase !== 'answer') return;
    const ok = input.value.trim().toLocaleLowerCase('tr').replace(/\s+/g, ' ') === st.answer;
    st.trial++;
    if (ok) st.right++;
    st.phase = 'run';
    form.hidden = true;
    word.className = `takisto-word ${ok ? 'right' : 'wrong'}`;
    word.textContent = ok ? `✓ ${st.answer}` : `✗ ${st.answer}`;
    later(900, next);
  };

  function endSet() {
    const passed = st.right >= 8;
    const msg = `${TAKISTO_SET} denemede ${st.right} doğru.`;
    const best = okumaGet('takisto');
    if (passed && (!best || st.level > best.level)) okumaSet('takisto', { level: st.level });
    let note = ' Bu seviyede kal ve tekrar dene.';
    if (passed && st.level < TAKISTO_MS.length) {
      st.level++;
      note = ` Seviye ${st.level}'e geçtin (${TAKISTO_MS[st.level - 1]} ms).`;
    } else if (st.right <= 5 && st.level > 1) {
      st.level--;
      note = ` Seviye ${st.level}'e indin.`;
    }
    save();
    idle(msg + note);
  }

  idle();
}

// ---------- Sayı tablosu ----------
function tabloView(body) {
  const saved = okumaGet('tablo-set') || { size: 5 };
  const st = { size: saved.size, next: 1, start: 0, running: false, timers: [] };
  okumaStop = () => st.timers.forEach(clearInterval);
  const opts = okEl('div', 'okuma-opts');
  const grid = okEl('div', 'tablo-grid');
  const info = okEl('p', 'muted small okuma-info');
  const startBtn = okBtn('Başla', 'lobby-start okuma-start', () => begin());
  body.append(opts, grid, startBtn, info);

  function drawOpts() {
    opts.replaceChildren(okEl('span', 'muted small', 'Tablo:'));
    for (const n of [3, 4, 5, 6]) {
      const b = okBtn(`${n}×${n}`, 'sm' + (st.size === n ? ' active' : ''), () => { st.size = n; okumaSet('tablo-set', { size: n }); drawOpts(); drawGrid(false); idleInfo(); });
      b.disabled = st.running;
      opts.append(b);
    }
  }
  const fmt = (ms) => (ms / 1000).toLocaleString('tr-TR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  function idleInfo() {
    const best = okumaGet(`tablo:${st.size}`);
    info.textContent = `1'den ${st.size * st.size}'e kadar sırayla bas. Gözünü tablonun ortasında tutmaya çalış.${best ? ` Rekorun: ${fmt(best.ms)} sn.` : ''}`;
  }

  function drawGrid(live) {
    const total = st.size * st.size;
    const nums = live ? okShuffle(Array.from({ length: total }, (_, i) => i + 1)) : Array(total).fill('');
    grid.style.setProperty('--n', st.size);
    grid.classList.toggle('idle', !live);
    grid.replaceChildren(...nums.map((v) => {
      const b = okBtn(String(v), 'tablo-cell');
      b.onclick = () => {
        if (!st.running) return;
        if (v === st.next) {
          b.classList.add('done');
          st.next++;
          if (st.next > total) finish();
        } else {
          b.classList.remove('miss');
          void b.offsetWidth;
          b.classList.add('miss');
        }
      };
      return b;
    }));
  }

  function begin() {
    st.running = true;
    st.next = 1;
    st.start = performance.now();
    startBtn.hidden = true;
    drawOpts();
    drawGrid(true);
    st.timers.push(setInterval(() => {
      info.textContent = `Sıradaki: ${st.next} · ${fmt(performance.now() - st.start)} sn`;
    }, 100));
  }

  function finish() {
    st.timers.forEach(clearInterval);
    st.timers = [];
    st.running = false;
    const ms = performance.now() - st.start;
    const best = okumaGet(`tablo:${st.size}`);
    const rec = !best || ms < best.ms;
    if (rec) okumaSet(`tablo:${st.size}`, { ms: Math.round(ms) });
    info.textContent = `${st.size}×${st.size} tabloyu ${fmt(ms)} sn'de bitirdin.${rec ? ' Yeni rekor!' : ` Rekorun: ${fmt(best.ms)} sn.`}`;
    startBtn.hidden = false;
    startBtn.textContent = 'Tekrar';
    drawOpts();
  }

  drawOpts();
  drawGrid(false);
  idleInfo();
}

