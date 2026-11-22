// ---------- Amuda kalkan eşek ----------
// Oynatıcıda bir şey çalmıyorken ortada duran 3D eşek: ön ayakları yerde, gövdesi dik, arka ayakları havada.
// Model basit parçalardan (kapsül, silindir, küre) kurulur; dosya indirilmez. Sürükleyince döner, bırakınca
// kendi kendine yavaşça döner ve dengede durmaya çalışır gibi hafifçe sallanır. Çizim yalnızca görünürken çalışır.
// app.js bunu dinamik import ile, oynatıcı boşken yükler (three.js ~730 KB, yalnızca o zaman iner).

import * as THREE from '/vendor/three.module.min.js';

const COLORS = {
  coat: 0x8f857a, belly: 0xcfc6b8, muzzle: 0xe2dacd, dark: 0x3b332d, hoof: 0x2a2420, eye: 0x111111, inner: 0xd9a7a0,
};

function mat(color, rough = 0.85) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 });
}

// a noktasından b noktasına uzanan silindir/kapsül (bacak, boyun, kuyruk parçaları için)
function limb(a, b, radius, material, capsule = true) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const geo = capsule ? new THREE.CapsuleGeometry(radius, Math.max(0.01, len - radius * 2), 6, 14) : new THREE.CylinderGeometry(radius, radius, len, 14);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return mesh;
}

function hoof(at, up, material) {
  const h = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.12, 0.14, 14), material);
  h.position.copy(at);
  h.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up.clone().normalize());
  return h;
}

function buildDonkey() {
  const coat = mat(COLORS.coat);
  const belly = mat(COLORS.belly);
  const muzzle = mat(COLORS.muzzle);
  const dark = mat(COLORS.dark);
  const hoofM = mat(COLORS.hoof, 0.6);
  const eyeM = mat(COLORS.eye, 0.3);
  const inner = mat(COLORS.inner);
  const v = (x, y, z) => new THREE.Vector3(x, y, z);
  const g = new THREE.Group();

  // Ön ayaklar: yerden omuza dik
  for (const x of [-0.24, 0.24]) {
    g.add(limb(v(x, 0.08, 0.12), v(x, 0.62, 0.1), 0.085, coat));   // incik
    g.add(limb(v(x, 0.62, 0.1), v(x, 1.12, 0.05), 0.11, coat));    // kol
    g.add(hoof(v(x, 0.07, 0.12), v(0, 1, 0), hoofM));
  }

  // Gövde: omuzdan kalçaya dik duran kapsül; karın kameraya bakar (açık renk)
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.43, 1.15, 8, 20), coat);
  body.position.set(0, 1.78, -0.05);
  body.rotation.x = -0.06;
  g.add(body);
  // Karın: gövdenin önünden biraz taşan açık renkli kapsül (yüzeyler çakışıp titremesin diye öne alınır)
  const bellyPatch = new THREE.Mesh(new THREE.CapsuleGeometry(0.31, 0.8, 8, 20), belly);
  bellyPatch.position.set(0, 1.8, 0.25);
  bellyPatch.rotation.x = -0.06;
  bellyPatch.scale.set(1, 1, 0.6);
  g.add(bellyPatch);

  // Arka ayaklar: kalçadan yukarı, V şeklinde açık
  for (const s of [-1, 1]) {
    const hip = v(0.2 * s, 2.45, -0.1);
    const knee = v(0.36 * s, 2.95, -0.02);
    const top = v(0.5 * s, 3.42, -0.12);
    g.add(limb(hip, knee, 0.13, coat));
    g.add(limb(knee, top, 0.085, coat));
    g.add(hoof(top.clone().add(v(0.02 * s, 0.05, 0)), v(0.25 * s, 1, -0.1), hoofM));
  }

  // Kuyruk: arkadan yukarı kıvrılır, ucunda koyu püskül
  const t0 = v(0, 2.55, -0.42);
  const t1 = v(0, 2.85, -0.58);
  const t2 = v(0, 3.1, -0.52);
  g.add(limb(t0, t1, 0.035, coat), limb(t1, t2, 0.032, coat));
  const tuft = new THREE.Mesh(new THREE.SphereGeometry(0.09, 14, 10), dark);
  tuft.scale.set(0.8, 1.6, 0.8);
  tuft.position.copy(t2).add(v(0, 0.12, 0.02));
  g.add(tuft);

  // Boyun: omuzdan öne ve aşağı, kafa ön ayakların önünde, yere yakın
  const neckTop = v(0, 1.2, 0.18);
  const neckBottom = v(0, 0.78, 0.52);
  g.add(limb(neckTop, neckBottom, 0.2, coat));
  // Yele: boynun arkası boyunca koyu sırt
  g.add(limb(v(0, 1.32, 0.05), v(0, 0.86, 0.42), 0.07, dark));

  // Kafa: kameraya bakar, hafif eğik (dengede durmaya çalışıyor)
  const head = new THREE.Group();
  head.position.set(0, 0.7, 0.68);
  head.rotation.x = 0.35;
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.25, 20, 16), coat);
  skull.scale.set(1, 1.05, 1.1);
  head.add(skull);
  const snout = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.18, 8, 16), muzzle);
  snout.rotation.x = Math.PI / 2 - 0.25;
  snout.position.set(0, -0.08, 0.27);
  head.add(snout);
  for (const s of [-1, 1]) {
    const nostril = new THREE.Mesh(new THREE.SphereGeometry(0.026, 8, 8), dark);
    nostril.position.set(0.07 * s, -0.06, 0.45);
    head.add(nostril);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 10), eyeM);
    eye.position.set(0.16 * s, 0.07, 0.16);
    head.add(eye);
    const glint = new THREE.Mesh(new THREE.SphereGeometry(0.014, 8, 6), mat(0xffffff, 0.2));
    glint.position.set(0.17 * s, 0.09, 0.2);
    head.add(glint);
    // Uzun kulaklar: yana ve yukarı, içi pembe
    const ear = new THREE.Group();
    ear.position.set(0.13 * s, 0.2, -0.05);
    ear.rotation.z = -0.55 * s;
    ear.rotation.x = -0.25;
    const outer = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.36, 6, 12), coat);
    outer.scale.set(1, 1, 0.55);
    outer.position.y = 0.22;
    const inside = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.28, 6, 12), inner);
    inside.scale.set(1, 1, 0.4);
    inside.position.set(0, 0.22, 0.03);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), dark);
    tip.position.y = 0.44;
    tip.scale.set(1, 1, 0.55);
    ear.add(outer, inside, tip);
    head.add(ear);
  }
  // Perçem
  const forelock = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), dark);
  forelock.scale.set(1.3, 0.7, 0.8);
  forelock.position.set(0, 0.24, 0.1);
  head.add(forelock);
  g.add(head);

  g.traverse((o) => {
    if (o.isMesh) o.castShadow = true;
  });
  return { group: g, head };
}

