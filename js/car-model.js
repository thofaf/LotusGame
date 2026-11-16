// Procedurell 3D-modell av Lotus Elise S2 inkl. interiör. Lokala axlar: +Z fram, +Y upp, +X vänster.
// Modellen byggs med marken på y=0 och flyttas sedan ned så origo ligger i tyngdpunkten.
import * as THREE from './lib/three.module.js';
import { ELISE } from './car-physics.js';

const CG = ELISE.cgHeight;

// Karossens tvärsnitt längs bilen: z, halvbredd, underkant, topp i mitten, topp vid sidan, sidolinje
const STATIONS = [
  [-1.535, 0.66, 0.34, 0.78, 0.80, 0.55],
  [-1.50, 0.78, 0.25, 0.86, 0.88, 0.52],
  [-1.38, 0.835, 0.19, 0.91, 0.94, 0.50],
  [-1.15, 0.855, 0.15, 0.93, 0.97, 0.49],
  [-0.87, 0.865, 0.14, 0.93, 0.99, 0.48],
  [-0.55, 0.855, 0.135, 0.92, 0.97, 0.47],
  [-0.38, 0.84, 0.135, 0.88, 0.93, 0.46],
  [-0.30, 0.83, 0.135, 0.52, 0.82, 0.46],
  [0.20, 0.83, 0.135, 0.50, 0.80, 0.46],
  [0.42, 0.835, 0.135, 0.62, 0.82, 0.46],
  [0.55, 0.84, 0.135, 0.80, 0.84, 0.46],
  [0.85, 0.86, 0.135, 0.75, 0.87, 0.47],
  [1.20, 0.865, 0.14, 0.69, 0.88, 0.47],
  [1.50, 0.86, 0.15, 0.65, 0.86, 0.46],
  [1.80, 0.83, 0.165, 0.59, 0.77, 0.44],
  [2.02, 0.75, 0.20, 0.52, 0.64, 0.42],
  [2.17, 0.58, 0.25, 0.46, 0.50, 0.40],
  [2.245, 0.36, 0.30, 0.42, 0.43, 0.38],
  [2.265, 0.05, 0.34, 0.39, 0.39, 0.37],
];

function lerpStation(z) {
  for (let i = 1; i < STATIONS.length; i++) {
    if (z <= STATIONS[i][0]) {
      const a = STATIONS[i - 1], b = STATIONS[i];
      let t = (z - a[0]) / (b[0] - a[0]);
      t = t * t * (3 - 2 * t) * 0.5 + t * 0.5; // mjukare övergång
      return a.map((v, k) => v + (b[k] - v) * t);
    }
  }
  return STATIONS[STATIONS.length - 1];
}

const ARCHES = [
  { z: ELISE.cgToFront, r: 0.37, y: ELISE.wheelRadiusF },
  { z: -ELISE.cgToRear, r: 0.385, y: ELISE.wheelRadiusR },
];

function bodyGeometry() {
  const NZ = 120, NS = 40;
  const z0 = STATIONS[0][0], z1 = STATIONS[STATIONS.length - 1][0];
  const pos = [], idx = [];
  const n = 5.0;
  for (let i = 0; i <= NZ; i++) {
    const z = z0 + (z1 - z0) * i / NZ;
    const [, w, hb, hc, hs, ym] = lerpStation(z);
    for (let j = 0; j <= NS * 2; j++) {
      // j: 0 = undersida höger ... NS = topp mitt? -> vi går runt: höger botten -> höger sida -> topp -> vänster sida -> vänster botten
      const s = j / (NS * 2);          // 0..1
      const phi = -Math.PI / 2 + s * 2 * Math.PI; // -90° (botten) -> 270°
      const c = Math.cos(phi), sn = Math.sin(phi);
      const xs = Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
      let x = -w * xs; // börja på höger sida (negativt x)
      const xr = Math.abs(xs);
      let y;
      if (sn < 0) y = ym - (ym - hb) * Math.pow(-sn, 2 / n);
      else {
        const top = hc + (hs - hc) * Math.pow(xr, 2.2);
        y = ym + (top - ym) * Math.pow(sn, 2 / 3.2);
      }
      // hjulhus
      for (const a of ARCHES) {
        const dz = z - a.z, dy = y - a.y;
        const d = Math.hypot(dz, dy);
        if (d < a.r && xr > 0.55 && y < ym + 0.2) {
          const k = a.r / Math.max(d, 1e-3);
          y = a.y + dy * k;
          if (y < a.y - 0.05) y = Math.max(y, hb);
          x *= 0.985;
        }
      }
      pos.push(x, y, z);
    }
  }
  const row = NS * 2 + 1;
  for (let i = 0; i < NZ; i++) for (let j = 0; j < NS * 2; j++) {
    const a = i * row + j, b = a + row;
    idx.push(a, a + 1, b, b, a + 1, b + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function ellipsoid(rx, ry, rz, mat, seg = 24) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, seg, Math.max(8, seg >> 1)), mat);
  m.scale.set(rx, ry, rz);
  return m;
}

