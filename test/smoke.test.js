// Duman testi: sunucu Supabase'siz açılır, iki kişi odaya girer.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, ack, next } = require('./helpers');

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.stop(); });

test('join ack hata içermez, ikinci kişi girince ilki user-joined alır', async () => {
  const ali = await client(srv.url, 'Ali');
  const res = await ack(ali, 'join', { token: ali.token, clientId: 'c1' });
  assert.equal(res.error, undefined);
  assert.deepEqual(res.peers, []);

  const joined = next(ali, 'user-joined');
  const veli = await client(srv.url, 'Veli');
  const res2 = await ack(veli, 'join', { token: veli.token, clientId: 'c2' });
  assert.equal(res2.error, undefined);
  assert.equal((await joined).name, 'Veli');
  ali.close();
  veli.close();
});
