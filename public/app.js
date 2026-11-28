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
let micSource = null;          // mikrofonu ses eşiğine bağlayan düğüm (cihaz değişince yenilenir)
let screenStream = null;      // kendi ekran paylaşımımız
let sharerId = null;          // odada ekranını paylaşan kişi
let micOn = true;
let screenAudioHeld = false;   // susturma ekran paylaşımının sesini kapattı; kişi mikrofonunu açınca geri açılır
let modMuted = null;           // oda sahibi ya da yönetici beni susturdu: 'owner' | 'admin' (mikrofon kilitli)
let myName = '';
let selfId = null;
let roomEpoch = null;          // sunucunun bu girişe verdiği dönem (taşınınca artar); bağlantılar sinyale ekler
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

// İkonlar temanın ikon setinden gelir (index.html <svg id="ui-icons">, theme.js).
// Ad işaretlemenin içine yazıldığı için yalnız küçük harf, rakam ve tire kabul edilir.
function icon(name) {
  if (typeof name !== 'string' || !/^[a-z0-9-]+$/.test(name)) throw new Error(`Geçersiz ikon adı: ${name}`);
  return `<svg class="ic" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

// Düğmenin içeriğini ikon (+ isteğe bağlı yazı) yapar.
function setIcon(el, name, text) {
  el.innerHTML = icon(name);
  if (text) el.append(text);
}

// Var olan içeriğin önüne ikon koyar; öğeyi döndürür.
function withIcon(el, name) {
  el.insertAdjacentHTML('afterbegin', icon(name));
  return el;
}

// Cevap gelmezse sonsuza kadar beklenmez: süre dolunca null döner.
function emitAck(ms, event, ...args) {
  return new Promise((resolve) => socket.timeout(ms).emit(event, ...args, (err, res) => resolve(err ? null : res)));
}

// kind: 'danger' (bağlantı koptu, yayın açılmadı) ya da 'live' (geri geldi) başa ikon koyar; yoksa düz bildirim.
const TOAST_ICONS = { danger: 'alert', live: 'check' };
function toast(text, kind) {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  if (TOAST_ICONS[kind]) {
    el.classList.add(`toast-${kind}`);
    el.innerHTML = icon(TOAST_ICONS[kind]);
    el.append(Object.assign(document.createElement('span'), { textContent: text }));
  } else el.textContent = text;
  box.append(el);
  // Kutu üst katmanda (popover) durur; sonradan açılmış bir pencere varsa onun da üstüne çıksın diye yeniden açılır.
  if (box.showPopover) {
    const open = box.matches(':popover-open');
    if (open && document.querySelector('dialog[open]')) box.hidePopover();
    if (!open || !box.matches(':popover-open')) box.showPopover();
  }
  setTimeout(() => {
    el.remove();
    if (!box.children.length && box.hidePopover && box.matches(':popover-open')) box.hidePopover();
  }, 4000);
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
  // Bluetooth kulaklık takılıp çıkınca tarayıcı ses altyapısını durdurabilir; hemen sürdür.
  audioCtx.onstatechange = () => audioCtx.state !== 'closed' && wake();
}

// ---------- Konuşma göstergesi ----------

const SPEAK_THRESHOLD = 12;
const SPEAK_HOLD = 350; // ms; kelime aralarında gösterge titremesin
const SPEAK_HOLD_HIDDEN = 1600; // ms; gizli sekmede (seyrek ölçüm)

// Bütün göstergeler tek zamanlayıcıyla ölçülür (20 kişilik birleşik odada 20 ayrı zamanlayıcı yerine biri).
// Sekme görünmezken de ölçülür ("konuşurken müziği kıs" peer.speaking'i okur, YouTube arka planda çalar); yalnız
// halkaların DOM'u yazılmaz, sekme dönünce ilk ölçümde düzelir. Tarayıcı gizli sekmede zamanlayıcıyı zaten seyreltir.
const levelMeters = new Set();
let levelTimer = 0;
function watchLevel(source, row, state) {
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  for (const m of levelMeters) if (m.state === state) levelMeters.delete(m); // bağlantı yenilenince eski ölçer düşer
  levelMeters.add({ analyser, data: new Uint8Array(analyser.fftSize), row, state, lastLoud: 0 });
  levelTimer ||= setInterval(tickLevels, 100);
}
function tickLevels() {
  const hidden = document.hidden;
  for (const m of levelMeters) {
    if (!m.row.isConnected) {
      levelMeters.delete(m);
      continue;
    }
    m.analyser.getByteTimeDomainData(m.data);
    let peak = 0;
    for (const v of m.data) peak = Math.max(peak, Math.abs(v - 128));
    if (peak > SPEAK_THRESHOLD) m.lastLoud = Date.now();
    // Gizli sekmede zamanlayıcı ~1 sn'de bir çalışır: konuşma arada kaçmasın diye bekleme uzar.
    const speaking = !m.state.silenced?.() && Date.now() - m.lastLoud < (hidden ? SPEAK_HOLD_HIDDEN : SPEAK_HOLD);
    m.state.speaking = speaking;
    if (hidden || m.row.classList.contains('speaking') === speaking) continue; // DOM'a yalnız görünürken ve değişince
    m.row.classList.toggle('speaking', speaking);
    m.row.mini?.classList.toggle('speaking', speaking);
  }
  if (!levelMeters.size) {
    clearInterval(levelTimer);
    levelTimer = 0;
  }
}

// ---------- Katılımcı listesi ----------

// Birleşik odada sınır iki katı (her odadan en fazla 10).
// Site yöneticisi doluluğa sayılmaz (dolu odaya da girer): sayaç onu saymaz.
function renderPeopleCount() {
  const max = curRoom?.max || 10;
  const n = [...peers.values()].filter((p) => !p.admin).length + (account?.admin ? 0 : 1);
  $('people-count').textContent = `${n}/${curRoom?.mergedWith ? 2 * max : max}`;
}

// İsimden sabit bir renk: herkes her yerde (liste, sohbet) aynı renkte görünür.
// Her ton beyaz baş harfle (--avatar-text) en az 4,5:1 kontrast verir; açık tonlar bu yüzden biraz koyu.
const AVATAR_COLORS = ['#c2413b', '#a96522', '#897417', '#368544', '#1b8477', '#2d7ab9', '#5b5fd6', '#8f4fc9', '#c2448f', '#6b7280'];

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
    img.onerror = () => img.isConnected && img.parentNode === el && avatarInitial(el, name); // resim gelmezse baş harf
    el.append(img);
    return;
  }
  avatarInitial(el, name);
}

function avatarInitial(el, name) {
  el.textContent = [...name][0]?.toLocaleUpperCase('tr-TR') || '?';
  el.style.background = avatarColor(name);
}

function avatarHash(name) {
  let hash = 2166136261; // FNV-1a: benzer isimler de farklı renge düşsün
  for (const ch of name) hash = Math.imul(hash ^ ch.codePointAt(0), 16777619);
  return (hash >>> 0) % AVATAR_COLORS.length;
}
// Oda içindeki renk sunucudan gelir (colors.js: odadakilerle çakışmaz, herkes aynısını görür, odada kaldıkça
// değişmez; 10 kişide hepsi ayrı, birleşik odada 20 kişide her renk en çok iki). Bu sekmenin odadaki kişileri
// (kişi sırası, Odadakiler, lobiler, oyun listeleri, sohbetteki avatarları) bu rengi kullanır; odada olmayan isim
// (oda listesi, ayrılmış kişinin eski sohbet satırları sonradan çizilirse) isimden gelen karma rengindedir.
const roomColors = new Map(); // isim -> renk sırası
function avatarColor(name) {
  return AVATAR_COLORS[roomColors.get(name) ?? avatarHash(name)];
}
function setRoomColor(name, index) {
  const before = roomColors.get(name);
  if (Number.isInteger(index) && index >= 0 && index < AVATAR_COLORS.length) roomColors.set(name, index);
  else roomColors.delete(name);
  if (roomColors.get(name) === before) return;
  for (const el of document.querySelectorAll('.avatar')) if (el.dataset.name === name) fillAvatar(el);
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
  li.dataset.name = name;
  $('people').append(li);
  // Oynatıcının altındaki kişi sırası: avatar, ad, konuşma halkası, sessiz ve kayıt rozetleri.
  // Basınca Odadakiler açılır ve bu kişinin satırı (ses ayarı) öne gelir.
  li.mini = document.createElement('button');
  li.mini.type = 'button';
  li.mini.className = 'person' + (isSelf ? ' is-self' : '');
  li.mini.setAttribute('popovertarget', 'people-pop');
  li.mini.innerHTML = `
    <span class="person-face"><span class="person-rec" title="Kayıt yapıyor"></span><span class="person-mic" title="Sessizde">${icon('mic-off')}</span><span class="person-mod" title="Susturuldu">${icon('volume-x')}</span></span>
    <span class="person-label"><span class="person-name"></span>${isSelf ? '<span class="person-you">sen</span>' : ''}</span>
    <span class="person-tag">susturuldu</span>`;
  li.mini.querySelector('.person-face').prepend(makeAvatar(name));
  li.mini.querySelector('.person-name').textContent = name;
  li.mini.title = isSelf ? `${name} (sen)` : `${name}: ses ayarı`;
  li.mini.setAttribute('aria-label', li.mini.title);
  li.mini.onclick = () => focusPerson(li);
  $('avatar-strip').append(li.mini);
  if (isSelf) selfRow = li;
  return li;
}

let selfRow = null;

// Kişi sırasındaki rozetler: sessizde (üstü çizili mikrofon) ve kayıt (kırmızı nokta).
// Moderatör susturması (modMuted 'owner' | 'admin') kendi sessizinden ayrı görünür: hoparlör işareti ve "susturuldu".
const MOD_BY = { owner: 'Oda sahibi susturdu', admin: 'Yönetici susturdu' };
function renderPersonState(row, { muted, recording, modMuted: mod }) {
  if (!row?.mini) return;
  if (muted !== undefined) row.mini.classList.toggle('is-muted', Boolean(muted));
  if (recording !== undefined) row.mini.classList.toggle('is-rec', Boolean(recording));
  if (mod !== undefined) {
    row.mini.classList.toggle('is-modmuted', Boolean(mod));
    row.classList.toggle('is-modmuted', Boolean(mod));
    const name = row.dataset.name;
    const base = row.mini.classList.contains('is-self') ? `${name} (sen)` : `${name}: ses ayarı`;
    row.mini.title = mod ? `${name}: ${MOD_BY[mod] || 'susturuldu'}` : base;
    row.mini.setAttribute('aria-label', mod ? `${row.mini.title}` : base);
  }
}

// Avatara basınca açılan Odadakiler penceresinde o kişinin satırı görünür ve kısa süre vurgulanır.
function focusPerson(row) {
  requestAnimationFrame(() => {
    row.scrollIntoView({ block: 'nearest' });
    row.classList.remove('is-focus');
    void row.offsetWidth;
    row.classList.add('is-focus');
  });
}

function setStatus(row, text) {
  row.querySelector('.p-status').textContent = text;
}

// info: { muted, modMuted, home, admin } (join cevabındaki peers satırı ya da user-joined)
function addPeer(id, name, info = {}) {
  if (peers.has(id)) return peers.get(id);
  const { muted = false } = info;
  setRoomColor(name, info.color);
  const row = personRow(name, false);
  const vol = document.createElement('input');
  vol.type = 'range';
  vol.min = 0;
  vol.max = 100;
  vol.value = 100;
  vol.className = 'p-vol range';
  vol.title = `${name} ses seviyesi`;
  row.querySelector('.p-info').append(vol);
  paintRange(vol);

  // Chrome, uzaktan gelen sesi Web Audio'ya ancak bir medya öğesine bağlıyken verir;
  // öğe sessiz çalar, asıl ses kompresörden çıkar.
  const audio = new Audio();
  audio.muted = true;
  const gain = audioCtx.createGain();
  gain.connect(voiceBus);

  const peer = {
    name, muted, pc: null, audio, gain, source: null, pendingIce: [], row, speaking: false, localMuted: false, badSince: null, retries: 0,
    modMuted: info.modMuted || null, home: info.home || null, admin: Boolean(info.admin),
  };
  // Susturulan kişinin sesi (karşıdan ne gelirse gelsin) çalınmaz; ekran paylaşımının sesi de.
  const applyGain = () => {
    const off = peer.localMuted || Boolean(peer.modMuted);
    gain.gain.value = off ? 0 : vol.value / 100;
    audio.volume = off ? 0 : vol.value / 100; // medya öğesinden çalarken
    if (peer.screenAudio) peer.screenAudio.muted = Boolean(peer.modMuted);
  };
  peer.silenced = () => Boolean(peer.modMuted); // konuşma halkası yanmaz
  peer.applyGain = applyGain;
  vol.oninput = applyGain;

  // Kişiyi sadece kendin için susturma (karşı taraf bunu görmez).
  const muteBtn = document.createElement('button');
  muteBtn.className = 'icon p-mute';
  row.append(muteBtn);
  const renderMute = () => {
    setIcon(muteBtn, peer.localMuted ? 'volume-x' : 'volume');
    muteBtn.title = peer.localMuted ? `${name} sesini aç` : `${name} sesini kapat`;
    muteBtn.classList.toggle('off', peer.localMuted);
    // Susturulmuş kişinin sesi zaten çalınmaz: ses ayarı ve kendin için kapatma düğmesi o sürece kapalı
    vol.disabled = peer.localMuted || Boolean(peer.modMuted);
    muteBtn.disabled = Boolean(peer.modMuted);
    if (peer.modMuted) muteBtn.title = vol.title = `${name} susturuldu; sesi kimseye gitmiyor`;
    else vol.title = `${name} ses seviyesi`;
  };
  peer.renderMute = () => renderMute();
  muteBtn.onclick = () => {
    peer.localMuted = !peer.localMuted;
    applyGain();
    renderMute();
  };
  renderMute();

  // Sustur / Susturmayı kaldır: yalnız yetkisi olana görünür (sunucu yine denetler). Sustur, satırdaki "Yönet"
  // (üç nokta) düğmesinin açtığı satırdadır: kalabalık listede yanlışlıkla dokunup birini susturmak olmasın.
  // Susturulmuş kişide "Susturmayı kaldır" doğrudan görünür (zararsız eylem).
  const moreBtn = document.createElement('button');
  moreBtn.type = 'button';
  moreBtn.className = 'icon p-more';
  moreBtn.innerHTML = icon('more');
  moreBtn.title = `${name}: yönet`;
  moreBtn.setAttribute('aria-label', `${name}: yönet`);
  moreBtn.setAttribute('aria-expanded', 'false');
  row.append(moreBtn);
  const modRow = document.createElement('div');
  modRow.className = 'p-modrow';
  modRow.hidden = true;
  const modBtn = document.createElement('button');
  modBtn.type = 'button';
  modBtn.className = 'btn btn-sm p-mod';
  modRow.append(modBtn);
  row.querySelector('.p-info').append(modRow);
  let open = false;
  peer.renderMod = () => {
    const can = canModerate(peer);
    moreBtn.hidden = !can || Boolean(peer.modMuted);
    if (!can) open = false;
    const show = can && (open || Boolean(peer.modMuted));
    modRow.hidden = !show;
    moreBtn.setAttribute('aria-expanded', String(show));
    if (!show) return;
    setIcon(modBtn, peer.modMuted ? 'mic' : 'mic-off', peer.modMuted ? 'Susturmayı kaldır' : `${name} kişisini sustur`);
    modBtn.classList.toggle('btn-danger', !peer.modMuted);
    modBtn.classList.toggle('btn-ghost', Boolean(peer.modMuted));
    modBtn.setAttribute('aria-label', `${name}: ${peer.modMuted ? 'susturmayı kaldır' : 'sustur'}`);
  };
  moreBtn.setAttribute('aria-controls', (modRow.id = `p-modrow-${id}`));
  moreBtn.onclick = () => {
    open = !open;
    peer.renderMod();
    if (open) modBtn.focus();
  };
  modBtn.onclick = async () => {
    const wasMuted = Boolean(peer.modMuted);
    modBtn.disabled = true;
    const res = (await emitAck(8000, 'mod:mute', { id, muted: !peer.modMuted })) ?? { error: 'Sunucuya ulaşılamadı.' };
    modBtn.disabled = false;
    if (res.error) toast(res.error);
    const lifted = !res.error && wasMuted;
    open = false; // susturunca satır kapanır; kaldırma düğmesi kendiliğinden görünür
    peer.renderMod();
    // Kaldırınca satır kapanır: odak aynı satırın Yönet düğmesine (görünmüyorsa satırın düğmesine) geçer.
    if (lifted || document.activeElement === document.body) (moreBtn.hidden ? muteBtn : moreBtn).focus();
  };

  peers.set(id, peer);
  setStatus(row, peer.modMuted ? MOD_BY[peer.modMuted] : muted ? 'Sessizde' : 'Bağlanıyor…');
  renderPersonState(row, { muted, modMuted: peer.modMuted });
  peer.renderMod();
  applyGain();
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
  if (![...peers.values()].some((p) => p.name === peer.name)) setRoomColor(peer.name, null);
  renderPeopleCount();
}

// ---------- WebRTC (sesli sohbet) ----------
// Her kişi diğer herkese doğrudan bağlanır: 10 kişilik odada 9, birleşik odada (10 + 10) 19 bağlantı.
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

// epoch: bağlantının kurulduğu giriş (peer.epoch); taşınmadan sonra eski bağlantının sinyallerini sunucu düşürür.
function sendDescription(to, desc, epoch) {
  socket.emit('signal', { to, data: { type: desc.type, sdp: tuneOpus(desc.sdp) }, epoch });
}

// Gönderilen ses ve görüntüye bitrate sınırı koyar (sınırlar anlaşmadan sonra uygulanabilir).
function applyLimits(pc) {
  for (const sender of pc.getSenders()) {
    if (!sender.track) continue;
    const params = sender.getParameters();
    if (!params.encodings?.length) continue;
    params.encodings[0].maxBitrate = sender.track.kind === 'video' ? screenBitrate() : VOICE_BITRATE;
    // Anlaşma sürerken reddedilebilir: bağlantı yeniden kararlı olunca bir kez daha denenir.
    sender.setParameters(params).catch(() => retryLimits(pc));
  }
}
function retryLimits(pc) {
  if (pc.limitsRetry || pc.signalingState === 'closed') return;
  pc.limitsRetry = true;
  const again = () => {
    if (pc.signalingState !== 'stable') return;
    pc.removeEventListener('signalingstatechange', again);
    pc.limitsRetry = false;
    for (const sender of pc.getSenders()) {
      if (!sender.track) continue;
      const params = sender.getParameters();
      if (!params.encodings?.length) continue;
      params.encodings[0].maxBitrate = sender.track.kind === 'video' ? screenBitrate() : VOICE_BITRATE;
      sender.setParameters(params).catch(() => {}); // ikinci ret: bir sonraki anlaşmada applyLimits yine dener
    }
  };
  if (pc.signalingState === 'stable') queueMicrotask(again);
  else pc.addEventListener('signalingstatechange', again);
}

// Paylaşan görüntüyü her kişiye ayrı gönderir: kişi başı 1 Mbps, ama toplam yükleme SCREEN_UPLOAD'u geçmesin
// (10 kişide kişi başı ~670 kbps, 20 kişide ~315 kbps). Kişi gelip gidince bütün bağlantılarda yeniden ayarlanır.
const SCREEN_UPLOAD = 6000000; // bps
const screenBitrate = () => Math.max(250000, Math.min(SCREEN_BITRATE, Math.floor(SCREEN_UPLOAD / Math.max(1, peers.size))));
function retuneScreen() {
  if (!screenStream) return;
  for (const peer of peers.values()) if (peer.pc) applyLimits(peer.pc);
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
  peer.epoch = roomEpoch;
  peer.createdAt = Date.now();
  peer.polite = selfId < id;
  peer.makingOffer = false;
  peer.badSince = Date.now();
  const { epoch } = peer;

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
      if (peer.pc !== pc) return; // bu arada bağlantı yenilendi
      sendDescription(id, pc.localDescription, epoch);
      applyLimits(pc);
    } catch (err) {
      console.warn('negotiation', err);
    } finally {
      peer.makingOffer = false;
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate && peer.pc === pc) socket.emit('signal', { to: id, data: { candidate: e.candidate }, epoch });
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
      peer.screenAudio.muted = Boolean(peer.modMuted);
      peer.screenAudio.srcObject = new MediaStream([e.track]);
      peer.screenAudio.play().catch(() => {});
      return;
    }
    peer.audio.srcObject = stream;
    peer.source?.disconnect();
    peer.source = null;
    try {
      peer.source = audioCtx.createMediaStreamSource(stream);
      peer.source.connect(peer.gain);
      watchLevel(peer.source, peer.row, peer);
      peer.audio.muted = true;
    } catch (err) {
      // Bazı tarayıcılar (ör. Firefox, Bluetooth kulaklıkta örnekleme hızı farklıyken) sesi
      // Web Audio'ya vermez; o zaman ses doğrudan medya öğesinden çalar.
      console.warn('ses Web Audio üzerinden çalınamıyor, doğrudan çalınıyor', err);
      peer.audio.muted = false;
      peer.applyGain();
    }
    peer.audio.play().catch(() => {});
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected') {
      setStatus(peer.row, peerStatus(peer));
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
  if (notify) socket.emit('signal', { to: id, data: { reset: true }, epoch: peer.epoch });
  createPc(id);
  setStatus(peer.row, 'Yeniden bağlanıyor…');
  renderScreen();
}

// Takılan bağlantılar (yarıda kalan kurulum, kopan ağ) sayfa yenilenmeden onarılır.
// Kaba taraf önce dener; o denemezse (sekmesi arka planda vb.) kibar taraf daha geç dener.
// Her başarısız denemede bekleme ikiye katlanır.
const PEER_RETRY = 12000; // ms
// Kurulumu hiç başlamamış ('new' kalan) bağlantı ilk seferde erken yenilenir (kaba taraf önce).
const PEER_STUCK_NEW = 5000; // ms
setInterval(() => {
  for (const [id, peer] of peers) {
    if (!peer.pc || peer.badSince == null) continue;
    const stuck = !peer.retries && peer.pc.connectionState === 'new'
      && Date.now() - peer.createdAt >= PEER_STUCK_NEW * (peer.polite ? 1.6 : 1);
    if (stuck) {
      peer.retries++;
      resetPeer(id, true);
      continue;
    }
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
  // Her await'ten sonra: bağlantı bu arada yenilendiyse (taşınma, sıfırlama) eski işe devam edilmez.
  const current = () => peers.get(from) === peer && peer.pc === pc;

  try {
    if (data.type) {
      const collision = data.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
      if (collision && !peer.polite) return;
      await pc.setRemoteDescription(data);
      if (!current()) return;
      if (data.type === 'offer') {
        await pc.setLocalDescription();
        if (!current()) return;
        sendDescription(from, pc.localDescription, peer.epoch);
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

socket.on('user-joined', ({ id, name, ...info }) => {
  addPeer(id, name, info);
  createPc(id);
  retuneScreen();
  renderRecBanner();
});

socket.on('user-left', (id) => {
  removePeer(id);
  retuneScreen();
  renderRecBanner();
});

const peerStatus = (peer) => (peer.modMuted ? MOD_BY[peer.modMuted] : peer.muted ? 'Sessizde' : 'Bağlı');

socket.on('user-muted', ({ id, muted }) => {
  const peer = peers.get(id);
  if (!peer) return;
  peer.muted = muted;
  setStatus(peer.row, peerStatus(peer));
  renderPersonState(peer.row, { muted });
});

// ---------- Susturma (oda sahibi ve yönetici) ----------
// Kim kimi susturabilir (sunucudaki mutes.check'in aynısı; düğme yalnız yetkisi olana görünür):
// yönetici herkesi; oda sahibi kendi odası kökenli herkesi (yönetici hariç; yöneticinin susturmasına dokunamaz).
const roomRoles = new Map(); // oda id -> bu hesabın rolü (join cevabı ve GET /rooms'tan)
function canModerate(peer) {
  if (!account) return false;
  if (account.admin) return true;
  if (peer.admin || peer.modMuted === 'admin') return false;
  return roomRoles.get(peer.home) === 'owner';
}
function renderModButtons() {
  for (const peer of peers.values()) peer.renderMod?.();
}

// Beni susturdular / susturmam kalktı: mikrofon kapanır ve kilitlenir; kalkınca kendim açana kadar kapalı kalır.
function setModMuted(by) {
  const was = modMuted;
  modMuted = by || null;
  if (modMuted) {
    micOn = false;
    sendStream?.getAudioTracks().forEach((t) => (t.enabled = false));
  }
  // Ekran paylaşımının sesi de gitmesin (görüntü sürer). Susturma kalkınca kendiliğinden açılmaz: kişi
  // mikrofonunu açınca (ayrı bir paylaşım sesi düğmesi yok) ya da paylaşımı yeniden başlatınca açılır.
  if (modMuted && screenStream?.getAudioTracks().some((t) => t.enabled)) {
    screenStream.getAudioTracks().forEach((t) => (t.enabled = false));
    screenAudioHeld = true;
  }
  renderMic();
  renderSfxLock();
  renderPersonState(selfRow, { modMuted });
  if (selfRow) setStatus(selfRow, modMuted ? MOD_BY[modMuted] : localStream ? 'Sen' : 'Sadece dinleyici');
  return was;
}

socket.on('user-modmuted', ({ id, muted, by } = {}) => {
  if (id === selfId) {
    const was = setModMuted(muted ? by : null);
    if (muted && !was) toast(by === 'admin' ? 'Yönetici seni susturdu. Mikrofonun kapalı.' : 'Oda sahibi seni susturdu. Mikrofonun kapalı.', 'danger');
    else if (!muted && was) {
      // Mikrofonu olmayan dinleyicide mikrofon düğmesi yok: paylaşımın sesi ancak yeni paylaşımla gelir.
      const held = screenAudioHeld && screenStream;
      toast(!held ? 'Susturman kaldırıldı; istersen mikrofonunu açabilirsin.'
        : sendStream ? 'Susturman kaldırıldı; mikrofonunu açınca ekran paylaşımının sesi de açılır.'
          : 'Susturman kaldırıldı; ekran paylaşımının sesi için paylaşımı durdurup yeniden başlat.', 'live');
    }
    return;
  }
  const peer = peers.get(id);
  if (!peer) return;
  peer.modMuted = muted ? by : null;
  peer.applyGain();
  peer.renderMute();
  setStatus(peer.row, peerStatus(peer));
  renderPersonState(peer.row, { modMuted: peer.modMuted });
  peer.renderMod();
});

socket.on('notice', toast);

socket.on('disconnect', (reason) => {
  if (reason === 'io client disconnect') return; // kendimiz çıktık
  if (reason === 'io server disconnect') toast('Bu hesapla başka bir sekmeden ya da cihazdan odaya girildi.');
  else toast('Sunucu bağlantısı koptu, yeniden bağlanılıyor…', 'danger');
});

// Sunucu bağlantısı geri gelince odaya sayfa yenilenmeden yeniden girilir. Sunucu aynı
// sekmeyi (clientId) tanır: "ayrıldı/katıldı" mesajı çıkmaz.
// Odada değilken (oda listesinde) yeni bağlantı hello ile yeniden hesaba bağlanır.
let rejoining = false;
async function rejoin() {
  if (!selfId) return account && !$('lobby-screen').hidden && helloLobby(); // henüz odaya girilmemişti
  if (rejoining) return;
  rejoining = true;
  // Kendi odasına (home) girilir; birleşikse sunucu misafiri ev sahibi odaya yerleştirir.
  const res = await emitAck(15000, 'join', { room: homeId, token: authToken, clientId });
  rejoining = false;
  if (!res) {
    if (socket.connected) setTimeout(rejoin, 2000);
    return;
  }
  // Oda kapanmış, şifresi değişmiş ya da oturum düşmüş: listeye dönülür, kendiliğinden yeniden girilmez.
  if (res.auth) saveToken('');
  if (res.gone || res.needPassword || res.auth) return backToList(res.error);
  if (res.error) return toast(`${res.error} Sayfayı yenileyip tekrar dene.`);

  // Bağlantı kopukken birleşme başlamış ya da bitmiş olabilir: soket başka odadaysa önceki oda temizlenir.
  const moved = res.room?.id !== roomId;
  if (moved) resetRoomState();
  setRoomInfo(res);
  applyJoin(res);
  if (moved) showRoomView();
  if (!micOn) socket.emit('mute', true);
  if (recorder) socket.emit('rec', true);
  if (screenStream) {
    const r = await emitAck(5000, 'screen:start');
    if (!r || r.error) stopScreen();
  }
  syncClock();
  toast('Bağlantı geri geldi', 'live');
}
socket.io.on('reconnect', rejoin);

// Odadan listeye tam yenilemeyle dönülür (ses ve bağlantılar temiz kapanır); mesaj listede bildirim olarak çıkar.
// Atılan sekme kendiliğinden yeniden girmez.
const NOTICE_KEY = 'lobbyNotice';
function backToList(notice) {
  try {
    if (notice) sessionStorage.setItem(NOTICE_KEY, notice);
    sessionStorage.removeItem(HOME_KEY);
  } catch {}
  location.assign('/');
}
socket.on('kicked', ({ reason, auth } = {}) => {
  if (auth) return sessionRevoked(reason);
  if (roomId) backToList(reason || 'Odadan çıkarıldın.');
});
// Bu sekmenin oturumu kapatıldı (şifre başka oturumdan değişti ya da çıkış yapıldı): giriş ekranına
// dönülür. Kayıtlı anahtar yalnız kapanan oturumunsa silinir (başka sekme yeni oturumla girmiş olabilir).
function sessionRevoked(reason) {
  try {
    if (localStorage.getItem('token') === authToken) localStorage.removeItem('token');
  } catch {}
  authToken = '';
  backToList(reason);
}
socket.on('room:closed', ({ name } = {}) => roomId && backToList(`${name || 'Bu'} odası kapatıldı.`));

// ---------- Mikrofon ----------

function renderMic() {
  const btn = $('mic-toggle');
  setIcon(btn, micOn ? 'mic' : 'mic-off');
  btn.title = modMuted ? `${modMuted === 'admin' ? 'Yönetici' : 'Oda sahibi'} seni susturdu; mikrofonu açamazsın` : micOn ? 'Mikrofonu kapat' : 'Mikrofonu aç';
  btn.setAttribute('aria-label', btn.title);
  btn.setAttribute('aria-pressed', String(!micOn));
  btn.setAttribute('aria-disabled', String(Boolean(modMuted)));
  btn.classList.toggle('off', !micOn);
  btn.classList.toggle('is-locked', Boolean(modMuted));
  renderPersonState(selfRow, { muted: !micOn || !localStream });
}

$('mic-toggle').onclick = () => {
  if (modMuted) return toast(`${modMuted === 'admin' ? 'Yönetici' : 'Oda sahibi'} seni susturdu; mikrofonunu açamazsın.`);
  if (!sendStream) return;
  micOn = !micOn;
  sendStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
  socket.emit('mute', !micOn);
  renderMic();
  if (micOn && screenAudioHeld) {
    screenAudioHeld = false;
    if (screenStream?.getAudioTracks().length) {
      screenStream.getAudioTracks().forEach((t) => (t.enabled = true));
      toast('Ekran paylaşımının sesi de açıldı.');
    }
  }
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
  paintRange($('gate'));
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
    micSource = audioCtx.createMediaStreamSource(localStream);
    micSource.connect(gateNode).connect(dest);
    gateNode.port.onmessage = ({ data }) => {
      $('meter-fill').style.width = `${meterPct(data.db)}%`;
      $('meter-fill').classList.toggle('open', data.open);
    };
    sendStream = dest.stream;
    renderGate();
  } catch (err) {
    console.warn('ses eşiği kullanılamıyor', err);
    gateNode = null;
    micSource = null;
    sendStream = localStream;
    $('gate-btn').hidden = true;
  }
}

const MIC_CONSTRAINTS = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
};

// Kulaklık (özellikle Bluetooth) takılıp çıkınca mikrofon eski cihazda kalır ya da kopar.
// Varsayılan mikrofonu yeniden açıp karşıya giden sese bağlar; bağlantılar kopmaz.
// Mikrofon açılamadıysa (odaya girerken ya da içerideyken koptuysa) hatanın adı; açıkken null.
// Not, nedeni söyler ve "Tekrar dene" düğmesi taşır: mikrofon odadan çıkmadan geri gelir.
let micLost = null;
function micErrorText(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Mikrofon izni kapalı; yalnız dinleyebilirsin. Tarayıcının site ayarlarından ve bilgisayarın gizlilik ayarlarından mikrofona izin ver.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Mikrofon bulunamadı; yalnız dinleyebilirsin. Bilgisayarın ses girişini kontrol et.';
    case 'NotReadableError':
    case 'AbortError':
      return 'Mikrofon açılamadı; başka bir uygulama (ör. bir arama) kullanıyor olabilir. Yalnız dinleyebilirsin.';
    default:
      return 'Mikrofona erişilemedi; yalnız dinleyebilirsin.';
  }
}
function showMicNote(err) {
  micLost = err?.name || 'Error';
  $('mic-note-text').textContent = micErrorText(err);
  // Tarayıcının kendi hata adı ve iletisi: izin sitede mi sistemde mi kapalı, buradan ayırt edilir.
  $('mic-note-code').textContent = `(${[micLost, err?.message].filter(Boolean).join(': ')})`;
  $('mic-note').hidden = false;
}
function hideMicNote() {
  micLost = null;
  $('mic-note').hidden = true;
}

// Kendi konuşma göstergemiz mikrofonu dinler; sessizdeyken karşıya ses gitmediği için yanmasın.
const selfLevel = { silenced: () => !micOn };
function watchSelfLevel() {
  try {
    if (gateNode) watchLevel(gateNode, selfRow, selfLevel);
    else if (localStream) watchLevel(audioCtx.createMediaStreamSource(localStream), selfRow, selfLevel);
  } catch (err) {
    console.warn('konuşma göstergesi kurulamadı', err); // oda yine de açılır
  }
}

// Odaya mikrofonsuz girildiyse mikrofonu sonradan açar ve kurulu bağlantılara ekler (yeniden pazarlık kendiliğinden olur).
async function addMicLate() {
  let fresh;
  try {
    fresh = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
  } catch (err) {
    console.warn('mikrofon açılamadı', err);
    showMicNote(err);
    return;
  }
  localStream = fresh;
  watchMicTrack();
  $('gate-btn').hidden = false;
  await setupMic();
  for (const track of sendStream.getAudioTracks()) {
    track.enabled = micOn;
    for (const peer of peers.values()) peer.pc?.addTrack(track, sendStream);
  }
  hideMicNote();
  $('mic-toggle').disabled = false;
  if (selfRow) setStatus(selfRow, modMuted ? MOD_BY[modMuted] : 'Sen');
  watchSelfLevel();
  renderMic();
  socket.emit('mute', !micOn);
  toast(micOn ? 'Mikrofon açıldı.' : 'Mikrofon hazır; açmak için mikrofon düğmesine bas.', 'live');
}

let micSwapping = null;
async function refreshMic() {
  if (micSwapping) return micSwapping;
  if (!localStream) {
    if (!micLost || !selfId) return;
    micSwapping = addMicLate().finally(() => (micSwapping = null));
    return micSwapping;
  }
  micSwapping = (async () => {
    let fresh;
    try {
      fresh = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    } catch (err) {
      console.warn('mikrofon yeniden açılamadı', err);
      // Eski mikrofon hâlâ çalışıyorsa sorun yok; koptuysa kişi bilsin ve yeniden deneyebilsin.
      if (localStream?.getAudioTracks()[0]?.readyState !== 'live') showMicNote(err);
      return;
    }
    const old = localStream;
    const newTrack = fresh.getAudioTracks()[0];
    const oldTrack = old.getAudioTracks()[0];
    if (oldTrack?.readyState === 'live' && oldTrack.getSettings().deviceId === newTrack.getSettings().deviceId
        && oldTrack.label === newTrack.label) {
      fresh.getTracks().forEach((t) => t.stop()); // aynı cihaz, değişen bir şey yok
      hideMicNote();
      return;
    }
    const wasLost = Boolean(micLost);
    hideMicNote();
    if (wasLost) toast('Mikrofon yeniden bağlandı.', 'live');
    localStream = fresh;
    watchMicTrack();
    let swapped = false;
    if (gateNode) {
      try {
        const src = audioCtx.createMediaStreamSource(fresh);
        micSource?.disconnect();
        src.connect(gateNode);
        micSource = src;
        swapped = true;
      } catch (err) {
        console.warn('yeni mikrofon ses eşiğine bağlanamadı, eşiksiz gönderiliyor', err);
        gateNode.port.onmessage = null;
        micSource?.disconnect();
        gateNode = null;
        micSource = null;
        $('gate-btn').hidden = true;
      }
    }
    if (!swapped) {
      sendStream = fresh;
      newTrack.enabled = micOn;
      for (const peer of peers.values()) {
        const senders = peer.pc?.getSenders() ?? [];
        const sender = senders.find((s) => s.track === oldTrack)
          ?? senders.find((s) => s.track?.kind === 'audio' && !peer.screenSenders?.includes(s));
        sender?.replaceTrack(newTrack).catch(() => {});
      }
    }
    old.getTracks().forEach((t) => t.stop());
  })().finally(() => (micSwapping = null));
  return micSwapping;
}

function watchMicTrack() {
  const track = localStream?.getAudioTracks()[0];
  if (track) track.onended = () => refreshMic();
}

$('mic-retry').onclick = async () => {
  const btn = $('mic-retry');
  btn.disabled = true;
  try {
    await audioCtx?.resume().catch(() => {});
    await refreshMic();
    // Deneme yine başarısızsa not aynı kalır; düğmenin çalıştığı anlaşılsın.
    if (micLost) toast('Mikrofon hâlâ açılamıyor.', 'danger');
  } finally {
    btn.disabled = false;
  }
};
// Arama bitip sekmeye dönülünce mikrofon kendiliğinden yeniden denenir. İzin kapalıysa denenmez:
// bazı tarayıcılar her denemede izin penceresi açar.
window.addEventListener('focus', () => {
  if (micLost && micLost !== 'NotAllowedError' && micLost !== 'SecurityError') refreshMic();
});

let deviceTimer = null;
navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  clearTimeout(deviceTimer);
  // Bluetooth cihazı birkaç adımda bağlanır; ortalık durulunca bak.
  deviceTimer = setTimeout(() => {
    audioCtx?.state === 'suspended' && audioCtx.resume().catch(() => {});
    refreshMic();
  }, 800);
});

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
  screenAudioHeld = Boolean(modMuted) && screenStream.getAudioTracks().length > 0;
  screenStream.getAudioTracks().forEach((t) => {
    t.contentHint = 'music';
    t.enabled = !modMuted; // susturulmuşken paylaşımın sesi gitmez (mikrofon açılınca açılır)
  });
  for (const peer of peers.values()) if (peer.pc) addScreenTrack(peer);
  renderScreen();

  if (!TAB_AUDIO) toast('Bu tarayıcı ekran sesini paylaşamıyor; sadece görüntü gidiyor. Ses için Chrome veya Edge kullan.');
  else if (!screenStream.getAudioTracks().length) toast('Ses paylaşılmıyor. Ses için bir sekme seçip "Sekme sesini de paylaş"ı aç.');
}

// quiet: sunucuya bildirilmez (oda değişti; eski odadaki paylaşımı sunucu zaten bitirdi).
function stopScreen({ quiet = false } = {}) {
  if (!screenStream) return;
  screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null;
  for (const peer of peers.values()) {
    peer.screenSenders?.forEach((sender) => peer.pc.removeTrack(sender));
    peer.screenSenders = null;
  }
  if (!quiet) socket.emit('screen:stop');
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
  renderShareStrip();
}

// Telefonda sahne görünmezken (Sohbet, Sıra, Oyunlar, Radyo) biri ekran paylaşıyorsa üstte ince şerit: Oda'ya dön.
function renderShareStrip() {
  const sharer = peers.get(sharerId);
  const on = PHONE.matches && Boolean(screenStream || sharer) && !stageVisible();
  $('screen-strip').hidden = !on;
  $('room-screen').classList.toggle('has-share-strip', on);
  if (on) $('screen-strip-text').textContent = screenStream ? 'Ekranını paylaşıyorsun' : `${sharer.name} ekranını paylaşıyor`;
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

// Aynı kutuyu birden çok düğme açabilir (kişi sırasındaki avatarlar, telefondaki "daha fazla"): kutu son basılan
// düğmeye hizalanır; yoksa görünen ilk düğmeye.
let popInvoker = null;
document.addEventListener('click', (e) => (popInvoker = e.target.closest?.('[popovertarget]') || popInvoker), true);
function popAnchor(pop) {
  if (popInvoker?.isConnected && popInvoker.getAttribute('popovertarget') === pop.id && popInvoker.getClientRects().length) return popInvoker;
  const all = [...document.querySelectorAll(`[popovertarget="${pop.id}"]`)];
  return all.find((b) => b.getClientRects().length) || all[0];
}

for (const pop of document.querySelectorAll('.pop')) {
  pop.addEventListener('toggle', (e) => {
    if (e.newState !== 'open') return;
    const btn = popAnchor(pop).getBoundingClientRect();
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
      <button class="icon sm ghost" title="Tekrar ekle" aria-label="Tekrar ekle">${icon('plus')}</button>`;
    li.prepend(thumb(h.videoId, h.thumb));
    li.querySelector('.q-title').textContent = h.title;
    const when = new Date(h.playedAt).toLocaleString(I18N.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
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

// Sıra / Geçmiş adresteki sekmedir (/oda/<id> ya da /oda/<id>/gecmis). Geçmiş her zaman görünür açılır: panel
// Sıra/Geçmiş bölümüne geçer.
function showTab(name) {
  for (const tab of ['queue', 'history']) $(`${tab}-view`).hidden = name !== tab;
  if (name === 'history') pane = 'list';
  renderFrame();
}

// ---------- Çerçeve: sayfa (oda / oyunlar / radyo) ve panel ----------
// pane: 'stage' (telefonda Oda sekmesi: oynatıcı + kişiler), 'chat' (Sohbet), 'list' (Sıra / Geçmiş).
// Masaüstünde sahne hep sol sütundadır; sağ panel 'list'te Sıra/Geçmiş'i, öteki iki durumda Sohbet'i gösterir.
// pane adrese yazılmaz (istemci durumu), ama geçmiş kaydına (history.state) yazılır: geri tuşu önceki bölüme döner.
// Sahne görünmezken oynatıcı ekrandan çıkarılır ama silinmez; müzik ve ekran paylaşımı sürer.
const PHONE = matchMedia('(max-width: 999px)');
let pane = 'stage';

const pageNow = () => (!$('radio').hidden ? 'radio' : $('games').hidden ? 'room' : 'games');
const stageVisible = () => pageNow() === 'room' && (!PHONE.matches || pane === 'stage');
const chatVisible = () => (PHONE.matches ? pageNow() === 'room' && pane === 'chat' : pane !== 'list');

function setActive(el, on) {
  el.classList.toggle('active', on);
  el.setAttribute('aria-selected', String(on));
}

function renderFrame() {
  const page = pageNow();
  const screen = $('room-screen');
  screen.dataset.page = page;
  screen.dataset.pane = pane;
  document.querySelector('.media').classList.toggle('away', !stageVisible());
  const list = pane === 'list';
  const tab = $('history-view').hidden ? 'queue' : 'history';
  setActive($('panel-chat'), !list);
  setActive($('tab-queue'), list && tab === 'queue');
  setActive($('tab-history'), list && tab === 'history');
  for (const [id, on] of [
    ['tabbar-room', page === 'room' && pane === 'stage'],
    ['tabbar-chat', page === 'room' && pane === 'chat'],
    ['tabbar-queue', page === 'room' && list],
    ['tabbar-games', page === 'games'],
    ['tabbar-radio', page === 'radio'],
  ]) {
    $(id).classList.toggle('active', on);
    if (on) $(id).setAttribute('aria-current', 'page');
    else $(id).removeAttribute('aria-current');
  }
  if (chatVisible()) setUnread(false);
  placeTools();
  renderShareStrip();
  renderTopbarNow();
}
PHONE.addEventListener('change', renderFrame);

// Görünmeyen sohbete gelen mesaj: Sohbet sekmelerinde nokta.
function setUnread(on) {
  $('panel-chat').classList.toggle('has-unread', on);
  $('tabbar-chat').classList.toggle('has-unread', on);
}

function showPage(page) {
  $('nav-room').classList.toggle('active', page === 'room');
  $('nav-games').classList.toggle('active', page === 'games');
  $('nav-radio').classList.toggle('active', page === 'radio');
  for (const [id, p] of [['nav-room', 'room'], ['nav-games', 'games'], ['nav-radio', 'radio']]) $(id).setAttribute('aria-selected', String(page === p));
  $('games').hidden = page !== 'games';
  $('radio').hidden = page !== 'radio';
  renderFrame();
  if (page === 'radio') openRadioPage();
  else syncRadioAudio();
  document.querySelectorAll('.tier-name').forEach(fitTierName);
}
$('nav-room').onclick = () => go(() => showPage('room'));
$('nav-games').onclick = () => go(() => { showPage('games'); openGame('home'); }); // her seferinde oyun kartlarıyla açılır
$('nav-radio').onclick = () => go(() => showPage('radio'));

// Sağ panelin sekmeleri (telefonda Sıra açıkken Sıra / Geçmiş seçicisi)
// Adres görüneni anlatsın: Sıra/Geçmiş bölümünden çıkılınca sekme Sıra'ya döner (/gecmis yalnız Geçmiş açıkken).
function leaveList(p) {
  pane = p;
  if (p !== 'list') for (const tab of ['queue', 'history']) $(`${tab}-view`).hidden = tab !== 'queue';
}
// Masaüstünde 'stage' ile 'chat' aynı görünür (panelde Sohbet): görünen bir şey değişmiyorsa geçmişe adım eklenmez.
$('panel-chat').onclick = () => {
  if (pane === 'chat' || (!PHONE.matches && pane === 'stage')) return;
  go(() => { leaveList('chat'); renderFrame(); });
};
$('tab-queue').onclick = () => go(() => { pane = 'list'; showTab('queue'); });
$('tab-history').onclick = () => go(() => showTab('history'));

// Telefonun alt sekme çubuğu
const showRoomPane = (p) => go(() => { leaveList(p); showPage('room'); });
$('tabbar-room').onclick = () => showRoomPane('stage');
$('tabbar-chat').onclick = () => showRoomPane('chat');
$('tabbar-queue').onclick = () => showRoomPane('list');
$('tabbar-games').onclick = () => $('nav-games').click();
$('tabbar-radio').onclick = () => $('nav-radio').click();
$('screen-strip').onclick = () => showRoomPane('stage');

// Masaüstünde oynatıcı, denetim paneli ve kişi sırası ilk ekrana sığsın: oynatıcının bırakacağı yükseklik
// (--stage-rest) panelin ve kişi sırasının gerçek boyundan hesaplanır (10 kişide kişi sırası iki satır, birleşik odada 20 kişide üç satır olur).
const stageRest = new ResizeObserver(() => {
  const now = document.querySelector('.stage > .now').offsetHeight;
  const people = document.querySelector('.stage > .people').offsetHeight;
  if (now && people) document.querySelector('.stage').style.setProperty('--stage-rest', `${now + people + 2 * 12 + 8}px`);
});
for (const el of document.querySelectorAll('.stage > .now, .stage > .people')) stageRest.observe(el);

// Araç satırı: telefonda az kullanılanlar (ekran paylaşımı, kayıt, Enver) "daha fazla" kutusuna taşınır.
const MORE_TOOLS = ['screen-toggle', 'rec-btn', 'esek-btn'];
function placeTools() {
  const into = PHONE.matches ? $('tools-more-list') : $('tools');
  for (const id of MORE_TOOLS) if ($(id).parentElement !== into) into.insertBefore($(id), PHONE.matches ? null : $('tools-more'));
  $('tools-more').hidden = !PHONE.matches || MORE_TOOLS.every((id) => $(id).hidden);
  if (!PHONE.matches && $('tools-more-pop').matches(':popover-open')) $('tools-more-pop').hidePopover();
}
// Düğmelerin görünürlüğü sonradan değişir (Enver yalnız yöneticide, kayıt/ekran tarayıcıya göre)
new MutationObserver(() => placeTools()).observe($('tools-more-list'), { subtree: true, attributes: true, attributeFilter: ['hidden'] });
// Kutudaki bir araç kendi kutusunu açacaksa (kayıt) ya da iş görürse "daha fazla" kapanır
$('tools-more-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn && !btn.hasAttribute('popovertarget')) $('tools-more-pop').hidePopover();
});

// Telefonda sohbet yazarken ekran klavyesi açılır: görünür alanın boyu (visualViewport) çerçeveye yazılır ki giriş
// kutusu klavyenin üstünde kalsın; klavye açıkken alt sekme çubuğu ve çalan şarkı şeridi gizlenir.
function renderViewport() {
  const vv = window.visualViewport;
  const style = $('room-screen').style;
  if (vv) {
    style.setProperty('--vv-h', `${Math.round(vv.height)}px`);
    style.setProperty('--vv-top', `${Math.round(vv.offsetTop)}px`);
  }
  const typing = document.activeElement === $('chat-input') && matchMedia('(pointer: coarse)').matches;
  // Parmakla yakınlaştırmada da görünür alan küçülür: klavye sayılması için ölçek 1 olmalı.
  const shrunk = vv ? Math.abs(vv.scale - 1) < 0.01 && innerHeight - vv.height > 120 : false;
  $('room-screen').classList.toggle('kb-open', PHONE.matches && (typing || shrunk));
}
window.visualViewport?.addEventListener('resize', renderViewport);
window.visualViewport?.addEventListener('scroll', renderViewport);
$('chat-input').addEventListener('focus', renderViewport);
$('chat-input').addEventListener('blur', () => setTimeout(renderViewport, 50));
PHONE.addEventListener('change', renderViewport);
renderViewport();

// Kaydırıcıların dolu kısmı (Chromium/WebKit'te ::-webkit-slider-runnable-track gradyanı): --pct.
function paintRange(el) {
  const min = Number(el.min) || 0;
  const max = Number(el.max) || 0;
  const pct = max > min ? ((Number(el.value) - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--pct', `${Math.max(0, Math.min(100, pct))}%`);
  // Ses kaydırıcısının yüzdesi kabında da durur: bir tema onu yazı olarak gösterebilir (Neon Oda'nın ses kadranı).
  if (el.parentElement?.classList.contains('vol')) {
    el.parentElement.dataset.val = Math.round(pct);
    const knob = el.parentElement.querySelector('.vol-knob');
    if (knob) knob.style.rotate = `${Math.max(0, Math.min(100, pct)) * 3.6}deg`;
  }
}

// Yuvarlak ses kadranı: bir tema ses kaydırıcısını halka olarak çizerse (Neon Oda masaüstü) .vol-knob görünür ve
// kadranın üstünü kaplar. Halkada tutup çevirerek ayarlanır: değer, imlecin kadranın merkezine göre açısıdır (tepe 0,
// saat yönünde 100). Sürüklerken tepeden geçince 100'den 0'a sıçramaz, uçta kalır. Tekerlek 5'er adım değiştirir;
// klavye kaydırıcının kendisinde çalışır. Diğer temalarda .vol-knob gizlidir (shell.css), kaydırıcı düz çalışır.
function setupVolDial(input) {
  const knob = Object.assign(document.createElement('span'), { className: 'vol-knob' });
  knob.setAttribute('aria-hidden', 'true');
  input.after(knob);
  const min = () => Number(input.min) || 0;
  const max = () => Number(input.max) || 100;
  const emit = (type) => input.dispatchEvent(new Event(type, { bubbles: true }));
  let dragging = false;
  const setFrom = (e) => {
    const r = input.getBoundingClientRect();
    const a = (Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2))) * 180 / Math.PI + 360) % 360;
    let v = Math.round(min() + (a / 360) * (max() - min()));
    const prev = Number(input.value);
    if (dragging && Math.abs(v - prev) > (max() - min()) / 2) v = prev > (min() + max()) / 2 ? max() : min();
    if (v !== prev) {
      input.value = v;
      emit('input');
    }
  };
  knob.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    knob.setPointerCapture(e.pointerId);
    dragging = false;
    setFrom(e);
    dragging = true;
  });
  knob.addEventListener('pointermove', (e) => { if (dragging) setFrom(e); });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    emit('change');
  };
  knob.addEventListener('pointerup', end);
  knob.addEventListener('pointercancel', end);
  knob.addEventListener('click', (e) => e.preventDefault()); // etiket tıklaması kaydırıcıya geçmesin
  knob.addEventListener('wheel', (e) => {
    e.preventDefault();
    input.value = Math.max(min(), Math.min(max(), Number(input.value) + (e.deltaY < 0 ? 5 : -5)));
    emit('input');
    emit('change');
  }, { passive: false });
}
document.querySelectorAll('.vol > input.range').forEach(setupVolDial);
document.addEventListener('input', (e) => e.target.matches?.('input.range') && paintRange(e.target));
const paintRanges = () => document.querySelectorAll('input.range').forEach(paintRange);
// Üst çubuktaki şarkıya basınca kumanda açılır (odaya dönmez); kumanda odadaki düğmeleri kullanır.
function renderNowPop() {
  $('now-pop-title').textContent = media?.current?.title || 'Şu an bir şey çalmıyor';
  $('now-pop-play').innerHTML = $('play-toggle').innerHTML;
  $('now-pop-play').disabled = $('now-pop-next').disabled = !media?.current;
  $('now-pop-vol').value = $('music-vol').value;
  paintRange($('now-pop-vol'));
}
$('now-pop').addEventListener('toggle', (e) => { if (e.newState === 'open') renderNowPop(); });
new MutationObserver(() => { if ($('now-pop').matches(':popover-open')) renderNowPop(); }).observe($('play-toggle'), { childList: true, subtree: true });
$('now-pop-play').onclick = () => $('play-toggle').click();
$('now-pop-next').onclick = () => $('next').click();
$('now-pop-vol').oninput = () => {
  $('music-vol').value = $('now-pop-vol').value;
  paintRange($('music-vol'));
  $('music-vol').dispatchEvent(new Event('input'));
  $('music-vol').dispatchEvent(new Event('change'));
};
// Telefonda Oda bölümüne (oynatıcı) gider; masaüstünde sağ panel olduğu gibi kalır.
$('now-pop-room').onclick = () => {
  $('now-pop').hidePopover();
  if (PHONE.matches) showRoomPane('stage');
  else go(() => showPage('room'));
};

