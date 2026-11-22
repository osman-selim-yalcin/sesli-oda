// Bozuk soket istekleri (null, sayı, metin, dizi) sunucuyu düşürmez; ack'li istek hata cevabı alır.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, ack, http } = require('./helpers');

let srv;
const sockets = [];

before(async () => {
  srv = await startServer();
});
after(async () => {
  for (const s of sockets) s.close();
  await srv?.stop();
});

async function user(name) {
  const s = await client(srv.url, name, { reconnection: false });
  sockets.push(s);
  return s;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Argümanını açan (destructure eden) işleyiciler; ilk sekizi yeni, gerisi eski işleyiciler.
const EVENTS = [
  'hello', 'join', 'signal', 'merge:request', 'merge:answer', 'merge:split', 'chat', 'media:vote',
  'chat:image', 'sfx:upload', 'media:react', 'tierlist:cover', 'tierlist:rename', 'tier:rename', 'card:add',
  'card:move', 'klotski:win', 'timing:result', 'race:result', 'dino:state', 'dino:dead',
];
const BAD = [null, 42, 'metin', [1, 2]];

// Sunucu hâlâ cevap veriyor mu (çökmüşse fetch bağlantı hatası verir).
async function alive() {
  const r = await http(srv.url, 'GET', '/status').catch((err) => ({ status: 0, err }));
  assert.equal(r.status, 200, `sunucu cevap vermiyor: ${r.err?.cause?.code || r.err?.message}`);
}

// Her olay için her bozuk değeri ack'siz ve ack'li gönderir; ack gelirse cevabı döner.
async function blast(s) {
  const acks = [];
  for (const event of EVENTS) {
    for (const bad of BAD) {
      s.emit(event, bad);
      acks.push(ack(s, event, bad, 1500).then((res) => ({ event, bad, res }), () => null));
    }
  }
  const got = (await Promise.all(acks)).filter(Boolean);
  await sleep(200);
  return got;
}

test('kimliksiz soketin bozuk istekleri sunucuyu düşürmez', async () => {
  const s = await user('Bozuk1');
  await blast(s);
  await alive();
});

test('odadaki soketin bozuk istekleri sunucuyu düşürmez', async () => {
  const s = await user('Bozuk2');
  const res = await ack(s, 'join', { token: 'test:Bozuk2', clientId: 'bz2', room: 'genel' });
  assert.ok(res.id, JSON.stringify(res));
  const got = await blast(s);
  await alive();
  // null ile açılamayan işleyici ack'e hata cevabı verir (cevapsız kalmaz)
  const hello = got.find((g) => g.event === 'hello' && g.bad === null);
  assert.deepEqual(hello?.res, { error: 'İstek işlenemedi.' });
  // Soket hâlâ çalışır
  const t = await new Promise((resolve) => { s.emit('time', resolve); setTimeout(() => resolve(null), 2000); });
  assert.equal(typeof t, 'number');
});
