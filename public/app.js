'use strict';

const $ = (id) => document.getElementById(id);
const DRIFT_LIMIT = 1.5;      // saniye; bundan fazla kayınca yeniden hizalanır
const VOICE_BITRATE = 32000;  // bps; Opus için konuşma kalitesi yeterli

const socket = io({ autoConnect: false });
const peers = new Map();      // id -> { name, muted, pc, audio, pendingIce, row }
let iceServers = [];
let localStream = null;
let micOn = true;
let selfId = null;
let audioCtx = null;

// ---------- Yardımcılar ----------

function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  $('toasts').append(el);
  setTimeout(() => el.remove(), 4000);
}

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function parseVideoId(input) {
  input = input.trim();
  if (/^[\w-]{11}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.hostname.endsWith('youtu.be')) return url.pathname.slice(1, 12);
    const v = url.searchParams.get('v');
    if (v) return v;
    const m = url.pathname.match(/\/(?:shorts|embed|live|v)\/([\w-]{11})/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function randomRoom() {
  return Math.random().toString(36).slice(2, 8);
}

// ---------- Sunucu saati ----------
// Herkesin aynı saniyeyi çalabilmesi için sunucu ile saat farkını ölçeriz.

let clockOffset = 0;
const serverNow = () => Date.now() + clockOffset;

async function syncClock() {
  let best = Infinity;
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    const server = await new Promise((r) => socket.emit('time', r));
    const rtt = Date.now() - t0;
    if (rtt < best) {
      best = rtt;
      clockOffset = server + rtt / 2 - Date.now();
    }
  }
}

// ---------- Konuşma göstergesi ----------

function watchLevel(stream, row) {
  audioCtx ||= new AudioContext();
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  audioCtx.createMediaStreamSource(stream).connect(analyser);
  const data = new Uint8Array(analyser.fftSize);
  const timer = setInterval(() => {
    if (!row.isConnected) return clearInterval(timer);
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
    row.classList.toggle('speaking', peak > 12);
  }, 120);
}

// ---------- Katılımcı listesi ----------

function renderPeopleCount() {
  $('people-count').textContent = `(${peers.size + 1}/6)`;
}

function personRow(name, isSelf) {
  const li = document.createElement('li');
  li.innerHTML = `
    <div class="avatar"></div>
    <div class="p-info">
      <div class="p-name"></div>
      <div class="p-status"></div>
    </div>`;
  li.querySelector('.avatar').textContent = name.slice(0, 1).toUpperCase();
  li.querySelector('.p-name').textContent = isSelf ? `${name} (sen)` : name;
  $('people').append(li);
  return li;
}

function setStatus(row, text) {
  row.querySelector('.p-status').textContent = text;
}

function addPeer(id, name, muted) {
  if (peers.has(id)) return peers.get(id);
  const row = personRow(name, false);
  const vol = document.createElement('input');
  vol.type = 'range';
  vol.min = 0;
  vol.max = 100;
  vol.value = 100;
  vol.className = 'p-vol';
  vol.title = `${name} ses seviyesi`;
  row.querySelector('.p-info').append(vol);

  const audio = new Audio();
  audio.autoplay = true;
  vol.oninput = () => (audio.volume = vol.value / 100);

  // Kişiyi sadece kendin için susturma (karşı taraf bunu görmez).
  const muteBtn = document.createElement('button');
  muteBtn.className = 'icon p-mute';
  row.append(muteBtn);
  const renderMute = () => {
    muteBtn.textContent = audio.muted ? '🔇' : '🔊';
    muteBtn.title = audio.muted ? `${name} sesini aç` : `${name} sesini kapat`;
    muteBtn.classList.toggle('off', audio.muted);
    vol.disabled = audio.muted;
  };
  muteBtn.onclick = () => {
    audio.muted = !audio.muted;
    renderMute();
  };
  renderMute();

  const peer = { name, muted, pc: null, audio, pendingIce: [], row };
  peers.set(id, peer);
  setStatus(row, muted ? 'Sessizde' : 'Bağlanıyor…');
  renderPeopleCount();
  return peer;
}

function removePeer(id) {
  const peer = peers.get(id);
  if (!peer) return;
  peer.pc?.close();
  peer.audio.srcObject = null;
  peer.row.remove();
  peers.delete(id);
  renderPeopleCount();
}

// ---------- WebRTC (sesli sohbet) ----------
// Her kişi diğer herkese doğrudan bağlanır (en fazla 6 kişi için ideal).
// Yeni katılan kişi teklif (offer) gönderir, odadakiler cevap verir.

// Karşı tarafa Opus için DTX (sessizken veri göndermeme) ve bitrate sınırı bildirir.
function tuneOpus(sdp) {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000/i);
  if (!m) return sdp;
  const pt = m[1];
  return sdp.replace(
    new RegExp(`a=fmtp:${pt} (.*)`),
    (_, params) => `a=fmtp:${pt} ${params};usedtx=1;useinbandfec=1;maxaveragebitrate=${VOICE_BITRATE}`
  );
}

