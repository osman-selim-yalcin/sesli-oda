// Odaya giriş: oda seçimi, şifre, üyelik, hesap aynı anda tek odada
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, ack, http, next } = require('./helpers');

let srv;
const ADMIN = 'test:osyalcin';
const PASS = 'kapi1234';
const LIMIT_PASS = 'sinir123';
const sockets = [];
let adminToken; // gerçek oturum: /admin/members test belirtecini tanımaz

before(async () => {
  srv = await startServer();
  const open = async (body) => {
    const r = await http(srv.url, 'POST', '/rooms', { token: ADMIN, body });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json.room.id;
  };
  // Sahibi olacak hesap önce açılır (oda sahibi var olan bir hesap olmalı).
  assert.equal((await http(srv.url, 'POST', '/auth/register', { body: { name: 'Sahip', password: 'sahip-sifre' } })).status, 200);
  adminToken = (await http(srv.url, 'POST', '/auth/register', { body: { name: 'osyalcin', password: 'yonetici-sifre' } })).json.token;
  assert.equal(await open({ name: 'Açık Oda' }), 'acik-oda');
  assert.equal(await open({ name: 'Gizli Oda', password: PASS, owner: 'Sahip' }), 'gizli-oda');
  assert.equal(await open({ name: 'Dolu Oda' }), 'dolu-oda');
  assert.equal(await open({ name: 'Sinir Oda', password: LIMIT_PASS }), 'sinir-oda');
});
after(async () => {
  for (const s of sockets) s.close();
  await srv?.stop();
});

