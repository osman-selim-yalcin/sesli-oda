'use strict';

const $ = (id) => document.getElementById(id);
const DRIFT_LIMIT = 1.5;      // saniye; bundan fazla kayınca yeniden hizalanır
const VOICE_BITRATE = 32000;  // bps; Opus için konuşma kalitesi yeterli

const socket = io({ autoConnect: false });
const peers = new Map();      // id -> { name, muted, pc, audio, gain, pendingIce, row, speaking }
let iceServers = [];
let localStream = null;
let micOn = true;
let selfId = null;
let audioCtx = null;
let voiceBus = null;          // tüm konuşmaların geçtiği kompresör
let sfxBus = null;

// Her sekmenin kalıcı kimliği: yenileyince sunucu eski kaydı silebilsin.
const clientId = (() => {
  try {
    let id = sessionStorage.getItem('clientId');
    if (!id) sessionStorage.setItem('clientId', (id = crypto.randomUUID()));
    return id;
  } catch {
    return crypto.randomUUID();
  }
})();

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

// ---------- Ses altyapısı ----------
// Konuşmalar tek bir kompresörden geçer: aynı anda birkaç kişi konuşunca
// ses patlamaz, kısık konuşan da duyulur.

function setupAudio() {
  if (audioCtx) return;
  audioCtx = new AudioContext();
  voiceBus = audioCtx.createDynamicsCompressor();
  voiceBus.threshold.value = -26;
  voiceBus.knee.value = 12;
  voiceBus.ratio.value = 4;
  voiceBus.attack.value = 0.005;
  voiceBus.release.value = 0.25;
  const makeup = audioCtx.createGain();
  makeup.gain.value = 1.4;
  voiceBus.connect(makeup).connect(audioCtx.destination);

  sfxBus = audioCtx.createGain();
  sfxBus.gain.value = Number($('sfx-vol').value) / 100;
  sfxBus.connect(audioCtx.destination);
}

// ---------- Konuşma göstergesi ----------

const SPEAK_THRESHOLD = 12;
const SPEAK_HOLD = 350; // ms; kelime aralarında gösterge titremesin

