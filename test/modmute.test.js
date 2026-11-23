// Oda sahibi ve site yöneticisi odadakileri susturur (model: mutes.js başı). Sahip susturması odaya (kişinin
// girdiği kapı) bağlı, yönetici susturması hesaba bağlı ve site geneli; odalar arasında kopyalama yok.
require('./preload');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, ack, http, next } = require('./helpers');
const mutes = require('../mutes');

let srv;
const ADMIN = 'test:osyalcin';
const sockets = [];

before(async () => {
  srv = await startServer({ env: { REJOIN_GRACE_MS: '300' } });
});
after(async () => {
  for (const s of sockets) s.close();
  await srv?.stop();
});

let cid = 0;
async function user(name, cidOverride) {
  const s = await client(srv.url, name);
  s.cid = cidOverride || `q${++cid}`;
  sockets.push(s);
  return s;
}
const join = (s, room, extra = {}) => ack(s, 'join', { token: s.token, clientId: s.cid, room, ...extra });
const mute = (s, target, muted = true) => ack(s, 'mod:mute', { id: target.joinId, muted });
// Başarılı susturma cevabı hata taşımaz; etkin durumu ({ modMuted }) taşır.
function noError(r, msg) {
  assert.equal(r?.error, undefined, msg || JSON.stringify(r));
  assert.ok('modMuted' in r, JSON.stringify(r));
  return r;
}
// Test sunucusundaki kayıtlar (preload /__test/mute): oda + hesabın sahip kaydı ve hesabın yönetici kaydı.
const inspect = async (url, room, name) => (await http(url, 'GET', `/__test/mute?room=${encodeURIComponent(room)}&key=${encodeURIComponent(name.toLocaleLowerCase('tr-TR'))}`)).json;
const record = async (room, name) => (await inspect(srv.url, room, name)).record;
const adminRecord = async (name) => (await inspect(srv.url, '', name)).admin;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function eventWhere(s, event, ok, ms = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { s.off(event, on); reject(new Error(`${event} gelmedi`)); }, ms);
    function on(data) {
      if (!ok(data)) return;
      clearTimeout(timer);
      s.off(event, on);
      resolve(data);
    }
    s.on(event, on);
  });
}
const chatText = (s, re) => eventWhere(s, 'chat', (m) => m.system && re.test(m.text));
// Koşul sağlanana kadar yoklar (zamanlamaya güvenmeden).
async function until(fn, what, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`olmadı: ${what}`);
    await sleep(20);
  }
}
const listed = async (id) => (await http(srv.url, 'GET', '/rooms', { token: ADMIN })).json.rooms.find((r) => r.id === id);
const emptied = (id) => until(async () => (await listed(id)).users.length === 0, `${id} boşaldı`);
async function adminLobby() {
  const s = await user('osyalcin');
  assert.ok((await ack(s, 'hello', { token: s.token })).rooms);
  return s;
}

