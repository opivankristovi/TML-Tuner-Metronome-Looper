import { PolyDetector } from '../js/dsp.js';

const N = 32768;
const SR = 48000;
const poly = new PolyDetector(N, SR);
const buf = new Float32Array(N);
for (let i = 0; i < N; i++) {
  buf[i] = Math.random();
}

const start = performance.now();
for (let i = 0; i < 100; i++) {
  poly.spectrum(buf);
}
const end = performance.now();

console.log(`Time for 100 spectrum calls: ${end - start} ms`);
