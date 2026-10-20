// Kalıcı depolama (Supabase). Oda başına durum (önceden çalanlar, özel efektler, tier listler)
// room_state tablosunda JSON olarak; efekt sesleri ve kart resimleri "media" bölmesinde durur.
// SUPABASE_URL ve SUPABASE_SECRET_KEY yoksa hiçbir şey kaydedilmez, her şey hafızada kalır.

const BASE = process.env.SUPABASE_URL?.replace(/\/$/, '');
const KEY = process.env.SUPABASE_SECRET_KEY;
const BUCKET = 'media';
const SAVE_DELAY = 1500;  // ms; art arda gelen değişiklikler tek yazmada birleşir
const RETRY_DELAY = 10000; // ms

const headers = () => ({ apikey: KEY, Authorization: `Bearer ${KEY}` });
const timeout = () => AbortSignal.timeout(10000);

const store = {
  // Açılışta okuma başarısız olursa yazma da kapatılır; yoksa boş hafıza eski kayıtların üstüne yazılır.
  enabled: Boolean(BASE && KEY),
};

async function check(res, what) {
  if (!res.ok) throw new Error(`${what} ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}

// [{ room, kind, data }]
store.loadAll = async () => {
  const res = await fetch(`${BASE}/rest/v1/room_state?select=room,kind,data`, { headers: headers(), signal: timeout() });
  return (await check(res, 'okuma')).json();
};

async function upsert(room, kind, data) {
  const res = await fetch(`${BASE}/rest/v1/room_state`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ room, kind, data, updated_at: new Date().toISOString() }),
    signal: timeout(),
  });
  await check(res, 'yazma');
}

// Hesap ve oturum tabloları için: hata olursa fırlatır, çağıran karar verir.
// filter PostgREST biçiminde, ör. "id=eq.osman".

store.select = async (table, filter) => {
  const res = await fetch(`${BASE}/rest/v1/${table}?${filter}`, { headers: headers(), signal: timeout() });
  return (await check(res, `${table} okuma`)).json();
};

store.insert = async (table, row) => {
  if (!store.enabled) return;
  const res = await fetch(`${BASE}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(row),
    signal: timeout(),
  });
  await check(res, `${table} ekleme`);
};

store.update = async (table, filter, patch) => {
  if (!store.enabled) return;
  const res = await fetch(`${BASE}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: { ...headers(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
    signal: timeout(),
  });
  await check(res, `${table} güncelleme`);
};

store.remove = async (table, filter) => {
  if (!store.enabled) return;
  const res = await fetch(`${BASE}/rest/v1/${table}?${filter}`, { method: 'DELETE', headers: headers(), signal: timeout() });
  await check(res, `${table} silme`);
};

const pending = new Map(); // `${oda}\n${tür}` -> { timer, room, kind, getData }

// Kaydı biraz geciktirir; o sürede gelen değişiklikler de aynı yazmaya girer.
store.save = (room, kind, getData) => {
  if (!store.enabled) return;
  const key = `${room}\n${kind}`;
  clearTimeout(pending.get(key)?.timer);
  const job = { room, kind, getData, timer: null };
  job.timer = setTimeout(() => run(key, job), SAVE_DELAY);
  pending.set(key, job);
};

async function run(key, job) {
  if (pending.get(key) === job) pending.delete(key);
  try {
    await upsert(job.room, job.kind, job.getData());
  } catch (err) {
    console.warn('kayıt', job.kind, err.message);
    if (!pending.has(key)) {
      job.timer = setTimeout(() => run(key, job), RETRY_DELAY);
      pending.set(key, job);
    }
  }
}

// Kapanırken (Render yeni sürümü açarken SIGTERM gönderir) bekleyen kayıtları hemen yazar.
store.flush = () =>
  Promise.all([...pending].map(([key, job]) => {
    clearTimeout(job.timer);
    return run(key, job);
  }));

// Başarılıysa true döner (kayıt kapalıyken de: yazılacak yer yok).
store.putFile = async (path, buf, type) => {
  if (!store.enabled) return true;
  try {
    const res = await fetch(`${BASE}/storage/v1/object/${BUCKET}/${path}`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': type, 'x-upsert': 'true' },
      body: buf,
      signal: timeout(),
    });
    await check(res, 'yükleme');
    return true;
  } catch (err) {
    console.warn('dosya', path, err.message);
    return false;
  }
};

// { buf, type } ya da yoksa null
store.getFile = async (path) => {
  if (!store.enabled) return null;
  try {
    const res = await fetch(`${BASE}/storage/v1/object/${BUCKET}/${path}`, { headers: headers(), signal: timeout() });
    if (!res.ok) return null;
    return { buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') };
  } catch {
    return null;
  }
};

store.deleteFile = (path) => {
  if (!store.enabled) return;
  fetch(`${BASE}/storage/v1/object/${BUCKET}/${path}`, { method: 'DELETE', headers: headers(), signal: timeout() })
    .catch((err) => console.warn('dosya silme', path, err.message));
};

module.exports = store;
