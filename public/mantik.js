// ---------- Mantık tablosu ----------
// app.js'ten sonra yüklenir; onun globallerini ($, socket, myName, LOBBY, renderLobby, confirmButton, fmtTime,
// lobbyButton, lobbyEmit, kelimeSmall) kullanır. Herkes aynı bulmacayı çözer; tablodaki işaretler (✗/✓) ve
// kullanılmış ipuçları sadece bu tarayıcıda, oyuna göre saklanır. Çözüm sunucuda; "Kontrol et" ✓'lerden
// çıkan cevabı gönderir, sunucu sadece doğru ya da değil der.

let mantik = null;
let mantikClock = 0; // sunucu saati - bu saat
let mantikTick = null;
let mantikUndo = []; // not değişikliklerinden önceki haller (JSON), en çok 100
let mantikMsgTimer = null;
const MANTIK_CYCLE = { '': 'x', x: 'v', v: 'q', q: '' }; // q = ? (emin değilim notu; doldurma ve kontrol saymaz)
const mantikNotesKey = () => `mantikNotes:${myName}`;
const MANTIK_AUTO_KEY = 'mantikAutoFill'; // eski 'mantikAutoX' sadece ✗ koyuyordu; yeni ayar varsayılan açık

const mantikPlaying = () => Boolean(mantik && mantik.players.includes(myName) && !mantik.gone?.includes(myName));
const mantikActive = () => (mantik && !mantik.done ? mantik : null);
const mantikSolving = () => Boolean(mantikActive() && mantikPlaying() && !mantik.finished[myName]);

function mantikAuto() {
  try { return localStorage.getItem(MANTIK_AUTO_KEY) !== '0'; } catch { return true; }
}

function mantikNotes() {
  let notes = null;
  try { notes = JSON.parse(localStorage.getItem(mantikNotesKey())); } catch {}
  if (!mantik || notes?.id !== mantik.id) notes = { id: mantik?.id ?? null, marks: {}, used: [] };
  return { marks: {}, used: [], ...notes };
}
function mantikSaveNotes(notes) {
  try { localStorage.setItem(mantikNotesKey(), JSON.stringify(notes)); } catch {}
}
// Notu değiştirir; önceki hali geri al için saklanır.
function mantikEdit(fn) {
  const notes = mantikNotes();
  mantikUndo.push(JSON.stringify(notes));
  if (mantikUndo.length > 100) mantikUndo.shift();
  fn(notes);
  mantikSaveNotes(notes);
  renderMantik();
}

// Tablo düzeni (merdiven): sütunlarda 1..k-1. kategoriler; satırlarda önce isimler, sonra sondan başa diğerleri.
// r. satır kategorisi c. sütun kategorisiyle r = 0 ya da c < r ise karşılaşır.
const mantikRowCats = (k) => [0, ...Array.from({ length: k - 2 }, (_, i) => k - 1 - i)];
const mantikHas = (r, c) => r === 0 || c < r;
const mantikKey = (r, c, rv, cv) => `${r},${c},${rv},${cv}`;

// İki kategori arasındaki işaret (hangi alt tabloda durduğu fark etmez): a. kategorinin av değeri – b.'nin bv değeri.
// Merdivende her çift bir kez var: isimler (0) satırda, diğer çiftlerde büyük numaralı kategori satırda.
function mantikPairKey(a, av, b, bv) {
  if (a === 0 || (b !== 0 && a > b)) return mantikKey(a, b, av, bv);
  return mantikKey(b, a, bv, av);
}

