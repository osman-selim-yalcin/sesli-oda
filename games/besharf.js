// ---------- Beş Harf (günlük kelime) ----------
// Her gün (Türkiye saatiyle gece yarısı değişir) herkese aynı 5 harfli kelime. 6 tahmin hakkı; her tahminden sonra harfler
// boyanır: yeşil doğru yerde, sarı kelimede var ama başka yerde, gri yok. Aynı harf iki kez yazılırsa kelimede kaç tane
// varsa o kadarı boyanır. Herkes günde bir kez oynar; yarım kalan oyun hesaba bağlıdır (başka cihazda devam eder).
// Günün sonuçları (yalnız renkler, harfler değil) herkese görünür; kayıt room_state 'besharfboard' (SHARED satırı).

const ANSWERS = require('./besharf-answers');
const VALID = new Set(require('../public/besharf-words'));

const LEN = 5;
const MAX = 6;
const TZ = 3 * 3600 * 1000; // Türkiye UTC+3, yaz saati yok
const DAY = 86400 * 1000;
const FIRST = Math.floor((Date.UTC(2026, 10, 28) + TZ) / DAY); // 28 Kasım 2026 = 1. gün
const KEEP_DAYS = 400; // kayıtta tutulan gün

const dayOf = (now = Date.now()) => Math.floor((now + TZ) / DAY);
const nextAt = (now = Date.now()) => (dayOf(now) + 1) * DAY - TZ;
const answerOf = (day) => ANSWERS[(((day - FIRST) % ANSWERS.length) + ANSWERS.length) % ANSWERS.length];
const lower = (s) => String(s || '').replace(/I/g, 'ı').replace(/İ/g, 'i').toLocaleLowerCase('tr');

// Renkler: 'g' doğru yer, 'y' var ama başka yerde, 'x' yok.
function marks(guess, answer) {
  const g = [...guess];
  const a = [...answer];
  const out = Array(LEN).fill('x');
  const left = {};
  for (let i = 0; i < LEN; i++) {
    if (g[i] === a[i]) out[i] = 'g';
    else left[a[i]] = (left[a[i]] || 0) + 1;
  }
  for (let i = 0; i < LEN; i++) {
    if (out[i] === 'g' || !left[g[i]]) continue;
    out[i] = 'y';
    left[g[i]]--;
  }
  return out.join('');
}

