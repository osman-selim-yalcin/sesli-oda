'use strict';

// Yörünge Kuşatması istemcisi. Masa CSS 3D ile çizilir: eğik bir düzlem (yor-plane) üstünde kalınlığı olan
// altıgen taşlar; yığınlar gerçek yükseklikle üst üste durur. Kurallar public/yorunge-kurallar.js içinde,
// buradaki hareket şemaları da aynı motordan üretilir.
(() => {
  const standalone = document.body.classList.contains('yorunge-demo');
  const $ = id => document.getElementById(id);
  const rules = window.YorungeKurallari;
  $('game-yorunge').innerHTML = `
    <div id="lobby-yorunge" class="lobby"></div>
    <div id="yorunge-match" class="yor" hidden>
      <header class="yor-bar">
        <div class="yor-crew" data-side="0"></div>
        <h3 id="yorunge-status" aria-live="polite"></h3>
        <div class="yor-crew" data-side="1"></div>
        <div class="yor-tools">
          <button type="button" class="sayi-info-btn" popovertarget="yorunge-rules-pop" title="Nasıl oynanır" aria-label="Nasıl oynanır">i</button>
          <button type="button" class="sm ghost" id="yorunge-resign">Çekil</button>
        </div>
      </header>
      <div class="yor-table">
        <aside class="yor-hangar" id="yorunge-stock" aria-label="Hangarın"></aside>
        <div class="yor-stage" id="yorunge-stage">
          <div class="yor-stars" aria-hidden="true"></div>
          <div class="yor-plane" id="yorunge-board"></div>
          <div class="yor-result" id="yorunge-result" hidden></div>
        </div>
        <aside class="yor-hangar rival" id="yorunge-rival" aria-label="Rakip hangar"></aside>
      </div>
      <section class="yor-brief" id="yorunge-brief">
        <div class="yor-diagram" id="yorunge-diagram" aria-hidden="true"></div>
        <div class="yor-brief-text">
          <strong id="yorunge-brief-title"></strong>
          <p id="yorunge-brief-rule"></p>
          <p id="yorunge-hint" class="yor-hint" aria-live="polite"></p>
        </div>
      </section>
    </div>
    <div id="yorunge-rules-pop" class="pop sayi-pop yor-pop" popover>
      <p><strong>Amaç:</strong> rakibin komuta gemisinin altı yanını doldur. Kuşatmada iki filonun gemileri de sayılır. İki komutan aynı anda çevrilirse maç berabere biter.</p>
      <p><strong>Sıra:</strong> hangardan bir gemi yerleştir veya masadaki bir gemini hareket ettir. İlk gemiler birbirine temas eder. Sonraki yerleştirmeler yalnız kendi rengindeki gemilere komşu olabilir. Komuta gemini en geç dördüncü sıranda yerleştir; ancak ondan sonra hareket edebilirsin.</p>
      <p><strong>Filo:</strong> tek parça kalmalı. Kayan gemiler kenar temasını korur ve iki gemi arasındaki dar geçitten geçemez. Kenetçi üstteyken alttaki gemi kilitlenir ve hücre üsttekinin rengini alır. Hamle kalmazsa sıra kendiliğinden geçer.</p>
      <dl id="yorunge-manual"></dl>
    </div>
  `;
  let local = standalone;
  let mode = 'bot';
  let timer;
  const ships = {
    komuta: ['Komuta', 'Bir hücre kayar. Altı yanı dolarsa kuşatılır.', 'M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.3l6.1-.7Z'],
    kesif: ['Keşif', 'Filonun çevresinde istediği kadar kayar.', 'm3 16 9-12 9 12-9-4Z M8 18l-2 3m10-3 2 3'],
    sicrama: ['Sıçrayıcı', 'Düz bir hatta bitişik gemilerin üzerinden ilk boş hücreye atlar.', 'm4 18 7-5-3-3 12-7-7 12-3-3Z M2 21l4-2'],
    mekik: ['Mekik', 'Aynı hücreye dönmeden tam üç adım kayar.', 'M4 7l5 5-5 5 M10.5 7l5 5-5 5 M17 7l5 5-5 5'],
    yanki: ['Yankı', 'Komşu üst gemilerden birinin hareketini veya çekici ışınını kopyalar. Üst kattayken Kenetçi gibi hareket eder.', 'M3 15q4-12 8 0t8 0 M5 9q4-8 8 0t8 0'],
    dalis: ['Dalış', 'İki dolu hücrenin üzerinden geçip üçüncü adımda boş hücreye iner.', 'M3 6h8l6 9 4-3-2 8-8-2 3-2-5-7H3Z'],
    cekici: ['Çekici', 'Bir hücre kayar veya komşu bir gemiyi yanındaki boş hücreye taşır. Son hamlede yer değiştiren gemi bir tur kilitlidir. Yığınlar taşınamaz.', 'M3 4v9l5 6h8l5-6V4h-4v8l-3 3h-4l-3-3V4Z'],
    kenet: ['Kenetçi', 'Bir adım ilerler. Bir geminin üstüne çıkıp onu kilitleyebilir.', 'M4 5v10l5 5h6l5-5V5l-5 6H9Z M9 15h6'],
  };
  const EMBLEM = ['☀', '☾'];
  const DIRECTIONS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  // Altıgen ölçüleri (css/games.css .yor-plane değişkenleriyle aynı olmalı)
  const R = 34, W = 59, H = 18, DX = 62, DY = 54;
  const TILT = 42;
  const MOVE_MS = 560;
  const NS = 'http://www.w3.org/2000/svg';
  const calm = matchMedia('(prefers-reduced-motion: reduce)');

  let game = null;
  let selected = null; // seçili kaynak: hangardaki tür adı ya da masadaki hücre
  let cargo = ''; // çekici ışınla taşınacak geminin hücresi
  let info = null; // alttaki bilgi kartında gösterilen tür (seçim yokken son bakılan)
  let shown = { id: null, revision: -1 }; // ekrana çizilmiş son durum (animasyon kararı için)

  const el = (tag, className, text) => Object.assign(document.createElement(tag), { className: className || '', ...(text != null ? { textContent: text } : {}) });
  const button = (text, action) => Object.assign(document.createElement('button'), { type: 'button', textContent: text, onclick: action });
  const coords = cell => cell.split(',').map(Number);
  const around = cell => { const [q, r] = coords(cell); return DIRECTIONS.map(([dq, dr]) => `${q + dq},${r + dr}`); };
  const place = cell => { const [q, r] = coords(cell); return { x: DX * (q + r / 2), y: DY * r }; };
  const at = (cell, level = 0, lift = 0) => { const p = place(cell); return `translate3d(${p.x}px, ${p.y}px, ${level * H + lift}px)`; };
  function glyph(kind) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('yor-glyph');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', ships[kind][2]);
    svg.append(path);
    return svg;
  }
  // Tıklanabilir masa öğesi: genel düğme stillerinden bağımsız kalsın diye div + role
  function pressable(node, label, action) {
    node.setAttribute('role', 'button');
    node.tabIndex = 0;
    node.setAttribute('aria-label', label);
    node.title = label;
    node.onclick = action;
    node.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); action(); } };
    return node;
  }

  function localLobby() {
    if (!local) return false;
    const lobby = $('lobby-yorunge');
    lobby.hidden = Boolean(game && !game.done);
    if (!lobby.hidden) {
      lobby.replaceChildren(button('Bota karşı oyna', () => start('bot')),
        button('Aynı cihazda iki kişi', () => start('duel')));
    }
    return true;
  }
  function start(nextMode) {
    clearTimeout(timer);
    mode = nextMode;
    game = rules.create(['Güneş Filosu', mode === 'bot' ? 'Ay Botu' : 'Ay Filosu']);
    selected = null; cargo = ''; info = null;
    render();
  }
  function localMove(move) {
    rules.play(game, move);
    selected = null; cargo = '';
    render();
    if (!game.done && game.turn === 1 && mode === 'bot') {
      timer = setTimeout(() => localMove(rules.botMove(game)), MOVE_MS + 340);
    }
  }
  if (!standalone) LOBBY.yorunge = {
    title: 'Yörünge Kuşatması', tab: 'yorunge', running: () => game && !game.done, last: () => game, localLobby,
    hint: 'Rakip komuta gemisinin altı yanını kuşat. Bir arkadaşını lobiye çağır veya oda botunu ekle.',
  };
  for (const [name, rule] of Object.values(ships)) {
    $('yorunge-manual').append(el('dt', '', name), el('dd', '', rule));
  }
  // Kural penceresi "i" düğmesinin altına hizalanır (app.js yalnız sayfa açılırken var olan pencereleri hizalar).
  $('yorunge-rules-pop').addEventListener('toggle', e => {
    if (e.newState !== 'open') return;
    const pop = e.target, btn = document.querySelector('[popovertarget="yorunge-rules-pop"]').getBoundingClientRect();
    const below = btn.bottom + 6 + pop.offsetHeight <= innerHeight - 16;
    pop.style.top = `${below ? btn.bottom + 6 : Math.max(16, Math.min(btn.top - 6 - pop.offsetHeight, innerHeight - pop.offsetHeight - 16))}px`;
    pop.style.left = `${Math.max(16, Math.min(btn.right - pop.offsetWidth, innerWidth - pop.offsetWidth - 16))}px`;
  });

  const source = move => move.via || move.kind || move.from;
  function choose(key) {
    cargo = '';
    selected = selected === key ? null : key;
    render();
  }
  function send(move) {
    if (local) localMove(move);
    else socket.emit('yorunge:move', { ...move, id: game.id, revision: game.revision });
  }

  // ---------- Hareket şeması ----------
  // Her tür için küçük bir örnek dizilim; hedefler gerçek kural motorundan hesaplanır.
  const ship = (kind, side = 1) => [{ kind, side }];
  const SAMPLES = {
    komuta: { '0,0': ship('komuta', 0), '1,0': ship('kesif') },
    kesif: { '-1,0': ship('kesif', 0), '0,0': ship('mekik'), '1,0': ship('kenet'), '0,1': ship('mekik') },
    sicrama: { '0,0': ship('sicrama', 0), '1,0': ship('kesif'), '2,0': ship('kesif') },
    mekik: { '0,0': ship('mekik', 0), '1,0': ship('kesif'), '1,1': ship('kesif') },
    yanki: { '0,0': ship('yanki', 0), '1,0': ship('sicrama'), '2,0': ship('kesif') },
    dalis: { '0,0': ship('dalis', 0), '1,0': ship('kesif'), '2,0': ship('kesif'), '1,1': ship('kesif') },
    cekici: { '0,0': ship('cekici', 0), '1,0': ship('kesif'), '-1,1': ship('mekik') },
    kenet: { '0,0': ship('kenet', 0), '1,0': ship('kesif'), '1,-1': ship('kesif') },
  };
  const SAMPLE_FROM = { kesif: '-1,0' };
  const diagrams = {};
  function diagram(kind) {
    if (diagrams[kind]) return diagrams[kind];
    const board = SAMPLES[kind], from = SAMPLE_FROM[kind] || '0,0';
    const ends = new Set(rules.destinations(board, from));
    const tow = kind === 'cekici' ? around(from).filter(c => !board[c]) : [];
    const cells = new Set([...Object.keys(board), ...ends, ...tow]);
    const pts = [...cells].map(cell => ({ cell, x: 20 * (coords(cell)[0] + coords(cell)[1] / 2), y: 17.4 * coords(cell)[1] }));
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `${Math.min(...xs) - 12} ${Math.min(...ys) - 13} ${Math.max(...xs) - Math.min(...xs) + 24} ${Math.max(...ys) - Math.min(...ys) + 26}`);
    for (const { cell, x, y } of pts) {
      const hex = document.createElementNS(NS, 'polygon');
      hex.setAttribute('points', [0, 1, 2, 3, 4, 5].map(i => {
        const a = Math.PI / 180 * (60 * i - 90);
        return (x + 10.4 * Math.cos(a)).toFixed(1) + ',' + (y + 10.4 * Math.sin(a)).toFixed(1);
      }).join(' '));
      hex.setAttribute('class', cell === from ? 'me' : board[cell] ? (ends.has(cell) ? 'other end' : cell === '1,0' && kind === 'cekici' ? 'other load' : 'other') : ends.has(cell) ? 'end' : 'tow');
      svg.append(hex);
    }
    return diagrams[kind] = svg;
  }

  // ---------- Masa ----------
  function fit() {
    if (!game) return;
    const stage = $('yorunge-stage'), plane = $('yorunge-board');
    const cells = new Set(['0,0']);
    for (const cell of Object.keys(game.board)) { cells.add(cell); for (const n of around(cell)) cells.add(n); }
    const pts = [...cells].map(place);
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const flat = Math.cos(TILT * Math.PI / 180);
    const scale = Math.min(stage.clientWidth / (maxX - minX + W + 70), stage.clientHeight / ((maxY - minY + 2 * R + 150) * flat), 1.6);
    plane.style.setProperty('--s', Math.max(0.3, scale).toFixed(3));
    plane.style.setProperty('--cx', ((minX + maxX) / 2).toFixed(1) + 'px');
    plane.style.setProperty('--cy', ((minY + maxY) / 2).toFixed(1) + 'px');
  }
  new ResizeObserver(fit).observe($('yorunge-stage'));

  function token(kind, side) {
    const t = el('span', 'yor-token');
    t.dataset.side = side;
    t.append(glyph(kind));
    return t;
  }
  function renderHangar(node, side, moves, own) {
    node.replaceChildren();
    node.dataset.side = side;
    const head = el('div', 'yor-hangar-head');
    head.append(el('span', 'yor-emblem', EMBLEM[side]), el('strong', '', own ? 'Hangarın' : game.players[side]));
    node.append(head);
    const list = el('div', 'yor-hangar-list');
    for (const [kind, [label, rule]] of Object.entries(ships)) {
      const count = game.stock[side][kind];
      const canPlace = own && moves.some(m => m.kind === kind);
      const row = el(own ? 'button' : 'div', 'yor-berth' + (count ? '' : ' empty') + (canPlace ? ' ready' : ''));
      const pile = el('span', 'yor-pile');
      pile.dataset.n = Math.min(3, Math.max(1, count));
      pile.append(token(kind, side));
      row.append(pile, el('span', 'yor-berth-name', label), el('b', 'yor-berth-count', '×' + count));
      row.title = `${label} · ${rule}`;
      if (own) {
        row.type = 'button';
        row.setAttribute('aria-pressed', String(selected === kind));
        row.onclick = () => { info = kind; if (canPlace) choose(kind); else { selected = null; cargo = ''; render(); } };
      }
      list.append(row);
    }
    node.append(list);
  }

  function render() {
    if (!localLobby()) renderLobby('yorunge');
    $('yorunge-match').hidden = !game;
    if (!game) { shown = { id: null, revision: -1 }; return; }
    const side = local ? (mode === 'duel' ? game.turn : 0) : game.players.indexOf(myName);
    const mine = side === game.turn && !game.done;
    const moves = mine ? game.moves : [];
    const displaySide = side < 0 ? 0 : side;
    if (selected && !moves.some(m => source(m) === selected)) { selected = null; cargo = ''; }

    // Kuşatma sayacı: her komuta gemisinin dolu komşu sayısı
    const siege = [null, null], command = [null, null];
    for (const [cell, stack] of Object.entries(game.board)) {
      for (const s of stack) if (s.kind === 'komuta') { command[s.side] = cell; siege[s.side] = around(cell).filter(n => game.board[n]).length; }
    }
    for (const crew of document.querySelectorAll('.yor-crew')) {
      const s = Number(crew.dataset.side);
      crew.classList.toggle('active', !game.done && game.turn === s);
      crew.classList.toggle('danger', siege[s] >= 4);
      const text = el('div', 'yor-crew-text');
      const meter = el('span', 'yor-meter');
      meter.title = siege[s] == null ? 'Komuta gemisi henüz hangarda' : `Komuta gemisinin ${siege[s]}/6 yanı dolu`;
      for (let i = 0; i < 6; i++) meter.append(el('i', i < (siege[s] || 0) ? 'on' : ''));
      text.append(el('strong', '', game.players[s]), el('small', '', siege[s] == null ? 'Komuta hangarda' : `Kuşatma ${siege[s]}/6`), meter);
      crew.replaceChildren(el('span', 'yor-emblem', EMBLEM[s]), text);
    }
    $('yorunge-status').textContent = game.done ? 'Maç bitti' : mine ? (local ? `Sıra ${game.players[side]} tarafında` : 'Hamle sırası sende') : `Hamle bekleniyor · ${game.players[game.turn]}`;
    $('yorunge-match').classList.toggle('mine', mine);
    $('yorunge-resign').hidden = side < 0 || game.done;
    const result = $('yorunge-result');
    result.hidden = !game.done;
    result.textContent = game.result || '';

    renderHangar($('yorunge-stock'), displaySide, moves, side >= 0);
    renderHangar($('yorunge-rival'), 1 - displaySide, [], false);

    // Seçime göre hedefler; çekici ışında önce taşınacak gemi seçilir
    const options = moves.filter(m => source(m) === selected);
    const loads = new Set(options.filter(m => m.via).map(m => m.from));
    if (!loads.has(cargo)) cargo = '';
    const targets = new Map(options.filter(m => cargo ? m.via && m.from === cargo : !m.via).map(m => [m.to, m]));

    const plane = $('yorunge-board');
    const origin = el('div', 'yor-origin');
    const ghosts = new Set(['0,0']);
    for (const cell of Object.keys(game.board)) for (const n of around(cell)) if (!game.board[n]) ghosts.add(n);
    for (const cell of ghosts) {
      if (game.board[cell]) continue;
      const g = el('div', 'yor-ghost');
      g.style.transform = at(cell);
      origin.append(g);
    }
    for (const [cell, stack] of Object.entries(game.board)) {
      const shadow = el('div', 'yor-shadow');
      shadow.style.transform = at(cell);
      shadow.dataset.cell = cell;
      shadow.style.setProperty('--h', stack.length);
      origin.append(shadow);
      stack.forEach((s, level) => {
        const topmost = level === stack.length - 1;
        const piece = el('div', 'yor-piece');
        piece.dataset.side = s.side;
        piece.dataset.cell = cell;
        piece.style.transform = at(cell, level + 1);
        for (const face of ['r', 'br', 'bl', 'l']) piece.append(el('i', 'yor-side ' + face));
        const top = el('div', 'yor-top');
        top.append(glyph(s.kind));
        if (topmost && stack.length > 1) top.append(el('b', 'yor-height', stack.length + ' kat'));
        piece.append(top);
        if (topmost) {
          const movable = moves.some(m => source(m) === cell);
          const loadable = loads.has(cell);
          piece.classList.toggle('movable', movable && !selected);
          piece.classList.toggle('selected', selected === cell);
          piece.classList.toggle('cargo', loadable);
          piece.classList.toggle('picked', cargo === cell);
          piece.classList.toggle('last', game.last?.to === cell);
          piece.classList.toggle('locked', mine && game.locked === cell && s.side === side);
          const contents = stack.map(x => `${game.players[x.side]} · ${ships[x.kind][0]}`).join(' / ');
          pressable(piece, [contents, loadable && 'Çekici ışınla taşı', movable && 'Hareket ettir'].filter(Boolean).join(' · '), () => {
            info = s.kind;
            if (loadable) { cargo = cargo === cell ? '' : cell; render(); }
            else if (movable) choose(cell);
            else { selected = null; cargo = ''; render(); }
          });
        }
        origin.append(piece);
      });
      const hasCommand = stack.find(s => s.kind === 'komuta');
      if (hasCommand) {
        const ring = el('div', 'yor-gauge' + (siege[hasCommand.side] >= 4 ? ' danger' : '') + (siege[hasCommand.side] === 6 ? ' lost' : ''));
        ring.style.transform = at(cell, stack.length, 1);
        around(cell).forEach((n, i) => {
          const pip = el('i', game.board[n] ? 'on' : '');
          pip.style.setProperty('--a', -60 * i + 'deg');
          ring.append(pip);
        });
        origin.append(ring);
      }
    }
    for (const [cell, move] of targets) {
      const level = game.board[cell]?.length || 0;
      const slot = el('div', 'yor-slot' + (level ? ' climb' : ''));
      slot.style.transform = at(cell, level, 2);
      slot.append(el('i'));
      pressable(slot, level ? 'Üstüne çık' : 'Hamle hedefi', () => send(move));
      origin.append(slot);
    }
    if (!Object.keys(game.board).length && !targets.size) {
      const first = el('div', 'yor-slot idle');
      first.style.transform = at('0,0', 0, 2);
      first.append(el('i'));
      origin.append(first);
    }
    plane.replaceChildren(origin);
    fit();

    // Bilgi kartı
    const kind = selected ? (game.board[selected]?.at(-1)?.kind || selected) : info;
    const forced = game.stock[game.turn].komuta && game.turns[game.turn] >= 3;
    let hint = '';
    if (game.done) hint = game.result;
    else if (!mine) hint = side < 0 ? 'Maçı izliyorsun.' : 'Rakibin hamlesini bekliyorsun. Bu sırada gemilere dokunup nasıl hareket ettiklerine bakabilirsin.';
    else if (loads.size && !cargo && targets.size) hint = 'Yeşil hücreye dokun: gemi oraya gider. Mavi halkalı komşuya dokunursan onu çekici ışınla taşırsın.';
    else if (loads.size && !cargo) hint = 'Mavi halkalı komşu gemilerden birine dokun, sonra onu bırakacağın hücreyi seç.';
    else if (cargo) hint = 'Taşınan geminin bırakılacağı yeşil hücreye dokun.';
    else if (selected) hint = 'Yeşil hücrelerden birine dokun. Vazgeçmek için seçili gemiye yeniden dokun.';
    else if (forced) hint = 'Bu tur komuta gemini yerleştirmek zorundasın: hangardan Komuta\'yı seç.';
    else hint = 'Hangardan bir gemi seç ya da masadaki parlayan gemilerinden birine dokun.';
    if (game.passed && !game.done) hint = `${game.passed} hamle bulamadı, pas geçti. ${hint}`;
    $('yorunge-hint').textContent = hint;
    $('yorunge-brief-title').textContent = kind ? ships[kind][0] : 'Amaç';
    $('yorunge-brief-rule').textContent = kind ? ships[kind][1] : 'Rakip komuta gemisinin altı yanını doldur. Komuta gemilerinin çevresindeki altı ışık kuşatmanın ne kadar ilerlediğini gösterir.';
    $('yorunge-diagram').replaceChildren(...(kind ? [diagram(kind)] : []));
    $('yorunge-diagram').hidden = !kind;

    animate();
  }

  // Yeni hamle geldiyse son oynanan taşı eski yerinden (ya da hangardan, yukarıdan) yeni yerine uçurur.
  function animate() {
    const fresh = shown.id === game.id && game.revision === shown.revision + 1 && game.last;
    shown = { id: game.id, revision: game.revision };
    if (!fresh || calm.matches) return false;
    const { from, to } = game.last;
    const level = game.board[to]?.length || 1;
    const piece = [...document.querySelectorAll('#yorunge-board .yor-piece')].filter(p => p.dataset.cell === to).at(-1);
    if (!piece?.animate) return false;
    const end = at(to, level);
    if (from) {
      const a = place(from), b = place(to);
      const fromLevel = (game.board[from]?.length || 0) + 1;
      const mid = `translate3d(${(a.x + b.x) / 2}px, ${(a.y + b.y) / 2}px, ${Math.max(level, fromLevel) * H + 46}px)`;
      piece.animate([{ transform: at(from, fromLevel) }, { transform: mid, offset: 0.5 }, { transform: end }], { duration: MOVE_MS, easing: 'cubic-bezier(.45,.05,.35,1)' });
    } else {
      piece.animate([{ transform: at(to, level, 240) + ' rotateZ(-50deg)' }, { transform: at(to, level, -3), offset: 0.72 }, { transform: at(to, level, 5), offset: 0.86 }, { transform: end }], { duration: MOVE_MS, easing: 'cubic-bezier(.3,.6,.4,1)' });
    }
    const shadow = [...document.querySelectorAll('#yorunge-board .yor-shadow')].find(s => s.dataset.cell === to);
    shadow?.animate([{ opacity: 0 }, { opacity: 0, offset: 0.55 }, { opacity: 1 }], { duration: MOVE_MS });
    return true;
  }

  function resign() {
    if (!local) return socket.emit('yorunge:resign', game?.id);
    if (!game || game.done) return;
    clearTimeout(timer);
    game.done = true;
    game.moves = [];
    game.result = 'Maç sona erdi.';
    selected = null;
    render();
  }

  // Sunucudan art arda gelen durumlar (benim hamlem, hemen ardından botun hamlesi) sırayla oynatılır.
  const queue = [];
  let busy = false;
  function pump() {
    if (busy || !queue.length) return;
    const next = queue.shift();
    const moved = next && game && next.id === game.id && next.revision === game.revision + 1 && !calm.matches;
    game = next || null;
    selected = null; cargo = '';
    if (!game) info = null;
    render();
    if (!moved) return pump();
    busy = true;
    setTimeout(() => { busy = false; pump(); }, MOVE_MS + 120);
  }

  if (standalone) {
    $('yorunge-resign').textContent = 'Maçı bitir';
    $('yorunge-resign').onclick = () => { if (window.confirm('Maç bitsin mi?')) resign(); };
  } else {
    confirmButton($('yorunge-resign'), 'Çekilmeyi onayla', resign);
    window.setYorunge = (state, supported = true) => {
      if (!supported && local) return; // Aynı odaya bağlantı yenilenirken yerel maçı koru.
      clearTimeout(timer);
      local = !supported;
      queue.push(state || null);
      pump();
    };
    socket.on('yorunge', state => window.setYorunge(state));
  }
  render();
})();
