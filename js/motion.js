// Rörelsesimulator via USB till Arduino med SMC3-firmware (assets/arduino/SMC3.ino).
// Protokoll: 5 byte per kommando: '[' , motor ('A'/'B'/'C'), högbyte, lågbyte, ']'.
// Position 0–1023, 512 = mitten. Standard 500000 baud.
// Kommunikation via Web Serial (Chrome/Edge), inget extra program behövs.
//
// Kanaler (läge "axes"):  A = gas/broms (längs-G),  B = vänster/höger (sido-G)
// Läge "mix" (tvåmotorsstol): A = vänster motor, B = höger motor (lutning fram/bak + sidled blandas)
//
// Tecken (före ev. invertering):
//   A > 512: acceleration/uppförsbacke (föraren trycks bakåt),  A < 512: inbromsning
//   B > 512: vänstersväng (föraren trycks åt höger),           B < 512: högersväng

const CENTER = 512, RANGE = 511;
const SLEW = 2200; // max ändring per sekund (enheter) – skyddar mot ryck

export class MotionOutput {
  constructor(settings, log = () => {}) {
    this.S = settings; this.log = log;
    this.port = null; this.writer = null; this.busy = false;
    this.status = this.supported ? 'Inte ansluten' : 'Webbläsaren saknar Web Serial (använd Chrome eller Edge)';
    this.outA = CENTER; this.outB = CENTER;   // skickade värden
    this.fLong = 0; this.fLat = 0;            // filtrerade G
    this.suppressT = 0; this.testT = -1;
    this.onStatus = null;
    if (this.supported) navigator.serial.addEventListener('disconnect', e => {
      if (e.target === this.port) { this.cleanup(); this.setStatus('Frånkopplad'); }
    });
  }
  get supported() { return typeof navigator !== 'undefined' && 'serial' in navigator; }
  get connected() { return !!this.writer; }
  setStatus(s) { this.status = s; this.log('rörelse: ' + s); if (this.onStatus) this.onStatus(s); }

  // Återanslut automatiskt till en port som användaren redan godkänt tidigare.
  async autoConnect() {
    if (!this.supported || !this.S.motionEnabled) return;
    const ports = await navigator.serial.getPorts();
    if (ports.length) await this.connect(ports[0]).catch(e => this.setStatus('Kunde inte ansluta: ' + e.message));
  }
  // Måste anropas från ett knapptryck (webbläsaren visar en portväljare).
  async choosePort() {
    if (!this.supported) return;
    try {
      const port = await navigator.serial.requestPort();
      await this.connect(port);
    } catch (e) { if (e.name !== 'NotFoundError') this.setStatus('Kunde inte ansluta: ' + e.message); }
  }
  async connect(port) {
    if (this.port) await this.disconnect();
    await port.open({ baudRate: +this.S.motionBaud || 500000 });
    this.port = port; this.writer = port.writable.getWriter();
    this.outA = this.outB = CENTER;
    this.diag = { disabled: -1, fbA: -1, tgA: -1, fbB: -1, tgB: -1, poll: 0, t: 0, frames: 0 };
    this.readLoop(port);
    this.setStatus('Ansluten – Arduinon startar om…');
    // Arduinon startar om när porten öppnas (ca 2 s). Skicka sedan "aktivera motorer" och mittläge.
    this.readyAt = performance.now() + 2400; // efter [ena], så att det inte krockar med positionsdata
    setTimeout(() => {
      if (!this.writer) return;
      this.writeRaw(new Uint8Array([91, 101, 110, 97, 93])); // [ena]
      this.setStatus('Ansluten');
    }, 2200);
  }
  async disconnect() {
    if (!this.port) return;
    try { await this.sendNow(CENTER, CENTER); } catch { /* */ }
    const port = this.port;
    try { this.writer.releaseLock(); } catch { /* */ }
    const reader = this.reader; this.reader = null;
    if (reader) { try { await reader.cancel(); } catch { /* */ } }
    this.cleanup();
    try { await port.close(); } catch { /* */ }
    this.setStatus('Inte ansluten');
  }
  cleanup() {
    this.writer = null; this.port = null; this.busy = false;
    if (this.reader) { this.reader.cancel().catch(() => {}); this.reader = null; }
  }

