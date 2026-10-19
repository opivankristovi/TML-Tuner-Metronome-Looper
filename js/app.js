import { PitchDetector, PolyDetector, nameChord, findFingerings, findOnset, positionsFor, freqToMidi, midiToFreq, noteName, NOTE_NAMES, pc, rmsOf } from './dsp.js';
import { INSTRUMENTS, isBass } from './instruments.js';
import { renderFretboard } from './fretboard.js';
import { createStation } from './station.js';

const $ = (id) => document.getElementById(id);
const GATE = 0.0025; // RMS below this is always treated as silence

// Microphones pick up room noise, so the silence gate follows each input's noise floor:
// the quietest level of the last 8 seconds (minimum per half-second bucket), so it adapts
// quickly but can never ratchet up while you play.
const noise = { floor: 0, buckets: [], bucketStart: 0 };
function trackNoiseFloor(buf, now) {
  const r = rmsOf(buf, 2048);
  if (r <= 0) return; // dead input
  if (!noise.buckets.length || now - noise.bucketStart > 500) {
    noise.buckets.push(r);
    noise.bucketStart = now;
    if (noise.buckets.length > 16) noise.buckets.shift();
  } else {
    noise.buckets[noise.buckets.length - 1] = Math.min(noise.buckets[noise.buckets.length - 1], r);
  }
  noise.floor = Math.min(...noise.buckets);
}
const gate = () => Math.min(0.01, Math.max(GATE, noise.floor * 2));

// ------------------------------------------------------------- settings
const settings = Object.assign(
  {
    deviceId: '', channel: 'mix', gain: 0, monitor: false, monitorVol: 0.8, instrument: 'gtr-std', a4: 440, tab: 'tuner', anMode: 'auto', sens: 0.22,
    loopVol: 1, latOffset: 0, bpm: 100, rhythm: 'click-4', metronome: false, metroVol: 0.7, countIn: true, quantize: 'bar', recBars: 0, trackGains: [1, 1, 1], devices: {},
  },
  load()
);
function load() { try { return JSON.parse(localStorage.getItem('irig-lab') || '{}'); } catch { return {}; } }
function save() { try { localStorage.setItem('irig-lab', JSON.stringify(settings)); } catch { /* storage unavailable */ } }

const station = createStation({ settings, save, banner });

const inst = () => INSTRUMENTS.find((i) => i.id === settings.instrument) || INSTRUMENTS[0];

// ---------------------------------------------------------------- audio
const audio = { ctx: null, stream: null, source: null, splitter: null, input: null, analyser: null, monitor: null, buf: null, devices: [] };
let pitch4k, pitch8k, poly;