// ---------- Gezinme geçmişi ----------
// Sayfa, sekme, oyun ve açık tier list tarayıcı geçmişine yazılır: geri tuşu siteden çıkmak yerine
// önceki ekrana döner, yenileyince de aynı yerde açılır. Her ekranın kendi adresi var (sunucu hepsine aynı sayfayı verir):
// / oda listesi, /uyeler (listede, yönetici); odanın içinde /oda/<id> sıra, /oda/<id>/gecmis, /oda/<id>/radyo,
// /oda/<id>/oyunlar (oyun kartları), /oda/<id>/oyunlar/tier/<liste no>, /oda/<id>/oyunlar/kelime ...

const GAMES = ['tier', 'timing', 'dino', 'kelime', 'memory', 'klotski', 'sayi', 'takimada', 'yedikapi', 'yorunge', 'kural', 'hedef', 'mantik', 'xox', 'dorttas', 'duvar', 'besharf', 'blackjack', 'arasinda', 'poker', 'pisti', 'batak', 'kemal', 'daktilo', 'okuma', 'peacock', 'oner'];
const GAME_PATHS = { tier: 'tier', timing: 'sure', dino: 'dinozor', kelime: 'kelime', memory: 'esini-bul', klotski: 'kaydirmaca', sayi: 'sayi-bulmaca', takimada: 'takimada', yedikapi: 'yedi-kapi', yorunge: 'yorunge-kusatmasi', kural: 'gizli-kural', hedef: 'hedef-sayi', mantik: 'mantik-tablosu', xox: 'ittirmeli-xox', dorttas: 'dort-tas', duvar: 'duvar', besharf: 'bes-harf', blackjack: 'blackjack', arasinda: 'arasinda', poker: 'poker', pisti: 'pisti', batak: 'batak', kemal: 'kemal', daktilo: 'daktilo', okuma: 'hizli-okuma', peacock: 'tavus', oner: 'oner' };

