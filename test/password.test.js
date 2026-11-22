// Şifre değiştirme: /auth/password
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, http } = require('./helpers');

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv?.stop(); });

async function register(name, password) {
  const r = await http(srv.url, 'POST', '/auth/register', { body: { name, password } });
  assert.equal(r.status, 200);
  return r.json.token;
}
const login = (name, password) => http(srv.url, 'POST', '/auth/login', { body: { name, password } });
const change = (token, current, password) => http(srv.url, 'POST', '/auth/password', { token, body: { current, password } });

test('doğru mevcut şifreyle değişir; eski şifre 401, yenisi 200', async () => {
  const token = await register('PwDegis', 'eskisifre');
  const r = await change(token, 'eskisifre', 'yenisifre');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, {});
  assert.equal((await login('PwDegis', 'eskisifre')).status, 401);
  assert.equal((await login('PwDegis', 'yenisifre')).status, 200);
});

test('yanlış mevcut şifre 403, şifre değişmez', async () => {
  const token = await register('PwYanlis', 'dogrusifre');
  const r = await change(token, 'yanlis', 'yenisifre');
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'Mevcut şifre yanlış.');
  assert.equal((await login('PwYanlis', 'dogrusifre')).status, 200);
  assert.equal((await login('PwYanlis', 'yenisifre')).status, 401);
});

test('diğer oturumlar kapanır, değiştirenin oturumu kalır', async () => {
  const a = await register('PwOturum', 'ilksifre');
  const b = (await login('PwOturum', 'ilksifre')).json.token;
  assert.equal((await http(srv.url, 'GET', '/auth/me', { token: b })).status, 200);
  assert.equal((await change(a, 'ilksifre', 'ikincisifre')).status, 200);
  assert.equal((await http(srv.url, 'GET', '/auth/me', { token: b })).status, 401);
  assert.equal((await http(srv.url, 'GET', '/auth/me', { token: a })).status, 200);
});

test('kural dışı yeni şifre 400', async () => {
  const token = await register('PwKisa', 'uzunsifre');
  assert.equal((await change(token, 'uzunsifre', 'abc')).status, 400);
  assert.equal((await change(token, 'uzunsifre', 'x'.repeat(201))).status, 400);
  assert.equal((await change(token, 'uzunsifre', 'uzunsifre')).status, 400);
  assert.equal((await login('PwKisa', 'uzunsifre')).status, 200);
});

test('oturumsuz 401', async () => {
  assert.equal((await change(undefined, 'a', 'bcdef')).status, 401);
  assert.equal((await change('gecersiz', 'a', 'bcdef')).status, 401);
});

// Sınırlayıcı IP'ye göre sayar; sunucuyu etkilememesi için kendi sunucusunda koşar.
test('10 yanlış denemeden sonra doğru şifre de 429', async () => {
  const own = await startServer();
  try {
    const reg = await http(own.url, 'POST', '/auth/register', { body: { name: 'PwSinir', password: 'dogrusifre' } });
    const token = reg.json.token;
    const call = (current) => http(own.url, 'POST', '/auth/password', { token, body: { current, password: 'yenisifre' } });
    for (let i = 0; i < 10; i++) assert.equal((await call('yanlis')).status, 403);
    assert.equal((await call('dogrusifre')).status, 429);
  } finally {
    await own.stop();
  }
});

test('paralel 11 yanlış istek: sınır aşılamaz, en az biri 429', async () => {
  const own = await startServer();
  try {
    const reg = await http(own.url, 'POST', '/auth/register', { body: { name: 'PwParalel', password: 'dogrusifre' } });
    const token = reg.json.token;
    const rs = await Promise.all(Array.from({ length: 11 }, () =>
      http(own.url, 'POST', '/auth/password', { token, body: { current: 'yanlis', password: 'yenisifre' } })));
    assert.ok(rs.some((r) => r.status === 429));
    assert.ok(rs.filter((r) => r.status === 403).length <= 10);
  } finally {
    await own.stop();
  }
});

test('başarılı denemeler sınırı tüketmez', async () => {
  const own = await startServer();
  try {
    const reg = await http(own.url, 'POST', '/auth/register', { body: { name: 'PwBasari', password: 'dogrusifre' } });
    let pw = 'dogrusifre';
    for (let i = 0; i < 12; i++) {
      const next = 'sifre' + i + 'xx';
      const r = await http(own.url, 'POST', '/auth/password', { token: reg.json.token, body: { current: pw, password: next } });
      assert.equal(r.status, 200);
      pw = next;
    }
  } finally {
    await own.stop();
  }
});

test('çalınan oturumun 10 yanlış denemesi sahibin oturumunu kilitlemez; hırsız sınırda kalır', async () => {
  const own = await startServer();
  try {
    const owner = (await http(own.url, 'POST', '/auth/register', { body: { name: 'PwKilit', password: 'dogrusifre' } })).json.token;
    const thief = (await http(own.url, 'POST', '/auth/login', { body: { name: 'PwKilit', password: 'dogrusifre' } })).json.token;
    // Hırsız ve sahip ayrı adreslerden (vekil sunucu X-Forwarded-For'un sonuna gerçek adresi yazar)
    const call = (token, ip, current) => fetch(own.url + '/auth/password', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ current, password: 'sahibinsifresi' }),
    }).then((r) => r.status);
    for (let i = 0; i < 10; i++) assert.equal(await call(thief, '10.1.1.1', 'yanlis'), 403);
    assert.equal(await call(thief, '10.1.1.2', 'dogrusifre'), 429); // adres değiştirse de oturumu sınırda
    assert.equal(await call(owner, '10.2.2.2', 'dogrusifre'), 200);
    assert.equal((await http(own.url, 'GET', '/auth/me', { token: thief })).status, 401);
  } finally {
    await own.stop();
  }
});

test('şifre değişirken eski şifreyle doğrulanan giriş çalışan oturum vermez', async () => {
  // scrypt onlarca ms sürer: değişim sırasında eski şifreyi doğrulamakta olan girişler olur.
  const owner = await register('PwYaris', 'eski-sifre');
  // Kendi adresinden: değişimden sonra başlayan girişler yanlış deneme sayılır, öteki testlerin sınırını yemesin.
  const oldLogin = () => fetch(srv.url + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.9.9.9' },
    body: JSON.stringify({ name: 'PwYaris', password: 'eski-sifre' }),
  }).then(async (r) => ({ status: r.status, json: await r.json() }));
  const logins = [];
  const changed = change(owner, 'eski-sifre', 'yeni-sifre');
  for (let i = 0; i < 8; i++) {
    logins.push(oldLogin());
    await new Promise((r) => setTimeout(r, 4));
  }
  assert.equal((await changed).status, 200);
  const results = await Promise.all(logins);
  for (const r of results) {
    if (r.status !== 200) {
      assert.equal(r.status, 401);
      continue;
    }
    assert.equal((await http(srv.url, 'GET', '/auth/me', { token: r.json.token })).status, 401, 'eski şifreyle alınan oturum çalışıyor');
  }
  assert.equal((await http(srv.url, 'GET', '/auth/me', { token: owner })).status, 200);
});

test('uzun şifrenin hata mesajı aralığı söyler', async () => {
  const long = 'x'.repeat(201);
  const reg = await http(srv.url, 'POST', '/auth/register', { body: { name: 'PwUzun', password: long } });
  assert.equal(reg.status, 400);
  assert.equal(reg.json.error, 'Şifre 4-200 karakter olmalı.');
  const token = await register('PwUzun2', 'uzunsifre');
  const r = await change(token, 'uzunsifre', long);
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'Şifre 4-200 karakter olmalı.');
});
