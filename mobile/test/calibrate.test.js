// Run: node test/calibrate.test.js
// Simulates speaker → room → microphone: the worklet's output comes back on its input after a
// known delay, attenuated, smeared by a short room response and mixed with noise.
const SR = 48000;
globalThis.sampleRate = SR;
globalThis.AudioWorkletProcessor = class {
  constructor() { this.port = { postMessage: (m) => this.sent?.push(m), onmessage: null }; }
};
let Station;
globalThis.registerProcessor = (_, cls) => { Station = cls; };
await import('../js/station-worklet.js');
const { measureLatency } = await import('../js/calibrate.js');

let seed = 9;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;

function calibrate({ delayMs, echoGain = 0.08, noise = 0.003, hum = 0 }) {
  const st = new Station();
  st.sent = [];
  st.port.onmessage({ data: { cmd: 'calibrate' } });
  const delay = Math.round((delayMs / 1000) * SR);
  const history = []; // everything the worklet played
  let t = 0, result = null;
  while (!result && t < SR * 6) {
    const inp = new Float32Array(128);
    for (let i = 0; i < 128; i++) {
      const k = t + i - delay;
      // room: direct sound plus two weaker reflections
      let v = 0;
      if (echoGain && k >= 0 && k < history.length) v += echoGain * history[k];
      if (echoGain && k - 240 >= 0 && k - 240 < history.length) v += echoGain * 0.4 * history[k - 240];
      if (echoGain && k - 700 >= 0 && k - 700 < history.length) v += echoGain * 0.2 * history[k - 700];
      inp[i] = v + noise * rand() + hum * Math.sin((2 * Math.PI * 50 * (t + i)) / SR);
    }
    const out = new Float32Array(128);
    st.process([[inp]], [[out]]);
    history.push(...out);
    t += 128;
    result = st.sent.find((m) => m.type === 'calibration');
  }
  return measureLatency(result.input, result.clicks, result.click, SR);
}

let fails = 0, total = 0;
const check = (ok, msg) => { total++; if (!ok) fails++; console.log(`${ok ? '  ok ' : 'FAIL '} ${msg}`); };

for (const [name, opts] of [
  ['wired headset / speaker, 28 ms', { delayMs: 28 }],
  ['typical phone speaker, 85 ms', { delayMs: 85 }],
  ['Bluetooth, 240 ms', { delayMs: 240 }],
  ['quiet echo in a noisy room, 60 ms', { delayMs: 60, echoGain: 0.03, noise: 0.004 }],
  ['mains hum, 45 ms', { delayMs: 45, hum: 0.05 }],
]) {
  const r = calibrate(opts);
  check(r.ok && Math.abs(r.ms - opts.delayMs) < 1.5, `${name}: measured ${r.ok ? r.ms.toFixed(1) + ' ms' : r.reason}`);
}
const silent = calibrate({ delayMs: 50, echoGain: 0 });
check(!silent.ok && silent.reason === 'quiet', `no echo (headphones) is reported, not guessed: ${silent.reason}`);

console.log(`\n${total - fails}/${total} passed`);
process.exit(fails ? 1 : 0);
