'use strict';

// Ses efektleri: gerçek kayıtlar (public/sfx, odaya girişte bir kez iner) ve
// kaydı olmayanlar için Web Audio ile cihazda üretilen sesler.
// Efekt çalınca ağdan sadece efektin adı gider (birkaç byte).

// Kaydı olan efektler; kaynaklar ve lisanslar public/sfx/KAYNAKLAR.txt dosyasında.
const SFX_FILES = ['clap', 'ding', 'sad', 'tada', 'boom'];

const SFX_LIST = [
  { id: 'clap', emoji: '👏', label: 'Alkış' },
  { id: 'rimshot', emoji: '🥁', label: 'Ba dum tss' },
  { id: 'ding', emoji: '🔔', label: 'Ding' },
  { id: 'sad', emoji: '🎺', label: 'Hüzün' },
  { id: 'tada', emoji: '🎉', label: 'Tada' },
  { id: 'boom', emoji: '💥', label: 'Bum' },
];

const Sfx = (() => {
  let noise = null;
  const samples = new Map(); // id -> AudioBuffer

  function noiseBuffer(ctx) {
    if (noise) return noise;
    noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return noise;
  }

  function envelope(ctx, t, { peak, attack = 0.005, hold = 0, decay = 0.3 }) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.setValueAtTime(peak, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + decay);
    return g;
  }

  function tone(ctx, out, t, opts) {
    const { type = 'sine', freq, to, attack = 0.005, hold = 0, decay = 0.3, lowpass } = opts;
    const end = t + attack + hold + decay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, end);

    let node = osc;
    if (lowpass) {
      node = ctx.createBiquadFilter();
      node.type = 'lowpass';
      node.frequency.value = lowpass;
      osc.connect(node);
    }
    node.connect(envelope(ctx, t, opts)).connect(out);
    osc.start(t);
    osc.stop(end + 0.05);
    return osc;
  }

  function noiseBurst(ctx, out, t, opts) {
    const { filter = 'bandpass', freq = 1000, q = 1, attack = 0.002, decay = 0.1 } = opts;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.value = freq;
    f.Q.value = q;
    src.connect(f).connect(envelope(ctx, t, opts)).connect(out);
    src.start(t, Math.random());
    src.stop(t + attack + decay + 0.05);
  }

  const effects = {
    clap(ctx, out, t) {
      for (let i = 0; i < 45; i++) {
        noiseBurst(ctx, out, t + Math.random() * 1.6, {
          freq: 1100 + Math.random() * 900,
          peak: 0.14 + Math.random() * 0.26,
          decay: 0.05 + Math.random() * 0.04,
        });
      }
    },
    rimshot(ctx, out, t) {
      tone(ctx, out, t, { freq: 190, to: 90, peak: 0.7, decay: 0.16 });
      tone(ctx, out, t + 0.17, { freq: 150, to: 70, peak: 0.7, decay: 0.2 });
      noiseBurst(ctx, out, t + 0.42, { filter: 'highpass', freq: 6500, peak: 0.35, decay: 0.9 });
    },
    ding(ctx, out, t) {
      tone(ctx, out, t, { freq: 1320, peak: 0.35, decay: 1.6 });
      tone(ctx, out, t, { freq: 2640, peak: 0.1, decay: 0.8 });
      tone(ctx, out, t, { freq: 3960, peak: 0.04, decay: 0.4 });
    },
    sad(ctx, out, t) {
      const notes = [392, 370, 349, 330];
      notes.forEach((freq, i) => {
        const last = i === notes.length - 1;
        const osc = tone(ctx, out, t + i * 0.4, {
          type: 'sawtooth', freq, peak: 0.18, attack: 0.03, hold: last ? 0.9 : 0.3, decay: 0.12, lowpass: 1100,
        });
        if (last) {
          // Son notada titreme (vibrato)
          const lfo = ctx.createOscillator();
          const depth = ctx.createGain();
          lfo.frequency.value = 5.5;
          depth.gain.value = 7;
          lfo.connect(depth).connect(osc.frequency);
          lfo.start(t + i * 0.4);
          lfo.stop(t + i * 0.4 + 1.1);
        }
      });
    },
    tada(ctx, out, t) {
      [523, 659, 784].forEach((freq, i) => {
        tone(ctx, out, t + i * 0.08, { type: 'triangle', freq, peak: 0.18, decay: 0.12 });
      });
      for (const freq of [523, 659, 784, 1047]) {
        tone(ctx, out, t + 0.3, { type: 'triangle', freq, peak: 0.13, hold: 0.45, decay: 0.6 });
      }
    },
    boom(ctx, out, t) {
      tone(ctx, out, t, { freq: 110, to: 32, peak: 0.9, decay: 1.1 });
      noiseBurst(ctx, out, t, { filter: 'lowpass', freq: 450, peak: 0.7, decay: 0.8 });
    },
  };

  return {
    // Kayıtları indirip çözer; çözülemeyen (ör. AAC desteklemeyen tarayıcı) sentezle çalar.
    async load(ctx) {
      await Promise.all(SFX_FILES.map(async (id) => {
        try {
          const res = await fetch(`sfx/${id}.m4a`);
          samples.set(id, await ctx.decodeAudioData(await res.arrayBuffer()));
        } catch {}
      }));
    },
    // Yeni sohbet mesajı için kısa, yumuşak bildirim sesi.
    ping(ctx, out) {
      const t = ctx.currentTime + 0.01;
      tone(ctx, out, t, { type: 'sine', freq: 880, peak: 0.18, attack: 0.004, decay: 0.12 });
      tone(ctx, out, t + 0.08, { type: 'sine', freq: 1320, peak: 0.14, attack: 0.004, decay: 0.22 });
    },
    play(ctx, out, id) {
      const t = ctx.currentTime + 0.01;
      const buffer = samples.get(id);
      if (!buffer) return effects[id]?.(ctx, out, t);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(out);
      src.start(t);
    },
  };
})();
