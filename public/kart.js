'use strict';

// ---------- Kağıt oyunları (istemci) ----------
// Blackjack, Arasında, Texas Hold'em, Pişti, Batak, Kemal. app.js'ten sonra yüklenir; $, socket, myName, LOBBY,
// renderLobby, confirmButton, makeAvatar, lobbyButton, lobbyEmit, kelimeSmall, BOT_NAME oradan gelir.
// Sunucu (games/kart.js) her oyuncuya kendi görünümünü yollar: kendi kartları açık, başkalarınınki null (kapalı).
// Her oyunun bölümü index.html'de: #game-<oyun> içinde #lobby-<oyun> ve #kart-<oyun>; içerik burada çizilir.

const KART_KEYS = ['blackjack', 'arasinda', 'poker', 'pisti', 'batak', 'kemal'];
const KART = {}; // oyun -> sunucudan gelen görünüm
let kartClock = 0; // sunucu saati - yerel saat
const kartSel = { kemal: null }; // kemal: seçili kart { from: 'hand'|'table', i }
const kartRaise = {}; // poker/arasında: kaydırıcıdaki değer (oyun|el anahtarıyla)

const KART_SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
const KART_SUIT_NAME = { S: 'Maça', H: 'Kupa', D: 'Karo', C: 'Sinek' };
const KART_RANK = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const KART_OPTS = {
  blackjack: { key: 'rounds', label: 'El:', values: [5, 10, 20] },
  arasinda: { key: 'rounds', label: 'Tur:', values: [3, 5, 10] },
  pisti: { key: 'target', label: 'Hedef:', values: [51, 101, 151] },
  batak: { key: 'rounds', label: 'El:', values: [3, 5, 8] },
  kemal: { key: 'target', label: 'Hedef:', values: [3, 5, 7] },
};
const KART_TITLE = { blackjack: 'Blackjack', arasinda: 'Arasında', poker: "Texas Hold'em", pisti: 'Pişti', batak: 'Batak', kemal: 'Kemal' };
const KART_HINT = {
  blackjack: 'Kurpiyere karşı 21\'e en yakın eli yap, 21\'i geçme. 1-7 kişi; tek başına da oynanır. Başta herkese 1000 çip.',
  arasinda: 'İki kart açılır; üçüncünün arasına düşeceğine pottan bahis yap. 1-8 kişi; tek başına başlatırsan iki bilgisayar oturur.',
  poker: 'İki kapalı kart, ortada beş açık kart; en iyi eli yap ya da blöfle. 1-8 kişi; masa bilgisayarlarla 4 kişiye tamamlanır.',
  pisti: 'Ortadaki kartla aynı sayıyı ya da Vale atıp yığını al; tek kartı alırsan pişti. 1-4 kişi; tek başına başlatırsan bilgisayara karşı.',
  batak: 'İhaleyi al, kozu seç, sözün kadar el topla. 4 kişilik; eksik koltuklara bilgisayar oturur.',
  kemal: 'Dört aynı kartı topla, ortağına gizli işaret ver; o "Kemal!" desin. 2\'ye 2; eksik koltuklara bilgisayar oturur.',
};

const kartShown = (name) => (name === BOT_NAME ? 'Bilgisayar' : name);
const kartNow = () => Date.now() + kartClock;
const kartMine = (g) => Boolean(g && g.players.includes(myName));
const kartEl = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
};
const kartFmt = (n) => Number(n || 0).toLocaleString('tr-TR');

// Kart ve kart sırası (public/kart-fx.js). slot: masadaki yer adı; kapalı kartların ve açılan kartın canlanması için.
const kartCard = (c, cls = '', slot = null, from = null) => KartFx.card(c, cls, slot, from);
const kartCards = (cards, cls = '', each, slot = null) => {
  const row = kartEl('div', 'kc-row ' + cls);
  const list = cards || [];
  row.style.setProperty('--n', list.length);
  list.forEach((c, i) => {
    const el = kartCard(c, '', slot ? `${slot}:${i}` : null);
    el.style.setProperty('--i', i);
    each?.(el, c, i);
    row.append(el);
  });
  return row;
};

// Koltuk sırası: ben (ya da izleyicide ilk oyuncu) altta; diğerleri saat yönünde sol, üst, sağ (4'ten fazlası üstte sıra).
function kartSeats(g) {
  const n = g.players.length;
  const me = Math.max(0, g.players.indexOf(myName));
  return g.players.map((name, i) => {
    const rel = (i - me + n) % n;
    let pos = 'top';
    if (rel === 0) pos = 'me';
    else if (n <= 4) pos = n === 2 ? 'top' : rel === 1 ? 'left' : rel === n - 1 ? 'right' : 'top';
    return { name, i, rel, pos };
  });
}

