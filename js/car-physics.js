// Fordonsfysik för Lotus Elise S2 (Toyota 2ZZ-GE, 6-växlad manuell).
// Lokala axlar: +Z framåt, +Y upp, +X vänster.
import * as THREE from './lib/three.module.js';
import { SURF_ROAD, SURF_GRASS } from './track.js';

export const ELISE = {
  mass: 950,                  // kg inkl. förare och bränsle
  inertia: [1000, 1150, 330], // pitch(x), yaw(y), roll(z)
  wheelbase: 2.30, cgToFront: 1.426, cgToRear: 0.874,
  trackF: 1.457, trackR: 1.506, cgHeight: 0.45,
  wheelRadiusF: 0.296, wheelRadiusR: 0.311,
  wheelInertiaF: 0.9, wheelInertiaR: 1.25,
  suspDroop: 0.22, staticComp: 0.075, dampRatio: 0.32,
  arbF: 16000, arbR: 9000,
  gears: [-3.250, 0, 3.116, 2.050, 1.481, 1.166, 0.916, 0.815], // index 0 = R, 1 = N, 2.. = 1:an..
  finalDrive: 4.529, driveEff: 0.90,
  idleRpm: 950, redline: 8500, limiter: 8600, engineInertia: 0.14,
  // vridmomentkurva (rpm, Nm) – 2ZZ-GE med VVTL-i lyft vid ~6200
  torque: [[0, 60], [1000, 112], [2000, 135], [3000, 146], [4000, 155], [5000, 160], [6000, 158], [6200, 166], [6800, 182], [7400, 184], [8000, 174], [8500, 158], [9000, 120]],
  clutchMaxTorque: 380,
  brakeF: 1350, brakeR: 700, handbrake: 1600,
  maxSteer: 0.56,  // rad vid hjulen
  cd: 0.43,       // 0.5*rho*Cd*A
  mu: 1.18,
};

function lerpTable(t, x) {
  if (x <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) if (x <= t[i][0]) {
    const a = t[i - 1], b = t[i]; return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
  }
  return t[t.length - 1][1];
}

const RPM = 60 / (2 * Math.PI);
const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3(), tmpV3 = new THREE.Vector3();
const gHit = { y: 0, nx: 0, ny: 1, nz: 0, surf: 0 };

// Magic-formula, normaliserad så att toppen ligger vid s = 1
const MF_C = 1.45, MF_B = 1.856;
const MF = s => Math.sin(MF_C * Math.atan(MF_B * s));

export class CarPhysics {
  constructor(world) {
    const P = this.P = ELISE;
    this.world = world;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.angVel = new THREE.Vector3();
    this.rot = new THREE.Matrix3();
    this.fwd = new THREE.Vector3(); this.up = new THREE.Vector3(); this.left = new THREE.Vector3();

    const g = 9.81, m = P.mass;
    const loadF = m * g * P.cgToRear / P.wheelbase / 2, loadR = m * g * P.cgToFront / P.wheelbase / 2;
    const mk = (x, z, front, staticLoad) => {
      const k = staticLoad / P.staticComp;
      const cm = staticLoad / g;
      return {
        attach: new THREE.Vector3(x, 0.0, z), front, rear: !front, left: x > 0,
        radius: front ? P.wheelRadiusF : P.wheelRadiusR,
        inertia: front ? P.wheelInertiaF : P.wheelInertiaR,
        k, c: 2 * P.dampRatio * Math.sqrt(k * cm), staticLoad,
        comp: 0, prevComp: 0, load: 0, omega: 0, angle: 0, steer: 0,
        contact: false, surf: SURF_ROAD, slipRatio: 0, slipAngle: 0, slide: 0,
        hubLocalY: -P.suspDroop,
        cp: new THREE.Vector3(), n: new THREE.Vector3(0, 1, 0),
      };
    };
    this.wheels = [
      mk(P.trackF / 2, P.cgToFront, true, loadF),   // FL
      mk(-P.trackF / 2, P.cgToFront, true, loadF),  // FR
      mk(P.trackR / 2, -P.cgToRear, false, loadR),  // RL
      mk(-P.trackR / 2, -P.cgToRear, false, loadR), // RR
    ];

    // drivlina
    this.gear = 1;           // index i P.gears (1 = neutral)
    this.engineOmega = P.idleRpm / RPM;
    this.clutchLocked = false;
    this.stalled = false; this.stallTimer = 0;
    this.limiterCut = false;
    this.engineTorque = 0; this.throttleEff = 0;
    this.grind = 0;          // >0 när växel skrapar
    this.shiftTimer = 0;

    // indata
    this.input = { steer: 0, throttle: 0, brake: 0, clutch: 0, handbrake: 0 };
    this.settings = { autoClutch: true, requireClutch: false, automatic: false, absAssist: false, tcAssist: false };

    // kollisionspunkter i karossen
    this.bodyPoints = [
      [0, 0.0, 2.2], [0.72, 0.0, 1.95], [-0.72, 0.0, 1.95], [0.86, 0.05, 0.6], [-0.86, 0.05, 0.6],
      [0.86, 0.05, -0.6], [-0.86, 0.05, -0.6], [0.78, 0.05, -1.4], [-0.78, 0.05, -1.4], [0, 0.05, -1.55],
    ].map(a => new THREE.Vector3(...a));
    this.impact = 0;
    this.airTime = 0;
    this.speed = 0;
    this.distance = 0;
  }

