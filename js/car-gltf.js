// Lotus Elise från glTF-modell (assets/2018_lotus_elise_sprint_220).
// Modell: "2018 Lotus Elise Sprint 220" av Ddiaz Design, CC-BY-NC-SA-4.0 (se license.txt i mappen).
// Ger samma gränssnitt som buildCarModel() i car-model.js men med setWheels()/setSteer().
// Lokala axlar (som fysiken): +Z fram, +Y upp, +X vänster. Origo i tyngdpunkten.
import * as THREE from './lib/three.module.js';
import { GLTFLoader } from './lib/addons/loaders/GLTFLoader.js';
import { ELISE } from './car-physics.js';

const URL = 'assets/2018_lotus_elise_sprint_220/scene.gltf';
const LENGTH = 3.824; // Elise S3, meter
const WHEELS = ['FL', 'FR', 'BL', 'BR']; // samma ordning som fysiken: FL, FR, RL, RR

export async function loadCarModel(colorHex, renderer) {
  const gltf = await new GLTFLoader().loadAsync(URL);
  const src = gltf.scene;

  // --- skala till verklig längd (filen har en 1/100-skala i rotnoden) och placera på marken
  src.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(src);
  const size = box.getSize(new THREE.Vector3());
  src.scale.multiplyScalar(LENGTH / size.z);
  src.updateMatrixWorld(true);

  const root = new THREE.Group();           // följer fysikkroppen (origo = tyngdpunkt)
  const body = new THREE.Group(); root.add(body);
  body.add(src);
  root.updateMatrixWorld(true);

  // --- hitta delarna
  const parts = { FL: [], FR: [], BL: [], BR: [] }, calipers = { FL: [], FR: [], BL: [], BR: [] };
  let steerGroup = null, paint = null;
  src.traverse(o => {
    const m = /wheel(FL|FR|BL|BR)_(caliper|tire|rims|details)/.exec(o.name);
    if (m && o.isMesh) (m[2] === 'caliper' ? calipers : parts)[m[1]].push(o);
    if (!steerGroup && /steering_wheel/.test(o.name)) steerGroup = o.parent;
    if (o.isMesh) {
      o.castShadow = true; o.receiveShadow = true;
      if (o.material.name === 'carpaint') paint = o.material;
    }
  });

  // --- material: spelet renderar utan sRGB-omvandling (som banan), så texturer och färger används "rått"
  const seen = new Set();
  src.traverse(o => {
    if (!o.isMesh || seen.has(o.material)) return; seen.add(o.material);
    const mat = o.material;
    for (const k of ['map', 'emissiveMap']) if (mat[k]) { mat[k].colorSpace = THREE.NoColorSpace; mat[k].needsUpdate = true; }
    if (mat.color && !mat.map) mat.color.convertLinearToSRGB();
    if (mat.name === 'glass') {
      // transmission kräver ett extra renderingspass – ersätts med vanlig genomskinlighet
      mat.transmission = 0; mat.transmissionMap = null;
      mat.transparent = true; mat.opacity = 0.32; mat.depthWrite = false;
      mat.color.setRGB(0.12, 0.14, 0.16); mat.roughness = 0.05; mat.metalness = 0;
      o.castShadow = false;
    }
    if (mat.name === 'mirror') { mat.metalness = 1; mat.roughness = 0.02; mat.color.setRGB(0.9, 0.9, 0.9); }
    mat.envMapIntensity = 0.9;
  });
  if (paint) {
    paint.clearcoat = 1; paint.clearcoatRoughness = 0.06;
    paint.metalness = 0.15; paint.roughness = 0.3;
  }

  // --- flytta modellen så att tyngdpunkten hamnar i origo och hjulen över fysikens hjul
  box = new THREE.Box3();
  const centre = k => new THREE.Box3().setFromObject(parts[k].find(p => /tire/.test(p.name)) || parts[k][0]).getCenter(new THREE.Vector3());
  const cFL = centre('FL'), cBL = centre('BL');
  const shiftZ = (ELISE.cgToFront - ELISE.cgToRear) / 2 - (cFL.z + cBL.z) / 2;
  body.position.set(0, -ELISE.cgHeight, shiftZ);
  root.updateMatrixWorld(true);

  // --- hjul: pivot (fjädring + styrning) → spin (rotation) → däck/fälg/detaljer
  const wheels = [];
  for (const k of WHEELS) {
    const tyre = parts[k].find(p => /tire/.test(p.name));
    const tb = new THREE.Box3().setFromObject(tyre);
    const c = tb.getCenter(new THREE.Vector3());           // i root-koordinater
    const radius = (tb.max.y - tb.min.y) / 2;
    const pivot = new THREE.Group(); pivot.position.copy(c); root.add(pivot);
    const spin = new THREE.Group(); pivot.add(spin);
    root.updateMatrixWorld(true);
    for (const p of parts[k]) spin.attach(p);
    for (const p of calipers[k]) pivot.attach(p);
    const front = k[0] === 'F';
    const physR = front ? ELISE.wheelRadiusF : ELISE.wheelRadiusR;
    wheels.push({ pivot, spin, baseX: c.x, baseZ: c.z, yOffset: radius - physR });
  }

  // --- ratt: rotera kring rattstångens axel (gruppens lokala Z) genom rattens mitt
  let steerPivot = null, steerAxis = null;
  if (steerGroup) {
    const sb = new THREE.Box3().setFromObject(steerGroup);
    const sc = sb.getCenter(new THREE.Vector3());
    steerAxis = new THREE.Vector3(0, 0, 1).transformDirection(steerGroup.matrixWorld);
    // root har identitetsrotation vid laddning → världsriktning = root-riktning
    steerPivot = new THREE.Group(); steerPivot.position.copy(sc); root.add(steerPivot);
    root.updateMatrixWorld(true);
    steerPivot.attach(steerGroup);
  }

  // --- förarens ögonposition: bakom och ovanför ratten
  const eye = steerPivot
    ? new THREE.Vector3(steerPivot.position.x, steerPivot.position.y + 0.25, steerPivot.position.z - 0.52)
    : new THREE.Vector3(0.25, 0.53, 0.07);

  const api = {
    root, eye, paint, steeringAxis: steerAxis, wheelsVisual: wheels, dashTex: null, lever: null,
    credit: 'Bilmodell: "2018 Lotus Elise Sprint 220" av Ddiaz Design (CC-BY-NC-SA-4.0)',
    setColor(hex) { if (paint) paint.color.set(hex); },
    // w: fysikens hjul (hubLocalY, steer, angle)
    setWheels(physWheels) {
      for (let i = 0; i < 4; i++) {
        const v = wheels[i], w = physWheels[i];
        v.pivot.position.set(v.baseX, w.hubLocalY + v.yOffset, v.baseZ);
        v.pivot.rotation.set(0, w.steer, 0);
        v.spin.rotation.x = w.angle;
      }
    },
    // vinkel i radianer, + = höger (medurs sett från föraren)
    setSteer(angle) {
      if (steerPivot) steerPivot.quaternion.setFromAxisAngle(steerAxis, -angle);
    },
  };
  api.setColor(colorHex);
  return api;
}