// Koltuk kutusu: avatar, ad, alt satır (çip/puan), etiket (sıra, son hamle), süre çubuğu.
function kartSeat(g, name, { sub, tag, cards, cls = '' } = {}) {
  const box = kartEl('div', 'kart-seat ' + cls);
  box.dataset.seat = name;
  if (name === myName) box.classList.add('me');
  if (g.bots?.includes(name) && name !== BOT_NAME && !name.startsWith('Bilgisayar')) box.classList.add('away');
  const head = kartEl('div', 'kart-seat-head');
  const who = kartEl('div', 'kart-seat-who');
  who.append(kartEl('strong', 'kart-seat-name', kartShown(name) + (name === myName ? ' (sen)' : '')));
  if (sub != null) who.append(kartEl('span', 'kart-seat-sub', sub));
  head.append(makeAvatar(name), who);
  box.append(head);
  if (tag) box.append(kartEl('span', 'kart-tag', tag));
  if (cards) box.append(cards);
  const until = g.deadlines?.[name];
  if (until && !g.done) {
    const left = Math.max(0, until - kartNow());
    const bar = kartEl('i', 'kart-timer');
    bar.style.setProperty('--left', `${left}ms`);
    bar.style.setProperty('--from', String(Math.min(1, left / 45000)));
    box.append(bar);
  }
  return box;
}

// Masa iskeleti: üst/sol/sağ koltuklar, orta alan, benim koltuğum, eylem çubuğu, kayıt.
function kartFelt(g, center, seatFor) {
  const felt = kartEl('div', 'kart-felt');
  felt.dataset.n = g.players.length;
  const areas = { top: kartEl('div', 'kart-area top'), left: kartEl('div', 'kart-area left'), right: kartEl('div', 'kart-area right'), me: kartEl('div', 'kart-area me') };
  for (const s of kartSeats(g)) {
    const seat = seatFor(s);
    if (g.turn === s.name || (Array.isArray(g.turn) && g.turn.includes(s.name))) seat.classList.add('turn');
    seat.dataset.pos = s.pos;
    areas[s.pos].append(seat);
  }
  const mid = kartEl('div', 'kart-area center');
  mid.append(center);
  if (g.pause) mid.append(kartPause(g));
  // Deste: yeni kartlar buradan uçar
  const shoe = kartEl('div', 'kart-shoe');
  for (let i = 0; i < 4; i++) shoe.append(KartFx.card(null, 'shoe-card'));
  felt.append(shoe, areas.top, areas.left, mid, areas.right, areas.me);
  return felt;
}

// Ara: el sonu ya da sonuç gösterilirken sonraki adıma kalan süre çubuğu
const KART_PAUSE = { blackjack: 'Yeni el', arasinda: 'Sıradaki oyuncu', poker: 'Yeni el', pisti: 'Yeni el', batak: 'Yeni el', kemal: 'Yeni dağıtım' };
function kartPause(g) {
  const left = Math.max(0, g.pause.until - kartNow());
  const box = kartEl('div', 'kart-pause kart-pop');
  box.append(kartEl('span', '', KART_PAUSE[g.key] || 'Devam'));
  const bar = kartEl('i', '');
  bar.style.setProperty('--left', `${left}ms`);
  bar.style.setProperty('--from', String(Math.min(1, left / g.pause.ms)));
  box.append(bar);
  return box;
}

function kartLog(g) {
  const box = kartEl('div', 'kart-log');
  for (const line of (g.log || []).slice(-4)) box.append(kartEl('div', '', line));
  return box;
}

const kartAct = (key, a) => socket.emit('kart:act', { key, id: KART[key].id, a });

function kartButton(text, cls, fn, disabled = false) {
  const b = kartEl('button', cls, text);
  b.type = 'button';
  b.onclick = fn;
  b.disabled = disabled;
  return b;
}

// Sonuç kutusu: sıralama, Yeniden oyna, Kapat.
function kartResult(key, g) {
  const box = kartEl('div', 'kart-result');
  box.setAttribute('role', 'status');
  const top = g.standings?.[0];
  const tie = g.standings?.[1] && g.standings[1].score === top?.score;
  const meWon = top && (top.name === myName || top.name.split(' & ').includes(myName));
  box.append(kartEl('strong', 'kart-result-title', tie ? 'Berabere' : meWon ? 'Kazandın!' : `${kartShown(top?.name || '')} kazandı`));
  if (g.reason) box.append(kartEl('span', 'muted small', g.reason));
  const list = kartEl('ol', 'kart-standings');
  const unit = ['blackjack', 'arasinda', 'poker'].includes(key) ? ' çip' : ' puan';
  for (const s of g.standings || []) {
    const li = kartEl('li', s.name === myName ? 'me' : '');
    li.append(kartEl('span', '', kartShown(s.name)), kartEl('b', '', kartFmt(s.score) + unit));
    list.append(li);
  }
  box.append(list);
  const row = kartEl('div', 'kart-result-actions');
  if (g.humans?.includes(myName)) row.append(kartButton('Yeniden oyna', 'primary', () => socket.emit('kart:again', { key })));
  row.append(kartButton('Kapat', 'ghost', () => socket.emit('kart:close', { key })));
  box.append(row);
  return box;
}

