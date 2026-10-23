'use strict';

const $ = (id) => document.getElementById(id);
const DRIFT_LIMIT = 1.5;      // saniye; bundan fazla kayınca yeniden hizalanır
const VOICE_BITRATE = 32000;  // bps; Opus için konuşma kalitesi yeterli
const SCREEN_BITRATE = 1000000; // bps; 720p/15fps ekran paylaşımı için yeterli

const socket = io({ autoConnect: false });
const peers = new Map();      // id -> { name, muted, pc, audio, gain, pendingIce, row, speaking }
let iceServers = [];
let localStream = null;       // ham mikrofon
let sendStream = null;        // ses eşiğinden geçmiş, karşıya giden ses
let gateNode = null;
let screenStream = null;      // kendi ekran paylaşımımız
let sharerId = null;          // odada ekranını paylaşan kişi
let micOn = true;
let myName = '';
let selfId = null;
let audioCtx = null;
let voiceBus = null;          // tüm konuşmaların geçtiği kompresör
let sfxBus = null;
let voiceOut = null;          // kompresörden sonraki konuşma sesi (kayıt buradan alır)

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

// İkonlar index.html'deki SVG setinden gelir (Lucide).
function icon(name) {
  return `<svg class="ic" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

// Düğmenin içeriğini ikon (+ isteğe bağlı yazı) yapar.
function setIcon(el, name, text) {
  el.innerHTML = icon(name);
  if (text) el.append(text);
}

// Cevap gelmezse sonsuza kadar beklenmez: süre dolunca null döner.
function emitAck(ms, event, ...args) {
  return new Promise((resolve) => socket.timeout(ms).emit(event, ...args, (err, res) => resolve(err ? null : res)));
}

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

const X_HOSTS = /(^|\.)(twitter|x|fxtwitter|vxtwitter|fixupx|fixvx)\.com$/;
const isX = (videoId) => Boolean(videoId?.startsWith('x:'));

function parseVideoId(input) {
  input = input.trim();
  if (/^[\w-]{11}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (X_HOSTS.test(url.hostname)) {
      const post = url.pathname.match(/\/status(?:es)?\/(\d{1,25})/)?.[1];
      return post ? `x:${post}` : null;
    }
    const id = /(^|\.)youtu\.be$/.test(url.hostname)
      ? url.pathname.slice(1, 12)
      : /(^|\.)youtube\.com$/.test(url.hostname)
        ? url.searchParams.get('v') || url.pathname.match(/\/(?:shorts|embed|live|v)\/([\w-]{11})/)?.[1]
        : null;
    return /^[\w-]{11}$/.test(id || '') ? id : null;
  } catch {
    return null;
  }
}

// ---------- Sunucu saati ----------
// Herkesin aynı saniyeyi çalabilmesi için sunucu ile saat farkını ölçeriz.

// performance.now kesintisiz ve hassastır; Date.now ms adımlı ve sistem saati değişince sıçrar.
let clockOffset = 0;
const localNow = () => performance.timeOrigin + performance.now();
const serverNow = () => localNow() + clockOffset;

async function syncClock() {
  let best = Infinity;
  for (let i = 0; i < 5; i++) {
    const t0 = localNow();
    const server = await emitAck(3000, 'time');
    if (server == null) continue;
    const t1 = localNow();
    const rtt = t1 - t0;
    if (rtt < best) {
      best = rtt;
      clockOffset = server + rtt / 2 - t1;
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
  voiceOut = makeup;

  sfxBus = audioCtx.createGain();
  sfxBus.gain.value = Number($('sfx-vol').value) / 100;
  sfxBus.connect(audioCtx.destination);

  // Telefonda ekran kilitlenince ya da arama gelince ses altyapısı durur ve kendiliğinden
  // dönmez; oda sessiz kalır, kayda da boşluk girer. Sayfaya dönünce ya da dokununca sürdür.
  const wake = () => audioCtx.state !== 'running' && audioCtx.resume().catch(() => {});
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && wake());
  document.addEventListener('pointerdown', wake);
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
    state.speaking = !state.silenced?.() && Date.now() - lastLoud < SPEAK_HOLD;
    row.classList.toggle('speaking', state.speaking);
    row.mini?.classList.toggle('speaking', state.speaking);
  }, 100);
}

// ---------- Katılımcı listesi ----------

function renderPeopleCount() {
  $('people-count').textContent = `${peers.size + 1}/6`;
}

// İsimden sabit bir renk: herkes her yerde (liste, sohbet) aynı renkte görünür.
const AVATAR_COLORS = ['#c2413b', '#d9822b', '#b59a1f', '#3f9b4f', '#1f9a8a', '#2f7fc1', '#5b5fd6', '#8f4fc9', '#c2448f', '#6b7280'];

// Profil resmi olanlar: { ad: sürüm }. Resmi olmayanın avatarı baş harfi ve isimden gelen renktir.
let profiles = {};

function makeAvatar(name) {
  const el = document.createElement('div');
  el.className = 'avatar';
  el.dataset.name = name;
  el.title = name;
  fillAvatar(el);
  return el;
}

function fillAvatar(el) {
  const name = el.dataset.name;
  const version = profiles[name];
  el.replaceChildren();
  el.style.background = '';
  if (version) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = `avatar/${encodeURIComponent(name)}?v=${version}`;
    el.append(img);
    return;
  }
  el.textContent = [...name][0]?.toLocaleUpperCase('tr-TR') || '?';
  el.style.background = avatarColor(name);
}

function avatarColor(name) {
  let hash = 2166136261; // FNV-1a: benzer isimler de farklı renge düşsün
  for (const ch of name) hash = Math.imul(hash ^ ch.codePointAt(0), 16777619);
  return AVATAR_COLORS[(hash >>> 0) % AVATAR_COLORS.length];
}

function setProfile(name, version) {
  if (version) profiles[name] = version;
  else delete profiles[name];
  for (const el of document.querySelectorAll('.avatar')) if (el.dataset.name === name) fillAvatar(el);
}

socket.on('profile', ({ name, avatar }) => setProfile(name, avatar));

function personRow(name, isSelf) {
  const li = document.createElement('li');
  li.innerHTML = `
    <div class="p-info">
      <div class="p-name"><span class="p-label"></span> <span class="p-badge" hidden title="Videosu yükleniyor">${icon('loader')}</span></div>
      <div class="p-status"></div>
    </div>`;
  li.prepend(makeAvatar(name));
  li.querySelector('.p-label').textContent = isSelf ? `${name} (sen)` : name;
  $('people').append(li);
  // Araç çubuğundaki küçük ikon; kimin konuştuğu liste kapalıyken de görünsün.
  li.mini = makeAvatar(name);
  $('avatar-strip').append(li.mini);
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

  const peer = { name, muted, pc: null, audio, gain, source: null, pendingIce: [], row, speaking: false, localMuted: false, badSince: null, retries: 0 };
  const applyGain = () => (gain.gain.value = peer.localMuted ? 0 : vol.value / 100);
  vol.oninput = applyGain;

  // Kişiyi sadece kendin için susturma (karşı taraf bunu görmez).
  const muteBtn = document.createElement('button');
  muteBtn.className = 'icon p-mute';
  row.append(muteBtn);
  const renderMute = () => {
    setIcon(muteBtn, peer.localMuted ? 'volume-x' : 'volume');
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
  if (peer.screenAudio) peer.screenAudio.srcObject = null;
  peer.row.remove();
  peer.row.mini.remove();
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

// Gönderilen ses ve görüntüye bitrate sınırı koyar (sınırlar anlaşmadan sonra uygulanabilir).
function applyLimits(pc) {
  for (const sender of pc.getSenders()) {
    if (!sender.track) continue;
    const params = sender.getParameters();
    if (!params.encodings?.length) continue;
    params.encodings[0].maxBitrate = sender.track.kind === 'video' ? SCREEN_BITRATE : VOICE_BITRATE;
    sender.setParameters(params).catch(() => {});
  }
}

// Ekran görüntüsü ve (varsa) sekme sesi birlikte gider.
function addScreenTrack(peer) {
  peer.screenSenders = screenStream.getTracks().map((track) => peer.pc.addTrack(track, screenStream));
}

// Bağlantılar sonradan değişebilir (ekran paylaşımı açılıp kapanınca), bu yüzden
// iki taraf da teklif gönderebilir. Çakışmada "kibar" taraf geri çekilir (perfect negotiation).
function createPc(id) {
  const peer = peers.get(id);
  const pc = new RTCPeerConnection({ iceServers });
  peer.pc = pc;
  peer.polite = selfId < id;
  peer.makingOffer = false;
  peer.badSince = Date.now();

  if (sendStream) {
    for (const track of sendStream.getAudioTracks()) pc.addTrack(track, sendStream);
  } else {
    pc.addTransceiver('audio', { direction: 'recvonly' });
  }
  if (screenStream) addScreenTrack(peer);

  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      sendDescription(id, pc.localDescription);
      applyLimits(pc);
    } catch (err) {
      console.warn('negotiation', err);
    } finally {
      peer.makingOffer = false;
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal', { to: id, data: { candidate: e.candidate } });
  };

  pc.ontrack = (e) => {
    const stream = e.streams[0] || new MediaStream([e.track]);
    if (e.track.kind === 'video') {
      peer.screen = stream;
      renderScreen();
      return;
    }
    // İlk gelen ses kişinin mikrofonudur; başka akıştan gelen ses ekran paylaşımının sesidir.
    peer.voiceStreamId ??= stream.id;
    if (stream.id !== peer.voiceStreamId) {
      peer.screenAudio ||= new Audio();
      peer.screenAudio.srcObject = new MediaStream([e.track]);
      peer.screenAudio.play().catch(() => {});
      return;
    }
    peer.audio.srcObject = stream;
    peer.audio.play().catch(() => {});
    peer.source?.disconnect();
    peer.source = audioCtx.createMediaStreamSource(stream);
    peer.source.connect(peer.gain);
    watchLevel(peer.source, peer.row, peer);
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected') {
      setStatus(peer.row, peer.muted ? 'Sessizde' : 'Bağlı');
      peer.badSince = null;
      peer.retries = 0;
      return;
    }
    peer.badSince ??= Date.now();
    if (s === 'failed') {
      setStatus(peer.row, 'Yeniden bağlanıyor…');
      // Önce ağ yolu yeniden aranır; iki taraf aynı anda denemesin diye kaba taraf başlatır.
      if (!peer.polite) pc.restartIce();
    } else if (s === 'disconnected') setStatus(peer.row, 'Bağlantı koptu…');
  };

  return pc;
}

// Bağlantıyı baştan kurar; karşı taraf da kendi bağlantısını sıfırlasın diye haber verilir.
function resetPeer(id, notify) {
  const peer = peers.get(id);
  if (!peer) return;
  peer.pc?.close();
  peer.source?.disconnect();
  peer.source = null;
  peer.voiceStreamId = null;
  peer.screen = null;
  peer.screenSenders = null;
  if (peer.screenAudio) peer.screenAudio.srcObject = null;
  peer.pendingIce = [];
  if (notify) socket.emit('signal', { to: id, data: { reset: true } });
  createPc(id);
  setStatus(peer.row, 'Yeniden bağlanıyor…');
  renderScreen();
}

// Takılan bağlantılar (yarıda kalan kurulum, kopan ağ) sayfa yenilenmeden onarılır.
// Kaba taraf önce dener; o denemezse (sekmesi arka planda vb.) kibar taraf daha geç dener.
// Her başarısız denemede bekleme ikiye katlanır.
const PEER_RETRY = 12000; // ms
setInterval(() => {
  for (const [id, peer] of peers) {
    if (!peer.pc || peer.badSince == null) continue;
    const wait = PEER_RETRY * Math.min(2 ** peer.retries, 8) * (peer.polite ? 2.5 : 1);
    if (Date.now() - peer.badSince < wait) continue;
    peer.retries++;
    resetPeer(id, true);
  }
}, 2000);

async function flushIce(peer) {
  for (const c of peer.pendingIce.splice(0)) {
    await peer.pc.addIceCandidate(c).catch(() => {});
  }
}

socket.on('signal', async ({ from, data }) => {
  if (data.reset) return resetPeer(from, false);
  const peer = peers.get(from);
  const pc = peer?.pc;
  if (!pc) return;

  try {
    if (data.type) {
      const collision = data.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
      if (collision && !peer.polite) return;
      await pc.setRemoteDescription(data);
      if (data.type === 'offer') {
        await pc.setLocalDescription();
        sendDescription(from, pc.localDescription);
      }
      applyLimits(pc);
      await flushIce(peer);
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
      else peer.pendingIce.push(data.candidate);
    }
  } catch (err) {
    console.warn('signal', err);
  }
});

socket.on('user-joined', ({ id, name, muted }) => {
  addPeer(id, name, muted);
  createPc(id);
  renderRecBanner();
});

socket.on('user-left', (id) => {
  removePeer(id);
  renderRecBanner();
});

socket.on('user-muted', ({ id, muted }) => {
  const peer = peers.get(id);
  if (!peer) return;
  peer.muted = muted;
  setStatus(peer.row, muted ? 'Sessizde' : 'Bağlı');
});

socket.on('notice', toast);

socket.on('disconnect', (reason) => {
  if (reason === 'io client disconnect') return; // kendimiz çıktık
  if (reason === 'io server disconnect') toast('Bu hesapla başka bir sekmeden ya da cihazdan odaya girildi.');
  else toast('Sunucu bağlantısı koptu, yeniden bağlanılıyor…');
});

// Sunucu bağlantısı geri gelince odaya sayfa yenilenmeden yeniden girilir. Sunucu aynı
// sekmeyi (clientId) tanır: "ayrıldı/katıldı" mesajı çıkmaz.
let rejoining = false;
async function rejoin() {
  if (!selfId || rejoining) return; // henüz odaya girilmemişti
  rejoining = true;
  const res = await emitAck(15000, 'join', { room: ROOM, token: authToken, clientId });
  rejoining = false;
  if (!res) {
    if (socket.connected) setTimeout(rejoin, 2000);
    return;
  }
  if (res.error) return toast(`${res.error} Sayfayı yenileyip tekrar dene.`);

  applyJoin(res);
  if (!micOn) socket.emit('mute', true);
  if (recorder) socket.emit('rec', true);
  if (screenStream) {
    const r = await emitAck(5000, 'screen:start');
    if (!r || r.error) stopScreen();
  }
  syncClock();
  toast('Bağlantı geri geldi');
}
socket.io.on('reconnect', rejoin);

// ---------- Mikrofon ----------

function renderMic() {
  const btn = $('mic-toggle');
  setIcon(btn, micOn ? 'mic' : 'mic-off');
  btn.title = micOn ? 'Mikrofonu kapat' : 'Mikrofonu aç';
  btn.classList.toggle('off', !micOn);
}

$('mic-toggle').onclick = () => {
  if (!sendStream) return;
  micOn = !micOn;
  sendStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
  socket.emit('mute', !micOn);
  renderMic();
};

// ---------- Ses eşiği (gürültü kapısı) ----------
// Eşiğin altındaki sesler (klavye, fan, uzaktaki konuşmalar) karşıya gitmez.

const GATE_MIN = -80;
const GATE_MAX = -10;
const meterPct = (db) => Math.max(0, Math.min(100, ((db - GATE_MIN) / (GATE_MAX - GATE_MIN)) * 100));

try {
  $('gate').value = localStorage.getItem('gate') ?? -50;
} catch {}

function renderGate() {
  const db = Number($('gate').value);
  $('gate-value').textContent = `${db} dB`;
  $('meter-mark').style.left = `${meterPct(db)}%`;
  gateNode?.parameters.get('threshold').setValueAtTime(db, audioCtx.currentTime);
}

$('gate').oninput = () => {
  renderGate();
  try {
    localStorage.setItem('gate', $('gate').value);
  } catch {}
};

// Mikrofonu eşikten geçirip karşıya gidecek akışı hazırlar; olmazsa ham mikrofonu kullanır.
async function setupMic() {
  try {
    await audioCtx.audioWorklet.addModule('gate-worklet.js');
    gateNode = new AudioWorkletNode(audioCtx, 'noise-gate', { outputChannelCount: [1] });
    const dest = audioCtx.createMediaStreamDestination();
    audioCtx.createMediaStreamSource(localStream).connect(gateNode).connect(dest);
    gateNode.port.onmessage = ({ data }) => {
      $('meter-fill').style.width = `${meterPct(data.db)}%`;
      $('meter-fill').classList.toggle('open', data.open);
    };
    sendStream = dest.stream;
    renderGate();
  } catch (err) {
    console.warn('ses eşiği kullanılamıyor', err);
    sendStream = localStream;
    $('gate-btn').hidden = true;
  }
}

// ---------- Ekran paylaşımı ----------
// Tek seferde bir kişi paylaşabilir. Görüntü 720p/15fps ve kişi başı ~1 Mbps ile sınırlı;
// paylaşan kişi bunu odadaki herkese ayrı ayrı gönderir.

// Sekme/ekran sesini sadece Chromium tabanlı tarayıcılar (Chrome, Edge, Brave, Opera) verir;
// Firefox ve Safari ekran paylaşımında yalnızca görüntü verir. Telefondaki Chrome da Chromium
// görünür ama ekran/sekme paylaşımı hiç yoktur.
const TAB_AUDIO = Boolean(
  navigator.mediaDevices?.getDisplayMedia &&
    !navigator.userAgentData?.mobile &&
    navigator.userAgentData?.brands?.some((b) => b.brand === 'Chromium'),
);

async function startScreen() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { max: 1280 }, height: { max: 720 }, frameRate: { max: 15 } },
      audio: TAB_AUDIO && { suppressLocalAudioPlayback: false },
      systemAudio: 'include',
      // Bu sekme paylaşılırsa herkesin sesi geri döner (yankı); seçeneklerde gösterilmez.
      selfBrowserSurface: 'exclude',
    });
  } catch {
    return; // kullanıcı vazgeçti
  }
  const res = await new Promise((r) => socket.emit('screen:start', r));
  if (res.error) {
    screenStream.getTracks().forEach((t) => t.stop());
    screenStream = null;
    return toast(res.error);
  }
  const track = screenStream.getVideoTracks()[0];
  track.contentHint = 'detail';
  track.onended = stopScreen; // tarayıcının "Paylaşımı durdur" düğmesi
  screenStream.getAudioTracks().forEach((t) => (t.contentHint = 'music'));
  for (const peer of peers.values()) if (peer.pc) addScreenTrack(peer);
  renderScreen();

  if (!TAB_AUDIO) toast('Bu tarayıcı ekran sesini paylaşamıyor; sadece görüntü gidiyor. Ses için Chrome veya Edge kullan.');
  else if (!screenStream.getAudioTracks().length) toast('Ses paylaşılmıyor. Ses için bir sekme seçip "Sekme sesini de paylaş"ı aç.');
}

function stopScreen() {
  if (!screenStream) return;
  screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null;
  for (const peer of peers.values()) {
    peer.screenSenders?.forEach((sender) => peer.pc.removeTrack(sender));
    peer.screenSenders = null;
  }
  socket.emit('screen:stop');
  renderScreen();
}

function renderScreen() {
  const sharer = peers.get(sharerId);
  const stream = screenStream || (sharer?.screen ?? null);
  $('screen-wrap').hidden = !stream;
  if ($('screen-video').srcObject !== stream) $('screen-video').srcObject = stream;
  $('screen-label').textContent = screenStream
    ? 'Ekranını paylaşıyorsun'
    : sharer ? `${sharer.name} ekranını paylaşıyor` : '';
  $('screen-stop').hidden = !screenStream;
  $('screen-toggle').classList.toggle('on', Boolean(screenStream));
  $('screen-toggle').title = screenStream ? 'Paylaşımı durdur' : 'Ekran paylaş';
}

socket.on('screen', (id) => {
  sharerId = id;
  // Biten paylaşımın donmuş son karesi sonraki paylaşımda bir an görünmesin.
  if (!id) {
    for (const peer of peers.values()) {
      peer.screen = null;
      if (peer.screenAudio) peer.screenAudio.srcObject = null;
    }
  }
  if (id && peers.has(id)) toast(`${peers.get(id).name} ekranını paylaşıyor`);
  renderScreen();
});

$('screen-toggle').hidden = !navigator.mediaDevices?.getDisplayMedia;
$('screen-toggle').onclick = () => (screenStream ? stopScreen() : startScreen());
$('screen-stop').onclick = stopScreen;
$('screen-full').onclick = () => $('screen-video').requestFullscreen?.();

// ---------- Açılır pencereler ----------
// Tarayıcının popover özelliği pencereyi ortalar; biz açan düğmenin altına hizalarız.

for (const pop of document.querySelectorAll('.pop')) {
  pop.addEventListener('toggle', (e) => {
    if (e.newState !== 'open') return;
    const btn = document.querySelector(`[popovertarget="${pop.id}"]`).getBoundingClientRect();
    const width = pop.offsetWidth;
    // Aşağıda yer yoksa düğmenin üstünde açılır.
    const below = btn.bottom + 6 + pop.offsetHeight <= innerHeight - 16;
    pop.style.top = `${below ? btn.bottom + 6 : Math.max(16, btn.top - 6 - pop.offsetHeight)}px`;
    pop.style.left = `${Math.max(16, Math.min(btn.left, innerWidth - width - 16))}px`;
  });
}

// ---------- Sıra / önceden çalanlar ----------
// Geçmiş sunucuda (sunucu yeniden başlayana kadar) ve tarayıcıda (kalıcı) tutulur; ikisi birleştirilir.

const HISTORY_LIMIT = 200;
const PLAYLIST_LIMIT = 50; // YouTube'un geçici playlist sınırı
let playHistory = [];

function loadLocalHistory() {
  try {
    return JSON.parse(localStorage.getItem(historyKey())) || [];
  } catch {
    return [];
  }
}

function mergeHistory(entries) {
  const seen = new Set(playHistory.map((h) => `${h.videoId}@${h.playedAt}`));
  for (const h of entries) {
    const key = `${h.videoId}@${h.playedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    playHistory.push(h);
  }
  playHistory.sort((a, b) => a.playedAt - b.playedAt);
  playHistory = playHistory.slice(-HISTORY_LIMIT);
  try {
    localStorage.setItem(historyKey(), JSON.stringify(playHistory));
  } catch {}
  renderHistory();
}

