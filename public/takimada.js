'use strict';

// Takımada arayüzü: eğik 3D ada masası (kalınlığı olan altıgen araziler, kutu iskeleler, fener kuleleri, rota
// çubukları, süzülen fırtına bulutu) ve sağda liman defteri (zar, ambar, inşa, takas). Kurallar takimada-kurallar.js.
(() => {
  const K = window.KutuOyun, R = window.TakimadaRules;
  const { el, art, button, pressable, box } = K;
  const MAT = ['wood', 'ore', 'fish', 'salt'];
  const LAND = ['orman', 'tas', 'koy', 'tuzla'];
  // Ölçüler css/games.css .tk-* ile aynı olmalı: köşe ızgarası U x V, arazi kalınlığı TH
  const U = 40, V = 23, TH = 16, TILT = 48;
  const BUILD = [
    { type: 'route', name: 'Rota', note: 'Yeni köşelere uzanır', icon: 'road' },
    { type: 'dock', name: 'İskele', note: '1 puan · arazilerden 1 mal', icon: 'dock' },
    { type: 'light', name: 'Fener', note: '2 puan · arazilerden 2 mal', icon: 'light' },
  ];
  const at = (x, y, z = 0) => `translate3d(${x}px, ${y}px, ${z}px)`;

  function scene(ctx, targets) {
    const { g, submit, prev, fresh } = ctx;
    const stage = el('div', 'tk-stage');
    const plane = el('div', 'tk-plane');
    const justRolled = g.phase === 'build' && g.gain;
    for (const [i, t] of g.tiles.entries()) {
      const water = t.kind < 0;
      const tile = el('div', 'tk-tile' + (g.storm === i ? ' stormy' : '') + (justRolled && t.number === g.dice[0] ? (g.storm === i ? ' blocked' : ' hit') : ''));
      tile.dataset.kind = water ? 'lagun' : LAND[t.kind];
      tile.style.transform = at(t.x * U, t.y * V, water ? 7 : TH);
      for (const f of ['r', 'br', 'bl', 'l']) tile.append(el('i', 'tk-side ' + f));
      const top = el('div', 'tk-top');
      if (!water) {
        top.append(art(MAT[t.kind], 'tk-deco'), el('b', 'tk-mark', String(t.number)));
        top.title = `${R.resources[t.kind]} · gelgit işareti ${t.number}`;
      } else top.title = 'Lagün · üretmez';
      tile.append(top);
      plane.append(tile);
    }
    for (const [i, e] of g.edges.entries()) {
      const a = g.nodes[e.a], b = g.nodes[e.b];
      const mx = (a.x + b.x) / 2 * U, my = (a.y + b.y) / 2 * V;
      const angle = Math.atan2((b.y - a.y) * V, (b.x - a.x) * U) * 180 / Math.PI;
      if (e.owner >= 0) {
        const route = el('div', 'tk-route' + (prev && prev.edges[i].owner < 0 ? ' fresh' : ''));
        route.style.transform = at(mx, my, TH) + ` rotateZ(${angle}deg)`;
        route.style.setProperty('--c', K.colors[e.owner]);
        route.append(box(32, 8, 6));
        plane.append(route);
      } else if (targets.has('route:' + i)) {
        const lane = el('div', 'tk-lane');
        lane.style.transform = at(mx, my, TH + 1) + ` rotateZ(${angle}deg)`;
        pressable(lane, 'Rota aç', () => submit('route:' + i));
        plane.append(lane);
      }
    }
    for (const [i, n] of g.nodes.entries()) {
      if (n.level) {
        const b = el('div', 'tk-build ' + (n.level === 2 ? 'light' : 'dock') + (prev && prev.nodes[i].level !== n.level ? ' fresh' : ''));
        b.style.transform = at(n.x * U, n.y * V, TH);
        b.style.setProperty('--c', K.colors[n.owner]);
        if (n.level === 1) b.append(box(20, 20, 14, 'hut'), box(13, 13, 7, 'roof'));
        else b.append(box(18, 18, 8, 'base'), box(12, 12, 46, 'tower'), box(16, 16, 8, 'lamp'), el('i', 'tk-beam'));
        plane.append(b);
      }
      const action = (n.level ? 'light:' : 'dock:') + i;
      if (targets.has(action)) {
        const spot = el('div', 'tk-spot' + (n.level ? ' up' : ''));
        spot.style.transform = at(n.x * U, n.y * V, TH + (n.level ? 26 : 1));
        spot.append(el('i'));
        pressable(spot, n.level ? 'Fenere yükselt' : 'İskele kur', () => submit(action));
        plane.append(spot);
      }
    }
    const st = g.tiles[g.storm];
    const storm = el('div', 'tk-storm');
    storm.style.transform = at(st.x * U, st.y * V, TH);
    const cloud = el('div', 'tk-cloud');
    cloud.append(art('storm'));
    storm.append(el('i', 'tk-storm-shade'), cloud);
    plane.append(storm);
    if (fresh && prev && prev.storm !== g.storm && storm.animate) {
      const from = prev.tiles[prev.storm];
      storm.animate([{ transform: at(from.x * U, from.y * V, TH) }, { transform: storm.style.transform }], { duration: 900, easing: 'cubic-bezier(.4,0,.2,1)' });
    }
    stage.append(el('div', 'tk-sea'), plane);

    // Adayı sahneye sığdır
    const xs = g.nodes.map(n => n.x * U), ys = g.nodes.map(n => n.y * V);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const flat = Math.cos(TILT * Math.PI / 180);
    const fit = () => {
      if (!stage.clientWidth) return;
      const scale = Math.min(stage.clientWidth / (maxX - minX + 70), stage.clientHeight / ((maxY - minY + 150) * flat), 1.9);
      plane.style.setProperty('--s', scale.toFixed(3));
      plane.style.setProperty('--cx', ((minX + maxX) / 2).toFixed(1) + 'px');
      plane.style.setProperty('--cy', ((minY + maxY) / 2).toFixed(1) + 'px');
    };
    ctx.state.observer?.disconnect();
    ctx.state.observer = new ResizeObserver(fit);
    ctx.state.observer.observe(stage);
    return stage;
  }

  function draw(ctx) {
    const { g, me, mine, acts, submit, body, fresh, prev, state, rerender } = ctx;
    const seat = me < 0 ? g.turn : me;
    if (!acts.some(a => a.startsWith(state.filter + ':'))) state.filter = '';
    const targets = new Set(acts.filter(a => /^(route|dock|light):/.test(a) && (!state.filter || a.startsWith(state.filter + ':'))));
    const layout = el('div', 'tk-layout');
    const stage = scene(ctx, targets);

    const hints = {
      settle: 'Başlangıç iskeleni kur: parlayan köşelerden birine dokun.',
      road: 'İskelenden çıkan kesikli rotalardan birini seç.',
      roll: 'Gelgit zarını at. İşareti zarla aynı olan araziler mal verir.',
      build: 'İnşa et, takas yap ya da sırayı bitir.',
      offer: g.log,
    };
    const hint = el('p', 'tk-hint' + (mine ? ' mine' : ''), g.done ? g.log : mine ? hints[g.phase] : `${g.players[g.turn]} oynuyor · ${g.log}`);
    hint.setAttribute('aria-live', 'polite');
    stage.append(hint);

    const rail = el('aside', 'tk-rail');
    // Zar
    const rolled = fresh && prev && prev.phase === 'roll' && g.phase === 'build';
    const tide = el('section', 'tk-card tk-tide');
    const tideText = el('div', 'tk-tide-text');
    tideText.append(el('strong', '', g.dice.length ? 'Gelgit ' + g.dice[0] : 'Gelgit zarı'), el('small', '', g.dice.length ? g.log : 'Henüz atılmadı.'));
    tide.append(K.die(g.dice[0], rolled), tideText);
    if (acts.includes('roll')) tide.append(button('Zarı at', () => submit('roll'), { icon: 'dice', cls: 'primary' }));
    rail.append(tide);
    // Ambar
    const hold = el('section', 'tk-card');
    hold.append(el('h4', '', me < 0 || (ctx.local && !ctx.robot) ? `${g.players[seat]} · ambar` : 'Ambarım'));
    const rack = el('div', 'tk-hold');
    R.resources.forEach((name, k) => {
      const cell = el('div', 'tk-res');
      cell.append(art(MAT[k]), el('b', '', String(g.hand[seat][k])), el('small', '', name));
      const gain = g.gain?.[seat][k];
      if (gain) cell.append(el('span', 'tk-gain' + (rolled ? ' fresh' : ''), '+' + gain));
      rack.append(cell);
    });
    hold.append(rack);
    rail.append(hold);
    // İnşa
    const yard = el('section', 'tk-card');
    yard.append(el('h4', '', 'İnşa'));
    const setup = g.phase === 'settle' || g.phase === 'road';
    for (const b of BUILD) {
      const row = button('', () => { state.filter = state.filter === b.type ? '' : b.type; rerender(); }, { icon: b.icon, cls: 'tk-plan' });
      const can = acts.some(a => a.startsWith(b.type + ':'));
      row.disabled = !can;
      row.setAttribute('aria-pressed', String(state.filter === b.type));
      const text = el('span', 'tk-plan-text');
      text.append(el('strong', '', b.name), el('small', '', b.note));
      const cost = el('span', 'tk-cost');
      if (setup && can) cost.append('Kurulumda bedava');
      else R.costs[b.type].forEach((n, k) => { for (let c = 0; c < n; c++) cost.append(art(MAT[k])); });
      row.title = `${b.name}: ` + R.costs[b.type].map((n, k) => n ? `${n} ${R.resources[k]}` : '').filter(Boolean).join(', ');
      row.append(text, cost);
      yard.append(row);
    }
    rail.append(yard);
    // Takas ve sıra
    const desk = el('section', 'tk-card tk-desk');
    const trades = acts.filter(a => a.startsWith('trade:'));
    if (trades.length) {
      const select = el('select');
      select.setAttribute('aria-label', 'Banka takası');
      for (const a of trades) { const [, i, j] = a.split(':'); select.add(new Option(`3 ${R.resources[i]} → 1 ${R.resources[j]}`, a)); }
      desk.append(el('h4', '', 'Banka (3:1)'), select, button('Değiştir', () => submit(select.value), { icon: 'trade' }));
    }
    const offers = acts.filter(a => a.startsWith('offer:'));
    if (offers.length) {
      const select = el('select');
      select.setAttribute('aria-label', 'Oyuncuyla takas');
      for (const a of offers) { const [, p, give, get] = a.split(':'); select.add(new Option(`${g.players[p]}: 1 ${R.resources[give]} ver, 1 ${R.resources[get]} al`, a)); }
      desk.append(el('h4', '', 'Oyuncuyla takas'), select, button('Teklif et', () => submit(select.value), { icon: 'trade' }));
    }
    if (acts.includes('accept')) {
      desk.append(el('h4', '', 'Takas teklifi'), el('p', 'tk-offer', g.log), button('Kabul et', () => submit('accept'), { cls: 'primary' }), button('Reddet', () => submit('decline')));
    }
    if (acts.includes('end')) desk.append(button('Sırayı bitir', () => submit('end'), { cls: 'tk-end' }));
    if (desk.children.length) rail.append(desk);

    layout.append(stage, rail);
    body.append(layout);
  }

  K.register('takimada', {
    title: 'Takımada', engine: R, icon: 'dice', pace: 700,
    tagline: 'Adaya iskeleler kur, rotalarını uzat, fenerlerini dik.',
    hint: '2–4 oyuncuyla veya oda botuyla oynanır.',
    seat: (g, i) => ({ text: `${R.score(g, i)}/${R.goal} puan`, value: R.score(g, i), max: R.goal }),
    rules: `
      <p><strong>Amaç:</strong> ilk 8 puana ulaşan kazanır. İskele 1, fener 2 puandır.</p>
      <p><strong>Kurulum:</strong> herkes sırayla iki iskele ve yanına birer rota yerleştirir. İkinci iskelen komşu arazilerden birer mal getirir. İki iskele yan yana köşelere kurulamaz.</p>
      <p><strong>Sıra:</strong> gelgit zarını at. İşareti zarla aynı olan araziler komşu iskelelere 1, fenerlere 2 mal verir. Sonra istediğin kadar inşa et ve takas yap, sırayı bitir.</p>
      <p><strong>Fırtına:</strong> üstünde durduğu arazi üretmez. Her sıranın sonunda komşu bir araziye kendiliğinden sürüklenir.</p>
      <p><strong>Bedeller:</strong> Rota 1 kereste + 1 tuz. İskele 1 kereste + 1 taş + 1 balık (rotana bağlı bir köşeye). Fener 2 taş + 2 balık + 1 tuz (kendi iskelenin yerine).</p>
      <p><strong>Takas:</strong> bankada aynı maldan 3 verip istediğin 1 malı alırsın. Oyunculara bire bir takas teklif edebilirsin; karşı taraf kabul ya da reddeder.</p>`,
    draw,
  });
})();