function quadGeo(pts) { // pts: 4 st Vector3 i ordningen a,b,c,d
  const g = new THREE.BufferGeometry();
  const p = []; for (const v of pts) p.push(v[0], v[1], v[2]);
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return g;
}

function makeWheel(radius, width, front, mats) {
  const g = new THREE.Group();
  const tyre = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, width, 40, 1, true), mats.tyre);
  tyre.rotation.z = Math.PI / 2; g.add(tyre);
  const side = new THREE.TorusGeometry(radius - 0.03, 0.03, 8, 40);
  for (const s of [-1, 1]) { const t = new THREE.Mesh(side, mats.tyre); t.rotation.y = Math.PI / 2; t.position.x = s * (width / 2 - 0.012); g.add(t); }
  const rimR = radius * 0.72;
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(rimR, rimR, width * 0.9, 32, 1, true), mats.rimDark);
  rim.rotation.z = Math.PI / 2; g.add(rim);
  const face = new THREE.Group(); face.position.x = width * 0.36; g.add(face);
  const lip = new THREE.Mesh(new THREE.TorusGeometry(rimR, 0.012, 6, 36), mats.rim); lip.rotation.y = Math.PI / 2; face.add(lip);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 0.04, 16), mats.rim); hub.rotation.z = Math.PI / 2; face.add(hub);
  const badge = new THREE.Mesh(new THREE.CircleGeometry(0.025, 16), mats.badge); badge.rotation.y = Math.PI / 2; badge.position.x = 0.021; face.add(badge);
  const spokes = 8;
  for (let i = 0; i < spokes; i++) {
    for (const off of [-0.09, 0.09]) {
      const sp = new THREE.Mesh(new THREE.BoxGeometry(0.018, rimR - 0.05, 0.022), mats.rim);
      const a = (i / spokes) * Math.PI * 2 + off;
      sp.position.set(0, Math.cos(a) * (rimR * 0.5 + 0.02), Math.sin(a) * (rimR * 0.5 + 0.02));
      sp.rotation.x = -a + off * 0.8;
      face.add(sp);
    }
  }
  // bromsskiva + ok
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(rimR * 0.85, rimR * 0.85, 0.02, 24), mats.disc);
  disc.rotation.z = Math.PI / 2; disc.position.x = -0.02;
  const spin = new THREE.Group(); spin.add(...g.children.splice(0)); spin.add(disc);
  g.add(spin);
  const caliper = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 0.07), mats.caliper);
  caliper.position.set(0.02, front ? 0.12 : 0.12, front ? -0.12 : 0.12);
  g.add(caliper);
  g.userData.spin = spin;
  return g;
}

