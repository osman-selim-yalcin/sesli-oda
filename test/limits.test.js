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

// Lobiyi kurar, sonra herkesi sırayla sokar: her katılma ya lobide görünür ya da "Lobi dolu" bildirimi alır.
async function fillLobby(game, n) {
  const id = await room();
  const ps = await people(id, n, `${game}${seq}k`);
  const opened = eventWhere(ps[0], 'lobbies', (l) => l[game]);
  ps[0].emit('lobby:open', { game });
  let lobby = (await opened)[game];
  const notices = [];
  for (const s of ps.slice(1)) {
    const name = s.token.slice('test:'.length);
    const inLobby = eventWhere(s, 'lobbies', (l) => l[game]?.players.includes(name)).then((l) => ({ lobby: l[game] }));
    const refused = eventWhere(s, 'notice', (t) => /Lobi dolu/.test(t)).then((text) => ({ text }));
    s.emit('lobby:join', { game });
    const r = await Promise.race([inLobby, refused]);
    inLobby.catch(() => {});
    refused.catch(() => {});
    if (r.lobby) lobby = r.lobby;
    else notices.push(r.text);
  }
  return { ps, lobby, notices };
}

for (const [game, max] of [['kelime', 6], ['dino', 7], ['hedef', 11], ['kural', 11], ['mantik', 11], ['daktilo', 11], ['race', 11], ['memory', 11], ['sayi', 2]]) {
  test(`${game}: lobi en fazla ${max} kişi; dolu lobiye giren nedenini duyar`, async () => {
    const n = Math.min(max + 1, 10);
    const { lobby, notices } = await fillLobby(game, n);
    assert.equal(lobby.max, max);
    assert.equal(lobby.players.length, Math.min(n, max), 'lobi max\'a kadar dolar');
    if (n > max) assert.deepEqual(notices, Array(n - max).fill(`Lobi dolu (en fazla ${max} kişi).`));
    else assert.deepEqual(notices, [], 'odadaki 10 kişinin hepsi lobiye girer');
  });
}
