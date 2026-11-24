'use strict';

(() => {
  // Altıgenler eksen koordinatlarıyla tutulur. Her hücrede en üstteki gemi hareket eder.
  const DIRECTIONS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  const FLEET = { komuta: 1, kesif: 3, sicrama: 3, mekik: 2, kenet: 2, yanki: 1, dalis: 1, cekici: 1 };
  const step = (cell, [dq, dr]) => {
    const [q, r] = cell.split(',').map(Number);
    return `${q + dq},${r + dr}`;
  };
  const around = cell => DIRECTIONS.map(d => step(cell, d));
  const top = stack => stack?.at(-1);

  function connected(board) {
    const cells = Object.keys(board);
    if (!cells.length) return true;
    const seen = new Set([cells[0]]);
    for (const cell of seen) {
      for (const next of around(cell)) if (board[next]) seen.add(next);
    }
    return seen.size === cells.length;
  }

  function lift(board, from) {
    const rest = { ...board };
    if (board[from].length === 1) delete rest[from];
    else rest[from] = board[from].slice(0, -1);
    return rest;
  }

  function gateOpen(board, from, to) {
    const ring = around(from);
    const i = ring.indexOf(to);
    const flank = offset => board[ring[(i + offset) % 6]]?.length || 0;
    const height = Math.max(board[from]?.length || 0, board[to]?.length || 0);
    return Math.min(flank(5), flank(1)) <= height;
  }

  function kindsAt(board, cell) {
    const kind = top(board[cell]).kind;
    if (kind !== 'yanki') return [kind];
    if (board[cell].length > 1) return ['kenet'];
    return [...new Set(around(cell).map(n => top(board[n])?.kind).filter(k => k && k !== 'yanki'))];
  }

  function destinations(board, from) {
    return [...new Set(kindsAt(board, from).flatMap(kind => movesAs(board, from, kind)))];
  }

  function movesAs(board, from, kind) {
    const rest = lift(board, from);
    if (!connected(rest)) return [];
    if (kind === 'sicrama') {
      const jumps = [];
      for (const dir of DIRECTIONS) {
        let cell = step(from, dir);
        if (!rest[cell]) continue;
        while (rest[cell]) cell = step(cell, dir);
        jumps.push(cell);
      }
      return jumps;
    }
    if (kind === 'dalis') {
      const ends = new Set();
      for (const first of around(from)) {
        if (!rest[first] || !gateOpen(rest, from, first)) continue;
        for (const second of around(first)) {
          if (!rest[second] || !gateOpen(rest, first, second)) continue;
          for (const end of around(second)) {
            if (end !== from && !rest[end] && gateOpen(rest, second, end)) ends.add(end);
          }
        }
      }
      return [...ends];
    }
    function slides(cell) {
      const ring = around(cell);
      return ring.filter((to, i) => {
        const left = rest[ring[(i + 5) % 6]]?.length || 0;
        const right = rest[ring[(i + 1) % 6]]?.length || 0;
        const height = kind === 'kenet' ? Math.max(rest[cell]?.length || 0, rest[to]?.length || 0) : 0;
        if (rest[to] && kind !== 'kenet') return false;
        return (height > 0 || left + right > 0) && Math.min(left, right) <= height;
      });
    }
    if (kind === 'kesif') {
      const seen = new Set([from]);
      for (const cell of seen) for (const next of slides(cell)) seen.add(next);
      seen.delete(from);
      return [...seen];
    }
    if (kind === 'mekik') {
      const ends = new Set();
      function walk(path) {
        if (path.length === 4) return ends.add(path.at(-1));
        for (const next of slides(path.at(-1))) if (!path.includes(next)) walk([...path, next]);
      }
      walk([from]);
      return [...ends];
    }
    return slides(from);
  }

  function legalMoves(game) {
    const { board, turn, stock } = game;
    const cells = Object.keys(board);
    const empty = new Set(cells.flatMap(around).filter(cell => !board[cell]));
    if (!cells.length) empty.add('0,0');
    const sites = [...empty].filter(cell => cells.length <= 1 ||
      around(cell).every(n => !board[n] || top(board[n]).side === turn));
    const moves = [];
    for (const [kind, count] of Object.entries(stock[turn])) {
      if (!count || (kind !== 'komuta' && stock[turn].komuta && game.turns[turn] >= 3)) continue;
      for (const to of sites) moves.push({ kind, to });
    }
    if (!stock[turn].komuta) {
      for (const from of cells) {
        if (top(board[from]).side !== turn || from === game.locked) continue;
        if (kindsAt(board, from).includes('cekici')) {
          const ring = around(from);
          for (const cargo of ring) {
            if (board[cargo]?.length !== 1 || cargo === game.locked) continue;
            const rest = lift(board, cargo);
            if (!connected(rest) || !gateOpen(rest, cargo, from)) continue;
            for (const to of ring) {
              if (!board[to] && gateOpen(rest, from, to)) moves.push({ via: from, from: cargo, to });
            }
          }
        }
        for (const to of destinations(board, from)) moves.push({ from, to });
      }
    }
    return moves;
  }

  function surrounded(board) {
    const lost = [];
    for (const [cell, stack] of Object.entries(board)) {
      if (around(cell).every(n => board[n])) {
        for (const ship of stack) if (ship.kind === 'komuta') lost.push(ship.side);
      }
    }
    return lost;
  }

  function create(players) {
    const game = { id: crypto.randomUUID(), players, board: {}, stock: [{ ...FLEET }, { ...FLEET }],
      turn: 0, turns: [0, 0], revision: 0, done: false, result: '', last: null };
    game.moves = legalMoves(game);
    return game;
  }

  function play(game, move) {
    const { board, turn } = game;
    let ship;
    if (move.from) {
      ship = board[move.from].pop();
      if (!board[move.from].length) delete board[move.from];
    } else {
      ship = { kind: move.kind, side: turn };
      game.stock[turn][move.kind]--;
    }
    (board[move.to] ||= []).push(ship);
    game.last = move;
    game.locked = move.to;
    game.turns[turn]++;
    game.revision++;
    game.turn = 1 - turn;
    const lost = surrounded(board);
    if (lost.length) game.result = lost.length === 2 ? 'İki komuta gemisi de kuşatıldı. Berabere!' :
      `${game.players[1 - lost[0]]} kuşatmayı tamamladı!`;
    game.moves = game.result ? [] : legalMoves(game);
    game.passed = null;
    if (!game.result && !game.moves.length) {
      game.passed = game.players[game.turn];
      game.turns[game.turn]++;
      game.turn = turn;
      game.locked = null;
      game.moves = legalMoves(game);
      if (!game.moves.length) game.result = 'İki filonun da hamlesi kalmadı. Berabere!';
    }
    game.done = Boolean(game.result);
  }

  function botMove(game) {
    // Rakip komutanın komşuluğuna giren ve kendi komutanına alan açan hamleleri öne alır.
    const commands = [];
    for (const [cell, stack] of Object.entries(game.board)) {
      for (const ship of stack) if (ship.kind === 'komuta') commands[ship.side] = cell;
    }
    const score = move => {
      let value = Math.random() * 2;
      for (const side of [0, 1]) {
        if (!commands[side]) continue;
        const ring = around(commands[side]);
        const delta = Number(ring.includes(move.to) && !game.board[move.to]) -
          Number(ring.includes(move.from) && game.board[move.from]?.length === 1);
        value += delta * (side === game.turn ? -2 : 3);
      }
      return value;
    };
    return game.moves.map(move => ({ move, score: score(move) })).sort((a, b) => b.score - a.score)[0].move;
  }
  const rules = { create, play, botMove, destinations, legalMoves, surrounded };
  if (typeof module === 'object' && module.exports) module.exports = rules;
  else window.YorungeKurallari = rules;
})();
