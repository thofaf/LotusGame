// Inmatning: Thrustmaster-ratt/pedaler/H-växel (Gamepad API), tangentbord och handkontroll.
// Thrustmaster-enheter rapporterar olika axel-/knappnummer beroende på modell (T150, TMX, T248,
// T300, TS-XW, T-GT, TH8A, T3PA/T-LCM ...) och på om pedaler/växel sitter i rattbasen eller via USB.
// Därför kalibreras allt via en guide och sparas per enhets-ID i localStorage.

const STORE = 'lotus.bindings.v1';
const SETTINGS = 'lotus.settings.v1';

export const ACTIONS_BUTTON = [
  ['gear1', '1:ans växel'], ['gear2', '2:ans växel'], ['gear3', '3:ans växel'], ['gear4', '4:ans växel'],
  ['gear5', '5:ans växel'], ['gear6', '6:ans växel'], ['gearR', 'Backväxel (R)'],
  ['shiftUp', 'Växla upp (höger paddel)'], ['shiftDown', 'Växla ned (vänster paddel)'],
  ['camera', 'Byt kamera'], ['lookLeft', 'Titta vänster (håll)'], ['lookRight', 'Titta höger (håll)'], ['lookBack', 'Titta bakåt (håll)'],
  ['reset', 'Återställ bilen till vägen'], ['handbrake', 'Handbroms'],
  ['ignition', 'Starta motorn'], ['pause', 'Paus / meny'],
];

export const DEFAULT_SETTINGS = {
  track: 'alpine_pass',    // vald bana (se TRACKS i main.js)
  wheelRotation: 900,      // grader, ska matcha inställningen i Thrustmaster Control Panel
  steerLinearity: 1.0,
  steerSensitivity: 900,
  tyreGrip: 100,           // däckens grepp i procent av standard
  gripBalance: 0,          // procent grepp som flyttas till framaxeln (+) eller bakaxeln (−)   // 900 = bilens ratt följer din ratt 1:1; högre = mer sväng per grad (snabbare styrväxel)
  gearbox: 'h',            // 'h' = H-växel, 'seq' = sekventiell/paddlar, 'auto' = automat
  autoClutch: true,
  requireClutch: true,     // kräv koppling för att lägga i växel (endast utan autokoppling)
  abs: false, tc: false,
  color: '#0f4a2a',
  volume: 0.8,
  camera: 0,
  fov: 62,               // synfält för yttre kameror
  // förarvy
  cockpitFovAuto: true,  // räkna ut synfältet från skärmens storlek och avstånd
  screenInches: 27,
  screenDistCm: 70,
  cockpitFov: 55,        // används när cockpitFovAuto = false
  seatFwd: 0, seatUp: 0, // cm
  lookPitch: -4.5,       // grader
  headMotion: 1.0,
  vibration: 1.0,
  lookApex: true,
  // rörelsesimulator (Arduino SMC3)
  motionEnabled: true,
  motionMode: 'axes',     // 'axes' = A gas/broms, B sidled; 'mix' = tvåmotorsstol
  motionMaxG: 1.2,        // G som ger fullt utslag
  motionIntensity: 0.5,   // andel av motorernas slaglängd
  motionSmooth: 0.3,
  motionSlopes: true,     // backar och vägens lutning påverkar stolen
  motionInvertLong: false,
  motionInvertLat: false,
  motionInvertB: false,
  motionBaud: 500000,
  // force feedback (via ffb/FfbBridge.cs)
  ffbEnabled: true,
  ffbGain: 0.6,           // styrka på självcentrerande moment och stötar
  ffbDamper: 0.25,        // dämpning (tyngd), mer vid låg fart
  ffbRoad: 0.5,           // vägkänsla: gupp, krockar, vibration på gräs
  ffbMinForce: 0,         // minsta kraft (dödzonskompensation)
  ffbInvert: false,
};