function renderHistory() {
  const list = $('history');
  list.replaceChildren();
  for (const h of [...playHistory].reverse()) {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="q-text">
        <div class="q-title"></div>
        <div class="muted small"></div>
      </div>
      <button class="sm">${icon('plus')}Tekrar ekle</button>`;
    li.prepend(thumb(h.videoId, h.thumb));
    li.querySelector('.q-title').textContent = h.title;
    const when = new Date(h.playedAt).toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    li.querySelector('.small').textContent = `${h.by} ekledi · ${when}`;
    li.querySelector('button').onclick = (e) => {
      socket.emit('media:add', h.videoId);
      e.currentTarget.disabled = true;
    };
    list.append(li);
  }
  $('history-empty').hidden = playHistory.length > 0;
  $('history-playlist').disabled = playHistory.length === 0;
  $('history-count').textContent = playHistory.length || '';
}

socket.on('history:add', (entry) => mergeHistory([entry]));

// Son çalınan (tekrarsız) şarkılardan YouTube'un geçici playlist'i; giriş gerektirmez.
$('history-playlist').onclick = () => {
  const ids = [];
  for (const h of [...playHistory].reverse()) {
    if (!isX(h.videoId) && !ids.includes(h.videoId)) ids.push(h.videoId);
    if (ids.length === PLAYLIST_LIMIT) break;
  }
  ids.reverse();
  window.open(`https://www.youtube.com/watch_videos?video_ids=${ids.join(',')}`, '_blank', 'noopener');
};

function showTab(name) {
  for (const tab of ['queue', 'history']) {
    $(`tab-${tab}`).classList.toggle('active', name === tab);
    $(`${tab}-view`).hidden = name !== tab;
  }
}
$('tab-queue').onclick = () => showTab('queue');
$('tab-history').onclick = () => showTab('history');

// ---------- Üst çubuk: oda / oyunlar ----------
// Oyunlardayken oynatıcı ekrandan çıkarılır ama silinmez; müzik çalmaya devam eder.

function showPage(page) {
  const games = page === 'games';
  $('nav-room').classList.toggle('active', !games);
  $('nav-games').classList.toggle('active', games);
  document.querySelector('.media').classList.toggle('away', games);
  $('games').hidden = !games;
  renderTopbarNow();
}
$('nav-room').onclick = () => showPage('room');
$('nav-games').onclick = () => showPage('games');
$('topbar-now').onclick = () => showPage('room');

// Oyunlardayken çalan şarkı üst çubukta görünür.
function renderTopbarNow() {
  const btn = $('topbar-now');
  const title = media?.current?.title;
  btn.hidden = !title || $('games').hidden;
  if (title) setIcon(btn, 'music', title);
}

// ---------- Tier list ----------
// Her liste oluşturanındır; sadece o değiştirir, diğerleri canlı izler. Başkasının listesi
// "Kendine al" ile kopyalanır: aynı kartlar yerleşmemiş gelir, sıralamayı herkes kendi yapar.

const TIER_COLORS = ['#ff7f7f', '#ffbf7f', '#ffdf7f', '#bfff7f', '#7fbfff', '#a78bfa', '#f0a6e8', '#7fe0d0', '#cbd5e1'];
const CARD_IMAGE_SIDE = 320;
let tierLists = [];
let openListId = null;
let selectedCard = null;  // telefonda: dokunulan kart, sonra dokunulan satıra gider
let drag = null;          // sürüklenen kart
let tierRenderPending = false;

const openList = () => tierLists.find((l) => l.id === openListId);
const isMine = (list) => list.by === myName;
let focusNewTier = false; // satır ekleyince yeni satırın adı düzenlemeye açılır

function setTierLists(lists) {
  tierLists = lists;
  if (openListId && !openList()) {
    openListId = null;
    toast('Açık olan tier list silindi.');
  }
  renderTierLists();
}

function renderTierLists() {
  // Sürüklerken ya da satır adı yazılırken tahta yeniden çizilmez; bitince çizilir.
  const typing = $('tier-edit').contains(document.activeElement) && document.activeElement.matches('.tier-name, #tier-title');
  if (drag || typing) {
    tierRenderPending = true;
    return;
  }
  tierRenderPending = false;
  const list = openList();
  $('tier-home').hidden = Boolean(list);
  $('tier-edit').hidden = !list;
  if (list) renderTierBoard(list);
  else renderTierHome();
}

$('tier-edit').addEventListener('focusout', () => setTimeout(() => tierRenderPending && renderTierLists()));

function renderTierHome() {
  const mine = tierLists.filter(isMine);
  const others = tierLists.filter((l) => !isMine(l));
  for (const [id, lists] of [['tierlist-mine', mine], ['tierlist-others', others]]) {
    const ol = $(id);
    ol.replaceChildren();
    for (const list of lists) ol.append(tierListItem(list));
    $(`${id}-head`).hidden = !lists.length;
  }
  $('tierlist-empty').hidden = tierLists.length > 0;
}

// Kapak: listenin kendi resmi; yoksa sıradaki ilk kartın resmi; o da yoksa adının baş harfi.
function fillTierCover(el, list) {
  const first = [...list.tiers.flatMap((t) => t.cards), ...list.pool].map((id) => list.cards.find((c) => c.id === id)).find((c) => c?.image);
  const image = list.cover || first?.image;
  el.style.backgroundImage = image ? `url("${image}")` : '';
  el.style.backgroundColor = image ? '' : TIER_COLORS[list.id % TIER_COLORS.length];
  el.textContent = image ? '' : [...list.title.trim()][0]?.toLocaleUpperCase('tr-TR') || '?';
}

function tierListItem(list) {
  const placed = list.tiers.reduce((n, t) => n + t.cards.length, 0);
  const li = document.createElement('li');
  li.className = 'tierlist-item';
  li.innerHTML = `
    <div class="q-text">
      <div class="q-title"></div>
      <div class="muted small"></div>
    </div>`;
  const cover = document.createElement('span');
  cover.className = 'tier-cover';
  fillTierCover(cover, list);
  li.prepend(cover);
  li.querySelector('.q-title').textContent = list.title;
  // İsimlere ek getirmeyen ifadeler: "ayşe'nin", "ali'nin" gibi ekler isme göre değişir.
  const who = isMine(list) ? (list.from ? `Senin kopyan · ${list.from} oluşturmuştu` : 'Senin listen') : `${list.by} oluşturdu`;
  li.querySelector('.small').textContent = `${who} · ${list.cards.length} kart, ${placed} yerleşti`;
  const open = () => {
    openListId = list.id;
    selectedCard = null;
    renderTierLists();
  };
  li.onclick = open;
  const view = document.createElement('button');
  view.className = 'sm';
  view.textContent = isMine(list) ? 'Aç' : 'Gör';
  li.append(view);
  if (isMine(list)) {
    const del = document.createElement('button');
    del.className = 'sm danger';
    del.textContent = 'Sil';
    del.addEventListener('click', (e) => e.stopPropagation()); // listeyi açmasın
    confirmButton(del, 'Emin misin?', () => socket.emit('tierlist:delete', list.id));
    li.append(del);
  } else {
    const take = document.createElement('button');
    take.className = 'sm primary';
    take.textContent = 'Kendine al';
    take.onclick = (e) => {
      e.stopPropagation();
      copyTierList(list.id);
    };
    li.append(take);
  }
  return li;
}

async function copyTierList(listId) {
  const res = await emitAck(8000, 'tierlist:copy', listId);
  if (!res) return toast('Sunucuya ulaşılamadı.');
  if (res.error) return toast(res.error);
  openListId = res.id;
  selectedCard = null;
  renderTierLists();
  toast('Liste senin oldu; kartları istediğin gibi sırala.');
}

function tierCard(card) {
  const el = document.createElement('div');
  el.className = 'tier-card' + (card.image ? ' has-img' : '') + (selectedCard === card.id ? ' selected' : '');
  el.dataset.card = card.id;
  el.title = `${card.text || 'Resim'} · ${card.by} ekledi`;
  if (card.image) {
    const img = document.createElement('img');
    img.src = card.image;
    img.alt = card.text;
    img.draggable = false;
    el.append(img);
  }
  if (card.text) {
    const text = document.createElement('span');
    text.className = 'tier-card-text';
    text.textContent = card.text;
    el.append(text);
  }
  if (!isMine(openList())) return el; // başkasının listesi: sadece izlenir
  const del = document.createElement('button');
  del.className = 'tier-card-del';
  del.title = 'Kartı sil';
  setIcon(del, 'x');
  del.onclick = (e) => {
    e.stopPropagation();
    socket.emit('card:remove', { listId: openListId, cardId: card.id });
  };
  del.onpointerdown = (e) => e.stopPropagation();
  el.append(del);
  el.onpointerdown = (e) => startCardDrag(e, el, card.id);
  return el;
}

function fillDrop(zone, ids, cards) {
  zone.replaceChildren();
  for (const id of ids) if (cards.has(id)) zone.append(tierCard(cards.get(id)));
}

function renderTierBoard(list) {
  const mine = isMine(list);
  if (document.activeElement !== $('tier-title')) $('tier-title').value = list.title;
  $('tier-title').readOnly = !mine;
  $('tier-delete').hidden = !mine;
  fillTierCover($('tier-cover'), list);
  $('tier-cover-pick').classList.toggle('disabled', !mine);
  $('tier-cover-pick').title = mine ? 'Kapak resmini değiştir' : '';
  $('tier-cover-file').disabled = !mine;
  $('tier-cover-clear').hidden = !mine || !list.cover;
  $('tier-copy').hidden = mine;
  $('tier-add-row').hidden = !mine;
  $('card-form').hidden = !mine;
  $('tier-help').hidden = !mine;
  $('tier-edit').classList.toggle('readonly', !mine);
  $('tier-pool-head').textContent = mine ? 'Yerleştirilmemiş kartlar' : 'Yerleşmemiş kartlar';
  $('tier-owner').textContent = mine
    ? (list.from ? `Senin kopyan (${list.from} oluşturmuştu). Sadece sen değiştirebilirsin, diğerleri canlı izler.` : 'Bu liste senin; sadece sen değiştirebilirsin, diğerleri canlı izler.')
    : `Sahibi: ${list.by}. Sadece izleyebilirsin; kendi sıralamanı yapmak için "Kendine al"a bas.`;
  const cards = new Map(list.cards.map((c) => [c.id, c]));
  const board = $('tier-board');
  board.replaceChildren();
  list.tiers.forEach((tier, i) => {
    const row = document.createElement('div');
    row.className = 'tier-row';
    row.innerHTML = `
      <div class="tier-label"><input class="tier-name" maxlength="24" aria-label="Satır adı"></div>
      <div class="tier-items tier-drop"></div>
      <div class="tier-row-actions">
        <button data-act="up" class="icon sm ghost" title="Yukarı taşı">${icon('up')}</button>
        <button data-act="down" class="icon sm ghost" title="Aşağı taşı">${icon('chevron')}</button>
        <button data-act="remove" class="icon sm ghost" title="Satırı sil (kartlar aşağıya döner)">${icon('x')}</button>
      </div>`;
    const label = row.querySelector('.tier-label');
    label.style.background = TIER_COLORS[i % TIER_COLORS.length];
    const name = row.querySelector('.tier-name');
    name.value = tier.name;
    name.readOnly = !mine;
    if (mine) {
      // Renkli kutunun neresine tıklanırsa tıklansın ad düzenlenir; tıklayınca eski ad seçili gelir.
      label.title = 'Adını değiştirmek için tıkla';
      label.onclick = (e) => e.target !== name && name.focus();
      name.onfocus = () => name.select();
      name.onchange = () => {
        if (name.value.trim()) socket.emit('tier:rename', { listId: list.id, tierId: tier.id, name: name.value });
        else name.value = tier.name;
      };
      name.onkeydown = (e) => {
        if (e.key === 'Enter') name.blur();
        if (e.key === 'Escape') {
          name.value = tier.name;
          name.blur();
        }
      };
    }
    const drop = row.querySelector('.tier-drop');
    drop.dataset.tier = tier.id;
    fillDrop(drop, tier.cards, cards);
    const act = (sel, fn) => (row.querySelector(`[data-act=${sel}]`).onclick = fn);
    act('up', () => socket.emit('tier:shift', { listId: list.id, tierId: tier.id, dir: -1 }));
    act('down', () => socket.emit('tier:shift', { listId: list.id, tierId: tier.id, dir: 1 }));
    act('remove', () => socket.emit('tier:remove', { listId: list.id, tierId: tier.id }));
    row.querySelector('[data-act=up]').disabled = i === 0;
    row.querySelector('[data-act=down]').disabled = i === list.tiers.length - 1;
    row.querySelector('[data-act=remove]').disabled = list.tiers.length <= 1;
    if (!mine) row.querySelector('.tier-row-actions').remove();
    board.append(row);
  });
  if (focusNewTier && mine) {
    focusNewTier = false;
    board.querySelector('.tier-row:last-child .tier-name')?.focus();
  }
  fillDrop($('tier-pool'), list.pool, cards);
  $('tier-pool').classList.toggle('empty-pool', !list.pool.length);
  $('tier-add-row').disabled = list.tiers.length >= 12;
}

// ---------- Sürükle-bırak ----------
// Fare ve dokunmatik için aynı kod (pointer olayları). Kıpırdamadan bırakılırsa "dokunma" sayılır.

const DRAG_START_PX = 6;

function startCardDrag(e, el, cardId) {
  if (e.button !== 0) return;
  drag = { cardId, el, x: e.clientX, y: e.clientY, ghost: null, zone: null };
  el.setPointerCapture(e.pointerId);
  el.onpointermove = moveCardDrag;
  el.onpointerup = el.onpointercancel = endCardDrag;
}

function dropZoneAt(x, y) {
  return document.elementFromPoint(x, y)?.closest('#tier-edit .tier-drop, #tier-edit .tier-row') || null;
}

function moveCardDrag(e) {
  if (!drag) return;
  if (!drag.ghost) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_START_PX) return;
    const rect = drag.el.getBoundingClientRect();
    drag.ghost = drag.el.cloneNode(true);
    drag.ghost.classList.add('tier-ghost');
    drag.ghost.style.width = `${rect.width}px`;
    drag.ghost.style.height = `${rect.height}px`;
    drag.dx = drag.x - rect.left;
    drag.dy = drag.y - rect.top;
    document.body.append(drag.ghost);
    drag.el.classList.add('dragging');
  }
  drag.ghost.style.transform = `translate(${e.clientX - drag.dx}px, ${e.clientY - drag.dy}px)`;
  let zone = dropZoneAt(e.clientX, e.clientY);
  if (zone?.classList.contains('tier-row')) zone = zone.querySelector('.tier-drop');
  if (zone !== drag.zone) {
    drag.zone?.classList.remove('over');
    zone?.classList.add('over');
    drag.zone = zone;
  }
}

