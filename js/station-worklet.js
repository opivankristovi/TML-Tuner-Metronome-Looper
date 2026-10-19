// Loop station engine, running on the audio thread.
//
// One transport (sample counter `t`, bar grid from BPM and beats per bar) drives three
// tracks plus a metronome/drum machine. Track actions are queued and take effect on the
// next bar (or beat, or immediately), so loops are whole bars and stay in sync.
//
// Latency: input arriving at playback time t was played against what was heard at
// t - latency, so all recording runs on the delayed clock m = t - latency.
//
// Buffers come from the main thread (shared memory when available): the audio thread
// never allocates large arrays, and the UI can draw and export loops without copying.

const MAX_SECONDS = 90;
const MAX_UNDO = 6; // overdub layers kept separately; older ones merge into the base
const JOB_CHUNK = 1 << 16; // samples of background work (zeroing, merging) per block
const MIN_LOOP_SECONDS = 0.25;
const NEXT = { empty: 'recording', recording: 'playing', playing: 'dubbing', dubbing: 'playing', stopped: 'playing' };

// ------------------------------------------------------------- drum sounds
function synthesize(sr) {
  let seed = 22222;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 1073741823.5) - 1;
  const make = (secs, fn) => {
    const b = new Float32Array(Math.floor(secs * sr));
    for (let i = 0; i < b.length; i++) b[i] = fn(i / sr);
    return b;
  };
  const highpassed = (amount) => {
    let prev = 0, hp = 0;
    return () => { const n = noise(); hp = amount * (hp + n - prev); prev = n; return hp; };
  };
  let ph = 0;
  const kick = make(0.4, (t) => { ph += (2 * Math.PI * (48 + 120 * Math.exp(-t * 35))) / sr; return Math.sin(ph) * Math.exp(-t * 8) * 0.9; });
  const sn = highpassed(0.7);
  const snare = make(0.25, (t) => sn() * Math.exp(-t * 18) * 0.5 + Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 30) * 0.35);
  const hh = highpassed(0.25);
  const hat = make(0.06, (t) => hh() * Math.exp(-t * 80) * 0.5);
  const oh = highpassed(0.25);
  const open = make(0.35, (t) => oh() * Math.exp(-t * 10) * 0.3);
  const rim = make(0.06, (t) => (Math.sin(2 * Math.PI * 1750 * t) * 0.4 + Math.sin(2 * Math.PI * 820 * t) * 0.3) * Math.exp(-t * 70));
  const accent = make(0.04, (t) => Math.sin(2 * Math.PI * 1800 * t) * Math.exp(-t * 120) * 0.6);
  const click = make(0.04, (t) => Math.sin(2 * Math.PI * 1200 * t) * Math.exp(-t * 140) * 0.45);
  return { k: kick, s: snare, h: hat, o: open, r: rim, a: accent, c: click };
}

const VELOCITY = { X: 1, x: 0.6, '-': 0.3 };

class Track {
  constructor(index) {
    this.index = index;
    this.rec = null; // first take (max 90 s), also the base the oldest overdubs merge into
    this.recId = 0;
    this.gain = 1;
    this.g = 1; // smoothed gain
    this.gen = 0;
    this.reset();
  }

  reset() {
    this.state = 'empty';
    this.queue = []; // [{target, at}] actions waiting for their boundary
    this.len = 0;
    this.anchor = 0; // transport time of loop position 0
    this.writing = false; // first take still being written (delayed clock)
    this.limitT = Infinity;
    this.layers = []; // committed overdubs {id, data, merged}
    this.redo = [];
    this.dub = null; // overdub in progress {id, data, startM, endM, merged}
    this.pool = []; // zeroed spare buffers of length len
    this.requested = 0;
    this.gen++; // invalidates background jobs for the old loop
  }

  // State after all queued actions have run
  get effective() {
    return this.queue.length ? this.queue[this.queue.length - 1].target : this.state;
  }

  get active() {
    return this.state === 'playing' || this.state === 'dubbing' || this.state === 'recording' || this.writing || this.dub || this.queue.length > 0;
  }
}

class StationProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.tracks = [0, 1, 2].map((i) => new Track(i));
    this.t = 0;
    this.running = false;
    this.bpm = 100;
    this.beats = 4;
    this.pattern = null;
    this.metronome = false;
    this.metroVol = 0.6;
    this.countIn = true;
    this.quantize = 'bar';
    this.recBars = 0;
    this.latency = 0;
    this.master = 1;
    this.countInEnd = -1;
    this.lastStep = -1;
    this.sounds = synthesize(sampleRate);
    this.voices = Array.from({ length: 24 }, () => ({ buf: null, pos: 0, gain: 0 }));
    this.jobs = [];
    this.nextEvent = Infinity;
    this.blocks = 0;
    this.dirty = true;
    this.updateBar();
    this.port.onmessage = (e) => { this.onMessage(e.data); this.sendState(); };
  }

  updateBar() {
    this.bar = Math.round((this.beats * 60 * sampleRate) / this.bpm);
  }

  hasContent() {
    return this.tracks.some((tr) => tr.len > 0 || tr.state !== 'empty' || tr.queue.length);
  }

  // ------------------------------------------------------------ messages
  onMessage(msg) {
    const tr = this.tracks[msg.track];
    switch (msg.cmd) {
      case 'settings': {
        const tempo = {};
        if ('bpm' in msg) tempo.bpm = Math.max(30, Math.min(300, msg.bpm));
        if (msg.pattern) { this.pattern = msg.pattern; tempo.beats = msg.pattern.beats; }
        // Tempo and meter are fixed while loops exist, or every loop would drift
        if ((tempo.bpm !== undefined && tempo.bpm !== this.bpm) || (tempo.beats !== undefined && tempo.beats !== this.beats)) {
          if (!this.hasContent()) {
            Object.assign(this, tempo);
            this.updateBar();
          }
        }
        for (const k of ['metroVol', 'countIn', 'quantize', 'recBars', 'master']) if (k in msg) this[k] = msg[k];
        if ('latency' in msg) this.latency = Math.max(0, Math.round(msg.latency));
        if ('metronome' in msg) {
          this.metronome = msg.metronome;
          if (this.metronome && !this.running) this.startTransport();
        }
        break;
      }
      case 'recBuffer':
        tr.rec = msg.data;
        tr.recId = msg.id;
        break;
      case 'buffer':
        tr.requested = Math.max(0, tr.requested - 1);
        if (tr.len && msg.data.length === tr.len) tr.pool.push({ id: msg.id, data: msg.data });
        break;
      case 'gain':
        tr.gain = msg.value;
        break;
      case 'track':
        this.trackAction(tr, msg.action);
        break;
      case 'playAll': this.playAll(); break;
      case 'stopAll': this.stopAll(); break;
      case 'toggleAll': this.tracks.some((x) => x.state === 'playing' || x.state === 'dubbing' || x.state === 'recording') || this.running ? this.stopAll() : this.playAll(); break;
      case 'snapshot':
        // Fallback for when buffers aren't shared: copy the mix out (may click once)
        if (tr.len) {
          const mix = this.mixdown(tr);
          this.port.postMessage({ type: 'snapshot', track: tr.index, data: mix }, [mix.buffer]);
        }
        break;
    }
  }

  mixdown(tr) {
    const out = tr.rec.slice(0, tr.len);
    for (const l of [...tr.layers, ...(tr.dub ? [tr.dub] : [])]) {
      for (let i = l.merged; i < tr.len; i++) out[i] += l.data[i];
    }
    return out;
  }

  // ------------------------------------------------------------ actions
  trackAction(tr, action) {
    switch (action) {
      case 'main':
        return this.request(tr, NEXT[tr.effective]);
      case 'stop': {
        const eff = tr.effective;
        if (eff === 'empty' || eff === 'stopped') { tr.queue = []; return; } // cancels a pending start
        return this.request(tr, 'stopped');
      }
      case 'undo': return this.undo(tr);
      case 'redo': return this.redoLayer(tr);
      case 'clear': return tr.reset();
    }
  }

  unit() {
    if (this.quantize === 'off') return 1;
    return this.quantize === 'beat' ? this.bar / this.beats : this.bar;
  }

  // Next boundary at or after `from`. A press shortly after a boundary counts as on time.
  boundary(from = this.t, graceAllowed = true) {
    const u = this.unit();
    if (u === 1) return from;
    const k = Math.floor(from / u);
    const prev = Math.round(k * u);
    const grace = Math.max(this.latency, Math.round(0.06 * sampleRate));
    if (graceAllowed && from - prev <= grace) return prev;
    return prev === from ? prev : Math.round((k + 1) * u);
  }

  request(tr, target) {
    if (!target) return;
    // Pressing again before a queued action happens cancels it
    if (tr.queue.length) {
      const before = tr.queue.length > 1 ? tr.queue[tr.queue.length - 2].target : tr.state;
      if (target === before) { tr.queue.pop(); this.updateNextEvent(); return; }
    }
    let at;
    if (!this.running) {
      this.startTransport();
      at = target === 'recording' && this.countIn && this.quantize !== 'off' ? this.bar : 0;
      this.countInEnd = at;
    } else {
      at = this.boundary();
      const last = tr.queue[tr.queue.length - 1];
      if (last && at <= last.at) at = this.boundary(last.at + 1, false);
      // A take or overdub lasts at least one boundary
      if (target === 'playing' || target === 'stopped') {
        const from = tr.effective;
        const started = from === 'recording' ? (tr.state === 'recording' ? tr.anchor : tr.queue.find((q) => q.target === 'recording')?.at)
          : from === 'dubbing' ? (tr.state === 'dubbing' && tr.dub ? tr.dub.startM : tr.queue.find((q) => q.target === 'dubbing')?.at) : undefined;
        const minimum = Math.max(1, Math.round(this.unit()), from === 'recording' ? MIN_LOOP_SECONDS * sampleRate : 1);
        if (started !== undefined) while (at - started < minimum) at = this.boundary(at + 1, false);
      }
    }
    tr.queue.push({ target, at });
    this.updateNextEvent();
  }

  updateNextEvent() {
    let n = Infinity;
    for (const tr of this.tracks) if (tr.queue.length) n = Math.min(n, tr.queue[0].at);
    this.nextEvent = n;
  }

  runEvents(t) {
    for (const tr of this.tracks) {
      while (tr.queue.length && tr.queue[0].at <= t) this.apply(tr, tr.queue.shift());
    }
    this.updateNextEvent();
    this.dirty = true;
  }

  apply(tr, { target, at }) {
    const from = tr.state;
    if (from === 'empty' && target === 'recording') {
      if (!tr.rec) return;
      tr.state = 'recording';
      tr.anchor = at;
      tr.len = 0;
      tr.writing = true;
      const m = this.t - this.latency;
      if (m > at) tr.rec.fill(0, 0, Math.min(m - at, tr.rec.length)); // started slightly in the past
      const u = this.unit();
      const maxLen = Math.min(MAX_SECONDS * sampleRate, tr.rec.length);
      tr.limitT = at + (u === 1 ? maxLen : Math.round(Math.floor(maxLen / u) * u));
      if (this.recBars > 0 && !tr.queue.length) {
        tr.queue.push({ target: 'playing', at: Math.min(tr.limitT, at + this.recBars * this.bar) });
      }
    } else if (from === 'recording' && (target === 'playing' || target === 'stopped')) {
      tr.len = at - tr.anchor;
      tr.limitT = Infinity;
      if (tr.len < MIN_LOOP_SECONDS * sampleRate) { tr.reset(); return; }
      tr.state = target; // the delayed clock keeps writing the take until it reaches len
      this.requestBuffers(tr);
    } else if ((from === 'playing' || from === 'stopped') && target === 'dubbing') {
      this.startDub(tr, at);
      tr.state = 'dubbing';
    } else if (from === 'dubbing' && (target === 'playing' || target === 'stopped')) {
      if (tr.dub) tr.dub.endM = at;
      tr.state = target;
    } else if (from === 'playing' && target === 'stopped') {
      tr.state = 'stopped';
    } else if (from === 'stopped' && target === 'playing') {
      tr.state = 'playing'; // anchor unchanged: the loop resumes in phase with the others
    }
  }

  startDub(tr, at) {
    let buf = tr.pool.pop();
    if (!buf) buf = { id: -1, data: new Float32Array(tr.len) }; // fallback; normally preallocated
    tr.dub = { id: buf.id, data: buf.data, startM: at, endM: Infinity, merged: 0 };
    for (const r of tr.redo) this.recycle(tr, r);
    tr.redo = [];
    this.requestBuffers(tr);
  }

  commitDub(tr) {
    tr.layers.push(tr.dub);
    tr.dub = null;
    if (tr.layers.length > MAX_UNDO && !this.jobs.some((j) => j.type === 'merge' && j.track === tr)) {
      const layer = tr.layers[0];
      this.jobs.push({ type: 'merge', track: tr, gen: tr.gen, layer, data: layer.data, pos: 0 });
    }
    this.dirty = true;
  }

  recycle(tr, buf) {
    if (buf.id >= 0) this.jobs.push({ type: 'zero', track: tr, gen: tr.gen, id: buf.id, data: buf.data, pos: 0 });
  }

  requestBuffers(tr) {
    while (tr.pool.length + tr.requested < 2) {
      tr.requested++;
      this.port.postMessage({ type: 'need', track: tr.index, len: tr.len });
    }
  }

  undo(tr) {
    if (tr.queue.length) { tr.queue.pop(); this.updateNextEvent(); return; }
    if (tr.state === 'recording') { tr.reset(); return; }
    if (tr.dub) {
      if (tr.dub.endM === Infinity) { // throw away the overdub in progress
        this.recycle(tr, tr.dub);
        tr.dub = null;
        tr.state = 'playing';
        return;
      }
      this.commitDub(tr); // still in its latency tail: commit, then undo it below
    }
    const last = tr.layers[tr.layers.length - 1];
    if (last && !this.jobs.some((j) => j.layer === last)) {
      tr.redo.push(tr.layers.pop());
    }
  }

  redoLayer(tr) {
    if (tr.redo.length && !tr.dub) tr.layers.push(tr.redo.pop());
  }

  startTransport() {
    this.running = true;
    this.t = 0;
    this.lastStep = -1;
    this.countInEnd = -1;
    for (const v of this.voices) v.buf = null;
    for (const tr of this.tracks) if (tr.len) tr.anchor = 0; // everything restarts from the top
  }

  playAll() {
    if (!this.running) {
      this.startTransport();
      for (const tr of this.tracks) if (tr.len && tr.state === 'stopped') tr.state = 'playing';
    } else {
      for (const tr of this.tracks) if (tr.len && tr.effective === 'stopped') this.request(tr, 'playing');
    }
  }

  stopAll() {
    const m = this.t - this.latency;
    for (const tr of this.tracks) {
      tr.queue = [];
      if (tr.state === 'recording') {
        const u = this.unit();
        tr.len = (u === 1 ? this.t : Math.round(Math.floor(this.t / u) * u)) - tr.anchor; // last whole bar
        if (tr.len < MIN_LOOP_SECONDS * sampleRate) { tr.reset(); continue; }
        tr.state = 'stopped';
        this.requestBuffers(tr);
      }
      tr.writing = false;
      if (tr.dub) {
        if (m < tr.dub.startM) { this.recycle(tr, tr.dub); tr.dub = null; } else this.commitDub(tr);
      }
      if (tr.state === 'playing' || tr.state === 'dubbing') tr.state = 'stopped';
    }
    this.running = false;
    this.countInEnd = -1;
    this.updateNextEvent();
  }

  // ------------------------------------------------------------ background jobs
  runJobs() {
    let budget = JOB_CHUNK;
    while (budget > 0 && this.jobs.length) {
      const j = this.jobs[0];
      if (j.gen !== j.track.gen) { this.jobs.shift(); continue; }
      const end = Math.min(j.data.length, j.pos + budget);
      if (j.type === 'zero') {
        j.data.fill(0, j.pos, end);
      } else {
        const base = j.track.rec, d = j.data;
        for (let k = j.pos; k < end; k++) base[k] += d[k];
        j.layer.merged = end;
      }
      budget -= end - j.pos;
      j.pos = end;
      if (end === j.data.length) {
        this.jobs.shift();
        const tr = j.track;
        if (j.type === 'zero') {
          if (tr.len === j.data.length) tr.pool.push({ id: j.id, data: j.data });
        } else {
          tr.layers = tr.layers.filter((l) => l !== j.layer);
          this.recycle(tr, j.layer);
          this.dirty = true;
        }
      }
    }
  }

  // ------------------------------------------------------------ metronome
  addVoice(buf, gain) {
    let slot = this.voices.find((v) => !v.buf);
    if (!slot) slot = this.voices.reduce((a, b) => (a.pos > b.pos ? a : b));
    slot.buf = buf; slot.pos = 0; slot.gain = gain;
  }

  metronomeSample(t) {
    const counting = t < this.countInEnd;
    if (counting || (this.metronome && this.pattern)) {
      const steps = counting ? this.beats : this.pattern.beats * this.pattern.sub;
      const step = Math.floor(t / (this.bar / steps));
      if (step !== this.lastStep) {
        this.lastStep = step;
        const i = step % steps;
        if (counting) {
          this.addVoice(i === 0 ? this.sounds.a : this.sounds.c, 1);
        } else {
          for (const voice in this.pattern.p) {
            const hits = this.pattern.p[voice];
            const v = VELOCITY[hits[i]];
            if (v && this.sounds[voice]) this.addVoice(this.sounds[voice], v);
          }
        }
      }
    }
    let s = 0;
    for (const v of this.voices) {
      if (!v.buf) continue;
      s += v.buf[v.pos++] * v.gain;
      if (v.pos >= v.buf.length) v.buf = null;
    }
    return s * this.metroVol;
  }

  // ------------------------------------------------------------ audio
  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const out = outputs[0][0];
    const n = out.length;
    this.runJobs();

    if (!this.running) {
      out.fill(0);
    } else {
      const L = this.latency;
      for (let i = 0; i < n; i++) {
        const t = this.t;
        const m = t - L;
        const x = input ? input[i] : 0;
        if (t >= this.nextEvent) this.runEvents(t);
        let mix = 0;
        for (const tr of this.tracks) {
          if (tr.writing) {
            const idx = m - tr.anchor;
            if (idx >= 0) {
              if ((tr.len && idx >= tr.len) || idx >= tr.rec.length) { tr.writing = false; this.dirty = true; }
              else tr.rec[idx] = x;
            }
          }
          if (tr.state === 'recording' && t >= tr.limitT) { this.apply(tr, { target: 'playing', at: tr.limitT }); tr.queue = []; this.updateNextEvent(); this.dirty = true; }
          const len = tr.len;
          if (!len) continue;
          const dub = tr.dub;
          if (dub && m >= dub.startM) {
            if (m >= dub.endM) this.commitDub(tr);
            else dub.data[(((m - tr.anchor) % len) + len) % len] += x;
          }
          if (tr.state === 'playing' || tr.state === 'dubbing') {
            const p = (((t - tr.anchor) % len) + len) % len;
            let s = tr.rec[p];
            for (const l of tr.layers) if (p >= l.merged) s += l.data[p];
            if (dub) s += dub.data[p];
            tr.g += (tr.gain - tr.g) * 0.002;
            mix += s * tr.g;
          }
        }
        out[i] = mix * this.master + this.metronomeSample(t);
        this.t++;
      }
      // Nothing left to do and no metronome: stop the clock so the next action starts at once
      if (!this.metronome && this.t >= this.countInEnd && !this.tracks.some((tr) => tr.active)) {
        this.running = false;
        this.dirty = true;
      }
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);

    if (this.dirty) this.sendState();
    else if (++this.blocks % 4 === 0) this.port.postMessage({ type: 'tick', t: this.t, running: this.running });
    return true;
  }

  sendState() {
    this.dirty = false;
    this.port.postMessage({
      type: 'state',
      t: this.t,
      running: this.running,
      bar: this.bar,
      beats: this.beats,
      bpm: this.bpm,
      countInEnd: this.countInEnd,
      locked: this.hasContent(),
      tracks: this.tracks.map((tr) => ({
        state: tr.state,
        len: tr.len,
        anchor: tr.anchor,
        writing: tr.writing,
        queue: tr.queue.map(({ target, at }) => ({ target, at })),
        layers: tr.layers.length,
        redo: tr.redo.length,
        dubbing: !!tr.dub,
        ids: [...tr.layers, ...(tr.dub ? [tr.dub] : [])].map((l) => l.id),
      })),
    });
  }
}

registerProcessor('station', StationProcessor);