// Instrumentpanel ritad på canvas (varvräknare + hastighet, Elise S2-stil)
class DashTexture {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 512; this.canvas.height = 256;
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.anisotropy = 4;
  }
  draw(rpm, kmh, gear, shiftLight) {
    const c = this.ctx, W = 512, H = 256;
    c.fillStyle = '#0b0c0e'; c.fillRect(0, 0, W, H);
    const dial = (cx, cy, r, max, val, step, label, redFrom) => {
      c.save(); c.translate(cx, cy);
      c.fillStyle = '#16181c'; c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#aab0b8'; c.lineWidth = 3; c.beginPath(); c.arc(0, 0, r - 2, 0, Math.PI * 2); c.stroke();
      const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
      if (redFrom) { c.strokeStyle = '#d0202a'; c.lineWidth = 8; c.beginPath(); c.arc(0, 0, r - 12, a0 + (a1 - a0) * redFrom / max, a1); c.stroke(); }
      c.fillStyle = '#e8ecf0'; c.font = 'bold 15px Arial'; c.textAlign = 'center'; c.textBaseline = 'middle';
      for (let v = 0; v <= max; v += step) {
        const a = a0 + (a1 - a0) * v / max;
        c.strokeStyle = '#e8ecf0'; c.lineWidth = 2;
        c.beginPath(); c.moveTo(Math.cos(a) * (r - 8), Math.sin(a) * (r - 8)); c.lineTo(Math.cos(a) * (r - 20), Math.sin(a) * (r - 20)); c.stroke();
        c.fillText(label(v), Math.cos(a) * (r - 34), Math.sin(a) * (r - 34));
      }
      const a = a0 + (a1 - a0) * Math.min(val, max * 1.02) / max;
      c.strokeStyle = '#ff5a1f'; c.lineWidth = 4; c.beginPath(); c.moveTo(-Math.cos(a) * 12, -Math.sin(a) * 12); c.lineTo(Math.cos(a) * (r - 14), Math.sin(a) * (r - 14)); c.stroke();
      c.fillStyle = '#2a2d33'; c.beginPath(); c.arc(0, 0, 10, 0, Math.PI * 2); c.fill();
      c.restore();
    };
    dial(140, 128, 118, 9000, rpm, 1000, v => v / 1000, 8000);
    dial(390, 128, 100, 280, kmh, 40, v => v, 0);
    // digital display
    c.fillStyle = '#20343a'; c.fillRect(100, 175, 80, 40);
    c.fillStyle = '#9ff3ff'; c.font = 'bold 30px monospace'; c.textAlign = 'center';
    c.fillText(gear, 140, 196);
    c.fillStyle = '#20343a'; c.fillRect(350, 170, 80, 34);
    c.fillStyle = '#9ff3ff'; c.font = 'bold 22px monospace'; c.fillText(Math.round(kmh), 390, 188);
    if (shiftLight) { c.fillStyle = '#ff2020'; c.beginPath(); c.arc(256, 26, 12, 0, Math.PI * 2); c.fill(); }
    this.tex.needsUpdate = true;
  }
}