  // --- Diagnostik: läs svar från SMC3 ([rdY] = motorstatus, [rdA]/[rdB] = feedback/mål) ---
  async readLoop(port) {
    if (!port.readable) return;
    const reader = port.readable.getReader();
    this.reader = reader;
    let buf = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const byte of value) {
          if (!buf.length && byte !== 91) continue;      // vänta på '['
          buf.push(byte);
          if (buf.length === 5) {
            if (buf[4] === 93) this.onFrame(buf[1], buf[2], buf[3]);
            buf = [];
          }
        }
      }
    } catch { /* porten stängd */ } finally {
      try { reader.releaseLock(); } catch { /* */ }
    }
  }
  onFrame(id, v1, v2) {
    const d = this.diag; if (!d) return;
    d.frames++;
    const now = performance.now();
    if (d.lastRx && now - d.lastRx > 500) {
      this.log(`rörelse-diag: INGET SVAR från Arduinon på ${Math.round(now - d.lastRx)} ms – troligen omstart (spänningsfall/USB) eller frånkoppling`);
    }
    d.lastRx = now;
    const ch = String.fromCharCode(id);
    if (ch === 'A') { d.fbA = v1 * 4; d.tgA = v2 * 4; }
    else if (ch === 'B') { d.fbB = v1 * 4; d.tgB = v2 * 4; }
    else if (ch === 'a') d.pwmA = v2;
    else if (ch === 'b') d.pwmB = v2;
    if (ch === 'a' || ch === 'b' || ch === 'Y') {
      const dis = v1 & 3; // bit0 = motor A, bit1 = motor B (motor C används inte)
      if (dis !== d.disabled) {
        const names = [dis & 1 ? 'A' : '', dis & 2 ? 'B' : ''].filter(Boolean).join('+');
        this.log(`rörelse-diag: ${dis ? 'AVSTÄNGD motor ' + names : 'alla motorer på'}`
          + ` | A feedback ${d.fbA} mål ${d.tgA} | B feedback ${d.fbB} mål ${d.tgB}`
          + ` | skickat A ${Math.round(this.outA)} B ${Math.round(this.outB)}`);
        if (dis) this.setStatus('Motor ' + names + ' avstängd av Arduinon (se logg)');
        d.disabled = dis;
      }
    }
  }
  // Fråga efter status ca 20 ggr/s, roterar mellan A, a, B, b
  // (A/B = feedback+mål, a/b = motorstatus+PWM). Loggar en sammanfattning varje sekund.
  pollBytes(dt) {
    const d = this.diag; if (!d) return null;
    d.logT = (d.logT || 0) + dt;
    if (d.logT >= 1) {
      d.logT = 0;
      const age = d.lastRx ? Math.round(performance.now() - d.lastRx) : -1;
      this.log(`rörelse-diag: A fb ${d.fbA} mål ${d.tgA} pwm ${d.pwmA ?? '-'} | B fb ${d.fbB} mål ${d.tgB} pwm ${d.pwmB ?? '-'}`
        + ` | av=${d.disabled} | skickat A ${Math.round(this.outA)} B ${Math.round(this.outB)} | svar ${d.frames} st, senast ${age} ms sedan`);
      if (age > 1000) this.log('rörelse-diag: Arduinon svarar inte – kontrollera USB/ström');
    }
    d.t += dt; if (d.t < 0.05) return null;
    d.t = 0;
    const what = [65, 97, 66, 98][d.poll++ % 4]; // 'A','a','B','b'
    return [91, 114, 100, what, 93];            // [rd?]
  }

  writeRaw(bytes) {
    if (!this.writer || this.busy) return;
    this.busy = true;
    this.writer.write(bytes).then(() => { this.busy = false; }, e => { this.busy = false; this.setStatus('Skrivfel: ' + e.message); });
  }
  frame(buf, o, motor, v) {
    v = Math.max(0, Math.min(1023, Math.round(v)));
    buf[o] = 91; buf[o + 1] = motor; buf[o + 2] = v >> 8; buf[o + 3] = v & 255; buf[o + 4] = 93;
  }
  send(a, b, extra) {
    const buf = new Uint8Array(extra ? 15 : 10);
    this.frame(buf, 0, 65, a); this.frame(buf, 5, 66, b);
    if (extra) buf.set(extra, 10);
    this.writeRaw(buf);
  }
  async sendNow(a, b) {
    if (!this.writer) return;
    const buf = new Uint8Array(10); this.frame(buf, 0, 65, a); this.frame(buf, 5, 66, b);
    await this.writer.write(buf);
  }

  // Ignorera accelerationstoppar en stund (t.ex. när bilen flyttas tillbaka till vägen).
  suppress(sec = 0.6) { this.suppressT = Math.max(this.suppressT, sec); }
  // Teströrelse åt ett håll som sedan återgår till mittläget.
  // kind: 'brake' | 'accel' | 'left' | 'right'
  startTest(kind = 'brake') { this.testKind = kind; this.testT = 0; }

  // gLong: + = acceleration framåt,  gLat: + = acceleration åt vänster (vänstersväng). active=false → mittläge.
  update(dt, gLong, gLat, active) {
    const S = this.S;
    let long = 0, lat = 0;
    active = active && S.motionEnabled; // avstängd → stolen går till mittläget och stannar där
    if (this.testT >= 0) {
      this.testT += dt;
      const t = this.testT;
      // mjuk upprampning 0,6 s, håll 1 s, mjuk återgång 1 s
      const ease = x => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, x)));
      const env = t < 0.6 ? ease(t / 0.6) : t < 1.6 ? 1 : ease(1 - (t - 1.6) / 1.0);
      const g = env * S.motionMaxG;
      if (t >= 2.6) this.testT = -1;
      else if (this.testKind === 'brake') long = -g;
      else if (this.testKind === 'accel') long = g;
      else if (this.testKind === 'left') lat = g;
      else if (this.testKind === 'right') lat = -g;
    } else if (active && this.suppressT <= 0) {
      long = gLong; lat = gLat;
    }
    if (this.suppressT > 0) this.suppressT -= dt;
    // lågpassfilter (mjukhet)
    const tau = 0.02 + S.motionSmooth * 0.25;
    const k = 1 - Math.exp(-dt / tau);
    this.fLong += (long - this.fLong) * k;
    this.fLat += (lat - this.fLat) * k;

    const n = x => Math.max(-1, Math.min(1, x / S.motionMaxG));
    let p = n(this.fLong) * (S.motionInvertLong ? -1 : 1);
    let r = n(this.fLat) * (S.motionInvertLat ? -1 : 1);
    let a, b;
    if (S.motionMode === 'mix') {
      a = Math.max(-1, Math.min(1, p + r)); // vänster motor
      b = Math.max(-1, Math.min(1, p - r)); // höger motor
    } else { a = p; b = r; }
    if (S.motionInvertB) b = -b; // vänd bara motor B (efter ev. blandning)
    const amp = RANGE * S.motionIntensity;
    const ta = CENTER + a * amp, tb = CENTER + b * amp;
    // hastighetsbegränsning
    const m = SLEW * dt;
    this.outA += Math.max(-m, Math.min(m, ta - this.outA));
    this.outB += Math.max(-m, Math.min(m, tb - this.outB));
    if (this.writer && performance.now() > (this.readyAt || 0) && !this.busy) this.send(this.outA, this.outB, this.pollBytes(dt));
  }
}
