'use strict';

// ---------- Gizli kural ----------
// app.js'ten sonra yüklenir; $, socket, myName, LOBBY, renderLobby, confirmButton, fmtTime, toast oradan gelir.
// Bilgisayar 3 sayılık diziler için gizli bir kural tutar; herkes aynı anda dizi dener, sunucu uyuyor/uymuyor der.
// Kuralı bilen listeden seçer. Kural ve başkalarının denemeleri oyun bitene kadar sunucudan gelmez.
// Kuralların üstünü çizme notları sadece bu tarayıcıda (localStorage, oyun id'sine göre) tutulur.

let kural = null;
let kuralClock = 0;       // sunucu saati - bu saat
let kuralTick = null;
let kuralPickOpen = false; // kural listesi açık mı
let kuralChoice = null;    // listeden seçilen kural id'si (onay bekliyor)
let kuralSeen = { id: null, tries: 0, wrong: 0 }; // son çizimdeki kendi deneme/yanlış sayım (yeni sonucu vurgulamak için)

const KURAL_MIN = 1;
const KURAL_MAX = 20;
const kuralInputs = [$('kural-n1'), $('kural-n2'), $('kural-n3')];
const kuralNotesKey = () => `kuralNotes:${myName}`;

const kuralActive = () => (kural && !kural.done ? kural : null);
const kuralPlaying = () => Boolean(kural && kural.players.includes(myName) && !kural.gone.includes(myName));
const kuralCanPlay = () => Boolean(kuralActive() && kuralPlaying() && !kural.finished[myName]);
const kuralRuleText = (id) => kural?.rules.find((r) => r.id === id)?.text || id;
const kuralLower = (s) => s.toLocaleLowerCase('tr');

LOBBY.kural = {
  title: 'Gizli kural', tab: 'kural', running: () => Boolean(kuralActive()), last: () => kural,
  hint: 'Bilgisayarın gizli kuralını 3 sayılık dizilerle bul. 1-6 kişi; tek başına da oynanır, bot açıksa bot da oynar.',
};

function kuralNotes() {
  let notes = null;
  try { notes = JSON.parse(localStorage.getItem(kuralNotesKey())); } catch {}
  if (!notes || notes.id !== kural?.id || !Array.isArray(notes.struck)) notes = { id: kural?.id ?? null, struck: [] };
  return notes;
}
function kuralToggleStrike(id) {
  const notes = kuralNotes();
  notes.struck = notes.struck.includes(id) ? notes.struck.filter((x) => x !== id) : [...notes.struck, id];
  try { localStorage.setItem(kuralNotesKey(), JSON.stringify(notes)); } catch {}
  renderKuralRules();
}

const kuralEl = (tag, className, text) => Object.assign(document.createElement(tag), { className, ...(text != null ? { textContent: text } : {}) });
const kuralSeqText = (seq) => seq.join(' · ');

// ---------- Sayı kutuları ----------
// Her kutuya 1-20 yazılır; sayı tamamlanınca (iki basamak ya da 3-9) imleç sonrakine geçer. "345" gibi art arda
// yazılanlar kutulara dağılır; boşluk, virgül, tire de sonraki kutuya geçirir.

function kuralFill(i, raw) {
  const input = kuralInputs[i];
  const sep = /[\s,.\-/]/.test(raw);
  const digits = raw.replace(/\D/g, '').replace(/^0+/, '');
  let tok = '';
  if (digits) tok = digits.length >= 2 && Number(digits.slice(0, 2)) <= KURAL_MAX ? digits.slice(0, 2) : digits[0];
  const rest = digits.slice(tok.length);
  input.value = tok;
  const complete = tok.length === 2 || tok >= '3' || Boolean(rest) || (sep && Boolean(tok));
  if (complete && i < 2) {
    if (rest) return kuralFill(i + 1, rest);
    kuralInputs[i + 1].focus();
    kuralInputs[i + 1].select();
  }
}

