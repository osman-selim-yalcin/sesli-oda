'use strict';

// ---------- Duvar ----------
// app.js'ten sonra yüklenir; $, socket, myName, LOBBY, renderLobby, lobbyButton, lobbyEmit, kelimeSmall, confirmButton,
// makeAvatar, BOT_NAME oradan; kurallar DUVAR (duvar-core.js). Sunucu: games/duvar.js.
// Tahta 17 izli bir ızgara: tek izler kareler, çift izler oluklar; duvarlar doğrudan oluklara yerleşir. Herkes kendi
// piyonunu altta görür (2. oyuncuda tahta ters çevrilir). İki mod: Piyon (gidilebilecek kareler işaretli, basınca gider)
// ve Duvar (imleç en yakın oluk kesişimine önizleme koyar; tıklayınca konur, dokunmatikte ikinci dokunuşta).
// R tuşu ya da sağ tık duvarın yönünü çevirir.

let duvar = null;
let dvSeen = null; // animasyonu oynatılmış son hamle
let dvMode = 'move';
let dvOrient = 'h';
let dvHover = null; // { o, r, c } (model koordinatı)
let dvTouchPick = null; // dokunmatikte ilk dokunuşla seçilen duvar
let dvBusy = false;
const DV_LEVELS = [['kolay', 'Kolay'], ['orta', 'Orta'], ['zor', 'Zor']];
const D_ = DUVAR;

const dvActive = () => (duvar && !duvar.done ? duvar : null);
const dvMe = () => (duvar ? duvar.players.indexOf(myName) : -1);
const dvMyTurn = () => Boolean(dvActive() && duvar.players[duvar.turn] === myName);
const dvShown = (name) => (name === BOT_NAME ? 'Bilgisayar' : name);
// 2. oyuncu tahtayı ters görür (kendi piyonu altta)
const dvFlip = () => dvMe() === 1;
const dvCell = (r, c) => (dvFlip() ? [D_.N - 1 - r, D_.N - 1 - c] : [r, c]); // model → ekran (ve tersi)
const dvWallView = (r, c) => (dvFlip() ? [D_.N - 2 - r, D_.N - 2 - c] : [r, c]); // duvar noktası model ↔ ekran

function dvSound(kind) {
  if (typeof audioCtx === 'undefined' || !audioCtx || audioCtx.state !== 'running') return;
  const bus = (typeof sfxBus !== 'undefined' && sfxBus) || audioCtx.destination;
  try {
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g);
    g.connect(bus);
    const f = { step: 420, wall: 150, win: 660, lose: 200, bad: 120 }[kind] || 300;
    o.type = kind === 'wall' ? 'square' : 'triangle';
    o.frequency.setValueAtTime(f, t);
    if (kind === 'win') [784, 988, 1319].forEach((v, k) => o.frequency.setValueAtTime(v, t + 0.1 * (k + 1)));
    if (kind === 'lose') o.frequency.exponentialRampToValueAtTime(90, t + 0.4);
    const len = kind === 'win' ? 0.5 : kind === 'lose' ? 0.45 : kind === 'wall' ? 0.09 : 0.08;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(kind === 'wall' ? 0.12 : 0.18, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.start(t);
    o.stop(t + len + 0.02);
  } catch {}
}

function dvPawn(p) {
  return Object.assign(document.createElement('span'), { className: `dv-pawn p${p}` });
}