// Bırakılan noktadan önceki kart sayısı = yeni sıra.
function dropIndex(zone, x, y, cardId) {
  const others = [...zone.querySelectorAll('.tier-card')].filter((c) => Number(c.dataset.card) !== cardId);
  const i = others.findIndex((c) => {
    const r = c.getBoundingClientRect();
    return y < r.top || (y <= r.bottom && x < r.left + r.width / 2);
  });
  return i < 0 ? others.length : i;
}

function moveCard(cardId, zone, index) {
  const to = zone.dataset.tier ? Number(zone.dataset.tier) : null;
  socket.emit('card:move', { listId: openListId, cardId, to, index });
}

function endCardDrag(e) {
  if (!drag) return;
  const { cardId, ghost, zone } = drag;
  drag.el.onpointermove = drag.el.onpointerup = drag.el.onpointercancel = null;
  drag = null;
  if (ghost) {
    ghost.remove();
    zone?.classList.remove('over');
    document.querySelector('.tier-card.dragging')?.classList.remove('dragging');
    if (zone && e.type === 'pointerup') moveCard(cardId, zone, dropIndex(zone, e.clientX, e.clientY, cardId));
    else if (tierRenderPending) renderTierLists();
  } else if (e.type === 'pointerup') {
    selectedCard = selectedCard === cardId ? null : cardId;
    renderTierLists();
  }
}

// Seçili kart varken bir satıra (ya da aşağıdaki alana) dokunmak kartı oraya taşır.
$('tier-edit').addEventListener('click', (e) => {
  if (!selectedCard || !isMine(openList()) || e.target.closest('.tier-card, button, input')) return;
  let zone = e.target.closest('.tier-drop, .tier-row');
  if (zone?.classList.contains('tier-row')) zone = zone.querySelector('.tier-drop');
  if (!zone) return;
  const cardId = selectedCard;
  selectedCard = null;
  moveCard(cardId, zone);
});

socket.on('tierlists', setTierLists);

$('tierlist-new').onsubmit = async (e) => {
  e.preventDefault();
  const title = $('tierlist-title').value.trim();
  if (!title) return;
  const res = await emitAck(8000, 'tierlist:create', title);
  if (!res) return toast('Sunucuya ulaşılamadı.');
  if (res.error) return toast(res.error);
  $('tierlist-title').value = '';
  openListId = res.id;
  renderTierLists();
};

$('tier-back').onclick = () => {
  openListId = null;
  selectedCard = null;
  renderTierLists();
};
$('tier-title').onchange = () => {
  if ($('tier-title').value.trim()) socket.emit('tierlist:rename', { listId: openListId, title: $('tier-title').value });
};
$('tier-title').onkeydown = (e) => e.key === 'Enter' && e.currentTarget.blur();
$('tier-add-row').onclick = () => {
  focusNewTier = true;
  socket.emit('tier:add', openListId);
};
$('tier-copy').onclick = () => copyTierList(openListId);
async function setTierCover(data, type) {
  const res = await emitAck(15000, 'tierlist:cover', { listId: openListId, data, type });
  if (!res || res.error) toast(res?.error || 'Kapak değiştirilemedi.');
}
$('tier-cover-file').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const { blob, type } = await compressImage(file, CARD_IMAGE_SIDE, true);
    setTierCover(await blob.arrayBuffer(), type);
  } catch {
    toast(`Bu resim açılamadı: ${file.name}`);
  }
};
$('tier-cover-clear').onclick = () => setTierCover(null);

// Seçilen resimler kart eklenene kadar bekler; birden fazla seçilirse her biri ayrı kart olur.
let cardFiles = [];
$('card-file').onchange = () => {
  cardFiles = [...$('card-file').files].filter((f) => f.type.startsWith('image/'));
  $('card-file').value = '';
  $('card-pick-label').textContent = cardFiles.length ? `${cardFiles.length} resim` : 'Resim';
  $('card-form').querySelector('.card-pick').classList.toggle('picked', cardFiles.length > 0);
  if (cardFiles.length) $('card-text').focus();
};

$('card-form').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('card-text').value.trim();
  const files = cardFiles;
  if (!text && !files.length) return $('card-text').focus();
  const btn = e.submitter || $('card-form').querySelector('[type=submit]');
  btn.disabled = true;
  try {
    for (const [i, file] of (files.length ? files : [null]).entries()) {
      const card = { listId: openListId, text: files.length > 1 ? '' : text };
      if (file) {
        try {
          const { blob, type } = await compressImage(file, CARD_IMAGE_SIDE);
          Object.assign(card, { data: await blob.arrayBuffer(), type });
        } catch {
          toast(`Bu resim açılamadı: ${file.name}`);
          continue;
        }
      }
      if (i) await new Promise((r) => setTimeout(r, 350)); // sunucudaki hız sınırı
      const res = await emitAck(15000, 'card:add', card);
      if (!res || res.error) {
        toast(res?.error || 'Kart eklenemedi.');
        break;
      }
    }
  } finally {
    btn.disabled = false;
  }
  cardFiles = [];
  $('card-pick-label').textContent = 'Resim';
  $('card-form').querySelector('.card-pick').classList.remove('picked');
  $('card-text').value = '';
};

// ---------- Oyun sekmeleri ----------

function showGame(name) {
  for (const game of ['tier', 'timing', 'dino', 'peacock']) {
    $(`game-tab-${game}`).classList.toggle('active', game === name);
    $(`game-${game}`).hidden = game !== name;
  }
}
$('game-tab-tier').onclick = () => showGame('tier');
$('game-tab-timing').onclick = () => showGame('timing');
$('game-tab-peacock').onclick = () => showGame('peacock');
$('game-tab-dino').onclick = () => {
  showGame('dino');
  dinoKick();
};

// ---------- Süre tahmini ----------
// Başlatınca süre ekranda görünmeden sayar; durdurunca geçen süre ve hedeften farkı açılır.
// Hedef odada herkes için ortak; sonuçlar herkese gider.

const TIMING_TARGETS = [5, 10, 15, 30, 60];
const TIMING_BOARD = 10;
const RACE_ROUNDS = [3, 5, 10];
let timing = { target: 10, results: [], race: null };
let timingRun = null;  // serbest modda süre sayarken { start, target }
let timingLast = null; // serbest modda kendi son sonucum { elapsed, target }
let raceRounds = 5;    // yarış başlatırken seçili tur sayısı
let raceLocal = null;  // yarışta bu turun süresi: { id, round, start }; ekranda "???" çıktığı an başlar

// Yarışta turlar herkeste aynı anda başlar; sunucu turu, başlangıç anını ve sonuçların açılışını belirler.
const RACE_MISS = 10000; // durdurmayan o tur için bu kadar fark yemiş sayılır (sunucuyla aynı)
const activeRace = () => (timing.race && !timing.race.done ? timing.race : null);
const racePhase = (race) => (race.revealUntil ? 'reveal' : serverNow() < race.roundStart ? 'countdown' : 'running');
const raceDiff = (race, ms, i) => (ms == null ? RACE_MISS : Math.abs(ms - race.targets[i] * 1000));
const raceTotal = (race, name) => race.scores[name].slice(0, race.ended).reduce((sum, ms, i) => sum + raceDiff(race, ms, i), 0);

const fmtSeconds = (ms) => (ms / 1000).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDiff = (ms) => `${ms >= 0 ? '+' : '−'}${fmtSeconds(Math.abs(ms))} sn`;

// Farka göre yorum ve renk sınıfı
function timingVerdict(diff) {
  const abs = Math.abs(diff);
  if (abs <= 50) return ['Kusursuz!', 'great'];
  if (abs <= 150) return ['Çok yakın!', 'great'];
  if (abs <= 400) return ['İyi', 'good'];
  if (abs <= 1000) return ['Fena değil', 'ok'];
  return [diff > 0 ? 'Geç kaldın' : 'Erken bıraktın', 'far'];
}

function timingRow(name, main, sub, cls) {
  const li = document.createElement('li');
  li.append(makeAvatar(name));
  const text = document.createElement('span');
  text.className = 'timing-name';
  text.textContent = name;
  const val = document.createElement('span');
  val.className = `timing-val ${cls || ''}`;
  val.textContent = main;
  li.append(text, val);
  if (sub) {
    const small = document.createElement('span');
    small.className = 'muted small';
    small.textContent = sub;
    li.append(small);
  }
  return li;
}

function renderTiming() {
  const race = activeRace();
  if (race) {
    $('timing-label').textContent = `Yarış · Tur ${race.round + 1}/${race.targets.length}`;
    $('timing-target').textContent = `${race.targets[race.round]} sn`;
  } else {
    $('timing-label').textContent = 'Hedef';
    $('timing-target').textContent = `${timing.target} sn`;
  }
  $('timing-targets').hidden = Boolean(race);
  $('timing-custom').hidden = Boolean(race);
  for (const el of $('timing-custom').elements) el.disabled = Boolean(timingRun);
  $('race-setup').hidden = Boolean(race);

  const rounds = $('race-rounds');
  rounds.replaceChildren();
  for (const n of RACE_ROUNDS) {
    const b = document.createElement('button');
    b.className = 'sm' + (n === raceRounds ? ' active' : '');
    b.textContent = `${n} tur`;
    b.onclick = () => {
      raceRounds = n;
      renderTiming();
    };
    rounds.append(b);
  }
  $('race-start').disabled = Boolean(timingRun);
  renderRaceBoard();

  const chips = $('timing-targets');
  chips.replaceChildren();
  for (const t of [...TIMING_TARGETS, 'random']) {
    const b = document.createElement('button');
    b.className = 'sm' + (t === timing.target ? ' active' : '');
    b.textContent = t === 'random' ? 'Rastgele' : `${t} sn`;
    b.disabled = Boolean(timingRun);
    b.onclick = () => socket.emit('timing:target', t);
    chips.append(b);
  }

  const display = $('timing-display');
  const diffEl = $('timing-diff');
  display.className = 'timing-display';
  diffEl.className = 'timing-diff';
  $('timing-btn').disabled = false;
  document.querySelector('.timing-hint').textContent = race
    ? 'Tur herkeste aynı anda kendiliğinden başlar; boşluk tuşuyla da durdurabilirsin.'
    : 'Boşluk tuşuyla da başlatıp durdurabilirsin.';
  if (race) renderRaceRound(race, display, diffEl);
  else if (timingRun) {
    display.textContent = '???';
    display.classList.add('running');
    diffEl.textContent = 'Süre sayıyor… Hedefe geldiğini düşününce durdur.';
  } else if (timingLast) {
    const diff = timingLast.elapsed - timingLast.target * 1000;
    const [word, cls] = timingVerdict(diff);
    display.textContent = `${fmtSeconds(timingLast.elapsed)} sn`;
    diffEl.textContent = `${fmtDiff(diff)} · ${word}`;
    diffEl.classList.add(cls);
  } else {
    display.textContent = 'Hazır';
    diffEl.textContent = '';
  }
  if (!race) {
    $('timing-btn').textContent = timingRun ? 'Durdur' : 'Başlat';
    $('timing-btn').classList.toggle('stop', Boolean(timingRun));
  }

  // En iyiler: bu hedefte herkesin en yakın denemesi
  const best = new Map();
  for (const r of timing.results) {
    if (r.target !== timing.target) continue;
    const diff = r.elapsed - r.target * 1000;
    if (!best.has(r.name) || Math.abs(diff) < Math.abs(best.get(r.name).diff)) best.set(r.name, { ...r, diff });
  }
  const bestList = $('timing-best');
  bestList.replaceChildren();
  [...best.values()].sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff)).slice(0, TIMING_BOARD).forEach((r, i) => {
    const row = timingRow(r.name, fmtDiff(r.diff), `${fmtSeconds(r.elapsed)} sn`, timingVerdict(r.diff)[1]);
    row.prepend(Object.assign(document.createElement('span'), { className: 'timing-rank', textContent: i + 1 }));
    bestList.append(row);
  });
  if (!best.size) bestList.append(Object.assign(document.createElement('li'), { className: 'muted small', textContent: 'Bu hedefte henüz deneme yok.' }));

  const recent = $('timing-recent');
  recent.replaceChildren();
  for (const r of timing.results.slice(-TIMING_BOARD).reverse()) {
    const diff = r.elapsed - r.target * 1000;
    recent.append(timingRow(r.name, fmtDiff(diff), `${r.target} sn hedef`, timingVerdict(diff)[1]));
  }
  if (!timing.results.length) recent.append(Object.assign(document.createElement('li'), { className: 'muted small', textContent: 'Henüz deneme yok.' }));
}

// Yarışta ortadaki gösterge: geri sayım, "???" (süre sayıyor), kendi sonucum ya da turun sonucu.
function renderRaceRound(race, display, diffEl) {
  const phase = racePhase(race);
  const playing = race.players.includes(myName);
  const mine = race.scores[myName]?.[race.round]; // undefined: henüz durdurmadım, null: süre doldu
  const target = race.targets[race.round] * 1000;
  const btn = $('timing-btn');
  btn.classList.remove('stop');
  btn.disabled = true;
  if (phase === 'countdown') {
    display.textContent = Math.max(1, Math.ceil((race.roundStart - serverNow()) / 1000));
    diffEl.textContent = 'Hazırlan… Süre herkeste aynı anda başlayacak.';
    btn.textContent = 'Hazırlan';
  } else if (phase === 'running' && playing && mine === undefined) {
    display.textContent = '???';
    display.classList.add('running');
    diffEl.textContent = 'Süre sayıyor… Hedefe geldiğini düşününce durdur.';
    btn.textContent = 'Durdur';
    btn.disabled = false;
    btn.classList.add('stop');
  } else if (mine != null) {
    const diff = mine - target;
    const [word, cls] = timingVerdict(diff);
    display.textContent = `${fmtSeconds(mine)} sn`;
    diffEl.textContent = `${fmtDiff(diff)} · ${word}`;
    diffEl.classList.add(cls);
    btn.textContent = phase === 'reveal' ? 'Sonraki tur geliyor…' : 'Diğerleri bekleniyor…';
  } else if (playing && mine === null) {
    display.textContent = 'Durdurmadın';
    diffEl.textContent = `+${RACE_MISS / 1000} sn ceza`;
    diffEl.classList.add('far');
    btn.textContent = 'Sonraki tur geliyor…';
  } else {
    display.textContent = '???';
    diffEl.textContent = 'İzliyorsun; bu yarış başladığında odada değildin.';
    btn.textContent = 'İzliyorsun';
  }
}

// Yarış tablosu: biten turlardaki toplam farka göre; sürmekte olan turda kimin durdurduğu görünür.
function renderRaceBoard() {
  const race = timing.race;
  $('race-board').hidden = !race;
  if (!race) return;
  const n = race.targets.length;
  $('race-title').textContent = race.done ? 'Yarış bitti' : `Yarış · ${n} tur · ${race.by} başlattı`;
  $('race-end').hidden = race.done;
  $('race-close').hidden = !race.done;

  const names = [...race.players].sort((a, b) => raceTotal(race, a) - raceTotal(race, b));
  const best = names.length ? raceTotal(race, names[0]) : 0;
  const list = $('race-list');
  list.replaceChildren();
  names.forEach((name, i) => {
    const total = raceTotal(race, name);
    const won = race.done && race.ended > 0 && total === best;
    const ms = race.scores[name][race.round];
    let sub;
    if (race.done) sub = won ? 'Kazandı' : `${race.ended} tur`;
    else if (race.revealUntil) sub = ms == null ? 'durdurmadı' : `bu tur ${fmtDiff(ms - race.targets[race.round] * 1000)}`;
    else sub = ms === undefined ? 'sayıyor…' : 'durdurdu ✓';
    const row = timingRow(name, `${fmtSeconds(total)} sn`, sub, won ? 'great' : '');
    row.classList.toggle('winner', won);
    row.prepend(Object.assign(document.createElement('span'), { className: 'timing-rank', textContent: won ? '🏆' : i + 1 }));
    list.append(row);
  });
}