// Otomatik doldurma: kullanıcının işaretlerinden kesin çıkanları boş hücrelere yazar (var olan işarete dokunmaz).
// Kayıtta sadece kullanıcının işaretleri durur; doldurulanlar her çizimde yeniden hesaplanır, böylece bir ✓ silinince
// ondan çıkanlar da kalkar.
// 1) Bir ✓'in satırı ve sütunu (o alt tabloda) ✗. 2) Satırda/sütunda tek boş kalıp gerisi ✗ ise o ✓.
// 3) Geçişlilik: A–B ✓ ve B–C ✓ ise A–C ✓; A–B ✓ ve B–C ✗ ise A–C ✗.
function mantikFill(own) {
  const marks = { ...own };
  const k = mantik.cats.length;
  // ? işareti boş sayılır; kesin çıkan bir sonuç ?'in yerine (soluk) görünür.
  const get = (a, av, b, bv) => { const m = marks[mantikPairKey(a, av, b, bv)]; return m === 'q' ? '' : m || ''; };
  let changed = true;
  const set = (a, av, b, bv, m) => {
    const key = mantikPairKey(a, av, b, bv);
    if (!marks[key] || marks[key] === 'q') { marks[key] = m; changed = true; }
  };
  for (let round = 0; changed && round < 30; round++) {
    changed = false;
    for (let a = 0; a < k; a++) {
      for (let b = a + 1; b < k; b++) {
        for (let i = 0; i < 4; i++) {
          for (let j = 0; j < 4; j++) {
            if (get(a, i, b, j) !== 'v') continue;
            for (let o = 0; o < 4; o++) {
              if (o !== j) set(a, i, b, o, 'x');
              if (o !== i) set(a, o, b, j, 'x');
            }
          }
          const rowOpen = [0, 1, 2, 3].filter((j) => get(a, i, b, j) !== 'x');
          if (rowOpen.length === 1 && !get(a, i, b, rowOpen[0])) set(a, i, b, rowOpen[0], 'v');
          const colOpen = [0, 1, 2, 3].filter((j) => get(a, j, b, i) !== 'x');
          if (colOpen.length === 1 && !get(a, colOpen[0], b, i)) set(a, colOpen[0], b, i, 'v');
        }
      }
    }
    for (let a = 0; a < k; a++) {
      for (let b = 0; b < k; b++) {
        if (b === a) continue;
        for (let c = 0; c < k; c++) {
          if (c === a || c === b) continue;
          for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
              if (get(a, i, b, j) !== 'v') continue;
              for (let l = 0; l < 4; l++) {
                const m = get(b, j, c, l);
                if (m) set(a, i, c, l, m);
              }
            }
          }
        }
      }
    }
  }
  return marks;
}

// Ekranda görünen işaretler: kullanıcınınkiler + (ayar açıksa) onlardan çıkanlar.
const mantikShown = (own) => (mantikAuto() ? mantikFill(own) : own);

// Hücreye basınca görünen işaretten bir sonrakine geçer ve kullanıcının işareti olarak saklanır.
function mantikToggle(r, c, rv, cv) {
  mantikEdit((notes) => {
    const key = mantikKey(r, c, rv, cv);
    const next = MANTIK_CYCLE[mantikShown(notes.marks)[key] || ''];
    if (next) notes.marks[key] = next;
    else delete notes.marks[key];
  });
}

// Cevap tablosundan seçim: p. kişinin c. kategorideki değeri v (null = boş). Tablodaki ✓ da buna göre değişir.
function mantikPick(c, p, v) {
  mantikEdit((notes) => {
    for (let i = 0; i < 4; i++) {
      for (const key of [mantikKey(0, c, p, i), mantikKey(0, c, i, v ?? -1)]) if (notes.marks[key] === 'v') delete notes.marks[key];
    }
    if (v == null) return;
    notes.marks[mantikKey(0, c, p, v)] = 'v';
  });
}

