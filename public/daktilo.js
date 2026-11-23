'use strict';

// ---------- Daktilo düellosu ----------
// app.js'ten sonra yüklenir; $, socket, myName, LOBBY, renderLobby, lobbyButton, lobbyEmit, kelimeSmall,
// confirmButton, makeAvatar, BOT_NAME oradan gelir. Herkes aynı kelimeleri yazar; boşluk kelimeyi gönderir.
// Kendi yazdıklarım ekranda hemen işaretlenir (sunucuyu beklemeden), puanı sunucu sayar (games/daktilo.js).

let daktilo = null;
let daktiloWords = { id: null, words: [] }; // kelime listesi yalnızca başta gelir
let daktiloBoard = {};
let daktiloBoardSecs = 60;
let dkLocal = { id: null, i: 0, marks: [] }; // kendi ilerlemem (gönderdiklerim)
let dkClock = 0; // sunucu saati - bu saat
let dkTick = null;
let dkBuilt = null; // kelime kutusu bu oyun için çizildi mi

const DK_DURATIONS = [60, 120, 180];
const dkNow = () => Date.now() + dkClock;
const dkActive = () => (daktilo && !daktilo.done ? daktilo : null);
const dkPlaying = () => Boolean(dkActive() && daktilo.players.includes(myName) && !daktilo.gone.includes(myName));
const dkOpen = () => dkPlaying() && dkNow() >= daktilo.startAt && dkNow() < daktilo.endAt;
const dkFmt = (ms) => {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};
const dkWpm = (s, secs) => Math.round((s.correct / Math.max(1, secs)) * 60);

const dkInput = $('daktilo-input');

// Kelime kutusu: her oyunda bir kez çizilir, sonra yalnızca sınıflar değişir.
function dkBuild() {
  const box = $('daktilo-text');
  if (dkBuilt === daktilo.id) return;
  dkBuilt = daktilo.id;
  box.replaceChildren(...daktiloWords.words.map((w) => Object.assign(document.createElement('span'), { className: 'dk-word', textContent: w })));
  box.scrollTop = 0;
}

function dkMarkWords() {
  const box = $('daktilo-text');
  const spans = box.children;
  if (!spans.length) return;
  for (let i = 0; i < spans.length; i++) {
    const m = dkLocal.marks[i];
    spans[i].className = 'dk-word' + (m === 1 ? ' ok' : m === 0 ? ' bad' : '') + (i === dkLocal.i ? ' current' : '');
  }
  const cur = spans[dkLocal.i];
  if (cur) {
    const typed = dkInput.value;
    cur.classList.toggle('typo', Boolean(typed) && !cur.textContent.startsWith(typed));
    // Şu anki kelimenin satırı kutunun ilk satırı olsun
    const lineTop = cur.offsetTop - spans[0].offsetTop;
    if (box.scrollTop !== lineTop) box.scrollTop = lineTop;
  }
}

function renderDaktiloScores() {
  const game = daktilo;
  const list = $('daktilo-scores');
  const elapsed = game.done ? game.secs * 1000 : Math.max(0, Math.min(dkNow(), game.endAt) - game.startAt);
  const live = (s) => (game.done ? dkWpm(s, game.secs) : elapsed > 3000 ? Math.round(s.correct / (elapsed / 60000)) : 0);
  const names = [...game.players].sort((a, b) => game.scores[b].correct - game.scores[a].correct || game.scores[a].wrong - game.scores[b].wrong);
  const most = Math.max(1, ...names.map((n) => game.scores[n].correct));
  list.replaceChildren(...names.map((name) => {
    const s = game.scores[name];
    const li = document.createElement('li');
    li.className = 'dk-row' + (name === myName ? ' me' : '') + (game.winners?.includes(name) ? ' won' : '') + (game.gone.includes(name) ? ' gone' : '');
    const bar = Object.assign(document.createElement('span'), { className: 'dk-bar' });
    bar.style.width = `${(s.correct / most) * 100}%`;
    li.append(makeAvatar(name), Object.assign(document.createElement('span'), { className: 'dk-name', textContent: name + (game.winners?.includes(name) ? ' 🏆' : '') }),
      Object.assign(document.createElement('span'), { className: 'dk-track' }),
      Object.assign(document.createElement('strong'), { className: 'dk-wpm', textContent: `${live(s)}` }),
      Object.assign(document.createElement('span'), { className: 'muted small dk-sub', textContent: `${s.correct} doğru${s.wrong ? ` · ${s.wrong} yanlış` : ''}` }));
    li.querySelector('.dk-track').append(bar);
    return li;
  }));
}

function renderDaktiloBoard() {
  const wrap = $('daktilo-records');
  wrap.hidden = Boolean(dkActive());
  if (wrap.hidden) return;
  const chips = $('daktilo-records-secs');
  chips.replaceChildren(...DK_DURATIONS.map((d) => {
    const b = lobbyButton(`${d / 60} dk`, 'sm' + (d === daktiloBoardSecs ? ' active' : ''), () => {
      daktiloBoardSecs = d;
      renderDaktiloBoard();
    });
    return b;
  }));
  const rows = daktiloBoard[daktiloBoardSecs] || [];
  const list = $('daktilo-records-list');
  list.replaceChildren(...rows.map((r, i) => {
    const li = document.createElement('li');
    if (r.name === myName) li.className = 'me';
    li.append(rankCell(i), makeAvatar(r.name),
      Object.assign(document.createElement('span'), { className: 'timing-name', textContent: r.name }),
      Object.assign(document.createElement('span'), { className: 'timing-val', textContent: `${r.wpm} kelime/dk` }),
      Object.assign(document.createElement('span'), { className: 'muted small', textContent: r.wrong ? `${r.wrong} yanlış` : 'hatasız' }));
    return li;
  }));
  if (!rows.length) list.append(Object.assign(document.createElement('li'), { className: 'muted small', textContent: `${daktiloBoardSecs / 60} dakikada henüz rekor yok. Süresi dolana kadar yazılan oyunlar girer.` }));
}

