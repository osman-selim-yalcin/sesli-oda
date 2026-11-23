// Oda kayıtları: rooms.js ve /rooms uçları
require('./preload'); // rooms.js bu süreçte de yüklenir: Supabase kapalı olsun
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, http } = require('./helpers');
const roomStore = require('../rooms');

let srv;
before(async () => {
  await roomStore.load(); // Supabase kapalı: hafızada genel açılır
  srv = await startServer();
});
after(async () => { await srv?.stop(); });

const list = (token) => http(srv.url, 'GET', '/rooms', { token });
const open = (token, body) => http(srv.url, 'POST', '/rooms', { token, body });

test('GET /rooms oturumsuz 401; oturumla tek oda genel', async () => {
  assert.equal((await list()).status, 401);
  const r = await list('test:Ali');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.rooms, [{
    id: 'genel', name: 'genel', owner: 'osyalcin', locked: false, theme: 'gece',
    users: [], count: 0, max: 10, mergedWith: null, role: 'member',
  }]);
  assert.equal((await list('test:osyalcin')).json.rooms[0].role, 'admin');
});

test('POST /rooms yalnız site yöneticisi; açılan oda listede görünür', async () => {
  assert.equal((await open(undefined, { name: 'Sohbet' })).status, 401);
  const denied = await open('test:Ali', { name: 'Sohbet' });
  assert.equal(denied.status, 403);
  assert.ok(denied.json.error);
  const r = await open('test:osyalcin', { name: 'Sohbet' });
  assert.equal(r.status, 200);
  assert.equal(r.json.room.id, 'sohbet');
  assert.equal(r.json.room.name, 'Sohbet');
  assert.equal(r.json.room.role, 'admin');
  const ids = (await list('test:Ali')).json.rooms.map((x) => x.id);
  assert.deepEqual(ids, ['genel', 'sohbet']);
});

test('slugOf: Türkçe harfler, boşluklar, boş kalan ad, ortak ve çakışma', async () => {
  assert.equal(roomStore.slugOf('Çığ Şöğü'), 'cig-sogu');
  assert.equal(roomStore.slugOf('  Film  Gecesi '), 'film-gecesi');
  assert.equal(roomStore.slugOf('🎮🎮'), 'oda');
  assert.equal(roomStore.slugOf('Ortak'), 'ortak-2');
  const room = await roomStore.create({ name: 'Film Gecesi', ownerId: 'osyalcin' });
  assert.equal(room.id, 'film-gecesi');
  assert.equal(roomStore.slugOf('Film Gecesi'), 'film-gecesi-2');
  // Sunucuda da: ada göre farklı ama kısa adı aynı oda -2 alır
  assert.equal((await open('test:osyalcin', { name: 'Film Gecesi' })).json.room.id, 'film-gecesi');
  assert.equal((await open('test:osyalcin', { name: 'Film.Gecesi' })).json.room.id, 'film-gecesi-2');
});

test('aynı ad, ortak, 1 ve 25 karakterlik ad reddedilir', async () => {
  for (const name of ['GENEL', 'Ortak', 'a', 'x'.repeat(25)]) {
    const res = await roomStore.create({ name, ownerId: 'osyalcin' });
    assert.equal(typeof res.error, 'string', name);
    const r = await open('test:osyalcin', { name });
    assert.equal(r.status, 400, name);
    assert.equal(typeof r.json.error, 'string');
  }
  assert.equal((await open('test:osyalcin', { name: 'xy' })).status, 200);
  assert.equal((await open('test:osyalcin', { name: 'x'.repeat(24) })).status, 200);
});

test('şifreli oda locked: true; özet hiçbir cevapta yok', async () => {
  const r = await open('test:osyalcin', { name: 'Gizli', password: 'sifre123' });
  assert.equal(r.status, 200);
  assert.equal(r.json.room.locked, true);
  assert.ok(!JSON.stringify(r.json).includes('pass'));
  const l = await list('test:Ali');
  assert.ok(!JSON.stringify(l.json).includes('pass'));
  const gizli = l.json.rooms.find((x) => x.id === 'gizli');
  assert.equal(gizli.locked, true);
  assert.equal(gizli.role, 'none');
  assert.equal((await open('test:osyalcin', { name: 'Kisa', password: 'abc' })).status, 400);
});

test('owner verilirse var olan hesap olmalı; sahip owner rolünü alır', async () => {
  const reg = await http(srv.url, 'POST', '/auth/register', { body: { name: 'Veli', password: 'velisifre' } });
  assert.equal(reg.status, 200);
  const r = await open('test:osyalcin', { name: 'Veli Odası', password: 'odasifre', owner: 'Veli' });
  assert.equal(r.status, 200);
  assert.equal(r.json.room.owner, 'Veli');
  const mine = (await list('test:Veli')).json.rooms.find((x) => x.id === r.json.room.id);
  assert.equal(mine.role, 'owner');
  assert.equal(mine.owner, 'Veli');
  const none = await open('test:osyalcin', { name: 'Hayalet Odası', owner: 'Hayalet' });
  assert.equal(none.status, 400);
  assert.ok(none.json.error);
});
