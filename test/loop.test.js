// Tek video döngüsü: açıkken biten video baştan başlar, başka video başlayınca döngü kapanır.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, ack } = require('./helpers');

let srv;
const sockets = [];

before(async () => { srv = await startServer(); });
after(async () => {
  for (const s of sockets) s.close();
  await srv?.stop();
});

// İstenen koşulu sağlayan ilk 'media' olayını bekler.
function mediaWhere(s, pred, ms = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { s.off('media', on); reject(new Error('media olayı gelmedi')); }, ms);
    function on(m) { if (pred(m)) { clearTimeout(timer); s.off('media', on); resolve(m); } }
    s.on('media', on);
  });
}

test('döngü açıkken biten video baştan başlar; sonraki video döngüyü kapatır', async () => {
  const ali = await client(srv.url, 'Ali');
  sockets.push(ali);
  assert.equal((await ack(ali, 'join', { token: ali.token, clientId: 'l1', room: 'genel' })).error, undefined);

  let m = mediaWhere(ali, (x) => x.current?.videoId === 'dQw4w9WgXcQ');
  ali.emit('media:add', 'dQw4w9WgXcQ');
  assert.equal((await m).loop, false);
  m = mediaWhere(ali, (x) => x.queue.length === 1);
  ali.emit('media:add', 'jNQXAC9IVRw');
  await m;

  m = mediaWhere(ali, (x) => x.loop === true);
  ali.emit('media:loop', true);
  await m;

  // Video sona geldi: sıradakine geçilmez, aynı video 0'dan çalar
  m = mediaWhere(ali, (x) => x.position === 100);
  ali.emit('media:seek', 100);
  await m;
  m = mediaWhere(ali, (x) => x.position === 0);
  ali.emit('media:ended', 'dQw4w9WgXcQ');
  const looped = await m;
  assert.equal(looped.current.videoId, 'dQw4w9WgXcQ');
  assert.equal(looped.playing, true);
  assert.equal(looped.loop, true);
  assert.equal(looped.queue.length, 1);

  // Sonraki'ye basınca yeni video döngüsüz başlar
  m = mediaWhere(ali, (x) => x.current?.videoId === 'jNQXAC9IVRw');
  ali.emit('media:next');
  assert.equal((await m).loop, false);
});

test('döngü kapalıyken biten video sıradakine geçer; çalan yokken döngü açılmaz', async () => {
  const veli = await client(srv.url, 'Veli');
  sockets.push(veli);
  const joined = await ack(veli, 'join', { token: veli.token, clientId: 'l2', room: 'genel' });
  assert.equal(joined.error, undefined);

  // Önceki testten kalan video bitsin: sıra boş, çalan kalmaz
  let m = mediaWhere(veli, (x) => x.position === 50);
  veli.emit('media:seek', 50);
  await m;
  m = mediaWhere(veli, (x) => !x.current);
  veli.emit('media:ended', 'jNQXAC9IVRw');
  const empty = await m;
  assert.equal(empty.loop, false);

  veli.emit('media:loop', true);
  await assert.rejects(mediaWhere(veli, () => true, 500));
});