export function buildCarModel(colorHex) {
  const root = new THREE.Group();
  const body = new THREE.Group(); body.position.y = -CG; root.add(body);

  const paint = new THREE.MeshPhysicalMaterial({ color: colorHex, metalness: 0.25, roughness: 0.32, clearcoat: 1.0, clearcoatRoughness: 0.08 });
  const mats = {
    paint,
    black: new THREE.MeshStandardMaterial({ color: 0x0c0c0d, roughness: 0.55 }),
    trim: new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.4, metalness: 0.2 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x0d1418, metalness: 0, roughness: 0.05, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide }),
    lamp: new THREE.MeshPhysicalMaterial({ color: 0xdfe8ee, metalness: 0.9, roughness: 0.05, transparent: true, opacity: 0.85 }),
    tail: new THREE.MeshStandardMaterial({ color: 0x9a0d10, roughness: 0.2, emissive: 0x300000 }),
    tyre: new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.9 }),
    rim: new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.25, metalness: 0.9 }),
    rimDark: new THREE.MeshStandardMaterial({ color: 0x2a2b2e, roughness: 0.5, metalness: 0.6 }),
    disc: new THREE.MeshStandardMaterial({ color: 0x777777, roughness: 0.4, metalness: 0.8 }),
    caliper: new THREE.MeshStandardMaterial({ color: 0xe6c200, roughness: 0.4 }),
    badge: new THREE.MeshStandardMaterial({ color: 0xf1c600, roughness: 0.3, metalness: 0.3 }),
    badgeG: new THREE.MeshStandardMaterial({ color: 0x0b6b2c, roughness: 0.3 }),
    alu: new THREE.MeshStandardMaterial({ color: 0xc9ccd0, roughness: 0.3, metalness: 0.9 }),
    interior: new THREE.MeshStandardMaterial({ color: 0x232427, roughness: 0.8 }),
    leather: new THREE.MeshStandardMaterial({ color: 0x111113, roughness: 0.7 }),
    grille: new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.8, side: THREE.DoubleSide }),
  };

  // --- kaross
  const shell = new THREE.Mesh(bodyGeometry(), paint);
  shell.castShadow = true; shell.receiveShadow = true;
  body.add(shell);
  const exterior = [shell];

  // --- vindruta, tak och sidorutor
  const ws = new THREE.Mesh(quadGeo([[0.70, 0.83, 0.56], [-0.70, 0.83, 0.56], [-0.60, 1.10, 0.02], [0.60, 1.10, 0.02]]), mats.glass);
  body.add(ws);
  // ram runt vindrutan
  for (const s of [1, -1]) {
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, 0.64), mats.black);
    pillar.position.set(s * 0.655, 0.965, 0.29); pillar.rotation.x = Math.atan2(0.27, 0.54); pillar.rotation.z = s * -0.12;
    body.add(pillar);
  }
  const header = new THREE.Mesh(new THREE.BoxGeometry(1.24, 0.05, 0.07), mats.black); header.position.set(0, 1.105, 0.01); body.add(header);
  // hardtop (svart)
  const roofShape = new THREE.Shape();
  roofShape.moveTo(-0.6, 0.02); roofShape.lineTo(0.6, 0.02); roofShape.quadraticCurveTo(0.66, -0.35, 0.68, -0.80); roofShape.lineTo(-0.68, -0.80); roofShape.quadraticCurveTo(-0.66, -0.35, -0.6, 0.02);
  const roofGeo = new THREE.ExtrudeGeometry(roofShape, { depth: 0.03, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 2 });
  const roof = new THREE.Mesh(roofGeo, mats.black); roof.rotation.x = Math.PI / 2; roof.position.y = 1.14; body.add(roof);
  roof.castShadow = true;
  // bakre kåpa/bakruta
  const rearW = new THREE.Mesh(quadGeo([[0.66, 1.12, -0.80], [-0.66, 1.12, -0.80], [-0.74, 0.95, -1.10], [0.74, 0.95, -1.10]]), mats.black); body.add(rearW);
  for (const s of [1, -1]) {
    const sideTri = new THREE.Mesh(quadGeo(s > 0
      ? [[0.82, 0.83, 0.52], [0.80, 0.83, -0.38], [0.66, 1.12, -0.80], [0.62, 1.10, 0.02]]
      : [[-0.82, 0.83, 0.52], [-0.62, 1.10, 0.02], [-0.66, 1.12, -0.80], [-0.80, 0.83, -0.38]]), mats.glass);
    body.add(sideTri);
    const buttress = new THREE.Mesh(quadGeo(s > 0
      ? [[0.80, 0.86, -0.38], [0.84, 0.94, -1.05], [0.74, 0.95, -1.10], [0.66, 1.12, -0.80]]
      : [[-0.80, 0.86, -0.38], [-0.66, 1.12, -0.80], [-0.74, 0.95, -1.10], [-0.84, 0.94, -1.05]]), paint);
    body.add(buttress); exterior.push(buttress);
  }

  // --- front: strålkastare, intag, märke
  for (const s of [1, -1]) {
    const hl = ellipsoid(0.13, 0.075, 0.22, mats.lamp); hl.position.set(s * 0.60, 0.635, 1.93); hl.rotation.set(-0.25, s * 0.35, s * 0.15); body.add(hl);
    const hlIn = ellipsoid(0.11, 0.06, 0.19, mats.black); hlIn.position.copy(hl.position).add(new THREE.Vector3(0, -0.005, -0.01)); hlIn.rotation.copy(hl.rotation); body.add(hlIn);
    const ind = ellipsoid(0.055, 0.035, 0.05, new THREE.MeshStandardMaterial({ color: 0xffb060, roughness: 0.2, transparent: true, opacity: 0.9 }));
    ind.position.set(s * 0.43, 0.53, 2.12); ind.rotation.y = s * 0.5; body.add(ind);
    // sidointag bakom dörren
    const si = ellipsoid(0.03, 0.15, 0.32, mats.grille); si.position.set(s * 0.835, 0.53, -0.62); si.rotation.x = -0.25; body.add(si);
    // backspegel
    const mArm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.02, 0.03), mats.black); mArm.position.set(s * 0.86, 0.86, 0.42); body.add(mArm);
    const mirror = ellipsoid(0.07, 0.05, 0.035, paint, 16); mirror.position.set(s * 0.95, 0.88, 0.42); body.add(mirror);
    const mGlass = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.08), mats.alu); mGlass.position.set(s * 0.95, 0.88, 0.385); mGlass.rotation.y = Math.PI; body.add(mGlass);
    // baklyktor (runda)
    for (const [lx, col] of [[0.60, mats.tail], [0.42, mats.tail]]) {
      const tl = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.058, 0.04, 24), col);
      tl.rotation.x = Math.PI / 2; tl.position.set(s * lx, 0.70, -1.50); body.add(tl);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.008, 6, 24), mats.alu); ring.position.set(s * lx, 0.70, -1.525); body.add(ring);
    }
    // nosens luftintag (sidor)
    const fi = ellipsoid(0.10, 0.055, 0.03, mats.grille); fi.position.set(s * 0.52, 0.36, 2.15); fi.rotation.y = s * 0.45; body.add(fi);
  }
  const intake = ellipsoid(0.36, 0.085, 0.05, mats.grille, 32); intake.position.set(0, 0.36, 2.22); body.add(intake);
  const badge = new THREE.Mesh(new THREE.CircleGeometry(0.035, 24), mats.badge); badge.position.set(0, 0.47, 2.262); badge.rotation.x = -0.4; body.add(badge);
  const badgeIn = new THREE.Mesh(new THREE.CircleGeometry(0.025, 24), mats.badgeG); badgeIn.position.set(0, 0.471, 2.265); badgeIn.rotation.x = -0.4; body.add(badgeIn);
  // huvluftintag (två mörka spår)
  for (const s of [1, -1]) { const hv = ellipsoid(0.16, 0.012, 0.07, mats.grille); hv.position.set(s * 0.2, 0.705, 1.18); hv.rotation.y = s * -0.35; body.add(hv); }
  // bakre galler, avgasrör, nummerplåt
  const rg = new THREE.Mesh(new THREE.PlaneGeometry(0.75, 0.14), mats.grille); rg.position.set(0, 0.45, -1.535); rg.rotation.y = Math.PI; body.add(rg);
  const ex = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.12, 16, 1, true), mats.alu); ex.rotation.x = Math.PI / 2; ex.position.set(0, 0.30, -1.52); body.add(ex);
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.11), new THREE.MeshStandardMaterial({ color: 0xf2f2f2 })); plate.position.set(0, 0.56, -1.545); plate.rotation.y = Math.PI; body.add(plate);
  // underrede
  const floor = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.04, 3.4), mats.black); floor.position.set(0, 0.16, 0.35); body.add(floor);
  // hjulhusens insida
  for (const a of ARCHES) for (const s of [1, -1]) {
    const liner = new THREE.Mesh(new THREE.CylinderGeometry(a.r + 0.01, a.r + 0.01, 0.30, 24, 1, true, 0, Math.PI), mats.black);
    liner.rotation.z = Math.PI / 2; liner.rotation.y = 0; liner.position.set(s * 0.66, a.y, a.z); liner.material = mats.black;
    liner.rotation.x = -Math.PI / 2; liner.rotation.set(0, 0, Math.PI / 2); liner.rotateY(Math.PI / 2);
    body.add(liner);
  }

  // --- hjul
  const wheels = [];
  const W = [
    [ELISE.trackF / 2, ELISE.wheelRadiusF, ELISE.cgToFront, 0.175, true],
    [-ELISE.trackF / 2, ELISE.wheelRadiusF, ELISE.cgToFront, 0.175, true],
    [ELISE.trackR / 2, ELISE.wheelRadiusR, -ELISE.cgToRear, 0.225, false],
    [-ELISE.trackR / 2, ELISE.wheelRadiusR, -ELISE.cgToRear, 0.225, false],
  ];
  for (const [x, r, z, w, front] of W) {
    const wh = makeWheel(r, w, front, mats);
    if (x < 0) wh.scale.x = -1; // spegla så att fälgen är utåt
    wh.position.set(x, 0, z);
    wh.traverse(o => { if (o.isMesh) o.castShadow = true; });
    root.add(wh);
    wheels.push(wh);
  }

  // --- interiör
  const interior = new THREE.Group(); body.add(interior);
  const dash = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.12, 0.30), mats.interior); dash.position.set(0, 0.76, 0.44); interior.add(dash);
  const dashTop = ellipsoid(0.75, 0.05, 0.16, mats.interior, 24); dashTop.position.set(0, 0.82, 0.46); interior.add(dashTop);
  // instrumenthuv framför föraren
  const DRV = 0.34;
  const hood = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.16, 24, 1, true, -Math.PI / 2, Math.PI), mats.interior);
  hood.rotation.x = Math.PI / 2; hood.rotation.y = 0; hood.position.set(DRV, 0.835, 0.36); hood.material.side = THREE.DoubleSide; interior.add(hood);
  const dashTex = new DashTexture();
  const cluster = new THREE.Mesh(new THREE.PlaneGeometry(0.30, 0.15), new THREE.MeshBasicMaterial({ map: dashTex.tex }));
  cluster.position.set(DRV, 0.875, 0.285); cluster.rotation.set(-0.25, Math.PI, 0); interior.add(cluster);
  // ventilationsmunstycken
  for (const vx of [0.66, 0.05, -0.05, -0.66]) {
    const v = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.014, 8, 20), mats.alu); v.position.set(vx, 0.78, 0.29); interior.add(v);
  }
  // ratt
  const steering = new THREE.Group();
  steering.position.set(DRV, 0.79, 0.16);
  steering.rotation.x = -0.42;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.165, 0.019, 10, 40), mats.leather); steering.add(rim);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 0.06, 20), mats.leather); hub.rotation.x = Math.PI / 2; hub.position.z = 0.03; steering.add(hub);
  const sb = new THREE.Mesh(new THREE.CircleGeometry(0.028, 20), mats.badge); sb.position.z = -0.002; sb.rotation.y = Math.PI; steering.add(sb);
  const sbi = new THREE.Mesh(new THREE.CircleGeometry(0.02, 20), mats.badgeG); sbi.position.z = -0.004; sbi.rotation.y = Math.PI; steering.add(sbi);
  for (const a of [0, Math.PI * 0.5, Math.PI]) {
    const sp = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.035, 0.012), mats.alu);
    const ang = a === Math.PI * 0.5 ? -Math.PI / 2 : a;
    sp.position.set(Math.cos(ang) * 0.09, Math.sin(ang) * 0.09, 0.02); sp.rotation.z = ang; steering.add(sp);
  }
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.25, 12), mats.interior); column.rotation.x = Math.PI / 2 - 0.42; column.position.set(DRV, 0.74, 0.28); interior.add(column);
  interior.add(steering);
  // växelspak
  const gearBase = new THREE.Group(); gearBase.position.set(0, 0.45, 0.02); interior.add(gearBase);
  const tunnel = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.28, 0.9), mats.interior); tunnel.position.set(0, 0.32, 0.0); interior.add(tunnel);
  const lever = new THREE.Group(); gearBase.add(lever);
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.011, 0.24, 8), mats.alu); stick.position.y = 0.12; lever.add(stick);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 12), mats.alu); knob.position.y = 0.25; lever.add(knob);
  const boot = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.08, 12), mats.leather); boot.position.y = 0.04; gearBase.add(boot);
  // stolar
  for (const sx of [DRV, -DRV]) {
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.08, 0.48), mats.leather); seat.position.set(sx, 0.28, -0.25); interior.add(seat);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.62, 0.08), mats.leather); back.position.set(sx, 0.6, -0.52); back.rotation.x = -0.22; interior.add(back);
  }
  // aluminiumtrösklar
  for (const s of [1, -1]) {
    const sill = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.28, 1.0), mats.alu); sill.position.set(s * 0.71, 0.36, -0.05); interior.add(sill);
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.26, 0.85), mats.interior); door.position.set(s * 0.79, 0.66, 0.05); interior.add(door);
  }
  // innerbackspegel
  const rv = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.06, 0.02), mats.black); rv.position.set(0, 1.04, 0.06); interior.add(rv);
  const rvg = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.05), mats.alu); rvg.position.set(0, 1.04, 0.048); rvg.rotation.y = Math.PI; interior.add(rvg);

  body.traverse(o => { if (o.isMesh && o.castShadow === false && o !== cluster) o.castShadow = o.material !== mats.glass; });

  return {
    root, wheels, steering, lever, dashTex, paint, exterior,
    eye: new THREE.Vector3(DRV, 1.02 - CG, -0.30),
    setColor(hex) { paint.color.set(hex); },
  };
}

// H-växelns spakposition per växel (x vänster, z fram)
export const LEVER_POS = {
  R: [-0.05, -0.06], N: [0, 0], 1: [0.05, 0.06], 2: [0.05, -0.06], 3: [0, 0.06], 4: [0, -0.06], 5: [-0.05, 0.06], 6: [-0.05, -0.06],
};