// ---------- Blackjack ----------
const BJ_BETS = [10, 25, 50, 100, 250];
const BJ_RESULT = { win: 'Kazandı', bj: 'Blackjack!', push: 'Berabere', lose: 'Kaybetti', bust: 'Yandı' };

function drawBlackjack(g) {
  const center = kartEl('div', 'bj-dealer');
  center.append(kartEl('span', 'kart-label', 'Kurpiyer' + (g.dealerTotal != null ? ` · ${g.dealerTotal}` : '')), kartCards(g.dealer, 'surface dealer', null, 'dealer'));
  center.append(kartEl('span', 'muted small', `El ${g.round}/${g.rounds} · kurpiyer 17'de durur · blackjack 3:2`));
  const felt = kartFelt(g, center, ({ name }) => {
    const hands = g.hands[name] || [];
    const wrap = kartEl('div', 'bj-hands');
    hands.forEach((h, k) => {
      const one = kartEl('div', 'bj-hand' + (g.phase === 'play' && g.turn === name && g.hand === k ? ' active' : ''));
      one.append(kartCards(h.cards, name === myName ? 'mine' : 'small', null, `bj:${name}:${k}`));
      const total = g.totals[name]?.[k];
      const res = h.result && g.phase === 'settle' ? ` · ${BJ_RESULT[h.result]}` : '';
      const info = kartEl('span', 'bj-hand-info' + (h.result ? ` ${h.result}` : ''));
      info.append(KartFx.chips(h.bet), `${total ?? ''}${total ? ' · ' : ''}🪙 ${h.bet}${res}`);
      one.append(info);
      wrap.append(one);
    });
    const net = g.results?.[name];
    const tag = g.phase === 'bet' && g.turn === name ? 'Bahis yapıyor' : net != null ? (net > 0 ? `+${net}` : net < 0 ? `${net}` : '±0') : '';
    return kartSeat(g, name, { sub: `🪙 ${kartFmt(g.chips[name])}`, tag, cards: wrap, cls: net > 0 ? 'won' : '' });
  });
  const bar = kartEl('div', 'kart-actions');
  const myTurn = g.turn === myName && !g.done;
  if (myTurn && g.phase === 'bet') {
    bar.append(kartEl('span', 'kart-actions-label', 'Bahsin:'));
    for (const b of BJ_BETS) bar.append(kartButton(`🪙 ${b}`, 'sm', () => kartAct('blackjack', { type: 'bet', amount: b }), b > g.chips[myName]));
  } else if (myTurn && g.phase === 'play') {
    const h = g.hands[myName][g.hand];
    const fresh = h.cards.length === 2;
    const val = (c) => (c.r === 14 ? 11 : Math.min(c.r, 10));
    bar.append(kartButton('Kart çek', 'primary', () => kartAct('blackjack', { type: 'hit' })), kartButton('Dur', '', () => kartAct('blackjack', { type: 'stand' })));
    if (fresh && g.chips[myName] >= h.bet) bar.append(kartButton('İkiye katla', 'ghost', () => kartAct('blackjack', { type: 'double' })));
    if (fresh && g.hands[myName].length === 1 && val(h.cards[0]) === val(h.cards[1]) && g.chips[myName] >= h.bet) bar.append(kartButton('Böl', 'ghost', () => kartAct('blackjack', { type: 'split' })));
  }
  return [felt, bar];
}

// ---------- Arasında ----------
function drawArasinda(g) {
  const center = kartEl('div', 'ar-center');
  center.append(kartPot(g.pot));
  const row = kartEl('div', 'ar-posts surface');
  const [a, b] = g.posts || [];
  row.append(kartCard(a, 'post', 'post0'), g.third ? kartCard(g.third, 'third ' + (g.outcome || ''), 'third') : kartEl('div', 'kc slot third'), kartCard(b, 'post', 'post1'));
  center.append(row);
  const OUT = { win: 'Arasına düştü!', lose: 'Dışarı düştü', post: 'Direğe çarptı! (2 kat)', pass: 'Pas', nospace: 'Arası yok, sıra geçti' };
  center.append(kartEl('span', 'ar-outcome ' + (g.outcome || ''), g.outcome ? OUT[g.outcome] + (g.bet ? ` · 🪙 ${g.bet}` : '') : g.turn === myName ? 'Sıra sende: bahis yap ya da pas de' : `${kartShown(g.turn || '')} düşünüyor…`));
  center.append(kartEl('span', 'muted small', `Tur ${g.cycle}/${g.rounds}`));
  const felt = kartFelt(g, center, ({ name }) => kartSeat(g, name, { sub: `🪙 ${kartFmt(g.chips[name])}`, cls: g.chips[name] <= 0 ? 'out' : '' }));
  const bar = kartEl('div', 'kart-actions');
  if (g.turn === myName && g.phase === 'bet' && !g.done) bar.append(...kartAmount('arasinda', g, g.min, g.max, 'Yatır', (amount) => kartAct('arasinda', { type: 'bet', amount }), [
    ['En düşük', g.min], ['Potun ¼', Math.round(g.pot / 4)], ['Yarısı', Math.round(g.pot / 2)], ['Pot', g.max],
  ]), kartButton('Pas', 'ghost', () => kartAct('arasinda', { type: 'pass' })));
  return [felt, bar];
}

