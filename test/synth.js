// Synthetic microphone scenarios shared by the analysis tests and debugging scripts.
import { ChordTracker } from '../js/analysis.js';
import { nameChord, midiToFreq } from '../js/dsp.js';

export const SR = 48000;
// mulberry32: a proper 32-bit generator (a naive LCG in floating point overflows 2^53 and
// turns "noise" into a periodic, tonal signal)
let seed = Number(process.env.SEED || 7) >>> 0;
export const rand = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

// Fan: low-passed noise (rumble) + white noise (air) + 50 Hz mains hum and harmonics +
// blade tone (137 Hz and harmonic), slowly wobbling
export function fan(len, rms) {
  const x = new Float32Array(len);
  let lp1 = 0, lp2 = 0;
  for (let i = 0; i < len; i++) {
    const w = gauss();
    lp1 += 0.05 * (w - lp1);
    lp2 += 0.05 * (lp1 - lp2);
    const t = i / SR;
    const hum = 0.3 * Math.sin(2 * Math.PI * 50 * t) + 0.2 * Math.sin(2 * Math.PI * 100 * t) + 0.1 * Math.sin(2 * Math.PI * 150 * t)
      + 0.25 * Math.sin(2 * Math.PI * 137 * t) + 0.12 * Math.sin(2 * Math.PI * 274 * t);
    x[i] = (lp2 * 6 + w * 0.5 + hum) * (1 + 0.2 * Math.sin(2 * Math.PI * 0.3 * t));
  }
  let e = 0;
  for (const v of x) e += v * v;
  const k = rms / Math.sqrt(e / len);
  for (let i = 0; i < len; i++) x[i] *= k;
  return x;
}

export function pluck(buf, start, midi, amp) {
  const f0 = midiToFreq(midi + (rand() - 0.5) * 0.08);
  for (let h = 1; h <= 25; h++) {
    const fh = h * f0 * Math.sqrt(1 + 1e-4 * h * h);
    if (fh > SR / 2 - 1000) break;
    const a = (amp / Math.pow(h, 1.1)) * (0.3 + 0.7 * rand());
    const decay = 1.2 + h * 0.5, ph = rand() * 6.28;
    for (let i = start, n = Math.min(buf.length, start + SR * 4); i < n; i++) {
      const t = (i - start) / SR;
      buf[i] += a * Math.exp(-decay * t) * Math.sin(2 * Math.PI * fh * t + ph);
    }
  }
}

// Strum: strings 12 ms apart with uneven levels, plus the previous chord damped
export function strum(buf, start, midis, amp) {
  // Changing chords lifts the fretting fingers: the previous chord stops within ~30 ms
  for (let i = start; i < buf.length; i++) buf[i] *= Math.exp(-(i - start) / (0.03 * SR));
  midis.forEach((m, i) => pluck(buf, start + Math.round(i * 0.012 * SR), m, amp * (0.6 + 0.4 * rand())));
}

// A few early reflections, like a mic in a small room
export function room(x) {
  const y = Float32Array.from(x);
  for (const [ms, g] of [[7, 0.35], [13, 0.25], [23, 0.18], [41, 0.1]]) {
    const d = Math.round((ms / 1000) * SR);
    for (let i = d; i < x.length; i++) y[i] += g * x[i - d];
  }
  return y;
}

export function mix(...parts) {
  const out = new Float32Array(parts[0].length);
  for (const p of parts) for (let i = 0; i < out.length; i++) out[i] += p[i];
  return out;
}

// Feed a signal through the tracker like the app does; returns what would be displayed per frame
export function runTracker(signal, opts = {}) {
  const tr = new ChordTracker(SR, opts);
  const frames = [];
  const hop = 800;
  for (let end = 32768; end < signal.length; end += hop) {
    const buf = signal.subarray(end - 32768, end);
    tr.update(buf, { end: end - 1, now: (end / SR) * 1000, minMidi: 39, maxMidi: 86 });
    frames.push({ t: end / SR, active: tr.active, fresh: tr.fresh, name: tr.fresh ? nameChord(tr.notes.map((n) => n.midi))[0]?.name : null, notes: tr.notes });
  }
  return frames;
}

