const path = require('path');
const crypto = require('crypto');
const http = require('http');
const zlib = require('zlib');
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
const RADIO_COOLDOWN = 1000; // ms; bir kişi radyoyu bu sıklıktan fazla değiştiremez
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
const TIERLIST_MAX = 50;       // odadaki en fazla tier list
const TIERLIST_PER_USER = 10;  // bir kişinin en fazla tier listi
const TIERLIST_TITLE_MAX = 60;
const TIER_MAX = 12;           // bir listedeki en fazla satır (S, A, B...)
const TIER_NAME_MAX = 24;
const CARD_MAX = 100;          // bir listedeki en fazla kart
const CARD_TEXT_MAX = 60;
const CARD_IMAGE_MAX_BYTES = 200 * 1024; // istemci küçültüp gönderir (~20-40 KB)
const CARD_COOLDOWN = 300;     // ms
const DEFAULT_TIERS = ['S', 'A', 'B', 'C', 'D'];
const TIMING_TARGET_MIN = 3;   // sn; süre tahmini oyununun hedefi
const TIMING_TARGET_MAX = 120;
const TIMING_RANDOM = [5, 30]; // "rastgele" hedef bu aralıktan
const RACE_TARGETS = [3, 10];   // yarış hedefleri bu aralıktan (sn)
const RACE_COUNTDOWN = 3000;    // ms; her turdan önce ortak geri sayım
const RACE_REVEAL = 3500;       // ms; tur sonuçları bu kadar görünür, sonra sonraki tur
const RACE_MISS = 10000;        // ms; durdurmayan o tur için bu kadar fark yemiş sayılır
const TIMING_RESULTS = 100;    // odada tutulan son deneme sayısı
const TIMING_COOLDOWN = 1000;  // ms
const RACE_ROUNDS = [3, 5, 10]; // yarışta seçilebilen tur sayıları
const DINO_COUNTDOWN = 5000;   // ms; dinozor oyunu başlamadan önce
const DINO_MAX_TIME = 20 * 60 * 1000; // bundan uzun süren oyun bitmiş sayılır
// Jef (kusursuz koşan bot) hep azami hızda koşar; azami hız zamanla artar (oyundaki DINO_PACE ile aynı olmalı).
const DINO_PACE = { runStart: 460, runAccel: 30, runMax: 1400 };
const DINO_SILENT = 3000; // ms; bu kadar konum göndermeyen oyuncu (sekmesi kapalı, bağlantısı kopmuş) ölmüş sayılır
const DINO_BOARD = 10; // her mod için saklanan en iyi skor sayısı
const DINO_BOARD_MODES = ['auto', 'hold', 'tap']; // 'auto' şu anki tek mod; diğerleri eski skorlar // en öndekinin bu kadar gerisinde kalan ölür (oyundaki ekran payı + gecikme payı)
const KELIME_TIME = 7 * 60 * 1000; // ms; her turda bilenlerin hedef kelimeyi bulmak için süresi
const KELIME_TURN = 10000;       // ms; anlatıcının gelen her kelimeyi yerleştirme süresi
const KELIME_QUEUE = 4;          // yerleştirilmeyi bekleyen bu kadar kelime varken yeni tahmin yazılamaz
const KELIME_COOLDOWN = 5000;    // ms; bir oyuncunun iki tahmini arasında en az
const KELIME_REVEAL = 3000;      // ms; tur başlayınca hedef kelime anlatıcının ekranında kalır
const KELIME_COUNTDOWN = 3000;   // ms; ardından herkeste 3, 2, 1
const KELIME_ROLLS = 6;          // "rastgele": ilk kelime + 5 kez değiştirme
const KELIME_PLAYERS = 6;        // bir anlatıcı + 5 bilen
const KELIME_MAX_LENGTH = 50;
const KELIME_POOL_MAX = 1000;    // odanın kelime havuzundaki en fazla kelime
const KELIME_WORDS_MAX = 200;    // bir turda yazılabilecek en fazla tahmin
const KELIME_TOP = 15;           // puan alan ilk kelime sayısı (1. kelime 15 puan, 15. kelime 1 puan)
const KELIME_NARRATOR = 10;      // anlatıcı: kelime bulunursa +10, bulunamazsa -10
const KELIME_RECENT = 20;        // son çıkan bu kadar kelime tekrar seçilmez (havuz yeterliyse)
const KELIME_COLORS = ['#ff6b6b', '#4dabf7', '#51cf66', '#fcc419', '#cc5de8', '#ff922b', '#20c997'];
// Bot: tek başına oynarken oyunların gidişatını görmek için rastgele oynar (iyi oynamaz).
// Adında emoji olduğu için hiçbir hesabın adıyla çakışmaz.
const BOT = 'Bot 🤖';
const BOT_WORDS = ['ev', 'deniz', 'kitap', 'araba', 'güneş', 'kedi', 'ağaç', 'su', 'ateş', 'telefon', 'müzik', 'okul', 'yol',
  'kahve', 'çay', 'bulut', 'yağmur', 'kar', 'dağ', 'şehir', 'para', 'zaman', 'rüya', 'oyun', 'film', 'renk', 'ışık', 'gece',
  'sabah', 'yemek', 'ekmek', 'elma', 'balık', 'kuş', 'köpek', 'çiçek', 'masa', 'kapı', 'pencere', 'saat', 'ayakkabı', 'şapka',
  'tren', 'uçak', 'gemi', 'futbol', 'şarkı', 'resim', 'kalem', 'defter', 'bilgisayar', 'internet', 'yaz', 'kış', 'bahar',
  'sonbahar', 'dost', 'aile', 'bebek', 'doktor', 'hastane', 'market', 'pazar', 'tatil', 'plaj', 'orman', 'nehir', 'göl'];
const rand = (min, max) => min + Math.random() * (max - min);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

