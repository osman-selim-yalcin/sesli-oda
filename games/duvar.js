// ---------- Duvar ----------
// Kurallar public/duvar-core.js'te (istemciyle ortak). İki oyuncu; piyonunu karşı kenara ilk ulaştıran kazanır. Sırası
// gelen ya piyonunu yürütür ya da rakibin yolunu uzatmak için duvar koyar (kişi başı 10). Kimin başlayacağı rastgele.
// Tek başına başlatılırsa rakip bilgisayardır (lobide zorluk: kolay, orta, zor).

const D = require('../public/duvar-core');

const LEVELS = ['kolay', 'orta', 'zor'];
const BOT_DELAY = [700, 1300];

// Rakibin en kısa yolundaki ilk adımları kesen duvarlar (bilgisayarın denediği duvarlar)
function candidateWalls(walls, pos, target, steps = 8) {
  const sp = D.shortest(walls, pos[target], D.GOAL[target], true);
  const out = new Map();
  if (!sp) return [];
  const path = sp.path.slice(0, steps + 1);
  const add = (o, r, c) => {
    const k = D.key(o, r, c);
    if (!out.has(k) && D.wallOk(walls, pos, o, r, c)) out.set(k, { o, r, c });
  };
  for (let i = 1; i < path.length; i++) {
    const [r1, c1] = path[i - 1];
    const [r2, c2] = path[i];
    if (r1 !== r2) {
      const r = Math.min(r1, r2);
      add('h', r, c1);
      add('h', r, c1 - 1);
    } else {
      const c = Math.min(c1, c2);
      add('v', r1, c);
      add('v', r1 - 1, c);
    }
  }
  return [...out.values()];
}

// Durum değeri (p için): rakibin yolu − kendi yolu; ellerdeki duvarlar biraz değerli
function evaluate(walls, pos, left, p) {
  const me = D.shortest(walls, pos[p], D.GOAL[p]);
  const them = D.shortest(walls, pos[1 - p], D.GOAL[1 - p]);
  if (me === 0) return 1000;
  if (them === 0) return -1000;
  return them - me + (left[p] - left[1 - p]) * 0.15;
}

// p'nin yapabileceği hamleler: { type: 'move', r, c } ya da { type: 'wall', o, r, c }
function actions(walls, pos, left, p, wallsToo = true) {
  const list = D.moves(walls, pos, p).map(([r, c]) => ({ type: 'move', r, c }));
  if (wallsToo && left[p] > 0) for (const w of candidateWalls(walls, pos, 1 - p)) list.push({ type: 'wall', ...w });
  return list;
}
function play(walls, pos, left, p, a) {
  if (a.type === 'move') {
    const next = pos.map((x) => x.slice());
    next[p] = [a.r, a.c];
    return { walls, pos: next, left };
  }
  const nl = left.slice();
  nl[p]--;
  return { walls: new Set(walls).add(D.key(a.o, a.r, a.c)), pos, left: nl };
}

function botMove(game, p, rnd = Math.random) {
  const walls = D.wallSet(game.walls);
  const { pos, left } = game;
  const level = game.level || 'orta';
  const mine = D.moves(walls, pos, p);
  // Hedefe tek adımsa her zorlukta oraya
  const win = mine.find(([r]) => r === D.GOAL[p]);
  if (win) return { type: 'move', r: win[0], c: win[1] };
  const stepAlongPath = () => {
    // en kısa yolu en çok kısaltan kare
    let best = null;
    for (const [r, c] of mine) {
      const np = pos.map((x) => x.slice());
      np[p] = [r, c];
      const d = D.shortest(walls, np[p], D.GOAL[p]) + rnd() * 0.5;
      if (!best || d < best.d) best = { d, r, c };
    }
    return best && { type: 'move', r: best.r, c: best.c };
  };
  if (level === 'kolay') {
    if (left[p] > 0 && rnd() < 0.22) {
      const ws = candidateWalls(walls, pos, 1 - p, 4);
      if (ws.length) return { type: 'wall', ...ws[Math.floor(rnd() * ws.length)] };
    }
    return stepAlongPath();
  }
  const all = actions(walls, pos, left, p);
  if (level === 'orta') {
    let best = null;
    for (const a of all) {
      const s = play(walls, pos, left, p, a);
      // duvar, rakibin yolunu yürümenin kazandırdığından belirgin biçimde fazla uzatmıyorsa yürümek seçilir
      const v = evaluate(s.walls, s.pos, s.left, p) - (a.type === 'wall' ? 0.4 : 0) + rnd() * 0.4;
      if (!best || v > best.v) best = { v, a };
    }
    return best?.a || stepAlongPath();
  }
  // zor: rakibin en iyi cevabını da hesaba katar (iki kat)
  let best = null;
  for (const a of all) {
    const s = play(walls, pos, left, p, a);
    if (a.type === 'move' && a.r === D.GOAL[p]) return a;
    let worst = Infinity;
    for (const b of actions(s.walls, s.pos, s.left, 1 - p)) {
      const t = play(s.walls, s.pos, s.left, 1 - p, b);
      const v = t.pos[1 - p][0] === D.GOAL[1 - p] ? -1000 : evaluate(t.walls, t.pos, t.left, p);
      if (v < worst) worst = v;
      if (best && worst <= best.v) break; // budama: bundan iyisi var
    }
    const v = worst - (a.type === 'wall' ? 0.3 : 0) + rnd() * 0.2;
    if (!best || v > best.v) best = { v, a };
  }
  return best?.a || stepAlongPath();
}

