'use strict';

// ---------- Beş Harf (günlük kelime) ----------
// app.js'ten sonra yüklenir; $, socket, myName oradan, BESHARF_WORDS besharf-words.js'ten gelir. Her gün herkese aynı
// 5 harfli kelime, 6 tahmin. Tahmin sunucuda denetlenir ve boyanır (games/besharf.js); kelime istemciye ancak oyun
// bitince gelir. Ekran klavyesi ya da bilgisayar klavyesiyle yazılır.
// İki dil: Türkçe (tr) ve İngilizce (en); her gün ikisinde ayrı kelime. Seçim tarayıcıda saklanır (ilk açılışta arayüzün
// dili). İngilizce tahmin listesi (besharf-words-en.js) İngilizce mod ilk açılınca yüklenir.

let besharf = null; // sunucudan: { no, rows: [{ w, m }], done, won, answer, nextAt, stats, board, ... }
let bhTyped = '';
let bhBusy = false;
let bhReveal = -1; // çevrilerek açılacak satır
let bhTimer = null;
let bhClock = null;
const BH_LEN = 5;
const BH_MAX = 6;
const BH_LANG_KEY = 'besharfLang';
const BH = {
  tr: {
    keys: [[...'ertyuıopğü'], [...'asdfghjklşi'], ['enter', ...'zcvbnmöç', 'back']],
    lower: (s) => s.replace(/I/g, 'ı').replace(/İ/g, 'i').toLocaleLowerCase('tr'),
    upper: (s) => s.replace(/i/g, 'İ').replace(/ı/g, 'I').toLocaleUpperCase('tr'),
    valid: new Set(typeof BESHARF_WORDS !== 'undefined' ? BESHARF_WORDS : []),
  },
  en: {
    keys: [[...'qwertyuiop'], [...'asdfghjkl'], ['enter', ...'zxcvbnm', 'back']],
    lower: (s) => s.toLowerCase(),
    upper: (s) => s.toUpperCase(),
    valid: new Set(), // besharf-words-en.js yüklenince dolar
  },
};
for (const L of Object.values(BH)) L.letters = new Set(L.keys.flat().filter((k) => k.length === 1));
let bhLang = (() => {
  try {
    const saved = localStorage.getItem(BH_LANG_KEY);
    if (saved === 'tr' || saved === 'en') return saved;
  } catch {}
  return typeof I18N !== 'undefined' && I18N.lang === 'en' ? 'en' : 'tr';
})();
const bhL = () => BH[bhLang];
const BH_RANK = { x: 1, y: 2, g: 3 };
const BH_FLIP = 260; // ms, harf başına
const bhLower = (s) => bhL().lower(s);
const bhUpper = (s) => bhL().upper(s);
let bhEnWords = null;
function bhLoadEn() {
  bhEnWords ||= new Promise((resolve) => {
    const s = Object.assign(document.createElement('script'), { src: '/besharf-words-en.js?v=1' });
    s.onload = () => {
      if (typeof BESHARF_WORDS_EN !== 'undefined') BESHARF_WORDS_EN.forEach((w) => BH.en.valid.add(w));
      resolve();
    };
    s.onerror = () => { bhEnWords = null; resolve(); }; // sunucu yine denetler
    document.head.append(s);
  });
  return bhEnWords;
}
const bhShown = () => !$('game-besharf').hidden;

function bhSound(kind, i = 0) {
  if (typeof audioCtx === 'undefined' || !audioCtx || audioCtx.state !== 'running') return;
  const bus = (typeof sfxBus !== 'undefined' && sfxBus) || audioCtx.destination;
  try {
    const t = audioCtx.currentTime + i;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g);
    g.connect(bus);
    const f = { key: 520, g: 880, y: 660, x: 300, bad: 140, win: 784 }[kind] || 440;
    o.type = kind === 'bad' ? 'square' : 'triangle';
    o.frequency.setValueAtTime(f, t);
    if (kind === 'win') [988, 1175, 1568].forEach((v, k) => o.frequency.setValueAtTime(v, t + 0.1 * (k + 1)));
    const len = kind === 'win' ? 0.5 : kind === 'bad' ? 0.18 : 0.07;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(kind === 'key' ? 0.06 : 0.14, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.start(t);
    o.stop(t + len + 0.02);
  } catch {}
}

function bhToast(text, ms = 1600) {
  const el = $('besharf-toast');
  el.textContent = text;
  el.hidden = false;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(bhToast.t);
  bhToast.t = setTimeout(() => (el.hidden = true), ms);
}

