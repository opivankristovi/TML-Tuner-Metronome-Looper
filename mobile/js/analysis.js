// Live note/chord tracking on top of the polyphonic detector.
//
// Raw detections flicker, and with a microphone any background noise (fans, hum) produces
// "notes". The tracker therefore
//  - learns the background level and only listens above a threshold (dB above it),
//  - analyses "events": from a pick attack (or the gate opening) until the sound dies away,
//  - votes within an event: a pitch class counts once it shows up in most recent analyses
//    (per pitch class, because short windows often get the octave of low notes wrong),
//  - locks the answer once two decisions agree (or after ~0.75 s): the fading tail of a
//    strum, where the high strings die first, can't change it. One strum, one answer.
// Pure logic (no DOM), shared by the desktop and mobile apps and tested in Node.
import { PolyDetector, findOnset, rmsOf, pc } from './dsp.js';

const ABS_GATE = 0.0025; // never listen below this (−52 dBFS)
const SUSTAIN_DB = 4.5; // after an attack, keep listening while this far above the background
const BG_MS = 250; // how often the background spectrum is sampled while nobody plays
const BG_SNAPSHOTS = 8; // background = per-bin minimum of the last 2 s of snapshots
const BG_QUIET_MS = 3000; // only learn after this long without playing
const WARMUP_MS = 750; // ignore the first moments of a stream (silence, then a jump to room noise)
const HOP_MS = 110; // time between analyses
const SETTLE_S = 0.2; // audio needed after an attack before the first analysis
const ATTACK_SKIP_S = 0.03; // the pick noise itself is skipped
const RELEASE_MS = 300; // keep listening this long after the level drops below the threshold
const VOTE_WINDOW = 8; // analyses that vote
const VOTE_SHARE = 0.6; // share of them a note must appear in
const LOCK_AFTER = 6; // analyses after which the result is locked even without agreement
const LOCK_MIN_S = 0.4; // shorter windows blur low notes: don't lock on them
const UNLOCK_MISSES = 3; // analyses without any locked note that mean the sound changed

// Background level: the quietest moment of the last 8 seconds (minimum per half-second
// bucket), so it adapts within seconds but can't ratchet up while you keep playing.
export class NoiseFloor {
  constructor({ buckets = 16, bucketMs = 500 } = {}) {
    this.size = buckets;
    this.bucketMs = bucketMs;
    this.reset();
  }

  reset() {
    this.buckets = [];
    this.bucketStart = 0;
    this.value = 0;
  }

  update(rms, now) {
    if (rms <= 0) return this.value; // dead input
    if (!this.buckets.length || now - this.bucketStart > this.bucketMs) {
      this.buckets.push(rms);
      this.bucketStart = now;
      if (this.buckets.length > this.size) this.buckets.shift();
    } else {
      const last = this.buckets.length - 1;
      this.buckets[last] = Math.min(this.buckets[last], rms);
    }
    this.value = Math.min(...this.buckets);
    return this.value;
  }
}

export class ChordTracker {
  constructor(sampleRate, { marginDb = 9, sens = 0.22 } = {}) {
    this.sr = sampleRate;
    this.poly = new PolyDetector(32768, sampleRate);
    this.floor = new NoiseFloor();
    this.marginDb = marginDb;
    this.sens = sens;
    this.nextEventId = 1;
    this.hp = new Float32Array(0);
    this.reset();
  }

