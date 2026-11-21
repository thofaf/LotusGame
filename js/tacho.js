// Stor varvräknare i HUD:en (nere till höger), ritad på en canvas.
// Statisk urtavla ritas en gång per storlek; nål och display ritas varje bildruta.

const MAX_RPM = 9000;
const RED_FROM = 6800;
const A0 = (165 * Math.PI) / 180;           // 0 rpm: strax under vänster horisont
const SWEEP = (210 * Math.PI) / 180;        // medurs upp över toppen till 9000 rpm strax under höger horisont
const CREAM = '#f3e9cf', RED = '#ff2d1f';
const NUM_FONT = '"Arial Black", "Segoe UI Black", Impact, system-ui, sans-serif';
const LCD_FONT = 'Consolas, "Lucida Console", monospace';

export class Tachometer {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.face = document.createElement('canvas');
    this.px = 0;
    this.rpm = 0;
  }

  angle(rpm) { return A0 + SWEEP * Math.min(1, Math.max(0, rpm / MAX_RPM)); }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(this.cv.clientWidth * dpr);
    if (!px || px === this.px) return;
    this.px = px;
    this.cv.width = this.cv.height = px;
    this.face.width = this.face.height = px;
    this.drawFace();
  }

  drawFace() {
    const g = this.face.getContext('2d'), S = this.px, c = S / 2, R = S * 0.47;
    g.clearRect(0, 0, S, S);

    // ram och urtavla
    g.beginPath(); g.arc(c, c, R * 1.04, 0, Math.PI * 2);
    const bez = g.createLinearGradient(0, 0, 0, S);
    bez.addColorStop(0, '#3a3f47'); bez.addColorStop(0.5, '#15181c'); bez.addColorStop(1, '#2a2e34');
    g.fillStyle = bez; g.fill();
    g.beginPath(); g.arc(c, c, R, 0, Math.PI * 2);
    const face = g.createRadialGradient(c, c * 0.85, R * 0.1, c, c, R);
    face.addColorStop(0, '#1d2430'); face.addColorStop(0.7, '#0e1218'); face.addColorStop(1, '#05070a');
    g.fillStyle = face; g.fill();
    // svag blå reflex i glaset
    g.save(); g.clip();
    const sheen = g.createLinearGradient(c - R, c - R, c + R * 0.4, c + R * 0.2);
    sheen.addColorStop(0, 'rgba(40,90,200,0.28)'); sheen.addColorStop(0.45, 'rgba(30,70,170,0.10)'); sheen.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = sheen; g.fillRect(0, 0, S, S);
    g.restore();

    // skalstreck var 200:e varv, långa vid varje tusental
    g.lineCap = 'round';
    for (let r = 0; r <= MAX_RPM; r += 200) {
      const a = this.angle(r), major = r % 1000 === 0, red = r >= RED_FROM;
      const outer = R * 0.95, inner = outer - R * (major ? 0.13 : red ? 0.06 : 0.075);
      g.strokeStyle = red ? RED : CREAM;
      g.lineWidth = R * (major ? 0.032 : 0.02);
      g.beginPath();
      g.moveTo(c + Math.cos(a) * inner, c + Math.sin(a) * inner);
      g.lineTo(c + Math.cos(a) * outer, c + Math.sin(a) * outer);
      g.stroke();
    }

    // siffror (breda, som på originalet)
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let n = 0; n <= 9; n++) {
      const a = this.angle(n * 1000), rr = R * 0.7;
      g.save();
      g.translate(c + Math.cos(a) * rr, c + Math.sin(a) * rr);
      g.scale(1.25, 1);
      g.font = `900 ${R * 0.22}px ${NUM_FONT}`;
      g.fillStyle = n * 1000 >= 7000 ? RED : '#f6f6f2';
      g.shadowColor = n * 1000 >= 7000 ? 'rgba(255,40,20,0.5)' : 'rgba(255,255,240,0.35)';
      g.shadowBlur = R * 0.03;
      g.fillText(String(n), 0, 0);
      g.restore();
    }

    // RPM x1000
    g.fillStyle = '#e9e9e4';
    g.font = `800 ${R * 0.1}px ${NUM_FONT}`;
    g.fillText('RPM', c, c + R * 0.25);
    g.font = `700 ${R * 0.065}px ${NUM_FONT}`;
    g.fillText('x1000', c, c + R * 0.34);
  }

  draw(rpm, speedKmh, gear, timeText) {
    this.resize();
    if (!this.px) return;
    // lätt utjämning så nålen inte fladdrar
    this.rpm += (rpm - this.rpm) * 0.5;
    const g = this.ctx, S = this.px, c = S / 2, R = S * 0.47;
    g.clearRect(0, 0, S, S);
    g.drawImage(this.face, 0, 0);

    // röd display
    const w = R * 1.12, h = R * 0.34, x = c - w / 2, y = c + R * 0.44;
    g.fillStyle = '#5c0a0e'; g.fillRect(x, y, w, h);
    const lcd = g.createLinearGradient(0, y, 0, y + h);
    lcd.addColorStop(0, '#b3121a'); lcd.addColorStop(1, '#7d0b11');
    g.fillStyle = lcd; g.fillRect(x + R * 0.012, y + R * 0.012, w - R * 0.024, h - R * 0.024);
    g.fillStyle = '#ff5b45';
    g.shadowColor = 'rgba(255,90,60,0.6)'; g.shadowBlur = R * 0.02;
    g.textBaseline = 'alphabetic';
    g.font = `700 ${R * 0.12}px ${LCD_FONT}`;
    g.textAlign = 'left'; g.fillText('GEAR ' + gear, x + R * 0.05, y + h * 0.43);
    g.textAlign = 'right'; g.fillText(timeText, x + w - R * 0.05, y + h * 0.43);
    g.font = `700 ${R * 0.15}px ${LCD_FONT}`;
    g.fillText(String(Math.round(speedKmh)), x + w - R * 0.2, y + h * 0.88);
    g.font = `700 ${R * 0.07}px ${LCD_FONT}`;
    g.fillText('km/h', x + w - R * 0.04, y + h * 0.88);
    g.shadowBlur = 0;

    // nål
    const a = this.angle(this.rpm), tip = R * 0.86, tail = R * 0.14;
    g.save();
    g.translate(c, c); g.rotate(a);
    g.shadowColor = 'rgba(255,30,20,0.7)'; g.shadowBlur = R * 0.04;
    g.fillStyle = '#ff2216';
    g.beginPath();
    g.moveTo(-tail, -R * 0.03); g.lineTo(tip, -R * 0.008); g.lineTo(tip, R * 0.008); g.lineTo(-tail, R * 0.03);
    g.closePath(); g.fill();
    g.restore();

    // nav
    g.beginPath(); g.arc(c, c, R * 0.12, 0, Math.PI * 2);
    const hub = g.createRadialGradient(c - R * 0.03, c - R * 0.04, R * 0.01, c, c, R * 0.12);
    hub.addColorStop(0, '#30343a'); hub.addColorStop(1, '#050607');
    g.fillStyle = hub; g.fill();
  }
}
