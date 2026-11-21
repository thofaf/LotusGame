// Syntetiserat ljud: 4-cyl motor (Toyota 2ZZ-GE, tändpulser i engine-worklet.js), insug, däckskrik, vind, växelskrap, krockar.
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

    // motor: tändpulser från AudioWorklet (engine-worklet.js) -> avgasrör/ljuddämpare resp. insug/luftlåda
    const f = (type, freq, q = 0.7, gain = 0) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = freq; b.Q.value = q; b.gain.value = gain; return b; };
    const chain = (...nodes) => { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); return nodes[nodes.length - 1]; };
    // avgaser: Elisens korta system med en ljuddämpare – djup grundresonans, rörmoder, dämparen tar diskanten
    this.exhLP = f('lowpass', 1500, 0.8);
    const sat = ctx.createWaveShaper(); // lätt mättnad: rasp vid fullgas
    const curve = new Float32Array(2048); for (let i = 0; i < 2048; i++) { const x = i / 1024 - 1; curve[i] = Math.tanh(x * 1.8) / Math.tanh(1.8); }
    sat.curve = curve; sat.oversample = '2x';
    this.exhIn = f('highpass', 32, 0.7);
    this.exhGain = ctx.createGain(); this.exhGain.gain.value = 0;
    chain(this.exhIn, f('peaking', 95, 1.1, 6), f('peaking', 290, 2.2, 4), f('peaking', 680, 2.5, 3), f('notch', 1300, 1.5), this.exhLP, sat, this.exhGain).connect(bus);
    // insug: luftlådan (Helmholtz-resonans) och insugsrör; ljusare och starkare med VVTL-i
    this.intLP = f('lowpass', 2500, 0.9);
    this.intRes = f('peaking', 420, 1.6, 7);
    this.intHorn = f('peaking', 1900, 2.0, 0); // "ylet" över 6200 rpm
    this.intIn = f('highpass', 70, 0.7);
    this.intGain = ctx.createGain(); this.intGain.gain.value = 0;
    chain(this.intIn, this.intRes, this.intHorn, this.intLP, this.intGain).connect(bus);
    // mekaniskt: ventiler, kamkedja – svagt surr som stiger med varvtalet
    this.mechF = f('bandpass', 3000, 1.2);
    this.mechGain = ctx.createGain(); this.mechGain.gain.value = 0;
    noise().connect(this.mechF); this.mechF.connect(this.mechGain); this.mechGain.connect(bus);
    this.engine = null;
    if (ctx.audioWorklet) {
      ctx.audioWorklet.addModule(new URL('./engine-worklet.js', import.meta.url)).then(() => {
        const node = new AudioWorkletNode(ctx, 'lotus-engine', { numberOfInputs: 0, numberOfOutputs: 2, outputChannelCount: [1, 1] });
        node.connect(this.exhIn, 0); node.connect(this.intIn, 1);
        this.engine = node;
        this.eng = { rpm: node.parameters.get('rpm'), load: node.parameters.get('load'), on: node.parameters.get('on'), vvtl: node.parameters.get('vvtl') };
      }).catch(e => console.warn('Motorljudet kunde inte startas', e));
    }

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
    const load = Math.max(0, Math.min(1, car.throttleEff));
    const set = (p, v) => p.setTargetAtTime(v, t, k);
    const ins = this.inside;
    // VVTL-i växlar till den höga kammen vid ~6200 rpm (bara med gas på)
    const vvtl = rpm > 6000 && load > 0.3 ? Math.min(1, (rpm - 6000) / 300) : 0;
    const r = rpm / 9000;
    if (this.eng) {
      this.eng.rpm.setTargetAtTime(rpm, t, 0.012);
      set(this.eng.load, load);
      this.eng.on.setValueAtTime(running ? 1 : 0, t);
      this.eng.vvtl.setTargetAtTime(vvtl, t, 0.03);
    }
    // avgaser: dominerar utifrån; ljuddämparen öppnar upp med last och varv
    set(this.exhLP.frequency, 700 + load * 2200 + rpm * 0.35);
    set(this.exhGain.gain, running ? (0.55 + load * 0.45) * (ins ? 0.65 : 1) : 0);
    // insug: luftlådan sitter bakom förarens huvud – dominerar inifrån, ylar på höga kammen
    set(this.intRes.frequency, 380 + r * 260);
    set(this.intHorn.gain, vvtl * 9);
    set(this.intLP.frequency, 1200 + r * 2400 + vvtl * 3000);
    set(this.intGain.gain, running ? (0.12 + load * 0.55) * (1 + vvtl * 0.7) * (ins ? 1.6 : 0.6) : 0);
    // mekaniskt surr
    set(this.mechF.frequency, 1800 + rpm * 0.45);
    set(this.mechGain.gain, running ? 0.006 + r * r * 0.035 * (ins ? 1.4 : 0.6) : 0);
    const sl = car.slide || 0;
    set(this.tyreGain.gain, Math.min(0.5, sl * 0.9));
    set(this.squealTone.gain, Math.min(0.08, sl * 0.12));
    const grass = car.wheels.some(w => w.contact && w.surf === 1) ? Math.min(1, car.speed / 15) : 0;
    set(this.gravelGain.gain, grass * 0.35);
    const sp = car.speed;
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