// Pot: çip yığını ve tutar
function kartPot(amount) {
  const pot = kartEl('div', 'kart-pot');
  pot.append(KartFx.chips(amount, 'big'), kartEl('span', '', `Pot 🪙 ${kartFmt(amount)}`));
  return pot;
}

// Tutar seçici: kaydırıcı + hızlı tutarlar + onay düğmesi
function kartAmount(key, g, min, max, verb, send, quick) {
  const slot = `${key}|${g.id}|${g.handNo ?? g.cycle}|${g.street ?? ''}|${min}|${max}`;
  if (kartRaise.slot !== slot) Object.assign(kartRaise, { slot, value: min });
  const clamp = (v) => Math.max(min, Math.min(max, Math.round(v)));
  const wrap = kartEl('div', 'kart-amount');
  const range = kartEl('input');
  Object.assign(range, { type: 'range', min, max, step: 1, value: kartRaise.value });
  range.setAttribute('aria-label', 'Tutar');
  const go = kartButton('', 'primary', () => send(clamp(Number(range.value))));
  const label = () => (go.textContent = `${verb} 🪙 ${clamp(Number(range.value))}`);
  range.oninput = () => {
    kartRaise.value = Number(range.value);
    label();
  };
  label();
  const chips = kartEl('div', 'kart-quick');
  for (const [text, v] of quick) {
    if (!(v >= min && v <= max)) continue;
    chips.append(kartButton(text, 'sm ghost', () => {
      range.value = clamp(v);
      kartRaise.value = clamp(v);
      label();
    }));
  }
  wrap.append(chips, range, go);
  return [wrap];
}

// ---------- Texas Hold'em ----------
const PK_STREET = { preflop: 'Kartlar dağıtıldı', flop: 'Flop', turn: 'Turn', river: 'River', showdown: 'Kartlar açıldı' };
function drawPoker(g) {
  const center = kartEl('div', 'pk-center');
  const board = kartEl('div', 'kc-row board surface');
  for (let i = 0; i < 5; i++) board.append(g.board[i] ? kartCard(g.board[i]) : kartEl('div', 'kc slot'));
  center.append(kartPot(g.pot), board);
  const winners = g.winners?.map((w) => `${kartShown(w.name)} +${w.amount}${w.hand ? ` (${w.hand})` : ''}`).join(' · ');
  center.append(kartEl('span', 'muted small', winners || `${PK_STREET[g.street] || ''} · El ${g.handNo} · kör ${g.sb}/${g.sb * 2}`));
  const felt = kartFelt(g, center, ({ name }) => {
    const folded = !g.inHand.includes(name) && g.hole[name];
    const cards = kartCards(g.hole[name] || [], name === myName ? 'mine' : 'small', null, `hole:${name}`);
    const tag = [g.last?.[name], g.handNames?.[name]].filter(Boolean).join(' · ');
    const seat = kartSeat(g, name, { sub: `${kartFmt(g.chips[name])} çip${g.button === name ? ' 🔘' : ''}`, tag, cards, cls: (folded ? 'folded' : '') + (!g.hole[name] ? ' out' : '') });
    if (g.bets[name]) {
      const bet = kartEl('span', 'kart-bet');
      bet.append(KartFx.chips(g.bets[name]), kartEl('b', '', kartFmt(g.bets[name])));
      seat.append(bet);
    }
    if (g.winners?.some((w) => w.name === name)) seat.classList.add('won');
    return seat;
  });
  const bar = kartEl('div', 'kart-actions');
  if (g.mine) bar.append(kartEl('span', 'kart-actions-label', `Elin: ${g.mine}`));
  const legal = g.legal || [];
  if (legal.length && !g.done) {
    const has = (t) => legal.find((m) => m.type === t);
    bar.append(kartButton('Çekil', 'ghost danger', () => kartAct('poker', { type: 'fold' })));
    if (has('check')) bar.append(kartButton('Pas', '', () => kartAct('poker', { type: 'check' })));
    if (has('call')) bar.append(kartButton(`Gör 🪙 ${has('call').amount}`, '', () => kartAct('poker', { type: 'call' })));
    const r = has('raise');
    if (r) {
      bar.append(...kartAmount('poker', g, r.min, r.max, g.current ? 'Yükselt' : 'Bahis', (amount) => kartAct('poker', { type: 'raise', amount }), [
        ['½ pot', g.current + Math.round(g.pot / 2)], ['Pot', g.current + g.pot], ['All-in', r.max],
      ]));
    }
  }
  return [felt, bar];
}