function create({ io, getRoom, postSystem, BOT, store, SHARED, JOINED }) {
  const plays = new Map(); // `${gün}|${ad}` -> { day, name, guesses: [kelime], done, won, startAt, at }
  const key = (day, name) => `${day}|${name}`;

  function merge(list) {
    for (const p of Array.isArray(list) ? list : []) {
      if (!p || !Number.isInteger(p.day) || typeof p.name !== 'string' || !Array.isArray(p.guesses)) continue;
      const k = key(p.day, p.name);
      const old = plays.get(k);
      if (!old || p.guesses.length > old.guesses.length) plays.set(k, p);
    }
    const min = dayOf() - KEEP_DAYS;
    for (const [k, p] of plays) if (p.day < min) plays.delete(k);
  }
  const loadBoard = merge;

  async function save() {
    if (store?.enabled) {
      try {
        const [row] = await store.select('room_state', `room=eq.${SHARED}&kind=eq.besharfboard&select=data`);
        merge(row?.data);
      } catch (err) {
        console.warn('beş harf kaydı okuma', err.message);
      }
    }
    store?.save(SHARED, 'besharfboard', () => [...plays.values()]);
  }

  const rows = (p) => p.guesses.map((w) => ({ w, m: marks(w, answerOf(p.day)) }));

  // Günün tablosu: herkesin renkleri (harfsiz). Bulanlar önce, az tahmin ve kısa süre öne.
  function board(day = dayOf()) {
    return [...plays.values()].filter((p) => p.day === day && p.guesses.length)
      .map((p) => ({ name: p.name, n: p.guesses.length, done: p.done, won: p.won, ms: p.done ? p.at - p.startAt : null, m: rows(p).map((r) => r.m) }))
      .sort((a, b) => (b.won - a.won) || (b.done - a.done) || (a.won ? a.n - b.n || a.ms - b.ms : b.n - a.n));
  }

  function stats(name) {
    const mine = [...plays.values()].filter((p) => p.name === name && p.done).sort((a, b) => a.day - b.day);
    const dist = Array(MAX).fill(0);
    let max = 0;
    let run = 0;
    let prev = null;
    for (const p of mine) {
      if (p.won) dist[p.guesses.length - 1]++;
      run = p.won ? (prev != null && p.day === prev + 1 ? run + 1 : 1) : 0;
      prev = p.won ? p.day : null;
      max = Math.max(max, run);
    }
    // Seri bugün ya da dün kazanılan günle bitmeli
    const today = dayOf();
    const lastWon = mine.filter((p) => p.won).at(-1);
    const streak = lastWon && lastWon.day >= today - 1 && run > 0 ? run : 0;
    return { played: mine.length, wins: mine.filter((p) => p.won).length, streak, max, dist };
  }

  function view(name) {
    const day = dayOf();
    const p = plays.get(key(day, name));
    return {
      no: day - FIRST + 1, day, len: LEN, max: MAX, nextAt: nextAt(), now: Date.now(),
      rows: p ? rows(p) : [], done: Boolean(p?.done), won: Boolean(p?.won), answer: p?.done ? answerOf(day) : null,
      stats: stats(name), board: board(day),
    };
  }

  // Tahmin: { word }. Yanıt (ack) { ok } ya da { error }.
  function guess(room, name, word) {
    if (!name || name === BOT) return { error: 'Oynayamazsın.' };
    word = lower(word).trim();
    if ([...word].length !== LEN) return { error: `${LEN} harfli bir kelime yaz.` };
    if (!VALID.has(word)) return { error: 'Bu kelime listede yok.' };
    const day = dayOf();
    const k = key(day, name);
    const p = plays.get(k) || { day, name, guesses: [], done: false, won: false, startAt: Date.now(), at: null };
    if (p.done) return { error: 'Bugünkü kelimeyi oynadın; yarın yenisi gelir.' };
    if (p.guesses.includes(word)) return { error: 'Bu kelimeyi zaten denedin.' };
    p.guesses.push(word);
    const answer = answerOf(day);
    if (word === answer || p.guesses.length >= MAX) {
      p.done = true;
      p.won = word === answer;
      p.at = Date.now();
    }
    plays.set(k, p);
    save();
    if (p.done && room) {
      const grid = rows(p).map((r) => [...r.m].map((c) => (c === 'g' ? '🟩' : c === 'y' ? '🟨' : '⬛')).join('')).join(' ');
      const no = day - FIRST + 1;
      postSystem(room, p.won ? `${name} Beş Harf #${no} kelimesini ${p.guesses.length}/${MAX} tahminde buldu: ${grid}` : `${name} Beş Harf #${no} kelimesini bulamadı (X/${MAX}): ${grid}`);
    }
    io.to(JOINED).emit('besharf:board', { day, board: board(day) });
    return { ok: true };
  }

  function bind(socket, code) {
    const who = () => {
      const c = code();
      if (!c) return {};
      const room = getRoom(c);
      return { room, user: room?.users.get(socket.id) };
    };
    socket.on('besharf:get', (_, ack) => {
      const { user } = who();
      if (user && typeof ack === 'function') ack(view(user.name));
    });
    socket.on('besharf:guess', (arg, ack) => {
      const { room, user } = who();
      if (!user || typeof ack !== 'function') return;
      const res = guess(room, user.name, arg?.word);
      ack({ ...res, state: view(user.name) });
    });
  }

  return { view, guess, board, stats, loadBoard, bind, marks, dayOf, answerOf, LEN, MAX };
}

module.exports = { create, marks, dayOf, answerOf, nextAt, FIRST };
