// Ortak rekor tabloları: Mantık tablosu, Hızlı okuma, Dört Taş, Duvar (games/boards.js) ve Beş Harf tüm zamanlar.
require('./preload');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, ack, http } = require('./helpers');
const boardsMod = require('../games/boards');
const bh = require('../games/besharf');

const BOT = '🤖 Bot';
function fake() {
  const sent = [];
  const io = { to: () => ({ emit: (event, data) => sent.push({ event, data }) }) };
  return { sent, b: boardsMod.create({ io, getRoom: () => null, BOT, store: null, SHARED: 'ortak', JOINED: '@joined' }) };
}

test('Mantık: çözenler zorluğa göre tabloya girer, bot girmez, en yüksek puan önde', async () => {
  const { b, sent } = fake();
  await b.mantikDone({ level: 'kolay', endedAt: 1000, finished: { Ali: { points: 700, ms: 150000, wrong: 1 }, [BOT]: { points: 900, ms: 60000, wrong: 0 } } });
  await b.mantikDone({ level: 'kolay', endedAt: 2000, finished: { Can: { points: 800, ms: 100000, wrong: 0 }, Ali: { points: 800, ms: 90000, wrong: 0 } } });
  await b.mantikDone({ level: 'zor', endedAt: 3000, finished: { Can: { points: 1500, ms: 250000, wrong: 0 } } });
  const t = b.mantikBoard();
  assert.deepEqual(t.kolay.map((r) => [r.name, r.points]), [['Ali', 800], ['Can', 800], ['Ali', 700]], 'eşit puanda kısa süre önde');
  assert.deepEqual(t.zor.map((r) => r.name), ['Can']);
  assert.equal(sent.at(-1).event, 'mantik:board');
  await b.mantikDone({ level: 'kolay', endedAt: 4000, finished: {} });
  assert.equal(b.mantikBoard().kolay.length, 3, 'kimse çözmediyse kayıt yok');
});

test('Hızlı okuma: kişinin en iyisi tutulur, akla yatkın olmayan sonuç reddedilir', () => {
  const { b } = fake();
  assert.equal(b.okumaResult('Ali', { d: 'yatay', score: 300 }).improved, true);
  assert.equal(b.okumaResult('Ali', { d: 'yatay', score: 200 }).improved, false, 'eskisinden kötü');
  assert.equal(b.okumaResult('Can', { d: 'yatay', score: 450 }).improved, true);
  assert.equal(b.okumaResult('Ali', { d: 'tablo', size: 5, ms: 20000 }).improved, true);
  assert.equal(b.okumaResult('Ali', { d: 'tablo', size: 5, ms: 18000 }).improved, true, 'daha kısa süre daha iyi');
  assert.equal(b.okumaResult('Ali', { d: 'takisto', score: 4, n: 2 }).improved, true);
  for (const bad of [{ d: 'yok', score: 5 }, { d: 'yatay', score: -1 }, { d: 'yatay', score: 1.5 }, { d: 'tablo', size: 9, ms: 30000 },
    { d: 'tablo', size: 5, ms: 1000 }, { d: 'takisto', score: 11 }, null]) {
    assert.ok(b.okumaResult('Ali', bad).error, JSON.stringify(bad));
  }
  assert.ok(b.okumaResult(BOT, { d: 'yatay', score: 999 }).error, 'bot giremez');
  const t = b.okumaBoard();
  assert.deepEqual(t.yatay.map((r) => [r.name, r.score]), [['Can', 450], ['Ali', 300]]);
  assert.deepEqual(t['tablo-5'].map((r) => r.ms), [18000], 'kişi başına tek satır');
  assert.deepEqual(t.takisto.map((r) => [r.score, r.n]), [[4, 2]]);
  assert.deepEqual(t['tablo-3'], []);
});

test('Dört Taş / Duvar: iki kişilik ve bilgisayara karşı galibiyetler ayrı, hemen bırakılan oyun girmez', async () => {
  const { b, sent } = fake();
  await b.duelDone('dorttas', { players: ['Ali', 'Can'], winner: 'Ali', moves: 9, endedAt: 1 });
  await b.duelDone('dorttas', { players: ['Can', 'Ali'], winner: null, moves: 42, endedAt: 2 });
  await b.duelDone('dorttas', { players: ['Ali', 'Can'], winner: 'Can', moves: 2, endedAt: 3 }); // girmez
  await b.duelDone('dorttas', { players: [BOT, 'Ali'], winner: BOT, moves: 12, level: 'zor', endedAt: 4 });
  await b.duelDone('dorttas', { players: ['Ali', BOT], winner: 'Ali', moves: 15, level: 'kolay', endedAt: 5 });
  await b.duelDone('duvar', { players: ['Can', 'Ali'], winner: 'Can', moves: 30, endedAt: 6 });
  const d = b.duelBoard('dorttas');
  assert.deepEqual(d.pvp.map((r) => [r.name, r.wins, r.losses, r.draws, r.games]), [['Ali', 1, 0, 1, 2], ['Can', 0, 1, 1, 2]]);
  assert.deepEqual(d.bot.zor.map((r) => [r.name, r.wins, r.games]), [['Ali', 0, 1]]);
  assert.deepEqual(d.bot.kolay.map((r) => [r.name, r.wins]), [['Ali', 1]]);
  assert.deepEqual(d.bot.orta, []);
  assert.deepEqual(b.duelBoard('duvar').pvp.map((r) => [r.name, r.wins]), [['Can', 1], ['Ali', 0]]);
  assert.equal(sent.at(-1).event, 'duvar:board');
});