// ---------- Pişti ----------
function drawPisti(g) {
  const center = kartEl('div', 'ps-center');
  const pile = kartEl('div', 'ps-pile surface');
  if (g.pileUnder) pile.append(kartCard(null, 'under'));
  pile.append(g.pile[0] ? kartCard(g.pile[0], 'top', null, g.lastPlay?.by || null) : kartEl('div', 'kc slot'));
  if (g.pileCount) pile.append(kartEl('span', 'ps-count', String(g.pileCount)));
  center.append(pile);
  center.append(kartEl('span', 'muted small', `Destede ${g.deckCount} · hedef ${g.target}`));
  if (g.phase === 'tally' && g.dealScores) {
    const t = kartEl('div', 'kart-tally kart-pop');
    for (const p of g.players) {
      const s = g.dealScores[p];
      t.append(kartEl('div', '', `${kartShown(p)}: +${s.points} (${s.cards} kart, ${s.pistis} pişti)`));
    }
    center.append(t);
  }
  const myTurn = g.turn === myName;
  const felt = kartFelt(g, center, ({ name }) => {
    const cards = name === myName
      ? kartCards(g.hands[name], 'hand' + (myTurn ? ' playable' : ''), (el, c, i) => {
        if (!myTurn) return;
        el.classList.add('can');
        el.tabIndex = 0;
        el.setAttribute('role', 'button');
        el.onclick = () => kartAct('pisti', { type: 'play', i });
        el.onkeydown = (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), el.click());
      })
      : kartCards(g.hands[name], 'small fan', null, `ps:${name}`);
    const pis = g.pistis[name] ? ` · ${g.pistis[name]} pişti` : '';
    return kartSeat(g, name, { sub: `${g.scores[name]} puan · ${g.taken[name]} kart${pis}`, cards });
  });
  const bar = kartEl('div', 'kart-actions');
  if (myTurn && !g.done) bar.append(kartEl('span', 'kart-actions-label', 'Sıra sende: bir kart at.'));
  return [felt, bar];
}

// ---------- Batak ----------
function drawBatak(g) {
  const center = kartEl('div', 'bt-center');
  const trick = kartEl('div', 'bt-trick surface');
  const seats = kartSeats(g);
  const shown = g.trick;
  for (const t of shown) {
    const s = seats.find((x) => x.name === t.by);
    const el = kartCard(t.card, 'pos-' + s.pos, null, t.by);
    trick.append(el);
  }
  center.append(trick);
  const info = g.trump ? `Koz ${KART_SUIT[g.trump]} ${KART_SUIT_NAME[g.trump]} · ihale ${kartShown(g.bidder)} ${g.high}` : g.high ? `İhale ${g.high}` : 'İhale başlıyor';
  center.append(kartEl('span', 'bt-info' + (g.trump === 'H' || g.trump === 'D' ? ' red' : ''), info));
  center.append(kartEl('span', 'muted small', `El ${g.handNo}/${g.rounds}`));
  if (g.phase === 'tally' && g.handScores) {
    const t = kartEl('div', 'kart-tally kart-pop');
    for (const p of g.players) t.append(kartEl('div', '', `${kartShown(p)}: ${g.tricks[p]} el → ${g.handScores[p] > 0 ? '+' : ''}${g.handScores[p]}`));
    center.append(t);
  }
  const myTurn = g.turn === myName && g.phase === 'play';
  const felt = kartFelt(g, center, ({ name }) => {
    const bid = g.bids[name];
    const tag = g.phase === 'bid' || g.phase === 'trump' ? (bid === 'pass' ? 'Pas' : bid ? `${bid} dedi` : '') : name === g.bidder ? `İhale ${g.high}` : '';
    const cards = name === myName
      ? kartCards(g.hands[name], 'hand' + (g.hands[name].length > 8 ? ' many' : ''), (el, c, i) => {
        if (!myTurn) return;
        if (!g.playable.includes(i)) return el.classList.add('dim');
        el.classList.add('can');
        el.tabIndex = 0;
        el.setAttribute('role', 'button');
        el.onclick = () => kartAct('batak', { type: 'play', i });
        el.onkeydown = (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), el.click());
      })
      : kartCards(g.hands[name], 'small fan', null, `bt:${name}`);
    return kartSeat(g, name, { sub: `${g.scores[name]} puan · ${g.tricks[name]} el`, tag, cards });
  });
  const bar = kartEl('div', 'kart-actions');
  if (g.turn === myName && g.phase === 'bid') {
    bar.append(kartEl('span', 'kart-actions-label', 'İhale:'), kartButton('Pas', 'ghost', () => kartAct('batak', { type: 'pass' })));
    for (let n = Math.max(5, g.high + 1); n <= 13; n++) bar.append(kartButton(String(n), 'sm', () => kartAct('batak', { type: 'bid', n })));
  } else if (g.turn === myName && g.phase === 'trump') {
    bar.append(kartEl('span', 'kart-actions-label', 'Kozu seç:'));
    for (const s of ['S', 'H', 'D', 'C']) bar.append(kartButton(`${KART_SUIT[s]} ${KART_SUIT_NAME[s]}`, 'suit ' + (s === 'H' || s === 'D' ? 'red' : ''), () => kartAct('batak', { type: 'trump', s })));
  } else if (myTurn) bar.append(kartEl('span', 'kart-actions-label', 'Sıra sende: parlayan kartlardan birini at.'));
  return [felt, bar];
}