// Yarış sürerken ekranı geri sayıma ve tur başlangıcına göre günceller. "???" göründüğü an
// kendi sayacım başlar; böylece süre, ekranda başladığını gördüğüm andan ölçülür.
let raceTicker = 0;
let raceShown = '';
function raceTick() {
  const race = activeRace();
  if (!race) {
    clearInterval(raceTicker);
    raceTicker = 0;
    return;
  }
  const phase = racePhase(race);
  if (phase === 'running' && raceLocal?.round !== race.round && race.players.includes(myName) && race.scores[myName][race.round] === undefined) {
    raceLocal = { id: race.id, round: race.round, start: performance.now() };
  }
  const shown = `${race.id}|${race.round}|${phase}|${phase === 'countdown' ? Math.ceil((race.roundStart - serverNow()) / 1000) : ''}`;
  if (shown !== raceShown) {
    raceShown = shown;
    renderTiming();
  }
}
function startRaceTicker() {
  if (!raceTicker && activeRace()) raceTicker = setInterval(raceTick, 16);
}

// Elle hedef: 3-120 sn arası tam sayı (sunucu da aynı sınırı uygular).
$('timing-custom').onsubmit = (e) => {
  e.preventDefault();
  const input = $('timing-custom-input');
  const value = Number(input.value);
  if (!Number.isInteger(value) || value < 3 || value > 120) return toast('Hedef 3 ile 120 sn arasında tam sayı olmalı.');
  socket.emit('timing:target', value);
  input.value = '';
  input.blur(); // boşluk tuşu tekrar oyunu başlatsın
};

$('race-start').onclick = () => socket.emit('race:start', raceRounds);
confirmButton($('race-end'), 'Emin misin? Tekrar bas', () => socket.emit('race:end'));
$('race-close').onclick = () => socket.emit('race:close');

function toggleTiming() {
  const race = activeRace();
  if (race) {
    // Yarışta tur kendiliğinden başlar; sadece durdurulur.
    if (racePhase(race) !== 'running' || raceLocal?.id !== race.id || raceLocal.round !== race.round) return;
    if (race.scores[myName]?.[race.round] !== undefined) return;
    const elapsed = Math.round(performance.now() - raceLocal.start);
    race.scores[myName].push(elapsed); // sunucudan dönmesini beklemeden göster
    socket.emit('race:result', { id: race.id, round: race.round, elapsed });
    raceShown = '';
    renderTiming();
    return;
  }
  if (!timingRun) {
    timingRun = { start: performance.now(), target: timing.target };
    timingLast = null;
  } else {
    const elapsed = Math.round(performance.now() - timingRun.start); // sunucu da ms'ye yuvarlar
    const { target } = timingRun;
    timingLast = { elapsed, target };
    timingRun = null;
    socket.emit('timing:result', { elapsed, target });
  }
  renderTiming();
}
$('timing-btn').onclick = toggleTiming;

// Boşluk tuşu: oyun açıkken başlat/durdur (yazı alanındayken ya da başka düğme seçiliyken değil).
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat || $('games').hidden || $('game-timing').hidden) return;
  if (e.target.closest?.('input, textarea, select, button, [contenteditable=""], [contenteditable="true"]')) return;
  e.preventDefault();
  toggleTiming();
});

socket.on('timing', (state) => {
  timing = state;
  // Yarış başlayınca serbest moddaki sayaç iptal olur.
  if (activeRace()) {
    timingRun = null;
    timingLast = null;
    startRaceTicker();
  }
  raceShown = '';
  renderTiming();
});

// ---------- Dinozor koşusu ----------
// Dünya birimleriyle çalışır; tuval genişliği ne olursa olsun herkes aynı genişlikte bir alan görür,
// böylece "ekranın solundan çıkma" sınırı herkes için aynıdır. y yukarı doğru artar, zemin 0'dır.

const DINO = {
  viewW: 1100, viewH: 250, groundY: 215, // ekranda zeminin yüksekliği
  leaderX: 420,         // kamera en öndekini (çoğunlukla Jef'i) ekranın bu noktasında tutar
  gap: 60,              // oyuncular Jef'in arkasında bu aralıklarla sıralanır
  gravity: 2600, jump: 860, fastFall: 3200,
  w: 40, h: 44, duckW: 54, duckH: 26,
  sendEvery: 250, // ms; zıplama/eğilme dışında arada bir düzeltme yayını
};

// Tempo: hız herkes için otomatik ve gitgide artar. Konum kare kare toplanmaz, oyunun başından beri
// geçen süreden hesaplanır; takılan kareler ya da gecikme kimseyi yavaşlatmaz. Jef kusursuz oynayan
// bottur, en önde koşar; oyuncular onun arkasında sıralanır ve sadece zıplayıp eğilir.
// Sunucudaki DINO_PACE ile aynı olmalı.
const DINO_PACE = { runStart: 460, runAccel: 30, runMax: 1400 };
const dinoFullAt = (DINO_PACE.runMax - DINO_PACE.runStart) / DINO_PACE.runAccel; // sn; bu andan sonra hız sabit
const dinoFullX = DINO_PACE.runStart * dinoFullAt + (DINO_PACE.runAccel * dinoFullAt ** 2) / 2;
const dinoMaxSpeed = (t) => Math.min(DINO_PACE.runMax, DINO_PACE.runStart + DINO_PACE.runAccel * Math.max(0, t));
// Başlangıçtan t sn sonra Jef'in yeri
function dinoJefX(t) {
  if (t <= 0) return 0;
  if (t < dinoFullAt) return DINO_PACE.runStart * t + (DINO_PACE.runAccel * t * t) / 2;
  return dinoFullX + DINO_PACE.runMax * (t - dinoFullAt);
}
// Jef'in x'e vardığı an (sn): engel aralıkları o andaki hıza göre açılır.
function dinoTimeAt(x) {
  const { runStart: v, runAccel: a } = DINO_PACE;
  if (x < dinoFullX) return (-v + Math.sqrt(v * v + 2 * a * x)) / a;
  return dinoFullAt + (x - dinoFullX) / DINO_PACE.runMax;
}

// Jef'in x'teki duruşu: üstünden geçilecek engelin tam ortasında tepeye çıkacak şekilde zıplar,
// yüksek kuşun altından eğilerek geçer.
function dinoJefPose(x) {
  const air = (2 * DINO.jump) / DINO.gravity; // havada kalma süresi
  const pose = { x, y: 0, duck: false };
  for (const ob of dinoObstacles) {
    if (ob.x > x + 800) break;
    if (ob.x + ob.w < x - 800) continue;
    if (ob.top) continue; // en üstteki kuşun altından koşarak geçilir
    if (ob.kind === 'bird' && ob.y > 20) {
      if (x + DINO.duckW > ob.x - 8 && x < ob.x + ob.w + 8) pose.duck = true;
      continue;
    }
    const v = dinoMaxSpeed(dinoTimeAt(ob.x));
    const from = ob.x + ob.w / 2 - DINO.w / 2 - (v * air) / 2;
    if (x >= from && x <= from + v * air) {
      const t = (x - from) / v;
      pose.y = DINO.jump * t - (DINO.gravity * t * t) / 2;
    }
  }
  return pose;
}
const DINO_JEF_COLOR = '#e0b341';
const dinoElapsed = () => (dinoGame ? (serverNow() - dinoGame.startAt) / 1000 : 0);
const dinoJefNow = () => (dinoGame?.done ? dinoGame.jef ?? 0 : dinoJefX(dinoElapsed()));

let dinoGame = null;   // sunucudaki oyun: { id, seed, startAt, players, done }
let dinoMe = null;     // kendi dinozorum: { x, y, vx, vy, duck, dead }
let dinoCam = 0;
let dinoObstacles = []; // { x, y, w, h, kind }
let dinoRng = null;
let dinoNextX = 0;
let dinoLastSend = 0;
let dinoLoop = 0;
// Diğer oyuncuların son anlık durumu: { t (oyun saati), y, vy, duck, hold (zıplama basılı) }. x zamandan
// hesaplanır, y bu anlık durumdan aynı fizikle sürdürülür; geç gelen paket kimseyi havada asılı bırakmaz.
// Tahmin tutmayınca (geç gelen zıplama) aradaki fark (err) sıçramak yerine ~50 ms'de söner.
const dinoOthers = new Map();
let dinoEvent = false; // zıplama ya da eğilme değişti: hemen gönderilir
const dinoKeys = { jump: false, duck: false };
// Oyuncunun sıradaki yeri: oyuncu listesindeki sırası (herkeste aynı)
const dinoSlot = (game, name) => Object.keys(game.players).indexOf(name) + 1;

// Tohumdan sayı üreten küçük rastgele üreteç (mulberry32): herkes aynı engelleri görür.
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Engelleri ihtiyaç oldukça üretir. İlerledikçe aralar daralır, 1000'den sonra kuşlar da gelir.
function dinoFill(untilX) {
  while (dinoNextX < untilX) {
    const r = dinoRng();
    const x = dinoNextX;
    let ob;
    if (x > 1000 && r < 0.2) ob = { kind: 'bird', y: 36, w: 42, h: 24 };         // yüksek: eğil
    else if (x > 1000 && r < 0.32) ob = { kind: 'bird', y: 6, w: 42, h: 24 };    // alçak: zıpla
    // En üstten inen kuş sürüsü: altından koşarak ya da eğilerek geçilir; en yüksek zıplamanın da
    // üstüne uzandığı için zıplayan, aşamadan çarpar.
    else if (x > 1000 && r < 0.42) ob = { kind: 'bird', y: 54, w: 42, h: 160, top: true };
    else if (r < 0.6) ob = { kind: 'cactus', y: 0, w: 18, h: 38 };
    else if (r < 0.8) ob = { kind: 'cactus', y: 0, w: 26, h: 52 };
    else if (r < 0.93) ob = { kind: 'cactus', y: 0, w: 48, h: 38, group: 3 };
    else ob = { kind: 'cactus', y: 0, w: 64, h: 38, group: 4 };
    dinoObstacles.push({ ...ob, x });
    // Zıplayınca havada geçen sürede (~0,66 sn) alınan yoldan kısa ara bırakılmaz; hız arttıkça aralar da açılır.
    const t = dinoTimeAt(x);
    const hard = Math.min(1, t / 45);
    const min = dinoMaxSpeed(t) * 0.66 + 80 - 30 * hard, spread = 260 - 120 * hard;
    dinoNextX = x + ob.w + min + dinoRng() * spread;
  }
}

function setDino(game) {
  const fresh = game?.id !== dinoGame?.id;
  dinoGame = game;
  if (fresh) {
    dinoOthers.clear();
    dinoObstacles = [];
    dinoCam = 0;
    dinoMe = null;
    if (game) {
      dinoRng = seeded(game.seed);
      dinoNextX = 700;
      dinoFill(DINO.viewW * 2);
      const mine = game.players[myName];
      // Sayfayı yenileyen oyuncunun dinozoru kaybolur; oyunda takılı kalmasın diye ölmüş sayılır.
      if (mine && !mine.dead) {
        if (serverNow() < game.startAt) dinoMe = { t: 0, x: -DINO.gap * dinoSlot(game, myName), y: 0, vx: 0, vy: 0, duck: false, dead: false };
        else socket.emit('dino:dead', { id: game.id });
      }
    }
  }
  if (game) for (const name of Object.keys(game.players)) if (name !== myName && !dinoOthers.has(name)) dinoOthers.set(name, { t: 0, y: 0, vy: 0, duck: false, hold: false, shownY: 0, err: 0, errAt: 0 });
  renderDinoUi();
  if (game && !dinoLoop) dinoLoop = requestAnimationFrame(dinoFrame);
}
socket.on('dino', setDino);

socket.on('dino:pos', ({ name, t, y, vy, duck, hold }) => {
  const o = dinoOthers.get(name);
  if (!o || t < o.t) return; // sırası karışan eski paket
  Object.assign(o, { t, y, vy, duck, hold });
  o.err = o.shownY - dinoSimY(o);
  o.errAt = performance.now();
});

// Anlık durumdan şu anki y: dinoStep'in aynısı, zıplama basılı tutulursa yere değince yine zıplar.
function dinoSimY(o) {
  let { y, vy } = o;
  const end = Math.min(dinoElapsed(), o.t + 3);
  for (let t = o.t; t < end && (y > 0 || vy > 0 || o.hold); t += 1 / 120) {
    if (o.hold && y === 0) vy = DINO.jump;
    vy -= (o.duck && y > 0 ? DINO.fastFall : DINO.gravity) / 120;
    y = Math.max(0, y + vy / 120);
    if (y === 0) vy = Math.max(0, vy);
  }
  return y;
}

// Diğer oyuncunun şu anki duruşu: x sıradaki yerinden, y son anlık durumdan kendi fiziğimizle.
function dinoOtherPose(name, o) {
  const p = dinoGame.players[name];
  const slotX = DINO.gap * dinoSlot(dinoGame, name);
  const x = (p?.dead ? p.dist : dinoJefNow()) - slotX;
  const err = o.err * Math.exp(-(performance.now() - o.errAt) / 50);
  o.shownY = p?.dead ? 0 : Math.max(0, dinoSimY(o) + err);
  return { x, y: o.shownY, duck: o.duck };
}

function renderDinoUi() {
  const game = dinoGame;
  const running = game && !game.done;
  $('dino-start').hidden = Boolean(running);
  $('dino-help').innerHTML = '<b>W</b> / <b>↑</b> / boşluk: zıpla · <b>S</b> / <b>↓</b>: eğil (havadayken hızlı iner). '
    + 'Hız otomatik ve gitgide artar; herkes kusursuz koşan Jef\'in arkasında koşar. Engele çarpan ölür, en uzağa giden kazanır. '
    + 'Gökten inen <b style="color:#d9822b">turuncu kuş sürüsü</b>nün altından koşarak geç; zıplarsan çarparsın.';
  $('dino-start').textContent = game ? 'Tekrar oyna' : 'Başlat';
  let status = 'Odadaki herkes Jef\'in peşinden koşar. Başlatınca 5 sn geri sayım olur.';
  if (running) {
    const alive = Object.values(game.players).filter((p) => !p.dead).length;
    status = `${alive}/${Object.keys(game.players).length} kişi hayatta` + (game.players[myName] ? '' : ' · İzliyorsun');
  } else if (game) status = 'Oyun bitti.';
  $('dino-status').textContent = status;

  const list = $('dino-results');
  list.replaceChildren();
  if (!game) return;
  // Skor, ölene kadar geçen sürede Jef'in gittiği yol: sıradaki yer skoru etkilemez. Hayattakiler için şu anki yol.
  const dist = (name, p) => (p.dead || game.done ? p.dist : dinoJefNow());
  const rows = Object.entries(game.players).map(([name, p]) => [name, { ...p, dist: dist(name, p) }]).sort((a, b) => b[1].dist - a[1].dist);
  const jef = timingRow('Jef (bot)', `${Math.round(dinoJefNow() / 10)} m`, 'Kusursuz', '');
  jef.querySelector('.avatar').style.background = DINO_JEF_COLOR;
  jef.prepend(Object.assign(document.createElement('span'), { className: 'timing-rank', textContent: '🤖' }));
  list.append(jef);
  rows.forEach(([name, p], i) => {
    const won = game.done && i === 0 && rows.length > 1;
    const row = timingRow(name, `${Math.round(p.dist / 10)} m`, p.dead ? (won ? 'Kazandı' : 'Öldü') : 'Koşuyor', won ? 'great' : '');
    row.classList.toggle('winner', won);
    row.prepend(Object.assign(document.createElement('span'), { className: 'timing-rank', textContent: won ? '🏆' : i + 1 }));
    list.append(row);
  });
}

// Kalıcı skor tablosu: en iyi 10 skor. Eski modların (basılı tut, tıklama) skorları kayıtta durur, gösterilmez.
function renderDinoBoard(board) {
  const list = $('dino-board');
  list.replaceChildren();
  (board?.auto || []).forEach((r, i) => {
    const date = new Date(r.at).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
    const row = timingRow(r.name, `${Math.round(r.dist / 10)} m`, date, i === 0 ? 'great' : '');
    row.prepend(Object.assign(document.createElement('span'), { className: 'timing-rank', textContent: i + 1 }));
    list.append(row);
  });
  if (!board?.auto?.length) list.append(Object.assign(document.createElement('li'), { className: 'muted small', textContent: 'Henüz skor yok.' }));
}
socket.on('dino:board', renderDinoBoard);

$('dino-start').onclick = () => socket.emit('dino:start');

function dinoBox(d) {
  return d.duck && d.y === 0 ? { w: DINO.duckW, h: DINO.duckH } : { w: DINO.w, h: DINO.h };
}

// dt kadar ilerler. x zamandan gelir (Jef'in yeri eksi sıradaki yer); sadece zıplama kare kare hesaplanır.
function dinoStep(dt) {
  const me = dinoMe;
  me.t += dt;
  me.x = dinoJefX(me.t) - DINO.gap * dinoSlot(dinoGame, myName);
  me.vx = dinoMaxSpeed(me.t);
  if (dinoKeys.jump && me.y === 0) {
    me.vy = DINO.jump;
    dinoEvent = true;
    if (dinoSound) Chip.jump(audioCtx);
  }
  if (me.duck !== dinoKeys.duck || me.hold !== dinoKeys.jump) dinoEvent = true;
  me.hold = dinoKeys.jump;
  me.duck = dinoKeys.duck;
  me.vy -= (me.duck && me.y > 0 ? DINO.fastFall : DINO.gravity) * dt;
  me.y = Math.max(0, me.y + me.vy * dt);
  if (me.y === 0) me.vy = Math.max(0, me.vy);

  const { w, h } = dinoBox(me);
  const pad = 5; // kenarlara sürtünmek affedilir
  for (const ob of dinoObstacles) {
    if (ob.x > me.x + w) break;
    if (ob.x + ob.w < me.x) continue;
    if (me.x + w - pad > ob.x + pad && me.x + pad < ob.x + ob.w - pad && me.y + pad < ob.y + ob.h - pad && me.y + h - pad > ob.y + pad) return dinoDie();
  }
  if (me.x + w < dinoCam - DINO.leaderX) dinoDie();
}

