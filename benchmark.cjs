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
