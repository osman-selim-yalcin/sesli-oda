'use strict';

// Oda listesi ekranı (#lobby-screen): odalar (canlı), şifre penceresi, hesap paneli (profil resmi, şifre
// değiştirme, çıkış), oda isteği; yöneticide istekler, oda açma ve üyeler (/uyeler).
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
  const isAdmin = () => Boolean(account?.admin);
  function showError(id, text) {
    $(id).textContent = text || '';
    $(id).hidden = !text;
  }

  // ---------- Odalar ----------

  function renderRooms() {
    const list = $('room-list');
    list.replaceChildren();
    $('room-list-empty').hidden = rooms.length > 0;
    for (const r of rooms) {
      const btn = el('button', `room-card${r.id === target ? ' target' : ''}`);
      btn.type = 'button';
      btn.disabled = Boolean(busyId);
      const info = el('span', 'room-info');
      info.append(el('strong', 'room-name', (r.locked ? '🔒 ' : '') + r.name));
      const partner = r.mergedWith && rooms.find((x) => x.id === r.mergedWith);
      const meta = [
        `Sahibi: ${r.owner}`,
        `${r.users.length}/${r.max} kişi`,
        partner && `${partner.name} ile birleşik`,
        r.role === 'none' && 'şifre gerekir',
      ].filter(Boolean).join(' · ');
      info.append(el('span', 'muted small', meta));
      if (r.users.length) {
        const strip = el('span', 'avatar-strip');
        for (const name of r.users) strip.append(makeAvatar(name));
        info.append(strip);
      }
      const label = busyId === r.id ? 'Bağlanıyor…' : r.id === target ? 'Odaya gir' : 'Gir';
      btn.append(info, el('span', `room-go${r.id === target ? ' primary' : ''}`, label));
      btn.onclick = () => tryEnter(r);
      list.append(wrap(btn));
    }
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

  function openPass(room, error = '') {
    passRoom = room;
    $('room-pass-title').textContent = room.name;
    showError('room-pass-error', error);
    $('room-pass-ok').disabled = (waitUntil.get(room.id) || 0) > Date.now();
    if (!$('room-pass').open) {
      $('room-pass-input').value = '';
      $('room-pass').showModal();
    }
    $('room-pass-input').select();
  }
  function closePass() {
    if ($('room-pass').open) $('room-pass').close();
  }
  $('room-pass').addEventListener('close', () => (passRoom = null));
  $('room-pass-cancel').onclick = closePass;
  $('room-pass-form').onsubmit = (e) => {
    e.preventDefault();
    const password = $('room-pass-input').value;
    if (!password) return showError('room-pass-error', 'Oda şifresini yaz.');
    if (passRoom) tryEnter(passRoom, password);
  };

  // ---------- Oda isteği (üye) ----------

  async function loadMine() {
    const res = await api('GET', '/rooms/requests/mine');
    if (res.error) return;
    mine = res.request;
    renderMine();
  }
  function renderMine() {
    $('my-request').hidden = isAdmin() || !mine;
    if (mine) $('my-request').textContent = `Oda isteğin: ${mine.name} · ${REQUEST_STATUS[mine.status] || mine.status}`;
    $('room-request').hidden = isAdmin() || mine?.status === 'pending';
  }
  $('room-request').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector('button');
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
    mine = res.request;
    renderMine();
    toast('İsteğin yöneticiye gitti.');
  };

  // ---------- Yönetici: istekler ve oda açma ----------

  function renderPending() {
    $('request-title').textContent = `İstekler (${pending ?? 0})`;
  }

  async function loadRequests() {
    const res = await api('GET', '/admin/room-requests');
    const list = $('request-list');
    list.replaceChildren();
    if (res.error) return showError('request-empty', res.error);
    pending = res.requests.length;
    renderPending();
    $('request-empty').textContent = 'Bekleyen istek yok.';
    $('request-empty').hidden = res.requests.length > 0;
    for (const q of res.requests) {
      const li = el('li');
      const info = el('div', 'p-info');
      info.append(el('div', 'p-name', (q.locked ? '🔒 ' : '') + q.name));
      info.append(el('div', 'p-status', [`İsteyen: ${q.by}`, fmtDate(q.createdAt), q.note].filter(Boolean).join(' · ')));
      const yes = el('button', 'primary sm', 'Onayla');
      const no = el('button', 'danger sm', 'Reddet');
      yes.onclick = () => decide(q, true, [yes, no]);
      no.onclick = () => decide(q, false, [yes, no]);
      li.append(makeAvatar(q.by), info, yes, no);
      list.append(li);
    }
  }

  async function decide(q, approve, buttons) {
    for (const b of buttons) b.disabled = true;
    const res = await api('POST', `/admin/room-requests/${encodeURIComponent(q.id)}`, { approve });
    toast(res.error || (approve ? `${q.name} odası açıldı.` : `${q.name} isteği reddedildi.`));
    loadRequests();
  }

  $('room-create').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector('button');
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
    toast(`${res.room.name} odası açıldı.`);
  };

  // ---------- Hesap: şifre değiştirme ----------
  // Profil resmi ve çıkış düğmelerini app.js bağlar (odadaki ayarlar penceresiyle ortak).

  function closePassForm() {
    $('pass-form').reset();
    $('pass-form').hidden = true;
    showError('pass-error', '');
  }
  $('pass-open').onclick = () => {
    if (!$('pass-form').hidden) return closePassForm();
    $('pass-form').hidden = false;
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
        <span class="member-badge" hidden></span>`;
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
    target = view.room || null;
    targetChecked = false;
    $('lobby-screen').hidden = false;
    $('lobby-nav-members').hidden = !isAdmin();
    $('admin-requests').hidden = $('room-create').hidden = !isAdmin();
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
    closePass();
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
  };
})();