// Cevap tablosu: her isim bir satır, her kategori bir seçim kutusu; değerler isim tablosundaki ✓'lerden okunur.
function renderMantikSheet(marks, editable) {
  const game = mantik;
  const k = game.cats.length;
  const tickOf = (c, p) => {
    const ticks = [0, 1, 2, 3].filter((v) => marks[mantikKey(0, c, p, v)] === 'v');
    return ticks.length === 1 ? ticks[0] : null;
  };
  const table = mantikCell('table', 'mantik-sheet');
  const head = document.createElement('tr');
  head.append(mantikCell('th', null, game.cats[0].title));
  for (let c = 1; c < k; c++) head.append(mantikCell('th', null, game.cats[c].title));
  table.append(head);
  for (let p = 0; p < 4; p++) {
    const tr = document.createElement('tr');
    tr.append(mantikCell('th', 'mantik-sheet-name', game.cats[0].values[p]));
    for (let c = 1; c < k; c++) {
      const td = document.createElement('td');
      const sel = document.createElement('select');
      const mine = tickOf(c, p);
      sel.className = mine == null ? 'empty' : '';
      sel.disabled = !editable;
      sel.append(new Option('?', ''));
      game.cats[c].values.forEach((label, v) => {
        const owner = [0, 1, 2, 3].find((q) => q !== p && tickOf(c, q) === v);
        const no = marks[mantikKey(0, c, p, v)] === 'x';
        const opt = new Option(label + (owner != null ? ` (${game.cats[0].values[owner]})` : no ? ' ✗' : ''), String(v));
        opt.selected = v === mine;
        sel.append(opt);
      });
      sel.onchange = () => mantikPick(c, p, sel.value === '' ? null : Number(sel.value));
      td.append(sel);
      tr.append(td);
    }
    table.append(tr);
  }
  $('mantik-sheet').replaceChildren(table);
}

// ✓'lerden cevap çıkarır: answer[c - 1][kişi] = değer. Döner: { answer } ya da { error }.
function mantikAnswer(marks) {
  const k = mantik.cats.length;
  const answer = [];
  for (let c = 1; c < k; c++) {
    const row = [];
    const cols = new Set();
    for (let p = 0; p < 4; p++) {
      const ticks = [0, 1, 2, 3].filter((v) => marks[mantikKey(0, c, p, v)] === 'v');
      if (ticks.length !== 1) return { error: ticks.length ? 'Bir satırda birden çok ✓ var.' : 'Tablo tamam değil: her ismin her kategoride bir ✓\'i olmalı.' };
      if (cols.has(ticks[0])) return { error: 'Bir sütunda birden çok ✓ var.' };
      cols.add(ticks[0]);
      row.push(ticks[0]);
    }
    answer.push(row);
  }
  // Alt tablolardaki ✓'ler isim tablosuyla çelişmemeli.
  const personOf = (c, v) => (c === 0 ? v : answer[c - 1].indexOf(v));
  for (const r of mantikRowCats(k).slice(1)) {
    for (let c = 1; c < r; c++) {
      for (let rv = 0; rv < 4; rv++) {
        for (let cv = 0; cv < 4; cv++) {
          if (marks[mantikKey(r, c, rv, cv)] === 'v' && personOf(r, rv) !== personOf(c, cv)) return { error: 'Tablodaki ✓\'ler birbiriyle çelişiyor.' };
        }
      }
    }
  }
  return { answer };
}

function mantikMsg(text, kind) {
  const el = $('mantik-msg');
  el.textContent = text;
  el.className = `small mantik-msg${kind ? ` ${kind}` : ''}`;
  clearTimeout(mantikMsgTimer);
  if (text) mantikMsgTimer = setTimeout(() => mantikMsg(''), 4000);
}

$('mantik-check').onclick = async () => {
  if (!mantikSolving()) return;
  const { answer, error } = mantikAnswer(mantikShown(mantikNotes().marks));
  if (error) return mantikMsg(error, 'warn');
  const btn = $('mantik-check');
  btn.disabled = true;
  const res = await emitAck(8000, 'mantik:check', answer);
  btn.disabled = false;
  if (!res) return mantikMsg('Sunucuya ulaşılamadı.', 'warn');
  if (res.error) return mantikMsg(res.error, 'warn');
  if (res.ok) return mantikMsg('Doğru! 🎉', 'ok');
  mantikMsg(`Doğru değil (−150 puan). Yanlış kontrol: ${res.wrong}`, 'warn');
};