function viewPath(view) {
  const base = `/oda/${view.room}`;
  if (view.page === 'radio') return `${base}/radyo`;
  if (view.page === 'room') return view.tab === 'history' ? `${base}/gecmis` : base;
  if (!GAME_PATHS[view.game]) return `${base}/oyunlar`;
  return `${base}/oyunlar/${GAME_PATHS[view.game]}` + (view.game === 'tier' && view.list != null ? `/${view.list}` : '');
}

// Odanın dışındaki adresler { page: 'list' | 'members' } olur (oda listesi ekranı, public/lobby.js).
function pathView(path) {
  const [top, room, first, second, third] = path.split('/').filter(Boolean);
  if (top !== 'oda' || !/^[\w-]+$/.test(room || '')) return { page: top === 'uyeler' ? 'members' : 'list' };
  const view = { room, page: 'room', tab: first === 'gecmis' ? 'history' : 'queue', game: 'home', list: null };
  if (first === 'radyo') view.page = 'radio';
  if (first !== 'oyunlar') return view;
  view.page = 'games';
  view.game = GAMES.find((g) => GAME_PATHS[g] === second) || 'home';
  if (view.game === 'tier' && /^\d+$/.test(third || '')) view.list = Number(third);
  return view;
}

const currentView = () => ({
  room: roomId,
  page: !$('radio').hidden ? 'radio' : $('games').hidden ? 'room' : 'games',
  tab: $('history-view').hidden ? 'queue' : 'history',
  game: GAMES.find((g) => !$(`game-${g}`).hidden) || 'home',
  list: openListId,
  pane,
});

const sameView = (a, b) => a && b && ['room', 'page', 'tab', 'game', 'list', 'pane'].every((k) => a[k] === b[k]);

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
  if (view.pane && view.pane !== pane) {
    pane = view.pane;
    renderFrame();
  }
  openGame(view.game);
  const list = view.list != null && tierLists.some((l) => l.id === view.list) ? view.list : null;
  if (list !== openListId) {
    openListId = list;
    selectedCard = null;
    renderTierLists();
  }
}

// Odanın dışına (listeye) geri gidilince sayfa o adreste yeniden açılır: ses ve bağlantılar temiz kapanır.
addEventListener('popstate', (e) => {
  if ($('room-screen').hidden) return;
  const view = e.state?.page ? e.state : pathView(location.pathname);
  if (view.room !== roomId) return location.reload();
  applyView(view);
});

// Sahne görünmezken (oyunlar, radyo, telefonda sohbet/sıra) çalan şarkı üst çubukta (telefonda alt şeritte) görünür.
function renderTopbarNow() {
  const btn = $('topbar-now');
  const title = media?.current?.title;
  btn.hidden = !title || !document.querySelector('.media').classList.contains('away');
  btn.classList.toggle('is-playing', Boolean(media?.playing));
  if (title && btn.dataset.title !== title) {
    btn.dataset.title = title;
    btn.innerHTML = `<span class="now-eq" aria-hidden="true"><i></i><i></i><i></i></span><span class="topbar-now-title"></span>${icon('up')}`;
    btn.querySelector('.topbar-now-title').textContent = title;
    btn.setAttribute('aria-label', `Çalan şarkı: ${title}`);
  }
  if (btn.hidden && $('now-pop').matches(':popover-open')) $('now-pop').hidePopover();
  else if ($('now-pop').matches(':popover-open')) renderNowPop();
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

// 'home' oyun değil: bütün oyunların kartları (Oyunlar sayfasının girişi)
function showGame(name) {
  $('game-home').hidden = name !== 'home';
  for (const game of GAMES) {
    $(`game-tab-${game}`).classList.toggle('active', game === name);
    $(`game-${game}`).hidden = game !== name;
  }
}
function openGame(name) {
  showGame(name);
  if (name === 'home') renderGameHome();
  if (name === 'tier') document.querySelectorAll('.tier-name').forEach(fitTierName);
  if (name === 'kelime') renderKelime();
  if (name === 'memory') renderMemory();
  if (name === 'klotski') renderKlotski();
  if (name === 'sayi') renderSayi();
  if (name === 'hedef') renderHedef(); // public/hedef.js
  if (name === 'kural') window.renderKural?.(); // public/kural.js
  if (name === 'mantik') renderMantik(); // public/mantik.js
  if (name === 'daktilo') renderDaktilo(); // public/daktilo.js
  if (name === 'xox') window.renderXox?.(); // public/xox.js
  if (name === 'dorttas') window.renderDorttas?.(); // public/dorttas.js
  if (name === 'duvar') window.renderDuvar?.(); // public/duvar.js
  if (name === 'besharf') window.renderBesharf?.(); // public/besharf.js
  if (['blackjack', 'arasinda', 'poker', 'pisti', 'batak', 'kemal'].includes(name)) window.renderKart?.(name); // public/kart.js
  if (name === 'okuma') renderOkuma(); // public/okuma.js
  else if (typeof okumaStop === 'function') okumaStop(); // açık alıştırmanın sayacı dursun; geri gelince alıştırma baştan çizilir
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

const fmtSeconds = (ms) => (ms / 1000).toLocaleString(I18N.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

// Skor tablosunun sıra hücresi. mark: sıralama kesinleşmiş, birinci tek ve puanı sıfırdan büyük (oyun bitti ya da
// kalıcı rekor tablosu): o zaman ilk üç --accent-2 ile işaretlenir, birincide taç (css/games.css .timing-rank.top);
// değilse düz sıra numarası. label sayı değilse (ör. bot simgesi ya da boş) olduğu gibi yazılır.
function rankCell(i, label = i + 1, mark = true) {
  const el = document.createElement('span');
  el.className = 'timing-rank';
  if (mark && typeof label === 'number' && i < 3) {
    el.classList.add('top', `top-${i + 1}`);
    el.title = `${i + 1}.`;
    if (i === 0) el.innerHTML = icon('crown');
    else el.textContent = label;
  } else el.textContent = label;
  return el;
}

// Skor tablolarının ortak satırı (.timing-list): avatar, ad, değer, alt yazı. Kendi satırın .me (--accent-soft).
function timingRow(name, main, sub, cls) {
  const li = document.createElement('li');
  if (name === myName) li.classList.add('me');
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
  [...best.values()].sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff)).slice(0, TIMING_BOARD).forEach((r, i, all) => {
    const row = timingRow(r.name, fmtDiff(r.diff), `${fmtSeconds(r.elapsed)} sn`, timingVerdict(r.diff)[1]);
    row.prepend(rankCell(i, i + 1, Math.abs(all[0].diff) !== Math.abs(all[1]?.diff))); // birincilikte eşitlik yoksa
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
  const sole = names.filter((n) => raceTotal(race, n) === best).length === 1; // taç yalnız tek kazanana
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
    row.prepend(rankCell(i, i + 1, race.done && race.ended > 0 && sole));
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
const kelimeColor = (name) => kelime?.players.find((p) => p.name === name)?.color || Theme.color('--muted');
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
    // Taç ve sarı sıralar yalnız oyun sonunda, birinci tek ve puanı artıdaysa; tur puanlarında ve oyun sürerken düz sıra
    li.prepend(rankCell(i, i + 1, Boolean(crown) && scores[0].points > 0 && scores[0].points !== scores[1]?.points));
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
    chip.translate = false; // havuzdaki Türkçe kelime çevrilmez
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
    row.prepend(rankCell(i, game.done && !solo ? i + 1 : '', best > 0 && game.players.filter((n) => game.scores[n] === best).length === 1));
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
  const size = game?.tiles.length / 2;
  if (size && memory?.id !== game.id) memorySize = size; // rekorlarda son oynanan tahta seçili olsun
  memory = game;
  renderMemory();
  renderMemoryRanks();
}
socket.on('memory', setMemory);

// Kalıcı tablolar: tek başına bitirilen oyunlar tahta büyüklüğüne göre (en az hamle, eşitse en kısa süre)
// ve birden çok kişiyle oynananlarda kazanma sayısı. Sunucu hesaplar.
let memoryRanks = { solo: {}, wins: [] };
let memorySize = null; // rekorlarda seçili tahta (çift sayısı)

// mark: birinci işaretlensin mi (kazananlar tablosunda 0 galibiyet ya da birincilikte eşitlik varsa işaret yok)
function memoryRankRow(name, main, sub, i, mark = true) {
  const row = timingRow(name, main, sub, i === 0 && mark ? 'great' : '');
  row.prepend(rankCell(i, i + 1, mark));
  return row;
}
const memoryEmpty = (text) => Object.assign(document.createElement('li'), { className: 'muted small', textContent: text });

function renderMemoryRanks() {
  const sizes = Object.keys(memoryRanks.solo).map(Number).sort((a, b) => a - b);
  if (!sizes.includes(memorySize)) memorySize = sizes.includes(40) ? 40 : sizes[0] ?? null;
  $('memory-sizes').replaceChildren(...(sizes.length > 1 ? sizes : []).map((n) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'sm ghost', textContent: `${n} çift` });
    b.classList.toggle('active', n === memorySize);
    b.onclick = () => {
      memorySize = n;
      renderMemoryRanks();
    };
    return b;
  }));
  const best = $('memory-best');
  best.replaceChildren(...(memoryRanks.solo[memorySize] || []).map((r, i) => {
    const date = new Date(r.at).toLocaleDateString(I18N.locale, { day: 'numeric', month: 'short' });
    return memoryRankRow(r.name, `${r.moves} hamle`, `${fmtClock(Math.round(r.ms / 1000) * 1000)} · ${sizes.length === 1 ? `${memorySize} çift · ` : ''}${date}`, i);
  }));
  if (!best.children.length) best.append(memoryEmpty('Tek başına bitirilen oyun yok.'));
  const wins = $('memory-wins');
  const [w1, w2] = memoryRanks.wins;
  const winsMark = w1?.wins > 0 && w1.wins !== w2?.wins;
  wins.replaceChildren(...memoryRanks.wins.map((w, i) => memoryRankRow(w.name, `${w.wins} galibiyet`, `${w.games} oyun · ${w.pairs} çift`, i, winsMark)));
  if (!wins.children.length) wins.append(memoryEmpty('Birlikte oynanan oyun yok.'));
}
socket.on('memory:board', (board) => {
  memoryRanks = board;
  renderMemoryRanks();
});

// ---------- Sayı bulmaca ----------
// Gizli sayıyı +/- ipuçlarıyla bulma. Tahminler klavyeyle yazılır (ekranda tuş takımı yok); kutulara basınca
// telefonda klavye açılır. Not araçları (rakam işaretleri, rakam × basamak tablosu, emin oldukların, tahmin
// rakamlarına çizgi/daire, serbest not) sadece bu tarayıcıda, oyuna göre saklanır. Tablodaki ✓ ile "emin
// oldukların" aynı veridir (notes.sure); tablodaki ✗'ler notes.grid'de "rakam:basamak" anahtarıyla durur.