function bhShake() {
  const row = $('besharf-grid').children[besharf?.rows.length ?? 0];
  if (!row) return;
  row.classList.remove('shake');
  void row.offsetWidth;
  row.classList.add('shake');
  bhSound('bad');
}

// Harf durumu klavyede: en iyi renk kalır
function bhLetterMarks() {
  const best = {};
  for (const { w, m } of besharf?.rows || []) {
    [...w].forEach((ch, i) => {
      if (!best[ch] || BH_RANK[m[i]] > BH_RANK[best[ch]]) best[ch] = m[i];
    });
  }
  return best;
}

function renderBhGrid() {
  const grid = $('besharf-grid');
  const rows = besharf?.rows || [];
  const out = [];
  for (let r = 0; r < BH_MAX; r++) {
    const row = document.createElement('div');
    row.className = 'bh-row';
    const done = rows[r];
    const typing = !done && r === rows.length && !besharf?.done;
    const letters = done ? [...done.w] : typing ? [...bhTyped] : [];
    for (let i = 0; i < BH_LEN; i++) {
      const tile = document.createElement('div');
      tile.className = 'bh-tile';
      const inner = document.createElement('div');
      inner.className = 'bh-in';
      const front = Object.assign(document.createElement('span'), { className: 'bh-face bh-front', textContent: letters[i] ? bhUpper(letters[i]) : '' });
      inner.append(front);
      if (done) {
        const back = Object.assign(document.createElement('span'), { className: `bh-face bh-back ${done.m[i]}`, textContent: bhUpper(letters[i]) });
        inner.append(back);
        tile.classList.add('set');
        if (r === bhReveal) {
          tile.classList.add('flip');
          tile.style.setProperty('--d', `${i * BH_FLIP}ms`);
        }
        if (besharf.won && r === rows.length - 1) {
          tile.classList.add('won');
          tile.style.setProperty('--w', `${(r === bhReveal ? BH_LEN * BH_FLIP + 150 : 0) + i * 90}ms`);
        }
      } else if (letters[i]) {
        tile.classList.add('filled');
        if (typing && i === bhTyped.length - 1) tile.classList.add('bh-typed'); // 'pop' değil: o ad açılır pencerelerin genel sınıfı (base.css .pop)
      }
      tile.append(inner);
      row.append(tile);
    }
    out.push(row);
  }
  grid.replaceChildren(...out);
}

function renderBhKeys() {
  const marks = bhLetterMarks();
  // Açılan satır bitene kadar klavye renkleri bir önceki hâliyle kalsın (sürpriz bozulmasın)
  const hold = bhReveal >= 0 ? bhRowsMarks(bhReveal) : null;
  $('besharf-keys').replaceChildren(...bhL().keys.map((line) => {
    const row = document.createElement('div');
    row.className = 'bh-krow';
    for (const k of line) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'bh-key' + (k.length > 1 ? ' wide' : '');
      if (k === 'enter') {
        b.textContent = 'Gir';
        b.setAttribute('aria-label', 'Tahmini gönder');
      } else if (k === 'back') {
        b.textContent = '⌫';
        b.setAttribute('aria-label', 'Harf sil');
      } else {
        b.textContent = bhUpper(k);
        const m = (hold || marks)[k];
        if (m) b.classList.add(m);
      }
      b.onclick = () => bhKey(k);
      b.disabled = Boolean(besharf?.done);
      row.append(b);
    }
    return row;
  }));
}
function bhRowsMarks(upto) {
  const best = {};
  for (const { w, m } of (besharf?.rows || []).slice(0, upto)) {
    [...w].forEach((ch, i) => {
      if (!best[ch] || BH_RANK[m[i]] > BH_RANK[best[ch]]) best[ch] = m[i];
    });
  }
  return best;
}