test('Kayıttan yükleme: aynı kayıt iki kez gelse de bir kez sayılır', () => {
  const { b } = fake();
  const rec = { at: 5, g: 'duvar', p: ['Ali', 'Can'], w: 'Ali', m: 20 };
  b.load('duelboard', [rec, { ...rec }, null, { bozuk: true }]);
  b.load('duelboard', [rec]);
  assert.equal(b.duelBoard('duvar').pvp[0].games, 1);
});

test('Beş Harf tüm zamanlar: çok bulan önce, eşitse az tahmin; dil ayrı; bulamayan listede yok', () => {
  const g = bh.create({ io: { to: () => ({ emit() {} }) }, getRoom: () => null, postSystem() {}, BOT, store: null, SHARED: 's', JOINED: 'j' });
  const day = bh.dayOf();
  const p = (name, d, n, won, lang = 'tr') => ({ day: day - d, lang, name, guesses: Array(n).fill('kalem'), done: true, won, startAt: 0, at: 1 });
  g.loadBoard([p('Ali', 0, 3, true), p('Ali', 1, 5, true), p('Can', 0, 2, true), p('Can', 1, 4, true), p('Can', 2, 6, false),
    p('Ece', 0, 6, false), p('Ece', 1, 2, true, 'en')]);
  assert.deepEqual(g.allTime('tr').map((r) => [r.name, r.wins, r.played, r.avg]), [['Can', 2, 3, 3], ['Ali', 2, 2, 4]]);
  assert.deepEqual(g.allTime('en').map((r) => r.name), ['Ece']);
  assert.ok(Array.isArray(g.view('Ali').allTime));
});

// ----- Sunucu: tablolar odalar arasında ortak -----
let srv;
const sockets = [];
before(async () => {
  srv = await startServer();
});
after(async () => {
  for (const s of sockets) s.close();
  await srv?.stop();
});
async function joined(id, name) {
  const s = await client(srv.url, name);
  sockets.push(s);
  const r = await ack(s, 'join', { token: s.token, clientId: name, room: id });
  assert.equal(r.error, undefined, JSON.stringify(r));
  s.joinRes = r;
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

test('Sunucu: bir odadaki Dört Taş ve Hızlı okuma sonucu başka odadakine de gelir; girişte tablolar gelir', async () => {
  const r1 = await http(srv.url, 'POST', '/rooms', { token: 'test:osyalcin', body: { name: 'Tablo Bir' } });
  const r2 = await http(srv.url, 'POST', '/rooms', { token: 'test:osyalcin', body: { name: 'Tablo Iki' } });
  const a = await joined(r1.json.room.id, 'Ayse');
  const b = await joined(r1.json.room.id, 'Bora');
  const c = await joined(r2.json.room.id, 'Cem');
  assert.ok(c.joinRes.mantikBoard && c.joinRes.okumaBoard && c.joinRes.duelBoards?.dorttas && c.joinRes.duelBoards?.duvar);

  a.emit('lobby:open', { game: 'dorttas' });
  await until(b, 'lobbies', (l) => l.dorttas);
  b.emit('lobby:join', { game: 'dorttas' });
  await until(a, 'lobbies', (l) => l.dorttas?.players.length === 2);
  const started = until(a, 'dorttas', (g) => g && !g.done);
  a.emit('lobby:start', { game: 'dorttas' });
  const g = await started;
  const [first, second] = g.players[0] === 'Ayse' ? [a, b] : [b, a];
  const winner = g.players[0];
  const board = until(c, 'dorttas:board', (x) => x.pvp.length === 2);
  let n = 0;
  for (const [s, col] of [[first, 0], [second, 6], [first, 1], [second, 6], [first, 2], [second, 5], [first, 3]]) {
    const p = until(a, 'dorttas', (x) => x.moves === n + 1);
    s.emit('dorttas:move', { col });
    await p;
    n++;
  }
  const t = await board;
  assert.deepEqual(t.pvp.map((r) => [r.name, r.wins, r.games]), [[winner, 1, 1], [g.players[1], 0, 1]]);

  const ok = until(c, 'okuma:board', (x) => x.yatay?.some((r) => r.name === 'Ayse'));
  assert.deepEqual(await ack(a, 'okuma:result', { d: 'yatay', score: 260 }), { ok: true, improved: true });
  assert.equal((await ok).yatay[0].score, 260);
  assert.ok((await ack(a, 'okuma:result', { d: 'tablo', size: 4, ms: 10 })).error);

  const d = await joined(r2.json.room.id, 'Deniz');
  assert.equal(d.joinRes.duelBoards.dorttas.pvp.length, 2, 'sonradan giren de görür');
  assert.equal(d.joinRes.okumaBoard.yatay[0].name, 'Ayse');
});
