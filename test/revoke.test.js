// Kapatılan oturumun (şifre değişince öteki oturumlar, çıkışta yalnız o oturum) açık soketleri de kesilir.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, ack, http, next } = require('./helpers');

let srv;
const sockets = [];

before(async () => {
  srv = await startServer();
});
after(async () => {
  for (const s of sockets) s.close();
  await srv?.stop();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function sock(token) {
  const s = await client(srv.url, 'x', { reconnection: false });
  s.token = token;
  sockets.push(s);
  return s;
}
async function register(name, password) {
  const r = await http(srv.url, 'POST', '/auth/register', { body: { name, password } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.token;
}
async function login(name, password) {
  const r = await http(srv.url, 'POST', '/auth/login', { body: { name, password } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.token;
}
const KICKED = { reason: 'Oturumun kapatıldı, tekrar giriş yap.', auth: true };

test('şifre değişince öteki oturumun odadaki soketi atılır, değiştirenin soketi kalır', async () => {
  const a = await register('Kesik1', 'ilk-sifre');
  const b = await login('Kesik1', 'ilk-sifre');
  await register('Gozcu1', 'gozcu-sifre');
  // Odanın sahibi Kesik1: eski oturumla birleşme isteği denenecek
  const room = await http(srv.url, 'POST', '/rooms', { token: 'test:osyalcin', body: { name: 'Kesik Oda', owner: 'Kesik1' } });
  assert.equal(room.status, 200, JSON.stringify(room.json));
  const other = await http(srv.url, 'POST', '/rooms', { token: 'test:osyalcin', body: { name: 'Kesik Diger', owner: 'Gozcu1' } });
  assert.equal(other.status, 200, JSON.stringify(other.json));

  const watcher = await sock('test:Gozcu1');
  assert.ok((await ack(watcher, 'join', { token: watcher.token, clientId: 'g1', room: room.json.room.id })).id);
  const sb = await sock(b);
  const joined = await ack(sb, 'join', { token: b, clientId: 'k1b', room: room.json.room.id });
  assert.ok(joined.id, JSON.stringify(joined));
  const sa = await sock(a);
  assert.ok((await ack(sa, 'hello', { token: a })).rooms);

  const kicked = next(sb, 'kicked');
  const gone = next(sb, 'disconnect');
  const left = next(watcher, 'user-left');
  let saKicked = false;
  sa.on('kicked', () => { saKicked = true; });
  assert.equal((await http(srv.url, 'POST', '/auth/password', { token: a, body: { current: 'ilk-sifre', password: 'yeni-sifre' } })).status, 200);
  assert.deepEqual(await kicked, KICKED);
  assert.equal(await gone, 'io server disconnect');
  assert.equal(await left, joined.id);
  await sleep(200);
  assert.equal(saKicked, false);
  assert.ok(sa.connected);

  // Eski oturumla yeniden bağlanan soket hiçbir şey yapamaz
  const again = await sock(b);
  assert.equal((await ack(again, 'hello', { token: b })).auth, true);
  assert.equal((await ack(again, 'join', { token: b, clientId: 'k1b', room: room.json.room.id })).auth, true);
  const req = await ack(again, 'merge:request', { from: room.json.room.id, to: other.json.room.id });
  assert.equal(req.auth, true, JSON.stringify(req));
});

test('çıkış yalnız o oturumun soketlerini keser', async () => {
  const a = await register('Kesik2', 'ilk-sifre');
  const b = await login('Kesik2', 'ilk-sifre');
  const sa = await sock(a);
  const sb = await sock(b);
  assert.ok((await ack(sa, 'hello', { token: a })).rooms);
  assert.ok((await ack(sb, 'hello', { token: b })).rooms);
  let saKicked = false;
  sa.on('kicked', () => { saKicked = true; });
  const kicked = next(sb, 'kicked');
  const gone = next(sb, 'disconnect');
  assert.equal((await http(srv.url, 'POST', '/auth/logout', { token: b })).status, 200);
  assert.deepEqual(await kicked, KICKED);
  await gone;
  await sleep(200);
  assert.equal(saKicked, false);
  assert.ok(sa.connected);
  assert.ok((await ack(sa, 'hello', { token: a })).rooms);
});
