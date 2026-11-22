// ---------- İttirmeli XOX ----------
// 5x5 tahta, başta boş. Sırası gelen kenardaki bir kareyi (boş ya da kendi işareti) alır, üstüne kendi işaretini
// koyar ve aynı satırın ya da sütunun bir ucundan geri iter; o satır/sütundaki diğer işaretler bir kayar.
// Aldığı yere geri koyamaz. Yatay, dikey ya da çaprazda beş aynı işaret yapan kazanır. Bir hamle iki tarafa da
// beşli yaparsa rakibin beşlisi sayılır (hamleyi yapan kaybeder). İki kişi; tek başına başlatılırsa rakip bilgisayardır.

const N = 5;
const MAX_MOVES = 300; // bu kadar hamlede biten olmazsa berabere
const BOT_DELAY = [700, 1500];

const idx = (r, c) => r * N + c;
const onEdge = (i) => {
  const r = Math.floor(i / N);
  const c = i % N;
  return r === 0 || c === 0 || r === N - 1 || c === N - 1;
};

// Bütün beşli çizgiler: 5 satır, 5 sütun, 2 çapraz
const LINES = [];
for (let r = 0; r < N; r++) LINES.push(Array.from({ length: N }, (_, c) => idx(r, c)));
for (let c = 0; c < N; c++) LINES.push(Array.from({ length: N }, (_, r) => idx(r, c)));
LINES.push(Array.from({ length: N }, (_, k) => idx(k, k)));
LINES.push(Array.from({ length: N }, (_, k) => idx(k, N - 1 - k)));

// from karesinden alınan taşın konabileceği uçlar: kendi satırının ve sütununun iki ucu, aldığı yer hariç.
function targets(from) {
  const r = Math.floor(from / N);
  const c = from % N;
  const out = new Set([idx(r, 0), idx(r, N - 1), idx(0, c), idx(N - 1, c)]);
  out.delete(from);
  return [...out];
}

const canTake = (board, from, mark) => Number.isInteger(from) && from >= 0 && from < N * N && onEdge(from) && (board[from] === null || board[from] === mark);
const validMove = (board, from, to, mark) => canTake(board, from, mark) && targets(from).includes(to);

// Hamleyi uygular, yeni tahtayı döner. Aynı satırdaysa satır, değilse sütun kayar.
function apply(board, from, to, mark) {
  const next = board.slice();
  const sameRow = Math.floor(from / N) === Math.floor(to / N);
  const step = sameRow ? 1 : N;
  const dir = to > from ? step : -step;
  for (let i = from; i !== to; i += dir) next[i] = next[i + dir];
  next[to] = mark;
  return next;
}

const lineOf = (board, mark) => LINES.find((line) => line.every((i) => board[i] === mark)) || null;

// Hamleden sonra kazanan: rakibin beşlisi önce gelir.
function winnerAfter(board, mark) {
  const other = mark === 'X' ? 'O' : 'X';
  const theirs = lineOf(board, other);
  if (theirs) return { mark: other, line: theirs };
  const mine = lineOf(board, mark);
  return mine ? { mark, line: mine } : null;
}

function allMoves(board, mark) {
  const moves = [];
  for (let from = 0; from < N * N; from++) {
    if (!canTake(board, from, mark)) continue;
    for (const to of targets(from)) moves.push({ from, to });
  }
  return moves;
}

// Tahta değeri: kendi işaretlerinin çizgilerdeki yoğunluğu, rakibinkinden fazlası iyi.
function score(board, mark) {
  const other = mark === 'X' ? 'O' : 'X';
  let s = 0;
  for (const line of LINES) {
    let a = 0;
    let b = 0;
    for (const i of line) {
      if (board[i] === mark) a++;
      else if (board[i] === other) b++;
    }
    if (!b) s += a * a;
    if (!a) s -= b * b * 1.2;
  }
  return s;
}

// Bilgisayar: kazandıran hamleyi yapar; kaybettireni yapmaz; rakibe bir sonraki hamlede kazanma fırsatı vermemeye
// çalışır; kalanlar arasında tahta değerine bakar, biraz da rastgele oynar (her seferinde aynı oyun olmasın).
// Yenilmez olmasın diye hamlelerin bir kısmında rakibin bir sonraki kazanma fırsatına bakmaz (BOT_CARELESS).
const BOT_CARELESS = 0.2;
function botMove(board, mark, rnd = Math.random) {
  const other = mark === 'X' ? 'O' : 'X';
  const moves = allMoves(board, mark).map((m) => {
    const next = apply(board, m.from, m.to, mark);
    return { ...m, next, win: winnerAfter(next, mark) };
  });
  const win = moves.find((m) => m.win?.mark === mark);
  if (win) return win;
  const alive = moves.filter((m) => !m.win);
  const careless = rnd() < BOT_CARELESS;
  const safe = careless ? alive : alive.filter((m) => !allMoves(m.next, other).some((o) => winnerAfter(apply(m.next, o.from, o.to, other), other)?.mark === other));
  const pool = safe.length ? safe : alive.length ? alive : moves;
  let best = null;
  let bestScore = -Infinity;
  for (const m of pool) {
    const s = score(m.next, mark) + rnd() * 6;
    if (s > bestScore) [best, bestScore] = [m, s];
  }
  return best;
}