async function buildGraph() {
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  audio.ctx = ctx;
  audio.input = new GainNode(ctx, { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
  audio.analyser = new AnalyserNode(ctx, { fftSize: 32768, smoothingTimeConstant: 0 });
  audio.input.connect(audio.analyser);
  audio.monitor = new GainNode(ctx, { gain: 0 });
  audio.input.connect(audio.monitor).connect(ctx.destination);
  await station.attach(ctx, audio.input);
  audio.buf = new Float32Array(audio.analyser.fftSize);
  pitch4k = new PitchDetector(4096, ctx.sampleRate);
  pitch8k = new PitchDetector(8192, ctx.sampleRate);
  poly = new PolyDetector(32768, ctx.sampleRate);
  applyGain(); applyMonitor();
}

let startGen = 0;
let pendingOpen = null; // label of a device whose open hasn't settled yet

const deviceLabel = (id) => audio.devices.find((d) => d.deviceId === id)?.label || (id && id !== 'default' ? 'the selected input' : 'the default input');

// Opens the selected input. Safe to call again while running: only the latest call wins.
// The current input keeps working until the new one is open.
async function startAudio() {
  const gen = ++startGen;
  if (!audio.devices.length) await listDevices();
  const target = settings.deviceId;
  const name = escapeHtml(deviceLabel(target));
  banner(pendingOpen
    ? `Waiting for <b>${escapeHtml(pendingOpen)}</b> to respond before opening <b>${name}</b>… (the browser opens one input at a time)`
    : `Opening <b>${name}</b>…`);
  const slow = setTimeout(() => {
    if (gen === startGen) banner(`<b>${name}</b> isn't responding. The browser gives up after about 30 s` + (audio.stream ? '; the current input keeps working meanwhile.' : '.'), true);
  }, 3000);
  const opening = deviceLabel(target);
  pendingOpen ??= opening;
  try {
    audio.ready ??= buildGraph();
    await audio.ready;
    await audio.ctx.resume();
    const constraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, latency: { ideal: 0.003 } };
    if (target) constraints.deviceId = { exact: target };
    let missing = false, stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
    } catch (err) {
      if (err.name !== 'OverconstrainedError' && err.name !== 'NotFoundError') throw err;
      delete constraints.deviceId; // the saved device isn't plugged in
      missing = true;
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
    } finally {
      if (pendingOpen === opening) pendingOpen = null;
    }
    if (gen !== startGen) { stream.getTracks().forEach((t) => t.stop()); return; } // superseded
    audio.stream?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    audio.stream = stream;
    const devices = await listDevices();
    if (gen !== startGen) return;
    // First run: prefer the iRig over the system default
    const irig = devices.find((d) => /irig/i.test(d.label));
    if (!settings.deviceId && irig && irig.deviceId !== currentDeviceId()) return switchDevice(irig.deviceId);

    const track = audio.stream.getAudioTracks()[0];
    track.onended = () => onDeviceLost(track.label);
    applyDeviceProfile(currentDeviceId());
    connectSource();
    noise.floor = 0;
    noise.buckets = [];
    dead.lastSignal = 0;
    dead.warned = false;
    station.updateLatency(audio.stream);
    setTimeout(() => station.updateLatency(audio.stream), 1500); // outputLatency is only known once the context runs
    const label = track?.label || 'input';
    banner((missing ? 'The saved input is not connected, so the default input is used. ' : '') +
      `Listening on <b>${escapeHtml(label)}</b> · ${audio.ctx.sampleRate} Hz`);
    $('start').textContent = 'Restart audio';
    $('start').classList.remove('primary');
  } catch (err) {
    if (gen !== startGen) return; // a newer request is in charge
    const why = err.name === 'NotReadableError' ? 'the device is busy or not working' + (/irig/i.test(opening) ? ' (see the iRig USB note in the README)' : '')
      : err.name === 'NotAllowedError' ? 'microphone access was denied' : err.message || err.name;
    if (audio.stream && err.name !== 'NotAllowedError') {
      // Stay on the input that works, and remember it so the broken one isn't retried at every launch
      settings.deviceId = currentDeviceId();
      save();
      await listDevices();
      banner(`Could not open <b>${escapeHtml(opening)}</b>: ${escapeHtml(why)}. Still listening on <b>${escapeHtml(audio.stream.getAudioTracks()[0]?.label || 'the previous input')}</b>.`, true);
    } else if (target && err.name !== 'NotAllowedError') {
      banner(`Could not open <b>${escapeHtml(opening)}</b>: ${escapeHtml(why)}. Trying the default input…`, true);
      settings.deviceId = 'default';
      save();
      return startAudio();
    } else {
      banner(`Could not open audio input: ${escapeHtml(why)}`, true);
    }
  } finally {
    clearTimeout(slow);
  }
}

function connectSource() {
  audio.source?.disconnect();
  audio.splitter?.disconnect();
  audio.source = audio.ctx.createMediaStreamSource(audio.stream);
  if (settings.channel === 'mix') {
    audio.source.connect(audio.input);
  } else {
    audio.splitter = audio.ctx.createChannelSplitter(2);
    audio.source.connect(audio.splitter);
    audio.splitter.connect(audio.input, Number(settings.channel));
  }
}

const currentDeviceId = () => audio.stream?.getAudioTracks()[0]?.getSettings().deviceId || settings.deviceId || 'default';

// Fills the Input menu. Labels are only available once microphone access was granted.
async function listDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  const sel = $('device');
  const labelled = devices.some((d) => d.label);
  if (!labelled) {
    sel.replaceChildren(new Option('(press Start audio to list inputs)', ''));
  } else {
    sel.replaceChildren(...devices.map((d, i) => new Option(deviceName(d, i), d.deviceId)));
    sel.value = audio.stream ? currentDeviceId() : settings.deviceId;
    if (sel.selectedIndex < 0) sel.selectedIndex = 0;
  }
  audio.devices = devices;
  return devices;
}

function deviceName(d, i) {
  const label = d.label || `Input ${i + 1}`;
  if (d.deviceId === 'default' || d.deviceId === 'communications') return label;
  return /irig|interface|guitar|instrument|hi-?z/i.test(label) ? `🎸 ${label}` : `🎤 ${label}`;
}

async function switchDevice(id) {
  saveDeviceProfile();
  settings.deviceId = id;
  save();
  await startAudio();
}

// Gain and channel are remembered per device: a microphone needs different settings than the iRig
function saveDeviceProfile() {
  if (!audio.stream) return;
  settings.devices[currentDeviceId()] = { gain: settings.gain, channel: settings.channel };
  save();
}
function applyDeviceProfile(id) {
  const p = settings.devices[id] || { gain: 0, channel: 'mix' };
  settings.gain = p.gain;
  settings.channel = p.channel;
  $('gain').value = p.gain;
  $('channel').value = p.channel;
  applyGain();
}

function onDeviceLost(label) {
  banner(`<b>${escapeHtml(label || 'The input')}</b> was disconnected. Pick another input under <b>Input</b>, or plug it back in.`, true);
}

