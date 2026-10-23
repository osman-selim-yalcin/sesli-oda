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
const KELIME_TIME = 6 * 60 * 1000; // ms; tahmin edenlerin hedef kelimeyi bulmak için toplam süresi
const KELIME_TURN = 10000;       // ms; anlatıcının gelen kelimeyi yerleştirme süresi
const KELIME_MAX_LENGTH = 40;
const KELIME_POOL_MAX = 1000;    // odanın kelime havuzundaki en fazla kelime
const KELIME_WORDS_MAX = 200;    // bir oyunda yazılabilecek en fazla tahmin
const KELIME_TOP = 10;           // puan alan ilk kelime sayısı (1. kelime 10 puan, 10. kelime 1 puan)
const KELIME_BONUS = 15;         // hedef kelimeyi bilene
const KELIME_RECENT = 20;        // son çıkan bu kadar kelime tekrar seçilmez (havuz yeterliyse)
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
// Sayfanın ekranları kendi adresinde açılır (/gecmis, /oyunlar/kelime ...); hepsi aynı sayfadır.
app.get(/^\/(gecmis|oyunlar)(\/[\w-]*)*\/?$/, (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
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
    ack({ id: socket.id, peers, media: mediaState(room), sharer: room.sharer, chat: room.chat, history: room.history, customSfx: customSfxList(room), tierLists: room.tierLists.map(tierListView), timing: room.timing, dino: room.dino, dinoBoard: room.dinoBoard, bot: room.bot, oneriler: oneriView(), kelimePool: room.kelimePool, kelime: kelimeView(room.kelime, name), profiles: accounts.profiles() });
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

  socket.on('race:start', (rounds) => {
    if (!code || !RACE_ROUNDS.includes(rounds)) return;
    const room = getRoom(code);
    if (room.timing.race && !room.timing.race.done) return;
    const [min, max] = RACE_TARGETS;
    const targets = Array.from({ length: rounds }, () => min + Math.floor(Math.random() * (max - min + 1)));
    const by = room.users.get(socket.id).name;
    const players = [...new Set([...room.users.values()].map((u) => u.name))];
    if (room.bot) players.push(BOT);
    room.timing.race = {
      id: Date.now(), by, targets, players, scores: Object.fromEntries(players.map((n) => [n, []])),
      round: 0, ended: 0, roundStart: 0, revealUntil: null, done: false,
    };
    postSystem(room, `${by} ${rounds} turluk süre yarışı başlattı`);
    startRaceRound(room, 0);
  });

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
    if (!room.timing.race || room.timing.race.done) return;
    finishRace(room, room.users.get(socket.id).name);
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
  socket.on('dino:start', () => {
    if (!code) return;
    const mode = 'auto';
    const room = getRoom(code);
    if (room.dino && !room.dino.done && Date.now() - room.dino.startAt < DINO_MAX_TIME) return;
    const by = room.users.get(socket.id).name;
    const players = {};
    for (const u of room.users.values()) players[u.name] = { dist: 0, dead: false };
    if (room.bot) players[BOT] = { dist: 0, dead: false };
    room.dino = { id: Date.now(), mode, seed: Math.floor(Math.random() * 2 ** 31), startAt: Date.now() + DINO_COUNTDOWN, players, done: false };
    io.to(code).emit('dino', room.dino);
    if (room.bot) dinoBot(room, room.dino);
    postSystem(room, `${by} dinozor koşusu başlattı`);
  });

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
    kelimeBotLater(room); // oyun sürerken eklenirse sırası gelince katılır
    postSystem(room, `${room.users.get(socket.id).name} botu ${room.bot ? 'ekledi; yeni başlayan oyunlara katılır' : 'çıkardı'}`);
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
  // Anlatıcı hedef kelimeyi görür; diğerleri teker teker tahmin yazar, anlatıcı her tahmini
  // sıcak-soğuk çubuğuna yerleştirir (pos: 0 en soğuk, 1 en sıcak). Sıra anlatıcıdayken tahmin yazılamaz.

  const kelimeGame = (fn) => (...args) => {
    if (!code) return;
    const room = getRoom(code);
    const game = room.kelime;
    if (!game || game.done) return;
    fn(game, room, room.users.get(socket.id).name, ...args);
  };

  socket.on('kelime:pool:add', (text) => {
    if (!code || typeof text !== 'string') return;
    const room = getRoom(code);
    const by = room.users.get(socket.id).name;
    const have = new Set(room.kelimePool.map((w) => kelimeKey(w.text)));
    let added = 0;
    for (const raw of text.split(/[,\n]/)) {
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

  // Başlatan anlatıcı olur; bot açıksa anlatıcı bot da olabilir.
  socket.on('kelime:start', ({ bot } = {}) => {
    if (!code) return;
    const room = getRoom(code);
    if (room.kelime && !room.kelime.done) return;
    if (!room.kelimePool.length) return socket.emit('notice', 'Önce havuza kelime ekleyin.');
    const starter = room.users.get(socket.id).name;
    const narrator = bot && room.bot ? BOT : starter;
    if (new Set([...room.users.values()].map((u) => u.name)).size + (room.bot ? 1 : 0) < 2) {
      return socket.emit('notice', 'Kelime için en az iki kişi gerekli; tek başınaysan botu ekle.');
    }
    const fresh = room.kelimePool.filter((w) => !room.kelimeRecent.includes(kelimeKey(w.text)));
    const pick = (fresh.length ? fresh : room.kelimePool)[Math.floor(Math.random() * (fresh.length || room.kelimePool.length))];
    const keep = Math.min(KELIME_RECENT, room.kelimePool.length - 1);
    room.kelimeRecent = keep > 0 ? [...room.kelimeRecent, kelimeKey(pick.text)].slice(-keep) : [];
    room.kelime = {
      id: Date.now(), narrator, target: pick.text, endAt: Date.now() + KELIME_TIME,
      words: [], pending: null, turnUntil: null, found: null, done: false, scores: null,
    };
    kelimeTimer(room, 'game', KELIME_TIME, () => finishKelime(room, 'Süre doldu.'));
    sendKelime(room);
    kelimeBotLater(room);
    postSystem(room, narrator === starter ? `${narrator} kelime oyununu başlattı; anlatıcı o.` : `${starter} kelime oyununu başlattı; anlatıcı ${BOT}.`);
  });

  socket.on('kelime:guess', kelimeGame((game, room, name, text) => {
    const error = kelimeGuess(room, name, text);
    if (error) socket.emit('notice', error);
  }));

  // Anlatıcı sürüklerken kelimenin yeri diğerlerine anlık gider (kaydedilmez).
  socket.on('kelime:drag', kelimeGame((game, room, name, { id, pos } = {}) => {
    if (name !== game.narrator || !game.pending || !(pos === null || Number.isFinite(pos))) return;
    // pos null: sürükleme bırakıldı, kelime yerleştirilmedi
    socket.to(code).volatile.emit('kelime:drag', { gameId: game.id, id, pos: pos === null ? null : Math.min(1, Math.max(0, pos)) });
  }));

  // Sıra anlatıcıdayken gelen kelime de eskiler de yerleştirilebilir.
  socket.on('kelime:place', kelimeGame((game, room, name, { id, pos } = {}) => {
    if (name !== game.narrator || !game.pending || !Number.isFinite(pos)) return;
    const w = game.words.find((x) => x.id === id);
    if (!w) return;
    w.pos = Math.min(1, Math.max(0, pos));
    sendKelime(room);
  }));

  // Gelen kelime yerleştirildiyse anlatıcı sırayı süre dolmadan bitirebilir.
  socket.on('kelime:turn', kelimeGame((game, room, name) => {
    if (name !== game.narrator || !game.pending) return;
    if (game.words.find((w) => w.id === game.pending).pos == null) return;
    endKelimeTurn(room);
  }));

  socket.on('kelime:end', kelimeGame((game, room, name) => {
    if (name !== game.narrator) return;
    finishKelime(room, `${name} kelime oyununu bitirdi.`);
  }));

  socket.on('kelime:close', () => {
    if (!code) return;
    const room = getRoom(code);
    if (!room.kelime?.done) return;
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
      if (current?.kelime && !current.kelime.done && current.kelime.narrator === user.name) {
        finishKelime(current, `Anlatıcı ${user.name} ayrıldı, kelime oyunu bitti.`);
      }
    }, REJOIN_GRACE));
    if (room.users.size === 0) {
      clearKelimeTimers(code);
      rooms.delete(code);
      deleteRoomImages(code);
    }
  });
});

