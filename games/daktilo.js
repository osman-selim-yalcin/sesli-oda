// ---------- Daktilo düellosu ----------
// Lobidekilere aynı rastgele kelime dizisi gelir; geri sayımdan sonra herkes aynı anda yazmaya başlar. Her kelime
// boşlukla gönderilir; sunucu sıradaki kelimeyle karşılaştırıp doğru/yanlış sayar. Süre (1-3 dk) bitince doğru
// kelime sayısı (kelime/dk) en yüksek olan kazanır; eşitse yanlışı az olan. 1-6 kişi, tek başına da oynanır.
// Rekorlar süreye göre ayrı tabloda, room_state 'daktiloboard' kaydında durur.

const WORDS = require('../public/tr-words');

const DURATIONS = [60, 120, 180]; // sn
const COUNTDOWN = 3000;
const LATE = 1500;        // süre bittikten sonra bu kadar geç gelen kelime de sayılır (ağ gecikmesi)
const WORD_COUNT = 400;   // 3 dakikada en hızlı yazan bile bitiremesin
const BOARD = 10;
const BOT_WPM = [28, 42];
const BOT_MISS = 0.06;

function create({ io, rooms, getRoom, postSystem, rand, pick, BOT, store }) {
  const timers = new Map(); // oda kodu -> { end, bot }
  const boards = new Map(); // oda kodu -> { 60: [{ name, wpm, wrong, at }], 120: [...], 180: [...] }

  const emptyBoard = () => Object.fromEntries(DURATIONS.map((d) => [d, []]));
  const board = (code) => {
    if (!boards.has(code)) boards.set(code, emptyBoard());
    return boards.get(code);
  };
  function mergeBoard(into, from) {
    for (const d of DURATIONS) {
      const seen = new Set();
      into[d] = [...(into[d] || []), ...(from?.[d] || [])]
        .filter((r) => {
          const key = `${r.name}|${r.at}|${r.wpm}`;
          return !seen.has(key) && seen.add(key);
        })
        .sort((a, b) => b.wpm - a.wpm || a.wrong - b.wrong || a.at - b.at)
        .slice(0, BOARD);
    }
  }
  function loadBoard(code, data) {
    const b = emptyBoard();
    mergeBoard(b, data);
    boards.set(code, b);
  }

  // Kelime listesi yalnızca oyun başlarken ve katılınca gider; yazarken gelen ilerlemede yoktur (istemci saklar).
  const view = (game, full = true) => {
    if (!game) return null;
    const { words, ...rest } = game;
    return { ...rest, ...(full ? { words } : {}), now: Date.now() };
  };
  const send = (room, full = true) => io.to(room.code).emit('daktilo', view(room.daktilo, full));

  function clearTimers(code) {
    const t = timers.get(code);
    if (t) {
      clearTimeout(t.end);
      clearTimeout(t.bot);
    }
    timers.delete(code);
  }

  function start(room, by, players, opts) {
    clearTimers(room.code);
    const secs = DURATIONS.includes(opts?.secs) ? opts.secs : 60;
    const words = Array.from({ length: WORD_COUNT }, () => pick(WORDS));
    const startAt = Date.now() + COUNTDOWN;
    room.daktilo = {
      id: Date.now(), by, players, words, secs, startAt, endAt: startAt + secs * 1000, done: false, gone: [],
      scores: Object.fromEntries(players.map((p) => [p, { i: 0, correct: 0, wrong: 0, chars: 0, marks: [] }])),
      winners: [],
    };
    postSystem(room, players.length > 1 ? `${by} ${secs / 60} dakikalık daktilo düellosu başlattı: ${players.join(' – ')}` : `${by} tek başına ${secs / 60} dakikalık daktilo çalışıyor`);
    timers.set(room.code, { end: setTimeout(() => finish(room), startAt + secs * 1000 + LATE - Date.now()) });
    send(room);
    botLater(room);
  }

  function word(room, name, { id, i, text } = {}) {
    const game = room.daktilo;
    const now = Date.now();
    if (!game || game.done || game.id !== id || !game.players.includes(name) || game.gone.includes(name)) return;
    if (now < game.startAt - 300 || now > game.endAt + LATE) return;
    const me = game.scores[name];
    if (i !== me.i || typeof text !== 'string' || text.length > 40) return;
    const ok = text === game.words[i];
    me.i++;
    me.marks.push(ok ? 1 : 0);
    if (ok) {
      me.correct++;
      me.chars += text.length + 1;
    } else me.wrong++;
    send(room, false);
  }

  const wpm = (game, s) => Math.round((s.correct / game.secs) * 60);

  async function finish(room, reason) {
    const game = room.daktilo;
    if (!game || game.done) return;
    clearTimers(room.code);
    const ranked = game.players.filter((p) => !game.gone.includes(p))
      .sort((a, b) => game.scores[b].correct - game.scores[a].correct || game.scores[a].wrong - game.scores[b].wrong);
    const top = ranked[0] && game.scores[ranked[0]];
    game.winners = top && top.correct > 0 ? ranked.filter((p) => game.scores[p].correct === top.correct && game.scores[p].wrong === top.wrong) : [];
    Object.assign(game, { done: true, reason: reason || null, endedAt: Date.now() });
    send(room);

    const line = (p) => `${p} ${wpm(game, game.scores[p])} kelime/dk${game.scores[p].wrong ? ` (${game.scores[p].wrong} yanlış)` : ''}`;
    const prefix = reason ? `${reason} ` : '';
    if (game.players.length === 1) postSystem(room, `${prefix}Daktilo: ${line(game.players[0])}.`);
    else if (game.winners.length) postSystem(room, `${prefix}Daktilo düellosu bitti: 🏆 ${game.winners.join(', ')}. ${ranked.map(line).join(' · ')}`);
    else postSystem(room, `${prefix}Daktilo düellosu bitti.`);

    // Süre sonuna kadar yazılan oyunlar rekor tablosuna girer (bot girmez)
    if (reason) return;
    const entries = ranked.filter((p) => p !== BOT && game.scores[p].correct > 0)
      .map((p) => ({ name: p, wpm: wpm(game, game.scores[p]), wrong: game.scores[p].wrong, at: game.endAt }));
    if (!entries.length) return;
    const b = board(room.code);
    if (store?.enabled) {
      try {
        const [row] = await store.select('room_state', `room=eq.${encodeURIComponent(room.code)}&kind=eq.daktiloboard&select=data`);
        mergeBoard(b, row?.data);
      } catch (err) {
        console.warn('daktilo tablosu okuma', err.message);
      }
    }
    mergeBoard(b, { [game.secs]: entries });
    store?.save(room.code, 'daktiloboard', () => b);
    io.to(room.code).emit('daktilo:board', b);
  }

  // Biri bitirirse oyun o anki sonuçlarla biter (rekora girmez).
  function end(room, name) {
    const game = room.daktilo;
    if (!game || game.done || !game.players.includes(name)) return;
    finish(room, `${name} düelloyu bitirdi.`);
  }

  function left(room, name) {
    const game = room.daktilo;
    if (!game || game.done || !game.players.includes(name) || game.gone.includes(name)) return;
    game.gone.push(name);
    if (game.players.every((p) => p === BOT || game.gone.includes(p))) return finish(room, `${name} ayrıldı.`);
    send(room);
  }

  function close(room) {
    if (!room.daktilo?.done) return;
    room.daktilo = null;
    send(room);
  }

  // Bot: dakikada 28-42 kelime, arada yanlış yazar.
  function botLater(room) {
    const game = room.daktilo;
    if (!game || game.done || !game.players.includes(BOT) || game.gone.includes(BOT)) return;
    const speed = game.botWpm || (game.botWpm = Math.round(rand(...BOT_WPM)));
    const delay = Math.max(0, game.startAt - Date.now()) + rand(0.7, 1.3) * (60000 / speed);
    const t = timers.get(room.code);
    if (!t) return;
    t.bot = setTimeout(() => {
      if (room.daktilo !== game || game.done || rooms.get(room.code) !== room) return;
      const me = game.scores[BOT];
      const w = game.words[me.i];
      word(room, BOT, { id: game.id, i: me.i, text: Math.random() < BOT_MISS ? `${w}x` : w });
      botLater(room);
    }, delay);
  }

  function bind(socket, code) {
    const act = (fn) => (value) => {
      const c = code();
      if (!c) return;
      const room = getRoom(c);
      const user = room.users.get(socket.id);
      if (user) fn(room, user.name, value);
    };
    socket.on('daktilo:word', act(word));
    socket.on('daktilo:end', act(end));
    socket.on('daktilo:close', act(close));
  }

  const running = (room) => Boolean(room.daktilo && !room.daktilo.done);

  return { start, view, send, left, clear: clearTimers, bind, running, board, loadBoard, DURATIONS };
}

module.exports = { create };
