// ---------- İttirmeli XOX ----------
// 5x5 tahta, 25 yuva, başta boş. İki oyuncu (X ve O) sırayla oynar; X başlar, kimin X olacağı rastgele.
// Sırası gelen iki hamleden birini yapar:
//   - Koy: boş bir yuvaya kendi taşını koyar.
//   - İt: dış halkada dolu bir yuvayı (kimin taşı olursa olsun) tahtanın içine doğru bir kare iter. Arkasındaki bitişik
//     taşlar da birer kayar; o yönde en az bir boş yuva yoksa itilemez. Boşalan kenar yuvasına itenin taşı girer.
//     Köşeler iki yöne de itilebilir.
// Yatay, dikey ya da çaprazda üç aynı taşı yan yana getiren kazanır. Bir itme iki tarafa da üçlü yaparsa rakip kazanır.
// 25 yuva dolar ve kimse üçlü yapamamışsa berabere. İki kişi; tek başına başlatılırsa rakip bilgisayardır.

const N = 5;
const WIN = 3;
const BOT_DELAY = [700, 1400];
const BOT_CARELESS = 0.2; // bu oranda bilgisayar rakibin bir sonraki kazanma fırsatına bakmaz (yenilebilsin)

const idx = (r, c) => r * N + c;
const rc = (i) => [Math.floor(i / N), i % N];
const onEdge = (i) => {
  const [r, c] = rc(i);
  return r === 0 || c === 0 || r === N - 1 || c === N - 1;
};
const other = (mark) => (mark === 'X' ? 'O' : 'X');

// İtme yönleri: 'down' | 'up' | 'right' | 'left' (taşın gideceği yön)
const DIRS = { down: [1, 0], up: [-1, 0], right: [0, 1], left: [0, -1] };

// Kenar yuvasının içeri doğru yönleri: üst kenar aşağı, sol kenar sağa…; köşede iki yön.
function inward(i) {
  const [r, c] = rc(i);
  const out = [];
  if (r === 0) out.push('down');
  if (r === N - 1) out.push('up');
  if (c === 0) out.push('right');
  if (c === N - 1) out.push('left');
  return out;
}

// Bütün üçlüler: satırlar, sütunlar ve iki çapraz yönde.
const LINES = [];
for (let r = 0; r < N; r++) {
  for (let c = 0; c < N; c++) {
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      const er = r + dr * (WIN - 1);
      const ec = c + dc * (WIN - 1);
      if (er < 0 || er >= N || ec < 0 || ec >= N) continue;
      LINES.push(Array.from({ length: WIN }, (_, k) => idx(r + dr * k, c + dc * k)));
    }
  }
}

// Kenardan dir yönünde itilince kayan yuvalar: itilen yuvadan ilk boş yuvaya kadar (ikisi dahil). Boş yoksa null.
function pushPath(board, cell, dir) {
  if (!Number.isInteger(cell) || cell < 0 || cell >= N * N || !DIRS[dir]) return null;
  if (board[cell] == null || !onEdge(cell) || !inward(cell).includes(dir)) return null;
  const [dr, dc] = DIRS[dir];
  let [r, c] = rc(cell);
  const path = [];
  while (r >= 0 && r < N && c >= 0 && c < N) {
    const i = idx(r, c);
    path.push(i);
    if (board[i] == null) return path;
    r += dr;
    c += dc;
  }
  return null;
}

const canPlace = (board, cell) => Number.isInteger(cell) && cell >= 0 && cell < N * N && board[cell] == null;

// Hamleyi uygular: { board, moved: [[from, to], ...] } (moved yalnız itmede). Geçersizse null.
function apply(board, move, mark) {
  if (move?.type === 'place') {
    if (!canPlace(board, move.cell)) return null;
    const next = board.slice();
    next[move.cell] = mark;
    return { board: next, moved: [] };
  }
  if (move?.type === 'push') {
    const path = pushPath(board, move.cell, move.dir);
    if (!path) return null;
    const next = board.slice();
    const moved = [];
    for (let k = path.length - 1; k > 0; k--) {
      next[path[k]] = next[path[k - 1]];
      moved.push([path[k - 1], path[k]]);
    }
    next[move.cell] = mark;
    return { board: next, moved };
  }
  return null;
}

const linesOf = (board, mark) => LINES.filter((line) => line.every((i) => board[i] === mark));

// Hamleden sonraki sonuç: { winner: 'X'|'O'|null, cells: [...] , draw }. İki tarafa da üçlü olursa rakip kazanır.
function outcome(board, mover) {
  const mine = linesOf(board, mover);
  const theirs = linesOf(board, other(mover));
  if (theirs.length) return { winner: other(mover), cells: [...new Set(theirs.flat())], both: mine.length > 0 };
  if (mine.length) return { winner: mover, cells: [...new Set(mine.flat())], both: false };
  if (board.every((v) => v != null)) return { winner: null, draw: true, cells: [] };
  return null;
}

function allMoves(board) {
  const moves = [];
  for (let i = 0; i < N * N; i++) {
    if (board[i] == null) moves.push({ type: 'place', cell: i });
    else if (onEdge(i)) for (const dir of inward(i)) if (pushPath(board, i, dir)) moves.push({ type: 'push', cell: i, dir });
  }
  return moves;
}