function bhFmtMs(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} sa ${m} dk` : m ? `${m} dk ${s % 60} sn` : `${s % 60} sn`;
}
function bhClockText() {
  if (!besharf) return '';
  const left = besharf.nextAt - (Date.now() + (besharf.skew || 0));
  const s = Math.max(0, Math.floor(left / 1000));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((v) => String(v).padStart(2, '0')).join(':');
}

function renderBhSide() {
  const g = besharf;
  const side = $('besharf-side');
  if (!g) return side.replaceChildren();
  const parts = [];
  // Sonuç ve istatistik
  const head = document.createElement('div');
  head.className = 'bh-card bh-me';
  const st = g.stats || { played: 0, wins: 0, streak: 0, max: 0, dist: [] };
  const nums = document.createElement('div');
  nums.className = 'bh-nums';
  for (const [v, label] of [[st.played, 'Oynadın'], [st.played ? Math.round((st.wins / st.played) * 100) : 0, 'Kazanma %'], [st.streak, 'Seri'], [st.max, 'En uzun seri']]) {
    const n = document.createElement('div');
    n.append(Object.assign(document.createElement('strong'), { textContent: v }), Object.assign(document.createElement('span'), { className: 'muted small', textContent: label }));
    nums.append(n);
  }
  head.append(nums);
  const dist = document.createElement('div');
  dist.className = 'bh-dist';
  const top = Math.max(1, ...st.dist);
  st.dist.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'bh-bar' + (g.won && g.rows.length === i + 1 ? ' now' : '');
    const bar = Object.assign(document.createElement('span'), { textContent: c });
    bar.style.setProperty('--p', `${Math.max(8, (c / top) * 100)}%`);
    row.append(Object.assign(document.createElement('b'), { textContent: i + 1 }), bar);
    dist.append(row);
  });
  head.append(dist);
  const next = document.createElement('div');
  next.className = 'bh-next muted small';
  next.append('Yeni kelimeye ', Object.assign(document.createElement('strong'), { id: 'besharf-clock', textContent: bhClockText() }));
  head.append(next);
  parts.push(head);

  // Bugün oynayanlar: yalnız renkler
  const today = document.createElement('div');
  today.className = 'bh-card bh-today';
  today.append(Object.assign(document.createElement('div'), { className: 'bh-card-title', textContent: `Bugün oynayanlar (${g.board.length})` }));
  if (!g.board.length) today.append(Object.assign(document.createElement('p'), { className: 'muted small', textContent: 'Bugün henüz kimse oynamadı. İlk sen ol!' }));
  const list = document.createElement('div');
  list.className = 'bh-people';
  for (const p of g.board) {
    const el = document.createElement('div');
    el.className = 'bh-person' + (p.name === myName ? ' me' : '');
    const mini = document.createElement('div');
    mini.className = 'bh-mini';
    for (const m of p.m) {
      const r = document.createElement('div');
      for (const c of m) r.append(Object.assign(document.createElement('i'), { className: c }));
      mini.append(r);
    }
    const info = document.createElement('div');
    info.className = 'bh-pinfo';
    info.append(
      Object.assign(document.createElement('strong'), { textContent: p.name + (p.name === myName ? ' (sen)' : '') }),
      Object.assign(document.createElement('span'), { className: 'muted small', textContent: p.won ? `${p.n}/${BH_MAX} · ${bhFmtMs(p.ms)}` : p.done ? `Bulamadı (X/${BH_MAX})` : `Oynuyor · ${p.n}/${BH_MAX}` }),
    );
    el.append(mini, info);
    list.append(el);
  }
  today.append(list);
  parts.push(today);
  side.replaceChildren(...parts);
}

function renderBhResult() {
  const g = besharf;
  const box = $('besharf-result');
  const show = Boolean(g?.done) && bhReveal < 0;
  box.hidden = !show;
  if (!show) return;
  $('besharf-result-title').textContent = g.won ? ['Dahice!', 'Harika!', 'Çok iyi!', 'Güzel!', 'İyi iş!', 'Kıl payı!'][g.rows.length - 1] : 'Bu sefer olmadı';
  $('besharf-result-word').textContent = bhUpper(g.answer || '');
  $('besharf-result-note').textContent = g.won ? `${g.rows.length}/${BH_MAX} tahminde buldun.` : 'Günün kelimesi buydu.';
}

function bhRenderAll() {
  const g = besharf;
  $('besharf-status').textContent = !g ? 'Yükleniyor…' : g.done ? `#${g.no} · ${g.won ? `${g.rows.length}/${BH_MAX}` : `X/${BH_MAX}`} · yeni kelimeye ${bhClockText()}` : `#${g.no} · günün kelimesi · ${g.rows.length}/${BH_MAX} tahmin`;
  renderBhGrid();
  renderBhKeys();
  renderBhSide();
  renderBhResult();
}

function bhKey(k) {
  if (!besharf || besharf.done || bhBusy) return;
  if (k === 'back') {
    bhTyped = [...bhTyped].slice(0, -1).join('');
    return renderBhGrid();
  }
  if (k === 'enter') return bhSubmit();
  if (!bhL().letters.has(k) || [...bhTyped].length >= BH_LEN) return;
  bhTyped += k;
  bhSound('key');
  renderBhGrid();
}

