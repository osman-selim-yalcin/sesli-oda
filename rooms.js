// Oda kayıtları: hangi odalar var, sahibi kim, şifreli mi, kim üye. Canlı oda durumu (kimler içeride,
// çalan video...) server.js'teki rooms haritasındadır; bu dosya kalıcı kaydı tutar.
// Supabase ayarlıysa rooms, room_requests ve room_members tablolarından okunur ve oraya yazılır.

const express = require('express');
const store = require('./store');
const accounts = require('./accounts');

const THEMES = ['varsayilan']; // Aşama 2 genişletir
const RESERVED = 'ortak';      // ortak kayıt anahtarı: oda adı ya da id'si olamaz
const PASSWORD_MIN = 4;
const PASSWORD_MAX = 200;
const DEFAULT_ROOM = { id: 'genel', name: 'genel', ownerId: 'osyalcin', passHash: null, theme: 'varsayilan', createdAt: 0, closedAt: null };

// Room = { id, name, ownerId, passHash|null, theme, createdAt, closedAt|null }
const registry = new Map(); // id -> Room (kapalılar da: id bir daha kullanılamaz)
const members = new Map();  // oda id -> Set<hesap anahtarı>
const requests = [];        // bekleyen oda istekleri (room_requests, status = pending)

const TR_ASCII = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u' };
const cleanName = (name) => String(name ?? '').trim().replace(/\s+/g, ' ');
const nameKey = (name) => cleanName(name).toLocaleLowerCase('tr-TR');
const time = (s) => (s ? Date.parse(s) : null);

const get = (id) => {
  const room = registry.get(id);
  return room && !room.closedAt ? room : undefined;
};
const all = () => [...registry.values()].filter((r) => !r.closedAt);

