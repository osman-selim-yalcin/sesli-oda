'use strict';

// ---------- Dört Taş ----------
// app.js'ten sonra yüklenir; $, socket, myName, LOBBY, renderLobby, lobbyButton, lobbyEmit, kelimeSmall, confirmButton,
// makeAvatar, BOT_NAME oradan gelir. 7×6 dik tahta: sıran gelince bir sütuna bas, taş en alttaki boş yuvaya düşer.
// Sunucu hamleyi denetler (games/dorttas.js).

let dorttas = null;
let dtSeen = null; // animasyonu oynatılmış son hamle
const DT_COLS = 7;
const DT_ROWS = 6;
const DT_LEVELS = [['kolay', 'Kolay'], ['orta', 'Orta'], ['zor', 'Zor']];

const dtActive = () => (dorttas && !dorttas.done ? dorttas : null);
const dtMark = (name) => (dorttas?.players[0] === name ? 'R' : dorttas?.players[1] === name ? 'Y' : null);
const dtMyTurn = () => Boolean(dtActive() && dorttas.players[dorttas.turn] === myName);
const dtShown = (name) => (name === BOT_NAME ? 'Bilgisayar' : name);
const dtFree = (col) => {
  if (!dorttas) return -1;
  for (let r = DT_ROWS - 1; r >= 0; r--) if (dorttas.board[r * DT_COLS + col] == null) return r;
  return -1;
};

function dtDisc(mark) {
  return Object.assign(document.createElement('span'), { className: `dt-disc ${mark === 'R' ? 'r' : 'y'}` });
}

function dtSound(kind) {
  if (typeof audioCtx === 'undefined' || !audioCtx || audioCtx.state !== 'running') return;
  const bus = (typeof sfxBus !== 'undefined' && sfxBus) || audioCtx.destination;
  try {
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g);
    g.connect(bus);
    if (kind === 'win') {
      o.type = 'triangle';
      [523, 659, 784, 1047].forEach((f, i) => o.frequency.setValueAtTime(f, t + i * 0.11));
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      o.start(t);
      o.stop(t + 0.62);
      return;
    }
    o.type = 'sine';
    o.frequency.setValueAtTime(kind === 'lose' ? 220 : 180, t);
    o.frequency.exponentialRampToValueAtTime(kind === 'lose' ? 110 : 90, t + 0.12);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(kind === 'lose' ? 0.2 : 0.3, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (kind === 'lose' ? 0.5 : 0.16));
    o.start(t);
    o.stop(t + 0.52);
  } catch {}
}

function renderDtPlayers(game) {
  $('dorttas-players').replaceChildren(...game.players.map((name, k) => {
    const mark = k === 0 ? 'R' : 'Y';
    const el = document.createElement('div');
    el.className = 'xox-player dt-player' + (!game.done && game.turn === k ? ' turn' : '') + (game.winner === name ? ' won' : '') + (name === myName ? ' me' : '');
    el.append(dtDisc(mark), makeAvatar(name), Object.assign(document.createElement('span'), { className: 'xox-player-name', textContent: dtShown(name) + (name === myName ? ' (sen)' : '') }));
    el.append(Object.assign(document.createElement('span'), {
      className: 'xox-player-tag',
      textContent: game.winner === name ? '🏆 Kazandı' : !game.done && game.turn === k ? (name === myName ? 'Sıra sende' : 'Sırada') : '',
    }));
    return el;
  }));
}

function renderDtResult(game) {
  const box = $('dorttas-result');
  box.hidden = !game.done;
  if (!game.done) return;
  const title = $('dorttas-result-title');
  const mark = game.winner ? dtMark(game.winner) : null;
  title.className = 'xox-result-title dt-result-title' + (mark ? ` ${mark === 'R' ? 'r' : 'y'}` : '');
  title.textContent = !game.winner ? 'Berabere' : game.winner === myName ? 'Kazandın!' : `${dtShown(game.winner)} kazandı`;
  $('dorttas-result-note').textContent = game.reason || `${game.moves} hamle`;
  $('dorttas-again').hidden = !game.players.includes(myName);
}

