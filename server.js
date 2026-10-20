const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

// Bilgisayarda .env dosyasından ortam değişkenleri (Render'da panelden gelir).
try {
  process.loadEnvFile();
} catch {}
const store = require('./store');
const accounts = require('./accounts');

const PORT = process.env.PORT || 3030;
const MAX_USERS = 6;
const VIDEO_ID = /^[\w-]{11}$/;
const TWEET_ID = /^x:(\d{1,25})$/; // X (Twitter) postu; videoId olarak "x:<post no>" tutulur
const SFX_IDS = new Set(['clap', 'rimshot', 'ding', 'sad', 'tada', 'boom']);
const SFX_COOLDOWN = 600; // ms; efekt spam'ini engeller
const CUSTOM_SFX_MAX = 12;               // odadaki en fazla özel efekt; dolunca en eski silinir
const CUSTOM_SFX_MAX_BYTES = 300 * 1024; // istemci 4 sn mono WAV'a çevirip gönderir (~170 KB)
const CUSTOM_SFX_COOLDOWN = 5000;        // ms
const REACTIONS = ['🔥', '😂', '😍', '👏', '💀', '😴'];
const CHAT_HISTORY = 50;
const PLAY_HISTORY = 200; // önceden çalanlar listesinde tutulan şarkı sayısı  // odaya yeni girene gösterilen son mesaj sayısı
const CHAT_MAX_LENGTH = 500;
const CHAT_COOLDOWN = 300; // ms
const TIERLIST_MAX = 10;       // odadaki en fazla tier list
const TIERLIST_TITLE_MAX = 60;
const TIER_MAX = 12;           // bir listedeki en fazla satır (S, A, B...)
const TIER_NAME_MAX = 24;
const CARD_MAX = 100;          // bir listedeki en fazla kart
const CARD_TEXT_MAX = 60;
const CARD_IMAGE_MAX_BYTES = 200 * 1024; // istemci küçültüp gönderir (~20-40 KB)
const CARD_COOLDOWN = 300;     // ms
const DEFAULT_TIERS = ['S', 'A', 'B', 'C', 'D'];
const IMAGE_MAX_BYTES = 3 * 1024 * 1024; // istemci zaten küçültüp gönderir
const IMAGE_COOLDOWN = 2000; // ms
// Dosyanın ilk baytlarıyla gerçekten resim olduğunu doğrularız (uzantıya/türe güvenmeyiz).
const IMAGE_TYPES = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

const app = express();
// Efekt kayıtları değişmez; tarayıcı bir kez indirip saklasın.
app.use('/sfx', express.static(path.join(__dirname, 'public/sfx'), { maxAge: '30d' }));
app.use(express.static(path.join(__dirname, 'public')));
accounts.setup(app, { imageTypes: IMAGE_TYPES, onProfile: (name, avatar) => io.emit('profile', { name, avatar }) });

// ICE sunucuları: STUN herkese yeter, ama mobil hat ve bazı modemlerde (CGNAT) doğrudan
// bağlantı kurulamaz; o zaman ses TURN sunucusu üzerinden geçer.
// Cloudflare TURN (CF_TURN_KEY_ID + CF_TURN_API_TOKEN, ayda 1 TB ücretsiz) ya da
// sabit bir TURN sunucusu (TURN_URL, TURN_USERNAME, TURN_CREDENTIAL) kullanılabilir.
const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
const TURN_TTL = 24 * 3600; // sn
let cfTurn = null; // { iceServers, expires }

async function cloudflareTurn() {
  if (cfTurn && cfTurn.expires > Date.now()) return cfTurn.iceServers;
  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${process.env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.CF_TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TURN_TTL }),
      signal: AbortSignal.timeout(5000),
    }
  );
  if (!res.ok) throw new Error(`Cloudflare TURN ${res.status}`);
  const { iceServers } = await res.json();
  // Bilgiler süresi dolmadan yenilensin: yarı ömürde tazelenir.
  cfTurn = { iceServers: [].concat(iceServers), expires: Date.now() + (TURN_TTL / 2) * 1000 };
  return cfTurn.iceServers;
}

app.get('/config', async (req, res) => {
  const iceServers = [...STUN];
  if (process.env.CF_TURN_KEY_ID && process.env.CF_TURN_API_TOKEN) {
    try {
      iceServers.push(...(await cloudflareTurn()));
    } catch (err) {
      console.warn('turn', err.message);
    }
  }
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(','),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  res.json({ iceServers, search: Boolean(process.env.YT_API_KEY) });
});

// Sohbet fotoğrafları: sadece hafızada; mesaj sohbet geçmişinden düşünce ya da oda boşalınca silinir.
const images = new Map(); // id -> { buf, type, code }

