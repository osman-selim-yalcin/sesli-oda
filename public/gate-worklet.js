// Gürültü kapısı (noise gate): ses eşiğin altındaysa mikrofonu susturur.
// Ses iş parçacığında çalışır; sekme arka plandayken de kesintisizdir.
// Kapı kapalıyken giden ses tamamen sessiz olur, Opus DTX sayesinde neredeyse veri harcamaz.

const HOLD = 0.3;     // sn; kelime aralarında kapı kapanmasın
const ATTACK = 0.005; // sn; açılış süresi (ilk heceyi yutmasın)
const RELEASE = 0.08; // sn; kapanış süresi (tık sesi olmasın)
const REPORT = 0.05;  // sn; seviye göstergesine bildirme aralığı

class NoiseGate extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'threshold', defaultValue: -50, minValue: -100, maxValue: 0 }];
  }

  constructor() {
    super();
    this.gain = 0;
    this.hold = 0;
    this.peakDb = -100;
    this.frames = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0][0];
    const output = outputs[0][0];
    if (!input || !output) return true;

    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const db = 20 * Math.log10(Math.sqrt(sum / input.length) + 1e-9);

    if (db > parameters.threshold[0]) this.hold = HOLD * sampleRate;
    else this.hold = Math.max(0, this.hold - input.length);
    const target = this.hold > 0 ? 1 : 0;

    const attackStep = 1 / (ATTACK * sampleRate);
    const releaseStep = 1 / (RELEASE * sampleRate);
    for (let i = 0; i < input.length; i++) {
      if (this.gain < target) this.gain = Math.min(target, this.gain + attackStep);
      else if (this.gain > target) this.gain = Math.max(target, this.gain - releaseStep);
      output[i] = input[i] * this.gain;
    }

    this.peakDb = Math.max(this.peakDb, db);
    this.frames += input.length;
    if (this.frames >= REPORT * sampleRate) {
      this.port.postMessage({ db: this.peakDb, open: target === 1 });
      this.peakDb = -100;
      this.frames = 0;
    }
    return true;
  }
}

registerProcessor('noise-gate', NoiseGate);
