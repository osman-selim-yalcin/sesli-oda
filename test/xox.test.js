// İttirmeli XOX: kurallar (koyma, zincirleme itme, dolu sıra, köşe yönleri, çift üçlü) ve sunucu akışı
// (lobiden iki kişi, sıra denetimi, bilgisayara karşı, yeniden oyna).
require('./preload');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, ack, http } = require('./helpers');
const xox = require('../games/xox');

const B = (s) => s.replace(/\s/g, '').split('').map((ch) => (ch === '.' ? null : ch));

test('kural: kenardaki taş içeri itilir, arkasındaki bitişik taşlar kayar, boşalan yere itenin taşı girer', () => {
  const b = B(`X O . O .
               . . . . .
               . . . . .
               . . . . .
               . . . . .`);
  const r = xox.apply(b, { type: 'push', cell: 0, dir: 'right' }, 'O');
  assert.deepEqual(r.board.slice(0, 5), ['O', 'X', 'O', 'O', null], 'yalnız ilk boşluğa kadar kayar');
  assert.deepEqual(r.moved, [[1, 2], [0, 1]]);
});

test('kural: sırada boş yuva yoksa itilemez; boş kenar ve iç yuva itilemez', () => {
  const b = B(`X O X O X
               O . . . .
               . . . . .
               . . . . .
               . . . . .`);
  assert.equal(xox.pushPath(b, 0, 'right'), null);
  assert.ok(xox.pushPath(b, 0, 'down'));
  assert.equal(xox.pushPath(b, 6, 'down'), null, 'iç yuva');
  assert.equal(xox.pushPath(b, 10, 'right'), null, 'boş kenar');
  assert.equal(xox.apply(b, { type: 'place', cell: 0 }, 'X'), null, 'dolu yuvaya konmaz');
});

test('kural: köşe iki yöne, kenar ortası yalnız içeri itilir', () => {
  assert.deepEqual(xox.inward(0), ['down', 'right']);
  assert.deepEqual(xox.inward(24), ['up', 'left']);
  assert.deepEqual(xox.inward(2), ['down']);
  assert.deepEqual(xox.inward(14), ['left']);
  const b = B(`. . X . .
               . . . . .
               . . . . .
               . . . . .
               . . . . .`);
  assert.equal(xox.pushPath(b, 2, 'right'), null, 'kenar boyunca itilmez');
});

test('kural: yatay, dikey, çapraz üçlü kazanır; iki tarafa üçlü olursa rakip kazanır; dolu tahta berabere', () => {
  assert.equal(xox.outcome(B('X.... .X... ..X.. ..... .....'), 'X').winner, 'X');
  assert.equal(xox.outcome(B('....O ...O. ..O.. ..... .....'), 'O').winner, 'O');
  const both = xox.outcome(B('XXX.. OOO.. ..... ..... .....'), 'X');
  assert.equal(both.winner, 'O');
  assert.equal(both.both, true);
  assert.equal(xox.outcome(B('XXOOX OOXXO XXOOX OOXXO XXOOX'), 'X').draw, true);
  // İtme yalnız rakibe üçlü yaparsa da rakip kazanır
  const b = B(`O . . . .
               . . O . .
               . . . O .
               . . . . .
               . . . . .`);
  const r = xox.apply(b, { type: 'push', cell: 0, dir: 'right' }, 'X'); // O 0->1, X 0'a: 1,7,13 çaprazında O O O
  assert.equal(xox.outcome(r.board, 'X').winner, 'O');
});

test('bilgisayar: her zaman geçerli hamle yapar, kazandıran hamleyi kaçırmaz', () => {
  const b = B('XX... OO... ..... ..... .....');
  const m = xox.botMove(b, 'X', () => 0.5);
  assert.equal(xox.outcome(xox.apply(b, m, 'X').board, 'X')?.winner, 'X');
  for (let g = 0; g < 20; g++) {
    let board = Array(25).fill(null);
    let mark = 'X';
    for (let n = 0; n < 200; n++) {
      const mv = xox.botMove(board, mark);
      const res = xox.apply(board, mv, mark);
      assert.ok(res, JSON.stringify(mv));
      board = res.board;
      if (xox.outcome(board, mark)) break;
      mark = mark === 'X' ? 'O' : 'X';
    }
  }
});

// ---------- Sunucu ----------
let srv;
const sockets = [];
before(async () => {
  srv = await startServer();
});
after(async () => {
  for (const s of sockets) s.close();
  await srv?.stop();
});

