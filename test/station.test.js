// Run: node test/station.test.js
// Drives the loop-station worklet outside the browser. The input signal encodes transport
// time (x = t * 1e-6), so recorded samples reveal exactly when they were captured.
const SR = 48000;
globalThis.sampleRate = SR;
globalThis.AudioWorkletProcessor = class {
  constructor() { this.port = { postMessage: (m) => this.sent?.push(m), onmessage: null }; }
};
let Station;
globalThis.registerProcessor = (_, cls) => { Station = cls; };
await import('../js/station-worklet.js');

const CLICK4 = { beats: 4, sub: 1, p: { a: 'X...', c: '.xxx' } };
const L = 480; // 10 ms latency compensation

function make(settings = {}) {
  const st = new Station();
  st.sent = [];
  st.send = (msg) => st.port.onmessage({ data: msg });
  st.send({ cmd: 'settings', bpm: 120, pattern: CLICK4, latency: L, countIn: false, quantize: 'bar', metronome: false, metroVol: 0, recBars: 0, ...settings });
  let id = 10;
  for (let i = 0; i < 3; i++) st.send({ cmd: 'recBuffer', track: i, id: i + 1, data: new Float32Array(91 * SR) });
  st.out = [];
  // Plays the role of the main thread: answers buffer requests
  st.serve = () => {
    for (const m of st.sent.splice(0)) {
      if (m.type === 'need') st.send({ cmd: 'buffer', track: m.track, id: id++, data: new Float32Array(m.len) });
    }
  };
  st.input = (t) => t * 1e-6;
  st.run = (samples) => {
    for (let done = 0; done < samples; done += 128) {
      const t0 = st.t;
      const inp = new Float32Array(128);
      for (let i = 0; i < 128; i++) inp[i] = st.running ? st.input(t0 + i) : 0;
      const out = new Float32Array(128);
      st.process([[inp]], [[out]]);
      st.lastOut = out;
      st.lastT0 = t0;
      st.serve();
    }
  };
  st.runTo = (t) => st.run(Math.max(0, t - st.t));
  st.press = (track, action = 'main') => st.send({ cmd: 'track', track, action });
  return st;
}

let fails = 0, total = 0;
const check = (ok, msg) => { total++; if (!ok) fails++; console.log(`${ok ? '  ok ' : 'FAIL '} ${msg}`); };
const near = (a, b, eps = 2e-7) => Math.abs(a - b) < eps;
const BAR = 96000; // 4/4 at 120 bpm

console.log('First take: quantized end, whole bars, latency-aligned');
{
  const st = make();
  st.press(0);
  check(st.running && st.tracks[0].queue[0]?.at === 0, 'transport starts and recording begins at once (no count-in)');
  st.runTo(Math.round(1.5 * BAR));
  st.press(0);
  check(st.tracks[0].queue[0]?.at === 2 * BAR, 'closing the loop mid-bar waits for the next bar');
  st.runTo(2 * BAR + 5000);
  const tr = st.tracks[0];
  check(tr.state === 'playing' && tr.len === 2 * BAR, `loop is exactly 2 bars (${tr.len} samples)`);
  check(near(tr.rec[0], L * 1e-6) && near(tr.rec[1000], (1000 + L) * 1e-6), 'sample k holds input from t = k + latency');
  check(near(tr.rec[tr.len - 1], (tr.len - 1 + L) * 1e-6), 'the latency tail after the boundary is captured');
  // Output plays the loop from the top at the boundary
  const p = st.lastT0 % tr.len;
  check(near(st.lastOut[0], tr.rec[p], 1e-6), 'playback reads the loop in phase with the transport');
}

console.log('\nGrace window and second track');
{
  const st = make();
  st.press(0); st.runTo(Math.round(0.5 * BAR)); st.press(0); st.runTo(BAR + 10);
  st.runTo(2 * BAR + 1000);
  st.press(1);
  check(st.tracks[1].queue[0].at === 2 * BAR, 'pressing 21 ms after the downbeat still starts on that downbeat');
  st.runTo(2 * BAR + 1200);
  check(st.tracks[1].state === 'recording' && st.tracks[1].anchor === 2 * BAR, 'track 2 recording anchored to bar 3');
  st.runTo(4 * BAR + 500);
  st.press(1);
  st.runTo(4 * BAR + 3000);
  check(st.tracks[1].len === 2 * BAR && st.tracks[1].state === 'playing', 'late close counts as the downbeat just passed: 2 bars');
  st.runTo(5 * BAR + 20000);
  st.press(2);
  check(st.tracks[2].queue[0].at === 6 * BAR, 'a press well into the bar waits for the next one');
}

console.log('\nOverdub, undo, redo');
{
  const st = make();
  st.press(0); st.runTo(Math.round(0.6 * BAR)); st.press(0); st.runTo(BAR + 5000); // 1-bar loop
  const tr = st.tracks[0];
  st.input = () => 0.01;
  st.press(0); // overdub at next bar
  check(tr.queue[0].target === 'dubbing' && tr.queue[0].at === 2 * BAR, 'overdub queued for bar 3');
  st.runTo(2 * BAR + 100);
  st.press(0); // end overdub at next bar
  st.runTo(3 * BAR + L + 200);
  check(tr.layers.length === 1 && !tr.dub, 'overdub committed after its latency tail');
  const layer = tr.layers[0].data;
  check(near(layer[0], 0.01, 1e-6) && near(layer[BAR - 1], 0.01, 1e-6), 'one full pass recorded across the whole loop');
  st.input = (t) => t * 1e-6;
  st.runTo(4 * BAR + 300);
  const p = st.lastT0 % BAR;
  check(near(st.lastOut[0], tr.rec[p] + 0.01, 1e-5), 'playback = base + overdub');
  st.press(0, 'undo');
  check(tr.layers.length === 0 && tr.redo.length === 1, 'undo removes the overdub');
  st.press(0, 'redo');
  check(tr.layers.length === 1 && tr.redo.length === 0, 'redo restores it');
  st.press(0); st.press(0);
  check(tr.queue.length === 0, 'pressing twice before the bar cancels the queued action');
  st.runTo(5 * BAR + 100);
  st.press(0); // overdub starts on bar 6 (grace)
  st.runTo(5 * BAR + 300);
  st.press(0); // immediate end request
  check(tr.queue[0]?.at === 6 * BAR, 'an overdub lasts at least one bar even if ended right away');
}