kuralInputs.forEach((input, i) => {
  input.addEventListener('input', () => {
    kuralFill(i, input.value);
    renderKuralHint();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !input.value && i > 0) {
      e.preventDefault();
      kuralInputs[i - 1].focus();
    } else if (e.key === 'ArrowLeft' && i > 0 && input.selectionStart === 0 && input.selectionEnd === 0) {
      e.preventDefault();
      kuralInputs[i - 1].focus();
    } else if (e.key === 'ArrowRight' && i < 2 && input.selectionStart === input.value.length) {
      e.preventDefault();
      kuralInputs[i + 1].focus();
    } else if (e.key === 'Enter' && i < 2 && kuralInputs.some((x) => !x.value)) {
      // Boş kutu varsa Enter sonraki boş kutuya geçirir
      e.preventDefault();
      (kuralInputs.find((x) => !x.value) || kuralInputs[i + 1]).focus();
    }
  });
  input.addEventListener('focus', () => input.select());
});

let kuralHintTimer = null;
function kuralHint(text, cls) {
  const el = $('kural-hint');
  el.textContent = text;
  el.className = 'muted small kural-hint' + (cls ? ` ${cls}` : '');
  clearTimeout(kuralHintTimer);
  if (cls === 'error') kuralHintTimer = setTimeout(renderKuralHint, 2500);
}
function renderKuralHint() {
  if (!kuralCanPlay()) return;
  const last = kural.tries[myName]?.at(-1);
  if (last && kuralInputs.every((x) => !x.value)) return kuralHint(`${kuralSeqText(last.seq)} → ${last.ok ? '✓ uyuyor' : '✗ uymuyor'}`, last.ok ? 'ok' : 'no');
  kuralHint('1-20 arası üç sayı yaz, Enter');
}

$('kural-try').onsubmit = (e) => {
  e.preventDefault();
  if (!kuralCanPlay()) return;
  const seq = kuralInputs.map((x) => Number(x.value));
  if (!seq.every((n) => Number.isInteger(n) && n >= KURAL_MIN && n <= KURAL_MAX)) {
    (kuralInputs.find((x) => !x.value) || kuralInputs[0]).focus();
    return kuralHint('Üç kutuya da 1-20 arası bir sayı yaz.', 'error');
  }
  if (kural.tries[myName].some((t) => t.seq.every((n, i) => n === seq[i]))) return kuralHint('Bu diziyi zaten denedin.', 'error');
  socket.emit('kural:try', seq);
  for (const x of kuralInputs) x.value = '';
  kuralInputs[0].focus();
};

// Klavyeden yazılan rakamlar, başka bir yere yazmıyorsan sayı kutularına gider.
document.addEventListener('keydown', (e) => {
  if ($('games').hidden || $('game-kural').hidden || e.ctrlKey || e.metaKey || e.altKey || !kuralCanPlay()) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
  if (!/^\d$/.test(e.key)) return;
  e.preventDefault();
  const i = Math.max(0, kuralInputs.findIndex((x) => !x.value));
  kuralInputs[i].focus();
  kuralFill(i, kuralInputs[i].value + e.key);
  renderKuralHint();
});

// ---------- Kural listesi ----------

$('kural-guess-toggle').onclick = () => {
  kuralPickOpen = !kuralPickOpen;
  if (!kuralPickOpen) kuralChoice = null;
  renderKural();
  if (kuralPickOpen && matchMedia('(pointer: fine)').matches) $('kural-search').focus();
};
$('kural-search').addEventListener('input', renderKuralRules);
$('kural-cancel').onclick = () => {
  kuralChoice = null;
  renderKuralRules();
};
$('kural-submit').onclick = () => {
  if (!kuralChoice || !kuralCanPlay()) return;
  socket.emit('kural:guess', kuralChoice);
  kuralChoice = null;
  renderKuralRules();
};