let sayi = null;
let sayiOppOpen = false;
const SAYI_CPU = 'Bilgisayar'; // sunucudaki SAYI_CPU ile aynı
const SAYI_MARKS = ['', 'x', 'v', 'q'];
const SAYI_MARK_TEXT = { x: '✗', v: '✓', q: '?' };
const SAYI_TAGS = ['', 's', 'c']; // tahmin rakamı: boş → üstü çizili → daire
const sayiNotesKey = () => `sayiNotes:${myName}`;
let sayiUndo = []; // not değişikliklerinden önceki haller (JSON), en çok 100
let sayiClock = 0; // sunucu saati - bu saat
let sayiTick = null;

const sayiPlaying = () => Boolean(sayi && sayi.players.includes(myName));
const sayiActive = () => (sayi && !sayi.done ? sayi : null);
const sayiOther = (name) => (sayi.players.length === 1 ? SAYI_CPU : sayi.players.find((p) => p !== name));

function sayiNotes() {
  let notes = null;
  try { notes = JSON.parse(localStorage.getItem(sayiNotesKey())); } catch {}
  if (!sayi) return { id: null, sure: [], marks: {}, grid: {}, tags: {}, text: '' };
  if (notes?.id !== sayi.id) notes = { id: sayi.id, sure: [], marks: {} };
  return { grid: {}, tags: {}, text: '', ...notes };
}
function sayiSaveNotes(notes) {
  try { localStorage.setItem(sayiNotesKey(), JSON.stringify(notes)); } catch {}
}
// Notu değiştirir; önceki hali geri al için saklanır.
function sayiEdit(fn) {
  const notes = sayiNotes();
  sayiUndo.push(JSON.stringify(notes));
  if (sayiUndo.length > 100) sayiUndo.shift();
  fn(notes);
  sayiSaveNotes(notes);
  renderSayi();
}

// Yazılanı kurala uydurur: sadece rakam, tekrar yok, başta 0 yok, en çok n hane.
function sayiClean(value, n) {
  let out = '';
  let msg = '';
  for (const ch of value) {
    if (!/\d/.test(ch)) continue;
    if (!out && ch === '0') { msg = '0 en başa gelemez.'; continue; }
    if (out.includes(ch)) { msg = `${ch} zaten var; aynı rakam iki kez olamaz.`; continue; }
    if (out.length < n) out += ch;
  }
  return { out, msg };
}

const sayiInfo = (g) => (g.plus === sayi.digits ? `+${g.plus} 🎉` : [g.plus && `+${g.plus}`, g.minus && `-${g.minus}`].filter(Boolean).join(' ') || '0');

// tags verilirse rakamlara basılınca çizgi/daire değişir (gi: tahminin sırası)
function sayiDigitsEl(text, marks, tags, gi) {
  const wrap = document.createElement('span');
  wrap.className = 'sayi-num';
  [...text].forEach((d, pos) => {
    const s = document.createElement('span');
    s.textContent = d;
    const tag = tags?.[`${gi}:${pos}`];
    s.className = [marks?.[d] && `mark-${marks[d]}`, tag && `tag-${tag}`].filter(Boolean).join(' ');
    if (tags) {
      s.classList.add('tappable');
      s.onclick = () => sayiEdit((notes) => {
        const key = `${gi}:${pos}`;
        const next = SAYI_TAGS[(SAYI_TAGS.indexOf(notes.tags[key] || '') + 1) % SAYI_TAGS.length];
        if (next) notes.tags[key] = next;
        else delete notes.tags[key];
      });
    }
    wrap.append(s);
  });
  return wrap;
}

function sayiListRows(list, guesses, marks, tags) {
  list.replaceChildren(...guesses.map((g, i) => {
    const li = document.createElement('li');
    li.className = 'sayi-row' + (g.plus === sayi.digits ? ' found' : '');
    const left = document.createElement('span');
    left.className = 'sayi-left';
    left.append(Object.assign(document.createElement('span'), { className: 'muted small sayi-i', textContent: `${i + 1}.` }), sayiDigitsEl(g.guess, marks, tags, i));
    li.append(left, Object.assign(document.createElement('strong'), { className: 'sayi-info', textContent: sayiInfo(g) }));
    return li;
  }));
  if (!guesses.length) list.append(Object.assign(document.createElement('li'), { className: 'muted small sayi-empty', textContent: 'Henüz tahmin yok.' }));
}

// Gizli input'un değeri kutucuklarda görünür.
function sayiSlots(input) {
  const box = input.closest('.sayi-entry').querySelector('.sayi-slots');
  const n = sayi?.digits || 0;
  const focused = document.activeElement === input;
  const marks = sayiNotes().marks;
  if (box.children.length !== n) box.replaceChildren(...Array.from({ length: n }, () => document.createElement('span')));
  [...box.children].forEach((slot, i) => {
    const d = input.value[i] || '';
    slot.textContent = d;
    slot.className = 'sayi-slot' + (d && marks[d] ? ` mark-${marks[d]}` : '') + (focused && i === Math.min(input.value.length, n - 1) ? ' caret' : '');
  });
}

function sayiBindEntry(input, onMsg) {
  input.addEventListener('input', () => {
    const { out, msg } = sayiClean(input.value, sayi?.digits || 0);
    input.value = out;
    onMsg(msg);
    sayiSlots(input);
  });
  input.addEventListener('focus', () => sayiSlots(input));
  input.addEventListener('blur', () => sayiSlots(input));
}

sayiBindEntry($('sayi-secret-input'), (msg) => { $('sayi-secret-error').textContent = msg; });
sayiBindEntry($('sayi-guess-input'), (msg) => { if (msg) sayiGuessHint(msg, true); else renderSayiHint(); });

let sayiHintTimer = null;
function sayiGuessHint(text, warn) {
  $('sayi-guess-hint').textContent = text;
  $('sayi-guess-hint').classList.toggle('error', Boolean(warn));
  clearTimeout(sayiHintTimer);
  if (warn) sayiHintTimer = setTimeout(renderSayiHint, 2500);
}
function renderSayiHint() {
  const game = sayiActive();
  if (!game || game.phase !== 'play') return;
  sayiGuessHint('Yaz, Enter');
}

$('sayi-secret').onsubmit = (e) => {
  e.preventDefault();
  const v = $('sayi-secret-input').value;
  if (v.length !== sayi?.digits) return ($('sayi-secret-error').textContent = `${sayi?.digits} basamak yaz.`);
  socket.emit('sayi:secret', v);
};

$('sayi-guess').onsubmit = (e) => {
  e.preventDefault();
  const game = sayiActive();
  const input = $('sayi-guess-input');
  if (!game || game.phase !== 'play') return;
  if (game.finished?.[myName]) return;
  if (input.value.length !== game.digits) return sayiGuessHint(`${game.digits} basamak yaz.`, true);
  if (game.guesses[myName].some((g) => g.guess === input.value)) return sayiGuessHint('Bunu zaten denedin.', true);
  socket.emit('sayi:guess', input.value);
  input.value = '';
  sayiSlots(input);
};

// Klavyeden yazılan rakamlar, başka bir yere yazmıyorsan tahmin kutusuna gider.
document.addEventListener('keydown', (e) => {
  if ($('games').hidden || $('game-sayi').hidden || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
  const input = !$('sayi-secret').hidden ? $('sayi-secret-input') : !$('sayi-guess').hidden && !$('sayi-play').hidden ? $('sayi-guess-input') : null;
  if (!input || !(/^\d$/.test(e.key) || e.key === 'Backspace' || e.key === 'Enter')) return;
  e.preventDefault();
  input.focus();
  if (e.key === 'Enter') return input.form.requestSubmit();
  input.value = e.key === 'Backspace' ? input.value.slice(0, -1) : input.value + e.key;
  input.dispatchEvent(new Event('input'));
});
for (const entry of document.querySelectorAll('.sayi-entry')) entry.onclick = () => $(entry.dataset.for).focus();

function renderSayiTools() {
  const notes = sayiNotes();
  const n = sayi.digits;
  // Emin oldukların: her basamağa bir rakam
  const sure = $('sayi-sure');
  if (sure.children.length !== n || sure.dataset.id !== String(sayi.id)) {
    sure.dataset.id = sayi.id;
    sure.replaceChildren(...Array.from({ length: n }, (_, i) => {
      const box = document.createElement('input');
      box.className = 'sayi-sure-slot';
      box.inputMode = 'numeric';
      box.autocomplete = 'off';
      box.setAttribute('aria-label', `${i + 1}. basamak`);
      box.oninput = () => {
        box.value = box.value.replace(/\D/g, '').slice(-1);
        const next = box.value ? sure.children[i + 1] : null;
        sayiEdit((notes) => {
          if (box.value) notes.sure = Array.from({ length: n }, (_, k) => (notes.sure[k] === box.value ? '' : notes.sure[k] || ''));
          notes.sure[i] = box.value;
          if (box.value) delete notes.grid[`${box.value}:${i}`];
        });
        next?.focus();
      };
      box.onkeydown = (e) => {
        if (e.key === 'Backspace' && !box.value) sure.children[i - 1]?.focus();
        if (e.key === 'ArrowLeft') sure.children[i - 1]?.focus();
        if (e.key === 'ArrowRight') sure.children[i + 1]?.focus();
      };
      box.onfocus = () => box.select();
      return box;
    }));
  }
  [...sure.children].forEach((box, i) => {
    if (document.activeElement !== box) box.value = notes.sure[i] || '';
  });
  // Rakam şeridi (üst satır, bastıkça boş → ✗ → ✓ → ? → boş) ve altında rakam × basamak tablosu
  // (bastıkça boş → ✗ burada değil → ✓ burada → boş). Bir basamakta ✓ olan rakam "emin oldukların"a yazılır.
  const strip = $('sayi-digits');
  const digits = [...'1234567890'];
  if (strip.dataset.id !== String(sayi.id) || strip.dataset.n !== String(n)) {
    strip.dataset.id = sayi.id;
    strip.dataset.n = n;
    strip.style.setProperty('--rows', n + 1);
    const cells = [Object.assign(document.createElement('span'), { className: 'sayi-corner' })];
    for (const d of digits) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sayi-digit';
      b.dataset.d = d;
      b.onclick = () => sayiEdit((notes) => {
        const next = SAYI_MARKS[(SAYI_MARKS.indexOf(notes.marks[d] || '') + 1) % SAYI_MARKS.length];
        if (next) notes.marks[d] = next;
        else delete notes.marks[d];
      });
      cells.push(b);
    }
    for (let i = 0; i < n; i++) {
      cells.push(Object.assign(document.createElement('span'), { className: 'sayi-pos muted small', textContent: `${i + 1}.`, title: `${i + 1}. basamak` }));
      for (const d of digits) {
        const c = document.createElement('button');
        c.type = 'button';
        c.className = 'sayi-cell';
        c.dataset.d = d;
        c.dataset.i = i;
        c.setAttribute('aria-label', `${d}, ${i + 1}. basamak`);
        c.onclick = () => sayiEdit((notes) => {
          const key = `${d}:${i}`;
          if (notes.sure[i] === d) notes.sure[i] = ''; // ✓ → boş
          else if (notes.grid[key]) { // ✗ → ✓ (aynı rakam başka basamakta ✓ ise oradan kalkar)
            delete notes.grid[key];
            notes.sure = Array.from({ length: n }, (_, k) => (notes.sure[k] === d ? '' : notes.sure[k] || ''));
            notes.sure[i] = d;
          }
          else notes.grid[key] = 'x'; // boş → ✗
        });
        cells.push(c);
      }
    }
    strip.replaceChildren(...cells);
  }
  for (const b of strip.querySelectorAll('.sayi-digit')) {
    const d = b.dataset.d;
    const mark = notes.marks[d] || '';
    const allX = Array.from({ length: n }, (_, i) => notes.grid[`${d}:${i}`]).every(Boolean);
    b.className = 'sayi-digit' + (mark ? ` mark-${mark}` : '') + (allX ? ' gone' : '');
    b.title = allX ? `${d} hiçbir basamağa sığmıyor` : '';
    b.replaceChildren(d, Object.assign(document.createElement('small'), { textContent: SAYI_MARK_TEXT[mark] || '' }));
  }
  for (const c of strip.querySelectorAll('.sayi-cell')) {
    const { d, i } = c.dataset;
    const yes = notes.sure[i] === d;
    const no = !yes && notes.grid[`${d}:${i}`];
    const taken = !yes && Boolean(notes.sure[i]); // bu basamakta başka bir rakam ✓
    const out = notes.marks[d] === 'x';
    c.className = 'sayi-cell' + (yes ? ' yes' : no ? ' no' : '') + (taken || out ? ' dim' : '');
    c.textContent = yes ? '✓' : no ? '✗' : '';
  }
  $('sayi-undo').disabled = !sayiUndo.length;
  const text = $('sayi-text');
  if (document.activeElement !== text) text.value = notes.text || '';
}

$('sayi-text').addEventListener('input', (e) => {
  const notes = sayiNotes();
  notes.text = e.target.value;
  sayiSaveNotes(notes);
});
$('sayi-undo').onclick = () => {
  const prev = sayiUndo.pop();
  if (!prev) return;
  const notes = JSON.parse(prev);
  notes.text = sayiNotes().text; // yazı notunun kendi geri alması var
  sayiSaveNotes(notes);
  renderSayi();
};
confirmButton($('sayi-reset'), 'Emin misin? Tekrar bas', () => sayiEdit((notes) => {
  Object.assign(notes, { sure: [], marks: {}, grid: {}, tags: {} });
}));

// Sağ üstteki süre: tahminler başlayınca işler, oyun bitince durur.
function renderSayiTimer() {
  const el = $('sayi-timer');
  const game = sayi;
  const show = Boolean(game && game.phase === 'play');
  el.hidden = !show;
  clearInterval(sayiTick);
  sayiTick = null;
  if (!show) return;
  const draw = () => {
    const mine = game.finished?.[myName];
    const end = mine ? game.startedAt + mine.ms : game.done ? game.endedAt : Date.now() + sayiClock;
    setIcon(el, 'timer', fmtTime((end - game.startedAt) / 1000));
  };
  draw();
  if (!game.done && !game.finished?.[myName]) sayiTick = setInterval(draw, 1000);
}

function renderSayi() {
  const game = sayi;
  renderLobby('sayi');
  const playing = sayiPlaying();
  const active = sayiActive();
  $('sayi-end').hidden = !(active && playing);
  $('sayi-close').hidden = !game?.done;
  const secretPhase = Boolean(active && active.phase === 'secret');
  $('sayi-secret').hidden = !(secretPhase && playing && !game.ready[myName]);
  const waiting = secretPhase ? game.players.filter((p) => !game.ready[p]) : [];
  $('sayi-wait').hidden = !(secretPhase && $('sayi-secret').hidden);
  $('sayi-wait').textContent = waiting.length ? `${waiting.join(', ')} sayısını tutuyor…` : '';
  $('sayi-play').hidden = !game || secretPhase;
  renderSayiTimer();
  if (!game) return;

  $('sayi-status').textContent = game.done
    ? (game.reason ? `${game.reason} ` : '') + (game.winners.length === 2 ? 'Berabere!' : game.winners.length ? `🏆 ${game.winners[0]} kazandı` : 'Oyun bitti')
    : secretPhase ? `${game.digits} basamak · sayılar tutuluyor`
      : `${game.digits} basamak · herkes kendi hızında`;
  // Puanlar: bulan herkesin tahmin, süre ve puanı; arayanların tahmin sayısı
  const scores = $('sayi-scores');
  scores.hidden = secretPhase;
  scores.replaceChildren(...game.players.map((p) => {
    const f = game.finished?.[p];
    const li = document.createElement('li');
    li.className = (f ? 'found' : '') + (p === myName ? ' me' : '');
    li.append(Object.assign(document.createElement('strong'), { textContent: p === myName ? 'Sen' : p }),
      f ? ` · ${f.guesses} tahmin · ${fmtTime(f.ms / 1000)} · ` : ` · ${game.done ? 'bulamadı' : 'arıyor'} (${game.guesses[p].length} tahmin)`,
      ...(f ? [Object.assign(document.createElement('b'), { textContent: `${f.points} puan` })] : []));
    return li;
  }));
  if (secretPhase) {
    sayiSlots($('sayi-secret-input'));
    return;
  }

  // Kimin gözünden: oynuyorsan senin, izliyorsan ilk oyuncunun tahminleri
  const viewer = playing ? myName : game.players[0];
  const other = sayiOther(viewer);
  const notes = playing ? sayiNotes() : { sure: [], marks: {} };
  const code = $('sayi-code');
  code.replaceChildren();
  if (playing && game.players.length > 1) {
    code.append('Senin sayın: ', sayiDigitsEl(game.secrets[myName] || ''));
    // Rakip sayı tutmadan oyun bittiyse (gizli sayı aşamasında ayrıldı) gösterilecek sayısı yok
    $('sayi-code-label').textContent = !game.done ? 'rakibinin bulmaya çalıştığı sayı'
      : game.secrets[other] ? `${other}'in sayısı: ${game.secrets[other]}` : `${other} sayı tutmadan oyun bitti`;
  } else {
    code.append(`${other}: `, sayiDigitsEl(game.done ? game.secrets[other] || '' : '?'.repeat(game.digits)));
    $('sayi-code-label').textContent = playing ? 'bulmaya çalıştığın sayı' : `${viewer}'in tahminleri aşağıda`;
  }
  $('game-sayi').querySelector('.sayi-sure').hidden = !playing;
  $('sayi-digits').hidden = !playing;
  $('sayi-tools').hidden = !playing;
  $('sayi-extra').hidden = !playing;
  $('sayi-guess').hidden = !(playing && active && !game.finished?.[myName]);
  if (playing) renderSayiTools();
  if (playing && active) {
    sayiSlots($('sayi-guess-input'));
    renderSayiHint();
  }
  sayiListRows($('sayi-mine'), game.guesses[viewer], notes.marks, playing ? notes.tags : null);

  const two = game.players.length > 1;
  const theirs = two ? game.guesses[other] : [];
  $('sayi-opp-toggle').hidden = !two;
  $('sayi-opp-toggle').textContent = `${sayiOppOpen ? '▾' : '▸'} ${playing ? 'Rakibin' : `${other}'in`} tahminleri (${theirs.length})`;
  $('sayi-opp').hidden = !(two && sayiOppOpen);
  if (two && sayiOppOpen) {
    $('sayi-opp-title').textContent = playing ? `${other} senin sayını arıyor` : `${other}, ${viewer}'in sayısını arıyor`;
    sayiListRows($('sayi-theirs'), theirs);
  }
}

$('sayi-opp-toggle').onclick = () => {
  sayiOppOpen = !sayiOppOpen;
  renderSayi();
};
confirmButton($('sayi-end'), 'Emin misin? Tekrar bas', () => socket.emit('sayi:end'));
$('sayi-close').onclick = () => socket.emit('sayi:close');

function setSayi(game) {
  const fresh = game && sayi?.id !== game.id;
  const wasPlay = sayiActive()?.phase === 'play';
  sayi = game;
  if (game?.now) sayiClock = game.now - Date.now();
  if (fresh) {
    sayiUndo = [];
    $('sayi-secret-input').value = '';
    $('sayi-guess-input').value = '';
    $('sayi-secret-error').textContent = '';
    $('sayi-sure').replaceChildren();
    sayiOppOpen = false;
  }
  renderSayi();
  // Tahminler başlayınca (sayfa açıksa) tahmin kutusuna odaklan
  const nowPlay = sayiActive()?.phase === 'play' && sayiPlaying();
  if (nowPlay && !wasPlay && !$('games').hidden && !$('game-sayi').hidden && !document.activeElement?.closest?.('input, textarea')) $('sayi-guess-input').focus({ preventScroll: true });
}
socket.on('sayi', setSayi);

// ---------- Kaydırmaca (Klotski) ----------
// Tek başına oynanır, tahta tarayıcıda. Parça sürüklendikçe yarım kare geçince bir kare kayar (boş yoksa durur),
// böylece köşe dönen yollar da tek sürüklemede yapılır. Aynı parçanın art arda adımları tek hamle sayılır.
// Bitince adımlar sunucuya gider; sunucu yeniden oynatıp doğrular ve rekor tablosuna ekler.

let klotskiLevels = [];
let klotskiRanks = {};
let klotski = null; // { level, pieces: [{ x, y, w, h, big, el }], steps: [[k, dx, dy]], start, done, ms }
let klotskiTimer = null;

const klotskiLevelKey = 'klotskiLevel';
const klotskiSolvedKey = 'klotskiSolved';
const klotskiStore = (key, value) => {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key));
    localStorage.setItem(key, JSON.stringify(value));
  } catch { return null; }
};

function setKlotskiLevels({ levels, board }) {
  klotskiLevels = levels || [];
  klotskiRanks = board || {};
  if (!klotski) {
    const saved = klotskiStore(klotskiLevelKey);
    klotskiLoad(klotskiLevels.find((l) => l.id === saved) || klotskiLevels[0]);
  }
  renderKlotski();
}

function klotskiParse(rows) {
  const pieces = [];
  const seen = new Set();
  for (let y = 0; y < 5; y++) for (let x = 0; x < 4; x++) {
    const c = rows[y][x];
    if (c === '.' || seen.has(c)) continue;
    seen.add(c);
    let w = 1, h = 1;
    while (rows[y][x + w] === c) w++;
    while (rows[y + h]?.[x] === c) h++;
    pieces.push({ x, y, w, h, big: w === 2 && h === 2 });
  }
  return pieces;
}

function klotskiLoad(level) {
  if (!level) return;
  clearInterval(klotskiTimer);
  klotskiTimer = null;
  klotski = { level, pieces: klotskiParse(level.rows), steps: [], start: 0, done: false, ms: 0 };
  klotskiStore(klotskiLevelKey, level.id);
  const board = $('klotski-board');
  board.classList.remove('won');
  board.replaceChildren(...klotski.pieces.map((p, k) => {
    const el = document.createElement('div');
    el.className = 'klotski-piece' + (p.big ? ' big' : '');
    el.append(document.createElement('i'));
    el.style.setProperty('--w', p.w);
    el.style.setProperty('--h', p.h);
    el.addEventListener('pointerdown', (e) => klotskiGrab(e, k));
    p.el = el;
    return el;
  }));
  klotskiPlace();
  $('klotski-done').hidden = true;
}

function klotskiPlace() {
  for (const p of klotski.pieces) {
    p.el.style.setProperty('--x', p.x);
    p.el.style.setProperty('--y', p.y);
  }
}

