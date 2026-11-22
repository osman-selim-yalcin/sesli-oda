'use strict';

// Oda listesi ekranı (#lobby-screen): oda kartları (canlı), şifre penceresi, hesap penceresi (profil resmi, şifre
// değiştirme, çıkış), oda isteği penceresi ve durum şeridi; yöneticide istekler ve oda açma pencereleri, üyeler
// (/uyeler). Oda amblemi (roomEmblem) burada üretilir, Lobby.emblem ile odanın üst çubuğu da kullanır.
// Oturum, soket ve oda app.js'tedir; $, api, toast, account, makeAvatar, pathView, NOTICE_KEY oradan gelir.
// app.js listeyi Lobby.show/hide/update ile yönetir, karta basılınca Lobby.onEnter ile verdiği giriş akışı çağrılır.

window.Lobby = (() => {
  let rooms = [];
  let pending = null;     // yönetici: bekleyen oda isteği sayısı
  let enter = null;       // app.js'in giriş akışı: ({ id, password }) => join cevabı
  let target = null;      // /oda/<id> ile açıldıysa o oda: kartı vurgulu, tek tıkla girilir
  let targetChecked = false;
  let busyId = null;      // girilmeye çalışılan oda
  let passRoom = null;    // şifre penceresindeki oda
  let mine = null;        // son oda isteğim { name, status }
  const waitUntil = new Map(); // oda id -> çok fazla yanlış şifre: bu zamana kadar düğme kilitli
  const WAIT_MS = 10 * 60 * 1000; // sunucudaki yanlış şifre penceresiyle aynı

  const REQUEST_STATUS = { pending: 'onay bekliyor', approved: 'onaylandı, oda açıldı', rejected: 'reddedildi' };
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  // Şifreli oda işareti: ad metninden önce kilit ikonu (ekran okuyucuya "Şifreli").
  const lockMark = () => {
    const s = el('span', 'lock-mark');
    s.innerHTML = icon('lock');
    s.title = 'Şifreli';
    s.setAttribute('role', 'img');
    s.setAttribute('aria-label', 'Şifreli');
    return s;
  };
  const withLock = (node, locked, text) => {
    if (locked) node.append(lockMark(), ' ');
    node.append(text);
    return node;
  };
  // Rozet: isteğe bağlı ikon (icon() çıktısı, sabit ad), yazı metin düğümü.
  const badge = (cls, iconHtml, text) => {
    const b = el('span', `badge ${cls}`.trim());
    if (iconHtml) b.innerHTML = iconHtml;
    b.append(text);
    return b;
  };
  const isAdmin = () => Boolean(account?.admin);
  function showError(id, text) {
    $(id).textContent = text || '';
    $(id).hidden = !text;
  }

  // ---------- Oda amblemi ----------
  // Odanın tek görsel imzası: baş harf + oda kimliğinden türetilen ton (--hue). Kartta, şifre penceresinde ve
  // odanın üst çubuğunda aynı öğe kullanılır; ileride room.icon gelince yalnız bu işlev değişir.
  function roomHue(id) {
    let hash = 2166136261; // FNV-1a: benzer kimlikler de farklı tona düşsün
    for (const ch of String(id)) hash = Math.imul(hash ^ ch.codePointAt(0), 16777619);
    return (hash >>> 0) % 360;
  }
  function roomEmblem(room) {
    const e = el('span', 'room-emblem', [...(room.name || '').trim()][0]?.toLocaleUpperCase('tr-TR') || '?');
    e.style.setProperty('--hue', roomHue(room.id));
    e.setAttribute('aria-hidden', 'true');
    return e;
  }

  // ---------- Odalar ----------

  const MAX_FACES = 5; // kartta en çok bu kadar yüz, fazlası "+N"
  const isFull = (r) => r.users.length >= r.max;

  // Tema önizleme şeridi: temanın üç renginden (Theme.preview) küçük bir oda taslağı: oynatıcı, sohbet, vurgu.
  function preview(room) {
    const pv = el('span', 'room-pv');
    pv.setAttribute('aria-hidden', 'true');
    const c = Theme.preview(room.theme);
    pv.style.setProperty('--pv-bg', c.bg);
    pv.style.setProperty('--pv-surface', c.surface);
    pv.style.setProperty('--pv-accent', c.accent);
    pv.append(el('span', 'room-pv-player'), el('span', 'room-pv-side'));
    return pv;
  }

  function faces(users) {
    const box = el('span', 'room-faces');
    if (!users.length) {
      box.append(el('span', 'room-faces-none', 'Kimse yok'));
      return box;
    }
    for (const name of users.slice(0, MAX_FACES)) box.append(makeAvatar(name));
    if (users.length > MAX_FACES) box.append(el('span', 'room-faces-more', `+${users.length - MAX_FACES}`));
    return box;
  }

  function roomCard(r) {
    const full = isFull(r);
    const isTarget = r.id === target;
    const card = el('button', 'room-card');
    card.type = 'button';
    card.dataset.id = r.id;
    card.classList.toggle('target', isTarget);
    card.classList.toggle('is-full', full);
    card.classList.toggle('is-busy', busyId === r.id);
    card.disabled = Boolean(busyId);
    if (full) card.setAttribute('aria-disabled', 'true');

    // Üst şerit: tema önizlemesi, köşelerde rozetler
    const top = el('span', 'room-top');
    top.append(preview(r));
    const tl = el('span', 'room-badges room-badges-start');
    if (full) tl.append(badge('', '', 'Dolu'));
    if (r.role === 'owner') tl.append(badge('badge-accent', icon('crown'), 'Senin odan'));
    const tr = el('span', 'room-badges room-badges-end');
    if (r.locked) tr.append(badge('badge-lock', icon('lock'), 'Şifreli'));
    top.append(tl, tr);

    // Gövde: amblem, ad, sahibi, birleşik rozeti
    const head = el('span', 'room-head');
    const text = el('span', 'room-head-text');
    text.append(el('span', 'room-name', r.name));
    const owner = el('span', 'room-owner');
    owner.innerHTML = icon('user');
    owner.append(el('span', 'room-owner-name', r.owner));
    owner.title = `Sahibi: ${r.owner}`;
    text.append(owner);
    head.append(roomEmblem(r), text);
    const body = el('span', 'room-body');
    body.append(head);
    const partner = r.mergedWith && rooms.find((x) => x.id === r.mergedWith);
    if (r.mergedWith) {
      const tags = el('span', 'room-tags');
      const m = badge('room-merged', '', `⇄ ${partner?.name || 'başka oda'}`);
      m.title = `${partner?.name || 'Başka bir oda'} ile birleşik`;
      tags.append(m);
      body.append(tags);
    }

    // Alt satır: yüzler, doluluk, eylem
    const foot = el('span', 'room-foot');
    const occ = el('span', `room-occ${r.users.length ? ' is-live' : ''}`, `${r.users.length}/${r.max}`);
    occ.title = `${r.users.length} kişi içeride, en fazla ${r.max}`;
    const go = el('span', 'room-go');
    if (busyId === r.id) {
      go.innerHTML = icon('loader');
      go.append('Bağlanıyor…');
    } else if (full) {
      go.append('Dolu');
    } else {
      go.append(r.locked && r.role === 'none' ? 'Şifreyle gir' : isTarget ? 'Odaya gir' : 'Gir');
    }
    foot.append(faces(r.users), occ, go);
    body.append(foot);
    card.append(top, body);

    const label = [r.name, r.locked && 'şifreli', full ? 'dolu' : `${r.users.length} kişi içeride`, partner && `${partner.name} ile birleşik`]
      .filter(Boolean).join(', ');
    card.setAttribute('aria-label', label);
    card.onclick = () => (full ? toast(`${r.name} dolu.`) : tryEnter(r));
    return card;
  }

  function renderSummary() {
    const people = rooms.reduce((n, r) => n + r.users.length, 0);
    $('lobby-summary').textContent = rooms.length
      ? `${rooms.length} oda · ${people ? `${people} kişi içeride` : 'şu an kimse yok'}`
      : '';
  }

  // Liste canlı yenilenir: klavyeyle bir kartın üstündeyken yenilense de odak aynı odada kalır.
  function renderRooms() {
    const list = $('room-list');
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.id : null;
    list.replaceChildren();
    $('room-list-empty').hidden = rooms.length > 0;
    list.hidden = rooms.length === 0;
    for (const r of rooms) list.append(wrap(roomCard(r)));
    if (focused) list.querySelector(`.room-card[data-id="${CSS.escape(focused)}"]`)?.focus();
    renderSummary();
  }
  const wrap = (child) => {
    const li = el('li');
    li.append(child);
    return li;
  };

  // /oda/<id> ile açılan sayfa: oda yoksa liste + bildirim; varsa kartı görünür yerde.
  function checkTarget() {
    if (targetChecked || !target) return;
    targetChecked = true;
    if (!rooms.some((r) => r.id === target)) {
      target = null;
      history.replaceState({ page: 'list' }, '', '/');
      toast('Böyle bir oda yok.');
      renderRooms();
      return;
    }
    document.querySelector('.room-card.target')?.scrollIntoView({ block: 'center' });
  }

  async function refreshRooms() {
    const res = await api('GET', '/rooms');
    if (!res.error) update({ rooms: res.rooms });
  }

  // Karta basınca (kullanıcı hareketi: ses izni için şart). Şifre gerekiyorsa önce pencere açılır.
  async function tryEnter(room, password) {
    if (busyId || !enter) return;
    if (room.role === 'none' && password == null) return openPass(room);
    busyId = room.id;
    renderRooms();
    $('room-pass-ok').disabled = true;
    const res = await enter({ id: room.id, password });
    busyId = null;
    $('room-pass-ok').disabled = false;
    if (!res?.error) return closePass(); // oda açıldı
    renderRooms();
    if (res.busy || res.auth) return; // oturum düştüyse app.js giriş ekranını açar
    if (res.wait) waitUntil.set(room.id, Date.now() + WAIT_MS);
    if (res.needPassword || res.wait) return openPass(room, password != null || res.wait ? res.error : '');
    closePass();
    if (res.gone) {
      toast('Böyle bir oda yok.');
      return refreshRooms();
    }
    toast(res.error); // oda dolu ya da başka bir hata
  }

  // ---------- Şifre penceresi ----------
  // Çok fazla yanlış denemeden sonra (wait) düğme kilitli kalır ve kalan süre geri sayılır.

  let waitTimer = null;
  const fmtLeft = (ms) => {
    const s = Math.ceil(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  function tickWait() {
    const left = passRoom ? (waitUntil.get(passRoom.id) || 0) - Date.now() : 0;
    const waiting = left > 0;
    $('room-pass-wait').hidden = !waiting;
    $('room-pass-wait').textContent = waiting ? `Tekrar deneyebilmen için ${fmtLeft(left)}` : '';
    $('room-pass-ok').disabled = waiting || Boolean(busyId);
    $('room-pass-input').disabled = waiting;
    if (!waiting) {
      clearInterval(waitTimer);
      waitTimer = null;
      if (passRoom) waitUntil.delete(passRoom.id);
    }
    return waiting;
  }

  function openPass(room, error = '') {
    passRoom = room;
    $('room-pass-title').textContent = room.name;
    showError('room-pass-error', error);
    if (!$('room-pass').open) {
      $('room-pass-input').value = '';
      $('room-pass').showModal();
    }
    if (tickWait() && !waitTimer) waitTimer = setInterval(tickWait, 1000);
    if (!$('room-pass-input').disabled) $('room-pass-input').select();
  }
  function closePass() {
    if ($('room-pass').open) $('room-pass').close();
  }
  $('room-pass').addEventListener('close', () => {
    passRoom = null;
    clearInterval(waitTimer);
    waitTimer = null;
    $('room-pass-input').disabled = false;
  });
  $('room-pass-cancel').onclick = closePass;
  $('room-pass-form').onsubmit = (e) => {
    e.preventDefault();
    const password = $('room-pass-input').value;
    if (!password) return showError('room-pass-error', 'Oda şifresini yaz.');
    if (passRoom) tryEnter(passRoom, password);
  };

  // ---------- Pencereler ----------
  // data-close taşıyan düğme içinde durduğu pencereyi kapatır.
  for (const b of document.querySelectorAll('#lobby-screen [data-close]')) b.onclick = () => b.closest('dialog').close();
  const openDialog = (id, focusId) => {
    if (!$(id).open) $(id).showModal();
    if (focusId) $(focusId).focus();
  };

  // ---------- Oda isteği (üye) ----------
  // Son isteğin durumu listenin üstünde ince bir şerittir; sonuçlanmış isteğin şeridi kapatılabilir
  // (kapatılan sonuç bu tarayıcıda hatırlanır).

  const SEEN_KEY = 'requestSeen';
  const seenKey = (q) => `${q.name}|${q.status}`;
  const isSeen = (q) => {
    try {
      return localStorage.getItem(SEEN_KEY) === seenKey(q);
    } catch {
      return false;
    }
  };

  async function loadMine() {
    const res = await api('GET', '/rooms/requests/mine');
    if (res.error) return;
    mine = res.request;
    renderMine();
  }
  function renderMine() {
    const strip = $('my-request');
    const show = !isAdmin() && Boolean(mine) && (mine.status === 'pending' || !isSeen(mine));
    strip.hidden = !show;
    if (show) {
      $('my-request-text').replaceChildren(
        'Oda isteğin ',
        el('strong', '', mine.name),
        ` ${REQUEST_STATUS[mine.status] || mine.status}.`,
      );
      strip.dataset.status = mine.status;
      $('my-request-dismiss').hidden = mine.status === 'pending';
    }
    const canAsk = !isAdmin() && mine?.status !== 'pending';
    $('request-open').hidden = !canAsk;
    $('create-open').hidden = !isAdmin();
    $('empty-action').hidden = !isAdmin() && !canAsk;
  }
  $('my-request-dismiss').onclick = () => {
    try {
      if (mine) localStorage.setItem(SEEN_KEY, seenKey(mine));
    } catch {}
    $('my-request').hidden = true;
  };
  const openRequest = () => {
    showError('request-error', '');
    openDialog('request-dialog', 'request-name');
  };
  $('request-open').onclick = openRequest;
  $('room-request').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    showError('request-error', '');
    const res = await api('POST', '/rooms/requests', {
      name: $('request-name').value,
      password: $('request-password').value || undefined,
      theme: $('request-theme').value,
      note: $('request-note').value,
    });
    btn.disabled = false;
    if (res.error) return showError('request-error', res.error);
    $('room-request').reset();
    $('request-dialog').close();
    mine = res.request;
    renderMine();
    toast('İsteğin yöneticiye gitti.');
  };

  // ---------- Yönetici: istekler ve oda açma ----------

  function renderPending() {
    const n = pending ?? 0;
    $('request-title').textContent = n ? `Oda istekleri (${n})` : 'Oda istekleri';
    $('request-count').textContent = n ? String(n) : '';
    $('request-count').classList.toggle('badge-accent', n > 0);
    $('requests-open').setAttribute('aria-label', n ? `İstekler, ${n} bekliyor` : 'İstekler');
  }

  async function loadRequests() {
    const res = await api('GET', '/admin/room-requests');
    const list = $('request-list');
    list.replaceChildren();
    if (res.error) {
      $('request-empty-text').textContent = res.error;
      $('request-empty').hidden = false;
      return;
    }
    pending = res.requests.length;
    renderPending();
    $('request-empty-text').textContent = 'Bekleyen istek yok.';
    $('request-empty').hidden = res.requests.length > 0;
    for (const q of res.requests) {
      const li = el('li', 'list-row request-row');
      const info = el('div', 'list-row-main');
      info.append(withLock(el('div', 'list-row-title'), q.locked, q.name));
      info.append(el('div', 'request-meta', [`İsteyen: ${q.by}`, fmtDate(q.createdAt)].join(' · ')));
      if (q.note) info.append(el('div', 'request-note', q.note));
      const yes = el('button', 'btn btn-primary btn-sm', 'Onayla');
      const no = el('button', 'btn btn-ghost btn-danger btn-sm', 'Reddet');
      yes.type = no.type = 'button';
      yes.onclick = () => decide(q, true, [yes, no]);
      no.onclick = () => decide(q, false, [yes, no]);
      const actions = el('div', 'request-actions');
      actions.append(no, yes);
      li.append(makeAvatar(q.by), info, actions);
      list.append(li);
    }
  }

  async function decide(q, approve, buttons) {
    for (const b of buttons) b.disabled = true;
    const res = await api('POST', `/admin/room-requests/${encodeURIComponent(q.id)}`, { approve });
    toast(res.error || (approve ? `${q.name} odası açıldı.` : `${q.name} isteği reddedildi.`));
    loadRequests();
  }
  $('requests-open').onclick = () => {
    openDialog('requests-dialog');
    loadRequests();
  };

  const openCreate = () => {
    showError('create-error', '');
    openDialog('create-dialog', 'create-name');
  };
  $('create-open').onclick = openCreate;
  $('empty-action').onclick = () => (isAdmin() ? openCreate() : openRequest());
  $('room-create').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    showError('create-error', '');
    const res = await api('POST', '/rooms', {
      name: $('create-name').value,
      password: $('create-password').value || undefined,
      theme: $('create-theme').value,
      owner: $('create-owner').value.trim() || undefined,
    });
    btn.disabled = false;
    if (res.error) return showError('create-error', res.error);
    $('room-create').reset();
    $('create-dialog').close();
    toast(`${res.room.name} odası açıldı.`);
  };

  // ---------- Hesap penceresi ----------
  // Profil resmi ve çıkış düğmelerini app.js bağlar (odadaki ayarlar penceresiyle ortak); burada pencere ve
  // şifre değiştirme.

  function renderChip() {
    if (!account) return;
    $('account-chip-avatar').replaceChildren(makeAvatar(account.name));
    $('account-chip-name').textContent = account.name;
    $('account-role').textContent = isAdmin() ? 'Yönetici' : 'Üye';
  }
  $('account-open').onclick = () => openDialog('account-dialog');
  $('account-dialog').addEventListener('close', closePassForm);

  function closePassForm() {
    $('pass-form').reset();
    $('pass-form').hidden = true;
    $('pass-open').setAttribute('aria-expanded', 'false');
    showError('pass-error', '');
  }
  $('pass-open').onclick = () => {
    if (!$('pass-form').hidden) return closePassForm();
    $('pass-form').hidden = false;
    $('pass-open').setAttribute('aria-expanded', 'true');
    $('pass-current').focus();
  };
  $('pass-cancel').onclick = closePassForm;
  $('pass-form').onsubmit = async (e) => {
    e.preventDefault();
    const current = $('pass-current').value;
    const password = $('pass-new').value;
    if (!current || !password) return showError('pass-error', 'Mevcut ve yeni şifreni yaz.');
    if (password !== $('pass-new2').value) return showError('pass-error', 'Yeni şifreler aynı değil.');
    const btn = e.submitter || e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    const res = await api('POST', '/auth/password', { current, password });
    btn.disabled = false;
    if (res.error) return showError('pass-error', res.error);
    closePassForm();
    toast('Şifren değişti. Öteki cihazlardaki oturumların kapandı.');
  };

  // ---------- Üyeler (/uyeler) ----------
  // Açılmış bütün hesaplar; sadece yöneticide listenin üst çubuğunda görünür.

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
        <span class="badge badge-live member-badge" hidden></span>`;
      li.prepend(makeAvatar(m.name));
      li.querySelector('.p-label').textContent = m.name + (m.name === account?.name ? ' (sen)' : '') + (m.admin ? ' · yönetici' : '');
      li.querySelector('.p-status').textContent =
        `Katıldı: ${fmtDate(m.createdAt)} · Son giriş: ${m.online ? 'şu an odada' : fmtDate(m.lastSeen)} · ${m.devices} cihazda açık`;
      const badge = li.querySelector('.member-badge');
      badge.hidden = !m.online;
      badge.textContent = 'Odada';
      $('members-list').append(li);
    }
  }
  $('members-refresh').onclick = loadMembers;

  // ---------- Liste düzeyinde gezinme: / ve /uyeler ----------

  function showPage(page) {
    if (page === 'members' && !isAdmin()) page = 'list';
    $('lobby-nav-rooms').classList.toggle('active', page === 'list');
    $('lobby-nav-members').classList.toggle('active', page === 'members');
    $('lobby-rooms').hidden = page !== 'list';
    $('members').hidden = page !== 'members';
    if (page === 'members') loadMembers();
    return page;
  }
  function goPage(page) {
    page = showPage(page);
    const path = page === 'members' ? '/uyeler' : '/';
    if (location.pathname !== path) history.pushState({ page }, '', path);
  }
  $('lobby-nav-rooms').onclick = () => {
    target = null;
    renderRooms();
    goPage('list');
  };
  $('lobby-nav-members').onclick = () => goPage('members');
  addEventListener('popstate', () => {
    if ($('lobby-screen').hidden) return;
    const view = pathView(location.pathname);
    target = view.room || null;
    renderRooms();
    showPage(view.page === 'members' ? 'members' : 'list');
  });

  // ---------- app.js'e açılan yüzey ----------

  function show() {
    const view = pathView(location.pathname);
    target = view.room ? homeAfterReload(view.room) : null; // birleşik odada misafir kökenliyse kendi odası
    targetChecked = false;
    $('lobby-screen').hidden = false;
    $('lobby-nav-members').hidden = !isAdmin();
    $('lobby-nav').hidden = !isAdmin(); // üyede tek sayfa var: sekme şeridi gereksiz
    $('requests-open').hidden = !isAdmin();
    $('step-first').textContent = isAdmin() ? 'Oda aç' : 'Oda iste';
    $('empty-action-text').textContent = isAdmin() ? 'Oda aç' : 'Oda iste';
    $('room-empty-text').textContent = isAdmin()
      ? 'İlk odayı aç; arkadaşların listede görüp tek tıkla girer.'
      : 'Bir oda iste; yönetici onaylayınca açılır ve sahibi sen olursun.';
    renderChip();
    renderPending();
    const page = showPage(view.page === 'members' ? 'members' : 'list');
    if (view.page === 'members' && page !== 'members') history.replaceState({ page }, '', '/');
    renderMine();
    renderRooms();
    if (isAdmin()) loadRequests();
    else loadMine();
    try {
      const notice = sessionStorage.getItem(NOTICE_KEY);
      sessionStorage.removeItem(NOTICE_KEY);
      if (notice) toast(notice);
    } catch {}
  }

  function hide() {
    for (const d of document.querySelectorAll('#lobby-screen dialog[open]')) d.close();
    $('lobby-screen').hidden = true;
  }

  // Sunucudan gelen liste ({ rooms }), yöneticide bekleyen istek sayısı ({ pending }) ya da
  // isteğimin sonucu ({ decided: { status, name } }; reddedilince istek formu yeniden görünür).
  function update({ rooms: next, pending: count, decided } = {}) {
    if (decided && !isAdmin()) {
      mine = { ...mine, name: decided.name, status: decided.status };
      renderMine();
      toast(decided.status === 'approved' ? `Oda isteğin onaylandı: ${decided.name}` : `Oda isteğin reddedildi: ${decided.name}`);
    }
    if (next) {
      rooms = next;
      if (passRoom) passRoom = rooms.find((r) => r.id === passRoom.id) || passRoom;
      renderRooms();
      checkTarget();
      if (mine?.status === 'pending') loadMine(); // onaylanınca oda listeye düşer
    }
    if (count != null && isAdmin()) {
      const more = pending != null && count > pending;
      pending = count;
      renderPending();
      if (more) toast(`Yeni oda isteği var (${count} bekliyor).`);
      if (!$('lobby-screen').hidden) loadRequests();
    }
  }

  return {
    show,
    hide,
    update,
    onEnter(fn) {
      enter = fn;
    },
    emblem: roomEmblem, // odanın üst çubuğu da aynı amblemi kullanır
  };
})();