function watchLevel(source, row, state) {
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.fftSize);
  let lastLoud = 0;
  const timer = setInterval(() => {
    if (!row.isConnected) return clearInterval(timer);
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
    if (peak > SPEAK_THRESHOLD) lastLoud = Date.now();
    state.speaking = Date.now() - lastLoud < SPEAK_HOLD;
    row.classList.toggle('speaking', state.speaking);
  }, 100);
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
      <div class="p-name"><span class="p-label"></span> <span class="p-badge" hidden title="Videosu yükleniyor">⏳</span></div>
      <div class="p-status"></div>
    </div>`;
  li.querySelector('.avatar').textContent = name.slice(0, 1).toUpperCase();
  li.querySelector('.p-label').textContent = isSelf ? `${name} (sen)` : name;
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

  // Chrome, uzaktan gelen sesi Web Audio'ya ancak bir medya öğesine bağlıyken verir;
  // öğe sessiz çalar, asıl ses kompresörden çıkar.
  const audio = new Audio();
  audio.muted = true;
  const gain = audioCtx.createGain();
  gain.connect(voiceBus);

  const peer = { name, muted, pc: null, audio, gain, source: null, pendingIce: [], row, speaking: false, localMuted: false };
  const applyGain = () => (gain.gain.value = peer.localMuted ? 0 : vol.value / 100);
  vol.oninput = applyGain;

  // Kişiyi sadece kendin için susturma (karşı taraf bunu görmez).
  const muteBtn = document.createElement('button');
  muteBtn.className = 'icon p-mute';
  row.append(muteBtn);
  const renderMute = () => {
    muteBtn.textContent = peer.localMuted ? '🔇' : '🔊';
    muteBtn.title = peer.localMuted ? `${name} sesini aç` : `${name} sesini kapat`;
    muteBtn.classList.toggle('off', peer.localMuted);
    vol.disabled = peer.localMuted;
  };
  muteBtn.onclick = () => {
    peer.localMuted = !peer.localMuted;
    applyGain();
    renderMute();
  };
  renderMute();

  peers.set(id, peer);
  setStatus(row, muted ? 'Sessizde' : 'Bağlanıyor…');
  renderPeopleCount();
  return peer;
}

function removePeer(id) {
  const peer = peers.get(id);
  if (!peer) return;
  peer.pc?.close();
  peer.source?.disconnect();
  peer.gain.disconnect();
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
    const stream = e.streams[0] || new MediaStream([e.track]);
    peer.audio.srcObject = stream;
    peer.audio.play().catch(() => {});
    peer.source?.disconnect();
    peer.source = audioCtx.createMediaStreamSource(stream);
    peer.source.connect(peer.gain);
    watchLevel(peer.source, peer.row, peer);
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
socket.on('disconnect', (reason) => {
  if (reason === 'io server disconnect') toast('Bu oda başka bir sekmede açıldı.');
  else toast('Sunucu bağlantısı koptu, yeniden bağlanılıyor…');
});
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
const usage = { voice: { down: 0, up: 0 }, sync: { down: 0, up: 0 }, youtube: 0 };
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

// YouTube'un verisi ölçülemez; tahmin = yeni indirilen video süresi × o kalitenin tipik veri hızı.
// Değerler video + ses birlikte, Mbps; YouTube'un gerçek hızı videoya göre ±%30 oynar.
const YT_MBPS = { tiny: 0.25, small: 0.4, medium: 0.75, large: 1.2, hd720: 2.2, hd1080: 3.8, hd1440: 8, hd2160: 16, highres: 16 };
const YT_MAX_STEP = 30; // sn; tek ölçümde sayılacak en fazla yeni tampon (sarma atlamalarına karşı)
const ytTrack = { id: null, loaded: 0, reset: false };

// Oynatıcı kaliteyi bildirmezse, oynatıcının gerçek piksel yüksekliğinden kestiririz.
function ytQuality() {
  const q = player.getPlaybackQuality?.();
  if (YT_MBPS[q]) return q;
  const h = player.getIframe().clientHeight * devicePixelRatio;
  if (h <= 160) return 'tiny';
  if (h <= 260) return 'small';
  if (h <= 380) return 'medium';
  if (h <= 500) return 'large';
  return h <= 760 ? 'hd720' : 'hd1080';
}

function pollYouTube() {
  if (!playerReady || !loadedId) return;
  const loaded = (player.getVideoLoadedFraction() || 0) * (player.getDuration() || 0);
  if (ytTrack.id !== loadedId || ytTrack.reset) {
    // Yeni video başlangıç konumundan, sarmadan sonra ise mevcut tampondan saymaya başlar.
    if (ytTrack.id === loadedId) ytTrack.loaded = loaded;
    ytTrack.id = loadedId;
    ytTrack.reset = false;
  }
  const fresh = Math.min(YT_MAX_STEP, loaded - ytTrack.loaded);
  if (fresh > 0) usage.youtube += (fresh * YT_MBPS[ytQuality()] * 1e6) / 8;
  ytTrack.loaded = Math.max(ytTrack.loaded, loaded);
}

function startUsageMeter() {
  let last = { down: 0, up: 0, time: performance.now() };
  setInterval(async () => {
    await pollVoice();
    pollYouTube();
    const down = usage.voice.down + usage.sync.down + usage.youtube;
    const up = usage.voice.up + usage.sync.up;
    const now = performance.now();
    const secs = (now - last.time) / 1000;
    $('use-rate').textContent =
      `↓ ${fmtRate(((down - last.down) * 8) / secs)}  ↑ ${fmtRate(((up - last.up) * 8) / secs)}`;
    $('use-total').textContent = `↓ ~${fmtBytes(down)}  ↑ ${fmtBytes(up)}`;
    $('use-yt').textContent = `↓ ~${fmtBytes(usage.youtube)}`;
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

function seekPlayer(pos) {
  player.seekTo(pos, true);
  ytTrack.reset = true;
}

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
          player.setVolume(musicVolume());
          new ResizeObserver(applyQuality).observe($('player-wrap'));
          applyQuality();
          resolve();
        },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.ENDED && media?.current) {
            socket.emit('media:ended', media.current.videoId);
          }
          if (e.data === YT.PlayerState.PLAYING) $('unlock').hidden = true;
          trackBuffering(e.data === YT.PlayerState.BUFFERING);
        },
      },
    });
  });
}

// ---------- Kişiye özel video kalitesi ----------
// YouTube kaliteyi oynatıcının piksel boyutuna göre seçer. Oynatıcıyı küçük boyutta
// tutup ekranda büyütünce (CSS scale) düşük kaliteye geçer ve daha az veri harcar.
// Her kişinin ayarı sadece kendi cihazını etkiler.

const QUALITY_PIXELS = { medium: [640, 360], low: [256, 144] }; // gerçek ekran pikseli

function applyQuality() {
  const iframe = player?.getIframe?.();
  if (!iframe) return;
  const mode = $('quality').value;
  if (!QUALITY_PIXELS[mode]) {
    iframe.style.width = iframe.style.height = iframe.style.transform = '';
    return;
  }
  const [w, h] = QUALITY_PIXELS[mode].map((v) => v / devicePixelRatio);
  iframe.style.width = `${w}px`;
  iframe.style.height = `${h}px`;
  iframe.style.transformOrigin = '0 0';
  iframe.style.transform = `scale(${$('player-wrap').clientWidth / w})`;
}

try {
  $('quality').value = localStorage.getItem('quality') || 'auto';
} catch {}
$('quality').onchange = () => {
  try {
    localStorage.setItem('quality', $('quality').value);
  } catch {}
  applyQuality();
};

// ---------- Donma takibi ----------
// Video 1 sn'den uzun yüklenirse diğerlerine "⏳" gösterilir. Sık donuyorsa kaliteyi düşürmeyi öneririz.

const BUFFER_REPORT_DELAY = 1000;
let bufferTimer = null;
let reportedBuffering = false;
let freezes = [];
let qualityHintShown = false;

function trackBuffering(buffering) {
  clearTimeout(bufferTimer);
  if (buffering) {
    bufferTimer = setTimeout(() => {
      reportedBuffering = true;
      socket.emit('video-state', 'buffering');
      freezes = freezes.filter((t) => Date.now() - t < 60000).concat(Date.now());
      if (freezes.length >= 3 && $('quality').value !== 'low' && !qualityHintShown) {
        qualityHintShown = true;
        toast('Videon sık donuyor. "Video kalitesi"ni Düşük yapmayı dene.');
      }
    }, BUFFER_REPORT_DELAY);
  } else if (reportedBuffering) {
    reportedBuffering = false;
    socket.emit('video-state', 'ok');
  }
}

socket.on('video-state', ({ id, state }) => {
  const peer = peers.get(id);
  if (peer) peer.row.querySelector('.p-badge').hidden = state !== 'buffering';
});

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
    ytTrack.loaded = pos;
    if (media.playing) player.loadVideoById({ videoId: cur.videoId, startSeconds: pos });
    else player.cueVideoById({ videoId: cur.videoId, startSeconds: pos });
    return;
  }

  const state = player.getPlayerState();
  if (media.playing) {
    if (Math.abs(player.getCurrentTime() - pos) > DRIFT_LIMIT) seekPlayer(pos);
    if (state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING) player.playVideo();
  } else {
    if (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING) player.pauseVideo();
    if (Math.abs(player.getCurrentTime() - pos) > 0.5) seekPlayer(pos);
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
      seekPlayer(expectedPosition());
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
  seekPlayer(expectedPosition());
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

// Biri konuşurken müzik yumuşakça kısılır, susunca geri açılır.
const DUCK_LEVEL = 0.3;
let duck = 1;
let appliedVolume = null;

function musicVolume() {
  return Math.round(Number($('music-vol').value) * duck);
}

setInterval(() => {
  if (!playerReady) return;
  const talking = $('duck-toggle').checked && [...peers.values()].some((p) => p.speaking && !p.localMuted);
  const target = talking ? DUCK_LEVEL : 1;
  // Kısma hızlı, geri açma yavaş: konuşma aralarında müzik inip çıkmasın.
  duck = target < duck ? Math.max(target, duck - 0.2) : Math.min(target, duck + 0.04);
  const vol = musicVolume();
  if (vol !== appliedVolume) {
    player.setVolume(vol);
    appliedVolume = vol;
  }
}, 100);

// ---------- Ses efektleri ----------

function renderSfx() {
  for (const fx of SFX_LIST) {
    const btn = document.createElement('button');
    btn.className = 'sfx-btn';
    btn.textContent = fx.emoji;
    btn.title = fx.label;
    btn.onclick = () => {
      if (btn.disabled) return;
      Sfx.play(audioCtx, sfxBus, fx.id);
      socket.emit('sfx', fx.id);
      // Sunucudaki bekleme süresiyle aynı; spam'i önler.
      document.querySelectorAll('.sfx-btn').forEach((b) => (b.disabled = true));
      setTimeout(() => document.querySelectorAll('.sfx-btn').forEach((b) => (b.disabled = false)), 600);
    };
    $('sfx').append(btn);
  }
}
renderSfx();

socket.on('sfx', ({ id, by }) => {
  const fx = SFX_LIST.find((f) => f.id === id);
  if (!fx || !audioCtx) return;
  Sfx.play(audioCtx, sfxBus, id);
  toast(`${by}: ${fx.emoji} ${fx.label}`);
});

$('sfx-vol').oninput = () => sfxBus && (sfxBus.gain.value = Number($('sfx-vol').value) / 100);

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

  setupAudio();
  audioCtx.resume();
  Sfx.load(audioCtx);

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
  const res = await new Promise((r) => socket.emit('join', { room, name, clientId }, r));

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
  if (localStream) watchLevel(audioCtx.createMediaStreamSource(localStream), selfRow, {});
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

// Sekme kapanınca/yenilenince sunucuya hemen haber ver.
addEventListener('pagehide', () => socket.disconnect());