export class Input {
  constructor() {
    this.bindings = load(STORE, {});
    this.settings = Object.assign({}, DEFAULT_SETTINGS, load(SETTINGS, {}));
    this.keys = new Set();
    this.prevButtons = {};
    this.kbSteer = 0;
    this.state = { steer: 0, throttle: 0, brake: 0, clutch: 0, handbrake: 0, hGear: null, events: [], device: 'Tangentbord' };
    addEventListener('keydown', e => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
      if (!this.keys.has(e.code)) this.keyEvent(e.code);
      this.keys.add(e.code);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', e => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    this.pendingEvents = [];
  }
  saveBindings() { localStorage.setItem(STORE, JSON.stringify(this.bindings)); }
  saveSettings() { localStorage.setItem(SETTINGS, JSON.stringify(this.settings)); }

  keyEvent(code) {
    const map = { KeyE: 'shiftUp', ShiftLeft: 'shiftUp', KeyQ: 'shiftDown', ControlLeft: 'shiftDown', KeyC: 'camera', KeyR: 'reset', KeyI: 'ignition', Escape: 'pause', KeyP: 'pause' };
    if (map[code]) this.pendingEvents.push(map[code]);
    const gears = { Digit1: 1, Digit2: 2, Digit3: 3, Digit4: 4, Digit5: 5, Digit6: 6, Digit0: 0, Backquote: -1, KeyN: 0, Minus: -1 };
    if (code in gears) this.pendingEvents.push('kbGear:' + gears[code]);
  }

  static pads() { return [...(navigator.getGamepads ? navigator.getGamepads() : [])].filter(Boolean); }
  pad(id) { return Input.pads().find(p => p.id === id); }

  axisValue(b) {
    if (!b) return null;
    const p = this.pad(b.dev); if (!p) return null;
    const v = p.axes[b.axis]; if (v === undefined) return null;
    return v;
  }
  pedal(b) {
    const v = this.axisValue(b); if (v === null) return null;
    let t = (v - b.rest) / (b.full - b.rest);
    t = Math.min(1, Math.max(0, t));
    return t < 0.02 ? 0 : (t - 0.02) / 0.98;
  }
  button(b) {
    if (!b) return false;
    const p = this.pad(b.dev); if (!p) return false;
    if (b.button !== undefined) { const btn = p.buttons[b.button]; return !!btn && (btn.pressed || btn.value > 0.5); }
    if (b.axis !== undefined) { const v = p.axes[b.axis]; return v !== undefined && Math.abs(v - b.value) < 0.08; }
    return false;
  }

  poll(dt) {
    const s = this.state, B = this.bindings, S = this.settings;
    const events = this.pendingEvents; this.pendingEvents = [];
    let steer = null, throttle = null, brake = null, clutch = null;
    // --- ratt
    if (B.steer) {
      const v = this.axisValue(B.steer);
      if (v !== null) {
        const c = B.steer.center ?? (B.steer.min + B.steer.max) / 2;
        let n = v < c ? (v - c) / (c - B.steer.min) : (v - c) / (B.steer.max - c);
        n = Math.max(-1, Math.min(1, n));
        steer = n;
      }
    }
    throttle = this.pedal(B.throttle);
    brake = this.pedal(B.brake);
    clutch = this.pedal(B.clutch);

    // --- handkontroll (standardmappning) om ingen ratt är kalibrerad
    let padUsed = false;
    if (steer === null) {
      const gp = Input.pads().find(p => p.mapping === 'standard');
      if (gp) {
        const x = gp.axes[0] || 0;
        steer = Math.abs(x) < 0.06 ? 0 : Math.sign(x) * Math.pow((Math.abs(x) - 0.06) / 0.94, 1.6);
        throttle = Math.max(throttle ?? 0, gp.buttons[7]?.value || 0);
        brake = Math.max(brake ?? 0, gp.buttons[6]?.value || 0);
        const edge = (i, ev) => { const pr = !!gp.buttons[i]?.pressed; const k = 'std' + i; if (pr && !this.prevButtons[k]) events.push(ev); this.prevButtons[k] = pr; };
        edge(5, 'shiftUp'); edge(4, 'shiftDown'); edge(3, 'camera'); edge(1, 'reset'); edge(9, 'pause'); edge(2, 'ignition');
        if (gp.buttons[0]?.pressed) s.handbrakePad = 1; else s.handbrakePad = 0;
        const rx = gp.axes[2] || 0; s.lookStick = Math.abs(rx) < 0.15 ? 0 : rx;
        padUsed = true;
        s.device = 'Handkontroll';
      }
    } else s.device = B.steer.dev;

    // --- tangentbord
    const k = this.keys;
    const kl = k.has('ArrowLeft') || k.has('KeyA'), kr = k.has('ArrowRight') || k.has('KeyD');
    const kbTarget = (kr ? 1 : 0) - (kl ? 1 : 0);
    const rate = kbTarget === 0 ? 4.0 : (Math.sign(kbTarget) !== Math.sign(this.kbSteer) ? 5.0 : 2.2);
    this.kbSteer += Math.max(-rate * dt, Math.min(rate * dt, kbTarget - this.kbSteer));
    const kbThr = (k.has('ArrowUp') || k.has('KeyW')) ? 1 : 0;
    const kbBrk = (k.has('ArrowDown') || k.has('KeyS')) ? 1 : 0;
    const kbClutch = k.has('KeyX') ? 1 : 0;

    if (steer === null || (Math.abs(this.kbSteer) > 0.01 && !B.steer)) steer = (steer ?? 0) + this.kbSteer;
    if (!B.steer && !padUsed) s.device = 'Tangentbord';
    s.kbSteering = !B.steer && !padUsed;
    s.steer = Math.max(-1, Math.min(1, steer ?? 0));
    if (S.steerLinearity !== 1) s.steer = Math.sign(s.steer) * Math.pow(Math.abs(s.steer), S.steerLinearity);
    s.throttle = Math.max(throttle ?? 0, kbThr);
    s.brake = Math.max(brake ?? 0, kbBrk);
    s.clutch = Math.max(clutch ?? 0, kbClutch);
    s.hasClutchPedal = !!B.clutch;

    // --- knappar
    for (const [name] of ACTIONS_BUTTON) {
      const pr = this.button(B[name]);
      if (pr && !this.prevButtons[name]) events.push(name);
      this.prevButtons[name] = pr;
    }
    s.handbrake = Math.max(this.button(B.handbrake) ? 1 : 0, k.has('Space') ? 1 : 0, s.handbrakePad || 0);
    // titta åt sidan/bakåt (hålls nedtryckt)
    s.lookLeft = this.button(B.lookLeft) || k.has('Comma') || k.has('Numpad4');
    s.lookRight = this.button(B.lookRight) || k.has('Period') || k.has('Numpad6');
    s.lookBack = this.button(B.lookBack) || k.has('KeyB') || k.has('Numpad2');
    if (!padUsed) s.lookStick = 0;

    // H-växel: absolut läge
    const hasH = ['gear1', 'gear2', 'gear3', 'gear4', 'gear5', 'gear6', 'gearR'].some(g => B[g]);
    if (hasH) {
      let g = 0;
      for (let i = 1; i <= 6; i++) if (this.button(B['gear' + i])) g = i;
      if (this.button(B.gearR)) g = -1;
      s.hGear = g;
    } else s.hGear = null;

    s.events = events;
    return s;
  }
}

function load(key, def) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v && typeof v === 'object' ? v : def; } catch { return def; }
}