function create({ io, rooms, getRoom, postSystem, rand, BOT }) {
  const timers = new Map();

  const view = (game) => game && { ...game, now: Date.now() };
  const send = (room) => io.to(room.code).emit('duvar', view(room.duvar));
  const shown = (p) => (p === BOT ? 'Bilgisayar' : p);

  function start(room, by, players, opts = {}) {
    clearTimeout(timers.get(room.code));
    const two = players.length >= 2 ? players.slice(0, 2) : [players[0], BOT];
    if (Math.random() < 0.5) two.reverse();
    const level = LEVELS.includes(opts.level) ? opts.level : 'orta';
    room.duvar = {
      id: Date.now(), players: two, pos: D.START.map((x) => x.slice()), walls: [], left: [D.WALLS, D.WALLS], turn: 0, moves: 0,
      last: null, level, startedAt: Date.now(), endedAt: null, done: false, winner: null, reason: null,
    };
    const vs = two.includes(BOT) ? `bilgisayara karşı (${level})` : two.join(' – ');
    postSystem(room, `${by} Duvar başlattı: ${vs}. ${shown(two[0])} başlıyor.`);
    send(room);
    botLater(room);
  }

  // Hamle: { type: 'move', r, c } ya da { type: 'wall', o: 'h'|'v', r, c }. Hata varsa açıklaması döner.
  function act(room, name, a = {}) {
    const game = room.duvar;
    if (!game || game.done) return 'Oyun yok.';
    const p = game.players.indexOf(name);
    if (p < 0 || game.turn !== p) return 'Sıra sende değil.';
    const walls = D.wallSet(game.walls);
    if (a?.type === 'move') {
      if (!D.moves(walls, game.pos, p).some(([r, c]) => r === a.r && c === a.c)) return 'Oraya gidemezsin.';
      game.pos[p] = [a.r, a.c];
      game.last = { type: 'move', by: name, r: a.r, c: a.c };
    } else if (a?.type === 'wall') {
      if (game.left[p] <= 0) return 'Duvarın kalmadı.';
      if (!D.wallFits(walls, a.o, a.r, a.c)) return 'Oraya duvar sığmıyor.';
      if (!D.wallOk(walls, game.pos, a.o, a.r, a.c)) return 'Bu duvar birinin bütün yolunu kapatır.';
      game.walls.push({ o: a.o, r: a.r, c: a.c, p });
      game.left[p]--;
      game.last = { type: 'wall', by: name, o: a.o, r: a.r, c: a.c };
    } else return 'Geçersiz hamle.';
    game.moves++;
    if (game.pos[p][0] === D.GOAL[p]) {
      finish(room, name);
      return null;
    }
    game.turn = 1 - p;
    send(room);
    botLater(room);
    return null;
  }

  function finish(room, winner, reason) {
    const game = room.duvar;
    if (!game || game.done) return;
    clearTimeout(timers.get(room.code));
    Object.assign(game, { done: true, winner, reason: reason || null, endedAt: Date.now() });
    send(room);
    const prefix = reason ? `${reason} ` : '';
    const loser = game.players.find((p) => p !== winner);
    postSystem(room, `${prefix}Duvar: 🏆 ${shown(winner)} kazandı${loser ? ` (${shown(loser)} karşısında)` : ''}, ${game.moves} hamle.`);
  }

  function end(room, name) {
    const game = room.duvar;
    if (!game || game.done || !game.players.includes(name)) return;
    finish(room, game.players.find((p) => p !== name), `${name} oyunu bıraktı.`);
  }
  function left(room, name) {
    const game = room.duvar;
    if (!game || game.done || !game.players.includes(name)) return;
    finish(room, game.players.find((p) => p !== name), `${name} ayrıldı.`);
  }
  function again(room, name) {
    const game = room.duvar;
    if (!game?.done || !game.players.includes(name)) return;
    const here = new Set([...room.users.values()].map((u) => u.name));
    if (!game.players.every((p) => p === BOT || here.has(p))) return;
    start(room, name, game.players, { level: game.level });
  }
  function close(room) {
    if (!room.duvar?.done) return;
    room.duvar = null;
    send(room);
  }

  function botLater(room) {
    const game = room.duvar;
    clearTimeout(timers.get(room.code));
    if (!game || game.done || game.players[game.turn] !== BOT) return;
    timers.set(room.code, setTimeout(() => {
      timers.delete(room.code);
      if (room.duvar !== game || game.done || rooms.get(room.code) !== room) return;
      const a = botMove(game, game.turn);
      if (!a || act(room, BOT, a)) {
        // bilgisayar geçerli hamle bulamazsa (olmamalı) yolda bir adım
        const [r, c] = D.moves(D.wallSet(game.walls), game.pos, game.turn)[0] || [];
        if (r != null) act(room, BOT, { type: 'move', r, c });
      }
    }, rand(...BOT_DELAY)));
  }

  function clear(code) {
    clearTimeout(timers.get(code));
    timers.delete(code);
  }

  function bind(socket, code) {
    const ctx = () => {
      const c = code();
      if (!c) return {};
      const room = getRoom(c);
      return { room, user: room?.users.get(socket.id) };
    };
    socket.on('duvar:act', (a, ack) => {
      const { room, user } = ctx();
      if (!user) return;
      const error = act(room, user.name, a);
      if (typeof ack === 'function') ack(error ? { error } : { ok: true });
    });
    for (const [ev, fn] of [['duvar:end', end], ['duvar:close', close], ['duvar:again', again]]) {
      socket.on(ev, () => {
        const { room, user } = ctx();
        if (user) fn(room, user.name);
      });
    }
  }

  const running = (room) => Boolean(room.duvar && !room.duvar.done);
  return { start, act, view, send, left, clear, bind, running, LEVELS };
}

module.exports = { create, botMove, candidateWalls, evaluate, LEVELS };