  get rpm() { return this.engineOmega * RPM; }
  get gearLabel() { return this.gear === 0 ? 'R' : this.gear === 1 ? 'N' : String(this.gear - 1); }
  get ratio() { return this.P.gears[this.gear] * this.P.finalDrive; }

  place(pos, forward) {
    const up = new THREE.Vector3(0, 1, 0);
    const f = forward.clone(); f.y = 0; f.normalize();
    const l = new THREE.Vector3().crossVectors(up, f).normalize();
    const m = new THREE.Matrix4().makeBasis(l, up, f);
    this.quat.setFromRotationMatrix(m);
    this.pos.copy(pos);
    this.vel.set(0, 0, 0); this.angVel.set(0, 0, 0);
    for (const w of this.wheels) { w.omega = 0; w.comp = w.prevComp = this.P.staticComp; }
    this.engineOmega = this.P.idleRpm / RPM; this.stalled = false;
    this.clutchLocked = false;
    this.updateBasis();
  }

  updateBasis() {
    this.quat.normalize();
    const m = new THREE.Matrix4().makeRotationFromQuaternion(this.quat);
    this.rot.setFromMatrix4(m);
    const e = m.elements;
    this.left.set(e[0], e[1], e[2]); this.up.set(e[4], e[5], e[6]); this.fwd.set(e[8], e[9], e[10]);
  }

  // Begär växel (H-växel: absolut växel, -1 = R, 0 = N, 1..6)
  requestGear(g) {
    const idx = g < 0 ? 0 : g + 1;
    if (idx === this.gear) return true;
    if (idx === 1) { this.gear = 1; this.clutchLocked = false; return true; }
    const clutchIn = this.clutchEngagement() < 0.35;
    if (this.settings.requireClutch && !this.settings.autoClutch && !clutchIn) {
      this.grind = 0.35; this.gear = 1; return false;
    }
    if (idx === 0 && this.speedSigned > 2) { this.grind = 0.35; return false; }
    this.gear = idx; this.clutchLocked = false; this.shiftTimer = 0.14;
    return true;
  }
  shiftUp() { if (this.gear < this.P.gears.length - 1) return this.requestGear(this.gear === 0 ? 0 : this.gear); return false; }
  shiftDown() { if (this.gear > 0) return this.requestGear(this.gear - 2); return false; }

