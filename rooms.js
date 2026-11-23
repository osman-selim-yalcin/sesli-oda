// Oda kayıtları: hangi odalar var, sahibi kim, şifreli mi, kim üye. Canlı oda durumu (kimler içeride,
// çalan video...) server.js'teki rooms haritasındadır; bu dosya kalıcı kaydı tutar.
// Supabase ayarlıysa rooms, room_requests ve room_members tablolarından okunur ve oraya yazılır.

const express = require('express');
const store = require('./store');
const accounts = require('./accounts');

const THEMES = ['gece', 'aydinlik']; // Gece Odası (varsayılan), Aydınlık Oda; yeni temalar buraya ve public/theme.js listesine
// İstemcinin kendi tablosunda olmayan temaların adı, önizleme renkleri ve ikon seti (GET /theme-list ile gider).
// Gerçek temalar public/theme.js'te tanımlıdır, burası boş kalır; yalnız test önyüklemesi (test/preload.js)
// denemelik temasını buraya ve THEMES'e ekler.
const THEME_INFO = {};
const RESERVED = 'ortak';      // ortak kayıt anahtarı: oda adı ya da id'si olamaz
const PASSWORD_MIN = 4;
const PASSWORD_MAX = 200;
const DEFAULT_ROOM = { id: 'genel', name: 'genel', ownerId: 'osyalcin', passHash: null, theme: 'gece', createdAt: 0, closedAt: null };

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

// Döner: kayıt açıksa rooms tablosundaki oda id'leri (startupProblem için), kapalıysa undefined.
async function load() {
  try {
    if (!store.enabled) return undefined;
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
    return rows.map((r) => r.id);
  } finally {
    // genel yoksa (Supabase kapalı, tablo boş ya da okunamadı) hafızada açılır; canlıya geçiş SQL'i
    // (db/2026-11-22-golive.sql) onu veritabanına da ekler.
    if (!registry.has('genel')) registry.set(DEFAULT_ROOM.id, { ...DEFAULT_ROOM, createdAt: Date.now() });
  }
}

// Canlıya alma koruması: kayıt açıkken sunucu bu durumlarda açılmamalı (kayıtlar sessizce kaybolur).
// roomIds: rooms tablosundaki id'ler; stateRows: room_state satırları ({ room, kind }).
// Açılmaması gerekiyorsa nedeni (Türkçe), yoksa null döner.
const SHARED_KINDS = ['dinoboard', 'memoryboard', 'klotskiboard', 'timingboard', 'daktiloboard', 'hedefboard', 'oneriler'];
function startupProblem({ roomIds = [], stateRows = [] }) {
  if (!roomIds.includes(DEFAULT_ROOM.id)) {
    return 'rooms tablosunda genel odası yok: db/2026-11-22-golive.sql çalıştırılmamış.';
  }
  const kinds = (room) => stateRows.some((r) => r.room === room && SHARED_KINDS.includes(r.kind));
  if (kinds(DEFAULT_ROOM.id) && !kinds(RESERVED)) {
    return `room_state'te genel odasının skor tabloları ya da önerileri var ama ${RESERVED} satırı yok: db/2026-11-22-golive.sql çalıştırılmamış.`;
  }
  return null;
}

// Ad, şifre ve tema doğrulaması (create ve oda isteği ortak kullanır). Hata { error } döner.
// pendingName: bekleyen başka bir istek de aynı adı tutamaz. self: adı değişen oda (kendi adıyla çakışmaz).
function checkName(name, { pendingName = false, self = null } = {}) {
  name = cleanName(name);
  if (!accounts.NAME_RE.test(name)) return { error: 'Oda adı 2-24 karakter olmalı; harf, rakam, boşluk, nokta, tire kullanılabilir.' };
  if (nameKey(name) === RESERVED) return { error: 'Bu ad oda adı olarak kullanılamaz.' };
  if (all().some((r) => r !== self && nameKey(r.name) === nameKey(name))) return { error: 'Bu adda bir oda zaten var.' };
  if (pendingName && requests.some((q) => nameKey(q.name) === nameKey(name))) return { error: 'Bu adda bir oda isteği zaten bekliyor.' };
  return { name };
}
function checkPassword(password) {
  if (password != null && typeof password !== 'string') return { error: 'Oda şifresi geçersiz.' };
  password = password || '';
  if (password && (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX)) {
    return { error: `Oda şifresi en az ${PASSWORD_MIN}, en çok ${PASSWORD_MAX} karakter olmalı.` };
  }
  return { password };
}
const checkTheme = (theme) => (THEMES.includes(theme) ? { theme } : { error: 'Bu tema yok.' });