function renderDvPlayers(game) {
  $('duvar-players').replaceChildren(...game.players.map((name, k) => {
    const el = document.createElement('div');
    el.className = 'xox-player dv-player' + (!game.done && game.turn === k ? ' turn' : '') + (game.winner === name ? ' won' : '') + (name === myName ? ' me' : '');
    const left = document.createElement('span');
    left.className = 'dv-left';
    left.title = `${game.left[k]} duvarı kaldı`;
    for (let i = 0; i < D_.WALLS; i++) left.append(Object.assign(document.createElement('i'), { className: i < game.left[k] ? 'on' : '' }));
    el.append(dvPawn(k), makeAvatar(name), Object.assign(document.createElement('span'), { className: 'xox-player-name', textContent: dvShown(name) + (name === myName ? ' (sen)' : '') }), left);
    el.append(Object.assign(document.createElement('span'), {
      className: 'xox-player-tag',
      textContent: game.winner === name ? '🏆 Kazandı' : !game.done && game.turn === k ? (name === myName ? 'Sıra sende' : 'Sırada') : '',
    }));
    return el;
  }));
}

function renderDvResult(game) {
  const box = $('duvar-result');
  box.hidden = !game.done;
  if (!game.done) return;
  const title = $('duvar-result-title');
  const p = game.players.indexOf(game.winner);
  title.className = 'xox-result-title dv-result-title' + (p >= 0 ? ` p${p}` : '');
  title.textContent = game.winner === myName ? 'Kazandın!' : `${dvShown(game.winner)} kazandı`;
  $('duvar-result-note').textContent = game.reason || `${game.moves} hamle`;
  $('duvar-again').hidden = !game.players.includes(myName);
}

function renderDvTools(game) {
  const mine = dvMyTurn();
  const me = dvMe();
  const tools = $('duvar-tools');
  tools.hidden = !game || game.done || me < 0;
  if (tools.hidden) return;
  for (const b of tools.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === dvMode));
  const wallBtn = tools.querySelector('[data-mode="wall"]');
  wallBtn.disabled = game.left[me] <= 0;
  if (wallBtn.disabled && dvMode === 'wall') dvMode = 'move';
  const rot = $('duvar-rotate');
  rot.hidden = dvMode !== 'wall';
  rot.textContent = dvOrient === 'h' ? 'Yatay ⟷' : 'Dikey ↕';
  tools.classList.toggle('waiting', !mine);
}

function renderDuvar() {
  renderLobby('duvar');
  const game = duvar;
  $('duvar-play').hidden = !game;
  $('duvar-end').hidden = !dvActive() || !game.players.includes(myName);
  $('duvar-close').hidden = !game?.done;
  const status = $('duvar-status');
  if (!game) {
    status.textContent = '';
    return;
  }
  renderDvPlayers(game);
  renderDvResult(game);
  renderDvTools(game);
  if (game.done) status.textContent = '';
  else if (dvMyTurn()) status.textContent = dvMode === 'wall' ? 'Sıra sende: oluğa duvar koy (R ile çevir).' : 'Sıra sende: işaretli bir kareye yürü ya da duvar koy.';
  else {
    const who = game.players[game.turn];
    status.textContent = game.players.includes(myName) ? `${dvShown(who)} düşünüyor…` : `${dvShown(who)} oynuyor · izliyorsun`;
  }
  const key = `${game.id}|${game.moves}`;
  const fresh = game.last && dvSeen !== key;
  dvSeen = key;
  renderDvBoard(game, fresh);
  if (fresh) {
    if (game.done) setTimeout(() => dvSound(game.winner === myName || !game.players.includes(myName) ? 'win' : 'lose'), 300);
    else dvSound(game.last.type === 'wall' ? 'wall' : 'step');
  }
}

