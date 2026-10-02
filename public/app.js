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
    state.speaking = Date.now() - lastLoud < SPEAK_HOLD;
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

function makeAvatar(name) {
  let hash = 2166136261; // FNV-1a: benzer isimler de farklı renge düşsün
  for (const ch of name) hash = Math.imul(hash ^ ch.codePointAt(0), 16777619);
  const el = document.createElement('div');
  el.className = 'avatar';
  el.textContent = [...name][0]?.toLocaleUpperCase('tr-TR') || '?';
  el.style.background = AVATAR_COLORS[(hash >>> 0) % AVATAR_COLORS.length];
  el.title = name;
  return el;
}

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

  const peer = { name, muted, pc: null, audio, gain, source: null, pendingIce: [], row, speaking: false, localMuted: false };
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
    if (s === 'connected') setStatus(peer.row, peer.muted ? 'Sessizde' : 'Bağlı');
    else if (s === 'failed') setStatus(peer.row, 'Bağlanamadı (ağ engeli)');
    else if (s === 'disconnected') setStatus(peer.row, 'Bağlantı koptu…');
  };

  return pc;
}

async function flushIce(peer) {
  for (const c of peer.pendingIce.splice(0)) {
    await peer.pc.addIceCandidate(c).catch(() => {});
  }
}

socket.on('signal', async ({ from, data }) => {
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

// Sunucu bağlantısı koparsa odaya yeniden girmek en temiz çözüm.
socket.on('disconnect', (reason) => {
  if (reason === 'io server disconnect') toast('Bu oda başka bir sekmede açıldı.');
  else toast('Sunucu bağlantısı koptu, yeniden bağlanılıyor…');
});
socket.io.on('reconnect', () => location.reload());

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
    li.prepend(thumb(h.videoId));
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
    if (!ids.includes(h.videoId)) ids.push(h.videoId);
    if (ids.length === PLAYLIST_LIMIT) break;
  }
  ids.reverse();
  window.open(`https://www.youtube.com/watch_videos?video_ids=${ids.join(',')}`, '_blank', 'noopener');
};

function showTab(name) {
  $('tab-queue').classList.toggle('active', name === 'queue');
  $('tab-history').classList.toggle('active', name === 'history');
  $('queue-view').hidden = name !== 'queue';
  $('history-view').hidden = name !== 'history';
}
$('tab-queue').onclick = () => showTab('queue');
$('tab-history').onclick = () => showTab('history');

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

  // Mesajda YouTube linki varsa tek tıkla sıraya eklenebilsin.
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

async function compressImage(file) {
  if (file.type === 'image/gif' && file.size <= GIF_MAX_BYTES) return { blob: file, type: 'image/gif' };
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
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
  if (!msg.system && msg.from !== selfId && audioCtx) Sfx.ping(audioCtx, sfxBus);
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
          if (e.data === YT.PlayerState.PLAYING) stalled = 0;
          updatePoster();
          trackBuffering(e.data === YT.PlayerState.BUFFERING);
        },
        // 100: video yok/özel, 101 ve 150: sahibi YouTube dışında oynatmayı kapatmış.
        onError: () => {
          if (media?.current) socket.emit('media:error', media.current.videoId);
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
  $('now-title').textContent = cur ? cur.title : 'Şu an bir şey çalmıyor';
  $('now-title').classList.toggle('muted', !cur);
  $('now-by').textContent = cur ? `${cur.by} ekledi` : '';
  setIcon($('play-toggle'), media.playing ? 'pause' : 'play');

  if (!cur) {
    if (loadedId) player.stopVideo();
    loadedId = null;
    updatePoster();
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
function thumb(videoId) {
  const img = document.createElement('img');
  img.className = 'thumb';
  img.loading = 'lazy';
  img.alt = '';
  img.src = `https://i.ytimg.com/vi/${videoId}/default.jpg`;
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
    li.prepend(thumb(item.videoId));
    li.querySelector('.q-title').textContent = item.title;
    li.querySelector('.small').textContent = `${item.by} ekledi`;
    fillReactions(li.querySelector('.reactions'), item);
    li.querySelector('[data-act=play]').onclick = () => socket.emit('media:playNow', i);
    li.querySelector('[data-act=remove]').onclick = () => socket.emit('media:remove', i);
    list.append(li);
  });
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
  const state = playerReady ? player.getPlayerState() : null;
  const notStarted = state === YT.PlayerState.UNSTARTED || state === YT.PlayerState.CUED;
  const blocked = media?.playing && stalled >= 3;
  const show = Boolean(cur) && (media.playing ? blocked : notStarted);
  $('poster').hidden = !show;
  if (!show) return;
  const src = `https://i.ytimg.com/vi/${cur.videoId}/mqdefault.jpg`;
  if ($('poster-img').src !== src) $('poster-img').src = src;
  setIcon($('poster-play'), 'play', media.playing ? 'Senkronize başlatmak için tıkla' : 'Oynat');
}

