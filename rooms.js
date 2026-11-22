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
const latest = new Map();   // hesap anahtarı -> en son karara bağlanmış istek { id, name, status, decidedAt }
const NOTE_MAX = 200;
let memId = 0;              // Supabase kapalıyken istek id'leri hafızada üretilir

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
    const decided = await store.select('room_requests', 'select=id,account_id,name,status,decided_at&status=neq.pending&order=created_at.asc');
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
    for (const q of decided) latest.set(q.account_id, { id: q.id, name: q.name, status: q.status, decidedAt: time(q.decided_at) });
    for (const m of mem) {
      if (!members.has(m.room_id)) members.set(m.room_id, new Set());
      members.get(m.room_id).add(m.account_id);
    }
    console.log(`Odalar: ${registry.size} oda, ${requests.length} bekleyen istek yüklendi.`);
  } finally {
    // genel yoksa (Supabase kapalı, tablo boş ya da okunamadı) hafızada açılır; canlıya geçiş SQL'i
    // (db/2026-11-22-golive.sql) onu veritabanına da ekler.
    if (!registry.has('genel')) registry.set(DEFAULT_ROOM.id, { ...DEFAULT_ROOM, createdAt: Date.now() });
  }
}

// Ad, şifre ve tema doğrulaması (create ve oda isteği ortak kullanır). Hata { error } döner.
// pendingName: bekleyen başka bir istek de aynı adı tutamaz.
function check({ name, password, theme = 'varsayilan' }, { pendingName = false } = {}) {
  name = cleanName(name);
  if (!accounts.NAME_RE.test(name)) return { error: 'Oda adı 2-24 karakter olmalı; harf, rakam, boşluk, nokta, tire kullanılabilir.' };
  if (nameKey(name) === RESERVED) return { error: 'Bu ad oda adı olarak kullanılamaz.' };
  if (all().some((r) => nameKey(r.name) === nameKey(name))) return { error: 'Bu adda bir oda zaten var.' };
  if (pendingName && requests.some((q) => nameKey(q.name) === nameKey(name))) return { error: 'Bu adda bir oda isteği zaten bekliyor.' };
  if (password != null && typeof password !== 'string') return { error: 'Oda şifresi geçersiz.' };
  password = password || '';
  if (password && (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX)) {
    return { error: `Oda şifresi en az ${PASSWORD_MIN}, en çok ${PASSWORD_MAX} karakter olmalı.` };
  }
  if (!THEMES.includes(theme)) return { error: 'Bu tema yok.' };
  return { name, password, theme };
}

