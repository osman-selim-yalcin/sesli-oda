// Oda sınırı 10 ile oyun lobilerinin sınırları: lobi max'ı istemciye gider, dolu lobiye girmek isteyen
// "Lobi dolu (en fazla N kişi)." duyar. Kelime 6, dinozor 7 (bot dahil), öteki grup oyunları 11 (10 + bot).
require('./preload');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, ack, http, next } = require('./helpers');

let srv;
const sockets = [];
before(async () => {
  srv = await startServer();
});
after(async () => {
  for (const s of sockets) s.close();
  await srv?.stop();
});

let seq = 0;
async function room() {
  const r = await http(srv.url, 'POST', '/rooms', { token: 'test:osyalcin', body: { name: `Sinir ${++seq}` } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.room.id;
}
async function people(id, n, prefix) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = await client(srv.url, `${prefix}${i}`);
    sockets.push(s);
    const r = await ack(s, 'join', { token: s.token, clientId: `${prefix}${i}`, room: id });
    assert.equal(r.error, undefined, JSON.stringify(r));
    out.push(s);
  }
  return out;
}
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

async function fillLobby(game, n) {
  const id = await room();
  const ps = await people(id, n, `${game}${seq}k`);
  const opened = eventWhere(ps[0], 'lobbies', (l) => l[game]);
  ps[0].emit('lobby:open', { game });
  const lobby = (await opened)[game];
  for (const s of ps.slice(1)) s.emit('lobby:join', { game });
  return { ps, lobby };
}

for (const [game, max] of [['kelime', 6], ['dino', 7], ['hedef', 11], ['kural', 11], ['mantik', 11], ['daktilo', 11], ['race', 11], ['memory', 11], ['sayi', 2]]) {
  test(`${game}: lobi en fazla ${max} kişi; dolu lobiye giren nedenini duyar`, async () => {
    const n = Math.min(max + 1, 10);
    const { ps, lobby } = await fillLobby(game, n);
    assert.equal(lobby.max, max);
    const last = ps[n - 1];
    if (n > max) {
      // Son kişi dolu lobiye girmeye çalıştı (join'ler sırayla işlenir)
      const notice = await eventWhere(last, 'notice', (t) => /Lobi dolu/.test(t)).catch(() => null);
      const final = await eventWhere(ps[0], 'lobbies', (l) => l[game]?.players.length === max, 2000).catch(() => null);
      assert.ok(final || notice, 'lobi doldu');
      ps[n - 1].emit('lobby:join', { game });
      assert.equal(await eventWhere(last, 'notice', (t) => /Lobi dolu/.test(t)), `Lobi dolu (en fazla ${max} kişi).`);
    } else {
      const full = await eventWhere(ps[0], 'lobbies', (l) => l[game]?.players.length === n);
      assert.equal(full[game].players.length, n, 'odadaki 10 kişinin hepsi lobiye girer');
    }
  });
}
