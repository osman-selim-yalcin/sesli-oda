'use strict';

const $ = (id) => document.getElementById(id);
// Sunucunun verdiği "card-img/..", "img/.." gibi yollar köke göre: sayfa /oyunlar/tier/3 gibi bir adresteyken de doğru yere gider.
const abs = (url) => (url && !/^([a-z]+:|\/)/i.test(url) ? `/${url}` : url);
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
    img.src = `/avatar/${encodeURIComponent(name)}?v=${version}`;
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
    await audioCtx.audioWorklet.addModule('/gate-worklet.js');
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
$('tab-queue').onclick = () => go(() => showTab('queue'));
$('tab-history').onclick = () => go(() => showTab('history'));

// ---------- Üst çubuk: oda / oyunlar ----------
// Oyunlardayken oynatıcı ekrandan çıkarılır ama silinmez; müzik çalmaya devam eder.

function showPage(page) {
  if (page === 'members' && !account?.admin) page = 'room';
  $('nav-room').classList.toggle('active', page === 'room');
  $('nav-games').classList.toggle('active', page === 'games');
  $('nav-members').classList.toggle('active', page === 'members');
  $('nav-radio').classList.toggle('active', page === 'radio');
  document.querySelector('.media').classList.toggle('away', page !== 'room');
  $('games').hidden = page !== 'games';
  $('members').hidden = page !== 'members';
  $('radio').hidden = page !== 'radio';
  if (page === 'members') loadMembers();
  if (page === 'radio') openRadioPage();
  else syncRadioAudio();
  document.querySelectorAll('.tier-name').forEach(fitTierName);
  renderTopbarNow();
}
$('nav-room').onclick = () => go(() => showPage('room'));
$('nav-games').onclick = () => go(() => showPage('games'));
$('nav-members').onclick = () => go(() => showPage('members'));
$('nav-radio').onclick = () => go(() => showPage('radio'));
$('topbar-now').onclick = () => go(() => showPage('room'));

// ---------- Gezinme geçmişi ----------
// Sayfa, sekme, oyun ve açık tier list tarayıcı geçmişine yazılır: geri tuşu siteden çıkmak yerine
// önceki ekrana döner, yenileyince de aynı yerde açılır. Her ekranın kendi adresi var:
// / sıra, /gecmis, /oyunlar/tier, /oyunlar/tier/<liste no>, /oyunlar/kelime ... (sunucu hepsine aynı sayfayı verir).

const GAMES = ['tier', 'timing', 'dino', 'kelime', 'memory', 'peacock', 'oner'];
const GAME_PATHS = { tier: 'tier', timing: 'sure', dino: 'dinozor', kelime: 'kelime', memory: 'esini-bul', peacock: 'tavus', oner: 'oner' };

function viewPath(view) {
  if (view.page === 'members') return '/uyeler';
  if (view.page === 'radio') return '/radyo';
  if (view.page === 'room') return view.tab === 'history' ? '/gecmis' : '/';
  return `/oyunlar/${GAME_PATHS[view.game]}` + (view.game === 'tier' && view.list != null ? `/${view.list}` : '');
}

function pathView(path) {
  const [first, second, third] = path.split('/').filter(Boolean);
  const view = { page: 'room', tab: first === 'gecmis' ? 'history' : 'queue', game: 'tier', list: null };
  if (first === 'uyeler') view.page = 'members';
  if (first === 'radyo') view.page = 'radio';
  if (first !== 'oyunlar') return view;
  view.page = 'games';
  view.game = GAMES.find((g) => GAME_PATHS[g] === second) || 'tier';
  if (view.game === 'tier' && /^\d+$/.test(third || '')) view.list = Number(third);
  return view;
}

const currentView = () => ({
  page: !$('members').hidden ? 'members' : !$('radio').hidden ? 'radio' : $('games').hidden ? 'room' : 'games',
  tab: $('history-view').hidden ? 'queue' : 'history',
  game: GAMES.find((g) => !$(`game-${g}`).hidden) || 'tier',
  list: openListId,
});

const sameView = (a, b) => a && b && ['page', 'tab', 'game', 'list'].every((k) => a[k] === b[k]);

// Ekranı değiştirir, değiştiyse geçmişe yeni adım ekler.
function go(fn) {
  fn();
  const view = currentView();
  if (!sameView(view, history.state)) history.pushState(view, '', viewPath(view));
}

function applyView(view) {
  if (!view?.page) return;
  showPage(view.page);
  showTab(view.tab);
  openGame(view.game);
  const list = view.list != null && tierLists.some((l) => l.id === view.list) ? view.list : null;
  if (list !== openListId) {
    openListId = list;
    selectedCard = null;
    renderTierLists();
  }
}

addEventListener('popstate', (e) => {
  if ($('room-screen').hidden) return;
  applyView(e.state || pathView(location.pathname));
});

// Oyunlardayken çalan şarkı üst çubukta görünür.
function renderTopbarNow() {
  const btn = $('topbar-now');
  const title = media?.current?.title;
  btn.hidden = !title || !document.querySelector('.media').classList.contains('away');
  if (title) setIcon(btn, 'music', title);
}

// ---------- Üyeler ----------
// Açılmış bütün hesaplar; sadece yönetici hesabında üst çubukta görünür.

const DATE_FMT = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtDate = (ms) => (ms ? DATE_FMT.format(ms) : '—');

async function loadMembers() {
  const res = await api('GET', '/admin/members');
  $('members-list').replaceChildren();
  $('members-empty').hidden = !res.error && res.members.length > 0;
  if (res.error) {
    $('members-count').textContent = '';
    $('members-empty').textContent = res.error;
    return;
  }
  $('members-empty').textContent = 'Henüz hesap yok.';
  const here = res.members.filter((m) => m.online).length;
  $('members-count').textContent = `${res.members.length} hesap · ${here} odada`;
  for (const m of res.members) {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="p-info">
        <div class="p-name"><span class="p-label"></span></div>
        <div class="p-status"></div>
      </div>
      <span class="member-badge" hidden></span>`;
    li.prepend(makeAvatar(m.name));
    li.querySelector('.p-label').textContent = m.name + (m.name === myName ? ' (sen)' : '') + (m.admin ? ' · yönetici' : '');
    li.querySelector('.p-status').textContent =
      `Katıldı: ${fmtDate(m.createdAt)} · Son giriş: ${m.online ? 'şu an odada' : fmtDate(m.lastSeen)} · ${m.devices} cihazda açık`;
    const badge = li.querySelector('.member-badge');
    badge.hidden = !m.online;
    badge.textContent = 'Odada';
    $('members-list').append(li);
  }
}
$('members-refresh').onclick = loadMembers;

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
  const image = abs(list.cover || first?.image);
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
  const open = () => go(() => {
    openListId = list.id;
    selectedCard = null;
    renderTierLists();
  });
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
  go(() => {
    openListId = res.id;
    selectedCard = null;
    renderTierLists();
  });
  toast('Liste senin oldu; kartları istediğin gibi sırala.');
}

// Satır adı renkli kutuya sığsın: uzadıkça yazı küçülür, sığmayan alt satıra geçer.
function fitTierName(el) {
  const n = [...el.value].length;
  el.classList.toggle('mid', n > 3 && n <= 8);
  el.classList.toggle('long', n > 8);
  if (!el.offsetParent) return; // gizliyken ölçülemez; sayfa açılınca yeniden ölçülür
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

addEventListener('resize', () => document.querySelectorAll('.tier-name').forEach(fitTierName));

function tierCard(card) {
  const el = document.createElement('div');
  el.className = 'tier-card' + (card.image ? ' has-img' : '') + (selectedCard === card.id ? ' selected' : '');
  el.dataset.card = card.id;
  el.title = `${card.text || 'Resim'} · ${card.by} ekledi`;
  if (card.image) {
    const img = document.createElement('img');
    img.src = abs(card.image);
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
      <div class="tier-label"><textarea class="tier-name" maxlength="24" rows="1" aria-label="Satır adı"></textarea></div>
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
    name.oninput = () => fitTierName(name);
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
        if (e.key === 'Enter') {
          e.preventDefault(); // satır adı tek satırdır; uzun olunca sadece görünüşte alta kayar
          name.blur();
        }
        if (e.key === 'Escape') {
          name.value = tier.name;
          fitTierName(name);
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
  board.querySelectorAll('.tier-name').forEach(fitTierName);
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
  go(() => {
    openListId = res.id;
    renderTierLists();
  });
};

$('tier-back').onclick = () => go(() => {
  openListId = null;
  selectedCard = null;
  renderTierLists();
});
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
  for (const game of GAMES) {
    $(`game-tab-${game}`).classList.toggle('active', game === name);
    $(`game-${game}`).hidden = game !== name;
  }
}
function openGame(name) {
  showGame(name);
  if (name === 'tier') document.querySelectorAll('.tier-name').forEach(fitTierName);
  if (name === 'kelime') renderKelime();
  if (name === 'memory') renderMemory();
  if (name === 'dino') dinoKick();
}
for (const game of GAMES) $(`game-tab-${game}`).onclick = () => go(() => openGame(game));

// ---------- Süre tahmini ----------
// Başlatınca süre ekranda görünmeden sayar; durdurunca geçen süre ve hedeften farkı açılır.
// Hedef odada herkes için ortak; sonuçlar herkese gider.

const TIMING_TARGETS = [5, 10, 15, 30, 60];
const TIMING_BOARD = 10;
const RACE_ROUNDS = [3, 5, 10];
let timing = { target: 10, results: [], race: null };
let timingRun = null;  // serbest modda süre sayarken { start, target }
let timingLast = null; // serbest modda kendi son sonucum { elapsed, target }
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
  renderLobby('race');
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
    diffEl.textContent = 'İzliyorsun; bu yarışın lobisinde değildin.';
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
  $('race-end').hidden = race.done || !race.players.includes(myName);
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

// ---------- Kelime ----------
// Oyun kurulunca herkes "anlat" ya da "bil" seçer. Her tur bir anlatıcı hedef kelimeyi seçer; bilenler tahmin
// yazar, anlatıcı her kelimeyi 10 sn içinde sıcak-soğuk çubuğuna sürükler (pos: 0 en alt/soğuk, 1 en üst/sıcak).
// Yerleştirilmeyi bekleyen 4 kelime varsa yeni tahmin yazılamaz. Herkes bir kez anlatınca oyun biter.
// Çubukta yer kalmayınca kelimelerin oranı bozulmadan çubuk uzar, kaydırılarak görülür.

const KELIME = { row: 30, maxH: 6000, top: 15, queue: 4, cooldown: 5000, countdown: 3000, rolls: 6, players: 6 };
let kelime = null;       // sunucudaki oyun (hedef kelime sadece anlatıcıya gelir)
let kelimePool = [];
let kelimeDrag = null;   // anlatıcının sürüklediği: { id, pos, fromTray, x0, y0, moved }
let kelimeRemote = null; // diğerlerinde anlatıcının sürüklediği: { id, pos }
let kelimeSelected = null; // telefonda: dokunulup seçilen kelime, sonra çubuğa (ya da çöpe) dokunulur
let kelimeTicker = null;
let kelimeLastEmit = 0;

const kelimeActive = () => (kelime && kelime.phase !== 'done' ? kelime : null);
const kelimePlaying = () => kelime?.phase === 'play' && serverNow() >= kelime.startAt;
const kelimeNarrating = () => Boolean(kelimePlaying() && kelime.narrator === myName);
const kelimeMe = () => kelime?.players.find((p) => p.name === myName);
const kelimeColor = (name) => kelime?.players.find((p) => p.name === name)?.color || '#888';
const kelimeUnplaced = () => (kelime?.phase === 'play' ? kelime.words.filter((w) => w.pos == null) : []);
const kelimeLast = () => kelime?.rounds.at(-1);
// Maviden (soğuk) kırmızıya (sıcak)
const kelimeTemp = (pos) => `hsl(${Math.round(225 - 225 * pos)} 90% 60%)`;
const fmtClock = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// Çubuğun boyu: en az kutunun boyu kadar; yan yana iki kelime arasında en az bir satırlık yer kalacak kadar uzar.
function kelimeHeight(words) {
  const ps = words.map((w) => w.pos).sort((a, b) => b - a);
  let h = Math.max(300, $('kelime-scroll').clientHeight - 64);
  for (let i = 1; i < ps.length; i++) {
    // Aynı yerdeki kelimeler (ör. süresi dolup en alta konanlar) etiketleri itilerek sıralanır, çubuğu uzatmaz.
    const gap = ps[i - 1] - ps[i];
    if (gap > 0) h = Math.max(h, KELIME.row / gap);
  }
  return Math.min(h, KELIME.maxH);
}

function kelimeShownPos(w) {
  if (kelimeDrag?.moved && kelimeDrag.id === w.id) return kelimeDrag.pos;
  if (kelimeRemote?.id === w.id) return kelimeRemote.pos;
  return w.pos;
}

let kelimeH = 300;

function renderKelimeBar() {
  const game = kelime;
  const track = $('kelime-track');
  const thermo = track.firstElementChild;
  track.replaceChildren(thermo);
  if (!game) return;
  kelimeH = kelimeHeight(game.words.filter((w) => w.pos != null));
  const shown = game.words
    .map((w) => ({ w, pos: kelimeShownPos(w) }))
    .filter((x) => x.pos != null)
    .sort((a, b) => b.pos - a.pos || a.w.id - b.w.id);
  // Bulunan kelime 1. sayılır, çubuktakiler ondan sonra gelir.
  const offset = game.phase !== 'play' && kelimeLast()?.found ? 1 : 0;
  const ranks = new Map(game.words.filter((w) => w.pos != null).sort((a, b) => b.pos - a.pos || a.id - b.id).map((w, i) => [w.id, i + 1 + offset]));
  // Etiketler üst üste binmesin diye aşağı itilir; çubuktaki çizgi gerçek yeri gösterir.
  let prev = -Infinity;
  let bottom = kelimeH;
  const grab = kelimeNarrating();
  for (const { w, pos } of shown) {
    const y = (1 - pos) * kelimeH;
    const label = Math.max(y, prev + KELIME.row, KELIME.row / 2);
    prev = label;
    bottom = Math.max(bottom, label + KELIME.row / 2);
    const tick = document.createElement('div');
    tick.className = 'kelime-tick';
    tick.style.top = `${y}px`;
    tick.style.background = kelimeTemp(pos);
    const chip = kelimeChip(w, ranks.get(w.id));
    chip.style.top = `${label - 13}px`;
    if (kelimeDrag?.moved && kelimeDrag.id === w.id || kelimeRemote?.id === w.id) chip.classList.add('moving');
    if (grab) chip.classList.add('grab');
    if (Math.abs(label - y) > 2) {
      const line = document.createElement('div');
      line.className = 'kelime-line';
      const dx = 16, dy = label - y;
      line.style.top = `${y}px`;
      line.style.width = `${Math.hypot(dx, dy)}px`;
      line.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
      track.append(line);
    }
    track.append(tick, chip);
  }
  track.style.height = `${bottom}px`;
  track.classList.toggle('placing', grab && kelimeSelected != null);
}

function kelimeChip(w, rank) {
  const chip = document.createElement('div');
  chip.className = 'kelime-word';
  chip.dataset.id = w.id;
  chip.style.setProperty('--who', kelimeColor(w.by));
  if (w.id === kelimeSelected) chip.classList.add('selected');
  const text = document.createElement('b');
  text.textContent = w.text;
  const by = document.createElement('span');
  by.className = 'muted';
  by.textContent = w.by;
  chip.append(text, by);
  if (rank && rank <= KELIME.top) {
    const r = document.createElement('span');
    r.className = 'rank';
    r.textContent = `#${rank}`;
    chip.append(r);
  }
  return chip;
}

