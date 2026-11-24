'use strict';

// ---------- İttirmeli XOX ----------
// app.js'ten sonra yüklenir; $, socket, myName, LOBBY, renderLobby, confirmButton, makeAvatar, BOT_NAME oradan gelir.
// 5x5 tahta. Sıran gelince boş bir yuvaya bas (taşını koyarsın) ya da dış halkadaki dolu bir yuvaya bas, çıkan
// oklardan birine bas (taş o yöne bir kare itilir, boşalan yere senin taşın girer). Sunucu hamleyi denetler (games/xox.js).

let xox = null;
let xoxPick = null; // itmek için seçtiğim kenar yuvası
let xoxSeen = null; // animasyonu oynatılmış son hamle
const XOX_N = 5;
const XOX_DIRS = { down: [1, 0], up: [-1, 0], right: [0, 1], left: [0, -1] };
const XOX_ARROW = { down: '↓', up: '↑', right: '→', left: '←' };
const XOX_DIR_NAME = { down: 'aşağı', up: 'yukarı', right: 'sağa', left: 'sola' };

const xoxActive = () => (xox && !xox.done ? xox : null);
const xoxMark = (name) => (xox?.players[0] === name ? 'X' : xox?.players[1] === name ? 'O' : null);
const xoxMyTurn = () => Boolean(xoxActive() && xox.players[xox.turn] === myName);
const xoxRc = (i) => [Math.floor(i / XOX_N), i % XOX_N];
const xoxEdge = (i) => {
  const [r, c] = xoxRc(i);
  return r === 0 || c === 0 || r === XOX_N - 1 || c === XOX_N - 1;
};
const xoxShown = (name) => (name === BOT_NAME ? 'Bilgisayar' : name);
function xoxInward(i) {
  const [r, c] = xoxRc(i);
  const out = [];
  if (r === 0) out.push('down');
  if (r === XOX_N - 1) out.push('up');
  if (c === 0) out.push('right');
  if (c === XOX_N - 1) out.push('left');
  return out;
}
// Sunucudaki pushPath'in aynısı: itilen yuvadan ilk boş yuvaya kadar; boş yoksa null.
function xoxPath(board, cell, dir) {
  if (board[cell] == null || !xoxEdge(cell)) return null;
  const [dr, dc] = XOX_DIRS[dir];
  let [r, c] = xoxRc(cell);
  const path = [];
  while (r >= 0 && r < XOX_N && c >= 0 && c < XOX_N) {
    const i = r * XOX_N + c;
    path.push(i);
    if (board[i] == null) return path;
    r += dr;
    c += dc;
  }
  return null;
}
const xoxPushDirs = (i) => (xox && xox.board[i] != null && xoxEdge(i) ? xoxInward(i).filter((d) => xoxPath(xox.board, i, d)) : []);

function xoxBall(mark) {
  const ball = document.createElement('span');
  ball.className = `xox-ball ${mark.toLowerCase()}`;
  ball.append(Object.assign(document.createElement('span'), { className: 'xox-sym', textContent: mark }));
  return ball;
}

function renderXoxPlayers(game) {
  $('xox-players').replaceChildren(...game.players.map((name, k) => {
    const mark = k === 0 ? 'X' : 'O';
    const el = document.createElement('div');
    el.className = `xox-player ${mark.toLowerCase()}` + (!game.done && game.turn === k ? ' turn' : '') + (game.winner === name ? ' won' : '') + (name === myName ? ' me' : '');
    const label = xoxShown(name) + (name === myName ? ' (sen)' : '');
    el.append(xoxBall(mark), makeAvatar(name), Object.assign(document.createElement('span'), { className: 'xox-player-name', textContent: label }));
    el.append(Object.assign(document.createElement('span'), {
      className: 'xox-player-tag',
      textContent: game.winner === name ? '🏆 Kazandı' : !game.done && game.turn === k ? (name === myName ? 'Sıra sende' : 'Sırada') : '',
    }));
    return el;
  }));
}

