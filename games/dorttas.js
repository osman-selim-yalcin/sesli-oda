// ---------- Dört Taş ----------
// 7 sütun × 6 satırlık dik tahta. İki oyuncu sırayla bir sütun seçer; taş o sütunda en alttaki boş yuvaya düşer.
// Yatay, dikey ya da çaprazda dört taşını yan yana getiren kazanır; tahta dolarsa berabere. Kimin başlayacağı rastgele.
// İki kişi; tek başına başlatılırsa rakip bilgisayardır (lobide zorluk: kolay, orta, zor).

const COLS = 7;
const ROWS = 6;
const WIN = 4;
const LEVELS = ['kolay', 'orta', 'zor'];
const DEPTH = { kolay: 2, orta: 4, zor: 7 };
const SLIP = { kolay: 0.3, orta: 0.08, zor: 0 }; // bu oranda bilgisayar rastgele (ama kaybettirmeyen) bir sütuna oynar
const BOT_DELAY = [700, 1300];
const ORDER = [3, 2, 4, 1, 5, 0, 6]; // önce ortadaki sütunlar (budama daha erken keser)

const idx = (r, c) => r * COLS + c; // r = 0 en üst satır

// Bütün dörtlüler
const LINES = [];
for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      const er = r + dr * (WIN - 1);
      const ec = c + dc * (WIN - 1);
      if (er < 0 || er >= ROWS || ec < 0 || ec >= COLS) continue;
      LINES.push(Array.from({ length: WIN }, (_, k) => idx(r + dr * k, c + dc * k)));
    }
  }
}

// Sütunda taşın düşeceği yuva; sütun doluysa -1.
function dropRow(board, col) {
  if (!Number.isInteger(col) || col < 0 || col >= COLS) return -1;
  for (let r = ROWS - 1; r >= 0; r--) if (board[idx(r, col)] == null) return r;
  return -1;
}
const canDrop = (board, col) => dropRow(board, col) >= 0;
const other = (m) => (m === 'R' ? 'Y' : 'R');

function apply(board, col, mark) {
  const r = dropRow(board, col);
  if (r < 0) return null;
  const next = board.slice();
  next[idx(r, col)] = mark;
  return { board: next, cell: idx(r, col), row: r };
}

// Kazanan dörtlü(ler)in yuvaları
function winCells(board, mark) {
  const cells = new Set();
  for (const line of LINES) if (line.every((i) => board[i] === mark)) for (const i of line) cells.add(i);
  return [...cells];
}
const full = (board) => board.every((v) => v != null);

// Tahta değeri (mark için): dörtlülerde rakip taşı yoksa taş sayısına göre artı, ortadaki sütun ayrıca değerli.
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
    if (a && !b) s += a === 3 ? 12 : a === 2 ? 3 : 0.5;
    if (b && !a) s -= b === 3 ? 14 : b === 2 ? 3 : 0.5;
  }
  for (let r = 0; r < ROWS; r++) {
    const v = board[idx(r, 3)];
    if (v === mark) s += 2;
    else if (v === them) s -= 2;
  }
  return s;
}