// ---------- Kemal ----------
function drawKemal(g) {
  const sel = kartSel.kemal;
  const seated = kartMine(g) && g.phase === 'swap' && !g.done;
  const pick = (from, i) => {
    const cur = kartSel.kemal;
    if (cur && cur.from !== from) {
      const h = from === 'hand' ? i : cur.i;
      const t = from === 'table' ? i : cur.i;
      kartSel.kemal = null;
      kartAct('kemal', { type: 'swap', h, t });
      return;
    }
    kartSel.kemal = cur && cur.from === from && cur.i === i ? null : { from, i };
    renderKart('kemal');
  };
  const clickable = (from) => (el, c, i) => {
    if (!seated) return;
    el.classList.add('can');
    if (sel?.from === from && sel.i === i) el.classList.add('picked');
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.onclick = () => pick(from, i);
    el.onkeydown = (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), el.click());
  };
  const center = kartEl('div', 'km-center');
  center.append(kartEl('span', 'kart-label', 'Ortadaki kartlar'), kartCards(g.table, 'table surface', clickable('table')));
  center.append(kartEl('span', 'muted small', `${g.ready.length}/4 hazır · destede ${g.deckCount} · hedef ${g.target}`));
  if (g.result) {
    const r = g.result;
    const text = r.kind === 'kemal' ? (r.ok ? `${kartShown(r.by)}: KEMAL! ✔` : `${kartShown(r.by)}: Kemal dedi, tutmadı ✘`) : (r.ok ? `${kartShown(r.by)}: KES! ${kartShown(r.holder)} yakalandı ✔` : `${kartShown(r.by)}: Kes dedi, tutmadı ✘`);
    center.append(kartEl('div', 'km-result kart-pop ' + (r.ok ? 'ok' : 'bad'), text));
  }
  const recent = (g.signals || []).filter((s) => kartNow() - s.at < 2600);
  const felt = kartFelt(g, center, ({ name }) => {
    const mine = name === myName;
    const cards = kartCards(g.hands[name], mine ? 'hand' : 'small', mine ? clickable('hand') : null, `km:${name}`);
    const team = g.teamOf[name];
    const tag = [g.ready.includes(name) ? 'Hazır' : '', name === g.partner ? 'Ortağın' : ''].filter(Boolean).join(' · ');
    const seat = kartSeat(g, name, { sub: `Takım ${team + 1} · ${g.teams[team]} puan`, tag, cards, cls: `team-${team}` });
    const sig = recent.filter((s) => s.by === name).pop();
    if (sig) seat.append(Object.assign(kartEl('span', 'km-signal', sig.e), { title: 'İşaret' }));
    return seat;
  });
  const bar = kartEl('div', 'kart-actions km-actions');
  if (seated) {
    if (g.mySecret) {
      const sec = kartEl('span', 'km-secret');
      sec.append(kartEl('div', '', `İşaretin ${g.mySecret}`), kartEl('div', '', `${kartShown(g.partner)}: ${g.mateSecret}`));
      sec.title = 'Gizli işaretler: seninkini ve ortağınınkini yalnız siz görürsünüz';
      felt.append(sec);
    }
    const sigs = kartEl('div', 'km-signals');
    for (const e of g.signalList) sigs.append(kartButton(e, 'sm ghost', () => kartAct('kemal', { type: 'signal', e })));
    bar.append(sigs);
    bar.append(kartButton(g.ready.includes(myName) ? 'Hazırsın' : 'Hazırım', g.ready.includes(myName) ? 'ghost' : '', () => kartAct('kemal', { type: 'ready' }), g.ready.includes(myName)));
    bar.append(kartButton('Kemal!', 'primary', () => kartAct('kemal', { type: 'kemal' })), kartButton('Kes!', 'danger', () => kartAct('kemal', { type: 'kes' })));
  }
  return [felt, bar];
}

const KART_DRAW = { blackjack: drawBlackjack, arasinda: drawArasinda, poker: drawPoker, pisti: drawPisti, batak: drawBatak, kemal: drawKemal };

// Durum satırı: sıra kimde, izliyor musun
function kartStatus(key, g) {
  if (!g || g.done) return '';
  if (!kartMine(g)) return 'Masayı izliyorsun.';
  if (key === 'kemal') return g.phase === 'swap' ? 'Kart değiştirmek için elinden bir kart, sonra ortadan bir kart seç.' : '';
  if (g.turn === myName) return 'Sıra sende.';
  return g.turn ? `${kartShown(g.turn)} oynuyor…` : '';
}