const klotskiMoves = () => {
  let moves = 0, last = -1;
  for (const [k] of klotski.steps) {
    if (k !== last) moves++;
    last = k;
  }
  return moves;
};

function klotskiCan(k, dx, dy) {
  const p = klotski.pieces[k];
  const nx = p.x + dx, ny = p.y + dy;
  if (nx < 0 || ny < 0 || nx + p.w > 4 || ny + p.h > 5) return false;
  return !klotski.pieces.some((q, i) => i !== k && nx < q.x + q.w && q.x < nx + p.w && ny < q.y + q.h && q.y < ny + p.h);
}

function klotskiStep(k, dx, dy) {
  if (klotski.done || !klotskiCan(k, dx, dy)) return false;
  const p = klotski.pieces[k];
  p.x += dx;
  p.y += dy;
  const last = klotski.steps.at(-1);
  // Aynı parça geri dönerse son adımı silmek yeterli (hamle sayısı şişmesin)
  if (last && last[0] === k && last[1] === -dx && last[2] === -dy) klotski.steps.pop();
  else klotski.steps.push([k, dx, dy]);
  if (!klotski.start) {
    klotski.start = Date.now();
    klotskiTimer = setInterval(renderKlotskiStats, 250);
  }
  klotskiPlace();
  if (p.big && p.x === 1 && p.y === 3) klotskiWon();
  renderKlotskiStats();
  return true;
}

function klotskiGrab(e, k) {
  if (!klotski || klotski.done) return;
  e.preventDefault();
  const el = klotski.pieces[k].el;
  const rect = $('klotski-board').getBoundingClientRect();
  const cw = (rect.width - 20) / 4, ch = (rect.height - 20) / 5;
  let ox = e.clientX, oy = e.clientY;
  el.classList.add('drag');
  try { el.setPointerCapture(e.pointerId); } catch {}
  const move = (ev) => {
    // Birden çok kare birden geçildiyse hepsini sırayla dene; önce daha çok çekilen yön
    for (let guard = 0; guard < 8; guard++) {
      const dx = (ev.clientX - ox) / cw, dy = (ev.clientY - oy) / ch;
      const tries = [];
      if (Math.abs(dx) >= .5) tries.push([Math.sign(dx), 0, Math.abs(dx)]);
      if (Math.abs(dy) >= .5) tries.push([0, Math.sign(dy), Math.abs(dy)]);
      tries.sort((a, b) => b[2] - a[2]);
      const done = tries.find(([sx, sy]) => klotskiStep(k, sx, sy));
      if (!done) break;
      ox += done[0] * cw;
      oy += done[1] * ch;
    }
  };
  const up = () => {
    el.classList.remove('drag');
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

function klotskiWon() {
  klotski.done = true;
  klotski.ms = Date.now() - klotski.start;
  clearInterval(klotskiTimer);
  klotskiTimer = null;
  const moves = klotskiMoves();
  const solved = klotskiStore(klotskiSolvedKey) || {};
  solved[klotski.level.id] = true;
  klotskiStore(klotskiSolvedKey, solved);
  socket.emit('klotski:win', { level: klotski.level.id, steps: klotski.steps, ms: klotski.ms });
  $('klotski-board').classList.add('won');
  const perfect = moves <= klotski.level.min ? ' · en kısa yol!' : '';
  $('klotski-done-text').textContent = `${moves} hamle · ${fmtClock(Math.round(klotski.ms / 1000) * 1000)}${perfect}`;
  const i = klotskiLevels.indexOf(klotski.level);
  $('klotski-next').hidden = i === klotskiLevels.length - 1;
  setTimeout(() => {
    if (klotski.done) $('klotski-done').hidden = false;
  }, 250);
  renderKlotski();
}

function renderKlotskiStats() {
  if (!klotski) return;
  const ms = klotski.done ? klotski.ms : klotski.start ? Date.now() - klotski.start : 0;
  $('klotski-time').textContent = fmtClock(Math.floor(ms / 1000) * 1000);
  $('klotski-moves').textContent = klotskiMoves();
  $('klotski-min').textContent = klotski.level.min;
  $('klotski-undo').disabled = klotski.done || !klotski.steps.length;
}

function renderKlotski() {
  if (!klotski) return;
  const solved = klotskiStore(klotskiSolvedKey) || {};
  $('klotski-levels').replaceChildren(...klotskiLevels.map((l, i) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'sm ghost' });
    b.append(`${i + 1}. ${l.name}`);
    if (solved[l.id]) b.append(Object.assign(document.createElement('span'), { className: 'ok', textContent: '✓' }));
    b.classList.toggle('active', l === klotski.level);
    b.onclick = () => {
      klotskiLoad(l);
      renderKlotski();
    };
    return b;
  }));
  $('klotski-level-name').textContent = klotski.level.name;
  const best = $('klotski-best');
  best.replaceChildren(...(klotskiRanks[klotski.level.id] || []).map((r, i) => {
    const date = new Date(r.at).toLocaleDateString(I18N.locale, { day: 'numeric', month: 'short' });
    return memoryRankRow(r.name, `${r.moves} hamle`, `${fmtClock(Math.round(r.ms / 1000) * 1000)} · ${date}`, i);
  }));
  if (!best.children.length) best.append(memoryEmpty('Bu bölümü bitiren yok.'));
  renderKlotskiStats();
}

$('klotski-reset').onclick = () => klotski && klotskiLoad(klotski.level);
$('klotski-undo').onclick = () => {
  if (!klotski || klotski.done) return;
  // Son hamlenin tamamı (aynı parçanın art arda adımları) geri alınır
  const k = klotski.steps.at(-1)?.[0];
  while (klotski.steps.length && klotski.steps.at(-1)[0] === k) {
    const [, dx, dy] = klotski.steps.pop();
    klotski.pieces[k].x -= dx;
    klotski.pieces[k].y -= dy;
  }
  klotskiPlace();
  renderKlotskiStats();
};
$('klotski-next').onclick = () => {
  const next = klotskiLevels[klotskiLevels.indexOf(klotski.level) + 1];
  if (next) {
    klotskiLoad(next);
    renderKlotski();
  }
};
socket.on('klotski:board', (board) => {
  klotskiRanks = board;
  renderKlotski();
});

// ---------- Radyo ----------
// Uydu görüntülü dönen bir dünya küresi; noktalar radyo olan yerler (aynı şehirdeki istasyonlar tek nokta).
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
const radioRegionNames = {};
const radioRegions = { of: (cc) => (radioRegionNames[I18N.lang] ||= new Intl.DisplayNames([I18N.lang], { type: 'region' })).of(cc) };
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

// Küre yüklenirken ve yüklenemezse kürenin ortasında not (yükleniyor / hata + Tekrar dene).
function radioGlobeNote(state, text) {
  $('radio-globe-note').hidden = !state;
  $('radio-globe-note').dataset.state = state || '';
  if (text) $('radio-globe-text').textContent = text;
  $('radio-retry').hidden = state !== 'error';
}
$('radio-retry').onclick = () => openRadioPage();

function radioMapReady() {
  if (!radioMapLoading && !radioMap) radioGlobeNote('loading', 'Küre yükleniyor…');
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
              'circle-opacity': 0.9,
              // Çok istasyonlu yerler biraz daha büyük; yakınlaştıkça hepsi büyür
              'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, ['min', 3.2, ['+', 1.4, ['*', 0.12, ['get', 'n']]]], 6, ['min', 8, ['+', 3.5, ['*', 0.25, ['get', 'n']]]]],
            },
          },
          { id: 'selected', type: 'circle', source: 'places', filter: ['==', ['get', 'i'], -1], paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 3.5, 6, 7] } },
          { id: 'playing', type: 'circle', source: 'places', filter: ['==', ['get', 'i'], -1], paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 4, 6, 8], 'circle-stroke-width': 2 } },
        ],
      },
    });
    // Kaynak atfı MapLibre'nin beyaz kutusu yerine kürenin köşesinde temalı yazı (index.html .radio-attrib)
    await new Promise((resolve) => radioMap.once('load', resolve));
    radioPaint();
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
    radioGlobeNote(null);
  })();
  radioMapLoading.catch((err) => {
    radioMapLoading = null;
    radioGlobeNote('error', err.message || 'Harita yüklenemedi.');
  });
  return radioMapLoading;
}

// Küredeki noktaların renkleri temadan. Uydu resmi her temada koyu: yerler --on-media-accent, halkanın seçtiği
// --on-media, çalan yer --live (kenarı --on-media).
function radioPaint() {
  if (!radioMap?.isStyleLoaded()) return;
  const c = (name) => Theme.color(name);
  radioMap.setPaintProperty('places', 'circle-color', c('--on-media-accent'));
  radioMap.setPaintProperty('selected', 'circle-color', c('--on-media'));
  radioMap.setPaintProperty('playing', 'circle-color', c('--live'));
  radioMap.setPaintProperty('playing', 'circle-stroke-color', c('--on-media'));
}
document.addEventListener('themechange', radioPaint);

// Halkanın içine düşen yerlerden merkeze en yakını seçilir; halka boşsa son seçilen kalır.
function radioPickCenter() {
  const { x, y } = radioMap.project(radioMap.getCenter()); // dolgu (radioLayout) hesaba katılır
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
  $('radio-place-sub').textContent = p ? `${radioFlag(p.cc)} ${p.title === p.country ? '' : p.country}`.trim() : 'Halkayı bir noktanın üstüne getir';
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
    fav.setAttribute('aria-label', `${s.name}: ${fav.title}`);
    fav.setAttribute('aria-pressed', String(radioFavs.includes(s.id)));
    fav.innerHTML = '<svg class="ic"><use href="#i-heart"></use></svg>';
    fav.onclick = () => radioToggleFav(s.id);
    li.append(play, fav);
    list.append(li);
  }
  if (!stations.length) {
    // Boş durum: şarkı aramasıyla aynı .empty (ikon + yazı)
    const searched = radioTab === 'search' && $('radio-search').value.trim().length >= 2;
    const [name, text] = searched
      ? ['search', 'Sonuç yok. Başka bir istasyon, şehir ya da ülke dene.']
      : { explore: ['globe', 'Küreyi çevir; halkanın altına gelen yerin radyoları burada listelenir.'], favs: ['heart', 'Henüz favorin yok. Bir istasyonun yanındaki kalple ekle.'], search: ['search', 'En az iki harf yaz.'] }[radioTab];
    const li = Object.assign(document.createElement('li'), { className: 'radio-empty empty', innerHTML: icon(name) });
    li.append(Object.assign(document.createElement('p'), { textContent: text }));
    list.append(li);
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
  const status = { loading: 'Bağlanıyor…', playing: 'Canlı', error: 'Yayın açılmadı' }[radioState] || '';
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
  radioLayout(); // küre yüklenirken de halka ve not panelin sağındaki alanın ortasında
  renderRadioPlayer();
  renderRadioList();
  syncRadioAudio();
  try {
    await radioMapReady();
  } catch {
    return;
  }
  radioMap.resize();
  radioLayout();
}

// Masaüstünde paneller kürenin solunu örter: harita merkezi (ve halka) panelin sağında kalan alanın ortasına kayar.
// Telefonda paneller kürenin altında, kayma yok.
function radioLayout() {
  const side = $('radio').querySelector('.radio-side');
  const off = matchMedia('(max-width: 700px)').matches ? 0 : side.offsetLeft + side.offsetWidth;
  $('radio').style.setProperty('--radio-off', `${off}px`);
  radioMap?.setPadding({ left: off, top: 0, right: 0, bottom: 0 });
}
addEventListener('resize', () => radioPage() && radioLayout());

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
  toast('Bu radyonun yayını açılmadı; başka bir istasyon seç.', 'danger');
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
    for (const b of $('radio').querySelectorAll('.radio-tabs button')) {
      b.classList.toggle('active', b === tab);
      b.setAttribute('aria-selected', String(b === tab));
    }
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
  sayi: {
    title: 'Sayı bulmaca', tab: 'sayi', running: () => Boolean(sayiActive()), last: () => sayi,
    hint: 'İki kişi birbirinin sayısını bulmaya çalışır. Tek başına başlatırsan sayıyı bilgisayar tutar; bot açıksa rakibin bot olur.',
  },
  kelime: {
    title: 'Kelime', tab: 'kelime', running: () => Boolean(kelimeActive()), last: () => kelime,
    hint: 'Biri anlatır, diğerleri bilir; herkes bir kez anlatır. 2-6 kişi (odada daha çok kişi varsa öbürleri izler).',
  },
};

const lobbyButton = (text, cls, onclick) => Object.assign(document.createElement('button'), { type: 'button', className: cls, textContent: text, onclick });
const lobbyEmit = (event, game, extra) => socket.emit(event, { game, ...extra });