function dinoDie() {
  dinoMe.dead = true;
  if (dinoSound) Chip.die(audioCtx);
  socket.emit('dino:dead', { id: dinoGame.id, x: dinoJefX(dinoMe.t) }); // skor: sıradaki yerden bağımsız
}

let dinoLastList = 0;
function dinoFrame(t) {
  dinoLoop = 0;
  if (!dinoGame) return dinoKick();
  const started = serverNow() >= dinoGame.startAt;
  if (started && dinoMe && !dinoMe.dead && !dinoGame.done) {
    // Oyunun saatine yetişene kadar küçük adımlarla ilerle: hızlıyken engelin içinden geçilmesin,
    // takılan kare de oyuncuyu geride bırakmasın.
    const now = Math.min(dinoElapsed(), dinoMe.t + 1);
    while (!dinoMe.dead && dinoMe.t < now) dinoStep(Math.min(1 / 120, now - dinoMe.t));
    if (!dinoMe.dead && (dinoEvent || t - dinoLastSend > DINO.sendEvery)) {
      dinoLastSend = t;
      const { x, t: mt, y, vy, duck } = dinoMe;
      const hold = dinoKeys.jump;
      (dinoEvent ? socket : socket.volatile).emit('dino:state', { id: dinoGame.id, x: Math.round(x), t: mt, y, vy, duck, hold, ev: dinoEvent });
      dinoEvent = false;
    }
  }
  // Kamera en öndekine (çoğunlukla Jef) kilitli, geri gitmez. Oyun bitince Jef de durur.
  dinoCam = Math.max(dinoCam, dinoJefNow());
  for (const [name, p] of Object.entries(dinoGame.players)) {
    if (p.dead) continue;
    const x = name === myName ? dinoMe?.x : dinoJefNow() - DINO.gap * dinoSlot(dinoGame, name);
    if (x != null) dinoCam = Math.max(dinoCam, x);
  }
  dinoFill(dinoCam + DINO.viewW * 2);
  drawDino(started);
  dinoMusicTick();
  if (started && t - dinoLastList > 300) {
    dinoLastList = t;
    renderDinoUi();
  }
  if (!dinoGame.done) dinoLoop = requestAnimationFrame(dinoFrame); // bittiyse son kare kalır
  else Chip.stop();
}

// Sekme açılınca bir kare çiz (oyun yokken ya da bitmişken döngü çalışmıyor).
function dinoKick() {
  if (dinoLoop) return;
  if (dinoGame) dinoLoop = requestAnimationFrame(dinoFrame);
  else requestAnimationFrame(() => drawDino(false));
}

function drawDino(started) {
  const canvas = $('dino-canvas');
  if (!canvas.offsetParent) return; // sekme kapalı: hesapla ama çizme
  const dpr = devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  if (canvas.width !== Math.round(cssW * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round((cssW * DINO.viewH / DINO.viewW) * dpr);
  }
  const ctx = canvas.getContext('2d');
  const k = canvas.width / DINO.viewW;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.clearRect(0, 0, DINO.viewW, DINO.viewH);
  const left = dinoCam - DINO.leaderX;
  const sx = (x) => x - left;
  const sy = (y, h) => DINO.groundY - y - h;

  // Zemin ve kayan çakıllar
  ctx.fillStyle = '#343946';
  ctx.fillRect(0, DINO.groundY, DINO.viewW, 2);
  ctx.fillStyle = '#262a34';
  for (let gx = Math.floor(left / 37) * 37; gx < left + DINO.viewW; gx += 37) {
    const n = Math.abs(Math.sin(gx * 12.9898) * 43758.5453) % 1;
    ctx.fillRect(sx(gx + n * 30), DINO.groundY + 6 + Math.floor(n * 3) * 6, 3 + n * 6, 2);
  }

  if (!dinoGame) {
    ctx.fillStyle = '#8b92a3';
    ctx.font = '600 16px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Başlat\'a bas, Jef\'in peşinden koşun', DINO.viewW / 2, 100);
    drawOneDino(ctx, 'Jef 🤖', { x: 80, y: 0, duck: false }, false, sx, sy, 0, DINO_JEF_COLOR);
    if (myName) drawOneDino(ctx, myName, { x: -40, y: 0, duck: false }, false, sx, sy);
    return;
  }

  for (const ob of dinoObstacles) {
    if (ob.x > left + DINO.viewW) break;
    if (ob.x + ob.w < left) continue;
    const x = sx(ob.x), y = sy(ob.y, ob.h);
    if (ob.kind === 'cactus') {
      ctx.fillStyle = '#3f9b4f';
      const parts = ob.group ? Array.from({ length: ob.group }, (_, i) => [i * 16, 16]) : [[0, ob.w]];
      for (const [px, pw] of parts) {
        const stem = Math.max(6, pw * 0.4);
        ctx.fillRect(x + px + (pw - stem) / 2, y, stem, ob.h);
        ctx.fillRect(x + px, y + ob.h * 0.3, 4, ob.h * 0.35);
        ctx.fillRect(x + px + pw - 4, y + ob.h * 0.2, 4, ob.h * 0.35);
        ctx.fillRect(x + px, y + ob.h * 0.6, pw, 4);
      }
    } else {
      ctx.fillStyle = ob.top ? '#d9822b' : '#8b92a3'; // en üstteki kuş turuncu: zıplama uyarısı
      const flap = Math.floor(performance.now() / 180) % 2;
      // Sürüde kuşlar alt alta dizilir (en alttaki koşanın hemen üstünde); tek kuşta biri.
      for (let by = y + ob.h - 24; by >= y - 1; by -= 34) {
        ctx.fillRect(x, by + 8, ob.w, 8);          // gövde
        ctx.fillRect(x - 6, by + 10, 8, 4);        // gaga
        ctx.fillRect(x + 12, flap ? by : by + 14, 14, 10); // kanat
      }
    }
  }

  // Yan yana duranların isimleri üst üste binmesin: yakındakinin ismi bir satır yukarı çıkar.
  const labels = [];
  const drawOne = (name, d, faded, color) => {
    let lift = 0;
    while (labels.some((l) => l.lift === lift && Math.abs(l.x - d.x) < 60)) lift++;
    labels.push({ x: d.x, lift });
    drawOneDino(ctx, name, d, faded, sx, sy, lift * 14, color);
  };
  drawOne('Jef 🤖', dinoJefPose(dinoJefNow()), false, DINO_JEF_COLOR);
  for (const [name, o] of dinoOthers) drawOne(name, dinoOtherPose(name, o), dinoGame.players[name]?.dead);
  if (dinoMe) drawOne(myName, dinoMe, dinoMe.dead);
  drawDinoHud(ctx, started);
}

function drawOneDino(ctx, name, d, faded, sx, sy, lift = 0, color = avatarColor(name)) {
  const { w, h } = dinoBox(d);
  const x = sx(d.x), y = sy(d.y, h);
  if (x + w < -40 || x > DINO.viewW + 40) return;
  ctx.globalAlpha = faded ? 0.3 : 1;
  ctx.fillStyle = color;
  const step = d.y === 0 && Math.floor(d.x / 18) % 2;
  if (d.duck && d.y === 0) {
    ctx.fillRect(x, y + 6, w - 14, h - 12);
    ctx.fillRect(x + w - 18, y, 18, 14);
    ctx.fillRect(x + 8 + (step ? 0 : 10), y + h - 6, 6, 6);
  } else {
    ctx.fillRect(x + 4, y + 14, w - 16, h - 24);  // gövde
    ctx.fillRect(x + w - 20, y, 20, 16);          // kafa
    ctx.fillRect(x, y + 18, 6, 10);               // kuyruk
    ctx.fillRect(x + 10, y + h - 10, 6, step ? 10 : 6);
    ctx.fillRect(x + 22, y + h - 10, 6, step ? 6 : 10);
  }
  ctx.fillStyle = '#0b0c10';
  ctx.fillRect(x + w - 8, y + 4, 3, 3); // göz
  ctx.globalAlpha = faded ? 0.4 : 0.85;
  ctx.fillStyle = '#eceef4';
  ctx.font = '600 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(name, x + w / 2, y - 6 - lift);
  ctx.globalAlpha = 1;
}

// Üstte: mesafe, hız; başta geri sayım, sonda durum
function drawDinoHud(ctx, started) {
  ctx.fillStyle = '#8b92a3';
  ctx.font = '600 14px system-ui, sans-serif';
  ctx.textAlign = 'right';
  if (dinoMe) {
    const live = dinoMe.dead || dinoGame.done ? '' : ` · hız ${Math.round(dinoMe.vx / 10)}`;
    ctx.fillText(`${Math.round(dinoJefX(dinoMe.t) / 10)} m${live}`, DINO.viewW - 14, 24);
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = '#eceef4';
  if (!started) {
    ctx.font = '800 64px system-ui, sans-serif';
    ctx.fillText(Math.ceil((dinoGame.startAt - serverNow()) / 1000), DINO.viewW / 2, 120);
  } else if (dinoGame.done) {
    ctx.font = '800 32px system-ui, sans-serif';
    ctx.fillText('Oyun bitti', DINO.viewW / 2, 110);
  } else if (dinoMe?.dead) {
    ctx.font = '700 24px system-ui, sans-serif';
    ctx.fillText('Öldün, diğerlerini izliyorsun', DINO.viewW / 2, 110);
  }
}

// ---------- Dinozor müziği ----------
// Dosya yok: chiptune tarayıcıda üretilir. Am-F-C-G üzerine bas, arpej, melodi ve davul; 4 ölçüde bir
// döner, tempo oyun hızlandıkça artar. Sadece oyun sürerken ve dinozor sekmesi açıkken çalar.

const Chip = (() => {
  const BASS = [45, 41, 48, 43];
  const CHORDS = [[69, 72, 76], [65, 69, 72], [72, 76, 79], [67, 71, 74]];
  const LEAD = [
    76, null, 74, 76, 72, null, 69, null,
    72, null, 74, 72, 69, null, 65, 67,
    67, null, 72, null, 76, 74, 72, null,
    74, null, 71, null, 67, null, 74, 76,
  ]; // sekizlikler, ölçü başına 8
  const hz = (n) => 440 * 2 ** ((n - 69) / 12);
  let ctx = null, out = null, noise = null, timer = 0, step = 0, next = 0, bpm = () => 140;
  let level = 0.5; // ana ses seviyesi (kaydırıcıdan)

  function tone(type, freq, t, dur, vol, slideTo) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain).connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  function hit(t, dur, vol, cutoff) {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = cutoff;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter).connect(gain).connect(out);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  // 16'lık adım: ölçü 16 adım, döngü 4 ölçü
  function play(s, t, len) {
    const bar = Math.floor(s / 16) % 4, i = s % 16;
    if (i === 0 || i === 8 || (bar % 2 && i === 10)) tone('sine', 150, t, 0.16, 0.7, 40); // davul
    if (i === 4 || i === 12) hit(t, 0.12, 0.22, 1500);                                  // trampet
    if (i % 2 === 0) hit(t, 0.03, i % 4 === 2 ? 0.07 : 0.03, 7000);                     // zil
    if (i % 2 === 0) tone('triangle', hz(BASS[bar] + (i % 4 === 2 ? 12 : 0)), t, len * 1.6, 0.3);
    tone('square', hz(CHORDS[bar][[0, 1, 2, 1][i % 4]]), t, len * 0.8, 0.025);
    const note = i % 2 === 0 && LEAD[bar * 8 + i / 2];
    if (note) tone('square', hz(note), t, len * 1.9, 0.06);
  }

  function schedule() {
    while (next < ctx.currentTime + 0.12) {
      const len = 60 / bpm() / 4;
      play(step, next, len);
      next += len;
      step = (step + 1) % 64;
    }
  }

  function setup(audio) {
    if (ctx === audio) return;
    ctx = audio;
    out = ctx.createGain();
    out.gain.value = 0;
    out.connect(ctx.destination);
    noise = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }

  return {
    get playing() { return Boolean(timer); },
    start(audio, tempo) {
      if (timer || !audio) return;
      setup(audio);
      bpm = tempo;
      out.gain.cancelScheduledValues(ctx.currentTime);
      out.gain.setTargetAtTime(level, ctx.currentTime, 0.05);
      step = 0;
      next = ctx.currentTime + 0.05;
      timer = setInterval(schedule, 25);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = 0;
      out.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
    },
    setVolume(v) {
      level = v;
      if (timer) out.gain.setTargetAtTime(level, ctx.currentTime, 0.03);
    },
    // Efektler müzik kapalıyken de aynı çıkıştan gelir.
    jump(audio) {
      if (!audio) return;
      setup(audio);
      out.gain.setTargetAtTime(level, ctx.currentTime, 0.01);
      tone('square', 380, ctx.currentTime, 0.12, 0.07, 760);
    },
    die(audio) {
      if (!audio) return;
      setup(audio);
      out.gain.setTargetAtTime(level, ctx.currentTime, 0.01);
      tone('sawtooth', 420, ctx.currentTime, 0.5, 0.1, 55);
    },
  };
})();

let dinoSound = true;
try { dinoSound = localStorage.getItem('dino-sound') !== '0'; } catch {}
function renderDinoSound() {
  setIcon($('dino-music'), dinoSound ? 'volume' : 'volume-x');
  $('dino-music').title = dinoSound ? 'Müziği ve efektleri kapat' : 'Müziği ve efektleri aç';
}
renderDinoSound();
$('dino-music').onclick = () => {
  dinoSound = !dinoSound;
  try { localStorage.setItem('dino-sound', dinoSound ? '1' : '0'); } catch {}
  renderDinoSound();
};

// Ses seviyesi: 0-100; 60 eski sabit seviyeye denk gelir.
try { $('dino-volume').value = localStorage.getItem('dino-volume') ?? 60; } catch {}
const applyDinoVolume = () => Chip.setVolume((Number($('dino-volume').value) / 100) * 0.85);
applyDinoVolume();
$('dino-volume').oninput = () => {
  applyDinoVolume();
  try { localStorage.setItem('dino-volume', $('dino-volume').value); } catch {}
  if (!dinoSound && Number($('dino-volume').value) > 0) $('dino-music').click(); // kaydırınca ses açılsın
};

// Sekme arka plandayken kare çizilmez; müzik de takılarak çalmasın.
document.addEventListener('visibilitychange', () => document.hidden && Chip.stop());

// Her karede: müzik oyun sürerken, ses açıkken ve dinozor sekmesi görünürken çalar.
function dinoMusicTick() {
  const want = dinoSound && audioCtx && dinoGame && !dinoGame.done && $('dino-canvas').offsetParent;
  if (want && !Chip.playing) {
    const { runStart, runMax } = DINO_PACE;
    Chip.start(audioCtx, () => 140 + 50 * ((dinoMaxSpeed(dinoElapsed()) - runStart) / (runMax - runStart)));
  } else if (!want && Chip.playing) Chip.stop();
}

// Klavye: oyun açıkken çalışır, yazı alanındayken değil.
const DINO_KEYS = { KeyW: 'jump', ArrowUp: 'jump', Space: 'jump', KeyS: 'duck', ArrowDown: 'duck' };
function dinoKey(e, down) {
  const action = DINO_KEYS[e.code];
  if (!action || $('games').hidden || $('game-dino').hidden) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
  e.preventDefault();
  dinoKeys[action] = down;
}
document.addEventListener('keydown', (e) => dinoKey(e, true));
document.addEventListener('keyup', (e) => dinoKey(e, false));
addEventListener('blur', () => Object.keys(dinoKeys).forEach((k) => (dinoKeys[k] = false)));

// Telefon: basılı tutulan dokunmatik düğmeler
for (const [id, action] of [['dino-t-jump', 'jump'], ['dino-t-duck', 'duck']]) {
  const b = $(id);
  b.onpointerdown = (e) => {
    b.setPointerCapture(e.pointerId);
    dinoKeys[action] = true;
  };
  b.onpointerup = b.onpointercancel = () => (dinoKeys[action] = false);
  b.oncontextmenu = (e) => e.preventDefault();
}

// Silme düğmeleri iki aşamalı: ilk basışta onay ister, birkaç saniye içinde ikinci basış uygular.
function confirmButton(btn, ask, run) {
  const label = btn.textContent;
  let timer = null;
  btn.onclick = () => {
    if (!timer) {
      btn.textContent = ask;
      timer = setTimeout(() => {
        btn.textContent = label;
        timer = null;
      }, 3000);
      return;
    }
    clearTimeout(timer);
    timer = null;
    btn.textContent = label;
    run();
  };
}
confirmButton($('tier-delete'), 'Emin misin? Tekrar bas', () => socket.emit('tierlist:delete', openListId));

// ---------- Geçici sohbet ----------
// Mesajlar sadece sunucunun hafızasında tutulur (son 50); herkes çıkınca silinir.

const URL_RE = /(https?:\/\/[^\s]+)/g;