// Oyun önerileri: alan adı -> en fazla uzunluk (istemcideki formla aynı alanlar)
const ONERI_FIELDS = {
  ad: 60, ozet: 200, tur: 40, ilham: 300,
  minOyuncu: 2, maxOyuncu: 2, takim: 60, roller: 1000, ses: 60,
  baslangic: 1000, akis: 2000, bitis: 1000, sure: 20, turSayisi: 200,
  ekran: 2000, pc: 1000, telefon: 1000, zaman: 1000,
  puan: 1500, kazanan: 1000, skorTablosu: 60,
  icerik: 1500, kenar: 1500, notlar: 2000, onem: 2,
};
const ONERI_REQUIRED = ['ad', 'ozet', 'baslangic', 'akis', 'bitis', 'puan'];
const ONERI_STATUS = ['bekliyor', 'eklenecek', 'eklenmeyecek', 'eklendi', 'silindi'];
const ONERI_PER_USER = 20;      // bir kişinin bekleyen en fazla önerisi
const ONERI_COOLDOWN = 20000;   // ms
const ONERI_REFRESH = 60000;    // ms; kayıttaki durum değişiklikleri bu aralıkla okunur
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
// Radyo haritasının istasyon listesi (bir kez indirilir, tarayıcı saklar)
app.get('/radio/stations', async (req, res) => {
  try {
    await (radioPayload ? null : loadRadio());
  } catch {
    return res.status(503).json({ error: 'Radyo listesi şu an alınamıyor.' });
  }
  const { json, gzip, etag } = radioPayload;
  res.set({ 'Cache-Control': 'public, max-age=3600', ETag: etag, 'Content-Type': 'application/json; charset=utf-8', Vary: 'Accept-Encoding' });
  if (req.get('if-none-match') === etag) return res.status(304).end();
  if (/\bgzip\b/.test(req.get('accept-encoding') || '')) return res.set('Content-Encoding', 'gzip').send(gzip);
  res.send(json);
});
// Sayfanın ekranları kendi adresinde açılır (/gecmis, /oyunlar/kelime, /uyeler, /radyo ...); hepsi aynı sayfadır.
app.get(/^\/(gecmis|oyunlar|uyeler|radyo)(\/[\w-]*)*\/?$/, (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
accounts.setup(app, {
  imageTypes: IMAGE_TYPES,
  onProfile: (name, avatar) => io.emit('profile', { name, avatar }),
  online: () => [...(rooms.get('genel')?.users.values() || [])].map((u) => u.name),
});

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
const dinoBoards = new Map(); // oda kodu -> { hold: [{ name, dist, at }], tap: [...] } en iyi skorlar
const kelimePools = new Map(); // oda kodu -> [{ text, by }] kelime oyununun havuzu
const oneriler = []; // oyun önerileri (tek oda var): [{ id, by, at, fields, status, note, updatedAt }]

function getRoom(code) {
  if (!rooms.has(code)) {
    if (!histories.has(code)) histories.set(code, []);
    if (!customSfxByRoom.has(code)) customSfxByRoom.set(code, new Map());
    if (!tierListsByRoom.has(code)) tierListsByRoom.set(code, []);
    if (!dinoBoards.has(code)) dinoBoards.set(code, { auto: [], hold: [], tap: [] });
    if (!kelimePools.has(code)) kelimePools.set(code, []);
    rooms.set(code, {
      code,
      history: histories.get(code),
      customSfx: customSfxByRoom.get(code),
      tierLists: tierListsByRoom.get(code),
      timing: { target: 10, results: [], race: null }, // süre tahmini: sadece hafızada
      dinoBoard: dinoBoards.get(code),
      kelimePool: kelimePools.get(code),
      kelime: null, // kelime oyunu (aşağıda); hedef kelime sadece anlatıcıya gider
      kelimeRecent: [],
      memory: null, // eşini bul (aşağıda)
      radio: null, // odada çalan radyo istasyonu
      memorySeen: new Map(),
      lobbyOpts: {}, // oyun -> son başlatılan lobinin ayarları
      lobbies: {}, // oyun -> { game, host, players, opts } grup oyunlarının lobisi
      bot: false, // açıkken yeni başlayan oyunlara Bot da katılır
      dino: null, // dinozor koşusu: { id, mode, seed, startAt, players: { isim: { dist, dead, seen } }, done, jef }
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
// Odada birden fazla tier list olabilir. Her liste oluşturanındır: kartları, satırları ve adı sadece
// o değiştirir, diğerleri izler. Başkasının listesi şablon gibi kopyalanabilir; kopyada kartlar
// yerleşmemiş gelir, herkes kendi sıralamasını yapar. Listeler oda boşalınca silinmez, kart resimleri
// de sunucu yeniden başlayana kadar hafızada durur.

const cardImages = new Map(); // id -> { buf, type }
let nextTierId = 1; // listeler, satırlar ve kartlar için ortak sayaç

const newTierRow = (name) => ({ id: nextTierId++, name, cards: [] });

// Oda ya da kişi sınırı doluysa hata metni, değilse boş
function tierListFull(room, by) {
  if (room.tierLists.length >= TIERLIST_MAX) return `Odada en fazla ${TIERLIST_MAX} tier list olabilir; eskilerden biri silinmeli.`;
  if (room.tierLists.filter((l) => l.by === by).length >= TIERLIST_PER_USER) return `En fazla ${TIERLIST_PER_USER} tier listin olabilir; birini sil.`;
  return '';
}

function tierListView(list) {
  return {
    id: list.id,
    title: list.title,
    by: list.by,
    from: list.from || null, // kopyalandığı listenin sahibi
    cover: list.cover || null, // listenin kendi kapak resmi; yoksa ilk kartın resmi gösterilir
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

// Kopyalanan listeler aynı resmi paylaşır; resim, odada onu kullanan son kart ya da kapak gidince silinir.
function dropImage(room, image) {
  if (!image) return;
  const used = room.tierLists.some((l) => l.cover === image || [...l.cards.values()].some((c) => c.image === image));
  if (used) return;
  const imageId = image.slice('card-img/'.length);
  cardImages.delete(imageId);
  store.deleteFile(`cards/${imageId}`);
}

// Gelen resmi saklar; adresini, uygun değilse null döner.
function keepImage(data, type) {
  if (!Buffer.isBuffer(data) || data.length > CARD_IMAGE_MAX_BYTES || !IMAGE_TYPES[type]?.(data)) return null;
  const imageId = crypto.randomUUID();
  cardImages.set(imageId, { buf: data, type });
  store.putFile(`cards/${imageId}`, data, type);
  return `card-img/${imageId}`;
}

function deleteCard(room, list, cardId) {
  takeCard(list, cardId);
  const card = list.cards.get(cardId);
  list.cards.delete(cardId);
  dropImage(room, card?.image);
}

io.on('connection', (socket) => {
  let code = null;

  socket.on('time', (ack) => typeof ack === 'function' && ack(Date.now()));

  // İsim hesaptan gelir; herkes kendi hesabıyla girer.
  socket.on('join', ({ token, clientId } = {}, ack) => {
    if (typeof ack !== 'function' || code) return;
    const roomCode = 'genel'; // tek oda var
    clientId = String(clientId || '').slice(0, 64);
    const account = accounts.accountByToken(token);
    if (!account) return ack({ error: 'Oturumun kapanmış, tekrar giriş yap.', auth: true });
    accounts.seen(account.key);
    const { name } = account;

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
    ack({ id: socket.id, peers, media: mediaState(room), sharer: room.sharer, chat: room.chat, history: room.history, customSfx: customSfxList(room), tierLists: room.tierLists.map(tierListView), timing: room.timing, dino: room.dino, dinoBoard: room.dinoBoard, bot: room.bot, oneriler: oneriView(), kelimePool: room.kelimePool, kelime: kelimeView(room.kelime, name), memory: memoryView(room.memory), radio: radioView(room), lobbies: room.lobbies, profiles: accounts.profiles() });
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

  // Tier list olayları listenin kimliğiyle gelir; liste yoksa ya da başkasınınsa yok sayılır.
  const withList = (listId, fn) => {
    if (!code) return;
    const room = getRoom(code);
    const list = room.tierLists.find((l) => l.id === listId);
    if (!list || list.by !== room.users.get(socket.id).name) return;
    if (fn(list, room) !== false) broadcastTierLists(room);
  };
  const cleanText = (text, max) => (typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, max) : '');

  socket.on('tierlist:create', (title, ack) => {
    if (!code || typeof ack !== 'function') return;
    const room = getRoom(code);
    title = cleanText(title, TIERLIST_TITLE_MAX);
    if (!title) return ack({ error: 'Listeye bir isim ver.' });
    const by = room.users.get(socket.id).name;
    const full = tierListFull(room, by);
    if (full) return ack({ error: full });
    const list = { id: nextTierId++, title, by, tiers: DEFAULT_TIERS.map(newTierRow), pool: [], cards: new Map() };
    room.tierLists.push(list);
    broadcastTierLists(room);
    socket.to(code).emit('notice', `${by} yeni tier list oluşturdu: ${title}`);
    ack({ id: list.id });
  });

  // Kendine al: aynı başlık, satır adları ve kartlarla yeni bir liste; kartlar yerleşmemiş gelir.
  socket.on('tierlist:copy', (listId, ack) => {
    if (!code || typeof ack !== 'function') return;
    const room = getRoom(code);
    const from = room.tierLists.find((l) => l.id === listId);
    if (!from) return ack({ error: 'Bu liste silinmiş.' });
    const by = room.users.get(socket.id).name;
    const full = tierListFull(room, by);
    if (full) return ack({ error: full });
    const order = [...from.tiers.flatMap((t) => t.cards), ...from.pool];
    const list = { id: nextTierId++, title: from.title, by, from: from.by, cover: from.cover || null, tiers: from.tiers.map((t) => newTierRow(t.name)), pool: [], cards: new Map() };
    for (const oldId of order) {
      const card = from.cards.get(oldId);
      if (!card) continue;
      const copy = { ...card, id: nextTierId++ };
      list.cards.set(copy.id, copy);
      list.pool.push(copy.id);
    }
    room.tierLists.push(list);
    broadcastTierLists(room);
    ack({ id: list.id });
  });

  socket.on('tierlist:delete', (listId) => withList(listId, (list, room) => {
    room.tierLists.splice(room.tierLists.indexOf(list), 1);
    for (const id of [...list.cards.keys()]) deleteCard(room, list, id);
    dropImage(room, list.cover);
  }));

  // Kapak: data null ise kapak kaldırılır (ilk kartın resmine döner).
  socket.on('tierlist:cover', ({ listId, data, type } = {}, ack) => {
    if (typeof ack !== 'function') return;
    if (!code) return ack({ error: 'Odada değilsin.' });
    if (Date.now() - lastCard < CARD_COOLDOWN) return ack({ error: 'Biraz bekle, çok hızlı ekliyorsun.' });
    const room = getRoom(code);
    const list = room.tierLists.find((l) => l.id === listId);
    if (!list) return ack({ error: 'Bu liste silinmiş.' });
    if (list.by !== room.users.get(socket.id).name) return ack({ error: 'Bu liste senin değil.' });
    let cover = null;
    if (data != null && !(cover = keepImage(data, type))) return ack({ error: 'Bu resim eklenemedi (desteklenmeyen tür ya da çok büyük).' });
    lastCard = Date.now();
    withList(listId, (l, room) => {
      const old = l.cover;
      l.cover = cover;
      dropImage(room, old);
    });
    ack({});
  });

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
    const room = getRoom(code);
    const list = room.tierLists.find((l) => l.id === listId);
    if (!list) return ack({ error: 'Bu liste silinmiş.' });
    if (list.by !== room.users.get(socket.id).name) return ack({ error: 'Bu liste senin değil; kendine alıp düzenleyebilirsin.' });
    if (list.cards.size >= CARD_MAX) return ack({ error: `Bir listede en fazla ${CARD_MAX} kart olabilir.` });
    text = cleanText(text, CARD_TEXT_MAX);
    let image = null;
    if (data != null && !(image = keepImage(data, type))) return ack({ error: 'Bu resim eklenemedi (desteklenmeyen tür ya da çok büyük).' });
    if (!text && !image) return ack({ error: 'Karta bir isim yaz ya da resim seç.' });
    lastCard = Date.now();
    withList(listId, (l, room) => {
      const card = { id: nextTierId++, text, image, by: room.users.get(socket.id).name };
      l.cards.set(card.id, card);
      l.pool.push(card.id);
    });
    ack({});
  });

  socket.on('card:remove', ({ listId, cardId } = {}) => withList(listId, (list, room) => {
    if (!list.cards.has(cardId)) return false;
    deleteCard(room, list, cardId);
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

  // ---------- Lobi ----------
  // Grup oyunları (süre yarışı, dinozor, kelime) lobiyle başlar: biri lobi kurar, isteyen girer ya da çıkar,
  // kuran başlatınca oyun lobideki ekiple başlar. Lobide olmayanlar oyunu izler.

  const lobbyAction = (fn) => (arg = {}) => {
    if (!code || !LOBBY_GAMES[arg.game]) return;
    const room = getRoom(code);
    fn(room, room.users.get(socket.id).name, arg.game, arg);
  };
  const lobbyError = (text) => socket.emit('notice', text);

  // again: biten oyunun ekibi (odada olanlar) lobiye hazır girer.
  socket.on('lobby:open', lobbyAction((room, name, game, { again }) => {
    if (room.lobbies[game]) return lobbyError('Bu oyunun lobisi zaten açık.');
    if (gameRunning(room, game)) return lobbyError('Bu oyun sürüyor; bitince yeni lobi kurulabilir.');
    const players = [name, ...(again ? lastPlayers(room, game).filter((n) => n !== name && n !== BOT) : [])].slice(0, LOBBY_GAMES[game].max);
    if (room.bot && players.length < LOBBY_GAMES[game].max) players.push(BOT);
    // Ayarlar (tur sayısı, tahta) son başlatılan lobiden kalır; kelimede anlatıcı her seferinde yeniden seçilir.
    const opts = { ...LOBBY_GAMES[game].opts, ...(game === 'kelime' ? {} : room.lobbyOpts[game]) };
    room.lobbies[game] = { game, host: name, players, opts };
    sendLobbies(room);
    postSystem(room, `${name} ${LOBBY_GAMES[game].label} lobisi kurdu; katılmak isteyen girsin.`);
  }));

  socket.on('lobby:join', lobbyAction((room, name, game) => {
    const lobby = room.lobbies[game];
    if (!lobby || lobby.players.includes(name)) return;
    if (lobby.players.length >= LOBBY_GAMES[game].max) return lobbyError(`Lobi dolu (en fazla ${LOBBY_GAMES[game].max} kişi).`);
    lobby.players.push(name);
    sendLobbies(room);
  }));

  socket.on('lobby:leave', lobbyAction((room, name, game) => leaveLobby(room, game, name)));

  // Kurallar: tur sayısı (yarış) kuranındır; kelimede anlatıcı koltuğunu lobideki herkes alabilir.
  socket.on('lobby:opts', lobbyAction((room, name, game, { rounds, narrator, numbers, colors }) => {
    const lobby = room.lobbies[game];
    if (!lobby?.players.includes(name)) return;
    if (game === 'race' && name === lobby.host && RACE_ROUNDS.includes(rounds)) lobby.opts.rounds = rounds;
    if (game === 'memory' && name === lobby.host) {
      const set = memoryBoard(numbers ?? lobby.opts.numbers, colors ?? lobby.opts.colors);
      if (!set) return;
      Object.assign(lobby.opts, set);
    }
    if (game === 'kelime' && narrator !== undefined) {
      const who = narrator === 'bot' ? BOT : narrator === 'me' ? name : null;
      if (who && !lobby.players.includes(who)) return;
      if (who && lobby.opts.narrator && lobby.opts.narrator !== who) return lobbyError(`Anlatıcı ${lobby.opts.narrator} oldu.`);
      if (!who && lobby.opts.narrator !== name && lobby.opts.narrator !== BOT) return;
      lobby.opts.narrator = who;
    }
    sendLobbies(room);
  }));

  socket.on('lobby:start', lobbyAction((room, name, game) => {
    const lobby = room.lobbies[game];
    if (!lobby || lobby.host !== name) return;
    if (lobby.players.length < LOBBY_GAMES[game].min) return lobbyError(`Bu oyun için lobide en az ${LOBBY_GAMES[game].min} kişi olmalı${room.bot ? '' : '; tek başınaysan botu ekle'}.`);
    if (gameRunning(room, game)) return;
    delete room.lobbies[game];
    room.lobbyOpts[game] = lobby.opts;
    sendLobbies(room);
    LOBBY_GAMES[game].start(room, name, lobby.players, lobby.opts);
  }));

  socket.on('lobby:cancel', lobbyAction((room, name, game) => {
    if (room.lobbies[game]?.host !== name) return;
    delete room.lobbies[game];
    sendLobbies(room);
  }));

  // ---------- Eşini bul ----------

  socket.on('memory:flip', (id) => {
    if (!code || !Number.isInteger(id)) return;
    const room = getRoom(code);
    memoryFlip(room, room.users.get(socket.id).name, id);
  });

  socket.on('memory:end', () => {
    if (!code) return;
    const room = getRoom(code);
    const name = room.users.get(socket.id).name;
    if (!room.memory || room.memory.done || !room.memory.players.includes(name)) return;
    finishMemory(room, `${name} oyunu bitirdi.`);
  });

  socket.on('memory:close', () => {
    if (!code) return;
    const room = getRoom(code);
    if (!room.memory?.done) return;
    room.memory = null;
    sendMemory(room);
  });

  // ---------- Radyo ----------
  // Seçilen istasyon odanın ortak radyosudur; Radyo sayfasındaki herkes onu dinler.

  let lastRadio = 0;
  const radioAction = (fn) => (...args) => {
    if (!code || Date.now() - lastRadio < RADIO_COOLDOWN) return;
    lastRadio = Date.now();
    const room = getRoom(code);
    fn(room, room.users.get(socket.id).name, ...args);
  };

  socket.on('radio:play', radioAction((room, name, id) => {
    const station = radioStations.get(id);
    if (station && room.radio?.id !== id) setRadio(room, station, name);
  }));

  socket.on('radio:random', radioAction((room, name) => {
    if (!radioStations.size) return socket.emit('notice', 'Radyo listesi yükleniyor, birazdan tekrar dene.');
    setRadio(room, pick([...radioStations.values()]), name);
  }));

  socket.on('radio:stop', radioAction((room, name) => {
    if (!room.radio) return;
    room.radio = null;
    io.to(room.code).emit('radio', null);
    postSystem(room, `📻 ${name} radyoyu kapattı`);
  }));

  // ---------- Süre tahmini ----------
  // Süreyi oyuncunun tarayıcısı ölçer; sunucu sadece sonuçları odaya dağıtır.

  socket.on('timing:target', (target) => {
    if (!code) return;
    const room = getRoom(code);
    if (target === 'random') {
      const [min, max] = TIMING_RANDOM;
      target = min + Math.floor(Math.random() * (max - min + 1));
    }
    if (!Number.isInteger(target) || target < TIMING_TARGET_MIN || target > TIMING_TARGET_MAX) return;
    room.timing.target = target;
    io.to(code).emit('timing', room.timing);
    socket.to(code).emit('notice', `${room.users.get(socket.id).name} süre tahmini hedefini ${target} sn yaptı`);
  });

  let lastTiming = 0;
  socket.on('timing:result', ({ elapsed, target } = {}) => {
    if (!code || Date.now() - lastTiming < TIMING_COOLDOWN) return;
    if (!Number.isFinite(elapsed) || elapsed <= 0 || elapsed > 10 * 60 * 1000) return;
    if (!Number.isInteger(target) || target < TIMING_TARGET_MIN || target > TIMING_TARGET_MAX) return;
    lastTiming = Date.now();
    const room = getRoom(code);
    room.timing.results.push({ name: room.users.get(socket.id).name, target, elapsed: Math.round(elapsed), at: Date.now() });
    if (room.timing.results.length > TIMING_RESULTS) room.timing.results.shift();
    io.to(code).emit('timing', room.timing);
  });

  // Yarış: turlar herkeste aynı anda başlar (ortak geri sayımdan sonra), herkes sadece durdurur.
  // Herkes durdurunca ya da süre dolunca tur kapanır, sonuçlar açılır, sonraki tur kendiliğinden gelir.

  socket.on('race:result', ({ id, round, elapsed } = {}) => {
    if (!code) return;
    const room = getRoom(code);
    const race = room.timing.race;
    if (!race || race.done || race.id !== id || round !== race.round || race.revealUntil) return;
    const name = room.users.get(socket.id).name;
    const mine = race.scores[name];
    if (!mine || mine.length !== round || Date.now() < race.roundStart - 500) return;
    if (!Number.isFinite(elapsed) || elapsed <= 0 || elapsed > raceRoundTime(race)) return;
    mine.push(Math.round(elapsed));
    io.to(code).emit('timing', room.timing);
    checkRaceRound(room);
  });

  socket.on('race:end', () => {
    if (!code) return;
    const room = getRoom(code);
    const name = room.users.get(socket.id).name;
    if (!room.timing.race || room.timing.race.done || !room.timing.race.players.includes(name)) return;
    finishRace(room, name);
  });

  socket.on('race:close', () => {
    if (!code) return;
    const room = getRoom(code);
    if (!room.timing.race?.done) return;
    room.timing.race = null;
    io.to(code).emit('timing', room.timing);
  });

  // ---------- Dinozor koşusu ----------
  // Engeller tohumdan (seed) herkesin tarayıcısında aynı üretilir. Her oyuncu kendi dinozorunu
  // kendi tarayıcısında oynatır, konumunu sunucu üzerinden diğerlerine yollar.

  // Tek mod: hız otomatik, oyuncu sadece zıplar ve eğilir. (Eski 'hold' ve 'tap' modlarının skorları
  // kayıtta ayrı durur; tıklama modu ileride "Tavus kuşu" oyunu olacak.)
  // Zıplama/eğilme anında (ev) güvenilir, arada düzeltme için volatile gelir. Diğerleri bu anlık
  // durumdan (oyun saati t, y, dikey hız vy) fiziği kendileri sürdürür; gecikme konumu kaydırmaz.
  socket.on('dino:state', ({ id, x, t, y, vy, duck, hold, ev } = {}) => {
    if (!code || ![x, t, y, vy].every(Number.isFinite)) return;
    const room = getRoom(code);
    const name = room.users.get(socket.id).name;
    const me = room.dino?.id === id && room.dino.players[name];
    if (!me || me.dead) return;
    me.dist = Math.max(me.dist, Math.min(x, dinoJefNow(room.dino))); // Jef'ten ileri gidilemez
    me.seen = Date.now();
    const pos = { name, t, y, vy, duck: Boolean(duck), hold: Boolean(hold) };
    if (ev) socket.to(code).emit('dino:pos', pos);
    else socket.to(code).volatile.emit('dino:pos', pos);
  });

  socket.on('dino:dead', ({ id, x } = {}) => {
    if (!code) return;
    const room = getRoom(code);
    if (room.dino?.id !== id) return;
    killDino(room, room.users.get(socket.id).name, x);
  });

  socket.on('bot:set', (on) => {
    if (!code) return;
    const room = getRoom(code);
    if (room.bot === Boolean(on)) return;
    room.bot = Boolean(on);
    io.to(code).emit('bot', room.bot);
    // Açık lobilere girer ya da çıkar; kelimede anlatıcıysa oyundan ayrılmış sayılır.
    for (const [game, lobby] of Object.entries(room.lobbies)) {
      if (!room.bot) leaveLobby(room, game, BOT);
      else if (!lobby.players.includes(BOT) && lobby.players.length < LOBBY_GAMES[game].max) lobby.players.push(BOT);
    }
    sendLobbies(room);
    if (!room.bot) kelimeLeft(room, BOT);
    kelimeBotLater(room);
    postSystem(room, `${room.users.get(socket.id).name} botu ${room.bot ? 'ekledi; lobilere katılır' : 'çıkardı'}`);
  });

  // ---------- Oyun önerileri ----------

  let lastOneri = 0;
  socket.on('oneri:add', (data, ack) => {
    if (!code || typeof ack !== 'function' || !data || typeof data !== 'object') return;
    const by = getRoom(code).users.get(socket.id).name;
    if (Date.now() - lastOneri < ONERI_COOLDOWN) return ack({ error: 'Biraz bekleyip tekrar gönder.' });
    if (oneriler.filter((o) => o.by === by && o.status === 'bekliyor').length >= ONERI_PER_USER) {
      return ack({ error: `En fazla ${ONERI_PER_USER} bekleyen önerin olabilir.` });
    }
    const fields = {};
    for (const [key, max] of Object.entries(ONERI_FIELDS)) {
      const value = typeof data[key] === 'string' ? data[key].trim().slice(0, max) : '';
      if (value) fields[key] = value;
    }
    const missing = ONERI_REQUIRED.filter((k) => !fields[k]);
    if (missing.length) return ack({ error: 'Zorunlu alanlar boş.', missing });
    lastOneri = Date.now();
    const now = Date.now();
    oneriler.push({ id: crypto.randomUUID(), by, at: now, fields, status: 'bekliyor', note: '', updatedAt: now });
    saveOneriler();
    io.emit('oneriler', oneriView());
    ack({ ok: true });
  });

  // Kişi sadece kendi bekleyen önerisini geri çekebilir.
  socket.on('oneri:remove', (id) => {
    if (!code) return;
    const by = getRoom(code).users.get(socket.id).name;
    const o = oneriler.find((x) => x.id === id);
    if (!o || o.by !== by || o.status !== 'bekliyor') return;
    Object.assign(o, { status: 'silindi', updatedAt: Date.now() });
    saveOneriler();
    io.emit('oneriler', oneriView());
  });

  // ---------- Kelime ----------
  // Oyun kurulunca odadakiler "anlat" ya da "bil" seçer. Her tur bir anlatıcı hedef kelimeyi seçer ve görür;
  // bilenler tahmin yazar, anlatıcı her tahmini sıcak-soğuk çubuğuna yerleştirir (pos: 0 en soğuk, 1 en sıcak).
  // Herkes bir kez anlatınca oyun biter.

  const kelimeGame = (fn) => (...args) => {
    if (!code) return;
    const room = getRoom(code);
    const game = room.kelime;
    if (!game || game.phase === 'done') return;
    fn(game, room, room.users.get(socket.id).name, ...args);
  };

  socket.on('kelime:pool:add', (text) => {
    if (!code || typeof text !== 'string') return;
    const room = getRoom(code);
    const by = room.users.get(socket.id).name;
    const have = new Set(room.kelimePool.map((w) => kelimeKey(w.text)));
    let added = 0;
    for (const raw of text.slice(0, 200000).split(/[,;\t\n]/)) {
      const word = kelimeClean(raw);
      if (!word || have.has(kelimeKey(word)) || room.kelimePool.length >= KELIME_POOL_MAX) continue;
      have.add(kelimeKey(word));
      room.kelimePool.push({ text: word, by });
      added++;
    }
    if (!added) return;
    saveKelimePool(room);
    io.to(code).emit('kelime:pool', room.kelimePool);
  });

  socket.on('kelime:pool:remove', (text) => {
    if (!code || typeof text !== 'string') return;
    const room = getRoom(code);
    const i = room.kelimePool.findIndex((w) => w.text === text);
    if (i < 0) return;
    room.kelimePool.splice(i, 1);
    saveKelimePool(room);
    io.to(code).emit('kelime:pool', room.kelimePool);
  });

  // Anlatıcı kelimeyi kendisi yazar ya da havuzdan rastgele çeker; sadece kendisi görür.
  socket.on('kelime:word', kelimeGame((game, room, name, text) => {
    if (game.phase !== 'pick' || name !== game.narrator || typeof text !== 'string') return;
    const word = kelimeClean(text);
    if (!word) return;
    game.target = word;
    sendKelime(room);
  }));

  socket.on('kelime:roll', kelimeGame((game, room, name) => {
    if (game.phase !== 'pick' || name !== game.narrator) return;
    const error = kelimeRoll(room);
    if (error) socket.emit('notice', error);
  }));

  socket.on('kelime:begin', kelimeGame((game, room, name) => {
    if (game.phase !== 'pick' || name !== game.narrator || !game.target) return;
    if (game.players.length < 2) return socket.emit('notice', 'En az bir kişinin "bil" seçmesi gerekli.');
    kelimeBegin(room);
  }));

  socket.on('kelime:guess', kelimeGame((game, room, name, text) => {
    const error = kelimeGuess(room, name, text);
    if (error) socket.emit('notice', error);
  }));

  // Anlatıcı sürüklerken kelimenin yeri diğerlerine anlık gider (kaydedilmez).
  socket.on('kelime:drag', kelimeGame((game, room, name, { id, pos } = {}) => {
    if (!kelimePlacing(game, name) || !(pos === null || Number.isFinite(pos))) return;
    // pos null: sürükleme bırakıldı, kelime yerleştirilmedi
    socket.to(code).volatile.emit('kelime:drag', { gameId: game.id, id, pos: pos === null ? null : Math.min(1, Math.max(0, pos)) });
  }));

  // Gelen kelimeler de çubuktakiler de tur boyunca yerleştirilebilir.
  socket.on('kelime:place', kelimeGame((game, room, name, { id, pos } = {}) => {
    if (!kelimePlacing(game, name) || !Number.isFinite(pos)) return;
    const w = game.words.find((x) => x.id === id);
    if (!w) return;
    w.pos = Math.min(1, Math.max(0, pos));
    w.until = null;
    sendKelime(room);
    kelimeBotLater(room);
  }));

  // Yanlış yazılmış kelime çöpe atılır; yazan doğrusunu yeniden yazabilir.
  socket.on('kelime:trash', kelimeGame((game, room, name, id) => {
    if (!kelimePlacing(game, name)) return;
    const i = game.words.findIndex((x) => x.id === id);
    if (i < 0) return;
    game.words.splice(i, 1);
    sendKelime(room);
    kelimeBotLater(room);
  }));

  socket.on('kelime:stop', kelimeGame((game, room, name) => {
    if (game.phase !== 'play' || name !== game.narrator) return;
    endKelimeRound(room, `${name} turu bitirdi.`);
  }));

  // Oyunculardan biri oyunu bitirebilir; süren tur sayılmaz.
  socket.on('kelime:end', kelimeGame((game, room, name) => {
    if (!kelimePlayer(game, name)) return;
    finishKelime(room, `${name} kelime oyununu bitirdi.`);
  }));

  socket.on('kelime:close', () => {
    if (!code) return;
    const room = getRoom(code);
    if (room.kelime?.phase !== 'done') return;
    room.kelime = null;
    sendKelime(room);
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
      if (current) checkRaceRound(current); // çıkan kişi durdurmamışsa kalanlar beklemesin
      if (current) killDino(current, user.name);
      if (current) kelimeLeft(current, user.name);
      if (current) memoryLeft(current, user.name);
      if (current) for (const game of Object.keys(current.lobbies)) leaveLobby(current, game, user.name);
    }, REJOIN_GRACE));
    if (room.users.size === 0) {
      clearKelimeTimers(code);
      clearMemoryTimers(code);
      rooms.delete(code);
      deleteRoomImages(code);
    }
  });
});

// ---------- Süre yarışı ----------

const raceTimers = new Map(); // oda kodu -> zamanlayıcı (yarış nesnesi odaya gönderildiği için onun içinde tutulmaz)
// ---------- Lobi ----------

const lobbyHere = (room) => {
  const here = new Set([...room.users.values()].map((u) => u.name));
  if (room.bot) here.add(BOT);
  return here;
};

// Oyun sürerken aynı oyunun lobisi kurulamaz, başlatılamaz.
function gameRunning(room, game) {
  if (game === 'race') return Boolean(room.timing.race && !room.timing.race.done);
  if (game === 'dino') return Boolean(room.dino && !room.dino.done && Date.now() - room.dino.startAt < DINO_MAX_TIME);
  if (game === 'memory') return Boolean(room.memory && !room.memory.done);
  return Boolean(room.kelime && room.kelime.phase !== 'done');
}

// Son oynanan oyunun ekibinden odada olanlar ("aynı ekiple tekrar")
function lastPlayers(room, game) {
  const names = game === 'race' ? room.timing.race?.players
    : game === 'dino' ? room.dino && Object.keys(room.dino.players)
      : game === 'memory' ? room.memory?.players
        : room.kelime?.players.map((p) => p.name);
  const here = lobbyHere(room);
  return (names || []).filter((n) => here.has(n));
}

function sendLobbies(room) {
  io.to(room.code).emit('lobbies', room.lobbies);
}

// Kuran çıkarsa lobideki sıradaki kişi kurucu olur; içeride kimse kalmazsa lobi kapanır.
function leaveLobby(room, game, name) {
  const lobby = room.lobbies[game];
  if (!lobby?.players.includes(name)) return;
  lobby.players = lobby.players.filter((n) => n !== name);
  if (lobby.opts.narrator === name) lobby.opts.narrator = null;
  if (lobby.host === name) lobby.host = lobby.players.find((n) => n !== BOT) || null;
  if (!lobby.host) delete room.lobbies[game];
  sendLobbies(room);
}

const LOBBY_GAMES = {
  race: { label: 'süre yarışı', min: 1, max: MAX_USERS + 1, opts: { rounds: 5 }, start: (room, by, players, opts) => startRace(room, by, players, opts.rounds) },
  dino: { label: 'dinozor', min: 1, max: MAX_USERS + 1, opts: {}, start: (room, by, players) => startDino(room, by, players) },
  memory: { label: 'Eşini Bul', min: 1, max: MAX_USERS + 1, opts: { numbers: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], colors: ['yesil', 'turuncu', 'mavi', 'kirmizi'] }, start: (room, by, players, opts) => startMemory(room, by, players, opts) },
  kelime: { label: 'kelime', min: 2, max: KELIME_PLAYERS, opts: { narrator: null }, start: (room, by, players, opts) => startKelime(room, by, players, opts.narrator) },
};

// Lobiden gelen ekiple başlar.
function startRace(room, by, players, rounds) {
  const [min, max] = RACE_TARGETS;
  const targets = Array.from({ length: rounds }, () => min + Math.floor(Math.random() * (max - min + 1)));
  room.timing.race = {
    id: Date.now(), by, targets, players, scores: Object.fromEntries(players.map((n) => [n, []])),
    round: 0, ended: 0, roundStart: 0, revealUntil: null, done: false,
  };
  postSystem(room, `${by} ${rounds} turluk süre yarışını başlattı: ${players.join(', ')}`);
  startRaceRound(room, 0);
}

const raceDiff = (race, ms, i) => (ms == null ? RACE_MISS : Math.abs(ms - race.targets[i] * 1000));
const raceTotal = (race, name) => race.scores[name].slice(0, race.ended).reduce((sum, ms, i) => sum + raceDiff(race, ms, i), 0);
// Durdurmak için verilen süre: hedefin iki katı + 5 sn
const raceRoundTime = (race) => race.targets[race.round] * 2000 + 5000;

function raceTimer(room, ms, fn) {
  clearTimeout(raceTimers.get(room.code));
  raceTimers.set(room.code, setTimeout(fn, ms));
}

function startRaceRound(room, i) {
  const race = room.timing.race;
  Object.assign(race, { round: i, roundStart: Date.now() + RACE_COUNTDOWN, revealUntil: null });
  io.to(room.code).emit('timing', room.timing);
  raceTimer(room, RACE_COUNTDOWN + raceRoundTime(race), () => endRaceRound(room));
  // Bot hedefin ±1,5 sn yakınında durdurur.
  if (race.scores[BOT]) {
    const elapsed = Math.max(300, race.targets[i] * 1000 + rand(-1500, 1500));
    setTimeout(() => {
      if (room.timing.race !== race || race.done || race.round !== i || race.revealUntil || race.scores[BOT].length !== i) return;
      race.scores[BOT].push(Math.round(elapsed));
      io.to(room.code).emit('timing', room.timing);
      checkRaceRound(room);
    }, RACE_COUNTDOWN + elapsed);
  }
}

// Odada olan oyuncuların hepsi durdurduysa tur kapanır.
function checkRaceRound(room) {
  const race = room.timing.race;
  if (!race || race.done || race.revealUntil) return;
  const here = new Set([...room.users.values()].map((u) => u.name));
  here.add(BOT);
  if (race.players.filter((n) => here.has(n)).every((n) => race.scores[n].length > race.round)) endRaceRound(room);
}

function endRaceRound(room) {
  const race = room.timing.race;
  if (!race || race.done || race.revealUntil) return;
  for (const n of race.players) if (race.scores[n].length === race.round) race.scores[n].push(null); // durdurmadı
  race.ended = race.round + 1;
  race.revealUntil = Date.now() + RACE_REVEAL;
  if (race.ended === race.targets.length) return finishRace(room);
  io.to(room.code).emit('timing', room.timing);
  raceTimer(room, RACE_REVEAL, () => startRaceRound(room, race.round + 1));
}

// Kazanan, biten turlardaki toplam farkı en az olandır.
function finishRace(room, endedBy) {
  const race = room.timing.race;
  clearTimeout(raceTimers.get(room.code));
  race.done = true;
  io.to(room.code).emit('timing', room.timing);
  const prefix = endedBy ? `${endedBy} yarışı bitirdi. ` : 'Süre yarışı bitti! ';
  if (!race.ended) return postSystem(room, `${prefix}Biten tur olmadı.`);
  const ranked = [...race.players].sort((a, b) => raceTotal(race, a) - raceTotal(race, b));
  const best = raceTotal(race, ranked[0]);
  const winners = ranked.filter((n) => raceTotal(race, n) === best);
  const secs = (best / 1000).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  postSystem(room, `${prefix}🏆 Kazanan: ${winners.join(', ')} (toplam ${secs} sn fark)`);
}

// ---------- Oyun önerileri ----------
// Durumları (eklenecek / eklenmeyecek / eklendi) site sahibi kayıttan değiştirir. Hem bilgisayardaki hem canlı
// sunucu aynı kaydı kullandığından yazmadan önce kayıttakiyle birleştirilir: her öneride en son değişen sürüm kalır.
// Silinen öneri de "silindi" olarak kalır, yoksa birleştirmede geri gelirdi.

const oneriView = () => oneriler.filter((o) => o.status !== 'silindi');

function mergeOneriler(from) {
  if (!Array.isArray(from)) return false;
  let changed = false;
  for (const o of from) {
    const i = oneriler.findIndex((x) => x.id === o.id);
    if (i < 0) oneriler.push(o);
    else if ((o.updatedAt || 0) > (oneriler[i].updatedAt || 0)) oneriler[i] = o;
    else continue;
    changed = true;
  }
  oneriler.sort((a, b) => a.at - b.at);
  return changed;
}

async function readOneriler() {
  if (!store.enabled) return false;
  try {
    const [row] = await store.select('room_state', 'room=eq.genel&kind=eq.oneriler&select=data');
    return mergeOneriler(row?.data);
  } catch (err) {
    console.warn('öneri okuma', err.message);
    return false;
  }
}

async function saveOneriler() {
  await readOneriler();
  store.save('genel', 'oneriler', () => oneriler);
}

setInterval(async () => {
  if (await readOneriler()) io.emit('oneriler', oneriView());
}, ONERI_REFRESH);

// ---------- Kelime ----------

const kelimeClean = (text) => String(text).replace(/\s+/g, ' ').trim().slice(0, KELIME_MAX_LENGTH);
// Karşılaştırma büyük/küçük harfe ve Türkçe i/ı'ya duyarsız değil: "Işık" = "ışık", ama "isik" değil.
const kelimeKey = (text) => kelimeClean(text).toLocaleLowerCase('tr');
const saveKelimePool = (room) => store.save(room.code, 'kelimeler', () => room.kelimePool);
const kelimePlayer = (game, name) => game.players.some((p) => p.name === name);
// Anlatıcı geri sayım bitince kelimeleri yerleştirebilir.
const kelimePlacing = (game, name) => game.phase === 'play' && name === game.narrator && Date.now() >= game.startAt;
const kelimeUnplaced = (game) => game.words.filter((w) => w.pos == null).length;

// Her oyuncunun kendi rengi olur; kelimeler yazanın renginde görünür.
function kelimeJoin(game, name) {
  if (kelimePlayer(game, name)) return true;
  if (game.players.length >= KELIME_PLAYERS) return false;
  const used = new Set(game.players.map((p) => p.color));
  game.players.push({ name, color: KELIME_COLORS.find((c) => !used.has(c)) });
  return true;
}

// Lobiden gelen ekiple başlar; anlatıcı koltuğunu alan yoksa lobiyi kuran ilk turu anlatır.
function startKelime(room, by, names, narrator) {
  const game = {
    id: Date.now(), phase: 'pick', round: 1, players: [], narrator: null, narrated: [],
    target: null, rolls: 0, seen: [], startAt: null, endAt: null,
    words: [], nextId: 1, lastGuess: {}, found: null, rounds: [], totals: [],
  };
  for (const n of names) kelimeJoin(game, n);
  game.narrator = names.includes(narrator) ? narrator : by;
  room.kelime = game;
  sendKelime(room);
  kelimeBotLater(room);
  postSystem(room, `${by} kelime oyununu başlattı: ${names.join(', ')}. İlk anlatıcı ${game.narrator}.`);
}

// Hedef kelime (ve anlatıcının çektiği rastgele kelimeler) tur bitene kadar sadece anlatıcıya gönderilir.
function kelimeView(game, name) {
  if (!game) return null;
  if (name === game.narrator) return game;
  return { ...game, target: null, seen: [] };
}

function sendKelime(room) {
  for (const [id, user] of room.users) io.to(id).emit('kelime', kelimeView(room.kelime, user.name));
}

const kelimeTimers = new Map(); // `${oda}:${tür}` -> zamanlayıcı

function kelimeTimer(room, kind, ms, fn) {
  const key = `${room.code}:${kind}`;
  clearTimeout(kelimeTimers.get(key));
  kelimeTimers.set(key, setTimeout(() => {
    kelimeTimers.delete(key);
    if (rooms.get(room.code) === room) fn();
  }, ms));
}

function clearKelimeTimers(code) {
  for (const kind of ['game', 'start', 'turn', 'bot']) {
    clearTimeout(kelimeTimers.get(`${code}:${kind}`));
    kelimeTimers.delete(`${code}:${kind}`);
  }
}

// Havuzdan daha önce çekilmemiş (mümkünse son oyunlarda da çıkmamış) bir kelime. Hata varsa açıklamasını döner.
function kelimeRoll(room) {
  const game = room.kelime;
  if (!room.kelimePool.length) return 'Havuz boş; kelimeyi kendin yaz ya da havuza kelime ekle.';
  if (game.rolls >= KELIME_ROLLS) return 'Rastgele hakkın bitti; çıkanlardan birini seç ya da kendin yaz.';
  const options = room.kelimePool.filter((w) => !game.seen.includes(kelimeKey(w.text)));
  if (!options.length) return 'Havuzda başka kelime kalmadı.';
  const fresh = options.filter((w) => !room.kelimeRecent.includes(kelimeKey(w.text)));
  const word = pick(fresh.length ? fresh : options).text;
  game.target = word;
  game.seen.push(kelimeKey(word));
  game.rolls++;
  sendKelime(room);
  return null;
}

// Hedef kelime 3 sn anlatıcıda kalır, sonra herkeste 3-2-1; ardından tur 7 dk sürer.
function kelimeBegin(room) {
  const game = room.kelime;
  const now = Date.now();
  const keep = Math.min(KELIME_RECENT, room.kelimePool.length - 1);
  room.kelimeRecent = keep > 0 ? [...room.kelimeRecent, kelimeKey(game.target)].slice(-keep) : [];
  game.startAt = now + KELIME_REVEAL + KELIME_COUNTDOWN;
  game.endAt = game.startAt + KELIME_TIME;
  Object.assign(game, { phase: 'play', words: [], nextId: 1, lastGuess: {}, found: null });
  game.narrated.push(game.narrator);
  kelimeTimer(room, 'start', game.startAt - now, () => {
    sendKelime(room);
    kelimeBotLater(room);
  });
  kelimeTimer(room, 'game', game.endAt - now, () => endKelimeRound(room, 'Süre doldu.'));
  sendKelime(room);
  postSystem(room, `Kelime ${game.round}. tur başlıyor; anlatıcı ${game.narrator}.`);
}

// Tahmin: hedefse tur biter, değilse anlatıcının yerleştireceği kelimelere eklenir. Hata varsa açıklamasını döner.
function kelimeGuess(room, name, text) {
  const game = room.kelime;
  if (!game || game.phase !== 'play' || name === game.narrator || !kelimePlayer(game, name) || typeof text !== 'string') return null;
  if (Date.now() < game.startAt) return null;
  const word = kelimeClean(text);
  if (!word) return null;
  if (kelimeUnplaced(game) >= KELIME_QUEUE) return 'Anlatıcı bekleyen kelimeleri yerleştirene kadar bekle.';
  const wait = (game.lastGuess[name] || 0) + KELIME_COOLDOWN - Date.now();
  if (wait > 0) return `${Math.ceil(wait / 1000)} sn sonra yeni tahmin yazabilirsin.`;
  if (kelimeKey(word) === kelimeKey(game.target)) {
    game.found = name;
    endKelimeRound(room, `🎉 ${name} kelimeyi buldu!`);
    return null;
  }
  if (game.words.some((w) => kelimeKey(w.text) === kelimeKey(word))) return 'Bu kelime zaten yazıldı.';
  if (game.words.length >= KELIME_WORDS_MAX) return null;
  game.lastGuess[name] = Date.now();
  game.words.push({ id: game.nextId++, text: word, by: name, pos: null, until: Date.now() + KELIME_TURN });
  kelimeDue(room);
  sendKelime(room);
  kelimeBotLater(room);
  return null;
}

// Süresinde yerleştirilmeyen kelime çubuğun en altına (en soğuk yere) konur; anlatıcı sonra taşıyabilir.
function kelimeDue(room) {
  const game = room.kelime;
  if (!game || game.phase !== 'play') return;
  const now = Date.now();
  let next = Infinity;
  for (const w of game.words) {
    if (w.pos != null) continue;
    if (w.until <= now) Object.assign(w, { pos: 0, until: null });
    else next = Math.min(next, w.until);
  }
  if (next < Infinity) {
    kelimeTimer(room, 'turn', next - now, () => {
      kelimeDue(room);
      sendKelime(room);
      kelimeBotLater(room);
    });
  }
}

// Bot birkaç saniye "düşünüp" rastgele oynar: anlatıcıysa kelime seçip başlatır ve gelen kelimeleri rastgele
// yerlere koyar, bilense rastgele kelime yazar (arada bir de hedefi tutturur ki turun bitişi de görülsün).
function kelimeBotLater(room) {
  const game = room.kelime;
  if (!room.bot || !game || game.phase === 'done' || kelimeTimers.has(`${room.code}:bot`)) return;
  const still = (phase) => room.kelime === game && game.phase === phase && room.bot;
  const narrating = game.narrator === BOT;
  if (game.phase === 'pick') {
    if (!narrating || game.players.length < 2) return;
    return kelimeTimer(room, 'bot', rand(1500, 3000), () => {
      if (!still('pick') || game.narrator !== BOT) return;
      if (!game.target && kelimeRoll(room)) game.target = pick(BOT_WORDS); // havuz boşsa kendi listesinden
      kelimeBegin(room);
    });
  }
  if (Date.now() < game.startAt) return; // tur başlayınca yeniden çağrılır
  if (narrating) {
    if (!kelimeUnplaced(game)) return;
    return kelimeTimer(room, 'bot', rand(1500, 4000), () => {
      const w = still('play') && game.words.find((x) => x.pos == null);
      if (!w) return;
      Object.assign(w, { pos: Math.random(), until: null });
      sendKelime(room);
      kelimeBotLater(room);
    });
  }
  if (!kelimePlayer(game, BOT) || kelimeUnplaced(game) >= KELIME_QUEUE) return;
  const wait = Math.max(0, (game.lastGuess[BOT] || 0) + KELIME_COOLDOWN - Date.now());
  kelimeTimer(room, 'bot', wait + rand(1500, 6000), () => {
    if (!still('play')) return;
    const used = new Set(game.words.map((w) => kelimeKey(w.text)));
    const lucky = Date.now() - game.startAt > 30000 && Math.random() < 0.08;
    const options = [...BOT_WORDS, ...room.kelimePool.map((w) => w.text)].filter((t) => !used.has(kelimeKey(t)) && kelimeKey(t) !== kelimeKey(game.target));
    kelimeGuess(room, BOT, lucky || !options.length ? game.target : pick(options));
    kelimeBotLater(room);
  });
}

// Çubukta hedefe en yakın 15 kelime 15'ten 1'e puan getirir; hedefi bulan kelime en üstte, 1. sayılır.
// Anlatıcı kelime bulunursa +10, bulunamazsa -10 alır.
function kelimeScores(game) {
  const placed = game.words.filter((w) => w.pos != null).sort((a, b) => b.pos - a.pos || a.id - b.id);
  const ranked = game.found ? [{ text: game.target, by: game.found }, ...placed] : placed;
  const scores = new Map();
  const add = (name) => scores.get(name) || scores.set(name, { name, points: 0, words: [] }).get(name);
  for (const p of game.players) add(p.name);
  const narrator = add(game.narrator);
  narrator.narrator = true;
  narrator.points += game.found ? KELIME_NARRATOR : -KELIME_NARRATOR;
  ranked.slice(0, KELIME_TOP).forEach((w, i) => {
    const s = add(w.by);
    s.points += KELIME_TOP - i;
    s.words.push(w.text);
  });
  return [...scores.values()].sort((a, b) => b.points - a.points);
}

function kelimeTotals(game) {
  const totals = new Map(game.players.map((p) => [p.name, { name: p.name, points: 0 }]));
  for (const r of game.rounds) {
    for (const s of r.scores) (totals.get(s.name) || totals.set(s.name, { name: s.name, points: 0 }).get(s.name)).points += s.points;
  }
  return [...totals.values()].sort((a, b) => b.points - a.points);
}

// Sıradaki anlatıcı: henüz anlatmamış, odada olan ilk oyuncu (katılma sırasıyla).
function kelimeNext(room) {
  const game = room.kelime;
  const here = new Set([...room.users.values()].map((u) => u.name));
  if (room.bot) here.add(BOT);
  return game.players.find((p) => !game.narrated.includes(p.name) && here.has(p.name))?.name || null;
}

// Tur biter; çubuk ve sonuçlar sıradaki tur başlayana kadar görünür. Herkes anlattıysa oyun biter.
function endKelimeRound(room, reason) {
  const game = room.kelime;
  if (!game || game.phase !== 'play') return;
  clearKelimeTimers(room.code);
  for (const w of game.words) if (w.pos == null) Object.assign(w, { pos: 0, until: null });
  game.rounds.push({ no: game.round, narrator: game.narrator, target: game.target, found: game.found, scores: kelimeScores(game) });
  game.totals = kelimeTotals(game);
  postSystem(room, `${reason} Kelime: ${game.target}`);
  kelimeNextRound(room);
}

function kelimeNextRound(room) {
  const game = room.kelime;
  const narrator = kelimeNext(room);
  if (!narrator) return finishKelime(room, 'Herkes anlattı, kelime oyunu bitti.');
  Object.assign(game, { phase: 'pick', round: game.rounds.length + 1, narrator, target: null, rolls: 0, seen: [], startAt: null, endAt: null });
  sendKelime(room);
  kelimeBotLater(room);
}

// Ayrılan oyuncu geri gelip devam edebilir. Anlatıcı ayrılırsa turu biter (kelime seçiyorsa sırası atlanır).
function kelimeLeft(room, name) {
  const game = room.kelime;
  if (!game || game.phase === 'done') return;
  if (game.narrator !== name) return;
  if (game.phase === 'play') return endKelimeRound(room, `Anlatıcı ${name} ayrıldı, tur bitti.`);
  game.narrated.push(name);
  kelimeNextRound(room);
}

// Süren tur sayılmaz; hiç tur bitmediyse oyun kapanır.
function finishKelime(room, reason) {
  const game = room.kelime;
  if (!game || game.phase === 'done') return;
  clearKelimeTimers(room.code);
  if (!game.rounds.length) {
    room.kelime = null;
    sendKelime(room);
    return postSystem(room, reason);
  }
  Object.assign(game, { phase: 'done', narrator: null, target: null, startAt: null, endAt: null, endedAt: Date.now() });
  sendKelime(room);
  const best = game.totals[0];
  postSystem(room, reason + (best?.points > 0 ? ` 🏆 ${best.name} (${best.points} puan)` : ''));
}

// ---------- Radyo ----------
// Dünya radyoları Radio Browser'dan gelir (radio-browser.info: açık, ücretsiz, anahtar istemez). Sadece haritada
// yeri belli, HTTPS yayın yapan (site HTTPS, düz HTTP çalınamaz) ve tarayıcıda doğrudan çalan istasyonlar alınır;
// HLS (.m3u8) yayınları Chrome ek kütüphane olmadan çalamadığı için dışarıda kalır. Liste günde bir yenilenir.

const RADIO_API = ['https://all.api.radio-browser.info', 'https://de1.api.radio-browser.info'];
const RADIO_HEADERS = { 'User-Agent': 'sesli-oda/1.0' }; // Radio Browser uygulama adı istiyor
const RADIO_REFRESH = 24 * 60 * 60 * 1000;
const RADIO_CODECS = new Set(['MP3', 'AAC', 'AAC+', 'OGG']);
const radioStations = new Map(); // id -> { id, name, cc, lat, lon, tags, url, codec, bitrate }
let radioPayload = null; // istemciye giden liste: { json, gzip, etag }
let radioLoading = null;
const regionNames = new Intl.DisplayNames(['tr'], { type: 'region' });
const countryName = (cc) => {
  try {
    return regionNames.of(cc);
  } catch {
    return cc;
  }
};

// Şehir adları: Radio Browser'da şehir çoğu zaman boş, istasyonun yerine en yakın şehir GeoNames'ten bulunur
// (nüfusu 15 binden büyük ~34 bin şehir, CC-BY). Alınamazsa istasyonun kendi bölge bilgisi kullanılır.
const CITIES_URL = 'https://download.geonames.org/export/dump/cities15000.zip';
const CITY_RADIUS = 40; // km; bundan uzaktaki şehir sayılmaz

// Tek dosyalı zip'i açar: merkez dizinden dosyanın yerini ve boyunu okur, veriyi zlib ile çözer.
function unzipSingle(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const dir = buf.readUInt32LE(end + 16);
  const method = buf.readUInt16LE(dir + 10);
  const size = buf.readUInt32LE(dir + 20);
  const local = buf.readUInt32LE(dir + 42);
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + size);
  return method === 8 ? zlib.inflateRawSync(data) : data;
}

// 1°×1° hücrelere bölünmüş şehir listesi: 'enlem:boylam' -> [{ name, lat, lon, pop }]
async function fetchCities() {
  const res = await fetch(CITIES_URL, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`şehirler ${res.status}`);
  const grid = new Map();
  for (const line of unzipSingle(Buffer.from(await res.arrayBuffer())).toString('utf8').split('\n')) {
    const f = line.split('\t');
    if (f.length < 15) continue;
    const city = { name: f[1], lat: Number(f[4]), lon: Number(f[5]), pop: Number(f[14]) || 0 };
    const key = `${Math.floor(city.lat)}:${Math.floor(city.lon)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(city);
  }
  return grid;
}

// Yakındaki (25 km) en kalabalık şehir, yoksa 40 km içindeki en yakın şehir: banliyö değil büyük şehrin adı çıksın.
function nearestCity(grid, lat, lon) {
  const km = (c) => Math.hypot((c.lat - lat) * 111, (c.lon - lon) * 111 * Math.cos((lat * Math.PI) / 180));
  const near = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (const c of grid.get(`${Math.floor(lat) + dy}:${Math.floor(lon) + dx}`) || []) {
        const d = km(c);
        if (d <= CITY_RADIUS) near.push({ c, d });
      }
    }
  }
  const close = near.filter((x) => x.d <= 25).sort((a, b) => b.c.pop - a.c.pop)[0];
  return (close || near.sort((a, b) => a.d - b.d)[0])?.c.name || '';
}

async function fetchRadio() {
  let lastError;
  for (const base of RADIO_API) {
    try {
      const res = await fetch(`${base}/json/stations/search?has_geo_info=true&hidebroken=true&is_https=true&limit=100000`, { headers: RADIO_HEADERS, signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`${res.status}`);
      return await res.json();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

// Liste bir kez çekilir; aynı anda gelen istekler aynı yüklemeyi bekler. Başarısız olursa sonraki istek yeniden dener.
function loadRadio() {
  radioLoading ||= Promise.all([fetchRadio(), fetchCities().catch((err) => console.warn('Şehir listesi alınamadı:', err.message))]).then(([rows, cities]) => {
    radioStations.clear();
    for (const s of rows) {
      if (s.hls === 1 || !RADIO_CODECS.has(s.codec) || !s.url_resolved.startsWith('https://')) continue;
      if (!Number.isFinite(s.geo_lat) || !Number.isFinite(s.geo_long)) continue;
      radioStations.set(s.stationuuid, {
        id: s.stationuuid, name: s.name.trim().slice(0, 80) || 'İsimsiz', cc: s.countrycode || '',
        state: ((cities && nearestCity(cities, s.geo_lat, s.geo_long)) || s.state || '').trim().slice(0, 40), // şehir (yoksa bölge)
        lat: Math.round(s.geo_lat * 1e4) / 1e4, lon: Math.round(s.geo_long * 1e4) / 1e4,
        tags: s.tags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 3).join(', ').slice(0, 60),
        url: s.url_resolved, codec: s.codec, bitrate: s.bitrate,
      });
    }
    // Haritaya sadece gereken alanlar gider: [id, ad, ülke kodu, enlem, boylam, etiketler, şehir]; yayın adresi seçilince gelir.
    const json = JSON.stringify([...radioStations.values()].map((s) => [s.id, s.name, s.cc, s.lat, s.lon, s.tags, s.state]));
    radioPayload = { json, gzip: zlib.gzipSync(json), etag: `"r${Date.now()}"` };
    console.log(`Radyo: ${radioStations.size} istasyon yüklendi.`);
    setTimeout(() => {
      radioLoading = null;
      loadRadio().catch(() => {});
    }, RADIO_REFRESH);
  }).catch((err) => {
    radioLoading = null;
    console.warn('Radyo listesi alınamadı:', err.message);
    throw err;
  });
  return radioLoading;
}

const radioView = (room) => room.radio;

function setRadio(room, station, by) {
  room.radio = { ...station, country: countryName(station.cc), by, at: Date.now() };
  io.to(room.code).emit('radio', radioView(room));
  postSystem(room, `📻 ${by} radyoyu açtı: ${station.name}` + (station.cc ? ` (${countryName(station.cc)})` : ''));
  // Radio Browser'ın istediği gibi tıklama sayılır (popüler istasyonlar sıralamada yukarı çıkar).
  fetch(`${RADIO_API[0]}/json/url/${station.id}`, { headers: RADIO_HEADERS, signal: AbortSignal.timeout(10000) }).catch(() => {});
}

// ---------- Eşini bul ----------
// Taşlar sayı (0-9) ve renkten oluşur, her taştan iki tane vardır. Sırası gelen iki taş açar: eşse (sayı ve renk
// aynı) çifti alır ve yeniden oynar; değilse taşlar kısa süre herkese açık kalıp kapanır, sıra geçer.
// Taş kalmayınca en çok çift toplayan kazanır. Kapalı taşların yüzü sunucuda kalır, istemciye gitmez.

// Tahtayı lobide kurucu kurar: seçilen her sayı-renk ikilisinden iki taş olur.
const MEMORY_COLORS = ['yesil', 'turuncu', 'mavi', 'kirmizi', 'mor', 'pembe', 'sari', 'turkuaz', 'kahve', 'siyah'];
const MEMORY_MAX_NUMBER = 30;
const MEMORY_PAIRS = [2, 60]; // en az / en çok çift (60 çift = 120 taş)
const MEMORY_TURN = 15000;  // ms; sırası gelenin hamle süresi (dolarsa sıra geçer)
const MEMORY_REVEAL = 1500; // ms; eş olmayan iki taşın açık kaldığı süre
const memoryTimers = new Map(); // `${oda}:${tür}` -> zamanlayıcı

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function memoryTimer(room, kind, ms, fn) {
  const key = `${room.code}:${kind}`;
  clearTimeout(memoryTimers.get(key));
  memoryTimers.set(key, setTimeout(() => {
    memoryTimers.delete(key);
    if (rooms.get(room.code) === room) fn();
  }, ms));
}

function clearMemoryTimers(code) {
  for (const kind of ['turn', 'bot']) {
    clearTimeout(memoryTimers.get(`${code}:${kind}`));
    memoryTimers.delete(`${code}:${kind}`);
  }
}

const memoryCurrent = (game) => game.players[game.turn];

// Lobide seçilen sayılar ve renkler: geçerliyse sıralı ve tekrarsız hali, değilse null.
function memoryBoard(numbers, colors) {
  if (!Array.isArray(numbers) || !Array.isArray(colors)) return null;
  const ns = [...new Set(numbers)].filter((n) => Number.isInteger(n) && n >= 0 && n <= MEMORY_MAX_NUMBER).sort((a, b) => a - b);
  const cs = MEMORY_COLORS.filter((c) => colors.includes(c));
  const pairs = ns.length * cs.length;
  if (ns.length !== numbers.length || cs.length !== colors.length || pairs < MEMORY_PAIRS[0] || pairs > MEMORY_PAIRS[1]) return null;
  return { numbers: ns, colors: cs };
}

function memoryView(game) {
  if (!game) return null;
  return { ...game, tiles: game.tiles.map((t) => (t.owner || game.open.includes(t.id) || game.done ? t : { id: t.id })) };
}

function sendMemory(room) {
  io.to(room.code).emit('memory', memoryView(room.memory));
}

// Lobiden gelen ekiple başlar; sırayı lobideki sıra belirler.
function startMemory(room, by, players, { numbers, colors }) {
  const pairs = numbers.flatMap((n) => colors.map((c) => ({ n, c })));
  const tiles = shuffle([...pairs, ...pairs]).map(({ n, c }, id) => ({ id, n, c, owner: null }));
  room.memory = {
    id: Date.now(), players, turn: -1, tiles, open: [], revealUntil: null, turnUntil: null,
    scores: Object.fromEntries(players.map((n) => [n, 0])), moves: Object.fromEntries(players.map((n) => [n, 0])),
    startedAt: Date.now(), endedAt: null, done: false,
  };
  room.memorySeen = new Map(); // botun aklında kalan taşlar: id -> 'sayı-renk'
  postSystem(room, players.length > 1 ? `${by} Eşini Bul'u başlattı: ${players.join(', ')}` : `${by} tek başına Eşini Bul oynuyor`);
  memoryNextTurn(room);
}

// Sıra, odada olan sıradaki oyuncuya geçer; kimse kalmadıysa oyun biter.
function memoryNextTurn(room) {
  const game = room.memory;
  const here = lobbyHere(room);
  for (let step = 1; step <= game.players.length; step++) {
    const i = (game.turn + step) % game.players.length;
    if (!here.has(game.players[i])) continue;
    game.turn = i;
    return memoryStartTurn(room);
  }
  finishMemory(room, 'Oyunda kimse kalmadı.');
}

function memoryStartTurn(room) {
  const game = room.memory;
  Object.assign(game, { open: [], revealUntil: null, turnUntil: Date.now() + MEMORY_TURN });
  memoryTimer(room, 'turn', MEMORY_TURN, () => memoryNextTurn(room));
  sendMemory(room);
  memoryBotLater(room);
}

function memoryFlip(room, name, id) {
  const game = room.memory;
  if (!game || game.done || game.revealUntil || memoryCurrent(game) !== name) return;
  const tile = game.tiles[id];
  if (!tile || tile.owner || game.open.includes(id) || game.open.length >= 2) return;
  game.open.push(id);
  if (room.bot && Math.random() < 0.6) room.memorySeen.set(id, `${tile.n}-${tile.c}`);
  if (game.open.length === 1) {
    sendMemory(room);
    return memoryBotLater(room);
  }
  game.moves[name]++;
  const [a, b] = game.open.map((i) => game.tiles[i]);
  if (a.n !== b.n || a.c !== b.c) {
    game.revealUntil = Date.now() + MEMORY_REVEAL;
    memoryTimer(room, 'turn', MEMORY_REVEAL, () => memoryNextTurn(room));
    return sendMemory(room);
  }
  a.owner = b.owner = name;
  game.scores[name]++;
  if (game.tiles.every((t) => t.owner)) return finishMemory(room);
  memoryStartTurn(room); // eşini bulan yeniden oynar
}

// Bot hep aynı şekilde oynar: aklında kalan bir çift varsa onu, açtığı taşın eşini biliyorsa onu, yoksa rastgele açar.
function memoryBotLater(room) {
  const game = room.memory;
  if (!game || game.done || game.revealUntil || memoryCurrent(game) !== BOT || !room.bot) return;
  memoryTimer(room, 'bot', rand(700, 1400), () => {
    if (room.memory !== game || game.done || memoryCurrent(game) !== BOT) return;
    const closed = game.tiles.filter((t) => !t.owner && !game.open.includes(t.id)).map((t) => t.id);
    const known = (id) => room.memorySeen.get(id);
    let choice;
    if (game.open.length) {
      const want = `${game.tiles[game.open[0]].n}-${game.tiles[game.open[0]].c}`;
      choice = closed.find((id) => known(id) === want);
    } else {
      const byKey = new Map();
      for (const id of closed) {
        if (!known(id)) continue;
        if (byKey.has(known(id))) choice = byKey.get(known(id));
        byKey.set(known(id), id);
      }
    }
    if (choice == null) {
      const unknown = closed.filter((id) => !known(id));
      choice = pick(unknown.length ? unknown : closed);
    }
    memoryFlip(room, BOT, choice);
  });
}

// Ayrılan oyuncunun sırasıysa sıra geçer.
function memoryLeft(room, name) {
  const game = room.memory;
  if (!game || game.done || memoryCurrent(game) !== name || game.revealUntil) return;
  memoryNextTurn(room);
}

function finishMemory(room, reason) {
  const game = room.memory;
  if (!game || game.done) return;
  clearMemoryTimers(room.code);
  Object.assign(game, { done: true, open: [], revealUntil: null, turnUntil: null, endedAt: Date.now() });
  sendMemory(room);
  const left = game.tiles.filter((t) => !t.owner).length / 2;
  const secs = Math.round((game.endedAt - game.startedAt) / 1000);
  const time = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  const prefix = reason ? `${reason} ` : '';
  if (game.players.length === 1) {
    const [name] = game.players;
    return postSystem(room, left ? `${prefix}Eşini Bul bitti: ${name} ${game.scores[name]} çift buldu.` : `${name} Eşini Bul'u ${game.moves[name]} hamlede, ${time} sürede bitirdi 🎉`);
  }
  const ranked = [...game.players].sort((a, b) => game.scores[b] - game.scores[a]);
  const best = game.scores[ranked[0]];
  const winners = ranked.filter((n) => game.scores[n] === best);
  postSystem(room, `${prefix}Eşini Bul bitti! ` + (best ? `🏆 ${winners.join(', ')} (${best} çift)` : 'Kimse çift bulamadı.'));
}

// ---------- Dinozor koşusu ----------

// Başlangıçtan t sn sonra Jef'in yeri
function dinoJefX(t) {
  const { runStart: v, runAccel: a, runMax } = DINO_PACE;
  const full = (runMax - v) / a;
  if (t <= 0) return 0;
  if (t < full) return v * t + (a * t * t) / 2;
  return v * full + (a * full * full) / 2 + runMax * (t - full);
}

const dinoJefNow = (game) => dinoJefX((Date.now() - game.startAt) / 1000);

// Bot engellere bakmaz: rastgele aralıklarla zıplar, 8-45 sn arası bir anda ölür.
function dinoBot(room, game) {
  const dieAt = game.startAt + rand(8000, 45000);
  const slot = Object.keys(game.players).indexOf(BOT) + 1;
  const step = () => {
    const me = game.players[BOT];
    if (room.dino !== game || game.done || me.dead || rooms.get(room.code) !== room) return;
    const now = Date.now();
    const t = (now - game.startAt) / 1000;
    me.seen = now;
    if (now >= dieAt) return killDino(room, BOT, dinoJefX(t) - 60 * slot);
    if (t > 0) {
      me.dist = Math.max(me.dist, dinoJefX(t) - 60 * slot);
      io.to(room.code).emit('dino:pos', { name: BOT, t, y: 0, vy: 860, duck: false, hold: false }); // DINO.jump
    }
    setTimeout(step, rand(400, 1600));
  };
  setTimeout(step, Math.max(0, game.startAt - Date.now()) + 500);
}

// Ölmeyi oyuncunun tarayıcısı denetler; sekmesi kapalı ya da bağlantısı kopmuş biri hiç ölmez,
// oyun da bitmezdi. Bir süredir konum göndermeyen oyuncu, son haber aldığımız yerde ölmüş sayılır.
function dinoSweep(room) {
  const game = room.dino;
  if (!game || game.done) return;
  const now = Date.now();
  for (const [name, p] of Object.entries(game.players)) {
    const seen = Math.max(p.seen || 0, game.startAt);
    if (!p.dead && now - seen > DINO_SILENT) killDino(room, name, dinoJefX((seen - game.startAt) / 1000));
  }
}

// Kimse konum yollamasa da (herkes sekmeyi kapattıysa) oyun biter.
setInterval(() => {
  for (const room of rooms.values()) dinoSweep(room);
}, 1000);

// Skorları tabloya ekler. Bilgisayardaki sunucu da canlıyla aynı kaydı kullandığından kaydetmeden önce
// kayıttakilerle birleştirilir; yoksa her sunucu yalnız kendi hafızasındakini yazıp ötekinin skorlarını siler.
function mergeDinoBoard(board, from) {
  for (const mode of DINO_BOARD_MODES) {
    const seen = new Set();
    board[mode] = [...(board[mode] || []), ...(from?.[mode] || [])]
      .filter((r) => {
        const key = `${r.name}|${r.at}|${r.dist}`;
        return !seen.has(key) && seen.add(key);
      })
      .sort((a, b) => b.dist - a.dist)
      .slice(0, DINO_BOARD);
  }
}

async function addDinoScores(room, mode, scores) {
  room.dinoBoard[mode].push(...scores);
  if (store.enabled) {
    try {
      const [row] = await store.select('room_state', `room=eq.${encodeURIComponent(room.code)}&kind=eq.dinoboard&select=data`);
      mergeDinoBoard(room.dinoBoard, row?.data);
    } catch (err) {
      console.warn('skor tablosu okuma', err.message);
    }
  }
  mergeDinoBoard(room.dinoBoard);
  store.save(room.code, 'dinoboard', () => room.dinoBoard);
  io.to(room.code).emit('dino:board', room.dinoBoard);
}

// Lobiden gelen ekiple başlar. Tek mod: hız otomatik, oyuncu sadece zıplar ve eğilir. (Eski 'hold' ve 'tap'
// modlarının skorları kayıtta ayrı durur; tıklama modu ileride "Tavus kuşu" oyunu olacak.)
function startDino(room, by, names) {
  const players = Object.fromEntries(names.map((n) => [n, { dist: 0, dead: false }]));
  room.dino = { id: Date.now(), mode: 'auto', seed: Math.floor(Math.random() * 2 ** 31), startAt: Date.now() + DINO_COUNTDOWN, players, done: false };
  io.to(room.code).emit('dino', room.dino);
  if (players[BOT]) dinoBot(room, room.dino);
  postSystem(room, `${by} dinozor koşusunu başlattı: ${names.join(', ')}`);
}

// Oyuncuyu öldürür; herkes öldüyse oyun biter ve en uzağa giden kazanır.
function killDino(room, name, x) {
  const game = room.dino;
  const player = game?.players[name];
  if (!player || player.dead || game.done) return;
  player.dead = true;
  if (Number.isFinite(x)) player.dist = Math.max(player.dist, Math.min(x, dinoJefNow(game) + 200));
  const players = Object.entries(game.players);
  if (players.every(([, p]) => p.dead)) {
    game.done = true;
    game.jef = Math.round(dinoJefX((Date.now() - game.startAt) / 1000));
    players.sort((a, b) => b[1].dist - a[1].dist);
    // Skor tablosu: her mod ayrı, en iyi 10 skor (aynı kişi birden çok kez girebilir)
    const at = Date.now();
    addDinoScores(room, game.mode, players.filter(([n, p]) => p.dist > 0 && n !== BOT).map(([n, p]) => ({ name: n, dist: Math.round(p.dist), at })));
    const [winner, { dist }] = players[0];
    const jef = ` · Jef 🤖 ${Math.round(game.jef / 10)} m`;
    postSystem(room, players.length > 1
      ? `Dinozor koşusu bitti! 🏆 Kazanan: ${winner} (${Math.round(dist / 10)} m)${jef}`
      : `Dinozor koşusu bitti: ${winner} ${Math.round(dist / 10)} m gitti${jef}`);
  }
  io.to(room.code).emit('dino', game);
}

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
    if (kind === 'kelimeler') kelimePools.set(room, data);
    if (kind === 'oneriler') mergeOneriler(data);
    if (kind === 'dinoboard') dinoBoards.set(room, { auto: [], hold: [], tap: [], ...data });
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
  loadRadio().catch(() => {}); // harita açılmadan önce hazır olsun
  server.listen(PORT, () => {
    console.log(`Sesli Oda çalışıyor: http://localhost:${PORT}`);
  });
});