function renderKelime() {
  const game = kelime;
  const active = kelimeActive();
  const narrator = game?.narrator === myName;
  const me = kelimeMe();
  const play = game?.phase === 'play';
  const last = kelimeLast();
  $('kelime-stop').hidden = !(play && narrator);
  $('kelime-end').hidden = !(active && me);
  $('kelime-close').hidden = game?.phase !== 'done';
  $('kelime-intro').hidden = Boolean(game);
  $('game-kelime').querySelector('.kelime-head').hidden = !game;
  // Havuz tur sırasında gizli: hedef kelime içinde olabilir.
  $('kelime-pool-box').hidden = play;
  const total = game?.players.length;
  $('kelime-status').textContent = !game
    ? ''
    : game.phase === 'done'
      ? 'Oyun bitti'
      : game.phase === 'pick'
        ? `${game.round}/${total}. tur hazırlanıyor · anlatıcı ${game.narrator}`
        : `${game.round}/${total}. tur · ` + (narrator ? 'Anlatıcı sensin' : `Anlatıcı: ${game.narrator}`);
  renderKelimePool();
  renderLobby('kelime');
  renderKelimeLobby();
  // Çubuk tur sırasında, sonra da sıradaki tur başlayana kadar (son turun hali) görünür.
  $('kelime-play').hidden = !game || !(play || last);
  if (!game) {
    $('kelime-clock').textContent = '';
    $('kelime-countdown').hidden = true;
    clearInterval(kelimeTicker);
    return;
  }

  const slot = $('kelime-slot');
  slot.replaceChildren();
  const shownFound = play ? null : last?.found;
  slot.className = 'kelime-slot' + (shownFound ? ' found' : '');
  if (!play && last) slot.append(`🎯 ${last.target}`, kelimeSmall(last.found ? `· ${last.found} buldu` : '· bulunamadı'));
  else if (game.target) slot.append(`🎯 ${game.target}`, kelimeSmall('· sadece sen görüyorsun'));
  else slot.append('🎯 ???');

  renderKelimeTurn();
  $('kelime-guess').hidden = !play || narrator || !me;
  $('kelime-trash').hidden = !(play && narrator);
  $('kelime-trash').classList.toggle('armed', kelimeSelected != null);
  $('kelime-help').textContent = !play
    ? ''
    : narrator
      ? 'Gelen kelimeyi sürükleyip çubuğa bırak (telefonda dokun, sonra çubuğa dokun). Yanlış yazılmışsa çöpe at. Çubuktaki kelimeleri de taşıyabilirsin.'
      : me
        ? `Tahmin yaz; anlatıcı onu çubuğa yerleştirir (üst sıcak, alt soğuk). İki tahmin arasında en az ${KELIME.cooldown / 1000} sn olmalı; bekleyen ${KELIME.queue} kelime varsa anlatıcıyı beklersin.`
        : 'Bu oyunu izliyorsun; bitince yeni oyuna katılabilirsin.';
  $('kelime-help').hidden = !play;

  $('kelime-results').hidden = play || !last;
  if (!play && last) {
    $('kelime-round-title').textContent = `${last.no}. tur · anlatıcı ${last.narrator}`;
    kelimeScoreList($('kelime-scores'), last.scores, (s) => [s.narrator ? 'anlatıcı' : '', s.words.join(', ')].filter(Boolean).join(' · '));
    kelimeScoreList($('kelime-totals'), game.totals, () => '', game.phase === 'done');
  }
  renderKelimeBar();
  kelimeTick();
  clearInterval(kelimeTicker);
  if (play) kelimeTicker = setInterval(kelimeTick, 250);
}

function kelimeScoreList(list, scores, sub, crown) {
  list.replaceChildren();
  scores.forEach((s, i) => {
    const li = timingRow(s.name, `${s.points > 0 ? '+' : ''}${s.points} puan`, sub(s));
    li.prepend(Object.assign(document.createElement('span'), { className: 'timing-rank', textContent: i + 1 }));
    if (crown && i === 0 && s.points > 0) li.classList.add('winner');
    list.append(li);
  });
}

// Tur arası: oyuncular, puanları ve anlatıcının kelime seçimi
function renderKelimeLobby() {
  const game = kelime;
  const pick = game?.phase === 'pick';
  $('kelime-lobby').hidden = !pick;
  if (!pick) return;
  const narrator = game.narrator === myName;
  const guessers = game.players.filter((p) => p.name !== game.narrator);

  const list = $('kelime-players');
  list.replaceChildren();
  for (const p of game.players) {
    const chip = document.createElement('span');
    chip.className = 'kelime-player';
    chip.style.setProperty('--who', p.color);
    const total = game.totals.find((t) => t.name === p.name);
    const role = p.name === game.narrator ? 'anlatıcı' : game.narrated.includes(p.name) ? 'anlattı' : 'bilen';
    chip.append(document.createElement('i'), p.name, kelimeSmall([role, total && `${total.points} puan`].filter(Boolean).join(' · ')));
    list.append(chip);
  }

  const ready = guessers.length > 0;
  $('kelime-pick-msg').textContent = !ready
    ? 'Bilen kalmadı.'
    : narrator
      ? game.target ? 'Hazırsan başlat; kelime 3 saniye sadece sende görünür, sonra herkeste 3, 2, 1.' : 'Hedef kelimeyi kendin yaz ya da havuzdan rastgele çek.'
      : `${game.narrator} kelimesini seçiyor…`;
  const choosing = narrator && ready;
  $('kelime-pick-tools').hidden = !choosing;
  const left = KELIME.rolls - game.rolls;
  $('kelime-roll').textContent = game.rolls ? `Başka rastgele (${left} hak)` : 'Rastgele';
  $('kelime-roll').disabled = left <= 0;
  if (!choosing) $('kelime-word-form').hidden = true;
  $('kelime-chosen').hidden = !(choosing && game.target);
  $('kelime-chosen-word').textContent = game.target || '';
}