// Metni güvenli şekilde ekler; linkleri tıklanabilir yapar.
function appendLinkified(el, text) {
  text.split(URL_RE).forEach((part, i) => {
    if (i % 2 === 0) return part && el.append(part);
    const a = document.createElement('a');
    a.href = part;
    a.textContent = part;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    el.append(a);
  });
}

function renderChatMessage({ from, name, text, image, ts, system }) {
  const list = $('chat-list');
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;

  if (system) {
    const li = document.createElement('li');
    li.className = 'chat-system';
    const time = new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    li.textContent = `${text} · ${time}`;
    list.append(li);
    $('chat-empty').hidden = true;
    if (nearBottom) list.scrollTop = list.scrollHeight;
    return;
  }

  const li = document.createElement('li');
  li.className = 'chat-msg' + (from === selfId ? ' mine' : '');
  const content = document.createElement('div');
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = name;
  const when = document.createElement('span');
  when.className = 'when';
  when.textContent = new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  const body = document.createElement('div');
  body.className = 'text';
  // Sadece 1-3 emojiden oluşan mesaj büyük gösterilir.
  if (/^(\p{Extended_Pictographic}(\uFE0F|\u200D\p{Extended_Pictographic}|\p{Emoji_Modifier})*\s*){1,3}$/u.test(text)) {
    body.classList.add('big');
  }
  appendLinkified(body, text);
  content.append(who, when, body);
  if (image) {
    const link = document.createElement('a');
    link.href = image;
    link.target = '_blank';
    link.rel = 'noopener';
    const img = document.createElement('img');
    img.className = 'chat-img';
    img.alt = `${name} fotoğraf gönderdi`;
    img.src = image;
    // Resim yüklenince boyu değişir; alttaysak aşağıda kalalım.
    img.onload = () => nearBottom && (list.scrollTop = list.scrollHeight);
    link.append(img);
    content.append(link);
  }
  li.append(makeAvatar(name), content);

  // Mesajda YouTube ya da X linki varsa tek tıkla sıraya eklenebilsin.
  const videoId = (text.match(URL_RE) || []).map(parseVideoId).find(Boolean);
  if (videoId) {
    const add = document.createElement('button');
    add.className = 'queue-add';
    setIcon(add, 'plus', 'Sıraya ekle');
    add.onclick = () => {
      socket.emit('media:add', videoId);
      add.disabled = true;
    };
    content.append(add);
  }

  list.append(li);
  $('chat-empty').hidden = true;
  if (nearBottom || from === selfId) list.scrollTop = list.scrollHeight;
}

// Fotoğrafı göndermeden önce küçültür: en uzun kenar 1600 px, WebP (desteklenmiyorsa JPEG).
// GIF'ler animasyon bozulmasın diye olduğu gibi gider.
const IMAGE_MAX_SIDE = 1600;
const GIF_MAX_BYTES = 2 * 1024 * 1024;

// square: ortadan kare kırpar (profil resmi).
async function compressImage(file, maxSide = IMAGE_MAX_SIDE, square = false) {
  if (maxSide === IMAGE_MAX_SIDE && file.type === 'image/gif' && file.size <= GIF_MAX_BYTES) return { blob: file, type: 'image/gif' };
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const [sx, sy, sw, sh] = square
    ? [(bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side]
    : [0, 0, bitmap.width, bitmap.height];
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const encode = (type) => new Promise((r) => canvas.toBlob(r, type, 0.82));
  let blob = await encode('image/webp');
  if (blob?.type !== 'image/webp') blob = await encode('image/jpeg'); // Safari WebP üretemez
  return { blob, type: blob.type };
}

async function sendImage(file) {
  if (!file?.type.startsWith('image/')) return toast('Sadece fotoğraf gönderilebilir.');
  let compressed;
  try {
    compressed = await compressImage(file);
  } catch {
    return toast('Bu fotoğraf açılamadı.');
  }
  const caption = $('chat-input').value.trim();
  const data = await compressed.blob.arrayBuffer();
  const res = await new Promise((r) => socket.emit('chat:image', { data, type: compressed.type, caption }, r));
  if (res.error) return toast(res.error);
  $('chat-input').value = '';
}

$('chat-file').onchange = () => {
  sendImage($('chat-file').files[0]);
  $('chat-file').value = '';
};

$('chat-input').addEventListener('paste', (e) => {
  const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'));
  if (!file) return;
  e.preventDefault();
  sendImage(file);
});

const chatBox = document.querySelector('.side .chat');
chatBox.addEventListener('dragover', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  chatBox.classList.add('dragging');
});
chatBox.addEventListener('dragleave', () => chatBox.classList.remove('dragging'));
chatBox.addEventListener('drop', (e) => {
  e.preventDefault();
  chatBox.classList.remove('dragging');
  sendImage(e.dataTransfer.files[0]);
});

socket.on('chat', (msg) => {
  renderChatMessage(msg);
  if (!audioCtx || msg.from === selfId) return;
  if (!msg.system) Sfx.ping(audioCtx, sfxBus);
  else if (msg.event === 'join') Sfx.join(audioCtx, sfxBus);
  else if (msg.event === 'leave') Sfx.leave(audioCtx, sfxBus);
});

// Emoji seçici: tıklanan emoji imlecin olduğu yere eklenir, pencere açık kalır (birkaç tane seçilebilsin).
const EMOJIS = [
  '😂', '🤣', '😅', '😊', '😍', '🥰', '😘', '😎', '🤩', '🥳', '😏', '😴', '🤔', '🙄', '😬', '😮',
  '😢', '😭', '😡', '🤯', '🥶', '🥵', '🤢', '💀', '👻', '🤡', '😈', '🙈', '👍', '👎', '👏', '🙌',
  '🙏', '💪', '🤝', '✌️', '🤘', '👀', '🫡', '🤌', '❤️', '🔥', '✨', '💯', '🎉', '🎵', '🎶', '🎤',
  '🎧', '🎸', '🥁', '🍕', '🍔', '🍻', '☕', '⚽', '🎮', '🚀', '⭐', '🌙', '💩', '🐐', '❓', '‼️',
];

for (const emoji of EMOJIS) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = emoji;
  btn.onclick = () => {
    const input = $('chat-input');
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.setRangeText(emoji, start, end, 'end');
    input.focus();
  };
  $('emoji-grid').append(btn);
}

// Hızlı emojiler: tek tıkla doğrudan mesaj olarak gider.
const QUICK_EMOJIS = ['😂', '🔥', '❤️', '👍', '👏', '😮', '😭', '💀'];
for (const emoji of QUICK_EMOJIS) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = emoji;
  btn.onclick = () => socket.emit('chat', emoji);
  $('quick-emojis').append(btn);
}

$('chat-form').onsubmit = (e) => {
  e.preventDefault();
  const text = $('chat-input').value.trim();
  if (!text) return;
  socket.emit('chat', text);
  $('chat-input').value = '';
};

// ---------- Ses kaydı ----------
// Kayıt tarayıcıda yapılır ve dosya olarak iner. "Müzik dahil" sekmenin sesini yakalar
// (YouTube dahil); "sadece konuşmalar" uygulamanın kendi ses karışımını kaydeder.
// İki durumda da kendi mikrofonun ayrıca eklenir, çünkü o sekmede çalınmaz.
// Tarayıcı MP3 kaydedemez; MP3 seçiliyse ses kayıt sürerken ayrı iş parçacığında MP3'e çevrilir.

const REC_MIME = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus']
  .find((m) => window.MediaRecorder?.isTypeSupported(m));
const REC_EXT = REC_MIME?.includes('mp4') ? 'm4a' : REC_MIME?.includes('ogg') ? 'ogg' : 'webm';
let recorder = null; // { stop() } — MediaRecorder ya da MP3 kodlayıcı
let recCleanup = [];
let recTimer = null;

function recFileName(ext) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `sesli-oda-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`;
}

async function startRecording(withMusic) {
  $('rec-pop').hidePopover();
  const dest = audioCtx.createMediaStreamDestination();
  // Kayda giren her şey önce sınırlayıcıdan geçer: sesler üst üste binince dosyada patlama olmasın.
  const limiter = audioCtx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.1;
  limiter.connect(dest);
  recCleanup.push(() => limiter.disconnect());

  if (withMusic) {
    let tab;
    try {
      tab = await navigator.mediaDevices.getDisplayMedia({
        video: true, // Chrome sekme sesini görüntüsüz vermiyor; görüntüyü hemen kapatırız
        audio: { suppressLocalAudioPlayback: false },
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
      });
    } catch (err) {
      if (err.name !== 'NotAllowedError') toast('Sekme sesi alınamadı: ' + err.message); // NotAllowedError: vazgeçildi
      return;
    }
    tab.getVideoTracks().forEach((t) => t.stop());
    const [track] = tab.getAudioTracks();
    if (!track) return toast('Sekme sesi paylaşılmadı. "Sekme sesini de paylaş" açık olmalı.');
    const src = audioCtx.createMediaStreamSource(new MediaStream([track]));
    src.connect(limiter);
    track.onended = stopRecording; // tarayıcının "Paylaşımı durdur" düğmesi
    recCleanup.push(() => {
      src.disconnect();
      track.onended = null;
      track.stop();
    });
  } else {
    voiceOut.connect(limiter);
    sfxBus.connect(limiter);
    recCleanup.push(() => {
      voiceOut.disconnect(limiter);
      sfxBus.disconnect(limiter);
    });
  }

  if (sendStream) {
    // Gönderilen akıştan alınır: mikrofon kapalıyken kayda da ses girmez.
    const mine = audioCtx.createMediaStreamSource(sendStream);
    mine.connect(limiter);
    recCleanup.push(() => mine.disconnect());
  }

  if ($('rec-format').value === 'mp3') {
    try {
      recorder = await startMp3(limiter);
    } catch {
      toast('MP3 kodlayıcı yüklenemedi, kayıt ' + REC_EXT + ' olarak yapılıyor.');
    }
  }
  recorder ??= startNative(dest.stream);

  const started = Date.now();
  recTimer = setInterval(() => setIcon($('rec-btn'), 'stop', fmtTime((Date.now() - started) / 1000)), 1000);
  socket.emit('rec', true);
  renderRec();
}

function downloadRec(blob, ext) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = recFileName(ext);
  // Bazı mobil tarayıcılar sayfada olmayan bağlantıya tıklamayı yok sayıyor.
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  toast('Kayıt indirildi.');
}

function startNative(stream) {
  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType: REC_MIME, audioBitsPerSecond: 96000 });
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => downloadRec(new Blob(chunks, { type: REC_MIME }), REC_EXT);
  rec.start(10000);
  return rec;
}

let recWorkletReady = null;

async function startMp3(input) {
  recWorkletReady ??= audioCtx.audioWorklet.addModule('rec-worklet.js');
  await recWorkletReady;
  const worker = new Worker('mp3-worker.js');
  worker.postMessage({ type: 'start', sampleRate: audioCtx.sampleRate, kbps: 160 });
  // Çıkışı yok: hiçbir yere bağlanmadan sadece dinler.
  const tap = new AudioWorkletNode(audioCtx, 'pcm-tap', {
    numberOfOutputs: 0,
    channelCount: 2,
    channelCountMode: 'explicit',
  });
  tap.port.onmessage = ({ data }) => {
    if (!data.done) return worker.postMessage({ type: 'pcm', ...data }, [data.left.buffer, data.right.buffer]);
    tap.port.onmessage = null;
    worker.postMessage({ type: 'end' });
  };
  worker.onmessage = ({ data }) => {
    worker.terminate();
    downloadRec(data, 'mp3');
  };
  input.connect(tap);
  return {
    stop() {
      tap.port.postMessage('flush');
      input.disconnect(tap);
    },
  };
}

function stopRecording() {
  if (!recorder) return;
  recorder.stop();
  recorder = null;
  recCleanup.splice(0).forEach((fn) => fn());
  clearInterval(recTimer);
  socket.emit('rec', false);
  renderRec();
}

function renderRec() {
  const btn = $('rec-btn');
  btn.classList.toggle('rec', Boolean(recorder));
  btn.title = recorder ? 'Kaydı durdur ve indir' : 'Kaydet';
  setIcon(btn, recorder ? 'stop' : 'rec', recorder ? '0:00' : '');
  renderRecBanner();
}

function renderRecBanner() {
  const names = [...peers.values()].filter((p) => p.recording).map((p) => p.name);
  if (recorder) names.unshift('sen');
  $('rec-banner').hidden = !names.length;
  $('rec-banner').textContent = `Kayıt yapılıyor: ${names.join(', ')}`;
}

socket.on('rec', ({ id, on }) => {
  const peer = peers.get(id);
  if (!peer) return;
  peer.recording = on;
  toast(on ? `🔴 ${peer.name} kayda başladı` : `${peer.name} kaydı durdurdu`);
  renderRecBanner();
});

$('rec-btn').hidden = !REC_MIME;
// Kayıt sürerken düğme menüyü açmaz, kaydı durdurur (preventDefault popover'ı engeller).
$('rec-btn').addEventListener('click', (e) => {
  if (!recorder) return;
  e.preventDefault();
  stopRecording();
});
$('rec-all').onclick = () => startRecording(true);
$('rec-voice').onclick = () => startRecording(false);
try {
  $('rec-format').value = localStorage.getItem('rec-format') || 'mp3';
} catch {}
$('rec-format').onchange = () => {
  try {
    localStorage.setItem('rec-format', $('rec-format').value);
  } catch {}
};
$('rec-format').querySelector('[value=native]').textContent = REC_EXT.toUpperCase() + ' (daha küçük dosya)';
if (!TAB_AUDIO) {
  $('rec-all').hidden = true;
  $('rec-all').nextElementSibling.textContent =
    'Müziği de kaydetmek için Chrome veya Edge kullan; bu tarayıcı sekme sesini vermiyor.';
}

// Kayıt sürerken sayfa kapanırsa kayıt kaybolur; tarayıcı uyarsın.
addEventListener('beforeunload', (e) => {
  if (recorder) e.preventDefault();
});

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
  if (isX(loadedId)) return;
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
let buffering = 0;      // sn; video oynarken ne kadardır yükleniyor
let retriedId = null;   // oynatıcısı baştan kurulmuş son video (her video için bir kez)
let resizeWatched = false;
let recreating = null;

// Çalan videonun oynatıcısı: YouTube ya da X (aynı arayüz).
const P = () => (isX(loadedId) ? xPlayer : player);

function seekPlayer(pos) {
  P().seekTo(pos, true);
  ytTrack.reset = true;
}

// YouTube betiği yüklenemezse (ağ hatası, engelleyici) sayfa yenilenmeden tekrar denenir.
const ytReady = new Promise((resolve) => {
  if (window.YT?.Player) return resolve();
  window.onYouTubeIframeAPIReady = resolve;
  let tries = 0;
  const timer = setInterval(() => {
    if (window.YT?.Player) return clearInterval(timer);
    if (++tries === 3) toast('YouTube yüklenemiyor; reklam engelleyici varsa bu sitede kapatmayı dene.');
    if (!window.YT?.loaded) window.YT = undefined; // yarım kalan yükleme baştan başlasın
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    document.head.append(script);
  }, 8000);
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
      playerVars: { controls: 0, disablekb: 1, rel: 0, playsinline: 1, iv_load_policy: 3, modestbranding: 1, origin: location.origin },
      events: {
        onReady: () => {
          playerReady = true;
          player.setVolume(musicVolume());
          appliedVolume = null;
          if (!resizeWatched) new ResizeObserver(applyQuality).observe($('player-wrap'));
          resizeWatched = true;
          applyQuality();
          resolve();
        },
        onStateChange: (e) => !isX(loadedId) && onPlayerState(e.data),
        // 100: video yok/özel, 101 ve 150: sahibi YouTube dışında oynatmayı kapatmış;
        // bunlarda tekrar denemek boşuna. Diğerleri (5: tarayıcı oynatamadı, 2: bozuk istek)
        // çoğu zaman geçicidir: oynatıcı bir kez baştan kurulup tekrar denenir.
        // Sunucu odanın yarısı bildirince atlar; atlanmadıysa sorun sadece bu cihazdadır.
        onError: (e) => {
          const cur = media?.current;
          if (!cur || isX(loadedId)) return;
          if (![100, 101, 150].includes(e.data) && retriedId !== cur.videoId) {
            retriedId = cur.videoId;
            recreatePlayer();
            return;
          }
          socket.emit('media:error', { videoId: cur.videoId, error: e.data }, (skipped) => {
            if (!skipped) toast(`Bu video sende oynatılamadı (YouTube hata ${e.data}). Reklam engelleyici varsa kapatmayı dene.`);
          });
        },
      },
    });
  });
}

function onPlayerState(state) {
  if (state === YT.PlayerState.ENDED && media?.current) {
    socket.emit('media:ended', media.current.videoId);
  }
  if (state === YT.PlayerState.PLAYING) stalled = 0;
  updatePoster();
  trackBuffering(state === YT.PlayerState.BUFFERING);
}

// ---------- X (Twitter) videoları ----------
// X, başka sitelerden gelen (referer'lı) video isteklerini reddediyor. Video bu yüzden
// referer göndermeyen aynı kaynaklı bir çerçevede oynar; YouTube oynatıcısıyla aynı arayüzü sunar.

let xVideo = null;
let xItem = null; // çerçevede yüklü X öğesi (kalite değişince kaynağı yeniden seçmek için)