function sendDescription(to, desc) {
  socket.emit('signal', { to, data: { type: desc.type, sdp: tuneOpus(desc.sdp) } });
}

function createPc(id) {
  const peer = peers.get(id);
  const pc = new RTCPeerConnection({ iceServers });
  peer.pc = pc;

  if (localStream) {
    for (const track of localStream.getAudioTracks()) {
      const sender = pc.addTrack(track, localStream);
      const params = sender.getParameters();
      params.encodings = params.encodings?.length ? params.encodings : [{}];
      params.encodings[0].maxBitrate = VOICE_BITRATE;
      sender.setParameters(params).catch(() => {});
    }
  } else {
    pc.addTransceiver('audio', { direction: 'recvonly' });
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal', { to: id, data: { candidate: e.candidate } });
  };

  pc.ontrack = (e) => {
    peer.audio.srcObject = e.streams[0] || new MediaStream([e.track]);
    peer.audio.play().catch(() => {});
    watchLevel(peer.audio.srcObject, peer.row);
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected') setStatus(peer.row, peer.muted ? 'Sessizde' : 'Bağlı');
    else if (s === 'failed') setStatus(peer.row, 'Bağlanamadı (ağ engeli)');
    else if (s === 'disconnected') setStatus(peer.row, 'Bağlantı koptu…');
  };

  return pc;
}

async function callPeer(id) {
  const pc = createPc(id);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendDescription(id, pc.localDescription);
}

async function flushIce(peer) {
  for (const c of peer.pendingIce.splice(0)) {
    await peer.pc.addIceCandidate(c).catch(() => {});
  }
}

socket.on('signal', async ({ from, data }) => {
  const peer = peers.get(from);
  if (!peer) return;

  if (data.type === 'offer') {
    const pc = peer.pc || createPc(from);
    await pc.setRemoteDescription(data);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendDescription(from, pc.localDescription);
    await flushIce(peer);
  } else if (data.type === 'answer') {
    await peer.pc.setRemoteDescription(data);
    await flushIce(peer);
  } else if (data.candidate) {
    if (peer.pc?.remoteDescription) await peer.pc.addIceCandidate(data.candidate).catch(() => {});
    else peer.pendingIce.push(data.candidate);
  }
});

socket.on('user-joined', ({ id, name, muted }) => {
  addPeer(id, name, muted);
  toast(`${name} odaya katıldı`);
});

socket.on('user-left', (id) => {
  const peer = peers.get(id);
  if (peer) toast(`${peer.name} ayrıldı`);
  removePeer(id);
});

socket.on('user-muted', ({ id, muted }) => {
  const peer = peers.get(id);
  if (!peer) return;
  peer.muted = muted;
  setStatus(peer.row, muted ? 'Sessizde' : 'Bağlı');
});

socket.on('notice', toast);

// Sunucu bağlantısı koparsa odaya yeniden girmek en temiz çözüm.
socket.on('disconnect', () => toast('Sunucu bağlantısı koptu, yeniden bağlanılıyor…'));
socket.io.on('reconnect', () => location.reload());

// ---------- Mikrofon ----------

function renderMic() {
  const btn = $('mic-toggle');
  btn.textContent = micOn ? '🎙 Mikrofon açık' : '🔇 Mikrofon kapalı';
  btn.classList.toggle('off', !micOn);
}

$('mic-toggle').onclick = () => {
  if (!localStream) return;
  micOn = !micOn;
  localStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
  socket.emit('mute', !micOn);
  renderMic();
};

// ---------- İnternet kullanımı ----------
// Sesli sohbet WebRTC istatistiklerinden, senkron ise Socket.IO mesajlarından ölçülür.
// YouTube oynatıcısı başka bir siteden geldiği için onun verisi ölçülemez.

const UDP_OVERHEAD = 28; // paket başına IPv4 + UDP başlığı; getStats bunu saymaz
const WS_OVERHEAD = 6;   // mesaj başına yaklaşık WebSocket çerçeve başlığı
const usage = { voice: { down: 0, up: 0 }, sync: { down: 0, up: 0 } };
const encoder = new TextEncoder();