app.get('/sfx-custom/:room/:id', async (req, res) => {
  const fx = customSfxByRoom.get(req.params.room)?.get(req.params.id);
  if (!fx) return res.status(404).end();
  // Kayıttan yüklenen efektin sesi ilk istendiğinde depodan alınır.
  fx.buf ??= (await store.getFile(`sfx/${req.params.id}.wav`))?.buf;
  if (!fx.buf) return res.status(404).end();
  res.set({ 'Content-Type': 'audio/wav', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400' });
  res.send(fx.buf);
});

app.get('/card-img/:id', async (req, res) => {
  if (!/^[\w-]{36}$/.test(req.params.id)) return res.status(404).end();
  let img = cardImages.get(req.params.id);
  if (!img) {
    img = await store.getFile(`cards/${req.params.id}`);
    if (!img || !IMAGE_TYPES[img.type]) return res.status(404).end();
    cardImages.set(req.params.id, img);
  }
  res.set({ 'Content-Type': img.type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400' });
  res.send(img.buf);
});

app.get('/img/:id', (req, res) => {
  const img = images.get(req.params.id);
  if (!img) return res.status(404).end();
  res.set({ 'Content-Type': img.type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400' });
  res.send(img.buf);
});

function deleteRoomImages(code) {
  for (const [id, img] of images) if (img.code === code) images.delete(id);
}

// YouTube araması (YouTube Data API v3). Anahtar Render'da YT_API_KEY ortam değişkeninde durur.
// Arama 100, süre bilgisi 1 kota birimi harcar (günlük ücretsiz kota 10.000 ≈ 100 arama);
// aynı arama 1 saat önbellekte tutulur.
const YT_API = process.env.YT_API_BASE || 'https://www.googleapis.com/youtube/v3';
const SEARCH_CACHE_MS = 60 * 60 * 1000;
const SEARCH_CACHE_MAX = 200;
const searchCache = new Map(); // sorgu -> { at, results }

const decodeEntities = (s) =>
  s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);

// ISO 8601 süre (PT1H2M3S) -> saniye
function isoSeconds(iso = '') {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/) || [];
  return (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
}

async function youtubeSearch(q) {
  const key = process.env.YT_API_KEY;
  const search = new URL(`${YT_API}/search`);
  search.search = new URLSearchParams({
    part: 'snippet', type: 'video', videoEmbeddable: 'true', maxResults: '10',
    regionCode: 'TR', relevanceLanguage: 'tr', q, key,
  });
  const res = await fetch(search, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`YouTube ${res.status}`);
  const items = (await res.json()).items || [];
  const ids = items.map((it) => it.id.videoId).filter(Boolean);
  if (!ids.length) return [];

  const details = new URL(`${YT_API}/videos`);
  details.search = new URLSearchParams({ part: 'contentDetails', id: ids.join(','), key });
  const durations = {};
  try {
    const d = await (await fetch(details, { signal: AbortSignal.timeout(8000) })).json();
    for (const v of d.items || []) durations[v.id] = isoSeconds(v.contentDetails?.duration);
  } catch {}

  return items.filter((it) => it.id.videoId).map((it) => ({
    videoId: it.id.videoId,
    title: decodeEntities(it.snippet.title),
    channel: decodeEntities(it.snippet.channelTitle),
    duration: durations[it.id.videoId] ?? null,
  }));
}

app.get('/search', async (req, res) => {
  if (!process.env.YT_API_KEY) return res.status(503).json({ error: 'Arama kapalı: sunucuda YouTube API anahtarı yok.' });
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (!q) return res.json({ results: [] });

  const cacheKey = q.toLocaleLowerCase('tr-TR');
  const hit = searchCache.get(cacheKey);
  if (hit && Date.now() - hit.at < SEARCH_CACHE_MS) return res.json({ results: hit.results });
  try {
    const results = await youtubeSearch(q);
    searchCache.set(cacheKey, { at: Date.now(), results });
    if (searchCache.size > SEARCH_CACHE_MAX) searchCache.delete(searchCache.keys().next().value);
    res.json({ results });
  } catch (err) {
    console.warn('arama', err.message);
    res.status(502).json({ error: 'YouTube araması şu an yapılamıyor (günlük kota dolmuş olabilir).' });
  }
});

// Giriş ekranı için: tek odada kimler var.
app.get('/status', (req, res) => {
  const room = rooms.get('genel');
  res.json({ names: room ? [...room.users.values()].map((u) => u.name) : [], max: MAX_USERS });
});

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: IMAGE_MAX_BYTES + 64 * 1024 });

// oda kodu -> { users: Map<socketId, {name, muted}>, current, queue, playing, position, updatedAt }
const rooms = new Map();

// Önceden çalanlar, özel efektler ve tier listler oda boşalınca silinmez; Supabase ayarlıysa
// kalıcıdır (store.js), değilse sunucu yeniden başlayana kadar durur.
const histories = new Map(); // oda kodu -> [{ videoId, title, by, playedAt }]
const customSfxByRoom = new Map(); // oda kodu -> Map<id, { buf, label, by }>
const tierListsByRoom = new Map(); // oda kodu -> [tier list] (aşağıda)

function getRoom(code) {
  if (!rooms.has(code)) {
    if (!histories.has(code)) histories.set(code, []);
    if (!customSfxByRoom.has(code)) customSfxByRoom.set(code, new Map());
    if (!tierListsByRoom.has(code)) tierListsByRoom.set(code, []);
    rooms.set(code, {
      code,
      history: histories.get(code),
      customSfx: customSfxByRoom.get(code),
      tierLists: tierListsByRoom.get(code),
      users: new Map(),
      current: null,
      sharer: null, // ekranını paylaşan kişinin soket kimliği
      chat: [],     // geçici: sadece hafızada, herkes çıkınca oda ile birlikte silinir
      queue: [],
      playing: false,
      position: 0,
      updatedAt: Date.now(),
    });
  }
  return rooms.get(code);
}

// Oynatma konumunu "şu an" itibarıyla dondurur.
function currentPosition(room) {
  if (!room.playing) return room.position;
  return room.position + (Date.now() - room.updatedAt) / 1000;
}

function setPlayback(room, playing, position) {
  room.playing = playing;
  room.position = Math.max(0, Number(position) || 0);
  room.updatedAt = Date.now();
}

// Beğeni ve tepkiler kişi başı tutulur (anahtar: sekme kimliği); istemciye isim listesi olarak gider.
const names = (map) => [...map.values()];

function itemView(item) {
  if (!item) return null;
  const reactions = {};
  for (const [emoji, who] of item.reactions) if (who.size) reactions[emoji] = names(who);
  return {
    id: item.id,
    videoId: item.videoId,
    title: item.title,
    thumb: item.thumb,
    sources: item.sources,
    by: item.by,
    likes: names(item.likes),
    dislikes: names(item.dislikes),
    reactions,
  };
}

function findItem(room, id) {
  if (room.current?.id === id) return room.current;
  return room.queue.find((item) => item.id === id);
}

let nextItemId = 1;

function mediaState(room) {
  return {
    current: itemView(room.current),
    queue: room.queue.map(itemView),
    playing: room.playing,
    position: room.position,
    updatedAt: room.updatedAt,
  };
}

function broadcastMedia(code) {
  io.to(code).emit('media', mediaState(getRoom(code)));
}

async function fetchTitle(videoId) {
  try {
    const url = `https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${videoId}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    return (await res.json()).title || null;
  } catch {
    return null;
  }
}

// X postundaki ilk videoyu FxTwitter'ın herkese açık API'siyle buluruz (giriş gerektirmez).
// Kaynaklar düşük kaliteden yükseğe sıralı mp4'ler; istemci kalite ayarına göre seçer.
async function fetchTweet(id) {
  try {
    const res = await fetch(`https://api.fxtwitter.com/status/${id}`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const { tweet } = await res.json();
    const video = tweet?.media?.videos?.[0];
    if (!video) return null;
    const mp4 = (video.formats || video.variants || [])
      .filter((f) => f.container === 'mp4' || /\.mp4(\?|$)/.test(f.url || ''))
      .map((f) => ({ url: f.url, bitrate: f.bitrate || 0 }));
    const sources = (mp4.length ? mp4 : [{ url: video.url, bitrate: 0 }])
      .filter((f) => /^https:\/\/video\.twimg\.com\//.test(f.url))
      .sort((a, b) => a.bitrate - b.bitrate);
    if (!sources.length) return null;
    const text = (tweet.text || '').replace(/\s+/g, ' ').trim();
    const name = tweet.author?.screen_name ? `@${tweet.author.screen_name}` : 'X';
    return {
      title: text ? `${name}: ${text.length > 90 ? `${text.slice(0, 90)}…` : text}` : `${name} videosu`,
      thumb: video.thumbnail_url || null,
      sources,
    };
  } catch {
    return null;
  }
}

const customSfxList = (room) => [...room.customSfx].map(([id, fx]) => ({ id, label: fx.label, by: fx.by }));
const saveCustomSfx = (room) => store.save(room.code, 'sfx', () => customSfxList(room));

// Giriş/çıkış sohbete yazılır. Sayfayı yenileyen kişi için iki mesaj da yazılmasın diye
// çıkış mesajı biraz bekletilir; o sürede aynı sekme geri dönerse ikisi de atlanır.
const REJOIN_GRACE = 5000; // ms
const pendingLeaves = new Map(); // `${oda}:${sekme}` -> zamanlayıcı

function postSystem(room, text, extra) {
  postChat(room, { system: true, text, ts: Date.now(), ...extra });
}

function postChat(room, msg) {
  room.chat.push(msg);
  if (room.chat.length > CHAT_HISTORY) {
    const old = room.chat.shift();
    if (old.image) images.delete(old.image.slice('img/'.length));
  }
  io.to(room.code).emit('chat', msg);
}

function stopSharing(room, code, id) {
  if (room.sharer !== id) return;
  room.sharer = null;
  io.to(code).emit('screen', null);
}

// Çalan şarkıyı değiştirir ve önceden çalanlar listesine ekler.
function setCurrent(room, item) {
  room.current = item || null;
  setPlayback(room, Boolean(room.current), 0);
  if (!item) return;
  const entry = { videoId: item.videoId, title: item.title, thumb: item.thumb, by: item.by, playedAt: Date.now() };
  room.history.push(entry);
  if (room.history.length > PLAY_HISTORY) room.history.shift();
  store.save(room.code, 'history', () => room.history);
  io.to(room.code).emit('history:add', entry);
}

function playNext(room) {
  setCurrent(room, room.queue.shift());
}

// ---------- Oyunlar: tier list ----------
// Odada birden fazla tier list olabilir. Herkes kart ekler (yazı ve/veya resim) ve kartları
// satırlara sürükler; tahta herkeste ortaktır. Listeler oda boşalınca silinmez, kart resimleri
// de sunucu yeniden başlayana kadar hafızada durur.

const cardImages = new Map(); // id -> { buf, type }
let nextTierId = 1; // listeler, satırlar ve kartlar için ortak sayaç

const newTierRow = (name) => ({ id: nextTierId++, name, cards: [] });

function tierListView(list) {
  return {
    id: list.id,
    title: list.title,
    by: list.by,
    tiers: list.tiers.map((t) => ({ id: t.id, name: t.name, cards: t.cards })),
    pool: list.pool,
    cards: [...list.cards.values()],
  };
}

function broadcastTierLists(room) {
  io.to(room.code).emit('tierlists', room.tierLists.map(tierListView));
  store.save(room.code, 'tierlists', () => room.tierLists.map(tierListView));
}

// Kartı bulunduğu yerden (havuz ya da bir satır) çıkarır.
function takeCard(list, cardId) {
  for (const arr of [list.pool, ...list.tiers.map((t) => t.cards)]) {
    const i = arr.indexOf(cardId);
    if (i >= 0) return arr.splice(i, 1);
  }
}

function deleteCard(list, cardId) {
  takeCard(list, cardId);
  const card = list.cards.get(cardId);
  if (card?.image) {
    const imageId = card.image.slice('card-img/'.length);
    cardImages.delete(imageId);
    store.deleteFile(`cards/${imageId}`);
  }
  list.cards.delete(cardId);
}

io.on('connection', (socket) => {
  let code = null;

  socket.on('time', (ack) => typeof ack === 'function' && ack(Date.now()));

  // İsim hesaptan gelir; herkes kendi hesabıyla girer.
  socket.on('join', ({ room: roomCode, token, clientId } = {}, ack) => {
    if (typeof ack !== 'function' || code) return;
    roomCode = String(roomCode || '').trim().toLowerCase().slice(0, 32);
    clientId = String(clientId || '').slice(0, 64);
    const account = accounts.accountByToken(token);
    if (!account) return ack({ error: 'Oturumun kapanmış, tekrar giriş yap.', auth: true });
    const { name } = account;
    if (!roomCode) return ack({ error: 'Oda kodu gerekli.' });

    const room = getRoom(roomCode);

    // Sayfa yenilenince eski bağlantı hemen kapanmayabilir; aynı sekmenin eski kaydını sileriz.
    // Aynı hesapla başka bir sekmeden/cihazdan girilirse eskisi odadan çıkarılır.
    const leaveKey = `${roomCode}:${clientId}`;
    let rejoined = pendingLeaves.has(leaveKey);
    clearTimeout(pendingLeaves.get(leaveKey));
    pendingLeaves.delete(leaveKey);

    for (const [id, user] of room.users) {
      if (!(clientId && user.clientId === clientId) && user.name !== name) continue;
      rejoined = true;
      room.users.delete(id);
      stopSharing(room, roomCode, id);
      io.to(roomCode).emit('user-left', id);
      io.sockets.sockets.get(id)?.disconnect(true);
    }

    if (room.users.size >= MAX_USERS) {
      return ack({ error: `Oda dolu (en fazla ${MAX_USERS} kişi).` });
    }

    const peers = [...room.users].map(([id, u]) => ({ id, name: u.name, muted: u.muted, recording: u.recording }));
    code = roomCode;
    room.users.set(socket.id, { name, muted: false, clientId, recording: false });
    socket.join(code);
    socket.to(code).emit('user-joined', { id: socket.id, name, muted: false });
    ack({ id: socket.id, peers, media: mediaState(room), sharer: room.sharer, chat: room.chat, history: room.history, customSfx: customSfxList(room), tierLists: room.tierLists.map(tierListView), profiles: accounts.profiles() });
    // Cevaptan sonra: giren kişi bu mesajı hem geçmişte hem bildirimde iki kez görmesin.
    if (!rejoined) postSystem(room, `${name} odaya katıldı`, { event: 'join', from: socket.id });
  });

  // WebRTC sinyal mesajlarını (offer/answer/ice) aynı odadaki hedefe iletir.
  socket.on('signal', ({ to, data } = {}) => {
    if (!code || !getRoom(code).users.has(to)) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  // Kayıt yapan herkes odadakilere bildirilir; kimse habersiz kaydedilmesin.
  socket.on('rec', (on) => {
    if (!code) return;
    const user = getRoom(code).users.get(socket.id);
    user.recording = Boolean(on);
    socket.to(code).emit('rec', { id: socket.id, on: user.recording });
  });

  socket.on('mute', (muted) => {
    if (!code) return;
    const user = getRoom(code).users.get(socket.id);
    user.muted = Boolean(muted);
    socket.to(code).emit('user-muted', { id: socket.id, muted: user.muted });
  });

  socket.on('screen:start', (ack) => {
    if (!code || typeof ack !== 'function') return;
    const room = getRoom(code);
    if (room.sharer && room.sharer !== socket.id) {
      return ack({ error: `${room.users.get(room.sharer)?.name || 'Biri'} zaten ekran paylaşıyor.` });
    }
    room.sharer = socket.id;
    socket.to(code).emit('screen', socket.id);
    ack({});
  });

  socket.on('screen:stop', () => {
    if (!code) return;
    stopSharing(getRoom(code), code, socket.id);
  });

  // Kişinin videosu donuyor mu; diğerlerinin listesinde ⏳ olarak görünür.
  socket.on('video-state', (state) => {
    if (!code || (state !== 'buffering' && state !== 'ok')) return;
    socket.to(code).emit('video-state', { id: socket.id, state });
  });

  let lastChat = 0;
  socket.on('chat', (text) => {
    if (!code || typeof text !== 'string' || Date.now() - lastChat < CHAT_COOLDOWN) return;
    text = text.trim().slice(0, CHAT_MAX_LENGTH);
    if (!text) return;
    lastChat = Date.now();
    const room = getRoom(code);
    postChat(room, { from: socket.id, name: room.users.get(socket.id).name, text, ts: Date.now() });
  });

  let lastImage = 0;
  socket.on('chat:image', ({ data, type, caption } = {}, ack) => {
    if (typeof ack !== 'function') return;
    if (!code) return ack({ error: 'Odada değilsin.' });
    if (Date.now() - lastImage < IMAGE_COOLDOWN) return ack({ error: 'Biraz bekle, çok hızlı gönderiyorsun.' });
    if (!Buffer.isBuffer(data) || data.length > IMAGE_MAX_BYTES || !IMAGE_TYPES[type]?.(data)) {
      return ack({ error: 'Bu dosya gönderilemedi (desteklenmeyen tür ya da çok büyük).' });
    }
    lastImage = Date.now();
    const id = crypto.randomUUID();
    images.set(id, { buf: data, type, code });
    const room = getRoom(code);
    const text = typeof caption === 'string' ? caption.trim().slice(0, CHAT_MAX_LENGTH) : '';
    postChat(room, { from: socket.id, name: room.users.get(socket.id).name, text, image: `img/${id}`, ts: Date.now() });
    ack({});
  });

  let lastSfx = 0;
  socket.on('sfx', (id) => {
    if (!code || typeof id !== 'string' || Date.now() - lastSfx < SFX_COOLDOWN) return;
    if (!SFX_IDS.has(id) && !getRoom(code).customSfx.has(id)) return;
    lastSfx = Date.now();
    socket.to(code).emit('sfx', { id, by: getRoom(code).users.get(socket.id).name });
  });

  // Kullanıcının yüklediği efekt: istemci 16-bit mono WAV'a çevirip gönderir.
  let lastUpload = 0;
  socket.on('sfx:upload', ({ data, label } = {}, ack) => {
    if (typeof ack !== 'function') return;
    if (!code) return ack({ error: 'Odada değilsin.' });
    if (Date.now() - lastUpload < CUSTOM_SFX_COOLDOWN) return ack({ error: 'Biraz bekle, çok hızlı yüklüyorsun.' });
    label = typeof label === 'string' ? label.trim().slice(0, 16) : '';
    const isWav = Buffer.isBuffer(data) && data.length > 44 && data.length <= CUSTOM_SFX_MAX_BYTES &&
      data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WAVE';
    if (!label) return ack({ error: 'Efekte bir isim ver.' });
    if (!isWav) return ack({ error: 'Ses dosyası işlenemedi.' });
    lastUpload = Date.now();
    const room = getRoom(code);
    const by = room.users.get(socket.id).name;
    const id = crypto.randomUUID();
    room.customSfx.set(id, { buf: data, label, by });
    store.putFile(`sfx/${id}.wav`, data, 'audio/wav');
    if (room.customSfx.size > CUSTOM_SFX_MAX) {
      const oldest = room.customSfx.keys().next().value;
      room.customSfx.delete(oldest);
      store.deleteFile(`sfx/${oldest}.wav`);
    }
    saveCustomSfx(room);
    io.to(code).emit('sfx:list', customSfxList(room));
    io.to(code).emit('notice', `${by} yeni efekt ekledi: ${label}`);
    ack({});
  });

  socket.on('sfx:remove', (id) => {
    if (!code || !getRoom(code).customSfx.delete(id)) return;
    store.deleteFile(`sfx/${id}.wav`);
    saveCustomSfx(getRoom(code));
    io.to(code).emit('sfx:list', customSfxList(getRoom(code)));
  });

  socket.on('media:add', async (videoId) => {
    if (!code || typeof videoId !== 'string') return;
    const tweetId = videoId.match(TWEET_ID)?.[1];
    if (!tweetId && !VIDEO_ID.test(videoId)) return;
    const roomCode = code;
    const by = getRoom(roomCode).users.get(socket.id).name;
    let info;
    if (tweetId) {
      info = await fetchTweet(tweetId);
      if (!info) return socket.emit('notice', 'Bu X postunda oynatılabilir video bulunamadı.');
    } else {
      info = { title: (await fetchTitle(videoId)) || videoId };
    }
    if (!rooms.has(roomCode)) return;
    const room = getRoom(roomCode);
    const { title, thumb = null, sources = null } = info;
    const item = { id: nextItemId++, videoId, title, thumb, sources, by, likes: new Map(), dislikes: new Map(), reactions: new Map() };
    if (room.current) {
      room.queue.push(item);
    } else {
      setCurrent(room, item);
    }
    io.to(roomCode).emit('notice', `${by} ekledi: ${title}`);
    broadcastMedia(roomCode);
  });

  const voter = () => {
    const user = getRoom(code).users.get(socket.id);
    return { key: user.clientId || socket.id, name: user.name };
  };

  // vote: 1 beğen, -1 beğenme; aynı oya tekrar basmak geri alır.
  socket.on('media:vote', ({ itemId, vote } = {}) => {
    if (!code || (vote !== 1 && vote !== -1)) return;
    const item = findItem(getRoom(code), itemId);
    if (!item) return;
    const { key, name } = voter();
    const [mine, other] = vote === 1 ? [item.likes, item.dislikes] : [item.dislikes, item.likes];
    other.delete(key);
    if (mine.has(key)) mine.delete(key);
    else mine.set(key, name);
    broadcastMedia(code);
  });

  socket.on('media:react', ({ itemId, emoji } = {}) => {
    if (!code || !REACTIONS.includes(emoji)) return;
    const item = findItem(getRoom(code), itemId);
    if (!item) return;
    const { key, name } = voter();
    if (!item.reactions.has(emoji)) item.reactions.set(emoji, new Map());
    const who = item.reactions.get(emoji);
    if (who.has(key)) who.delete(key);
    else who.set(key, name);
    broadcastMedia(code);
  });

  socket.on('media:play', (position) => {
    if (!code || !getRoom(code).current) return;
    setPlayback(getRoom(code), true, position);
    broadcastMedia(code);
  });

  socket.on('media:pause', (position) => {
    if (!code || !getRoom(code).current) return;
    setPlayback(getRoom(code), false, position);
    broadcastMedia(code);
  });

  socket.on('media:seek', (position) => {
    if (!code || !getRoom(code).current) return;
    const room = getRoom(code);
    setPlayback(room, room.playing, position);
    broadcastMedia(code);
  });

  socket.on('media:next', () => {
    if (!code) return;
    playNext(getRoom(code));
    broadcastMedia(code);
  });

  // Video bittiğinde her istemci bildirir; yalnızca hâlâ çalan video için ilerlenir.
  socket.on('media:ended', (videoId) => {
    if (!code) return;
    const room = getRoom(code);
    if (room.current?.videoId !== videoId || currentPosition(room) < 1) return;
    playNext(room);
    broadcastMedia(code);
  });

  // Video oynatılamıyorsa (gömme kapalı, silinmiş) atlanır. Tek kişinin cihazındaki sorun
  // (reklam engelleyici, tarayıcı) herkesin şarkısını geçmesin: odanın yarısı bildirince atlanır.
  socket.on('media:error', (data, ack) => {
    if (!code) return;
    const { videoId, error } = typeof data === 'string' ? { videoId: data } : data || {};
    const room = getRoom(code);
    const done = (skipped) => typeof ack === 'function' && ack(skipped);
    if (room.current?.videoId !== videoId) return done(false);
    const failed = (room.current.failed ??= new Set());
    failed.add(socket.id);
    if (failed.size * 2 < room.users.size) return done(false);
    const why = Number.isInteger(error) ? ` (YouTube hata ${error})` : '';
    io.to(code).emit('notice', `Oynatılamadı, atlandı: ${room.current.title}${why}`);
    playNext(room);
    broadcastMedia(code);
    done(true);
  });

  socket.on('media:remove', (index) => {
    if (!code) return;
    const room = getRoom(code);
    if (!Number.isInteger(index) || !room.queue[index]) return;
    room.queue.splice(index, 1);
    broadcastMedia(code);
  });

  socket.on('media:playNow', (index) => {
    if (!code) return;
    const room = getRoom(code);
    if (!Number.isInteger(index) || !room.queue[index]) return;
    setCurrent(room, room.queue.splice(index, 1)[0]);
    broadcastMedia(code);
  });

  // Tier list olayları listenin kimliğiyle gelir; liste yoksa yok sayılır.
  const withList = (listId, fn) => {
    if (!code) return;
    const room = getRoom(code);
    const list = room.tierLists.find((l) => l.id === listId);
    if (list && fn(list, room) !== false) broadcastTierLists(room);
  };
  const cleanText = (text, max) => (typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, max) : '');

  socket.on('tierlist:create', (title, ack) => {
    if (!code || typeof ack !== 'function') return;
    const room = getRoom(code);
    title = cleanText(title, TIERLIST_TITLE_MAX);
    if (!title) return ack({ error: 'Listeye bir isim ver.' });
    if (room.tierLists.length >= TIERLIST_MAX) return ack({ error: `En fazla ${TIERLIST_MAX} tier list olabilir; eskilerden birini sil.` });
    const by = room.users.get(socket.id).name;
    const list = { id: nextTierId++, title, by, tiers: DEFAULT_TIERS.map(newTierRow), pool: [], cards: new Map() };
    room.tierLists.push(list);
    broadcastTierLists(room);
    socket.to(code).emit('notice', `${by} yeni tier list oluşturdu: ${title}`);
    ack({ id: list.id });
  });

  socket.on('tierlist:delete', (listId) => withList(listId, (list, room) => {
    for (const id of [...list.cards.keys()]) deleteCard(list, id);
    room.tierLists.splice(room.tierLists.indexOf(list), 1);
  }));

  socket.on('tierlist:rename', ({ listId, title } = {}) => withList(listId, (list) => {
    title = cleanText(title, TIERLIST_TITLE_MAX);
    if (!title) return false;
    list.title = title;
  }));

  socket.on('tier:add', (listId) => withList(listId, (list) => {
    if (list.tiers.length >= TIER_MAX) return false;
    list.tiers.push(newTierRow(String(list.tiers.length + 1)));
  }));

  // Silinen satırdaki kartlar havuza döner.
  socket.on('tier:remove', ({ listId, tierId } = {}) => withList(listId, (list) => {
    const i = list.tiers.findIndex((t) => t.id === tierId);
    if (i < 0 || list.tiers.length <= 1) return false;
    list.pool.push(...list.tiers.splice(i, 1)[0].cards);
  }));

  socket.on('tier:rename', ({ listId, tierId, name } = {}) => withList(listId, (list) => {
    const tier = list.tiers.find((t) => t.id === tierId);
    name = cleanText(name, TIER_NAME_MAX);
    if (!tier || !name) return false;
    tier.name = name;
  }));

  // dir: -1 yukarı, 1 aşağı
  socket.on('tier:shift', ({ listId, tierId, dir } = {}) => withList(listId, (list) => {
    const i = list.tiers.findIndex((t) => t.id === tierId);
    const j = i + (dir === -1 ? -1 : 1);
    if (i < 0 || j < 0 || j >= list.tiers.length) return false;
    [list.tiers[i], list.tiers[j]] = [list.tiers[j], list.tiers[i]];
  }));

  let lastCard = 0;
  socket.on('card:add', ({ listId, text, data, type } = {}, ack) => {
    if (typeof ack !== 'function') return;
    if (!code) return ack({ error: 'Odada değilsin.' });
    if (Date.now() - lastCard < CARD_COOLDOWN) return ack({ error: 'Biraz bekle, çok hızlı ekliyorsun.' });
    const list = getRoom(code).tierLists.find((l) => l.id === listId);
    if (!list) return ack({ error: 'Bu liste silinmiş.' });
    if (list.cards.size >= CARD_MAX) return ack({ error: `Bir listede en fazla ${CARD_MAX} kart olabilir.` });
    text = cleanText(text, CARD_TEXT_MAX);
    let image = null;
    if (data != null) {
      if (!Buffer.isBuffer(data) || data.length > CARD_IMAGE_MAX_BYTES || !IMAGE_TYPES[type]?.(data)) {
        return ack({ error: 'Bu resim eklenemedi (desteklenmeyen tür ya da çok büyük).' });
      }
      const imageId = crypto.randomUUID();
      cardImages.set(imageId, { buf: data, type });
      store.putFile(`cards/${imageId}`, data, type);
      image = `card-img/${imageId}`;
    }
    if (!text && !image) return ack({ error: 'Karta bir isim yaz ya da resim seç.' });
    lastCard = Date.now();
    withList(listId, (l, room) => {
      const card = { id: nextTierId++, text, image, by: room.users.get(socket.id).name };
      l.cards.set(card.id, card);
      l.pool.push(card.id);
    });
    ack({});
  });

  socket.on('card:remove', ({ listId, cardId } = {}) => withList(listId, (list) => {
    if (!list.cards.has(cardId)) return false;
    deleteCard(list, cardId);
  }));

  // to: satır kimliği ya da havuz için null; index: o yerdeki sırası.
  socket.on('card:move', ({ listId, cardId, to, index } = {}) => withList(listId, (list) => {
    if (!list.cards.has(cardId)) return false;
    const target = to == null ? list.pool : list.tiers.find((t) => t.id === to)?.cards;
    if (!target) return false;
    takeCard(list, cardId);
    const at = Number.isInteger(index) ? Math.max(0, Math.min(index, target.length)) : target.length;
    target.splice(at, 0, cardId);
  }));

  socket.on('disconnect', () => {
    if (!code) return;
    const room = getRoom(code);
    // Yenileme sırasında zaten silinmiş olabilir.
    const user = room.users.get(socket.id);
    if (!room.users.delete(socket.id)) return;
    stopSharing(room, code, socket.id);
    socket.to(code).emit('user-left', socket.id);

    const roomCode = code;
    const leaveKey = `${roomCode}:${user.clientId}`;
    pendingLeaves.set(leaveKey, setTimeout(() => {
      pendingLeaves.delete(leaveKey);
      const current = rooms.get(roomCode);
      if (current) postSystem(current, `${user.name} ayrıldı`, { event: 'leave' });
    }, REJOIN_GRACE));
    if (room.users.size === 0) {
      rooms.delete(code);
      deleteRoomImages(code);
    }
  });
});

// Kayıtlı durumu hafızaya alır. Okunamazsa kayıt da kapatılır ki boş hafıza eskilerin üstüne yazılmasın.
async function loadSaved() {
  if (!store.enabled) return console.log('Supabase ayarlı değil; hesaplar, geçmiş, efektler ve tier listler sadece hafızada.');
  let rows;
  try {
    rows = await store.loadAll();
    await accounts.load();
  } catch (err) {
    store.enabled = false;
    return console.warn('Kayıtlar okunamadı, bu oturumda kaydetme kapalı:', err.message);
  }
  for (const { room, kind, data } of rows) {
    if (kind === 'history') histories.set(room, data);
    if (kind === 'sfx') customSfxByRoom.set(room, new Map(data.map((fx) => [fx.id, { buf: null, label: fx.label, by: fx.by }])));
    if (kind === 'tierlists') {
      tierListsByRoom.set(room, data.map((l) => ({ ...l, cards: new Map(l.cards.map((c) => [c.id, c])) })));
      for (const l of data) {
        for (const id of [l.id, ...l.tiers.map((t) => t.id), ...l.cards.map((c) => c.id)]) nextTierId = Math.max(nextTierId, id + 1);
      }
    }
  }
  console.log(`Supabase: ${rows.length} kayıt yüklendi.`);
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, async () => {
    await store.flush();
    process.exit(0);
  });
}

loadSaved().then(() => {
  server.listen(PORT, () => {
    console.log(`Sesli Oda çalışıyor: http://localhost:${PORT}`);
  });
});
