// Kayıt olma sınırı: adres başına 10 dakikada 5 kayıt denemesi (bozuk ad/şifre sayılmaz, alınmış ad sayılır).
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, http } = require('./helpers');

const LIMIT_MSG = 'Çok fazla kayıt denemesi oldu; 10 dakika sonra tekrar dene.';
let seq = 0;
const register = (srv, headers, name = `Kayit${++seq}`) =>
  http(srv.url, 'POST', '/auth/register', { body: { name, password: 'kayit-sifre' }, headers });

describe('kayıt sınırı (CLIENT_IP_HEADER ayarsız: X-Forwarded-For son değeri)', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv?.stop(); });
  const from = (ip) => ({ 'x-forwarded-for': ip });

  test('5 kayıt olur, 6. 429; başka adres etkilenmez', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await register(srv, from('10.5.0.1'))).status, 200);
    const r = await register(srv, from('10.5.0.1'));
    assert.equal(r.status, 429);
    assert.deepEqual(r.json, { error: LIMIT_MSG });
    assert.equal((await register(srv, from('10.5.0.2'))).status, 200);
  });

  test('paralel istekler 5 sınırını aşamaz', async () => {
    const all = await Promise.all(Array.from({ length: 12 }, () => register(srv, from('10.5.0.3'))));
    const codes = all.map((r) => r.status);
    assert.equal(codes.filter((c) => c === 200).length, 5, codes.join(','));
    assert.equal(codes.filter((c) => c === 429).length, 7, codes.join(','));
  });

  test('bozuk ad ve şifre hakkı harcamaz; alınmış ad harcar', async () => {
    const ip = from('10.5.0.4');
    for (let i = 0; i < 6; i++) {
      assert.equal((await register(srv, ip, '!')).status, 400);
      assert.equal((await http(srv.url, 'POST', '/auth/register', { body: { name: `Kisa${i}`, password: 'x' }, headers: ip })).status, 400);
    }
    assert.equal((await register(srv, ip, 'Alinmis')).status, 200);
    for (let i = 0; i < 4; i++) assert.equal((await register(srv, ip, 'Alinmis')).status, 409);
    assert.equal((await register(srv, ip)).status, 429);
  });
});

describe('kayıt sınırı (CLIENT_IP_HEADER ayarlı)', () => {
  let srv;
  before(async () => { srv = await startServer({ env: { CLIENT_IP_HEADER: 'cf-connecting-ip' } }); });
  after(async () => { await srv?.stop(); });

  test('sınır başlıktaki adrese göre; sahte X-Forwarded-For kaçış sağlamaz', async () => {
    for (let i = 0; i < 5; i++) {
      assert.equal((await register(srv, { 'cf-connecting-ip': '203.0.113.50', 'x-forwarded-for': `10.6.0.${i}` })).status, 200);
    }
    assert.equal((await register(srv, { 'cf-connecting-ip': '203.0.113.50', 'x-forwarded-for': '10.6.1.1' })).status, 429);
    assert.equal((await register(srv, { 'cf-connecting-ip': '203.0.113.51' })).status, 200);
  });
});