function create({ io, rooms, getRoom, postSystem, rand, BOT }) {
  const timers = new Map(); // oda kodu -> bot zamanlayıcısı

  const view = (game) => game && { ...game, now: Date.now() };
  const send = (room) => io.to(room.code).emit('xox', view(room.xox));
  const markOf = (game, name) => (game.players[0] === name ? 'X' : game.players[1] === name ? 'O' : null);

  function start(room, by, players) {
    clearTimeout(timers.get(room.code));
    const two = players.length >= 2 ? players.slice(0, 2) : [players[0], BOT];
    if (Math.random() < 0.5) two.reverse();
    room.xox = {
      id: Date.now(), players: two, board: Array(N * N).fill(null), turn: 0, moves: 0, last: null,
      startedAt: Date.now(), endedAt: null, done: false, winner: null, line: null, reason: null,
    };
    const vs = two.includes(BOT) && players.length < 2 ? 'bilgisayara karşı' : two.join(' – ');
    postSystem(room, `${by} İttirmeli XOX başlattı: ${vs}. ${two[0]} X, başlıyor.`);
    send(room);
    botLater(room);
  }

  function move(room, name, { from, to } = {}) {
    const game = room.xox;
    if (!game || game.done || game.players[game.turn] !== name) return;
    const mark = markOf(game, name);
    if (!validMove(game.board, from, to, mark)) return;
    game.board = apply(game.board, from, to, mark);
    game.last = { from, to, by: name };
    game.moves++;
    const win = winnerAfter(game.board, mark);
    if (win) return finish(room, game.players[win.mark === 'X' ? 0 : 1], win.line);
    if (game.moves >= MAX_MOVES) return finish(room, null, null, `${MAX_MOVES} hamlede biten olmadı.`);
    game.turn = 1 - game.turn;
    send(room);
    botLater(room);
  }

  function finish(room, winner, line, reason) {
    const game = room.xox;
    if (!game || game.done) return;
    clearTimeout(timers.get(room.code));
    Object.assign(game, { done: true, winner, line, reason: reason || null, endedAt: Date.now() });
    send(room);
    const prefix = reason ? `${reason} ` : '';
    if (!winner) return postSystem(room, `${prefix}İttirmeli XOX berabere bitti.`);
    const loser = game.players.find((p) => p !== winner);
    postSystem(room, `${prefix}İttirmeli XOX: 🏆 ${winner} kazandı${loser ? ` (${loser}'a karşı)` : ''}, ${game.moves} hamle.`);
  }

  // Oyunculardan biri bitirirse ya da ayrılırsa öbürü kazanır.
  function end(room, name) {
    const game = room.xox;
    if (!game || game.done || !game.players.includes(name)) return;
    finish(room, game.players.find((p) => p !== name), null, `${name} oyunu bıraktı.`);
  }
  const left = (room, name) => {
    const game = room.xox;
    if (!game || game.done || !game.players.includes(name)) return;
    finish(room, game.players.find((p) => p !== name), null, `${name} ayrıldı.`);
  };

  function close(room) {
    if (!room.xox?.done) return;
    room.xox = null;
    send(room);
  }

  function botLater(room) {
    const game = room.xox;
    clearTimeout(timers.get(room.code));
    if (!game || game.done || game.players[game.turn] !== BOT) return;
    timers.set(room.code, setTimeout(() => {
      timers.delete(room.code);
      if (room.xox !== game || game.done || rooms.get(room.code) !== room) return;
      const m = botMove(game.board, markOf(game, BOT));
      if (m) move(room, BOT, m);
    }, rand(...BOT_DELAY)));
  }

  function clear(code) {
    clearTimeout(timers.get(code));
    timers.delete(code);
  }

  function bind(socket, code) {
    const act = (fn) => (value) => {
      const c = code();
      if (!c) return;
      const room = getRoom(c);
      const user = room.users.get(socket.id);
      if (user) fn(room, user.name, value);
    };
    socket.on('xox:move', act(move));
    socket.on('xox:end', act(end));
    socket.on('xox:close', act(close));
  }

  const running = (room) => Boolean(room.xox && !room.xox.done);

  return { start, view, send, left, clear, bind, running };
}

module.exports = { create, apply, targets, validMove, winnerAfter, botMove, allMoves, N };