function renderDaktilo() {
  renderLobby('daktilo');
  renderDaktiloBoard();
  const game = daktilo;
  $('daktilo-play').hidden = !game;
  $('daktilo-end').hidden = !dkActive() || !game.players.includes(myName);
  $('daktilo-close').hidden = !game?.done;
  const timer = $('daktilo-timer');
  timer.hidden = !game;
  if (!game) {
    $('daktilo-status').textContent = '';
    return;
  }
  if (daktiloWords.id === game.id) dkBuild();
  const now = dkNow();
  const status = $('daktilo-status');
  if (game.done) {
    timer.textContent = '0:00';
    const mine = game.scores[myName];
    status.textContent = mine ? `Bitti: ${dkWpm(mine, game.secs)} kelime/dk, ${mine.correct} doğru, ${mine.wrong} yanlış${game.reason ? ` · ${game.reason}` : ''}` : `Bitti${game.reason ? ` · ${game.reason}` : ''}`;
  } else if (now < game.startAt) {
    timer.textContent = dkFmt(game.secs * 1000);
    status.textContent = `Hazırlan… ${Math.ceil((game.startAt - now) / 1000)}`;
  } else {
    timer.textContent = dkFmt(game.endAt - now);
    status.textContent = dkPlaying() ? 'Yaz! Her kelimeden sonra boşluk.' : 'İzliyorsun; bu düellonun lobisinde değildin.';
  }
  timer.classList.toggle('urgent', !game.done && now >= game.startAt && game.endAt - now < 10000);
  const wasDisabled = dkInput.disabled;
  dkInput.disabled = !dkOpen();
  dkInput.hidden = !dkPlaying() && !game.done;
  dkInput.placeholder = game.done ? 'Süre doldu' : now < game.startAt ? 'Başlamak üzere…' : 'Buraya yaz';
  if (wasDisabled && !dkInput.disabled && !$('game-daktilo').hidden) dkInput.focus();
  if (game.done) dkInput.value = '';
  dkMarkWords();
  renderDaktiloScores();
}

function dkSubmit(text) {
  if (!dkOpen() || !text) return;
  const i = dkLocal.i;
  dkLocal.marks[i] = text === daktiloWords.words[i] ? 1 : 0;
  dkLocal.i++;
  socket.emit('daktilo:word', { id: daktilo.id, i, text });
}

dkInput.addEventListener('input', () => {
  if (!dkOpen()) {
    dkInput.value = '';
    return;
  }
  // Boşluk kelimeyi gönderir; yapıştırılan çok kelimeli yazı da sırayla gönderilir
  const parts = dkInput.value.split(/\s/);
  while (parts.length > 1) dkSubmit(parts.shift());
  dkInput.value = parts[0];
  dkMarkWords();
});
dkInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const text = dkInput.value.trim();
    dkInput.value = '';
    dkSubmit(text);
    dkMarkWords();
  }
});
dkInput.addEventListener('paste', (e) => e.preventDefault()); // kopyala-yapıştır yok

function dkStartTick() {
  clearInterval(dkTick);
  dkTick = dkActive() ? setInterval(() => {
    if (!dkActive()) {
      clearInterval(dkTick);
      dkTick = null;
    }
    renderDaktilo();
  }, 250) : null;
}

confirmButton($('daktilo-end'), 'Emin misin? Tekrar bas', () => socket.emit('daktilo:end'));
$('daktilo-close').onclick = () => socket.emit('daktilo:close');

function setDaktilo(game) {
  if (game?.words) daktiloWords = { id: game.id, words: game.words };
  if (game && game.id !== dkLocal.id) {
    // Yeni oyun ya da yeniden bağlanma: ilerlemem sunucudakinden başlar
    const s = game.scores[myName];
    dkLocal = { id: game.id, i: s?.i || 0, marks: [...(s?.marks || [])] };
    dkInput.value = '';
  }
  if (game?.now) dkClock = game.now - Date.now();
  daktilo = game || null;
  renderDaktilo();
  dkStartTick();
}
function setDaktiloBoard(b) {
  daktiloBoard = b || {};
  renderDaktiloBoard();
}
socket.on('daktilo', setDaktilo);
socket.on('daktilo:board', setDaktiloBoard);

LOBBY.daktilo = {
  title: 'Daktilo düellosu', tab: 'daktilo', running: () => Boolean(dkActive()), last: () => daktilo,
  hint: 'Herkese aynı kelimeler gelir; süre bitene kadar en çok doğru kelimeyi yazan kazanır. 1-6 kişi; tek başına da çalışabilirsin.',
  opts: (lobby, host) => {
    const row = document.createElement('div');
    row.className = 'lobby-opts';
    row.append(kelimeSmall('Süre:'));
    for (const secs of DK_DURATIONS) {
      const b = lobbyButton(`${secs / 60} dk`, 'sm' + (lobby.opts.secs === secs ? ' active' : ''), () => lobbyEmit('lobby:opts', 'daktilo', { secs }));
      b.disabled = !host;
      row.append(b);
    }
    return [row];
  },
};
