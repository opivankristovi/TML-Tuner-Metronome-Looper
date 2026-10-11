// Loop station UI for touchscreens: transport (tempo, rhythm, click, quantize), three tracks,
// latency calibration. The audio engine lives in station-worklet.js; this module allocates its
// buffers, mirrors its state and draws it.
import { RHYTHMS } from './rhythms.js';
import { encodeWav } from './wav.js';
import { measureLatency } from './calibrate.js';

const $ = (id) => document.getElementById(id);
const TRACKS = 3;
// Keyboards and Bluetooth foot pedals (which send key presses) can drive the tracks too
const KEYS = { main: ['q', 'w', 'e'], stop: ['a', 's', 'd'] };
const NEXT = { empty: 'recording', recording: 'playing', playing: 'dubbing', dubbing: 'playing', stopped: 'playing' };
const MAIN_LABEL = { recording: ['● Rec', 'rec'], playing: ['▶ Play', 'play'], dubbing: ['● Dub', 'dub'] };
const STATE_LABEL = { empty: 'EMPTY', recording: 'REC', playing: 'PLAY', dubbing: 'DUB', stopped: 'STOP' };
const COLOR = { recording: '#ef5b5b', dubbing: '#f2a14e', playing: '#5ad1a6', stopped: '#5a6170', empty: '#5a6170' };
const BUFFER_SECONDS = 91; // 90 s loops plus room for the latency tail

const buzz = () => navigator.vibrate?.(12); // Android only; iOS has no web haptics

// Sizes a canvas for the screen's pixel density; returns a context in CSS pixels
export function fitCanvas(cv) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(cv.clientWidth * dpr)), h = Math.max(1, Math.round(cv.clientHeight * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, W: cv.clientWidth, H: cv.clientHeight };
}