// ---------- Süre yarışı ----------

const raceTimers = new Map(); // oda kodu -> zamanlayıcı (yarış nesnesi odaya gönderildiği için onun içinde tutulmaz)
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

// Hedef kelime oyun bitene kadar sadece anlatıcıya gönderilir.
function kelimeView(game, name) {
  if (!game) return null;
  if (game.done || name === game.narrator) return game;
  return { ...game, target: null };
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
  for (const kind of ['game', 'turn', 'bot']) {
    clearTimeout(kelimeTimers.get(`${code}:${kind}`));
    kelimeTimers.delete(`${code}:${kind}`);
  }
}

// Tahmin: hedefse oyun biter, değilse sıra anlatıcıya geçer. Hata varsa açıklamasını döner.
function kelimeGuess(room, name, text) {
  const game = room.kelime;
  if (!game || game.done || name === game.narrator || game.pending || typeof text !== 'string') return null;
  const word = kelimeClean(text);
  if (!word) return null;
  if (kelimeKey(word) === kelimeKey(game.target)) {
    game.found = name;
    finishKelime(room, `🎉 ${name} kelimeyi buldu!`);
    return null;
  }
  if (game.words.some((w) => kelimeKey(w.text) === kelimeKey(word))) return 'Bu kelime zaten yazıldı.';
  if (game.words.length >= KELIME_WORDS_MAX) return null;
  const w = { id: game.words.length + 1, text: word, by: name, pos: null };
  game.words.push(w);
  game.pending = w.id;
  game.turnUntil = Date.now() + KELIME_TURN;
  kelimeTimer(room, 'turn', KELIME_TURN, () => endKelimeTurn(room));
  sendKelime(room);
  kelimeBotLater(room);
  return null;
}

