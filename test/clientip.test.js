// Gerçek ziyaretçi adresi: CLIENT_IP_HEADER ayarlıysa adres o başlıktan, yoksa eski kural (X-Forwarded-For'un son değeri).
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, ack, http } = require('./helpers');
const { makeClientIp, limiterKey } = require('../clientip');

// Express isteği ve socket.io soketi gibi görünen sahte nesneler
const req = (headers, { remote = '127.0.0.1', ip = remote } = {}) => ({ headers, ip, socket: { remoteAddress: remote } });
const sock = (headers, address = '127.0.0.1') => ({ handshake: { headers, address } });

describe('clientIp birim', () => {
  const cf = makeClientIp('CF-Connecting-IP'); // büyük harfle verilse de çalışır

  test('başlık ayarlı ve geçerli: başlıktaki adres (HTTP ve soket)', () => {
    assert.equal(cf(req({ 'cf-connecting-ip': ' 203.0.113.7 ' })), '203.0.113.7');
    assert.equal(cf(req({ 'cf-connecting-ip': '2001:db8::1' })), '2001:db8::1');
    assert.equal(cf(sock({ 'cf-connecting-ip': '198.51.100.4' })), '198.51.100.4');
  });

  test('başlık ayarlı ama yok: bağlantı adresi, X-Forwarded-For değil', () => {
    assert.equal(cf(req({ 'x-forwarded-for': '1.2.3.4' }, { remote: '10.9.9.9', ip: '1.2.3.4' })), '10.9.9.9');
    assert.equal(cf(sock({ 'x-forwarded-for': '1.2.3.4' }, '10.9.9.9')), '10.9.9.9');
  });

  test('başlık ayarlı ama bozuk ya da liste: bağlantı adresi', () => {
    for (const bad of ['', 'abc', '1.2.3', '999.1.1.1', '1.2.3.4, 5.6.7.8', '1.2.3.4 5.6.7.8', '<script>']) {
      assert.equal(cf(req({ 'cf-connecting-ip': bad }, { remote: '10.0.0.5' })), '10.0.0.5', bad);
      assert.equal(cf(sock({ 'cf-connecting-ip': bad }, '10.0.0.5')), '10.0.0.5', bad);
    }
    assert.equal(cf(req({ 'cf-connecting-ip': ['1.2.3.4', '5.6.7.8'] }, { remote: '10.0.0.5' })), '10.0.0.5');
    // Bölge kimlikli (zone id) IPv6 geçersiz sayılır
    assert.equal(cf(req({ 'cf-connecting-ip': 'fe80::1%eth0' }, { remote: '10.0.0.5' })), '10.0.0.5');
  });

  test('başlık yok/bozuk: uyarı bir kez, sonra en çok 10 dakikada bir', () => {
    const warns = [];
    let now = 1000;
    const f = makeClientIp('cf-connecting-ip', { warn: (m) => warns.push(m), now: () => now });
    f(req({})); f(req({ 'cf-connecting-ip': 'bozuk' })); f(sock({}));
    assert.equal(warns.length, 1);
    assert.match(warns[0], /cf-connecting-ip/);
    f(req({ 'cf-connecting-ip': '203.0.113.7' })); // geçerli başlık uyarı vermez
    now += 9 * 60 * 1000; f(req({}));
    assert.equal(warns.length, 1);
    now += 2 * 60 * 1000; f(req({}));
    assert.equal(warns.length, 2);
    const quiet = [];
    makeClientIp('', { warn: (m) => quiet.push(m) })(req({}));
    assert.equal(quiet.length, 0); // ayarsızken uyarı yok
  });

  test('başlık ayarlı değil: eski davranış (req.ip; sokette X-Forwarded-For son değeri)', () => {
    const old = makeClientIp('');
    assert.equal(old(req({ 'cf-connecting-ip': '203.0.113.7' }, { remote: '10.0.0.1', ip: '9.9.9.9' })), '9.9.9.9');
    assert.equal(old(sock({ 'x-forwarded-for': '6.6.6.6, 7.7.7.7', 'cf-connecting-ip': '203.0.113.7' })), '7.7.7.7');
    assert.equal(old(sock({}, '10.1.1.1')), '10.1.1.1');
    assert.equal(makeClientIp(undefined)(sock({ 'x-forwarded-for': '8.8.8.8' })), '8.8.8.8');
  });
});

