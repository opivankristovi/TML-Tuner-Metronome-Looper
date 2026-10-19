const { performance } = require('perf_hooks');

const N = 4096;
const re = new Float64Array(N / 2);
const im = new Float64Array(N / 2);
const mag1 = new Float64Array(N / 2);
const mag2 = new Float64Array(N / 2);

for (let i = 0; i < N / 2; i++) {
  re[i] = Math.random();
  im[i] = Math.random();
}

function benchmarkMathPow() {
  const start = performance.now();
  for (let iter = 0; iter < 10000; iter++) {
    for (let k = 0; k < N / 2; k++) mag1[k] = Math.pow(re[k] * re[k] + im[k] * im[k], 0.25);
  }
  return performance.now() - start;
}

function benchmarkMathSqrt() {
  const start = performance.now();
  for (let iter = 0; iter < 10000; iter++) {
    for (let k = 0; k < N / 2; k++) mag2[k] = Math.sqrt(Math.sqrt(re[k] * re[k] + im[k] * im[k]));
  }
  return performance.now() - start;
}

const timePow = benchmarkMathPow();
const timeSqrt = benchmarkMathSqrt();

console.log(`Math.pow(x, 0.25) time: ${timePow.toFixed(2)} ms`);
console.log(`Math.sqrt(Math.sqrt(x)) time: ${timeSqrt.toFixed(2)} ms`);
console.log(`Speedup: ${(timePow / timeSqrt).toFixed(2)}x`);
