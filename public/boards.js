// ---------- Ortak skor tabloları: Mantık tablosu, Hızlı okuma, Dört Taş, Duvar (sunucu: games/boards.js) ----------
// app.js ve oyun dosyalarından sonra yüklenir. Tablo kutusu (.daktilo-records: başlık, sekmeler, .timing-list) oyunun
// lobisinin altına bir kez eklenir; oyun sürerken gizlenir. Tablolar bütün odalarda ortaktır.

const boardState = {
  mantik: { kolay: [], zor: [] },
  okuma: {},
  dorttas: { pvp: [], bot: { kolay: [], orta: [], zor: [] } },
  duvar: { pvp: [], bot: { kolay: [], orta: [], zor: [] } },
};
const boardTab = { mantik: 'kolay', dorttas: 'pvp', duvar: 'pvp', tablo: 5 };
const BOARD_DUEL_TABS = [['pvp', 'İki kişilik'], ['kolay', 'Bilgisayar: kolay'], ['orta', 'Bilgisayar: orta'], ['zor', 'Bilgisayar: zor']];

// Kutu: { wrap, tabs, list }. Yoksa lobinin altına ekler.
function boardBox(game, after) {
  let wrap = document.getElementById(`${game}-records`);
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = `${game}-records`;
    wrap.className = 'daktilo-records game-records';
    wrap.innerHTML = `<div class="race-head"><h2>Rekorlar</h2><div class="lobby-opts"></div></div><ol class="timing-list"></ol>`;
    after.after(wrap);
  }
  return { wrap, tabs: wrap.querySelector('.lobby-opts'), list: wrap.querySelector('.timing-list') };
}

function boardTabs(el, tabs, current, pick) {
  el.replaceChildren(...tabs.map(([key, label]) => lobbyButton(label, 'sm' + (key === current ? ' active' : ''), () => pick(key))));
}

function boardFill(list, rows, cells, empty) {
  list.replaceChildren(...rows.map((r, i) => {
    const [main, sub] = cells(r);
    const li = timingRow(r.name, main, sub);
    li.prepend(rankCell(i));
    return li;
  }));
  if (!rows.length) list.append(Object.assign(document.createElement('li'), { className: 'muted small', textContent: empty }));
}

const boardSecs = (ms) => (ms / 1000).toLocaleString(I18N.locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

// ----- Mantık tablosu -----
function renderMantikRecords() {
  const lobby = $('lobby-mantik');
  if (!lobby) return;
  const { wrap, tabs, list } = boardBox('mantik', lobby);
  wrap.hidden = Boolean(typeof mantik !== 'undefined' && mantik && !mantik.done);
  if (wrap.hidden) return;
  boardTabs(tabs, [['kolay', 'Kolay'], ['zor', 'Zor']], boardTab.mantik, (k) => { boardTab.mantik = k; renderMantikRecords(); });
  boardFill(list, boardState.mantik[boardTab.mantik] || [], (r) => [`${r.points} puan`, `${fmtTime(r.ms / 1000)}${r.wrong ? ` · ${r.wrong} yanlış` : ''}`],
    `${boardTab.mantik === 'zor' ? 'Zor' : 'Kolay'} bulmacada henüz rekor yok. Çözülen her bulmaca puanıyla girer.`);
}

// ----- Dört Taş ve Duvar -----
function renderDuelRecords(game) {
  const lobby = $(`lobby-${game}`);
  if (!lobby) return;
  const { wrap, tabs, list } = boardBox(game, lobby);
  // dorttas / duvar: public/dorttas.js ve duvar.js'in üst düzey değişkenleri
  const live = game === 'dorttas' ? (typeof dorttas !== 'undefined' ? dorttas : null) : (typeof duvar !== 'undefined' ? duvar : null);
  wrap.hidden = Boolean(live && !live.done);
  if (wrap.hidden) return;
  const tab = boardTab[game];
  boardTabs(tabs, BOARD_DUEL_TABS, tab, (k) => { boardTab[game] = k; renderDuelRecords(game); });
  const b = boardState[game];
  const rows = tab === 'pvp' ? b.pvp : b.bot?.[tab] || [];
  const sub = (r) => [r.losses && `${r.losses} yenilgi`, r.draws && `${r.draws} berabere`].filter(Boolean).join(' · ') || 'yenilgisiz';
  boardFill(list, rows, (r) => [`${r.wins} galibiyet`, `${r.games} oyun · ${sub(r)}`],
    tab === 'pvp' ? 'Henüz iki kişilik oyun yok. Biten her oyun galibiyet tablosuna girer.' : 'Bu zorlukta bilgisayara karşı henüz oyun yok.');
}

// ----- Hızlı okuma: alıştırma ekranının altında o alıştırmanın tablosu -----
function okumaRecords(body, drill) {
  const wrap = document.createElement('div');
  wrap.className = 'daktilo-records game-records okuma-records';
  wrap.innerHTML = `<div class="race-head"><h2>Rekorlar</h2><div class="lobby-opts"></div></div><ol class="timing-list"></ol>`;
  body.append(wrap);
  const tabs = wrap.querySelector('.lobby-opts');
  const list = wrap.querySelector('.timing-list');
  const draw = () => {
    if (!wrap.isConnected) return;
    let key = drill;
    if (drill === 'tablo') {
      boardTabs(tabs, [3, 4, 5, 6].map((n) => [n, `${n}×${n}`]), boardTab.tablo, (n) => { boardTab.tablo = n; draw(); });
      key = `tablo-${boardTab.tablo}`;
    }
    const rows = boardState.okuma[key] || [];
    const cells = drill === 'tablo' ? (r) => [`${boardSecs(r.ms)} sn`]
      : drill === 'takisto' ? (r) => [`Seviye ${r.score}`, `${r.n || 1} kelime`]
        : (r) => [`${r.score} puan`];
    boardFill(list, rows, cells, 'Henüz rekor yok. İlk sen ol!');
  };
  wrap.redraw = draw;
  draw();
}
function redrawOkumaRecords() {
  for (const el of document.querySelectorAll('.okuma-records')) el.redraw?.();
}
// Alıştırma bitince sonuç sunucuya gider (kişinin en iyisinden iyiyse tabloya girer).
function okumaSubmit(res) {
  socket.emit('okuma:result', res, () => {});
}

function setBoards(res = {}) {
  if (res.mantikBoard) boardState.mantik = res.mantikBoard;
  if (res.okumaBoard) boardState.okuma = res.okumaBoard;
  if (res.duelBoards?.dorttas) boardState.dorttas = res.duelBoards.dorttas;
  if (res.duelBoards?.duvar) boardState.duvar = res.duelBoards.duvar;
  renderMantikRecords();
  renderDuelRecords('dorttas');
  renderDuelRecords('duvar');
  redrawOkumaRecords();
}

socket.on('mantik:board', (b) => { boardState.mantik = b || boardState.mantik; renderMantikRecords(); });
socket.on('okuma:board', (b) => { boardState.okuma = b || boardState.okuma; redrawOkumaRecords(); });
socket.on('dorttas:board', (b) => { boardState.dorttas = b || boardState.dorttas; renderDuelRecords('dorttas'); });
socket.on('duvar:board', (b) => { boardState.duvar = b || boardState.duvar; renderDuelRecords('duvar'); });

Object.assign(window, { setBoards, renderMantikRecords, renderDuelRecords, okumaRecords, okumaSubmit });
