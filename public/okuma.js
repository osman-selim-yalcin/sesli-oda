'use strict';

// ---------- Hızlı okuma alıştırmaları ----------
// app.js ve tr-words.js'ten sonra yüklenir; $, toast, TR_WORDS oradan gelir. Hepsi tek kişilik, sunucuya bir şey
// gitmez; en iyi sonuçlar bu tarayıcıda (localStorage) kişiye göre tutulur.
// - Takistoskop: kelime(ler) çok kısa süre görünür, gördüğünü yazarsın. Seviye 1-10 gösterim süresini kısaltır.
// - Tek mi çift mi: 1 dakikada tablodaki tek (ya da çift) sayıların hepsini bul; bitince yeni tablo gelir.
// - Sayı tablosu: 1'den başlayıp sırayla bütün sayılara bas; gözünü ortada tutmaya çalış.
// - Kelime akışı: metin kelime kelime (ya da 2-3'lü gruplar) ekranın ortasında seçilen hızda akar.

const OKUMA_EXERCISES = [
  { key: 'takisto', title: 'Takistoskop', icon: '⚡', desc: 'Bir anlık gördüğün kelimeyi yaz. Seviye arttıkça süre kısalır.' },
  { key: 'tekcift', title: 'Tek mi? Çift mi?', icon: '🔢', desc: 'Tablodaki tek ya da çift sayıların hepsini bir dakikada bul.' },
  { key: 'tablo', title: 'Sayı tablosu', icon: '🎯', desc: "1'den başlayıp sırayla bütün sayılara bas. Gözün ortada kalsın, kenarları görmeye çalış." },
  { key: 'akis', title: 'Kelime akışı', icon: '📖', desc: 'Metin ekranın ortasında kelime kelime akar; hızı sen seçersin.' },
];

// Seviye -> gösterim süresi (ms)
const TAKISTO_MS = [200, 150, 125, 100, 75, 50, 30, 20, 15, 10];
const TAKISTO_SET = 10; // bir turda kaç deneme

const OKUMA_TEXTS = [
  { title: 'Sabah', text: 'Sabahları erken kalkmak çoğu insana zor gelir. Alarm çalar, el kendiliğinden düğmeye uzanır ve beş dakika daha uyumak dünyanın en güzel fikri gibi görünür. Oysa güneş doğarken pencereyi açıp serin havayı içine çekmek, günün geri kalanına bambaşka bir başlangıç yapmak demektir. Sokaklar henüz sessizdir, fırınlardan taze ekmek kokusu yayılır, kuşlar ağaçlarda birbirine seslenir. Bu saatlerde yazılan bir sayfa, okunan bir bölüm ya da yapılan kısa bir yürüyüş, öğleden sonra yapılan iki saatlik çalışmadan daha verimli olabilir. Önemli olan bir anda değişmek değil, her gün biraz daha erken kalkmayı denemektir. Bir hafta sonra beden bu yeni düzene alışır ve sabahlar artık bir ceza değil, kimsenin rahatsız etmediği küçük bir hediye olur.' },
  { title: 'Deniz feneri', text: 'Küçük bir adanın ucunda, kayaların üstünde eski bir deniz feneri dururdu. Yıllarca her gece aynı saatte yanar, uzaktaki gemilere kıyının nerede olduğunu gösterirdi. Feneri yaşlı bir bekçi yönetirdi. Her akşam yüz yirmi basamağı tek tek çıkar, camları siler, lambayı yakar ve sabaha kadar denizi izlerdi. Fırtınalı gecelerde dalgalar kayalara çarpar, rüzgar pencereleri sarsardı ama ışık hiç sönmezdi. Bir gün adaya otomatik bir lamba getirildi ve bekçiye artık gerek kalmadığı söylendi. Yaşlı adam fenerden indi, köydeki küçük evine yerleşti. Yine de her akşam aynı saatte pencereye gider, uzakta dönen ışığa bakar ve kendi kendine gülümserdi. Işık hâlâ yanıyordu; onun için önemli olan da buydu.' },
  { title: 'Okumak', text: 'Hızlı okumak yalnızca gözleri hızlı oynatmak değildir. Okurken çoğumuz kelimeleri içimizden tek tek söyleriz ve bu iç ses okuma hızımızı konuşma hızına bağlar. Göz ise aslında bir bakışta birden fazla kelimeyi görebilir. Alıştırmalar bu yüzden iki şeye odaklanır: bir bakışta görülen alanı genişletmek ve gözün satır üstündeki sıçramalarını azaltmak. Takistoskop çalışması kısa sürede daha çok şey görmeyi, sayı tablosu ise gözü ortada tutarken kenarları fark etmeyi öğretir. Yine de amaç anlamadan okumak değildir. Hız arttıkça arada durup okuduğunu kendine özetlemek, anlamanın da hızla birlikte gelişmesini sağlar. Her gün on dakikalık düzenli çalışma, ayda bir yapılan uzun çalışmadan çok daha fazla işe yarar.' },
];

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
  ({ takisto: takistoView, tekcift: tekciftView, tablo: tabloView, akis: akisView })[okumaEx](body);
}