// Hot-plugging: refresh the menu, offer newly connected inputs, recover when ours vanished
async function onDeviceChange() {
  const before = new Set((audio.devices || []).map((d) => d.deviceId));
  const devices = await listDevices();
  if (!audio.stream) return;
  const track = audio.stream.getAudioTracks()[0];
  const ours = currentDeviceId();
  if (track?.readyState === 'ended' || !devices.some((d) => d.deviceId === ours)) {
    onDeviceLost(track?.label);
    return;
  }
  const added = devices.find((d) => !before.has(d.deviceId) && d.deviceId !== 'default' && d.deviceId !== 'communications' && d.label);
  if (added && before.size) {
    banner(`New input connected: <b>${escapeHtml(added.label)}</b> <button id="useNew" class="small">Use it</button>`);
    $('useNew').onclick = () => switchDevice(added.deviceId);
  }
}

function applyGain() {
  $('gainOut').textContent = `${settings.gain} dB`;
  if (audio.input) audio.input.gain.value = Math.pow(10, settings.gain / 20);
}
function applyMonitor() {
  if (audio.monitor) audio.monitor.gain.setTargetAtTime(settings.monitor ? settings.monitorVol : 0, audio.ctx.currentTime, 0.02);
}

// ----------------------------------------------------------------- UI basics
function banner(html, error = false) {
  const b = $('banner');
  b.innerHTML = html;
  b.classList.toggle('error', error);
  b.classList.remove('hidden');
}
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function setupControls() {
  const instSel = $('instrument');
  for (const group of ['Guitar', 'Bass']) {
    const og = document.createElement('optgroup');
    og.label = group;
    for (const i of INSTRUMENTS.filter((x) => x.group === group)) og.appendChild(new Option(i.name, i.id));
    instSel.appendChild(og);
  }
  instSel.value = settings.instrument;
  instSel.onchange = () => { settings.instrument = instSel.value; save(); onInstrumentChange(); };

  $('start').onclick = startAudio;
  $('device').onchange = () => {
    if (!$('device').value) return;
    if (audio.stream) switchDevice($('device').value);
    else { settings.deviceId = $('device').value; save(); }
  };
  navigator.mediaDevices?.addEventListener('devicechange', onDeviceChange);
  listDevices();
  $('channel').value = settings.channel;
  $('channel').onchange = () => { settings.channel = $('channel').value; saveDeviceProfile(); if (audio.stream) connectSource(); };
  $('gain').value = settings.gain;
  $('gain').oninput = () => { settings.gain = Number($('gain').value); saveDeviceProfile(); applyGain(); };
  applyGain();
  $('monitor').checked = settings.monitor;
  $('monitor').onchange = () => { settings.monitor = $('monitor').checked; save(); applyMonitor(); };
  $('monitorVol').value = settings.monitorVol;
  $('monitorVol').oninput = () => { settings.monitorVol = Number($('monitorVol').value); save(); applyMonitor(); };
  $('a4').value = settings.a4;
  $('a4').onchange = () => {
    settings.a4 = Math.min(466, Math.max(415, Number($('a4').value) || 440));
    $('a4').value = settings.a4;
    save();
  };

  for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => showTab(b.dataset.tab);
  showTab(settings.tab);

  for (const b of document.querySelectorAll('#anMode button')) {
    b.onclick = () => { settings.anMode = b.dataset.mode; save(); syncSeg(); };
  }
  syncSeg();
  $('sens').value = settings.sens;
  $('sens').oninput = () => { settings.sens = Number($('sens').value); save(); };
  $('vPrev').onclick = () => cycleVoicing(-1);
  $('vNext').onclick = () => cycleVoicing(1);
  $('anHistClear').onclick = () => { an.history = []; renderHistory(); };

  station.setup();
  document.addEventListener('keydown', onKey);
  onInstrumentChange();
}

function syncSeg() {
  for (const b of document.querySelectorAll('#anMode button')) b.classList.toggle('active', b.dataset.mode === settings.anMode);
}

function showTab(tab) {
  settings.tab = tab;
  save();
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const s of document.querySelectorAll('.tab')) s.classList.toggle('active', s.id === `tab-${tab}`);
}

function onInstrumentChange() {
  tuner.lockedString = null;
  tuner.tuned.clear();
  const btns = $('stringBtns');
  btns.replaceChildren();
  // Display high → low like a headstock seen from the front? Players read low → high.
  inst().tuning.forEach((m, s) => {
    const b = document.createElement('button');
    b.className = 'string';
    b.textContent = noteName(m);
    b.title = `String ${inst().tuning.length - s}`;
    b.onclick = () => { tuner.lockedString = tuner.lockedString === s ? null : s; syncStringButtons(); };
    btns.appendChild(b);
  });
  $('stringAuto').onclick = () => { tuner.lockedString = null; syncStringButtons(); };
  syncStringButtons();
  an.key = '';
  an.notes = [];
  an.votes.clear();
  renderAnalyzer(true);
}

