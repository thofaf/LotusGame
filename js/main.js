// Lotus Elise – Stelvio. Huvudprogram: laddning, scen, spelloop, kameror, HUD och menyer.
import * as THREE from './lib/three.module.js';
import { parseKN5, buildKN5 } from './kn5.js';
import { parseAI, CollisionWorld, SURF_ROAD, SURF_GRASS, SURF_WALL } from './track.js';
import { CarPhysics, ELISE } from './car-physics.js';
import { buildCarModel, LEVER_POS } from './car-model.js';
import { loadCarModel } from './car-gltf.js';
import { MotionOutput } from './motion.js';
import { ForceFeedback } from './ffb.js';
import { Input, Calibrator, DEFAULT_SETTINGS } from './input.js';
import { CarAudio } from './audio.js';
import { Tachometer } from './tacho.js';

const $ = id => document.getElementById(id);
const tacho = new Tachometer($('hud-tacho'));
const TEST = new URLSearchParams(location.search).has('autotest');

// Banor (Assetto Corsa-format). Filer:
//   visual:  syns i spelet. phys 'named' = fysikytor enligt AC:s namnregel (1ROAD, 1GRASS, 1WALL …) i samma fil,
//            terrain = övrig synlig mark blir gräs (för banor där fysikfilen saknar terräng)
//   phys 'all': separat fysikfil där alla meshar är ytor;  markers: AC_START_0, AC_AB_START_L/R, AC_AB_FINISH_L/R
// Mittlinjen läses från ai/fast_lane.ai (skapas med tools/make-ai.ps1 om banan saknar en).
const TRACKS = {
  alpine_pass: {
    name: 'Stelviopasset', short: 'STELVIO', dir: 'assets/tracks/alpine_pass/', bestKey: 'lotus.best.v1',
    desc: 'Backklättring uppför alpvägarna mot Passo dello Stelvio – drygt 6 km och 500 höjdmeter.',
    finish: 'MÅL – Passo dello Stelvio',
    files: [
      { f: 'alpine_pass.kn5', label: 'Stelviopasset (3D-modell)', visual: true, terrain: true },
      { f: 'physical1.kn5', label: 'Vägyta och räcken', phys: 'all' },
      { f: 'hillclimb.kn5', label: 'Start och mål', markers: true },
    ],
    map: { w: 2130, h: 544, xo: 364.845275878906, zo: 437.728363037109, scale: 1 },
  },
  bg_kakami: {
    name: 'Kakamigahara Park Way', short: 'KAKAMIGAHARA', dir: 'assets/tracks/bg_kakami/', bestKey: 'lotus.best.bg_kakami',
    desc: 'Smal och kurvig touge-väg i Gifu, Japan – 700 m och 60 höjdmeter med hårnålar. Bana av Nihon Drift Project.',
    finish: 'MÅL – Kakamigahara',
    light: 1.45, // skogsbanans material är mörkare än Stelvios
    files: [
      { f: 'kakami.kn5', label: 'Kakamigahara (3D-modell)', visual: true, phys: 'named' },
      { f: 'tree.kn5', label: 'Träd', visual: true },
      { f: 'gr_coll.kn5', label: 'Räcken', phys: 'named' },
      { f: 'uhpits.kn5', label: 'Start och mål', markers: true },
    ],
    map: { w: 687, h: 511, xo: 286.574890136719, zo: 285.85205078125, scale: 1 },
  },
  // Rundbanor (circuit: true): start/mål = AC_TIME_0_L/R, bilen startar i AC_START_0 (pole position).
  // Filerna följer models_layout_*.ini; ai/ och map.png ligger i layoutens mapp.
  nurburgring_gp: {
    name: 'Nürburgring – GP', short: 'NÜRBURGRING GP', dir: 'assets/tracks/ks_nurburgring/', layout: 'layout_gp_a/',
    bestKey: 'lotus.best.nurburgring_gp', circuit: true, detailWorld: true,
    desc: 'Grand Prix-banan vid Nürburg i Eifel – 5,1 km runt med Mercedes-Arena och den snabba Dunlop-kurvan. Kör ett flygande varv; varje passage av mållinjen ger en varvtid.',
    finish: 'VARVTID – Nürburgring GP',
    files: nurburgFiles(['7', '1', 'ks_nurburgring', '4', '2', '8', '9', '100']),
    map: { w: 600.604, h: 1565.46, xo: 422.16, zo: 1034.46, scale: 1.2 },
  },
  nurburgring_sprint: {
    name: 'Nürburgring – Sprint', short: 'NÜRBURGRING SPRINT', dir: 'assets/tracks/ks_nurburgring/', layout: 'layout_sprint_a/',
    bestKey: 'lotus.best.nurburgring_sprint', circuit: true, detailWorld: true,
    desc: 'Nürburgrings sprintslinga – 3,6 km utan Mercedes-Arena. Kör ett flygande varv; varje passage av mållinjen ger en varvtid.',
    finish: 'VARVTID – Nürburgring Sprint',
    files: nurburgFiles(['7', 'ks_nurburgring', '5', '2', '1', '8', '9', '100']),
    map: { w: 480.136, h: 1269.94, xo: 422.243, zo: 1034.87, scale: 1 },
  },
};
function nurburgFiles(names) {
  const label = { ks_nurburgring: 'Nürburgring (3D-modell och ytor)', 7: 'Vägbana', 8: 'Detaljer', 100: 'Bro' };
  return names.map(n => ({
    f: n + '.kn5', label: label[n] || 'Banobjekt ' + n, visual: true, phys: 'named',
    markers: n === 'ks_nurburgring',
    // från models_layout_*.ini: POSITION=-8.5,68.9,-696.7  ROTATION=180,0,0
    ...(n === '100' ? { pos: [-8.5, 68.9, -696.7], rot: [180, 0, 0] } : {}),
  }));
}
const TRACK_ID = (() => {
  const q = new URLSearchParams(location.search).get('track');
  if (q && TRACKS[q]) return q;
  try { const s = JSON.parse(localStorage.getItem('lotus.settings.v1') || '{}').track; if (TRACKS[s]) return s; } catch { /* */ }
  return 'alpine_pass';
})();
const TRK = TRACKS[TRACK_ID];
const TRACK = TRK.dir;
const LAYOUT = TRACK + (TRK.layout || ''); // ai/ och map.png (egen mapp per layout på banor med flera layouter)
const BEST_KEY = TRK.bestKey;
const WHEEL_LOCK_DEG = 450; // rattutslag åt ena hållet i bilen (900° lock-to-lock)

// Spelet arbetar i "gammarymd" som AC – inga sRGB-omvandlingar.
THREE.ColorManagement.enabled = false;

function log(...a) {
  console.log(...a);
  if (TEST) fetch('/__log', { method: 'POST', body: a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') }).catch(() => {});
}
addEventListener('error', e => log('FEL: ' + e.message + ' @' + e.filename + ':' + e.lineno));
addEventListener('unhandledrejection', e => log('FEL (promise): ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));

// ---------------------------------------------------------------------------
// Renderare och scen
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: TEST });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
$('view').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const FOG = new THREE.Color(0xb9cddd);
scene.fog = new THREE.Fog(FOG, 400, 4200);
scene.background = FOG;
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.2, 7000);

// himmel: gradientkupol som följer kameran
const sky = new THREE.Mesh(new THREE.SphereGeometry(5000, 32, 16), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { top: { value: new THREE.Color(0x3f78c0) }, hor: { value: FOG.clone() }, sunDir: { value: new THREE.Vector3() } },
  vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `uniform vec3 top; uniform vec3 hor; uniform vec3 sunDir; varying vec3 vD;
    void main(){ float h = clamp(vD.y, 0.0, 1.0); vec3 c = mix(hor, top, pow(h, 0.55));
      float s = max(dot(normalize(vD), sunDir), 0.0); c += vec3(1.0,0.92,0.75) * (pow(s, 600.0) * 2.0 + pow(s, 12.0) * 0.18);
      gl_FragColor = vec4(c, 1.0); }`,
}));
sky.renderOrder = -1; sky.frustumCulled = false;
scene.add(sky);