export function mountDonkey(host) {
  const canvas = document.createElement('canvas');
  canvas.className = 'esek-canvas';
  canvas.setAttribute('aria-label', 'Amuda kalkmış 3D eşek; sürükleyerek çevirebilirsin');
  host.append(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(0, 2.1, 7.4);
  camera.lookAt(0, 1.72, 0);

  scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x3a3226, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(3, 6, 5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 5, bottom: -1, near: 1, far: 20 });
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0x8fa6ff, 1.1);
  rim.position.set(-4, 3, -4);
  scene.add(rim);

  // Zemin: yalnızca gölge görünür
  const ground = new THREE.Mesh(new THREE.CircleGeometry(2.2, 48), new THREE.ShadowMaterial({ opacity: 0.35 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const { group: donkey, head } = buildDonkey();
  const pivot = new THREE.Group(); // ayakların yere bastığı noktadan sallanır
  pivot.add(donkey);
  scene.add(pivot);

  // Sürükleyince döner; bırakınca yavaşça kendi döner
  let yaw = -0.5;
  let spin = 0.25; // rad/sn
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, yaw };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    yaw = drag.yaw + (e.clientX - drag.x) * 0.012;
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
    if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }

  let raf = 0;
  let last = performance.now();
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!drag) yaw += spin * dt;
    const t = now / 1000;
    pivot.rotation.y = yaw;
    // Dengede durmaya çalışır gibi: yana ve öne arkaya hafif salınım, kafa da ters yöne düzeltir
    pivot.rotation.z = Math.sin(t * 1.7) * 0.045 + Math.sin(t * 3.1) * 0.012;
    pivot.rotation.x = Math.sin(t * 1.2 + 1) * 0.03;
    head.rotation.z = -pivot.rotation.z * 1.6;
    resize();
    renderer.render(scene, camera);
  }

  // Yalnızca görünürken çiz
  const io = new IntersectionObserver(([entry]) => {
    cancelAnimationFrame(raf);
    raf = 0;
    if (entry.isIntersecting && !document.hidden) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  });
  io.observe(canvas);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
    } else if (!raf && canvas.offsetParent) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  });
}
