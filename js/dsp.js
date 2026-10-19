// Signal analysis: FFT, monophonic pitch (McLeod Pitch Method), polyphonic
// note estimation (iterative harmonic-salience / spectral subtraction),
// chord naming and fretboard fingering search.
// Pure functions/classes with no DOM access so they can be tested in Node.

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const midiToFreq = (m, a4 = 440) => a4 * Math.pow(2, (m - 69) / 12);
export const freqToMidi = (f, a4 = 440) => 69 + 12 * Math.log2(f / a4);
export const pc = (m) => ((Math.round(m) % 12) + 12) % 12;
export const noteName = (m) => NOTE_NAMES[pc(m)] + (Math.floor(Math.round(m) / 12) - 1);

// ---------------------------------------------------------------- FFT
export class FFT {
  constructor(n) {
    if (n & (n - 1)) throw new Error('FFT size must be a power of two');
    this.n = n;
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
      this.rev[i] = r;
    }
  }

  // In-place forward transform.
  transform(re, im) {
    const { n, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half;
          const tr = re[b] * cos[k] - im[b] * sin[k];
          const ti = re[b] * sin[k] + im[b] * cos[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }
}

export function rmsOf(buf, count = buf.length) {
  let s = 0;
  for (let i = buf.length - count; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / count);
}

// ------------------------------------------------- monophonic pitch (MPM)
export class PitchDetector {
  constructor(size, sampleRate) {
    this.size = size;
    this.sr = sampleRate;
    this.fft = new FFT(size * 2);
    this.re = new Float64Array(size * 2);
    this.im = new Float64Array(size * 2);
    this.x = new Float64Array(size);
    this.nsdf = new Float64Array(size);
  }

  // Analyses the last `size` samples of buf.
  // `lowpass` (Hz) attenuates upper partials, which on strings run sharp and bias the estimate.
  detect(buf, { minFreq = 25, maxFreq = 1500, gate = 0.002, k = 0.9, lowpass = 0 } = {}) {
    const N = this.size, { re, im, x, nsdf, sr } = this;
    const off = buf.length - N;
    let mean = 0;
    for (let i = 0; i < N; i++) mean += buf[off + i];
    mean /= N;
    for (let i = 0; i < N; i++) x[i] = buf[off + i] - mean;
    if (lowpass > 0) {
      // Two cascaded one-pole low-pass sections, run forward then backward (zero phase)
      const a = Math.exp((-2 * Math.PI * lowpass) / sr);
      for (let pass = 0; pass < 2; pass++) {
        let y = x[0];
        for (let i = 0; i < N; i++) x[i] = y = (1 - a) * x[i] + a * y;
        y = x[N - 1];
        for (let i = N - 1; i >= 0; i--) x[i] = y = (1 - a) * x[i] + a * y;
      }
    }
    let energy = 0;
    for (let i = 0; i < N; i++) energy += x[i] * x[i];
    const rms = Math.sqrt(energy / N);
    if (rms < gate) return { freq: 0, clarity: 0, rms };

    // Autocorrelation via FFT (zero padded to 2N)
    re.fill(0); im.fill(0);
    re.set(x);
    this.fft.transform(re, im);
    for (let i = 0; i < 2 * N; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; }
    this.fft.transform(re, im);
    const scale = 1 / (2 * N);

    const maxTau = Math.min(N - 2, Math.floor(sr / minFreq));
    const minTau = Math.max(2, Math.floor(sr / maxFreq));
    // Scan a bit past maxTau so a lobe whose peak lies just inside the range is complete
    const scanTau = Math.min(N - 2, Math.floor(maxTau * 1.5));
    let m = 2 * energy;
    nsdf[0] = 1;
    for (let tau = 1; tau <= scanTau + 1; tau++) {
      m -= x[tau - 1] * x[tau - 1] + x[N - tau] * x[N - tau];
      nsdf[tau] = m > 1e-12 ? (2 * re[tau] * scale) / m : 0;
    }

    // Key maxima: highest point of each positive lobe after the first zero crossing
    const peaks = [];
    let tau = 1;
    while (tau < maxTau && nsdf[tau] > 0) tau++;
    while (tau < maxTau) {
      while (tau < maxTau && nsdf[tau] <= 0) tau++;
      let best = -Infinity, bestTau = -1;
      while (tau < scanTau && nsdf[tau] > 0) {
        if (nsdf[tau] > best) { best = nsdf[tau]; bestTau = tau; }
        tau++;
      }
      if (bestTau > 0 && bestTau <= maxTau && tau < scanTau) peaks.push(bestTau);
    }
    let globalMax = 0;
    for (const p of peaks) if (p >= minTau && nsdf[p] > globalMax) globalMax = nsdf[p];
    if (globalMax <= 0) return { freq: 0, clarity: 0, rms };
    const chosen = peaks.find((p) => p >= minTau && nsdf[p] >= k * globalMax);

    const a = nsdf[chosen - 1], b = nsdf[chosen], c = nsdf[chosen + 1];
    const denom = a - 2 * b + c;
    const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
    const clarity = b - 0.25 * (a - c) * shift;
    return { freq: sr / (chosen + shift), clarity, rms };
  }
}

// ------------------------------------------------ polyphonic estimation
export class PolyDetector {
  constructor(size, sampleRate) {
    this.size = size;
    this.sr = sampleRate;
    this.fft = new FFT(size);
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
    this.mag = new Float64Array(size / 2);
    this.residual = new Float64Array(size / 2);
    this.win = new Float64Array(size);
    this.winLen = 0;
    this.binHz = sampleRate / size;
  }

  static HANN_TABLE = new Float64Array(131072);
  static {
    for (let i = 0; i < 131072; i++) {
      this.HANN_TABLE[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / 131072);
    }
  }

  // Spectrum of the most recent `length` samples (Hann windowed, zero padded to size).
  spectrum(buf, length = this.size) {
    const N = this.size, { re, im, mag, win } = this;
    const L = Math.min(N, length, buf.length);
    this.lobe = (2 * N) / L; // Hann main-lobe half-width, in (zero-padded) bins
    if (L !== this.winLen) {
      const step = 131071 / (L - 1);
      const table = PolyDetector.HANN_TABLE;
      for (let i = 0; i < L; i++) win[i] = table[(i * step) | 0];
      const phaseStep = (2 * Math.PI) / (L - 1);
      let cos = 1, sin = 0;
      const cosStep = Math.cos(phaseStep);
      const sinStep = Math.sin(phaseStep);
      for (let i = 0; i < L; i++) {
        win[i] = 0.5 - 0.5 * cos;
        const nextCos = cos * cosStep - sin * sinStep;
        const nextSin = sin * cosStep + cos * sinStep;
        cos = nextCos;
        sin = nextSin;
      }
      this.winLen = L;
    }
    const off = buf.length - L;
    for (let i = 0; i < L; i++) { re[i] = buf[off + i] * win[i]; im[i] = 0; }
    re.fill(0, L); im.fill(0, L);
    this.fft.transform(re, im);
    // Mild magnitude compression evens out the strong fundamentals of DI signals
    for (let k = 0; k < N / 2; k++) mag[k] = Math.sqrt(Math.sqrt(re[k] * re[k] + im[k] * im[k]));
    return mag;
  }

  // Relative search tolerance for harmonic h: string partials run sharp as h grows
  static tolerance(h) {
    return Math.min(0.04, 0.01 + 0.00005 * h * h);
  }

  // Max of arr in a window around frequency f (the h-th harmonic); returns [value, bin]
  peakAt(arr, f, h = 1) {
    const c = f / this.binHz;
    const tol = Math.max(1.5, (f * PolyDetector.tolerance(h)) / this.binHz);
    const lo = Math.max(1, Math.floor(c - tol)), hi = Math.min(arr.length - 2, Math.ceil(c + tol));
    let v = 0, bin = -1;
    for (let b = lo; b <= hi; b++) if (arr[b] > v) { v = arr[b]; bin = b; }
    return [v, bin];
  }

  salience(arr, f0, fmax) {
    let s = 0;
    for (let h = 1; h * f0 < fmax && h <= 20; h++) {
      s += ((f0 + 27) / (h * f0 + 320)) * this.peakAt(arr, h * f0, h)[0];
    }
    return s;
  }

  // Spectral level near frequency f in the last analysed frame, relative to its peak (0..1)
  levelAt(f) {
    return this.magMax ? this.peakAt(this.mag, f)[0] / this.magMax : 0;
  }

  isHarmonicOf(f0, notes) {
    return notes.some((n) => {
      const h = Math.round(f0 / n.freq);
      return h >= 2 && Math.abs(f0 / (h * n.freq) - 1) < PolyDetector.tolerance(h) + 0.006;
    });
  }

  // Returns detected notes [{midi, freq, cents, strength}] sorted by pitch.
  // `length` limits analysis to the most recent samples (e.g. since the last pick attack).
  analyze(buf, { minMidi = 28, maxMidi = 88, a4 = 440, maxNotes = 6, relThreshold = 0.22, fundRatio = 0.08, harmonicKeep = 0.75, gate = 0.002, length = this.size } = {}) {
    const L = Math.min(this.size, length, buf.length);
    if (rmsOf(buf, L) < gate) return [];
    const mag = this.spectrum(buf, L);
    const res = this.residual;
    res.set(mag);
    let globalMax = 0;
    for (let k = 1; k < mag.length; k++) if (mag[k] > globalMax) globalMax = mag[k];
    this.magMax = globalMax;
    if (globalMax <= 0) return [];
    const fmax = Math.min(6000, this.sr / 2 - 100);

    const notes = [];
    const taken = new Set();
    let firstSal = 0;
    while (notes.length < maxNotes) {
      let best = null;
      for (let m = minMidi; m <= maxMidi; m++) {
        if (taken.has(m)) continue;
        for (let cents = -30; cents <= 30; cents += 10) {
          const f0 = midiToFreq(m + cents / 100, a4);
          const [fund, fb] = this.peakAt(res, f0);
          if (fund < fundRatio * globalMax) continue;
          // The fundamental must be a real peak, not the skirt of a neighbouring note
          if (res[fb - 1] > fund || res[fb + 1] > fund) continue;
          // A partial of an already-found note only counts as a new note if most of
          // its energy is still unexplained after subtraction.
          if (this.isHarmonicOf(f0, notes) && fund < harmonicKeep * this.peakAt(mag, f0)[0]) continue;
          const s = this.salience(res, f0, fmax);
          if (!best || s > best.sal) best = { midi: m, f0, sal: s };
        }
      }
      if (!best) break;
      if (notes.length === 0) firstSal = best.sal;
      else if (best.sal < relThreshold * firstSal) break;

      // Refine frequency from the fundamental peak (parabolic on log magnitude)
      const [, bin] = this.peakAt(mag, best.f0);
      let freq = best.f0;
      if (bin > 0) {
        const a = Math.log(mag[bin - 1] + 1e-12), b = Math.log(mag[bin] + 1e-12), c = Math.log(mag[bin + 1] + 1e-12);
        const d = a - 2 * b + c;
        freq = (bin + (d !== 0 ? (0.5 * (a - c)) / d : 0)) * this.binHz;
      }
      const exact = freqToMidi(freq, a4);
      notes.push({ midi: best.midi, freq, cents: Math.round((exact - best.midi) * 100), strength: best.sal });
      for (let d = -1; d <= 1; d++) taken.add(best.midi + d);
      this.subtract(res, best.f0, fmax);
    }
    return notes.sort((x, y) => x.midi - y.midi);
  }

  // Remove the estimated harmonic series of f0 from the residual spectrum,
  // using spectral smoothness so shared partials (e.g. octaves) survive.
  subtract(res, f0, fmax) {
    const amps = [];
    for (let h = 1; h * f0 < fmax && h <= 20; h++) amps.push(this.peakAt(res, h * f0, h)[0]);
    for (let i = 0; i < amps.length; i++) {
      const h = i + 1;
      const lo = Math.max(0, i - 1), hi = Math.min(amps.length - 1, i + 1);
      let smooth = 0;
      for (let j = lo; j <= hi; j++) smooth += amps[j];
      smooth /= hi - lo + 1;
      const a = amps[i];
      if (a <= 0) continue;
      const est = h === 1 ? a : Math.min(a, smooth);
      const factor = Math.max(0, 1 - est / a);
      const c = (h * f0) / this.binHz;
      const tol = Math.max(1.5, (h * f0 * PolyDetector.tolerance(h)) / this.binHz) + this.lobe;
      const blo = Math.max(0, Math.floor(c - tol)), bhi = Math.min(res.length - 1, Math.ceil(c + tol));
      for (let b = blo; b <= bhi; b++) res[b] *= factor;
    }
  }
}

// Index in buf of the most recent attack (energy jump between short blocks), or -1.
export function findOnset(buf, { block = 512, ratio = 4, gate = 0.002 } = {}) {
  const nb = Math.floor(buf.length / block);
  const start = buf.length - nb * block;
  const e = new Float64Array(nb);
  for (let b = 0; b < nb; b++) {
    let s = 0;
    for (let i = start + b * block, end = i + block; i < end; i++) s += buf[i] * buf[i];
    e[b] = s / block;
  }
  for (let b = nb - 1; b >= 4; b--) {
    const before = (e[b - 1] + e[b - 2] + e[b - 3] + e[b - 4]) / 4;
    if (e[b] > ratio * before + 1e-9 && e[b] > gate * gate) return start + b * block;
  }
  return -1;
}

// ------------------------------------------------------------ chord naming
const CHORDS = [
  { s: '', name: 'major', iv: [0, 4, 7] },
  { s: 'm', name: 'minor', iv: [0, 3, 7] },
  { s: '5', name: 'power chord', iv: [0, 7] },
  { s: '7', name: 'dominant 7th', iv: [0, 4, 7, 10] },
  { s: 'maj7', name: 'major 7th', iv: [0, 4, 7, 11] },
  { s: 'm7', name: 'minor 7th', iv: [0, 3, 7, 10] },
  { s: 'm(maj7)', name: 'minor-major 7th', iv: [0, 3, 7, 11] },
  { s: '6', name: 'major 6th', iv: [0, 4, 7, 9] },
  { s: 'm6', name: 'minor 6th', iv: [0, 3, 7, 9] },
  { s: 'sus2', name: 'suspended 2nd', iv: [0, 2, 7] },
  { s: 'sus4', name: 'suspended 4th', iv: [0, 5, 7] },
  { s: '7sus4', name: 'dominant 7th sus4', iv: [0, 5, 7, 10] },
  { s: 'dim', name: 'diminished', iv: [0, 3, 6] },
  { s: 'dim7', name: 'diminished 7th', iv: [0, 3, 6, 9] },
  { s: 'm7b5', name: 'half-diminished', iv: [0, 3, 6, 10] },
  { s: 'aug', name: 'augmented', iv: [0, 4, 8] },
  { s: 'add9', name: 'added 9th', iv: [0, 4, 7, 2] },
  { s: 'm(add9)', name: 'minor added 9th', iv: [0, 3, 7, 2] },
  { s: '9', name: 'dominant 9th', iv: [0, 4, 7, 10, 2] },
  { s: 'maj9', name: 'major 9th', iv: [0, 4, 7, 11, 2] },
  { s: 'm9', name: 'minor 9th', iv: [0, 3, 7, 10, 2] },
  { s: '7#9', name: 'dominant 7th sharp 9', iv: [0, 4, 7, 10, 3] },
];

const INTERVAL_NAMES = ['unison', 'minor 2nd', 'major 2nd', 'minor 3rd', 'major 3rd', 'perfect 4th', 'tritone', 'perfect 5th', 'minor 6th', 'major 6th', 'minor 7th', 'major 7th'];

// midis: detected MIDI notes. Returns ranked candidates [{name, longName, score}].
export function nameChord(midis) {
  if (!midis.length) return [];
  const sorted = [...midis].sort((a, b) => a - b);
  const bass = pc(sorted[0]);
  const pcs = [...new Set(sorted.map(pc))];
  if (pcs.length === 1) return [{ name: NOTE_NAMES[bass], longName: 'single note / octaves', score: 1 }];
  if (pcs.length === 2) {
    const iv = (pcs.find((p) => p !== bass) - bass + 12) % 12;
    if (iv === 7) return [{ name: NOTE_NAMES[bass] + '5', longName: 'power chord', score: 1 }];
    return [{ name: `${NOTE_NAMES[bass]} + ${NOTE_NAMES[(bass + iv) % 12]}`, longName: INTERVAL_NAMES[iv] + ' (dyad)', score: 0.5 }];
  }
  const out = [];
  for (const root of pcs) {
    const rel = new Set(pcs.map((p) => (p - root + 12) % 12));
    for (const ch of CHORDS) {
      if (ch.iv.length < 3) continue;
      let hit = 0, missing = 0;
      for (const iv of ch.iv) {
        if (rel.has(iv)) hit++;
        else missing += iv === 7 ? 0.4 : 1; // a dropped 5th is common
      }
      const extra = [...rel].filter((iv) => !ch.iv.includes(iv)).length;
      const score = hit * 2 - missing * 3 - extra * 2.5 + (root === bass ? 1.5 : 0) - ch.iv.length * 0.1;
      const slash = root !== bass ? '/' + NOTE_NAMES[bass] : '';
      out.push({ name: NOTE_NAMES[root] + ch.s + slash, longName: `${NOTE_NAMES[root]} ${ch.name}${slash ? ', ' + NOTE_NAMES[bass] + ' in bass' : ''}`, score });
    }
  }
  out.sort((a, b) => b.score - a.score);
  const seen = new Set();
  return out.filter((c) => !seen.has(c.name) && seen.add(c.name)).slice(0, 4);
}

// ------------------------------------------------------- fretboard layout
// All (string, fret) positions for one MIDI note. Strings are indexed low→high.
export function positionsFor(midi, tuning, maxFret) {
  const out = [];
  tuning.forEach((open, s) => {
    const f = midi - open;
    if (f >= 0 && f <= maxFret) out.push({ string: s, fret: f });
  });
  return out;
}

// Find playable fingerings for a set of notes: each note on its own string,
// limited stretch, preferring low positions, open strings and contiguous strings.
// Returns up to `limit` options: {frets: [fret|null per string], cost}.
export function findFingerings(midis, tuning, maxFret, { maxSpan = 4, limit = 5 } = {}) {
  const notes = [...new Set(midis.map(Math.round))].sort((a, b) => a - b);
  if (!notes.length) return [];
  const results = [];
  const frets = new Array(tuning.length).fill(null);

  const evaluate = () => {
    const played = [];
    frets.forEach((f, s) => f !== null && played.push([s, f]));
    const fretted = played.filter(([, f]) => f > 0).map(([, f]) => f);
    const minF = fretted.length ? Math.min(...fretted) : 0;
    const maxF = fretted.length ? Math.max(...fretted) : 0;
    if (maxF - minF > maxSpan) return;
    // Finger count, allowing a barre at the lowest fret
    const atMin = fretted.filter((f) => f === minF).length;
    const fingers = fretted.length - (atMin > 1 ? atMin - 1 : 0);
    if (fingers > 4) return;
    const lowS = played[0][0], highS = played[played.length - 1][0];
    const gaps = highS - lowS + 1 - played.length;
    // Pitch order should follow string order
    let crossings = 0;
    for (let i = 1; i < played.length; i++) {
      if (tuning[played[i][0]] + played[i][1] < tuning[played[i - 1][0]] + played[i - 1][1]) crossings++;
    }
    const cost = (maxF - minF) * 0.8 + minF * 0.25 + gaps * 2.5 + crossings * 3 + fingers * 0.3 + (atMin > 1 ? 0.5 : 0);
    results.push({ frets: [...frets], cost });
  };

  const dfs = (i) => {
    if (i === notes.length) return evaluate();
    for (let s = 0; s < tuning.length; s++) {
      if (frets[s] !== null) continue;
      const f = notes[i] - tuning[s];
      if (f < 0 || f > maxFret) continue;
      frets[s] = f;
      dfs(i + 1);
      frets[s] = null;
    }
  };
  dfs(0);
  results.sort((a, b) => a.cost - b.cost);
  const seen = new Set();
  return results.filter((r) => { const k = r.frets.join(','); return !seen.has(k) && seen.add(k); }).slice(0, limit);
}
