// Run: node test/analysis.test.js
// Microphone-like scenarios for the live chord tracker: fan noise + hum, room reflections,
// strummed chords with uneven strings. Fed exactly like the app: ~60 updates per second.
import { PolyDetector, nameChord, findOnset, noteName, pc } from '../js/dsp.js';

import { SR, rand, fan, pluck, strum, room, mix, runTracker } from './synth.js';

// The previous logic (raw detections + short-term votes), for comparison
function runLegacy(signal) {
  const poly = new PolyDetector(32768, SR);
  const votes = new Map();
  let notes = [], lastOnset = -Infinity, lastPoly = -1e9;
  const frames = [];
  for (let end = 32768; end < signal.length; end += 800) {
    const buf = signal.subarray(end - 32768, end);
    const now = (end / SR) * 1000;
    if (now - lastPoly > 110) {
      lastPoly = now;
      const onset = findOnset(buf, { gate: 0.0025 });
      let length = 32768, fresh = false, skip = false;
      if (onset >= 0) {
        length = buf.length - onset - Math.round(SR * 0.03);
        const at = end - (buf.length - onset);
        if (length < SR * 0.2) skip = true;
        else if (at - lastOnset > 4096) { lastOnset = at; votes.clear(); fresh = true; }
      }
      if (!skip) {
        const det = poly.analyze(buf, { minMidi: 39, maxMidi: 86, gate: 0.0025, length, minSnr: 0 });
        const present = new Map(det.map((n) => [n.midi, n]));
        for (const m of new Set([...votes.keys(), ...present.keys()])) {
          const v = votes.get(m) || { score: 0 };
          v.score = fresh ? 0.6 : v.score * 0.6 + (present.has(m) ? 0.4 : 0);
          if (present.has(m)) v.note = present.get(m);
          if (v.score < 0.05) votes.delete(m); else votes.set(m, v);
        }
        notes = [...votes.values()].filter((v) => v.score > 0.55).map((v) => v.note);
      }
    }
    frames.push({ t: end / SR, name: notes.length ? nameChord(notes.map((n) => n.midi))[0]?.name : null });
  }
  return frames;
}

const flips = (names) => names.filter((n, i) => i > 0 && n !== names[i - 1]).length;

let fails = 0, total = 0;
const check = (ok, msg) => { total++; if (!ok) fails++; console.log(`${ok ? '  ok ' : 'FAIL '} ${msg}`); };

console.log('Background noise only (12 s)');
for (const [label, rms] of [['quiet fan, −46 dBFS', 0.005], ['loud fan / phone mic gain, −34 dBFS', 0.02]]) {
  const sig = fan(SR * 12, rms);
  const shown = runTracker(sig).filter((f) => f.t > 1 && f.fresh);
  const legacy = runLegacy(sig).filter((f) => f.t > 1 && f.name);
  check(shown.length === 0, `${label}: tracker shows nothing (${shown.length} frames with notes; old logic: ${legacy.length} frames, ${new Set(legacy.map((f) => f.name)).size} different "chords")`);
}

const CHORDS = [
  ['G', [43, 47, 50, 55, 59, 67]],
  ['C', [48, 52, 55, 60, 64]],
  ['D', [50, 57, 62, 66]],
  ['Em', [40, 47, 52, 55, 59, 64]],
  ['Am', [45, 52, 57, 60, 64]],
  ['F', [41, 48, 53, 57, 60, 65]],
  ['E5', [40, 47, 52]],
  ['A', [45, 52, 57, 61, 64]],
];
const STRUM_S = 2.5;

