// WebRTC sinyali: taşınmadan (birleşme/ayrılma) önceki bağlantının sinyali (eski epoch) yeni odaya iletilmez.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, ack, http, next } = require('./helpers');

let srv;
const ADMIN = 'test:osyalcin';
const sockets = [];

before(async () => {
  srv = await startServer();
});
after(async () => {
  for (const s of sockets) s.close();
  await srv?.stop();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function user(name) {
  const s = await client(srv.url, name, { reconnection: false });
  sockets.push(s);
  return s;
}
async function openRoom(name, owner) {
  const r = await http(srv.url, 'POST', '/auth/register', { body: { name: owner, password: 'hesap-sifre' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const o = await http(srv.url, 'POST', '/rooms', { token: ADMIN, body: { name, owner } });
  assert.equal(o.status, 200, JSON.stringify(o.json));
  return o.json.room.id;
}
// Hedefe ms içinde gelen sinyaller.
function signals(s, ms = 400) {
  const got = [];
  const on = (m) => got.push(m);
  s.on('signal', on);
  return sleep(ms).then(() => { s.off('signal', on); return got; });
}

test('taşınmadan sonra eski epoch\'lu sinyal iletilmez; yenisi ve epoch\'suzu iletilir', async () => {
  const host = await openRoom('Sinyal Ev', 'SinyalSahipA');
  const guest = await openRoom('Sinyal Misafir', 'SinyalSahipB');
  const x = await user('SinyalX');
  const y = await user('SinyalY');
  const jx = await ack(x, 'join', { token: x.token, clientId: 'sx', room: guest });
  const jy = await ack(y, 'join', { token: y.token, clientId: 'sy', room: guest });
  assert.ok(jx.id && jy.id, JSON.stringify([jx, jy]));
  assert.equal(typeof jx.epoch, 'number');

  // Aynı odada: güncel epoch iletilir
  let got = signals(y);
  x.emit('signal', { to: jy.id, data: { n: 0 }, epoch: jx.epoch });
  assert.deepEqual((await got).map((m) => m.data.n), [0]);

  // Yönetici birleştirir: misafir odadakiler ev sahibi odaya taşınır
  const movedX = next(x, 'room:moved');
  const movedY = next(y, 'room:moved');
  const admin = await user('osyalcin');
  assert.ok((await ack(admin, 'hello', { token: ADMIN })).rooms);
  assert.deepEqual(await ack(admin, 'merge:request', { from: host, to: guest }), { merged: true });
  const mx = await movedX;
  await movedY;
  assert.equal(mx.room.id, host);
  assert.ok(mx.epoch > jx.epoch, JSON.stringify({ before: jx.epoch, after: mx.epoch }));

  got = signals(y);
  x.emit('signal', { to: jy.id, data: { n: 1 }, epoch: jx.epoch }); // eski bağlantıdan: düşer
  x.emit('signal', { to: jy.id, data: { n: 2 }, epoch: mx.epoch }); // yeni bağlantıdan
  x.emit('signal', { to: jy.id, data: { n: 3 } });                  // epoch bilmeyen eski istemci
  assert.deepEqual((await got).map((m) => m.data.n), [2, 3]);

  // Ayrılınca yine yeni epoch; birleşik odadaki epoch artık eski
  const splitX = next(x, 'room:moved');
  const splitY = next(y, 'room:moved');
  assert.deepEqual(await ack(admin, 'merge:split', { room: host }), {});
  const sx = await splitX;
  await splitY;
  assert.equal(sx.reason, 'split');
  got = signals(y);
  x.emit('signal', { to: jy.id, data: { n: 4 }, epoch: mx.epoch });
  x.emit('signal', { to: jy.id, data: { n: 5 }, epoch: sx.epoch });
  assert.deepEqual((await got).map((m) => m.data.n), [5]);
});
