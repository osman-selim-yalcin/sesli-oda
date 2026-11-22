// ---------- Amuda kalkan eşek: Enver ----------
// Yönetici üst çubuktaki 🫏 düğmesine basınca odadaki herkesin ekranında ortada belirir (sunucu: 'esek:show' → 'esek').
// Gösteri ~8 sn: yukarıdan amut duruşunda dönerek düşer, ön ayaklarının üstüne konar, sahnede zıplayıp ters takla
// atar, dengede durmaya çalışır, bir ara düşecek gibi olup toparlanır, "İ-haaa!" diye anırır, sonra zıplayıp dönerek gider. Sürükleyince çevrilir; Esc ya da
// boşluğa tıklamak gösteriyi kapatır. Model basit parçalardan (kapsül, silindir, küre) kurulur; dosya indirilmez.
// app.js bunu ilk gösteride dinamik import ile yükler (three.js ~730 KB, yalnızca o zaman iner).

import * as THREE from '/vendor/three.module.min.js';

const COLORS = {
  coat: 0x8f857a, belly: 0xcfc6b8, muzzle: 0xe2dacd, dark: 0x3b332d, hoof: 0x2a2420, eye: 0x111111, inner: 0xd9a7a0, mouth: 0x5a2b2b,
};

const mat = (color, rough = 0.85) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 });
const v = (x, y, z) => new THREE.Vector3(x, y, z);

// a noktasından b noktasına uzanan kapsül (bacak, boyun, kuyruk parçaları için)
function limb(a, b, radius, material) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, Math.max(0.01, len - radius * 2), 6, 14), material);
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(v(0, 1, 0), dir.normalize());
  return mesh;
}

function hoof(at, up, material) {
  const h = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.125, 0.15, 16), material);
  h.position.copy(at);
  h.quaternion.setFromUnitVectors(v(0, 1, 0), up.clone().normalize());
  return h;
}