$('poster-play').onclick = () => {
  if (media.playing) {
    seekPlayer(expectedPosition());
    player.playVideo();
  } else {
    socket.emit('media:play', media.position);
  }
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
  if (!searchEnabled) return toast('Geçerli bir YouTube linki değil.');
  searchYouTube(value);
};

// Sunucuda API anahtarı yoksa kutu sadece link kabul eder.
let searchEnabled = false;

function setSearchEnabled(on) {
  searchEnabled = on;
  $('yt-url').placeholder = on ? 'Şarkı ara ya da YouTube linki yapıştır…' : 'YouTube linki yapıştır…';
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

try {
  $('name').value = localStorage.getItem('name') || '';
} catch {}

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
  const name = $('name').value.trim();
  myName = name;
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
    $('gate-btn').hidden = true;
  }
  if (localStream) await setupMic();

  const config = await fetch('/config').then((r) => r.json());
  iceServers = config.iceServers;
  setSearchEnabled(config.search);
  socket.connect();
  const res = await new Promise((r) => socket.emit('join', { room: ROOM, name, clientId }, r));

  if (res.error) {
    socket.disconnect();
    localStream?.getTracks().forEach((t) => t.stop());
    $('join-error').textContent = res.error;
    $('join-error').hidden = false;
    btn.disabled = false;
    return;
  }

  selfId = res.id;
  $('join-screen').hidden = true;
  $('room-screen').hidden = false;
  if (secret) {
    document.title = `Gizli oda · ${document.title}`;
    toast('Gizli odadasın; sadece linki bilenler girebilir');
  }

  const selfRow = personRow(name, true);
  setStatus(selfRow, localStream ? 'Sen' : 'Sadece dinleyici');
  if (gateNode) watchLevel(gateNode, selfRow, {});
  else if (localStream) watchLevel(audioCtx.createMediaStreamSource(localStream), selfRow, {});
  renderMic();
  renderPeopleCount();
  startUsageMeter();

  // Bağlantıları hemen kur: odadakiler de bize teklif gönderiyor, gecikirsek kaybolur.
  for (const p of res.peers) {
    addPeer(p.id, p.name, p.muted).recording = p.recording;
    createPc(p.id);
  }
  sharerId = res.sharer;
  renderRecBanner();
  res.chat.forEach(renderChatMessage);
  mergeHistory([...loadLocalHistory(), ...res.history]);
  setCustomSfx(res.customSfx);

  await Promise.all([syncClock(), createPlayer()]);

  media ||= res.media;
  renderQueue();
  applyMedia();
};

const inviteLink = () => (secret ? `${location.origin}/#gizli=${encodeURIComponent(secret)}` : location.origin);

$('copy-link').onclick = async () => {
  try {
    await navigator.clipboard.writeText(inviteLink());
    toast(secret ? 'Gizli oda linki kopyalandı' : 'Davet linki kopyalandı');
  } catch {
    toast(inviteLink());
  }
};

$('leave').onclick = () => {
  location.reload();
};

// Sekme kapanınca/yenilenince sunucuya hemen haber ver.
addEventListener('pagehide', () => socket.disconnect());
