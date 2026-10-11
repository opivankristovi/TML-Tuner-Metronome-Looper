// Round-trip latency from a calibration recording: the worklet played `click` at sample
// positions `clicks` through the speaker while recording the microphone on the same clock.
//
// Each click is found with a matched filter: correlating the recording with sine and cosine
// copies of the click gives a smooth envelope that peaks where the echo lines up, gains
// ~20 dB over the noise and ignores hum.

function envelopeAt(x, k, ts, tc) {
  let s = 0, c = 0;
  for (let j = 0; j < ts.length; j++) { const v = x[k + j]; s += v * ts[j]; c += v * tc[j]; }
  return Math.sqrt(s * s + c * c);
}

// Returns {ok, samples, ms, spreadMs} or {ok: false, reason}
export function measureLatency(input, clicks, click, sampleRate, { maxSeconds = 0.5 } = {}) {
  const n = click.length;
  // Quadrature templates with the click's window (2 kHz carrier)
  const ts = new Float32Array(n), tc = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / (n - 1));
    ts[j] = w * Math.sin((2 * Math.PI * 2000 * j) / sampleRate);
    tc[j] = w * Math.cos((2 * Math.PI * 2000 * j) / sampleRate);
  }
  const win = Math.round(maxSeconds * sampleRate);
  const last = input.length - n;

  // Noise: envelope level before the first click
  const pre = [];
  for (let k = 0; k + n < clicks[0] && k < last; k += 16) pre.push(envelopeAt(input, k, ts, tc));
  pre.sort((a, b) => a - b);
  const noise = pre.length ? pre[Math.floor(pre.length * 0.9)] : 0;

  const delays = [];
  for (const at of clicks) {
    // Coarse scan, then refine around the first strong peak
    const env = [];
    for (let k = 0; k < win && at + k < last; k += 4) env.push(envelopeAt(input, at + k, ts, tc));
    let peak = 0;
    for (const v of env) peak = Math.max(peak, v);
    if (peak < Math.max(5 * noise, 1e-4)) continue; // no audible echo for this click
    // The direct sound arrives first; reflections come later, so take the first peak above half the maximum
    let i = env.findIndex((v) => v >= 0.5 * peak);
    while (i + 1 < env.length && env[i + 1] > env[i]) i++;
    let best = i * 4, bestV = 0;
    for (let k = Math.max(0, i * 4 - 4); k <= i * 4 + 4 && at + k < last; k++) {
      const v = envelopeAt(input, at + k, ts, tc);
      if (v > bestV) { bestV = v; best = k; }
    }
    delays.push(best);
  }
  if (delays.length < Math.ceil(clicks.length / 2)) return { ok: false, reason: 'quiet' };
  delays.sort((a, b) => a - b);
  const median = delays[Math.floor(delays.length / 2)];
  const q1 = delays[Math.floor(delays.length / 4)], q3 = delays[Math.ceil((3 * delays.length) / 4) - 1];
  const spreadMs = ((q3 - q1) / sampleRate) * 1000;
  if (spreadMs > 5) return { ok: false, reason: 'inconsistent', spreadMs };
  return { ok: true, samples: median, ms: (median / sampleRate) * 1000, spreadMs };
}
