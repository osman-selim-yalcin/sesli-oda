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
  // Odanın tek görsel imzası: baş harf + oda kimliğinden türetilen ton (--hue). Kartta ve (Lobby.emblem ile)
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

  // ---------- Tema seçici ----------
  // Oda aç, oda iste ve oda ayarları pencerelerinde ortak. box: <fieldset class="theme-picker"> (ilk çocuğu
  // <legend>); içine her tema için bir radyo kutucuğu yazılır (name = box.id): o temanın kendi renkleriyle küçük
  // bir oda taslağı (Theme.preview, tema CSS'i yüklenmeden) ve adı. Seçili olan vurgulu çerçeve ve onay işaretiyle
  // görünür. Tek tema varken yanına kısa bir not gelir (boş görünmesin). Klavye: ok tuşları (yerel radyo grubu).
  // value: seçili olacak tema (verilmezse seçim korunur). current: odanın şu anki teması ("Şu an" etiketi; yalnız
  // oda ayarlarında). Tema listesi değişmediyse kutucuklar yeniden yazılmaz, yalnız seçim ve etiket güncellenir
  // (klavye odağı yerinde kalır); yeniden yazılırsa odak seçili kutucuğa döner.
  function themePicker(box, value, current = null) {
    const list = Theme.list;
    const old = pickedTheme(box);
    const picked = list.includes(value) ? value : list.includes(old) ? old : Theme.DEFAULT;
    const inputs = [...box.querySelectorAll('.theme-swatch-input')];
    if (inputs.length !== list.length || inputs.some((x, i) => x.value !== list[i])) {
      const hadFocus = box.contains(document.activeElement);
      const grid = el('div', 'theme-picker-grid');
      for (const id of list) {
        const c = Theme.preview(id);
        const opt = el('label', 'theme-swatch');
        opt.dataset.theme = id;
        const input = el('input', 'theme-swatch-input');
        input.type = 'radio';
        input.name = box.id;
        input.value = id;
        const art = el('span', 'theme-swatch-art');
        art.setAttribute('aria-hidden', 'true');
        art.style.setProperty('--sw-bg', c.bg);
        art.style.setProperty('--sw-surface', c.surface);
        art.style.setProperty('--sw-text', c.text);
        art.style.setProperty('--sw-accent', c.accent);
        const panel = el('span', 'theme-swatch-panel');
        panel.append(el('span', 'theme-swatch-line'), el('span', 'theme-swatch-line is-short'), el('span', 'theme-swatch-btn'));
        art.append(panel, el('span', 'theme-swatch-side'));
        const foot = el('span', 'theme-swatch-foot');
        const mark = el('span', 'theme-swatch-mark');
        mark.innerHTML = icon('check');
        foot.append(el('span', 'theme-swatch-name', Theme.name(id)), mark);
        opt.append(input, art, el('span', 'badge theme-swatch-now', 'Şu an'), foot); // etiket taslağın köşesinde
        grid.append(opt);
      }
      if (list.length === 1) grid.append(el('p', 'theme-picker-note', 'Şimdilik tek tema var; yeni temalar geldikçe burada seçilir.'));
      const legend = box.querySelector('legend');
      box.replaceChildren(...(legend ? [legend] : []), grid);
      for (const input of box.querySelectorAll('.theme-swatch-input')) input.defaultChecked = input.value === picked; // form.reset()
      if (hadFocus) queueMicrotask(() => box.querySelector('.theme-swatch-input:checked')?.focus());
    }
    for (const input of box.querySelectorAll('.theme-swatch-input')) {
      if (input.value === picked) input.checked = true;
      const now = list.length > 1 && input.value === current;
      input.closest('.theme-swatch').classList.toggle('is-current', now);
    }
  }
  const pickedTheme = (box) => box.querySelector('input:checked')?.value || null;

  // Sunucudan tema listesi gelince (Theme 'themelist') seçiciler ve kart önizlemeleri yeniden çizilir.
  for (const id of ['create-theme', 'request-theme']) themePicker($(id), Theme.DEFAULT);
  document.addEventListener('themelist', () => {
    for (const id of ['create-theme', 'request-theme']) themePicker($(id));
    if (!$('lobby-screen').hidden) renderRooms();
  });

  // ---------- Odalar ----------

  const MAX_FACES = 5; // kartta en çok bu kadar yüz, fazlası "+N"
  // Dolu oda: hesabın kendisi zaten içerideyse (ör. telefondan dizüstüne geçiş) dolu sayılmaz; sunucu girişte o
  // hesabın eski oturumunu düşürüp öyle sayar.
  const isFull = (r) => r.users.length >= r.max && !r.users.includes(account?.name);

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
    const action = go.textContent;
    foot.append(faces(r.users), occ, go);
    body.append(foot);
    card.append(top, body);

    // Erişilebilir ad görünen eylemi de içerir (ör. "Şifreyle gir").
    const label = [
      `${r.name}: ${action}`,
      r.role === 'owner' && 'Senin odan',
      `sahibi ${r.owner}`,
      r.locked && 'şifreli',
      `${r.users.length}/${r.max} kişi`,
      partner && `${partner.name} ile birleşik`,
    ].filter(Boolean).join(', ');
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
    $('room-pass-wait').textContent = waiting ? `Çok fazla yanlış deneme; ${fmtLeft(left)} sonra tekrar dene.` : '';
    if (waiting) showError('room-pass-error', ''); // beklerken tek satır: geri sayım
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
  const seenKey = (q) => `${q.id ?? q.name}|${q.status}`; // aynı adla sonraki istek yeniden görünsün
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
      theme: pickedTheme($('request-theme')) || Theme.DEFAULT,
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

  // Karardan sonra klavye odağı pencerede kalır: aynı sıradaki (yoksa son) isteğin ilk düğmesine, liste boşsa
  // kapat düğmesine geçer.
  async function decide(q, approve, buttons) {
    const row = buttons[0].closest('li');
    const index = [...$('request-list').children].indexOf(row);
    for (const b of buttons) b.disabled = true;
    const res = await api('POST', `/admin/room-requests/${encodeURIComponent(q.id)}`, { approve });
    toast(res.error || (approve ? `${q.name} odası açıldı.` : `${q.name} isteği reddedildi.`));
    await loadRequests();
    if (!$('requests-dialog').open) return;
    const rows = $('request-list').children;
    const next = rows[Math.min(index, rows.length - 1)]?.querySelector('button');
    (next || $('requests-dialog').querySelector('.dialog-close')).focus();
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
      theme: pickedTheme($('create-theme')) || Theme.DEFAULT,
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

  const DAY_FMT = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' });
  const TIME_FMT = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' });
  const FULL_FMT = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const fmtDay = (ms) => (ms ? DAY_FMT.format(ms) : '—');
  // Oda isteği satırı: tam tarih ve saat
  const fmtDate = (ms) => (ms ? FULL_FMT.format(ms) : '—');
  // Son görülme: bugünse saat, değilse gün
  const fmtSeen = (ms) => {
    if (!ms) return '—';
    return new Date(ms).toDateString() === new Date().toDateString() ? `Bugün ${TIME_FMT.format(ms)}` : DAY_FMT.format(ms);
  };

  // Satır: kişi (avatar, ad, "sen" ve "Yönetici" rozetleri) | Katıldı | Son görülme | Cihaz | Durum.
  // Masaüstünde tablo sütunları (başlık satırı index.html'de); dar ekranda bilgiler adın altında tek satır.
  function memberRow(m) {
    const li = document.createElement('li');
    li.className = 'member-row';
    li.innerHTML = `
      <div class="member-who">
        <div class="member-name"><span class="member-label-name"></span></div>
      </div>
      <div class="member-meta">
        <span class="member-cell member-joined"><span class="member-key">Katıldı</span><span class="member-val"></span></span>
        <span class="member-cell member-seen"><span class="member-key">Son görülme</span><span class="member-val"></span></span>
        <span class="member-cell member-devices"><span class="member-key">Cihaz</span><span class="member-val"></span><span class="member-unit">cihaz</span></span>
      </div>
      <div class="member-state"></div>`;
    const avatar = makeAvatar(m.name);
    avatar.classList.add('avatar-md');
    li.querySelector('.member-who').prepend(avatar);
    const name = li.querySelector('.member-name');
    li.querySelector('.member-label-name').textContent = m.name;
    if (m.name === account?.name) name.append(Object.assign(document.createElement('span'), { className: 'badge member-you', textContent: 'sen' }));
    if (m.admin) name.append(Object.assign(document.createElement('span'), { className: 'badge badge-accent', textContent: 'Yönetici' }));
    const [joined, seen, devices] = li.querySelectorAll('.member-val');
    joined.textContent = fmtDay(m.createdAt);
    joined.parentElement.title = m.createdAt ? FULL_FMT.format(m.createdAt) : '';
    seen.textContent = m.online ? 'Şu an' : fmtSeen(m.lastSeen);
    seen.parentElement.title = m.lastSeen ? FULL_FMT.format(m.lastSeen) : '';
    devices.textContent = m.devices ?? 0;
    devices.parentElement.title = `${m.devices ?? 0} cihazda oturumu açık`;
    const state = li.querySelector('.member-state');
    if (m.online) state.append(Object.assign(document.createElement('span'), { className: 'badge badge-live member-badge', textContent: 'Odada' }));
    else state.append(Object.assign(document.createElement('span'), { className: 'member-off', textContent: 'Çevrimdışı' }));
    return li;
  }

  async function loadMembers() {
    $('members').setAttribute('aria-busy', 'true');
    $('members-count').replaceChildren(Object.assign(document.createElement('span'), { className: 'spinner' }), ' Yükleniyor…');
    const res = await api('GET', '/admin/members');
    $('members').removeAttribute('aria-busy');
    $('members-list').replaceChildren();
    const failed = Boolean(res.error);
    $('members-empty').hidden = !failed && res.members.length > 0;
    $('members-empty').classList.toggle('notice', failed);
    $('members-empty').classList.toggle('notice-danger', failed);
    $('members-head').hidden = failed || !res.members.length;
    if (failed) {
      $('members-count').textContent = '';
      $('members-empty').textContent = res.error;
      return;
    }
    $('members-empty').textContent = 'Henüz hesap yok.';
    const here = res.members.filter((m) => m.online).length;
    $('members-count').textContent = `${res.members.length} hesap · ${here} odada`;
    $('members-list').append(...res.members.map(memberRow));
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
    themePicker, // oda ayarları penceresi de aynı seçiciyi kullanır
    pickedTheme,
  };
})();
