// Oda içi avatar rengi: sunucu her girişte bir renk sırası (0..COUNT-1) verir, herkes aynısını görür.
// İsmin karma rengi (istemcideki avatarHash ile aynı FNV-1a) boşsa o, değilse en az kullanılan renklerin en küçüğü.
// Kişi odada kaldıkça rengi değişmez; 10 kişiye kadar herkes ayrı renkte, 20 kişide (birleşik oda) her renk en çok iki kişide.
const COUNT = 10; // public/app.js AVATAR_COLORS uzunluğu

function hashOf(name) {
  let hash = 2166136261;
  for (const ch of String(name)) hash = Math.imul(hash ^ ch.codePointAt(0), 16777619);
  return (hash >>> 0) % COUNT;
}

// used: odadakilerin renk sıraları
function pick(name, used) {
  const count = new Array(COUNT).fill(0);
  for (const i of used) if (Number.isInteger(i) && i >= 0 && i < COUNT) count[i]++;
  const least = Math.min(...count);
  const want = hashOf(name);
  if (count[want] === least) return want;
  return count.indexOf(least);
}

module.exports = { COUNT, hashOf, pick };
