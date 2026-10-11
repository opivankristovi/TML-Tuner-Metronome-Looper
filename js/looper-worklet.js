// Looper running on the audio thread.
// States: empty → recording → playing ⇄ overdubbing, plus stopped.
// Overdubs are written `latency` samples behind the playhead so what you play
// lines up with what you heard (round-trip input + output latency).

const MAX_SECONDS = 600;

class LooperProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.state = 'empty';
    this.layers = []; // {id, data, gain, muted}
    this.redo = [];
    this.loopLen = 0;
    this.pos = 0;
    this.latency = 0;
    this.rec = null; // chunks while recording the first layer
    this.dub = null; // {id, data, write, tail}
    this.nextId = 1;
    this.blocks = 0;
    this.port.onmessage = (e) => this.command(e.data);
  }

  command(msg) {
    switch (msg.cmd) {
      case 'rec':
        if (this.state === 'empty') {
          this.rec = { chunks: [], length: 0 };
          this.setState('recording');
        }
        break;
      case 'play':
        if (this.state === 'recording') this.finishRecording('playing');
        else if (this.state === 'overdubbing') { this.endDub(); this.setState('playing'); }
        else if (this.state === 'stopped') { this.pos = 0; this.setState('playing'); }
        break;
      case 'dub':
        if (this.state === 'stopped') this.pos = 0;
        if (this.state === 'playing' || this.state === 'stopped') {
          this.finalizeDub();
          this.dub = { id: this.nextId++, data: new Float32Array(this.loopLen), write: (this.pos - this.latency + this.loopLen * 4) % this.loopLen, tail: -1 };
          this.setState('overdubbing');
        }
        break;
      case 'stop':
        if (this.state === 'recording') this.finishRecording('stopped');
        else if (this.state === 'overdubbing') { this.endDub(); this.setState('stopped'); }
        else if (this.state === 'playing') this.setState('stopped');
        break;
      case 'undo':
        if (this.state === 'recording') { this.rec = null; this.setState('empty'); break; }
        if (this.dub && this.state === 'overdubbing') { this.dub = null; this.setState('playing'); break; }
        this.finalizeDub(); // a dub still in its latency tail becomes a layer, then gets undone below
        if (this.layers.length) {
          this.redo.push(this.layers.pop());
          if (!this.layers.length) { this.state = 'empty'; this.pos = 0; }
          this.sendState();
        }
        break;
      case 'redo':
        if (this.redo.length && this.state !== 'recording' && !this.dub) {
          const layer = this.redo.pop();
          if (!this.layers.length) { this.loopLen = layer.data.length; this.state = 'stopped'; }
          this.layers.push(layer);
          this.sendState();
        }
        break;
      case 'clear':
        this.layers = []; this.redo = []; this.rec = null; this.dub = null;
        this.loopLen = 0; this.pos = 0;
        this.setState('empty');
        break;
      case 'layer': {
        const l = this.layers.find((x) => x.id === msg.id);
        if (l) {
          if ('gain' in msg) l.gain = msg.gain;
          if ('muted' in msg) l.muted = msg.muted;
          if (msg.remove) this.layers = this.layers.filter((x) => x !== l);
          if (!this.layers.length) { this.state = 'empty'; this.pos = 0; }
          this.sendState();
        }
        break;
      }
      case 'latency':
        this.latency = Math.max(0, Math.round(msg.samples));
        break;
    }
  }

  finishRecording(next) {
    const { chunks, length } = this.rec;
    this.rec = null;
    if (length < sampleRate * 0.1) { this.setState('empty'); return; }
    const data = new Float32Array(length);
    let o = 0;
    for (const c of chunks) { data.set(c, o); o += c.length; }
    this.loopLen = length;
    this.pos = 0;
    this.addLayer({ id: this.nextId++, data, gain: 1, muted: false });
    this.setState(next);
  }

  // Stop capturing new input, but keep writing for `latency` samples so the
  // last notes heard before the button press are included.
  endDub() {
    if (this.dub && this.dub.tail < 0) this.dub.tail = this.latency;
    if (this.dub && this.dub.tail === 0) this.finalizeDub();
  }

  finalizeDub() {
    if (!this.dub) return;
    const { id, data } = this.dub;
    this.dub = null;
    this.addLayer({ id, data, gain: 1, muted: false });
  }

  addLayer(layer) {
    this.layers.push(layer);
    this.redo = [];
    this.port.postMessage({ type: 'layer', id: layer.id, data: layer.data.slice() });
    this.sendState();
  }

  setState(s) { this.state = s; this.sendState(); }

  sendState() {
    this.port.postMessage({
      type: 'state',
      state: this.state,
      loopLen: this.loopLen,
      layers: this.layers.map(({ id, gain, muted }) => ({ id, gain, muted })),
      canRedo: this.redo.length > 0,
      dubbing: !!this.dub,
    });
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const out = outputs[0][0];
    const n = out.length;

    if (this.state === 'recording') {
      if (input) { this.rec.chunks.push(input.slice()); this.rec.length += input.length; }
      if (this.rec.length >= sampleRate * MAX_SECONDS) this.finishRecording('playing');
    }

    const playing = this.state === 'playing' || this.state === 'overdubbing';
    for (let i = 0; i < n; i++) {
      let s = 0;
      if (playing && this.loopLen) {
        for (const l of this.layers) if (!l.muted) s += l.data[this.pos] * l.gain;
        if (this.dub) s += this.dub.data[this.pos];
      }
      out[i] = s;

      const dub = this.dub;
      if (dub && (this.state === 'overdubbing' || dub.tail > 0)) {
        dub.data[dub.write] += input ? input[i] : 0;
        dub.write = (dub.write + 1) % this.loopLen;
        if (dub.tail > 0 && --dub.tail === 0) this.finalizeDub();
      }
      if (playing && this.loopLen) this.pos = (this.pos + 1) % this.loopLen;
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);

    if (++this.blocks % 6 === 0) {
      this.port.postMessage({ type: 'pos', pos: this.pos, recLen: this.rec ? this.rec.length : 0 });
    }
    return true;
  }
}

registerProcessor('looper', LooperProcessor);
