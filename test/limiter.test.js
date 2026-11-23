// Deneme sınırı (attemptLimiter): sıfıra dönen ve süresi dolan kayıtlar haritadan silinir.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { attemptLimiter } = require('../accounts');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('rezervasyon geri alınınca kayıt silinir', () => {
  const l = attemptLimiter(3, 60000);
  const release = l.reserve('a');
  assert.equal(l.size(), 1);
  release();
  assert.equal(l.size(), 0);
  // iki rezervasyon: biri geri alınınca kayıt kalır, ikisi de alınınca silinir
  const r1 = l.reserve('b');
  const r2 = l.reserve('b');
  r1();
  assert.equal(l.size(), 1);
  r2();
  assert.equal(l.size(), 0);
  l.stop();
});

test('süresi dolan kayıtlar kendiliğinden temizlenir ve sınır sıfırlanır', async () => {
  const l = attemptLimiter(2, 60);
  for (let i = 0; i < 50; i++) l.fail(`ip${i}`);
  l.fail('x'); l.fail('x');
  assert.equal(l.blocked('x'), true);
  assert.equal(l.size(), 51);
  await sleep(250);
  assert.equal(l.size(), 0);
  assert.equal(l.blocked('x'), false);
  l.stop();
});