console.log('\nStop and restart stay in phase');
{
  const st = make();
  st.press(0); st.runTo(Math.round(1.2 * BAR)); st.press(0); st.runTo(2 * BAR + 10); // 2-bar loop
  st.press(1); st.runTo(2 * BAR + 100); st.runTo(Math.round(2.4 * BAR)); st.press(1); st.runTo(3 * BAR + 10); // 1-bar loop
  st.press(0, 'stop');
  st.runTo(4 * BAR + 10);
  check(st.tracks[0].state === 'stopped', 'stop takes effect at the next bar');
  st.runTo(Math.round(4.5 * BAR));
  st.press(0);
  st.runTo(5 * BAR + 10);
  const tr = st.tracks[0];
  check(tr.state === 'playing' && tr.anchor === 0, 'restarted track keeps its phase (anchor unchanged)');
  check(st.running, 'transport kept running while track 2 played');
}

console.log('\nCount-in, metronome, fixed length');
{
  const st = make({ countIn: true, metroVol: 1, recBars: 2 });
  st.press(0);
  check(st.tracks[0].queue[0].at === BAR, 'with count-in, recording starts after one bar');
  st.run(256);
  const clickPeak = Math.max(...st.lastOut.map(Math.abs));
  check(clickPeak > 0.05, `count-in click is audible (peak ${clickPeak.toFixed(2)})`);
  st.runTo(BAR + 10);
  check(st.tracks[0].state === 'recording' && st.tracks[0].queue[0]?.at === 3 * BAR, 'fixed 2-bar length queues its own end');
  st.runTo(3 * BAR + 10);
  check(st.tracks[0].state === 'playing' && st.tracks[0].len === 2 * BAR, 'fixed-length take closes itself after 2 bars');
}

console.log('\n90-second limit');
{
  const st = make({ bpm: 60 }); // 4 s bars
  st.press(0);
  st.runTo(92 * SR);
  const tr = st.tracks[0];
  check(tr.state === 'playing' && tr.len === 22 * 4 * SR, `take stops itself at the last whole bar under 90 s (${tr.len / SR} s)`);
}

console.log('\nUndo history merges into the base');
{
  const st = make({ bpm: 240 }); // 4 beats at 240 bpm = 1 s bars
  const bar = SR;
  st.input = () => 0;
  st.press(0); st.runTo(Math.round(0.5 * bar)); st.press(0); st.runTo(bar + L + 200); // incl. latency tail
  st.input = () => 0.01;
  const tr = st.tracks[0];
  const midBar = () => st.runTo(Math.round((Math.floor(st.t / bar) + 1.5) * bar));
  for (let k = 0; k < 8; k++) {
    midBar();
    st.press(0); // dub from the next bar
    midBar();
    st.press(0); // end at the following bar: one full pass
    midBar();
  }
  st.run(SR); // let background merges finish
  const mix = st.mixdown(tr);
  check(tr.layers.length <= 6, `layers kept for undo: ${tr.layers.length}`);
  check(near(mix[100], 0.08, 1e-5) && near(mix[bar - 1], 0.08, 1e-5), `8 overdubs still sum correctly after merging (${mix[100].toFixed(4)})`);
}

console.log('\nTempo lock and stop-all');
{
  const st = make();
  st.press(0); st.runTo(Math.round(2.3 * BAR));
  st.send({ cmd: 'settings', bpm: 90 });
  check(st.bpm === 120, 'tempo cannot change while a loop exists');
  st.send({ cmd: 'stopAll' });
  check(!st.running && st.tracks[0].state === 'stopped' && st.tracks[0].len === 2 * BAR, 'stop-all while recording keeps the whole bars');
  st.send({ cmd: 'playAll' });
  st.run(1280);
  check(st.running && st.tracks[0].state === 'playing' && st.tracks[0].anchor === 0, 'play-all restarts everything from the top');
  st.press(0, 'clear');
  st.send({ cmd: 'stopAll' });
  st.send({ cmd: 'settings', bpm: 90 });
  check(st.bpm === 90, 'tempo changes once all tracks are cleared');
}

console.log('\nRhythm patterns');
{
  const { RHYTHMS } = await import('../js/rhythms.js');
  const bad = RHYTHMS.filter((r) => Object.entries(r.p).some(([v, hits]) => hits.length !== r.beats * r.sub || !'acksohr'.includes(v) || /[^Xx.-]/.test(hits)));
  check(!bad.length, `${RHYTHMS.length} patterns well formed${bad.length ? ': bad ' + bad.map((r) => r.id).join(', ') : ''}`);
  const st = make({ metroVol: 1, metronome: true });
  let peak = 0;
  for (const r of RHYTHMS) { st.send({ cmd: 'settings', pattern: r }); st.run(SR / 2); peak = Math.max(peak, ...st.lastOut.map(Math.abs)); }
  check(st.running && peak > 0, 'metronome alone runs the transport and every pattern plays');
}

console.log(`\n${total - fails}/${total} passed`);
process.exit(fails ? 1 : 0);