// ljus enligt data/lighting.ini (SUN_PITCH 35°, HEADING 45°)
const hemi = new THREE.HemisphereLight(0xdde9f5, 0x6a6255, 1.7); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
const pitch = THREE.MathUtils.degToRad(35), heading = THREE.MathUtils.degToRad(45);
const SUN_DIR = new THREE.Vector3(-Math.sin(heading) * Math.cos(pitch), Math.sin(pitch), Math.cos(heading) * Math.cos(pitch)).normalize();
sky.material.uniforms.sunDir.value.copy(SUN_DIR);
if (TRK.light) { hemi.intensity *= TRK.light; sun.intensity *= TRK.light; }
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const SH = 45;
Object.assign(sun.shadow.camera, { left: -SH, right: SH, top: SH, bottom: -SH, near: 1, far: 400 });
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);

// Miljökarta för bilens PBR-material (lack, fälgar, speglar): himmel, sol och bergig mark.
{
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), new THREE.ShaderMaterial({
    side: THREE.BackSide, uniforms: { sunDir: { value: SUN_DIR } },
    vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 sunDir; varying vec3 vD;
      void main(){ vec3 d = normalize(vD);
        vec3 sky = mix(vec3(0.78,0.85,0.92), vec3(0.32,0.52,0.82), pow(max(d.y,0.0), 0.5));
        vec3 ground = mix(vec3(0.42,0.40,0.36), vec3(0.22,0.21,0.19), clamp(-d.y*3.0,0.0,1.0));
        vec3 c = d.y > 0.0 ? sky : ground;
        c += vec3(6.0,5.6,4.8) * pow(max(dot(d, sunDir), 0.0), 300.0);
        gl_FragColor = vec4(c, 1.0); }`,
  })));
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(envScene, 0.02).texture;
  pmrem.dispose();
}

addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });

// ---------------------------------------------------------------------------
// Laddning
const files = [
  ...TRK.files.map(x => ({ url: TRACK + x.f, label: x.label })),
  { url: LAYOUT + 'ai/fast_lane.ai', label: 'Ideallinje' },
];
let loadedBytes = 0, totalBytes = 0;
function setProgress(text, frac) {
  $('load-text').textContent = text;
  if (frac !== undefined) $('load-bar').style.width = (frac * 100).toFixed(1) + '%';
}
async function fetchAll() {
  const heads = await Promise.all(files.map(f => fetch(f.url, { method: 'HEAD' }).then(r => +r.headers.get('content-length') || 0).catch(() => 0)));
  totalBytes = heads.reduce((a, b) => a + b, 0) || 1;
  const out = [];
  for (const f of files) {
    const res = await fetch(f.url);
    if (!res.ok) throw new Error('Kunde inte läsa ' + f.url + ' (' + res.status + ')');
    const len = +res.headers.get('content-length') || 0;
    const buf = new Uint8Array(len || 0);
    const reader = res.body.getReader();
    let p = 0; const chunks = [];
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      if (len) buf.set(value, p); else chunks.push(value);
      p += value.length; loadedBytes += value.length;
      setProgress(`Laddar ${f.label}… ${(loadedBytes / 1048576).toFixed(0)} / ${(totalBytes / 1048576).toFixed(0)} MB`, 0.8 * loadedBytes / totalBytes);
    }
    let ab;
    if (len) ab = buf.buffer;
    else { const all = new Uint8Array(p); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; } ab = all.buffer; }
    out.push(ab);
  }
  return out;
}
const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));

// ---------------------------------------------------------------------------
// Spelvärld
const input = new Input();
const S = input.settings;
const audio = new CarAudio();
const motion = new MotionOutput(S, log);
const ffb = new ForceFeedback(S, log);
addEventListener('beforeunload', () => { motion.disconnect(); ffb.stop(); });
let world, spline, car, model, startInfo;
let startIdx = 0, finishIdx = 0;

async function loadWorld() {
  const bufs = await fetchAll();
  const aiBuf = bufs.pop();

  world = new CollisionWorld();
  let nRoad = 0, nWall = 0, nGrass = 0, nTerrain = 0;
  const addPhys = (m, surf) => { world.addMesh(m, surf); if (surf === SURF_WALL) nWall++; else if (surf === SURF_ROAD) nRoad++; else nGrass++; };
  const markerRoots = [];
  for (let k = 0; k < TRK.files.length; k++) {
    const spec = TRK.files[k];
    setProgress(`Avkodar ${spec.label.toLowerCase()}…`, 0.8 + 0.15 * k / TRK.files.length); await nextFrame();
    const built = await buildKN5(parseKN5(bufs[k]), renderer, { visual: !!spec.visual, detailWorld: !!TRK.detailWorld });
    bufs[k] = null;
    if (spec.pos || spec.rot) {
      // placering från models.ini (AC-koordinater: X speglas, rotationen runt Y byter tecken)
      const [px, py, pz] = spec.pos || [0, 0, 0];
      built.root.position.set(-px, py, pz);
      built.root.rotation.y = -THREE.MathUtils.degToRad((spec.rot || [0])[0]);
      built.root.updateMatrixWorld(true);
    }
    if (spec.visual) {
      for (const m of built.materials) m.fog = true;
      scene.add(built.root);
    }
    if (spec.markers) markerRoots.push(built.root);
    if (spec.phys === 'all') {
      // separat fysikfil: allt som inte är räcke eller väg räknas som gräs/terräng
      for (const m of built.meshes) {
        const n = m.name.toUpperCase();
        if (n.startsWith('AC_')) continue;
        if (n.includes('WALL')) addPhys(m, SURF_WALL);
        else if (n.includes('GRASS') || n.includes('SAND') || n.includes('KERB') === false && n.includes('ROAD') === false) addPhys(m, SURF_GRASS);
        else addPhys(m, SURF_ROAD);
      }
    } else if (spec.phys === 'named') {
      for (const m of built.meshes) { const s = namedSurface(m); if (s !== null) addPhys(m, s); }
    }
    if (spec.terrain) {
      // Visuell terräng (berg, slänter) som mark utanför vägen – genomskinliga dekaler hoppas över.
      for (const m of built.meshes) {
        const def = m.userData.matDef;
        if (!def || def.blend === 1) continue;
        if (/asphalt|line|razmetka|road/i.test(def.name)) continue;
        world.addMesh(m, SURF_GRASS, { minNy: 0.6, steepWallNy: 0.5 }); nTerrain++;
      }
    }
  }
  setProgress('Bygger kollisionsvärld…', 0.95); await nextFrame();
  world.finalize();
  log(`bana ${TRACK_ID}: väg ${nRoad}, gräs ${nGrass}, räcken ${nWall}, terräng ${nTerrain} meshar, ${world.surf.length} trianglar`);

  spline = parseAI(aiBuf);

  // start/mål: AC_-markörer (meshar eller tomma noder)
  const centre = name => {
    for (const r of markerRoots) {
      const o = r.getObjectByName(name); if (!o) continue;
      if (o.isMesh) { o.geometry.computeBoundingBox(); return o.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(o.matrixWorld); }
      return o.getWorldPosition(new THREE.Vector3());
    }
    return null;
  };
  const st = centre('AC_START_0') || spline.point(5);
  const gate = (a, b) => { const p = centre(a), q = centre(b); return p && q ? p.add(q).multiplyScalar(0.5) : null; };
  if (TRK.circuit) {
    // Rundbana: rulla ut slingan från ~40 m bakom startplatsen, ett varv + marginal.
    // Mållinjen ligger då både vid startIdx och startIdx + n; vid målgång flyttas index ett varv bakåt.
    const n = spline.n;
    const line = gate('AC_TIME_0_L', 'AC_TIME_0_R') || st;
    const si0 = spline.nearest(st.x, st.z, -1, st.y), li0 = spline.nearest(line.x, line.z, -1, line.y);
    let begin = si0, back = 0;
    while (back < 40) { const a = (begin - 1 + n) % n; back += spline.point(a).distanceTo(spline.point(begin)); begin = a; }
    const toLine = ((li0 - begin) % n + n) % n;
    spline = spline.unrolled(begin, toLine + n + 400);
    const si = ((si0 - begin) % n + n) % n;
    startIdx = toLine; finishIdx = toLine + n;
    startInfo = { pos: st, idx: si };
    log(`rundbana: varv ${n} punkter, ${(spline.dist[finishIdx] - spline.dist[startIdx]).toFixed(0)} m, start idx ${si}, mållinje ${startIdx}/${finishIdx}`);
  } else {
    // A–B-bana: AC_AB_START/FINISH-grindar
    const sGate = gate('AC_AB_START_L', 'AC_AB_START_R');
    const fGate = gate('AC_AB_FINISH_L', 'AC_AB_FINISH_R');
    const si = spline.nearest(st.x, st.z, -1, st.y);
    startIdx = sGate ? spline.nearest(sGate.x, sGate.z, -1, sGate.y) : si + 10;
    finishIdx = fGate ? spline.nearest(fGate.x, fGate.z, -1, fGate.y) : spline.n - 5;
    if (finishIdx <= startIdx) finishIdx = spline.n - 5;
    startInfo = { pos: st, idx: si };
    log(`spline n=${spline.n} längd=${spline.length.toFixed(0)} m, start idx ${si}, startlinje ${startIdx}, mål ${finishIdx}`);
  }

  // bil
  car = new CarPhysics(world);
  setProgress('Laddar bilmodellen…', 0.97); await nextFrame();
  try {
    model = await loadCarModel(S.color, renderer);
    log('bilmodell: glTF laddad, öga ' + model.eye.toArray().map(v => v.toFixed(2)) + ' rattaxel ' + (model.steeringAxis ? model.steeringAxis.toArray().map(v => v.toFixed(2)) : '-'));
  } catch (e) {
    log('glTF-modellen kunde inte laddas, använder enkel modell: ' + (e.stack || e));
    model = buildCarModel(S.color);
  }
  scene.add(model.root);
  if (model.credit) $('credits').textContent = model.credit;
  // svag kupébelysning för den enkla modellen (glTF-modellen lyses upp av miljökartan)
  if (!model.setWheels) {
    const cabin = new THREE.PointLight(0xfff4e6, 0.7, 1.3, 1);
    cabin.position.copy(model.eye).add(new THREE.Vector3(0, -0.12, 0.3));
    model.root.add(cabin);
  }
  applySettings();
  placeAtIndex(startInfo.idx, st);

  // minikarta
  setupMinimap();
  setProgress('Klar', 1);
}

// AC:s namnregel för fysikytor: siffra + ytans nyckel, t.ex. "1ROAD.003", "01WALL11", "1GRASS.012".
function namedSurface(m) {
  // nyckeln kan innehålla bindestreck (Kunos: "1ASPH-NURB", "1GRS-CUT-B")
  const k = /^\d+([A-Z][A-Z-]*)/i.exec(m.name);
  if (!k) return null;
  const full = k[1].toUpperCase().replace(/-+$/, ''), base = full.split('-')[0];
  const mat = m.userData.matDef ? m.userData.matDef.name : '';
  if (/marker/i.test(mat)) return null; // reflexstolpar/kantmarkeringar: inte körbara
  const ROAD = ['ROAD', 'SPROAD', 'PITS', 'PIT', 'KERB', 'ASPHALT', 'ASPH-NURB', 'CURB', 'CUTKRB', 'CONCRETE', 'PAINT', 'OUT', 'TRM-CUT-A'];
  const GRASS = ['GRASS', 'GRAVEL', 'SAND', 'DIRT', 'GRS-CUT-B', 'CARPET'];
  for (const key of [full, base]) { // hela nyckeln först, sedan delen före bindestrecket ("1ROAD-LEFT")
    if (key === 'WALL') return SURF_WALL;
    if (ROAD.includes(key)) return SURF_ROAD;
    if (GRASS.includes(key)) return SURF_GRASS;
  }
  return null; // t.ex. WATER
}

function placeAtIndex(i, exact) {
  const p = exact ? exact.clone() : spline.point(i);
  const fwd = spline.tangent(i);
  const hit = world.groundAt(p.x, p.z, p.y + 1.0, {});
  const gy = hit ? hit.y : p.y;
  p.y = gy + ELISE.cgHeight + 0.06;
  car.place(p, fwd);
  if (S.gearbox === 'auto') car.gear = 2;
  progressIdx = i; lastGoodIdx = i;
  motion.suppress(0.8); // ingen stöt i stolen när bilen flyttas
}

let lastGoodIdx = 0;
function resetCar(msg = 'Bilen återställd') {
  // Om bilen har fallit ned mot en annan vägslinga: gå tillbaka till senaste punkt på vägen.
  let i = spline.nearest(car.pos.x, car.pos.z, progressIdx, car.pos.y);
  if (Math.abs(spline.point(i).y - car.pos.y) > 3 || Math.abs(i - lastGoodIdx) > 40) i = lastGoodIdx;
  placeAtIndex(Math.max(0, i - 2), spline.point(Math.max(0, i - 2)));
  lastGoodIdx = progressIdx;
  toast(msg);
}
function checkOffTrack() {
  const ref = spline.point(progressIdx);
  if (car.contacts >= 3 && Math.abs(car.pos.y - ref.y) < 4 && car.up.y > 0.7) lastGoodIdx = progressIdx;
  const good = spline.point(lastGoodIdx);
  if (car.pos.y < good.y - 8 || car.pos.y < -900 || car.airTime > 6) resetCar('Avåkning – bilen återställd');
  else if (car.up.y < -0.3 && car.speed < 2) { flipT += 1 / 60; if (flipT > 2) { flipT = 0; resetCar('Bilen vändes rätt'); } }
  else flipT = 0;
}
let flipT = 0;

function applySettings() {
  if (!car) return;
  car.settings.automatic = S.gearbox === 'auto';
  car.settings.autoClutch = S.autoClutch || S.gearbox === 'auto';
  car.settings.requireClutch = S.requireClutch;
  car.settings.absAssist = S.abs;
  car.settings.tcAssist = S.tc;
  car.settings.grip = (S.tyreGrip || 100) / 100;
  car.settings.gripBalance = (S.gripBalance || 0) / 100;
  model.setColor(S.color);
  audio.setVolume(S.volume);
  camera.fov = S.fov; camera.updateProjectionMatrix();
  if (S.gearbox === 'auto' && car.gear === 1) car.gear = 2;
}

// ---------------------------------------------------------------------------
// Minikarta (map.png + data/map.ini)
const MAP = TRK.map;
let mapImg = null;
function setupMinimap() {
  mapImg = new Image(); mapImg.src = LAYOUT + 'map.png';
  // kartans proportioner: högst 360 × 160 px på skärmen
  const k = Math.min(360 / MAP.w, 160 / MAP.h);
  const c = $('minimap'), w = Math.round(MAP.w * k), h = Math.round(MAP.h * k);
  c.style.width = w + 'px'; c.style.height = h + 'px'; c.width = w * 2; c.height = h * 2;
}
function drawMinimap() {
  const c = $('minimap'), ctx = c.getContext('2d');
  const W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  const k = Math.min(W / MAP.w, H / MAP.h);
  const ox = (W - MAP.w * k) / 2, oy = (H - MAP.h * k) / 2;
  if (mapImg && mapImg.complete && mapImg.naturalWidth) {
    ctx.globalAlpha = 0.9; ctx.drawImage(mapImg, ox, oy, MAP.w * k, MAP.h * k); ctx.globalAlpha = 1;
  }
  const toMap = (x, z) => [ox + ((-x) + MAP.xo) / MAP.scale * k, oy + (z + MAP.zo) / MAP.scale * k];
  for (const [i, col] of [[startIdx, '#3ddc84'], [finishIdx, '#ff4d4d']]) {
    const p = spline.point(i); const [mx, my] = toMap(p.x, p.z);
    ctx.fillStyle = col; ctx.fillRect(mx - 3, my - 3, 6, 6);
  }
  const [cx, cy] = toMap(car.pos.x, car.pos.z);
  ctx.fillStyle = '#ffd400'; ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
}

// ---------------------------------------------------------------------------
// Kameror
const CAMS = ['Jaktkamera', 'Förarplats', 'Huvkamera', 'Lång jaktkamera'];
let camMode = S.camera || 0;
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
let camInit = false;
const _v = new THREE.Vector3(), _q = new THREE.Quaternion();

// Förarvyns tillstånd: huvudets position (fjäder-dämpare i bilens koordinater), blickriktning
const head = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), acc: new THREE.Vector3(), yaw: 0, lastComp: [0, 0, 0, 0] };
const Y_AXIS = new THREE.Vector3(0, 1, 0), X_AXIS = new THREE.Vector3(1, 0, 0), Z_AXIS = new THREE.Vector3(0, 0, 1);
const _qa = new THREE.Quaternion();

// Synfält som motsvarar verkligheten: fönstrets fysiska höjd sett från ögat.
function cockpitFov() {
  if (!S.cockpitFovAuto) return S.cockpitFov;
  const sw = screen.width || innerWidth, sh = screen.height || innerHeight;
  const diagCm = S.screenInches * 2.54;
  const screenHcm = diagCm / Math.sqrt(1 + (sw / sh) ** 2);
  const viewHcm = screenHcm * Math.min(1, innerHeight / sh);
  return THREE.MathUtils.radToDeg(2 * Math.atan(viewHcm / 2 / S.screenDistCm));
}

// Blickriktning (radianer, + = vänster) från knappar, höger styrspak och "titta mot kurvan".
function lookYawTarget(st, withApex) {
  if (st.lookBack) return Math.PI * 0.92;
  if (st.lookLeft && st.lookRight) return Math.PI * 0.92;
  if (st.lookLeft) return 1.35;
  if (st.lookRight) return -1.35;
  let y = -(st.lookStick || 0) * 1.4;
  if (withApex && S.lookApex && car.speed > 2) {
    const yawRate = car.angVel.dot(car.up); // + = svänger vänster
    y += THREE.MathUtils.clamp(yawRate * 0.3 - car.input.steer * 0.1, -0.3, 0.3);
  }
  return y;
}

function updateHead(dt, strength) {
  // filtrerad acceleration i bilens koordinater (x vänster, y upp, z fram)
  const a = head.acc.lerp(car.lastAcc || _v.set(0, 0, 0), 1 - Math.exp(-dt * 18));
  const H = S.headMotion * strength;
  const target = _v.set(
    THREE.MathUtils.clamp(-a.x * 0.0045 * H, -0.07, 0.07),   // sidled: kroppen trycks utåt i kurvan
    THREE.MathUtils.clamp(-a.y * 0.0030 * H, -0.04, 0.04),   // upp/ned: gupp och krön
    THREE.MathUtils.clamp(-a.z * 0.0045 * H, -0.06, 0.06));  // fram/bak: inbromsning och gas
  // fjäder-dämpare: huvudet släpar efter och svänger in mjukt
  const w0 = 10, zeta = 0.6;
  head.vel.addScaledVector(target.sub(head.pos), w0 * w0 * dt).multiplyScalar(Math.max(0, 1 - 2 * zeta * w0 * dt));
  // gupp från fjädringen (hjulets inåtfjädring knuffar huvudet)
  let bump = 0;
  car.wheels.forEach((w, i) => { bump += (w.comp - head.lastComp[i]) * (w.front ? 1 : 0.6); head.lastComp[i] = w.comp; });
  if (Math.abs(bump) < 0.05) head.vel.y -= bump * 2.5 * H;
  head.pos.addScaledVector(head.vel, dt);
}

function updateCamera(dt, st) {
  const body = model.root;
  const fwdFlat = _v.copy(car.fwd); fwdFlat.y *= 0.3; fwdFlat.normalize();
  const inside = camMode === 1 || camMode === 2;
  head.yaw += (lookYawTarget(st, inside) - head.yaw) * (1 - Math.exp(-dt * 9));
  if (camMode === 0 || camMode === 3) {
    const dist = camMode === 0 ? 5.2 : 8.5, h = camMode === 0 ? 1.65 : 2.6;
    // titta i färdriktningen när bilen glider, annars bakom bilen
    const vdir = car.speed > 3 ? car.vel.clone().normalize() : fwdFlat.clone();
    const dir = fwdFlat.clone().lerp(vdir, 0.35).normalize();
    if (Math.abs(head.yaw) > 0.01) dir.applyAxisAngle(Y_AXIS, head.yaw); // titta runt bilen
    const target = car.pos.clone().addScaledVector(dir, -dist); target.y += h;
    const hit = world.groundAt(target.x, target.z, target.y + 1.5, {});
    if (hit && target.y < hit.y + 0.6) target.y = hit.y + 0.6;
    const k = camInit ? 1 - Math.exp(-dt * 7) : 1;
    camPos.lerp(target, k);
    camLook.lerp(car.pos.clone().addScaledVector(car.up, 0.55).addScaledVector(dir, 2.0), camInit ? 1 - Math.exp(-dt * 14) : 1);
    camera.position.copy(camPos); camera.up.set(0, 1, 0); camera.lookAt(camLook);
    camera.near = 0.2;
    camera.fov = S.fov;
  } else {
    const driver = camMode === 1;
    if (!paused) updateHead(dt, driver ? 1 : 0.35);
    const eye = _v.copy(driver ? model.eye : new THREE.Vector3(0, 0.62, 0.35));
    if (driver) eye.add(new THREE.Vector3(0, S.seatUp / 100, S.seatFwd / 100));
    eye.add(head.pos);
    // titta bakåt: inifrån syns bara stolsryggen, så kameran flyttas till bakänden
    if (Math.abs(head.yaw) > 2.4) eye.set(0, 0.55, -1.75);
    // vibrationer: motor (ökar med varvtalet) och vägbana (fart, gräs)
    let jitter = 0;
    if (!paused) {
      const V = S.vibration;
      const grass = car.wheels.some(w => w.contact && w.surf === SURF_GRASS);
      const eng = car.stalled ? 0 : 0.00035 * Math.pow(Math.min(1, car.rpm / 8500), 1.5) * (0.4 + car.throttleEff);
      const road = Math.min(1, car.speed / 30) * (grass ? 0.006 : 0.0007);
      jitter = (eng + road) * V;
      eye.x += (Math.random() - 0.5) * jitter; eye.y += (Math.random() - 0.5) * jitter * 1.5;
    }
    camera.position.copy(eye).applyQuaternion(body.quaternion).add(body.position);
    // rotation: bilens orientering → vänd framåt + blickriktning → lutning nedåt → huvudets lutning i kurvor
    camera.quaternion.copy(body.quaternion)
      .multiply(_qa.setFromAxisAngle(Y_AXIS, Math.PI + head.yaw))
      .multiply(_q.setFromAxisAngle(X_AXIS, THREE.MathUtils.degToRad(driver ? S.lookPitch : -1.7) + (Math.random() - 0.5) * jitter * 0.6))
      .multiply(_qa.setFromAxisAngle(Z_AXIS, driver ? THREE.MathUtils.clamp(head.pos.x * 0.6, -0.04, 0.04) : 0));
    camera.near = driver ? 0.05 : 0.1;
    camera.fov = driver ? cockpitFov() : S.fov;
  }
  audio.setCabin(camMode === 1 && started);
  camera.updateProjectionMatrix();
  camInit = true;
}

// ---------------------------------------------------------------------------
// Tidtagning
let progressIdx = 0, timerState = 'ready', timeStart = 0, raceTime = 0, lastIdx = 0;
let best = +localStorage.getItem(BEST_KEY) || 0, finishTimer = 0;
function updateTiming(dt) {
  const i = spline.nearest(car.pos.x, car.pos.z, progressIdx, car.pos.y);
  lastIdx = progressIdx; progressIdx = i;
  if (timerState === 'ready' && lastIdx < startIdx && i >= startIdx && i - lastIdx < 50) { timerState = 'running'; raceTime = 0; toast('Tiden går!'); }
  if (timerState === 'running') {
    raceTime += dt;
    if (lastIdx < finishIdx && i >= finishIdx && i - lastIdx < 50) {
      timerState = 'finished';
      const newBest = !best || raceTime < best;
      if (newBest) { best = raceTime; localStorage.setItem(BEST_KEY, String(best)); }
      $('finish-time').textContent = fmtTime(raceTime);
      $('finish-best').textContent = newBest ? 'Nytt personbästa!' : 'Personbästa: ' + fmtTime(best);
      $('finish').classList.remove('hidden');
      clearTimeout(finishTimer); finishTimer = setTimeout(() => $('finish').classList.add('hidden'), TRK.circuit ? 5000 : 9000);
      if (TRK.circuit) {
        // nästa varv: samma plats ligger ett varv tidigare i den utrullade mittlinjen
        const n = spline.lapPoints;
        progressIdx -= n; lastIdx -= n; if (lastGoodIdx >= n) lastGoodIdx -= n;
        timerState = 'running'; raceTime = 0;
      }
    }
  }
}
function restartRun() {
  timerState = 'ready'; raceTime = 0;
  placeAtIndex(startInfo.idx, startInfo.pos);
  $('finish').classList.add('hidden');
}
function fmtTime(t) { const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(2).padStart(5, '0')}`; }

// ---------------------------------------------------------------------------
// HUD
let toastTimer = 0;
function toast(t) { const el = $('toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 1800); }
let hudT = 0, dashT = 0;
function updateHud(dt, st) {
  hudT += dt; dashT += dt;
  const kmh = car.speed * 3.6;
  if (dashT > 0.05 && model.dashTex) { dashT = 0; model.dashTex.draw(car.rpm, Math.abs(car.speedSigned) * 3.6, car.gearLabel, car.rpm > 7900); }
  // stor varvräknare: ritas varje bildruta för mjuk nål, syns i alla kameravyer
  const gear = S.gearbox === 'auto' && car.gear >= 2 ? 'D' + car.gearLabel : car.gearLabel;
  tacho.draw(car.rpm, kmh, gear, timerState === 'ready' ? '--:--' : fmtTime(raceTime).slice(0, -1));
  if (hudT < 0.05) return; hudT = 0;
  $('hud-time').textContent = timerState === 'ready' ? 'Kör till startlinjen' : fmtTime(raceTime);
  $('hud-best').textContent = best ? 'Bästa ' + fmtTime(best) : '';
  const prog = THREE.MathUtils.clamp((progressIdx - startIdx) / (finishIdx - startIdx), 0, 1);
  $('hud-prog').style.width = (prog * 100) + '%';
  const toGo = Math.max(0, spline.dist[finishIdx] - spline.dist[progressIdx]);
  $('hud-dist').textContent = (toGo / 1000).toFixed(2) + ' km till målet';
  const pedal = (id, v) => { $(id).style.height = (v * 100) + '%'; };
  pedal('p-clutch', st.clutch); pedal('p-brake', st.brake); pedal('p-thr', st.throttle);
  $('p-steer').style.transform = `rotate(${car.input.steer * WHEEL_LOCK_DEG / steerGain()}deg)`;
  const flags = [];
  if (car.stalled) flags.push('<span class="warn">MOTORSTOPP – tryck I (starta) eller koppling + friläge</span>');
  if (car.grind > 0) flags.push('<span class="warn">GRRR – trampa ur kopplingen!</span>');
  if (car.limiterCut) flags.push('<span>VARVBEGRÄNSARE</span>');
  if (st.handbrake > 0.1) flags.push('<span>HANDBROMS</span>');
  if (S.abs) flags.push('<span class="dim">ABS</span>'); if (S.tc) flags.push('<span class="dim">TC</span>');
  $('hud-flags').innerHTML = flags.join(' ');
  $('hud-device').textContent = (st.device === 'Tangentbord' || st.device === 'Handkontroll' ? st.device : 'Ratt: ' + short(st.device))
    + (motion.connected ? `  ·  Rörelse A ${Math.round(motion.outA)} B ${Math.round(motion.outB)}` : '')
    + (ffb.connected && S.ffbEnabled ? '  ·  FFB' : '');
  drawMinimap();
}
function short(s) { return s.length > 40 ? s.slice(0, 38) + '…' : s; }

// ---------------------------------------------------------------------------
// Bilmodell följer fysiken
function updateModel(st) {
  model.root.position.copy(car.pos);
  model.root.quaternion.copy(car.quat);
  // bilens ratt följer din fysiska ratt; styrkänsligheten ändrar bara hjulens utslag
  const steerRad = car.input.steer * THREE.MathUtils.degToRad(WHEEL_LOCK_DEG / steerGain());
  if (model.setWheels) { // glTF-modellen
    model.setWheels(car.wheels);
    model.setSteer(steerRad);
    return;
  }
  for (let i = 0; i < 4; i++) {
    const w = car.wheels[i], m = model.wheels[i];
    m.position.y = w.hubLocalY;
    m.rotation.y = w.steer;
    m.userData.spin.rotation.x = w.angle;
  }
  model.steering.rotation.set(-0.42, 0, steerRad);
  const lp = LEVER_POS[car.gearLabel] || LEVER_POS.N;
  const k = 3.2;
  model.lever.rotation.x += (lp[1] * k - model.lever.rotation.x) * 0.35;
  model.lever.rotation.z += (-lp[0] * k - model.lever.rotation.z) * 0.35;
  void st;
}

// ---------------------------------------------------------------------------
// Inmatning -> bil
// Styrkänslighet: snabbare styrväxel för ratt. 900 = 1:1, 1800 = dubbelt så mycket hjulutslag per rattgrad.
function steerGain() { return input.bindings.steer ? (S.steerSensitivity || 900) / 900 : 1; }
let prevHGear = null;
function applyInput(st, dt) {
  const inp = car.input;
  // ratt: kalibrerad axel ±1 motsvarar ±(rotation/2) grader; bilens ratt har ±450°
  let steer = st.steer;
  if (input.bindings.steer) steer = THREE.MathUtils.clamp(steer * (S.wheelRotation / 2) * steerGain() / WHEEL_LOCK_DEG, -1, 1);
  else {
    // tangentbord/handkontroll: hastighetsberoende styrning
    const v = car.speed;
    steer *= 1 / (1 + v * v / (st.kbSteering ? 700 : 1400));
  }
  inp.steer = steer;
  inp.throttle = st.throttle; inp.brake = st.brake; inp.handbrake = st.handbrake;
  // koppling: med riktig pedal används den alltid (även om autokoppling är på, som "överstyrning")
  inp.clutch = st.clutch;

  for (const ev of st.events) {
    if (ev === 'shiftUp') shift(+1);
    else if (ev === 'shiftDown') shift(-1);
    else if (ev.startsWith('kbGear:')) { const g = +ev.slice(7); car.requestGear(g); }
    else if (ev === 'camera') { camMode = (camMode + 1) % CAMS.length; S.camera = camMode; input.saveSettings(); toast(CAMS[camMode]); camInit = false; }
    else if (ev === 'reset') { lastGoodIdx = progressIdx; resetCar(); }
    else if (ev === 'ignition') ignition();
    else if (ev === 'pause') togglePause();
  }
  // H-växel (TH8A/TH8S): absolut läge
  if (st.hGear !== null && S.gearbox !== 'auto') {
    const cur = car.gear === 0 ? -1 : car.gear - 1;
    const changed = st.hGear !== prevHGear;
    if (st.hGear !== cur && (changed || car.clutchEngagement() < 0.35)) car.requestGear(st.hGear);
    prevHGear = st.hGear;
  }
  void dt;
}
function shift(d) {
  if (S.gearbox === 'auto') {
    if (d < 0 && car.gear === 2 && car.speed < 1) { car.requestGear(-1); toast('Back'); return; }
    if (d > 0 && car.gear <= 1) { car.requestGear(1); toast('Drive'); return; }
  }
  if (d > 0) car.shiftUp(); else car.shiftDown();
}
function ignition() {
  if (car.stalled || car.rpm < 200) { car.stalled = false; car.engineOmega = ELISE.idleRpm * 2 * Math.PI / 60; toast('Motorn startad'); }
}

// ---------------------------------------------------------------------------
// Menyer
let paused = true, started = false;
function show(id) { for (const p of document.querySelectorAll('.panel')) p.classList.toggle('hidden', p.id !== id); $('menu').classList.toggle('hidden', !id); }
function togglePause() {
  if (!started || countdown > 0) return;
  paused = !paused;
  if (paused) { show('pause'); audio.suspend(); } else { show(null); audio.resume(); }
}
// Nedräkning innan start: bilen står still tills siffran når noll
const COUNTDOWN_S = 10;
let countdown = 0, countdownShown = -1, goTimer = 0;
function setCountdownText(text, go) {
  const el = $('countdown');
  el.textContent = text;
  el.classList.toggle('go', !!go);
  el.classList.remove('hidden', 'pop'); void el.offsetWidth; el.classList.add('pop');
}
function updateCountdown(dt) {
  countdown -= dt;
  if (countdown > 0) {
    const n = Math.ceil(countdown);
    if (n !== countdownShown) { countdownShown = n; setCountdownText(n); }
    return;
  }
  countdown = 0; paused = false; acc = 0;
  setCountdownText('KÖR!', true);
  clearTimeout(goTimer); goTimer = setTimeout(() => $('countdown').classList.add('hidden'), 900);
}
function startGame() {
  started = true; show(null);
  audio.start(S.volume); audio.resume();
  $('hud').classList.remove('hidden');
  last = performance.now();
  if (TEST) { paused = false; return; }
  paused = true; countdown = COUNTDOWN_S; countdownShown = -1;
  updateCountdown(0);
}

function buildSettings() {
  const f = $('settings-form');
  const row = (label, html) => `<label class="srow"><span>${label}</span>${html}</label>`;
  const sel = (k, opts) => `<select data-k="${k}">${opts.map(([v, t]) => `<option value="${v}" ${String(S[k]) === String(v) ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
  const chk = k => `<input type="checkbox" data-k="${k}" ${S[k] ? 'checked' : ''}>`;
  const num = (k, min, max, step) => `<input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${S[k]}"><output>${S[k]}</output>`;
  f.innerHTML = [
    row('Växellåda', sel('gearbox', [['h', 'H-växel (TH8A/TH8S)'], ['seq', 'Sekventiell / paddlar'], ['auto', 'Automat']])),
    row('Automatisk koppling', chk('autoClutch')),
    row('Kräv koppling vid växling', chk('requireClutch')),
    row('Rattens rotation (grader)', num('wheelRotation', 270, 1080, 10)),
    row('Styrkänslighet (900 = 1:1, högre = mer sväng)', num('steerSensitivity', 300, 2000, 10)),
    row('Styrkurva (1 = linjär)', num('steerLinearity', 0.6, 2, 0.05)),
    row('Däckgrepp / väghållning (%, 100 = standard)', num('tyreGrip', 50, 200, 5)),
    row('Greppbalans fram/bak (%, + = mer grepp fram → överstyr, − = mer bak → understyr)', num('gripBalance', -30, 30, 1)),
    row('ABS', chk('abs')),
    row('Antispinn (TC)', chk('tc')),
    row('Synfält yttre kameror (FOV)', num('fov', 40, 95, 1)),
    row('Volym', num('volume', 0, 1, 0.05)),
    '<h3 class="shead">Förarvy</h3>',
    row('Verklighetstroget synfält (från skärmen)', chk('cockpitFovAuto')),
    row('Skärmens storlek (tum, diagonal)', num('screenInches', 13, 65, 1)),
    row('Avstånd öga – skärm (cm)', num('screenDistCm', 30, 150, 1)),
    row('Synfält förarvy, manuellt', num('cockpitFov', 20, 100, 1)),
    '<div id="fov-info" class="dim"></div>',
    row('Sits fram (+) / bak (−), cm', num('seatFwd', -15, 15, 1)),
    row('Sits upp (+) / ned (−), cm', num('seatUp', -8, 8, 1)),
    row('Blickvinkel upp/ned (grader)', num('lookPitch', -15, 10, 0.5)),
    row('Huvudrörelser av g-krafter', num('headMotion', 0, 2, 0.1)),
    row('Vibrationer (motor och väg)', num('vibration', 0, 2, 0.1)),
    row('Titta in mot kurvan', chk('lookApex')),
    row('Lackfärg', `<input type="color" data-k="color" value="${S.color}">
      <span class="swatches">${['#0f4a2a', '#f2c200', '#c8102e', '#1b3f8b', '#e9e9e9', '#111111', '#ff6a13'].map(c => `<i data-c="${c}" style="background:${c}"></i>`).join('')}</span>`),
    '<h3 class="shead">Force feedback (rattens motkraft)</h3>',
    `<div class="mrow"><button class="btn ghost" id="f-test" type="button">Testa kraften</button>
      <span id="f-status" class="dim">${ffb.status}</span></div>`,
    '<div class="mlive"><div>Kraft <span class="bar fbar"><i id="f-bar"></i></span> <span class="dim">rött = klipper, sänk styrkan</span></div></div>',
    row('Force feedback på', chk('ffbEnabled')),
    row('Styrka', num('ffbGain', 0, 1.5, 0.05)),
    row('Dämpning (tyngd)', num('ffbDamper', 0, 1, 0.05)),
    row('Vägkänsla (gupp, gräs, krockar)', num('ffbRoad', 0, 1.5, 0.05)),
    row('Minsta kraft (svaga rattar)', num('ffbMinForce', 0, 0.2, 0.01)),
    row('Vänd kraftriktning', chk('ffbInvert')),
    '<h3 class="shead">Rörelsesimulator (Arduino SMC3 via USB)</h3>',
    `<div class="mrow"><button class="btn ghost" id="m-connect" type="button">${motion.connected ? 'Koppla från' : 'Anslut Arduino…'}</button>
      <span id="m-status" class="dim">${motion.status}</span></div>`,
    `<div class="mrow">
      <button class="btn ghost m-test" data-t="brake" type="button">Inbromsning</button>
      <button class="btn ghost m-test" data-t="accel" type="button">Acceleration</button>
      <button class="btn ghost m-test" data-t="left" type="button">Vänstersväng</button>
      <button class="btn ghost m-test" data-t="right" type="button">Högersväng</button></div>`,
    '<div id="m-live" class="mlive"><div>A <span class="bar"><i id="m-a"></i></span> <b id="m-av">512</b></div><div>B <span class="bar"><i id="m-b"></i></span> <b id="m-bv">512</b></div></div>',
    row('Skicka rörelser', chk('motionEnabled')),
    row('Motorer', sel('motionMode', [['axes', 'A = gas/broms, B = vänster/höger'], ['mix', 'Tvåmotorsstol (A vänster, B höger motor)']])),
    row('Fullt utslag vid (G)', num('motionMaxG', 0.3, 2.5, 0.1)),
    row('Styrka (andel av slaglängd)', num('motionIntensity', 0, 1, 0.05)),
    row('Mjukhet', num('motionSmooth', 0, 1, 0.05)),
    row('Backar och vägens lutning', chk('motionSlopes')),
    row('Vänd gas/broms', chk('motionInvertLong')),
    row('Vänd vänster/höger', chk('motionInvertLat')),
    row('Vänd motor B', chk('motionInvertB')),
    row('Överföringshastighet (baud)', sel('motionBaud', [['500000', '500000 (SMC3 standard)'], ['115200', '115200']])),
  ].join('');
  $('m-connect').onclick = async () => {
    if (motion.connected) await motion.disconnect(); else await motion.choosePort();
    $('m-connect').textContent = motion.connected ? 'Koppla från' : 'Anslut Arduino…';
  };
  const testBtns = f.querySelectorAll('.m-test');
  testBtns.forEach(b => b.onclick = () => { motion.startTest(b.dataset.t); toast('Teströrelse: ' + b.textContent.toLowerCase() + ', sedan tillbaka till mitten'); });
  motion.onStatus = s => { const el = $('m-status'); if (el) el.textContent = s; const b = $('m-connect'); if (b) b.textContent = motion.connected ? 'Koppla från' : 'Anslut Arduino…'; };
  if (!motion.supported) { $('m-connect').disabled = true; testBtns.forEach(b => b.disabled = true); }
  $('f-test').onclick = () => { ffb.startTest(); toast('Test: ratten vrids åt höger, sedan vänster, sedan vibration'); };
  ffb.onStatus = (state, text) => { const el = $('f-status'); if (el) el.textContent = text; };
  f.querySelectorAll('[data-k]').forEach(el => {
    el.oninput = () => {
      const k = el.dataset.k;
      let v = el.type === 'checkbox' ? el.checked : el.type === 'range' ? +el.value : el.value;
      S[k] = v;
      if (el.nextElementSibling && el.nextElementSibling.tagName === 'OUTPUT') el.nextElementSibling.textContent = v;
      input.saveSettings(); applySettings(); fovInfo();
    };
  });
  fovInfo();
  f.querySelectorAll('.swatches i').forEach(i => i.onclick = () => { S.color = i.dataset.c; f.querySelector('[data-k=color]').value = S.color; input.saveSettings(); applySettings(); });
}

function fovInfo() {
  const el = $('fov-info'); if (!el) return;
  const f = cockpitFov();
  el.innerHTML = S.cockpitFovAuto
    ? `Förarvyns synfält blir <b>${f.toFixed(0)}°</b> (vertikalt). Det kan kännas inzoomat men ger rätt storlek på ratt, vägbredd och fart. Kör i helskärm (F11) för bäst resultat.`
    : `Manuellt synfält: <b>${f.toFixed(0)}°</b>. Ett verklighetstroget värde för din skärm vore ${(() => { const o = S.cockpitFovAuto; S.cockpitFovAuto = true; const v = cockpitFov(); S.cockpitFovAuto = o; return v.toFixed(0); })()}°.`;
}

function bindingSummary() {
  const B = input.bindings;
  const pads = Input.pads();
  const parts = [];
  parts.push(pads.length ? 'Anslutna enheter: ' + pads.map(p => short(p.id)).join(', ') : 'Ingen ratt/handkontroll upptäckt ännu – vrid ratten eller tryck på en knapp.');
  if (B.steer) {
    const have = ['throttle', 'brake', 'clutch'].filter(k => B[k]).map(k => ({ throttle: 'gas', brake: 'broms', clutch: 'koppling' }[k]));
    const h = ['gear1', 'gear2', 'gear3', 'gear4', 'gear5', 'gear6', 'gearR'].filter(g => B[g]).length;
    parts.push(`Kalibrerat: ratt, ${have.join(', ')}${h ? `, H-växel (${h} lägen)` : ''}.`);
  } else parts.push('Ingen ratt kalibrerad – tangentbord/handkontroll används.');
  $('bind-summary').innerHTML = parts.map(p => `<div>${p}</div>`).join('');
}

function openCalibration() {
  show('calib');
  new Calibrator(input, $('cal-body'), saved => {
    if (saved) {
      const B = input.bindings;
      // tre pedaler + H-växel: kör med riktig koppling som standard
      if (B.clutch) { S.autoClutch = false; S.requireClutch = true; }
      if (['gear1', 'gear2', 'gear3'].some(g => B[g])) S.gearbox = 'h';
      else if (B.shiftUp && S.gearbox === 'h') S.gearbox = 'seq';
      input.saveSettings(); applySettings(); buildSettings();
      toast('Kalibrering sparad');
    }
    bindingSummary();
    show(started ? 'pause' : 'main');
  });
}

function setupTrackMenu() {
  document.title = 'Lotus Elise – ' + TRK.name;
  for (const el of document.querySelectorAll('.track-short')) el.textContent = TRK.short;
  $('track-desc').textContent = TRK.desc + ' Elise S2 med 1,8-liters Toyota 2ZZ-GE och sexväxlad manuell låda.';
  $('finish-title').textContent = TRK.finish;
  const sel = $('track-select');
  sel.innerHTML = Object.entries(TRACKS).map(([id, t]) => `<option value="${id}" ${id === TRACK_ID ? 'selected' : ''}>${t.name}</option>`).join('');
  sel.onchange = () => {
    S.track = sel.value; input.saveSettings();
    const u = new URL(location.href); u.searchParams.delete('track');
    location.href = u.toString(); // laddar om med den nya banan
  };
  $('btn-track').onclick = () => { show('main'); sel.focus(); };
}

function setupMenus() {
  setupTrackMenu();
  $('btn-start').onclick = () => { if (started) togglePause(); else startGame(); };
  $('btn-resume').onclick = togglePause;
  $('btn-restart').onclick = () => { restartRun(); togglePause(); };
  $('btn-reset').onclick = () => { lastGoodIdx = progressIdx; resetCar(); togglePause(); };
  for (const b of document.querySelectorAll('[data-open]')) b.onclick = () => {
    const t = b.dataset.open;
    if (t === 'calib') openCalibration();
    else { if (t === 'settings') buildSettings(); show(t); }
  };
  for (const b of document.querySelectorAll('[data-back]')) b.onclick = () => show(started ? 'pause' : 'main');
  $('btn-clear-bind').onclick = () => { input.bindings = {}; input.saveBindings(); bindingSummary(); toast('Rattinställningar rensade'); };
  addEventListener('gamepadconnected', e => { toast('Ansluten: ' + short(e.gamepad.id)); bindingSummary(); });
  addEventListener('gamepaddisconnected', e => { toast('Frånkopplad: ' + short(e.gamepad.id)); bindingSummary(); });
  // Enter/menyknapp på ratten startar spelet från huvudmenyn
  addEventListener('keydown', e => { if (e.code === 'Enter' && !started && !$('main').classList.contains('hidden') && !$('btn-start').disabled) startGame(); });
  bindingSummary();
  setInterval(() => { if (paused) bindingSummary(); }, 1500);
}

// ---------------------------------------------------------------------------
// Spelloop
const STEP = 1 / 240;
let last = performance.now(), acc = 0;
const prevVel = new THREE.Vector3();
let testT = 0, testShots = 0, stuckT = 0;

function frame(now) {
  requestAnimationFrame(frame);
  let dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (!car) return;
  const st = input.poll(dt);
  if (countdown > 0) {
    updateCountdown(dt);
  } else if (paused) {
    for (const ev of st.events) if (ev === 'pause' && started) togglePause();
    if (TEST) testDrive(st, dt);
  } else {
    if (TEST) testDrive(st, dt);
    applyInput(st, dt);
    acc += dt;
    let n = 0;
    prevVel.copy(car.vel);
    while (acc >= STEP && n < 14) {
      const snap = snapshotCar();
      car.step(STEP); acc -= STEP; n++;
      if (!Number.isFinite(car.pos.x + car.vel.x + car.angVel.x + car.quat.w + car.engineOmega + car.wheels[0].omega + car.wheels[2].omega)) {
        if (!nanLogged) { nanLogged = true; log('NaN i fysiken, föregående tillstånd: ' + JSON.stringify(snap)); }
        restoreCar(snap); car.vel.set(0, 0, 0); car.angVel.set(0, 0, 0);
        for (const w of car.wheels) w.omega = 0;
        break;
      }
    }
    if (n === 14) acc = 0;
    // acceleration i bilens koordinater (x vänster, y upp, z fram) över den simulerade tiden
    if (n > 0) car.lastAcc = car.vel.clone().sub(prevVel).divideScalar(n * STEP).applyQuaternion(car.quat.clone().invert());
    if (car.impact > 1.5) { audio.crash(car.impact); }
    ffb.addImpact(car.impact);
    car.impact = 0;
    updateTiming(dt);
    checkOffTrack();
    audio.update(car, dt);
  }
  updateModel(st);
  updateCamera(dt, st);
  updateMotion(dt);
  updateFfb(dt, st);
  // skuggkamera följer bilen
  sun.target.position.copy(car.pos);
  sun.position.copy(car.pos).addScaledVector(SUN_DIR, 150);
  sky.position.copy(camera.position);
  if (started) updateHud(dt, st);
  renderer.render(scene, camera);
}

// Rörelsesimulator: G-krafter som föraren känner (specifik kraft = acceleration − tyngdkraft)
let motionAccF = new THREE.Vector3();
function updateMotion(dt) {
  const active = started && !paused && car.contacts > 0 && car.up.y > 0.5;
  let gLong = 0, gLat = 0;
  if (active && car.lastAcc) {
    // filtrera bort enstaka toppar (krockar) innan modulens egen utjämning
    const a = car.lastAcc;
    const lim = 25;
    motionAccF.lerp(new THREE.Vector3(
      THREE.MathUtils.clamp(a.x, -lim, lim), 0, THREE.MathUtils.clamp(a.z, -lim, lim)), 1 - Math.exp(-dt * 30));
    gLong = motionAccF.z / 9.81;
    gLat = motionAccF.x / 9.81;
    if (S.motionSlopes) {
      // tyngdkraftens komposant längs bilen: uppförsbacke känns som acceleration, sidolutning som sido-G
      gLong += car.fwd.y;
      gLat += car.left.y;
    }
  }
  motion.update(dt, gLong, gLat, active);
  // levande visning i inställningarna
  const ea = $('m-a');
  if (ea && !$('settings').classList.contains('hidden')) {
    const pct = v => Math.max(0, Math.min(100, v / 1023 * 100)) + '%';
    ea.style.width = pct(motion.outA); $('m-b').style.width = pct(motion.outB);
    $('m-av').textContent = Math.round(motion.outA); $('m-bv').textContent = Math.round(motion.outB);
  }
}

// Force feedback: rattens motkraft beräknas ur däckkrafterna
function updateFfb(dt, st) {
  const B = input.bindings.steer;
  ffb.setDevice(B && B.dev);
  const active = started && !paused && document.hasFocus();
  const steerDeg = B ? st.steer * S.wheelRotation / 2 : null;
  // ändstoppet hamnar där bilens fulla rattutslag nås med vald styrkänslighet
  ffb.update(dt, car, active, steerDeg, WHEEL_LOCK_DEG / steerGain());
  const bar = $('f-bar');
  if (bar && !$('settings').classList.contains('hidden')) {
    const f = ffb.force;
    bar.style.left = (50 + Math.min(0, f) * 50) + '%';
    bar.style.width = (Math.abs(f) * 50) + '%';
    bar.style.background = ffb.clip > 0.5 ? '#ff4d4d' : '';
  }
}

// Skydd mot numerisk instabilitet: spara/återställ tillstånd
let nanLogged = false;
function snapshotCar() {
  return {
    pos: car.pos.toArray(), vel: car.vel.toArray(), q: car.quat.toArray(), w: car.angVel.toArray(), eo: car.engineOmega, gear: car.gear,
    lock: car.clutchLocked, inp: { ...car.input },
    wh: car.wheels.map(w => [w.omega, w.comp, w.prevComp, w.contact, w.surf, w.load, w.steer]),
  };
}
function restoreCar(s) {
  car.pos.fromArray(s.pos); car.vel.fromArray(s.vel); car.quat.fromArray(s.q); car.angVel.fromArray(s.w);
  car.engineOmega = s.eo; car.clutchLocked = false;
  car.wheels.forEach((w, i) => { w.omega = s.wh[i][0]; w.comp = s.wh[i][1]; w.prevComp = s.wh[i][2]; });
  car.updateBasis();
}

// Automatiskt test (?autotest): kör uppför och tar skärmdumpar till servern.
function testDrive(st, dt) {
  testT += dt;
  if (!started && testT > 0.5) startGame();
  if (!started) return;
  // hastighetsgräns från kommande kurvor (radie ur tangentvinkel)
  const v = car.speed, t0 = spline.tangent(progressIdx);
  let brake = false;
  for (let k = 4; k < 120; k += 4) {
    const j = Math.min(spline.n - 1, progressIdx + k);
    const d = spline.dist[j] - spline.dist[progressIdx];
    if (d > 15 + v * v / 10) break;
    const ang = Math.acos(THREE.MathUtils.clamp(t0.dot(spline.tangent(j)), -1, 1));
    const vmax = Math.sqrt(6.5 * Math.max(4, d / Math.max(ang, 1e-3)));
    if (v * v - vmax * vmax > 2 * 7 * Math.max(0, d - 6)) { brake = true; break; }
  }
  st.throttle = testT < 1 ? 0 : brake ? 0 : 0.85;
  st.brake = brake ? 0.8 : 0;
  // följ mittlinjen
  const i = Math.min(spline.n - 1, progressIdx + 4 + Math.round(v * 0.3));
  const p = spline.point(i).sub(car.pos);
  const lat = p.dot(car.left), lon = Math.max(1, p.dot(car.fwd));
  // sikta på mittlinjen + dämpning med girhastigheten
  st.steer = THREE.MathUtils.clamp(-2 * lat / (lon * lon) * 3.2 + car.angVel.dot(car.up) * 0.12, -1, 1);
  if (car.speed < 0.5 && testT > 4) { stuckT = (stuckT || 0) + dt; if (stuckT > 2) { resetCar(); stuckT = 0; } } else stuckT = 0;
  st.events = st.events || [];
  if (car.gear === 1 && testT > 0.8) car.requestGear(1);
  if (car.rpm > 7800 && car.gear < 5) car.shiftUp();
  if (car.rpm < 3000 && car.gear > 2) car.shiftDown();
  if (Math.floor(testT / 3) !== Math.floor((testT - dt) / 3) && testT > 12) log(`A=${Math.round(motion.outA)} B=${Math.round(motion.outB)} t=${testT.toFixed(1)} v=${(car.speed * 3.6).toFixed(0)} g=${car.gearLabel} rpm=${car.rpm.toFixed(0)} idx=${progressIdx} y=${car.pos.y.toFixed(2)} c=${car.contacts} steer=${car.input.steer.toFixed(2)} slide=${(car.slide || 0).toFixed(2)} ffb=${ffb.force.toFixed(2)}`);
  const shotsAt = [3, 9, 15, 45];
  if (testShots < shotsAt.length && testT > shotsAt[testShots]) {
    testShots++;
    if (testShots === 2) { camMode = 1; }
    if (testShots === 3) { camMode = 0; }
    log(`fov=${camera.fov.toFixed(1)} head=${head.pos.toArray().map(x => x.toFixed(3))} yaw=${head.yaw.toFixed(2)} cabin=${audio.inside}`);
    log(`t=${testT.toFixed(1)} v=${(car.speed * 3.6).toFixed(0)} km/h gear=${car.gearLabel} rpm=${car.rpm.toFixed(0)} idx=${progressIdx} pos=${car.pos.x.toFixed(1)},${car.pos.y.toFixed(1)},${car.pos.z.toFixed(1)} contacts=${car.contacts} surf=${car.wheels.map(w => w.surf).join('')}`);
    renderer.render(scene, camera);
    fetch('/__shot', { method: 'POST', body: renderer.domElement.toDataURL('image/png') });
  }
}

// ---------------------------------------------------------------------------
async function main() {
  setupMenus();
  try {
    motion.autoConnect().catch(() => {});
    if (!TEST) ffb.connect(); // autotest kör bilen själv – rör inte den riktiga ratten
    await loadWorld();
  } catch (e) {
    log('Laddningsfel: ' + (e.stack || e));
    setProgress('Kunde inte ladda banan: ' + e.message);
    return;
  }
  $('loading').classList.add('hidden');
  $('btn-start').disabled = false;
  $('btn-start').textContent = 'Kör!';
  requestAnimationFrame(frame);
}
main();
void DEFAULT_SETTINGS;
