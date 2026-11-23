// ---------- Hedef sayı ----------
// app.js'ten sonra yüklenir; $, socket, myName, LOBBY, renderLobby, lobbyButton, lobbyEmit, kelimeSmall, makeAvatar,
// emitAck, fmtTime, serverNow, confirmButton gibi ortak yardımcıları kullanır.
// Herkese aynı 6 sayı ve hedef gelir. Bir sayıya, bir işleme, başka bir sayıya basınca iki kutu birleşir ve sonuç yeni
// kutu olur. Elde hedefe en yakın sayı cevaptır; "Gönder" sunucuya adımları yollar, sunucu yeniden oynatıp doğrular.

const HEDEF_OPS = { '+': '+', '-': '−', '*': '×', '/': '÷' };
const HEDEF_ROUNDS = [3, 5, 7]; // sunucudaki ROUNDS ile aynı
let hedef = null;
let hedefLocal = null; // bu turdaki kendi adımlarım: { key, vals, used, steps, sel, op }
let hedefTicker = null;
let hedefSending = false;
let hedefRecords = null; // kalıcı puan tablosu: { 3: [{ name, points, at }], 5: [...], 7: [...] }
let hedefRecordTab = null; // gösterilen tur sayısı; seçilmediyse son oyununki ya da 5

const hedefActive = () => (hedef && !hedef.done ? hedef : null);
const hedefPlaying = () => Boolean(hedefActive() && hedef.players.includes(myName) && !hedef.left.includes(myName));
const hedefCanPlay = () => hedefPlaying() && hedef.phase === 'play' && serverNow() < hedef.roundEnd;
const hedefWho = (name) => (name === myName ? 'Sen' : name);

LOBBY.hedef = {
  title: 'Hedef sayı', tab: 'hedef', running: () => Boolean(hedefActive()), last: () => hedef,
  hint: 'Herkese aynı 6 sayı ve bir hedef gelir; dört işlemle hedefe en yakın sayıyı bul. 1-6 kişi.',
  opts: (lobby, host) => {
    const row = document.createElement('div');
    row.className = 'lobby-opts';
    row.append(kelimeSmall('Tur:'));
    for (const n of HEDEF_ROUNDS) {
      const b = lobbyButton(`${n} tur`, 'sm' + (n === lobby.opts.rounds ? ' active' : ''), () => lobbyEmit('lobby:opts', 'hedef', { rounds: n }));
      b.disabled = !host;
      row.append(b);
    }
    return [row];
  },
};

function hedefReset() {
  hedefLocal = { key: hedef ? `${hedef.id}:${hedef.round}` : '', vals: hedef ? [...hedef.nums] : [], used: hedef ? hedef.nums.map(() => false) : [], steps: [], sel: null, op: null };
}

// Elde kalan kutulardan hedefe en yakını (eşitse önce gelen; sunucu da böyle seçer).
function hedefAnswer() {
  const { vals, used } = hedefLocal;
  let best = -1;
  for (let k = 0; k < vals.length; k++) {
    if (!used[k] && (best < 0 || Math.abs(vals[k] - hedef.target) < Math.abs(vals[best] - hedef.target))) best = k;
  }
  return best < 0 ? null : { id: best, value: vals[best], diff: Math.abs(vals[best] - hedef.target) };
}

let hedefMsgTimer = null;
function hedefMsg(text, warn) {
  const el = $('hedef-msg');
  el.textContent = text || '';
  el.classList.toggle('error', Boolean(warn));
  clearTimeout(hedefMsgTimer);
  if (text) hedefMsgTimer = setTimeout(() => { el.textContent = ''; }, 3000);
}

// İki kutuyu birleştirir. Çıkarma ve bölme ters sırada geçerliyse sıra kendiliğinden çevrilir (3 − 25 → 25 − 3).
function hedefApply(i, op, j) {
  const L = hedefLocal;
  let [x, y] = [i, j];
  const a = L.vals[i];
  const b = L.vals[j];
  if (op === '-') {
    if (a === b) return hedefMsg('Sonuç 0 olur; sayılar pozitif kalmalı.', true);
    if (b > a) [x, y] = [j, i];
  }
  if (op === '/') {
    if (a % b && b % a) return hedefMsg(`${Math.max(a, b)} ÷ ${Math.min(a, b)} tam bölünmüyor.`, true);
    if (a % b) [x, y] = [j, i];
  }
  const p = L.vals[x];
  const q = L.vals[y];
  const r = op === '+' ? p + q : op === '-' ? p - q : op === '*' ? p * q : p / q;
  L.steps.push([x, op, y]);
  L.used[x] = L.used[y] = true;
  L.vals.push(r);
  L.used.push(false);
  L.sel = L.vals.length - 1; // sonuç seçili kalır, hemen yeni işleme geçilebilir
  L.op = null;
  hedefMsg('');
}

