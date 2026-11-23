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
  assert.deepEqual(await mute(o, m1), {});
  assert.deepEqual(await seen, { id: m1.joinId, muted: true, by: 'owner' });
  assert.deepEqual(await own, { id: m1.joinId, muted: true, by: 'owner' });
  assert.match((await line).text, new RegExp(`susturan: ${ownerA}`));

  // Yönetici susturur; sahip kaldıramaz ve üstüne yazamaz; yönetici kaldırır
  assert.deepEqual(await mute(admin, m2), {});
  assert.ok((await mute(o, m2, false)).error);
  assert.ok((await mute(o, m2, true)).error);
  const lifted = eventWhere(m1, 'user-modmuted', (d) => d.id === m2.joinId && !d.muted);
  assert.deepEqual(await mute(admin, m2, false), {});
  assert.deepEqual(await lifted, { id: m2.joinId, muted: false, by: null });

  // Sahibin susturmasını yönetici de kaldırabilir; yönetici sahibi susturabilir
  assert.deepEqual(await mute(admin, m1, false), {});
  assert.deepEqual(await mute(admin, o), {});
  assert.ok((await mute(o, m1)).error === undefined, 'susturulmuş sahip yine de susturabilir');
  assert.deepEqual(await mute(o, m1, false), {});
});

test('susturulan kendi mute(false) ile açamaz; yük geç girenlere ve kendisine gider; kaldırılınca sessizde kalır', async () => {
  const { A, ownerA } = await rooms(1);
  const o = await enter(ownerA, A);
  const m = await enter(`Kim${tag}`, A);
  assert.deepEqual(await mute(o, m), {});
  // Protokolde kendi susturmasını kaldıracak olay yok; mic açma (mute false) yok sayılır
  assert.ok((await ack(m, 'mod:mute', { id: m.joinId, muted: false })).error);
  m.emit('mute', false);
  await sleep(150);
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
  assert.deepEqual(await mute(o, m, false), {});
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
  assert.deepEqual(await mute(o, m), {});
  const gone = eventWhere(o, 'user-left', (id) => id === m.joinId);
  m.close();
  await gone;
  const back = await enter(`Donen${tag}`, A);
  assert.equal(back.joinRes.modMuted, 'owner');
  assert.equal(back.joinRes.peers.find((p) => p.id === o.joinId).modMuted, null);
  const seen = await user(`Izle${tag}`);
  const r = await join(seen, A);
  assert.equal(r.peers.find((p) => p.id === back.joinRes.id).modMuted, 'owner');

  // Herkes çıkar: oda boşalır, susturma temizlenir
  for (const s of [o, back, seen]) s.close();
  await emptied(A);
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
  assert.deepEqual(await mute(ob, b1), {});
  assert.deepEqual(await mute(oa, a1), {});
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
  assert.deepEqual(await mute(ob, b1, false), {});
});

test('oda kapanınca susturma kalmaz (kapanan odanın kişisi başka odada susturulmuş görünmez)', async () => {
  const { A, B, ownerA } = await rooms();
  const o = await enter(ownerA, A);
  const m = await enter(`Kapan${tag}`, A);
  assert.deepEqual(await mute(o, m), {});
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
  assert.deepEqual(out.slice(0, 8), Array(8).fill({}));
  assert.ok(out[8].error);
});

test('birleşikken kapı değiştiren susturulmuş kişi susturulmuş kalır (B kökenli A kapısından, A kökenli B kapısından; yönetici susturması da)', async () => {
  const { A, B, ownerA, ownerB } = await rooms();
  const oa = await enter(ownerA, A);
  const ob = await enter(ownerB, B);
  const b1 = await enter(`Bkapi${tag}`, B, `bkapi${tag}`);
  const a1 = await enter(`Akapi${tag}`, A, `akapi${tag}`);
  const b2 = await enter(`Bkapi2${tag}`, B, `bkapi2${tag}`);
  const admin = await adminLobby();
  const moved = [next(ob, 'room:moved'), next(b1, 'room:moved'), next(b2, 'room:moved')];
  assert.deepEqual(await ack(admin, 'merge:request', { from: A, to: B }), { merged: true });
  const [mob, mb1, mb2] = await Promise.all(moved);
  ob.joinId = mob.id;
  b1.joinId = mb1.id;
  b2.joinId = mb2.id;
  const adminIn = await enter('osyalcin', A);

  assert.deepEqual(await mute(ob, b1), {}); // B sahibi
  assert.deepEqual(await mute(oa, a1), {}); // A sahibi
  assert.deepEqual(await mute(adminIn, b2), {}); // yönetici

  // B kökenli A kapısından yeniden girer
  for (const [s, name, door, by, origin] of [[b1, `Bkapi${tag}`, A, 'owner', B], [a1, `Akapi${tag}`, B, 'owner', A], [b2, `Bkapi2${tag}`, A, 'admin', B]]) {
    const left = eventWhere(oa, 'user-left', (id) => id === s.joinId);
    s.close();
    await left;
    const joined = eventWhere(oa, 'user-joined', (d) => d.name === name);
    const back = await enter(name, door);
    assert.equal(back.joinRes.modMuted, by, `${name} ${door} kapısından`);
    assert.equal(back.joinRes.home.id, origin, 'kökeni değişmez');
    const j = await joined;
    assert.equal(j.modMuted, by);
    assert.equal(j.home, origin);
    const late = await enter(`Gec${name}`, A);
    assert.equal(late.joinRes.peers.find((p) => p.name === name).modMuted, by, 'geç girene de');
    late.close();
    s.joinId = back.joinId;
  }
  // Sahip, kapı değiştiren kendi kökenlisini hâlâ yönetir; öteki sahip yönetemez
  assert.ok((await mute(oa, b1, false)).error);
  assert.deepEqual(await mute(ob, b1, false), {});
  assert.ok((await mute(ob, b2, false)).error, 'yöneticinin susturması');
});

