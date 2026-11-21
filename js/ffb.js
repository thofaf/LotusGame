// Force feedback (rattens motkraft). Webbläsarens Gamepad API kan inte styra rattmotorer, så
// krafterna skickas via WebSocket till serverns brygga (ffb/FfbBridge.cs) som styr ratten
// med DirectInput. Fungerar bara när spelet startas via "Starta spelet.bat".
//
// Kraften byggs av:
//  • självcentrerande moment: framdäckens sidokraft × (mekaniskt + pneumatiskt trail). Det pneumatiska
//    trailet minskar när slipvinkeln växer, så ratten blir lättare när framhjulen tappar greppet.
//  • stötar från ojämnheter (skillnad i fjädring vänster/höger fram) och krockar
//  • ändstopp när ratten vrids förbi bilens rattutslag
//  • dämpning (tyngre vid låg fart – Elisen saknar servo) och vibration på gräs/vägbana
// Tecken: + = kraften vrider ratten åt höger.

import { SURF_GRASS } from './track.js';

const MZ_FULL = 100;      // Nm (summa båda framhjul) som motsvarar full kraft vid styrka 1
const MECH_TRAIL = 0.010;  // m (caster)
const PNEU_TRAIL = 0.030;  // m vid rakt fram
const ALPHA_ZERO = 0.20;   // rad: pneumatiskt trail har gått till noll
const SEND_MIN_MS = 6;

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class ForceFeedback {
  constructor(settings, log = () => {}) {
    this.S = settings; this.log = log;
    this.ws = null; this.open = false;
    this.status = 'Ansluter till hjälpprogrammet…'; this.state = 'wait'; // 'ok' | 'wait' | 'err'
    this.onStatus = null;
    this.force = 0; this.clip = 0;           // senaste kraft (för visning)
    this.fz = 0;                              // filtrerat moment
    this.kick = 0; this.impact = 0; this.lastComp = null;
    this.testT = -1; this.lastSend = 0; this.hello = '';
    this.retry = 0;
  }
  get connected() { return this.open && this.state === 'ok'; }

  connect() {
    if (this.ws) return;
    if (location.protocol !== 'http:') { this.setStatus('err', 'Starta spelet via "Starta spelet.bat" för force feedback'); return; }
    let ws;
    try { ws = new WebSocket(`ws://${location.host}/__ffb`); } catch { this.scheduleRetry(); return; }
    this.ws = ws;
    ws.onopen = () => { this.open = true; this.retry = 0; this.hello = ''; };
    ws.onmessage = e => {
      const m = String(e.data), sp = m.indexOf(' ');
      const kind = sp < 0 ? m : m.slice(0, sp), text = sp < 0 ? '' : m.slice(sp + 1);
      this.setStatus(kind === 'OK' ? 'ok' : kind === 'ERR' ? 'err' : 'wait', kind === 'OK' ? 'Ansluten: ' + text : text);
    };
    ws.onclose = () => {
      const was = this.open;
      this.ws = null; this.open = false;
      if (was || this.state !== 'err') this.setStatus('err', 'Hjälpprogrammet svarar inte – starta spelet via "Starta spelet.bat"');
      this.scheduleRetry();
    };
  }
  scheduleRetry() { clearTimeout(this.retryTimer); this.retryTimer = setTimeout(() => this.connect(), Math.min(10000, 2000 + this.retry++ * 1000)); }
  setStatus(state, text) {
    if (state === this.state && text === this.status) return;
    this.state = state; this.status = text; this.log('ffb: ' + text);
    if (this.onStatus) this.onStatus(state, text);
  }
  send(s) { if (this.open && this.ws.readyState === 1) this.ws.send(s); }
  stop() { this.send('S'); }

  // Vilken ratt som används för styrning (Gamepad-id innehåller vendor/product).
  setDevice(id) {
    if (!id || id === this.hello) return;
    const m = /Vendor:\s*([0-9a-f]{4}).*Product:\s*([0-9a-f]{4})/i.exec(id) || /^([0-9a-f]{4})-([0-9a-f]{4})-/i.exec(id);
    if (m && this.open) { this.send(`H ${m[1]} ${m[2]}`); this.hello = id; }
  }

  addImpact(v) { this.impact = Math.max(this.impact, v); }
  startTest() { this.testT = 0; }

  // car: CarPhysics, steerDeg: rattens vinkel i grader (null utan kalibrerad ratt), lockDeg: bilens rattutslag
  update(dt, car, active, steerDeg, lockDeg) {
    const S = this.S;
    let force = 0, damper = 0, rumble = 0, period = 30;

    if (this.testT >= 0) {
      // test: höger, vänster, vibration
      this.testT += dt;
      const t = this.testT;
      if (t < 1.2) force = 0.35 * smooth(0, 0.3, t);
      else if (t < 2.4) force = -0.35 * smooth(1.2, 1.5, t);
      else if (t < 3.4) { rumble = 0.5; period = 40; }
      else this.testT = -1;
      if (S.ffbInvert) force = -force;
      this.output(force, 0.15, rumble, period, force);
      return;
    }

    if (!active || !S.ffbEnabled || !car) {
      this.fz = 0; this.kick = 0; this.impact = 0; this.lastComp = null;
      this.output(0, 0, 0, period, 0);
      return;
    }

    const W = car.wheels, v = car.speed;
    // --- självcentrerande moment (Nm, + = vrider ratten åt höger)
    let mz = 0;
    for (const w of [W[0], W[1]]) {
      if (!w.contact) continue;
      const a = Math.abs(w.slipAngle || 0);
      const trail = MECH_TRAIL + PNEU_TRAIL * Math.max(0, 1 - a / ALPHA_ZERO);
      mz += (w.Fy || 0) * trail;
    }
    mz *= smooth(0.3, 3, v);                    // inget däckmoment när bilen står still
    if (car.speedSigned < -0.5) mz *= 0.4;      // backning: svagare och instabilt i verkligheten
    this.fz += (mz - this.fz) * (1 - Math.exp(-dt / 0.012));
    force = this.fz / MZ_FULL;

    // --- stötar: ojämnhet under ett framhjul ger en ryck i ratten
    const comp = [W[0].comp, W[1].comp];
    if (this.lastComp && dt > 0) {
      const d = ((comp[0] - this.lastComp[0]) - (comp[1] - this.lastComp[1])) / dt; // m/s
      this.kick += Math.max(-1, Math.min(1, d * 0.35)) * S.ffbRoad;
    }
    this.lastComp = comp;
    if (this.impact > 1.5) this.kick += (Math.random() < 0.5 ? -1 : 1) * Math.min(1, this.impact / 12) * S.ffbRoad;
    this.impact = 0;
    this.kick *= Math.exp(-dt / 0.05);
    force += this.kick * 0.5;

    force *= S.ffbGain;

    // --- ändstopp när ratten vrids förbi bilens rattutslag
    if (steerDeg !== null && Math.abs(steerDeg) > lockDeg) {
      force += -Math.sign(steerDeg) * Math.min(1, (Math.abs(steerDeg) - lockDeg) / 12);
    }

    // minsta kraft (kompenserar dödzon/friktion i svagare rattar)
    const mn = S.ffbMinForce;
    if (mn > 0 && Math.abs(force) > 0.003) force = Math.sign(force) * (mn + (1 - mn) * Math.abs(force));
    const raw = force;
    force = Math.max(-1, Math.min(1, force));

    // --- dämpning: tung vid parkering, lättare i fart
    damper = S.ffbDamper * (0.35 + 0.65 * (1 - smooth(0, 10, v)));

    // --- vibration: gräs/grus och vägbanans struktur
    const front = W[0].contact || W[1].contact;
    const grass = W.filter(w => w.contact && w.surf === SURF_GRASS).length / 4;
    const sp = smooth(1, 20, v);
    rumble = front ? S.ffbRoad * sp * (grass * 0.45 + 0.03) : 0;
    period = grass > 0 ? Math.round(55 - 25 * smooth(3, 25, v)) : Math.round(28 - 12 * smooth(5, 40, v));

    if (S.ffbInvert) force = -force;
    this.output(force, damper, rumble, period, raw);
  }

  output(force, damper, rumble, period, raw) {
    this.force = force;
    this.clip = Math.abs(raw) > 1 ? 1 : this.clip * 0.97;
    const now = performance.now();
    if (now - this.lastSend < SEND_MIN_MS) return;
    this.lastSend = now;
    this.send(`F ${force.toFixed(4)} ${damper.toFixed(3)} ${rumble.toFixed(3)} ${period}`);
  }
}