describe('limiterKey: deneme sınırı anahtarı', () => {
  test('IPv4 olduğu gibi', () => {
    assert.equal(limiterKey('203.0.113.7'), '203.0.113.7');
  });
  test('IPv6: /64 öneki, kanonik biçimde', () => {
    assert.equal(limiterKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
    assert.equal(limiterKey('2001:0DB8:0001:0002:aaaa::1'), '2001:db8:1:2::/64');
    assert.equal(limiterKey('2001:db8:1:2::ffff'), '2001:db8:1:2::/64');
    assert.equal(limiterKey('2001:db8::1'), '2001:db8:0:0::/64');
    assert.equal(limiterKey('::1'), '0:0:0:0::/64');
    // aynı /64'teki iki adres aynı anahtar, farklı /64 farklı
    assert.equal(limiterKey('2a00:1450:4001:80b::1'), limiterKey('2a00:1450:4001:80b:dead:beef:0:7'));
    assert.notEqual(limiterKey('2a00:1450:4001:80b::1'), limiterKey('2a00:1450:4001:80c::1'));
  });
  test('IPv4-mapped IPv6 -> IPv4', () => {
    assert.equal(limiterKey('::ffff:198.51.100.4'), '198.51.100.4');
    assert.equal(limiterKey('::FFFF:127.0.0.1'), '127.0.0.1');
  });
  test('bölge kimliği atılır, bilinmeyen değer olduğu gibi', () => {
    assert.equal(limiterKey('fe80::1%lo0'), 'fe80:0:0:0::/64');
    assert.equal(limiterKey(undefined), 'bilinmiyor');
  });
});

describe('CLIENT_IP_HEADER ayarlı sunucu', () => {
  let srv;
  const sockets = [];
  before(async () => { srv = await startServer({ env: { CLIENT_IP_HEADER: 'cf-connecting-ip' } }); });
  after(async () => {
    for (const s of sockets) s.close();
    await srv?.stop();
  });

  const login = (headers) => http(srv.url, 'POST', '/auth/login', { body: { name: 'Yok', password: 'yanlis' }, headers });

  test('HTTP: giriş sınırı başlıktaki adrese göre; sahte X-Forwarded-For etkisiz; başlıksız/bozuk = bağlantı adresi', async () => {
    // A adresinden 10 yanlış deneme; her biri farklı bir X-Forwarded-For uydurur
    for (let i = 0; i < 10; i++) {
      assert.equal((await login({ 'cf-connecting-ip': '203.0.113.1', 'x-forwarded-for': `10.1.0.${i}` })).status, 401);
    }
    assert.equal((await login({ 'cf-connecting-ip': '203.0.113.1', 'x-forwarded-for': '10.1.1.1' })).status, 429);
    assert.equal((await login({ 'cf-connecting-ip': '203.0.113.2' })).status, 401); // başka adres etkilenmez
    // Başlıksız istekler bağlantı adresinde (127.0.0.1) toplanır; X-Forwarded-For değiştirmek kaçış sağlamaz
    for (let i = 0; i < 10; i++) {
      assert.equal((await login({ 'x-forwarded-for': `10.2.0.${i}` })).status, 401);
    }
    assert.equal((await login({ 'x-forwarded-for': '10.2.1.1' })).status, 429);
    // Bozuk başlık da bağlantı adresine düşer
    assert.equal((await login({ 'cf-connecting-ip': 'bozuk' })).status, 429);
    assert.equal((await login({ 'cf-connecting-ip': '203.0.113.9, 203.0.113.10' })).status, 429);
    assert.equal((await login({ 'cf-connecting-ip': '203.0.113.3' })).status, 401);
  });

  test('soket: oda şifresi sınırı başlıktaki adrese göre; sahte X-Forwarded-For etkisiz', async () => {
    const r = await http(srv.url, 'POST', '/rooms', { token: 'test:osyalcin', body: { name: 'Adres Oda', password: 'adres123' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const room = r.json.room.id;
    let n = 0;
    const join = async (name, headers, password) => {
      const s = await client(srv.url, name, { extraHeaders: headers });
      sockets.push(s);
      return ack(s, 'join', { token: s.token, clientId: `adr${++n}`, room, password });
    };
    // Her deneme farklı hesaptan (hesap:oda anahtarı dolmasın), aynı gerçek adresten, farklı sahte XFF ile
    for (let i = 0; i < 10; i++) {
      const res = await join(`Adr${i}`, { 'cf-connecting-ip': '198.51.100.1', 'x-forwarded-for': `10.3.0.${i}` }, 'yanlis');
      assert.deepEqual(res, { error: 'Şifre yanlış.', needPassword: true });
    }
    assert.equal((await join('AdrX', { 'cf-connecting-ip': '198.51.100.1', 'x-forwarded-for': '10.3.1.1' }, 'adres123')).wait, true);
    const ok = await join('AdrY', { 'cf-connecting-ip': '198.51.100.2' }, 'adres123');
    assert.equal(ok.error, undefined);
  });

  test('IPv6: aynı /64 içinde adres değiştirmek giriş sınırından kaçırmaz', async () => {
    for (let i = 0; i < 10; i++) {
      assert.equal((await login({ 'cf-connecting-ip': `2001:db8:aa:bb::${i + 1}` })).status, 401);
    }
    assert.equal((await login({ 'cf-connecting-ip': '2001:db8:aa:bb:ffff::1' })).status, 429);
    assert.equal((await login({ 'cf-connecting-ip': '2001:db8:aa:bc::1' })).status, 401);
  });

  test('soket: IPv6 /64 ve IPv4-mapped adres aynı anahtara düşer', async () => {
    const r = await http(srv.url, 'POST', '/rooms', { token: 'test:osyalcin', body: { name: 'Altı Oda', password: 'alti1234' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const room = r.json.room.id;
    let n = 0;
    const join = async (name, ip, password) => {
      const s = await client(srv.url, name, { extraHeaders: { 'cf-connecting-ip': ip } });
      sockets.push(s);
      return ack(s, 'join', { token: s.token, clientId: `alt${++n}`, room, password });
    };
    for (let i = 0; i < 10; i++) {
      assert.equal((await join(`Alt${i}`, `2001:db8:cc:dd::${i + 1}`, 'yanlis')).needPassword, true);
    }
    assert.equal((await join('AltX', '2001:db8:cc:dd:1:2:3:4', 'alti1234')).wait, true);
    assert.equal((await join('AltY', '2001:db8:cc:de::1', 'alti1234')).error, undefined);
  });
});