function bhSubmit() {
  const word = bhTyped;
  if ([...word].length < BH_LEN) {
    bhShake();
    return bhToast('Kelime 5 harf olmalı');
  }
  if (bhL().valid.size && !bhL().valid.has(word)) {
    bhShake();
    return bhToast('Bu kelime listede yok');
  }
  if (besharf.rows.some((r) => r.w === word)) {
    bhShake();
    return bhToast('Bunu zaten denedin');
  }
  bhBusy = true;
  const lang = bhLang;
  socket.emit('besharf:guess', { word, lang }, (res) => {
    bhBusy = false;
    if (lang !== bhLang) return; // bu arada dil değişti
    if (!res?.ok) {
      bhShake();
      bhToast(res?.error || 'Gönderilemedi');
      if (res?.state) setBesharf(res.state);
      return;
    }
    bhTyped = '';
    bhReveal = res.state.rows.length - 1;
    setBesharf(res.state, true);
    const m = res.state.rows[bhReveal].m;
    [...m].forEach((c, i) => bhSound(c, (i * BH_FLIP + BH_FLIP / 2) / 1000));
    clearTimeout(bhTimer);
    bhTimer = setTimeout(() => {
      bhReveal = -1;
      if (besharf.won) bhSound('win');
      if (besharf.done) setTimeout(bhRenderAll, besharf.won ? 900 : 300);
      renderBhKeys();
      renderBhResult();
    }, BH_LEN * BH_FLIP + 250);
  });
}

addEventListener('keydown', (e) => {
  if (!bhShown() || e.ctrlKey || e.metaKey || e.altKey) return;
  const el = document.activeElement;
  if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
  if (e.key === 'Enter') {
    if (el?.classList?.contains('bh-key')) return; // ekran tuşu odaktayken Enter onun tıklaması olur
    e.preventDefault();
    return bhKey('enter');
  }
  if (e.key === 'Backspace') {
    e.preventDefault();
    return bhKey('back');
  }
  const k = e.key.length === 1 ? bhLower(e.key) : '';
  if (bhL().letters.has(k)) {
    e.preventDefault();
    bhKey(k);
  }
});

$('besharf-result-close').onclick = () => ($('besharf-result').hidden = true);

// Gün değişince yeni kelime: sayaç bitince sunucudan yeniden iste
function bhSchedule() {
  clearTimeout(bhClock);
  if (!besharf) return;
  const tick = () => {
    const c = document.getElementById('besharf-clock');
    if (c) c.textContent = bhClockText();
    if (besharf.done) $('besharf-status').textContent = `#${besharf.no} · ${besharf.won ? `${besharf.rows.length}/${BH_MAX}` : `X/${BH_MAX}`} · yeni kelimeye ${bhClockText()}`;
    if (besharf.nextAt - (Date.now() + (besharf.skew || 0)) <= 0) return besharfRefresh();
    bhClock = setTimeout(tick, 1000);
  };
  tick();
}
function besharfRefresh() {
  socket.emit('besharf:get', { lang: bhLang }, (state) => state && setBesharf(state));
}

// Dil seçici (TR / EN): yazılan silinir, o dilin bugünkü oyunu sunucudan gelir
function renderBhLang() {
  for (const b of document.querySelectorAll('#besharf-lang [data-lang]')) {
    b.setAttribute('aria-pressed', String(b.dataset.lang === bhLang));
  }
}
function bhSetLang(lang) {
  if (!BH[lang] || lang === bhLang) return;
  bhLang = lang;
  try { localStorage.setItem(BH_LANG_KEY, lang); } catch {}
  bhTyped = '';
  bhReveal = -1;
  besharf = null;
  renderBhLang();
  bhRenderAll();
  if (lang === 'en') bhLoadEn();
  besharfRefresh();
}
for (const b of document.querySelectorAll('#besharf-lang [data-lang]')) b.onclick = () => bhSetLang(b.dataset.lang);
renderBhLang();
if (bhLang === 'en') bhLoadEn();

function setBesharf(state, keepTyped = false) {
  if (!state) return;
  // Giriş yanıtı her zaman Türkçe oyunu taşır; başka dildeysek o dilin oyununu iste
  if ((state.lang || 'tr') !== bhLang) return besharf ? undefined : besharfRefresh();
  const newDay = besharf && besharf.day !== state.day;
  besharf = { ...state, skew: state.now - Date.now() };
  if (newDay || !keepTyped) {
    if (newDay || besharf.done) bhTyped = '';
  }
  bhRenderAll();
  bhSchedule();
}
socket.on('besharf:board', ({ day, lang = 'tr', board } = {}) => {
  if (!besharf || besharf.day !== day || lang !== bhLang) return;
  besharf.board = board || [];
  renderBhSide();
});
window.setBesharf = setBesharf;
window.renderBesharf = () => {
  bhRenderAll();
  besharfRefresh(); // sekme uzun süre açık kaldıysa gün değişmiş olabilir
};