let seq = 0;
async function joined(id, name) {
  const s = await client(srv.url, name);
  sockets.push(s);
  const r = await ack(s, 'join', { token: s.token, clientId: name, room: id });
  assert.equal(r.error, undefined, JSON.stringify(r));
  return s;
}
const until = (s, event, ok, ms = 4000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { s.off(event, on); reject(new Error(`${event} gelmedi`)); }, ms);
  function on(data) {
    if (!ok(data)) return;
    clearTimeout(timer);
    s.off(event, on);
    resolve(data);
  }
  s.on(event, on);
});

test('sunucu: iki kişi lobiden başlar, sırası olmayan oynayamaz, itme ve kazanma, yeniden oyna', async () => {
  const r = await http(srv.url, 'POST', '/rooms', { token: 'test:osyalcin', body: { name: `XOX ${++seq}` } });
  const id = r.json.room.id;
  const a = await joined(id, 'Ayse');
  const b = await joined(id, 'Bora');
  const opened = until(a, 'lobbies', (l) => l.xox);
  a.emit('lobby:open', { game: 'xox' });
  await opened;
  const inLobby = until(a, 'lobbies', (l) => l.xox?.players.length === 2);
  b.emit('lobby:join', { game: 'xox' });
  await inLobby;
  const started = until(a, 'xox', (g) => g && !g.done);
  a.emit('lobby:start', { game: 'xox' });
  let g = await started;
  assert.equal(g.players.length, 2);
  const sock = { Ayse: a, Bora: b };
  const first = sock[g.players[0]];
  const second = sock[g.players[1]];

  // Sırası olmayanın hamlesi yok sayılır; sonra X koyar
  second.emit('xox:move', { type: 'place', cell: 12 });
  const moved = until(a, 'xox', (x) => x.moves === 1);
  first.emit('xox:move', { type: 'place', cell: 0 });
  g = await moved;
  assert.equal(g.board[0], 'X');
  assert.equal(g.board[12], null);
  assert.equal(g.turn, 1);

  // O, X'in köşe taşını sağa iter: X 1'e kayar, 0'a O girer
  const pushed = until(a, 'xox', (x) => x.moves === 2);
  second.emit('xox:move', { type: 'push', cell: 0, dir: 'right' });
  g = await pushed;
  assert.equal(g.board[0], 'O');
  assert.equal(g.board[1], 'X');
  assert.deepEqual(g.last.moved, [[0, 1]]);

  // X: 2 ve 3 → 1,2,3 üçlü (O araya 20, 21 koyar)
  const play = async (s, m, n) => {
    const p = until(a, 'xox', (x) => x.moves === n);
    s.emit('xox:move', m);
    return p;
  };
  await play(first, { type: 'place', cell: 2 }, 3);
  await play(second, { type: 'place', cell: 20 }, 4);
  g = await play(first, { type: 'place', cell: 3 }, 5);
  assert.equal(g.done, true);
  assert.equal(g.winner, g.players[0]);
  assert.deepEqual([...g.line].sort((x, y) => x - y), [1, 2, 3]);

  const again = until(a, 'xox', (x) => x && !x.done && x.moves === 0 && x.id !== g.id);
  b.emit('xox:again');
  const g2 = await again;
  assert.deepEqual([...g2.players].sort(), ['Ayse', 'Bora']);
});

test('sunucu: tek başına başlatılınca bilgisayar oynar', async () => {
  const r = await http(srv.url, 'POST', '/rooms', { token: 'test:osyalcin', body: { name: `XOX ${++seq}` } });
  const a = await joined(r.json.room.id, 'Cem');
  const opened = until(a, 'lobbies', (l) => l.xox);
  a.emit('lobby:open', { game: 'xox' });
  await opened;
  const started = until(a, 'xox', (g) => g && !g.done);
  a.emit('lobby:start', { game: 'xox' });
  let g = await started;
  assert.ok(g.players.includes('Cem'));
  assert.equal(g.players.length, 2);
  if (g.players[0] === 'Cem') {
    const p = until(a, 'xox', (x) => x.moves === 1);
    a.emit('xox:move', { type: 'place', cell: 12 });
    g = await p;
  }
  // Bilgisayarın hamlesi gelir
  g = await until(a, 'xox', (x) => x.players[x.turn] === 'Cem' && x.moves >= 1, 4000);
  assert.ok(g.board.some((v) => v === (g.players[0] === 'Cem' ? 'O' : 'X')));
});
