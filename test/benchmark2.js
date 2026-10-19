import { PolyDetector } from '../js/dsp.js';

const N = 32768;
const SR = 48000;
const poly = new PolyDetector(N, SR);
const buf = new Float32Array(N);
for (let i = 0; i < N; i++) {
  buf[i] = Math.random();
}

console.time('PolyDetector.spectrum 1000 iterations');
for (let i = 0; i < 1000; i++) {
  poly.spectrum(buf);
}
console.timeEnd('PolyDetector.spectrum 1000 iterations');