  // Rumble below the instrument's lowest note (fans, traffic, handling) is removed before
  // levels and attacks are measured. 2nd-order Butterworth high-pass, run over the buffer.
  highpass(buf, cutoff) {
    if (this.hp.length !== buf.length) this.hp = new Float32Array(buf.length);
    const w = Math.tan((Math.PI * cutoff) / this.sr), k = Math.SQRT2;
    const a0 = 1 + k * w + w * w;
    const b0 = 1 / a0, b1 = -2 / a0, b2 = 1 / a0, a1 = (2 * (w * w - 1)) / a0, a2 = (1 - k * w + w * w) / a0;
    let x1 = buf[0], x2 = buf[0], y1 = 0, y2 = 0;
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i], y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      this.hp[i] = y; x2 = x1; x1 = x; y2 = y1; y1 = y;
    }
    return this.hp;
  }

  reset() {
    this.floor.reset();
    this.event = null; // {id, start, frames: [[notes]]}
    this.background = null; // spectrum of the room while nobody plays (steady hum, fans)
    this.snapshots = [];
    this.lastBg = -Infinity;
    this.lastEventEnd = -Infinity;
    this.startedAt = null;
    this.live = false; // the latest vote still finds the notes
    this.notes = []; // latest stable notes
    this.notesEvent = 0; // event the notes came from
    this.detections = []; // raw result of the latest analysis
    this.level = 0;
    this.now = 0;
    this.lastHop = -Infinity;
    this.lastLoud = -Infinity;
    this.lastOnset = -Infinity;
  }

  get threshold() {
    return Math.max(ABS_GATE, this.floor.value * 10 ** (this.marginDb / 20));
  }

  // Listening: something was played and is still sounding (within the release time)
  get active() {
    return this.now - this.lastLoud < RELEASE_MS;
  }

  // True while the current notes belong to the sound that is playing now
  get fresh() {
    return this.active && !!this.event && this.notesEvent === this.event.id && this.live && this.notes.length > 0;
  }

  // buf: most recent input samples (at least the detector size); end: absolute sample index
  // of buf's last sample; now: milliseconds. Returns {analysed, changed}.
  update(buf, { end, now, minMidi = 28, maxMidi = 88, a4 = 440 }) {
    this.now = now;
    this.startedAt ??= now;
    if (now - this.startedAt < WARMUP_MS) return { analysed: false, changed: false };
    const lowest = 440 * 2 ** ((minMidi + 1 - 69) / 12); // minMidi is one below the lowest string
    const filtered = this.highpass(buf, Math.max(20, lowest * 0.75));
    this.level = rmsOf(filtered, 2048);
    this.floor.update(this.level, now);
    const threshold = this.threshold;
    const sustain = Math.max(ABS_GATE, this.floor.value * 10 ** (SUSTAIN_DB / 20));

    // Listening starts with a pick attack above the threshold (fans and hum have none) or a
    // level above it, and continues while the sound stays a little above the background.
    const onset = findOnset(filtered, { gate: threshold, block: 512 });
    const at = onset >= 0 ? end - (buf.length - 1 - onset) : -Infinity;
    const attack = onset >= 0 && at - this.lastOnset > 4096 && end - at < 0.15 * this.sr;
    if (this.level > threshold || attack || (this.event && this.level > sustain)) this.lastLoud = now;
    if (!this.active) {
      const changed = !!this.event;
      if (this.event) this.lastEventEnd = now;
      this.event = null;
      this.live = false;
      this.learnBackground(buf, now);
      return { analysed: false, changed };
    }
    if (attack) {
      this.lastOnset = at;
      this.event = { id: this.nextEventId++, start: at, frames: [] };
    }
    if (now - this.lastHop < HOP_MS) return { analysed: false, changed: false };
    this.lastHop = now;
    if (!this.event) this.event = { id: this.nextEventId++, start: end, frames: [] }; // swelled in without an attack

    const length = end - this.event.start - Math.round(ATTACK_SKIP_S * this.sr);
    if (length < SETTLE_S * this.sr) return { analysed: false, changed: false };
    const notes = this.poly.analyze(buf, {
      minMidi, maxMidi, a4, relThreshold: this.sens, gate: ABS_GATE, length: Math.min(length, this.poly.size), background: this.background,
    });
    this.detections = notes;

    const ev = this.event;
    if (ev.locked) {
      // The sound changed without a new attack (slide, hammer-on): start over
      const hit = notes.some((n) => ev.locked.some((l) => pc(l.midi) === pc(n.midi)));
      ev.misses = hit ? 0 : (ev.misses || 0) + 1;
      if (ev.misses < UNLOCK_MISSES) return { analysed: true, changed: false };
      this.event = { id: this.nextEventId++, start: end - Math.round(SETTLE_S * this.sr), frames: [] };
      return { analysed: true, changed: false };
    }
    const frames = ev.frames;
    frames.push(notes);
    if (frames.length > VOTE_WINDOW) frames.shift();
    const need = Math.max(2, Math.ceil(frames.length * VOTE_SHARE));
    const votes = new Map(); // pitch class → number of analyses it appears in
    for (const frame of frames) for (const p of new Set(frame.map((n) => pc(n.midi)))) votes.set(p, (votes.get(p) || 0) + 1);
    // Octaves come from the latest analyses (longest windows): lowest instance of each pitch class
    const recent = frames.slice(-3).flat();
    const stable = [];
    for (const [p, count] of votes) {
      if (count < need) continue;
      const inst = recent.filter((n) => pc(n.midi) === p).sort((x, y) => x.midi - y.midi)[0] || frames.flat().find((n) => pc(n.midi) === p);
      stable.push(inst);
    }
    stable.sort((x, y) => x.midi - y.midi);
    // An event without a clear result keeps showing the previous one, but no longer as live
    if (!stable.length) {
      const changed = this.live;
      this.live = false;
      return { analysed: true, changed };
    }
    const key = (list) => [...new Set(list.map((n) => pc(n.midi)))].sort((x, y) => x - y).join(',');
    const changed = stable.map((n) => n.midi).join() !== this.notes.map((n) => n.midi).join() || this.notesEvent !== ev.id;
    if ((ev.lastKey === key(stable) && length >= LOCK_MIN_S * this.sr) || frames.length >= LOCK_AFTER) ev.locked = stable;
    ev.lastKey = key(stable);
    this.notes = stable;
    this.notesEvent = ev.id;
    this.live = true;
    return { analysed: true, changed };
  }

  // While nobody plays, learn the room's spectrum (fans, hum) so it can be subtracted.
  // A per-bin minimum over recent snapshots keeps steady sounds and drops passing ones,
  // such as the tail of the last chord.
  learnBackground(buf, now) {
    if (now - this.lastBg < BG_MS || buf.length < this.poly.size) return;
    if (now - this.lastEventEnd < BG_QUIET_MS) return; // (no event yet: learn right away)
    if (this.level > Math.max(ABS_GATE, this.floor.value * 1.6)) return; // only true background
    this.lastBg = now;
    this.snapshots.push(Float64Array.from(this.poly.spectrum(buf, this.poly.size)));
    if (this.snapshots.length > BG_SNAPSHOTS) this.snapshots.shift();
    if (this.snapshots.length < 3) return;
    const bg = (this.background ??= new Float64Array(this.snapshots[0].length));
    for (let k = 0; k < bg.length; k++) {
      let m = Infinity;
      for (const snap of this.snapshots) if (snap[k] < m) m = snap[k];
      bg[k] = m;
    }
  }
}