function renderKuralRules() {
  const list = $('kural-rules');
  if (!kural) return list.replaceChildren();
  const notes = kuralNotes();
  const wrong = kural.wrong[myName] || [];
  const q = kuralLower($('kural-search').value.trim());
  const rules = kural.rules.filter((r) => !q || kuralLower(r.text).includes(q));
  list.replaceChildren(...rules.map((r) => {
    const li = kuralEl('li', 'kural-rule');
    const bad = wrong.includes(r.id);
    const struck = notes.struck.includes(r.id);
    li.classList.toggle('struck', struck || bad);
    li.classList.toggle('bad', bad);
    li.classList.toggle('chosen', kuralChoice === r.id);
    const pickBtn = kuralEl('button', 'kural-rule-pick', r.text);
    pickBtn.type = 'button';
    pickBtn.disabled = bad;
    pickBtn.onclick = () => {
      kuralChoice = kuralChoice === r.id ? null : r.id;
      renderKuralRules();
    };
    if (bad) pickBtn.append(kuralEl('small', 'kural-rule-tag', 'yanlış tahmin'));
    const strike = kuralEl('button', 'sm ghost kural-strike');
    setIcon(strike, struck ? 'undo' : 'x');
    strike.type = 'button';
    strike.title = struck ? 'Çizgiyi kaldır' : 'Üstünü çiz (sadece sende)';
    strike.setAttribute('aria-label', strike.title);
    strike.hidden = bad;
    strike.onclick = () => kuralToggleStrike(r.id);
    li.append(pickBtn, strike);
    return li;
  }));
  if (!rules.length) list.append(kuralEl('li', 'muted small kural-empty', 'Aramaya uyan kural yok.'));
  const chosen = kuralChoice && kural.rules.find((r) => r.id === kuralChoice);
  $('kural-confirm').hidden = !chosen;
  if (chosen) {
    $('kural-choice').replaceChildren('Seçtiğin: ', kuralEl('strong', '', chosen.text), kuralEl('span', 'muted', ' · yanlışsa −150 puan'));
  }
  const open = kural.rules.filter((r) => !notes.struck.includes(r.id) && !wrong.includes(r.id)).length;
  $('kural-guess-toggle').replaceChildren(
    kuralEl('span', '', `${kuralPickOpen ? '▾' : '▸'} Kuralı söyle`),
    kuralEl('small', 'muted', `${open}/${kural.rules.length} kural açık`),
  );
}

// ---------- Çizim ----------

function kuralTryList(list, tries, flash) {
  list.replaceChildren(...[...tries].reverse().map((t, k) => {
    const li = kuralEl('li', `kural-row ${t.ok ? 'ok' : 'no'}` + (flash && k === 0 ? ' new' : ''));
    li.append(
      kuralEl('span', 'muted small kural-i', `${tries.length - k}.`),
      kuralEl('span', 'kural-seq', kuralSeqText(t.seq)),
      kuralEl('strong', 'kural-res', t.ok ? '✓ uyuyor' : '✗ uymuyor'),
    );
    return li;
  }));
}

function renderKuralTimer() {
  const el = $('kural-timer');
  const game = kural;
  el.hidden = !game;
  clearInterval(kuralTick);
  kuralTick = null;
  if (!game) return;
  const draw = () => {
    const mine = game.finished?.[myName];
    const end = mine ? game.startedAt + mine.ms : game.done ? game.endedAt : Date.now() + kuralClock;
    setIcon(el, 'timer', fmtTime((end - game.startedAt) / 1000));
  };
  draw();
  if (!game.done && !game.finished?.[myName]) kuralTick = setInterval(draw, 1000);
}

