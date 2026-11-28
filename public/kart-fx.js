'use strict';

// ---------- Kağıt oyunları: kart, çip, animasyon, efekt ve ses ----------
// public/kart.js'ten önce yüklenir. Masa her güncellemede baştan çizilir; canlılık şöyle sağlanır:
//   snapshot(kutu) çizimden önce her kartın yerini (anahtarıyla) kaydeder, animate(kutu, anlık) çizimden sonra
//   - yeri değişen kartı eski yerinden yenisine kaydırır (FLIP),
//   - yeni gelen kartı desteden (ya da data-from ile oynayanın koltuğundan) uçurur, açıksa dönerek açar,
//   - aynı yuvada kapalıyken açılan kartı 3D çevirir (kurpiyerin kapalı kartı, pokerde eller açılınca),
//   - kaybolan kartı yığını alanın koltuğuna (collector) uçurur, yoksa masadan süpürür.
// Kart anahtarı: açık kart "c:<rank><suit>:<kaçıncı>", kapalı kart "d:<yuva>". Yuva (slot) verilmeyen kapalı kart canlanmaz.
// Sesler cihazda Web Audio ile üretilir (dosya yok), yalnız bu tarayıcıda çalar; app.js'teki audioCtx/sfxBus kullanılır.

const KartFx = (() => {
  const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const SUIT_NAME = { S: 'Maça', H: 'Kupa', D: 'Karo', C: 'Sinek' };
  const RANK = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  let occ = new Map(); // bu çizimde aynı kartın kaçıncısı (blackjack 6 deste)

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  function begin() {
    occ = new Map();
  }

  // Kart: c null ise kapalı. slot: masadaki yeri (çevirme ve kapalı kart takibi için). from: oynayanın adı.
  function card(c, cls = '', slot = null, from = null) {
    const box = el('div', 'kc ' + cls);
    const inner = el('div', 'kc-in');
    const back = el('div', 'kc-face kc-back');
    back.append(el('span', 'kc-emblem', '♠'));
    const front = el('div', 'kc-face kc-front');
    inner.append(front, back);
    box.append(inner);
    if (slot) box.dataset.slot = slot;
    if (from) box.dataset.from = from;
    if (!c) {
      box.classList.add('down');
      if (slot) box.dataset.k = `d:${slot}`;
      return box;
    }
    const id = `${c.r}${c.s}`;
    const n = (occ.get(id) || 0) + 1;
    occ.set(id, n);
    box.dataset.k = `c:${id}:${n}`;
    const red = c.s === 'H' || c.s === 'D';
    box.classList.add(red ? 'red' : 'black');
    if (c.r >= 11 && c.r <= 13) box.classList.add('face');
    const rank = RANK[c.r] || String(c.r);
    box.setAttribute('translate', 'no');
    const center = c.r >= 11 && c.r <= 13 ? el('span', 'kc-court', rank) : el('span', 'kc-pip', SUIT[c.s]);
    if (c.r >= 11 && c.r <= 13) center.append(el('small', '', SUIT[c.s]));
    front.append(el('span', 'kc-corner', `${rank}${SUIT[c.s]}`), center, el('span', 'kc-corner br', `${rank}${SUIT[c.s]}`));
    box.title = `${SUIT_NAME[c.s]} ${rank}`;
    return box;
  }

  // Çip yığını: tutarı renklere böler (500 mor, 100 siyah, 25 yeşil, 5 kırmızı, 1 beyaz), en çok 8 disk.
  const DENOMS = [[500, 'c500'], [100, 'c100'], [25, 'c25'], [5, 'c5'], [1, 'c1']];
  function chips(amount, cls = '') {
    const wrap = el('span', 'chips ' + cls);
    let left = Math.max(0, Math.floor(amount || 0));
    const discs = [];
    for (const [v, c] of DENOMS) {
      while (left >= v && discs.length < 8) {
        discs.push(c);
        left -= v;
      }
    }
    discs.forEach((c, i) => {
      const d = el('i', 'chip ' + c);
      d.style.setProperty('--i', i);
      wrap.append(d);
    });
    wrap.style.setProperty('--n', discs.length);
    return wrap;
  }

  const rectOf = (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, left: r.left, top: r.top };
  };
  const visible = (box) => box && !box.hidden && box.offsetParent !== null && box.getClientRects().length > 0;

  function snapshot(box) {
    const snap = { on: visible(box), keys: new Map(), slots: new Map() };
    if (!snap.on) return snap;
    for (const e of box.querySelectorAll('.kc[data-k]')) {
      const r = rectOf(e);
      if (!r.w) continue;
      const info = { r, down: e.classList.contains('down'), node: e.cloneNode(true) };
      snap.keys.set(e.dataset.k, info);
      if (e.dataset.slot) snap.slots.set(e.dataset.slot, info);
    }
    return snap;
  }

  function fly(e, from, delay, { flip = false, spin = -18, dur = 520 } = {}) {
    const to = rectOf(e);
    const dx = from.x - to.x;
    const dy = from.y - to.y;
    e.animate([
      { translate: `${dx}px ${dy}px`, rotate: `${spin}deg`, scale: from.w && to.w ? Math.max(0.4, from.w / to.w) : 0.8, opacity: 0.4 },
      { translate: '0 0', rotate: '0deg', scale: 1, opacity: 1 },
    ], { duration: dur, delay, easing: 'cubic-bezier(.2,.85,.25,1)', fill: 'backwards' });
    if (flip) e.querySelector('.kc-in')?.animate([{ transform: 'rotateY(180deg)' }, { transform: 'rotateY(180deg)', offset: 0.35 }, { transform: 'rotateY(0deg)' }], { duration: dur + 160, delay, easing: 'ease-out', fill: 'backwards' });
  }

  // collector: (anahtar) => hedef öğe; kaybolan açık kartlar oraya uçar.
  // per: dağıtımda iki kart arası (ms). Yeni kartlar elde sırasına göre (herkese birinci kart, sonra ikinci…) dağılır.
  function animate(box, snap, { collector = null, shoe = null, per = 75 } = {}) {
    if (!snap?.on || calm() || !visible(box)) return { dealt: 0, flipped: 0, moved: 0, per };
    const stats = { dealt: 0, flipped: 0, moved: 0, per };
    const shoeR = shoe ? rectOf(shoe) : null;
    const seen = new Set();
    let stagger = 0;
    const all = [...box.querySelectorAll('.kc[data-k]')];
    const order = (e) => Number(e.style.getPropertyValue('--i')) || 0;
    const sorted = all.map((e, n) => [e, n]).sort((a, b) => order(a[0]) - order(b[0]) || a[1] - b[1]).map(([e]) => e);
    for (const e of sorted) {
      const k = e.dataset.k;
      seen.add(k);
      const was = snap.keys.get(k);
      const to = rectOf(e);
      if (was) {
        const dx = was.r.x - to.x;
        const dy = was.r.y - to.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) {
          e.animate([{ translate: `${dx}px ${dy}px`, scale: was.r.w / (to.w || 1) }, { translate: '0 0', scale: 1 }], { duration: 480, easing: 'cubic-bezier(.2,.85,.25,1)' });
          stats.moved++;
        }
        continue;
      }
      const slot = e.dataset.slot;
      const prevSlot = slot ? snap.slots.get(slot) : null;
      if (prevSlot && prevSlot.down && !e.classList.contains('down')) {
        // Aynı yerde kapalıyken açıldı: 3D çevir
        e.querySelector('.kc-in')?.animate([{ transform: 'rotateY(180deg)' }, { transform: 'rotateY(0deg)' }], { duration: 560, delay: stagger * 90, easing: 'cubic-bezier(.3,1.3,.5,1)', fill: 'backwards' });
        stagger++;
        stats.flipped++;
        continue;
      }
      if (prevSlot && !prevSlot.down) continue; // yuvada başka açık kart vardı (yeniden sıralama); sessiz geç
      // Yeni kart: oynayanın koltuğundan ya da desteden
      const seat = e.dataset.from ? box.querySelector(`[data-seat="${CSS.escape(e.dataset.from)}"]`) : null;
      const from = seat ? rectOf(seat) : shoeR;
      if (!from) continue;
      fly(e, from, stagger * per, { flip: !e.classList.contains('down'), spin: seat ? 10 : -24, dur: 620 });
      stagger++;
      stats.dealt++;
    }
    // Kaybolan açık kartlar: alanın koltuğuna ya da masadan aşağı süzülür
    let gone = 0;
    for (const [k, info] of snap.keys) {
      if (seen.has(k) || info.down || gone > 24) continue;
      const target = collector?.(k);
      ghost(info, target ? rectOf(target) : null, gone++ * 35);
    }
    return stats;
  }

  function ghost(info, to, delay) {
    const g = info.node;
    g.classList.add('kc-ghost');
    Object.assign(g.style, { left: `${info.r.left}px`, top: `${info.r.top}px`, width: `${info.r.w}px`, height: `${info.r.h}px` });
    document.body.append(g);
    const end = to
      ? { translate: `${to.x - info.r.x}px ${to.y - info.r.y}px`, scale: 0.35, rotate: '25deg', opacity: 0 }
      : { translate: '0 40px', scale: 0.85, rotate: '-8deg', opacity: 0 };
    const a = g.animate([{ translate: '0 0', scale: 1, rotate: '0deg', opacity: 1 }, end], { duration: to ? 620 : 420, delay, easing: 'cubic-bezier(.5,0,.3,1)', fill: 'both' });
    a.onfinish = a.oncancel = () => g.remove();
  }

  // Çip uçuşu: from → to, n disk
  function chipFly(fromEl, toEl, n = 3, color = 'c25') {
    if (!fromEl || !toEl || calm()) return;
    const a = rectOf(fromEl);
    const b = rectOf(toEl);
    for (let i = 0; i < Math.min(n, 6); i++) {
      const d = el('i', `chip chip-fly ${color}`);
      Object.assign(d.style, { left: `${a.x - 11}px`, top: `${a.y - 11}px` });
      document.body.append(d);
      const mx = (b.x - a.x) / 2 + (Math.random() - 0.5) * 40;
      const my = (b.y - a.y) / 2 - 50 - Math.random() * 30;
      const anim = d.animate([
        { translate: '0 0', scale: 0.7, opacity: 0 },
        { translate: `${mx}px ${my}px`, scale: 1.1, opacity: 1, offset: 0.45 },
        { translate: `${b.x - a.x}px ${b.y - a.y}px`, scale: 0.9, opacity: 0.9 },
      ], { duration: 640, delay: i * 70, easing: 'cubic-bezier(.4,0,.3,1)', fill: 'both' });
      anim.onfinish = anim.oncancel = () => d.remove();
    }
  }

  // Ortada büyük yazı (BLACKJACK!, PİŞTİ!, KEMAL!…). kind: gold | good | bad
  function banner(felt, text, kind = 'gold', sub = '') {
    if (!felt) return;
    felt.querySelector('.kart-banner')?.remove();
    const b = el('div', `kart-banner ${kind}`);
    b.append(el('strong', '', text));
    if (sub) b.append(el('span', '', sub));
    felt.append(b);
    setTimeout(() => b.remove(), calm() ? 1600 : 2000);
  }

  function shake(e) {
    if (!e || calm()) return;
    e.animate([{ translate: '0 0' }, { translate: '-7px 2px' }, { translate: '6px -2px' }, { translate: '-4px 1px' }, { translate: '3px 0' }, { translate: '0 0' }], { duration: 380, easing: 'ease-out' });
  }

  const CONFETTI = ['#FFD23F', '#FF6B7A', '#4ADE80', '#7AA2FF', '#F472B6', '#FFFFFF'];
  function confetti(e, n = 70) {
    if (!e || calm()) return;
    const r = rectOf(e);
    for (let i = 0; i < n; i++) {
      const p = el('i', 'kart-confetti');
      p.style.background = CONFETTI[i % CONFETTI.length];
      Object.assign(p.style, { left: `${r.x}px`, top: `${r.y}px` });
      if (i % 3 === 0) p.style.borderRadius = '50%';
      document.body.append(p);
      const ang = Math.random() * Math.PI * 2;
      const pow = 120 + Math.random() * 260;
      const dx = Math.cos(ang) * pow;
      const dy = Math.sin(ang) * pow * 0.6 - 160;
      const a = p.animate([
        { translate: '0 0', rotate: '0deg', opacity: 1 },
        { translate: `${dx}px ${dy}px`, rotate: `${Math.random() * 540}deg`, opacity: 1, offset: 0.45 },
        { translate: `${dx * 1.2}px ${dy + 340}px`, rotate: `${Math.random() * 900}deg`, opacity: 0 },
      ], { duration: 1400 + Math.random() * 700, easing: 'cubic-bezier(.2,.6,.4,1)', fill: 'both' });
      a.onfinish = a.oncancel = () => p.remove();
    }
  }

  // ---------- Ses ----------
  let lastSound = {};
  function out() {
    try {
      // app.js: audioCtx odaya girerken açılır, sfxBus efekt ses düzeyidir
      if (typeof audioCtx === 'undefined' || !audioCtx || audioCtx.state !== 'running') return null;
      return { ctx: audioCtx, bus: (typeof sfxBus !== 'undefined' && sfxBus) || audioCtx.destination };
    } catch {
      return null;
    }
  }
  function noise(ctx, dur) {
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    return src;
  }
  function tone(o, freq, t, dur, peak, type = 'sine') {
    const osc = o.ctx.createOscillator();
    const g = o.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(o.bus);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
  function sound(kind, count = 1, gap = 75) {
    const o = out();
    if (!o) return;
    const now = performance.now();
    if (now - (lastSound[kind] || 0) < 60) return;
    lastSound[kind] = now;
    const t0 = o.ctx.currentTime + 0.01;
    if (kind === 'deal' || kind === 'flip' || kind === 'slide') {
      for (let i = 0; i < Math.min(count, 60); i++) {
        const t = t0 + (i * gap) / 1000 + 0.45;
        const src = noise(o.ctx, kind === 'flip' ? 0.06 : 0.09);
        const hp = o.ctx.createBiquadFilter();
        hp.type = 'bandpass';
        hp.frequency.value = kind === 'flip' ? 3200 : 2200;
        hp.Q.value = 0.9;
        const g = o.ctx.createGain();
        g.gain.setValueAtTime(kind === 'slide' ? 0.12 : 0.22, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
        src.connect(hp).connect(g).connect(o.bus);
        src.start(t);
      }
    } else if (kind === 'chip') {
      for (let i = 0; i < Math.min(count, 5); i++) {
        const t = t0 + i * 0.06 + Math.random() * 0.02;
        tone(o, 2600 + Math.random() * 900, t, 0.07, 0.06, 'triangle');
        tone(o, 4100 + Math.random() * 600, t + 0.01, 0.05, 0.03);
      }
    } else if (kind === 'win') {
      [523, 659, 784, 1047].forEach((f, i) => tone(o, f, t0 + i * 0.09, 0.35, 0.09, 'triangle'));
    } else if (kind === 'big') {
      [392, 523, 659, 784, 1047, 1319].forEach((f, i) => tone(o, f, t0 + i * 0.07, 0.5, 0.1, 'triangle'));
    } else if (kind === 'bad') {
      tone(o, 220, t0, 0.35, 0.1, 'sawtooth');
      tone(o, 165, t0 + 0.14, 0.45, 0.08, 'sawtooth');
    } else if (kind === 'turn') {
      tone(o, 880, t0, 0.12, 0.05);
      tone(o, 1320, t0 + 0.08, 0.16, 0.05);
    }
  }

  return { card, chips, snapshot, animate, chipFly, banner, shake, confetti, sound, begin, rectOf, calm };
})();
