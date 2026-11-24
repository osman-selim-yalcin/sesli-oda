'use strict';

// Yedi Kapı arayüzü: ortada 3D zindan kapısı (menteşesinden açılır, arkasından karşılaşma kartı çıkar), solda
// kahraman ve kuşanılan eşyalar, sağda seviye merdiveni, altta çanta. Kurallar yedikapi-kurallar.js.
(() => {
  const K = window.KutuOyun, R = window.YediKapiRules;
  const { el, art, button } = K;
  const SLOTS = ['Başlık', 'Zırh', 'Silah'];
  const SLOT_ICONS = ['helm', 'armor', 'mace'];
  const ITEM_ICONS = ['helm', 'crown', 'armor', 'cloak', 'spoon', 'mace'];
  const GOAL = 10;

  function encounter(g, fresh) {
    const card = el('div', 'yk-card');
    const ev = g.event?.type;
    const face = (name, title, text, cls) => {
      card.className = 'yk-card ' + cls + (fresh ? ' flip' : '');
      card.append(art(name, 'yk-card-art'), el('strong', '', title));
      if (text) card.append(el('small', '', text));
    };
    if (g.done) face('crown', 'Zafer!', g.log, 'gold');
    else if (g.monster) {
      face('monster', g.monster.name, 'Kapıyı tutuyor', 'monster');
      card.append(el('b', 'yk-strength', String(g.monster.strength)));
    } else if (ev === 'treasure') face('bag', 'Hazine odası', 'Çantana bir eşya girdi', 'gold');
    else if (ev === 'curse') face('eye', 'Lanetli ayna', 'Bir seviye kaybettin', 'curse');
    else if (ev === 'win') face('crown', 'Canavar yenildi', 'Seviye atladın, ganimet çantada', 'gold');
    else if (ev === 'flee') face('door', 'Kaçtın', 'Zar ' + g.event.roll + ' · 5 veya 6 kurtarır', 'calm');
    else if (ev === 'caught') face('monster', 'Yakalandın', 'Zar ' + g.event.roll + ' · bir seviye kaybettin', 'curse');
    else face('potion', 'Kamp', 'Eşyalarını düzenle, sırayı bitir', 'calm');
    if (!g.done && (ev === 'flee' || ev === 'caught')) card.append(K.die(g.event.roll, fresh));
    return card;
  }

  function draw(ctx) {
    const { g, me, mine, acts, submit, body, fresh, prev, state, rerender } = ctx;
    const hotseat = ctx.local && !ctx.robot;
    if (state.seat !== me) { state.bagOpen = !hotseat; state.seat = me; }
    const lead = g.phase === 'help' ? g.leader : g.turn;
    const hero = g.heroes[lead];
    const open = g.phase !== 'door' || g.done;
    const layout = el('div', 'yk-layout');

    // ---- Sahne ----
    const stage = el('section', 'yk-stage');
    const scene = el('div', 'yk-scene');
    const arch = el('div', 'yk-arch');
    const behind = el('div', 'yk-behind');
    if (open) behind.append(encounter(g, fresh && Boolean(g.event) && g.event.type !== 'potion'));
    const door = el('div', 'yk-door' + (open ? ' open' : ''));
    if (fresh && prev) {
      const was = prev.phase !== 'door' || prev.done;
      if (was !== open) door.classList.add(open ? 'opening' : 'closing');
    }
    const leaf = el('div', 'yk-leaf');
    leaf.append(el('i', 'yk-hinge a'), el('i', 'yk-hinge b'), el('i', 'yk-knocker'), el('b', 'yk-plaque', 'Sv. ' + hero.level));
    door.append(leaf);
    arch.append(behind, door, el('i', 'yk-torch l'), el('i', 'yk-torch r'));
    scene.append(arch);
    stage.append(scene);

    if (g.monster && !g.done) {
      const mine2 = R.power(hero) + g.boost, need = g.monster.strength;
      const meter = el('div', 'yk-meter' + (mine2 > need ? ' win' : ''));
      const side = (cls, name, value, label) => {
        const s = el('div', 'yk-side ' + cls);
        s.append(art(name), el('b', '', String(value)), el('small', '', label));
        return s;
      };
      const bar = el('div', 'yk-bar');
      const fill = el('i');
      fill.style.width = Math.round(100 * mine2 / (mine2 + need)) + '%';
      bar.append(fill);
      meter.append(side('hero', 'mace', mine2, g.players[lead] + (g.boost ? ` (+${g.boost} destek)` : '')), bar, side('foe', 'monster', need, g.monster.name),
        el('p', 'yk-verdict', mine2 > need ? 'Güç yetiyor: savaşırsan kazanırsın.' : `${need - mine2 + 1} güç daha gerekli. İksir iç, yardım iste ya da kaç.`));
      if (fresh && g.event?.type === 'potion') meter.classList.add('boost');
      stage.append(meter);
    }
    const log = el('p', 'yk-log' + (mine ? ' mine' : ''), g.log);
    log.setAttribute('aria-live', 'polite');
    stage.append(log);
    const actions = el('div', 'yk-actions');
    const labels = { door: ['Kapıyı aç', 'door', 'primary'], fight: ['Savaş', 'mace', 'primary'], potion: ['İksir iç (+3)', 'potion', ''], flee: ['Kaçmayı dene', 'dice', ''] };
    for (const a of acts) if (labels[a]) actions.append(button(labels[a][0], () => submit(a), { icon: labels[a][1], cls: labels[a][2] }));
    for (const a of acts.filter(a => a.startsWith('help:'))) actions.append(button(g.players[Number(a.slice(5))] + ' yardım etsin', () => submit(a)));
    if (acts.includes('accept')) actions.append(button('Savaşa katıl', () => submit('accept'), { cls: 'primary' }), button('Reddet', () => submit('decline')));
    if (acts.includes('end')) actions.append(button('Sırayı bitir', () => submit('end'), { cls: 'primary' }));
    if (!actions.children.length && !g.done) actions.append(el('span', 'yk-wait', `${g.players[g.turn]} oynuyor…`));
    stage.append(actions);

    // ---- Kahraman ----
    const seat = me < 0 ? lead : me, own = g.heroes[seat];
    const sheet = el('aside', 'yk-panel yk-hero');
    sheet.style.setProperty('--c', K.colors[seat]);
    sheet.append(el('h4', '', me < 0 || hotseat ? g.players[seat] : 'Kahramanım'));
    const stats = el('div', 'yk-stats');
    for (const [name, value, label] of [['crown', own.level, 'Seviye'], ['mace', R.power(own), 'Güç'], ['potion', own.potions, 'İksir']]) {
      const s = el('div', 'yk-stat');
      s.append(art(name), el('b', '', String(value)), el('small', '', label));
      stats.append(s);
    }
    sheet.append(stats);
    const rack = el('div', 'yk-rack');
    SLOTS.forEach((label, slot) => {
      const item = own.items[own.gear[slot]];
      const tile = el('div', 'yk-slot' + (item ? ' worn' : ''));
      tile.append(art(item ? ITEM_ICONS[item.type] : SLOT_ICONS[slot]), el('small', '', label), el('b', '', item ? `${R.gear[item.type][0]} +${R.gear[item.type][2]}` : 'Boş'));
      rack.append(tile);
    });
    sheet.append(rack, el('p', 'yk-note', 'Güç = seviye + kuşandığın eşyalar. Canavarı yenmek için gücün onunkini geçmeli.'));

    // ---- Seviye merdiveni ----
    const ladder = el('aside', 'yk-panel yk-ladder');
    ladder.append(el('h4', '', 'Merdiven'));
    const rungs = el('ol', 'yk-rungs');
    for (let level = GOAL; level >= 1; level--) {
      const rung = el('li', 'yk-rung' + (level === GOAL ? ' goal' : ''));
      rung.append(el('span', 'yk-rung-no', level === GOAL ? '10 ★' : String(level)));
      g.heroes.forEach((h, i) => {
        if (h.level !== level) return;
        const pawn = el('span', 'yk-pawn' + (prev && prev.heroes[i].level !== h.level ? ' hop' : '') + (!g.done && i === g.turn ? ' turn' : ''));
        pawn.style.setProperty('--c', K.colors[i]);
        pawn.title = `${g.players[i]} · seviye ${h.level} · güç ${R.power(h)}`;
        pawn.textContent = g.players[i].slice(0, 1).toLocaleUpperCase('tr-TR');
        rung.append(pawn);
      });
      rungs.append(rung);
    }
    ladder.append(rungs);
    const shownItems = el('div', 'yk-table');
    for (const [i, h] of g.heroes.entries()) for (const [index, item] of h.items.entries()) {
      if (!item.shown) continue;
      const entry = el('span', 'yk-shown');
      entry.style.setProperty('--c', K.colors[i]);
      entry.title = `${g.players[i]} · ${R.gear[item.type][0]}${h.gear.includes(index) ? ' · kuşanıldı' : ''}`;
      entry.append(art(ITEM_ICONS[item.type]), el('small', '', g.players[i]));
      shownItems.append(entry);
    }
    ladder.append(el('h4', '', 'Masadaki eşyalar'), shownItems.children.length ? shownItems : el('p', 'yk-note', 'Henüz kimse eşya göstermedi.'));

    layout.append(sheet, stage, ladder);
    body.append(layout);

    // ---- Çanta ----
    if (me >= 0) {
      const mineHero = g.heroes[me];
      const bag = el('section', 'yk-panel yk-bag');
      const head = el('div', 'yk-bag-head');
      head.append(el('h4', '', `Çantam · ${mineHero.items.length} eşya`));
      if (hotseat) {
        const toggle = button(state.bagOpen ? 'Çantayı kapat' : 'Çantamı aç', () => { state.bagOpen = !state.bagOpen; rerender(); }, { icon: 'bag' });
        toggle.setAttribute('aria-expanded', String(state.bagOpen));
        head.append(toggle);
      }
      const canDress = g.turn === me && ['door', 'camp'].includes(g.phase) && !g.done;
      head.append(el('small', 'yk-note', g.done ? 'Maç tamamlandı.' : canDress ? 'Şimdi kuşanabilir, çıkarabilir ya da eşyayı iksire çevirebilirsin.' : 'Kapı önünde ya da kampta, sıra sendeyken kuşanabilirsin.'));
      bag.append(head);
      if (state.bagOpen) {
        const choices = new Set(R.inventoryActions(g, me)), grid = el('div', 'yk-loot-grid');
        for (const [index, item] of mineHero.items.entries()) {
          const [name, slot, bonus] = R.gear[item.type], worn = mineHero.gear.includes(index);
          const card = el('article', 'yk-loot' + (worn ? ' worn' : ''));
          const pic = el('div', 'yk-loot-art');
          pic.append(art(ITEM_ICONS[item.type]), el('b', '', '+' + bonus));
          const text = el('div', 'yk-loot-text');
          text.append(el('small', '', SLOTS[slot] + ' · ' + (worn ? 'Kuşanıldı' : 'Çantada')), el('strong', '', name));
          const controls = el('div', 'yk-loot-controls');
          const control = (label, cmd, opts) => {
            const action = cmd + ':' + index, b = button(label, () => submit(action), opts);
            b.disabled = !choices.has(action);
            return b;
          };
          const visible = control(item.shown ? 'Gizle' : 'Göster', item.shown ? 'hide' : 'show', { icon: 'eye' });
          visible.title = item.shown ? 'Masadan gizle' : 'Masadaki herkese göster';
          visible.setAttribute('aria-pressed', String(item.shown));
          controls.append(control(worn ? 'Çıkar' : 'Kuşan', worn ? 'remove' : 'equip', { cls: worn ? '' : 'primary' }), visible);
          if (!worn && choices.has('exchange:' + index)) {
            controls.append(button('İksire çevir', () => { if (window.confirm(name + ' bir iksire çevrilsin mi?')) submit('exchange:' + index); }, { icon: 'potion', cls: 'yk-exchange' }));
          }
          card.append(pic, text, controls);
          grid.append(card);
        }
        if (!mineHero.items.length) grid.append(el('p', 'yk-note', 'Çantan boş. Kapı açarak ganimet bulabilirsin.'));
        bag.append(grid);
      }
      body.append(bag);
    }
  }

  K.register('yedikapi', {
    title: 'Yedi Kapı', engine: R, icon: 'mace', pace: 900,
    tagline: 'Kapıyı aç, ganimeti topla ve 10. seviyeye ulaş.',
    hint: '2–4 oyuncuyla veya oda botuyla oynanır.',
    seat: (g, i) => ({ text: `Seviye ${g.heroes[i].level} · güç ${R.power(g.heroes[i])}`, value: g.heroes[i].level, max: GOAL }),
    rules: `
      <p><strong>Amaç:</strong> savaş kazanarak 10. seviyeye ilk çıkan kazanır.</p>
      <p><strong>Kapı:</strong> sıran gelince kapıyı aç. Arkasından canavar, hazine ya da lanet çıkar. Hazine çantana bir eşya koyar, lanet bir seviye düşürür.</p>
      <p><strong>Savaş:</strong> gücün (seviye + kuşandığın eşyalar) canavarın gücünü geçerse kazanırsın: bir seviye ve bir eşya alırsın. İksir o savaşta +3 verir. Bir oyuncudan yardım isteyebilirsin; kabul ederse gücü seninkine eklenir ve zaferde o da eşya alır.</p>
      <p><strong>Kaçış:</strong> gücün yetmiyorsa kaçmayı dene. Zar 5 ya da 6 gelirse kurtulursun, yoksa bir seviye kaybedersin.</p>
      <p><strong>Çanta:</strong> kapı önünde ya da kampta, sıra sendeyken eşya kuşanabilir, çıkarabilir ya da çantadaki bir eşyayı iksire çevirebilirsin. Her yuvaya (başlık, zırh, silah) tek eşya girer. Eşyalarını diğer oyunculara göstermek ya da gizlemek sana kalmış.</p>`,
    draw,
  });
})();