function hedefTile(id) {
  if (!hedefCanPlay()) return;
  const L = hedefLocal;
  if (L.sel == null) L.sel = id;
  else if (L.sel === id) [L.sel, L.op] = L.op ? [id, null] : [null, null];
  else if (!L.op) L.sel = id;
  else hedefApply(L.sel, L.op, id);
  renderHedef();
}

function hedefOp(op) {
  if (!hedefCanPlay()) return;
  const L = hedefLocal;
  if (L.sel == null) return hedefMsg('Önce bir sayı seç.', true);
  L.op = L.op === op ? null : op;
  renderHedef();
}

function hedefUndo() {
  const L = hedefLocal;
  if (!hedefCanPlay() || !L.steps.length) return;
  const [i, , j] = L.steps.pop();
  L.vals.pop();
  L.used.pop();
  L.used[i] = L.used[j] = false;
  L.sel = null;
  L.op = null;
  renderHedef();
}

async function hedefSend() {
  const game = hedefActive();
  const ans = game && hedefCanPlay() ? hedefAnswer() : null;
  if (!ans || hedefSending) return;
  if (game.mine && game.mine.diff <= ans.diff) return hedefMsg('Bundan iyisini zaten gönderdin.', true);
  hedefSending = true;
  renderHedef();
  const res = await emitAck(5000, 'hedef:submit', { id: game.id, round: game.round, steps: hedefLocal.steps });
  hedefSending = false;
  if (!res) hedefMsg('Gönderilemedi, tekrar dene.', true);
  else if (res.error) hedefMsg(res.error, true);
  else hedefMsg(res.diff ? `Gönderildi: ${res.value} (${res.diff} fark)` : `Hedefe ulaştın! +${res.points} puan`);
  renderHedef();
}

$('hedef-undo').onclick = hedefUndo;
$('hedef-clear').onclick = () => {
  if (!hedefCanPlay()) return;
  hedefReset();
  renderHedef();
};
$('hedef-send').onclick = hedefSend;
for (const b of document.querySelectorAll('#hedef-ops [data-op]')) b.onclick = () => hedefOp(b.dataset.op);
confirmButton($('hedef-end'), 'Emin misin? Tekrar bas', () => socket.emit('hedef:end'));
$('hedef-close').onclick = () => socket.emit('hedef:close');
$('hedef-next').onclick = () => socket.emit('hedef:next');

// Klavye: + − × ÷ işlem seçer, Backspace geri alır, Enter gönderir, Esc seçimi bırakır.
document.addEventListener('keydown', (e) => {
  if ($('games').hidden || $('game-hedef').hidden || e.ctrlKey || e.metaKey || e.altKey || !hedefCanPlay()) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
  const op = { '+': '+', '-': '-', '*': '*', x: '*', X: '*', '/': '/', ':': '/' }[e.key];
  if (op) hedefOp(op);
  else if (e.key === 'Backspace') hedefUndo();
  else if (e.key === 'Enter' && !e.target.closest?.('button')) hedefSend();
  else if (e.key === 'Escape' && hedefLocal.sel != null) {
    hedefLocal.sel = null;
    hedefLocal.op = null;
    renderHedef();
  } else return;
  e.preventDefault();
});

function hedefStepEl(text) {
  return Object.assign(document.createElement('li'), { textContent: text });
}

// Sağ üstteki sayaç: turda kalan süre (son 10 sn kırmızı); arada gizli (yeni tur "Sonraki tur" ile başlar).
function hedefTick() {
  const game = hedefActive();
  const el = $('hedef-clock');
  if (!game) {
    el.hidden = true;
    clearInterval(hedefTicker);
    hedefTicker = null;
    return;
  }
  const play = game.phase === 'play';
  const left = Math.max(0, Math.ceil((game.roundEnd - serverNow()) / 1000));
  el.hidden = !play;
  setIcon(el, 'timer', fmtTime(left));
  el.classList.toggle('low', play && left <= 10);
  // Süre dolunca sunucunun turu bitirmesi beklenir; bu arada kutular kilitlenir.
  if (play && hedefCanPlay() === $('game-hedef').classList.contains('hedef-locked')) renderHedef();
}

