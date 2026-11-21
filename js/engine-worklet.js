// AudioWorklet: fyrcylindrig fyrtaktsmotor (Toyota 2ZZ-GE i Lotus Elise), syntetiserad ur enskilda tändpulser.
// Utgång 0 = avgaspuls (före rör/ljuddämpare), utgång 1 = insug (före luftlådan). Filtren ligger i audio.js.
//
// Pulsformen är låst till vevaxelvinkeln, så klangen följer varvtalet; rör- och luftlådsresonanserna
// (fasta frekvenser i Hz) ligger efter, vilket ger den karakteristiska förändringen av tonen genom varvregistret.

const FIRING_ORDER = [0, 2, 3, 1];          // 1-3-4-2
const CYL_GAIN = [1.0, 0.93, 1.06, 0.97];   // små skillnader mellan cylindrarna = tomgångsknatter

class EngineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 0, minValue: 0, maxValue: 12000, automationRate: 'k-rate' },
      { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'on', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'vvtl', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.phase = 0;              // motorcykel 0..1 (720° vevaxel)
    this.fireIdx = 0;
    // en aktiv puls per cylinder: tid sedan tändning (s), längd (s), amplitud
    this.pAge = new Float32Array(4).fill(1e9);
    this.pDur = new Float32Array(4).fill(0.01);
    this.pAmp = new Float32Array(4);
    this.pSlot = 0;
    this.seed = 22222;
    this.liftT = 10;             // sekunder sedan gasen släpptes (för smällar på motorbroms)
    this.popEnv = 0;
    this.popAmp = 0;
    this.lp1 = 0; this.lp2 = 0;  // enkla lågpass för brus
  }

  rand() { // xorshift, 0..1
    let x = this.seed; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.seed = x >>> 0;
    return this.seed / 4294967296;
  }

  process(_in, outputs, params) {
    const exh = outputs[0][0], intk = outputs[1][0];
    if (!exh || !intk) return true;
    const rpm = params.rpm[0], load = params.load[0], on = params.on[0] > 0.5, vvtl = params.vvtl[0];
    const n = exh.length, dt = 1 / sampleRate;
    const cycleHz = rpm / 120;                          // motorcykler per sekund
    const interval = cycleHz > 0.1 ? 0.25 / cycleHz : 1; // tid mellan tändningar
    const dphi = cycleHz * dt;

    // motorbroms: räkna tid sedan gasen släpptes
    this.liftT = load < 0.04 ? this.liftT + n * dt : 0;
    const overrun = on && load < 0.04 && rpm > 3200 && this.liftT < 1.6;

    for (let i = 0; i < n; i++) {
      const prevQ = Math.floor(this.phase * 4);
      this.phase += dphi;
      const q = Math.floor(this.phase * 4);
      if (this.phase >= 1) this.phase -= 1;
      if (q !== prevQ && on && rpm > 150) {
        // tändning
        const cyl = FIRING_ORDER[this.fireIdx]; this.fireIdx = (this.fireIdx + 1) & 3;
        const idle = rpm < 1500 ? 1 : 0.3;
        const jitter = 0.06 + 0.14 * (1 - load) * idle;
        const amp = (0.22 + 0.78 * Math.pow(load, 0.8)) * CYL_GAIN[cyl] * (1 + jitter * (this.rand() * 2 - 1));
        const s = this.pSlot; this.pSlot = (s + 1) & 3;
        this.pAge[s] = 0; this.pDur[s] = interval * (0.85 + 0.1 * this.rand()); this.pAmp[s] = amp;
        // smällar/poppande på motorbroms (oförbränt bränsle som tänder i avgasröret)
        if (overrun && this.rand() < 0.012 + 0.02 * (rpm / 9000)) {
          this.popEnv = 1; this.popAmp = 0.4 + this.rand() * 0.8;
        }
      }

      // avgaspuls: kort, kraftig utblåsning när ventilen öppnar + bredare utskjutningsfas
      let ex = 0, inl = 0;
      for (let s = 0; s < 4; s++) {
        const age = this.pAge[s];
        if (age > this.pDur[s] * 1.6) continue;
        const x = age / this.pDur[s];
        const blow = Math.exp(-x * 9) * (1 - Math.exp(-x * 80));
        const disp = x < 1 ? Math.sin(Math.PI * x) : 0;
        ex += this.pAmp[s] * (1.5 * blow + 0.45 * disp * disp);
        // insugspuls (annan cylinder i insugstakt – samma takt i en rak fyra): mjukare sug,
        // skarpare och mer tonal när VVTL-i:s höga kam är inkopplad
        const suck = x < 1 ? Math.pow(Math.sin(Math.PI * x), 2 - vvtl) : 0;
        inl += this.pAmp[s] * (suck + vvtl * 0.9 * Math.exp(-x * 5) * (1 - Math.exp(-x * 40)));
        this.pAge[s] = age + dt;
      }

      // brus: förbränningsrasp i avgaserna, luftrusning i insuget
      const w = this.rand() * 2 - 1;
      this.lp1 += (w - this.lp1) * 0.35;
      this.lp2 += (w - this.lp2) * 0.6;
      ex += this.lp1 * ex * (0.18 + 0.2 * load);
      inl += this.lp2 * inl * (0.25 + 0.45 * vvtl) * (0.3 + 0.7 * load) + this.lp2 * 0.02 * load * (rpm / 9000);

      // smäll i avgasröret
      if (this.popEnv > 0.001) {
        ex += this.popAmp * this.popEnv * (this.lp1 * 2.2 + (this.popEnv > 0.7 ? 0.8 : 0));
        this.popEnv *= Math.exp(-dt / 0.006);
      }

      exh[i] = ex * 0.55;
      intk[i] = inl * 0.5;
    }
    return true;
  }
}

registerProcessor('lotus-engine', EngineProcessor);
