// Duvar: kurallar (public/duvar-core.js), oyun akışı ve bilgisayar (games/duvar.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../public/duvar-core');
const { create, botMove } = require('../games/duvar');

const W = (...list) => D.wallSet(list.map(([o, r, c]) => ({ o, r, c })));
const sorted = (cells) => cells.map(([r, c]) => `${r}${c}`).sort();

test('Duvar: piyon dört yöne gider; kenar ve duvar geçişi kapatır', () => {
  assert.deepEqual(sorted(D.moves(W(), [[8, 4], [0, 4]], 0)), ['74', '83', '85']);
  // (8,4)'ün üstüne yatay duvar (7. ve 8. satır arası, 4-5. sütun)
  assert.deepEqual(sorted(D.moves(W(['h', 7, 4]), [[8, 4], [0, 4]], 0)), ['83', '85']);
  // aynı oluğun 3-4. sütun parçası da kapatır
  assert.deepEqual(sorted(D.moves(W(['h', 7, 3]), [[8, 4], [0, 4]], 0)), ['83', '85']);
  // dikey duvar sağa geçişi kapatır
  assert.deepEqual(sorted(D.moves(W(['v', 7, 4]), [[8, 4], [0, 4]], 0)), ['74', '83']);
});

test('Duvar: rakibin üstünden atlanır; arkası kapalıysa yanlara (çapraz) geçilir', () => {
  // rakip hemen üstte, arkası açık: düz atlama
  assert.deepEqual(sorted(D.moves(W(), [[5, 4], [4, 4]], 0)), ['34', '53', '55', '64']);
  // rakibin arkası duvar: yanlarına
  assert.deepEqual(sorted(D.moves(W(['h', 3, 4]), [[5, 4], [4, 4]], 0)), ['43', '45', '53', '55', '64']);
  // rakip kenarda (arkası tahta dışı): yanlarına
  assert.deepEqual(sorted(D.moves(W(), [[1, 4], [0, 4]], 0)), ['03', '05', '13', '15', '24']);
});

test('Duvar: duvarlar üst üste binemez, çaprazlanamaz, tahtadan taşamaz', () => {
  const ws = W(['h', 3, 3]);
  assert.equal(D.wallFits(ws, 'h', 3, 3), false);
  assert.equal(D.wallFits(ws, 'h', 3, 2), false);
  assert.equal(D.wallFits(ws, 'h', 3, 4), false);
  assert.equal(D.wallFits(ws, 'v', 3, 3), false); // aynı noktada çapraz
  assert.equal(D.wallFits(ws, 'h', 3, 5), true);
  assert.equal(D.wallFits(ws, 'v', 2, 3), true);
  assert.equal(D.wallFits(W(['v', 3, 3]), 'v', 4, 3), false);
  assert.equal(D.wallFits(W(), 'h', 8, 0), false);
  assert.equal(D.wallFits(W(), 'x', 1, 1), false);
});

test('Duvar: kimsenin bütün yolu kapatılamaz', () => {
  // 0. satırın altını boydan boya kapat (h 0,0 / 0,2 / 0,4 / 0,6), 8. sütun açık kalır
  const ws = W(['h', 0, 0], ['h', 0, 2], ['h', 0, 4], ['h', 0, 6]);
  const pos = [[8, 4], [0, 4]];
  assert.ok(D.shortest(ws, pos[0], 0) > 0);
  // son açıklığı (8. sütun) kapatacak duvar: 7-8. sütunlar dikeyle çakışmadan kapatılamaz; v ile kapatma denemesi
  assert.equal(D.wallOk(W(['h', 0, 0], ['h', 0, 2], ['h', 0, 4], ['v', 0, 7], ['h', 1, 7]), pos, 'h', 0, 5), false);
  // köşedeki piyon: sağı dikey duvarla kapalı (0. ve 1. satır); altını kapatan duvar onu hapseder, konamaz
  const corner = [[8, 4], [0, 0]];
  assert.equal(D.wallOk(W(['v', 0, 0]), corner, 'h', 1, 0), false);
  assert.equal(D.wallOk(W(['v', 0, 0]), corner, 'h', 2, 0), true);
  assert.equal(D.shortest(W(), [8, 4], 0), 8);
  const sp = D.shortest(W(), [8, 4], 0, true);
  assert.equal(sp.path.length, 9);
});

function fakeRoom(names) {
  const posts = [];
  const sent = [];
  const room = { code: 'r1', users: new Map(names.map((n, i) => [`s${i}`, { name: n }])), duvar: null };
  const io = { to: () => ({ emit: (ev, data) => sent.push([ev, data]) }) };
  const g = create({ io, rooms: new Map([['r1', room]]), getRoom: () => room, postSystem: (r, t) => posts.push(t), rand: () => 10, BOT: 'Bot' });
  return { g, room, posts, sent };
}

test('Duvar: sıra, geçersiz hamle, duvar sayısı ve kazanma', () => {
  const { g, room, posts } = fakeRoom(['Ali', 'Ece']);
  g.start(room, 'Ali', ['Ali', 'Ece']);
  const game = room.duvar;
  const [a, b] = game.players;
  assert.match(posts[0], /Duvar başlattı/);
  assert.match(g.act(room, b, { type: 'move', r: 1, c: 4 }), /Sıra/);
  assert.match(g.act(room, a, { type: 'move', r: 5, c: 5 }), /gidemezsin/);
  assert.match(g.act(room, a, { type: 'wall', o: 'h', r: 9, c: 0 }), /sığmıyor/);
  assert.equal(g.act(room, a, { type: 'wall', o: 'h', r: 3, c: 3 }), null);
  assert.deepEqual(game.left, [9, 10]);
  assert.equal(game.turn, 1);
  assert.match(g.act(room, b, { type: 'wall', o: 'v', r: 3, c: 3 }), /sığmıyor/); // çapraz
  // duvar bitince duvar konamaz
  game.left[1] = 0;
  assert.match(g.act(room, b, { type: 'wall', o: 'h', r: 5, c: 0 }), /kalmadı/);
  // kazanma: a hedefe bir adım uzakta
  game.left[1] = 10;
  assert.equal(g.act(room, b, { type: 'move', r: 1, c: 4 }), null);
  game.pos[0] = [1, 0];
  assert.equal(g.act(room, a, { type: 'move', r: 0, c: 0 }), null);
  assert.equal(game.done, true);
  assert.equal(game.winner, a);
  assert.match(posts.at(-1), /Duvar: 🏆/);
  g.clear('r1');
});

test('Duvar: bilgisayar her zorlukta yalnız kurallara uygun hamle yapar ve oyunu bitirir', () => {
  for (const level of ['kolay', 'orta', 'zor']) {
    const game = { pos: D.START.map((x) => x.slice()), walls: [], left: [10, 10], turn: 0, level };
    let done = false;
    for (let n = 0; n < 300 && !done; n++) {
      const p = game.turn;
      const a = botMove(game, p);
      const ws = D.wallSet(game.walls);
      if (a.type === 'move') {
        assert.ok(D.moves(ws, game.pos, p).some(([r, c]) => r === a.r && c === a.c), `${level}: kuralsız adım`);
        game.pos[p] = [a.r, a.c];
      } else {
        assert.ok(game.left[p] > 0 && D.wallOk(ws, game.pos, a.o, a.r, a.c), `${level}: kuralsız duvar`);
        game.walls.push(a);
        game.left[p]--;
      }
      done = game.pos[p][0] === D.GOAL[p];
      game.turn = 1 - p;
    }
    assert.ok(done, `${level}: oyun bitmedi`);
  }
});