// Doğrulama hatası fırlatılmaz, { error } döner. Kayıt hatası fırlatılır.
// passHash verilirse (onaylanan istek) şifre yeniden hashlenmez.
async function create({ name, ownerId, password, passHash: ready, theme }) {
  const v = check({ name, password: ready ? undefined : password, theme });
  if (v.error) return v;
  name = v.name;
  theme = v.theme;
  if (typeof ownerId !== 'string' || !ownerId) return { error: 'Oda sahibi belli değil.' };
  const passHash = ready || (v.password ? await accounts.hashPassword(v.password) : null);
  if (all().some((r) => nameKey(r.name) === nameKey(name))) return { error: 'Bu adda bir oda zaten var.' }; // özet hesaplanırken aynı ad açılmış olabilir
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

  const admin = (req, res) => {
    const a = accounts.accountByToken(bearer(req));
    if (!a) fail(res, 401, 'Oturum kapanmış.');
    else if (!accounts.isAdmin(a.key)) fail(res, 403, 'Bu işlem sadece yönetici içindir.');
    else return a;
    return null;
  };
  const pendingCount = () => ({ pending: requests.length });

  app.post('/rooms/requests', json, async (req, res) => {
    const a = accounts.accountByToken(bearer(req));
    if (!a) return fail(res, 401, 'Oturum kapanmış.');
    if (accounts.isAdmin(a.key)) return fail(res, 400, 'Yönetici oda isteği göndermez; doğrudan oda açabilir.');
    const body = req.body || {};
    const has = () => requests.some((q) => q.accountId === a.key);
    if (has()) return fail(res, 409, 'Bekleyen bir oda isteğin var.');
    const v = check({ name: body.name, password: body.password, theme: body.theme ?? undefined }, { pendingName: true });
    if (v.error) return fail(res, 400, v.error);
    if (body.note != null && typeof body.note !== 'string') return fail(res, 400, 'Not geçersiz.');
    const note = (body.note || '').trim();
    if (note.length > NOTE_MAX) return fail(res, 400, `Not en çok ${NOTE_MAX} karakter olmalı.`);
    try {
      const passHash = v.password ? await accounts.hashPassword(v.password) : null; // düz şifre saklanmaz
      if (has()) return fail(res, 409, 'Bekleyen bir oda isteğin var.'); // hash sürerken ikinci istek gelmiş olabilir
      if (check({ name: v.name }, { pendingName: true }).error) return fail(res, 400, 'Bu adda bir oda ya da istek zaten var.');
      const q = { id: null, accountId: a.key, name: v.name, passHash, theme: v.theme, note, createdAt: Date.now() };
      requests.push(q); // await sırasında ikinci istek ya da aynı ad geçmesin
      try {
        const row = await store.insertReturning('room_requests', {
          account_id: a.key, name: q.name, pass_hash: passHash, theme: q.theme, note, created_at: new Date(q.createdAt).toISOString(),
        });
        q.id = row ? row.id : ++memId;
      } catch (err) {
        requests.splice(requests.indexOf(q), 1);
        throw err;
      }
      onChange('request', pendingCount());
      res.json({ request: { id: q.id, name: q.name, status: 'pending' } });
    } catch (err) {
      console.warn('oda isteği', err.message);
      fail(res, 500, 'İstek gönderilemedi, biraz sonra tekrar dene.');
    }
  });

  app.get('/rooms/requests/mine', (req, res) => {
    const a = accounts.accountByToken(bearer(req));
    if (!a) return fail(res, 401, 'Oturum kapanmış.');
    const q = requests.find((r) => r.accountId === a.key);
    if (q) return res.json({ request: { id: q.id, name: q.name, status: 'pending', decidedAt: null } });
    res.json({ request: latest.get(a.key) || null });
  });

  app.get('/admin/room-requests', (req, res) => {
    if (!admin(req, res)) return;
    res.json({
      requests: requests.map((q) => ({
        id: q.id, by: accounts.byKey(q.accountId)?.name || q.accountId, name: q.name,
        locked: Boolean(q.passHash), theme: q.theme, note: q.note, createdAt: q.createdAt,
      })),
    });
  });

  app.post('/admin/room-requests/:id', json, async (req, res) => {
    const a = admin(req, res);
    if (!a) return;
    const approve = req.body?.approve;
    if (typeof approve !== 'boolean') return fail(res, 400, 'approve true ya da false olmalı.');
    const at = requests.findIndex((q) => String(q.id) === req.params.id);
    if (at < 0) return fail(res, 409, 'Bu istek zaten karara bağlanmış ya da yok.');
    const [q] = requests.splice(at, 1); // karar sürerken ikinci karar aynı isteği bulamasın
    const restore = () => requests.splice(Math.min(at, requests.length), 0, q);
    try {
      let room = null;
      if (approve) {
        room = await create({ name: q.name, ownerId: q.accountId, passHash: q.passHash, theme: q.theme });
        if (room.error) { restore(); return fail(res, 409, room.error); } // istek beklemede kalır
      }
      const decidedAt = Date.now();
      latest.set(q.accountId, { id: q.id, name: q.name, status: approve ? 'approved' : 'rejected', decidedAt });
      try {
        await store.update('room_requests', `id=eq.${q.id}`, { status: approve ? 'approved' : 'rejected', decided_at: new Date(decidedAt).toISOString() });
      } catch (err) {
        console.warn('oda isteği kararı yazılamadı', err.message); // oda açıldı; kayıt bir sonraki açılışta beklemede görünebilir
      }
      if (room) onChange('rooms', { id: room.id });
      onChange('request', pendingCount());
      res.json(room ? { room: view(room, a) } : {});
    } catch (err) {
      restore();
      console.warn('oda isteği kararı', err.message);
      fail(res, 500, 'Karar kaydedilemedi, biraz sonra tekrar dene.');
    }
  });
}

module.exports = { load, get, all, slugOf, create, role, view, setup, THEMES };