// Tahta değeri: üçlülerde iki taşı olup üçüncüsü boş olanlar (tehdit) ve tek taşlılar; rakibinki eksi.
function score(board, mark) {
  const them = other(mark);
  let s = 0;
  for (const line of LINES) {
    let a = 0;
    let b = 0;
    for (const i of line) {
      if (board[i] === mark) a++;
      else if (board[i] === them) b++;
    }
    if (!b) s += a === 2 ? 10 : a;
    if (!a) s -= b === 2 ? 12 : b;
  }
  // Orta yuvalar kenardakilerden değerli (itilemezler)
  for (let i = 0; i < N * N; i++) if (!onEdge(i)) s += board[i] === mark ? 1.5 : board[i] === them ? -1.5 : 0;
  return s;
}

const winsNow = (board, mark) => allMoves(board).some((m) => apply(board, m, mark) && outcome(apply(board, m, mark).board, mark)?.winner === mark);

// Bilgisayar: kazandıran hamleyi yapar, kaybettireni yapmaz, rakibe bir sonraki hamlede kazanma fırsatı vermemeye
// çalışır; kalanlar arasında tahta değerine bakar, biraz da rastgele oynar.
function botMove(board, mark, rnd = Math.random) {
  const scored = allMoves(board).map((m) => {
    const next = apply(board, m, mark).board;
    return { ...m, next, res: outcome(next, mark) };
  });
  const win = scored.find((m) => m.res?.winner === mark);
  if (win) return win;
  const alive = scored.filter((m) => !m.res || m.res.draw);
  const careless = rnd() < BOT_CARELESS;
  const safe = careless ? alive : alive.filter((m) => m.res?.draw || !winsNow(m.next, other(mark)));
  const pool = safe.length ? safe : alive.length ? alive : scored;
  let best = null;
  let bestScore = -Infinity;
  for (const m of pool) {
    const s = score(m.next, mark) + rnd() * 4;
    if (s > bestScore) [best, bestScore] = [m, s];
  }
  return best && { type: best.type, cell: best.cell, dir: best.dir };
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
      startedAt: Date.now(), endedAt: null, done: false, winner: null, line: null, reason: null, both: false,
    };
    const vs = two.includes(BOT) ? 'bilgisayara karşı' : two.join(' – ');
    postSystem(room, `${by} İttirmeli XOX başlattı: ${vs}. ${two[0]} X, başlıyor.`);
    send(room);
    botLater(room);
  }

  function move(room, name, m = {}) {
    const game = room.xox;
    if (!game || game.done || game.players[game.turn] !== name) return;
    const mark = markOf(game, name);
    const type = m.type === 'push' ? 'push' : 'place';
    const res = apply(game.board, { type, cell: m.cell, dir: m.dir }, mark);
    if (!res) return;
    game.board = res.board;
    game.last = { type, cell: m.cell, dir: type === 'push' ? m.dir : null, moved: res.moved, by: name, mark };
    game.moves++;
    const end = outcome(game.board, mark);
    if (end?.winner) {
      game.both = end.both;
      return finish(room, game.players[end.winner === 'X' ? 0 : 1], end.cells, end.both ? `${name} iki tarafa da üçlü yaptı, rakip kazanır.` : null);
    }
    if (end?.draw) return finish(room, null, null, 'Tahta doldu.');
    game.turn = 1 - game.turn;
    send(room);
    botLater(room);
  }

  function finish(room, winner, line, reason) {
    const game = room.xox;
    if (!game || game.done) return;
    clearTimeout(timers.get(room.code));
    Object.assign(game, { done: true, winner, line: line || null, reason: reason || null, endedAt: Date.now() });
    send(room);
    const prefix = reason ? `${reason} ` : '';
    if (!winner) return postSystem(room, `${prefix}İttirmeli XOX berabere bitti.`);
    const loser = game.players.find((p) => p !== winner);
    postSystem(room, `${prefix}İttirmeli XOX: 🏆 ${winner} kazandı${loser ? ` (${loser} karşısında)` : ''}, ${game.moves} hamle.`);
  }

  // Oyunculardan biri bırakırsa ya da ayrılırsa öbürü kazanır.
  function end(room, name) {
    const game = room.xox;
    if (!game || game.done || !game.players.includes(name)) return;
    finish(room, game.players.find((p) => p !== name), null, `${name} oyunu bıraktı.`);
  }
  function left(room, name) {
    const game = room.xox;
    if (!game || game.done || !game.players.includes(name)) return;
    finish(room, game.players.find((p) => p !== name), null, `${name} ayrıldı.`);
  }

  // Yeniden oyna: biten oyunun iki oyuncusundan biri aynı ikiliyle hemen yeni oyun başlatır (ikisi de odadaysa).
  function again(room, name) {
    const game = room.xox;
    if (!game?.done || !game.players.includes(name)) return;
    const here = new Set([...room.users.values()].map((u) => u.name));
    if (!game.players.every((p) => p === BOT || here.has(p))) return;
    start(room, name, game.players);
  }

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
    socket.on('xox:again', act(again));
  }

  const running = (room) => Boolean(room.xox && !room.xox.done);

  return { start, view, send, left, clear, bind, running };
}

module.exports = { create, apply, pushPath, inward, outcome, allMoves, botMove, LINES, N };