// Sağ üstteki süre: bulmaca açılınca işler; çözünce ya da oyun bitince durur.
function renderMantikTimer() {
  const el = $('mantik-timer');
  const game = mantik;
  el.hidden = !game;
  clearInterval(mantikTick);
  mantikTick = null;
  if (!game) return;
  const draw = () => {
    const mine = game.finished?.[myName];
    const end = mine ? game.startedAt + mine.ms : game.done ? game.endedAt : Date.now() + mantikClock;
    el.textContent = `⏱ ${fmtTime((end - game.startedAt) / 1000)}`;
  };
  draw();
  if (!game.done && !game.finished?.[myName]) mantikTick = setInterval(draw, 1000);
}

function mantikCell(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

// Izgara: <table>; her alt tablo 4×4, aralarında kalın çizgi.
function renderMantikGrid(marks, editable, own = marks) {
  const game = mantik;
  const k = game.cats.length;
  const cols = Array.from({ length: k - 1 }, (_, i) => i + 1);
  const table = mantikCell('table', 'mantik-table');
  const head1 = document.createElement('tr');
  const corner = mantikCell('th', 'mantik-corner');
  corner.colSpan = 2;
  corner.rowSpan = 2;
  head1.append(corner);
  for (const c of cols) {
    const th = mantikCell('th', 'mantik-cat-col', game.cats[c].head);
    th.colSpan = 4;
    head1.append(th);
  }
  const head2 = document.createElement('tr');
  for (const c of cols) {
    game.cats[c].values.forEach((v, i) => {
      const th = mantikCell('th', 'mantik-col' + (i === 0 ? ' start' : ''));
      th.append(mantikCell('span', null, v));
      head2.append(th);
    });
  }
  const thead = document.createElement('thead');
  thead.append(head1, head2);
  const tbody = document.createElement('tbody');
  for (const r of mantikRowCats(k)) {
    for (let rv = 0; rv < 4; rv++) {
      const tr = document.createElement('tr');
      if (rv === 3) tr.className = 'end';
      if (rv === 0) {
        const th = mantikCell('th', 'mantik-cat-row');
        th.rowSpan = 4;
        th.append(mantikCell('span', null, game.cats[r].head));
        tr.append(th);
      }
      tr.append(mantikCell('th', 'mantik-row', game.cats[r].values[rv]));
      for (const c of cols) {
        if (!mantikHas(r, c)) break;
        for (let cv = 0; cv < 4; cv++) {
          const mark = marks[mantikKey(r, c, rv, cv)] || '';
          const td = mantikCell('td', 'mantik-td' + (cv === 0 ? ' start' : cv === 3 ? ' end' : ''));
          const auto = mark && own[mantikKey(r, c, rv, cv)] !== mark;
          const b = mantikCell('button', `mantik-cell${mark ? ` mark-${mark}` : ''}${auto ? ' auto' : ''}`, { x: '✗', v: '✓', q: '?' }[mark] || '');
          b.type = 'button';
          b.dataset.col = String((c - 1) * 4 + cv);
          b.title = `${game.cats[r].values[rv]} – ${game.cats[c].values[cv]}`;
          b.disabled = !editable;
          if (editable) b.onclick = () => mantikToggle(r, c, rv, cv);
          td.append(b);
          tr.append(td);
        }
      }
      tbody.append(tr);
    }
  }
  table.append(thead, tbody);
  // Üstüne gelinen hücrenin satır ve sütun başlığı (ve o satır/sütun) vurgulanır.
  const heads = [...head2.children];
  const clear = () => table.querySelectorAll('.hl').forEach((el) => el.classList.remove('hl'));
  table.addEventListener('pointerover', (e) => {
    clear();
    const cell = e.target.closest('.mantik-cell');
    if (!cell) return;
    const col = Number(cell.dataset.col);
    const tr = cell.closest('tr');
    tr.querySelector('.mantik-row')?.classList.add('hl');
    tr.querySelectorAll('.mantik-td').forEach((td) => td.classList.add('hl'));
    heads[col]?.classList.add('hl');
    table.querySelectorAll(`.mantik-cell[data-col="${col}"]`).forEach((b) => b.parentElement.classList.add('hl'));
  });
  table.addEventListener('pointerleave', clear);
  $('mantik-grid').replaceChildren(table);
  mantikFit();
}

// Hücre boyu kutunun genişliğine göre seçilir (36 px'e kadar), tablo telefonda da yana kaymadan sığar.
function mantikFit() {
  const table = $('mantik-grid').querySelector('.mantik-table');
  const box = $('mantik-grid').parentElement;
  if (!table || !box.clientWidth) return;
  table.style.removeProperty('--mc');
  const cols = (mantik.cats.length - 1) * 4;
  const label = table.querySelector('.mantik-cat-row').offsetWidth + table.querySelector('.mantik-row').offsetWidth;
  let size = Math.max(16, Math.min(36, Math.floor((box.clientWidth - label - 4) / cols)));
  table.style.setProperty('--mc', `${size}px`);
  // Kenar çizgileri de yer kaplar: taşıyorsa biraz daha küçült.
  for (let i = 0; i < 4 && size > 16 && box.scrollWidth > box.clientWidth; i++) {
    size = Math.max(16, size - Math.ceil((box.scrollWidth - box.clientWidth) / cols));
    table.style.setProperty('--mc', `${size}px`);
  }
}
addEventListener('resize', () => { if (!$('mantik-grid-box').hidden) mantikFit(); });

// Bitince çözüm: her kişi bir satır (zorda ev sırasıyla).
function renderMantikSolution() {
  const game = mantik;
  const box = $('mantik-solution');
  box.hidden = !(game?.done && game.answer);
  if (box.hidden) return;
  const value = (c, p) => (c === 0 ? game.cats[0].values[p] : game.cats[c].values[game.answer[c - 1][p]]);
  const kc = game.cats.findIndex((c) => c.key === 'konum');
  const people = [0, 1, 2, 3].sort((a, b) => (kc < 0 ? 0 : game.answer[kc - 1][a] - game.answer[kc - 1][b]));
  const table = mantikCell('table', 'mantik-sol');
  const head = document.createElement('tr');
  for (const c of game.cats) head.append(mantikCell('th', null, c.title));
  table.append(head);
  for (const p of people) {
    const tr = document.createElement('tr');
    game.cats.forEach((_, c) => tr.append(mantikCell('td', null, value(c, p))));
    table.append(tr);
  }
  box.replaceChildren(mantikCell('strong', null, 'Çözüm'), table);
}

function renderMantik() {
  const game = mantik;
  renderLobby('mantik');
  const playing = mantikPlaying();
  const active = mantikActive();
  const solving = mantikSolving();
  $('mantik-end').hidden = !(active && playing);
  $('mantik-close').hidden = !game?.done;
  $('mantik-play').hidden = !game;
  renderMantikTimer();
  if (!game) return;

  $('game-mantik').classList.toggle('zor', game.level === 'zor'); // telefonda daha kısa satır başlıkları
  const levelName = game.level === 'zor' ? 'Zor' : 'Kolay';
  $('mantik-status').textContent = game.done
    ? (game.reason ? `${game.reason} ` : '') + (game.winners.length > 1 ? 'Berabere!' : game.winners.length ? `🏆 ${game.winners[0]} kazandı` : 'Oyun bitti')
    : `${levelName} · ${game.clues.length} ipucu` + (playing ? '' : ' · izliyorsun');

  // Oyuncuların durumu (tablolar gizli)
  $('mantik-scores').replaceChildren(...game.players.map((p) => {
    const f = game.finished[p];
    const li = document.createElement('li');
    li.className = f ? 'found' : '';
    li.append(mantikCell('strong', null, p === myName ? 'Sen' : p));
    if (f) li.append(` · ✓ ${fmtTime(f.ms / 1000)} · `, mantikCell('b', null, `${f.points} puan`));
    else li.append(game.done ? ' · çözemedi' : ' · çözüyor');
    if (game.gone?.includes(p)) li.append(' (ayrıldı)');
    return li;
  }));

  const notes = playing ? mantikNotes() : { marks: {}, used: [] };
  const list = $('mantik-clues');
  list.replaceChildren(...game.clues.map((text, i) => {
    const li = mantikCell('li', notes.used.includes(i) ? 'used' : '');
    const b = mantikCell('button', 'mantik-clue');
    b.type = 'button';
    b.append(mantikCell('span', 'mantik-clue-no', `${i + 1}.`), mantikCell('span', null, text));
    b.disabled = !playing;
    if (playing) b.onclick = () => mantikEdit((n) => { n.used = n.used.includes(i) ? n.used.filter((x) => x !== i) : [...n.used, i]; });
    li.append(b);
    return li;
  }));

  // Tablo sadece oynayana; bitince herkese çözüm
  $('mantik-grid-box').hidden = !playing || game.done;
  if (playing && !game.done) {
    const shown = mantikShown(notes.marks);
    renderMantikGrid(shown, solving, notes.marks);
    renderMantikSheet(shown, solving);
    $('mantik-undo').disabled = !mantikUndo.length || !solving;
    $('mantik-reset').disabled = !solving;
    $('mantik-auto').checked = mantikAuto();
    $('mantik-check-row').hidden = !solving;
    const wrong = game.myWrong || 0;
    $('mantik-wrong').textContent = wrong ? `Yanlış kontrol: ${wrong} (−${wrong * 150})` : '';
  }
  renderMantikSolution();
}

$('mantik-auto').onchange = (e) => {
  try { localStorage.setItem(MANTIK_AUTO_KEY, e.target.checked ? '1' : '0'); } catch {}
  renderMantik();
};
$('mantik-undo').onclick = () => {
  const prev = mantikUndo.pop();
  if (!prev) return;
  mantikSaveNotes(JSON.parse(prev));
  renderMantik();
};
confirmButton($('mantik-reset'), 'Emin misin? Tekrar bas', () => mantikEdit((notes) => {
  notes.marks = {};
  notes.used = [];
}));
confirmButton($('mantik-end'), 'Emin misin? Tekrar bas', () => socket.emit('mantik:end'));
$('mantik-close').onclick = () => socket.emit('mantik:close');

function setMantik(game) {
  const fresh = game && mantik?.id !== game.id;
  mantik = game || null;
  if (game?.now) mantikClock = game.now - Date.now();
  if (fresh) {
    mantikUndo = [];
    mantikMsg('');
  }
  renderMantik();
}
socket.on('mantik', setMantik);

// Lobi: kurucu zorluğu seçer.
LOBBY.mantik = {
  title: 'Mantık tablosu', tab: 'mantik', running: () => Boolean(mantikActive()), last: () => mantik,
  hint: 'Herkes aynı bulmacayı aynı anda çözer; en hızlı ve en az yanlışla çözen kazanır. 1-6 kişi.',
  opts: (lobby, host) => {
    const row = document.createElement('div');
    row.className = 'lobby-opts';
    row.append(kelimeSmall('Zorluk:'));
    for (const [level, label] of [['kolay', 'Kolay'], ['zor', 'Zor']]) {
      const b = lobbyButton(label, 'sm' + (lobby.opts.level === level ? ' active' : ''), () => lobbyEmit('lobby:opts', 'mantik', { level }));
      b.disabled = !host;
      row.append(b);
    }
    return [row];
  },
};