const xReady = new Promise((resolve) => {
  const frame = $('x-frame');
  frame.onload = () => {
    xVideo = frame.contentDocument.querySelector('video');
    const report = () => isX(loadedId) && onPlayerState(xPlayer.getPlayerState());
    for (const ev of ['playing', 'pause', 'waiting', 'ended', 'seeked']) xVideo.addEventListener(ev, report);
    xVideo.addEventListener('error', onXError);
    appliedVolume = null; // ses seviyesi bir sonraki turda bu oynatıcıya da uygulanır
    resolve();
  };
  frame.srcdoc = `<!doctype html><meta name="referrer" content="no-referrer">
    <style>html,body{margin:0;height:100%;background:#000;overflow:hidden}video{width:100%;height:100%;display:block}</style>
    <video playsinline preload="auto"></video>`;
});

// Kalite ayarına göre mp4 seçilir (kaynaklar düşükten yükseğe sıralı, bit/sn).
// X'in mp4 seçenekleri genelde ~0.3 / 0.8 / 2.2 / 10 Mbps (270p / 480p / 720p / 1080p).
const X_MAX_BITRATE = { auto: 2500000, 2160: Infinity, 1440: Infinity, 1080: Infinity, 720: 2500000, 480: 1000000, 360: 1000000, 240: 400000, 144: 0 };

function xSource(item) {
  const mode = $('audio-only').checked ? '144' : $('quality').value;
  const max = X_MAX_BITRATE[mode] ?? X_MAX_BITRATE.auto;
  const fit = item.sources.filter((s) => s.bitrate <= max);
  return (fit.at(-1) || item.sources[0]).url;
}

const xPlayer = {
  load(item, pos, play) {
    xItem = item;
    xVideo.src = xSource(item);
    xVideo.currentTime = pos;
    if (play) this.playVideo();
  },
  // Kalite değişince kaynak değişir; konum ve oynatma durumu korunur.
  applySource() {
    if (!xItem || !xVideo.src) return;
    const url = xSource(xItem);
    if (xVideo.src === url) return;
    const pos = xVideo.currentTime;
    const play = !xVideo.paused;
    xVideo.src = url;
    xVideo.currentTime = pos;
    if (play) this.playVideo();
  },
  getPlayerState() {
    const S = YT.PlayerState;
    if (!xVideo?.getAttribute('src') || xVideo.error) return S.UNSTARTED;
    if (xVideo.ended) return S.ENDED;
    if (xVideo.paused) return xVideo.played.length ? S.PAUSED : S.CUED;
    if (xVideo.readyState < 3 || xVideo.seeking) return S.BUFFERING;
    return S.PLAYING;
  },
  getCurrentTime: () => xVideo?.currentTime || 0,
  getDuration: () => (Number.isFinite(xVideo?.duration) ? xVideo.duration : 0),
  seekTo: (pos) => (xVideo.currentTime = pos),
  playVideo: () => xVideo.play().catch(() => {}), // otomatik oynatma engeli: kapak gösterilir
  pauseVideo: () => xVideo.pause(),
  stopVideo() {
    xItem = null;
    xVideo.pause();
    xVideo.removeAttribute('src');
    xVideo.load();
  },
  setVolume: (vol) => xVideo && (xVideo.volume = vol / 100),
};

// Bozuk bağlantı ya da geçici ağ hatasında kaynak bir kez yeniden yüklenir.
function onXError() {
  const cur = media?.current;
  if (!cur || !isX(loadedId) || cur.videoId !== loadedId || !xVideo.getAttribute('src')) return;
  if (retriedId !== cur.videoId) {
    retriedId = cur.videoId;
    xPlayer.load(cur, expectedPosition(), media.playing);
    return;
  }
  socket.emit('media:error', { videoId: cur.videoId }, (skipped) => {
    if (!skipped) toast('Bu X videosu sende oynatılamadı.');
  });
}

// Oynatıcı bozulursa (oynatma hatası, takılı kalma) sayfa yenilenmeden baştan kurulur.
function recreatePlayer() {
  if (recreating) return recreating;
  playerReady = false;
  loadedId = null;
  try {
    player?.destroy();
  } catch {}
  $('player')?.remove();
  const el = document.createElement('div');
  el.id = 'player';
  $('player-wrap').prepend(el);
  recreating = createPlayer().then(() => {
    recreating = null;
    applyMedia();
  });
  return recreating;
}

// ---------- Kişiye özel video kalitesi ----------
// YouTube kaliteyi oynatıcının piksel boyutuna göre seçer. Oynatıcıyı küçük boyutta
// tutup ekranda büyütünce (CSS scale) düşük kaliteye geçer ve daha az veri harcar.
// Her kişinin ayarı sadece kendi cihazını etkiler.

// YouTube kalite seçtirmez, oynatıcının boyutuna göre seçer. Oynatıcıyı istenen kalitenin boyutunda
// çizip kutuya sığacak şekilde büyütür/küçültürüz (gerçek ekran pikseli). İnternet yetmezse YouTube
// yine de daha düşüğe inebilir.
const QUALITY_PIXELS = {
  2160: [3840, 2160], 1440: [2560, 1440], 1080: [1920, 1080], 720: [1280, 720],
  480: [854, 480], 360: [640, 360], 240: [426, 240], 144: [256, 144],
};
const OLD_QUALITY = { medium: '360', low: '144' }; // eski ayar adları

function applyQuality() {
  if (isX(loadedId) && xVideo) xPlayer.applySource();
  const iframe = player?.getIframe?.();
  if (!iframe) return;
  // Sadece seste görüntü görünmez; en düşük kalite yeterli, veri de az gider.
  const mode = $('audio-only').checked ? '144' : $('quality').value;
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

function applyAudioOnly() {
  const on = $('audio-only').checked;
  $('player-wrap').classList.toggle('audio-only', on);
  $('quality-field').hidden = on;
  applyQuality();
}

try {
  const saved = localStorage.getItem('quality') || 'auto';
  $('quality').value = OLD_QUALITY[saved] || saved;
  if (!$('quality').value) $('quality').value = 'auto';
  $('audio-only').checked = localStorage.getItem('audio-only') === '1';
} catch {}
applyAudioOnly();
$('audio-only').onchange = () => {
  try {
    localStorage.setItem('audio-only', $('audio-only').checked ? '1' : '');
  } catch {}
  applyAudioOnly();
};
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
      if (freezes.length >= 3 && Number($('quality').value) > 240 && !$('audio-only').checked && !qualityHintShown) {
        qualityHintShown = true;
        toast('Videon sık donuyor. Ayarlardan "Sadece ses"i ya da düşük kaliteyi dene.');
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
  if (isX(media.current?.videoId) && !xVideo) return void xReady.then(applyMedia);
  const cur = media.current;

  $('player-empty').hidden = Boolean(cur);
  $('now-title').textContent = cur ? cur.title : 'Şu an bir şey çalmıyor';
  $('now-title').classList.toggle('muted', !cur);
  $('now-by').textContent = cur ? `${cur.by} ekledi` : '';
  setIcon($('play-toggle'), media.playing ? 'pause' : 'play');

  if (!cur) {
    if (loadedId) P().stopVideo();
    loadedId = null;
    $('player-wrap').classList.remove('x-mode');
    $('x-frame').hidden = true;
    updatePoster();
    return;
  }

  const pos = expectedPosition();
  if (cur.videoId !== loadedId) {
    // YouTube'dan X'e (ya da tersi) geçerken eski oynatıcı durdurulur.
    if (loadedId && isX(loadedId) !== isX(cur.videoId)) P().stopVideo();
    loadedId = cur.videoId;
    ytTrack.loaded = pos;
    $('player-wrap').classList.toggle('x-mode', isX(cur.videoId));
    $('x-frame').hidden = !isX(cur.videoId);
    if (isX(cur.videoId)) xPlayer.load(cur, pos, media.playing);
    else if (media.playing) player.loadVideoById({ videoId: cur.videoId, startSeconds: pos });
    else player.cueVideoById({ videoId: cur.videoId, startSeconds: pos });
    return;
  }

  const state = P().getPlayerState();
  if (media.playing) {
    if (Math.abs(P().getCurrentTime() - pos) > DRIFT_LIMIT) seekPlayer(pos);
    if (state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING) P().playVideo();
  } else {
    if (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING) P().pauseVideo();
    if (Math.abs(P().getCurrentTime() - pos) > 0.5) seekPlayer(pos);
  }
}

// ---------- Şarkı tepkileri ----------
// 👍/👎 ve emoji; herkes her şarkıya bir kez basar, tekrar basınca geri alır.

const REACTIONS = ['🔥', '😂', '😍', '👏', '💀', '😴'];

function reactButton(label, who, onClick) {
  const btn = document.createElement('button');
  btn.className = 'react' + (who.includes(myName) ? ' mine' : '');
  const count = who.length ? String(who.length) : '';
  if (label === 'like' || label === 'dislike') setIcon(btn, label, count);
  else btn.textContent = count ? `${label} ${count}` : label;
  if (who.length) btn.title = who.join(', ');
  btn.onclick = onClick;
  return btn;
}

function fillReactions(container, item) {
  container.replaceChildren();
  if (!item) return;
  const vote = (v) => () => socket.emit('media:vote', { itemId: item.id, vote: v });
  const react = (emoji) => () => socket.emit('media:react', { itemId: item.id, emoji });
  container.append(reactButton('like', item.likes, vote(1)), reactButton('dislike', item.dislikes, vote(-1)));
  for (const [emoji, who] of Object.entries(item.reactions)) container.append(reactButton(emoji, who, react(emoji)));

  const picker = document.createElement('span');
  picker.className = 'react-picker';
  picker.hidden = true;
  for (const emoji of REACTIONS) {
    const b = document.createElement('button');
    b.textContent = emoji;
    b.onclick = react(emoji);
    picker.append(b);
  }
  const more = document.createElement('button');
  more.className = 'react';
  setIcon(more, 'smile-plus');
  more.title = 'Emoji ekle';
  more.onclick = () => (picker.hidden = !picker.hidden);
  container.append(more, picker);
}

// Küçük önizleme (YouTube'un en küçük resmi, ~3 KB; görünür olunca yüklenir).
function thumb(videoId, src) {
  const img = document.createElement('img');
  img.className = 'thumb';
  img.loading = 'lazy';
  img.alt = '';
  img.src = isX(videoId) ? src || '' : `https://i.ytimg.com/vi/${videoId}/default.jpg`;
  return img;
}

function renderQueue() {
  fillReactions($('now-reactions'), media.current);
  const list = $('queue');
  list.innerHTML = '';
  media.queue.forEach((item, i) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="q-text">
        <div class="q-title"></div>
        <div class="muted small"></div>
        <div class="reactions"></div>
      </div>
      <button data-act="play" class="icon sm ghost" title="Şimdi oynat">${icon('play')}</button>
      <button data-act="remove" class="icon sm ghost" title="Sıradan çıkar">${icon('x')}</button>`;
    li.prepend(thumb(item.videoId, item.thumb));
    li.querySelector('.q-title').textContent = item.title;
    li.querySelector('.small').textContent = `${item.by} ekledi`;
    fillReactions(li.querySelector('.reactions'), item);
    li.querySelector('[data-act=play]').onclick = () => socket.emit('media:playNow', i);
    li.querySelector('[data-act=remove]').onclick = () => socket.emit('media:remove', i);
    list.append(li);
  });
  renderTopbarNow();
  $('queue-empty').hidden = media.queue.length > 0;
  $('queue-count').textContent = media.queue.length || '';
}

socket.on('media', (state) => {
  media = state;
  renderQueue();
  applyMedia();
});

// Düzenli kontrol: kayma düzeltme, zaman çubuğu ve otomatik oynatma engeli.
setInterval(() => {
  if (!playerReady || !media?.current || loadedId !== media.current.videoId) return;
  const state = P().getPlayerState?.();
  if (typeof state !== 'number') return recreatePlayer(); // oynatıcı çerçevesi çökmüş
  const videoId = media.current.videoId;

  // Video uzun süre yüklenip duruyorsa önce aynı yere tekrar atlanır, olmazsa oynatıcı baştan kurulur.
  buffering = media.playing && state === YT.PlayerState.BUFFERING ? buffering + 1 : 0;
  if (buffering === 10) seekPlayer(expectedPosition());
  else if (buffering >= 25) {
    buffering = 0;
    if (isX(videoId)) return xPlayer.load(media.current, expectedPosition(), true);
    return recreatePlayer();
  }
  // Hiç başlamayan video: otomatik oynatma engeli değilse oynatıcı bir kez baştan kurulur.
  if (stalled >= 20 && state === YT.PlayerState.UNSTARTED && retriedId !== videoId) {
    retriedId = videoId;
    stalled = 0;
    return recreatePlayer();
  }

  const dur = P().getDuration() || 0;
  $('seek').max = dur;
  $('time-dur').textContent = fmtTime(dur);
  if (!seeking) {
    $('seek').value = P().getCurrentTime();
    $('time-cur').textContent = fmtTime(P().getCurrentTime());
  }

  if (media.playing && state === YT.PlayerState.PLAYING) {
    if (Math.abs(P().getCurrentTime() - expectedPosition()) > DRIFT_LIMIT) {
      seekPlayer(expectedPosition());
    }
    stalled = 0;
  } else if (media.playing && state !== YT.PlayerState.BUFFERING) {
    // Tarayıcı otomatik oynatmayı engellediyse kullanıcıdan tek tık isteriz.
    P().playVideo();
    stalled++;
  } else {
    stalled = 0;
  }
  updatePoster();
}, 1000);

// Video başlamamışken (duraklatılmış yeni video ya da tarayıcının otomatik oynatma engeli)
// YouTube kendi kapağını ve tıklanamayan oynat düğmesini gösterir; onun yerine bizimkini koyarız.
function updatePoster() {
  const cur = media?.current;
  const state = playerReady ? P().getPlayerState() : null;
  const notStarted = state === YT.PlayerState.UNSTARTED || state === YT.PlayerState.CUED;
  const blocked = media?.playing && stalled >= 3;
  const show = Boolean(cur) && (media.playing ? blocked : notStarted);
  $('poster').hidden = !show;
  if (!show) return;
  const src = isX(cur.videoId) ? cur.thumb || '' : `https://i.ytimg.com/vi/${cur.videoId}/mqdefault.jpg`;
  if ($('poster-img').src !== src) $('poster-img').src = src;
  setIcon($('poster-play'), 'play', media.playing ? 'Senkronize başlatmak için tıkla' : 'Oynat');
}

$('poster-play').onclick = () => {
  if (media.playing) {
    seekPlayer(expectedPosition());
    P().playVideo();
  } else {
    socket.emit('media:play', media.position);
  }
};

$('play-toggle').onclick = () => {
  if (!media?.current) return;
  const pos = P().getCurrentTime();
  socket.emit(media.playing ? 'media:pause' : 'media:play', pos);
};

$('next').onclick = () => socket.emit('media:next');

// ---------- 5 sn ileri/geri ----------
// YouTube'daki gibi: her basış 5 sn ekler, basılı tutunca birikir. Bırakınca toplam
// tek seferde herkese gönderilir (her basışta değil), böylece oynatıcılar zıplayıp durmaz.

const NUDGE_STEP = 5;           // sn
const NUDGE_COMMIT_DELAY = 450; // ms; son basıştan sonra bu kadar beklenip gönderilir
const NUDGE_REPEAT = 150;       // ms; basılı tutarken tekrar aralığı
let nudgeBase = null;
let nudgeTarget = 0;
let nudgeSteps = 0;
let nudgeTimer = null;
let lastNudge = 0;

function nudge(dir) {
  if (!playerReady || !media?.current || loadedId !== media.current.videoId) return;
  lastNudge = Date.now();
  if (nudgeBase === null) {
    nudgeBase = P().getCurrentTime();
    nudgeSteps = 0;
  }
  nudgeSteps += dir;
  const dur = P().getDuration();
  nudgeTarget = Math.max(0, nudgeBase + nudgeSteps * NUDGE_STEP);
  if (dur) nudgeTarget = Math.min(nudgeTarget, Math.max(0, dur - 1));

  seeking = true;
  $('seek').value = nudgeTarget;
  $('time-cur').textContent = fmtTime(nudgeTarget);
  // YouTube'daki gibi istenen toplam gösterilir (videonun başı/sonu sınırı ayrıca uygulanır).
  const total = Math.abs(nudgeSteps) * NUDGE_STEP;
  const hint = $('seek-hint');
  hint.className = `seek-hint show ${nudgeSteps < 0 ? 'back' : 'fwd'}`;
  hint.textContent = nudgeSteps < 0 ? `« ${total} sn` : `${total} sn »`;

  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => {
    seeking = false;
    socket.emit('media:seek', nudgeTarget);
    nudgeBase = null;
    hint.classList.remove('show');
  }, NUDGE_COMMIT_DELAY);
}

// Düğmeye basılı tutunca kısa bir beklemeden sonra tekrarlar.
function holdToRepeat(btn, dir) {
  let delay = null;
  let repeat = null;
  const stop = () => {
    clearTimeout(delay);
    clearInterval(repeat);
  };
  btn.onpointerdown = (e) => {
    if (e.button !== 0) return;
    stop();
    nudge(dir);
    delay = setTimeout(() => (repeat = setInterval(() => nudge(dir), NUDGE_REPEAT)), 400);
  };
  btn.onpointerup = btn.onpointerleave = btn.onpointercancel = stop;
  btn.onclick = (e) => e.detail === 0 && nudge(dir); // klavyeyle (Enter/Boşluk) basış
}
holdToRepeat($('back5'), -1);
holdToRepeat($('fwd5'), 1);

// Yön tuşları: yazı kutularında ve kaydırıcılarda kendi işini yapar.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  const t = e.target;
  if (t.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
  e.preventDefault();
  if (e.repeat && Date.now() - lastNudge < NUDGE_REPEAT) return;
  nudge(e.key === 'ArrowLeft' ? -1 : 1);
});

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
    xPlayer.setVolume(vol);
    appliedVolume = vol;
  }
}, 100);

