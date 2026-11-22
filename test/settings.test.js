// Oda ayarları (tema, şifre) ve yönetici işlemleri (ad, sahip, kapatma): yetki matrisi
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, ack, http, next } = require('./helpers');

let srv;
const ADMIN = 'test:osyalcin';
const OWNER = 'test:Sahip';    // ayar-oda, sifre-oda, kapat-oda sahibi
const OTHER = 'test:Baskasi';  // baska-oda sahibi
const FIRST_PASS = 'ilk-sifre';
const sockets = [];

before(async () => {
  srv = await startServer();
  for (const name of ['Sahip', 'Baskasi', 'Yeni Sahip']) {
    const r = await http(srv.url, 'POST', '/auth/register', { body: { name, password: 'hesap-sifre' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  const open = async (body) => {
    const r = await http(srv.url, 'POST', '/rooms', { token: ADMIN, body });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json.room.id;
  };
  assert.equal(await open({ name: 'Ayar Oda', owner: 'Sahip' }), 'ayar-oda');
  assert.equal(await open({ name: 'Sifre Oda', owner: 'Sahip', password: FIRST_PASS }), 'sifre-oda');
  assert.equal(await open({ name: 'Baska Oda', owner: 'Baskasi' }), 'baska-oda');
  assert.equal(await open({ name: 'Kapat Oda', owner: 'Sahip' }), 'kapat-oda');
  assert.equal(await open({ name: 'Lobi Oda' }), 'lobi-oda');
  assert.equal(await open({ name: 'Ad Oda' }), 'ad-oda');
});
after(async () => {
  for (const s of sockets) s.close();
  await srv?.stop();
});

let cid = 0;
async function user(name) {
  const s = await client(srv.url, name);
  s.cid = `c${++cid}`;
  sockets.push(s);
  return s;
}
const join = (s, room, extra = {}) => ack(s, 'join', { token: s.token, clientId: s.cid, room, ...extra });
const patch = (id, token, body) => http(srv.url, 'PATCH', `/rooms/${id}`, { token, body });
const remove = (id, token) => http(srv.url, 'DELETE', `/rooms/${id}`, { token });
const listed = async (id) => (await http(srv.url, 'GET', '/rooms', { token: ADMIN })).json.rooms.find((r) => r.id === id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function collect(s) {
  const got = [];
  s.onAny((event, data) => got.push({ event, data }));
  return got;
}
const chatText = (s, text) => new Promise((resolve) => s.on('chat', (m) => m.text === text && resolve(m)));

test('tema: üye 403, başka odanın sahibi 403, sahip 200 ve odadaki istemci room:theme alır', async () => {
  const uye = await user('Uye');
  assert.equal((await join(uye, 'ayar-oda')).error, undefined);
  assert.equal((await patch('ayar-oda', 'test:Uye', { theme: 'varsayilan' })).status, 403);
  assert.equal((await patch('ayar-oda', OTHER, { theme: 'varsayilan' })).status, 403);
  const got = next(uye, 'room:theme');
  const r = await patch('ayar-oda', OWNER, { theme: 'varsayilan' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.room.id, 'ayar-oda');
  assert.equal(r.json.room.theme, 'varsayilan');
  assert.deepEqual(await got, { theme: 'varsayilan' });
  // yönetici de tema değiştirebilir
  assert.equal((await patch('ayar-oda', ADMIN, { theme: 'varsayilan' })).status, 200);
});

test('oturumsuz 401, olmayan oda 404, tanınan alan yoksa 400', async () => {
  assert.equal((await patch('ayar-oda', undefined, { theme: 'varsayilan' })).status, 401);
  assert.equal((await patch('yok-oda', OWNER, { theme: 'varsayilan' })).status, 404);
  assert.equal((await patch('ayar-oda', OWNER, {})).status, 400);
  assert.equal((await patch('ayar-oda', OWNER, { renk: 'mavi' })).status, 400);
  assert.equal((await remove('ayar-oda', undefined)).status, 401);
  assert.equal((await remove('yok-oda', ADMIN)).status, 404);
});

test('bilinmeyen tema 400; 3 karakterlik, boş ve metin olmayan şifre 400', async () => {
  assert.equal((await patch('ayar-oda', OWNER, { theme: 'yok-tema' })).status, 400);
  for (const password of ['abc', '', 1234, 'x'.repeat(201)]) {
    const r = await patch('ayar-oda', OWNER, { password });
    assert.equal(r.status, 400, `şifre ${JSON.stringify(password)}`);
  }
  assert.equal((await listed('ayar-oda')).locked, false);
});

test('sahip şifre koyar: içerideki atılmaz, dışarıdaki eski üye yeni şifreyi yazmalı; şifre kaldırılır', async () => {
  // Eski üye şifreyle girip çıkar; içerideki şifreyle girer ve kalır.
  const eski = await user('Eski');
  assert.equal((await join(eski, 'sifre-oda', { password: FIRST_PASS })).error, undefined);
  eski.close();
  const icerde = await user('Icerde');
  assert.equal((await join(icerde, 'sifre-oda', { password: FIRST_PASS })).error, undefined);
  await sleep(100);
  const got = collect(icerde);

  const r = await patch('sifre-oda', OWNER, { password: 'yeni-sifre' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.room.locked, true);
  assert.ok(!JSON.stringify(r.json).includes('yeni-sifre'));

  // içerideki olay almaz ve sohbet edebilir
  const own = chatText(icerde, 'hala buradayim');
  icerde.emit('chat', 'hala buradayim');
  await own;
  assert.deepEqual(got.filter((g) => g.event !== 'chat').map((g) => g.event), []);

  // eski üye: üyelik silindi
  const eski2 = await user('Eski');
  const a = await join(eski2, 'sifre-oda');
  assert.equal(a.needPassword, true);
  assert.equal((await join(eski2, 'sifre-oda', { password: FIRST_PASS })).error, 'Şifre yanlış.');
  const b = await join(eski2, 'sifre-oda', { password: 'yeni-sifre' });
  assert.equal(b.error, undefined);
  assert.equal(b.room.locked, true);

  // şifre kaldırılır (null) -> locked false
  const c = await patch('sifre-oda', OWNER, { password: null });
  assert.equal(c.status, 200);
  assert.equal(c.json.room.locked, false);

  // şifresiz odaya sahip şifre koyar -> locked
  const d = await patch('ayar-oda', OWNER, { password: 'ayar-sifre' });
  assert.equal(d.status, 200);
  assert.equal(d.json.room.locked, true);
  assert.equal((await listed('ayar-oda')).locked, true);
});

test('sahip ad ya da sahip gönderirse 403 ve hiçbir alan uygulanmaz (aynı istekteki tema da)', async () => {
  const uye = await user('Izleyen');
  assert.equal((await join(uye, 'baska-oda')).error, undefined);
  await sleep(100); // "katıldı" mesajı geçsin
  const got = collect(uye);
  assert.equal((await patch('baska-oda', OTHER, { name: 'Yeni Ad', theme: 'varsayilan' })).status, 403);
  assert.equal((await patch('baska-oda', OTHER, { owner: 'Sahip', theme: 'varsayilan', password: 'olmasin1' })).status, 403);
  await sleep(150);
  assert.deepEqual(got.map((g) => g.event), []); // room:theme gelmedi
  const room = await listed('baska-oda');
  assert.equal(room.name, 'Baska Oda');
  assert.equal(room.owner, 'Baskasi');
  assert.equal(room.locked, false);
});

test('yönetici adı değiştirir: id aynı; geçersiz ya da alınmış ad 400', async () => {
  const r = await patch('ad-oda', ADMIN, { name: 'Yeni Adli Oda' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.room.id, 'ad-oda');
  assert.equal(r.json.room.name, 'Yeni Adli Oda');
  assert.equal((await listed('ad-oda')).name, 'Yeni Adli Oda');
  assert.equal((await patch('ad-oda', ADMIN, { name: 'yeni adli oda' })).status, 200); // kendi adının harf farkı
  assert.equal((await patch('ad-oda', ADMIN, { name: 'Ayar Oda' })).status, 400);
  assert.equal((await patch('ad-oda', ADMIN, { name: 'x' })).status, 400);
  assert.equal((await patch('ad-oda', ADMIN, { name: 'ortak' })).status, 400);
});

test('yönetici sahibi değiştirir: eski sahip 403, yenisi 200; olmayan hesap 400', async () => {
  assert.equal((await patch('baska-oda', ADMIN, { owner: 'Kimse Yok' })).status, 400);
  const r = await patch('baska-oda', ADMIN, { owner: 'Yeni Sahip' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.room.owner, 'Yeni Sahip');
  assert.equal((await patch('baska-oda', OTHER, { theme: 'varsayilan' })).status, 403);
  assert.equal((await patch('baska-oda', 'test:Yeni Sahip', { theme: 'varsayilan' })).status, 200);
});

test('kapatma: sahip 403; yönetici kapatır, içeridekiler room:closed alır, listede yok, join gone; genel 400', async () => {
  const a = await user('Kapali1');
  const b = await user('Kapali2');
  assert.equal((await join(a, 'kapat-oda')).error, undefined);
  assert.equal((await join(b, 'kapat-oda')).error, undefined);
  assert.equal((await remove('kapat-oda', OWNER)).status, 403);
  assert.ok(await listed('kapat-oda'));

  const closedA = next(a, 'room:closed');
  const closedB = next(b, 'room:closed');
  const r = await remove('kapat-oda', ADMIN);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(await closedA, { name: 'Kapat Oda' });
  assert.deepEqual(await closedB, { name: 'Kapat Oda' });
  assert.equal(await listed('kapat-oda'), undefined);
  assert.equal((await join(a, 'kapat-oda')).gone, true);
  assert.equal((await patch('kapat-oda', ADMIN, { theme: 'varsayilan' })).status, 404);
  assert.equal((await remove('kapat-oda', ADMIN)).status, 404);
  // aynı soket başka odaya girebilir
  assert.equal((await join(b, 'genel')).error, undefined);

  assert.equal((await remove('genel', ADMIN)).status, 400);
  assert.equal((await remove('genel', OWNER)).status, 403);
  assert.ok(await listed('genel'));
});

test('açık lobisi olan oda kapatılınca sunucu çökmeden temizlenir', async () => {
  const host = await user('Lobici');
  const guest = await user('Misafir');
  assert.equal((await join(host, 'lobi-oda')).error, undefined);
  assert.equal((await join(guest, 'lobi-oda')).error, undefined);
  const opened = next(guest, 'lobbies');
  host.emit('lobby:open', { game: 'race' });
  assert.ok((await opened).race);
  const joined = next(host, 'lobbies');
  guest.emit('lobby:join', { game: 'race' });
  assert.deepEqual((await joined).race.players, ['Lobici', 'Misafir']);

  const closed = next(host, 'room:closed');
  assert.equal((await remove('lobi-oda', ADMIN)).status, 200);
  await closed;
  await sleep(100);
  const status = (await http(srv.url, 'GET', '/status')).json;
  assert.ok(status, 'sunucu ayakta');
  const later = await user('Sonraki');
  assert.equal((await join(later, 'genel')).error, undefined);
  assert.equal((await join(host, 'ayar-oda', { password: 'ayar-sifre' })).error, undefined);
});