let cid = 0;
// Her istemcinin kendi sekme kimliği olur; yeniden bağlanınca aynısı kullanılır.
async function user(name, opts) {
  const s = await client(srv.url, name, opts);
  s.cid = `c${++cid}`;
  sockets.push(s);
  return s;
}
const join = (s, room, extra = {}) => ack(s, 'join', { token: s.token, clientId: s.cid, room, ...extra });
const ip = (addr) => ({ extraHeaders: { 'x-forwarded-for': addr } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Soketin aldığı bütün olaylar
function collect(s) {
  const got = [];
  s.onAny((event, data) => got.push({ event, data }));
  return got;
}
// Belli metinli sohbet mesajını bekler (giriş mesajları araya girebilir).
const chatText = (s, text) => new Promise((resolve) => s.on('chat', (m) => m.text === text && resolve(m)));
const closeAll = () => { for (const s of sockets.splice(0)) s.close(); };
const status = async () => (await http(srv.url, 'GET', '/status')).json;
async function waitEmpty() {
  for (let i = 0; i < 50; i++) {
    if ((await status()).online === 0) return;
    await sleep(50);
  }
  throw new Error('odalar boşalmadı');
}

test('şifresiz yeni odaya giriş; genel ile o oda birbirinin sohbetini almaz', async () => {
  const ali = await user('Ali');
  const veli = await user('Veli');
  const a = await join(ali, 'genel');
  assert.equal(a.error, undefined);
  assert.equal(a.room.id, 'genel');
  const v = await join(veli, 'acik-oda');
  assert.equal(v.error, undefined);
  assert.equal(v.room.id, 'acik-oda');
  assert.equal(v.room.role, 'member');
  assert.deepEqual(v.peers, []);
  const aliGot = collect(ali);
  const veliGot = collect(veli);

  const own = chatText(veli, 'açık odadan merhaba');
  veli.emit('chat', 'açık odadan merhaba');
  await own;
  const own2 = chatText(ali, 'genelden selam');
  ali.emit('chat', 'genelden selam');
  await own2;
  await sleep(300);
  assert.ok(!aliGot.some((e) => e.event === 'chat' && e.data.text === 'açık odadan merhaba'));
  assert.ok(!veliGot.some((e) => e.event === 'chat' && e.data.text === 'genelden selam'));
  assert.ok(!aliGot.some((e) => e.event === 'user-joined'));
  closeAll();
});

test('şifreli oda: şifresiz ve yanlış şifre needPassword; doğru şifreyle girer; sonra şifresiz (üyelik)', async () => {
  const deniz = await user('Deniz');
  assert.deepEqual(await join(deniz, 'gizli-oda'), { error: 'Bu oda şifreli.', needPassword: true });
  assert.deepEqual(await join(deniz, 'gizli-oda', { password: 'yanlis' }), { error: 'Şifre yanlış.', needPassword: true });
  const ok = await join(deniz, 'gizli-oda', { password: PASS });
  assert.equal(ok.error, undefined);
  assert.equal(ok.room.id, 'gizli-oda');
  assert.equal(ok.room.locked, true);
  assert.equal(ok.room.role, 'member');
  assert.ok(!JSON.stringify(ok).includes(PASS));
  assert.ok(!JSON.stringify(ok.room).includes('pass'));
  deniz.close();
  const again = await user('Deniz');
  const r = await join(again, 'gizli-oda');
  assert.equal(r.error, undefined);
  assert.equal(r.room.id, 'gizli-oda');
  closeAll();
});

test('sızıntı: başarısız girişte oda verisi yok, soket odanın olaylarını almaz', async () => {
  const sahip = await user('Sahip');
  const s = await join(sahip, 'gizli-oda');
  assert.equal(s.error, undefined);
  assert.equal(s.room.role, 'owner');
  const chat = chatText(sahip, 'gizli mesaj');
  sahip.emit('chat', 'gizli mesaj');
  await chat;
  const created = await ack(sahip, 'tierlist:create', 'Gizli Liste');
  assert.equal(created.error, undefined);
  const added = next(sahip, 'history:add', 8000);
  sahip.emit('media:add', 'dQw4w9WgXcQ');
  await added;

  const kemal = await user('Kemal');
  const got = collect(kemal);
  for (const extra of [{}, { password: 'yanlis' }]) {
    const r = await join(kemal, 'gizli-oda', extra);
    assert.deepEqual(Object.keys(r).sort(), ['error', 'needPassword']);
    assert.ok(!JSON.stringify(r).includes('gizli'));
  }
  const chat2 = chatText(sahip, 'ikinci gizli mesaj');
  sahip.emit('chat', 'ikinci gizli mesaj');
  await chat2;
  await ack(sahip, 'tierlist:create', 'Gizli Liste 2');
  await sleep(300);
  assert.deepEqual(got, []);
  closeAll();
});

test('sahip ve site yöneticisi şifre yazmadan girer', async () => {
  const sahip = await user('Sahip');
  const admin = await user('osyalcin');
  const s = await join(sahip, 'gizli-oda');
  assert.equal(s.error, undefined);
  assert.equal(s.room.role, 'owner');
  const a = await join(admin, 'gizli-oda');
  assert.equal(a.error, undefined);
  assert.equal(a.room.role, 'admin');
  // Üyeler sayfası genel dışındaki odaları da sayar
  const members = (await http(srv.url, 'GET', '/admin/members', { token: adminToken })).json.members;
  assert.equal(members.find((m) => m.name === 'Sahip').online, true);
  closeAll();
});

test('10 yanlış denemeden sonra doğru şifre de bekletilir; sınır hem hesap:oda hem IP ile sayılır', async () => {
  const limit = await user('Limit', ip('10.0.0.1'));
  for (let i = 0; i < 10; i++) {
    assert.deepEqual(await join(limit, 'sinir-oda', { password: `yanlis${i}` }), { error: 'Şifre yanlış.', needPassword: true });
  }
  const blocked = await join(limit, 'sinir-oda', { password: LIMIT_PASS });
  assert.equal(blocked.wait, true);
  assert.ok(blocked.error);
  assert.equal(blocked.room, undefined);

  // Aynı hesap başka bir adresten: hesap:oda anahtarı engelli
  const otherIp = await user('Limit', ip('10.0.0.2'));
  assert.equal((await join(otherIp, 'sinir-oda', { password: LIMIT_PASS })).wait, true);
  // Başka hesap aynı adresten: IP engelli
  const sameIp = await user('Baska', ip('10.0.0.1'));
  assert.equal((await join(sameIp, 'sinir-oda', { password: LIMIT_PASS })).wait, true);
  // Başka hesap başka adresten girebilir
  const fresh = await user('Baska', ip('10.0.0.3'));
  const ok = await join(fresh, 'sinir-oda', { password: LIMIT_PASS });
  assert.equal(ok.error, undefined);
  closeAll();
});

test('olmayan oda gone', async () => {
  const ali = await user('Ali');
  assert.deepEqual(await join(ali, 'boyle-bir-oda-yok'), { error: 'Böyle bir oda yok.', gone: true });
  assert.deepEqual(await join(ali, 42), { error: 'Böyle bir oda yok.', gone: true });
  assert.deepEqual(await join(ali, 'ortak'), { error: 'Böyle bir oda yok.', gone: true });
  closeAll();
});

test('başka odaya giren hesabın ilk soketi kicked alır, odadan çıkar, bağlı kalır', async () => {
  const ali1 = await user('Ali');
  const veli = await user('Veli');
  assert.equal((await join(ali1, 'acik-oda')).error, undefined);
  assert.equal((await join(veli, 'acik-oda')).error, undefined);

  const kicked = next(ali1, 'kicked');
  const left = next(veli, 'user-left');
  const bye = new Promise((resolve) => veli.on('chat', (m) => m.event === 'leave' && resolve(m)));
  const ali2 = await user('Ali');
  const r = await join(ali2, 'genel');
  assert.equal(r.error, undefined);
  assert.deepEqual(await kicked, { reason: 'Başka bir odaya girdin.' });
  assert.equal(await left, ali1.id);
  assert.equal((await bye).text, 'Ali ayrıldı'); // beklemeden (grace yok)
  await sleep(200);
  assert.equal(ali1.connected, true);
  const acik = (await http(srv.url, 'GET', '/rooms', { token: 'test:Ali' })).json.rooms.find((x) => x.id === 'acik-oda');
  assert.deepEqual(acik.users, ['Veli']);

  // Odadan çıkarılan soket yeniden girebilir; bu kez ikinci soket düşer.
  const kicked2 = next(ali2, 'kicked');
  const back = await join(ali1, 'acik-oda');
  assert.equal(back.error, undefined);
  assert.equal(back.room.id, 'acik-oda');
  await kicked2;
  closeAll();
});

test('aynı soketten ikinci join, ilki sürerken yok sayılır', async () => {
  const e = await user('Ece');
  const first = join(e, 'gizli-oda', { password: PASS });
  const second = ack(e, 'join', { token: e.token, clientId: e.cid, room: 'acik-oda' }, 500);
  assert.equal((await first).room.id, 'gizli-oda');
  await assert.rejects(second, /zaman aşımı/);
  const rooms = (await http(srv.url, 'GET', '/rooms', { token: 'test:Ece' })).json.rooms;
  assert.deepEqual(rooms.find((x) => x.id === 'acik-oda').users, []);
  assert.deepEqual(rooms.find((x) => x.id === 'gizli-oda').users, ['Ece']);
  closeAll();
});

test('yeniden bağlanma: şifreli odadaki istemci şifresiz aynı odaya döner', async () => {
  const r = await user('Remzi');
  assert.equal((await join(r, 'gizli-oda', { password: PASS })).error, undefined);
  r.disconnect();
  const back = new Promise((resolve) => r.once('connect', resolve));
  r.connect();
  await back;
  const again = await join(r, 'gizli-oda');
  assert.equal(again.error, undefined);
  assert.equal(again.room.id, 'gizli-oda');
  closeAll();
});

test('/status yalnız toplam kişi sayısını verir (bütün odalar)', async () => {
  await waitEmpty();
  const ali = await user('Ali');
  const veli = await user('Veli');
  await join(ali, 'genel');
  await join(veli, 'acik-oda');
  assert.deepEqual(await status(), { online: 2 });
  closeAll();
});

test('7. kişi oda dolu hatası alır', async () => {
  for (let i = 1; i <= 6; i++) {
    const s = await user(`Kisi${i}`);
    assert.equal((await join(s, 'dolu-oda')).error, undefined);
  }
  const seventh = await user('Kisi7');
  const r = await join(seventh, 'dolu-oda');
  assert.match(r.error, /^Oda dolu/);
  assert.equal(r.room, undefined);
  closeAll();
});
