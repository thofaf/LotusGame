// Syntetiserat ljud: 4-cyl motor (Toyota 2ZZ-GE), insug, däckskrik, vind, växelskrap, krockar.
export class CarAudio {
  constructor() { this.ctx = null; this.enabled = false; }

  start(volume = 0.8) {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const ctx = this.ctx = new AC();
    const master = this.master = ctx.createGain(); master.gain.value = volume; master.connect(ctx.destination);
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4;
    // kupéfilter: inne i bilen dämpas diskanten och basen förstärks (karossen resonerar)
    const cabLP = this.cabLP = ctx.createBiquadFilter(); cabLP.type = 'lowpass'; cabLP.frequency.value = 18000; cabLP.Q.value = 0.5;
    const cabLow = this.cabLow = ctx.createBiquadFilter(); cabLow.type = 'lowshelf'; cabLow.frequency.value = 220; cabLow.gain.value = 0;
    const cabMid = this.cabMid = ctx.createBiquadFilter(); cabMid.type = 'peaking'; cabMid.frequency.value = 3500; cabMid.Q.value = 0.8; cabMid.gain.value = 0;
    comp.connect(cabLow); cabLow.connect(cabMid); cabMid.connect(cabLP); cabLP.connect(master);
    this.inside = false;
    const bus = comp;

    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const noise = () => { const n = ctx.createBufferSource(); n.buffer = noiseBuf; n.loop = true; n.start(); return n; };

    // motor: grundton (tändfrekvens), övertoner och "knatter"
    const engFilter = this.engFilter = ctx.createBiquadFilter(); engFilter.type = 'lowpass'; engFilter.Q.value = 1.2;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; curve[i] = Math.tanh(x * 2.2); }
    shaper.curve = curve;
    const engGain = this.engGain = ctx.createGain(); engGain.gain.value = 0;
    shaper.connect(engFilter); engFilter.connect(engGain); engGain.connect(bus);
    const mkOsc = (type, gain) => { const o = ctx.createOscillator(); o.type = type; const g = ctx.createGain(); g.gain.value = gain; o.connect(g); g.connect(shaper); o.start(); return { o, g }; };
    this.o1 = mkOsc('sawtooth', 0.35);   // tändfrekvens
    this.o2 = mkOsc('square', 0.18);     // halva (vevaxel) – mullret
    this.o3 = mkOsc('sawtooth', 0.12);   // 2x
    this.o4 = mkOsc('triangle', 0.25);   // 1.5x – ojämnhet
    // VVTL: hårdare ton över 6200 rpm
    const vv = ctx.createBiquadFilter(); vv.type = 'bandpass'; vv.Q.value = 2.5;
    const vvGain = this.vvGain = ctx.createGain(); vvGain.gain.value = 0;
    this.o5 = ctx.createOscillator(); this.o5.type = 'sawtooth'; this.o5.connect(vv); vv.connect(vvGain); vvGain.connect(bus); this.o5.start();
    this.vvFilter = vv;
    // insug / avgaser – brus
    const intake = ctx.createBiquadFilter(); intake.type = 'bandpass'; intake.Q.value = 0.9;
    const intakeGain = this.intakeGain = ctx.createGain(); intakeGain.gain.value = 0;
    noise().connect(intake); intake.connect(intakeGain); intakeGain.connect(bus);
    this.intakeFilter = intake;
    // amplitudmodulering i takt med tändningarna (ger "puls")
    const am = this.am = ctx.createOscillator(); am.type = 'sine';
    const amDepth = this.amDepth = ctx.createGain(); amDepth.gain.value = 0.15;
    am.connect(amDepth); amDepth.connect(engGain.gain); am.start();