function renderXoxResult(game) {
  const box = $('xox-result');
  box.hidden = !game.done;
  if (!game.done) return;
  const title = $('xox-result-title');
  const mark = game.winner ? xoxMark(game.winner) : null;
  title.className = 'xox-result-title' + (mark ? ` ${mark.toLowerCase()}` : '');
  title.textContent = !game.winner ? 'Berabere' : game.winner === myName ? 'Kazandın!' : `${xoxShown(game.winner)} kazandı (${mark})`;
  $('xox-result-note').textContent = game.reason || `${game.moves} hamle`;
  const mine = game.players.includes(myName);
  $('xox-again').hidden = !mine;
}

function renderXox() {
  renderLobby('xox');
  const game = xox;
  $('xox-play').hidden = !game;
  $('xox-end').hidden = !xoxActive() || !game.players.includes(myName);
  $('xox-close').hidden = !game?.done;
  const status = $('xox-status');
  if (!game) {
    status.textContent = '';
    return;
  }
  if (!xoxMyTurn() || (xoxPick != null && !xoxPushDirs(xoxPick).length)) xoxPick = null;
  renderXoxPlayers(game);
  renderXoxResult(game);

  if (game.done) status.textContent = '';
  else if (xoxMyTurn()) status.textContent = xoxPick == null
    ? `Sıra sende (${xoxMark(myName)}): boş yuvaya taş koy ya da kenardaki bir taşı seçip it.`
    : 'Bir oka bas: taş o yöne itilir, boşalan yere senin taşın girer. Vazgeçmek için taşa yeniden bas.';
  else {
    const who = game.players[game.turn];
    status.textContent = game.players.includes(myName) ? `${xoxShown(who)} düşünüyor…` : `${xoxShown(who)} oynuyor (${game.turn === 0 ? 'X' : 'O'}) · izliyorsun`;
  }

  const board = $('xox-board');
  const key = `${game.id}|${game.moves}`;
  const fresh = game.last && xoxSeen !== key;
  xoxSeen = key;
  const last = fresh ? game.last : null;
  const from = new Map((last?.moved || []).map(([a, b]) => [b, a])); // varılan yuva -> çıkılan yuva
  const win = new Set(game.line || []);
  const mine = xoxMyTurn();
  board.classList.toggle('my-turn', mine);
  board.classList.toggle('done', game.done);
  board.classList.toggle('picking', xoxPick != null);

  board.replaceChildren(...game.board.map((mark, i) => {
    const hole = document.createElement('div');
    hole.className = 'xox-hole' + (xoxEdge(i) ? ' edge' : '');
    hole.dataset.i = i;
    const [r, c] = xoxRc(i);
    let label = `${r + 1}. satır ${c + 1}. sütun`;
    if (mark) {
      const ball = xoxBall(mark);
      if (win.has(i)) ball.classList.add('win');
      if (game.last?.cell === i) ball.classList.add('last');
      // Kayma: kayan taş eski yerinden, itilen yere giren taş tahtanın dışından gelir; konan taş düşer.
      if (last && from.has(i)) {
        const [fr, fc] = xoxRc(from.get(i));
        ball.style.setProperty('--dx', fc - c);
        ball.style.setProperty('--dy', fr - r);
        ball.classList.add('slide');
      } else if (last?.type === 'push' && last.cell === i) {
        const [dr, dc] = XOX_DIRS[last.dir];
        ball.style.setProperty('--dx', -dc);
        ball.style.setProperty('--dy', -dr);
        ball.classList.add('slide', 'enter');
      } else if (last?.type === 'place' && last.cell === i) ball.classList.add('drop');
      hole.append(ball);
      label += `: ${mark}`;
    }
    if (mine) {
      const dirs = mark ? xoxPushDirs(i) : [];
      if (!mark) {
        hole.classList.add('can-place');
        hole.dataset.ghost = xoxMark(myName);
        hole.setAttribute('role', 'button');
        hole.tabIndex = 0;
        label += ', boş: taş koy';
      } else if (dirs.length) {
        hole.classList.add('can-push');
        if (i === xoxPick) hole.classList.add('picked');
        hole.setAttribute('role', 'button');
        hole.tabIndex = 0;
        label += ', itilebilir';
        for (const dir of dirs) {
          const a = document.createElement('button');
          a.type = 'button';
          a.className = `xox-arrow ${dir}`;
          a.textContent = XOX_ARROW[dir];
          a.title = `${XOX_DIR_NAME[dir]} it`;
          a.setAttribute('aria-label', `${r + 1}. satır ${c + 1}. sütundaki taşı ${XOX_DIR_NAME[dir]} it`);
          a.tabIndex = i === xoxPick ? 0 : -1;
          a.onclick = (e) => {
            e.stopPropagation();
            xoxPush(i, dir);
          };
          a.onmouseenter = a.onfocus = () => xoxPreview(i, dir);
          a.onmouseleave = a.onblur = () => xoxPreview(null);
          hole.append(a);
        }
      }
    }
    hole.setAttribute('aria-label', label);
    hole.onclick = () => xoxClick(i);
    hole.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        xoxClick(i);
      }
    };
    return hole;
  }));
  // Kayma mesafesi: bir yuvadan ötekine (yuva + aralık)
  const holes = board.children;
  if (holes.length > 1) board.style.setProperty('--pitch', `${holes[1].offsetLeft - holes[0].offsetLeft}px`);
}