function renderKural() {
  const game = kural;
  renderLobby('kural');
  const active = kuralActive();
  const playing = kuralPlaying();
  const canPlay = kuralCanPlay();
  $('kural-end').hidden = !(active && playing);
  $('kural-close').hidden = !game?.done;
  $('kural-play').hidden = !game;
  renderKuralTimer();
  if (!game) return;

  const me = game.finished[myName];
  const [winner] = game.winners;
  const result = game.winners.length > 1 ? 'Berabere!' : winner === myName ? '🏆 Sen kazandın' : winner ? `🏆 ${winner} kazandı` : 'Oyun bitti';
  $('kural-status').textContent = game.done
    ? (game.reason ? `${game.reason} ` : '') + result
    : me ? 'Buldun! Diğerleri arıyor…'
      : !playing ? 'Oyunu izliyorsun · denemeler bitince açılır'
        : game.players.length > 1 ? `${game.players.length} oyuncu · herkes kendi hızında` : 'Tek başına';

  // Puanlar: bulanların deneme, süre ve puanı; arayanların deneme sayısı
  $('kural-scores').replaceChildren(...game.players.map((p) => {
    const f = game.finished[p];
    const c = game.counts[p] || { tries: 0, wrong: 0 };
    const gone = game.gone.includes(p);
    const li = kuralEl('li', f ? 'found' : '');
    li.append(kuralEl('strong', '', p === myName ? 'Sen' : p));
    if (f) {
      li.append(` · ${f.tries} deneme${f.wrong ? ` · ${f.wrong} yanlış` : ''} · ${fmtTime(f.ms / 1000)} · `, kuralEl('b', '', `${f.points} puan`));
    } else {
      li.append(` · ${c.tries} deneme${c.wrong ? ` · ${c.wrong} yanlış` : ''} · ${gone ? 'ayrıldı' : game.done ? 'bulamadı' : 'arıyor'}`);
    }
    return li;
  }));

  const reveal = $('kural-reveal');
  reveal.hidden = !game.done;
  if (game.done) reveal.replaceChildren(kuralEl('span', 'muted small', 'Gizli kural'), kuralEl('strong', '', game.rule || ''));

  $('kural-example').textContent = kuralSeqText(game.example);

  // Kendi denemelerim (izleyenlerde boş; bitince herkesinki aşağıda)
  const mine = game.tries[myName] || [];
  const fresh = kuralSeen.id === game.id && mine.length > kuralSeen.tries;
  const newWrong = kuralSeen.id === game.id && (game.wrong[myName]?.length || 0) > kuralSeen.wrong;
  if (newWrong) toast(`Yanlış kural: ${kuralRuleText(game.wrong[myName].at(-1))} (−150 puan)`);
  kuralSeen = { id: game.id, tries: mine.length, wrong: game.wrong[myName]?.length || 0 };

  $('kural-try').hidden = !canPlay;
  $('kural-guess-box').hidden = !canPlay;
  const board = $('game-kural').querySelector('.kural-board');
  board.hidden = !playing;
  board.querySelector('.kural-wrong')?.remove();
  $('kural-tries-count').textContent = mine.length ? `${mine.filter((t) => t.ok).length} ✓ · ${mine.filter((t) => !t.ok).length} ✗` : '';
  kuralTryList($('kural-mine'), mine, fresh);
  if (!mine.length) $('kural-mine').append(kuralEl('li', 'muted small kural-empty', 'Henüz deneme yok. Örneğe benzeyen ve benzemeyen diziler dene.'));
  if (canPlay) {
    $('kural-pick').hidden = !kuralPickOpen;
    renderKuralRules();
    renderKuralHint();
  } else {
    kuralChoice = null;
  }

  // Bitince herkesin denemeleri ve yanlış tahminleri
  const others = $('kural-others');
  const rest = game.done ? game.players.filter((p) => p !== myName || !playing) : [];
  others.hidden = !rest.length;
  others.replaceChildren(...rest.map((p) => {
    const box = kuralEl('div', 'sayi-board kural-board');
    const head = kuralEl('div', 'kural-col-head muted small');
    const tries = game.tries[p] || [];
    head.append(kuralEl('span', '', `${p}'in denemeleri`), kuralEl('span', '', `${tries.length} deneme`));
    const list = kuralEl('ol', 'kural-list');
    kuralTryList(list, tries);
    if (!tries.length) list.append(kuralEl('li', 'muted small kural-empty', 'Deneme yok.'));
    box.append(head, list);
    const wrong = game.wrong[p] || [];
    if (wrong.length) box.append(kuralEl('p', 'muted small kural-wrong', `Yanlış tahmin: ${wrong.map(kuralRuleText).join(' · ')}`));
    return box;
  }));
  // Kendi yanlış tahminlerim de bitince görünsün
  if (game.done && playing && game.wrong[myName]?.length) {
    board.append(kuralEl('p', 'muted small kural-wrong', `Yanlış tahminlerin: ${game.wrong[myName].map(kuralRuleText).join(' · ')}`));
  }
}

confirmButton($('kural-end'), 'Emin misin? Tekrar bas', () => socket.emit('kural:end'));
$('kural-close').onclick = () => socket.emit('kural:close');

function setKural(game) {
  const fresh = game && kural?.id !== game.id;
  kural = game;
  if (game?.now) kuralClock = game.now - Date.now();
  if (fresh) {
    for (const x of kuralInputs) x.value = '';
    $('kural-search').value = '';
    kuralPickOpen = false;
    kuralChoice = null;
  }
  renderKural();
  // Yeni oyun başlayınca (sayfa açıksa) ilk kutuya odaklan
  if (fresh && kuralCanPlay() && !$('games').hidden && !$('game-kural').hidden && !document.activeElement?.closest?.('input, textarea')) {
    kuralInputs[0].focus({ preventScroll: true });
  }
}
socket.on('kural', setKural);
renderKural();
