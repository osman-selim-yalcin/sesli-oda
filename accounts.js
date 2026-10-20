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

const accounts = new Map(); // anahtar (küçük harfli ad) -> { name, passHash, avatar }
const sessions = new Map(); // oturum özeti -> anahtar
const avatarCache = new Map(); // anahtar -> { buf, type }
const loginFails = new Map(); // ip -> { count, since }

const keyOf = (name) => name.toLocaleLowerCase('tr-TR');
const dbId = (key) => store.ns + key;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const avatarPath = (key) => `avatars/${sha256(dbId(key)).slice(0, 32)}`;
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
  const own = store.ns ? `like.${encodeURIComponent(store.ns)}*` : 'not.like.dev:*';
  const rows = await store.select('accounts', `select=id,name,pass_hash,avatar&id=${own}`);
  for (const r of rows) accounts.set(r.id.slice(store.ns.length), { name: r.name, passHash: r.pass_hash, avatar: r.avatar });
  const sess = await store.select('sessions', `select=token_hash,account_id&account_id=${own}`);
  for (const s of sess) sessions.set(s.token_hash, s.account_id.slice(store.ns.length));
  console.log(`Hesaplar: ${accounts.size} hesap, ${sessions.size} oturum yüklendi.`);
}

async function newSession(key) {
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = sha256(token);
  await store.insert('sessions', { token_hash: hash, account_id: dbId(key) });
  sessions.set(hash, key);
  return token;
}

const bearer = (req) => req.get('authorization')?.replace(/^Bearer /, '') || '';
const me = (a) => ({ name: a.name, avatar: a.avatar });

// onProfile(ad, sürüm): profil resmi değişince odadakilere haber vermek için.
function setup(app, { imageTypes, onProfile }) {
  app.set('trust proxy', 1); // Render'ın vekil sunucusu: req.ip gerçek adres olsun
  const json = express.json({ limit: '4kb' });
  const fail = (res, status, error) => res.status(status).json({ error });

  // Şifre deneme sınırı: aynı yerden çok yanlış giriş olursa bir süre beklenir.
  const blocked = (ip) => {
    const f = loginFails.get(ip);
    if (f && Date.now() - f.since > LOGIN_FAIL_WINDOW) loginFails.delete(ip);
    return (loginFails.get(ip)?.count || 0) >= LOGIN_FAIL_MAX;
  };
  const addFail = (ip) => {
    const f = loginFails.get(ip) || { count: 0, since: Date.now() };
    f.count++;
    loginFails.set(ip, f);
  };

  const readCredentials = (req) => {
    const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ');
    const password = String(req.body?.password || '');
    return { name, password, key: keyOf(name) };
  };

  app.post('/auth/register', json, async (req, res) => {
    const { name, password, key } = readCredentials(req);
    if (!NAME_RE.test(name)) return fail(res, 400, 'Kullanıcı adı 2-24 karakter olmalı; harf, rakam, boşluk, nokta, tire kullanılabilir.');
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) return fail(res, 400, `Şifre en az ${PASSWORD_MIN} karakter olmalı.`);
    if (accounts.has(key)) return fail(res, 409, 'Bu kullanıcı adı alınmış. Senin hesabınsa "Giriş yap"ı seç.');
    const account = { name, passHash: await hashPassword(password), avatar: null };
    if (accounts.has(key)) return fail(res, 409, 'Bu kullanıcı adı alınmış.');
    try {
      await store.insert('accounts', { id: dbId(key), name, pass_hash: account.passHash });
      accounts.set(key, account);
      res.json({ token: await newSession(key), ...me(account) });
    } catch (err) {
      console.warn('kayıt olma', err.message);
      fail(res, 500, 'Hesap açılamadı, biraz sonra tekrar dene.');
    }
  });

  app.post('/auth/login', json, async (req, res) => {
    const { password, key } = readCredentials(req);
    if (blocked(req.ip)) return fail(res, 429, 'Çok fazla yanlış deneme oldu; 10 dakika sonra tekrar dene.');
    const account = accounts.get(key);
    if (!account || !(await checkPassword(password, account.passHash))) {
      addFail(req.ip);
      return fail(res, 401, 'Kullanıcı adı ya da şifre yanlış.');
    }
    try {
      res.json({ token: await newSession(key), ...me(account) });
    } catch (err) {
      console.warn('giriş', err.message);
      fail(res, 500, 'Giriş yapılamadı, biraz sonra tekrar dene.');
    }
  });

  app.get('/auth/me', (req, res) => {
    const a = accountByToken(bearer(req));
    if (!a) return fail(res, 401, 'Oturum kapanmış.');
    res.json(me(a));
  });

  app.post('/auth/logout', (req, res) => {
    const hash = sha256(bearer(req));
    if (sessions.delete(hash)) store.remove('sessions', `token_hash=${eq(hash)}`).catch((err) => console.warn('çıkış', err.message));
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
      await store.update('accounts', `id=${eq(dbId(a.key))}`, { avatar: version });
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
      await store.update('accounts', `id=${eq(dbId(a.key))}`, { avatar: null });
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

module.exports = { setup, load, accountByToken, profiles };
