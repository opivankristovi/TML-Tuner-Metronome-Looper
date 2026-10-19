const v8 = require('v8');

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

// Ensure JIT compilation
for(let i = 0; i < 10000; i++) {
  runOld();
  runNew();
}

function testAllocations(fn, name) {
    if (global.gc) global.gc();
    const startStats = v8.getHeapStatistics();

    // Create an array to keep generated objects alive long enough
    // to actually trigger garbage collection cycles
    const arr = [];
    for (let i = 0; i < 1000000; i++) {
        fn();
        if (i % 1000 === 0) {
            arr.push(new Array(100));
        }
    }

    const endStats = v8.getHeapStatistics();
    console.log(`${name}:`);
    // Note: heap stats only give us a rough idea, actual GC pressure is harder to measure in simple scripts
}

console.log("Measuring...");
testAllocations(runOld, "Old");
testAllocations(runNew, "New");
