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
    this.setStatus('Ansluten – Arduinon startar om…');
    // Arduinon startar om när porten öppnas (ca 2 s). Skicka sedan "aktivera motorer" och mittläge.
    this.readyAt = performance.now() + 2200;
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
    this.cleanup();
    try { await port.close(); } catch { /* */ }
    this.setStatus('Inte ansluten');
  }
  cleanup() { this.writer = null; this.port = null; this.busy = false; }

  writeRaw(bytes) {
    if (!this.writer || this.busy) return;
    this.busy = true;
    this.writer.write(bytes).then(() => { this.busy = false; }, e => { this.busy = false; this.setStatus('Skrivfel: ' + e.message); });
  }
  frame(buf, o, motor, v) {
    v = Math.max(0, Math.min(1023, Math.round(v)));
    buf[o] = 91; buf[o + 1] = motor; buf[o + 2] = v >> 8; buf[o + 3] = v & 255; buf[o + 4] = 93;
  }
  send(a, b) {
    const buf = new Uint8Array(10);
    this.frame(buf, 0, 65, a); this.frame(buf, 5, 66, b);
    this.writeRaw(buf);
  }
  async sendNow(a, b) {
    if (!this.writer) return;
    const buf = new Uint8Array(10); this.frame(buf, 0, 65, a); this.frame(buf, 5, 66, b);
    await this.writer.write(buf);
  }

  // Ignorera accelerationstoppar en stund (t.ex. när bilen flyttas tillbaka till vägen).
  suppress(sec = 0.6) { this.suppressT = Math.max(this.suppressT, sec); }
  // Långsam teströrelse: först gas/broms, sedan sidled.
  startTest() { this.testT = 0; }

  // gLong: + = acceleration framåt,  gLat: + = acceleration åt vänster (vänstersväng). active=false → mittläge.
  update(dt, gLong, gLat, active) {
    const S = this.S;
    let long = 0, lat = 0;
    active = active && S.motionEnabled; // avstängd → stolen går till mittläget och stannar där
    if (this.testT >= 0) {
      this.testT += dt;
      const t = this.testT;
      if (t < 4) long = Math.sin(t / 4 * Math.PI * 2) * S.motionMaxG;
      else if (t < 8) lat = Math.sin((t - 4) / 4 * Math.PI * 2) * S.motionMaxG;
      else this.testT = -1;
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
    const amp = RANGE * S.motionIntensity;
    const ta = CENTER + a * amp, tb = CENTER + b * amp;
    // hastighetsbegränsning
    const m = SLEW * dt;
    this.outA += Math.max(-m, Math.min(m, ta - this.outA));
    this.outB += Math.max(-m, Math.min(m, tb - this.outB));
    if (this.writer && performance.now() > (this.readyAt || 0)) this.send(this.outA, this.outB);
  }
}