function renderDvBoard(game, fresh) {
  const board = $('duvar-board');
  const walls = D_.wallSet(game.walls);
  const mine = dvMyTurn();
  const me = dvMe();
  board.classList.toggle('my-turn', mine);
  board.classList.toggle('done', game.done);
  board.classList.toggle('wall-mode', mine && dvMode === 'wall');
  board.classList.toggle('flip', dvFlip());
  board.dataset.me = me;
  const targets = mine && dvMode === 'move' ? D_.moves(walls, game.pos, me) : [];
  const out = [];
  // Kareler; hedef sıraları o oyuncunun renginde
  for (let r = 0; r < D_.N; r++) {
    for (let c = 0; c < D_.N; c++) {
      const [vr, vc] = dvCell(r, c);
      const cell = document.createElement('div');
      cell.className = 'dv-cell' + (r === D_.GOAL[0] ? ' goal0' : r === D_.GOAL[1] ? ' goal1' : '');
      cell.style.gridArea = `${vr * 2 + 1} / ${vc * 2 + 1}`;
      cell.dataset.r = r;
      cell.dataset.c = c;
      if (targets.some(([tr, tc]) => tr === r && tc === c)) {
        cell.classList.add('can');
        cell.setAttribute('role', 'button');
        cell.tabIndex = 0;
        cell.setAttribute('aria-label', `${String.fromCharCode(97 + c)}${D_.N - r} karesine yürü`);
        cell.onclick = () => dvSend({ type: 'move', r, c });
        cell.onkeydown = (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            dvSend({ type: 'move', r, c });
          }
        };
      }
      game.pos.forEach(([pr, pc], p) => {
        if (pr !== r || pc !== c) return;
        const pawn = dvPawn(p);
        if (fresh && game.last?.type === 'move' && game.players[p] === game.last.by) pawn.classList.add('hop');
        cell.append(pawn);
      });
      out.push(cell);
    }
  }
  // Duvarlar
  for (const w of game.walls) {
    const el = dvWallEl(w.o, w.r, w.c, `dv-wall by${w.p}`);
    if (fresh && game.last?.type === 'wall' && game.last.o === w.o && game.last.r === w.r && game.last.c === w.c) el.classList.add('drop');
    out.push(el);
  }
  // Önizleme
  const pick = dvTouchPick || dvHover;
  if (mine && dvMode === 'wall' && pick) {
    const ok = D_.wallOk(walls, game.pos, pick.o, pick.r, pick.c);
    out.push(dvWallEl(pick.o, pick.r, pick.c, `dv-wall ghost ${ok ? 'ok' : 'bad'}${dvTouchPick ? ' picked' : ''}`));
  }
  board.replaceChildren(...out);
}

function dvWallEl(o, r, c, cls) {
  const [vr, vc] = dvWallView(r, c);
  const el = document.createElement('span');
  el.className = `${cls} ${o}`;
  el.style.gridArea = o === 'h' ? `${vr * 2 + 2} / ${vc * 2 + 1} / span 1 / span 3` : `${vr * 2 + 1} / ${vc * 2 + 2} / span 3 / span 1`;
  return el;
}

// İmlecin en yakın oluk kesişimi (model koordinatı)
function dvPointWall(e) {
  const board = $('duvar-board');
  const rect = board.getBoundingClientRect();
  const cs = getComputedStyle(board);
  const pl = parseFloat(cs.paddingLeft);
  const pt = parseFloat(cs.paddingTop);
  const w = rect.width - pl - parseFloat(cs.paddingRight);
  const h = rect.height - pt - parseFloat(cs.paddingBottom);
  const x = (e.clientX - rect.left - pl) / (w / D_.N);
  const y = (e.clientY - rect.top - pt) / (h / D_.N);
  const clamp = (v) => Math.max(0, Math.min(D_.N - 2, v));
  const vc = clamp(Math.round(x) - 1);
  const vr = clamp(Math.round(y) - 1);
  const [r, c] = dvWallView(vr, vc);
  return { o: dvOrient, r, c };
}

function dvSend(a) {
  if (!dvMyTurn() || dvBusy) return;
  dvBusy = true;
  socket.emit('duvar:act', a, (res) => {
    dvBusy = false;
    if (res?.error) {
      dvSound('bad');
      $('duvar-status').textContent = res.error;
    }
  });
  dvTouchPick = null;
  dvHover = null;
}

function dvSetMode(mode) {
  dvMode = mode;
  dvTouchPick = null;
  dvHover = null;
  renderDuvar();
}
function dvRotate() {
  dvOrient = dvOrient === 'h' ? 'v' : 'h';
  if (dvHover) dvHover = { ...dvHover, o: dvOrient };
  if (dvTouchPick) dvTouchPick = { ...dvTouchPick, o: dvOrient };
  renderDuvar();
}

