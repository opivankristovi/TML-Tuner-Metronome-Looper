const { PerformanceObserver, performance } = require('perf_hooks');

const an_votes = new Map();
const present = new Map();

for (let i = 0; i < 5; i++) {
  an_votes.set(i, { score: 0.5 });
  present.set(i + 2, { midi: i + 2 });
}

function runOld() {
  const an = { votes: new Map(an_votes) };
  let fresh = false;
  for (const m of new Set([...an.votes.keys(), ...present.keys()])) {
    const v = an.votes.get(m) || { score: 0 };
    v.score = fresh ? 0.6 : v.score * 0.6 + (present.has(m) ? 0.4 : 0);
    if (present.has(m)) v.note = present.get(m);
    if (v.score < 0.05) an.votes.delete(m); else an.votes.set(m, v);
  }
}

const unionSet = new Set();
function runNew() {
  const an = { votes: new Map(an_votes) };
  let fresh = false;
  unionSet.clear();
  for (const k of an.votes.keys()) unionSet.add(k);
  for (const k of present.keys()) unionSet.add(k);

  for (const m of unionSet) {
    const v = an.votes.get(m) || { score: 0 };
    v.score = fresh ? 0.6 : v.score * 0.6 + (present.has(m) ? 0.4 : 0);
    if (present.has(m)) v.note = present.get(m);
    if (v.score < 0.05) an.votes.delete(m); else an.votes.set(m, v);
  }
}

// Warmup
for (let i = 0; i < 10000; i++) {
  runOld();
  runNew();
}

if (global.gc) global.gc();

const startOld = performance.now();
for (let i = 0; i < 1000000; i++) runOld();
const endOld = performance.now();

if (global.gc) global.gc();

const startNew = performance.now();
for (let i = 0; i < 1000000; i++) runNew();
const endNew = performance.now();

console.log(`Old Time: ${(endOld - startOld).toFixed(2)}ms`);
console.log(`New Time: ${(endNew - startNew).toFixed(2)}ms`);
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