  clutchEngagement() {
    const pedal = 1 - this.input.clutch;
    if (!this.settings.autoClutch && !this.settings.automatic) return pedal;
    // automatisk koppling
    let a = 1;
    if (this.shiftTimer > 0) a = 0;
    const rpm = this.rpm;
    const wheelRpm = Math.abs(this.rearOmega() * this.ratio) * RPM;
    if (this.gear !== 1 && wheelRpm < 2600) {
      // starta från stillastående: koppla in mjukt beroende på varvtal
      // mer gas = högre startvarv innan kopplingen tar (som en förare som "slirar" iväg)
      const launch = 1050 + this.input.throttle * 1900;
      const target = THREE.MathUtils.clamp((rpm - launch) / 1300, 0, 1);
      a = Math.min(a, this.input.throttle > 0.02 ? target : Math.min(target, wheelRpm > 1300 ? 1 : 0));
    }
    return Math.min(a, pedal);
  }
  rearOmega() { return (this.wheels[2].omega + this.wheels[3].omega) * 0.5; }

  step(dt) {
    const P = this.P, W = this.wheels, inp = this.input;
    this.updateBasis();
    const m = P.mass;
    const force = tmpV.set(0, -9.81 * m, 0);
    const torque = new THREE.Vector3();
    const pos = this.pos, vel = this.vel, angVel = this.angVel;
    this.speedSigned = vel.dot(this.fwd);
    const speed = vel.length();
    if (this.shiftTimer > 0) this.shiftTimer -= dt;
    if (this.grind > 0) this.grind -= dt;

    // ---- styrning (Ackermann)
    const steerAng = -inp.steer * P.maxSteer;
    const tanS = Math.tan(steerAng);
    if (Math.abs(tanS) > 1e-4) {
      const R = P.wheelbase / tanS;
      W[0].steer = Math.atan(P.wheelbase / (R - P.trackF / 2));
      W[1].steer = Math.atan(P.wheelbase / (R + P.trackF / 2));
    } else { W[0].steer = W[1].steer = 0; }
    W[2].steer = W[3].steer = 0;

    // ---- fjädring
    let contacts = 0;
    for (const w of W) {
      const a = tmpV2.copy(w.attach).applyMatrix3(this.rot).add(pos);
      // bara mark under fjäderfästet kan bära hjulet (annars "klättrar" bilen upp på murkrön)
      const hit = this.world.groundAt(a.x, a.z, a.y + 0.05, gHit);
      w.contact = false;
      if (hit) {
        const ndu = hit.nx * this.up.x + hit.ny * this.up.y + hit.nz * this.up.z;
        const t = hit.ny * (a.y - hit.y) / Math.max(0.2, ndu);
        const comp = P.suspDroop + w.radius - t;
        if (comp > 0) {
          w.contact = true; contacts++;
          w.comp = Math.min(comp, 0.25);
          w.n.set(hit.nx, hit.ny, hit.nz);
          w.surf = hit.surf;
          w.cp.copy(a).addScaledVector(this.up, -t);
        } else w.comp = 0;
      } else w.comp = 0;
      w.hubLocalY = -P.suspDroop + w.comp;
    }
    // krängningshämmare
    const arb = [(W[0].comp - W[1].comp) * P.arbF, (W[2].comp - W[3].comp) * P.arbR];

    // ---- drivlina: motor
    const ratio = this.ratio;
    let thr = inp.throttle;
    const rpm = this.rpm;
    if (this.stalled) {
      this.stallTimer += dt;
      if (this.stallTimer > 1.2 && (this.gear === 1 || this.clutchEngagement() < 0.1)) { this.stalled = false; this.engineOmega = P.idleRpm / RPM; }
    }
    // tomgångsregulator
    const idleT = THREE.MathUtils.clamp((P.idleRpm + 50 - rpm) / 400, 0, 0.35);
    thr = Math.max(thr, idleT);
    if (this.settings.tcAssist && this.gear > 1) {
      const rs = Math.max(W[2].slipRatio, W[3].slipRatio);
      if (rs > 0.12) thr *= THREE.MathUtils.clamp(1 - (rs - 0.12) * 6, 0, 1);
    }
    if (rpm > P.limiter) this.limiterCut = true; else if (rpm < P.limiter - 250) this.limiterCut = false;
    if (this.limiterCut) thr = 0;
    if (this.stalled) thr = 0;
    this.throttleEff = thr;
    const full = lerpTable(P.torque, rpm);
    const friction = 14 + rpm * 0.0042 + (rpm / 1000) ** 2 * 0.5;
    let Te = thr * (full + friction) - friction;
    if (this.stalled && rpm < 50) Te = Math.max(Te, -this.engineOmega * P.engineInertia / dt);
    this.engineTorque = Te;

    // automatisk växellåda
    if (this.settings.automatic && this.gear >= 2 && this.shiftTimer <= 0) {
      if (rpm > 8150 && this.gear < P.gears.length - 1) { this.gear++; this.shiftTimer = 0.16; }
      else if (rpm < (inp.throttle > 0.6 ? 4800 : 2600) && this.gear > 2) {
        const nr = P.gears[this.gear - 1] * P.finalDrive;
        if (Math.abs(this.rearOmega() * nr) * RPM < 7600) { this.gear--; this.shiftTimer = 0.16; }
      }
    }

    // koppling
    const engage = this.gear === 1 ? 0 : this.clutchEngagement();
    const wt = this.rearOmega() * ratio;
    const slip = this.engineOmega - wt;
    if (engage > 0.97 && Math.abs(slip) < 4 && this.gear !== 1 && !this.stalled) this.clutchLocked = true;
    if (engage < 0.97 || this.gear === 1) this.clutchLocked = false;

    let driveTorqueEach = 0, clutchImplicit = 0, lockedInertia = 0;
    if (this.clutchLocked) {
      driveTorqueEach = Te * ratio * P.driveEff * 0.5;
      lockedInertia = P.engineInertia * ratio * ratio * 0.5;
    } else if (this.gear !== 1 && engage > 0) {
      const cap = P.clutchMaxTorque * engage;
      const band = 25;
      const Tc = THREE.MathUtils.clamp(slip / band, -1, 1) * cap;
      const slope = Math.abs(slip) < band ? cap / band : 0;
      // motor (implicit mot kopplingen)
      this.engineOmega += (Te - Tc) / (P.engineInertia / dt + slope);
      driveTorqueEach = Tc * ratio * P.driveEff * 0.5;
      clutchImplicit = slope * ratio * ratio * 0.5;
    } else {
      this.engineOmega += Te / P.engineInertia * dt;
    }
    if (this.engineOmega < 0) this.engineOmega = 0;

    // ---- däck & krafter per hjul
    let slideSum = 0;
    for (let i = 0; i < 4; i++) {
      const w = W[i];
      const r = tmpV3.copy(w.attach).applyMatrix3(this.rot);
      if (!w.contact) {
        w.load = 0; w.slide = 0; w.slipRatio = 0;
        // fritt snurrande hjul
        let Td = w.rear ? driveTorqueEach : 0;
        const I = w.inertia + (w.rear ? lockedInertia + clutchImplicit * dt : 0);
        w.omega += Td / I * dt;
        const bt = (w.front ? P.brakeF : P.brakeR) * inp.brake + (w.rear ? P.handbrake * inp.handbrake : 0);
        const bd = bt / I * dt; w.omega = Math.abs(w.omega) <= bd ? 0 : w.omega - Math.sign(w.omega) * bd;
        w.angle += w.omega * dt;
        continue;
      }
      const cpRel = new THREE.Vector3().subVectors(w.cp, pos);
      // fjäderkraft
      const compRate = (w.comp - w.prevComp) / dt; w.prevComp = w.comp;
      let Fs = w.k * w.comp + w.c * compRate;
      Fs += (w.left ? 1 : -1) * arb[w.front ? 0 : 1] * (w.front ? 1 : 1);
      if (w.comp > 0.13) Fs += (w.comp - 0.13) * 400000; // bump stop
      Fs = Math.max(0, Fs);
      w.load = Fs;
      const n = w.n;
      const ndu = Math.max(0.3, n.dot(this.up));
      const Fn = Fs * ndu;

      // hjulets riktning
      const wf = new THREE.Vector3().copy(this.fwd).multiplyScalar(Math.cos(w.steer)).addScaledVector(this.left, Math.sin(w.steer));
      wf.addScaledVector(n, -wf.dot(n)).normalize();
      const wl = new THREE.Vector3().crossVectors(n, wf);
      // kontaktpunktens hastighet
      const vp = new THREE.Vector3().crossVectors(angVel, cpRel).add(vel);
      const vLong = vp.dot(wf), vLat = vp.dot(wl);

      const surfMu = w.surf === SURF_GRASS ? 0.62 : 1.0;
      const loadSens = 1 - 0.07 * (Fn / w.staticLoad - 1);
      const muN = P.mu * surfMu * loadSens * Fn;
      const kp = 0.11, ap = 0.115;
      const den = Math.max(Math.abs(vLong), 2.5);
      const tanA = vLat / Math.max(Math.abs(vLong), 1.6);

      const tyre = (kappa) => {
        const sx = kappa / kp, sy = tanA / ap;
        const s = Math.hypot(sx, sy);
        if (s < 1e-6) return [0, 0];
        const f = muN * MF(s) / s;
        return [f * sx, -f * sy];
      };
      const I = w.inertia + (w.rear ? lockedInertia : 0);
      const kappa0 = (w.omega * w.radius - vLong) / den;
      const [Fx0] = tyre(kappa0);
      const eps = 0.002;
      const Kk = (tyre(kappa0 + eps)[0] - Fx0) / eps;
      const K = Math.max(0, Kk) * w.radius / den;
      let Td = w.rear ? driveTorqueEach : 0;
      const denomI = I / dt + w.radius * K + (w.rear ? clutchImplicit : 0);
      let omegaNew = w.omega + (Td - w.radius * Fx0) / denomI;
      // broms (friktion mot noll)
      let bt = (w.front ? P.brakeF : P.brakeR) * inp.brake + (w.rear ? P.handbrake * inp.handbrake : 0);
      if (this.settings.absAssist && inp.brake > 0 && Math.abs(vLong) > 3) {
        const sr = (w.omega * w.radius - vLong) / den;
        if (sr < -0.13) bt *= 0.35;
      }
      const bImp = bt / denomI;
      if (Math.abs(omegaNew) <= bImp) omegaNew = 0; else omegaNew -= Math.sign(omegaNew) * bImp;
      // rullmotstånd
      omegaNew -= Math.sign(omegaNew) * Math.min(Math.abs(omegaNew), 20 / denomI);
      // diff-koppling (lätt spärr)
      const kappa1 = (omegaNew * w.radius - vLong) / den;
      w.omega = omegaNew;
      w.angle += w.omega * dt;
      const [Fx, Fy] = tyre(kappa1);
      w.slipRatio = Math.abs(kappa1);
      w.slipAngle = Math.atan(tanA);
      const sl = Math.hypot(kappa1 / kp, tanA / ap);
      w.slide = Math.max(0, Math.min(1, (sl - 0.75) / 1.5)) * Math.min(1, speed / 4);
      slideSum += w.slide;
      // gräs: extra motstånd
      let Fdrag = 0;
      if (w.surf === SURF_GRASS) Fdrag = -Math.sign(vLong) * Math.min(Math.abs(vLong) * 120, 900);

      const F = new THREE.Vector3().copy(n).multiplyScalar(Fs * ndu)
        .addScaledVector(this.up, 0)
        .addScaledVector(wf, Fx + Fdrag).addScaledVector(wl, Fy);
      force.add(F);
      torque.add(new THREE.Vector3().crossVectors(cpRel, F));
    }
    this.slide = slideSum / 4;
    // spärrdiff: utjämna bakhjulens varvtal en aning
    if (this.gear !== 1) {
      const d = W[2].omega - W[3].omega;
      const k = Math.min(0.5, 6 * dt);
      W[2].omega -= d * k * 0.5; W[3].omega += d * k * 0.5;
    }
    // motorvarv följer hjulen när kopplingen är låst
    if (this.clutchLocked) {
      this.engineOmega = Math.max(0, this.rearOmega() * ratio);
      if (this.rpm < 380 && !this.settings.autoClutch && !this.settings.automatic) {
        this.stalled = true; this.stallTimer = 0; this.clutchLocked = false; this.engineOmega = 0;
      }
    } else if (!this.stalled && this.rpm < 300 && this.gear !== 1 && engage > 0.6) {
      this.stalled = true; this.stallTimer = 0; this.engineOmega = 0;
    }

    // aerodynamik
    const vf = this.speedSigned;
    force.addScaledVector(vel, -P.cd * speed);
    force.addScaledVector(this.up, -0.045 * vf * vf);

    // ---- integrering
    vel.addScaledVector(force, dt / m);
    pos.addScaledVector(vel, dt);

    // rotation i kroppskoordinater
    const rotT = this.rot.clone().transpose();
    const tb = torque.clone().applyMatrix3(rotT);
    const wb = angVel.clone().applyMatrix3(rotT);
    const I = P.inertia;
    const Iw = new THREE.Vector3(I[0] * wb.x, I[1] * wb.y, I[2] * wb.z);
    const gyro = new THREE.Vector3().crossVectors(wb, Iw);
    wb.x += (tb.x - gyro.x) / I[0] * dt;
    wb.y += (tb.y - gyro.y) / I[1] * dt;
    wb.z += (tb.z - gyro.z) / I[2] * dt;
    angVel.copy(wb.applyMatrix3(this.rot));
    if (contacts > 0 && speed < 0.3 && inp.throttle < 0.05) angVel.multiplyScalar(0.98);
    const q = this.quat;
    const dq = new THREE.Quaternion(angVel.x * dt * 0.5, angVel.y * dt * 0.5, angVel.z * dt * 0.5, 0).multiply(q);
    q.x += dq.x; q.y += dq.y; q.z += dq.z; q.w += dq.w; q.normalize();
    this.updateBasis();

    // ---- räcken och väggar
    this.collide(dt);

    // parkering: håll bilen still vid låg fart och broms/handbroms
    if (contacts >= 3 && speed < 0.25 && (inp.brake > 0.2 || inp.handbrake > 0.2) ) {
      vel.multiplyScalar(0.8);
    }
    this.contacts = contacts;
    this.airTime = contacts === 0 ? this.airTime + dt : 0;
    this.speed = vel.length();
    this.distance += Math.max(0, this.speedSigned) * dt;
  }