// Okun üzerine gelince kayacak taşlar ve boşalacak/dolacak yuva gösterilir.
function xoxPreview(cell, dir) {
  const board = $('xox-board');
  for (const el of board.querySelectorAll('.will-move, .will-fill')) el.classList.remove('will-move', 'will-fill');
  if (cell == null) return;
  const path = xoxPath(xox.board, cell, dir) || [];
  path.forEach((i, k) => board.children[i]?.classList.add(k === path.length - 1 ? 'will-fill' : 'will-move'));
}

function xoxClick(i) {
  if (!xoxMyTurn()) return;
  if (xox.board[i] == null) {
    xoxPick = null;
    socket.emit('xox:move', { type: 'place', cell: i });
    return;
  }
  const dirs = xoxPushDirs(i);
  if (!dirs.length) return;
  xoxPick = xoxPick === i ? null : i;
  renderXox();
  if (xoxPick != null) $('xox-board').children[i]?.querySelector('.xox-arrow')?.focus({ preventScroll: true });
}

function xoxPush(cell, dir) {
  if (!xoxMyTurn() || !xoxPath(xox.board, cell, dir)) return;
  xoxPick = null;
  socket.emit('xox:move', { type: 'push', cell, dir });
}

confirmButton($('xox-end'), 'Emin misin? Tekrar bas', () => socket.emit('xox:end'));
$('xox-close').onclick = () => socket.emit('xox:close');
$('xox-again').onclick = () => socket.emit('xox:again');
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && xoxPick != null && !$('game-xox').hidden) {
    xoxPick = null;
    renderXox();
  }
});

function setXox(game) {
  if (game?.id !== xox?.id) {
    xoxPick = null;
    // Katılınca ya da yeni oyunda eski hamle yeniden oynatılmasın
    if (!xox && game) xoxSeen = `${game.id}|${game.moves}`;
  }
  xox = game || null;
  renderXox();
}
socket.on('xox', setXox);

LOBBY.xox = {
  title: 'İttirmeli XOX', tab: 'xox', running: () => Boolean(xoxActive()), last: () => xox,
  hint: 'Boş yuvaya taş koy ya da kenardaki bir taşı içeri it; üçünü yan yana getiren kazanır. 2 kişi; tek başına başlatırsan bilgisayara karşı oynarsın.',
};