const kelimeSmall = (text) => Object.assign(document.createElement('span'), { className: 'muted small', textContent: text });

// Yerleştirilmeyi bekleyen kelimeler ve her birinin kalan süresi
function renderKelimeTurn() {
  const box = $('kelime-turn');
  box.replaceChildren();
  const waiting = kelimeUnplaced();
  if (!waiting.length) return;
  const narrator = kelime.narrator === myName;
  box.append(kelimeSmall(narrator ? `Yerleştir (${waiting.length}/${KELIME.queue}) · süresi dolan en alta konur` : `${kelime.narrator} yerleştiriyor (${waiting.length}/${KELIME.queue})…`));
  for (const w of waiting) {
    const row = document.createElement('div');
    row.className = 'row';
    const chip = kelimeChip(w);
    if (narrator) chip.classList.add('grab');
    const secs = document.createElement('span');
    secs.className = 'secs kelime-secs';
    secs.dataset.until = w.until;
    row.append(chip, secs);
    box.append(row);
  }
}

function kelimeTick() {
  const game = kelime;
  if (!game) return;
  const now = serverNow();
  const play = game.phase === 'play';
  const left = play ? Math.min(game.endAt - now, game.endAt - game.startAt) : 0;
  $('kelime-clock').textContent = play ? fmtClock(left) : '';
  $('kelime-clock').classList.toggle('low', play && left < 30000);
  for (const secs of document.querySelectorAll('.kelime-secs')) secs.textContent = `${Math.max(0, Math.ceil((secs.dataset.until - now) / 1000))} sn`;

  // Tur başında: anlatıcı kelimesini görür, sonra herkeste 3, 2, 1
  const cd = $('kelime-countdown');
  const toStart = play ? game.startAt - now : 0;
  cd.hidden = toStart <= 0 || $('game-kelime').hidden;
  if (!cd.hidden) {
    cd.replaceChildren();
    if (toStart > KELIME.countdown) {
      const say = (t) => Object.assign(document.createElement('small'), { textContent: t });
      if (game.target) cd.append(say('Kelimen'), Object.assign(document.createElement('b'), { textContent: game.target }));
      else cd.append(say(`${game.narrator} kelimesine bakıyor…`));
    } else cd.append(String(Math.ceil(toStart / 1000)));
  }

  // Tahmin: bekleyen kelime sınırı ve iki tahmin arasındaki süre
  const input = $('kelime-guess-input');
  const button = $('kelime-guess').querySelector('button');
  if (play && kelimeMe() && game.narrator !== myName) {
    const wait = (game.lastGuess[myName] || 0) + KELIME.cooldown - now;
    const reason = toStart > 0 ? 'Başlamak üzere…'
      : kelimeUnplaced().length >= KELIME.queue ? 'Anlatıcı kelimeleri yerleştiriyor…'
        : wait > 0 ? `${Math.ceil(wait / 1000)} sn sonra yeni tahmin…` : '';
    const was = input.disabled;
    input.disabled = button.disabled = Boolean(reason);
    input.placeholder = reason || 'Tahminini yaz';
    if (was && !reason && !$('game-kelime').hidden && document.activeElement === document.body) input.focus();
  }
  if (!play || now > game.endAt) clearInterval(kelimeTicker);
}

function renderKelimePool() {
  $('kelime-pool-count').textContent = kelimePool.length || '';
  const box = $('kelime-pool');
  box.replaceChildren();
  for (const w of kelimePool) {
    const chip = document.createElement('span');
    chip.title = `${w.by} ekledi`;
    chip.textContent = w.text;
    const x = document.createElement('button');
    x.type = 'button';
    x.title = 'Havuzdan çıkar';
    x.textContent = '×';
    x.onclick = () => socket.emit('kelime:pool:remove', w.text);
    chip.append(x);
    box.append(chip);
  }
  if (!kelimePool.length) box.append(kelimeSmall('Havuz boş. Kelime ekleyin ya da dosyadan yükleyin; "rastgele" buradan seçer.'));
}

// Çubukta ekrandaki y'den konuma (0 alt, 1 üst)
function kelimePosAt(clientY) {
  const rect = $('kelime-track').getBoundingClientRect();
  return Math.min(1, Math.max(0, 1 - (clientY - rect.top) / kelimeH));
}

function kelimePlace(id, pos) {
  const w = kelime.words.find((x) => x.id === id);
  if (w) w.pos = pos; // sunucudan dönmesini beklemeden göster
  socket.emit('kelime:place', { id, pos });
}

function kelimeTrash(id) {
  kelime.words = kelime.words.filter((x) => x.id !== id);
  socket.emit('kelime:trash', id);
}

const kelimeOverTrash = (x, y) => {
  const r = $('kelime-trash').getBoundingClientRect();
  return !$('kelime-trash').hidden && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
};

// Anlatıcı: kelimeyi çubukta ya da yan kutuda tutup sürükler.
function kelimePointerDown(e) {
  if (!kelimeNarrating() || e.button > 0) return;
  const chip = e.target.closest('.kelime-word');
  if (!chip) {
    // Seçili kelime varken çubuğa dokunmak onu oraya koyar.
    if (kelimeSelected != null && e.currentTarget === $('kelime-track')) {
      kelimePlace(kelimeSelected, kelimePosAt(e.clientY));
      kelimeSelected = null;
      renderKelime();
    }
    return;
  }
  e.preventDefault();
  kelimeDrag = { id: Number(chip.dataset.id), pos: 0, fromTray: Boolean(chip.closest('#kelime-turn')), x0: e.clientX, y0: e.clientY, y: e.clientY, x: e.clientX, moved: false };
}

addEventListener('pointermove', (e) => {
  const d = kelimeDrag;
  if (!d) return;
  d.x = e.clientX;
  d.y = e.clientY;
  if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 6) return;
  d.moved = true;
  kelimeSelected = null;
  $('kelime-trash').classList.toggle('over', kelimeOverTrash(d.x, d.y));
  kelimeDragUpdate();
});

function kelimeDragUpdate() {
  const d = kelimeDrag;
  d.pos = kelimePosAt(d.y);
  renderKelimeBar();
  if (performance.now() - kelimeLastEmit > 60) {
    kelimeLastEmit = performance.now();
    socket.emit('kelime:drag', { id: d.id, pos: d.pos });
  }
}

// Sürüklerken kutunun kenarına gelince kendiliğinden kayar.
setInterval(() => {
  const d = kelimeDrag;
  if (!d?.moved) return;
  const box = $('kelime-scroll').getBoundingClientRect();
  const edge = 40;
  const step = d.y < box.top + edge ? -14 : d.y > box.bottom - edge ? 14 : 0;
  if (!step || d.x < box.left || d.x > box.right || d.y < box.top - 80 || d.y > box.bottom + 80) return;
  $('kelime-scroll').scrollTop += step;
  kelimeDragUpdate();
}, 30);

addEventListener('pointerup', (e) => {
  const d = kelimeDrag;
  if (!d) return;
  kelimeDrag = null;
  $('kelime-trash').classList.remove('over');
  if (!d.moved) {
    // Dokunma: seç, sonra çubuğa ya da çöpe dokunulunca oraya gider.
    kelimeSelected = kelimeSelected === d.id ? null : d.id;
    return renderKelime();
  }
  const box = $('kelime-scroll').getBoundingClientRect();
  const inside = e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top - 40 && e.clientY <= box.bottom + 40;
  if (kelimeOverTrash(e.clientX, e.clientY)) kelimeTrash(d.id);
  else if (inside || !d.fromTray) kelimePlace(d.id, kelimePosAt(e.clientY));
  if (!inside) socket.emit('kelime:drag', { id: d.id, pos: null });
  renderKelime();
});

addEventListener('pointercancel', () => {
  if (!kelimeDrag) return;
  kelimeDrag = null;
  $('kelime-trash').classList.remove('over');
  renderKelime();
});

$('kelime-track').addEventListener('pointerdown', kelimePointerDown);
$('kelime-turn').addEventListener('pointerdown', kelimePointerDown);
$('kelime-trash').onclick = () => {
  if (kelimeSelected == null || !kelimeNarrating()) return;
  kelimeTrash(kelimeSelected);
  kelimeSelected = null;
  renderKelime();
};

$('kelime-stop').onclick = () => socket.emit('kelime:stop');
$('kelime-end').onclick = () => socket.emit('kelime:end');
$('kelime-close').onclick = () => socket.emit('kelime:close');
$('kelime-roll').onclick = () => {
  $('kelime-word-form').hidden = true;
  socket.emit('kelime:roll');
};
$('kelime-write').onclick = () => {
  $('kelime-word-form').hidden = false;
  $('kelime-word-input').focus();
};
$('kelime-word-form').onsubmit = (e) => {
  e.preventDefault();
  const text = $('kelime-word-input').value.trim();
  if (!text) return;
  socket.emit('kelime:word', text);
  $('kelime-word-input').value = '';
  $('kelime-word-form').hidden = true;
};
$('kelime-begin').onclick = () => socket.emit('kelime:begin');

$('kelime-guess').onsubmit = (e) => {
  e.preventDefault();
  const input = $('kelime-guess-input');
  const text = input.value.trim();
  if (!text || input.disabled) return;
  socket.emit('kelime:guess', text);
  input.value = '';
};

$('kelime-pool-form').onsubmit = (e) => {
  e.preventDefault();
  const input = $('kelime-pool-input');
  if (!input.value.trim()) return;
  socket.emit('kelime:pool:add', input.value);
  input.value = '';
};

// Her satırda (ya da virgülle ayrılmış) bir kelime olan metin dosyası
$('kelime-pool-file').onchange = async () => {
  const file = $('kelime-pool-file').files[0];
  $('kelime-pool-file').value = '';
  if (!file) return;
  if (file.size > 1e6) return toast('Dosya çok büyük.');
  socket.emit('kelime:pool:add', await file.text());
};

function setKelime(game) {
  const prev = kelime;
  kelime = game;
  kelimeRemote = null;
  if (!game || game.id !== prev?.id || game.phase !== 'play' || game.round !== prev?.round) {
    kelimeDrag = null;
    kelimeSelected = null;
  }
  if (kelimeSelected != null && !game.words.some((w) => w.id === kelimeSelected)) kelimeSelected = null;
  // Yeni tur başlayınca çubuğun en üstü (sıcak uç) görünsün.
  if (game?.phase === 'play' && (game.id !== prev?.id || prev?.phase !== 'play')) $('kelime-scroll').scrollTop = 0;
  renderKelime();
}

socket.on('kelime', setKelime);
socket.on('kelime:pool', (pool) => {
  kelimePool = pool;
  renderKelimePool();
});
socket.on('kelime:drag', ({ gameId, id, pos }) => {
  if (kelime?.id !== gameId) return;
  kelimeRemote = pos == null ? null : { id, pos };
  renderKelimeBar();
});