function renderLobby(game) {
  const box = $(`lobby-${game}`);
  const def = LOBBY[game];
  if (def.localLobby?.()) return;
  const lobby = lobbies[game];
  box.replaceChildren();
  box.hidden = def.running();
  $(`game-tab-${def.tab}`).classList.toggle('lobby-open', Boolean(lobby) && box.hidden === false);
  $(`game-tab-${def.tab}`).classList.toggle('game-running', box.hidden); // oyunlar sayfasındaki "Oynanıyor" rozeti
  if (box.hidden) return;

  box.classList.remove('hero');
  box.style.removeProperty('--hue');

  // Lobi yokken: ortada oyunun simgesi ve adı, altında oyunun renginde "Oda kur" tuşu, en altta soluk açıklama.
  // Süre tahmininde lobi tek başına oynanan oyunun üstünde durduğundan, biten oyun da ekranda dururken
  // (Kapat'a basılana kadar) sonucu aşağı itmesin diye küçük kalır.
  if (!lobby) {
    box.classList.remove('open');
    const hero = game !== 'race' && !def.last();
    box.classList.toggle('hero', hero);
    box.style.setProperty('--hue', gameInfo(def.tab).hue);
    if (hero) box.append(gameIcon(def.tab, 'lobby-hero-icon'));
    box.append(Object.assign(document.createElement(hero ? 'h2' : 'strong'), { className: 'lobby-title', textContent: def.title }));
    if (!hero) box.append(Object.assign(document.createElement('p'), { className: 'muted small', textContent: def.hint }));
    const row = document.createElement('div');
    row.className = 'lobby-actions';
    row.append(withIcon(lobbyButton('Oda kur', 'primary lobby-start', () => lobbyEmit('lobby:open', game)), 'plus'));
    if (def.last()) row.append(lobbyButton('Aynı ekiple kur', 'ghost lobby-again', () => lobbyEmit('lobby:open', game, { again: true })));
    box.append(row);
    if (hero) box.append(Object.assign(document.createElement('p'), { className: 'lobby-desc', textContent: def.hint }));
    return;
  }

  // Lobi kartı: başlıkta oyunun simgesi, adı, kimin kurduğu ve durum rozeti (tek kişiyse "bekleniyor", fazlaysa
  // "hazır"); altında oyuncular avatar sırası, ayarlar ve eylemler.
  const head = document.createElement('div');
  head.className = 'lobby-head';
  box.append(head);
  box.classList.add('open');
  box.style.setProperty('--hue', gameInfo(def.tab).hue);
  const mine = lobby.players.includes(myName);
  const host = lobby.host === myName;
  // Durum: iki ve üstü kişi "Hazır"; tek kişiyle başlatılabiliyorsa sakin kişi sayısı; başlatılamıyorsa (kelime en az 2)
  // "Oyuncu bekleniyor".
  const n = lobby.players.length;
  const ready = n > 1;
  const canStart = n >= (['kelime', 'yorunge', 'takimada', 'yedikapi'].includes(game) ? 2 : 1);
  const headText = document.createElement('div');
  headText.className = 'lobby-head-text';
  headText.append(Object.assign(document.createElement('strong'), { className: 'lobby-name', textContent: `${def.title} lobisi` }),
    kelimeSmall(ready ? `${n} kişi · ${lobby.host} kurdu` : `${lobby.host} kurdu`));
  head.append(gameIcon(def.tab, 'lobby-head-icon'), headText,
    Object.assign(document.createElement('span'), { className: ready ? 'badge badge-live' : 'badge', textContent: ready ? 'Hazır' : canStart ? `${n} kişi` : 'Oyuncu bekleniyor' }));

  const list = document.createElement('div');
  list.className = 'lobby-players';
  for (const name of lobby.players) {
    const chip = document.createElement('span');
    chip.className = 'lobby-player' + (name === myName ? ' me' : '');
    chip.title = name;
    chip.append(makeAvatar(name), Object.assign(document.createElement('span'), { className: 'lobby-player-name', textContent: name === myName ? `${name} (sen)` : name }));
    if (name === lobby.host) chip.append(kelimeSmall('kurucu'));
    if (name === lobby.opts.narrator) chip.append(withIcon(kelimeSmall('anlatıcı'), 'mic'));
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
  if (def.opts) box.append(...def.opts(lobby, host)); // başka dosyadaki oyunların ayarları (ör. hedef.js)
  if (game === 'sayi') {
    const row = document.createElement('div');
    row.className = 'lobby-opts';
    row.append(kelimeSmall('Basamak:'));
    for (let n = 1; n <= 10; n++) {
      const b = lobbyButton(String(n), 'sm' + (n === lobby.opts.digits ? ' active' : ''), () => lobbyEmit('lobby:opts', game, { digits: n }));
      b.disabled = !host;
      row.append(b);
    }
    box.append(row);
  }
  if (game === 'kelime') {
    const row = document.createElement('div');
    row.className = 'lobby-opts';
    const seat = lobby.opts.narrator;
    if (seat) {
      row.append(withIcon(kelimeSmall(`İlk anlatıcı: ${seat}`), 'mic'));
      if (mine && (seat === myName || seat === BOT_NAME)) row.append(lobbyButton('Bırak', 'sm ghost', () => lobbyEmit('lobby:opts', game, { narrator: null })));
    } else {
      if (mine) row.append(withIcon(lobbyButton('İlk ben anlatayım', 'sm', () => lobbyEmit('lobby:opts', game, { narrator: 'me' })), 'mic'));
      if (mine && lobby.players.includes(BOT_NAME)) row.append(lobbyButton('Bot anlatsın', 'sm', () => lobbyEmit('lobby:opts', game, { narrator: 'bot' })));
      row.append(kelimeSmall(`Kimse seçmezse ${lobby.host} anlatır.`));
    }
    box.append(row);
  }

  const actions = document.createElement('div');
  actions.className = 'lobby-actions';
  if (host) {
    const start = withIcon(lobbyButton(`Başlat (${lobby.players.length} kişi)`, 'primary', () => lobbyEmit('lobby:start', game)), 'play');
    if (['yorunge', 'takimada', 'yedikapi'].includes(game)) start.disabled = !canStart;
    actions.append(start);
    actions.append(withIcon(lobbyButton('Lobiden çık', 'ghost', () => lobbyEmit('lobby:leave', game)), 'logout'));
    actions.append(lobbyButton('Lobiyi kapat', 'ghost danger', () => lobbyEmit('lobby:cancel', game)));
  } else if (mine) {
    actions.append(withIcon(lobbyButton('Lobiden çık', 'ghost', () => lobbyEmit('lobby:leave', game)), 'logout'));
    actions.append(kelimeSmall(`${lobby.host} başlatınca oyun bu ekiple başlar.`));
  } else if (lobby.max && n >= lobby.max && !lobby.players.includes(BOT_NAME)) {
    // Dolu lobi (ör. kelime 6 kişilik): düğme kapalı, nedeni yazılı; oyunu izleyebilir
    const b = withIcon(lobbyButton('Lobi dolu', 'primary', null), 'users');
    b.disabled = true;
    actions.append(b, kelimeSmall(`${def.title} en fazla ${lobby.max} kişiyle oynanır; bu oyunu izleyebilirsin.`));
  } else {
    actions.append(withIcon(lobbyButton('Lobiye katıl', 'primary', () => lobbyEmit('lobby:join', game)), 'plus'));
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
  setIcon($('bot-toggle'), 'bot', on ? 'Bot var · çıkar' : 'Bot ekle');
  $('bot-toggle').classList.toggle('on', on);
  renderKelime();
  renderLobbies();
}
$('bot-toggle').onclick = () => socket.emit('bot:set', !botOn);
socket.on('bot', setBot);

// ---------- Oyun öner ----------
// İstenen oyun adım adım anlatılır. Yazılanlar bu cihazda taslak olarak durur; gönderilince herkese
// görünen listeye düşer, site sahibi eklenip eklenmeyeceğine karar verir (durum sunucudaki kayıttan gelir).

const PLAYERS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']; // oda en fazla 10 kişi
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
    title: 'Oyuncular', head: 'Kimler, nasıl oynuyor?', intro: 'Odada en fazla 10 kişi olabiliyor (iki oda birleşince 20).',
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
      b.dataset.value = opt;
      b.className = onerDraft[f.key] === opt ? 'active' : '';
      b.onclick = () => {
        onerDraft[f.key] = onerDraft[f.key] === opt ? '' : opt; // seçiliye tekrar basınca kalkar
        saveOnerDraft();
        for (const x of chips.children) x.classList.toggle('active', onerDraft[f.key] === x.dataset.value);
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
    const date = new Date(o.at).toLocaleDateString(I18N.locale, { day: 'numeric', month: 'short' });
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
  $('dino-help').innerHTML = I18N.t('<b>W</b> / <b>↑</b> / boşluk: zıpla · <b>S</b> / <b>↓</b>: eğil (havadayken hızlı iner). '
    + 'Hız otomatik ve gitgide artar; herkes kusursuz koşan Jef\'in arkasında koşar. Engele çarpan ölür, en uzağa giden kazanır. '
    + 'Gökten inen <b class="dino-bird-word">turuncu kuş sürüsü</b>nün altından koşarak geç; zıplarsan çarparsın.');
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
  jef.prepend(rankCell(-1, '🤖'));
  list.append(jef);
  // Taç ve sarı sıralar yalnız koşu bitince, birinci tekse (eskiden 🏆 yalnız kazanana çıkıyordu)
  const sole = rows.length > 1 && rows[0][1].dist > 0 && rows[0][1].dist !== rows[1][1].dist;
  rows.forEach(([name, p], i) => {
    const won = game.done && i === 0 && rows.length > 1;
    const row = timingRow(name, `${Math.round(p.dist / 10)} m`, p.dead ? (won ? 'Kazandı' : 'Öldü') : 'Koşuyor', won ? 'great' : '');
    row.classList.toggle('winner', won);
    row.prepend(rankCell(i, i + 1, game.done && sole));
    list.append(row);
  });
}

// Kalıcı skor tablosu: en iyi 10 skor. Eski modların (basılı tut, tıklama) skorları kayıtta durur, gösterilmez.
function renderDinoBoard(board) {
  const list = $('dino-board');
  list.replaceChildren();
  (board?.auto || []).forEach((r, i) => {
    const date = new Date(r.at).toLocaleDateString(I18N.locale, { day: 'numeric', month: 'short' });
    const row = timingRow(r.name, `${Math.round(r.dist / 10)} m`, date, i === 0 ? 'great' : '');
    row.prepend(rankCell(i));
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

// Tuvalin arayüz renkleri (zemin çizgisi, yazılar) ve yazı tipi temadan; dinozorlar, kaktüs ve kuşlar oyun içeriği.
const dinoUi = (name) => Theme.color(name);
const dinoFont = (weight, px) => `${weight} ${px}px ${Theme.color('--font-body') || 'system-ui, sans-serif'}`;
// Tema değişince (oyun durmuşken de) son kare yeni renklerle yeniden çizilir.
document.addEventListener('themechange', () => {
  if (!dinoLoop) requestAnimationFrame(() => drawDino(Boolean(dinoGame)));
});

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
  ctx.fillStyle = dinoUi('--border-strong');
  ctx.fillRect(0, DINO.groundY, DINO.viewW, 2);
  ctx.fillStyle = dinoUi('--border');
  for (let gx = Math.floor(left / 37) * 37; gx < left + DINO.viewW; gx += 37) {
    const n = Math.abs(Math.sin(gx * 12.9898) * 43758.5453) % 1;
    ctx.fillRect(sx(gx + n * 30), DINO.groundY + 6 + Math.floor(n * 3) * 6, 3 + n * 6, 2);
  }

  if (!dinoGame) {
    ctx.fillStyle = dinoUi('--muted');
    ctx.font = dinoFont(600, 16);
    ctx.textAlign = 'center';
    ctx.fillText(I18N.t('Lobi kur, birlikte Jef\'in peşinden koşun'), DINO.viewW / 2, 100);
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
  ctx.fillStyle = dinoUi('--text');
  ctx.font = dinoFont(600, 12);
  ctx.textAlign = 'center';
  ctx.fillText(name, x + w / 2, y - 6 - lift);
  ctx.globalAlpha = 1;
}

// Üstte: mesafe, hız; başta geri sayım, sonda durum
function drawDinoHud(ctx, started) {
  ctx.fillStyle = dinoUi('--muted');
  ctx.font = dinoFont(600, 14);
  ctx.textAlign = 'right';
  if (dinoMe) {
    const live = dinoMe.dead || dinoGame.done ? "" : I18N.t(` · hız ${Math.round(dinoMe.vx / 10)}`);
    ctx.fillText(`${Math.round(dinoJefX(dinoMe.t) / 10)} m${live}`, DINO.viewW - 14, 24);
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = dinoUi('--text');
  if (!started) {
    ctx.font = dinoFont(800, 64);
    ctx.fillText(Math.ceil((dinoGame.startAt - serverNow()) / 1000), DINO.viewW / 2, 120);
  } else if (dinoGame.done) {
    ctx.font = dinoFont(800, 32);
    ctx.fillText(I18N.t('Oyun bitti'), DINO.viewW / 2, 110);
  } else if (dinoMe?.dead) {
    ctx.font = dinoFont(700, 24);
    ctx.fillText(I18N.t('Öldün, diğerlerini izliyorsun'), DINO.viewW / 2, 110);
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
    const time = new Date(ts).toLocaleTimeString(I18N.locale, { hour: '2-digit', minute: '2-digit' });
    li.append(text, ` · ${time}`); // saat ayrı düğüm: sistem mesajı dil sözlüğünden çevrilebilsin
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
  who.translate = false;
  const when = document.createElement('span');
  when.className = 'when';
  when.textContent = new Date(ts).toLocaleTimeString(I18N.locale, { hour: '2-digit', minute: '2-digit' });
  const body = document.createElement('div');
  body.className = 'text';
  body.translate = false; // kullanıcının yazdığı mesaj çevrilmez
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
    img.onerror = () => {
      const note = Object.assign(document.createElement('span'), { className: 'notice chat-img-missing', innerHTML: icon('image') });
      note.append(Object.assign(document.createElement('span'), { textContent: 'Resim yüklenemedi' }));
      img.replaceWith(note);
    };
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

// Sohbet en alttayken alanı değişirse (klavye açıldı, panel yeniden göründü, pencere küçüldü) en altta kalır.
let chatAtBottom = true;
$('chat-list').addEventListener('scroll', () => {
  const list = $('chat-list');
  if (list.clientHeight) chatAtBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
});
new ResizeObserver(() => {
  const list = $('chat-list');
  if (chatAtBottom && list.clientHeight) list.scrollTop = list.scrollHeight;
}).observe($('chat-list'));

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
  if (!msg.system && msg.from !== selfId && !chatVisible()) setUnread(true);
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
// Temaya özel hızlı emoji satırı (yoksa yukarıdaki); tema değişince satır yeniden yazılır.
const THEME_QUICK_EMOJIS = { kis: ['❄️', '⛄', '🥶', '☕', '🔥', '❤️', '😂', '💀'] };
function renderQuickEmojis() {
  const list = THEME_QUICK_EMOJIS[Theme.current()] || QUICK_EMOJIS;
  $('quick-emojis').replaceChildren(...list.map((emoji) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = emoji;
    btn.onclick = () => socket.emit('chat', emoji);
    return btn;
  }));
}
renderQuickEmojis();
document.addEventListener('themechange', renderQuickEmojis);

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
    try {
      const mine = audioCtx.createMediaStreamSource(sendStream);
      mine.connect(limiter);
      recCleanup.push(() => mine.disconnect());
    } catch (err) {
      console.warn('kendi sesin kayda eklenemedi', err);
    }
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

// quiet: sunucuya bildirilmez (oda değişti; yeni odadakilere "kaydı durdurdu" gitmesin).
function stopRecording({ quiet = false } = {}) {
  if (!recorder) return;
  recorder.stop();
  recorder = null;
  recCleanup.splice(0).forEach((fn) => fn());
  clearInterval(recTimer);
  if (!quiet) socket.emit('rec', false);
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
  $('rec-banner').textContent = `Kayıt: ${names.join(', ')}`;
  $('rec-banner').title = `Kayıt yapılıyor: ${names.join(', ')}`;
  for (const peer of peers.values()) renderPersonState(peer.row, { recording: peer.recording });
  renderPersonState(selfRow, { recording: Boolean(recorder) });
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
$('rec-format').querySelector('[value=native]').textContent = `${REC_EXT.toUpperCase()} (daha küçük dosya)`;
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
          // Oynatıcı yalnız bizim düğmelerle yönetilir (fare için .player-shield); klavye de içine girmesin
          player.getIframe().tabIndex = -1;
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

// Amuda kalkan eşek: yönetici çıkarınca odadaki herkesin ekranında ortada belirir (public/esek.js).
// three.js büyük olduğundan ilk gösteride yüklenir (yöneticide düğme görününce önceden).
let esekModule = null;
const loadEsek = () => (esekModule ||= import('/esek.js'));
socket.on('esek', (data) => {
  loadEsek()
    .then((m) => m.showDonkey(data))
    .catch((err) => console.warn('eşek gösterilemedi', err));
});
$('esek-btn').onclick = () => socket.emit('esek:show');

function applyMedia() {
  if (!playerReady || !media) return;
  if (isX(media.current?.videoId) && !xVideo) return void xReady.then(applyMedia);
  const cur = media.current;

  $('player-empty').hidden = Boolean(cur);
  $('now-title').textContent = cur ? cur.title : 'Şu an bir şey çalmıyor';
  $('now-title').classList.toggle('muted', !cur);
  $('now-by').textContent = cur ? `${cur.by} ekledi` : '';
  setIcon($('play-toggle'), media.playing ? 'pause' : 'play');
  $('loop').setAttribute('aria-pressed', String(Boolean(cur && media.loop)));
  $('loop').disabled = !cur;
  $('loop').title = media.loop ? 'Döngüyü kapat' : 'Bu videoyu tekrarla';

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
  // Resim yoksa ya da gelmezse aynı boyda sakin bir yer tutucu (müzik ikonu)
  const missing = () => {
    const box = Object.assign(document.createElement('span'), { className: 'thumb thumb-missing', innerHTML: icon('music') });
    if (img.isConnected) img.replaceWith(box);
    return box;
  };
  if (!img.getAttribute('src')) return missing();
  img.onerror = missing;
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
  paintRange($('seek'));

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
$('loop').onclick = () => media?.current && socket.emit('media:loop', !media.loop);

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
  paintRange($('seek'));
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
    setTimeout(renderSfxLock, 600);
  };
  btn.disabled = Boolean(modMuted);
  return btn;
}

// Susturulan kişi ses efekti de çalamaz ve yükleyemez (sunucu da reddeder): düğmeler kapalı, nedeni yazılı.
const SFX_LOCKED = 'Susturuldun; susturman kalkana kadar ses efekti çalamaz ve yükleyemezsin.';
function renderSfxLock() {
  const locked = Boolean(modMuted);
  for (const b of document.querySelectorAll('.sfx-btn')) {
    b.disabled = locked;
    if (locked) b.dataset.title ??= b.title;
    b.title = locked ? SFX_LOCKED : b.dataset.title ?? b.title;
  }
  $('sfx-file').disabled = locked;
  $('sfx-label').disabled = locked;
  $('sfx-upload').classList.toggle('is-locked', locked);
  $('sfx-locked').hidden = !locked;
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
  await Promise.all(list.map((fx) => Sfx.addCustom(audioCtx, fx.id, `/sfx-custom/${encodeURIComponent(roomCode)}/${fx.id}`).catch(() => {})));
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

// Arama durumu sonuç listesinin içinde: sonuç yoksa boş durum, hata varsa kırmızı not.
function searchNote(kind, text) {
  const li = document.createElement('li');
  const failed = kind === 'error';
  li.className = failed ? 'notice notice-danger search-note' : 'empty search-note';
  li.innerHTML = failed ? icon('alert') : icon('search');
  li.append(Object.assign(document.createElement('p'), { textContent: text }));
  $('search-results').append(li);
}

async function searchYouTube(q) {
  $('search-box').hidden = false;
  $('search-label').replaceChildren(Object.assign(document.createElement('span'), { className: 'spinner' }), ` "${q}" aranıyor…`);
  $('search-results').replaceChildren();
  let data;
  try {
    const res = await fetch(`/search?q=${encodeURIComponent(q)}`);
    data = await res.json();
  } catch {
    data = { error: 'Arama yapılamadı.' };
  }
  if (data.error) {
    $('search-label').textContent = `"${q}" araması`;
    searchNote('error', data.error);
    return;
  }
  $('search-label').textContent = data.results.length ? `"${q}" için sonuçlar` : `"${q}" araması`;
  if (!data.results.length) searchNote('empty', 'Sonuç yok. Başka bir şey dene ya da linki yapıştır.');
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
// Giriş yapılmamışsa giriş ekranı; giriş yapınca oda listesi (public/lobby.js); karta basınca oda.

let roomId = null;   // soketin bulunduğu oda (adresteki id); odaya girilince dolar
let roomCode = null; // soketin bulunduğu canlı oda (roomId ile aynı); efekt adresleri bundan
let homeId = null;   // kişinin kendi odası: birleşik odada misafir kökenlinin odası; yeniden bağlanma buna girer
let curRoom = null;  // soketin bulunduğu odanın görünümü { id, name, owner, locked, theme, users, max, mergedWith, role }
let curHome = null;  // kendi odasının görünümü (birleşik değilse curRoom ile aynı oda); oda ayarları bunu değiştirir
// genel odasının yerel şarkı geçmişi eski anahtarında kalır; öteki odalar kendi anahtarında.
const historyKey = () => (roomId === 'genel' ? 'history' : `history:${roomId}`);

// ---------- Hesap ----------
// Giriş yapınca sunucunun verdiği oturum anahtarı tarayıcıda saklanır; çıkış yapılana kadar
// bir daha şifre sorulmaz.

let authToken = '';
let account = null; // { name, avatar, admin }
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
  if (!account) return;
  setProfile(account.name, account.avatar);
  $('account-name').textContent = account.name;
  $('account-avatar').replaceChildren(makeAvatar(account.name));
  // Ayarlar penceresindeki profil bölümü ve üst çubuktaki küçük avatar
  $('profile-name').textContent = account.name;
  $('profile-avatar').replaceChildren(makeAvatar(account.name));
  $('topbar-avatar').replaceChildren(makeAvatar(account.name));
  $('esek-btn').hidden = !account.admin;
  for (const id of ['avatar-change', 'profile-change']) {
    const label = $(id).querySelector('.label') || $(id); // liste penceresinde ikonun yanındaki yazı
    label.textContent = account.avatar ? 'Resmi değiştir' : 'Resim ekle';
  }
  for (const id of ['avatar-remove', 'profile-remove']) $(id).hidden = !account.avatar;
}

function setAuthMode(mode) {
  authMode = mode;
  $('auth-login').classList.toggle('active', mode === 'login');
  $('auth-register').classList.toggle('active', mode === 'register');
  $('auth-login').setAttribute('aria-selected', String(mode === 'login'));
  $('auth-register').setAttribute('aria-selected', String(mode === 'register'));
  $('join-btn').textContent = mode === 'login' ? 'Giriş yap' : 'Kayıt ol';
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

// Oturum düştü: giriş ekranına dönülür. Soket eski hesaba bağlı kaldığı için kapatılır; yeni giriş yeni soket açar.
function signedOut(error) {
  saveToken('');
  account = null;
  socket.disconnect();
  Lobby.hide();
  Lobby.reset();
  $('room-screen').hidden = true;
  applyTheme(Theme.DEFAULT); // giriş ekranı her zaman varsayılan tema
  $('join-screen').hidden = false;
  if (error) showJoinError(error);
}

// Çıkış: sayfa listenin adresinde yeniden açılır (giriş ekranı). Soket önce kapatılır: sunucu çıkış yapan
// oturumun soketini keser, açık kalırsa giriş ekranı "Oturumun kapatıldı" hatasıyla açılırdı.
async function logout() {
  socket.disconnect();
  await api('POST', '/auth/logout');
  saveToken('');
  location.assign('/');
}
$('logout').onclick = logout;

$('sign-out').onclick = async () => {
  socket.disconnect();
  Sfx.leave(audioCtx, sfxBus);
  await Promise.all([api('POST', '/auth/logout'), new Promise((r) => setTimeout(r, 600))]); // çıkış sesi bitsin
  saveToken('');
  location.assign('/');
};

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
  .then(({ online }) => {
    $('room-status').textContent = online ? `Şu an sitede ${online} kişi var.` : 'Şu an sitede kimse yok.';
    $('room-status').parentElement.classList.toggle('is-live', online > 0);
  })
  .catch(() => {});

$('join-form').onsubmit = async (e) => {
  e.preventDefault();
  const btn = $('join-btn');
  btn.disabled = true;
  $('join-error').hidden = true;
  if (await signIn()) openLobby();
  btn.disabled = false;
};

// ---------- Oda listesi ----------
// Liste açılınca soket bağlanır ve hello ile hesaba bağlanır; aynı soket sonra odaya girerken (join) kullanılır.
// Kayıtlı oturumla açılışta liste beklenmez: oturum belirteci belliyse /rooms isteği ve soket bağlantısı,
// /auth/me ile aynı anda başlar (açılış, aşağıda). Liste gelene kadar Lobby iskelet kartlar gösterir.

function openLobby() {
  applyTheme(Theme.DEFAULT); // oda listesi her zaman varsayılan tema; odanın teması yalnız odada
  $('join-screen').hidden = true;
  renderAccount();
  Lobby.show();
  helloLobby();
}

async function helloLobby() {
  // Bağlı ya da yeniden bağlanırken connect çağrılmaz: aynı bağlantıda ikinci bağlanma paketi sunucuyu koparır.
  if (!socket.active) socket.connect();
  // Ücretsiz sunucu uykudaysa uyanması yarım dakikayı bulabilir.
  const res = (await emitAck(45000, 'hello', { token: authToken })) ?? {
    error: 'Sunucuya bağlanılamadı. İnternetini kontrol edip tekrar dene.',
  };
  if (res.auth) return signedOut(res.error);
  if (res.error) {
    Lobby.failed(res.error); // liste hiç gelmediyse listenin yerinde hata notu
    return toast(res.error);
  }
  Lobby.update({ rooms: res.rooms, pending: res.pending });
}
socket.on('rooms', ({ rooms } = {}) => {
  if (!Array.isArray(rooms)) return;
  Lobby.update({ rooms });
  if (!curRoom) syncRoomSettings(rooms); // listeden açılan ayarlar penceresi canlı
});
socket.on('room-request', ({ pending } = {}) => Lobby.update({ pending }));
socket.on('room-request:decided', ({ status, name } = {}) => status && Lobby.update({ decided: { status, name } }));

// ---------- Odaya giriş ----------
// Oda kartına (ya da şifre penceresindeki düğmeye) basınca çağrılır: ses altyapısı ve mikrofon izni
// kullanıcı hareketi içinde açılmalı. Cevap (hata dahil) listeye döner; hata varsa mikrofon bırakılır.

let sfxLoaded = null;
let entering = false;

function releaseMic() {
  localStream?.getTracks().forEach((t) => t.stop());
  micSource?.disconnect();
  if (gateNode) {
    gateNode.port.onmessage = null;
    gateNode.disconnect();
  }
  localStream = sendStream = gateNode = micSource = null;
  hideMicNote();
  $('mic-toggle').disabled = false;
  $('gate-btn').hidden = false;
}

async function enterRoomFlow(id, password) {
  if (entering || selfId) return { error: 'Odaya giriliyor…', busy: true };
  entering = true;
  try {
    return await enterRoom(id, password);
  } finally {
    entering = false;
  }
}

async function enterRoom(id, password) {
  const { name } = account;
  myName = name;

  setupAudio();
  audioCtx.resume();
  sfxLoaded ||= Sfx.load(audioCtx);

  try {
    localStream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    watchMicTrack();
  } catch (err) {
    console.warn('mikrofon açılamadı', err);
    localStream = null;
    showMicNote(err);
    $('mic-toggle').disabled = true;
    $('gate-btn').hidden = true;
  }
  if (localStream) await setupMic();

  if (!iceServers.length) {
    try {
      const config = await fetch('/config').then((r) => r.json());
      iceServers = config.iceServers;
      setSearchEnabled(config.search);
    } catch {
      iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    }
  }
  if (!socket.active) socket.connect(); // listede bağlanmıştı; oturum düşüp yeniden girildiyse yeniden bağlanır
  const res = (await emitAck(45000, 'join', { room: id, password, token: authToken, clientId })) ?? {
    error: 'Sunucuya bağlanılamadı. İnternetini kontrol edip tekrar dene.',
  };

  if (res.error) {
    releaseMic();
    if (res.auth) signedOut(res.error);
    return res;
  }

  setRoomInfo(res);
  Lobby.hide();
  $('room-screen').hidden = false;
  paintRanges();
  renderViewport();

  const selfRow = personRow(name, true);
  setStatus(selfRow, localStream ? 'Sen' : 'Sadece dinleyici');
  watchSelfLevel();
  renderMic();
  renderPeopleCount();
  startUsageMeter();

  applyJoin(res);
  // Yenilenen ya da linkle açılan sayfa adresteki ekranda açılır; listeden girilince odanın adresi geçmişe eklenir.
  // Birleşik misafir odaya girildiyse (soket ev sahibi odada) adres ev sahibi odanın id'sini alır.
  const here = pathView(location.pathname);
  const sameRoom = (room) => room === id || room === roomId;
  applyView(sameRoom(history.state?.room) ? history.state : sameRoom(here.room) ? here : { room: roomId, page: 'room', tab: 'queue', game: 'home', list: null });
  if (sameRoom(here.room)) history.replaceState(currentView(), '', viewPath(currentView()));
  else history.pushState(currentView(), '', viewPath(currentView()));
  sfxLoaded.then(() => Sfx.join(audioCtx, sfxBus));

  // YouTube yüklenemese de oda çalışır; oynatıcı hazır olunca video başlar.
  Promise.all([syncClock(), createPlayer()]).then(applyMedia);
  return res;
}

// Sunucudan gelen oda durumunu uygular: ilk girişte ve bağlantı kopup geri gelince.
function applyJoin(res) {
  selfId = res.id;
  roomEpoch = res.epoch ?? null;
  for (const id of [...peers.keys()]) removePeer(id);
  // Bağlantıları hemen kur: odadakiler de bize teklif gönderiyor, gecikirsek kaybolur.
  for (const p of res.peers) {
    addPeer(p.id, p.name, p).recording = p.recording;
    createPc(p.id);
  }
  setModMuted(res.modMuted || null);
  setRoomColor(myName, res.color);
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
  memoryRanks = res.memoryBoard || memoryRanks;
  if (res.klotski) setKlotskiLevels(res.klotski);
  setMemory(res.memory);
  setSayi(res.sayi);
  setHedef(res.hedef); // public/hedef.js
  setHedefRecords(res.hedefBoard);
  LOBBY.takimada?.sync(res.takimada, Object.hasOwn(res, 'takimada'));
  LOBBY.yedikapi?.sync(res.yedikapiInventory ? res.yedikapi : null, res.yedikapiInventory === true);
  window.setYorunge?.(res.yorunge, Object.hasOwn(res, 'yorunge'));
  window.setKural?.(res.kural); // public/kural.js
  setMantik(res.mantik); // public/mantik.js
  setDaktilo(res.daktilo); // public/daktilo.js
  setDaktiloBoard(res.daktiloBoard);
  window.setXox?.(res.xox); // public/xox.js (yüklenemediyse giriş bozulmasın)
  window.setDorttas?.(res.dorttas); // public/dorttas.js
  window.setDuvar?.(res.duvar); // public/duvar.js
  window.setBesharf?.(res.besharf); // public/besharf.js
  window.setKart?.(res.kart); // public/kart.js
  setRadio(res.radio);
  lobbies = res.lobbies || {};
  renderLobbies();
  renderTiming();
  media = res.media;
  renderQueue();
  applyMedia();
}

// ---------- Oda bilgisi, oda değiştirme ----------
// join cevabı ve room:moved { room, home } taşır. room: soketin bulunduğu oda, home: kişinin kendi odası
// (birleşik odada misafir kökenli için misafir oda). Adres ve üst çubuk room'u gösterir.

const roomNames = new Map(); // oda id -> ad (birleşik odanın adını göstermek için; GET /rooms'tan)
const canManage = (view) => ['owner', 'admin'].includes(view?.role);

// Birleşik odada misafir kökenlinin adresi ev sahibi odayı gösterir. Sekme yenilenince listede adresteki
// oda değil kendi odası seçili gelsin (public/lobby.js); sunucu birleşikse yine ev sahibi odaya yerleştirir,
// kökeni korunur (ayrılınca kendi odasına döner).
const HOME_KEY = 'roomHome';
function homeAfterReload(id) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(HOME_KEY));
    if (saved?.room === id && pathView(location.pathname).room === id && typeof saved.home === 'string') return saved.home;
  } catch {}
  return id;
}

function setRoomInfo(res) {
  curRoom = res.room;
  curHome = res.home || res.room;
  roomRoles.set(curRoom.id, curRoom.role);
  roomRoles.set(curHome.id, curHome.role);
  roomId = roomCode = curRoom.id;
  homeId = curHome.id;
  try {
    sessionStorage.setItem(HOME_KEY, JSON.stringify({ room: roomId, home: homeId }));
  } catch {}
  roomNames.set(curRoom.id, curRoom.name);
  roomNames.set(curHome.id, curHome.name);
  applyTheme(curRoom.theme); // birleşik odada ev sahibi odanın teması; ayrılınca kendi odasınınki
  renderRoomInfo();
  if (curRoom.mergedWith && !roomNames.has(curRoom.mergedWith)) refreshRoomView();
}

function renderRoomInfo() {
  if (!curRoom) return;
  document.title = `${curRoom.name} · Sesli Oda`;
  $('topbar-room').textContent = curRoom.name;
  $('topbar-room').title = curRoom.name;
  if (window.Lobby?.emblem) $('topbar-emblem').replaceChildren(Lobby.emblem(curRoom));
  $('topbar-lock').hidden = !curRoom.locked;
  const other = curRoom.mergedWith;
  $('topbar-merged').hidden = !other;
  $('topbar-merged').innerHTML = other ? '<span aria-hidden="true">⇄</span><span class="topbar-merged-name"></span>' : '';
  if (other) $('topbar-merged').lastChild.textContent = roomNames.get(other) || other;
  $('topbar-merged').title = other ? `${roomNames.get(other) || other} ile birleşik` : '';
  $('room-settings-open').hidden = $('room-settings-top').hidden = !canManage(curHome);
  renderPeopleCount();
}

// Odaların güncel görünümü (soket odadayken rooms olayı gelmez); ayarlar penceresi ve bilinmeyen oda adı için.
async function refreshRoomView() {
  const res = await api('GET', '/rooms');
  if (res.error || !curRoom) return null;
  for (const r of res.rooms) {
    roomNames.set(r.id, r.name);
    roomRoles.set(r.id, r.role);
  }
  renderModButtons();
  curRoom = res.rooms.find((r) => r.id === curRoom.id) || curRoom;
  curHome = res.rooms.find((r) => r.id === curHome.id) || curHome;
  renderRoomInfo();
  return res.rooms;
}

// Birleşme başladı ya da bitti (ev sahibi odadakilere; taşınanlar ayrıca room:moved alır).
socket.on('room:merge', ({ mergedWith = null, name = null } = {}) => {
  if (!curRoom) return;
  if (mergedWith && name) roomNames.set(mergedWith, name);
  curRoom.mergedWith = mergedWith;
  if (curHome?.id === curRoom.id) curHome.mergedWith = mergedWith;
  renderRoomInfo();
  if (mergedWith) refreshRoomView(); // birleşen odanın sahibi de olabilirim (susturma yetkisi)
});

// Odanın teması değişti: odadaki herkes sayfa yenilenmeden yeni temaya geçer (Theme.apply yazı tipi, renk ve
// ikonları birlikte değiştirir; JS'te çizilenler 'themechange' ile yeniden çizilir). Sunucu olayı yalnız o
// odanın soketlerine gönderir. Birleşikken misafirler ev sahibi odadadır: kendi (misafir) odalarının teması
// değişirse onlara olay gelmez; ayrılınca room:moved odanın güncel temasını getirir ve o uygulanır.
// Bir odanın sahibi değişti (bu oda ya da birleşik odanın öteki yarısı): roller (Sustur düğmeleri, oda ayarları
// düğmesi) yeniden alınır. Sunucu yalnız o odanın ve ev sahibi odanın soketlerine gönderir.
socket.on('room:roles', () => {
  if (curRoom) refreshRoomView();
});

socket.on('room:theme', ({ id, theme } = {}) => {
  if (!curRoom || typeof theme !== 'string') return;
  const roomOf = id || curRoom.id;
  if (curRoom.id !== roomOf) return;
  curRoom.theme = theme;
  if (curHome?.id === roomOf) curHome.theme = theme;
  applyTheme(theme);
  if ($('room-settings').open && settingsRoom?.id === roomOf) {
    settingsRoom.theme = theme;
    renderRoomSettings();
  }
});

// Odadan kalan her şeyi temizler (oda değişirken): eş bağlantıları, ekran paylaşımı, kayıt, sohbet,
// sıra, geçmiş, tier listler, oyunlar, lobiler, radyo. Mikrofon akışı ve AudioContext kalır.
// Ardından applyJoin yeni odayı doldurur.
function resetRoomState() {
  setUnread(false);
  stopScreen({ quiet: true });
  stopRecording({ quiet: true });
  for (const id of [...peers.keys()]) {
    removePeer(id); // user-left temizliği
    renderRecBanner();
  }
  sharerId = null;
  renderScreen();
  if ($('room-settings').open) $('room-settings').close(); // birleşme penceresi odadan bağımsız, açık kalır
  for (const pop of document.querySelectorAll('#room-screen .pop:popover-open')) pop.hidePopover();
  $('chat-list').replaceChildren();
  $('chat-empty').hidden = false;
  playHistory = [];
  renderHistory();
  media = null;
  clearTimeout(nudgeTimer);
  nudgeBase = null;
  seeking = false;
  stalled = buffering = 0;
  $('seek').value = $('seek').max = 0; // yeni odada bir şey çalmıyorsa eski şarkının süresi kalmasın
  paintRange($('seek'));
  $('time-cur').textContent = $('time-dur').textContent = fmtTime(0);
  openListId = null;
  selectedCard = null;
  drag = null;
  setTierLists([]);
  timingRun = timingLast = raceLocal = null;
  clearInterval(raceTicker);
  raceTicker = 0;
  raceShown = '';
  setKelime(null);
  setMemory(null);
  setSayi(null);
  setHedef(null);
  for (const key of ['takimada', 'yedikapi']) LOBBY[key]?.sync(null, true);
  window.setYorunge?.(null);
  window.setKural?.(null);
  setMantik(null);
  setDaktilo(null);
  window.setKart?.(null);
  window.setXox?.(null);
  window.setDorttas?.(null);
  setDino(null);
  Chip.stop();
  setRadio(null);
  lobbies = {};
  renderLobbies();
}

// Oda değişince ekran yeni odanın adresine geçer: sayfa (oda/oyunlar/radyo) korunur, açık oyun ve liste kapanır.
function showRoomView() {
  applyView({ ...currentView(), room: roomId, game: 'home', list: null });
  history.replaceState(currentView(), '', viewPath(currentView()));
}

// Birleşme (misafir odadakiler ev sahibi odaya) ya da ayrılma (kendi odasına dönüş): sayfa yenilenmez.
// Hedef oda doluysa sunucu room:moved yerine kicked gönderir (listeye dönülür).
socket.on('room:moved', (res = {}) => {
  if (!selfId || !res.room || res.error) return;
  resetRoomState();
  setRoomInfo(res);
  applyJoin(res);
  if (!micOn) socket.emit('mute', true);
  showRoomView();
  syncClock().then(applyMedia);
  toast(res.reason === 'split' ? 'Odalar ayrıldı' : `Odalar birleşti: ${res.room.name}`);
});

// ---------- Oda ayarları ----------
// Odanın içinden (yalnız kendi odasında sahip ya da yöneticiyse) ve oda listesindeki kartın ayar düğmesinden
// (sahip kendi odasında, site yöneticisi her odada; lobby.js onManage) aynı pencere açılır. Yetkiyi yine sunucu
// denetler. Tema listesi oda isteği formundaki seçeneklerden gelir.

let settingsRoom = null; // pencerenin değiştirdiği oda (odada curHome; listede kartın odası)
let rsList = null; // son oda listesi (birleşme hedefleri)
let rsShown = null; // yönetim alanlarına son yazılan ad ve sahip: kullanıcı değiştirdiyse canlı güncelleme ezmez
let rsClosing = null; // bu pencereden kapatılmakta olan oda (liste güncellemesi ikinci bildirim göstermesin)
let rsOpener = null;  // listede pencereyi açan ayar düğmesinin oda id'si (kapanınca odak oraya döner)
let rsThemePending = null; // ayarlar penceresinde seçilmiş ama henüz uygulanmamış tema
let rsThemeSaving = false;

// Tema dosyası yüklenemezse önceki tema kalır (Theme.apply); kullanıcıya söylenir.
// Aynı yükleme için birden çok çağrı (ayar kaydı + room:theme) tek bildirim gösterir: ekranda bir tema hatası
// bildirimi varken yenisi eklenmez. quiet: bildirimi çağıran gösterir.
const isThemeFail = (t) => /yüklenemedi[;,] (bu cihazda )?önceki görünüm|bu cihazda yüklenemedi|could not load|previous look/i.test(t.textContent);
const themeFailShown = () => [...$('toasts').children].some(isThemeFail);
function applyTheme(id, { quiet = false } = {}) {
  return Theme.apply(id).then((ok) => {
    if (!ok && !quiet && !themeFailShown()) toast('Tema yüklenemedi; önceki görünüm kullanılıyor.');
    return ok;
  });
}

function rsError(text) {
  $('rs-error').textContent = text || '';
  $('rs-error').hidden = !text;
}

// İçeridekiler: odanın kendi kökenli kişileri (birleşik odada öteki odanın kişileri kendi odasında sayılır).
function renderRsPeople(r) {
  const users = r.users || [];
  const count = r.count ?? users.length; // yönetici sayılmaz
  $('rs-people-count').textContent = r.max ? `${count}/${r.max}` : String(users.length);
  if (!users.length) {
    $('rs-people').replaceChildren(Object.assign(document.createElement('li'), { className: 'rs-people-none', textContent: 'Şu an içeride kimse yok.' }));
    return;
  }
  $('rs-people').replaceChildren(...users.map((name) => {
    const li = document.createElement('li');
    li.className = 'rs-person';
    li.append(makeAvatar(name), Object.assign(document.createElement('span'), { className: 'rs-person-name', textContent: name }));
    return li;
  }));
}

function renderRoomSettings(list) {
  const r = settingsRoom;
  if (!r) return;
  if (list) rsList = list;
  const admin = r.role === 'admin';
  $('rs-title').textContent = r.name;
  if (window.Lobby?.emblem) $('rs-emblem').replaceChildren(Lobby.emblem(r));
  renderRsPeople(r);
  // Tema: kutucuk yalnız seçer; Uygula kaydeder. Bekleyen seçim odanın temasına eşitse (ör. room:theme geldi) düşer.
  if (rsThemePending === r.theme) rsThemePending = null;
  if (window.Lobby?.themePicker) Lobby.themePicker($('rs-theme'), rsThemePending ?? r.theme, r.theme);
  renderThemeApply();
  // Durum satırı: rozet + açıklama
  const state = (el, cls, iconName, label, text) => {
    el.innerHTML = `<span class="badge ${cls}">${icon(iconName)}</span><span class="rs-state-text"></span>`;
    el.firstChild.append(label);
    el.lastChild.textContent = text;
  };
  if (r.locked) state($('rs-pass-state'), 'badge-accent', 'lock', 'Şifreli', 'Şifre değişince üyeler yeni şifreyi yazar.');
  else state($('rs-pass-state'), 'badge-lock', 'unlock', 'Şifresiz', 'Odaya herkes girebilir.');
  $('rs-pass-save').textContent = r.locked ? 'Değiştir' : 'Şifre koy';
  $('rs-pass').placeholder = r.locked ? 'Yeni şifre' : 'Şifre (en az 4 karakter)';
  $('rs-pass-remove').hidden = !r.locked;
  const partner = r.mergedWith;
  $('rs-merged').hidden = !partner;
  if (partner) state($('rs-merged'), 'badge-accent', 'merge', roomNames.get(partner) || partner, 'ile birleşik.'); // rozette birleşme simgesi var, ⇄ ikinci kez yazılmaz
  else $('rs-merged').replaceChildren();
  $('rs-merge-form').classList.toggle('is-merged', Boolean(partner));
  $('rs-split').hidden = !partner;
  $('rs-merge-field').hidden = $('rs-merge').hidden = Boolean(partner);
  $('rs-merge-hint').textContent = r.max
    ? `Karşı odanın sahibi kabul edince iki oda tek oda olur (her odadan en fazla ${r.max}, toplam ${2 * r.max} kişi).`
    : 'Karşı odanın sahibi kabul edince iki oda tek oda olur.';
  if (!partner && rsList) {
    const others = rsList.filter((x) => x.id !== r.id && !x.mergedWith);
    const picked = $('rs-merge-target').value;
    $('rs-merge-target').replaceChildren(...others.map((x) => new Option(`${x.name} (${x.users.length} kişi)`, x.id)));
    if (others.some((x) => x.id === picked)) $('rs-merge-target').value = picked;
    $('rs-merge').disabled = others.length === 0;
    if (!others.length) $('rs-merge-target').append(new Option('Birleşilecek oda yok', ''));
  }
  $('rs-admin').hidden = !admin;
  if (admin) {
    // Kullanıcı alanı değiştirdiyse (yazarken liste güncellendi) değeri ezilmez
    if (!rsShown || $('rs-name').value === rsShown.name) $('rs-name').value = r.name;
    if (!rsShown || $('rs-owner').value === rsShown.owner) $('rs-owner').value = r.owner;
    rsShown = { name: r.name, owner: r.owner };
    $('rs-close-room').closest('.rs-danger').hidden = r.id === 'genel';
    if (r.id === 'genel') showCloseConfirm(false);
    else renderCloseConfirm();
  }
}

// Yönetici: sahip seçimi için hesap adları (pencere her açılışta bir kez ister; sunucu yine doğrular).
async function loadOwnerNames() {
  const res = await api('GET', '/admin/accounts');
  if (res.error || !Array.isArray(res.names)) return;
  $('rs-owner-list').replaceChildren(...res.names.map((n) => new Option(n)));
}

// Kapatma onayı: odanın adı ve oda listesine dönecek kişi sayısı.
function renderCloseConfirm() {
  const r = settingsRoom;
  if (!r || $('rs-close-confirm').hidden) return;
  const n = r.users?.length || 0;
  const ask = $('rs-close-ask');
  ask.replaceChildren(Object.assign(document.createElement('strong'), { textContent: r.name }), ' kapatılsın mı? ',
    n ? `İçerideki ${n} kişi oda listesine döner.` : 'İçeride kimse yok.', ' Geri alınamaz.');
}
function showCloseConfirm(on) {
  $('rs-close-confirm').hidden = !on;
  $('rs-close-room').setAttribute('aria-expanded', String(on));
  $('rs-close-room').disabled = on;
  if (on) {
    renderCloseConfirm();
    $('rs-close-cancel').focus();
  }
}

// view: odanın görünümü (GET /rooms satırı ya da join cevabındaki oda). Pencere hemen açılır, liste arkadan tazelenir.
async function openRoomSettings(view) {
  if (!view) return;
  if ($('settings-pop').matches(':popover-open')) $('settings-pop').hidePopover();
  settingsRoom = view;
  rsOpener = curRoom ? null : view.id;
  rsShown = null;
  rsThemePending = null;
  rsError('');
  $('rs-pass').value = '';
  showCloseConfirm(false);
  renderRoomSettings();
  if (!$('room-settings').open) $('room-settings').showModal();
  if (view.role === 'admin') loadOwnerNames();
  const list = curRoom ? await refreshRoomView() : await fetchRoomList(); // birleşme durumu ve listesi güncel olsun
  if (!$('room-settings').open || settingsRoom?.id !== view.id) return;
  if (!list) return rsError('Oda listesi alınamadı.');
  syncRoomSettings(list);
}
async function fetchRoomList() {
  const res = await api('GET', '/rooms');
  if (res.error) return null;
  for (const r of res.rooms) roomNames.set(r.id, r.name);
  return res.rooms;
}
// Açık pencere taze listeyle güncellenir (oda listesinde rooms olayıyla canlı); oda kapandıysa pencere kapanır.
function syncRoomSettings(list) {
  if (!$('room-settings').open || !settingsRoom) return;
  for (const r of list) roomNames.set(r.id, r.name);
  const fresh = list.find((r) => r.id === settingsRoom.id);
  if (!fresh) {
    $('room-settings').close();
    if (rsClosing !== settingsRoom.id) toast(`${settingsRoom.name} odası artık yok.`); // kendi kapattığımız: tek bildirim
    return;
  }
  settingsRoom = fresh;
  renderRoomSettings(list);
}

$('room-settings-open').onclick = () => openRoomSettings(curHome);
$('rs-done').onclick = () => $('room-settings').close();
$('room-settings').querySelector('[data-close]').onclick = () => $('room-settings').close();
// Kapanınca odak açan düğmeye döner: liste bu arada yeniden çizildiyse aynı odanın yeni ayar düğmesine, oda
// kapandıysa listeye (ilk karta).
$('room-settings').addEventListener('close', () => {
  showCloseConfirm(false);
  const id = rsOpener;
  rsOpener = null;
  rsClosing = null;
  if (id == null || curRoom) return;
  requestAnimationFrame(() => {
    const target = document.querySelector(`.room-manage[data-id="${CSS.escape(id)}"]`) || document.querySelector('#room-list .room-card');
    target?.focus();
  });
});
$('room-settings-top').onclick = () => $('room-settings-open').click();
// Odadaki pencerelerin kapat düğmeleri
for (const b of document.querySelectorAll('#room-screen dialog [data-close]')) b.onclick = () => b.closest('dialog').close();

// Ayarı kaydeder; cevap odanın yeni görünümüdür.
async function saveRoomSetting(body, done, btn) {
  if (!settingsRoom) return;
  rsError('');
  if (btn) btn.disabled = true;
  const res = await api('PATCH', `/rooms/${encodeURIComponent(settingsRoom.id)}`, body);
  if (btn) btn.disabled = false;
  if (res.error) return rsError(res.error);
  if (settingsRoom?.id !== res.room.id) return; // bu arada pencere başka oda için açıldı
  settingsRoom = res.room;
  rsShown = null; // kaydedilen ad ve sahip alanlara yazılsın
  if (curHome?.id === res.room.id) curHome = res.room;
  if (curRoom?.id === res.room.id) curRoom = res.room;
  roomNames.set(res.room.id, res.room.name);
  renderRoomInfo();
  renderRoomSettings();
  if (curRoom) refreshRoomView(); // sahip değiştiyse susturma yetkileri de değişir
  if (done) toast(done);
}
const submitter = (e) => e.submitter || e.target.querySelector('button[type=submit]');
// Tema seçimi: kutucuğa basmak (ya da ok tuşlarıyla gezmek) yalnız seçer, kimseye gitmez. "Uygula" (ya da seçili
// kutucukta Enter) kaydeder; yeni tema odadakilere room:theme ile gelir (bu sekme dahil). Kayıt sürerken seçici
// odakta kalır, kutucuklar yeniden yazılmaz; ikinci gönderimi aria-busy ve rsThemeSaving engeller.
function renderThemeApply() {
  const differs = Boolean(settingsRoom && rsThemePending && rsThemePending !== settingsRoom.theme);
  // Kayıt sürerken düğme kilitlenmez (odağı düşürürdü); aria-busy ve rsThemeSaving ikinci gönderimi engeller.
  $('rs-theme-apply').disabled = !differs;
  $('rs-theme-apply').setAttribute('aria-busy', String(rsThemeSaving));
  $('rs-theme-hint').textContent = differs
    ? `${Theme.name(rsThemePending)} seçili; Uygula'ya basınca odadaki herkeste değişir.`
    : 'Seçtiğin tema odadaki herkeste değişir.';
}
$('rs-theme').onchange = () => {
  rsThemePending = Lobby.pickedTheme($('rs-theme'));
  if (rsThemePending === settingsRoom?.theme) rsThemePending = null;
  renderThemeApply();
};
$('rs-theme').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.matches('.theme-swatch-input')) return;
  e.preventDefault(); // tarayıcının örtük gönderimi yerine tek gönderim
  $('rs-theme-form').requestSubmit();
});
$('rs-theme-form').onsubmit = async (e) => {
  e.preventDefault();
  const theme = rsThemePending;
  if (!settingsRoom || !theme || theme === settingsRoom.theme || rsThemeSaving) return;
  rsThemeSaving = true;
  renderThemeApply();
  await saveRoomSetting({ theme }); // başarıda renderRoomSettings bekleyen seçimi düşürür; bildirim aşağıda
  rsThemeSaving = false;
  const saved = settingsRoom?.theme === theme;
  const lost = [$('rs-theme-apply'), document.body].includes(document.activeElement);
  renderThemeApply();
  // Düğme artık kapalıysa odak seçili kutucuğa geçer (görünür halkayla), sayfanın başına düşmez.
  if (lost && $('rs-theme-apply').disabled) $('rs-theme').querySelector('.theme-swatch-input:checked')?.focus({ focusVisible: true });
  if (!saved) return; // hata pencerede yazılı (rsError)
  // room:theme gecikse de bu sekme geçsin. Pencere açıkken yalnız son bildirim görünür: sonuç tek bildirimde.
  const here = curRoom && curRoom.id === settingsRoom.id;
  const ok = here ? await applyTheme(theme, { quiet: true }) : true;
  if (!ok) for (const t of [...$('toasts').children]) if (isThemeFail(t)) t.remove();
  toast(ok ? 'Tema kaydedildi.' : 'Tema kaydedildi; bu cihazda yüklenemedi, önceki görünüm kullanılıyor.');
};
// Sunucudan tema listesi geldi: açık ayarlar penceresinin seçicisi yeniden çizilir.
document.addEventListener('themelist', () => $('room-settings').open && renderRoomSettings());
$('rs-pass-form').onsubmit = (e) => {
  e.preventDefault();
  const password = $('rs-pass').value;
  if (!password) return rsError('Yeni şifreyi yaz.');
  $('rs-pass').value = '';
  saveRoomSetting({ password }, 'Oda şifresi kaydedildi.', submitter(e));
};
$('rs-pass-remove').onclick = (e) => saveRoomSetting({ password: null }, 'Oda şifresi kaldırıldı.', e.currentTarget);
$('rs-name-form').onsubmit = (e) => {
  e.preventDefault();
  saveRoomSetting({ name: $('rs-name').value }, 'Oda adı kaydedildi.', submitter(e));
};
$('rs-owner-form').onsubmit = (e) => {
  e.preventDefault();
  saveRoomSetting({ owner: $('rs-owner').value.trim() }, 'Odanın sahibi kaydedildi.', submitter(e));
};
// Kapatma iki adımlı: önce onay satırı (odanın adı, içerideki kişi sayısı). Kapanınca içerideki herkes (bu sekme
// dahil) room:closed alıp listeye döner; listedekilerin kartı canlı kalkar.
$('rs-close-room').onclick = () => showCloseConfirm(true);
$('rs-close-cancel').onclick = () => {
  showCloseConfirm(false);
  $('rs-close-room').focus();
};
$('rs-close-yes').onclick = async (e) => {
  const room = settingsRoom;
  if (!room) return;
  const btn = e.currentTarget;
  rsError('');
  btn.disabled = true;
  rsClosing = room.id;
  const res = await api('DELETE', `/rooms/${encodeURIComponent(room.id)}`);
  btn.disabled = false;
  if (res.error) {
    rsClosing = null;
    return rsError(res.error);
  }
  if ($('room-settings').open) $('room-settings').close();
  toast(`${room.name} odası kapatıldı.`);
};

// ---------- Birleşme ----------
// İsteyen: oda ayarlarından istek gönderir; karşı odanın sahibine (ya da yöneticilere) pencere çıkar.
// Yönetici isterse hemen birleşir. Kabul edilince karşı odadakiler bu odaya taşınır (room:moved).

const MERGE_PROMPT_MS = 60 * 1000; // sunucudaki istek süresiyle aynı
const MERGE_CLOSED = { declined: 'Birleşme isteği reddedildi.', expired: 'Birleşme isteğinin süresi doldu.', cancelled: 'Birleşme isteği geçersiz oldu.' };
const mergeAsked = new Set(); // gönderdiğim bekleyen istekler

$('rs-merge-form').onsubmit = async (e) => {
  e.preventDefault();
  const to = $('rs-merge-target').value;
  if (!settingsRoom || !to) return;
  const btn = submitter(e);
  rsError('');
  btn.disabled = true;
  const res = (await emitAck(10000, 'merge:request', { from: settingsRoom.id, to })) ?? { error: 'Sunucuya ulaşılamadı.' };
  btn.disabled = false;
  if (res.error) return rsError(res.error);
  $('room-settings').close();
  if (res.merged) {
    toast(`Odalar birleşti: ${roomNames.get(to) || to}`); // görünüm room:merge ile güncellenir
    return;
  }
  mergeAsked.add(res.id);
  toast(`Birleşme isteği gönderildi: ${roomNames.get(to) || to}`);
};

$('rs-split').onclick = async (e) => {
  if (!settingsRoom) return;
  const btn = e.currentTarget;
  rsError('');
  btn.disabled = true;
  const res = (await emitAck(10000, 'merge:split', { room: settingsRoom.id })) ?? { error: 'Sunucuya ulaşılamadı.' };
  btn.disabled = false;
  if (res.error) return rsError(res.error);
  if ($('room-settings').open) $('room-settings').close(); // görünüm room:merge ya da room:moved ile güncellenir
};

// Gelen istek penceresi: odada da listede de aynı pencere. Sırayla gösterilir; cevaplanınca,
// sunucu isteği kapatınca (merge:closed) ya da 60 sn sonra kapanır.
const mergeQueue = [];
let mergeShown = null;
let mergeTimer = null;

function showNextMerge() {
  clearTimeout(mergeTimer);
  mergeShown = mergeQueue.shift() || null;
  const dialog = $('merge-prompt');
  if (!mergeShown) {
    if (dialog.open) dialog.close();
    return;
  }
  const q = mergeShown;
  // İki oda yan yana: isteyen oda ⇄ hedef oda (hedef sunucudan gelir; eski sunucuda yoksa yalnız isteyen)
  const side = (room) => {
    const box = document.createElement('div');
    box.className = 'merge-room';
    if (window.Lobby?.emblem) box.append(Lobby.emblem(room));
    box.append(Object.assign(document.createElement('span'), { className: 'merge-room-name', textContent: room.name }));
    return box;
  };
  const rooms = [side(q.from || { id: '', name: '?' })];
  if (q.to?.name) rooms.push(Object.assign(document.createElement('span'), { className: 'merge-arrow', textContent: '⇄' }), side(q.to));
  $('merge-prompt-rooms').replaceChildren(...rooms);
  $('merge-prompt-title').textContent = q.to?.name
    ? `${q.from?.name || 'Bir oda'}, ${q.to.name} ile birleşmek istiyor`
    : `${q.from?.name || 'Bir'} odası birleşmek istiyor`;
  $('merge-prompt-by').textContent = q.by ? `İsteyen: ${q.by}. Kabul edersen iki oda tek oda olur.` : 'Kabul edersen iki oda tek oda olur.';
  const warn = [q.warn?.game && 'süren oyun bitecek', q.warn?.music && 'çalan müzik duracak'].filter(Boolean);
  $('merge-prompt-warn').hidden = !warn.length;
  if (warn.length) {
    $('merge-prompt-warn').innerHTML = icon('alert');
    $('merge-prompt-warn').append(`Birleşince ${warn.join(', ')}.`);
  }
  $('merge-accept').disabled = $('merge-reject').disabled = false;
  mergeTimer = setTimeout(() => dropMerge(q.id), MERGE_PROMPT_MS);
  startMergeCountdown(Date.now() + MERGE_PROMPT_MS);
  if (!dialog.open) dialog.showModal();
}

// Pencerede kalan süre: çubuk ve "0:58"
let mergeTick = null;
function startMergeCountdown(until) {
  clearInterval(mergeTick);
  const draw = () => {
    const left = Math.max(0, until - Date.now());
    $('merge-prompt-bar').style.width = `${(left / MERGE_PROMPT_MS) * 100}%`;
    $('merge-prompt-time').textContent = `${fmtTime(Math.ceil(left / 1000))} içinde cevap ver`;
    if (!left || !$('merge-prompt').open) clearInterval(mergeTick);
  };
  draw();
  mergeTick = setInterval(draw, 250);
}

function dropMerge(id) {
  const at = mergeQueue.findIndex((q) => q.id === id);
  if (at >= 0) mergeQueue.splice(at, 1);
  if (mergeShown?.id === id) showNextMerge();
}

socket.on('merge:incoming', (q = {}) => {
  if (typeof q.id !== 'string' || mergeShown?.id === q.id || mergeQueue.some((x) => x.id === q.id)) return;
  mergeQueue.push(q);
  if (!mergeShown) showNextMerge();
});

socket.on('merge:closed', ({ id, reason } = {}) => {
  const mine = mergeAsked.delete(id);
  const shown = mergeShown?.id === id || mergeQueue.some((q) => q.id === id);
  if (shown) dropMerge(id);
  // İsteyen reddi, süre dolmasını ve iptali duyar; pencerede bekleyen süre dolmasını ve iptali.
  // merged için ayrıca bildirim yok: taşınma kendisi haber verir.
  if (mine ? MERGE_CLOSED[reason] : shown && (reason === 'expired' || reason === 'cancelled')) toast(MERGE_CLOSED[reason]);
});

async function answerMerge(accept) {
  const q = mergeShown;
  if (!q) return;
  $('merge-accept').disabled = $('merge-reject').disabled = true;
  const res = (await emitAck(10000, 'merge:answer', { id: q.id, accept })) ?? { error: 'Sunucuya ulaşılamadı.' };
  if (res.error) toast(res.error);
  dropMerge(q.id);
}
$('merge-accept').onclick = () => answerMerge(true);
$('merge-reject').onclick = () => answerMerge(false);
// Esc pencereyi yalnız bu sekmede kapatır; istek süresi dolana kadar bekler.
$('merge-prompt').addEventListener('cancel', (e) => {
  e.preventDefault();
  if (mergeShown) dropMerge(mergeShown.id);
});

const inviteLink = () => `${location.origin}/oda/${roomId}`;

$('copy-link').onclick = async () => {
  try {
    await navigator.clipboard.writeText(inviteLink());
    toast('Davet linki kopyalandı');
  } catch {
    toast(inviteLink());
  }
};

// Odadan çıkış ("Odalar" ya da "Odadan çık"): çıkış sesi bitsin diye biraz beklenip liste tam yenilemeyle açılır.
function leaveToList() {
  try {
    sessionStorage.removeItem(HOME_KEY);
  } catch {}
  socket.disconnect();
  Sfx.leave(audioCtx, sfxBus);
  setTimeout(() => location.assign('/'), 600);
}
$('leave').onclick = leaveToList;
$('nav-rooms').onclick = leaveToList;

// Sekme kapanınca/yenilenince sunucuya hemen haber ver.
addEventListener('pagehide', () => socket.disconnect());

// Açılış: kayıtlı oturum geçerliyse oda listesi, değilse giriş ekranı. Liste public/lobby.js'tedir ve bu
// dosyadan sonra yüklenir; bu yüzden açılış sayfanın bütün betikleri çalıştıktan sonra yapılır.
addEventListener('DOMContentLoaded', async () => {
  Lobby.onEnter(({ id, password }) => enterRoomFlow(id, password));
  Lobby.onManage((room) => openRoomSettings(room));
  Lobby.onRetry(helloLobby);
  if (!authToken) {
    if (document.documentElement.dataset.env === 'dev' && /^\/oda\/[^/]+\/oyunlar\/yorunge-kusatmasi\/?$/.test(location.pathname)) {
      return location.replace('/yorunge.html');
    }
    $('join-screen').hidden = false;
    // Oturumu kapatılıp buraya dönüldüyse nedeni giriş ekranında yazar.
    try {
      const notice = sessionStorage.getItem(NOTICE_KEY);
      sessionStorage.removeItem(NOTICE_KEY);
      if (notice) showJoinError(notice);
    } catch {}
    return;
  }
  // Oturum belirteci belli: liste ve soket bağlantısı /auth/me cevabını beklemez (hello yine openLobby'de)
  Lobby.prefetch();
  socket.connect();
  const res = await api('GET', '/auth/me');
  if (res.error) {
    if (res.status === 401) return signedOut();
    socket.disconnect(); // erken açılan bağlantı: giriş ekranında soket gerekmez
    $('join-screen').hidden = false;
    return showJoinError(res.error);
  }
  account = res;
  openLobby();
});

// ---------- Oyun seçici ----------
// Oyunlar sayfası kart ızgarasıyla açılır (game-home); karta basınca oyun açılır. Oyundayken üstte
// "Oyunlar" geri düğmesi, açık oyunun adı ve son oynananlar durur.
// Sekme düğmeleri (game-tab-*) gizli durur ve hâlâ asıl geçişi yapar; kartlar ve son oynananlar onları tıklar.
// Yeni bir oyunun sekmesi eklenince kartlarda kendiliğinden görünür (bilgisi yoksa "Diğer" altında).

// players: kartta görünen kişi sayısı aralığı (sunucudaki LOBBY_GAMES sınırları: odada 10 kişi, bot ayrıca katılabilir;
// dinozor 7 (bot dahil), kelime 6, sayı bulmaca ve İttirmeli XOX 2)
// hue: oyunun tonu, oklch ton açısı (simgenin rengi, kartın ve lobinin simge zemini; açıklığı temadan gelir)
const GAME_INFO = {
  sayi: { hue: 245, group: 'Zeka', desc: 'Gizli sayıyı +/- ipuçlarıyla bul', players: '1–2 kişi' },
  takimada: { hue: 80, hidden: true, group: 'Kutu Oyunları', desc: 'Yollar kur, kaynakları takas et ve adaya yerleş', players: '2–4 kişi' },
  yedikapi: { hue: 320, hidden: true, group: 'Kutu Oyunları', desc: 'Kapıyı aç, canavarları yen ve hazine topla', players: '2–4 kişi' },
  yorunge: { hue: 205, group: 'Kutu Oyunları', desc: 'Filonu konuşlandır, rakip komuta gemisini kuşat', players: '2 kişilik' },
  kural: { hue: 290, group: 'Zeka', desc: 'Dizileri dene, gizli kuralı yakala', players: '1–10 kişi' },
  hedef: { hue: 25, group: 'Zeka', desc: '6 sayı, 4 işlem, hedefe ulaş', players: '1–10 kişi' },
  mantik: { hue: 345, group: 'Zeka', desc: 'İpuçlarından kim kimdir tablosu', players: '1–10 kişi' },
  blackjack: { hue: 140, group: 'Kağıt Oyunları', desc: 'Kurpiyere karşı 21\'e en yakın eli yap', players: '1–7 kişi' },
  poker: { hue: 0, group: 'Kağıt Oyunları', desc: 'Texas Hold\'em: çiplerle blöf ve en iyi el', players: '1–8 kişi' },
  arasinda: { hue: 45, group: 'Kağıt Oyunları', desc: 'Üçüncü kart iki kartın arasına düşer mi?', players: '1–8 kişi' },
  pisti: { hue: 195, group: 'Kağıt Oyunları', desc: 'Aynı kartı ya da Valeyi at, yığını topla', players: '1–4 kişi' },
  batak: { hue: 230, group: 'Kağıt Oyunları', desc: 'İhaleyi al, kozu seç, sözünü tut', players: '4 kişilik' },
  kemal: { hue: 300, group: 'Kağıt Oyunları', desc: 'Dörtlüyü topla, ortağına gizlice işaret ver', players: '2\'ye 2' },
  besharf: { hue: 120, group: 'Günlük Oyun', desc: 'Günün 5 harfli kelimesini 6 tahminde bul', players: 'Günlük' },
  dorttas: { hue: 55, group: 'Zeka', desc: 'Sütuna taş bırak, dördünü yan yana getir', players: '2 kişilik' },
  duvar: { hue: 28, group: 'Zeka', desc: 'Piyonunu karşıya ulaştır, rakibin yoluna duvar ör', players: '2 kişilik' },
  xox: { hue: 170, group: 'Zeka', desc: 'Taş koy ya da kenardan it, üçünü yan yana getir', players: '2 kişilik' },
  klotski: { hue: 150, group: 'Zeka', desc: 'Büyük kareyi kaydırarak çıkar', players: 'Tek kişi' },
  memory: { hue: 65, group: 'Zeka', desc: 'Eşleri bul, en çok çifti topla', players: '1–10 kişi' },
  timing: { hue: 215, group: 'Hız ve refleks', desc: 'Süreyi görmeden tam zamanında dur', players: '1–10 kişi' },
  daktilo: { hue: 315, group: 'Hız ve refleks', desc: 'Aynı kelimeleri yaz, en hızlı olan kazanır', players: '1–10 kişi' },
  okuma: { hue: 50, group: 'Hız ve refleks', desc: 'Göz açısı, blok görme, takistoskop', players: 'Tek kişi' },
  dino: { hue: 130, group: 'Hız ve refleks', desc: 'Engellerden zıplayarak koş', players: '1–7 kişi' },
  peacock: { hue: 185, group: 'Hız ve refleks', desc: 'Yakında', soon: true },
  kelime: { hue: 265, group: 'Birlikte', desc: 'Biri anlatır, diğerleri bilir', players: '2–6 kişi' },
  tier: { hue: 35, group: 'Birlikte', desc: 'Birlikte sıralama listeleri', players: 'Herkes' },
  oner: { hue: 90, group: 'Diğer', desc: 'Eklenmesini istediğin oyunu anlat' },
};
const GAME_GROUPS = ['Günlük Oyun', 'Kağıt Oyunları', 'Kutu Oyunları', 'Zeka', 'Hız ve refleks', 'Birlikte', 'Diğer'];
// Oyun simgeleri: index.html'deki gömülü <svg id="game-icons"> (kaynağı icons/games.svg, test/tools/game-icons.js).
// Sembolü olmayan (yeni eklenmiş) oyunda arayüz setinin oyun kolu ikonu görünür.
function gameIcon(key, cls) {
  const el = Object.assign(document.createElement('span'), { className: cls });
  el.style.setProperty('--hue', gameInfo(key).hue);
  const id = document.getElementById(`g-${key}`) ? `g-${key}` : 'i-gamepad';
  el.innerHTML = `<svg class="${id === 'i-gamepad' ? 'ic' : 'gi'}" aria-hidden="true"><use href="#${id}"></use></svg>`;
  return el;
}
const gameRecentKey = 'gameRecent';

// hidden: true olan oyunlar (GAME_INFO) kartlarda ve son oynananlarda görünmez; kodu ve adresi yerinde kalır.
const gameTabs = () => [...document.querySelectorAll('.games-panel > .tabs > .tab[id^="game-tab-"]')]
  .map((btn) => ({ btn, key: btn.id.slice('game-tab-'.length), name: btn.textContent.trim() }))
  .filter((t) => !GAME_INFO[t.key]?.hidden);
const gameInfo = (key) => GAME_INFO[key] || { hue: 260, group: 'Diğer', desc: '' };
const lobbyOpen = (tab) => tab.btn.classList.contains('lobby-open');

function gameEntry(tab, cls) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls + (lobbyOpen(tab) ? ' lobby-open' : '');
  b.title = lobbyOpen(tab) ? `${tab.name}: lobi açık` : tab.name;
  b.onclick = () => tab.btn.click();
  return b;
}

// Son oynananlar şeridinin sağ kenarı yalnız şerit taşınca solar (css/games.css .game-recent.is-overflow).
function recentFade() {
  const strip = $('game-recent');
  strip.classList.toggle('is-overflow', strip.scrollWidth > strip.clientWidth + 1);
}
new ResizeObserver(recentFade).observe($('game-recent'));

function renderGameSwitch() {
  const tabs = gameTabs();
  const current = $('game-home').hidden ? tabs.find((t) => t.btn.classList.contains('active')) : null;
  $('games').classList.toggle('at-home', !current);
  let recent = [];
  try { recent = JSON.parse(localStorage.getItem(gameRecentKey)) || []; } catch {}
  if (current && recent[0] !== current.key) {
    recent = [current.key, ...recent.filter((k) => k !== current.key)].slice(0, 6);
    try { localStorage.setItem(gameRecentKey, JSON.stringify(recent)); } catch {}
  }
  const homeBtn = $('game-home-btn');
  homeBtn.classList.toggle('lobby-open', tabs.some((t) => t !== current && lobbyOpen(t)));
  homeBtn.disabled = !current;
  homeBtn.replaceChildren(...(current
    ? [Object.assign(document.createElement('span'), { className: 'game-home-back', innerHTML: icon('back') }),
      gameIcon(current.key, 'game-home-icon'),
      Object.assign(document.createElement('strong'), { textContent: current.name })]
    : [Object.assign(document.createElement('strong'), { textContent: 'Oyunlar' })]));
  homeBtn.title = current ? 'Bütün oyunlara dön' : '';
  // Son oynananlar: şu ankinden sonraki en çok 3 oyun, lobisi açık olanlar öne (kart ızgarasında gizli)
  const byKey = new Map(tabs.map((t) => [t.key, t]));
  const others = recent.filter((k) => k !== current?.key).map((k) => byKey.get(k)).filter(Boolean);
  for (const t of tabs) if (t !== current && lobbyOpen(t) && !others.includes(t)) others.unshift(t);
  $('game-recent').replaceChildren(...(current ? others.slice(0, 3) : []).map((t) => {
    const b = gameEntry(t, 'game-chip');
    b.append(gameIcon(t.key, 'game-chip-icon'), t.name);
    return b;
  }));
  recentFade();
  if (!$('game-home').hidden) renderGameHome();
}

// Kart: üstte oyunun çizimi (oyunun tonunda hafif zemin), altta ad, tek satır açıklama ve kişi sayısı.
// Lobisi açık ya da oyunu süren oyunda köşede --live rozeti (lobisi olmayan oyunlarda rozet yok).
function renderGameHome() {
  const tabs = gameTabs();
  const groups = GAME_GROUPS.map((g) => [g, tabs.filter((t) => gameInfo(t.key).group === g)]).filter(([, list]) => list.length);
  const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, ...(text != null ? { textContent: text } : {}) });
  $('game-home').replaceChildren(...groups.map(([group, list]) => {
    const sec = document.createElement('section');
    sec.append(el('h3', '', group));
    const grid = el('div', 'game-home-grid');
    grid.append(...list.map((t) => {
      const info = gameInfo(t.key);
      const running = t.btn.classList.contains('game-running');
      const b = gameEntry(t, 'game-card' + (info.soon ? ' soon' : '') + (running ? ' running' : ''));
      b.dataset.game = t.key;
      b.style.setProperty('--hue', info.hue);
      const art = el('span', 'game-card-art');
      art.append(gameIcon(t.key, 'game-card-icon'));
      const body = el('span', 'game-card-body');
      body.append(el('strong', 'game-card-name', t.name));
      if (info.desc && !info.soon) body.append(el('small', 'game-card-desc', lobbyOpen(t) ? 'Lobi açık, katılabilirsin' : info.desc));
      // Alt satır: kişi sayısı solda, rozet sağda (çizimin üstüne binmez)
      const foot = el('span', 'game-card-foot');
      if (info.players) foot.append(withIcon(el('span', 'game-card-meta', info.players), 'users'));
      if (lobbyOpen(t) || running) foot.append(el('span', 'badge badge-live game-card-badge', lobbyOpen(t) ? 'Lobi açık' : 'Oynanıyor'));
      if (info.soon) foot.append(el('span', 'badge game-card-badge', 'Yakında'));
      if (foot.childNodes.length) body.append(foot);
      b.append(art, body);
      return b;
    }));
    sec.append(grid);
    return sec;
  }));
}

$('game-home-btn').onclick = () => go(() => openGame('home'));
// Bot düğmesi sekme satırından seçicinin sağına taşınır
document.querySelector('.game-switch').append($('bot-toggle'));
const gameSwitchObserver = new MutationObserver(renderGameSwitch);
gameSwitchObserver.observe(document.querySelector('.games-panel > .tabs'), { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
gameSwitchObserver.observe($('game-home'), { attributes: true, attributeFilter: ['hidden'] });
renderGameSwitch();

