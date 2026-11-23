// Oda sahibi ve site yöneticisi odadakileri susturur: yetki matrisi, yük (peers / user-joined), yeniden
// giriş, birleşik odada köken kuralı, ayrılmada her tarafın susturmaları, oda boşalınca ya da kapanınca temizlik.
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
// Test sunucusundaki kayıt (preload /__test/mute); anahtar hesap adının küçük harflisi.
const record = async (room, name) => (await http(srv.url, 'GET', `/__test/mute?room=${encodeURIComponent(room)}&key=${encodeURIComponent(name.toLocaleLowerCase('tr-TR'))}`)).json.record;
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

test('mutes.js: yetki kuralı', () => {
  const owner = { key: 'o', admin: false, ownsOrigin: true };
  const admin = { key: 'x', admin: true, ownsOrigin: false };
  const member = { key: 'm', admin: false, ownsOrigin: false };
  const plain = { key: 't', admin: false };
  assert.equal(mutes.check({ actor: owner, target: plain, existing: null, mute: true }), null);
  assert.equal(mutes.check({ actor: admin, target: plain, existing: null, mute: true }), null);
  assert.ok(mutes.check({ actor: member, target: plain, existing: null, mute: true }));
  assert.ok(mutes.check({ actor: owner, target: { key: 'o', admin: false }, existing: null, mute: true }), 'kendini');
  assert.ok(mutes.check({ actor: admin, target: { key: 'x', admin: true }, existing: null, mute: true }), 'yönetici kendini');
  assert.ok(mutes.check({ actor: owner, target: { key: 'x', admin: true }, existing: null, mute: true }), 'sahip yöneticiyi');
  assert.equal(mutes.check({ actor: admin, target: { key: 'y', admin: true }, existing: null, mute: true }), null, 'yönetici başka yöneticiyi');
  assert.ok(mutes.check({ actor: owner, target: plain, existing: { by: 'admin' }, mute: false }), 'yöneticinin susturmasını sahip kaldıramaz');
  assert.ok(mutes.check({ actor: owner, target: plain, existing: { by: 'admin' }, mute: true }), 'üstüne yazamaz');
  assert.equal(mutes.check({ actor: owner, target: plain, existing: { by: 'owner' }, mute: false }), null);
  assert.equal(mutes.check({ actor: admin, target: plain, existing: { by: 'owner' }, mute: false }), null);
});

test('mutes.js: kökene göre saklanır, oda temizlenince gider', () => {
  mutes.set('r1', 'a', { by: 'owner', name: 'O' });
  mutes.set('r2', 'a', { by: 'admin', name: 'X' });
  assert.deepEqual(mutes.get('r1', 'a'), { by: 'owner', name: 'O' });
  assert.deepEqual(mutes.get('r2', 'a'), { by: 'admin', name: 'X' });
  assert.equal(mutes.get('r1', 'b'), null);
  mutes.clear('r1');
  assert.equal(mutes.get('r1', 'a'), null);
  assert.ok(mutes.get('r2', 'a'));
  mutes.remove('r2', 'a');
  assert.equal(mutes.size(), 0);
});

// ---------- sunucu ----------

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

