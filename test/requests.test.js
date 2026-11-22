// Oda açma istekleri ve yönetici onayı
require('./preload');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, http } = require('./helpers');
const roomStore = require('../rooms');

let srv;
before(async () => {
  await roomStore.load();
  srv = await startServer();
});
after(async () => { await srv?.stop(); });

const ADMIN = 'test:osyalcin';
const ask = (token, body) => http(srv.url, 'POST', '/rooms/requests', { token, body });
const mine = (token) => http(srv.url, 'GET', '/rooms/requests/mine', { token });
const pendingList = (token) => http(srv.url, 'GET', '/admin/room-requests', { token });
const decide = (token, id, approve) => http(srv.url, 'POST', `/admin/room-requests/${id}`, { token, body: { approve } });
const rooms = (token) => http(srv.url, 'GET', '/rooms', { token });

test('istek yöneticinin listesinde görünür; locked doğru; şifre hiçbir cevapta yok', async () => {
  assert.equal((await ask(undefined, { name: 'Salon' })).status, 401);
  const r = await ask('test:Ali', { name: 'Ali Salonu', password: 'gizli123', note: 'Arkadaşlarla' });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json.request).sort(), ['id', 'name', 'status']);
  assert.equal(r.json.request.status, 'pending');
  const l = await pendingList(ADMIN);
  assert.equal(l.status, 200);
  const item = l.json.requests.find((q) => q.id === r.json.request.id);
  assert.deepEqual(item, {
    id: r.json.request.id, by: 'ali', name: 'Ali Salonu', locked: true, theme: 'gece',
    note: 'Arkadaşlarla', createdAt: item.createdAt,
  });
  assert.equal(typeof item.createdAt, 'number');
  assert.ok(!JSON.stringify([r.json, l.json, (await mine('test:Ali')).json]).includes('gizli123'));
  assert.ok(!JSON.stringify(l.json).includes('pass'));
  assert.deepEqual((await mine('test:Ali')).json.request, { id: r.json.request.id, name: 'Ali Salonu', status: 'pending', decidedAt: null });
});

