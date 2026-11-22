// Sayfa adresleri: oda listesi, oda içi ekranlar ve üyeler aynı sayfayı alır; eski tek oda adresleri
// genel odasına yönlenir.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let srv;
before(async () => { srv = await startServer(); });
after(() => srv?.stop());

const get = (p) => fetch(srv.url + p, { redirect: 'manual' });

test('oda adresleri ve /uyeler index.html verir', async () => {
  for (const p of ['/', '/oda/genel', '/oda/genel/', '/oda/film-gecesi-2/gecmis', '/oda/genel/radyo',
    '/oda/genel/oyunlar', '/oda/genel/oyunlar/kelime', '/oda/genel/oyunlar/tier/3', '/uyeler']) {
    const res = await get(p);
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get('content-type'), /text\/html/, p);
    assert.ok((await res.text()).includes('id="lobby-screen"'), p);
  }
});

test('eski adresler /oda/genel altına 302 ile gider, kuyruk korunur', async () => {
  const cases = {
    '/gecmis': '/oda/genel/gecmis',
    '/radyo': '/oda/genel/radyo',
    '/oyunlar': '/oda/genel/oyunlar',
    '/oyunlar/kelime': '/oda/genel/oyunlar/kelime',
    '/oyunlar/tier/3': '/oda/genel/oyunlar/tier/3',
  };
  for (const [from, to] of Object.entries(cases)) {
    const res = await get(from);
    assert.equal(res.status, 302, from);
    assert.equal(res.headers.get('location'), to, from);
  }
});

test('bilinmeyen yollar sayfa almaz', async () => {
  for (const p of ['/oda', '/oda/', '/odalar', '/oda/genel/x/../../server.js']) {
    const res = await get(p);
    assert.notEqual(res.status, 200, p);
  }
});
