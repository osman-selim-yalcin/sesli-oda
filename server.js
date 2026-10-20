const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

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
const TIER_MAX_ITEMS = 40;   // 40 öğe = 780 eşleşme; daha fazlası bitmez
const TIER_TITLE_MAX = 80;
const TIER_REVEAL_MS = 1500;  // herkes oy verince sonuç bu kadar görünür, sonra sıradaki eşleşme
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

app.get('/sfx-custom/:room/:id', (req, res) => {
  const fx = customSfxByRoom.get(req.params.room)?.get(req.params.id);
  if (!fx) return res.status(404).end();
  res.set({ 'Content-Type': 'audio/wav', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400' });
  res.send(fx.buf);
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

// Önceden çalanlar ve özel efektler oda boşalınca silinmez (sunucu yeniden başlayana kadar durur).
const histories = new Map(); // oda kodu -> [{ videoId, title, by, playedAt }]
const customSfxByRoom = new Map(); // oda kodu -> Map<id, { buf, label, by }>
const tiersByRoom = new Map(); // oda kodu -> tier list oyunu (aşağıda)

function getRoom(code) {
  if (!rooms.has(code)) {
    if (!histories.has(code)) histories.set(code, []);
    if (!customSfxByRoom.has(code)) customSfxByRoom.set(code, new Map());
    if (!tiersByRoom.has(code)) tiersByRoom.set(code, newTier());
    rooms.set(code, {
      code,
      history: histories.get(code),
      customSfx: customSfxByRoom.get(code),
      tier: tiersByRoom.get(code),
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
  io.to(room.code).emit('history:add', entry);
}

function playNext(room) {
  setCurrent(room, room.queue.shift());
}

// ---------- Oyunlar: tier list ----------
// Havuzdaki öğeler ikişer ikişer herkese aynı anda sorulur. Herkes oy verince kısa bir süre
// sonuç görünür ve sıradaki eşleşmeye geçilir. Sıralama her öğenin kazandığı oy oranıdır.

const pairKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

function newTier() {
  return {
    topic: '',
    items: [],          // { id, title, by, videoId }
    votes: new Map(),   // eşleşme anahtarı -> Map<sekme kimliği, { name, pick }>
    done: new Set(),    // oylanmış ya da geçilmiş eşleşmeler
    pair: null,         // [a, b]
    revealing: false,   // herkes oy verdi, sonuç gösteriliyor
    timer: null,
  };
}

let nextTierItemId = 1;

function tierView(tier) {
  const score = new Map(tier.items.map((it) => [it.id, { wins: 0, games: 0 }]));
  for (const [key, votes] of tier.votes) {
    const [a, b] = key.split('-').map(Number);
    if (!score.has(a) || !score.has(b)) continue;
    for (const { pick } of votes.values()) {
      score.get(a).games++;
      score.get(b).games++;
      score.get(pick).wins++;
    }
  }
  const n = tier.items.length;
  let pair = null;
  if (tier.pair) {
    const votes = {};
    for (const { name, pick } of tier.votes.get(pairKey(...tier.pair))?.values() || []) (votes[pick] ??= []).push(name);
    pair = { ids: tier.pair, votes, revealing: tier.revealing };
  }
  return {
    topic: tier.topic,
    items: tier.items.map((it) => ({ ...it, ...score.get(it.id) })),
    pair,
    done: tier.done.size,
    total: (n * (n - 1)) / 2,
  };
}

function broadcastTier(room) {
  io.to(room.code).emit('tier', tierView(room.tier));
}

// Henüz sorulmamış bir eşleşme seçer; az önce sorulan öğeler arka arkaya gelmesin.
function nextPair(tier) {
  clearTimeout(tier.timer);
  tier.revealing = false;
  const last = new Set(tier.pair || []);
  if (tier.pair) tier.done.add(pairKey(...tier.pair));
  const open = [];
  const ids = tier.items.map((it) => it.id);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (!tier.done.has(pairKey(ids[i], ids[j]))) open.push([ids[i], ids[j]]);
    }
  }
  const fresh = open.filter(([a, b]) => !last.has(a) && !last.has(b));
  const pool = fresh.length ? fresh : open;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  tier.pair = pick ? (Math.random() < 0.5 ? pick : [pick[1], pick[0]]) : null;
}

// Odadaki herkes oy verdiyse sonucu gösterip sıradakine geçer.
function checkTierVotes(room) {
  const tier = room.tier;
  if (!tier.pair || tier.revealing) return;
  const votes = tier.votes.get(pairKey(...tier.pair));
  const present = new Set([...room.users.values()].map((u) => u.clientId));
  const voted = [...(votes?.keys() || [])].filter((k) => present.has(k)).length;
  if (!present.size || voted < present.size) return;
  tier.revealing = true;
  tier.timer = setTimeout(() => {
    nextPair(tier);
    if (rooms.get(room.code) === room) broadcastTier(room);
  }, TIER_REVEAL_MS);
}

io.on('connection', (socket) => {
  let code = null;

  socket.on('time', (ack) => typeof ack === 'function' && ack(Date.now()));

  socket.on('join', ({ room: roomCode, name, clientId } = {}, ack) => {
    if (typeof ack !== 'function' || code) return;
    roomCode = String(roomCode || '').trim().toLowerCase().slice(0, 32);
    name = String(name || '').trim().slice(0, 24);
    clientId = String(clientId || '').slice(0, 64);
    if (!roomCode || !name) return ack({ error: 'Oda kodu ve isim gerekli.' });

    const room = getRoom(roomCode);

    // Sayfa yenilenince eski bağlantı hemen kapanmayabilir; aynı sekmenin eski kaydını sileriz.
    const leaveKey = `${roomCode}:${clientId}`;
    let rejoined = pendingLeaves.has(leaveKey);
    clearTimeout(pendingLeaves.get(leaveKey));
    pendingLeaves.delete(leaveKey);

    for (const [id, user] of room.users) {
      if (!clientId || user.clientId !== clientId) continue;
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
    ack({ id: socket.id, peers, media: mediaState(room), sharer: room.sharer, chat: room.chat, history: room.history, customSfx: customSfxList(room), tier: tierView(room.tier) });
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
    room.customSfx.set(crypto.randomUUID(), { buf: data, label, by });
    if (room.customSfx.size > CUSTOM_SFX_MAX) room.customSfx.delete(room.customSfx.keys().next().value);
    io.to(code).emit('sfx:list', customSfxList(room));
    io.to(code).emit('notice', `${by} yeni efekt ekledi: ${label}`);
    ack({});
  });

  socket.on('sfx:remove', (id) => {
    if (!code || !getRoom(code).customSfx.delete(id)) return;
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

  socket.on('tier:add', async ({ text, videoId } = {}) => {
    if (!code) return;
    const roomCode = code;
    const tier = getRoom(roomCode).tier;
    if (tier.items.length >= TIER_MAX_ITEMS) return socket.emit('notice', `Havuz dolu (en fazla ${TIER_MAX_ITEMS} öğe).`);
    videoId = typeof videoId === 'string' && VIDEO_ID.test(videoId) ? videoId : null;
    let title = typeof text === 'string' ? text.trim() : '';
    if (videoId) title = (await fetchTitle(videoId)) || title;
    title = title.slice(0, TIER_TITLE_MAX);
    if (!title || !rooms.has(roomCode)) return;
    const room = getRoom(roomCode);
    if (room.tier.items.some((it) => it.title.toLocaleLowerCase('tr-TR') === title.toLocaleLowerCase('tr-TR'))) {
      return socket.emit('notice', `Bu zaten havuzda: ${title}`);
    }
    room.tier.items.push({ id: nextTierItemId++, title, by: room.users.get(socket.id)?.name || '?', videoId });
    if (!room.tier.pair) nextPair(room.tier);
    broadcastTier(room);
  });

  socket.on('tier:remove', (id) => {
    if (!code) return;
    const room = getRoom(code);
    const tier = room.tier;
    const index = tier.items.findIndex((it) => it.id === id);
    if (index < 0) return;
    tier.items.splice(index, 1);
    if (tier.pair?.includes(id)) {
      tier.pair = null; // silinen öğenin eşleşmesi oylanmış sayılmasın
      nextPair(tier);
    }
    broadcastTier(room);
  });

  // Oy değiştirilebilir; aynı öğeye tekrar basmak geri alır. Sonuç gösterilirken oy alınmaz.
  socket.on('tier:vote', (pick) => {
    if (!code) return;
    const room = getRoom(code);
    const tier = room.tier;
    if (!tier.pair?.includes(pick) || tier.revealing) return;
    const key = pairKey(...tier.pair);
    if (!tier.votes.has(key)) tier.votes.set(key, new Map());
    const votes = tier.votes.get(key);
    const { key: who, name } = voter();
    if (votes.get(who)?.pick === pick) votes.delete(who);
    else votes.set(who, { name, pick });
    if (!votes.size) tier.votes.delete(key);
    checkTierVotes(room);
    broadcastTier(room);
  });

  socket.on('tier:next', () => {
    if (!code) return;
    const room = getRoom(code);
    if (!room.tier.pair) return;
    nextPair(room.tier);
    broadcastTier(room);
  });

  socket.on('tier:topic', (topic) => {
    if (!code || typeof topic !== 'string') return;
    const room = getRoom(code);
    room.tier.topic = topic.trim().slice(0, TIER_TITLE_MAX);
    broadcastTier(room);
  });

  // reset: oylar silinir, havuz kalır. clear: her şey silinir.
  socket.on('tier:reset', (all) => {
    if (!code) return;
    const room = getRoom(code);
    const tier = room.tier;
    clearTimeout(tier.timer);
    if (all) {
      tier.items = [];
      tier.topic = '';
    }
    tier.votes.clear();
    tier.done.clear();
    tier.pair = null;
    nextPair(tier);
    io.to(code).emit('notice', `${room.users.get(socket.id).name} ${all ? 'tier listesini temizledi' : 'tier listesinin oylarını sıfırladı'}`);
    broadcastTier(room);
  });

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
    // Herkes oy vermiş, sadece giden kişi bekleniyorsa eşleşme ilerlesin.
    if (room.users.size) {
      checkTierVotes(room);
      broadcastTier(room);
    }
    if (room.users.size === 0) {
      clearTimeout(room.tier.timer);
      room.tier.revealing = false;
      rooms.delete(code);
      deleteRoomImages(code);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Sesli Oda çalışıyor: http://localhost:${PORT}`);
});