// ---------- Ses efektleri ----------

let customSfx = []; // [{ id, label, by }]

function sfxButton(id, text, title) {
  const btn = document.createElement('button');
  btn.className = 'sfx-btn';
  btn.textContent = text;
  btn.title = title;
  btn.onclick = (e) => {
    if (btn.disabled || e.target !== btn) return;
    Sfx.play(audioCtx, sfxBus, id);
    socket.emit('sfx', id);
    // Sunucudaki bekleme süresiyle aynı; spam'i önler.
    document.querySelectorAll('.sfx-btn').forEach((b) => (b.disabled = true));
    setTimeout(() => document.querySelectorAll('.sfx-btn').forEach((b) => (b.disabled = false)), 600);
  };
  return btn;
}

for (const fx of SFX_LIST) $('sfx').append(sfxButton(fx.id, fx.emoji, fx.label));

function renderCustomSfx() {
  $('sfx-custom').replaceChildren(
    ...customSfx.map((fx) => {
      const btn = sfxButton(fx.id, fx.label, `${fx.label} (${fx.by} yükledi)`);
      const remove = document.createElement('span');
      remove.className = 'remove';
      remove.innerHTML = icon('x');
      remove.title = 'Efekti sil';
      remove.onclick = () => socket.emit('sfx:remove', fx.id);
      btn.append(remove);
      return btn;
    })
  );
}

async function setCustomSfx(list) {
  customSfx = list;
  renderCustomSfx();
  await Promise.all(list.map((fx) => Sfx.addCustom(audioCtx, fx.id, `sfx-custom/${encodeURIComponent(ROOM)}/${fx.id}`).catch(() => {})));
}

socket.on('sfx:list', setCustomSfx);

socket.on('sfx', ({ id, by }) => {
  if (!audioCtx) return;
  const fx = SFX_LIST.find((f) => f.id === id);
  const custom = customSfx.find((f) => f.id === id);
  if (!fx && !custom) return;
  Sfx.play(audioCtx, sfxBus, id);
  toast(fx ? `${by}: ${fx.emoji} ${fx.label}` : `${by}: 🔊 ${custom.label}`);
});

// Yüklenen sesi efekte çevirir: ilk 4 sn, mono, 22 kHz, ses seviyesi eşitlenmiş 16-bit WAV.
const CUSTOM_SFX_SECONDS = 4;
const CUSTOM_SFX_RATE = 22050;
const CUSTOM_SFX_RMS = 0.16;  // hazır efektlerle aynı yükseklik
const CUSTOM_SFX_PEAK = 0.89;

async function toEffectWav(file) {
  const decoded = await audioCtx.decodeAudioData(await file.arrayBuffer());
  const length = Math.min(decoded.length, Math.round(decoded.sampleRate * CUSTOM_SFX_SECONDS));
  const off = new OfflineAudioContext(1, Math.ceil((length / decoded.sampleRate) * CUSTOM_SFX_RATE), CUSTOM_SFX_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start(0, 0, length / decoded.sampleRate);
  const data = (await off.startRendering()).getChannelData(0);

  // Ses seviyesi: en yüksek kısımların ortalamasına göre, tepe sınırıyla.
  let peak = 0;
  let sum = 0;
  for (const v of data) {
    peak = Math.max(peak, Math.abs(v));
    sum += v * v;
  }
  const rms = Math.sqrt(sum / data.length) || 1;
  const gain = Math.min(CUSTOM_SFX_RMS / rms, CUSTOM_SFX_PEAK / (peak || 1));
  const fade = Math.min(data.length, Math.round(CUSTOM_SFX_RATE * 0.05)); // kesik bitmesin

  const view = new DataView(new ArrayBuffer(44 + data.length * 2));
  const text = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + data.length * 2, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, CUSTOM_SFX_RATE, true);
  view.setUint32(28, CUSTOM_SFX_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, data.length * 2, true);
  data.forEach((v, i) => {
    const tail = data.length - i < fade ? (data.length - i) / fade : 1;
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v * gain * tail)) * 32767, true);
  });
  return view.buffer;
}

$('sfx-file').onchange = async () => {
  const file = $('sfx-file').files[0];
  $('sfx-file').value = '';
  if (!file) return;
  const label = $('sfx-label').value.trim() || file.name.replace(/\.[^.]+$/, '').slice(0, 16);
  let data;
  try {
    data = await toEffectWav(file);
  } catch {
    return toast('Bu ses dosyası açılamadı.');
  }
  const res = await new Promise((r) => socket.emit('sfx:upload', { data, label }, r));
  if (res.error) return toast(res.error);
  $('sfx-label').value = '';
};
$('sfx-upload').onsubmit = (e) => {
  e.preventDefault();
  $('sfx-file').click();
};

$('sfx-vol').oninput = () => sfxBus && (sfxBus.gain.value = Number($('sfx-vol').value) / 100);

// Kutuya link yapıştırılırsa doğrudan eklenir; yazı yazılırsa site içinde YouTube'da aranır.
$('add-form').onsubmit = (e) => {
  e.preventDefault();
  const value = $('yt-url').value.trim();
  if (!value) return;
  const id = parseVideoId(value);
  if (id) {
    socket.emit('media:add', id);
    $('yt-url').value = '';
    return;
  }
  if (!searchEnabled) return toast('Geçerli bir YouTube ya da X linki değil.');
  searchYouTube(value);
};

// Sunucuda API anahtarı yoksa kutu sadece link kabul eder.
let searchEnabled = false;

function setSearchEnabled(on) {
  searchEnabled = on;
  $('yt-url').placeholder = on ? 'Şarkı ara ya da YouTube / X linki yapıştır…' : 'YouTube ya da X linki yapıştır…';
  $('add-form').querySelector('button').textContent = on ? 'Ara / Ekle' : 'Ekle';
}

async function searchYouTube(q) {
  $('search-box').hidden = false;
  $('search-label').textContent = `"${q}" aranıyor…`;
  $('search-results').replaceChildren();
  let data;
  try {
    const res = await fetch(`search?q=${encodeURIComponent(q)}`);
    data = await res.json();
  } catch {
    data = { error: 'Arama yapılamadı.' };
  }
  if (data.error) {
    $('search-label').textContent = data.error;
    return;
  }
  $('search-label').textContent = data.results.length ? `"${q}" için sonuçlar` : `"${q}" için sonuç yok`;
  for (const r of data.results) {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="q-text">
        <div class="q-title"></div>
        <div class="muted small"></div>
      </div>
      <button class="primary sm">${icon('plus')}Ekle</button>`;
    li.prepend(thumb(r.videoId));
    li.querySelector('.q-title').textContent = r.title;
    li.querySelector('.small').textContent = r.duration ? `${r.channel} · ${fmtTime(r.duration)}` : r.channel;
    li.querySelector('button').onclick = (ev) => {
      socket.emit('media:add', r.videoId);
      const b = ev.currentTarget;
      setIcon(b, 'check', 'Eklendi');
      b.disabled = true;
    };
    $('search-results').append(li);
  }
}

$('search-close').onclick = () => {
  $('search-box').hidden = true;
  $('yt-url').value = '';
};

// ---------- Giriş / çıkış ----------

// Herkese açık tek oda "genel"; giriş ekranında kimlerin içeride olduğunu gösteririz.
// Gizli odaya arayüzde bir yol yok, sadece linkle girilir: /#gizli=şifre. Aynı şifreli linke
// gelenler genel odadan ayrı bir odada buluşur.
const secret = (new URLSearchParams(location.hash.slice(1)).get('gizli') || '')
  .trim().toLocaleLowerCase('tr-TR').slice(0, 24);
const ROOM = secret ? `gizli-${secret}` : 'genel';

// Önceden çalanlar her oda için ayrı saklanır (genel oda eski anahtarı kullanmaya devam eder).
const historyKey = () => (ROOM === 'genel' ? 'history' : `history:${ROOM}`);

// ---------- Hesap ----------
// Giriş yapınca sunucunun verdiği oturum anahtarı tarayıcıda saklanır; çıkış yapılana kadar
// bir daha şifre sorulmaz.

let authToken = '';
let account = null; // { name, avatar }
let authMode = 'login';
const AVATAR_SIDE = 256;

try {
  authToken = localStorage.getItem('token') || '';
  $('name').value = localStorage.getItem('name') || '';
} catch {}

function saveToken(token) {
  authToken = token;
  try {
    if (token) localStorage.setItem('token', token);
    else localStorage.removeItem('token');
  } catch {}
}

async function api(method, url, body, type = 'application/json') {
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${authToken}`, ...(body ? { 'Content-Type': type } : {}) },
      body: body && type === 'application/json' ? JSON.stringify(body) : body,
    });
    const data = await res.json().catch(() => ({}));
    return res.ok ? data : { error: data.error || 'Sunucuya ulaşılamadı.', status: res.status };
  } catch {
    return { error: 'Sunucuya ulaşılamadı. İnternetini kontrol edip tekrar dene.' };
  }
}

function showJoinError(text) {
  $('join-error').textContent = text;
  $('join-error').hidden = false;
}

function renderAccount() {
  $('auth-fields').hidden = Boolean(account);
  $('account').hidden = !account;
  if (!account) return;
  setProfile(account.name, account.avatar);
  $('account-name').textContent = account.name;
  $('account-avatar').replaceChildren(makeAvatar(account.name));
  // Ayarlar penceresindeki profil bölümü ve üst çubuktaki küçük avatar
  $('profile-name').textContent = account.name;
  $('profile-avatar').replaceChildren(makeAvatar(account.name));
  $('topbar-avatar').replaceChildren(makeAvatar(account.name));
  for (const id of ['avatar-change', 'profile-change']) $(id).textContent = account.avatar ? 'Resmi değiştir' : 'Resim ekle';
  for (const id of ['avatar-remove', 'profile-remove']) $(id).hidden = !account.avatar;
}

function setAuthMode(mode) {
  authMode = mode;
  $('auth-login').classList.toggle('active', mode === 'login');
  $('auth-register').classList.toggle('active', mode === 'register');
  $('password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('password').placeholder = mode === 'login' ? '' : 'En az 4 karakter';
  $('password2-field').hidden = mode === 'login';
  $('password2').value = '';
  $('join-error').hidden = true;
}
$('auth-login').onclick = () => setAuthMode('login');
$('auth-register').onclick = () => setAuthMode('register');

async function signIn() {
  const name = $('name').value.trim();
  const password = $('password').value;
  if (!name || !password) {
    showJoinError('Kullanıcı adı ve şifre yaz.');
    return false;
  }
  if (authMode === 'register' && password !== $('password2').value) {
    showJoinError('Şifreler aynı değil.');
    $('password2').focus();
    return false;
  }
  const res = await api('POST', authMode === 'login' ? '/auth/login' : '/auth/register', { name, password });
  if (res.error) {
    showJoinError(res.error);
    return false;
  }
  saveToken(res.token);
  account = { name: res.name, avatar: res.avatar };
  $('password').value = $('password2').value = '';
  try {
    localStorage.setItem('name', res.name);
  } catch {}
  renderAccount();
  return true;
}

function signedOut() {
  saveToken('');
  account = null;
  renderAccount();
}

$('logout').onclick = async () => {
  await api('POST', '/auth/logout');
  signedOut();
};

$('sign-out').onclick = async () => {
  await api('POST', '/auth/logout');
  saveToken('');
  socket.disconnect();
  Sfx.leave(audioCtx, sfxBus);
  setTimeout(() => location.reload(), 600);
};

// Kayıtlı oturum hâlâ geçerli mi?
if (authToken) {
  api('GET', '/auth/me').then((res) => {
    if (res.error) {
      if (res.status === 401) signedOut();
      return;
    }
    account = res;
    renderAccount();
  });
}

const pickAvatar = () => $('avatar-file').click();
$('account-avatar').onclick = pickAvatar;
$('avatar-change').onclick = pickAvatar;
$('profile-avatar').onclick = pickAvatar;
$('profile-change').onclick = pickAvatar;

$('avatar-file').onchange = async () => {
  const file = $('avatar-file').files[0];
  $('avatar-file').value = '';
  if (!file) return;
  let compressed;
  try {
    compressed = await compressImage(file, AVATAR_SIDE, true);
  } catch {
    return toast('Bu resim açılamadı.');
  }
  const res = await api('PUT', '/auth/avatar', compressed.blob, compressed.type);
  if (res.error) return toast(res.error);
  account.avatar = res.avatar;
  renderAccount();
  toast('Profil resmin güncellendi');
};

$('avatar-remove').onclick = $('profile-remove').onclick = async () => {
  const res = await api('DELETE', '/auth/avatar');
  if (res.error) return toast(res.error);
  account.avatar = null;
  renderAccount();
};

if (secret) {
  $('room-status').textContent = 'Gizli oda';
  $('join-btn').textContent = 'Gizli odaya katıl';
} else {
  fetch('/status')
    .then((r) => r.json())
    .then(({ names, max }) => {
      $('room-status').textContent = names.length
        ? `Şu an odada (${names.length}/${max}): ${names.join(', ')}`
        : 'Oda şu an boş.';
    })
    .catch(() => {});
}

// Açık sekmeye gizli link yapıştırılınca sadece # değişir, sayfa yenilenmez; oda yeniden seçilsin.
addEventListener('hashchange', () => location.reload());

$('join-form').onsubmit = async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  $('join-error').hidden = true;
  if (!account && !(await signIn())) {
    btn.disabled = false;
    return;
  }
  const { name } = account;
  myName = name;

  setupAudio();
  audioCtx.resume();
  const sfxLoaded = Sfx.load(audioCtx);

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch {
    localStream = null;
    $('mic-note').textContent = 'Mikrofona erişilemedi; sadece dinleyebilirsin.';
    $('mic-note').hidden = false;
    $('mic-toggle').disabled = true;
    $('gate-btn').hidden = true;
  }
  if (localStream) await setupMic();

  try {
    const config = await fetch('/config').then((r) => r.json());
    iceServers = config.iceServers;
    setSearchEnabled(config.search);
  } catch {
    iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  }
  socket.connect();
  // Ücretsiz sunucu uykudaysa uyanması yarım dakikayı bulabilir.
  const label = btn.textContent;
  btn.textContent = 'Bağlanıyor…';
  const res = (await emitAck(45000, 'join', { room: ROOM, token: authToken, clientId })) ?? {
    error: 'Sunucuya bağlanılamadı. İnternetini kontrol edip tekrar dene.',
  };
  btn.textContent = label;

  if (res.error) {
    socket.disconnect();
    localStream?.getTracks().forEach((t) => t.stop());
    if (res.auth) signedOut();
    showJoinError(res.error);
    btn.disabled = false;
    return;
  }

  $('join-screen').hidden = true;
  $('room-screen').hidden = false;
  if (secret) {
    document.title = `Gizli oda · ${document.title}`;
    toast('Gizli odadasın; sadece linki bilenler girebilir');
  }

  const selfRow = personRow(name, true);
  setStatus(selfRow, localStream ? 'Sen' : 'Sadece dinleyici');
  // Kendi göstergemiz mikrofonu dinler; sessizdeyken karşıya ses gitmediği için yanmasın.
  const self = { silenced: () => !micOn };
  if (gateNode) watchLevel(gateNode, selfRow, self);
  else if (localStream) watchLevel(audioCtx.createMediaStreamSource(localStream), selfRow, self);
  renderMic();
  renderPeopleCount();
  startUsageMeter();

  applyJoin(res);
  sfxLoaded.then(() => Sfx.join(audioCtx, sfxBus));

  // YouTube yüklenemese de oda çalışır; oynatıcı hazır olunca video başlar.
  await Promise.all([syncClock(), createPlayer()]);
  applyMedia();
};

// Sunucudan gelen oda durumunu uygular: ilk girişte ve bağlantı kopup geri gelince.
function applyJoin(res) {
  selfId = res.id;
  for (const id of [...peers.keys()]) removePeer(id);
  // Bağlantıları hemen kur: odadakiler de bize teklif gönderiyor, gecikirsek kaybolur.
  for (const p of res.peers) {
    addPeer(p.id, p.name, p.muted).recording = p.recording;
    createPc(p.id);
  }
  sharerId = res.sharer;
  renderScreen();
  renderRecBanner();
  $('chat-list').replaceChildren();
  $('chat-empty').hidden = false;
  res.chat.forEach(renderChatMessage);
  mergeHistory([...loadLocalHistory(), ...res.history]);
  setCustomSfx(res.customSfx);
  profiles = res.profiles;
  for (const el of document.querySelectorAll('.avatar')) fillAvatar(el);
  setTierLists(res.tierLists);
  timing = res.timing;
  startRaceTicker();
  setDino(res.dino);
  renderDinoBoard(res.dinoBoard);
  renderTiming();
  media = res.media;
  renderQueue();
  applyMedia();
}

const inviteLink = () => (secret ? `${location.origin}/#gizli=${encodeURIComponent(secret)}` : location.origin);

$('copy-link').onclick = async () => {
  try {
    await navigator.clipboard.writeText(inviteLink());
    toast(secret ? 'Gizli oda linki kopyalandı' : 'Davet linki kopyalandı');
  } catch {
    toast(inviteLink());
  }
};

// Çıkış sesi bitsin diye sayfa biraz bekleyip yenilenir.
$('leave').onclick = () => {
  socket.disconnect();
  Sfx.leave(audioCtx, sfxBus);
  setTimeout(() => location.reload(), 600);
};

// Sekme kapanınca/yenilenince sunucuya hemen haber ver.
addEventListener('pagehide', () => socket.disconnect());