function renderDorttas() {
  renderLobby('dorttas');
  window.renderDuelRecords?.('dorttas'); // public/boards.js
  const game = dorttas;
  $('dorttas-play').hidden = !game;
  $('dorttas-end').hidden = !dtActive() || !game.players.includes(myName);
  $('dorttas-close').hidden = !game?.done;
  const status = $('dorttas-status');
  if (!game) {
    status.textContent = '';
    return;
  }
  renderDtPlayers(game);
  renderDtResult(game);
  if (game.done) status.textContent = '';
  else if (dtMyTurn()) status.textContent = 'Sıra sende: bir sütuna bas, taşın en alta düşer.';
  else {
    const who = game.players[game.turn];
    status.textContent = game.players.includes(myName) ? `${dtShown(who)} düşünüyor…` : `${dtShown(who)} oynuyor · izliyorsun`;
  }

  const key = `${game.id}|${game.moves}`;
  const fresh = game.last && dtSeen !== key;
  dtSeen = key;
  const win = new Set(game.line || []);
  const mine = dtMyTurn();
  const board = $('dorttas-board');
  board.classList.toggle('my-turn', mine);
  board.classList.toggle('done', game.done);
  board.style.setProperty('--ghost', mine ? `var(--dt-${dtMark(myName) === 'R' ? 'r' : 'y'})` : 'transparent');

  const cols = [];
  for (let c = 0; c < DT_COLS; c++) {
    const col = document.createElement('div');
    col.className = 'dt-col';
    col.dataset.c = c;
    const free = dtFree(c);
    if (mine && free >= 0) {
      col.classList.add('can');
      col.setAttribute('role', 'button');
      col.tabIndex = 0;
      col.setAttribute('aria-label', `${c + 1}. sütuna taş bırak`);
      col.onclick = () => dtDrop(c);
      col.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          dtDrop(c);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          const cs = [...board.querySelectorAll('.dt-col.can')];
          const at = cs.indexOf(col) + (e.key === 'ArrowLeft' ? -1 : 1);
          cs[(at + cs.length) % cs.length]?.focus();
        }
      };
    }
    for (let r = 0; r < DT_ROWS; r++) {
      const i = r * DT_COLS + c;
      const hole = document.createElement('div');
      hole.className = 'dt-hole' + (mine && r === free ? ' next' : '');
      const mark = game.board[i];
      if (mark) {
        const disc = dtDisc(mark);
        if (win.has(i)) disc.classList.add('win');
        if (game.last?.cell === i) {
          disc.classList.add('last');
          if (fresh) {
            disc.classList.add('drop');
            disc.style.setProperty('--fall', r + 1);
          }
        }
        hole.append(disc);
      }
      col.append(hole);
    }
    cols.push(col);
  }
  board.replaceChildren(...cols);
  if (fresh) {
    if (game.done && game.winner) setTimeout(() => dtSound(game.winner === myName || !game.players.includes(myName) ? 'win' : 'lose'), 420);
    else dtSound('drop');
  }
}

function dtDrop(c) {
  if (!dtMyTurn() || dtFree(c) < 0) return;
  socket.emit('dorttas:move', { col: c });
}

confirmButton($('dorttas-end'), 'Emin misin? Tekrar bas', () => socket.emit('dorttas:end'));
$('dorttas-close').onclick = () => socket.emit('dorttas:close');
$('dorttas-again').onclick = () => socket.emit('dorttas:again');
// Klavye: 1-7 tuşları sütun seçer
addEventListener('keydown', (e) => {
  if ($('game-dorttas').hidden || e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
  const n = Number(e.key);
  if (Number.isInteger(n) && n >= 1 && n <= DT_COLS && dtMyTurn()) dtDrop(n - 1);
});

function setDorttas(game) {
  if (!dorttas && game) dtSeen = `${game.id}|${game.moves}`; // katılınca eski hamle yeniden oynatılmasın
  dorttas = game || null;
  renderDorttas();
}
socket.on('dorttas', setDorttas);

LOBBY.dorttas = {
  title: 'Dört Taş', tab: 'dorttas', running: () => Boolean(dorttas), last: () => dorttas, // sonuç açıkken lobi araya girmesin (yükseklik sabit); Kapat'la lobiye dönülür
  hint: 'Sırayla bir sütuna taş bırakın; dördünü yan yana, alt alta ya da çapraz getiren kazanır. 2 kişi; tek başına başlatırsan bilgisayara karşı oynarsın.',
  opts: (lobby, host) => {
    const row = document.createElement('div');
    row.className = 'lobby-opts';
    row.append(kelimeSmall('Bilgisayar:'));
    for (const [level, label] of DT_LEVELS) {
      const b = lobbyButton(label, 'sm' + (lobby.opts.level === level ? ' active' : ''), () => lobbyEmit('lobby:opts', 'dorttas', { level }));
      b.disabled = !host;
      row.append(b);
    }
    return [row];
  },
};
