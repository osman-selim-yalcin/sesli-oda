// Oda birleştirme: merge.js durum makinesi (süreç içinde) ve sunucudaki istek, onay, taşıma, ayrılma
require('./preload');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, ack, http, next } = require('./helpers');
const merge = require('../merge');

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

let cid = 0;
async function user(name, cidOverride) {
  const s = await client(srv.url, name);
  s.cid = cidOverride || `c${++cid}`;
  sockets.push(s);
  return s;
}
const hello = (s) => ack(s, 'hello', { token: s.token });
const join = (s, room, extra = {}) => ack(s, 'join', { token: s.token, clientId: s.cid, room, ...extra });
const request = (s, from, to) => ack(s, 'merge:request', { from, to });
const answer = (s, id, accept) => ack(s, 'merge:answer', { id, accept });
const split = (s, room) => ack(s, 'merge:split', { room });
const listed = async (id) => (await http(srv.url, 'GET', '/rooms', { token: ADMIN })).json.rooms.find((r) => r.id === id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function collect(s) {
  const got = [];
  s.onAny((event, data) => got.push({ event, data }));
  return got;
}
const chatText = (s, text, ms = 3000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`sohbet gelmedi: ${text}`)), ms);
  s.on('chat', (m) => { if (m.text === text) { clearTimeout(timer); resolve(m); } });
});
// Koşulu sağlayan ilk olayı bekler.
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

