// Oda içi avatar renkleri: sunucu verir, herkes aynı rengi görür; çakışma 10 kişiye kadar yok.
require('./preload');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, client, ack, http, next } = require('./helpers');
const colors = require('../colors');

test('colors.js: karma rengi boşsa o, değilse en az kullanılanların en küçüğü; 20 kişide her renk en çok iki', () => {
  const name = 'Ayse';
  const h = colors.hashOf(name);
  assert.equal(colors.pick(name, []), h);
  assert.equal(colors.pick(name, [h]), h === 0 ? 1 : 0);
  const used = [];
  for (let i = 0; i < 20; i++) used.push(colors.pick(`Kisi${i}`, used));
  const per = new Array(10).fill(0);
  for (const i of used) per[i]++;
  assert.ok(per.every((n) => n === 2), JSON.stringify(per));
  assert.equal(new Set(used.slice(0, 10)).size, 10);
});

test('istemcideki renk sayısı ve karma işlevi sunucuyla aynı', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const list = app.match(/const AVATAR_COLORS = \[([^\]]*)\]/)[1].split(',').filter((x) => x.trim());
  assert.equal(list.length, colors.COUNT);
  assert.match(app, /Math\.imul\(hash \^ ch\.codePointAt\(0\), 16777619\)/);
});

let srv;
const sockets = [];
before(async () => {
  srv = await startServer();
});
after(async () => {
  for (const s of sockets) s.close();
  await srv?.stop();
});
async function enter(name, room) {
  const s = await client(srv.url, name);
  sockets.push(s);
  const r = await ack(s, 'join', { token: s.token, clientId: name, room });
  assert.equal(r.error, undefined, JSON.stringify(r));
  s.res = r;
  return s;
}

test('sunucu: 10 kişi 10 ayrı renk; renk join cevabında, peers ve user-joined içinde; herkes aynısını görür', async () => {
  const r = await http(srv.url, 'POST', '/rooms', { token: 'test:osyalcin', body: { name: 'Renk Oda' } });
  const id = r.json.room.id;
  const first = await enter('R0', id);
  const mine = { R0: first.res.color };
  for (let i = 1; i < 10; i++) {
    const joined = next(first, 'user-joined');
    const s = await enter(`R${i}`, id);
    const j = await joined;
    assert.equal(j.color, s.res.color, 'user-joined ile kendi cevabı aynı');
    mine[`R${i}`] = s.res.color;
    for (const p of s.res.peers) assert.equal(p.color, mine[p.name], `${p.name} herkeste aynı`);
  }
  assert.equal(new Set(Object.values(mine)).size, 10);
});

test('sunucu: birleşik 20 kişide her renk en çok iki; odada kalanın rengi değişmez', async () => {
  const mk = async (name) => (await http(srv.url, 'POST', '/rooms', { token: 'test:osyalcin', body: { name } })).json.room.id;
  const A = await mk('Renk A');
  const B = await mk('Renk B');
  const a = [];
  const b = [];
  for (let i = 0; i < 10; i++) a.push(await enter(`Ra${i}`, A));
  for (let i = 0; i < 10; i++) b.push(await enter(`Rb${i}`, B));
  const before = a.map((s) => s.res.color);
  const admin = await client(srv.url, 'osyalcin');
  sockets.push(admin);
  await ack(admin, 'hello', { token: admin.token });
  const moved = b.map((s) => next(s, 'room:moved'));
  assert.deepEqual(await ack(admin, 'merge:request', { from: A, to: B }), { merged: true });
  const last = (await Promise.all(moved)).pop();
  const all = [...last.peers.map((p) => p.color), last.color];
  assert.equal(all.length, 20);
  const per = {};
  for (const c of all) per[c] = (per[c] || 0) + 1;
  assert.ok(Object.values(per).every((n) => n <= 2), JSON.stringify(per));
  const byName = Object.fromEntries(last.peers.map((p) => [p.name, p.color]));
  assert.deepEqual(a.map((s) => byName[s.token.slice(5)]), before, 'A kökenlilerin rengi aynı');
});