// Negamax + alfa-beta. Erken kazanç daha değerli (kalan derinlik eklenir).
function negamax(board, mark, depth, alpha, beta) {
  const them = other(mark);
  if (full(board) || depth === 0) return score(board, mark);
  let best = -Infinity;
  for (const c of ORDER) {
    const res = apply(board, c, mark);
    if (!res) continue;
    let v;
    if (winCells(res.board, mark).length) v = 10000 + depth;
    else v = -negamax(res.board, them, depth - 1, -beta, -alpha);
    if (v > best) best = v;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best === -Infinity ? 0 : best;
}

function botMove(board, mark, level = 'orta', rnd = Math.random) {
  const depth = DEPTH[level] || DEPTH.orta;
  const cols = ORDER.filter((c) => canDrop(board, c));
  if (!cols.length) return null;
  // Hemen kazandıran hamle her zorlukta yapılır
  for (const c of cols) if (winCells(apply(board, c, mark).board, mark).length) return c;
  const scored = cols.map((c) => {
    const next = apply(board, c, mark).board;
    return { c, v: -negamax(next, other(mark), depth - 1, -Infinity, Infinity) + rnd() * 2 };
  });
  // Rakibe hemen kazandırmayanlar
  const safe = scored.filter((m) => m.v > -9000);
  if ((SLIP[level] || 0) > rnd() && safe.length) return safe[Math.floor(rnd() * safe.length)].c;
  scored.sort((a, b) => b.v - a.v);
  return scored[0].c;
}

function create({ io, rooms, getRoom, postSystem, rand, BOT, onDone }) {
  const timers = new Map();

  const view = (game) => game && { ...game, now: Date.now() };
  const send = (room) => io.to(room.code).emit('dorttas', view(room.dorttas));
  const markOf = (game, name) => (game.players[0] === name ? 'R' : game.players[1] === name ? 'Y' : null);

  function start(room, by, players, opts = {}) {
    clearTimeout(timers.get(room.code));
    const two = players.length >= 2 ? players.slice(0, 2) : [players[0], BOT];
    if (Math.random() < 0.5) two.reverse();
    const level = LEVELS.includes(opts.level) ? opts.level : 'orta';
    room.dorttas = {
      id: Date.now(), players: two, board: Array(ROWS * COLS).fill(null), turn: 0, moves: 0, last: null, level,
      startedAt: Date.now(), endedAt: null, done: false, winner: null, line: null, reason: null,
    };
    const vs = two.includes(BOT) ? `bilgisayara karşı (${level})` : two.join(' – ');
    postSystem(room, `${by} Dört Taş başlattı: ${vs}. ${two[0] === BOT ? 'Bilgisayar' : two[0]} başlıyor.`);
    send(room);
    botLater(room);
  }

  function move(room, name, m = {}) {
    const game = room.dorttas;
    if (!game || game.done || game.players[game.turn] !== name) return;
    const mark = markOf(game, name);
    const res = apply(game.board, m.col, mark);
    if (!res) return;
    game.board = res.board;
    game.last = { col: m.col, row: res.row, cell: res.cell, by: name, mark };
    game.moves++;
    const cells = winCells(game.board, mark);
    if (cells.length) return finish(room, name, cells);
    if (full(game.board)) return finish(room, null, null, 'Tahta doldu.');
    game.turn = 1 - game.turn;
    send(room);
    botLater(room);
  }

  function finish(room, winner, line, reason) {
    const game = room.dorttas;
    if (!game || game.done) return;
    clearTimeout(timers.get(room.code));
    Object.assign(game, { done: true, winner, line: line || null, reason: reason || null, endedAt: Date.now() });
    send(room);
    onDone?.(game); // galibiyet tablosu (games/boards.js)
    const prefix = reason ? `${reason} ` : '';
    if (!winner) return postSystem(room, `${prefix}Dört Taş berabere bitti.`);
    const shown = (p) => (p === BOT ? 'Bilgisayar' : p);
    const loser = game.players.find((p) => p !== winner);
    postSystem(room, `${prefix}Dört Taş: 🏆 ${shown(winner)} kazandı${loser ? ` (${shown(loser)} karşısında)` : ''}, ${game.moves} hamle.`);
  }

  function end(room, name) {
    const game = room.dorttas;
    if (!game || game.done || !game.players.includes(name)) return;
    finish(room, game.players.find((p) => p !== name), null, `${name} oyunu bıraktı.`);
  }
  function left(room, name) {
    const game = room.dorttas;
    if (!game || game.done || !game.players.includes(name)) return;
    finish(room, game.players.find((p) => p !== name), null, `${name} ayrıldı.`);
  }
  function again(room, name) {
    const game = room.dorttas;
    if (!game?.done || !game.players.includes(name)) return;
    const here = new Set([...room.users.values()].map((u) => u.name));
    if (!game.players.every((p) => p === BOT || here.has(p))) return;
    start(room, name, game.players, { level: game.level });
  }
  function close(room) {
    if (!room.dorttas?.done) return;
    room.dorttas = null;
    send(room);
  }

  function botLater(room) {
    const game = room.dorttas;
    clearTimeout(timers.get(room.code));
    if (!game || game.done || game.players[game.turn] !== BOT) return;
    timers.set(room.code, setTimeout(() => {
      timers.delete(room.code);
      if (room.dorttas !== game || game.done || rooms.get(room.code) !== room) return;
      const col = botMove(game.board, markOf(game, BOT), game.level);
      if (col != null) move(room, BOT, { col });
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
    socket.on('dorttas:move', act(move));
    socket.on('dorttas:end', act(end));
    socket.on('dorttas:close', act(close));
    socket.on('dorttas:again', act(again));
  }

  const running = (room) => Boolean(room.dorttas && !room.dorttas.done);
  return { start, view, send, left, clear, bind, running, LEVELS };
}

module.exports = { create, apply, dropRow, winCells, botMove, LINES, COLS, ROWS, LEVELS };
