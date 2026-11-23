// Oda listesinden yönetim: site yöneticisi hiç girmediği (şifreli, dolu) odayı da her yönüyle yönetir;
// odanın üyesi ve başka odanın sahibi hiçbirini yapamaz, sahip yalnız tema/şifre/birleştirme.
require('./preload');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, ack, http, next } = require('./helpers');

let srv;
const ADMIN = 'test:osyalcin';
const OWNER = 'test:Ysahip';
const OTHER = 'test:Ybaska';
const MEMBER = 'test:Yuye';
const sockets = [];

before(async () => {
  srv = await startServer();
  for (const name of ['Ysahip', 'Ybaska', 'Yuye', 'Yyeni']) {
    const r = await http(srv.url, 'POST', '/auth/register', { body: { name, password: 'hesap-sifre' } });
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
  s.cid = `m${++cid}`;
  sockets.push(s);
  return s;
}
const hello = (s) => ack(s, 'hello', { token: s.token });
const join = (s, room, extra = {}) => ack(s, 'join', { token: s.token, clientId: s.cid, room, ...extra });
const patch = (id, token, body) => http(srv.url, 'PATCH', `/rooms/${id}`, { token, body });
const remove = (id, token) => http(srv.url, 'DELETE', `/rooms/${id}`, { token });
const list = async (token = ADMIN) => (await http(srv.url, 'GET', '/rooms', { token })).json.rooms;
const listed = async (id, token) => (await list(token)).find((r) => r.id === id);
let seq = 0;
async function open(body) {
  const r = await http(srv.url, 'POST', '/rooms', { token: ADMIN, body: { name: `Yonet ${++seq}`, owner: 'Ysahip', ...body } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.room.id;
}

test('yönetici hiç girmediği şifreli odada: rol admin, içeridekiler görünür; ad, şifre koy/kaldır, tema, sahip, kapatma', async () => {
  const id = await open({ password: 'oda-sifre' });
  const inside = await user('Icerde1');
  assert.equal((await join(inside, id, { password: 'oda-sifre' })).error, undefined);
  await new Promise((r) => setTimeout(r, 50));
  const view = await listed(id);
  assert.equal(view.role, 'admin');
  assert.deepEqual(view.users, ['Icerde1']);
  assert.equal(view.max, 10);

  // Yönetici listede beklerken (hello) değişiklikleri canlı alır
  const lobby = await user('osyalcin');
  assert.ok((await hello(lobby)).rooms);

  let r = await patch(id, ADMIN, { name: `Yeni Ad ${seq}` });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.room.name, `Yeni Ad ${seq}`);
  const live = await next(lobby, 'rooms');
  assert.equal(live.rooms.find((x) => x.id === id).name, `Yeni Ad ${seq}`);

  const themed = next(inside, 'room:theme');
  r = await patch(id, ADMIN, { theme: 'aydinlik' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(await themed, { id, theme: 'aydinlik' });

  r = await patch(id, ADMIN, { password: null });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.room.locked, false);
  r = await patch(id, ADMIN, { password: 'yeni-sifre' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.room.locked, true);

  r = await patch(id, ADMIN, { owner: 'Yyeni' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.room.owner, 'Yyeni');
  assert.equal((await listed(id, 'test:Yyeni')).role, 'owner');
  assert.equal((await patch(id, ADMIN, { owner: 'Hic Yok' })).status, 400);
  assert.equal((await patch(id, ADMIN, { owner: '' })).status, 400);

  const closed = next(inside, 'room:closed');
  r = await remove(id, ADMIN);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(await closed, { name: `Yeni Ad ${seq}` });
  assert.equal(await listed(id), undefined);
});

test('dolu odayı yönetici dışarıdan yönetir', async () => {
  const id = await open({});
  const { max } = await listed(id);
  for (let i = 0; i < max; i++) {
    const s = await user(`Dolu${i}`);
    assert.equal((await join(s, id)).error, undefined);
  }
  const view = await listed(id);
  assert.equal(view.users.length, max);
  assert.equal((await patch(id, ADMIN, { theme: 'piksel', name: `Dolu Oda ${seq}` })).status, 200);
  assert.equal((await remove(id, ADMIN)).status, 200);
});

test('reddedilir: odanın üyesi ve başka odanın sahibi hiçbir ayarı değiştiremez ve kapatamaz', async () => {
  const id = await open({});
  await open({ owner: 'Ybaska' }); // başka odanın sahibi olsun
  const m = await user('Yuye');
  assert.equal((await join(m, id)).error, undefined);
  for (const token of [MEMBER, OTHER]) {
    for (const body of [{ theme: 'piksel' }, { password: 'abcd1' }, { password: null }, { name: 'Gasp Edilen' }, { owner: 'Yuye' }]) {
      const r = await patch(id, token, body);
      assert.equal(r.status, 403, `${token} ${JSON.stringify(body)} -> ${r.status}`);
    }
    assert.equal((await remove(id, token)).status, 403);
  }
  const view = await listed(id);
  assert.equal(view.theme, 'gece');
  assert.equal(view.locked, false);
  assert.equal(view.owner, 'Ysahip');
});

test('sahip listeden kendi odasında tema ve şifreyi değiştirir; ad, sahip ve kapatma reddedilir', async () => {
  const id = await open({});
  assert.equal((await listed(id, OWNER)).role, 'owner');
  assert.equal((await patch(id, OWNER, { theme: 'piksel' })).status, 200);
  assert.equal((await patch(id, OWNER, { password: 'abcd1' })).status, 200);
  assert.equal((await patch(id, OWNER, { password: null })).status, 200);
  assert.equal((await patch(id, OWNER, { name: 'Kendi Adim' })).status, 403);
  assert.equal((await patch(id, OWNER, { owner: 'Yuye' })).status, 403);
  assert.equal((await remove(id, OWNER)).status, 403);
});

test('yönetici listeden (odaya girmeden) iki odayı birleştirir ve ayırır; üye listeden ayıramaz', async () => {
  const a = await open({});
  const b = await open({ owner: 'Ybaska' });
  const inB = await user('Bdeki');
  assert.equal((await join(inB, b)).error, undefined);
  const lobby = await user('osyalcin');
  assert.ok((await hello(lobby)).rooms);
  const moved = next(inB, 'room:moved');
  const r = await ack(lobby, 'merge:request', { from: a, to: b });
  assert.deepEqual(r, { merged: true });
  assert.equal((await moved).room.id, a);
  assert.equal((await listed(a)).mergedWith, b);

  const m = await user('Yuye');
  assert.ok((await hello(m)).rooms);
  assert.ok((await ack(m, 'merge:split', { room: a })).error);
  const back = next(inB, 'room:moved');
  assert.deepEqual(await ack(lobby, 'merge:split', { room: a }), {});
  assert.equal((await back).room.id, b);
});

test('sahip seçimi için hesap adları yalnız yöneticiye (GET /admin/accounts)', async () => {
  const r = await http(srv.url, 'GET', '/admin/accounts', { token: ADMIN });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.names.includes('Yyeni'));
  assert.ok(r.json.names.includes('Ysahip'));
  assert.deepEqual(r.json.names, [...r.json.names].sort((x, y) => x.localeCompare(y, 'tr')));
  assert.equal((await http(srv.url, 'GET', '/admin/accounts', { token: OWNER })).status, 403);
  assert.equal((await http(srv.url, 'GET', '/admin/accounts')).status, 401);
});