// Bot sırası gelince birkaç saniye "düşünüp" rastgele oynar: anlatıcıysa gelen kelimeyi rastgele bir yere koyar,
// tahminciyse rastgele bir kelime yazar (arada bir de hedefi tutturur ki oyunun bitişi de görülsün).
function kelimeBotLater(room) {
  const game = room.kelime;
  if (!room.bot || !game || game.done) return;
  const narrating = game.narrator === BOT;
  if (narrating !== Boolean(game.pending)) return; // sıra botta değil
  kelimeTimer(room, 'bot', rand(1500, narrating ? 4000 : 6000), () => {
    if (room.kelime !== game || game.done || !room.bot) return;
    if (narrating) {
      const w = game.words.find((x) => x.id === game.pending);
      if (!w) return;
      w.pos = Math.random();
      return endKelimeTurn(room);
    }
    if (game.pending) return;
    const used = new Set(game.words.map((w) => kelimeKey(w.text)));
    const lucky = Date.now() - game.id > 30000 && Math.random() < 0.08;
    const options = [...BOT_WORDS, ...room.kelimePool.map((w) => w.text)].filter((t) => !used.has(kelimeKey(t)) && kelimeKey(t) !== kelimeKey(game.target));
    kelimeGuess(room, BOT, lucky || !options.length ? game.target : pick(options));
  });
}

// Süresinde yerleştirilmeyen kelime çubuğun en altına (en soğuk yere) konur; anlatıcı sonra taşıyabilir.
function endKelimeTurn(room) {
  const game = room.kelime;
  if (!game || game.done || !game.pending) return;
  clearTimeout(kelimeTimers.get(`${room.code}:turn`));
  const w = game.words.find((x) => x.id === game.pending);
  if (w.pos == null) w.pos = 0;
  game.pending = null;
  game.turnUntil = null;
  sendKelime(room);
  kelimeBotLater(room);
}

// Çubukta en üstteki (hedefe en yakın) 10 kelime 10'dan 1'e puan getirir; bilen 15 puan daha alır.
function kelimeScores(game) {
  const placed = game.words.filter((w) => w.pos != null).sort((a, b) => b.pos - a.pos || a.id - b.id);
  const scores = new Map();
  const add = (name) => scores.get(name) || scores.set(name, { name, points: 0, words: [], bonus: 0 }).get(name);
  for (const w of game.words) if (w.by !== game.narrator) add(w.by);
  placed.slice(0, KELIME_TOP).forEach((w, i) => {
    const s = add(w.by);
    s.points += KELIME_TOP - i;
    s.words.push(w.text);
  });
  if (game.found) {
    const s = add(game.found);
    s.bonus = KELIME_BONUS;
    s.points += KELIME_BONUS;
  }
  return [...scores.values()].sort((a, b) => b.points - a.points);
}

function finishKelime(room, reason) {
  const game = room.kelime;
  if (!game || game.done) return;
  clearKelimeTimers(room.code);
  const pending = game.words.find((w) => w.id === game.pending);
  if (pending && pending.pos == null) pending.pos = 0;
  Object.assign(game, { done: true, pending: null, turnUntil: null, endedAt: Date.now() });
  game.scores = kelimeScores(game);
  sendKelime(room);
  const best = game.scores[0];
  postSystem(room, `${reason} Kelime: ${game.target}` + (best?.points ? ` · 🏆 ${best.name} (${best.points} puan)` : ''));
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
  server.listen(PORT, () => {
    console.log(`Sesli Oda çalışıyor: http://localhost:${PORT}`);
  });
});