// Eşek: ayakların yere bastığı nokta (0,0,0). Hareket eden parçalar (arka ayaklar, kulaklar, çene, kuyruk, kafa)
// ayrı gruplar olarak döner.
function buildDonkey() {
  const coat = mat(COLORS.coat);
  const belly = mat(COLORS.belly);
  const muzzle = mat(COLORS.muzzle);
  const dark = mat(COLORS.dark);
  const hoofM = mat(COLORS.hoof, 0.6);
  const eyeM = mat(COLORS.eye, 0.3);
  const inner = mat(COLORS.inner);
  const g = new THREE.Group();

  // Ön ayaklar: yerden omuza dik
  for (const x of [-0.24, 0.24]) {
    g.add(limb(v(x, 0.08, 0.12), v(x, 0.62, 0.1), 0.085, coat));
    g.add(limb(v(x, 0.62, 0.1), v(x, 1.12, 0.05), 0.115, coat));
    g.add(hoof(v(x, 0.075, 0.12), v(0, 1, 0), hoofM));
  }

  // Gövde ve karın
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.43, 1.15, 8, 22), coat);
  body.position.set(0, 1.78, -0.05);
  body.rotation.x = -0.06;
  g.add(body);
  const bellyPatch = new THREE.Mesh(new THREE.CapsuleGeometry(0.31, 0.8, 8, 20), belly);
  bellyPatch.position.set(0, 1.8, 0.25);
  bellyPatch.rotation.x = -0.06;
  bellyPatch.scale.set(1, 1, 0.6);
  g.add(bellyPatch);
  // Göğüs: gövdeyi boyna bağlar
  const chest = new THREE.Mesh(new THREE.SphereGeometry(0.36, 20, 16), coat);
  chest.position.set(0, 1.22, 0.08);
  chest.scale.set(1.05, 0.9, 1);
  g.add(chest);

  // Arka ayaklar: kalçada döner (sallanır, sendelerken çırpınır)
  const hind = [];
  for (const s of [-1, 1]) {
    const leg = new THREE.Group();
    leg.position.set(0.2 * s, 2.42, -0.1);
    const thigh = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), coat);
    thigh.scale.set(1, 1.25, 1.1);
    leg.add(thigh);
    const knee = v(0.16 * s, 0.52, 0.06);
    const top = v(0.3 * s, 1.0, -0.02);
    leg.add(limb(v(0, 0, 0), knee, 0.125, coat), limb(knee, top, 0.085, coat));
    leg.add(hoof(top.clone().add(v(0.02 * s, 0.06, 0)), v(0.25 * s, 1, -0.05), hoofM));
    hind.push(leg);
    g.add(leg);
  }

  // Kuyruk: arkadan yukarı, ucunda koyu püskül
  const tail = new THREE.Group();
  tail.position.set(0, 2.5, -0.4);
  const t1 = v(0, 0.3, -0.16);
  const t2 = v(0, 0.58, -0.1);
  tail.add(limb(v(0, 0, 0), t1, 0.038, coat), limb(t1, t2, 0.034, coat));
  const tuft = new THREE.Mesh(new THREE.SphereGeometry(0.095, 14, 10), dark);
  tuft.scale.set(0.8, 1.7, 0.8);
  tuft.position.copy(t2).add(v(0, 0.13, 0.02));
  tail.add(tuft);
  g.add(tail);

  // Boyun ve yele (boynun arkası boyunca koyu püsküller)
  g.add(limb(v(0, 1.2, 0.18), v(0, 0.8, 0.52), 0.2, coat));
  for (let i = 0; i <= 6; i++) {
    const f = i / 6;
    const tuftM = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), dark);
    tuftM.position.set(0, 1.36 - 0.48 * f, 0.02 + 0.42 * f);
    tuftM.scale.set(0.7, 1, 1.5);
    tuftM.rotation.x = 0.8;
    g.add(tuftM);
  }

  // Kafa
  const head = new THREE.Group();
  head.position.set(0, 0.72, 0.7);
  head.rotation.x = 0.35;
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.27, 22, 18), coat);
  skull.scale.set(1, 1.05, 1.1);
  head.add(skull);
  const snout = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.16, 8, 16), muzzle);
  snout.rotation.x = Math.PI / 2 - 0.2;
  snout.position.set(0, -0.04, 0.29);
  head.add(snout);
  // Alt çene: anırınca açılır; içi koyu
  const jaw = new THREE.Group();
  jaw.position.set(0, -0.14, 0.12);
  const jawM = new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.16, 8, 14), muzzle);
  jawM.rotation.x = Math.PI / 2 - 0.1;
  jawM.position.set(0, -0.03, 0.17);
  const mouthIn = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 10), mat(COLORS.mouth, 0.5));
  mouthIn.scale.set(1, 0.5, 1.4);
  mouthIn.position.set(0, 0.03, 0.2);
  jaw.add(jawM, mouthIn);
  head.add(jaw);
  const ears = [];
  for (const s of [-1, 1]) {
    const nostril = new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 8), dark);
    nostril.position.set(0.075 * s, -0.01, 0.46);
    head.add(nostril);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.048, 12, 10), eyeM);
    eye.position.set(0.17 * s, 0.08, 0.17);
    head.add(eye);
    const glint = new THREE.Mesh(new THREE.SphereGeometry(0.015, 8, 6), mat(0xffffff, 0.2));
    glint.position.set(0.18 * s, 0.1, 0.21);
    head.add(glint);
    head.add(limb(v(0.1 * s, 0.16, 0.2), v(0.22 * s, 0.14, 0.15), 0.018, dark)); // kaş
    // Uzun kulaklar: kökte döner (sallanır)
    const ear = new THREE.Group();
    ear.position.set(0.13 * s, 0.22, -0.05);
    ear.rotation.z = -0.55 * s;
    ear.rotation.x = -0.25;
    const outer = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.38, 6, 12), coat);
    outer.scale.set(1, 1, 0.55);
    outer.position.y = 0.23;
    const inside = new THREE.Mesh(new THREE.CapsuleGeometry(0.048, 0.3, 6, 12), inner);
    inside.scale.set(1, 1, 0.4);
    inside.position.set(0, 0.23, 0.03);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.052, 10, 8), dark);
    tip.position.y = 0.46;
    tip.scale.set(1, 1, 0.55);
    ear.add(outer, inside, tip);
    ear.userData.base = { x: ear.rotation.x, z: ear.rotation.z, s };
    ears.push(ear);
    head.add(ear);
  }
  const forelock = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), dark);
  forelock.scale.set(1.3, 0.7, 0.8);
  forelock.position.set(0, 0.26, 0.1);
  head.add(forelock);
  g.add(head);

  g.traverse((o) => {
    if (o.isMesh) o.castShadow = true;
  });
  return { group: g, head, jaw, ears, hind, tail };
}