// ---------------------------------------------------------------------------
// Kalibreringsguide
export class Calibrator {
  constructor(input, el, onDone) {
    this.input = input; this.el = el; this.onDone = onDone;
    this.steps = [
      { kind: 'baseline', text: 'Släpp alla pedaler, centrera ratten och lägg växelspaken i friläge. Tryck sedan <b>Nästa</b>.' },
      { kind: 'axis', key: 'steerL', text: 'Vrid ratten helt åt <b>VÄNSTER</b> och håll kvar. Tryck <b>Nästa</b> (Enter) medan du håller.' },
      { kind: 'axis', key: 'steerR', text: 'Vrid ratten helt åt <b>HÖGER</b> och håll kvar. Tryck <b>Nästa</b> (Enter).' },
      { kind: 'axis', key: 'throttle', text: 'Tryck <b>GASPEDALEN</b> i botten och håll. Tryck <b>Nästa</b> (Enter).' },
      { kind: 'axis', key: 'brake', text: 'Tryck <b>BROMSPEDALEN</b> i botten och håll. Tryck <b>Nästa</b> (Enter).' },
      { kind: 'axis', key: 'clutch', optional: true, text: 'Tryck <b>KOPPLINGSPEDALEN</b> i botten och håll. Tryck <b>Nästa</b> (Enter). Har du bara två pedaler: <b>Hoppa över</b>.' },
      ...['gear1', 'gear2', 'gear3', 'gear4', 'gear5', 'gear6', 'gearR'].map(g => ({ kind: 'button', key: g, optional: true, text: `Lägg i <b>${g === 'gearR' ? 'BACKVÄXELN' : g.slice(4) + ':ANS VÄXEL'}</b> på växelspaken (TH8A/TH8S). Registreras automatiskt. Ingen H-växel: <b>Hoppa över</b>.` })),
      { kind: 'button', key: 'shiftUp', optional: true, text: 'Tryck på knappen/paddeln för <b>VÄXLA UPP</b> (sekventiellt).' },
      { kind: 'button', key: 'shiftDown', optional: true, text: 'Tryck på knappen/paddeln för <b>VÄXLA NED</b>.' },
      { kind: 'button', key: 'camera', optional: true, text: 'Tryck på en rattknapp för <b>BYT KAMERA</b>.' },
      { kind: 'button', key: 'lookLeft', optional: true, text: 'Tryck på en rattknapp för <b>TITTA VÄNSTER</b> (hålls in under körning).' },
      { kind: 'button', key: 'lookRight', optional: true, text: 'Tryck på en rattknapp för <b>TITTA HÖGER</b>.' },
      { kind: 'button', key: 'lookBack', optional: true, text: 'Tryck på en rattknapp för <b>TITTA BAKÅT</b>.' },
      { kind: 'button', key: 'reset', optional: true, text: 'Tryck på en rattknapp för <b>ÅTERSTÄLL BIL</b>.' },
      { kind: 'button', key: 'pause', optional: true, text: 'Tryck på en rattknapp för <b>PAUS/MENY</b>.' },
      { kind: 'button', key: 'handbrake', optional: true, text: 'Tryck på en knapp för <b>HANDBROMS</b> (valfritt).' },
    ];
    this.i = 0;
    this.result = {};
    this.base = null;
    this.render();
    this.timer = setInterval(() => this.tick(), 50);
    this.keyH = e => { if (e.code === 'Enter') { e.preventDefault(); this.next(); } else if (e.code === 'Escape') this.close(false); };
    addEventListener('keydown', this.keyH);
  }
  snapshot() {
    const s = {};
    for (const p of Input.pads()) s[p.id] = { axes: [...p.axes], buttons: p.buttons.map(b => b.pressed || b.value > 0.5) };
    return s;
  }
  // största axelförändring jämfört med baslinjen
  bestAxis(exclude) {
    let best = null;
    const now = this.snapshot();
    for (const id in now) {
      const b = this.base[id]; if (!b) continue;
      now[id].axes.forEach((v, i) => {
        if (exclude.some(e => e && e.dev === id && e.axis === i)) return;
        const d = Math.abs(v - b.axes[i]);
        if (d > 0.25 && (!best || d > best.d)) best = { dev: id, axis: i, d, v, rest: b.axes[i] };
      });
    }
    return best;
  }
  newButton() {
    const now = this.snapshot();
    for (const id in now) {
      const b = this.base[id]; if (!b) continue;
      for (let i = 0; i < now[id].buttons.length; i++) if (now[id].buttons[i] && !b.buttons[i]) return { dev: id, button: i };
    }
    return null;
  }
  tick() {
    const st = this.steps[this.i]; if (!st) return;
    const live = this.el.querySelector('.cal-live');
    const pads = Input.pads();
    if (!pads.length) { live.innerHTML = '<span class="warn">Ingen enhet hittad. Anslut ratten via USB och tryck på valfri knapp/vrid ratten så att webbläsaren upptäcker den.</span>'; return; }
    if (st.kind === 'baseline') {
      live.innerHTML = pads.map(p => `<div class="dev">🎮 ${esc(p.id)}<br><small>${p.axes.length} axlar, ${p.buttons.length} knappar</small></div>`).join('');
    } else if (st.kind === 'axis') {
      const ex = [];
      if (st.key === 'steerR') ex.length = 0;
      else if (st.key !== 'steerL') ex.push(this.result.steer, this.result.throttle, this.result.brake);
      const b = st.key === 'steerR' ? this.liveSteer() : this.bestAxis(ex);
      this.cand = b;
      live.innerHTML = b ? `Hittad: <b>${esc(short(b.dev))}</b> axel ${b.axis} &nbsp; värde ${b.v.toFixed(2)} ${bar(b.v)}` : 'Väntar på rörelse…';
    } else if (st.kind === 'button') {
      const b = this.newButton();
      if (b) {
        this.result[st.key] = b;
        live.innerHTML = `Registrerad: knapp ${b.button} på ${esc(short(b.dev))}`;
        clearTimeout(this.adv); this.adv = setTimeout(() => this.next(true), 350);
        this.base = this.snapshot(); // undvik dubbelregistrering
        this.base[b.dev].buttons[b.button] = true;
      } else if (!this.result[st.key]) live.innerHTML = 'Väntar på knapptryckning…';
    }
  }
  liveSteer() {
    const s = this.result.steer; if (!s) return null;
    const p = Input.pads().find(x => x.id === s.dev); if (!p) return null;
    return { dev: s.dev, axis: s.axis, v: p.axes[s.axis], rest: s.center };
  }
  next(auto) {
    const st = this.steps[this.i];
    if (st.kind === 'baseline') {
      this.base = this.snapshot();
      if (!Object.keys(this.base).length) return;
    } else if (st.kind === 'axis') {
      const b = this.cand;
      if (!b) { if (st.optional) return this.skip(); return; }
      if (st.key === 'steerL') this.result.steer = { dev: b.dev, axis: b.axis, min: b.v, center: b.rest };
      else if (st.key === 'steerR') { this.result.steer.max = b.v; }
      else this.result[st.key] = { dev: b.dev, axis: b.axis, rest: b.rest, full: b.v };
      this.cand = null;
    } else if (st.kind === 'button' && !auto && !this.result[st.key]) return this.skip();
    this.i++;
    if (this.i >= this.steps.length) return this.close(true);
    this.render();
  }
  skip() { this.i++; if (this.i >= this.steps.length) return this.close(true); this.render(); }
  back() { if (this.i > 0) { this.i--; this.render(); } }
  render() {
    const st = this.steps[this.i];
    this.el.innerHTML = `
      <div class="cal-step">Steg ${this.i + 1} / ${this.steps.length}</div>
      <p class="cal-text">${st.text}</p>
      <div class="cal-live"></div>
      <div class="row">
        <button class="btn ghost" data-a="cancel">Avbryt</button>
        <span style="flex:1"></span>
        ${this.i > 0 ? '<button class="btn ghost" data-a="back">Tillbaka</button>' : ''}
        ${st.optional ? '<button class="btn ghost" data-a="skip">Hoppa över</button>' : ''}
        ${st.kind !== 'button' ? '<button class="btn" data-a="next">Nästa</button>' : ''}
      </div>`;
    this.el.querySelectorAll('button').forEach(b => b.onclick = () => {
      const a = b.dataset.a;
      if (a === 'next') this.next(); else if (a === 'skip') this.skip(); else if (a === 'back') this.back(); else this.close(false);
    });
    if (st.kind === 'button' && this.base) this.base = this.snapshot();
  }
  close(save) {
    clearInterval(this.timer); clearTimeout(this.adv);
    removeEventListener('keydown', this.keyH);
    if (save) {
      const r = this.result;
      const B = {};
      if (r.steer && r.steer.max !== undefined && Math.abs(r.steer.max - r.steer.min) > 0.2) B.steer = r.steer;
      for (const k of ['throttle', 'brake', 'clutch']) if (r[k]) B[k] = r[k];
      for (const [k] of ACTIONS_BUTTON) if (r[k]) B[k] = r[k];
      this.input.bindings = B;
      this.input.saveBindings();
    }
    this.onDone(save);
  }
}

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function short(id) { return id.length > 48 ? id.slice(0, 46) + '…' : id; }
function bar(v) { const p = Math.round((v + 1) * 50); return `<span class="bar"><i style="width:${p}%"></i></span>`; }