// Her test kendi oda çiftini ve sahiplerini açar: oda<t>-a (sahibi Asahip<t>), oda<t>-b (sahibi Bsahip<t>).
let tag = 0;
async function pair({ aPass, bPass, extra = 0 } = {}) {
  const t = ++tag;
  const owners = [`Asahip${t}`, `Bsahip${t}`, `Csahip${t}`];
  for (const name of owners) {
    const r = await http(srv.url, 'POST', '/auth/register', { body: { name, password: 'hesap-sifre' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  const open = async (name, owner, password) => {
    const r = await http(srv.url, 'POST', '/rooms', { token: ADMIN, body: { name, owner, password } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json.room.id;
  };
  const A = await open(`Oda${t} A`, owners[0], aPass);
  const B = await open(`Oda${t} B`, owners[1], bPass);
  const C = extra ? await open(`Oda${t} C`, owners[2]) : null;
  return { t, A, B, C, ownerA: `test:${owners[0]}`, ownerB: `test:${owners[1]}`, ownerC: `test:${owners[2]}`, nameB: `Oda${t} B` };
}
// Listede bekleyen (hello demiş) sahip soketi.
async function online(token) {
  const s = await user(token.slice('test:'.length));
  assert.ok((await hello(s)).rooms);
  return s;
}
// Odaya giren n kişi.
async function fill(room, prefix, n, extra) {
  const list = [];
  for (let i = 0; i < n; i++) {
    const s = await user(`${prefix}${i}`);
    const r = await join(s, room, extra);
    assert.equal(r.error, undefined, JSON.stringify(r));
    s.joinId = r.id;
    list.push(s);
  }
  return list;
}
// A sahibi ister, B sahibi kabul eder; B'deki herkesin room:moved'unu döner.
async function mergeRooms({ A, B, ownerA, ownerB }, bSockets) {
  const a = await online(ownerA);
  const b = await online(ownerB);
  const incoming = next(b, 'merge:incoming');
  const req = await request(a, A, B);
  assert.equal(req.error, undefined, JSON.stringify(req));
  const inc = await incoming;
  const moved = bSockets.map((s) => next(s, 'room:moved'));
  const res = await answer(b, inc.id, true);
  assert.equal(res.error, undefined, JSON.stringify(res));
  return { a, b, inc, moved: await Promise.all(moved) };
}

// ---------- merge.js (süreç içinde) ----------

test('merge.js throttle: ret ve düşmeden sonra 60 sn bekleme (yalnız o yön), hesap başına 60 sn\'de 3 istek', () => {
  const now = 1e9;
  const COOL = 'Bu odaya az önce istek gönderildi; biraz sonra tekrar dene.';
  // Ret: aynı yön 60 sn bekler, ters yön ve başka oda serbest
  assert.equal(merge.throttle('t-sahip1', 't-a', 't-b', now), null);
  const q = merge.propose('t-a', 't-b', 'x', now);
  assert.equal(merge.answer(q.id, false, now + 10), null);
  assert.deepEqual(merge.throttle('t-sahip2', 't-a', 't-b', now + 20), { error: COOL });
  assert.equal(merge.throttle('t-sahip3', 't-b', 't-a', now + 20), null, 'ters yön');
  assert.deepEqual(merge.throttle('t-sahip2', 't-a', 't-b', now + 10 + merge.COOLDOWN - 1), { error: COOL });
  assert.equal(merge.throttle('t-sahip4', 't-a', 't-b', now + 10 + merge.COOLDOWN), null, 'süre bitti');

  // Düşme (zaman aşımı) de bekletir
  const e = merge.propose('t-c', 't-d', 'x', now);
  assert.equal(merge.expire(now + merge.REQUEST_TTL).length, 1);
  assert.deepEqual(merge.throttle('t-sahip5', 't-c', 't-d', now + merge.REQUEST_TTL + 1), { error: COOL });
  assert.ok(e.id);

  // Kabul bekletmez
  const k = merge.propose('t-e', 't-f', 'x', now);
  assert.deepEqual(merge.answer(k.id, true, now), { host: 't-e', guest: 't-f' });
  merge.split('t-e');
  assert.equal(merge.throttle('t-sahip6', 't-e', 't-f', now + 1), null);

  // Hesap başına 60 sn'de en çok 3 çağrı (bütün hedeflere toplam); pencere kayınca yeniden
  assert.equal(merge.throttle('t-yogun', 't-g', 't-h1', now), null);
  assert.equal(merge.throttle('t-yogun', 't-g', 't-h2', now + 1), null);
  assert.equal(merge.throttle('t-yogun', 't-g', 't-h3', now + 2), null);
  assert.match(merge.throttle('t-yogun', 't-g', 't-h4', now + 3).error, /Çok fazla birleşme isteği/);
  assert.equal(merge.throttle('t-baska', 't-g', 't-h4', now + 3), null, 'başka hesap etkilenmez');
  assert.equal(merge.throttle('t-yogun', 't-g', 't-h4', now + merge.RATE_WINDOW), null);
});

test('merge.js: aynı oda, bekleyen çift, birleşik oda hata; ret ve zaman aşımı durumu temizler', () => {
  const now = 1_000_000;
  assert.ok(merge.propose('u-a', 'u-a', 'x', now).error);
  const first = merge.propose('u-a', 'u-b', 'x', now);
  assert.equal(typeof first.id, 'string');
  assert.ok(merge.propose('u-a', 'u-b', 'x', now).error, 'aynı çift ikinci kez');
  assert.ok(merge.propose('u-b', 'u-a', 'x', now).error, 'ters yönde de bekleyen istek sayılır');
  assert.equal(merge.answer(first.id, false, now), null, 'ret');
  assert.ok(merge.answer(first.id, true, now).error, 'cevaplanmış istek bir daha cevaplanamaz');

  const second = merge.propose('u-a', 'u-b', 'x', now);
  assert.equal(typeof second.id, 'string', 'retten sonra yeniden istenebilir');
  assert.deepEqual(merge.expire(now + merge.REQUEST_TTL - 1), []);
  assert.equal(merge.expire(now + merge.REQUEST_TTL).length, 1);
  assert.ok(merge.answer(second.id, true, now + merge.REQUEST_TTL).error, 'düşen istek kabul edilemez');
  // süresi dolmuş ama henüz süpürülmemiş istek de kabul edilemez
  const third = merge.propose('u-a', 'u-b', 'x', now);
  assert.ok(merge.answer(third.id, true, now + merge.REQUEST_TTL + 5).error);
  assert.equal(typeof merge.propose('u-a', 'u-b', 'x', now + merge.REQUEST_TTL + 5).id, 'string', 'süresi dolan istek engel değil');
  merge.expire(now + 10 * merge.REQUEST_TTL);

  const ok = merge.propose('u-a', 'u-b', 'x', now);
  const other = merge.propose('u-c', 'u-b', 'x', now);
  assert.deepEqual(merge.answer(ok.id, true, now), { host: 'u-a', guest: 'u-b' });
  assert.equal(merge.hostOf('u-b'), 'u-a');
  assert.equal(merge.hostOf('u-a'), 'u-a');
  assert.equal(merge.hostOf('u-c'), 'u-c');
  assert.equal(merge.partnerOf('u-a'), 'u-b');
  assert.equal(merge.partnerOf('u-b'), 'u-a');
  assert.equal(merge.partnerOf('u-c'), null);
  assert.ok(merge.answer(other.id, true, now).error, 'birleşen odayı içeren öteki istek düşer');
  assert.ok(merge.propose('u-a', 'u-c', 'x', now).error, 'zincir yok (ev sahibi)');
  assert.ok(merge.propose('u-c', 'u-b', 'x', now).error, 'zincir yok (misafir)');
  assert.deepEqual(merge.split('u-b'), { host: 'u-a', guest: 'u-b' });
  assert.equal(merge.split('u-a'), null);
  assert.equal(merge.partnerOf('u-a'), null);

  const gone = merge.propose('u-a', 'u-d', 'x', now);
  merge.forget('u-d');
  assert.ok(merge.answer(gone.id, true, now).error, 'kapanan odanın isteği silinir');
});

// ---------- Sunucu ----------

test('yetki: kimliksiz soket, üye ve C sahibi istek gönderemez; üye cevaplayamaz ve ayıramaz', async () => {
  const p = await pair({ extra: 1 });
  const anon = await user('Kimliksiz');
  assert.ok((await request(anon, p.A, p.B)).error);
  const [uye] = await fill(p.A, `Uye${p.t}-`, 1);
  assert.ok((await request(uye, p.A, p.B)).error, 'A üyesi');
  const c = await online(p.ownerC);
  assert.ok((await request(c, p.A, p.B)).error, 'C odasının sahibi A ile B\'yi birleştiremez');
  assert.ok((await request(c, p.C, 'yok-oda')).error, 'olmayan oda');

  const b = await online(p.ownerB);
  const a = await online(p.ownerA);
  const incoming = next(b, 'merge:incoming');
  const req = await request(a, p.A, p.B);
  assert.equal(req.error, undefined, JSON.stringify(req));
  const inc = await incoming;
  assert.ok((await answer(uye, inc.id, true)).error, 'üye cevaplayamaz');
  assert.ok((await answer(a, inc.id, true)).error, 'isteyen taraf kendi isteğini cevaplayamaz');
  assert.ok((await answer(c, inc.id, true)).error, 'C sahibi cevaplayamaz');
  const moved = next(uye, 'room:moved').then(() => assert.fail('A üyesi taşınmamalı'), () => {});
  assert.equal((await answer(b, inc.id, true)).error, undefined);
  assert.ok((await answer(b, inc.id, true)).error, 'ikinci cevap hata');
  assert.ok((await split(uye, p.A)).error, 'üye ayıramaz');
  assert.ok((await split(c, p.A)).error, 'C sahibi ayıramaz');
  assert.ok((await split(c, p.C)).error, 'birleşik olmayan oda');
  assert.equal((await split(b, p.B)).error, undefined, 'B sahibi ayırabilir');
  await moved;
});

test('mutlu yol: B sahibi kabul eder, B\'dekiler A\'ya taşınır; sohbet, lobi ve oda listesi ortak', async () => {
  const p = await pair();
  const aside = await fill(p.A, `Ali${p.t}-`, 2);
  const bside = await fill(p.B, `Bora${p.t}-`, 2);
  const aGot = collect(aside[0]);
  const hi = chatText(aside[1], 'A merhaba');
  aside[1].emit('chat', 'A merhaba');
  await hi;
  const joined = [];
  aside[0].on('user-joined', (u) => joined.push(u.name));
  const merged = chatText(aside[0], `${p.nameB} odası birleşti`);
  const { inc, moved } = await mergeRooms(p, bside);

  assert.deepEqual(inc.from, { id: p.A, name: `Oda${p.t} A` });
  assert.equal(inc.by, `Asahip${p.t}`);
  assert.deepEqual(inc.warn, { game: false, music: false });
  for (const m of moved) {
    assert.equal(m.reason, 'merge');
    assert.equal(m.room.id, p.A);
    assert.equal(m.home.id, p.B);
    assert.ok(m.chat.some((c) => c.text === 'A merhaba'), 'A\'nın sohbeti');
    const peerIds = m.peers.map((x) => x.id);
    for (const s of aside) assert.ok(peerIds.includes(s.joinId), 'A\'daki eşler');
  }
  await merged;
  assert.deepEqual(joined.sort(), bside.map((s, i) => `Bora${p.t}-${i}`));

  // B kökenlinin mesajı A'dakilere ulaşır
  const got = chatText(aside[1], 'B selam');
  bside[0].emit('chat', 'B selam');
  await got;
  // Taşınmalar için ayrıldı/katıldı yazılmaz
  assert.ok(!aGot.some((e) => e.event === 'chat' && /katıldı|ayrıldı/.test(e.data.text)), JSON.stringify(aGot.filter((e) => e.event === 'chat')));

  // A'da açılan lobiye B kökenli katılabilir
  aside[0].emit('lobby:open', { game: 'race' });
  await eventWhere(bside[0], 'lobbies', (l) => l.race);
  const inLobby = eventWhere(aside[0], 'lobbies', (l) => l.race?.players.includes(`Bora${p.t}-0`));
  bside[0].emit('lobby:join', { game: 'race' });
  await inLobby;

  await sleep(400); // oda listesi yayını
  const la = await listed(p.A);
  const lb = await listed(p.B);
  assert.equal(la.mergedWith, p.B);
  assert.equal(lb.mergedWith, p.A);
  assert.deepEqual(lb.users.sort(), [`Bora${p.t}-0`, `Bora${p.t}-1`]);
  assert.deepEqual(la.users.sort(), [`Ali${p.t}-0`, `Ali${p.t}-1`]);
});

test('birleşikken B\'ye join eden A\'ya yerleşir (B\'nin şifresiyle); A şifresi sorulmaz, ayrılınca sorulur', async () => {
  const p = await pair({ aPass: 'a-sifresi', bPass: 'b-sifresi' });
  const aside = await fill(p.A, `Ayla${p.t}-`, 1, { password: 'a-sifresi' });
  const bside = await fill(p.B, `Berk${p.t}-`, 1, { password: 'b-sifresi' });
  const { a } = await mergeRooms(p, bside);

  const third = await user(`Ucuncu${p.t}`);
  assert.equal((await join(third, p.B)).needPassword, true, 'B şifreli');
  assert.equal((await join(third, p.B, { password: 'a-sifresi' })).needPassword, true, 'A\'nın şifresi B için geçmez');
  const joinedA = next(aside[0], 'user-joined');
  const r = await join(third, p.B, { password: 'b-sifresi' });
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(r.room.id, p.A);
  assert.equal(r.home.id, p.B);
  assert.equal((await joinedA).name, `Ucuncu${p.t}`);

  const back = next(third, 'room:moved');
  assert.equal((await split(a, p.A)).error, undefined);
  const m = await back;
  assert.equal(m.reason, 'split');
  assert.equal(m.room.id, p.B);
  // ayrıldıktan sonra A'ya giriş: üyelik yazılmamış, şifre sorulur
  const again = await user(`Ucuncu${p.t}`);
  const res = await join(again, p.A);
  assert.equal(res.needPassword, true, JSON.stringify(res));
});

test('ayrılma: B kökenliler kendi geçmişini ve tier listlerini görür; birleşikken yazılan sohbet A\'da kalır', async () => {
  const p = await pair();
  const aside = await fill(p.A, `Aras${p.t}-`, 1);
  const bside = await fill(p.B, `Banu${p.t}-`, 2);
  const created = await ack(bside[0], 'tierlist:create', 'B listesi');
  assert.equal(created.error, undefined, JSON.stringify(created));
  const { b, moved } = await mergeRooms(p, bside);
  assert.ok(!moved[0].tierLists.some((l) => l.title === 'B listesi'), 'birleşikken A\'nın listeleri');
  const said = chatText(aside[0], 'birleşikken');
  bside[1].emit('chat', 'birleşikken');
  await said;

  const left = eventWhere(aside[0], 'user-left', () => true);
  const splitMsg = chatText(aside[0], `${p.nameB} odası ayrıldı`);
  const back = bside.map((s) => next(s, 'room:moved'));
  assert.equal((await split(b, p.B)).error, undefined);
  for (const m of await Promise.all(back)) {
    assert.equal(m.reason, 'split');
    assert.equal(m.room.id, p.B);
    assert.equal(m.home.id, p.B);
    assert.ok(m.tierLists.some((l) => l.title === 'B listesi'), 'B\'nin tier listleri');
    assert.ok(!m.chat.some((c) => c.text === 'birleşikken'), 'birleşikken yazılan B\'ye gitmez');
    assert.deepEqual(m.peers.map((x) => x.name).filter((n) => n.startsWith('Aras')), []);
  }
  await left;
  await splitMsg;
  await sleep(400);
  assert.equal((await listed(p.A)).mergedWith, null);
  assert.equal((await listed(p.B)).mergedWith, null);
  // A'da sohbet duruyor: yeni giren görür
  const late = await user(`Gec${p.t}`);
  const r = await join(late, p.A);
  assert.ok(r.chat.some((c) => c.text === 'birleşikken'));
});

test('ret ve 60 sn zaman aşımı: durum temiz; aynı yöne bekleme süresi, ters yön serbest', async () => {
  const p = await pair();
  const bside = await fill(p.B, `Bade${p.t}-`, 1);
  const a = await online(p.ownerA);
  const b = await online(p.ownerB);
  let inc = next(b, 'merge:incoming');
  assert.equal((await request(a, p.A, p.B)).error, undefined);
  assert.ok((await request(a, p.A, p.B)).error, 'bekleyen çift');
  const moved = next(bside[0], 'room:moved', 1500).then(() => assert.fail('retten sonra taşınma olmamalı'), () => {});
  const declined = (await inc).id;
  const toA = next(a, 'merge:closed');
  const toB = next(b, 'merge:closed');
  assert.equal((await answer(b, declined, false)).error, undefined);
  assert.deepEqual(await toA, { id: declined, reason: 'declined' }, 'isteyen öğrenir');
  assert.deepEqual(await toB, { id: declined, reason: 'declined' }, 'karar verenin penceresi kapanır');
  await moved;
  assert.equal((await listed(p.B)).mergedWith, null);

  // Retten sonra aynı yöne 60 sn yeni istek yok (karşı odanın sahibi rahatsız edilmesin); ters yön serbest
  const silent = next(b, 'merge:incoming', 500).then(() => assert.fail('bekleme süresinde istek gitmemeli'), () => {});
  assert.deepEqual(await request(a, p.A, p.B), { error: 'Bu odaya az önce istek gönderildi; biraz sonra tekrar dene.' });
  await silent;
  inc = next(a, 'merge:incoming');
  assert.equal((await request(b, p.B, p.A)).error, undefined, 'ters yön');
  assert.ok((await inc).id);
  // Sunucunun 5 sn'de bir çalışan expire'ı 60 sn sonra düşürür; süreç içi kural aşağıda denetlenir.
  const local = merge.propose(`${p.A}-x`, `${p.B}-x`, 'x', 0);
  merge.expire(merge.REQUEST_TTL);
  assert.ok(merge.answer(local.id, true, merge.REQUEST_TTL).error);
  assert.equal(typeof merge.propose(`${p.A}-x`, `${p.B}-x`, 'x', merge.REQUEST_TTL).id, 'string');
});

test('B sahibi çevrimdışı: hata; site yöneticisi aynı isteği gönderince doğrudan birleşir', async () => {
  const p = await pair();
  const bside = await fill(p.B, `Bilge${p.t}-`, 1);
  const a = await online(p.ownerA);
  const r = await request(a, p.A, p.B);
  assert.equal(r.error, 'Karşı odanın sahibi şu an çevrimiçi değil.');
  const admin = await online(ADMIN);
  const moved = next(bside[0], 'room:moved');
  const ar = await request(admin, p.A, p.B);
  assert.equal(ar.error, undefined, JSON.stringify(ar));
  const m = await moved;
  assert.equal(m.reason, 'merge');
  assert.equal(m.room.id, p.A);
  assert.equal(m.home.id, p.B);
});

test('çevrimiçi yönetici de merge:incoming alır ve onaylayabilir', async () => {
  const p = await pair();
  const bside = await fill(p.B, `Bulut${p.t}-`, 1);
  const b = await online(p.ownerB);
  const admin = await online(ADMIN);
  const a = await online(p.ownerA);
  const toAdmin = next(admin, 'merge:incoming');
  const toOwner = next(b, 'merge:incoming');
  assert.equal((await request(a, p.A, p.B)).error, undefined);
  const inc = await toAdmin;
  assert.equal((await toOwner).id, inc.id);
  const moved = next(bside[0], 'room:moved');
  const closedOwner = next(b, 'merge:closed');
  const closedRequester = next(a, 'merge:closed');
  assert.equal((await answer(admin, inc.id, true)).error, undefined);
  await moved;
  assert.deepEqual(await closedOwner, { id: inc.id, reason: 'merged' }, 'öteki karar vericinin penceresi kapanır');
  assert.deepEqual(await closedRequester, { id: inc.id, reason: 'merged' });
  assert.ok((await answer(b, inc.id, true)).error, 'ilk cevap kazanır');
});

test('doluluk: 4 + 4 ve 6 + 6 birleşir; 7. B kökenli giremez; birleşik oda üçüncü odayla birleşemez', async () => {
  const p = await pair({ extra: 1 });
  await fill(p.A, `Dort${p.t}a`, 4);
  const b4 = await fill(p.B, `Dort${p.t}b`, 4);
  const { moved } = await mergeRooms(p, b4);
  assert.equal(moved[0].peers.length, 4, 'ilk taşınan A\'daki 4 kişiyi görür');
  assert.equal(moved[3].peers.length, 7, 'son taşınan 4 + 3 kişiyi görür');

  const q = await pair({ extra: 1 });
  await fill(q.A, `Alti${q.t}a`, 6);
  const b6 = await fill(q.B, `Alti${q.t}b`, 6);
  const { a } = await mergeRooms(q, b6);
  const seventh = await user(`Yedi${q.t}b`);
  const r = await join(seventh, q.B);
  assert.match(r.error || '', /dolu/, JSON.stringify(r));
  const seventhA = await user(`Yedi${q.t}a`);
  assert.match((await join(seventhA, q.A)).error || '', /dolu/);
  await sleep(400);
  const lb = await listed(q.B);
  assert.equal(lb.users.length, 6);
  assert.equal(lb.max, 6);

  const c = await online(q.ownerC);
  assert.ok((await request(a, q.A, q.C)).error, 'ev sahibi üçüncü odayla');
  assert.ok((await request(c, q.C, q.B)).error, 'üçüncü oda misafirle');
});

test('istek beklerken taraf değişir (yönetici A ile C\'yi birleştirir): kabulde hata, kimse taşınmaz', async () => {
  const p = await pair({ extra: 1 });
  await fill(p.A, `Bek${p.t}a`, 3);
  const bside = await fill(p.B, `Bek${p.t}b`, 1);
  await fill(p.C, `Bek${p.t}c`, 4);
  const a = await online(p.ownerA);
  const b = await online(p.ownerB);
  const inc = next(b, 'merge:incoming');
  assert.equal((await request(a, p.A, p.B)).error, undefined);
  const { id } = await inc;
  const cancelA = next(a, 'merge:closed');
  const cancelB = next(b, 'merge:closed');
  const admin = await online(ADMIN);
  assert.equal((await request(admin, p.A, p.C)).error, undefined, 'yönetici A ile C\'yi birleştirir');
  assert.deepEqual(await cancelA, { id, reason: 'cancelled' });
  assert.deepEqual(await cancelB, { id, reason: 'cancelled' });
  const moved = next(bside[0], 'room:moved', 1000).then(() => assert.fail('taşınmamalı'), () => {});
  const r = await answer(b, id, true);
  assert.ok(r.error, JSON.stringify(r));
  await moved;
  assert.equal((await listed(p.B)).mergedWith, null);
});

test('B sahibi birleşikken çıkar: birleşme sürer, A sahibi ayırır', async () => {
  const p = await pair();
  await fill(p.A, `Cik${p.t}a`, 1);
  const bOwnerIn = await user(`Bsahip${p.t}`);
  assert.equal((await join(bOwnerIn, p.B)).error, undefined);
  const bside = await fill(p.B, `Cik${p.t}b`, 1);
  const { a } = await mergeRooms(p, [bOwnerIn, ...bside]);
  bOwnerIn.close();
  await sleep(400);
  assert.equal((await listed(p.A)).mergedWith, p.B);
  const back = next(bside[0], 'room:moved');
  assert.equal((await split(a, p.A)).error, undefined);
  assert.equal((await back).room.id, p.B);
});

test('ayrılırken bağlantısı kopuk B kökenli geri gelince B\'ye; birleşikken yenileyen A\'ya döner', async () => {
  const p = await pair();
  const aside = await fill(p.A, `Kop${p.t}a`, 1);
  const [stay, refresher, dropped] = await fill(p.B, `Kop${p.t}b`, 3);
  const { a } = await mergeRooms(p, [stay, refresher, dropped]);

  // Yenileme: aynı sekme kimliği yeni soketle B'ye join eder -> A'ya döner
  refresher.close();
  await sleep(100);
  const again = await user(`Kop${p.t}b1`, refresher.cid);
  const r = await join(again, p.B);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(r.room.id, p.A);
  assert.equal(r.home.id, p.B);

  // Ayrılma anında kopuk olan: geri gelip B'ye join edince B'ye yerleşir
  dropped.close();
  await sleep(100);
  const back = next(stay, 'room:moved');
  assert.equal((await split(a, p.A)).error, undefined);
  assert.equal((await back).room.id, p.B);
  const returned = await user(`Kop${p.t}b2`, dropped.cid);
  const rr = await join(returned, p.B);
  assert.equal(rr.error, undefined, JSON.stringify(rr));
  assert.equal(rr.room.id, p.B);
  assert.equal(rr.home.id, p.B);
  assert.ok(aside[0].connected);
});

test('A kapatılırsa önce ayrılma yapılır: B kökenliler B\'de, A kökenliler listede', async () => {
  const p = await pair();
  const aside = await fill(p.A, `Kap${p.t}a`, 1);
  const bside = await fill(p.B, `Kap${p.t}b`, 1);
  await mergeRooms(p, bside);
  const back = next(bside[0], 'room:moved');
  const closedA = next(aside[0], 'room:closed');
  const bClosed = next(bside[0], 'room:closed', 1000).then(() => assert.fail('B kökenli listeye düşmemeli'), () => {});
  const r = await http(srv.url, 'DELETE', `/rooms/${p.A}`, { token: ADMIN });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const m = await back;
  assert.equal(m.reason, 'split');
  assert.equal(m.room.id, p.B);
  await closedA;
  await bClosed;
  await sleep(400);
  assert.equal((await listed(p.B)).mergedWith, null);
});

test('B kapatılırsa B kökenliler listeye döner, birleşme biter, A kökenliler kalır', async () => {
  const p = await pair();
  const aside = await fill(p.A, `Kbp${p.t}a`, 1);
  const bside = await fill(p.B, `Kbp${p.t}b`, 1);
  await mergeRooms(p, bside);
  const closedB = next(bside[0], 'room:closed');
  const left = next(aside[0], 'user-left');
  const aClosed = next(aside[0], 'room:closed', 1000).then(() => assert.fail('A kökenli çıkmamalı'), () => {});
  assert.equal((await http(srv.url, 'DELETE', `/rooms/${p.B}`, { token: ADMIN })).status, 200);
  await closedB;
  await left;
  await aClosed;
  await sleep(400);
  assert.equal((await listed(p.A)).mergedWith, null);
});

test('birleşme anında B\'deki lobi kapanır, B\'nin müziği duraklatılır; uyarı game ve music doğru', async () => {
  const p = await pair();
  const bside = await fill(p.B, `Muz${p.t}-`, 1);
  const s = bside[0];
  s.emit('lobby:open', { game: 'race' });
  await eventWhere(s, 'lobbies', (l) => l.race);
  s.emit('media:add', 'dQw4w9WgXcQ');
  const playing = await eventWhere(s, 'media', (m) => m.current, 8000);
  s.emit('media:add', 'jNQXAC9IVRw');
  await eventWhere(s, 'media', (m) => m.queue.length === 1, 8000);
  s.emit('media:play', 12);
  await eventWhere(s, 'media', (m) => m.playing);
  const said = chatText(s, 'B\'nin eski mesajı');
  s.emit('chat', 'B\'nin eski mesajı');
  await said;

  const got = collect(s);
  const a = await online(p.ownerA);
  const b = await online(p.ownerB);
  const incoming = next(b, 'merge:incoming');
  assert.equal((await request(a, p.A, p.B)).error, undefined);
  const inc = await incoming;
  assert.deepEqual(inc.warn, { game: true, music: true });
  const moved = next(s, 'room:moved');
  assert.equal((await answer(b, inc.id, true)).error, undefined);
  const m = await moved;
  assert.deepEqual(m.lobbies, {}, 'A\'nın lobileri');
  const before = got.slice(0, got.findIndex((e) => e.event === 'room:moved'));
  const media = before.filter((e) => e.event === 'media').pop();
  assert.ok(media, 'taşınmadan önce B\'nin media durumu gelir');
  assert.equal(media.data.playing, false);
  const lobbies = before.filter((e) => e.event === 'lobbies').pop();
  assert.ok(lobbies && !lobbies.data.race, 'B\'deki lobi kapandı');

  // Ayrılınca B'nin kendi canlı durumu beklediği gibi döner: şarkı duraklamış, sıra ve eski sohbet yerinde
  const back = next(s, 'room:moved');
  assert.equal((await split(b, p.B)).error, undefined);
  const r = await back;
  assert.equal(r.room.id, p.B);
  assert.equal(r.media.current?.id, playing.current.id, 'şarkı korunur');
  assert.equal(r.media.playing, false);
  assert.ok(r.media.position >= 12);
  assert.deepEqual(r.media.queue.map((q) => q.videoId), ['jNQXAC9IVRw'], 'sıra korunur');
  assert.ok(r.chat.some((c) => c.text === 'B\'nin eski mesajı'), 'B\'nin sohbeti korunur');
  assert.deepEqual(r.lobbies, {});
});

test('ev sahibi oda boşalınca birleşme biter; bekleyen boş misafir odanın canlı durumu silinir', async () => {
  const p = await pair();
  const [aUser] = await fill(p.A, `Bos${p.t}a`, 1);
  const [bUser] = await fill(p.B, `Bos${p.t}b`, 1);
  const said = chatText(bUser, 'silinecek mesaj');
  bUser.emit('chat', 'silinecek mesaj');
  await said;
  await mergeRooms(p, [bUser]);
  await sleep(400);
  assert.deepEqual((await listed(p.B)).users, [`Bos${p.t}b0`]);
  aUser.close();
  bUser.close();
  await sleep(400);
  const lb = await listed(p.B);
  assert.equal(lb.mergedWith, null);
  assert.deepEqual(lb.users, [], 'boş misafir oda dolu görünmez');
  assert.equal((await listed(p.A)).mergedWith, null);
  // B'ye yeni giren yeni bir canlı durum bulur (eski boş oda kalmadı)
  const fresh = await user(`Yeni${p.t}b`);
  const r = await join(fresh, p.B);
  assert.equal(r.room.id, p.B);
  assert.ok(!r.chat.some((c) => c.text === 'silinecek mesaj'));
});

test('room:merge: A\'da kalan birleşmede B\'nin id\'sini, ayrılmada null alır; taşınanın görünümü aynı', async () => {
  const p = await pair();
  const [aUser] = await fill(p.A, `Olay${p.t}a`, 1);
  const bside = await fill(p.B, `Olay${p.t}b`, 1);
  const merged = next(aUser, 'room:merge');
  const { b, moved } = await mergeRooms(p, bside);
  assert.deepEqual(await merged, { mergedWith: p.B, name: p.nameB });
  assert.equal(moved[0].room.mergedWith, p.B, 'room:moved görünümü olayla aynı');
  const splitEv = next(aUser, 'room:merge');
  const back = next(bside[0], 'room:moved');
  assert.equal((await split(b, p.B)).error, undefined);
  assert.deepEqual(await splitEv, { mergedWith: null, name: null });
  assert.equal((await back).room.mergedWith, null);
});

test('room:merge: boş B ile birleşmede de (yönetici, hemen) A\'dakilere gelir; B kapanınca null', async () => {
  const p = await pair();
  const [aUser] = await fill(p.A, `Bosb${p.t}a`, 1);
  const admin = await online(ADMIN);
  const merged = next(aUser, 'room:merge');
  assert.deepEqual(await request(admin, p.A, p.B), { merged: true });
  assert.deepEqual(await merged, { mergedWith: p.B, name: p.nameB });
  const closed = next(aUser, 'room:merge');
  assert.equal((await http(srv.url, 'DELETE', `/rooms/${p.B}`, { token: ADMIN })).status, 200);
  assert.deepEqual(await closed, { mergedWith: null, name: null });
});
