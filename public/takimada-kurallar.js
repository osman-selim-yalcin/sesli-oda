'use strict';

// Takımada: uzun bir adada iskele, fener ve rota kurma oyunu.
// - 24 altıgen arazi (4-5-6-5-4 sıralar): Kereste, Taş, Balık, Tuz ve iki lagün. Her arazinin 1-6 arası bir gelgit işareti var.
// - Sıra başında tek gelgit zarı atılır; işareti zarla aynı olan araziler komşu iskelelere 1, fenerlere 2 mal verir.
// - Fırtına bir arazinin üstünde durur ve o arazi üretmez. Her sıranın sonunda komşu bir araziye kendiliğinden sürüklenir.
// - Rota: 1 kereste + 1 tuz. İskele: 1 kereste + 1 taş + 1 balık (1 puan). Fener: 2 taş + 2 balık + 1 tuz (2 puan).
// - Bankayla 3:1, oyuncularla bire bir takas. İlk 8 puan kazanır.
(() => {
  const resources = ['Kereste', 'Taş', 'Balık', 'Tuz'];
  const routeCost = [1, 0, 0, 1];
  const dockCost = [1, 1, 1, 0];
  const lightCost = [0, 2, 2, 1];
  const GOAL = 8;
  const die = () => 1 + Math.floor(Math.random() * 6);
  function shuffle(cards) {
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    return cards;
  }
  function create(names) {
    const tiles = [], nodes = [], edges = [];
    const vertices = new Map(), links = new Map(), cells = new Map();
    const land = shuffle([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, -1, -1]);
    const marks = shuffle([1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6, ...shuffle([1, 2, 3, 4, 5, 6]).slice(0, 4)]);
    for (let r = -2; r <= 2; r++) {
      for (let q = -3 - Math.min(r, 0); q <= 2 - Math.max(r, 0); q++) {
        const x = 2 * q + r, y = 3 * r, kind = land.pop();
        const corners = [[0, -2], [1, -1], [1, 1], [0, 2], [-1, 1], [-1, -1]].map(([dx, dy]) => {
          const vx = x + dx, vy = y + dy, key = vx + ',' + vy;
          if (!vertices.has(key)) {
            vertices.set(key, nodes.length);
            nodes.push({ x: vx, y: vy, owner: -1, level: 0, edges: [], tiles: [] });
          }
          const id = vertices.get(key);
          nodes[id].tiles.push(tiles.length);
          return id;
        });
        cells.set(q + ',' + r, tiles.length);
        tiles.push({ q, r, x, y, kind, number: kind < 0 ? 0 : marks.pop(), corners, near: [] });
        corners.forEach((a, i) => {
          const b = corners[(i + 1) % 6], key = Math.min(a, b) + ',' + Math.max(a, b);
          if (links.has(key)) return;
          links.set(key, edges.length);
          nodes[a].edges.push(edges.length);
          nodes[b].edges.push(edges.length);
          edges.push({ a, b, owner: -1 });
        });
      }
    }
    for (const t of tiles) {
      for (const [dq, dr] of [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]) {
        const n = cells.get((t.q + dq) + ',' + (t.r + dr));
        if (n !== undefined) t.near.push(n);
      }
    }
    return { players: names, tiles, nodes, edges, hand: names.map(() => [0, 0, 0, 0]), phase: 'settle',
      turn: 0, setup: 0, anchor: null, storm: tiles.findIndex(t => t.kind < 0), dice: [], gain: null, goal: GOAL,
      log: 'İlk iskelenin yerini seç.', done: false };
  }
  const other = (edge, i) => edge.a === i ? edge.b : edge.a;
  const affordable = (hand, cost) => cost.every((n, i) => hand[i] >= n);
  const score = (g, p) => g.nodes.reduce((n, v) => n + (v.owner === p ? v.level : 0), 0);
  function available(g) {
    if (g.done) return [];
    const me = g.turn, hand = g.hand[me], acts = [];
    const hasRoute = i => g.nodes[i].edges.some(e => g.edges[e].owner === me);
    if (g.phase === 'offer') return ['accept', 'decline'];
    if (g.phase === 'roll') return ['roll'];
    if (g.phase === 'build') {
      acts.push('end');
      for (const [p, stock] of g.hand.entries()) {
        if (p === me) continue;
        for (let give = 0; give < 4; give++) for (let get = 0; get < 4; get++) {
          if (give !== get && hand[give] && stock[get]) acts.push(['offer', p, give, get].join(':'));
        }
      }
      for (let i = 0; i < 4; i++) {
        if (hand[i] < 3) continue;
        for (let j = 0; j < 4; j++) if (i !== j) acts.push('trade:' + i + ':' + j);
      }
    }
    g.nodes.forEach((v, i) => {
      if (g.phase === 'build' && v.owner === me && v.level === 1 && affordable(hand, lightCost)) acts.push('light:' + i);
      if (g.phase !== 'settle' && !(g.phase === 'build' && affordable(hand, dockCost) && hasRoute(i))) return;
      if (!v.level && v.edges.every(e => !g.nodes[other(g.edges[e], i)].level)) acts.push('dock:' + i);
    });
    g.edges.forEach((e, i) => {
      if (e.owner !== -1) return;
      const ends = [e.a, e.b];
      if (g.phase === 'road' && ends.includes(g.anchor)) acts.push('route:' + i);
      if (g.phase === 'build' && affordable(hand, routeCost) && ends.some(n => g.nodes[n].owner === me || (g.nodes[n].owner === -1 && hasRoute(n)))) acts.push('route:' + i);
    });
    return acts;
  }
  function play(g, action) {
    const [type, index, output] = action.split(':');
    const i = Number(index), me = g.turn, hand = g.hand[me], name = g.players[me];
    const pay = cost => cost.forEach((n, k) => hand[k] -= n);
    if (type === 'roll') {
      const mark = die();
      g.dice = [mark];
      g.gain = g.players.map(() => [0, 0, 0, 0]);
      let blocked = false;
      g.tiles.forEach((t, k) => {
        if (t.number !== mark) return;
        if (k === g.storm) { blocked = true; return; }
        for (const n of t.corners) {
          const v = g.nodes[n];
          if (v.level) { g.hand[v.owner][t.kind] += v.level; g.gain[v.owner][t.kind] += v.level; }
        }
      });
      g.log = name + ' gelgit zarını attı · ' + mark + (blocked ? ' · Fırtınadaki arazi üretmedi.' : '');
      g.phase = 'build';
    } else if (type === 'dock' || type === 'light') {
      const v = g.nodes[i];
      if (g.phase === 'settle') {
        g.anchor = i;
        g.phase = 'road';
        if (g.setup >= g.players.length) for (const k of v.tiles) if (g.tiles[k].kind >= 0) hand[g.tiles[k].kind]++;
      } else pay(type === 'dock' ? dockCost : lightCost);
      v.owner = me;
      v.level = type === 'dock' ? 1 : 2;
      g.log = name + (v.level === 1 ? ' iskele kurdu.' : ' fener dikti.');
    } else if (type === 'route') {
      g.edges[i].owner = me;
      g.log = name + ' rota açtı.';
      if (g.phase === 'road') {
        g.setup++;
        const count = g.players.length;
        g.phase = g.setup === 2 * count ? 'roll' : 'settle';
        g.turn = g.setup < count ? g.setup : Math.max(0, 2 * count - 1 - g.setup);
      } else pay(routeCost);
    } else if (type === 'offer') {
      const get = Number(action.split(':')[3]);
      g.offer = { from: me, give: Number(output), get }; g.turn = i; g.phase = 'offer';
      g.log = name + ' 1 ' + resources[g.offer.give] + ' verip 1 ' + resources[get] + ' istiyor.';
    } else if (type === 'accept' || type === 'decline') {
      const { from, give, get } = g.offer;
      if (type === 'accept') {
        g.hand[from][give]--; hand[give]++; hand[get]--; g.hand[from][get]++;
      }
      g.offer = null; g.turn = from; g.phase = 'build';
      g.log = name + (type === 'accept' ? ' takası kabul etti.' : ' takası reddetti.');
    } else if (type === 'trade') {
      hand[i] -= 3;
      hand[Number(output)]++;
      g.log = name + ' bankayla takas yaptı.';
    } else if (type === 'end') {
      const near = g.tiles[g.storm].near;
      g.storm = near[Math.floor(Math.random() * near.length)];
      g.gain = null;
      g.turn = (me + 1) % g.players.length;
      g.phase = 'roll';
      g.log = 'Fırtına sürüklendi. Sıra ' + g.players[g.turn] + ' tarafında.';
    }
    if (score(g, me) >= GOAL) { g.done = true; g.log = name + ' ' + GOAL + ' puana ulaştı ve kazandı!'; }
  }
  function bot(g, acts) {
    if (g.phase === 'offer') return g.hand[g.turn][g.offer.get] >= g.hand[g.turn][g.offer.give] ? 'accept' : 'decline';
    const prefix = x => acts.filter(a => a.startsWith(x + ':'));
    const sites = [...prefix('light'), ...prefix('dock')];
    if (sites.length) {
      // Çok araziye ve farklı mallara dokunan köşeler daha değerli
      const quality = a => {
        const kinds = g.nodes[Number(a.split(':')[1])].tiles.map(k => g.tiles[k].kind).filter(k => k >= 0);
        return kinds.length + new Set(kinds).size;
      };
      return shuffle(sites).sort((a, b) => quality(b) - quality(a))[0];
    }
    const h = g.hand[g.turn];
    const trades = prefix('trade').filter(a => { const [, give, get] = a.split(':'); return h[get] < 1 && h[give] - 3 >= 1; });
    if (trades.length) return shuffle(trades)[0];
    const routes = prefix('route');
    if (routes.length && (g.phase === 'road' || h[0] + h[3] > 3 || Math.random() < 0.5)) return shuffle(routes)[0];
    return acts.includes('end') ? 'end' : shuffle([...acts])[0];
  }
  const rules = { create, available, play, bot, score, resources, costs: { route: routeCost, dock: dockCost, light: lightCost }, goal: GOAL };
  if (typeof module === 'object' && module.exports) module.exports = rules;
  else window.TakimadaRules = rules;
})();
