'use strict';

(() => {
  const standalone = document.body.classList.contains('yorunge-demo');
  const $ = id => document.getElementById(id);
  $('game-yorunge').innerHTML = `
    <div id="lobby-yorunge" class="lobby"></div>
    <div id="yorunge-match" hidden>
      <div class="yorunge-head"><div><small id="yorunge-crews"></small><h3 id="yorunge-status" aria-live="polite"></h3></div>
        <button class="sm ghost" id="yorunge-resign">Çekil</button></div>
      <div class="yorunge-space" tabindex="0" aria-label="Kaydırılabilir yıldız haritası"><div id="yorunge-board"></div></div>
      <p id="yorunge-hint" class="small" aria-live="polite"></p>
      <div id="yorunge-stock" aria-label="Hangar"></div>
    </div>
    <details class="yorunge-guide"><summary>Nasıl oynanır?</summary>
      <p>Rakibin komuta gemisinin altı yanını doldur. Kuşatmada iki filonun gemileri de sayılır. İki komutan aynı anda çevrilirse maç berabere biter.</p>
      <p>Her sırada hangardan bir gemi yerleştir veya haritadaki bir gemini hareket ettir. İlk gemiler birbirine temas eder. Sonraki yerleştirmeler yalnız kendi rengindeki gemilere komşu olabilir. Komuta gemini en geç dördüncü sıranda yerleştir. Ancak ondan sonra hareket edebilirsin.</p>
      <p>Filo tek parça kalmalı. Kayan gemiler kenar temasını korur ve iki gemi arasındaki dar geçitten geçemez. Kenetçi üstteyken alttaki gemi kilitlenir ve hücre üsttekinin rengini alır. Hamle kalmazsa sıra otomatik geçer.</p>
      <dl id="yorunge-manual"></dl>
    </details>
  `;
  let local = standalone;
  let mode = 'bot';
  let timer;
  const ships = {
    komuta: ['Komuta', 'Bir hücre kayar. Altı yanı dolarsa kuşatılır.', 'M12 2 21 19 12 15 3 19Z M12 7v8'],
    kesif: ['Keşif', 'Filonun çevresinde istediği kadar kayar.', 'm3 16 9-12 9 12-9-4Z M8 18l-2 3m10-3 2 3'],
    sicrama: ['Sıçrayıcı', 'Düz bir hatta bitişik gemilerin üzerinden ilk boş hücreye atlar.', 'm4 18 7-5-3-3 12-7-7 12-3-3Z M2 21l4-2'],
    mekik: ['Mekik', 'Aynı hücreye dönmeden tam üç adım kayar.', 'm12 3 4 8 5 5v4l-9-5-9 5v-4l5-5Z'],
    kenet: ['Kenetçi', 'Bir adım ilerler. Bir geminin üstüne çıkıp onu kilitleyebilir.', 'M4 5v10l5 5h6l5-5V5l-5 6H9Z M9 15h6'],
  };
  let game = null;
  let selected = null;
  const button = (text, action) => Object.assign(document.createElement('button'), { type: 'button', textContent: text, onclick: action });
  function icon(kind) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', ships[kind][2]);
    svg.append(path);
    return svg;
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
    game = window.YorungeKurallari.create(['Güneş Filosu', mode === 'bot' ? 'Ay Botu' : 'Ay Filosu']);
    selected = null;
    render();
  }
  function localMove(move) {
    window.YorungeKurallari.play(game, move);
    selected = null;
    render();
    if (!game.done && game.turn === 1 && mode === 'bot') {
      timer = setTimeout(() => localMove(window.YorungeKurallari.botMove(game)), 350);
    }
  }
  if (!standalone) LOBBY.yorunge = {
    title: 'Yörünge Kuşatması', tab: 'yorunge', running: () => game && !game.done, last: () => game, localLobby,
    hint: 'Rakip komuta gemisinin altı yanını kuşat. Bir arkadaşını lobiye çağır veya oda botunu ekle.',
  };
  for (const [name, rule] of Object.values(ships)) {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = name;
    dd.textContent = rule;
    $('yorunge-manual').append(dt, dd);
  }
  const source = move => move.kind || move.from;
  function choose(key) {
    selected = selected === key ? null : key;
    render();
  }
  function render() {
    if (!localLobby()) renderLobby('yorunge');
    $('yorunge-match').hidden = !game;
    if (!game) return;
    const side = local ? (mode === 'duel' ? game.turn : 0) : game.players.indexOf(myName);
    const mine = side === game.turn && !game.done;
    const moves = mine ? game.moves : [];
    const displaySide = side < 0 ? game.turn : side;
    $('yorunge-crews').textContent = `☀ ${game.players[0]}   ·   ☾ ${game.players[1]}`;
    $('yorunge-status').textContent = game.result || (mine ? (local ? `Sıra ${game.players[side]} tarafında` : 'Hamle sırası sende') : `Hamle bekleniyor · ${game.players[game.turn]}`);
    $('yorunge-resign').hidden = side < 0 || game.done;
    const forced = game.stock[game.turn].komuta && game.turns[game.turn] >= 3;
    let hint = '';
    if (mine) hint = selected ? 'İşaretli bir hedefe dokun.' : forced ? 'Bu tur komuta gemini yerleştir.' : 'Hangardan bir gemi veya haritadan hareket ettireceğin gemiyi seç.';
    if (selected) {
      const kind = game.board[selected]?.at(-1)?.kind || selected;
      hint = `${ships[kind][0]} · ${ships[kind][1]} İşaretli hedeflerden birini seç.`;
    }
    if (game.passed && !game.done) hint = `${game.passed} pas geçti. ${hint}`;
    $('yorunge-hint').textContent = hint;
    $('yorunge-hint').hidden = !hint;
    const stock = $('yorunge-stock');
    stock.replaceChildren();
    for (const [kind, [label, rule]] of Object.entries(ships)) {
      const b = button(`${label} ×${game.stock[displaySide][kind]}`, () => choose(kind));
      b.prepend(icon(kind));
      b.title = rule;
      b.disabled = !moves.some(m => m.kind === kind);
      b.setAttribute('aria-pressed', String(selected === kind));
      stock.append(b);
    }
    const board = $('yorunge-board');
    board.replaceChildren();
    const targets = new Map(moves.filter(m => source(m) === selected).map(m => [m.to, m]));
    const cells = new Set([...Object.keys(game.board), ...game.moves.map(m => m.to), '0,0']);
    const positions = [...cells].map(cell => {
      const [q, r] = cell.split(',').map(Number);
      return { cell, x: 60 * (q + r / 2), y: 52 * r };
    });
    const xs = positions.map(p => p.x), ys = positions.map(p => p.y);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    board.style.width = (Math.max(...xs) - minX + 80) + 'px';
    board.style.height = (Math.max(...ys) - minY + 90) + 'px';
    for (const { cell, x, y } of positions) {
      const stack = game.board[cell];
      const ship = stack?.at(-1);
      const move = targets.get(cell);
      if (!ship && !move && !(game.revision === 0 && cell === '0,0')) continue;
      const b = button('', () => {
        if (move && local) localMove(move);
        else if (move) socket.emit('yorunge:move', { ...move, id: game.id, revision: game.revision });
        else choose(cell);
      });
      b.className = 'yorunge-cell';
      b.style.left = (x - minX + 10) + 'px';
      b.style.top = (y - minY + 10) + 'px';
      b.disabled = !move && !moves.some(m => m.from === cell);
      b.classList.toggle('target', Boolean(move));
      b.classList.toggle('selected', selected === cell);
      b.classList.toggle('last', game.last?.to === cell);
      if (ship) {
        b.dataset.side = ship.side;
        b.append(icon(ship.kind));
        const tag = document.createElement('small');
        tag.textContent = (ship.side ? '☾' : '☀') + (stack.length > 1 ? ' ×' + stack.length : '');
        b.append(tag);
      } else b.textContent = move ? '+' : '◎';
      const contents = stack?.map(s => game.players[s.side] + ' · ' + ships[s.kind][0]).join(' / ');
      b.title = [cell, contents, move && 'Hamle hedefi'].filter(Boolean).join(' · ');
      b.setAttribute('aria-label', b.title);
      board.append(b);
    }
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
  if (standalone) {
    $('yorunge-resign').textContent = 'Maçı bitir';
    $('yorunge-resign').onclick = () => { if (window.confirm('Maç bitsin mi?')) resign(); };
  } else {
    confirmButton($('yorunge-resign'), 'Çekilmeyi onayla', resign);
    window.setYorunge = (state, supported = true) => {
      if (!supported && local) return; // Aynı odaya bağlantı yenilenirken yerel maçı koru.
      clearTimeout(timer);
      local = !supported;
      game = state || null;
      selected = null;
      render();
    };
    socket.on('yorunge', state => window.setYorunge(state));
  }
  render();
})();