function renderKart(key) {
  renderLobby(key);
  const g = KART[key];
  const box = $(`kart-${key}`);
  box.hidden = !g;
  $(`${key}-end`).hidden = !g || g.done || !g.humans?.includes(myName);
  $(`${key}-status`).textContent = kartStatus(key, g);
  if (!g) return box.replaceChildren();
  const snap = kartDrawn[key] === g.id ? KartFx.snapshot(box) : null;
  KartFx.begin();
  const parts = KART_DRAW[key](g);
  // Sabit yükseklik: masa ve düğme çubuğu hep aynı boyda; kayıt ve sonuç masanın içinde açılır kutu olarak durur
  const felt = parts[0];
  felt.append(kartLog(g));
  if (g.done) felt.append(kartResult(key, g));
  box.replaceChildren(...parts);
  kartDrawn[key] = g.id;
  return KartFx.animate(box, snap, { collector: kartCollector(key, g, box), shoe: box.querySelector('.kart-shoe') });
}
const kartDrawn = {}; // oyun -> son çizilen oyunun kimliği (yeni oyunda eski kartlar canlanmasın)

// Kaybolan kartlar nereye uçar: piştide yığını alana, batakta eli alana.
function kartCollector(key, g, box) {
  let who = null;
  if (key === 'pisti' && g.flash && ['take', 'pisti', 'jpisti'].includes(g.flash.type)) who = g.flash.by;
  if (key === 'batak' && !g.trick.length && g.lastTrick) who = g.lastTrick.winner;
  const seat = who && box.querySelector(`[data-seat="${CSS.escape(who)}"]`);
  return seat ? () => seat : null;
}

// ---------- Anlar: ses, çip uçuşu, büyük yazı, konfeti ----------
// prev ile yeni durum karşılaştırılır; yalnız oyun ekranı açıkken ve aynı oyun sürerken çalışır.
function kartEvents(key, prev, g, stats = {}) {
  const box = $(`kart-${key}`);
  const felt = box.querySelector('.kart-felt');
  const seat = (name) => box.querySelector(`[data-seat="${CSS.escape(name)}"]`);
  const pot = box.querySelector('.kart-pot') || box.querySelector('.kart-area.center');
  const mine = kartMine(g);
  const fx = KartFx;
  if (stats.dealt) fx.sound('deal', stats.dealt);
  else if (stats.moved) fx.sound('slide');
  if (stats.flipped) setTimeout(() => fx.sound('flip', stats.flipped), 80);

  // Sıra bana geldi
  const myTurn = (x) => x.turn === myName || (x.legal || []).length > 0;
  if (mine && !g.done && myTurn(g) && !myTurn(prev)) fx.sound('turn');

  // Çipler: azalan koltuktan pota, artan pottan koltuğa
  if (g.chips && prev.chips) {
    let clink = 0;
    for (const p of g.players) {
      const d = (g.chips[p] ?? 0) - (prev.chips[p] ?? 0);
      if (!d) continue;
      const color = Math.abs(d) >= 500 ? 'c500' : Math.abs(d) >= 100 ? 'c100' : Math.abs(d) >= 25 ? 'c25' : 'c5';
      const n = Math.min(6, 2 + Math.floor(Math.log10(Math.abs(d))));
      if (d < 0) fx.chipFly(seat(p), pot, n, color);
      else setTimeout(() => fx.chipFly(pot, seat(p), n, color), 250);
      clink += n;
    }
    if (clink) fx.sound('chip', clink);
  }

  const big = (text, kind = 'gold', sub = '', party = false) => {
    fx.banner(felt, text, kind, sub);
    if (party) {
      fx.confetti(felt, 90);
      fx.sound('big');
    } else fx.sound(kind === 'bad' ? 'bad' : 'win');
  };

  if (key === 'blackjack') {
    const myHands = g.hands?.[myName] || [];
    const prevHands = prev.hands?.[myName] || [];
    myHands.forEach((h, k) => {
      const t = g.totals?.[myName]?.[k];
      const pt = prev.totals?.[myName]?.[k];
      if (t > 21 && !(pt > 21) && prevHands[k]) {
        big('YANDIN', 'bad', String(t));
        fx.shake(felt);
      }
    });
    if (g.phase === 'settle' && prev.phase !== 'settle') {
      if (g.dealerTotal > 21) setTimeout(() => fx.banner(felt, 'KURPİYER YANDI!', 'good'), 50);
      const net = g.results?.[myName];
      const bj = myHands.some((h) => h.result === 'bj');
      if (bj) big('BLACKJACK!', 'gold', `+${net}`, true);
      else if (net > 0) big('KAZANDIN', 'good', `+${net}`);
      else if (net < 0 && !(g.dealerTotal > 21)) big('KURPİYER ALDI', 'bad', String(net));
      else if (net === 0) fx.banner(felt, 'BERABERE', 'gold');
    }
  }

  if (key === 'arasinda' && g.outcome && !prev.outcome && g.outcome !== 'nospace' && g.outcome !== 'pass') {
    const me = g.turn === myName;
    if (g.outcome === 'win') big('ARASINDA!', 'good', `+${g.bet}`, me);
    else if (g.outcome === 'post') {
      big('DİREĞE ÇARPTI!', 'bad', `−${g.bet * 2}`);
      fx.shake(felt);
    } else big('DIŞARIDA', 'bad', `−${g.bet}`);
  }

  if (key === 'poker') {
    if (g.winners && !prev.winners) {
      const w = g.winners.find((x) => x.name === myName);
      if (w) big('KAZANDIN!', 'gold', `+${w.amount}${w.hand ? ` · ${w.hand}` : ''}`, true);
      else {
        const top = g.winners[0];
        fx.banner(felt, `${kartShown(top.name)} +${top.amount}`, 'gold', top.hand || '');
        fx.sound('win');
      }
    }
    for (const p of g.players) {
      if (/^All-in/.test(g.last?.[p] || '') && !/^All-in/.test(prev.last?.[p] || '')) {
        fx.banner(felt, 'ALL-IN!', 'bad', kartShown(p));
        fx.shake(felt);
        fx.sound('chip', 5);
      }
    }
  }

  if (key === 'pisti' && g.flash && (g.flash.type === 'pisti' || g.flash.type === 'jpisti') && JSON.stringify(g.flash) !== JSON.stringify(prev.flash)) {
    big(g.flash.type === 'jpisti' ? 'PİŞTİ! ×2' : 'PİŞTİ!', 'gold', kartShown(g.flash.by), g.flash.by === myName);
    fx.shake(felt);
  }

  if (key === 'batak') {
    if (g.lastTrick && !g.trick.length && prev.trick?.length) {
      if (g.lastTrick.winner === myName) fx.sound('win');
    }
    if (g.phase === 'tally' && prev.phase !== 'tally' && g.bidder) {
      const made = g.tricks[g.bidder] >= g.high;
      big(made ? 'TUTTU!' : 'BATTI!', made ? 'good' : 'bad', `${kartShown(g.bidder)} · ${g.tricks[g.bidder]}/${g.high}`, made && g.bidder === myName);
      if (!made) fx.shake(felt);
    }
    if (g.trump && !prev.trump) fx.banner(felt, `KOZ ${KART_SUIT[g.trump]}`, g.trump === 'H' || g.trump === 'D' ? 'bad' : 'gold', KART_SUIT_NAME[g.trump]);
  }

  if (key === 'kemal') {
    if (g.result && !prev.result) {
      const r = g.result;
      const ours = mine && r.team === g.teamOf[myName];
      big(r.kind === 'kemal' ? 'KEMAL!' : 'KES!', r.ok ? 'good' : 'bad', r.ok ? `${kartShown(r.holder)} dörtlüyü topladı` : 'Tutmadı', ours);
      if (!r.ok) fx.shake(felt);
    }
    const fresh = (g.signals || []).filter((x) => !(prev.signals || []).some((y) => y.at === x.at && y.by === x.by));
    if (fresh.length) fx.sound('flip');
  }

  // Oyun bitti
  if (g.done && !prev.done) {
    const top = g.standings?.[0];
    const won = top && (top.name === myName || top.name.split(' & ').includes(myName));
    if (won) {
      fx.confetti(box.querySelector('.kart-result') || felt, 160);
      fx.sound('big');
    }
  }
}