{
  const board = $('duvar-board');
  const same = (a, b) => a && b && a.o === b.o && a.r === b.r && a.c === b.c;
  board.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || !dvMyTurn() || dvMode !== 'wall') return;
    const w = dvPointWall(e);
    if (same(w, dvHover)) return;
    dvHover = w;
    renderDvBoard(duvar, false);
  });
  board.addEventListener('pointerleave', () => {
    if (!dvHover) return;
    dvHover = null;
    if (duvar) renderDvBoard(duvar, false);
  });
  board.addEventListener('click', (e) => {
    if (!dvMyTurn() || dvMode !== 'wall') return;
    const w = dvPointWall(e);
    const touch = e.pointerType && e.pointerType !== 'mouse';
    if (touch && !same(w, dvTouchPick)) {
      dvTouchPick = w; // ilk dokunuş: önizle
      return renderDvBoard(duvar, false);
    }
    if (!D_.wallOk(D_.wallSet(duvar.walls), duvar.pos, w.o, w.r, w.c)) {
      dvSound('bad');
      $('duvar-status').textContent = D_.wallFits(D_.wallSet(duvar.walls), w.o, w.r, w.c) ? 'Bu duvar birinin bütün yolunu kapatır.' : 'Oraya duvar sığmıyor.';
      return;
    }
    dvSend({ type: 'wall', ...w });
  });
  board.addEventListener('contextmenu', (e) => {
    if (!dvMyTurn() || dvMode !== 'wall') return;
    e.preventDefault();
    dvRotate();
  });
}
for (const b of document.querySelectorAll('#duvar-tools [data-mode]')) b.onclick = () => dvSetMode(b.dataset.mode);
$('duvar-rotate').onclick = dvRotate;
confirmButton($('duvar-end'), 'Emin misin? Tekrar bas', () => socket.emit('duvar:end'));
$('duvar-close').onclick = () => socket.emit('duvar:close');
$('duvar-again').onclick = () => socket.emit('duvar:again');
// Klavye: R yön çevirir, W duvar / piyon modu
addEventListener('keydown', (e) => {
  if ($('game-duvar').hidden || e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
  if (!dvActive() || dvMe() < 0) return;
  const k = e.key.toLowerCase();
  if (k === 'r' && dvMode === 'wall') dvRotate();
  else if (k === 'w' && duvar.left[dvMe()] > 0) dvSetMode(dvMode === 'wall' ? 'move' : 'wall');
});

function setDuvar(game) {
  if (!duvar && game) dvSeen = `${game.id}|${game.moves}`; // katılınca eski hamle yeniden oynatılmasın
  if (game && duvar && game.id !== duvar.id) dvMode = 'move';
  duvar = game || null;
  dvTouchPick = null;
  renderDuvar();
}
socket.on('duvar', setDuvar);
window.setDuvar = setDuvar;
window.renderDuvar = renderDuvar;
LOBBY.duvar = {
  title: 'Duvar', tab: 'duvar', running: () => Boolean(duvar), last: () => duvar,
  hint: 'Piyonunu karşı kenara ilk ulaştıran kazanır. Sıran gelince ya bir kare yürürsün ya da rakibin yoluna duvar koyarsın (10 duvar). 2 kişi; tek başına başlatırsan bilgisayara karşı oynarsın.',
  opts: (lobby, host) => {
    const row = document.createElement('div');
    row.className = 'lobby-opts';
    row.append(kelimeSmall('Bilgisayar:'));
    for (const [level, label] of DV_LEVELS) {
      const b = lobbyButton(label, 'sm' + (lobby.opts.level === level ? ' active' : ''), () => lobbyEmit('lobby:opts', 'duvar', { level }));
      b.disabled = !host;
      row.append(b);
    }
    return [row];
  },
};