// ---------- Eşini bul ----------
// Sırası gelen iki taş açar; sayı ve renk aynıysa çifti alır ve yeniden oynar. Kapalı taşların yüzü
// sunucudan gelmez. Tahta oyun başında bir kez kurulur, sonra taşlar sadece açılıp kapanır (dönme animasyonu için).

// Renkler sunucudaki MEMORY_COLORS sırasıyla aynı; sınırlar da sunucuyla aynı.
const MEMORY = {
  colors: {
    yesil: ['Yeşil', '#2fb344'], turuncu: ['Turuncu', '#f08c00'], mavi: ['Mavi', '#1c7ed6'], kirmizi: ['Kırmızı', '#e03131'],
    mor: ['Mor', '#9c36b5'], pembe: ['Pembe', '#e64980'], sari: ['Sarı', '#d4a000'], turkuaz: ['Turkuaz', '#15aabf'],
    kahve: ['Kahverengi', '#8b5a2b'], siyah: ['Siyah', '#222222'],
  },
  maxNumber: 30, pairs: [2, 60],
};
// Sütun sayısı: tahta kareye yakın (biraz geniş) olsun, mümkünse son satır yarım kalmasın.
function memoryCols(count) {
  const ideal = Math.sqrt(count * 1.25);
  let best = 4;
  let bestScore = Infinity;
  for (let c = 4; c <= 12; c++) {
    const score = (count % c ? 3 : 0) + Math.abs(c - ideal);
    if (score < bestScore) [best, bestScore] = [c, score];
  }
  return best;
}
let memory = null;
let memoryBoardId = null;
let memoryTicker = null;

const memoryActive = () => (memory && !memory.done ? memory : null);
const memoryCurrent = () => memory?.players[memory.turn];
const memoryMyTurn = () => Boolean(memoryActive() && memoryCurrent() === myName && !memory.revealUntil);

function renderMemory() {
  const game = memory;
  const active = memoryActive();
  const playing = game?.players.includes(myName);
  const current = memoryCurrent();
  renderLobby('memory');
  $('memory-end').hidden = !(active && playing);
  $('memory-close').hidden = !game?.done;
  $('memory-board').hidden = !game;
  $('game-memory').querySelector('.memory-head').hidden = !game;
  const left = game ? game.tiles.filter((t) => !t.owner).length / 2 : 0;
  $('memory-status').textContent = !game ? ''
    : game.done ? (left ? 'Oyun bitti' : 'Tüm çiftler bulundu')
      : (current === myName ? (game.open.length === 1 ? 'Sıra sende: bir taş daha aç' : 'Sıra sende: iki taş aç') : `Sıra: ${current}`)
        + ` · ${left} çift kaldı` + (playing ? '' : ' · İzliyorsun');
  if (!game) {
    $('memory-scores').replaceChildren();
    clearInterval(memoryTicker);
    return;
  }
  renderMemoryBoard();

  const list = $('memory-scores');
  list.replaceChildren();
  const solo = game.players.length === 1;
  const ranked = game.done ? [...game.players].sort((a, b) => game.scores[b] - game.scores[a]) : game.players;
  const best = Math.max(...game.players.map((n) => game.scores[n]));
  ranked.forEach((name, i) => {
    const turn = !game.done && name === current;
    const sub = [`${game.moves[name]} hamle`, turn ? 'sırada' : ''].filter(Boolean).join(' · ');
    const row = timingRow(name, `${game.scores[name]} çift`, sub, turn ? 'good' : '');
    if (game.done && !solo && best > 0 && game.scores[name] === best) row.classList.add('winner');
    row.classList.toggle('memory-turn', turn);
    row.prepend(Object.assign(document.createElement('span'), { className: 'timing-rank', textContent: game.done && !solo ? i + 1 : '' }));
    list.append(row);
  });
  if (game.done && solo && !left) {
    const secs = Math.round((game.endedAt - game.startedAt) / 1000);
    list.append(Object.assign(document.createElement('li'), { className: 'muted', textContent: `🎉 ${game.moves[myName] ?? game.moves[game.players[0]]} hamlede, ${fmtClock(secs * 1000)} sürede bitti.` }));
  }
  memoryTick();
  clearInterval(memoryTicker);
  if (active) memoryTicker = setInterval(memoryTick, 250);
}

function renderMemoryBoard() {
  const game = memory;
  const board = $('memory-board');
  if (memoryBoardId !== game.id) {
    memoryBoardId = game.id;
    board.replaceChildren();
    const cols = memoryCols(game.tiles.length);
    board.style.setProperty('--cols', cols);
    board.style.setProperty('--rows', Math.ceil(game.tiles.length / cols));
    for (const t of game.tiles) {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'memory-tile';
      tile.dataset.id = t.id;
      tile.innerHTML = '<span class="memory-inner"><span class="memory-back"></span><span class="memory-face"></span></span>';
      tile.onclick = () => {
        if (!memoryMyTurn() || memory.open.includes(t.id) || memory.tiles[t.id].owner) return;
        socket.emit('memory:flip', t.id);
      };
      board.append(tile);
    }
  }
  const mine = memoryMyTurn();
  for (const tile of board.children) {
    const t = game.tiles[Number(tile.dataset.id)];
    const open = Boolean(t.c);
    tile.classList.toggle('open', open);
    tile.classList.toggle('taken', Boolean(t.owner));
    tile.classList.toggle('miss', Boolean(game.revealUntil) && game.open.includes(t.id));
    tile.classList.toggle('can', mine && !open);
    tile.disabled = !mine || open;
    tile.title = t.owner ? `${t.owner} buldu` : '';
    const face = tile.querySelector('.memory-face');
    if (open) {
      face.textContent = t.n;
      face.style.setProperty('--c', MEMORY.colors[t.c][1]);
    }
  }
}

function memoryTick() {
  const game = memoryActive();
  $('memory-clock').textContent = game?.turnUntil && !game.revealUntil ? `${Math.max(0, Math.ceil((game.turnUntil - serverNow()) / 1000))} sn` : '';
  $('memory-clock').classList.toggle('low', Boolean(game?.turnUntil) && game.turnUntil - serverNow() < 5000);
  if (!game) clearInterval(memoryTicker);
}

confirmButton($('memory-end'), 'Emin misin? Tekrar bas', () => socket.emit('memory:end'));
$('memory-close').onclick = () => socket.emit('memory:close');

function setMemory(game) {
  memory = game;
  renderMemory();
}
socket.on('memory', setMemory);

// ---------- Radyo ----------
// Uydu görüntülü dönen bir dünya küresi; yeşil noktalar radyo olan yerler (aynı şehirdeki istasyonlar tek nokta).
// Küre çevrilince ortadaki halkanın altına gelen yer seçilir, istasyonları sol altta listelenir; birine basınca
// odanın ortak radyosu o olur. Ses sadece Radyo sayfasındayken çalar (o sırada YouTube sende kısılır), sayfadan
// çıkınca yayın indirilmeyi de bırakır. Harita kütüphanesi (MapLibre) ve istasyon listesi sayfa ilk açılınca yüklenir.

const RADIO_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/5.6.0/';
const RADIO_IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'; // anahtar istemez
const RADIO_RING = 44;      // px; halkanın yarıçapı, bu alana giren en yakın yer seçilir
const RADIO_IDLE = 8000;    // ms; başkası radyo açınca, küreyi bu kadar süredir çevirmeyenin küresi oraya döner
const RADIO_FOCUS = 5;      // radyo açılınca kürenin yakınlaştığı seviye (şehir ve çevresi görünür)
let radio = null;           // odada çalan istasyon: { id, name, cc, country, state, tags, url, codec, bitrate, lat, lon, by }
let radioMap = null;
let radioMapLoading = null;
let radioState = '';        // '', 'loading', 'playing', 'error'
let radioPaused = false;    // sadece bende duraklatıldı
let radioPlaces = [];       // [{ i, lat, lon, cc, title, country, stations }]
const radioById = new Map(); // id -> { id, name, cc, lat, lon, tags, state, place }
let radioPlace = null;      // halkanın altındaki yer
let radioTab = 'explore';
let radioTouchedAt = 0;
let radioFavs = [];
try {
  radioFavs = JSON.parse(localStorage.getItem('radio-favs')) || [];
} catch {}

const radioPage = () => !$('radio').hidden;
const radioFlag = (cc) => (/^[A-Z]{2}$/.test(cc || '') ? String.fromCodePoint(...[...cc].map((c) => 127397 + c.charCodeAt(0))) : '🌐');
const radioRegions = new Intl.DisplayNames(['tr'], { type: 'region' });
const radioCountry = (cc) => {
  try {
    return cc ? radioRegions.of(cc) : '';
  } catch {
    return cc;
  }
};
const radioSmall = (text) => Object.assign(document.createElement('span'), { className: 'muted small', textContent: text });

function loadAsset(url) {
  return new Promise((resolve, reject) => {
    const el = url.endsWith('.css')
      ? Object.assign(document.createElement('link'), { rel: 'stylesheet', href: url })
      : Object.assign(document.createElement('script'), { src: url });
    el.onload = resolve;
    el.onerror = () => reject(new Error('Harita yüklenemedi.'));
    document.head.append(el);
  });
}

// Aynı şehirdeki istasyonlar tek yer olur (şehri bilinmeyenler ≈10 km'lik karelere göre); yerin adı şehir, yoksa ülke.
function radioGroup(rows) {
  const byKey = new Map();
  for (const [id, name, cc, lat, lon, tags, state] of rows) {
    const key = state ? `${cc}:${state}` : `${Math.round(lat * 10)}:${Math.round(lon * 10)}`;
    let place = byKey.get(key);
    if (!place) byKey.set(key, (place = { i: byKey.size, cc, stations: [] }));
    const station = { id, name, cc, lat, lon, tags, state, place };
    place.stations.push(station);
    radioById.set(id, station);
  }
  radioPlaces = [...byKey.values()];
  for (const p of radioPlaces) {
    p.lat = p.stations.reduce((sum, s) => sum + s.lat, 0) / p.stations.length;
    p.lon = p.stations.reduce((sum, s) => sum + s.lon, 0) / p.stations.length;
    const counts = new Map();
    for (const s of p.stations) if (s.state) counts.set(s.state, (counts.get(s.state) || 0) + 1);
    p.country = radioCountry(p.cc);
    p.title = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || p.country || 'Bilinmeyen yer';
    p.stations.sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  }
}