test('birleşikken susturulmuş kişi kapı değiştirerek dolu tarafa sığmaz (köken tarafında sayılır)', async () => {
  const { A, B, ownerA, ownerB } = await rooms();
  const ob = await enter(ownerB, B);
  const bm = await enter(`Bdolu${tag}`, B);
  const admin = await adminLobby();
  const moved = [next(ob, 'room:moved'), next(bm, 'room:moved')];
  assert.deepEqual(await ack(admin, 'merge:request', { from: A, to: B }), { merged: true });
  const [mob, mbm] = await Promise.all(moved);
  ob.joinId = mob.id;
  bm.joinId = mbm.id;
  assert.deepEqual(await mute(ob, bm), {});
  const left = eventWhere(ob, 'user-left', (id) => id === bm.joinId);
  bm.close();
  await left;
  for (let i = 0; i < 9; i++) await enter(`Bdol${i}x${tag}`, B); // B tarafı 10 (sahip + 9)
  const s = await user(`Bdolu${tag}`);
  const r = await join(s, A); // A kapısı boş ama köken B
  assert.match(r.error || '', /dolu/, JSON.stringify(r).slice(0, 200));
  void ownerA;
});

test('boş misafir odayla birleşmede susturma, birleşme bitince bayatlamaz', async () => {
  const { A, B, ownerA, ownerB } = await rooms();
  const oa = await enter(ownerA, A);
  const admin = await adminLobby();
  assert.deepEqual(await ack(admin, 'merge:request', { from: A, to: B }), { merged: true }); // B'nin canlı durumu yok
  const ob = await enter(ownerB, B); // A'ya yerleşir, kökeni B
  const b1 = await enter(`Bayat${tag}`, B);
  assert.equal(b1.joinRes.room.id, A);
  assert.deepEqual(await mute(ob, b1), {});
  // Ayrılma: B kökenliler B'ye döner; sonra hepsi çıkar → B boşalır, susturma silinir
  for (const s of [ob, b1]) s.close();
  await until(async () => (await listed(B)).users.length === 0, 'B kökenliler çıktı');
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
  assert.deepEqual(await mute(ob2, b2), {});
  for (const s of [oa2, ob2, b2]) s.close();
  await emptied(t.A);
  await until(async () => !(await listed(t.A)).mergedWith, 'birleşme bitti');
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
  assert.deepEqual(await mute(oa, m), {});
  const roles = [eventWhere(oa, 'room:roles', (d) => d.id === A), eventWhere(n, 'room:roles', (d) => d.id === A)];
  assert.equal((await http(srv.url, 'PATCH', `/rooms/${A}`, { token: ADMIN, body: { owner: newOwner } })).status, 200);
  await Promise.all(roles);
  assert.ok((await mute(oa, m, false)).error, 'eski sahip');
  assert.deepEqual(await mute(n, m, false), {}, 'yeni sahip');
  assert.deepEqual(await mute(n, m), {});
  const adminIn = await enter('osyalcin', A);
  assert.deepEqual(await mute(adminIn, m, false), {}, 'yönetici');
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
  assert.deepEqual(await mute(ob, b1), {});
  assert.deepEqual(await mute(oa, a1), {});
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
  assert.deepEqual(await mute(o, m), {});
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
  assert.deepEqual(await mute(o, m, false), {});
  const ok = eventWhere(o, 'sfx', (d) => d.id === 'clap');
  m.emit('sfx', 'clap');
  await ok;
  assert.equal(heard.length, 1, 'susturulmuşken gelen efekt yayılmadı');
});
