// Aynı hesap sekmeyi kapatıp başka sekmeden (yeni clientId) bekleme süresi içinde dönerse
// eski sekmenin gecikmeli çıkışı "ayrıldı" yazmaz, oyunu bitirmez. Dönmeyen hesap yine ayrılır.
require('./preload');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, ack, http, next } = require('./helpers');

const GRACE = 400; // ms; sunucuya REJOIN_GRACE_MS ile verilir
const ADMIN = 'test:osyalcin';
let srv;
const sockets = [];

before(async () => {
  srv = await startServer({ env: { REJOIN_GRACE_MS: String(GRACE) } });
  for (const name of ['Donus Odasi', 'Kontrol Odasi']) {
    const r = await http(srv.url, 'POST', '/rooms', { token: ADMIN, body: { name } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
});
after(async () => {
  for (const s of sockets) s.close();
  await srv?.stop();
});

let cid = 0;
async function user(name) {
  const s = await client(srv.url, name);
  s.cid = `r${++cid}`;
  sockets.push(s);
  return s;
}
const join = (s, room) => ack(s, 'join', { token: s.token, clientId: s.cid, room });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const roomId = async (name) => (await http(srv.url, 'GET', '/rooms', { token: ADMIN })).json.rooms.find((r) => r.name === name).id;

// İki kişilik sayı bulmaca başlatır; izleyenin son 'sayi' durumunu döner.
async function startSayi(host, guest) {
  const started = new Promise((resolve) => guest.on('sayi', (g) => g && !g.done && resolve(g)));
  host.emit('lobby:open', { game: 'sayi' });
  await next(guest, 'lobbies');
  guest.emit('lobby:join', { game: 'sayi' });
  await next(host, 'lobbies');
  host.emit('lobby:start', { game: 'sayi' });
  return started;
}

function watch(s) {
  const got = { chat: [], sayi: null };
  s.on('chat', (m) => got.chat.push(m.text));
  s.on('sayi', (g) => { got.sayi = g; });
  return got;
}

test('aynı hesap yeni sekmeden süre içinde dönerse eski sekmenin çıkışı oyunu bitirmez', async () => {
  const room = await roomId('Donus Odasi');
  const a = await user('Ayse');
  const b = await user('Bora');
  assert.equal((await join(a, room)).error, undefined);
  assert.equal((await join(b, room)).error, undefined);
  const game = await startSayi(a, b);
  assert.deepEqual([...game.players].sort(), ['Ayse', 'Bora']);
  const seen = watch(b);

  a.close(); // A sekmesi kapandı
  await next(b, 'user-left');
  const a2 = await user('Ayse'); // yeni sekme: yeni clientId
  const back = await join(a2, room);
  assert.equal(back.error, undefined);
  assert.equal(back.sayi.done, false);

  await sleep(GRACE * 2.5);
  assert.ok(!seen.chat.some((t) => /Ayse ayrıldı/.test(t)), JSON.stringify(seen.chat));
  assert.ok(!seen.sayi || !seen.sayi.done, JSON.stringify(seen.sayi));
});

test('dönmeyen hesap süre dolunca ayrılır: mesaj gelir, oyun biter', async () => {
  const room = await roomId('Kontrol Odasi');
  const c = await user('Cem');
  const d = await user('Deniz');
  assert.equal((await join(c, room)).error, undefined);
  assert.equal((await join(d, room)).error, undefined);
  await startSayi(c, d);
  const seen = watch(d);

  c.close();
  await sleep(GRACE * 2.5);
  assert.ok(seen.chat.some((t) => /Cem ayrıldı/.test(t)), JSON.stringify(seen.chat));
  assert.equal(seen.sayi?.done, true);
});