    // däck
    const tyreF = ctx.createBiquadFilter(); tyreF.type = 'bandpass'; tyreF.frequency.value = 1100; tyreF.Q.value = 6;
    const tyreG = this.tyreGain = ctx.createGain(); tyreG.gain.value = 0;
    noise().connect(tyreF); tyreF.connect(tyreG); tyreG.connect(bus);
    const sq = ctx.createOscillator(); sq.type = 'triangle'; sq.frequency.value = 820;
    const sqLfo = ctx.createOscillator(); sqLfo.frequency.value = 9; const sqL = ctx.createGain(); sqL.gain.value = 40; sqLfo.connect(sqL); sqL.connect(sq.frequency); sqLfo.start();
    const sqG = this.squealTone = ctx.createGain(); sqG.gain.value = 0; sq.connect(sqG); sqG.connect(bus); sq.start();
    // grus/gräs
    const gravF = ctx.createBiquadFilter(); gravF.type = 'lowpass'; gravF.frequency.value = 500;
    const gravG = this.gravelGain = ctx.createGain(); gravG.gain.value = 0;
    noise().connect(gravF); gravF.connect(gravG); gravG.connect(bus);
    // vind
    const windF = ctx.createBiquadFilter(); windF.type = 'lowpass'; windF.frequency.value = 700;
    const windG = this.windGain = ctx.createGain(); windG.gain.value = 0;
    noise().connect(windF); windF.connect(windG); windG.connect(bus);
    this.windF = windF;
    // vägmuller (stomljud genom chassit) – hörs främst inifrån
    const roadF = ctx.createBiquadFilter(); roadF.type = 'lowpass'; roadF.frequency.value = 140; roadF.Q.value = 1.5;
    const roadG = this.roadGain = ctx.createGain(); roadG.gain.value = 0;
    noise().connect(roadF); roadF.connect(roadG); roadG.connect(bus);
    this.roadF = roadF;
    // växelskrap
    const grF = ctx.createBiquadFilter(); grF.type = 'bandpass'; grF.frequency.value = 2400; grF.Q.value = 3;
    const grG = this.grindGain = ctx.createGain(); grG.gain.value = 0;
    noise().connect(grF); grF.connect(grG); grG.connect(bus);
    const grO = ctx.createOscillator(); grO.type = 'square'; grO.frequency.value = 170; const grOG = this.grindTone = ctx.createGain(); grOG.gain.value = 0; grO.connect(grOG); grOG.connect(bus); grO.start();
    // krock
    this.noiseBuf = noiseBuf;
    this.bus = bus;
    this.enabled = true;
  }

  setVolume(v) { if (this.master) this.master.gain.value = v; }

  // Förarplats (inside=true) eller yttre kamera. Mjuk övergång.
  setCabin(inside) {
    if (!this.enabled || inside === this.inside) return;
    this.inside = inside;
    const t = this.ctx.currentTime, k = 0.15;
    this.cabLP.frequency.setTargetAtTime(inside ? 3200 : 18000, t, k);
    this.cabLow.gain.setTargetAtTime(inside ? 6 : 0, t, k);
    this.cabMid.gain.setTargetAtTime(inside ? -4 : 0, t, k);
  }
  suspend() { this.ctx?.suspend(); }
  resume() { this.ctx?.resume(); }

  crash(strength) {
    if (!this.enabled) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const n = ctx.createBufferSource(); n.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 400 + strength * 60;
    const g = ctx.createGain(); g.gain.setValueAtTime(Math.min(1.2, strength * 0.09), t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    n.connect(f); f.connect(g); g.connect(this.bus); n.start(t); n.stop(t + 0.6);
  }

  update(car, dt) {
    if (!this.enabled) return;
    const t = this.ctx.currentTime, k = 0.04;
    const rpm = Math.max(0, car.rpm);
    if (!Number.isFinite(rpm + car.speed + (car.slide || 0) + car.throttleEff)) return;
    const running = !car.stalled && rpm > 200;
    const f = rpm / 60 * 2; // tändningar per sekund (4 cyl)
    const load = car.throttleEff;
    const set = (p, v) => p.setTargetAtTime(v, t, k);
    set(this.o1.o.frequency, f);
    set(this.o2.o.frequency, f * 0.5);
    set(this.o3.o.frequency, f * 2);
    set(this.o4.o.frequency, f * 1.5);
    set(this.o5.frequency, f * 2);
    set(this.am.frequency, f * 0.5);
    set(this.engFilter.frequency, 380 + load * 2600 + rpm * 0.32);
    set(this.engGain.gain, running ? 0.16 + load * 0.22 : 0);
    set(this.amDepth.gain, running ? 0.05 + (1 - load) * 0.06 : 0);
    const vvtl = rpm > 6200 ? Math.min(1, (rpm - 6200) / 400) : 0;
    set(this.vvFilter.frequency, f * 3);
    set(this.vvGain.gain, running ? vvtl * (0.05 + load * 0.12) : 0);
    set(this.intakeFilter.frequency, 300 + rpm * 0.35);
    set(this.intakeGain.gain, running ? load * (0.05 + rpm / 9000 * 0.18) : 0);
    const sl = car.slide || 0;
    set(this.tyreGain.gain, Math.min(0.5, sl * 0.9));
    set(this.squealTone.gain, Math.min(0.08, sl * 0.12));
    const grass = car.wheels.some(w => w.contact && w.surf === 1) ? Math.min(1, car.speed / 15) : 0;
    set(this.gravelGain.gain, grass * 0.35);
    const sp = car.speed;
    const ins = this.inside;
    // i Elisen sitter motorn precis bakom ryggen: insuget hörs mer inifrån
    if (ins) set(this.intakeGain.gain, running ? load * (0.08 + rpm / 9000 * 0.26) : 0);
    const onGrass = car.wheels.some(w => w.contact && w.surf === 1);
    set(this.roadGain.gain, Math.min(0.4, sp * (onGrass ? 0.02 : 0.007)) * (ins ? 1 : 0.3));
    set(this.roadF.frequency, 70 + sp * 2.5);
    set(this.windGain.gain, Math.min(0.35, sp * sp * 0.00004) * (ins ? 0.6 : 1));
    set(this.windF.frequency, 300 + sp * 12);
    const gr = car.grind > 0 ? 1 : 0;
    set(this.grindGain.gain, gr * 0.5);
    set(this.grindTone.gain, gr * 0.08);
  }
}