function radioMapReady() {
  radioMapLoading ||= (async () => {
    await Promise.all([loadAsset(`${RADIO_LIB}maplibre-gl.min.css`), loadAsset(`${RADIO_LIB}maplibre-gl.min.js`)]);
    const res = await fetch('/radio/stations');
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Radyo listesi alınamadı.');
    radioGroup(await res.json());
    const start = radio && radioById.get(radio.id)?.place;
    radioMap = new maplibregl.Map({
      container: 'radio-map',
      center: start ? [start.lon, start.lat] : [32, 39],
      zoom: start ? 1.6 : 0.9, // başta küre uzaktan görünsün
      maxZoom: 12,
      attributionControl: false,
      style: {
        version: 8,
        projection: { type: 'globe' },
        sources: {
          sat: { type: 'raster', tiles: [RADIO_IMAGERY], tileSize: 256, maxzoom: 17, attribution: 'Uydu görüntüsü © Esri, Maxar, Earthstar Geographics' },
          places: {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: radioPlaces.map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { i: p.i, n: p.stations.length } })) },
          },
        },
        layers: [
          { id: 'sat', type: 'raster', source: 'sat' },
          {
            id: 'places', type: 'circle', source: 'places',
            paint: {
              'circle-color': '#50f08c',
              'circle-opacity': 0.9,
              // Çok istasyonlu yerler biraz daha büyük; yakınlaştıkça hepsi büyür
              'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, ['min', 3.2, ['+', 1.4, ['*', 0.12, ['get', 'n']]]], 6, ['min', 8, ['+', 3.5, ['*', 0.25, ['get', 'n']]]]],
            },
          },
          { id: 'selected', type: 'circle', source: 'places', filter: ['==', ['get', 'i'], -1], paint: { 'circle-color': '#ffffff', 'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 3.5, 6, 7] } },
          { id: 'playing', type: 'circle', source: 'places', filter: ['==', ['get', 'i'], -1], paint: { 'circle-color': '#50f08c', 'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 4, 6, 8], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } },
        ],
      },
    });
    radioMap.addControl(new maplibregl.AttributionControl({ compact: true }), 'top-left'); // sağ alttaki butonlarla çakışmasın
    await new Promise((resolve) => radioMap.once('load', resolve));
    let pending = false;
    radioMap.on('move', () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        radioPickCenter();
      });
    });
    radioMap.on('idle', radioPickCenter); // ani zıplama ya da uçuştan sonra çizim bitince bir kez daha bak
    // Sadece kişinin kendi çevirmesi sayılır (radyo değişince yapılan uçuş değil)
    for (const ev of ['dragstart', 'zoomstart', 'rotatestart']) radioMap.on(ev, (e) => e.originalEvent && (radioTouchedAt = Date.now()));
    radioMap.on('click', 'places', (e) => {
      radioTouchedAt = Date.now();
      radioMap.easeTo({ center: e.features[0].geometry.coordinates, duration: 700 });
    });
    radioMap.on('mouseenter', 'places', () => (radioMap.getCanvas().style.cursor = 'pointer'));
    radioMap.on('mouseleave', 'places', () => (radioMap.getCanvas().style.cursor = ''));
    renderRadioPlaying();
    radioPickCenter();
  })();
  radioMapLoading.catch((err) => {
    radioMapLoading = null;
    toast(err.message || 'Harita yüklenemedi.');
  });
  return radioMapLoading;
}

// Halkanın içine düşen yerlerden merkeze en yakını seçilir; halka boşsa son seçilen kalır.
function radioPickCenter() {
  const box = radioMap.getContainer();
  const x = box.clientWidth / 2;
  const y = box.clientHeight / 2;
  let best = null;
  let bestDist = Infinity;
  for (const f of radioMap.queryRenderedFeatures([[x - RADIO_RING, y - RADIO_RING], [x + RADIO_RING, y + RADIO_RING]], { layers: ['places'] })) {
    const p = radioMap.project(f.geometry.coordinates);
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bestDist) [best, bestDist] = [radioPlaces[f.properties.i], d];
  }
  if (!best || best === radioPlace) return;
  radioPlace = best;
  radioMap.setFilter('selected', ['==', ['get', 'i'], best.i]);
  $('radio').querySelector('.radio-ring').classList.add('on');
  renderRadioPlace();
}

function renderRadioPlace() {
  const p = radioPlace;
  $('radio-place-count').textContent = p ? p.stations.length : '–';
  $('radio-place-title').textContent = p ? p.title : 'Dünyayı çevir';
  $('radio-place-sub').textContent = p ? `${radioFlag(p.cc)} ${p.title === p.country ? '' : p.country}`.trim() : 'Halkayı yeşil bir noktanın üstüne getir';
  if (radioTab === 'explore') renderRadioList();
}

function radioStationsForTab() {
  if (radioTab === 'favs') return radioFavs.map((id) => radioById.get(id)).filter(Boolean);
  if (radioTab === 'search') {
    const q = $('radio-search').value.trim().toLocaleLowerCase('tr');
    if (q.length < 2) return [];
    const out = [];
    for (const s of radioById.values()) {
      const hay = `${s.name} ${s.state} ${s.place.country} ${s.tags}`.toLocaleLowerCase('tr');
      if (hay.includes(q) && out.push(s) >= 60) break;
    }
    return out;
  }
  return radioPlace?.stations || [];
}

function renderRadioList() {
  const list = $('radio-list');
  list.replaceChildren();
  const stations = radioStationsForTab();
  for (const s of stations) {
    const li = document.createElement('li');
    li.className = 'radio-row' + (radio?.id === s.id ? ' playing' : '');
    const play = document.createElement('button');
    play.className = 'radio-row-main';
    const name = Object.assign(document.createElement('strong'), { textContent: s.name });
    const sub = radioTab === 'explore' ? s.tags : [`${radioFlag(s.cc)} ${s.state || s.place.country}`, s.tags].filter(Boolean).join(' · ');
    play.append(name, radioSmall(sub || ' '));
    play.onclick = () => {
      if (radio?.id !== s.id) socket.emit('radio:play', s.id);
      else if (radioPaused) radioSetPaused(false);
    };
    const fav = document.createElement('button');
    fav.className = 'radio-icon radio-row-fav' + (radioFavs.includes(s.id) ? ' on' : '');
    fav.title = radioFavs.includes(s.id) ? 'Favorilerden çıkar' : 'Favorilere ekle';
    fav.innerHTML = '<svg class="ic"><use href="#i-heart"></use></svg>';
    fav.onclick = () => radioToggleFav(s.id);
    li.append(play, fav);
    list.append(li);
  }
  if (!stations.length) {
    const empty = { explore: 'Küreyi çevir; halkanın altına gelen yerin radyoları burada listelenir.', favs: 'Henüz favorin yok. Bir istasyonun yanındaki ♥ ile ekle.', search: 'En az iki harf yaz.' }[radioTab];
    list.append(Object.assign(document.createElement('li'), { className: 'radio-empty muted small', textContent: radioTab === 'search' && $('radio-search').value.trim().length >= 2 ? 'Sonuç yok.' : empty }));
  }
}

function radioToggleFav(id) {
  radioFavs = radioFavs.includes(id) ? radioFavs.filter((x) => x !== id) : [...radioFavs, id];
  try {
    localStorage.setItem('radio-favs', JSON.stringify(radioFavs));
  } catch {}
  renderRadioList();
  renderRadioPlayer();
}

function renderRadioPlayer() {
  const status = { loading: 'Bağlanıyor…', playing: '● Canlı', error: 'Yayın açılmadı' }[radioState] || '';
  $('radio-now-name').textContent = radio ? radio.name : 'Radyo kapalı';
  $('radio-now-sub').textContent = radio
    ? [[radio.state, radio.country].filter(Boolean).join(', '), `${radio.by} açtı`].join(' · ')
    : 'Listeden bir istasyona bas, herkeste açılsın';
  $('radio-now-status').textContent = radio && radioPaused ? 'Sende duraklatıldı' : radio ? status : '';
  $('radio-now-status').className = `radio-now-status ${radioPaused ? '' : radioState}`;
  $('radio-fav').hidden = !radio;
  $('radio-fav').classList.toggle('on', Boolean(radio && radioFavs.includes(radio.id)));
  $('radio-stop').hidden = !radio;
  const playing = radio && !radioPaused;
  $('radio-toggle').querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  const siblings = radio && radioById.get(radio.id)?.place.stations.length > 1;
  $('radio-prev').disabled = $('radio-next').disabled = !siblings;
}

// Çalan istasyonun yeri kürede beyaz halkalı nokta olur.
function renderRadioPlaying() {
  if (!radioMap) return;
  const place = radio && radioById.get(radio.id)?.place;
  radioMap.setFilter('playing', ['==', ['get', 'i'], place ? place.i : -1]);
}

function radioFlyTo(place, force) {
  if (!radioMap || !place) return;
  if (!force && Date.now() - radioTouchedAt < RADIO_IDLE) return;
  radioMap.flyTo({ center: [place.lon, place.lat], zoom: Math.max(radioMap.getZoom(), RADIO_FOCUS), duration: 2000 });
}

async function openRadioPage() {
  renderRadioPlayer();
  renderRadioList();
  syncRadioAudio();
  try {
    await radioMapReady();
  } catch {
    return;
  }
  radioMap.resize();
}

// Yayın sadece Radyo sayfasındayken (ve kişi duraklatmadıysa) indirilir ve çalar.
function syncRadioAudio() {
  const audio = $('radio-audio');
  if (!radioPage() || !radio || radioPaused) {
    if (audio.dataset.id) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      delete audio.dataset.id;
    }
    radioState = '';
    renderRadioPlayer();
    return;
  }
  if (audio.dataset.id !== radio.id) {
    audio.dataset.id = radio.id;
    audio.src = radio.url;
    radioState = 'loading';
  }
  if (audio.paused) {
    audio.play().catch((err) => {
      if (err.name === 'NotAllowedError') toast('Tarayıcı sesi engelledi; radyoyu duymak için sayfaya bir kez tıkla.');
    });
  }
  renderRadioPlayer();
}

function radioSetPaused(paused) {
  radioPaused = paused;
  syncRadioAudio();
}

const radioAudio = $('radio-audio');
radioAudio.addEventListener('playing', () => {
  radioState = 'playing';
  renderRadioPlayer();
});
radioAudio.addEventListener('waiting', () => {
  radioState = 'loading';
  renderRadioPlayer();
});
radioAudio.addEventListener('error', () => {
  if (!radioAudio.dataset.id) return; // sayfadan çıkınca bilerek durduruldu
  radioState = 'error';
  renderRadioPlayer();
  toast('Bu radyonun yayını açılmadı; başka bir istasyon seç.');
});
// Engellenen ilk çalma, sayfaya ilk tıklamada yeniden denenir.
document.addEventListener('pointerdown', () => {
  if (radioPage() && radio && !radioPaused && radioAudio.paused && radioState !== 'error') radioAudio.play().catch(() => {});
});

// Radyo sesi kişiye özel; YouTube gibi biri konuşurken kısılır (duck).
let radioVolume = 70;
try {
  radioVolume = Number(localStorage.getItem('radio-volume') ?? 70);
} catch {}
$('radio-vol').value = radioVolume;
$('radio-vol').oninput = () => {
  radioVolume = Number($('radio-vol').value);
  try {
    localStorage.setItem('radio-volume', radioVolume);
  } catch {}
};
setInterval(() => {
  radioAudio.volume = Math.min(1, (radioVolume / 100) * duck);
}, 100);

