'use strict';

// ---------- İttirmeli XOX ----------
// app.js'ten sonra yüklenir; $, socket, myName, LOBBY, renderLobby, confirmButton, BOT_NAME oradan gelir.
// 5x5 tahta. Sıran gelince kenardaki boş ya da kendi işaretin olan bir kareye bas, sonra parlayan uçlardan birine
// bas: kare oraya senin işaretinle girer, aradaki işaretler bir kayar. Sunucu hamleyi kontrol eder (games/xox.js).

let xox = null;
let xoxPick = null; // seçtiğim kare (alınacak taş)
const XOX_N = 5;

const xoxActive = () => (xox && !xox.done ? xox : null);
const xoxMark = (name) => (xox?.players[0] === name ? 'X' : xox?.players[1] === name ? 'O' : null);
const xoxMyTurn = () => Boolean(xoxActive() && xox.players[xox.turn] === myName);
const xoxEdge = (i) => {
  const r = Math.floor(i / XOX_N);
  const c = i % XOX_N;
  return r === 0 || c === 0 || r === XOX_N - 1 || c === XOX_N - 1;
};
function xoxTargets(from) {
  const r = Math.floor(from / XOX_N);
  const c = from % XOX_N;
  const out = new Set([r * XOX_N, r * XOX_N + XOX_N - 1, c, (XOX_N - 1) * XOX_N + c]);
  out.delete(from);
  return [...out];
}
const xoxCanTake = (i) => xoxEdge(i) && (xox.board[i] === null || xox.board[i] === xoxMark(myName));

// Son hamlede kayan kareler (from ile to arası); kısa bir parıltıyla gösterilir.
function xoxShifted(last) {
  if (!last) return new Set();
  const { from, to } = last;
  const sameRow = Math.floor(from / XOX_N) === Math.floor(to / XOX_N);
  const step = (sameRow ? 1 : XOX_N) * (to > from ? 1 : -1);
  const out = new Set();
  for (let i = from; i !== to; i += step) out.add(i);
  out.add(to);
  return out;
}

let xoxSeenMove = null;
function renderXox() {
  renderLobby('xox');
  const game = xox;
  const play = $('xox-play');
  play.hidden = !game;
  $('xox-end').hidden = !xoxActive() || !game.players.includes(myName);
  $('xox-close').hidden = !game?.done;
  const status = $('xox-status');
  if (!game) {
    status.textContent = '';
    return;
  }
  if (!xoxMyTurn()) xoxPick = null;

  // Oyuncular: X ve O, sırası gelen vurgulu
  const players = $('xox-players');
  players.replaceChildren(...game.players.map((name, k) => {
    const el = document.createElement('div');
    const mark = k === 0 ? 'X' : 'O';
    el.className = `xox-player ${mark.toLowerCase()}` + (!game.done && game.turn === k ? ' turn' : '') + (game.winner === name ? ' won' : '');
    el.append(Object.assign(document.createElement('span'), { className: 'xox-player-mark', textContent: mark }), makeAvatar(name),
      Object.assign(document.createElement('span'), { className: 'xox-player-name', textContent: name === myName ? `${name} (sen)` : name }));
    if (game.winner === name) el.append(Object.assign(document.createElement('span'), { className: 'xox-player-tag', textContent: '🏆' }));
    return el;
  }));

  if (game.done) {
    status.textContent = game.winner ? `${game.winner === myName ? 'Kazandın!' : `${game.winner} kazandı`}${game.reason ? ` · ${game.reason}` : ''}` : `Berabere${game.reason ? ` · ${game.reason}` : ''}`;
  } else if (xoxMyTurn()) {
    status.textContent = xoxPick == null ? `Sıra sende (${xoxMark(myName)}): kenardan boş ya da kendi işaretin olan bir kare seç.` : 'Parlayan uçlardan birine bas; satır ya da sütun kayar.';
  } else {
    const who = game.players[game.turn];
    status.textContent = game.players.includes(myName) ? `${who} düşünüyor…` : `${who} oynuyor (${game.turn === 0 ? 'X' : 'O'}) · izliyorsun`;
  }

  const fresh = game.last && xoxSeenMove !== `${game.id}|${game.moves}`;
  xoxSeenMove = `${game.id}|${game.moves}`;
  const shifted = fresh ? xoxShifted(game.last) : new Set();
  const targets = xoxPick == null ? [] : xoxTargets(xoxPick);
  const line = new Set(game.line || []);
  const board = $('xox-board');
  board.classList.toggle('my-turn', xoxMyTurn());
  board.replaceChildren(...game.board.map((mark, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'xox-cell' + (mark ? ` ${mark.toLowerCase()}` : '') + (xoxEdge(i) ? ' edge' : '');
    b.textContent = mark || '';
    if (game.last?.to === i) b.classList.add('last');
    if (shifted.has(i)) b.classList.add('shifted');
    if (line.has(i)) b.classList.add('win');
    if (xoxMyTurn()) {
      if (i === xoxPick) b.classList.add('picked');
      else if (targets.includes(i)) {
        b.classList.add('target');
        b.dataset.ghost = xoxMark(myName);
      } else if (xoxPick == null && xoxCanTake(i)) b.classList.add('takeable');
    }
    b.setAttribute('aria-label', `${Math.floor(i / XOX_N) + 1}. satır ${i % XOX_N + 1}. sütun${mark ? `: ${mark}` : ''}`);
    b.onclick = () => xoxClick(i);
    return b;
  }));
}

function xoxClick(i) {
  if (!xoxMyTurn()) return;
  if (xoxPick != null && xoxTargets(xoxPick).includes(i)) {
    socket.emit('xox:move', { from: xoxPick, to: i });
    xoxPick = null;
    return renderXox();
  }
  if (i === xoxPick) xoxPick = null;
  else if (xoxCanTake(i)) xoxPick = i;
  renderXox();
}

confirmButton($('xox-end'), 'Emin misin? Tekrar bas', () => socket.emit('xox:end'));
$('xox-close').onclick = () => socket.emit('xox:close');
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && xoxPick != null && !$('game-xox').hidden) {
    xoxPick = null;
    renderXox();
  }
});

function setXox(game) {
  if (game?.id !== xox?.id) xoxPick = null;
  xox = game || null;
  renderXox();
}
socket.on('xox', setXox);

LOBBY.xox = {
  title: 'İttirmeli XOX', tab: 'xox', running: () => Boolean(xoxActive()), last: () => xox,
  hint: 'Kenardan bir kare al, satırın ya da sütunun ucundan geri it; beşini yan yana getiren kazanır. 2 kişi; tek başına başlatırsan bilgisayara karşı oynarsın.',
};
