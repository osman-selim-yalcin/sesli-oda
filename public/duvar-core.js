'use strict';
// Duvar: oyunun saf kuralları. Sunucu (games/duvar.js) require eder, tarayıcı <script> ile yükler (public/duvar.js
// geçerli hamleleri ve duvar önizlemesini bunlarla hesaplar; son söz sunucunun).
//
// Tahta 9 × 9; satır 0 en üst. 1. oyuncu (players[0]) alt ortadan (8, 4) başlar, hedefi üst sıra (0); 2. oyuncu üst
// ortadan (0, 4) başlar, hedefi alt sıra (8). Sırası gelen ya piyonunu yürütür ya da bir duvar koyar (kişi başı 10).
// Duvar iki kare uzunluğundadır ve karelerin arasındaki oluğa, bir kesişim noktasının (r, c; 0-7) ortasından konur:
//   'h' (yatay): r ile r+1 satırlarının arasında, c ve c+1 sütunlarını kapatır
//   'v' (dikey): c ile c+1 sütunlarının arasında, r ve r+1 satırlarını kapatır
// Duvarlar üst üste binemez, aynı noktada çaprazlanamaz ve iki oyuncudan birinin hedefe giden bütün yolunu kesemez.
// Piyon dört yöne bir kare gider; komşu karede rakip varsa üstünden atlar, rakibin arkası duvar ya da kenarsa
// rakibin yanındaki karelere (çapraz) geçer.

const DUVAR = (() => {
  const N = 9;
  const WALLS = 10;
  const START = [[8, 4], [0, 4]];
  const GOAL = [0, 8];
  const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const key = (o, r, c) => `${o}${r}${c}`;
  const inside = (r, c) => r >= 0 && r < N && c >= 0 && c < N;

  // (r, c) karesinden (dr, dc) yönüne geçiş duvarla ya da kenarla kapalı mı
  function blocked(walls, r, c, dr, dc) {
    if (!inside(r + dr, c + dc)) return true;
    if (dr === -1) return walls.has(key('h', r - 1, c)) || walls.has(key('h', r - 1, c - 1));
    if (dr === 1) return walls.has(key('h', r, c)) || walls.has(key('h', r, c - 1));
    if (dc === -1) return walls.has(key('v', r, c - 1)) || walls.has(key('v', r - 1, c - 1));
    return walls.has(key('v', r, c)) || walls.has(key('v', r - 1, c));
  }

  // Hedef sırasına en kısa yol (piyonlar sayılmaz); yol yoksa -1. withPath: kareleri de döndürür.
  function shortest(walls, from, goalRow, withPath = false) {
    const prev = new Map();
    const start = from[0] * N + from[1];
    prev.set(start, -1);
    let q = [start];
    let d = 0;
    while (q.length) {
      const next = [];
      for (const i of q) {
        const r = Math.floor(i / N);
        const c = i % N;
        if (r === goalRow) {
          if (!withPath) return d;
          const path = [];
          for (let k = i; k !== -1; k = prev.get(k)) path.unshift([Math.floor(k / N), k % N]);
          return { d, path };
        }
        for (const [dr, dc] of DIRS) {
          if (blocked(walls, r, c, dr, dc)) continue;
          const j = (r + dr) * N + c + dc;
          if (prev.has(j)) continue;
          prev.set(j, i);
          next.push(j);
        }
      }
      q = next;
      d++;
    }
    return withPath ? null : -1;
  }

  // Duvar tahtaya sığıyor ve başka duvarla çakışmıyor mu (yol denetimi ayrı: wallOk)
  function wallFits(walls, o, r, c) {
    if (!['h', 'v'].includes(o) || !Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r > N - 2 || c < 0 || c > N - 2) return false;
    if (walls.has(key('h', r, c)) || walls.has(key('v', r, c))) return false;
    if (o === 'h') return !walls.has(key('h', r, c - 1)) && !walls.has(key('h', r, c + 1));
    return !walls.has(key('v', r - 1, c)) && !walls.has(key('v', r + 1, c));
  }
  // Konabilir mi: sığar ve iki oyuncunun da hedefe yolu kalır
  function wallOk(walls, pos, o, r, c) {
    if (!wallFits(walls, o, r, c)) return false;
    const next = new Set(walls).add(key(o, r, c));
    return shortest(next, pos[0], GOAL[0]) >= 0 && shortest(next, pos[1], GOAL[1]) >= 0;
  }

  // p oyuncusunun gidebileceği kareler
  function moves(walls, pos, p) {
    const [r, c] = pos[p];
    const [or, oc] = pos[1 - p];
    const out = [];
    for (const [dr, dc] of DIRS) {
      if (blocked(walls, r, c, dr, dc)) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (nr !== or || nc !== oc) {
        out.push([nr, nc]);
        continue;
      }
      // Rakip komşu karede: düz atla; arkası kapalıysa yanlara
      if (!blocked(walls, or, oc, dr, dc)) out.push([or + dr, oc + dc]);
      else {
        for (const [sr, sc] of dr ? [[0, -1], [0, 1]] : [[-1, 0], [1, 0]]) {
          if (!blocked(walls, or, oc, sr, sc)) out.push([or + sr, oc + sc]);
        }
      }
    }
    return out;
  }

  const wallSet = (list) => new Set((list || []).map((w) => key(w.o, w.r, w.c)));
  return { N, WALLS, START, GOAL, key, blocked, shortest, wallFits, wallOk, moves, wallSet };
})();

if (typeof module !== 'undefined') module.exports = DUVAR;