function setKart(all) {
  for (const key of KART_KEYS) applyKart(key, all ? all[key] : null);
}
function applyKart(key, game) {
  if (game?.now) kartClock = game.now - Date.now();
  if (game?.id !== KART[key]?.id) {
    kartSel[key] = null;
    kartRaise.slot = null;
  }
  const prev = KART[key];
  KART[key] = game || null;
  if (key === 'kemal' && kartSel.kemal && game?.phase !== 'swap') kartSel.kemal = null;
  const stats = renderKart(key);
  if (prev && game && prev.id === game.id && !$(`game-${key}`).hidden) kartEvents(key, prev, game, stats);
}
socket.on('kart', ({ key, game } = {}) => KART_KEYS.includes(key) && applyKart(key, game));

// Kemal'de işaretler 2,6 sn sonra sönsün
setInterval(() => {
  const g = KART.kemal;
  if (g && !g.done && !$('game-kemal').hidden && (g.signals || []).some((s) => kartNow() - s.at < 4000)) renderKart('kemal');
}, 1000);

for (const key of KART_KEYS) {
  confirmButton($(`${key}-end`), 'Emin misin? Tekrar bas', () => socket.emit('kart:end', { key }));
  const spec = KART_OPTS[key];
  LOBBY[key] = {
    // Biten oyunun sonucu masada dururken lobi gizli kalır (sayfa oynamasın); Kapat'a basınca lobi gelir.
    title: KART_TITLE[key], tab: key, running: () => Boolean(KART[key]), last: () => KART[key],
    hint: KART_HINT[key],
    opts: spec && ((lobby, host) => {
      const row = document.createElement('div');
      row.className = 'lobby-opts';
      row.append(kelimeSmall(spec.label));
      for (const v of spec.values) {
        const b = lobbyButton(String(v), 'sm' + (lobby.opts[spec.key] === v ? ' active' : ''), () => lobbyEmit('lobby:opts', key, { [spec.key]: v }));
        b.disabled = !host;
        row.append(b);
      }
      return [row];
    }),
  };
}
window.setKart = setKart;
window.renderKart = renderKart;