function renderHedefBoard(game) {
  const play = game.phase === 'play';
  const ranked = [...game.players].sort((a, b) => (play ? 0 : game.totals[b] - game.totals[a]));
  $('hedef-board').replaceChildren(...ranked.map((p) => {
    const li = document.createElement('li');
    if (game.done && game.winners.includes(p)) li.className = 'winner';
    if (p === myName) li.classList.add('me');
    const gone = game.left.includes(p);
    const s = play ? game.status[p] : game.last?.results[p];
    let note;
    if (gone) note = 'ayrıldı';
    else if (play) note = !s ? 'düşünüyor…' : s.diff ? `en yakın ${s.diff} fark` : 'ulaştı ✓';
    else note = !s ? 'göndermedi · +0' : `${s.value}${s.diff ? ` (${s.diff} fark)` : ' ✓'} · +${s.points}`;
    const name = Object.assign(document.createElement('strong'), { className: 'hedef-name', textContent: hedefWho(p) });
    const status = Object.assign(document.createElement('span'), { className: 'muted small hedef-note' + (play && s && !s.diff ? ' ok' : ''), textContent: note });
    const total = Object.assign(document.createElement('b'), { className: 'hedef-total', textContent: `${game.totals[p]} puan` });
    li.append(makeAvatar(p), name, status, total);
    return li;
  }));
}

function renderHedefResult(game) {
  const last = game.last;
  $('hedef-result').hidden = !last || game.phase === 'play';
  if (!last || game.phase === 'play') return;
  $('hedef-result-title').textContent = game.done
    ? (game.reason ? `${game.reason} ` : '') + (game.winners.length > 1 ? 'Berabere!' : game.winners.length ? `🏆 ${hedefWho(game.winners[0])} kazandı` : 'Oyun bitti')
    : `${last.round + 1}. tur bitti`;
  $('hedef-result-target').textContent = last.target;
  $('hedef-result-nums').replaceChildren(...last.nums.map((v) => Object.assign(document.createElement('span'), { className: 'hedef-tile' + (v >= 25 ? ' big' : ''), textContent: v })));
  // Arada: herkes "Sonraki tur"a basınca yeni tur başlar; kimlerin beklendiği yazılır.
  const waiting = !game.done && game.phase === 'break';
  $('hedef-next-row').hidden = !waiting;
  if (waiting) {
    const people = game.players.filter((p) => p !== BOT_NAME && !game.left.includes(p));
    const ready = game.ready || [];
    const me = hedefPlaying() && ready.includes(myName);
    const wait = people.filter((p) => !ready.includes(p)).map(hedefWho);
    $('hedef-next').hidden = !hedefPlaying();
    $('hedef-next').disabled = me;
    $('hedef-next').textContent = me ? 'Hazırsın' : game.round + 2 === game.rounds ? 'Son tura geç' : 'Sonraki tur';
    $('hedef-ready').textContent = people.length > 1 ? `Hazır ${ready.length}/${people.length}` + (wait.length ? ` · bekleniyor: ${wait.join(', ')}` : '') : '';
  }
  const list = $('hedef-result-list');
  list.replaceChildren(...game.players.filter((p) => last.results[p]).map((p) => {
    const r = last.results[p];
    const li = document.createElement('li');
    li.className = r.diff ? '' : 'ok';
    const head = document.createElement('div');
    head.className = 'hedef-result-head';
    head.append(Object.assign(document.createElement('strong'), { textContent: hedefWho(p) }),
      Object.assign(document.createElement('span'), { textContent: `${r.value}${r.diff ? ` · ${r.diff} fark` : ' ✓'}` }),
      Object.assign(document.createElement('b'), { textContent: `+${r.points}` }));
    li.append(head, Object.assign(document.createElement('span'), { className: 'muted small', textContent: r.steps.length ? r.steps.join(' · ') : 'işlem yok (tek sayı)' }));
    return li;
  }));
  if (!list.children.length) list.append(Object.assign(document.createElement('li'), { className: 'muted small', textContent: 'Kimse cevap göndermedi.' }));
  $('hedef-solution').replaceChildren(...last.solution.map(hedefStepEl));
}

// Puan tablosu oyun sürmezken görünür; sekmeler 3 / 5 / 7 tur.
function renderHedefRecords() {
  const box = $('hedef-records');
  box.hidden = Boolean(hedefActive()) || !hedefRecords;
  if (box.hidden) return;
  const tab = hedefRecordTab || hedef?.rounds || 5;
  $('hedef-records-tabs').replaceChildren(...HEDEF_ROUNDS.map((n) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'sm' + (n === tab ? ' active' : ''), textContent: `${n} tur` });
    b.onclick = () => { hedefRecordTab = n; renderHedefRecords(); };
    return b;
  }));
  const rows = hedefRecords[tab] || [];
  const list = $('hedef-records-list');
  list.replaceChildren(...rows.map((r, i) => {
    const date = new Date(r.at).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
    const row = timingRow(r.name, `${r.points} puan`, date, i === 0 ? 'great' : '');
    row.prepend(rankCell(i, i + 1, rows[0].points > 0 && rows[0].points !== rows[1]?.points));
    if (hedef?.done && r.at === hedef.id) row.classList.add('winner'); // az önce biten oyun
    return row;
  }));
  if (!rows.length) list.append(Object.assign(document.createElement('li'), { className: 'muted small', textContent: `${tab} turluk oyunda henüz puan yok. Sonuna kadar oynanan oyunlar buraya girer.` }));
}
function setHedefRecords(board) {
  hedefRecords = board || null;
  renderHedefRecords();
}
socket.on('hedef:board', setHedefRecords);

