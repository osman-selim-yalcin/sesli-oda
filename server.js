const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3030;
const MAX_USERS = 6;
const VIDEO_ID = /^[\w-]{11}$/;
const SFX_IDS = new Set(['clap', 'rimshot', 'ding', 'sad', 'tada', 'boom']);
const SFX_COOLDOWN = 600; // ms; efekt spam'ini engeller
const REACTIONS = ['🔥', '😂', '😍', '👏', '💀', '😴'];
const CHAT_HISTORY = 50;  // odaya yeni girene gösterilen son mesaj sayısı
const CHAT_MAX_LENGTH = 500;
const CHAT_COOLDOWN = 300; // ms

const app = express();
// Efekt kayıtları değişmez; tarayıcı bir kez indirip saklasın.
app.use('/sfx', express.static(path.join(__dirname, 'public/sfx'), { maxAge: '30d' }));
app.use(express.static(path.join(__dirname, 'public')));

// ICE sunucuları: varsayılan STUN; gerekirse TURN ortam değişkenleriyle eklenir.
app.get('/config', (req, res) => {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  res.json({ iceServers });
});

// Giriş ekranı için: tek odada kimler var.
app.get('/status', (req, res) => {
  const room = rooms.get('genel');
  res.json({ names: room ? [...room.users.values()].map((u) => u.name) : [], max: MAX_USERS });
});

const server = http.createServer(app);
const io = new Server(server);

// oda kodu -> { users: Map<socketId, {name, muted}>, current, queue, playing, position, updatedAt }
const rooms = new Map();

function getRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
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

function stopSharing(room, code, id) {
  if (room.sharer !== id) return;
  room.sharer = null;
  io.to(code).emit('screen', null);
}

function playNext(room) {
  room.current = room.queue.shift() || null;
  setPlayback(room, Boolean(room.current), 0);
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
    for (const [id, user] of room.users) {
      if (!clientId || user.clientId !== clientId) continue;
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
    ack({ id: socket.id, peers, media: mediaState(room), sharer: room.sharer, chat: room.chat });
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
    const msg = { from: socket.id, name: room.users.get(socket.id).name, text, ts: Date.now() };
    room.chat.push(msg);
    if (room.chat.length > CHAT_HISTORY) room.chat.shift();
    io.to(code).emit('chat', msg);
  });

  let lastSfx = 0;
  socket.on('sfx', (id) => {
    if (!code || !SFX_IDS.has(id) || Date.now() - lastSfx < SFX_COOLDOWN) return;
    lastSfx = Date.now();
    socket.to(code).emit('sfx', { id, by: getRoom(code).users.get(socket.id).name });
  });

  socket.on('media:add', async (videoId) => {
    if (!code || !VIDEO_ID.test(videoId)) return;
    const roomCode = code;
    const by = getRoom(roomCode).users.get(socket.id).name;
    const title = (await fetchTitle(videoId)) || videoId;
    if (!rooms.has(roomCode)) return;
    const room = getRoom(roomCode);
    const item = { id: nextItemId++, videoId, title, by, likes: new Map(), dislikes: new Map(), reactions: new Map() };
    if (room.current) {
      room.queue.push(item);
    } else {
      room.current = item;
      setPlayback(room, true, 0);
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
    room.current = room.queue.splice(index, 1)[0];
    setPlayback(room, true, 0);
    broadcastMedia(code);
  });

  socket.on('disconnect', () => {
    if (!code) return;
    const room = getRoom(code);
    // Yenileme sırasında zaten silinmiş olabilir.
    if (!room.users.delete(socket.id)) return;
    stopSharing(room, code, socket.id);
    socket.to(code).emit('user-left', socket.id);
    if (room.users.size === 0) rooms.delete(code);
  });
});

server.listen(PORT, () => {
  console.log(`Sesli Oda çalışıyor: http://localhost:${PORT}`);
});