// Önceki / sonraki: çalan istasyonun yerindeki listede gezer (herkeste değişir).
function radioStep(dir) {
  const stations = radio && radioById.get(radio.id)?.place.stations;
  if (!stations || stations.length < 2) return;
  const i = stations.findIndex((s) => s.id === radio.id);
  socket.emit('radio:play', stations[(i + dir + stations.length) % stations.length].id);
}

$('radio-toggle').onclick = () => {
  if (radio) return radioSetPaused(!radioPaused);
  const first = radioPlace?.stations[0];
  if (first) socket.emit('radio:play', first.id);
};
$('radio-prev').onclick = () => radioStep(-1);
$('radio-next').onclick = () => radioStep(1);
$('radio-fav').onclick = () => radio && radioToggleFav(radio.id);
$('radio-random').onclick = () => socket.emit('radio:random');
$('radio-shuffle').onclick = () => socket.emit('radio:random');
confirmButton($('radio-stop'), 'Herkeste kapat?', () => socket.emit('radio:stop'));
$('radio-zoom-in').onclick = () => radioMap?.zoomIn();
$('radio-zoom-out').onclick = () => radioMap?.zoomOut();
$('radio-locate').onclick = () => {
  if (!navigator.geolocation) return toast('Tarayıcın konum vermiyor.');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      radioTouchedAt = Date.now();
      radioMap?.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 6, duration: 2000 });
    },
    () => toast('Konum alınamadı.'),
    { timeout: 10000 },
  );
};
for (const tab of $('radio').querySelectorAll('.radio-tabs button')) {
  tab.onclick = () => {
    radioTab = tab.dataset.tab;
    for (const b of $('radio').querySelectorAll('.radio-tabs button')) b.classList.toggle('active', b === tab);
    $('radio-search').hidden = radioTab !== 'search';
    if (radioTab === 'search') $('radio-search').focus();
    renderRadioList();
  };
}
$('radio-search').oninput = renderRadioList;

function setRadio(station) {
  const changed = station?.id !== radio?.id;
  radio = station;
  if (changed) {
    radioState = '';
    radioPaused = false; // yeni istasyon herkeste çalar
  }
  syncRadioAudio();
  renderRadioList();
  renderRadioPlaying();
  // Kendi açtığım radyoya ekran her zaman odaklanır; başkasınınkine, küreyi o an çevirmiyorsam
  if (changed && radio && radioPage()) radioFlyTo(radioById.get(radio.id)?.place, radio.by === myName);
}
socket.on('radio', setRadio);

// ---------- Lobi ----------
// Grup oyunları lobiyle başlar: biri lobi kurar, isteyen girer ya da çıkar, kuran başlatınca oyun lobideki
// ekiple başlar. Oyun sürerken lobi kutusu gizlenir; lobide olmayanlar oyunu izler.

let lobbies = {}; // oyun -> { game, host, players, opts }
const BOT_NAME = 'Bot 🤖'; // sunucudaki BOT ile aynı
const LOBBY = {
  race: {
    title: 'Süre yarışı', tab: 'timing', running: () => Boolean(activeRace()), last: () => timing.race,
    hint: 'Lobidekilere aynı rastgele hedefler gelir, turlar herkeste aynı anda başlar; toplam farkı en az olan kazanır.',
  },
  dino: {
    title: 'Dinozor koşusu', tab: 'dino', running: () => Boolean(dinoGame && !dinoGame.done), last: () => dinoGame,
    hint: 'Lobidekiler Jef\'in peşinden birlikte koşar; başlatınca 5 sn geri sayım olur.',
  },
  memory: {
    title: 'Eşini bul', tab: 'memory', running: () => Boolean(memoryActive()), last: () => memory,
    hint: 'Sırayla iki taş açılır, eşini bulan yeniden oynar. Tek başına da oynanabilir.',
  },
  kelime: {
    title: 'Kelime', tab: 'kelime', running: () => Boolean(kelimeActive()), last: () => kelime,
    hint: 'Biri anlatır, diğerleri bilir; herkes bir kez anlatır. 2-6 kişi.',
  },
};

const lobbyButton = (text, cls, onclick) => Object.assign(document.createElement('button'), { type: 'button', className: cls, textContent: text, onclick });
const lobbyEmit = (event, game, extra) => socket.emit(event, { game, ...extra });

function renderLobby(game) {
  const box = $(`lobby-${game}`);
  const def = LOBBY[game];
  const lobby = lobbies[game];
  box.replaceChildren();
  box.hidden = def.running();
  $(`game-tab-${def.tab}`).classList.toggle('lobby-open', Boolean(lobby) && box.hidden === false);
  if (box.hidden) return;

  const head = document.createElement('div');
  head.className = 'lobby-head';
  const title = document.createElement('strong');
  title.textContent = lobby ? `${def.title} lobisi` : def.title;
  head.append(title);
  box.append(head);

  if (!lobby) {
    box.classList.remove('open');
    box.append(Object.assign(document.createElement('p'), { className: 'muted small', textContent: def.hint }));
    const row = document.createElement('div');
    row.className = 'lobby-actions';
    row.append(lobbyButton('Lobi kur', 'primary', () => lobbyEmit('lobby:open', game)));
    if (def.last()) row.append(lobbyButton('Aynı ekiple lobi kur', '', () => lobbyEmit('lobby:open', game, { again: true })));
    box.append(row);
    return;
  }

  box.classList.add('open');
  const mine = lobby.players.includes(myName);
  const host = lobby.host === myName;
  head.append(kelimeSmall(`${lobby.players.length} kişi · ${lobby.host} kurdu`));

  const list = document.createElement('div');
  list.className = 'lobby-players';
  for (const name of lobby.players) {
    const chip = document.createElement('span');
    chip.className = 'lobby-player' + (name === myName ? ' me' : '');
    chip.append(makeAvatar(name), name);
    if (name === lobby.host) chip.append(kelimeSmall('kurucu'));
    if (name === lobby.opts.narrator) chip.append(kelimeSmall('🎙️ anlatıcı'));
    list.append(chip);
  }
  box.append(list);

  // Oyunun ayarları
  if (game === 'race') {
    const row = document.createElement('div');
    row.className = 'lobby-opts';
    row.append(kelimeSmall('Tur:'));
    for (const n of RACE_ROUNDS) {
      const b = lobbyButton(`${n} tur`, 'sm' + (n === lobby.opts.rounds ? ' active' : ''), () => lobbyEmit('lobby:opts', game, { rounds: n }));
      b.disabled = !host;
      row.append(b);
    }
    box.append(row);
  }
  if (game === 'memory') box.append(...memoryLobbyOpts(lobby, host));
  if (game === 'kelime') {
    const row = document.createElement('div');
    row.className = 'lobby-opts';
    const seat = lobby.opts.narrator;
    if (seat) {
      row.append(kelimeSmall(`🎙️ İlk anlatıcı: ${seat}`));
      if (mine && (seat === myName || seat === BOT_NAME)) row.append(lobbyButton('Bırak', 'sm ghost', () => lobbyEmit('lobby:opts', game, { narrator: null })));
    } else {
      if (mine) row.append(lobbyButton('🎙️ İlk ben anlatayım', 'sm', () => lobbyEmit('lobby:opts', game, { narrator: 'me' })));
      if (mine && lobby.players.includes(BOT_NAME)) row.append(lobbyButton('Bot anlatsın', 'sm', () => lobbyEmit('lobby:opts', game, { narrator: 'bot' })));
      row.append(kelimeSmall(`Kimse seçmezse ${lobby.host} anlatır.`));
    }
    box.append(row);
  }

  const actions = document.createElement('div');
  actions.className = 'lobby-actions';
  if (host) {
    actions.append(lobbyButton(`Başlat (${lobby.players.length} kişi)`, 'primary', () => lobbyEmit('lobby:start', game)));
    actions.append(lobbyButton('Lobiden çık', 'ghost', () => lobbyEmit('lobby:leave', game)));
    actions.append(lobbyButton('Lobiyi kapat', 'ghost danger', () => lobbyEmit('lobby:cancel', game)));
  } else if (mine) {
    actions.append(lobbyButton('Lobiden çık', '', () => lobbyEmit('lobby:leave', game)));
    actions.append(kelimeSmall(`${lobby.host} başlatınca oyun bu ekiple başlar.`));
  } else {
    actions.append(lobbyButton('Lobiye katıl', 'primary', () => lobbyEmit('lobby:join', game)));
    actions.append(kelimeSmall('Katılmazsan oyunu izlersin.'));
  }
  box.append(actions);
}

// Eşini bul tahtası: kurucu sayı ve renk ekleyip çıkarır; her sayı-renk ikilisinden iki taş olur.
function memoryLobbyOpts(lobby, host) {
  const { numbers, colors } = lobby.opts;
  const pairs = numbers.length * colors.length;
  const set = (opts) => lobbyEmit('lobby:opts', 'memory', { numbers, colors, ...opts });
  const fits = (n, c) => n * c >= MEMORY.pairs[0] && n * c <= MEMORY.pairs[1];
  const chip = (label, color, onRemove) => {
    const el = document.createElement('span');
    el.className = 'memory-chip';
    if (color) el.style.setProperty('--c', color);
    el.append(label);
    if (host && onRemove) el.append(lobbyButton('×', 'memory-chip-x', onRemove));
    return el;
  };
  const plus = (title, onclick, ok) => {
    const b = lobbyButton('+', 'sm memory-plus', onclick);
    b.title = title;
    b.disabled = !ok;
    return b;
  };

  const numRow = document.createElement('div');
  numRow.className = 'lobby-opts';
  numRow.append(kelimeSmall('Sayılar:'));
  for (const n of numbers) {
    numRow.append(chip(String(n), null, fits(numbers.length - 1, colors.length) ? () => set({ numbers: numbers.filter((x) => x !== n) }) : null));
  }
  const nextNumber = [...Array(MEMORY.maxNumber + 1).keys()].find((n) => !numbers.includes(n));
  if (host) numRow.append(plus('Sayı ekle', () => set({ numbers: [...numbers, nextNumber] }), nextNumber != null && fits(numbers.length + 1, colors.length)));

  const colorRow = document.createElement('div');
  colorRow.className = 'lobby-opts';
  colorRow.append(kelimeSmall('Renkler:'));
  for (const c of colors) {
    colorRow.append(chip(MEMORY.colors[c][0], MEMORY.colors[c][1], fits(numbers.length, colors.length - 1) ? () => set({ colors: colors.filter((x) => x !== c) }) : null));
  }
  const nextColor = Object.keys(MEMORY.colors).find((c) => !colors.includes(c));
  if (host) colorRow.append(plus('Renk ekle', () => set({ colors: [...colors, nextColor] }), nextColor && fits(numbers.length, colors.length + 1)));

  const note = kelimeSmall(`${pairs} çift · ${pairs * 2} taş` + (host ? ` (en çok ${MEMORY.pairs[1] * 2} taş)` : ''));
  return [numRow, colorRow, note];
}