function renderHedef() {
  const game = hedef;
  renderLobby('hedef');
  renderHedefRecords();
  const playing = hedefPlaying();
  const active = hedefActive();
  $('hedef-end').hidden = !(active && playing);
  $('hedef-close').hidden = !game?.done;
  $('hedef-board').hidden = !game;
  if (!game) {
    $('hedef-status').textContent = '';
    $('hedef-play').hidden = true;
    $('hedef-result').hidden = true;
    hedefTick();
    return;
  }
  if (hedefLocal?.key !== `${game.id}:${game.round}`) hedefReset();
  if (active && !hedefTicker) hedefTicker = setInterval(hedefTick, 250);
  hedefTick();

  $('hedef-status').textContent = game.done ? (game.reason ? `${game.round + 1}/${game.rounds} turda bitti` : `${game.rounds} tur bitti`)
    : game.phase === 'play' ? `${game.round + 1}/${game.rounds}. tur` + (playing ? '' : ' · izliyorsun')
      : `${game.round + 1}/${game.rounds}. tur bitti`;
  renderHedefBoard(game);
  renderHedefResult(game);

  const play = game.phase === 'play';
  $('hedef-play').hidden = !play;
  if (!play) return;
  const can = hedefCanPlay();
  $('game-hedef').classList.toggle('hedef-locked', !can);
  $('hedef-target').textContent = game.target;
  const L = hedefLocal;
  const tiles = $('hedef-tiles');
  const ids = playing ? L.vals.map((_, k) => k).filter((k) => !L.used[k]) : game.nums.map((_, k) => k);
  const ans = playing ? hedefAnswer() : null;
  tiles.replaceChildren(...ids.map((k) => {
    const b = document.createElement('button');
    b.type = 'button';
    const v = playing ? L.vals[k] : game.nums[k];
    b.className = 'hedef-tile' + (k >= game.nums.length ? ' made' : v >= 25 ? ' big' : '') + (L.sel === k ? ' sel' : '')
      + (ans?.id === k ? ' best' : '') + (playing && v === game.target ? ' hit' : '');
    b.textContent = v;
    b.disabled = !can;
    b.onclick = () => hedefTile(k);
    return b;
  }));
  for (const b of document.querySelectorAll('#hedef-ops [data-op]')) {
    b.classList.toggle('active', L.op === b.dataset.op);
    b.disabled = !can;
  }
  $('hedef-ops').hidden = !playing;
  $('hedef-tools').hidden = !playing;
  $('hedef-steps').hidden = !playing || !L.steps.length;
  $('hedef-steps').replaceChildren(...L.steps.map(([i, op, j], k) => hedefStepEl(`${L.vals[i]} ${HEDEF_OPS[op]} ${L.vals[j]} = ${L.vals[game.nums.length + k]}`)));
  $('hedef-undo').disabled = !can || !L.steps.length;
  $('hedef-clear').disabled = !can || !L.steps.length;
  if (!playing) return;
  const mine = game.mine;
  $('hedef-answer').textContent = ans ? `Cevabın: ${ans.value}` + (ans.diff ? ` · ${ans.diff} fark` : ' · tam hedef!') : '';
  $('hedef-answer').classList.toggle('ok', ans?.diff === 0);
  $('hedef-mine').textContent = mine ? `Gönderdiğin: ${mine.value}` + (mine.diff ? ` (${mine.diff} fark)` : ` ✓ · +${mine.points} puan`) : 'Henüz göndermedin';
  const better = ans && (!mine || ans.diff < mine.diff);
  $('hedef-send').disabled = !can || !better || hedefSending;
  $('hedef-send').textContent = mine && better ? 'Daha iyisini gönder' : 'Gönder';
  $('hedef-send').classList.toggle('pulse', Boolean(better && ans.diff === 0));
}

function setHedef(game) {
  const fresh = game && hedef?.id !== game.id;
  hedef = game;
  if (fresh) hedefLocal = null;
  renderHedef();
}
socket.on('hedef', setHedef);
