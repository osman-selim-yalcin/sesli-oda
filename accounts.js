// Hesaplar: kullanıcı adı + şifre, isteğe bağlı profil resmi. Giriş yapınca tarayıcıya uzun ömürlü
// bir oturum anahtarı verilir; sunucu anahtarın sadece özetini saklar. Hesaplar ve oturumlar
// hafızada tutulur, Supabase ayarlıysa oraya da yazılır (store.js).

const crypto = require('crypto');
const { promisify } = require('util');
const express = require('express');
const store = require('./store');

const scrypt = promisify(crypto.scrypt);
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{1,23}$/u; // 2-24 karakter: harf, rakam, boşluk, . _ -
const PASSWORD_MIN = 4;
const PASSWORD_MAX = 200;
const AVATAR_MAX_BYTES = 200 * 1024; // istemci 256 px'e küçültüp gönderir (~15 KB)
const LOGIN_FAIL_MAX = 10;           // bu kadar yanlış şifreden sonra...
const LOGIN_FAIL_WINDOW = 10 * 60 * 1000; // ...bu süre beklenir
const SEEN_SAVE_EVERY = 60 * 1000;        // son görülme en fazla dakikada bir kaydedilir
const ADMINS = new Set(['osyalcin']); // üyeler listesini görebilen hesaplar

const accounts = new Map(); // anahtar (küçük harfli ad) -> { name, passHash, avatar, createdAt, lastSeen }
const sessions = new Map(); // oturum özeti -> anahtar
const avatarCache = new Map(); // anahtar -> { buf, type }

// Deneme sınırı: bir anahtar (ip, hesap...) pencere içinde max kez başarısız olursa engellenir.
function attemptLimiter(max, windowMs) {
  const fails = new Map(); // anahtar -> { count, since }
  return {
    blocked(key) {
      const f = fails.get(key);
      if (f && Date.now() - f.since > windowMs) fails.delete(key);
      return (fails.get(key)?.count || 0) >= max;
    },
    fail(key) {
      const f = fails.get(key) || { count: 0, since: Date.now() };
      f.count++;
      fails.set(key, f);
    },
    // Denemeyi await'ten ÖNCE sayar (paralel istekler sınırı aşamasın); engelliyse null döner.
    // Dönen fonksiyon rezervasyonu geri alır: deneme başarılıysa çağrılır.
    reserve(key) {
      if (this.blocked(key)) return null;
      this.fail(key);
      const f = fails.get(key);
      return () => { if (fails.get(key) === f && f.count > 0) f.count--; };
    },
  };
}

