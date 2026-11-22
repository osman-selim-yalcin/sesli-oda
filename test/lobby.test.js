// Oda listesi için canlı bağlantı: hello, rooms olayı, yöneticiye istek bildirimi
require('./preload');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, ack, http, next } = require('./helpers');

let srv;
const ADMIN = 'test:osyalcin';
const sockets = [];

before(async () => {
  srv = await startServer();
  const r = await http(srv.url, 'POST', '/rooms', { token: ADMIN, body: { name: 'Gizli Oda', password: 'gizli-sifre' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const k = await http(srv.url, 'POST', '/rooms', { token: ADMIN, body: { name: 'Kapanan Oda' } });
  assert.equal(k.status, 200, JSON.stringify(k.json));
  const d = await http(srv.url, 'POST', '/rooms', { token: ADMIN, body: { name: 'Dolu Oda' } });
  assert.equal(d.status, 200, JSON.stringify(d.json));
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
const hello = (s, token = s.token) => ack(s, 'hello', { token });
const join = (s, room = 'genel', extra = {}) => ack(s, 'join', { token: s.token, clientId: s.cid, room, ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function collect(s) {
  const got = [];
  s.onAny((event, data) => got.push({ event, data }));
  return got;
}
// Koşulu sağlayan ilk rooms olayını bekler (araya önceki değişikliklerin olayı girebilir).
function roomsWhere(s, ok, ms = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { s.off('rooms', on); reject(new Error('rooms olayı gelmedi')); }, ms);
    function on(data) {
      if (!ok(data)) return;
      clearTimeout(timer);
      s.off('rooms', on);
      resolve(data);
    }
    s.on('rooms', on);
  });
}

test('hello: geçersiz token { error, auth: true }; geçerli token oda listesini döner', async () => {
  const s = await user('Kimsesiz');
  const bad = await hello(s, 'yanlis');
  assert.equal(bad.auth, true);
  assert.equal(typeof bad.error, 'string');
  assert.equal(bad.rooms, undefined);
  const ok = await hello(s);
  assert.equal(ok.error, undefined);
  const genel = ok.rooms.find((r) => r.id === 'genel');
  assert.equal(genel.role, 'member');
  assert.equal(ok.pending, undefined); // yönetici değil
});

test('listedeki Ali, Veli genel\'e girince rooms alır; genel.users içinde Veli var', async () => {
  const ali = await user('Ali');
  await hello(ali);
  const veli = await user('Veli');
  const got = roomsWhere(ali, (d) => d.rooms.find((r) => r.id === 'genel')?.users.includes('Veli'));
  assert.equal((await join(veli)).error, undefined);
  const { rooms } = await got;
  const genel = rooms.find((r) => r.id === 'genel');
  assert.deepEqual(genel.users, ['Veli']);
  assert.equal(genel.role, 'member');
  // Veli çıkınca liste yine güncellenir
  const left = roomsWhere(ali, (d) => d.rooms.find((r) => r.id === 'genel')?.users.length === 0);
  veli.close();
  await left;
});

test('art arda değişiklikler tek rooms olayında toplanır', async () => {
  const izleyen = await user('Izleyen');
  await hello(izleyen);
  const got = collect(izleyen);
  const a = await user('Toplu1');
  const b = await user('Toplu2');
  await Promise.all([join(a), join(b)]);
  await roomsWhere(izleyen, (d) => d.rooms.find((r) => r.id === 'genel')?.users.length === 2);
  await sleep(400);
  assert.equal(got.filter((e) => e.event === 'rooms').length, 1);
  a.close();
  b.close();
});

test('odadaki Ali ikinci soketiyle hello der: odadaki soket kicked almaz, odadakiler user-left almaz', async () => {
  const ali1 = await user('Ali2');
  const diger = await user('Diger');
  assert.equal((await join(ali1)).error, undefined);
  assert.equal((await join(diger)).error, undefined);
  const gotAli = collect(ali1);
  const gotDiger = collect(diger);
  const ali2 = await user('Ali2');
  const res = await hello(ali2);
  assert.equal(res.error, undefined);
  const inGenel = res.rooms.find((r) => r.id === 'genel').users;
  assert.ok(inGenel.includes('Ali2') && inGenel.includes('Diger'));
  await sleep(400);
  assert.ok(ali1.connected);
  assert.ok(!gotAli.some((e) => e.event === 'kicked'));
  assert.ok(!gotDiger.some((e) => e.event === 'user-left'));
  // Odadaki soket hello derse kimliklenir ama listeye alınmaz (odada kalır)
  assert.equal((await hello(ali1)).error, undefined);
  const lobbyEvents = collect(ali1);
  const extra = await user('Ekstra');
  const seen = roomsWhere(ali2, (d) => d.rooms.find((r) => r.id === 'genel')?.users.includes('Ekstra'));
  await join(extra);
  await seen;
  await sleep(100);
  assert.ok(!lobbyEvents.some((e) => e.event === 'rooms'));
  for (const s of [ali1, diger, extra]) s.close();
});

test('aynı sokette başka hesabın tokenı reddedilir', async () => {
  const s = await user('Birinci');
  assert.equal((await hello(s)).error, undefined);
  const other = await hello(s, 'test:Ikinci');
  assert.equal(other.auth, true);
  assert.equal(typeof other.error, 'string');
  const j = await ack(s, 'join', { token: 'test:Ikinci', clientId: 'x1', room: 'genel' });
  assert.equal(j.auth, true);
  const expired = await ack(s, 'join', { token: 'yanlis', clientId: 'x1', room: 'genel' });
  assert.deepEqual(expired, { error: 'Oturumun kapanmış, tekrar giriş yap.', auth: true });
  const missing = await ack(s, 'join', { clientId: 'x1', room: 'genel' });
  assert.deepEqual(missing, { error: 'Oturumun kapanmış, tekrar giriş yap.', auth: true });
  const j2 = await ack(s, 'join', { token: 'test:Birinci', clientId: 'x1', room: 'genel' });
  assert.equal(j2.error, undefined);
  s.close();
});

test('Ali istek gönderince hello demiş yönetici room-request { pending: 1 } alır, Veli almaz', async () => {
  const admin = await user('osyalcin');
  const first = await hello(admin);
  assert.equal(first.pending, 0);
  const adminInRoom = await user('osyalcin');
  assert.equal((await join(adminInRoom, 'gizli-oda')).error, undefined); // odadaki soketine de gider
  const veli = await user('Veli');
  await hello(veli);
  const gotVeli = collect(veli);
  const got = next(admin, 'room-request');
  const gotInRoom = next(adminInRoom, 'room-request');
  const r = await http(srv.url, 'POST', '/rooms/requests', { token: 'test:Ali', body: { name: 'Ali Salonu' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(await got, { pending: 1 });
  assert.deepEqual(await gotInRoom, { pending: 1 });
  await sleep(100);
  assert.ok(!gotVeli.some((e) => e.event === 'room-request'));
  // hello cevabı da aynı sayıyı verir
  const again = await user('osyalcin');
  assert.equal((await hello(again)).pending, 1);
  // Yönetici odadan çıktı; şifreli oda listede yine görünür (sonraki testte yeniden girer)
  adminInRoom.close();
  again.close();
});

test('şifreli oda listede herkese görünür: locked, users dolu, üye olmayana role none', async () => {
  const admin = await user('osyalcin');
  assert.equal((await join(admin, 'gizli-oda')).error, undefined);
  const veli = await user('Veli');
  const res = await hello(veli);
  const gizli = res.rooms.find((r) => r.id === 'gizli-oda');
  assert.equal(gizli.locked, true);
  assert.deepEqual(gizli.users, ['osyalcin']);
  assert.equal(gizli.role, 'none');
  assert.ok(!JSON.stringify(res).includes('gizli-sifre'));
  assert.ok(!JSON.stringify(res).includes('pass'));
  admin.close();
});

test('oda kapanınca içerideki soket listeye döner ve rooms alır', async () => {
  const s = await user('Donen');
  assert.equal((await join(s, 'kapanan-oda')).error, undefined);
  const closed = next(s, 'room:closed');
  const listed = roomsWhere(s, (d) => !d.rooms.some((r) => r.id === 'kapanan-oda'));
  const r = await http(srv.url, 'DELETE', '/rooms/kapanan-oda', { token: ADMIN });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await closed;
  const { rooms } = await listed;
  assert.equal(rooms.find((x) => x.id === 'genel').role, 'member');
  s.close();
});

test('hello demeden dolu odaya giremeyen soket listeye alınır ve rooms alır', async () => {
  const inside = [];
  for (let i = 1; i <= 6; i++) {
    const s = await user(`Dolu${i}`);
    assert.equal((await join(s, 'dolu-oda')).error, undefined);
    inside.push(s);
  }
  const late = await user('Gec');
  const res = await join(late, 'dolu-oda');
  assert.match(res.error, /Oda dolu/);
  const got = roomsWhere(late, (d) => d.rooms.find((r) => r.id === 'dolu-oda')?.users.length === 5);
  inside[0].close();
  await got;
  for (const s of inside) s.close();
  late.close();
});