test('bekleyen isteği olan ikinci istek gönderemez (409); aynı adla başka hesap da gönderemez', async () => {
  const r = await ask('test:Ali', { name: 'Başka Ad' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'Bekleyen bir oda isteğin var.');
  const dup = await ask('test:Deniz', { name: 'ali salonu' });
  assert.equal(dup.status, 400);
});

test('yönetici olmayan liste ve karar uçlarında 403; oturumsuz 401', async () => {
  const id = (await pendingList(ADMIN)).json.requests[0].id;
  assert.equal((await pendingList('test:Veli')).status, 403);
  assert.equal((await decide('test:Veli', id, true)).status, 403);
  assert.equal((await pendingList(undefined)).status, 401);
  assert.equal((await pendingList(ADMIN)).json.requests.length, 1); // reddedilen karar etkisiz
});

test('yönetici istek göndermez (400)', async () => {
  const r = await ask(ADMIN, { name: 'Yönetici Odası' });
  assert.equal(r.status, 400);
  assert.ok(r.json.error);
});

test('onay: oda istek sahibinin adına açılır, şifre korunur; mine approved', async () => {
  const id = (await mine('test:Ali')).json.request.id;
  const r = await decide(ADMIN, id, true);
  assert.equal(r.status, 200);
  assert.equal(r.json.room.id, 'ali-salonu');
  assert.equal(r.json.room.locked, true);
  assert.ok(!JSON.stringify(r.json).includes('pass'));
  const aliRooms = (await rooms('test:Ali')).json.rooms;
  const room = aliRooms.find((x) => x.id === 'ali-salonu');
  assert.equal(room.role, 'owner');
  assert.equal(room.locked, true);
  assert.equal((await rooms('test:Veli')).json.rooms.find((x) => x.id === 'ali-salonu').role, 'none');
  const m = (await mine('test:Ali')).json.request;
  assert.equal(m.status, 'approved');
  assert.equal(m.id, id);
  assert.equal(typeof m.decidedAt, 'number');
  assert.equal((await pendingList(ADMIN)).json.requests.length, 0);
});

test('aynı isteğe ikinci karar 409', async () => {
  const id = (await mine('test:Ali')).json.request.id;
  assert.equal((await decide(ADMIN, id, true)).status, 409);
  assert.equal((await decide(ADMIN, id, false)).status, 409);
});

test('ret: oda açılmaz, mine rejected, istek sahibi yeniden gönderebilir; şifresiz istek locked false', async () => {
  const r = await ask('test:Ali', { name: 'Reddedilecek' });
  assert.equal(r.status, 200);
  assert.equal((await pendingList(ADMIN)).json.requests[0].locked, false);
  const d = await decide(ADMIN, r.json.request.id, false);
  assert.equal(d.status, 200);
  assert.deepEqual(d.json, {});
  assert.ok(!(await rooms(ADMIN)).json.rooms.some((x) => x.name === 'Reddedilecek'));
  const m = (await mine('test:Ali')).json.request;
  assert.equal(m.status, 'rejected');
  assert.equal(m.name, 'Reddedilecek');
  assert.equal((await ask('test:Ali', { name: 'Reddedilecek' })).status, 200); // ret adı serbest bırakır
  assert.equal((await mine('test:Hiç')).json.request, null);
});

test('geçersiz ad, uzun not, bilinmeyen tema, kısa ve metin olmayan şifre reddedilir', async () => {
  const bad = [
    { name: 'a' }, { name: 'x'.repeat(25) }, { name: 'Ortak' }, { name: 'genel' }, { name: 'Ali Salonu' },
    { name: 'Geçerli Ad', note: 'n'.repeat(201) }, { name: 'Geçerli Ad', theme: 'yok' },
    { name: 'Geçerli Ad', password: 'abc' }, { name: 'Geçerli Ad', password: {} }, { name: 'Geçerli Ad', password: false },
    { name: 'Geçerli Ad', note: 5 },
  ];
  for (const body of bad) {
    const r = await ask('test:Cem', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(typeof r.json.error, 'string');
  }
  assert.equal((await mine('test:Cem')).json.request, null);
  assert.equal((await ask('test:Cem', { name: 'Geçerli Ad', note: 'n'.repeat(200) })).status, 200);
});

test('onaydan önce aynı adla oda açılmışsa onay 409 ve istek beklemede kalır', async () => {
  const id = (await mine('test:Cem')).json.request.id;
  assert.equal((await http(srv.url, 'POST', '/rooms', { token: ADMIN, body: { name: 'Geçerli Ad' } })).status, 200);
  const r = await decide(ADMIN, id, true);
  assert.equal(r.status, 409);
  assert.ok(r.json.error);
  assert.ok((await pendingList(ADMIN)).json.requests.some((q) => q.id === id));
  assert.equal((await mine('test:Cem')).json.request.status, 'pending');
  assert.equal((await decide(ADMIN, id, false)).status, 200); // yine de reddedilebilir
});

test('create metin olmayan şifreyi reddeder', async () => {
  for (const password of [{}, false, 1234, ['abcd']]) {
    const r = await roomStore.create({ name: 'Şifre Denemesi', ownerId: 'osyalcin', password });
    assert.equal(typeof r.error, 'string', JSON.stringify(password));
  }
  assert.equal(roomStore.all().some((x) => x.name === 'Şifre Denemesi'), false);
});

// Bu süreçte (sunucu süreci değil) rooms.js uçları: kayıt yazması elle geciktirilir.
async function inProcess(fn) {
  const express = require('express');
  const store = require('../store');
  const app = express();
  roomStore.setup(app, { live: () => ({ users: [], max: 6, mergedWith: null }) });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const url = `http://localhost:${server.address().port}`;
  const saved = { insertReturning: store.insertReturning, enabled: store.enabled, update: store.update };
  try {
    await fn(url, store);
  } finally {
    Object.assign(store, saved);
    server.closeAllConnections(); // test yarıda kalırsa bekleyen istek sunucuyu açık tutmasın
    await new Promise((r) => server.close(r));
  }
}

test('kayıt sürerken kimliksiz istek listede, mine ve kararda görünmez; kayıt hatası başka isteği silmez', async () => {
  await inProcess(async (url, store) => {
    store.update = async () => {};
    const other = await http(url, 'POST', '/rooms/requests', { token: 'test:Bekleyen', body: { name: 'Bekleyen Oda' } });
    assert.equal(other.status, 200);
    let fail;
    store.insertReturning = () => new Promise((resolve, reject) => { fail = reject; setTimeout(() => reject(new Error('zaman aşımı')), 3000); });
    const slow = http(url, 'POST', '/rooms/requests', { token: 'test:Yavas', body: { name: 'Yavaş Oda' } });
    slow.catch(() => {});
    while (!fail) await new Promise((r) => setTimeout(r, 5));
    const list = (await http(url, 'GET', '/admin/room-requests', { token: ADMIN })).json.requests;
    assert.deepEqual(list.map((q) => q.name), ['Bekleyen Oda']);
    assert.equal((await http(url, 'GET', '/rooms/requests/mine', { token: 'test:Yavas' })).json.request, null);
    assert.equal((await http(url, 'POST', '/admin/room-requests/null', { token: ADMIN, body: { approve: false } })).status, 409);
    fail(new Error('yazılamadı'));
    assert.equal((await slow).status, 500);
    const after = (await http(url, 'GET', '/admin/room-requests', { token: ADMIN })).json.requests;
    assert.deepEqual(after.map((q) => q.name), ['Bekleyen Oda']);
    assert.equal((await http(url, 'POST', `/admin/room-requests/${other.json.request.id}`, { token: ADMIN, body: { approve: false } })).status, 200);
  });
});

test('Supabase açıkken kayıt satır döndürmezse istek hata verir, hafıza sayacına düşmez', async () => {
  await inProcess(async (url, store) => {
    store.enabled = true;
    store.insertReturning = async () => null;
    const r = await http(url, 'POST', '/rooms/requests', { token: 'test:Satirsiz', body: { name: 'Satırsız Oda' } });
    assert.equal(r.status, 500);
    store.enabled = false;
    assert.deepEqual((await http(url, 'GET', '/admin/room-requests', { token: ADMIN })).json.requests, []);
    assert.equal((await http(url, 'GET', '/rooms/requests/mine', { token: 'test:Satirsiz' })).json.request, null);
  });
});

test('aynı hesaptan 5 eşzamanlı istek: biri 200, öbürleri 409', async () => {
  const rs = await Promise.all([1, 2, 3, 4, 5].map((i) => ask('test:Eszaman', { name: `Eszaman Oda ${i}`, password: 'gizli-sifre' })));
  const codes = rs.map((r) => r.status).sort();
  assert.deepEqual(codes, [200, 409, 409, 409, 409], JSON.stringify(rs.map((r) => r.json)));
  for (const r of rs) if (r.status === 409) assert.equal(r.json.error, 'Bekleyen bir oda isteğin var.');
});

// Bu süreçte (sunucu süreci değil): rooms.js uçları ayrı bir Express'e bağlanır, şifre hashleme sayılır.
test('eşzamanlı istekler şifreyi yalnız bir kez hashler', async () => {
  const express = require('express');
  const accounts = require('../accounts');
  const app = express();
  roomStore.setup(app, { live: () => ({ users: [], max: 6, mergedWith: null }), onChange: () => {} });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const hash = accounts.hashPassword;
  let hashed = 0;
  accounts.hashPassword = (p) => { hashed++; return hash(p); };
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const rs = await Promise.all([1, 2, 3, 4, 5].map((i) => http(url, 'POST', '/rooms/requests', { token: 'test:Tekhash', body: { name: `Tekhash Oda ${i}`, password: 'gizli-sifre' } })));
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409, 409, 409, 409]);
    assert.equal(hashed, 1);
  } finally {
    accounts.hashPassword = hash;
    await new Promise((r) => server.close(r));
  }
});