const keyOf = (name) => name.toLocaleLowerCase('tr-TR');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const avatarPath = (key) => `avatars/${sha256(key).slice(0, 32)}`;
const eq = (v) => `eq.${encodeURIComponent(v)}`;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${(await scrypt(password, salt, 32)).toString('hex')}`;
}

async function checkPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const got = await scrypt(password, Buffer.from(salt, 'hex'), 32);
  return crypto.timingSafeEqual(got, Buffer.from(hash, 'hex'));
}

// Profil resmi olanlar: { ad: sürüm }. İstemci resmi /avatar/<ad>?v=<sürüm> adresinden alır.
function profiles() {
  const out = {};
  for (const a of accounts.values()) if (a.avatar) out[a.name] = a.avatar;
  return out;
}

function accountByToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const key = sessions.get(sha256(token));
  return key ? { key, ...accounts.get(key) } : null;
}

async function load() {
  if (!store.enabled) return;
  const rows = await store.select('accounts', 'select=id,name,pass_hash,avatar,created_at,last_seen');
  for (const r of rows) {
    accounts.set(r.id, { name: r.name, passHash: r.pass_hash, avatar: r.avatar, createdAt: Date.parse(r.created_at), lastSeen: Date.parse(r.last_seen) || 0 });
  }
  const sess = await store.select('sessions', 'select=token_hash,account_id');
  for (const s of sess) sessions.set(s.token_hash, s.account_id);
  console.log(`Hesaplar: ${accounts.size} hesap, ${sessions.size} oturum yüklendi.`);
}

async function newSession(key) {
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = sha256(token);
  await store.insert('sessions', { token_hash: hash, account_id: key });
  sessions.set(hash, key);
  seen(key);
  return token;
}

// Oturumu hafızadan ve kayıttan siler.
function dropSession(hash) {
  sessions.delete(hash);
  store.remove('sessions', `token_hash=${eq(hash)}`).catch((err) => console.warn('oturum silme', err.message));
}

// Siteye her girişte (sayfa açılınca ya da odaya katılınca) son görülme güncellenir.
function seen(key) {
  const a = accounts.get(key);
  if (!a) return;
  const saved = a.lastSeen;
  a.lastSeen = Date.now();
  if (a.lastSeen - saved < SEEN_SAVE_EVERY) return;
  store.update('accounts', `id=${eq(key)}`, { last_seen: new Date(a.lastSeen).toISOString() })
    .catch((err) => console.warn('son görülme', err.message));
}

const bearer = (req) => req.get('authorization')?.replace(/^Bearer /, '') || '';
const me = (a, key) => ({ name: a.name, avatar: a.avatar, admin: ADMINS.has(key) });

// onProfile(ad, sürüm): profil resmi değişince odadakilere haber vermek için.
// online(): şu an odada olanların adları.
// onRevoke(anahtar, { keepHash, onlyHash }): oturum kapandı; açık bağlantıları kesmek için. Şifre değişince
// keepHash (değiştiren oturum) dışındakiler, çıkışta yalnız onlyHash kapanır.
function setup(app, { imageTypes, onProfile, online, onRevoke = () => {} }) {
  app.set('trust proxy', 1); // Render'ın vekil sunucusu: req.ip gerçek adres olsun
  const json = express.json({ limit: '4kb' });
  const fail = (res, status, error) => res.status(status).json({ error });
  const PASSWORD_RULE = `Şifre ${PASSWORD_MIN}-${PASSWORD_MAX} karakter olmalı.`;

  // Şifre deneme sınırı: aynı yerden çok yanlış giriş olursa bir süre beklenir.
  const logins = attemptLimiter(LOGIN_FAIL_MAX, LOGIN_FAIL_WINDOW);
  const passwordChanges = attemptLimiter(LOGIN_FAIL_MAX, LOGIN_FAIL_WINDOW);

  const readCredentials = (req) => {
    const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ');
    const password = String(req.body?.password || '');
    return { name, password, key: keyOf(name) };
  };

  app.post('/auth/register', json, async (req, res) => {
    const { name, password, key } = readCredentials(req);
    if (!NAME_RE.test(name)) return fail(res, 400, 'Kullanıcı adı 2-24 karakter olmalı; harf, rakam, boşluk, nokta, tire kullanılabilir.');
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) return fail(res, 400, PASSWORD_RULE);
    if (accounts.has(key)) return fail(res, 409, 'Bu kullanıcı adı alınmış. Senin hesabınsa "Giriş yap"ı seç.');
    const account = { name, passHash: await hashPassword(password), avatar: null, createdAt: Date.now(), lastSeen: 0 };
    if (accounts.has(key)) return fail(res, 409, 'Bu kullanıcı adı alınmış.');
    try {
      await store.insert('accounts', { id: key, name, pass_hash: account.passHash });
      accounts.set(key, account);
      res.json({ token: await newSession(key), ...me(account, key) });
    } catch (err) {
      console.warn('kayıt olma', err.message);
      fail(res, 500, 'Hesap açılamadı, biraz sonra tekrar dene.');
    }
  });

  app.post('/auth/login', json, async (req, res) => {
    const { password, key } = readCredentials(req);
    const release = logins.reserve(req.ip);
    if (!release) return fail(res, 429, 'Çok fazla yanlış deneme oldu; 10 dakika sonra tekrar dene.');
    const account = accounts.get(key);
    const hash = account?.passHash; // denetlenirken şifre değişirse eski şifre oturum kazandırmasın
    if (!account || !(await checkPassword(password, hash))) {
      return fail(res, 401, 'Kullanıcı adı ya da şifre yanlış.');
    }
    release();
    const stale = () => account.passHash !== hash;
    if (stale()) return fail(res, 401, 'Kullanıcı adı ya da şifre yanlış.');
    try {
      const token = await newSession(key);
      if (stale()) { // oturum yazılırken şifre değişti (değişim öteki oturumları kapattıktan sonra eklendi)
        dropSession(sha256(token));
        return fail(res, 401, 'Kullanıcı adı ya da şifre yanlış.');
      }
      res.json({ token, ...me(account, key) });
    } catch (err) {
      console.warn('giriş', err.message);
      fail(res, 500, 'Giriş yapılamadı, biraz sonra tekrar dene.');
    }
  });

  // Şifre değiştirme: yanlış mevcut şifre hem IP hem oturumla sayılır (hesapla sayılsaydı çalınan bir oturum
  // sahibini kilitleyebilirdi). Başarıda çağıran oturum dışındaki bütün oturumlar kapanır.
  app.post('/auth/password', json, async (req, res) => {
    const token = bearer(req);
    const a = accountByToken(token);
    if (!a) return fail(res, 401, 'Oturum kapanmış.');
    const ipKey = `ip:${req.ip}`;
    const sessionKey = `oturum:${sha256(token)}`;
    const releaseIp = passwordChanges.reserve(ipKey);
    const releaseKey = releaseIp && passwordChanges.reserve(sessionKey);
    if (!releaseKey) {
      releaseIp?.();
      return fail(res, 429, 'Çok fazla yanlış deneme oldu; 10 dakika sonra tekrar dene.');
    }
    const release = () => { releaseIp(); releaseKey(); };
    const current = String(req.body?.current || '');
    const password = String(req.body?.password || '');
    const account = accounts.get(a.key);
    if (!account) { release(); return fail(res, 401, 'Oturum kapanmış.'); }
    const before = account.passHash; // denetlenirken başka bir istek şifreyi değiştirebilir
    if (!(await checkPassword(current, before))) return fail(res, 403, 'Mevcut şifre yanlış.');
    release(); // mevcut şifre doğru: deneme hakkı harcanmaz
    if (account.passHash !== before || !accountByToken(token)) return fail(res, 401, 'Oturum kapanmış.');
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      return fail(res, 400, PASSWORD_RULE);
    }
    if (password === current) return fail(res, 400, 'Yeni şifre eskisiyle aynı olamaz.');
    const passHash = await hashPassword(password);
    const keep = sha256(token);
    try {
      await store.update('accounts', `id=${eq(a.key)}`, { pass_hash: passHash });
    } catch (err) {
      console.warn('şifre değiştirme', err.message);
      return fail(res, 500, 'Şifre değiştirilemedi, biraz sonra tekrar dene.');
    }
    account.passHash = passHash;
    for (const [hash, k] of sessions) if (k === a.key && hash !== keep) sessions.delete(hash);
    store.remove('sessions', `account_id=${eq(a.key)}&token_hash=neq.${encodeURIComponent(keep)}`)
      .catch((err) => console.warn('oturumları kapatma', err.message));
    onRevoke(a.key, { keepHash: keep });
    res.json({});
  });

  app.get('/auth/me', (req, res) => {
    const a = accountByToken(bearer(req));
    if (!a) return fail(res, 401, 'Oturum kapanmış.');
    seen(a.key);
    res.json(me(a, a.key));
  });

  // Üyeler: sadece yönetici görür. En yeni hesap en üstte.
  app.get('/admin/members', (req, res) => {
    const a = accountByToken(bearer(req));
    if (!a) return fail(res, 401, 'Oturum kapanmış.');
    if (!ADMINS.has(a.key)) return fail(res, 403, 'Bu sayfayı sadece yönetici görebilir.');
    const here = new Set(online());
    const devices = new Map();
    for (const key of sessions.values()) devices.set(key, (devices.get(key) || 0) + 1);
    const members = [...accounts].map(([key, m]) => ({
      name: m.name,
      admin: ADMINS.has(key),
      createdAt: m.createdAt,
      lastSeen: m.lastSeen,
      devices: devices.get(key) || 0,
      online: here.has(m.name),
    }));
    members.sort((x, y) => y.createdAt - x.createdAt);
    res.json({ members });
  });

  app.post('/auth/logout', (req, res) => {
    const hash = sha256(bearer(req));
    const key = sessions.get(hash);
    if (sessions.delete(hash)) {
      store.remove('sessions', `token_hash=${eq(hash)}`).catch((err) => console.warn('çıkış', err.message));
      onRevoke(key, { onlyHash: hash });
    }
    res.json({});
  });

  app.put('/auth/avatar', express.raw({ type: 'image/*', limit: AVATAR_MAX_BYTES }), async (req, res) => {
    const a = accountByToken(bearer(req));
    if (!a) return fail(res, 401, 'Oturum kapanmış.');
    const type = req.get('content-type');
    if (!Buffer.isBuffer(req.body) || !imageTypes[type]?.(req.body)) return fail(res, 400, 'Bu resim kullanılamadı.');
    const version = Date.now();
    try {
      if (!(await store.putFile(avatarPath(a.key), req.body, type))) throw new Error('yüklenemedi');
      await store.update('accounts', `id=${eq(a.key)}`, { avatar: version });
    } catch (err) {
      console.warn('profil resmi', err.message);
      return fail(res, 500, 'Resim kaydedilemedi, biraz sonra tekrar dene.');
    }
    avatarCache.set(a.key, { buf: req.body, type });
    accounts.get(a.key).avatar = version;
    onProfile(a.name, version);
    res.json({ avatar: version });
  });

  app.delete('/auth/avatar', async (req, res) => {
    const a = accountByToken(bearer(req));
    if (!a) return fail(res, 401, 'Oturum kapanmış.');
    try {
      await store.update('accounts', `id=${eq(a.key)}`, { avatar: null });
    } catch (err) {
      console.warn('profil resmi silme', err.message);
      return fail(res, 500, 'Resim kaldırılamadı, biraz sonra tekrar dene.');
    }
    store.deleteFile(avatarPath(a.key));
    avatarCache.delete(a.key);
    accounts.get(a.key).avatar = null;
    onProfile(a.name, null);
    res.json({});
  });

  // Sürüm adreste olduğu için uzun süre önbellekte kalabilir.
  app.get('/avatar/:name', async (req, res) => {
    const key = keyOf(req.params.name);
    if (!accounts.get(key)?.avatar) return res.status(404).end();
    if (!avatarCache.has(key)) {
      const file = await store.getFile(avatarPath(key));
      if (!file || !imageTypes[file.type]) return res.status(404).end();
      avatarCache.set(key, file);
    }
    const { buf, type } = avatarCache.get(key);
    res.set({ 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=31536000, immutable' });
    res.send(buf);
  });
}

const isAdmin = (key) => ADMINS.has(key);
// Anahtarla hesap: { key, name } ya da yoksa null (şifre özeti dışarı verilmez).
const byKey = (key) => (accounts.has(key) ? { key, name: accounts.get(key).name } : null);

module.exports = { setup, load, accountByToken, sha256, byKey, profiles, seen, isAdmin, hashPassword, checkPassword, keyOf, NAME_RE, attemptLimiter };