// ---------------------------------------------------------------- level meter
const meter = { peakHold: 0, peakTime: 0, clipTime: 0 };
function updateMeter(buf, now) {
  let peak = 0;
  for (let i = buf.length - 2048; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
  const db = 20 * Math.log10(peak + 1e-9);
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  $('meterFill').style.width = pct + '%';
  if (pct >= meter.peakHold || now - meter.peakTime > 1500) { meter.peakHold = pct; meter.peakTime = now; }
  $('meterPeak').style.left = `calc(${meter.peakHold}% - 2px)`;
  if (peak >= 0.98) meter.clipTime = now;
  $('clip').classList.toggle('on', now - meter.clipTime < 1500);
}

// ---------------------------------------------------------------- tuner
const tuner = { lockedString: null, recent: [], cents: 0, shownCents: 0, lastSeen: 0, history: [], tuned: new Set(), inTuneSince: 0, midi: null, freq: 0 };

function detectMono(buf) {
  const bass = isBass(inst());
  const det = bass ? pitch8k : pitch4k;
  const r = det.detect(buf, { minFreq: bass ? 25 : 60, maxFreq: bass ? 600 : 1500, lowpass: bass ? 500 : 1200, gate: gate() });
  return r.freq > 0 && r.clarity > 0.8 ? r : null;
}

function updateTuner(buf, now) {
  const r = detectMono(buf);
  const tuning = inst().tuning;
  if (r) {
    const m = freqToMidi(r.freq, settings.a4);
    // Median of recent readings suppresses octave blips during the attack
    tuner.recent.push(m);
    if (tuner.recent.length > 5) tuner.recent.shift();
    const med = [...tuner.recent].sort((a, b) => a - b)[Math.floor(tuner.recent.length / 2)];
    if (Math.abs(med - m) > 0.5) return drawTuner(now);
    let target = Math.round(m);
    let nearest = 0;
    tuning.forEach((t, s) => { if (Math.abs(m - t) < Math.abs(m - tuning[nearest])) nearest = s; });
    if (tuner.lockedString !== null) target = tuning[tuner.lockedString];
    tuner.near = Math.abs(m - tuning[nearest]) < 1.5 ? nearest : null;
    tuner.target = target;
    tuner.cents = (m - target) * 100;
    tuner.midi = Math.round(m);
    tuner.freq = r.freq;
    tuner.lastSeen = now;
    tuner.history.push({ t: now, c: tuner.cents });

    const stringIdx = tuner.lockedString ?? (tuner.near !== null && tuning[tuner.near] === target ? tuner.near : null);
    if (Math.abs(tuner.cents) < 3) {
      if (!tuner.inTuneSince) tuner.inTuneSince = now;
      if (stringIdx !== null && now - tuner.inTuneSince > 700) tuner.tuned.add(stringIdx);
    } else {
      tuner.inTuneSince = 0;
    }
  } else {
    tuner.recent = [];
    tuner.inTuneSince = 0;
  }
  drawTuner(now);
}

function syncStringButtons() {
  $('stringAuto').classList.toggle('active', tuner.lockedString === null);
  [...$('stringBtns').children].forEach((b, s) => {
    b.classList.toggle('active', tuner.lockedString === s);
    b.classList.toggle('near', tuner.lockedString === null && tuner.near === s && tuner.fresh);
    b.classList.toggle('tuned', tuner.tuned.has(s));
  });
}

function drawTuner(now) {
  const fresh = now - tuner.lastSeen < 400;
  tuner.fresh = fresh;
  const cents = tuner.cents;
  if (fresh) tuner.shownCents += (Math.max(-50, Math.min(50, cents)) - tuner.shownCents) * 0.35;
  const noteEl = $('tNote');
  const hasNote = tuner.midi !== null && tuner.lastSeen > 0;
  noteEl.textContent = hasNote ? NOTE_NAMES[pc(tuner.target)] : '–';
  $('tOct').textContent = hasNote ? Math.floor(tuner.target / 12) - 1 : '';
  const abs = Math.abs(cents);
  noteEl.className = 'big-note' + (!fresh ? ' stale' : abs < 3 ? ' in-tune' : abs < 10 ? ' close' : '');
  $('tCents').textContent = hasNote ? (cents > 0 ? '+' : '') + cents.toFixed(1) : '–';
  $('tFreq').textContent = hasNote ? tuner.freq.toFixed(2) : '–';
  $('tTarget').textContent = hasNote ? `${noteName(tuner.target)} ${midiToFreq(tuner.target, settings.a4).toFixed(1)}` : '–';
  const hint = $('tHint');
  if (!fresh) hint.textContent = audio.ctx ? 'Play a single string…' : '';
  else if (abs < 3) hint.textContent = '✓ In tune';
  else if (abs > 50) hint.textContent = `${(abs / 100).toFixed(1)} semitones ${cents > 0 ? 'sharp: tune down ↓' : 'flat: tune up ↑'}`;
  else hint.textContent = cents > 0 ? 'Sharp: tune down ↓' : 'Flat: tune up ↑';
  hint.classList.toggle('go', fresh && abs < 3);
  syncStringButtons();
  drawGauge(fresh);
  drawHistory(now);
}

function drawGauge(fresh) {
  const c = $('gauge'), g = c.getContext('2d');
  const W = c.width, H = c.height, cx = W / 2, cy = H - 24, R = H - 100;
  g.clearRect(0, 0, W, H);
  const ang = (cents) => -Math.PI / 2 + (cents / 50) * (Math.PI / 3);
  // zones
  const arc = (from, to, color, width) => {
    g.beginPath(); g.arc(cx, cy, R, ang(from), ang(to)); g.strokeStyle = color; g.lineWidth = width; g.stroke();
  };
  arc(-50, 50, '#232833', 18);
  arc(-10, 10, '#3d3a22', 18);
  arc(-3, 3, '#1f5a46', 18);
  g.fillStyle = '#8b93a3';
  g.font = '15px system-ui';
  g.textAlign = 'center';
  for (let t = -50; t <= 50; t += 5) {
    const a = ang(t), major = t % 10 === 0;
    const r1 = R + 14, r2 = R + (major ? 30 : 22);
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    g.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
    g.strokeStyle = major ? '#8b93a3' : '#4a5160';
    g.lineWidth = major ? 2 : 1;
    g.stroke();
    if (major) g.fillText((t > 0 ? '+' : '') + t, cx + Math.cos(a) * (R + 46), cy + Math.sin(a) * (R + 46) + 5);
  }
  const a = ang(tuner.shownCents);
  const abs = Math.abs(tuner.cents);
  g.strokeStyle = !fresh ? '#3a404d' : abs < 3 ? '#5ad1a6' : abs < 10 ? '#f2c14e' : '#ef5b5b';
  g.lineWidth = 5;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(cx, cy);
  g.lineTo(cx + Math.cos(a) * (R + 8), cy + Math.sin(a) * (R + 8));
  g.stroke();
  g.fillStyle = g.strokeStyle;
  g.beginPath(); g.arc(cx, cy, 10, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#8b93a3';
  g.font = '13px system-ui';
  g.fillText('♭ flat', cx - R * 0.72, cy);
  g.fillText('sharp ♯', cx + R * 0.72, cy);
}

function drawHistory(now) {
  const c = $('history'), g = c.getContext('2d');
  const W = c.width, H = c.height, span = 6000;
  tuner.history = tuner.history.filter((p) => now - p.t < span);
  g.clearRect(0, 0, W, H);
  g.fillStyle = 'rgba(90,209,166,0.08)';
  g.fillRect(0, H / 2 - (3 / 50) * (H / 2), W, (6 / 50) * (H / 2));
  g.strokeStyle = '#2a2f3a';
  g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
  g.strokeStyle = '#6aa8ff';
  g.lineWidth = 2;
  g.beginPath();
  let prev = null;
  for (const p of tuner.history) {
    const x = W - ((now - p.t) / span) * W;
    const y = H / 2 - (Math.max(-50, Math.min(50, p.c)) / 50) * (H / 2 - 4);
    if (prev && p.t - prev.t < 200) g.lineTo(x, y); else g.moveTo(x, y);
    prev = p;
  }
  g.stroke();
  g.fillStyle = '#8b93a3';
  g.font = '11px system-ui';
  g.fillText('+50', 4, 12);
  g.fillText('−50', 4, H - 4);
}

// ---------------------------------------------------------------- analyzer
const an = { _keys: new Set(), votes: new Map(), notes: [], key: '', keySince: 0, label: '', loggedKey: '', voicings: [], vIndex: 0, lastPoly: 0, lastSound: 0, lastOnset: -Infinity, history: [], mono: null, display: null };

function updateAnalyzer(buf, now) {
  const tuning = inst().tuning;
  const minMidi = Math.min(...tuning) - 1;
  const maxMidi = Math.min(96, Math.max(...tuning) + inst().frets);
  const sounding = rmsOf(buf, 4096) > gate();
  if (sounding) an.lastSound = now;
  an.mono = sounding ? detectMono(buf) : null;

  if (now - an.lastPoly > 110) {
    an.lastPoly = now;
    // Analyse only what was played after the latest pick attack, once enough of it has arrived;
    // the attack itself is broadband noise and the previous chord would blur the result.
    const sr = audio.ctx.sampleRate;
    const onset = findOnset(buf, { gate: gate() });
    let length = poly.size, fresh = false;
    if (onset >= 0) {
      length = buf.length - onset - Math.round(sr * 0.03);
      const at = audio.ctx.currentTime * sr - (buf.length - onset);
      if (length < sr * 0.2) return renderAnalyzer(false, now); // still settling
      if (at - an.lastOnset > 4096) { an.lastOnset = at; an.votes.clear(); fresh = true; }
    }
    const notes = sounding ? poly.analyze(buf, { minMidi, maxMidi, a4: settings.a4, relThreshold: settings.sens, gate: gate(), length }) : [];
    const present = new Map(notes.map((n) => [n.midi, n]));
    an._keys.clear();
    for (const m of an.votes.keys()) an._keys.add(m);
    for (const m of present.keys()) an._keys.add(m);
    for (const m of an._keys) {
      const v = an.votes.get(m) || { score: 0 };
      v.score = fresh ? 0.6 : v.score * 0.6 + (present.has(m) ? 0.4 : 0);
      if (present.has(m)) v.note = present.get(m);
      if (v.score < 0.05) an.votes.delete(m); else an.votes.set(m, v);
    }
    const stable = [...an.votes.entries()].filter(([, v]) => v.score > 0.55).map(([, v]) => v.note).sort((a, b) => a.midi - b.midi);
    if (!($('hold').checked && !stable.length)) an.notes = stable;
    drawSpectrum(notes);
  }
  renderAnalyzer(false, now);
}

function chooseDisplay() {
  const mode = settings.anMode;
  const pcs = new Set(an.notes.map((n) => pc(n.midi)));
  if (mode === 'chord' || (mode === 'auto' && pcs.size >= 2)) {
    if (!an.notes.length) return null;
    return { kind: 'chord', notes: an.notes };
  }
  // Single note: prefer the monophonic detector (more precise), else the lowest poly note
  if (an.mono) {
    const m = freqToMidi(an.mono.freq, settings.a4);
    return { kind: 'note', midi: Math.round(m), cents: (m - Math.round(m)) * 100, freq: an.mono.freq };
  }
  if (an.notes.length) {
    const n = an.notes[0];
    return { kind: 'note', midi: n.midi, cents: n.cents, freq: n.freq };
  }
  return null;
}

function renderAnalyzer(force, now = performance.now()) {
  const tuning = inst().tuning;
  let d = chooseDisplay();
  const fresh = !!d;
  if (!d && $('hold').checked) d = an.display;
  if (!d && an.display && now - an.lastSound < 2500) d = an.display;
  $('anName').classList.toggle('stale', !fresh);

  if (!d) {
    if (!force && !an.display) return;
    an.display = null;
    $('anName').textContent = '–';
    $('anLong').textContent = 'Play a note or strum a chord';
    $('anNotes').replaceChildren();
    $('anAlt').replaceChildren();
    $('anPositions').replaceChildren();
    $('vLabel').textContent = '';
    an.key = '';
    renderFretboard($('fretboard'), { tuning, maxFret: inst().frets });
    return;
  }
  an.display = d;
  if (fresh && an.key && an.loggedKey !== an.key && now - an.keySince > 400) {
    an.loggedKey = an.key;
    pushHistory(an.label);
  }

  if (d.kind === 'note') {
    const key = `n${d.midi}`;
    $('anName').innerHTML = `${NOTE_NAMES[pc(d.midi)]}<span class="octave">${Math.floor(d.midi / 12) - 1}</span>`;
    $('anLong').textContent = `${d.freq.toFixed(1)} Hz · ${d.cents >= 0 ? '+' : ''}${d.cents.toFixed(0)} cents`;
    if (key === an.key && !force) return;
    setKey(key, noteName(d.midi), now);
    const pos = positionsFor(d.midi, tuning, inst().frets);
    $('anNotes').replaceChildren(chip(noteName(d.midi), true));
    $('anAlt').replaceChildren();
    $('anBoardTitle').textContent = `Where ${noteName(d.midi)} is on the neck`;
    $('vLabel').textContent = '';
    $('vPrev').disabled = $('vNext').disabled = true;
    renderFretboard($('fretboard'), { tuning, maxFret: inst().frets, markers: pos.map((p) => ({ ...p, kind: 'root', label: NOTE_NAMES[pc(d.midi)] })) });
    $('anPositions').innerHTML = pos.map((p) => `<b>${stringLabel(p.string)}</b> fret ${p.fret}`).join(' · ') || 'Out of range for this instrument';
    return;
  }

  // Chord
  const midis = d.notes.map((n) => n.midi);
  const key = 'c' + midis.join(',');
  const cands = nameChord(midis);
  const top = cands[0];
  $('anName').textContent = top ? top.name : '?';
  $('anLong').textContent = top ? top.longName : '';
  if (key === an.key && !force) return;
  setKey(key, top ? top.name : '?', now);
  const rootPc = top ? NOTE_NAMES.indexOf(top.name.match(/^[A-G]#?/)[0]) : -1;
  $('anNotes').replaceChildren(...d.notes.map((n) => chip(noteName(n.midi), pc(n.midi) === rootPc, n.cents)));
  $('anAlt').innerHTML = cands.length > 1 ? 'Could also be: ' + cands.slice(1).map((c) => `<b>${escapeHtml(c.name)}</b>`).join('') : '';
  an.voicings = fingeringsWithFallback(midis, tuning);
  an.vIndex = 0;
  an.rootPc = rootPc;
  drawVoicing();
}

function setKey(key, label, now) {
  if (key !== an.key) an.keySince = now;
  an.key = key;
  an.label = label;
}

// If every note can't be fretted at once (e.g. a spurious detection), drop notes until it can.
function fingeringsWithFallback(midis, tuning) {
  let opts = findFingerings(midis, tuning, inst().frets);
  if (opts.length || midis.length < 3) return opts;
  for (let i = midis.length - 1; i >= 0 && !opts.length; i--) {
    opts = findFingerings(midis.filter((_, j) => j !== i), tuning, inst().frets);
  }
  return opts;
}

function drawVoicing() {
  const tuning = inst().tuning;
  const v = an.voicings[an.vIndex];
  $('vPrev').disabled = an.vIndex <= 0;
  $('vNext').disabled = an.vIndex >= an.voicings.length - 1;
  if (!v) {
    $('anBoardTitle').textContent = 'No playable fingering found';
    $('vLabel').textContent = '';
    renderFretboard($('fretboard'), { tuning, maxFret: inst().frets });
    $('anPositions').textContent = '';
    return;
  }
  $('anBoardTitle').textContent = 'Strings & frets';
  $('vLabel').textContent = `voicing ${an.vIndex + 1}/${an.voicings.length}`;
  const frets = completeVoicing(v.frets);
  const markers = [], muted = [];
  frets.forEach((f, s) => {
    if (f === null) return muted.push(s);
    const kind = v.frets[s] === null ? 'inferred' : pc(tuning[s] + f) === an.rootPc ? 'root' : 'note';
    markers.push({ string: s, fret: f, kind, label: NOTE_NAMES[pc(tuning[s] + f)] });
  });
  renderFretboard($('fretboard'), { tuning, maxFret: inst().frets, markers, muted });
  const tab = frets.map((f) => (f === null ? 'x' : f)).join(frets.some((f) => f > 9) ? '-' : '');
  const inferred = frets.some((f, s) => f !== null && v.frets[s] === null);
  $('anPositions').innerHTML = `Shape <b>${tab}</b> (low → high) · ` +
    frets.map((f, s) => (f === null ? null : `<b>${stringLabel(s)}</b> ${f === 0 ? 'open' : 'fret ' + f}`)).filter(Boolean).reverse().join(' · ') +
    (inferred ? '<br><small>Faded dots: octave doublings that blend into the other notes\' overtones, so they are inferred from the shape.</small>' : '');
}

// Octave doublings sit on top of lower notes' overtones, so the detector reports each pitch
// class once. Fill unused strings above the bass with a chord tone that fits the hand shape
// when the spectrum shows energy at that pitch.
function completeVoicing(frets) {
  const tuning = inst().tuning;
  const out = [...frets];
  const pcs = new Set(an.notes.map((n) => pc(n.midi)));
  const played = frets.map((f, s) => (f === null ? null : s)).filter((s) => s !== null);
  if (!played.length || !poly) return out;
  const fretted = frets.filter((f) => f > 0);
  const lo = fretted.length ? Math.min(...fretted) : 1;
  const hi = fretted.length ? Math.max(...fretted) : 1;
  for (let s = played[0] + 1; s < tuning.length; s++) {
    if (out[s] !== null) continue;
    let best = null;
    for (let f = 0; f <= inst().frets; f++) {
      if (!pcs.has(pc(tuning[s] + f))) continue;
      if (f > 0 && (Math.max(hi, f) - Math.min(lo, f) > 4)) continue;
      const level = poly.levelAt(midiToFreq(tuning[s] + f, settings.a4));
      if (level >= 0.35 && (!best || Math.abs(f - lo) < Math.abs(best - lo))) best = f;
    }
    if (best !== null) out[s] = best;
  }
  return out;
}

function cycleVoicing(dir) {
  an.vIndex = Math.max(0, Math.min(an.voicings.length - 1, an.vIndex + dir));
  drawVoicing();
}

function stringLabel(s) {
  const t = inst().tuning;
  return `${t.length - s} (${NOTE_NAMES[pc(t[s])]})`;
}

function chip(text, root, cents) {
  const s = document.createElement('span');
  s.className = 'chip' + (root ? ' root' : '');
  s.textContent = text;
  if (cents !== undefined) {
    const small = document.createElement('small');
    small.textContent = `${cents >= 0 ? '+' : ''}${cents}¢`;
    s.appendChild(small);
  }
  return s;
}

function pushHistory(name) {
  if (an.history[an.history.length - 1] === name) return;
  an.history.push(name);
  if (an.history.length > 24) an.history.shift();
  renderHistory();
}
function renderHistory() {
  $('anHistory').replaceChildren(...an.history.map((h) => Object.assign(document.createElement('span'), { textContent: h })));
  $('anHistory').scrollLeft = 1e6;
}

function drawSpectrum(notes) {
  const c = $('spectrum'), g = c.getContext('2d');
  const W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  if (!poly) return;
  const fLo = 30, fHi = 5000;
  const xOf = (f) => (Math.log(f / fLo) / Math.log(fHi / fLo)) * W;
  // grid at each C and E
  g.font = '11px system-ui';
  for (let m = 24; m <= 108; m++) {
    if (m % 12 !== 0) continue;
    const x = xOf(midiToFreq(m, settings.a4));
    g.strokeStyle = '#232833';
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
    g.fillStyle = '#5a6170';
    g.fillText(noteName(m), x + 3, H - 4);
  }
  const mag = poly.mag;
  let max = 1e-9;
  for (let k = 1; k < mag.length; k++) if (mag[k] > max) max = mag[k];
  g.beginPath();
  g.moveTo(0, H);
  let lastX = -1;
  for (let k = Math.floor(fLo / poly.binHz); k < Math.min(mag.length, fHi / poly.binHz); k++) {
    const x = xOf(k * poly.binHz);
    if (x - lastX < 0.6) continue;
    lastX = x;
    const db = 40 * Math.log10(mag[k] / max + 1e-9); // mag is |X|^0.5
    g.lineTo(x, H - 16 - Math.max(0, (db + 70) / 70) * (H - 26));
  }
  g.lineTo(W, H);
  g.fillStyle = 'rgba(106,168,255,0.25)';
  g.strokeStyle = '#6aa8ff';
  g.fill();
  g.stroke();
  for (const n of notes) {
    const x = xOf(n.freq);
    g.strokeStyle = '#5ad1a6';
    g.beginPath(); g.moveTo(x, 14); g.lineTo(x, H - 16); g.stroke();
    g.fillStyle = '#5ad1a6';
    g.fillText(noteName(n.midi), x + 3, 12);
  }
}

// ---------------------------------------------------------------- keys
function onKey(e) {
  if (e.target.matches?.('input[type=number], select') || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  if (e.key === '1' || e.key === '2' || e.key === '3') showTab(['tuner', 'analyzer', 'looper'][Number(e.key) - 1]);
  else if (!station.onKey(e)) return;
  e.preventDefault();
}

// ---------------------------------------------------------------- main loop
// A live interface always has some noise; exact digital zeros mean the device isn't streaming.
const dead = { lastSignal: 0, warned: false };
function checkDeadInput(buf, now) {
  if (!dead.lastSignal) dead.lastSignal = now;
  for (let i = buf.length - 2048; i < buf.length; i++) {
    if (buf[i] !== 0) { dead.lastSignal = now; if (dead.warned) { dead.warned = false; $('banner').classList.add('hidden'); } return; }
  }
  if (pendingOpen) { dead.lastSignal = now; return; } // a device switch is in progress
  if (!dead.warned && now - dead.lastSignal > 3000 && audio.ctx.state === 'running') {
    dead.warned = true;
    banner('The input delivers pure digital silence, so the device is not streaming. On Linux, run ' +
      '<code>journalctl -k | grep usb_set_interface</code>: errors there mean the USB port can\'t run the iRig HD\'s audio stream. ' +
      'Unplug and replug it, preferably through a USB&nbsp;2.0 hub or into another port, then press <b>Restart audio</b>.', true);
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  if (audio.analyser && audio.stream) {
    audio.analyser.getFloatTimeDomainData(audio.buf);
    checkDeadInput(audio.buf, now);
    trackNoiseFloor(audio.buf, now);
    updateMeter(audio.buf, now);
    if (settings.tab === 'tuner') updateTuner(audio.buf, now);
    else if (settings.tab === 'analyzer') updateAnalyzer(audio.buf, now);
  } else if (settings.tab === 'tuner') {
    drawTuner(now);
  }
  if (settings.tab === 'looper' && audio.ctx) station.frame(now);
}

setupControls();
requestAnimationFrame(frame);
globalThis.irigLab = { audio, settings, noise }; // for debugging from the browser console

// Keep Space for the looper: don't leave clicked controls focused (Space would re-trigger them)
document.addEventListener('pointerup', () => setTimeout(() => {
  const a = document.activeElement;
  if (a && a.matches('button, input[type=checkbox], input[type=range]')) a.blur();
}));
// Browsers may start the context suspended until a user gesture
for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, () => audio.ctx?.state === 'suspended' && audio.ctx.resume());

// Auto-start if permission was granted before (no prompt needed)
navigator.permissions?.query({ name: 'microphone' }).then((p) => { if (p.state === 'granted') startAudio(); }).catch(() => {});