function check({ name, password, theme = 'gece' }, opts = {}) {
  const v = checkName(name, opts);
  if (v.error) return v;
  const p = checkPassword(password);
  if (p.error) return p;
  const t = checkTheme(theme);
  if (t.error) return t;
  return { name: v.name, password: p.password, theme };
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

const isMember = (roomId, key) => Boolean(members.get(roomId)?.has(key));
const memberGen = new Map(); // oda id -> üyelikler her silindiğinde artan sayaç
const genOf = (roomId) => memberGen.get(roomId) || 0;
const memberFilter = (roomId, key) => `room_id=eq.${encodeURIComponent(roomId)}&account_id=eq.${encodeURIComponent(key)}`;

// Şifreyi bir kez doğru yazan hesap odanın üyesi olur; bir daha şifre sorulmaz.
// Hafızaya hemen eklenir; kayıt hatası fırlatılır (aynı satır zaten varsa hata sayılmaz).
// Yabancı anahtar hatasında (oda ya da hesap tabloda yok) uyarı yazılır, üyelik geri alınır; false döner.
// Kayıt sürerken üyelikler silindiyse (şifre değişti) yazılan satır geri silinir; false döner.
async function addMember(roomId, key) {
  if (isMember(roomId, key)) return true;
  const gen = genOf(roomId);
  if (!members.has(roomId)) members.set(roomId, new Set());
  members.get(roomId).add(key);
  try {
    await store.insert('room_members', { room_id: roomId, account_id: key, joined_at: new Date().toISOString() });
  } catch (err) {
    if (!/ 409 /.test(err.message)) throw err;
    if (/23503/.test(err.message)) {
      console.warn(`oda üyeliği yazılamadı (oda ${roomId} ya da hesap tabloda yok)`);
      members.get(roomId)?.delete(key);
      return false;
    }
    // birincil anahtar çakışması: üyelik zaten kayıtlı
  }
  if (genOf(roomId) === gen) return true;
  members.get(roomId)?.delete(key);
  await store.remove('room_members', memberFilter(roomId, key));
  return false;
}

// Şifre değişince ya da kalkınca eski üyelikler geçersiz: hafızadan ve tablodan silinir.
// Tablo silinemezse hata fırlatılır (hafıza olduğu gibi kalır).
async function clearMembers(roomId) {
  memberGen.set(roomId, genOf(roomId) + 1); // kaydı süren addMember'lar kendi satırını geri siler
  await store.remove('room_members', `room_id=eq.${encodeURIComponent(roomId)}`);
  members.delete(roomId);
}

function role(room, account) {
  if (!room || !account?.key) return 'none';
  if (accounts.isAdmin(account.key)) return 'admin';
  if (room.ownerId === account.key) return 'owner';
  if (!room.passHash || isMember(room.id, account.key)) return 'member';
  return 'none';
}

// Kayıt sürerken istek id'siz durur (aynı ad ya da ikinci istek geçmesin diye listede); id'siz istek
// listede, mine'da, kararda ve bekleyen sayısında görünmez.
const ready = () => requests.filter((q) => q.id != null);
const pendingCount = () => ready().length; // yöneticinin listesindeki bekleyen istek sayısı

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
// 'request' bilgisi { pending, decided? }: decided = { key, status, name } (karar verildiyse isteyen hesap).
function setup(app, opts) {
  live = opts.live;
  if (opts.onChange) onChange = opts.onChange;
  const json = express.json({ limit: '4kb' });
  const fail = (res, status, error) => res.status(status).json({ error });

  // Seçilebilir temalar (oturum gerekmez; giriş ekranı da yükler).
  app.get('/theme-list', (req, res) => {
    res.json({ themes: THEMES.map((id) => ({ id, ...THEME_INFO[id] })) });
  });

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

  // Hangi alanı kim değiştirebilir (spec bölüm 5). Yetkisiz alan içeren istek tümüyle reddedilir.
  const SETTINGS = { theme: ['owner', 'admin'], password: ['owner', 'admin'], name: ['admin'], owner: ['admin'] };

  app.patch('/rooms/:id', json, async (req, res) => {
    const a = accounts.accountByToken(bearer(req));
    if (!a) return fail(res, 401, 'Oturum kapanmış.');
    const room = get(req.params.id);
    if (!room) return fail(res, 404, 'Böyle bir oda yok.');
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const fields = Object.keys(SETTINGS).filter((f) => body[f] !== undefined);
    if (!fields.length) return fail(res, 400, 'Değişecek bir ayar yok.');
    const r = role(room, a);
    if (fields.some((f) => !SETTINGS[f].includes(r))) {
      return fail(res, 403, r === 'owner' ? 'Odanın adını ve sahibini sadece yönetici değiştirebilir.' : 'Bu odanın ayarlarını değiştiremezsin.');
    }
    // Önce hepsi doğrulanır, sonra hepsi birden uygulanır.
    const next = {};
    if ('theme' in body) {
      const t = checkTheme(body.theme);
      if (t.error) return fail(res, 400, t.error);
      next.theme = t.theme;
    }
    if ('name' in body) {
      if (typeof body.name !== 'string') return fail(res, 400, 'Oda adı geçersiz.');
      const v = checkName(body.name, { self: room });
      if (v.error) return fail(res, 400, v.error);
      next.name = v.name;
    }
    if ('owner' in body) {
      const owner = typeof body.owner === 'string' && accounts.byKey(accounts.keyOf(cleanName(body.owner)));
      if (!owner) return fail(res, 400, 'Bu adda bir hesap yok.');
      next.ownerId = owner.key;
    }
    const passChange = 'password' in body;
    if (passChange && body.password !== null) {
      if (typeof body.password !== 'string' || !body.password) return fail(res, 400, 'Oda şifresi geçersiz.');
      const p = checkPassword(body.password);
      if (p.error) return fail(res, 400, p.error);
    }
    try {
      if (passChange) next.passHash = body.password === null ? null : await accounts.hashPassword(body.password); // düz şifre saklanmaz
      if (!get(room.id)) return fail(res, 404, 'Böyle bir oda yok.'); // özet hesaplanırken kapanmış olabilir
      if (next.name && checkName(next.name, { self: room }).error) return fail(res, 400, 'Bu adda bir oda zaten var.');
      const old = Object.fromEntries(Object.keys(next).map((k) => [k, room[k]]));
      Object.assign(room, next); // await sırasında aynı ad başka odaya verilmesin
      try {
        if (passChange) await clearMembers(room.id);
        const row = {};
        if ('theme' in next) row.theme = next.theme;
        if ('name' in next) row.name = next.name;
        if ('ownerId' in next) row.owner_id = next.ownerId;
        if (passChange) row.pass_hash = next.passHash;
        await store.update('rooms', `id=eq.${encodeURIComponent(room.id)}`, row);
      } catch (err) {
        // Yalnız bu isteğin değiştirdiği alanlar, araya başka değişiklik girmediyse geri alınır (closedAt hiç).
        for (const [k, v] of Object.entries(old)) if (room[k] === next[k]) room[k] = v;
        throw err;
      }
      if ('theme' in next) onChange('settings', { id: room.id, theme: room.theme });
      onChange('rooms', { id: room.id });
      res.json({ room: view(room, a) });
    } catch (err) {
      console.warn('oda ayarı', err.message);
      fail(res, 500, 'Ayar kaydedilemedi, biraz sonra tekrar dene.');
    }
  });

  app.delete('/rooms/:id', async (req, res) => {
    const a = accounts.accountByToken(bearer(req));
    if (!a) return fail(res, 401, 'Oturum kapanmış.');
    if (!accounts.isAdmin(a.key)) return fail(res, 403, 'Odayı sadece yönetici kapatabilir.');
    const room = get(req.params.id);
    if (!room) return fail(res, 404, 'Böyle bir oda yok.');
    if (room.id === DEFAULT_ROOM.id) return fail(res, 400, 'genel odası kapatılamaz.');
    room.closedAt = Date.now(); // await sırasında kimse giremesin
    try {
      await store.update('rooms', `id=eq.${encodeURIComponent(room.id)}`, { closed_at: new Date(room.closedAt).toISOString() });
    } catch (err) {
      room.closedAt = null;
      console.warn('oda kapatma', err.message);
      return fail(res, 500, 'Oda kapatılamadı, biraz sonra tekrar dene.');
    }
    // Odanın kayıtları (geçmiş, efektler, tier listler, kelimeler) silinmez; id bir daha kullanılmaz.
    onChange('closed', { id: room.id, name: room.name });
    onChange('rooms', { id: room.id });
    res.json({});
  });

  const admin = (req, res) => {
    const a = accounts.accountByToken(bearer(req));
    if (!a) fail(res, 401, 'Oturum kapanmış.');
    else if (!accounts.isAdmin(a.key)) fail(res, 403, 'Bu işlem sadece yönetici içindir.');
    else return a;
    return null;
  };
  // Hesabın işlenmekte olan isteği (şifre hashlenirken): eşzamanlı istekler her biri scrypt çalıştırmasın.
  const asking = new Set();
  app.post('/rooms/requests', json, async (req, res) => {
    const a = accounts.accountByToken(bearer(req));
    if (!a) return fail(res, 401, 'Oturum kapanmış.');
    if (accounts.isAdmin(a.key)) return fail(res, 400, 'Yönetici oda isteği göndermez; doğrudan oda açabilir.');
    const body = req.body || {};
    const has = () => requests.some((q) => q.accountId === a.key);
    if (has() || asking.has(a.key)) return fail(res, 409, 'Bekleyen bir oda isteğin var.');
    const v = check({ name: body.name, password: body.password, theme: body.theme ?? undefined }, { pendingName: true });
    if (v.error) return fail(res, 400, v.error);
    if (body.note != null && typeof body.note !== 'string') return fail(res, 400, 'Not geçersiz.');
    const note = (body.note || '').trim();
    if (note.length > NOTE_MAX) return fail(res, 400, `Not en çok ${NOTE_MAX} karakter olmalı.`);
    asking.add(a.key);
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
        if (!row && store.enabled) throw new Error('room_requests ekleme satır döndürmedi'); // hafıza sayacı veritabanı id'leriyle çakışır
        q.id = row ? row.id : ++memId;
      } catch (err) {
        const at = requests.indexOf(q);
        if (at >= 0) requests.splice(at, 1);
        throw err;
      }
      onChange('request', { pending: pendingCount() });
      res.json({ request: { id: q.id, name: q.name, status: 'pending' } });
    } catch (err) {
      console.warn('oda isteği', err.message);
      fail(res, 500, 'İstek gönderilemedi, biraz sonra tekrar dene.');
    } finally {
      asking.delete(a.key);
    }
  });

  app.get('/rooms/requests/mine', (req, res) => {
    const a = accounts.accountByToken(bearer(req));
    if (!a) return fail(res, 401, 'Oturum kapanmış.');
    const q = ready().find((r) => r.accountId === a.key);
    if (q) return res.json({ request: { id: q.id, name: q.name, status: 'pending', decidedAt: null } });
    res.json({ request: latest.get(a.key) || null });
  });

  app.get('/admin/room-requests', (req, res) => {
    if (!admin(req, res)) return;
    res.json({
      requests: ready().map((q) => ({
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
    const at = requests.findIndex((q) => q.id != null && String(q.id) === req.params.id);
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
      // decided: isteyen hesaba sonucu anında bildirmek için (anahtar yalnız sunucuda kalır)
      onChange('request', { pending: pendingCount(), decided: { key: q.accountId, status: approve ? 'approved' : 'rejected', name: q.name } });
      res.json(room ? { room: view(room, a) } : {});
    } catch (err) {
      restore();
      console.warn('oda isteği kararı', err.message);
      fail(res, 500, 'Karar kaydedilemedi, biraz sonra tekrar dene.');
    }
  });
}

module.exports = { load, startupProblem, get, all, slugOf, create, role, view, setup, addMember, isMember, pendingCount, THEMES, THEME_INFO };