// ---------- Gösteri zaman çizelgesi (sn) ----------
const T = { fall: 1.0, land: 1.3, flip: 1.45, flipEnd: 2.35, flipLand: 2.65, wobbleBig: 3.2, wobbleBigEnd: 4.1, bray: 4.4, brayEnd: 5.9, crouch: 6.5, jump: 6.8, fade: 7.4, end: 8.0 };
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const easeOut = (x) => 1 - (1 - x) ** 3;
const easeIn = (x) => x ** 2;
const span = (t, a, b) => clamp01((t - a) / (b - a));

let current = null; // açık gösteri (yenisi gelirse eskisi kapanır)

export function showDonkey({ by } = {}) {
  current?.close();

  const overlay = document.createElement('div');
  overlay.className = 'esek-overlay';
  const stage = document.createElement('div');
  stage.className = 'esek-stage';
  const canvas = document.createElement('canvas');
  canvas.className = 'esek-canvas';
  canvas.setAttribute('aria-label', 'Amuda kalkmış 3D eşek Enver');
  const bubble = Object.assign(document.createElement('div'), { className: 'esek-bubble', textContent: 'İ-haaa!' });
  const caption = Object.assign(document.createElement('div'), { className: 'esek-caption', textContent: by ? `🫏 ${by}, Enver'i çıkardı` : '🫏 Enver' });
  stage.append(canvas, bubble);
  overlay.append(stage, caption);
  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add('on'));

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch (err) {
    overlay.remove();
    throw err;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 60);
  camera.position.set(0, 2.2, 9.2);
  camera.lookAt(0, 1.8, 0);

  scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x3a3226, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 2.3);
  sun.position.set(3, 7, 5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 6, bottom: -1, near: 1, far: 25 });
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0x8fa6ff, 1.1);
  rim.position.set(-4, 3, -4);
  scene.add(rim);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(2.4, 48), new THREE.ShadowMaterial({ opacity: 0.4 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const d = buildDonkey();
  // pivot: ayakların bastığı nokta (sallanma, dönüş ve yükseklik); squash: konarken basılıp yaylanma;
  // spinner: gövdenin ortası, ters takla buradan döner (ayaktan dönerse gövde sahneden dışarı savrulur)
  const CENTER = 1.75;
  const pivot = new THREE.Group();
  const squash = new THREE.Group();
  const spinner = new THREE.Group();
  spinner.position.y = CENTER;
  d.group.position.y = -CENTER;
  spinner.add(d.group);
  squash.add(spinner);
  pivot.add(squash);
  scene.add(pivot);

  // Sürükleyince döner
  let yaw = -0.45;
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, yaw };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (drag) yaw = drag.yaw + (e.clientX - drag.x) * 0.012;
  });
  const release = () => {
    drag = null;
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    const pr = renderer.getPixelRatio();
    if (canvas.width !== Math.round(w * pr) || canvas.height !== Math.round(h * pr)) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }

  const start = performance.now();
  let last = start;
  let raf = 0;
  function frame(now) {
    const t = (now - start) / 1000;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (t >= T.end) return close();
    raf = requestAnimationFrame(frame);
    if (!drag) yaw += 0.22 * dt;

    // Düşüş: ekranın üstünden doğrudan amut duruşunda, elleri önde iner; inerken kendi etrafında yarım tur döner.
    // (Takla havada değil, yere indikten sonra sahnede atılır; havada atınca sahneye inmeden yukarıda bitiyordu.)
    const f = span(t, 0, T.fall);
    let y = (1 - easeIn(f)) * 4.8;
    let flip = 0;
    let spinY = (1 - easeOut(f)) * Math.PI;
    // Konma: basılıp yaylanır (inişte ve taklanın sonunda)
    const l = span(t, T.fall, T.land);
    const l2 = span(t, T.flipEnd, T.flipLand);
    let sq = t < T.fall ? 1 : 1 - Math.sin(l * Math.PI) * 0.16 * (1 - l * 0.5);
    if (t > T.flipEnd) sq = 1 - Math.sin(l2 * Math.PI) * 0.18 * (1 - l2 * 0.5);
    // Ters takla: sahnede zıplar, gövdesinin ortası etrafında geriye bir tur döner, yine ellerinin üstüne konar
    const fl = span(t, T.flip, T.flipEnd);
    const flipping = fl > 0 && fl < 1;
    if (flipping) y += Math.sin(fl * Math.PI) * 0.6; // dönerken boyu kadar yer kaplar; yüksek zıplarsa sahneden taşar
    const roll = flipping ? -(fl * fl * (3 - 2 * fl)) * Math.PI * 2 : 0;
    // Zıplamadan hemen önce çömelir
    if (t > T.flip - 0.15 && t < T.flip) sq = 1 - span(t, T.flip - 0.15, T.flip) * 0.12;
    // Denge: sürekli hafif salınım + bir kez büyük sendeleme
    let tilt = flipping ? 0 : Math.sin(t * 1.7) * 0.045 + Math.sin(t * 3.1) * 0.012;
    const big = span(t, T.wobbleBig, T.wobbleBigEnd);
    if (big > 0 && big < 1) tilt += Math.sin(big * Math.PI) * 0.32 * Math.cos(big * Math.PI * 2.2 - 0.6);
    let flail = 0.08 * Math.sin(t * 2.3);
    if (big > 0 && big < 1) flail += Math.sin(big * Math.PI) * 0.5 * Math.sin(t * 18);
    // Çıkış: çömelip zıplar, dönerek yukarı gider
    const c = span(t, T.crouch, T.jump);
    const j = span(t, T.jump, T.end);
    let sqOut = 1 - Math.sin((c * Math.PI) / 2) * 0.12;
    if (j > 0) {
      sqOut = 1 + 0.06 * (1 - j);
      y += easeIn(j) * 9;
      spinY += easeIn(j) * Math.PI * 4;
      flip = easeIn(j) * 0.4;
    }

    const s = sq * sqOut;
    pivot.position.y = y;
    pivot.rotation.set(flip + (t > T.fall ? Math.sin(t * 1.2 + 1) * 0.03 : 0), yaw + spinY, t > T.fall ? tilt : 0);
    squash.scale.set(1 + (1 - s) * 0.6, s, 1 + (1 - s) * 0.6);
    spinner.rotation.x = roll;
    d.head.rotation.z = -pivot.rotation.z * 1.6;
    d.hind[0].rotation.z = -0.1 - flail;
    d.hind[1].rotation.z = 0.1 + flail * 0.9;
    d.hind[0].rotation.x = Math.sin(t * 2.1) * 0.08;
    d.hind[1].rotation.x = Math.sin(t * 2.1 + 1.4) * 0.08;
    d.tail.rotation.x = Math.sin(t * 4.2) * 0.25;
    d.tail.rotation.z = Math.sin(t * 2.7) * 0.2;
    for (const ear of d.ears) {
      const b = ear.userData.base;
      ear.rotation.z = b.z + Math.sin(t * 3 + b.s) * 0.08 * b.s - tilt * 0.8;
      ear.rotation.x = b.x + Math.sin(t * 2.4 + b.s) * 0.06;
    }
    // Anırma: ağzını açıp kapar, baloncuk görünür
    const braying = t > T.bray && t < T.brayEnd;
    d.jaw.rotation.x = braying ? 0.15 + Math.abs(Math.sin((t - T.bray) * 9)) * 0.45 : 0;
    d.head.rotation.x = 0.35 - (braying ? 0.18 : 0);
    bubble.classList.toggle('on', braying);
    if (t > T.fade) overlay.classList.remove('on');

    resize();
    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(frame);

  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) close();
  });
  addEventListener('keydown', onKey);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    cancelAnimationFrame(raf);
    removeEventListener('keydown', onKey);
    overlay.classList.remove('on');
    setTimeout(() => {
      scene.traverse((o) => {
        o.geometry?.dispose();
        o.material?.dispose?.();
      });
      renderer.dispose();
      overlay.remove();
    }, 300);
    if (current?.close === close) current = null;
  }
  current = { close };
}
