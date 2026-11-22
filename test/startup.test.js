// Canlıya alma koruması (süreç içinde): kayıt açıkken eksik oda tablosu ya da kopyalanmamış skorla sunucu
// açılmaz; addMember yinelenen satırı kabul eder, yabancı anahtar hatasını üyelik saymaz.
require('./preload');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const roomStore = require('../rooms');
const store = require('../store');

const insert = store.insert;
after(() => { store.insert = insert; });

const row = (room, kind) => ({ room, kind, data: [] });

test('genel ve ortak satırları tamamsa açılır', () => {
  assert.equal(roomStore.startupProblem({ roomIds: ['genel', 'film'], stateRows: [row('ortak', 'dinoboard'), row('genel', 'dinoboard'), row('genel', 'history')] }), null);
  assert.equal(roomStore.startupProblem({ roomIds: ['genel'], stateRows: [] }), null); // hiç skor yok: kopyalanacak bir şey yok
  assert.equal(roomStore.startupProblem({ roomIds: ['genel'], stateRows: [row('genel', 'history'), row('genel', 'sfx')] }), null); // oda başına türler
});

test('rooms tablosunda genel yoksa açılmaz', () => {
  const p = roomStore.startupProblem({ roomIds: ['film'], stateRows: [] });
  assert.match(p, /genel/);
  assert.match(p, /golive\.sql/);
});

test('genel altında skor ya da öneri var, ortak altında hiç yoksa açılmaz', () => {
  for (const kind of ['dinoboard', 'memoryboard', 'klotskiboard', 'timingboard', 'daktiloboard', 'hedefboard', 'oneriler']) {
    const p = roomStore.startupProblem({ roomIds: ['genel'], stateRows: [row('genel', kind), row('genel', 'history')] });
    assert.match(p, /ortak/, kind);
    assert.match(p, /golive\.sql/, kind);
  }
});

test('addMember: yinelenen satır üyeliktir, yabancı anahtar hatası değildir', async () => {
  store.insert = async () => { throw new Error('ekleme 409 {"code":"23505","message":"duplicate key value violates unique constraint"}'); };
  assert.equal(await roomStore.addMember('oda-x', 'ali'), true);
  assert.equal(roomStore.isMember('oda-x', 'ali'), true);

  const warn = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    store.insert = async () => { throw new Error('ekleme 409 {"code":"23503","message":"insert or update on table \\"room_members\\" violates foreign key constraint"}'); };
    assert.equal(await roomStore.addMember('oda-y', 'veli'), false);
  } finally {
    console.warn = warn;
  }
  assert.equal(roomStore.isMember('oda-y', 'veli'), false);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /oda-y/);
});