test('oda kapanınca susturma kalmaz (kapanan odanın kişisi başka odada susturulmuş görünmez)', async () => {
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

test('B\'de susturulan A kapısından girer: kökeni A, susturma A\'ya kopyalanır; herkes ve geç girenler görür', async () => {
  const p = await mutedInB();
  const joined = eventWhere(p.oa, 'user-joined', (d) => d.name === `X${tag}`);
  const x = await enter(`X${tag}`, p.A);
  assert.equal(x.joinRes.home.id, p.A, 'köken kapı');
  assert.equal(x.joinRes.modMuted, 'owner');
  const j = await joined;
  assert.equal(j.modMuted, 'owner');
  assert.equal(j.home, p.A);
  const late = await enter(`Gec${tag}`, p.A);
  assert.equal(late.joinRes.peers.find((q) => q.name === `X${tag}`).modMuted, 'owner');
  // Kopya sahip düzeyinde: kapının (A) sahibi kaldırabilir; B'nin sahibi artık bu kişiye karışamaz
  assert.ok((await mute(p.ob, x, false)).error);
  noError(await mute(p.oa, x, false));
});

test('ters yön: A\'da susturulan B kapısından girer → kökeni B, susturulmuş', async () => {
  const t = await rooms();
  const oa = await enter(t.ownerA, t.A);
  const ob = await enter(t.ownerB, t.B);
  const x = await enter(`Y${tag}`, t.A);
  noError(await mute(oa, x));
  const gone = chatText(oa, new RegExp(`^Y${tag} ayrıldı$`));
  x.close();
  await gone;
  const admin = await adminLobby();
  const moved = next(ob, 'room:moved');
  assert.deepEqual(await ack(admin, 'merge:request', { from: t.A, to: t.B }), { merged: true });
  ob.joinId = (await moved).id;
  const y = await enter(`Y${tag}`, t.B);
  assert.equal(y.joinRes.room.id, t.A);
  assert.equal(y.joinRes.home.id, t.B);
  assert.equal(y.joinRes.modMuted, 'owner');
  noError(await mute(ob, y, false), 'B kapısının sahibi kaldırabilir');
});

test('yönetici susturması kapı değişince yönetici susturması kalır; kapının sahibi kaldıramaz', async () => {
  const p = await mutedInB({ by: 'admin' });
  const x = await enter(`X${tag}`, p.A);
  assert.equal(x.joinRes.modMuted, 'admin');
  assert.ok((await mute(p.oa, x, false)).error);
  const adminIn = await enter('osyalcin', p.A);
  noError(await mute(adminIn, x, false));
});

test('ayrılınca kapının odasında kalır ve susturulmuş; şifreli öteki odaya girmez; B\'deki asıl kayıt durur', async () => {
  const p = await mutedInB({ lockB: true });
  const x = await enter(`X${tag}`, p.A);
  assert.equal(x.joinRes.modMuted, 'owner');
  const got = [];
  x.on('room:moved', (d) => got.push(d));
  const back = next(p.ob, 'room:moved');
  assert.deepEqual(await ack(p.admin, 'merge:split', { room: p.A }), {});
  assert.equal((await back).room.id, p.B);
  await new Promise((r) => x.emit('time', r));
  assert.deepEqual(got, [], 'X taşınmadı');
  assert.ok(!(await listed(p.B)).users.includes(`X${tag}`), 'şifreli B\'ye girmedi');
  const look = await enter(`Bak${tag}`, p.A);
  assert.equal(look.joinRes.peers.find((q) => q.name === `X${tag}`).modMuted, 'owner', 'A\'da susturulmuş');
  // B'deki asıl kayıt: X B'ye (şifreyle) dönerse yine susturulmuş
  const left = eventWhere(p.oa, 'user-left', (id) => id === x.joinId);
  x.close();
  await left;
  const xb = await user(`X${tag}`);
  const r = await join(xb, p.B, { password: 'kilit-sifre' });
  assert.equal(r.error, undefined, JSON.stringify(r).slice(0, 200));
  assert.equal(r.modMuted, 'owner');
});

test('birleşme anındaki taşınma kökeni değiştirmez, kopyalamaz: B\'de oturan, A\'daki eski kaydına rağmen susturulmuş değil', async () => {
  const t = await rooms();
  const oa = await enter(t.ownerA, t.A);
  const z = await enter(`Z${tag}`, t.A);
  noError(await mute(oa, z));
  const gone = chatText(oa, new RegExp(`^Z${tag} ayrıldı$`));
  z.close();
  await gone;
  const zb = await enter(`Z${tag}`, t.B); // B'de oturuyor (B kaydı yok)
  assert.equal(zb.joinRes.modMuted, null);
  const admin = await adminLobby();
  const moved = next(zb, 'room:moved');
  assert.deepEqual(await ack(admin, 'merge:request', { from: t.A, to: t.B }), { merged: true });
  const m = await moved;
  assert.equal(m.home.id, t.B);
  assert.equal(m.modMuted, null);
  // A'nın sahibi B kökenliye karışamaz; A kapısından girenleri her zaman susturabilir
  zb.joinId = m.id;
  assert.ok((await mute(oa, zb)).error);
  const w = await enter(`W${tag}`, t.A);
  noError(await mute(oa, w));
});

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

test('kaldırılan susturma yenilemede geri gelmez; yeni birleşmede yeniden taşınabilir', async () => {
  const t = await rooms();
  const oa = await enter(t.ownerA, t.A);
  const ob = await enter(t.ownerB, t.B);
  const x = await enter(`Kal${tag}`, t.B);
  noError(await mute(ob, x));
  const gone = chatText(ob, new RegExp(`^Kal${tag} ayrıldı$`));
  x.close();
  await gone;
  const admin = await adminLobby();
  const merge1 = next(ob, 'room:moved');
  assert.deepEqual(await ack(admin, 'merge:request', { from: t.A, to: t.B }), { merged: true });
  ob.joinId = (await merge1).id;
  const xa = await enter(`Kal${tag}`, t.A, `kal-a${tag}`);
  assert.equal(xa.joinRes.modMuted, 'owner');
  assert.equal(noError(await mute(oa, xa, false)).modMuted, null);
  // Yenileme: yeni soket, aynı hesap, aynı kapı → susturulmamış kalır
  xa.close();
  const again = await enter(`Kal${tag}`, t.A, `kal-a2${tag}`);
  assert.equal(again.joinRes.modMuted, null);
  // Ayrılma, sonra aynı çiftin yeni birleşmesi: taşınma yeniden olabilir (B'deki asıl kayıt duruyor)
  const back = next(ob, 'room:moved');
  assert.deepEqual(await ack(admin, 'merge:split', { room: t.A }), {});
  ob.joinId = (await back).id;
  const left = chatText(oa, new RegExp(`^Kal${tag} ayrıldı$`));
  again.close();
  await left;
  const merge2 = next(ob, 'room:moved');
  assert.deepEqual(await ack(admin, 'merge:request', { from: t.A, to: t.B }), { merged: true });
  await merge2;
  const third = await enter(`Kal${tag}`, t.A, `kal-a3${tag}`);
  assert.equal(third.joinRes.modMuted, 'owner', 'yeni birleşmede yeniden taşındı');
});

test('etkin susturma yalnız kökenin kaydı: öteki odada yönetici kaydı olan kişiyi sahip susturur → sahip düzeyi, geç giren de öyle görür, sahip kaldırır', async () => {
  const t = await rooms();
  const oa = await enter(t.ownerA, t.A);
  const ob = await enter(t.ownerB, t.B);
  const v = await enter(`V${tag}`, t.B);
  const adminB = await enter('osyalcin', t.B);
  noError(await mute(adminB, v)); // B: yönetici kaydı
  const goneAdmin = eventWhere(ob, 'user-left', (id) => id === adminB.joinId);
  adminB.close();
  await goneAdmin;
  const gone = chatText(ob, new RegExp(`^V${tag} ayrıldı$`));
  v.close();
  await gone;
  const va = await enter(`V${tag}`, t.A); // birleşik değilken A'ya: susturulmamış, A'da kayıt yok
  assert.equal(va.joinRes.modMuted, null);
  const admin = await adminLobby();
  const merged = next(ob, 'room:moved');
  assert.deepEqual(await ack(admin, 'merge:request', { from: t.A, to: t.B }), { merged: true });
  ob.joinId = (await merged).id;
  const look0 = await enter(`Bak0${tag}`, t.A);
  assert.equal(look0.joinRes.peers.find((q) => q.name === `V${tag}`).modMuted, null, 'birleşme kökeni değiştirmez');
  const flag = eventWhere(look0, 'user-modmuted', (d) => d.id === va.joinId);
  assert.equal(noError(await mute(oa, va)).modMuted, 'owner');
  assert.equal((await flag).by, 'owner');
  const look = await enter(`Bak1${tag}`, t.A);
  assert.equal(look.joinRes.peers.find((q) => q.name === `V${tag}`).modMuted, 'owner');
  assert.equal(noError(await mute(oa, va, false)).modMuted, null, 'sahip kendi susturmasını kaldırır');
});

test('taşınmada yönetici kaydı öncelikli: kapının odasında sahip kaydı, öteki odada yönetici kaydı → yönetici düzeyi, sahip kaldıramaz', async () => {
  const t = await rooms();
  const oa = await enter(t.ownerA, t.A);
  const ob = await enter(t.ownerB, t.B);
  const w = await enter(`W${tag}`, t.B);
  const adminB = await enter('osyalcin', t.B);
  noError(await mute(adminB, w)); // B: yönetici
  const goneAdmin = eventWhere(ob, 'user-left', (id) => id === adminB.joinId);
  adminB.close();
  await goneAdmin;
  let gone = chatText(ob, new RegExp(`^W${tag} ayrıldı$`));
  w.close();
  await gone;
  const wa = await enter(`W${tag}`, t.A);
  noError(await mute(oa, wa)); // A: sahip
  gone = chatText(oa, new RegExp(`^W${tag} ayrıldı$`));
  wa.close();
  await gone;
  const admin = await adminLobby();
  const merged = next(ob, 'room:moved');
  assert.deepEqual(await ack(admin, 'merge:request', { from: t.A, to: t.B }), { merged: true });
  await merged;
  const again = await enter(`W${tag}`, t.A);
  assert.equal(again.joinRes.modMuted, 'admin');
  assert.ok((await mute(oa, again, false)).error);
});

test('dolu tarafa giremeyen kişiye kayıt taşınmaz; sonra birleşik değilken o odaya girince susturulmuş değil', async () => {
  const t = await rooms();
  const ob = await enter(t.ownerB, t.B);
  const x = await enter(`Dol${tag}`, t.B);
  noError(await mute(ob, x));
  const gone = chatText(ob, new RegExp(`^Dol${tag} ayrıldı$`));
  x.close();
  await gone;
  const inA = [];
  for (let i = 0; i < 10; i++) inA.push(await enter(`Adol${i}x${tag}`, t.A)); // A tarafı dolu
  const admin = await adminLobby();
  const merged = next(ob, 'room:moved');
  assert.deepEqual(await ack(admin, 'merge:request', { from: t.A, to: t.B }), { merged: true });
  await merged;
  const s = await user(`Dol${tag}`);
  const r = await join(s, t.A);
  assert.match(r.error || '', /dolu/);
  assert.equal(await record(t.A, `Dol${tag}`), null, 'kayıt taşınmadı');
  assert.deepEqual(await ack(admin, 'merge:split', { room: t.A }), {});
  const leave = chatText(inA[1], new RegExp(`^Adol0x${tag} ayrıldı$`));
  inA[0].close();
  await leave;
  const r2 = await join(s, t.A);
  assert.equal(r2.error, undefined, JSON.stringify(r2).slice(0, 200));
  assert.equal(r2.modMuted, null);
});

test('ev sahibi oda kapanınca yenileme payındaki misafir kökenlinin susturması kalmaz', async () => {
  const slow = await startServer({ env: { REJOIN_GRACE_MS: '4000' } });
  const conn = async (name, room) => {
    const s = await client(slow.url, name);
    sockets.push(s);
    const r = await ack(s, 'join', { token: s.token, clientId: name, room });
    assert.equal(r.error, undefined, JSON.stringify(r).slice(0, 200));
    s.joinId = r.id;
    return s;
  };
  const rec = async (room, name) => (await http(slow.url, 'GET', `/__test/mute?room=${room}&key=${name.toLocaleLowerCase('tr-TR')}`)).json.record;
  try {
    const mk = async (name, owner) => {
      await http(slow.url, 'POST', '/auth/register', { body: { name: owner, password: 'hesap-sifre' } });
      return (await http(slow.url, 'POST', '/rooms', { token: ADMIN, body: { name, owner } })).json.room.id;
    };
    const A = await mk('Kap A', 'KapA');
    const B = await mk('Kap B', 'KapB');
    const oa = await conn('KapA', A);
    const admin = await client(slow.url, 'osyalcin');
    sockets.push(admin);
    await ack(admin, 'hello', { token: admin.token });
    assert.deepEqual(await ack(admin, 'merge:request', { from: A, to: B }), { merged: true }); // B boş
    const x = await conn('Kapx', B); // A'da, kökeni B
    const adminIn = await conn('osyalcin', A);
    noError(await mute(adminIn, x));
    const xLeft = eventWhere(oa, 'user-left', (id) => id === x.joinId);
    x.close(); // yenileme payında
    await xLeft;
    assert.ok(await rec(B, 'Kapx'));
    const closed = next(oa, 'room:closed');
    assert.equal((await http(slow.url, 'DELETE', `/rooms/${A}`, { token: ADMIN })).status, 200);
    await closed;
    assert.equal(await rec(B, 'Kapx'), null, 'B kökenli kimse kalmadı: kayıt silindi');
  } finally {
    await slow.stop();
  }
});