// Adresde kullanılacak kısa ad: "Film Gecesi" -> "film-gecesi"; doluysa "film-gecesi-2".
function slugOf(name) {
  const base = String(name ?? '')
    .toLocaleLowerCase('tr-TR')
    .replace(/[çğıöşü]/g, (c) => TR_ASCII[c])
    .normalize('NFD').replace(/\p{M}/gu, '') // é -> e
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'oda';
  const taken = (s) => s === RESERVED || registry.has(s);
  if (!taken(base)) return base;
  let n = 2;
  while (taken(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

async function load() {
  try {
    if (!store.enabled) return;
    const rows = await store.select('rooms', 'select=id,name,owner_id,pass_hash,theme,created_at,closed_at&order=created_at.asc');
    const reqs = await store.select('room_requests', 'select=id,account_id,name,pass_hash,theme,note,created_at&status=eq.pending&order=created_at.asc');
    const mem = await store.select('room_members', 'select=room_id,account_id');
    for (const r of rows) {
      registry.set(r.id, {
        id: r.id, name: r.name, ownerId: r.owner_id, passHash: r.pass_hash || null,
        theme: r.theme, createdAt: time(r.created_at), closedAt: time(r.closed_at),
      });
    }
    for (const q of reqs) {
      requests.push({ id: q.id, accountId: q.account_id, name: q.name, passHash: q.pass_hash || null, theme: q.theme, note: q.note, createdAt: time(q.created_at) });
    }
    for (const m of mem) {
      if (!members.has(m.room_id)) members.set(m.room_id, new Set());
      members.get(m.room_id).add(m.account_id);
    }
    console.log(`Odalar: ${registry.size} oda, ${requests.length} bekleyen istek yüklendi.`);
  } finally {
    // Tablo boşsa (ya da okunamadıysa) genel odası yalnız hafızada açılır; veritabanına canlıya geçiş SQL'i ekler.
    if (!registry.size) registry.set(DEFAULT_ROOM.id, { ...DEFAULT_ROOM, createdAt: Date.now() });
  }
}

// Doğrulama hatası fırlatılmaz, { error } döner. Kayıt hatası fırlatılır.
async function create({ name, ownerId, password, theme = 'varsayilan' }) {
  name = cleanName(name);
  if (!accounts.NAME_RE.test(name)) return { error: 'Oda adı 2-24 karakter olmalı; harf, rakam, boşluk, nokta, tire kullanılabilir.' };
  if (nameKey(name) === RESERVED) return { error: 'Bu ad oda adı olarak kullanılamaz.' };
  const taken = () => all().some((r) => nameKey(r.name) === nameKey(name));
  if (taken()) return { error: 'Bu adda bir oda zaten var.' };
  password = password == null ? '' : String(password);
  if (password && (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX)) {
    return { error: `Oda şifresi en az ${PASSWORD_MIN}, en çok ${PASSWORD_MAX} karakter olmalı.` };
  }
  if (!THEMES.includes(theme)) return { error: 'Bu tema yok.' };
  if (typeof ownerId !== 'string' || !ownerId) return { error: 'Oda sahibi belli değil.' };
  const passHash = password ? await accounts.hashPassword(password) : null;
  if (taken()) return { error: 'Bu adda bir oda zaten var.' }; // özet hesaplanırken aynı ad açılmış olabilir
  const room = { id: slugOf(name), name, ownerId, passHash, theme, createdAt: Date.now(), closedAt: null };
  registry.set(room.id, room); // await sırasında aynı id başkasına verilmesin
  try {
    await store.insert('rooms', {
      id: room.id, name, owner_id: ownerId, pass_hash: passHash, theme, created_at: new Date(room.createdAt).toISOString(),
    });
  } catch (err) {
    registry.delete(room.id);
    throw err;
  }
  return room;
}

function role(room, account) {
  if (!room || !account?.key) return 'none';
  if (accounts.isAdmin(account.key)) return 'admin';
  if (room.ownerId === account.key) return 'owner';
  if (!room.passHash || members.get(room.id)?.has(account.key)) return 'member';
  return 'none';
}

let live = () => ({ users: [], max: 0, mergedWith: null });
let onChange = () => {};

function view(room, account) {
  const { users, max, mergedWith } = live(room.id);
  return {
    id: room.id,
    name: room.name,
    owner: accounts.byKey(room.ownerId)?.name || room.ownerId,
    locked: Boolean(room.passHash),
    theme: room.theme,
    users,
    max,
    mergedWith,
    role: role(room, account),
  };
}

const bearer = (req) => req.get('authorization')?.replace(/^Bearer /, '') || '';

// live(oda id) -> { users, max, mergedWith }: canlı durum sunucudan gelir.
// onChange(tür, bilgi): kayıtlar değişince ('rooms' | 'request' | 'settings' | 'closed').
function setup(app, opts) {
  live = opts.live;
  if (opts.onChange) onChange = opts.onChange;
  const json = express.json({ limit: '4kb' });
  const fail = (res, status, error) => res.status(status).json({ error });

  app.get('/rooms', (req, res) => {
    const a = accounts.accountByToken(bearer(req));
    if (!a) return fail(res, 401, 'Oturum kapanmış.');
    res.json({ rooms: all().map((r) => view(r, a)) });
  });

  app.post('/rooms', json, async (req, res) => {
    const a = accounts.accountByToken(bearer(req));
    if (!a) return fail(res, 401, 'Oturum kapanmış.');
    if (!accounts.isAdmin(a.key)) return fail(res, 403, 'Oda açmayı sadece yönetici yapabilir; oda isteği gönderebilirsin.');
    const body = req.body || {};
    let ownerId = a.key;
    if (body.owner != null && body.owner !== '') {
      const owner = accounts.byKey(accounts.keyOf(cleanName(body.owner)));
      if (!owner) return fail(res, 400, 'Bu adda bir hesap yok.');
      ownerId = owner.key;
    }
    try {
      const room = await create({ name: body.name, ownerId, password: body.password, theme: body.theme ?? undefined });
      if (room.error) return fail(res, 400, room.error);
      onChange('rooms', { id: room.id });
      res.json({ room: view(room, a) });
    } catch (err) {
      console.warn('oda açma', err.message);
      fail(res, 500, 'Oda açılamadı, biraz sonra tekrar dene.');
    }
  });
}

module.exports = { load, get, all, slugOf, create, role, view, setup, THEMES };