let tag = 0;
async function rooms(n = 2) {
  const t = ++tag;
  const out = { t };
  for (const side of ['A', 'B', 'C'].slice(0, n)) {
    const owner = `${side}sahip${t}`;
    const r = await http(srv.url, 'POST', '/auth/register', { body: { name: owner, password: 'hesap-sifre' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const o = await http(srv.url, 'POST', '/rooms', { token: ADMIN, body: { name: `Sus${t} ${side}`, owner } });
    assert.equal(o.status, 200, JSON.stringify(o.json));
    out[side] = o.json.room.id;
    out[`owner${side}`] = owner;
  }
  return out;
}
async function enter(name, room, cidOverride) {
  const s = await user(name, cidOverride);
  const r = await join(s, room);
  assert.equal(r.error, undefined, JSON.stringify(r));
  s.joinId = r.id;
  s.joinRes = r;
  return s;
}

// ---------- mutes.js (süreç içinde) ----------
test('mutes.js: etkin durum yönetici > sahip; sahip kaydı odaya, yönetici kaydı hesaba bağlı', () => {
  mutes.setOwner('u1', 'k', 'O');
  assert.deepEqual(mutes.effective('u1', 'k'), { by: 'owner', name: 'O' });
  assert.equal(mutes.effective('u2', 'k'), null, 'başka odada sahip kaydı uygulanmaz');
  mutes.setAdmin('k', 'X');
  assert.deepEqual(mutes.effective('u2', 'k'), { by: 'admin', name: 'X' });
  assert.equal(mutes.effective('u1', 'k').by, 'admin');
  mutes.clearRoom('u1');
  assert.equal(mutes.getOwner('u1', 'k'), null);
  assert.ok(mutes.getAdmin('k'), 'oda temizliği yönetici kaydına dokunmaz');
  mutes.removeAdmin('k');
  assert.equal(mutes.effective('u1', 'k'), null);
});

test('mutes.js: yetki kuralı', () => {
  const owner = { key: 'o', admin: false, ownsOrigin: true };
  const admin = { key: 'x', admin: true, ownsOrigin: false };
  const member = { key: 'm', admin: false, ownsOrigin: false };
  const plain = { key: 't', admin: false };
  assert.equal(mutes.check({ actor: owner, target: plain, existing: null }), null);
  assert.equal(mutes.check({ actor: admin, target: plain, existing: { by: 'owner' } }), null);
  assert.ok(mutes.check({ actor: member, target: plain, existing: null }));
  assert.ok(mutes.check({ actor: owner, target: { key: 'o', admin: false }, existing: null }), 'kendini');
  assert.ok(mutes.check({ actor: admin, target: { key: 'x', admin: true }, existing: null }), 'yönetici kendini');
  assert.ok(mutes.check({ actor: owner, target: { key: 'x', admin: true }, existing: null }), 'sahip yöneticiyi');
  assert.match(mutes.check({ actor: owner, target: plain, existing: { by: 'admin' } }), /yönetici susturdu/);
  assert.equal(mutes.check({ actor: owner, target: plain, existing: { by: 'owner' } }), null);
});

test('yetki matrisi: sahip herkesi (yönetici hariç), yönetici herkesi; üye, başka odanın sahibi ve kendini olmaz', async () => {
  const { A, B, ownerA, ownerB } = await rooms();
  const o = await enter(ownerA, A);
  const m1 = await enter(`Uye1x${tag}`, A);
  const m2 = await enter(`Uye2x${tag}`, A);
  const visitor = await enter(ownerB, A); // B'nin sahibi A'da misafir
  const admin = await enter('osyalcin', A);
  void B;

  assert.ok((await mute(m1, m2)).error, 'üye susturamaz');
  assert.ok((await mute(visitor, m2)).error, 'başka odanın sahibi susturamaz');
  assert.ok((await mute(o, o)).error, 'kendini susturamaz');
  assert.ok((await mute(o, admin)).error, 'sahip yöneticiyi susturamaz');

  const seen = eventWhere(m2, 'user-modmuted', (d) => d.id === m1.joinId);
  const own = eventWhere(m1, 'user-modmuted', (d) => d.id === m1.joinId);
  const line = chatText(m2, new RegExp(`Uye1x${tag} susturuldu`));
  noError(await mute(o, m1));
  assert.deepEqual(await seen, { id: m1.joinId, muted: true, by: 'owner' });
  assert.deepEqual(await own, { id: m1.joinId, muted: true, by: 'owner' });
  assert.match((await line).text, new RegExp(`susturan: ${ownerA}`));

  // Yönetici susturur; sahip kaldıramaz ve üstüne yazamaz; yönetici kaldırır
  noError(await mute(admin, m2));
  assert.ok((await mute(o, m2, false)).error);
  assert.ok((await mute(o, m2, true)).error);
  const lifted = eventWhere(m1, 'user-modmuted', (d) => d.id === m2.joinId && !d.muted);
  noError(await mute(admin, m2, false));
  assert.deepEqual(await lifted, { id: m2.joinId, muted: false, by: null });

  // Sahibin susturmasını yönetici de kaldırabilir; yönetici sahibi susturabilir
  noError(await mute(admin, m1, false));
  noError(await mute(admin, o));
  assert.ok((await mute(o, m1)).error === undefined, 'susturulmuş sahip yine de susturabilir');
  noError(await mute(o, m1, false));
});

test('susturulan kendi mute(false) ile açamaz; yük geç girenlere ve kendisine gider; kaldırılınca sessizde kalır', async () => {
  const { A, ownerA } = await rooms(1);
  const o = await enter(ownerA, A);
  const m = await enter(`Kim${tag}`, A);
  noError(await mute(o, m));
  // Protokolde kendi susturmasını kaldıracak olay yok; mic açma (mute false) yok sayılır
  assert.ok((await ack(m, 'mod:mute', { id: m.joinId, muted: false })).error);
  m.emit('mute', false);
  await new Promise((r) => m.emit('time', r)); // aynı soketin sonraki olayı: mute(false) işlendi
  const late = await enter(`Gec${tag}`, A);
  const peer = late.joinRes.peers.find((p) => p.id === m.joinId);
  assert.equal(peer.muted, true);
  assert.equal(peer.modMuted, 'owner');
  assert.equal(peer.home, A);
  assert.equal(late.joinRes.peers.find((p) => p.id === o.joinId).modMuted, null);
  // Sonradan girenin user-joined'ı da bayrağı taşır
  const joined = eventWhere(o, 'user-joined', (d) => d.name === `Gec2${tag}`);
  await enter(`Gec2${tag}`, A);
  assert.equal((await joined).modMuted, null);

  const unmuted = eventWhere(late, 'user-modmuted', (d) => d.id === m.joinId);
  noError(await mute(o, m, false));
  await unmuted;
  const late3 = await enter(`Gec3${tag}`, A);
  const p3 = late3.joinRes.peers.find((p) => p.id === m.joinId);
  assert.equal(p3.modMuted, null);
  assert.equal(p3.muted, true, 'kaldırılınca kendi mikrofonunu açana kadar sessizde');
  const opened = eventWhere(late3, 'user-muted', (d) => d.id === m.joinId && d.muted === false);
  m.emit('mute', false);
  await opened;
});

test('bozuk istekler yok sayılır; odada olmayanı ve odada olmayan hedefi hedefleyemez', async () => {
  const { A, B, ownerA } = await rooms();
  const o = await enter(ownerA, A);
  const elsewhere = await enter(`Baska${tag}`, B);
  for (const payload of [null, 5, 'x', {}, { id: 5, muted: true }, { id: o.joinId, muted: 'evet' }, { id: elsewhere.joinId, muted: true }, { id: 'yok', muted: true }]) {
    const r = await ack(o, 'mod:mute', payload);
    assert.ok(r?.error, JSON.stringify(payload));
  }
  o.emit('mod:mute', { id: elsewhere.joinId, muted: true }); // ack'siz: sessizce yok sayılır
  const lobby = await user('osyalcin');
  assert.ok((await ack(lobby, 'hello', { token: lobby.token })).rooms);
  assert.ok((await ack(lobby, 'mod:mute', { id: elsewhere.joinId, muted: true })).error, 'odada değilken');
  const late = await enter(`Bak${tag}`, B);
  assert.equal(late.joinRes.peers.find((p) => p.id === elsewhere.joinId).modMuted, null);
});

test('çıkıp dönen yine susturulmuş; oda boşalınca susturma gider', async () => {
  const { A, ownerA } = await rooms(1);
  const o = await enter(ownerA, A);
  const m = await enter(`Donen${tag}`, A, `donen${tag}`);
  noError(await mute(o, m));
  // Gerçek çıkış: yenileme payı geçip "ayrıldı" yazılınca döner (yenileme yolu değil)
  const gone = chatText(o, new RegExp(`^Donen${tag} ayrıldı$`));
  m.close();
  await gone;
  const back = await enter(`Donen${tag}`, A);
  assert.equal(back.joinRes.rejoined, undefined);
  assert.equal(back.joinRes.modMuted, 'owner');
  assert.equal(back.joinRes.peers.find((p) => p.id === o.joinId).modMuted, null);
  const seen = await user(`Izle${tag}`);
  const r = await join(seen, A);
  assert.equal(r.peers.find((p) => p.id === back.joinRes.id).modMuted, 'owner');

  // Herkes çıkar: oda boşalır, susturma temizlenir
  for (const s of [o, back, seen]) s.close();
  await emptied(A);
  // Oda boşaldı; yenileme payı (300 ms) içinde dönen olsaydı susturma kalırdı. Pay dolunca kayıt silinir.
  await until(async () => !(await record(A, `Donen${tag}`)), 'kayıt silindi');
  const again = await enter(`Donen${tag}`, A);
  assert.equal(again.joinRes.modMuted, null);
});

test('birleşik oda: sahip yalnız kendi odasının kökenlilerini susturur; ayrılınca her taraf kendi susturmalarını korur', async () => {
  const { A, B, ownerA, ownerB } = await rooms();
  const oa = await enter(ownerA, A);
  const a1 = await enter(`Akok${tag}`, A);
  const ob = await enter(ownerB, B);
  const b1 = await enter(`Bkok${tag}`, B);
  const admin = await user('osyalcin');
  assert.ok((await ack(admin, 'hello', { token: admin.token })).rooms);
  const moved = [next(ob, 'room:moved'), next(b1, 'room:moved')];
  assert.deepEqual(await ack(admin, 'merge:request', { from: A, to: B }), { merged: true });
  const [mob, mb1] = await Promise.all(moved);
  ob.joinId = mob.id;
  b1.joinId = mb1.id;

  assert.ok((await mute(oa, b1)).error, 'A sahibi B kökenliyi susturamaz');
  assert.ok((await mute(ob, a1)).error, 'B sahibi A kökenliyi susturamaz');
  noError(await mute(ob, b1));
  noError(await mute(oa, a1));
  const inA = await enter(`Gozcu${tag}`, A);
  const peers = Object.fromEntries(inA.joinRes.peers.map((p) => [p.name, p]));
  assert.equal(peers[`Bkok${tag}`].modMuted, 'owner');
  assert.equal(peers[`Bkok${tag}`].home, B);
  assert.equal(peers[`Akok${tag}`].modMuted, 'owner');

  // Ayrılma: B kökenliler B'ye döner; susturmaları onlarla gider
  const back = next(b1, 'room:moved');
  assert.deepEqual(await ack(admin, 'merge:split', { room: A }), {});
  const r = await back;
  assert.equal(r.room.id, B);
  assert.equal(r.modMuted, 'owner');
  const inB = await enter(`Bgozcu${tag}`, B);
  assert.equal(inB.joinRes.peers.find((p) => p.name === `Bkok${tag}`).modMuted, 'owner');
  const inA2 = await enter(`Agozcu${tag}`, A);
  assert.equal(inA2.joinRes.peers.find((p) => p.name === `Akok${tag}`).modMuted, 'owner');
  // Ayrıldıktan sonra B sahibi kendi odasında kaldırabilir
  b1.joinId = r.id;
  noError(await mute(ob, b1, false));
});

test('oda kapanınca sahip susturması kalmaz (kapanan odanın kişisi başka odada susturulmuş görünmez)', async () => {
  const { A, B, ownerA } = await rooms();
  const o = await enter(ownerA, A);
  const m = await enter(`Kapan${tag}`, A);
  noError(await mute(o, m));
  const closed = next(m, 'room:closed');
  assert.equal((await http(srv.url, 'DELETE', `/rooms/${A}`, { token: ADMIN })).status, 200);
  await closed;
  const r = await join(m, B);
  assert.equal(r.error, undefined);
  assert.equal(r.modMuted, null);
});

test('hız sınırı: bir soket 4 sn\'de en çok 8 susturma/kaldırma', async () => {
  const { A, ownerA } = await rooms(1);
  const o = await enter(ownerA, A);
  const m = await enter(`Hizli${tag}`, A);
  const out = [];
  for (let i = 0; i < 9; i++) out.push(await mute(o, m, i % 2 === 0));
  for (const r of out.slice(0, 8)) noError(r);
  assert.ok(out[8].error);
});

test('boş misafir odayla birleşmede susturma, birleşme bitince bayatlamaz', async () => {
  const { A, B, ownerA, ownerB } = await rooms();
  const oa = await enter(ownerA, A);
  const admin = await adminLobby();
  assert.deepEqual(await ack(admin, 'merge:request', { from: A, to: B }), { merged: true }); // B'nin canlı durumu yok
  const ob = await enter(ownerB, B); // A'ya yerleşir, kökeni B
  const b1 = await enter(`Bayat${tag}`, B);
  assert.equal(b1.joinRes.room.id, A);
  noError(await mute(ob, b1));
  // B kökenliler gerçekten çıkar ("ayrıldı" yazılır: yenileme payı doldu), sonra ayrılınca B'nin susturması silinir
  const gone = [chatText(oa, new RegExp(`^${ownerB} ayrıldı$`)), chatText(oa, new RegExp(`^Bayat${tag} ayrıldı$`))];
  for (const s of [ob, b1]) s.close();
  await Promise.all(gone);
  assert.deepEqual(await ack(admin, 'merge:split', { room: A }), {});
  const back = await enter(`Bayat${tag}`, B);
  assert.equal(back.joinRes.room.id, B);
  assert.equal(back.joinRes.modMuted, null, 'ayrılınca dönecek kimse yoktu: susturma silindi');
  back.close();
  oa.close();

  // İkinci yol: birleşik oda tamamen boşalır (birleşme kendiliğinden biter)
  const t = await rooms();
  const oa2 = await enter(t.ownerA, t.A);
  assert.deepEqual(await ack(admin, 'merge:request', { from: t.A, to: t.B }), { merged: true });
  const ob2 = await enter(t.ownerB, t.B);
  const b2 = await enter(`Bayat2${tag}`, t.B);
  noError(await mute(ob2, b2));
  for (const s of [oa2, ob2, b2]) s.close();
  await emptied(t.A);
  await until(async () => !(await listed(t.A)).mergedWith, 'birleşme bitti');
  await until(async () => !(await record(t.B, `Bayat2${tag}`)), 'kayıt silindi'); // yenileme payı dolunca
  const again = await enter(`Bayat2${tag}`, t.B);
  assert.equal(again.joinRes.modMuted, null);
});

test('sahip değişince: eski sahip susturmayı kaldıramaz, yeni sahip ve yönetici kaldırır; odadakilere room:roles gider', async () => {
  const { A, ownerA } = await rooms(1);
  const newOwner = `Yeni${tag}`;
  assert.equal((await http(srv.url, 'POST', '/auth/register', { body: { name: newOwner, password: 'hesap-sifre' } })).status, 200);
  const oa = await enter(ownerA, A);
  const m = await enter(`Kalan${tag}`, A);
  const n = await enter(newOwner, A);
  noError(await mute(oa, m));
  const roles = [eventWhere(oa, 'room:roles', (d) => d.id === A), eventWhere(n, 'room:roles', (d) => d.id === A)];
  assert.equal((await http(srv.url, 'PATCH', `/rooms/${A}`, { token: ADMIN, body: { owner: newOwner } })).status, 200);
  await Promise.all(roles);
  assert.ok((await mute(oa, m, false)).error, 'eski sahip');
  noError(await mute(n, m, false), 'yeni sahip');
  noError(await mute(n, m));
  const adminIn = await enter('osyalcin', A);
  noError(await mute(adminIn, m, false), 'yönetici');
});

test('room:roles birleşik odada misafir odanın sahibi değişince ev sahibi odadakilere de gider; tema değişiminde gitmez', async () => {
  const { A, B, ownerA, ownerB } = await rooms();
  const oa = await enter(ownerA, A);
  const admin = await adminLobby();
  assert.deepEqual(await ack(admin, 'merge:request', { from: A, to: B }), { merged: true });
  const got = [];
  oa.on('room:roles', (d) => got.push(d));
  assert.equal((await http(srv.url, 'PATCH', `/rooms/${A}`, { token: ADMIN, body: { theme: 'piksel' } })).status, 200);
  const roles = eventWhere(oa, 'room:roles', (d) => d.id === B);
  assert.equal((await http(srv.url, 'PATCH', `/rooms/${B}`, { token: ADMIN, body: { owner: ownerA } })).status, 200);
  await roles;
  assert.deepEqual(got.map((d) => d.id), [B]);
  void ownerB;
});

test('birleş → ayrıl → yeniden birleş: her kişinin susturması doğru kalır', async () => {
  const { A, B, ownerA, ownerB } = await rooms();
  const oa = await enter(ownerA, A);
  const a1 = await enter(`Ra${tag}`, A);
  const ob = await enter(ownerB, B);
  const b1 = await enter(`Rb${tag}`, B);
  const admin = await adminLobby();
  const merged = async () => {
    const mv = [next(ob, 'room:moved'), next(b1, 'room:moved')];
    assert.deepEqual(await ack(admin, 'merge:request', { from: A, to: B }), { merged: true });
    const [x, y] = await Promise.all(mv);
    ob.joinId = x.id;
    b1.joinId = y.id;
    return y;
  };
  await merged();
  noError(await mute(ob, b1));
  noError(await mute(oa, a1));
  const back = next(b1, 'room:moved');
  assert.deepEqual(await ack(admin, 'merge:split', { room: A }), {});
  assert.equal((await back).modMuted, 'owner');
  const again = await merged();
  assert.equal(again.modMuted, 'owner');
  const look = await enter(`Rgoz${tag}`, A);
  const peers = Object.fromEntries(look.joinRes.peers.map((p) => [p.name, p.modMuted]));
  assert.equal(peers[`Rb${tag}`], 'owner');
  assert.equal(peers[`Ra${tag}`], 'owner');
  assert.equal(peers[ownerB], null);
});

test('susturulan ses efekti çalamaz ve yükleyemez; kaldırılınca çalabilir', async () => {
  const { A, ownerA } = await rooms(1);
  const o = await enter(ownerA, A);
  const m = await enter(`Efekt${tag}`, A);
  noError(await mute(o, m));
  const notice = eventWhere(m, 'notice', (t) => /Susturuldun/.test(t));
  const heard = [];
  o.on('sfx', (d) => heard.push(d));
  m.emit('sfx', 'clap');
  assert.match(await notice, /efekt/);
  const wav = Buffer.alloc(100);
  wav.write('RIFF', 0, 'latin1');
  wav.write('WAVE', 8, 'latin1');
  const up = await ack(m, 'sfx:upload', { data: wav, label: 'deneme' });
  assert.match(up.error || '', /Susturuldun/);
  noError(await mute(o, m, false));
  const ok = eventWhere(o, 'sfx', (d) => d.id === 'clap');
  m.emit('sfx', 'clap');
  await ok;
  assert.equal(heard.length, 1, 'susturulmuşken gelen efekt yayılmadı');
});

// ---------- Köken kapıdır; ortak odadaki susturma kapının odasına kopyalanır ----------

// A ve B birleşik (A ev sahibi). X, B'de susturulmuş ve B'den çıkmış (B dolu kaldığı için kayıt duruyor).
async function mutedInB({ by = 'owner', lockB = false } = {}) {
  const t = await rooms();
  const oa = await enter(t.ownerA, t.A);
  const ob = await enter(t.ownerB, t.B);
  const x = await enter(`X${tag}`, t.B);
  const admin = await adminLobby();
  const adminIn = by === 'admin' ? await enter('osyalcin', t.B) : null;
  noError(await mute(by === 'admin' ? adminIn : ob, x));
  if (adminIn) {
    const left = eventWhere(ob, 'user-left', (id) => id === adminIn.joinId);
    adminIn.close();
    await left;
  }
  const gone = chatText(ob, new RegExp(`^X${tag} ayrıldı$`));
  x.close();
  await gone;
  if (lockB) assert.equal((await http(srv.url, 'PATCH', `/rooms/${t.B}`, { token: `test:${t.ownerB}`, body: { password: 'kilit-sifre' } })).status, 200);
  const moved = next(ob, 'room:moved');
  assert.deepEqual(await ack(admin, 'merge:request', { from: t.A, to: t.B }), { merged: true });
  ob.joinId = (await moved).id;
  return { ...t, oa, ob, admin };
}

test('ayrılma sırasında sayfasını yenileyen susturulmuş kişi susturmasını kaybetmez', async () => {
  const slow = await startServer({ env: { REJOIN_GRACE_MS: '4000' } });
  const conn = async (name, room, cidv = name) => {
    const s = await client(slow.url, name);
    sockets.push(s);
    const r = await ack(s, 'join', { token: s.token, clientId: cidv, room });
    assert.equal(r.error, undefined, JSON.stringify(r).slice(0, 200));
    s.joinId = r.id;
    s.joinRes = r;
    return s;
  };
  try {
    const mk = async (name, owner) => {
      await http(slow.url, 'POST', '/auth/register', { body: { name: owner, password: 'hesap-sifre' } });
      return (await http(slow.url, 'POST', '/rooms', { token: ADMIN, body: { name, owner } })).json.room.id;
    };
    const A = await mk('Yen A', 'YenA');
    const B = await mk('Yen B', 'YenB');
    const oa = await conn('YenA', A);
    const ob = await conn('YenB', B);
    const x = await conn('Yenileyen', B);
    const admin = await client(slow.url, 'osyalcin');
    sockets.push(admin);
    await ack(admin, 'hello', { token: admin.token });
    const moved = [next(ob, 'room:moved'), next(x, 'room:moved')];
    assert.deepEqual(await ack(admin, 'merge:request', { from: A, to: B }), { merged: true });
    const [mob, mx] = await Promise.all(moved);
    ob.joinId = mob.id;
    x.joinId = mx.id;
    noError(await mute(ob, x));
    // B sahibi çıkar (B kökenli yalnız X kalır); X yenilenirken (bağlantı koptu, yenileme payı içinde) ayrılma olur
    const obLeft = eventWhere(oa, 'user-left', (id) => id === ob.joinId);
    ob.close();
    await obLeft;
    const xLeft = eventWhere(oa, 'user-left', (id) => id === x.joinId);
    x.close();
    await xLeft;
    assert.deepEqual(await ack(admin, 'merge:split', { room: A }), {});
    const back = await conn('Yenileyen', B);
    assert.equal(back.joinRes.room.id, B);
    assert.equal(back.joinRes.modMuted, 'owner');
  } finally {
    await slow.stop();
  }
});

// ---------- Tur 3 ----------

test('ayrılma susturmayı silmez: boş misafir odayla birleşme, B sahibi susturur ve çıkar, ayrılınca b1 B\'de susturulmuş', async () => {
  const { A, B, ownerA, ownerB } = await rooms();
  const oa = await enter(ownerA, A);
  const admin = await adminLobby();
  assert.deepEqual(await ack(admin, 'merge:request', { from: A, to: B }), { merged: true });
  const ob = await enter(ownerB, B);
  const b1 = await enter(`Tek${tag}`, B);
  noError(await mute(ob, b1));
  const gone = chatText(oa, new RegExp(`^${ownerB} ayrıldı$`));
  ob.close();
  await gone;
  const moved = next(b1, 'room:moved');
  assert.deepEqual(await ack(admin, 'merge:split', { room: A }), {});
  const m = await moved;
  assert.equal(m.room.id, B);
  assert.equal(m.modMuted, 'owner');
  const look = await enter(`TekBak${tag}`, B);
  assert.equal(look.joinRes.peers.find((q) => q.name === `Tek${tag}`).modMuted, 'owner');
});

// ---------- Sahip susturması odaya bağlı (kopyalama yok) ----------

test('birleşikken B sahibinin susturduğu kişi A kapısından girerse susturulmuş değil; A sahibi susturabilir, B sahibi susturamaz', async () => {
  const t = await rooms();
  const oa = await enter(t.ownerA, t.A);
  const ob = await enter(t.ownerB, t.B);
  const x = await enter(`Kapi${tag}`, t.B);
  noError(await mute(ob, x));
  const gone = chatText(ob, new RegExp(`^Kapi${tag} ayrıldı$`));
  x.close();
  await gone;
  const admin = await adminLobby();
  const moved = next(ob, 'room:moved');
  assert.deepEqual(await ack(admin, 'merge:request', { from: t.A, to: t.B }), { merged: true });
  ob.joinId = (await moved).id;
  const xa = await enter(`Kapi${tag}`, t.A);
  assert.equal(xa.joinRes.home.id, t.A);
  assert.equal(xa.joinRes.modMuted, null, 'sahip susturması kapı değişince uygulanmaz (belgelendi)');
  assert.equal(await record(t.A, `Kapi${tag}`), null, 'kopyalanmadı');
  assert.ok(await record(t.B, `Kapi${tag}`), 'B\'deki kayıt yerinde');
  assert.ok((await mute(ob, xa)).error, 'B sahibi A kapısından gireni susturamaz');
  const flag = eventWhere(oa, 'user-modmuted', (d) => d.id === xa.joinId);
  assert.equal(noError(await mute(oa, xa)).modMuted, 'owner');
  assert.equal((await flag).by, 'owner');
  const late = await enter(`KapiGec${tag}`, t.A);
  assert.equal(late.joinRes.peers.find((q) => q.name === `Kapi${tag}`).modMuted, 'owner');
});

test('birleşme anındaki taşınma susturmaları değiştirmez; ayrılınca her taraf kendi kayıtlarını korur', async () => {
  const t = await rooms();
  const oa = await enter(t.ownerA, t.A);
  const ob = await enter(t.ownerB, t.B);
  const b1 = await enter(`Tas${tag}`, t.B);
  noError(await mute(ob, b1));
  const admin = await adminLobby();
  const moved = [next(ob, 'room:moved'), next(b1, 'room:moved')];
  assert.deepEqual(await ack(admin, 'merge:request', { from: t.A, to: t.B }), { merged: true });
  const [mob, mb1] = await Promise.all(moved);
  ob.joinId = mob.id;
  b1.joinId = mb1.id;
  assert.equal(mb1.modMuted, 'owner');
  assert.equal(mb1.home.id, t.B);
  assert.equal(await record(t.A, `Tas${tag}`), null);
  const back = next(b1, 'room:moved');
  assert.deepEqual(await ack(admin, 'merge:split', { room: t.A }), {});
  assert.equal((await back).modMuted, 'owner');
  void oa;
});

// ---------- Yönetici susturması hesaba bağlı, site geneli ----------

test('yönetici susturması hesabı izler: birleşikken kapı değişimi, ayrılma, başka oda, gerçek çıkıştan dönüş, kurulduğu odanın kapanması', async () => {
  const t = await rooms(3);
  const oa = await enter(t.ownerA, t.A);
  const ob = await enter(t.ownerB, t.B);
  const oc = await enter(t.ownerC, t.C);
  const name = `Yon${tag}`;
  let x = await enter(name, t.B);
  const adminB = await enter('osyalcin', t.B);
  noError(await mute(adminB, x));
  assert.equal(x.joinRes && (await adminRecord(name)).by, 'admin');
  const adminGone = eventWhere(ob, 'user-left', (id) => id === adminB.joinId);
  adminB.close();
  await adminGone;
  // Birleşme, X A kapısından girer
  const admin = await adminLobby();
  const moved = [next(ob, 'room:moved'), next(x, 'room:moved')];
  assert.deepEqual(await ack(admin, 'merge:request', { from: t.A, to: t.B }), { merged: true });
  const [mob, mx] = await Promise.all(moved);
  ob.joinId = mob.id;
  assert.equal(mx.modMuted, 'admin');
  let gone = chatText(oa, new RegExp(`^${name} ayrıldı$`));
  x.close();
  await gone;
  x = await enter(name, t.A);
  assert.equal(x.joinRes.home.id, t.A);
  assert.equal(x.joinRes.modMuted, 'admin', 'kapı değişince de');
  assert.equal((await enter(`YonGec${tag}`, t.A)).joinRes.peers.find((q) => q.name === name).modMuted, 'admin');
  assert.ok((await mute(oa, x, false)).error, 'sahip kaldıramaz');
  assert.match((await mute(oa, x)).error || '', /yönetici susturdu/, 'sahip üstüne yazamaz');
  // Ayrılma: X A'da (kapısı) kalır, yine susturulmuş
  assert.deepEqual(await ack(admin, 'merge:split', { room: t.A }), {});
  assert.equal((await enter(`YonGec2${tag}`, t.A)).joinRes.peers.find((q) => q.name === name).modMuted, 'admin');
  // Başka oda (C): susturulmuş
  const kicked = next(x, 'kicked');
  const xc = await enter(name, t.C);
  await kicked;
  assert.equal(xc.joinRes.modMuted, 'admin');
  // Gerçek çıkış ve dönüş
  gone = chatText(oc, new RegExp(`^${name} ayrıldı$`));
  xc.close();
  await gone;
  // Kurulduğu oda (B) kapanır: yönetici susturması kalır
  assert.equal((await http(srv.url, 'DELETE', `/rooms/${t.B}`, { token: ADMIN })).status, 200);
  const back = await enter(name, t.C);
  assert.equal(back.joinRes.modMuted, 'admin');
  // Yönetici bir kez kaldırır: her yerde duyulur
  const adminC = await enter('osyalcin', t.C);
  assert.equal(noError(await mute(adminC, back, false)).modMuted, null);
  assert.equal(await adminRecord(name), null);
  const lookC = await enter(`YonGec3${tag}`, t.C);
  assert.equal(lookC.joinRes.peers.find((q) => q.name === name).modMuted, null);
});

test('etkin durum yönetici > sahip; yönetici kaldırınca kökendeki sahip kaydı da gider, kişi duyulur', async () => {
  const { A, ownerA } = await rooms(1);
  const o = await enter(ownerA, A);
  const x = await enter(`Ust${tag}`, A);
  noError(await mute(o, x));
  const adminIn = await enter('osyalcin', A);
  const flag = eventWhere(o, 'user-modmuted', (d) => d.id === x.joinId && d.by === 'admin');
  assert.equal(noError(await mute(adminIn, x)).modMuted, 'admin');
  await flag;
  assert.equal((await enter(`UstGec${tag}`, A)).joinRes.peers.find((q) => q.name === `Ust${tag}`).modMuted, 'admin');
  assert.ok((await mute(o, x, false)).error, 'sahip yöneticinin susturmasını kaldıramaz');
  const lifted = eventWhere(o, 'user-modmuted', (d) => d.id === x.joinId && !d.muted);
  assert.equal(noError(await mute(adminIn, x, false)).modMuted, null);
  await lifted;
  assert.equal(await record(A, `Ust${tag}`), null, 'sahip kaydı da silindi');
  assert.equal((await enter(`UstGec2${tag}`, A)).joinRes.peers.find((q) => q.name === `Ust${tag}`).modMuted, null);
});

test('oda kapanınca: kapanan odanın kökenlileri iptal, öteki kökenlilerin yenileme payı sürer (dönen susturulmuş, dönmeyenin kaydı silinir)', async () => {
  const slow = await startServer({ env: { REJOIN_GRACE_MS: '2500' } });
  const conn = async (name, room) => {
    const s = await client(slow.url, name);
    sockets.push(s);
    const r = await ack(s, 'join', { token: s.token, clientId: name, room });
    assert.equal(r.error, undefined, JSON.stringify(r).slice(0, 200));
    s.joinId = r.id;
    s.joinRes = r;
    return s;
  };
  const rec = async (room, name) => (await inspect(slow.url, room, name)).record;
  try {
    const mk = async (name, owner) => {
      await http(slow.url, 'POST', '/auth/register', { body: { name: owner, password: 'hesap-sifre' } });
      return (await http(slow.url, 'POST', '/rooms', { token: ADMIN, body: { name, owner } })).json.room.id;
    };
    for (const [variant, returns] of [['Don', true], ['Kac', false]]) {
      const A = await mk(`${variant} A`, `${variant}A`);
      const B = await mk(`${variant} B`, `${variant}B`);
      const oa = await conn(`${variant}A`, A);
      const admin = await client(slow.url, 'osyalcin');
      sockets.push(admin);
      await ack(admin, 'hello', { token: admin.token });
      assert.deepEqual(await ack(admin, 'merge:request', { from: A, to: B }), { merged: true }); // B boş
      const ob = await conn(`${variant}B`, B); // A'da, kökeni B
      const x = await conn(`${variant}x`, B);
      noError(await mute(ob, x));
      const obLeft = chatText(oa, new RegExp(`^${variant}B ayrıldı$`));
      ob.close();
      await obLeft; // B sahibi gerçekten çıktı
      const xLeft = eventWhere(oa, 'user-left', (id) => id === x.joinId);
      x.close(); // yenileme payında
      await xLeft;
      const closed = next(oa, 'room:closed');
      assert.equal((await http(slow.url, 'DELETE', `/rooms/${A}`, { token: ADMIN })).status, 200);
      await closed;
      assert.ok(await rec(B, `${variant}x`), 'kapanıştan hemen sonra kayıt duruyor (pay sürüyor)');
      if (returns) {
        const back = await conn(`${variant}x`, B);
        assert.equal(back.joinRes.modMuted, 'owner', 'pay içinde kendi odasına dönen susturulmuş');
      } else {
        await until(async () => !(await rec(B, `${variant}x`)), 'pay dolunca kayıt silindi', 8000);
      }
    }
  } finally {
    await slow.stop();
  }
});