export function createStation({ settings, save, banner, canCalibrate }) {
  const s = {
    ctx: null, node: null, shared: false,
    state: null, tickT: 0, tickTime: 0,
    bufs: new Map(), nextId: 100, rec: [],
    snapshots: [], waves: [], selected: 0, taps: [], autoLatency: 0, calibrating: null,
  };

  // ---------------------------------------------------------- audio
  async function attach(ctx, input) {
    s.ctx = ctx;
    s.shared = globalThis.crossOriginIsolated === true;
    await ctx.audioWorklet.addModule('js/station-worklet.js');
    s.node = new AudioWorkletNode(ctx, 'station', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 1, channelCountMode: 'explicit' });
    input.connect(s.node);
    s.node.connect(ctx.destination);
    s.node.port.onmessage = (e) => onMessage(e.data);
    for (let i = 0; i < TRACKS; i++) {
      const data = alloc(BUFFER_SECONDS * ctx.sampleRate);
      s.rec[i] = data;
      post({ cmd: 'recBuffer', track: i, id: i + 1, data }, data);
    }
    sendSettings();
    for (let i = 0; i < TRACKS; i++) post({ cmd: 'gain', track: i, value: settings.trackGains[i] });
  }

  // Shared memory lets the UI read loops directly; otherwise buffers are transferred.
  function alloc(n) {
    return new Float32Array(s.shared ? new SharedArrayBuffer(n * 4) : new ArrayBuffer(n * 4));
  }
  function post(msg, data) {
    if (!s.node) return;
    s.node.port.postMessage(msg, data && !s.shared ? [data.buffer] : []);
  }
  const cmd = (msg) => {
    if (!s.node) { banner('Tap <b>Tap to start</b> first.', true); return; }
    post(msg);
  };

  function sendSettings() {
    const pattern = RHYTHMS.find((r) => r.id === settings.rhythm) || RHYTHMS[0];
    post({
      cmd: 'settings', bpm: settings.bpm, pattern, metronome: settings.metronome, metroVol: settings.metroVol,
      countIn: settings.countIn, quantize: settings.quantize, recBars: settings.recBars, master: settings.loopVol,
      latency: latencySamples(),
    });
  }

  // ---------------------------------------------------------- latency
  // Measured round trip when available, else the browser's own estimate; plus a manual offset
  function updateLatency(stream) {
    if (!s.ctx) return;
    const inLat = stream?.getAudioTracks()[0]?.getSettings().latency || 0;
    s.autoLatency = (s.ctx.baseLatency || 0) + (s.ctx.outputLatency || 0) + inLat;
    renderLatency();
    sendSettings();
  }
  const baseMs = () => (settings.latMeasured ?? s.autoLatency * 1000);
  const totalMs = () => Math.max(0, baseMs() + settings.latOffset);
  function latencySamples() {
    return s.ctx ? (totalMs() / 1000) * s.ctx.sampleRate : 0;
  }
  function renderLatency() {
    const src = settings.latMeasured != null ? `measured ${settings.latMeasured.toFixed(0)} ms` : s.ctx ? `browser estimate ${(s.autoLatency * 1000).toFixed(0)} ms` : 'starts with audio';
    $('latValue').textContent = s.ctx ? `${totalMs().toFixed(0)} ms` : '–';
    $('latSource').textContent = src + (settings.latOffset ? `, fine-tuned ${settings.latOffset > 0 ? '+' : '−'}${Math.abs(settings.latOffset)} ms` : '');
    $('lLatOut').textContent = `${settings.latOffset >= 0 ? '+' : '−'}${Math.abs(settings.latOffset)} ms`;
  }

  async function calibrate() {
    if (!s.node) return banner('Tap <b>Tap to start</b> first.', true);
    if (s.state?.running) return banner('Stop the loops (▶ Play all / ■ Stop all) before measuring.', true);
    const blocked = canCalibrate();
    if (blocked) return banner(blocked, true);
    const btn = $('calibrate');
    btn.disabled = true;
    btn.textContent = 'Listening… keep quiet';
    await s.ctx.resume();
    const msg = await new Promise((resolve) => { s.calibrating = resolve; post({ cmd: 'calibrate' }); });
    btn.disabled = false;
    btn.textContent = 'Measure latency';
    const r = measureLatency(msg.input, msg.clicks, msg.click, s.ctx.sampleRate);
    if (r.ok) {
      settings.latMeasured = r.ms;
      settings.latOffset = 0;
      $('lLat').value = 0;
      save();
      renderLatency();
      sendSettings();
      banner(`Measured round-trip latency: <b>${r.ms.toFixed(0)} ms</b>. Overdubs are now shifted by this amount.`);
    } else if (r.reason === 'quiet') {
      banner('No clicks reached the microphone. Turn the volume up and unplug headphones, or set the latency by ear with <b>Fine-tune</b>.', true);
    } else {
      banner(`The measurement was unsteady (±${r.spreadMs.toFixed(0)} ms), probably because of noise. Try again in a quieter spot.`, true);
    }
  }

  function onMessage(msg) {
    if (msg.type === 'tick') {
      if (s.state) { s.state.t = msg.t; s.state.running = msg.running; }
      s.tickT = msg.t; s.tickTime = s.ctx.currentTime;
      return;
    }
    if (msg.type === 'calibration') { s.calibrating?.(msg); s.calibrating = null; return; }
    if (msg.type === 'need') {
      const data = alloc(msg.len);
      const id = s.nextId++;
      if (s.shared) s.bufs.set(id, data);
      post({ cmd: 'buffer', track: msg.track, id, data }, data);
      return;
    }
    if (msg.type === 'snapshot') { s.snapshots[msg.track] = msg.data; s.waves[msg.track] = null; return; }
    if (msg.type === 'state') {
      const prev = s.state;
      s.state = msg;
      s.tickT = msg.t; s.tickTime = s.ctx.currentTime;
      msg.tracks.forEach((tr, i) => {
        const p = prev?.tracks[i];
        const changed = !p || p.len !== tr.len || p.ids.join() !== tr.ids.join() || p.state !== tr.state || p.writing !== tr.writing;
        if (changed) s.waves[i] = null;
        if (changed && !s.shared && tr.len && !tr.writing && tr.state !== 'recording') post({ cmd: 'snapshot', track: i });
      });
      renderTransport();
      renderTracks();
    }
  }

  // Transport time now, extrapolated between messages for a smooth playhead
  function now() {
    if (!s.state) return 0;
    return s.state.running ? s.tickT + (s.ctx.currentTime - s.tickTime) * s.ctx.sampleRate : s.tickT;
  }

  // ---------------------------------------------------------- controls
  // Fires on touch-down rather than release, so loop timing follows the finger
  function press(el, fn) {
    el.addEventListener('pointerdown', (e) => { if (e.button > 0) return; e.preventDefault(); buzz(); fn(); });
    el.addEventListener('click', (e) => { if (e.detail === 0) fn(); }); // keyboard / switch access
  }

  function setup() {
    const rs = $('rhythm');
    for (const group of ['Click', 'Drums']) {
      const og = document.createElement('optgroup');
      og.label = group;
      for (const r of RHYTHMS.filter((x) => x.group === group)) og.appendChild(new Option(r.name, r.id));
      rs.appendChild(og);
    }
    const bind = (id, key, parse, prop = 'value', after = sendSettings) => {
      const el = $(id);
      el[prop] = settings[key];
      el.addEventListener(prop === 'checked' ? 'change' : 'input', () => { settings[key] = parse(el[prop]); save(); after(); });
    };
    bind('rhythm', 'rhythm', String);
    bind('metroVol', 'metroVol', Number);
    bind('countIn', 'countIn', Boolean, 'checked');
    bind('quantize', 'quantize', String);
    bind('recBars', 'recBars', Number);
    bind('lVol', 'loopVol', Number);
    bind('lLat', 'latOffset', Number, 'value', () => { renderLatency(); sendSettings(); });
    const bpm = $('bpm');
    bpm.value = settings.bpm;
    bpm.addEventListener('change', () => setBpm(Number(bpm.value)));
    press($('bpmDown'), () => setBpm(settings.bpm - 1));
    press($('bpmUp'), () => setBpm(settings.bpm + 1));
    press($('tap'), tap);
    press($('metroBtn'), toggleMetronome);
    press($('playAll'), () => cmd({ cmd: 'toggleAll' }));
    $('calibrate').onclick = calibrate;
    syncMetro();
    buildTracks();
    renderLatency();
    renderTransport();
    renderTracks();
  }

  function setBpm(v) {
    if (s.state?.locked) return;
    settings.bpm = Math.round(Math.min(300, Math.max(30, v || 100)));
    $('bpm').value = settings.bpm;
    save();
    sendSettings();
  }

  function tap() {
    const t = performance.now();
    if (s.taps.length && t - s.taps[s.taps.length - 1] > 2000) s.taps = [];
    s.taps.push(t);
    if (s.taps.length > 5) s.taps.shift();
    if (s.taps.length >= 2) setBpm(60000 / ((s.taps[s.taps.length - 1] - s.taps[0]) / (s.taps.length - 1)));
  }

  function toggleMetronome() {
    settings.metronome = !settings.metronome;
    save();
    syncMetro();
    sendSettings();
  }
  function syncMetro() {
    $('metroBtn').setAttribute('aria-pressed', String(settings.metronome));
    $('metroBtn').textContent = settings.metronome ? 'Click on' : 'Click';
  }

  function buildTracks() {
    const root = $('tracks');
    root.replaceChildren();
    for (let i = 0; i < TRACKS; i++) {
      const el = document.createElement('div');
      el.className = 'track';
      el.innerHTML = `
        <div class="track-head"><span class="tname">Track ${i + 1}</span><span class="tstate">EMPTY</span><span class="tinfo">Empty</span></div>
        <canvas class="twave"></canvas>
        <div class="tbtns">
          <button class="tmain rec">● Rec</button>
          <button class="tstop">■ Stop</button>
        </div>
        <div class="tsmall">
          <button class="tundo" aria-label="Undo last overdub">↶</button>
          <button class="tredo" aria-label="Redo">↷</button>
          <button class="tclear" aria-label="Clear track">✕</button>
          <button class="texport" aria-label="Share track as WAV">⇪</button>
          <input type="range" min="0" max="1.5" step="0.01" aria-label="Track ${i + 1} volume">
        </div>`;
      const q = (c) => el.querySelector(c);
      const act = (action) => { s.selected = i; cmd({ cmd: 'track', track: i, action }); };
      press(q('.tmain'), () => act('main'));
      press(q('.tstop'), () => act('stop'));
      q('.tundo').onclick = () => act('undo');
      q('.tredo').onclick = () => act('redo');
      q('.tclear').onclick = () => clearTrack(i);
      q('.texport').onclick = () => exportTrack(i);
      const vol = q('.tsmall input');
      vol.value = settings.trackGains[i];
      vol.oninput = () => {
        settings.trackGains[i] = Number(vol.value);
        save();
        cmd({ cmd: 'gain', track: i, value: settings.trackGains[i] });
      };
      root.appendChild(el);
    }
  }

  function clearTrack(i) {
    const tr = s.state?.tracks[i];
    if (tr && tr.len && !confirm(`Clear track ${i + 1}?`)) return;
    cmd({ cmd: 'track', track: i, action: 'clear' });
  }

  // ---------------------------------------------------------- rendering
  function renderTransport() {
    const st = s.state;
    const locked = !!st?.locked;
    for (const id of ['bpm', 'bpmDown', 'bpmUp', 'tap']) $(id).disabled = locked;
    if (locked && st.bpm !== Number($('bpm').value)) $('bpm').value = st.bpm;
    const beats = (RHYTHMS.find((r) => r.id === settings.rhythm) || RHYTHMS[0]).beats;
    for (const o of $('rhythm').querySelectorAll('option')) {
      o.disabled = locked && RHYTHMS.find((r) => r.id === o.value).beats !== beats; // meter is fixed once loops exist
    }
    $('tempoLock').textContent = locked ? 'Tempo and meter are locked while tracks hold loops.' : '';
    if (st && st.bpm !== settings.bpm && !locked) sendSettings();
    $('playAll').textContent = st?.running ? '■ Stop all' : '▶ Play all';
    $('playAll').classList.toggle('running', !!st?.running);
    const lights = $('beatLights');
    const n = st ? st.beats : beats;
    if (lights.children.length !== n) lights.replaceChildren(...Array.from({ length: n }, () => document.createElement('span')));
  }

  function renderTracks() {
    const st = s.state;
    [...$('tracks').children].forEach((el, i) => {
      const tr = st?.tracks[i] || { state: 'empty', queue: [], len: 0, layers: 0, redo: 0 };
      const eff = tr.queue.length ? tr.queue[tr.queue.length - 1].target : tr.state;
      const [label, cls] = MAIN_LABEL[NEXT[eff]];
      const main = el.querySelector('.tmain');
      main.textContent = label;
      main.className = `tmain ${cls}${tr.queue.length ? ' pending' : ''}`;
      const badge = el.querySelector('.tstate');
      badge.textContent = STATE_LABEL[tr.state];
      badge.className = `tstate ${tr.state}`;
      el.dataset.state = tr.state;
      el.querySelector('.tstop').disabled = eff === 'empty' || eff === 'stopped';
      el.querySelector('.tundo').disabled = !(tr.layers || tr.dubbing || tr.queue.length || tr.state === 'recording');
      el.querySelector('.tredo').disabled = !tr.redo;
      el.querySelector('.tclear').disabled = tr.state === 'empty' && !tr.queue.length;
      el.querySelector('.texport').disabled = !tr.len;
    });
  }

  function frame() {
    const st = s.state;
    const t = now();
    if (st) {
      const beatLen = st.bar / st.beats;
      const counting = st.running && t < st.countInEnd;
      const beat = Math.floor((t % st.bar) / beatLen);
      [...$('beatLights').children].forEach((el, b) => {
        el.className = st.running && b === beat ? (b === 0 ? 'on accent' : 'on') : '';
      });
      $('barPos').textContent = !st.running ? 'Stopped' : counting ? `Count-in ${beat + 1}` : `Bar ${Math.floor(t / st.bar) + 1}·${beat + 1}`;
      $('barPos').classList.toggle('counting', counting);
    }
    [...$('tracks').children].forEach((el, i) => {
      const tr = st?.tracks[i];
      if (!tr) return;
      const sr = s.ctx.sampleRate;
      const info = el.querySelector('.tinfo');
      const bars = (n) => { const b = Math.round((n / st.bar) * 100) / 100; return Number.isInteger(b) ? `${b} bar${b === 1 ? '' : 's'}` : `${b.toFixed(2)} bars`; };
      if (tr.state === 'recording') {
        const cur = Math.max(0, t - tr.anchor);
        info.textContent = `bar ${Math.floor(cur / st.bar) + 1} · ${(cur / sr).toFixed(1)} s`;
      } else if (tr.len) {
        info.textContent = `${bars(tr.len)} · ${(tr.len / sr).toFixed(1)} s` + (tr.layers ? ` · +${tr.layers}` : '');
      } else {
        info.textContent = 'Empty';
      }
      // A queued action replaces the info with a countdown
      const q = tr.queue[0];
      if (q && st.running) {
        const beatsLeft = Math.max(0, Math.ceil((q.at - t) / (st.bar / st.beats)));
        info.textContent = `${STATE_LABEL[q.target]} ${beatsLeft ? `in ${beatsLeft} beat${beatsLeft > 1 ? 's' : ''}` : 'now'}`;
      }
      info.classList.toggle('pending', !!(q && st.running));
      drawTrack(el.querySelector('.twave'), i, tr, t);
    });
  }

  // ---------------------------------------------------------- waveforms
  function layersOf(tr) {
    return s.shared ? tr.ids.map((id) => s.bufs.get(id)).filter(Boolean) : [];
  }

  // Peak envelope of base + overdubs, one value per column
  function peaks(i, tr, length, cols) {
    const out = new Float32Array(cols);
    const base = s.shared ? s.rec[i] : s.snapshots[i];
    if (!base || !length) return out;
    const layers = layersOf(tr);
    const step = Math.max(1, Math.floor(length / cols / 48));
    for (let c = 0; c < cols; c++) {
      const a = Math.floor((c * length) / cols), b = Math.floor(((c + 1) * length) / cols);
      let mx = 0;
      for (let k = a; k < b && k < base.length; k += step) {
        let v = base[k];
        for (const l of layers) v += l[k];
        if (Math.abs(v) > mx) mx = Math.abs(v);
      }
      out[c] = mx;
    }
    return out;
  }

  function drawTrack(cv, i, tr, t) {
    const { g, W, H } = fitCanvas(cv);
    const cols = Math.round(W);
    const live = tr.state === 'recording' || tr.dubbing || tr.writing;
    const nowMs = performance.now();
    let w = s.waves[i];
    if (!w || w.env.length !== cols || (live && nowMs - w.time > 300)) {
      const length = tr.state === 'recording' ? Math.max(0, Math.floor(t - latencySamples() - tr.anchor)) : tr.len;
      w = s.waves[i] = { time: nowMs, length, env: peaks(i, tr, length, cols) };
    }
    g.clearRect(0, 0, W, H);
    if (!w.length && tr.state !== 'recording') {
      g.fillStyle = '#5a6170';
      g.font = '13px system-ui';
      g.textAlign = 'center';
      g.fillText(tr.queue.length ? 'Waiting for the bar…' : 'Empty', W / 2, H / 2 + 4);
      return;
    }
    let max = 1e-4;
    for (const v of w.env) max = Math.max(max, v);
    const scale = Math.min(1 / max, 10) * 0.9 * (H / 2);
    g.fillStyle = tr.state === 'stopped' ? '#3b4253' : '#6aa8ff';
    for (let x = 0; x < cols; x++) {
      const h = Math.max(0.5, w.env[x] * scale);
      g.fillRect(x, H / 2 - h, 1, h * 2);
    }
    if (s.state && tr.len) {
      g.fillStyle = 'rgba(255,255,255,0.14)';
      for (let b = s.state.bar; b < tr.len; b += s.state.bar) g.fillRect(Math.round((b / tr.len) * W), 0, 1, H);
    }
    if ((tr.state === 'playing' || tr.state === 'dubbing') && tr.len) {
      const x = ((((t - tr.anchor) % tr.len) + tr.len) % tr.len / tr.len) * W;
      g.fillStyle = tr.state === 'dubbing' ? 'rgba(242,161,78,0.2)' : 'rgba(90,209,166,0.14)';
      g.fillRect(0, 0, x, H);
      g.fillStyle = COLOR[tr.state];
      g.fillRect(x - 1, 0, 2.5, H);
    }
  }

  // ---------------------------------------------------------- export
  // Phones: the share sheet (save to Files, send to an app); elsewhere a download
  async function exportTrack(i) {
    const tr = s.state?.tracks[i];
    if (!tr?.len) return;
    let mix;
    if (s.shared) {
      mix = s.rec[i].slice(0, tr.len);
      for (const l of layersOf(tr)) for (let k = 0; k < tr.len; k++) mix[k] += l[k];
    } else {
      mix = s.snapshots[i]?.slice();
      if (!mix) return;
    }
    let peak = 0;
    for (const v of mix) peak = Math.max(peak, Math.abs(v));
    if (peak > 0.99) for (let k = 0; k < mix.length; k++) mix[k] *= 0.99 / peak;
    const blob = encodeWav(mix, s.ctx.sampleRate);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const name = `track${i + 1}-${settings.bpm}bpm-${stamp}.wav`;
    const file = new File([blob], name, { type: 'audio/wav' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ---------------------------------------------------------- keys / pedals
  function onKey(e) {
    const k = e.key.toLowerCase();
    const mi = KEYS.main.indexOf(k), si = KEYS.stop.indexOf(k);
    if (mi >= 0) cmd({ cmd: 'track', track: mi, action: 'main' });
    else if (si >= 0) cmd({ cmd: 'track', track: si, action: 'stop' });
    else if (k === ' ') cmd({ cmd: 'toggleAll' });
    else if (k === 'z') cmd({ cmd: 'track', track: s.selected, action: e.shiftKey ? 'redo' : 'undo' });
    else return false;
    return true;
  }

  const running = () => !!s.state?.running;
  return { attach, setup, frame, onKey, updateLatency, renderLatency, running };
}