function fmtBytes(b) {
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

function fmtRate(bitsPerSec) {
  if (bitsPerSec >= 1e6) return `${(bitsPerSec / 1e6).toFixed(1)} Mbps`;
  return `${Math.round(bitsPerSec / 1000)} kbps`;
}

function packetBytes(packet) {
  const d = packet.data;
  const size = typeof d === 'string' ? encoder.encode(d).length : d?.byteLength || 0;
  return size + WS_OVERHEAD;
}

socket.io.on('open', () => {
  const engine = socket.io.engine;
  engine.on('packetCreate', (p) => (usage.sync.up += packetBytes(p)));
  engine.on('packet', (p) => (usage.sync.down += packetBytes(p)));
});

async function pollVoice() {
  for (const peer of peers.values()) {
    if (!peer.pc) continue;
    let down = 0;
    let up = 0;
    try {
      (await peer.pc.getStats()).forEach((s) => {
        if (s.type !== 'transport') return;
        down += (s.bytesReceived || 0) + (s.packetsReceived || 0) * UDP_OVERHEAD;
        up += (s.bytesSent || 0) + (s.packetsSent || 0) * UDP_OVERHEAD;
      });
    } catch {
      continue;
    }
    // Sayaçlar bağlantı başına birikir; sadece artışı ekleriz ki ayrılanların verisi kaybolmasın.
    usage.voice.down += Math.max(0, down - (peer.statDown || 0));
    usage.voice.up += Math.max(0, up - (peer.statUp || 0));
    peer.statDown = down;
    peer.statUp = up;
  }
}

function startUsageMeter() {
  let last = { down: 0, up: 0, time: performance.now() };
  setInterval(async () => {
    await pollVoice();
    const down = usage.voice.down + usage.sync.down;
    const up = usage.voice.up + usage.sync.up;
    const now = performance.now();
    const secs = (now - last.time) / 1000;
    $('use-rate').textContent =
      `↓ ${fmtRate(((down - last.down) * 8) / secs)}  ↑ ${fmtRate(((up - last.up) * 8) / secs)}`;
    $('use-total').textContent = `↓ ${fmtBytes(down)}  ↑ ${fmtBytes(up)}`;
    $('use-voice').textContent = `↓ ${fmtBytes(usage.voice.down)}  ↑ ${fmtBytes(usage.voice.up)}`;
    $('use-sync').textContent = `↓ ${fmtBytes(usage.sync.down)}  ↑ ${fmtBytes(usage.sync.up)}`;
    last = { down, up, time: now };
  }, 1000);
}

// ---------- YouTube senkronizasyonu ----------

let player = null;
let playerReady = false;
let media = null;        // sunucudan gelen son durum
let loadedId = null;
let seeking = false;
let stalled = 0;

const ytReady = new Promise((resolve) => {
  if (window.YT?.Player) resolve();
  else window.onYouTubeIframeAPIReady = resolve;
});

function expectedPosition() {
  if (!media) return 0;
  if (!media.playing) return media.position;
  return media.position + (serverNow() - media.updatedAt) / 1000;
}

async function createPlayer() {
  await ytReady;
  return new Promise((resolve) => {
    player = new YT.Player('player', {
      width: '100%',
      height: '100%',
      playerVars: { controls: 0, disablekb: 1, rel: 0, playsinline: 1, iv_load_policy: 3, modestbranding: 1 },
      events: {
        onReady: () => {
          playerReady = true;
          player.setVolume(Number($('music-vol').value));
          resolve();
        },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.ENDED && media?.current) {
            socket.emit('media:ended', media.current.videoId);
          }
          if (e.data === YT.PlayerState.PLAYING) $('unlock').hidden = true;
        },
      },
    });
  });
}

function applyMedia() {
  if (!playerReady || !media) return;
  const cur = media.current;

  $('player-empty').hidden = Boolean(cur);
  $('now-title').textContent = cur ? cur.title : '—';
  $('now-by').textContent = cur ? `${cur.by} ekledi` : '';
  $('play-toggle').textContent = media.playing ? '⏸' : '▶';

  if (!cur) {
    if (loadedId) player.stopVideo();
    loadedId = null;
    $('unlock').hidden = true;
    return;
  }

  const pos = expectedPosition();
  if (cur.videoId !== loadedId) {
    loadedId = cur.videoId;
    if (media.playing) player.loadVideoById({ videoId: cur.videoId, startSeconds: pos });
    else player.cueVideoById({ videoId: cur.videoId, startSeconds: pos });
    return;
  }

  const state = player.getPlayerState();
  if (media.playing) {
    if (Math.abs(player.getCurrentTime() - pos) > DRIFT_LIMIT) player.seekTo(pos, true);
    if (state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING) player.playVideo();
  } else {
    if (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING) player.pauseVideo();
    if (Math.abs(player.getCurrentTime() - pos) > 0.5) player.seekTo(pos, true);
  }
}