function renderLobbies() {
  for (const game of Object.keys(LOBBY)) renderLobby(game);
}

socket.on('lobbies', (state) => {
  lobbies = state || {};
  renderLobbies();
});

// ---------- Bot ----------
// Açıkken yeni başlayan kelime, süre yarışı ve dinozor oyunlarına "Bot 🤖" da katılır ve rastgele oynar.

let botOn = false;

function setBot(on) {
  botOn = on;
  $('bot-toggle').textContent = on ? '🤖 Bot var · çıkar' : '🤖 Bot ekle';
  $('bot-toggle').classList.toggle('on', on);
  renderKelime();
  renderLobbies();
}
$('bot-toggle').onclick = () => socket.emit('bot:set', !botOn);
socket.on('bot', setBot);

// ---------- Oyun öner ----------
// İstenen oyun adım adım anlatılır. Yazılanlar bu cihazda taslak olarak durur; gönderilince herkese
// görünen listeye düşer, site sahibi eklenip eklenmeyeceğine karar verir (durum sunucudaki kayıttan gelir).

const PLAYERS = ['1', '2', '3', '4', '5', '6'];
const ONER_STEPS = [
  {
    title: 'Oyun', head: 'Oyunun kendisi', intro: 'Önce kısaca ne olduğunu anlat.',
    fields: [
      { key: 'ad', label: 'Oyunun adı', required: true, max: 60, placeholder: 'ör. Kim Bu?' },
      { key: 'ozet', label: 'Tek cümlede oyun', required: true, max: 200, placeholder: 'ör. Herkes sırayla bir ünlüyü anlatır, diğerleri bilmeye çalışır.' },
      { key: 'tur', label: 'Ne tür bir oyun?', type: 'choice', options: ['Kelime', 'Bilgi / quiz', 'Refleks / hız', 'Çizim', 'Strateji', 'Kart / masa', 'Parti / sosyal', 'Diğer'] },
      { key: 'ilham', label: 'Benzer bildiğin bir oyun ya da link', max: 300, placeholder: 'ör. Gartic, Codenames, bir YouTube videosu…', help: 'Varsa, nasıl bir şey istediğini anlamak çok kolaylaşır.' },
    ],
  },
  {
    title: 'Oyuncular', head: 'Kimler, nasıl oynuyor?', intro: 'Odada en fazla 6 kişi olabiliyor.',
    fields: [
      { row: [
        { key: 'minOyuncu', label: 'En az kaç kişi?', type: 'choice', options: PLAYERS },
        { key: 'maxOyuncu', label: 'En fazla kaç kişi?', type: 'choice', options: PLAYERS },
      ] },
      { key: 'takim', label: 'Oyuncular nasıl ayrılıyor?', type: 'choice', options: ['Herkes tek başına', 'Takımlar halinde', 'Herkes birlikte (iş birliği)', 'Biri herkese karşı'] },
      { key: 'roller', label: 'Özel roller var mı?', type: 'textarea', max: 1000, placeholder: 'ör. Her turda biri anlatıcı olur, sırayla döner. Anlatıcı kelimeyi görür, diğerleri görmez.', help: 'Yoksa boş bırak.' },
      { key: 'ses', label: 'Sesli konuşma ne kadar önemli?', type: 'choice', options: ['Konuşmak şart', 'Konuşmak oyunu güzelleştirir', 'Konuşmaya gerek yok'] },
    ],
  },
  {
    title: 'Akış', head: 'Oyun nasıl oynanıyor?', intro: 'En önemli kısım. Biri hiç bilmiyormuş gibi adım adım yaz.',
    fields: [
      { key: 'baslangic', label: 'Oyun nasıl başlıyor?', type: 'textarea', required: true, max: 1000, placeholder: 'ör. Biri "Başlat"a basar, herkese rastgele bir kart dağıtılır, 3 saniyelik geri sayım olur…' },
      { key: 'akis', label: 'Bir tur / sıra adım adım nasıl işliyor?', type: 'textarea', required: true, max: 2000, big: true, placeholder: '1. Sıradaki oyuncu …\n2. Diğerleri …\n3. Doğru bilen olursa …\n4. Sonra sıra …', help: 'Kim ne yapıyor, ne zaman sıra geçiyor, doğru/yanlış olunca ne oluyor?' },
      { key: 'bitis', label: 'Oyun ne zaman ve nasıl bitiyor?', type: 'textarea', required: true, max: 1000, placeholder: 'ör. 5 tur sonunda, ya da biri 30 puana ulaşınca.' },
      { row: [
        { key: 'sure', label: 'Bir oyun ne kadar sürsün?', type: 'choice', options: ['2 dk’dan kısa', '2-5 dk', '5-10 dk', '10-20 dk', '20 dk’dan uzun'] },
        { key: 'turSayisi', label: 'Kaç tur?', max: 200, placeholder: 'ör. 5, ya da herkes bir kez anlatana kadar' },
      ] },
    ],
  },
  {
    title: 'Ekran', head: 'Ekran ve kontroller', intro: 'Oynarken ekranda neler olsun, nasıl oynansın?',
    fields: [
      { key: 'ekran', label: 'Ekranda neler görünüyor?', type: 'textarea', max: 2000, big: true, placeholder: 'ör. Ortada büyük bir kart, altında kalan süre, sağda puan tablosu. Anlatıcının ekranında gizli kelime görünür, diğerlerinde "???".', help: 'Kimin ekranında ne var, ne gizli? İstersen çizer gibi tarif et.' },
      { key: 'pc', label: 'Bilgisayarda nasıl oynanıyor?', type: 'textarea', max: 1000, placeholder: 'ör. Yazıp Enter’a basarak tahmin edilir; boşluk tuşu pas geçer.' },
      { key: 'telefon', label: 'Telefonda nasıl oynanıyor?', type: 'textarea', max: 1000, placeholder: 'ör. Büyük butonlara dokunarak.' },
      { key: 'zaman', label: 'Süre sınırları var mı?', type: 'textarea', max: 1000, placeholder: 'ör. Her tahmin için 15 sn, tüm oyun 5 dk. Süre bitince sıra geçer.' },
    ],
  },
  {
    title: 'Puan', head: 'Puan ve kazanma', intro: 'Kim, nasıl kazanıyor?',
    fields: [
      { key: 'puan', label: 'Puan nasıl kazanılıyor?', type: 'textarea', required: true, max: 1500, placeholder: 'ör. İlk bilen 3, ikinci 2, üçüncü 1 puan. Anlatan, bilen başına 1 puan alır.', help: 'Puan yoksa onu yaz: ör. "Puan yok, son kalan kazanır."' },
      { key: 'kazanan', label: 'Kazanan nasıl belirleniyor?', type: 'textarea', max: 1000, placeholder: 'ör. En çok puanı olan. Eşitlikte en hızlı bilen.' },
      { key: 'skorTablosu', label: 'Skorlar saklansın mı?', type: 'choice', options: ['Kalıcı “en iyiler” listesi olsun', 'Sadece o oyunun sonucu yeter', 'Gerek yok'] },
    ],
  },
  {
    title: 'Ayrıntı', head: 'İçerik ve özel durumlar', intro: 'Son birkaç şey.',
    fields: [
      { key: 'icerik', label: 'Oyunun içeriği nereden geliyor?', type: 'textarea', max: 1500, placeholder: 'ör. Kelimeleri oyuncular bir havuza ekler. / Hazır 500 soru olsun. / Herkes resim yükler.', help: 'Kelimeler, sorular, resimler… Kim ekler, hazır mı gelir?' },
      { key: 'kenar', label: 'Şunlar olursa ne olsun?', type: 'textarea', max: 1500, placeholder: 'ör. Oyun ortasında biri çıkarsa sırası atlanır. Sonradan gelen izleyici olur.', help: 'Biri oyundan çıkarsa, geç gelirse, sırası gelip bir şey yapmazsa, hile yaparsa…' },
      { key: 'notlar', label: 'Eklemek istediğin başka bir şey', type: 'textarea', max: 2000, placeholder: 'Ses efektleri, müzik, renkler, aklına gelen her şey.' },
      { key: 'onem', label: 'Bu oyunu ne kadar istiyorsun?', type: 'choice', options: ['1', '2', '3', '4', '5'], help: '1: olsa fena olmaz · 5: çok istiyorum' },
    ],
  },
];
const ONER_REVIEW = ONER_STEPS.length; // son adım: gözden geçir ve gönder
const onerFields = (step) => step.fields.flatMap((f) => f.row || [f]);
const ONER_ALL = ONER_STEPS.flatMap(onerFields);
const ONER_STATUS = { bekliyor: 'Bekliyor', eklenecek: 'Eklenecek', eklenmeyecek: 'Eklenmeyecek', eklendi: 'Eklendi' };

let onerDraft = {};
let onerStep = 0;
let oneriler = [];
let onerSending = false;
try {
  ({ draft: onerDraft = {}, step: onerStep = 0 } = JSON.parse(localStorage.getItem('oner-draft')) || {});
} catch {}

function saveOnerDraft() {
  try { localStorage.setItem('oner-draft', JSON.stringify({ draft: onerDraft, step: onerStep })); } catch {}
}

function onerField(f) {
  const wrap = document.createElement('div');
  wrap.className = 'oner-field';
  wrap.dataset.key = f.key;
  const id = `oner-${f.key}`;
  const label = document.createElement(f.type === 'choice' ? 'span' : 'label');
  label.className = 'label';
  label.textContent = f.label;
  if (f.type !== 'choice') label.htmlFor = id;
  if (f.required) label.append(Object.assign(document.createElement('span'), { className: 'req', textContent: '*', title: 'Zorunlu' }));
  wrap.append(label);
  if (f.help) wrap.append(Object.assign(document.createElement('p'), { className: 'help muted', textContent: f.help }));

  if (f.type === 'choice') {
    const chips = document.createElement('div');
    chips.className = 'oner-chips';
    for (const opt of f.options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = opt;
      b.className = onerDraft[f.key] === opt ? 'active' : '';
      b.onclick = () => {
        onerDraft[f.key] = onerDraft[f.key] === opt ? '' : opt; // seçiliye tekrar basınca kalkar
        saveOnerDraft();
        for (const x of chips.children) x.classList.toggle('active', onerDraft[f.key] === x.textContent);
      };
      chips.append(b);
    }
    wrap.append(chips);
    return wrap;
  }
  const input = document.createElement(f.type === 'textarea' ? 'textarea' : 'input');
  input.id = id;
  input.maxLength = f.max;
  input.placeholder = f.placeholder || '';
  input.value = onerDraft[f.key] || '';
  input.autocomplete = 'off';
  if (f.type === 'textarea') input.rows = f.big ? 7 : 4;
  const counter = Object.assign(document.createElement('span'), { className: 'counter muted' });
  const count = () => {
    const n = input.value.length;
    counter.textContent = n > f.max * 0.7 ? `${n}/${f.max}` : '';
  };
  input.oninput = () => {
    onerDraft[f.key] = input.value;
    wrap.classList.remove('invalid');
    count();
    saveOnerDraft();
  };
  count();
  wrap.append(input, counter);
  return wrap;
}

