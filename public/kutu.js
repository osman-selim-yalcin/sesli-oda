'use strict';

// Kutu oyunlarının (Takımada, Yedi Kapı) ortak kabuğu: lobi, yerel maç (bota karşı / aynı cihazda), sunucu durumu
// kuyruğu, üstteki oyuncu şeridi, kural penceresi ve 3D zar. Her oyun kendi sahnesini KutuOyun.register ile
// verdiği draw() içinde çizer (public/takimada.js, public/yedikapi.js).
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const colors = ['#f78c64', '#6ac5ff', '#de96f3', '#a8d87a'];
  const calm = matchMedia('(prefers-reduced-motion: reduce)');
  const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls || '', ...(text != null ? { textContent: text } : {}) });
  const svgEl = (tag, attrs = {}) => {
    const e = document.createElementNS(NS, tag);
    for (const [a, v] of Object.entries(attrs)) e.setAttribute(a, v);
    return e;
  };
  function art(name, cls = '') {
    const svg = svgEl('svg', { viewBox: '0 0 32 32', class: ('kutu-icon ' + cls).trim(), 'aria-hidden': 'true' });
    svg.append(svgEl('use', { href: '/icons/kutu.svg?v=3d#' + name }));
    return svg;
  }
  function button(label, action, { icon: name, cls = '' } = {}) {
    const b = el('button', cls, label);
    b.type = 'button';
    b.onclick = action;
    if (name) b.prepend(art(name));
    return b;
  }
  // Tıklanabilir sahne öğesi (genel düğme stillerinden bağımsız)
  function pressable(node, label, action) {
    node.setAttribute('role', 'button');
    node.tabIndex = 0;
    node.setAttribute('aria-label', label);
    node.title = label;
    node.onclick = action;
    node.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); action(); } };
    return node;
  }
  // 3D zar: altı yüzlü küp; roll verilirse dönerek o yüzde durur.
  const PIPS = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
  function die(value, roll) {
    const wrap = el('div', 'kutu-die-wrap');
    const cube = el('div', 'kutu-die' + (roll && !calm.matches ? ' rolling' : ''));
    cube.dataset.face = value || 1;
    for (let n = 1; n <= 6; n++) {
      const face = el('i', 'f' + n);
      for (const p of PIPS[n]) face.append(el('b', 'p' + p));
      cube.append(face);
    }
    wrap.append(cube);
    wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', value ? 'Zar ' + value : 'Zar');
    return wrap;
  }
  // Kutu (dikdörtgen prizma): üst + ön + iki yan yüz. Eğik masada arka yüz görünmez.
  function box(w, d, h, cls) {
    const b = el('div', 'kutu-box ' + (cls || ''));
    b.style.cssText = `--w:${w}px;--d:${d}px;--h:${h}px`;
    for (const f of ['top', 'front', 'left', 'right']) b.append(el('i', f));
    return b;
  }

  function register(key, def) {
    const { title, engine } = def;
    const panel = document.getElementById('game-' + key);
    let game = null, local = false, robot = false, timer;
    let shown = { id: null, revision: -1 }, snapshot = null, prev = null;
    const state = {}; // oyunun kendi arayüz durumu (seçim, filtre, çanta)
    panel.classList.add('kutu-game', 'kutu-' + key);
    const lobby = el('div', 'lobby'), match = el('div', 'kutu-match');
    lobby.id = 'lobby-' + key;
    const pop = el('div', 'pop sayi-pop yor-pop');
    pop.id = key + '-rules-pop';
    pop.popover = 'auto';
    pop.innerHTML = def.rules;
    pop.addEventListener('toggle', e => {
      if (e.newState !== 'open') return;
      const btn = panel.querySelector(`[popovertarget="${pop.id}"]`).getBoundingClientRect();
      const below = btn.bottom + 6 + pop.offsetHeight <= innerHeight - 16;
      pop.style.top = `${below ? btn.bottom + 6 : Math.max(16, Math.min(btn.top - 6 - pop.offsetHeight, innerHeight - pop.offsetHeight - 16))}px`;
      pop.style.left = `${Math.max(16, Math.min(btn.right - pop.offsetWidth, innerWidth - pop.offsetWidth - 16))}px`;
    });
    panel.append(lobby, match, pop);

    function localLobby() {
      if (!local) return false;
      lobby.hidden = Boolean(game && !game.done);
      if (!lobby.hidden) {
        lobby.className = 'lobby kutu-start';
        const options = el('div', 'kutu-start-options'), select = el('select');
        select.setAttribute('aria-label', 'Aynı cihazdaki oyuncu sayısı');
        for (const n of [2, 3, 4]) select.add(new Option(n + ' oyuncu', String(n)));
        const group = el('div', 'kutu-choice');
        group.append(select, button('Aynı cihazda oyna', () => start(false, Number(select.value))));
        options.append(button('Bota karşı oyna', () => start(true, 2), { icon: def.icon, cls: 'primary' }), group);
        const banner = el('div', 'kutu-banner kutu-banner-' + key);
        banner.append(el('h2', '', title), el('p', '', def.tagline));
        lobby.replaceChildren(banner, options);
      }
      return true;
    }
    LOBBY[key] = { title, tab: key, running: () => Boolean(game && !game.done), last: () => game, localLobby, hint: def.hint };

    function start(bot, n) {
      clearTimeout(timer);
      robot = bot;
      for (const k of Object.keys(state)) delete state[k];
      game = engine.create(Array.from({ length: n }, (_, i) => bot && i === 1 ? 'Bot 🤖' : 'Oyuncu ' + (i + 1)));
      game.id = 'yerel-' + Date.now();
      game.revision = 0;
      render();
    }
    function apply(action) {
      engine.play(game, action);
      game.revision++;
      render();
      if (robot && !game.done && game.turn === 1) timer = setTimeout(() => apply(engine.bot(game, engine.available(game))), def.pace + 250);
    }
    function submit(action) {
      if (!game) return;
      if (local) {
        if (action === 'leave') { clearTimeout(timer); game.done = true; game.log = 'Maç sona erdi.'; game.revision++; return render(); }
        const player = robot ? 0 : game.turn;
        if (engine.manage?.(game, player, action)) { game.revision++; return render(); }
        if (!(robot && game.turn === 1) && engine.available(game).includes(action)) apply(action);
      } else socket.emit('kutu:action', { key, id: game.id, revision: game.revision, action });
    }

    function render() {
      if (!localLobby()) renderLobby(key);
      match.hidden = !game;
      if (!game) { shown = { id: null, revision: -1 }; snapshot = prev = null; match.replaceChildren(); return; }
      const g = game, me = local ? (robot ? 0 : g.turn) : g.players.indexOf(myName);
      const mine = !g.done && me === g.turn, acts = mine ? engine.available(g) : [];
      const fresh = shown.id === g.id && shown.revision !== g.revision && !calm.matches;
      if (shown.id !== g.id) { prev = null; for (const k of Object.keys(state)) delete state[k]; }
      else if (shown.revision !== g.revision) prev = snapshot;
      if (shown.id !== g.id || shown.revision !== g.revision) snapshot = structuredClone(g);
      shown = { id: g.id, revision: g.revision };

      const bar = el('header', 'kutu-bar');
      const seats = el('div', 'kutu-seats');
      g.players.forEach((name, i) => {
        const info = def.seat(g, i);
        const seat = el('div', 'kutu-seat' + (!g.done && i === g.turn ? ' active' : '') + (i === me ? ' me' : ''));
        seat.style.setProperty('--c', colors[i]);
        const text = el('div', 'kutu-seat-text');
        const pips = el('span', 'kutu-pips');
        for (let n = 0; n < info.max; n++) pips.append(el('i', n < info.value ? 'on' : ''));
        text.append(el('strong', '', name), el('small', '', info.text), pips);
        seat.append(el('span', 'kutu-pawn'), text);
        seats.append(seat);
      });
      const tools = el('div', 'kutu-tools');
      const rulesBtn = button('i', null, { cls: 'sayi-info-btn' });
      rulesBtn.setAttribute('popovertarget', pop.id);
      rulesBtn.title = 'Nasıl oynanır';
      rulesBtn.setAttribute('aria-label', 'Nasıl oynanır');
      tools.append(rulesBtn);
      if (!g.done && me >= 0) tools.append(button('Maçı bitir', () => { if (window.confirm('Maç bitsin mi?')) submit('leave'); }, { cls: 'sm ghost' }));
      bar.append(seats, tools);
      const body = el('div', 'kutu-body');
      match.replaceChildren(bar, body);
      def.draw({ g, me, mine, acts, submit, body, fresh, prev: fresh ? prev : null, local, robot, state, rerender: render });
    }

    // Sunucudan art arda gelen durumlar (hamle + hemen ardından bot) animasyon süresi kadar arayla oynatılır.
    const queue = [];
    let busy = false;
    function pump() {
      if (busy || !queue.length) return;
      const next = queue.shift();
      const moved = next && game && next.id === game.id && next.revision !== game.revision && !calm.matches;
      game = next;
      render();
      if (!moved) return pump();
      busy = true;
      setTimeout(() => { busy = false; pump(); }, def.pace);
    }
    function sync(next, supported) {
      if (local && !supported) return;
      clearTimeout(timer);
      local = !supported;
      queue.push(next || null);
      pump();
    }
    socket.on('kutu:state', data => { if (!local && data.key === key) sync(data.game, true); });
    LOBBY[key].sync = sync;
    render();
  }

  window.KutuOyun = { register, el, svgEl, art, button, pressable, die, box, colors, calm };
})();