function renderQueue() {
  const list = $('queue');
  list.innerHTML = '';
  media.queue.forEach((item, i) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="q-text">
        <div class="q-title"></div>
        <div class="muted small"></div>
      </div>
      <button data-act="play">Şimdi oynat</button>
      <button data-act="remove" title="Sıradan çıkar">✕</button>`;
    li.querySelector('.q-title').textContent = item.title;
    li.querySelector('.small').textContent = `${item.by} ekledi`;
    li.querySelector('[data-act=play]').onclick = () => socket.emit('media:playNow', i);
    li.querySelector('[data-act=remove]').onclick = () => socket.emit('media:remove', i);
    list.append(li);
  });
  $('queue-empty').hidden = media.queue.length > 0;
}

socket.on('media', (state) => {
  media = state;
  renderQueue();
  applyMedia();
});

// Düzenli kontrol: kayma düzeltme, zaman çubuğu ve otomatik oynatma engeli.
setInterval(() => {
  if (!playerReady || !media?.current || loadedId !== media.current.videoId) return;
  const state = player.getPlayerState();
  const dur = player.getDuration() || 0;
  $('seek').max = dur;
  $('time-dur').textContent = fmtTime(dur);
  if (!seeking) {
    $('seek').value = player.getCurrentTime();
    $('time-cur').textContent = fmtTime(player.getCurrentTime());
  }

  if (media.playing && state === YT.PlayerState.PLAYING) {
    if (Math.abs(player.getCurrentTime() - expectedPosition()) > DRIFT_LIMIT) {
      player.seekTo(expectedPosition(), true);
    }
    stalled = 0;
  } else if (media.playing && state !== YT.PlayerState.BUFFERING) {
    // Tarayıcı otomatik oynatmayı engellediyse kullanıcıdan tek tık isteriz.
    player.playVideo();
    if (++stalled >= 3) $('unlock').hidden = false;
  } else {
    stalled = 0;
  }
}, 1000);

$('unlock').onclick = () => {
  player.seekTo(expectedPosition(), true);
  player.playVideo();
};

$('play-toggle').onclick = () => {
  if (!media?.current) return;
  const pos = player.getCurrentTime();
  socket.emit(media.playing ? 'media:pause' : 'media:play', pos);
};

$('next').onclick = () => socket.emit('media:next');

$('seek').oninput = () => {
  seeking = true;
  $('time-cur').textContent = fmtTime($('seek').value);
};
$('seek').onchange = () => {
  seeking = false;
  socket.emit('media:seek', Number($('seek').value));
};

$('music-vol').oninput = () => player?.setVolume(Number($('music-vol').value));

$('add-form').onsubmit = (e) => {
  e.preventDefault();
  const id = parseVideoId($('yt-url').value);
  if (!id) return toast('Geçerli bir YouTube linki değil.');
  socket.emit('media:add', id);
  $('yt-url').value = '';
};

// ---------- Giriş / çıkış ----------

const params = new URLSearchParams(location.search);
$('room').value = params.get('oda') || randomRoom();
$('name').value = localStorage.getItem('name') || '';

$('join-form').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('name').value.trim();
  const room = $('room').value.trim().toLowerCase();
  const btn = e.submitter;
  btn.disabled = true;
  $('join-error').hidden = true;

  try {
    localStorage.setItem('name', name);
  } catch {}

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch {
    localStream = null;
    $('mic-note').textContent = 'Mikrofona erişilemedi; sadece dinleyebilirsin.';
    $('mic-note').hidden = false;
    $('mic-toggle').disabled = true;
  }

  ({ iceServers } = await fetch('/config').then((r) => r.json()));
  socket.connect();
  const res = await new Promise((r) => socket.emit('join', { room, name }, r));

  if (res.error) {
    socket.disconnect();
    localStream?.getTracks().forEach((t) => t.stop());
    $('join-error').textContent = res.error;
    $('join-error').hidden = false;
    btn.disabled = false;
    return;
  }

  selfId = res.id;
  history.replaceState(null, '', `?oda=${encodeURIComponent(room)}`);
  $('room-label').textContent = room;
  $('join-screen').hidden = true;
  $('room-screen').hidden = false;

  const selfRow = personRow(name, true);
  setStatus(selfRow, localStream ? 'Sen' : 'Sadece dinleyici');
  if (localStream) watchLevel(localStream, selfRow);
  renderMic();
  renderPeopleCount();
  startUsageMeter();

  await Promise.all([syncClock(), createPlayer()]);

  for (const p of res.peers) {
    addPeer(p.id, p.name, p.muted);
    callPeer(p.id);
  }

  media ||= res.media;
  renderQueue();
  applyMedia();
};

$('copy-link').onclick = async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Davet linki kopyalandı');
  } catch {
    toast(location.href);
  }
};

$('leave').onclick = () => {
  location.href = location.pathname;
};