  collide(dt) {
    const push = new THREE.Vector3();
    let maxImp = 0;
    for (const lp of this.bodyPoints) {
      const wp = tmpV2.copy(lp).applyMatrix3(this.rot).add(this.pos);
      const r = 0.32;
      if (!this.world.wallPush(wp.x, wp.y, wp.z, r, push)) continue;
      const len = push.length(); if (len < 1e-5) continue;
      const nrm = push.clone().divideScalar(len);
      this.pos.addScaledVector(push, 0.8);
      const rel = new THREE.Vector3().subVectors(wp, this.pos);
      const vp = new THREE.Vector3().crossVectors(this.angVel, rel).add(this.vel);
      const vn = vp.dot(nrm);
      if (vn >= 0) continue;
      // impuls med rotation
      const invI = this.invInertiaWorld();
      const rxn = new THREE.Vector3().crossVectors(rel, nrm);
      const ang = rxn.clone().applyMatrix3(invI).cross(rel).dot(nrm);
      const e = 0.15;
      const j = -(1 + e) * vn / (1 / this.P.mass + ang);
      const J = nrm.clone().multiplyScalar(j);
      // friktion längs väggen
      const vt = vp.clone().addScaledVector(nrm, -vn);
      const vtl = vt.length();
      if (vtl > 1e-3) J.addScaledVector(vt, -Math.min(0.35 * j, vtl * this.P.mass * 0.3) / vtl);
      this.vel.addScaledVector(J, 1 / this.P.mass);
      this.angVel.add(new THREE.Vector3().crossVectors(rel, J).applyMatrix3(invI));
      maxImp = Math.max(maxImp, -vn);
    }
    if (maxImp > this.impact) this.impact = maxImp;
  }

  invInertiaWorld() {
    const I = this.P.inertia;
    const R = this.rot, RT = R.clone().transpose();
    const D = new THREE.Matrix3().set(1 / I[0], 0, 0, 0, 1 / I[1], 0, 0, 0, 1 / I[2]);
    return R.clone().multiply(D).multiply(RT);
  }
}