function okumaBestText(key) {
  if (key === 'takisto') {
    const b = okumaGet('takisto');
    return b?.level ? `En iyi: seviye ${b.level} (${TAKISTO_MS[b.level - 1]} ms)` : '';
  }
  if (key === 'tekcift') {
    const b = okumaGet('tekcift');
    return b?.score ? `En iyi: ${b.score} puan` : '';
  }
  if (key === 'tablo') {
    const b = okumaGet('tablo:5');
    return b?.ms ? `En iyi 5×5: ${(b.ms / 1000).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} sn` : '';
  }
  return '';
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

// ---------- Tek mi? Çift mi? ----------
function tekciftView(body) {
  const saved = okumaGet('tekcift-set') || { digits: 2 };
  const st = { digits: saved.digits, running: false, score: 0, wrong: 0, end: 0, odd: true, cells: [], left: 0, timers: [] };
  okumaStop = () => st.timers.forEach(clearInterval);
  const opts = okEl('div', 'okuma-opts');
  const task = okEl('div', 'tekcift-task');
  const grid = okEl('div', 'tekcift-grid');
  const info = okEl('p', 'muted small okuma-info');
  const startBtn = okBtn('Başla', 'lobby-start okuma-start', () => begin());
  body.append(opts, task, grid, startBtn, info);

  function drawOpts() {
    opts.replaceChildren(okEl('span', 'muted small', 'Basamak:'));
    for (const d of [2, 3, 4]) {
      const b = okBtn(String(d), 'sm' + (st.digits === d ? ' active' : ''), () => { st.digits = d; okumaSet('tekcift-set', { digits: d }); drawOpts(); });
      b.disabled = st.running;
      opts.append(b);
    }
  }

  function newGrid() {
    st.odd = Math.random() < 0.5;
    const lo = 10 ** (st.digits - 1);
    const hi = 10 ** st.digits - 1;
    const n = 30;
    const hits = 6 + Math.floor(Math.random() * 6);
    const nums = [];
    for (let i = 0; i < n; i++) {
      let v = lo + Math.floor(Math.random() * (hi - lo + 1));
      const want = i < hits ? st.odd : !st.odd; // ilk "hits" tanesi aranan türde
      if ((v % 2 === 1) !== want) v = v === hi ? v - 1 : v + 1;
      nums.push(v);
    }
    st.cells = okShuffle(nums);
    st.left = hits;
    task.textContent = st.odd ? 'Tek sayıları bul!' : 'Çift sayıları bul!';
    task.className = `tekcift-task ${st.odd ? 'odd' : 'even'}`;
    grid.replaceChildren(...st.cells.map((v) => {
      const b = okBtn(String(v), 'tekcift-cell');
      b.onclick = () => {
        if (!st.running || b.disabled) return;
        if ((v % 2 === 1) === st.odd) {
          b.classList.add('hit');
          b.disabled = true;
          st.score++;
          if (--st.left === 0) newGrid();
        } else {
          st.wrong++;
          b.classList.remove('miss');
          void b.offsetWidth;
          b.classList.add('miss');
        }
        stats();
      };
      return b;
    }));
  }

  const points = () => Math.max(0, st.score - st.wrong * 2);
  function stats() {
    const left = Math.max(0, st.end - Date.now());
    info.textContent = st.running ? `${Math.ceil(left / 1000)} sn · ${st.score} doğru · ${st.wrong} yanlış` : info.textContent;
  }

  function begin() {
    st.running = true;
    st.score = 0;
    st.wrong = 0;
    st.end = Date.now() + 60000;
    startBtn.hidden = true;
    drawOpts();
    newGrid();
    stats();
    st.timers.push(setInterval(() => {
      if (Date.now() < st.end) return stats();
      st.timers.forEach(clearInterval);
      st.timers = [];
      finish();
    }, 200));
  }

  function finish() {
    st.running = false;
    startBtn.hidden = false;
    startBtn.textContent = 'Tekrar';
    for (const b of grid.children) b.disabled = true;
    const p = points();
    const best = okumaGet('tekcift');
    const rec = !best || p > best.score;
    if (rec && p > 0) okumaSet('tekcift', { score: p });
    info.textContent = `Süre doldu: ${st.score} doğru, ${st.wrong} yanlış → ${p} puan (her yanlış 2 puan götürür).${rec && p > 0 ? ' Yeni rekor!' : best ? ` Rekorun ${best.score}.` : ''}`;
    drawOpts();
  }

  drawOpts();
  task.textContent = 'Hazır olunca başla';
  task.className = 'tekcift-task';
  info.textContent = 'Bir dakika boyunca tablodaki tek (ya da çift) sayıların hepsine bas; hepsini bulunca yeni tablo gelir. Yanlışa basmak 2 puan götürür.';
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

// ---------- Kelime akışı ----------
function akisView(body) {
  const saved = okumaGet('akis-set') || { wpm: 300, chunk: 1, text: 0 };
  const st = { ...saved, words: [], pos: 0, playing: false, timer: null, custom: '' };
  okumaStop = () => clearTimeout(st.timer);
  const save = () => okumaSet('akis-set', { wpm: st.wpm, chunk: st.chunk, text: st.text });

  const opts = okEl('div', 'okuma-opts');
  const texts = okEl('div', 'okuma-opts');
  const stage = okEl('div', 'akis-stage');
  const word = okEl('div', 'akis-word');
  stage.append(word);
  const bar = okEl('div', 'akis-progress');
  const fill = okEl('span');
  bar.append(fill);
  const controls = okEl('div', 'okuma-opts akis-controls');
  const playBtn = okBtn('Başlat', 'lobby-start okuma-start', () => (st.playing ? pause() : play()));
  const backBtn = okBtn('↺ Baştan', 'sm ghost', () => { pause(); st.pos = 0; show(); });
  controls.append(playBtn, backBtn);
  const custom = Object.assign(okEl('textarea', 'akis-custom'), { placeholder: 'Kendi metnini buraya yapıştır…', rows: 4, hidden: true });
  custom.oninput = () => { st.custom = custom.value; load(); };
  const info = okEl('p', 'muted small okuma-info');
  body.append(texts, custom, opts, stage, bar, controls, info);

  function drawOpts() {
    texts.replaceChildren(okEl('span', 'muted small', 'Metin:'), ...OKUMA_TEXTS.map((t, i) =>
      okBtn(t.title, 'sm' + (st.text === i ? ' active' : ''), () => { st.text = i; save(); load(); drawOpts(); })),
    okBtn('Kendi metnin', 'sm' + (st.text === -1 ? ' active' : ''), () => { st.text = -1; save(); load(); drawOpts(); }));
    custom.hidden = st.text !== -1;
    opts.replaceChildren(okEl('span', 'muted small', 'Hız:'), ...[200, 300, 400, 500, 650, 800].map((w) =>
      okBtn(`${w}`, 'sm' + (st.wpm === w ? ' active' : ''), () => { st.wpm = w; save(); drawOpts(); show(); })),
    okEl('span', 'muted small', 'kelime/dk'), okEl('span', 'muted small okuma-gap', 'Grup:'), ...[1, 2, 3].map((n) =>
      okBtn(String(n), 'sm' + (st.chunk === n ? ' active' : ''), () => { st.chunk = n; save(); drawOpts(); show(); })));
  }

  function load() {
    pause();
    const text = st.text === -1 ? st.custom : OKUMA_TEXTS[st.text]?.text || '';
    st.words = text.split(/\s+/).filter(Boolean);
    st.pos = 0;
    show();
  }

  function show() {
    const total = st.words.length;
    word.textContent = total ? st.words.slice(st.pos, st.pos + st.chunk).join(' ') || '✓' : '';
    fill.style.width = total ? `${Math.min(100, (st.pos / total) * 100)}%` : '0';
    const mins = total / st.wpm;
    info.textContent = total ? `${total} kelime · bu hızla ${mins < 1 ? `${Math.round(mins * 60)} sn` : `${mins.toLocaleString('tr-TR', { maximumFractionDigits: 1 })} dk`}. Boşluk tuşu başlatır/durdurur.` : 'Metin yok.';
  }

  function step() {
    st.pos += st.chunk;
    if (st.pos >= st.words.length) {
      st.pos = st.words.length;
      pause();
      word.textContent = '✓ Bitti';
      fill.style.width = '100%';
      return;
    }
    show();
    // Noktalı kelimede biraz durur
    const shown = st.words.slice(st.pos, st.pos + st.chunk).join(' ');
    const extra = /[.!?]$/.test(shown) ? 1.8 : /[,;:]$/.test(shown) ? 1.3 : 1;
    st.timer = setTimeout(step, (60000 / st.wpm) * st.chunk * extra);
  }

  function play() {
    if (!st.words.length) return;
    if (st.pos >= st.words.length) st.pos = 0;
    st.playing = true;
    playBtn.textContent = 'Durdur';
    show();
    st.timer = setTimeout(step, (60000 / st.wpm) * st.chunk);
  }
  function pause() {
    clearTimeout(st.timer);
    st.playing = false;
    playBtn.textContent = st.pos > 0 && st.pos < st.words.length ? 'Devam' : 'Başlat';
  }

  drawOpts();
  load();
}

addEventListener('keydown', (e) => {
  if (okumaEx !== 'akis' || e.key !== ' ' || $('game-okuma').hidden) return;
  if (e.target.closest?.('input, textarea')) return;
  e.preventDefault();
  $('okuma-ex').querySelector('.akis-controls .okuma-start')?.click();
});
