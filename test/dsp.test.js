// Run: node test/dsp.test.js
// Synthesises plucked-string signals and checks pitch, polyphony, chord naming and fingering.
import { PitchDetector, PolyDetector, nameChord, findFingerings, findOnset, midiToFreq, noteName, freqToMidi } from '../js/dsp.js';

const SR = 48000;
let seed = Number(process.env.SEED || 12345);
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

// String-like tone: inharmonic partials, per-partial decay, random partial levels.
function pluck(buf, midi, { amp = 0.2, detuneCents = 0, start = 0, B = 1e-4 } = {}) {
  const f0 = midiToFreq(midi + detuneCents / 100);
  for (let h = 1; h <= 30; h++) {
    const fh = h * f0 * Math.sqrt(1 + B * h * h);
    if (fh > SR / 2 - 1000) break;
    const a = (amp / Math.pow(h, 0.9)) * (0.4 + 0.6 * rand());
    const decay = 1.5 + h * 0.6;
    const ph = rand() * 2 * Math.PI;
    for (let i = start; i < buf.length; i++) {
      const t = (i - start) / SR;
      buf[i] += a * Math.exp(-decay * t) * Math.sin(2 * Math.PI * fh * t + ph);
    }
  }
}
const signal = (len = SR) => {
  const b = new Float32Array(len);
  for (let i = 0; i < len; i++) b[i] = (rand() - 0.5) * 0.002;
  return b;
};

let fails = 0, total = 0;
const check = (ok, msg) => { total++; if (!ok) fails++; console.log(`${ok ? '  ok ' : 'FAIL '} ${msg}`); };

console.log('Monophonic pitch (MPM)');
for (const [size, notes, lowpass] of [[4096, [40, 45, 50, 55, 59, 64, 69, 76, 88], 1200], [8192, [23, 28, 33, 38, 43, 52], 500]]) {
  const det = new PitchDetector(size, SR);
  for (const m of notes) {
    for (const dc of [0, -23, 17]) {
      const b = signal(SR);
      pluck(b, m, { detuneCents: dc });
      const r = det.detect(b.subarray(0, Math.round(SR * 0.4)), { lowpass });
      const cents = (freqToMidi(r.freq) - m) * 100;
      check(Math.abs(cents - dc) < 3, `${noteName(m)} ${dc >= 0 ? '+' : ''}${dc}c (N=${size}) → ${r.freq.toFixed(2)} Hz, ${cents.toFixed(1)}c, clarity ${r.clarity.toFixed(2)}`);
    }
  }
}

const GUITAR = [40, 45, 50, 55, 59, 64];
const BASS = [28, 33, 38, 43];
const chords = [
  ['E', [40, 47, 52, 56, 59, 64]],
  ['A', [45, 52, 57, 61, 64]],
  ['D', [50, 57, 62, 66]],
  ['G', [43, 47, 50, 55, 59, 67]],
  ['C', [48, 52, 55, 60, 64]],
  ['Am', [45, 52, 57, 60, 64]],
  ['Em', [40, 47, 52, 55, 59, 64]],
  ['Dm', [50, 57, 62, 65]],
  ['F', [41, 48, 53, 57, 60, 65]],
  ['B7', [47, 51, 57, 59, 66]],
  ['E5', [40, 47, 52]],
  ['A5', [45, 52]],
  ['Cmaj7', [48, 52, 55, 59, 64]],
  ['Bm', [47, 54, 59, 62, 66]],
  ['Dsus4', [50, 57, 62, 67]],
];

console.log('\nPolyphonic notes + chord names (guitar)');
for (const size of [32768]) {
  const poly = new PolyDetector(size, SR);
  let ok = 0;
  for (const [name, notes] of chords) {
    const b = signal(SR);
    notes.forEach((m, i) => pluck(b, m, { amp: 0.12, start: i * 480, detuneCents: (rand() - 0.5) * 10 }));
    const det = poly.analyze(b.subarray(0, size + 4800), { minMidi: 40, maxMidi: 86 });
    const got = det.map((d) => d.midi);
    const cands = nameChord(got);
    const top = cands[0]?.name;
    const pass = top === name;
    if (pass) ok++;
    check(pass, `N=${size} ${name.padEnd(6)} expected [${notes.map(noteName).join(' ')}] got [${got.map(noteName).join(' ')}] → ${top} (${cands.map((c) => c.name).join(', ')})`);
  }
  console.log(`  N=${size}: ${ok}/${chords.length} chords named correctly`);
}

console.log('\nShort window after an attack (0.25 s of a 32768 buffer)');
{
  const poly = new PolyDetector(32768, SR);
  let ok = 0;
  for (const [name, notes] of chords) {
    // previous chord ringing, then the new chord attacks 0.28 s before the end of the buffer
    const b = signal(32768);
    const attack = 32768 - Math.round(SR * 0.28);
    pluck(b, 59, { amp: 0.1 });
    for (let i = attack; i < b.length; i++) b[i] *= 0.03; // old chord damped by the chord change
    notes.forEach((m, i) => pluck(b, m, { amp: 0.12, start: attack + i * 240 }));
    const onset = findOnset(b);
    const len = b.length - onset - Math.round(SR * 0.03);
    const got = poly.analyze(b, { minMidi: 40, maxMidi: 86, length: len }).map((d) => d.midi);
    const top = nameChord(got)[0]?.name;
    if (top === name) ok++;
    check(top === name && Math.abs(onset - attack) < 1536, `${name.padEnd(6)} onset ${onset - attack >= 0 ? '+' : ''}${onset - attack} samples, [${got.map(noteName).join(' ')}] → ${top}`);
  }
  console.log(`  ${ok}/${chords.length} chords named correctly`);
}

console.log('\nBass');
{
  const poly = new PolyDetector(32768, SR);
  for (const [name, notes] of [['E5', [28, 35]], ['A5', [33, 40]], ['G', [31, 38, 47]]]) {
    const b = signal(SR);
    notes.forEach((m) => pluck(b, m, { amp: 0.2 }));
    const det = poly.analyze(b, { minMidi: 23, maxMidi: 67 });
    const top = nameChord(det.map((d) => d.midi))[0]?.name;
    check(top === name, `${name} → [${det.map((d) => noteName(d.midi)).join(' ')}] ${top}`);
  }
}

console.log('\nFingerings');
const fmt = (f) => f.map((x) => (x === null ? 'x' : x)).join('');
for (const [name, notes, expect] of [
  ['C', [48, 52, 55, 60, 64], 'x32010'],
  ['G', [43, 47, 50, 55, 59, 67], '320003'],
  ['Am', [45, 52, 57, 60, 64], 'x02210'],
  ['D', [50, 57, 62, 66], 'xx0232'],
  ['E', [40, 47, 52, 56, 59, 64], '022100'],
  ['F', [41, 48, 53, 57, 60, 65], '133211'],
]) {
  const opts = findFingerings(notes, GUITAR, 22);
  check(opts.length && fmt(opts[0].frets) === expect, `${name} → ${opts.slice(0, 3).map((o) => fmt(o.frets)).join(' | ')} (expect ${expect})`);
}
const bassOpts = findFingerings([28, 35], BASS, 24);
check(fmt(bassOpts[0].frets) === '02xx', `bass E5 → ${fmt(bassOpts[0].frets)}`);

console.log(`\n${total - fails}/${total} passed`);
process.exit(fails ? 1 : 0);