function renderOnerSteps() {
  const list = $('oner-steps');
  list.replaceChildren();
  [...ONER_STEPS, { title: 'Gönder' }].forEach((step, i) => {
    const li = document.createElement('li');
    li.className = i === onerStep ? 'current' : i < onerStep ? 'done' : '';
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `<b>${i + 1}</b><span></span>`;
    b.querySelector('span').textContent = step.title;
    // İleri atlarken araya giren adımların zorunlu alanları da dolu olmalı.
    b.onclick = () => {
      if (i > onerStep && !onerValid(onerStep, i)) return;
      onerGo(i);
    };
    li.append(b);
    list.append(li);
  });
}

function renderOner() {
  renderOnerSteps();
  const box = $('oner-step');
  box.replaceChildren();
  $('oner-error').hidden = true;
  $('oner-prev').hidden = onerStep === 0;
  $('oner-next').textContent = onerStep === ONER_REVIEW ? 'Gönder' : onerStep === ONER_REVIEW - 1 ? 'Gözden geçir' : 'İleri';
  $('oner-next').disabled = onerSending;
  if (onerStep === ONER_REVIEW) {
    box.append(Object.assign(document.createElement('h3'), { textContent: 'Gözden geçir ve gönder' }));
    box.append(Object.assign(document.createElement('p'), { className: 'muted small', textContent: 'Bir şeyi değiştirmek için o bölümün "Düzenle"sine bas.' }));
    const review = document.createElement('div');
    review.className = 'oner-review';
    ONER_STEPS.forEach((step, i) => {
      const sec = document.createElement('section');
      sec.append(Object.assign(document.createElement('h4'), { textContent: step.head }));
      sec.append(onerDl(onerFields(step), onerDraft));
      const edit = Object.assign(document.createElement('button'), { type: 'button', className: 'sm ghost edit', textContent: 'Düzenle' });
      edit.onclick = () => onerGo(i);
      sec.append(edit);
      review.append(sec);
    });
    box.append(review);
    return;
  }
  const step = ONER_STEPS[onerStep];
  box.append(Object.assign(document.createElement('h3'), { textContent: `${onerStep + 1}. ${step.head}` }));
  box.append(Object.assign(document.createElement('p'), { className: 'muted small', textContent: step.intro }));
  for (const f of step.fields) {
    if (!f.row) {
      box.append(onerField(f));
      continue;
    }
    const row = document.createElement('div');
    row.className = 'oner-row';
    row.append(...f.row.map(onerField));
    box.append(row);
  }
}

// Doldurulan alanların listesi (boşlar "—")
function onerDl(fields, values) {
  const dl = document.createElement('dl');
  for (const f of fields) {
    dl.append(Object.assign(document.createElement('dt'), { textContent: f.label }));
    dl.append(Object.assign(document.createElement('dd'), { textContent: values[f.key]?.trim() || '—' }));
  }
  return dl;
}

// from..to-1 arasındaki adımların zorunlu alanları dolu mu? Değilse ilk eksik adıma gider ve gösterir.
function onerValid(from, to = from + 1) {
  for (let i = from; i < Math.min(to, ONER_REVIEW); i++) {
    const missing = onerFields(ONER_STEPS[i]).filter((f) => f.required && !onerDraft[f.key]?.trim());
    if (!missing.length) continue;
    if (i !== onerStep) onerGo(i);
    for (const f of missing) document.querySelector(`.oner-field[data-key="${f.key}"]`)?.classList.add('invalid');
    $('oner-error').textContent = `Şunları doldurman gerekiyor: ${missing.map((f) => f.label).join(', ')}`;
    $('oner-error').hidden = false;
    document.querySelector('.oner-field.invalid input, .oner-field.invalid textarea')?.focus();
    return false;
  }
  return true;
}

function onerGo(i) {
  onerStep = i;
  saveOnerDraft();
  renderOner();
  $('oner-steps').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

$('oner-prev').onclick = () => onerGo(Math.max(0, onerStep - 1));

$('oner-clear').onclick = () => {
  if (!Object.values(onerDraft).some((v) => v?.trim())) return;
  if (!$('oner-clear').dataset.sure) {
    // Yanlışlıkla silinmesin: ikinci basışta siler.
    $('oner-clear').dataset.sure = '1';
    $('oner-clear').textContent = 'Emin misin? Tekrar bas';
    setTimeout(() => {
      delete $('oner-clear').dataset.sure;
      $('oner-clear').textContent = 'Taslağı temizle';
    }, 3000);
    return;
  }
  onerDraft = {};
  onerGo(0);
};

$('oner-form').onsubmit = async (e) => {
  e.preventDefault();
  if (onerStep < ONER_REVIEW) {
    if (onerValid(onerStep)) onerGo(onerStep + 1);
    return;
  }
  if (!onerValid(0, ONER_REVIEW) || onerSending) return;
  onerSending = true;
  $('oner-next').disabled = true;
  const res = await emitAck(10000, 'oneri:add', onerDraft);
  onerSending = false;
  $('oner-next').disabled = false;
  if (!res) return toast('Sunucuya ulaşılamadı, tekrar dene. Yazdıkların duruyor.');
  if (res.error) return toast(res.error);
  onerDraft = {};
  onerGo(0);
  toast('Önerin gönderildi, teşekkürler! Aşağıdaki listede görünüyor.');
};

function renderOneriler() {
  $('oner-count').textContent = oneriler.length || '';
  const list = $('oner-list');
  list.replaceChildren();
  for (const o of [...oneriler].reverse()) {
    const li = document.createElement('li');
    const det = document.createElement('details');
    det.className = 'oner-item';
    const sum = document.createElement('summary');
    sum.append(makeAvatar(o.by));
    const text = document.createElement('div');
    text.className = 'q-text';
    text.append(Object.assign(document.createElement('div'), { className: 'q-title', textContent: o.fields.ad }));
    const date = new Date(o.at).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
    text.append(Object.assign(document.createElement('div'), { className: 'muted small', textContent: `${o.by} · ${date} · ${o.fields.ozet}` }));
    sum.append(text, Object.assign(document.createElement('span'), { className: `oner-status ${o.status}`, textContent: ONER_STATUS[o.status] || o.status }));
    det.append(sum);
    const body = document.createElement('div');
    body.className = 'oner-body';
    if (o.note) body.append(Object.assign(document.createElement('p'), { className: 'oner-note', textContent: o.note }));
    for (const step of ONER_STEPS) {
      const fields = onerFields(step).filter((f) => o.fields[f.key]);
      if (!fields.length) continue;
      body.append(Object.assign(document.createElement('h4'), { textContent: step.head }), onerDl(fields, o.fields));
    }
    if (o.by === myName && o.status === 'bekliyor') {
      const del = Object.assign(document.createElement('button'), { type: 'button', className: 'sm ghost danger', textContent: 'Önerimi geri çek' });
      del.style.justifySelf = 'start';
      del.onclick = () => socket.emit('oneri:remove', o.id);
      body.append(del);
    }
    det.append(body);
    li.append(det);
    list.append(li);
  }
  if (!oneriler.length) list.append(Object.assign(document.createElement('li'), { className: 'muted small empty', textContent: 'Henüz öneri yok. İlk sen yaz!' }));
}

socket.on('oneriler', (list) => {
  oneriler = list;
  renderOneriler();
});

renderOner();

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
  renderLobby('dino');
  $('dino-help').innerHTML = '<b>W</b> / <b>↑</b> / boşluk: zıpla · <b>S</b> / <b>↓</b>: eğil (havadayken hızlı iner). '
    + 'Hız otomatik ve gitgide artar; herkes kusursuz koşan Jef\'in arkasında koşar. Engele çarpan ölür, en uzağa giden kazanır. '
    + 'Gökten inen <b style="color:#d9822b">turuncu kuş sürüsü</b>nün altından koşarak geç; zıplarsan çarparsın.';
  let status = 'Lobi kurulup başlatılınca lobidekiler Jef\'in peşinden koşar.';
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
    ctx.fillText('Lobi kur, birlikte Jef\'in peşinden koşun', DINO.viewW / 2, 100);
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
    link.href = abs(image);
    link.target = '_blank';
    link.rel = 'noopener';
    const img = document.createElement('img');
    img.className = 'chat-img';
    img.alt = `${name} fotoğraf gönderdi`;
    img.src = abs(image);
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
  recWorkletReady ??= audioCtx.audioWorklet.addModule('/rec-worklet.js');
  await recWorkletReady;
  const worker = new Worker('/mp3-worker.js');
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
  const vol = radioPage() ? 0 : musicVolume(); // Radyo sayfasındayken radyo duyulur, YouTube kısılır
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
  await Promise.all(list.map((fx) => Sfx.addCustom(audioCtx, fx.id, `/sfx-custom/${encodeURIComponent(ROOM)}/${fx.id}`).catch(() => {})));
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
    const res = await fetch(`/search?q=${encodeURIComponent(q)}`);
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

// Tek oda var: "genel"; giriş ekranında kimlerin içeride olduğunu gösteririz.
const ROOM = 'genel';
const historyKey = () => 'history';

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
  $('nav-members').hidden = !account.admin;
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
  account = { name: res.name, avatar: res.avatar, admin: res.admin };
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

fetch('/status')
  .then((r) => r.json())
  .then(({ names, max }) => {
    $('room-status').textContent = names.length
      ? `Şu an odada (${names.length}/${max}): ${names.join(', ')}`
      : 'Oda şu an boş.';
  })
  .catch(() => {});

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
  // Yenilenen ya da linkle açılan sayfa adresteki ekranda açılır.
  applyView(history.state?.page ? history.state : pathView(location.pathname));
  history.replaceState(currentView(), '', viewPath(currentView()));
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
  setBot(Boolean(res.bot));
  oneriler = res.oneriler || [];
  renderOneriler();
  kelimePool = res.kelimePool || [];
  setKelime(res.kelime);
  setMemory(res.memory);
  setRadio(res.radio);
  lobbies = res.lobbies || {};
  renderLobbies();
  renderTiming();
  media = res.media;
  renderQueue();
  applyMedia();
}

const inviteLink = () => location.origin;

$('copy-link').onclick = async () => {
  try {
    await navigator.clipboard.writeText(inviteLink());
    toast('Davet linki kopyalandı');
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