// [label, fan level, strum level, threshold dB, expectation]
//  'exact': full chord names; 'chord': right chord, slash bass may be missed (a softly hit low
//  string can drown in fan rumble); 'root': root right; 'steady': only steadiness and silence
//  on background are required (strums 6–8 dB above a loud fan), accuracy is reported.
for (const [label, noiseRms, amp, marginDb, expect] of [
  ['quiet room', 0.005, 0.08, 9, 'exact'],
  ['fan at −40 dBFS (strums ~16 dB above it)', 0.01, 0.08, 9, 'chord'],
  ['loud fan, −34 dBFS (strums ~10 dB above it)', 0.02, 0.08, 9, 'root'],
  ['soft strumming, loud fan, threshold lowered to 6 dB', 0.02, 0.03, 6, 'steady'],
]) {
  console.log(`\nStrummed chords through a room mic, ${label}`);
  const len = Math.round(SR * (1.5 + CHORDS.length * STRUM_S + 1));
  const guitar = new Float32Array(len);
  CHORDS.forEach(([, m], k) => strum(guitar, Math.round(SR * (1.5 + k * STRUM_S)), m, amp));
  const sig = mix(room(guitar), fan(len, noiseRms));
  const frames = runTracker(sig, { marginDb });
  const legacy = runLegacy(sig);
  let correct = 0, chordsRight = 0, roots = 0, totalFlips = 0, legacyFlips = 0, legacyCorrect = 0;
  CHORDS.forEach(([name], k) => {
    const t0 = 1.5 + k * STRUM_S, t1 = t0 + STRUM_S;
    const inEvent = frames.filter((f) => f.t > t0 && f.t <= t1 && f.name).map((f) => f.name);
    const shown = inEvent.at(-1);
    const majority = [...new Set(inEvent)].sort((a, b) => inEvent.filter((x) => x === b).length - inEvent.filter((x) => x === a).length)[0];
    const leg = legacy.filter((f) => f.t > t0 && f.t <= t1 && f.name).map((f) => f.name);
    const legMajority = [...new Set(leg)].sort((a, b) => leg.filter((x) => x === b).length - leg.filter((x) => x === a).length)[0];
    if (majority === name) correct++;
    if (majority && majority.split('/')[0] === name) chordsRight++;
    if (majority && majority.match(/^[A-G]#?/)[0] === name.match(/^[A-G]#?/)[0]) roots++;
    if (legMajority === name) legacyCorrect++;
    totalFlips += flips(inEvent);
    legacyFlips += flips(leg);
    const firstAt = frames.find((f) => f.t > t0 && f.t <= t1 && f.name === name)?.t;
    console.log(`   ${name.padEnd(3)} → ${(majority || '–').padEnd(8)} changes ${flips(inEvent)}${firstAt ? `, shown after ${((firstAt - t0) * 1000).toFixed(0)} ms` : ''}   | old: ${(legMajority || '–').padEnd(8)} changes ${flips(leg)}`);
  });
  const summary = `${correct}/${CHORDS.length} full names, ${chordsRight}/${CHORDS.length} right ignoring slash bass, ${roots}/${CHORDS.length} roots (old logic: ${legacyCorrect}/${CHORDS.length} names)`;
  if (expect === 'exact') check(correct >= CHORDS.length - 1, summary);
  else if (expect === 'chord') check(chordsRight >= CHORDS.length - 2, summary);
  else if (expect === 'root') check(roots >= CHORDS.length - 2, summary);
  else console.log(`   (best effort) ${summary}`);
  check(totalFlips <= CHORDS.length, `display changes within strums: ${totalFlips} (old logic: ${legacyFlips})`);
  const afterLast = frames.filter((f) => f.t > 1.5 + CHORDS.length * STRUM_S + 0.6 && f.fresh);
  check(afterLast.length === 0, 'once the last chord has died away, background noise shows nothing');
}

console.log('\nSingle notes stay single notes');
{
  const len = SR * 9; // notes from 2 s: the tracker ignores the first moments after audio starts
  const guitar = new Float32Array(len);
  [45, 52, 57, 40].forEach((m, k) => {
    const at = Math.round(SR * (2 + k * 1.6));
    for (let i = at; i < len; i++) guitar[i] *= Math.exp(-(i - at) / (0.02 * SR)); // same string: previous note stops
    pluck(guitar, at, m, 0.08);
  });
  const frames = runTracker(mix(room(guitar), fan(len, 0.005)));
  const pcsShown = frames.filter((f) => f.fresh).map((f) => new Set(f.notes.map((n) => pc(n.midi))).size);
  const multi = pcsShown.filter((n) => n > 1).length;
  check(multi <= pcsShown.length * 0.05, `single notes: ${multi}/${pcsShown.length} frames show more than one note`);
  const found = [45, 52, 57, 40].map((m, k) => frames.some((f) => f.t > 2 + k * 1.6 && f.t < 3.6 + k * 1.6 && f.notes[0]?.midi === m));
  check(found.every(Boolean), `each note detected: ${[45, 52, 57, 40].map(noteName).join(' ')}`);
}

console.log(`\n${total - fails}/${total} passed`);
process.exit(fails ? 1 : 0);
