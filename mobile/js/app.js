import { PitchDetector, PolyDetector, nameChord, findFingerings, findOnset, positionsFor, freqToMidi, midiToFreq, noteName, NOTE_NAMES, pc, rmsOf } from './dsp.js';
import { INSTRUMENTS, isBass } from './instruments.js';
import { renderChordBox, renderNeck } from './fretboard.js';
import { createStation, fitCanvas } from './station.js';

const $ = (id) => document.getElementById(id);
const GATE = 0.0025; // RMS below this is always treated as silence
const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// Phone microphones pick up room noise, so the silence gate follows the input's noise floor:
// the quietest level of the last 8 seconds (minimum per half-second bucket).
const noise = { floor: 0, buckets: [], bucketStart: 0 };
function trackNoiseFloor(buf, now) {
  const r = rmsOf(buf, 2048);
  if (r <= 0) return;
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
    deviceId: '', channel: 'mix', gain: 0, aec: false, monitor: false, monitorVol: 0.6, instrument: 'gtr-std', a4: 440, tab: 'tuner', anMode: 'auto', sens: 0.22,
    loopVol: 1, latOffset: 0, latMeasured: null, bpm: 100, rhythm: 'click-4', metronome: false, metroVol: 0.7, countIn: true, quantize: 'bar', recBars: 0,
    trackGains: [1, 1, 1], devices: {}, wake: true,
  },
  load()
);
function load() { try { return JSON.parse(localStorage.getItem('irig-lab-mobile') || '{}'); } catch { return {}; } }
function save() { try { localStorage.setItem('irig-lab-mobile', JSON.stringify(settings)); } catch { /* storage unavailable */ } }

const station = createStation({
  settings, save, banner,
  canCalibrate: () => (settings.aec ? 'Turn off <b>Echo cancellation</b> while measuring: it would erase the clicks.' : null),
});
const inst = () => INSTRUMENTS.find((i) => i.id === settings.instrument) || INSTRUMENTS[0];

// ---------------------------------------------------------------- audio
const audio = { ctx: null, stream: null, source: null, splitter: null, input: null, analyser: null, monitor: null, buf: null, devices: [], ready: null };
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
  // Phone calls, Siri and app switches interrupt audio; offer a one-tap resume
  ctx.onstatechange = () => {
    if (ctx.state !== 'running' && document.visibilityState === 'visible') banner('Audio was paused by the system. <button id="resume">Resume</button>', true);
    else if (ctx.state === 'running' && $('resume')) hideBanner();
    $('resume')?.addEventListener('click', resumeAudio);
  };
  applyGain(); applyMonitor();
}

let startGen = 0;
let pendingOpen = null;

// Opens the selected input. Safe to call again while running: only the latest call wins,
// and the current input keeps working until the new one is open.
async function startAudio() {
  const gen = ++startGen;
  if (!audio.devices.length) await listDevices();
  const target = settings.deviceId;
  const opening = deviceInfo(target).name;
  banner(pendingOpen ? `Waiting for <b>${esc(pendingOpen)}</b> before opening <b>${esc(opening)}</b>…` : `Opening <b>${esc(opening)}</b>…`);
  const slow = setTimeout(() => { if (gen === startGen) banner(`<b>${esc(opening)}</b> isn't responding yet…`, true); }, 3000);
  pendingOpen ??= opening;
  try {
    // iOS: record and play at the same time (Safari 16.4+)
    if (navigator.audioSession) navigator.audioSession.type = 'play-and-record';
    audio.ready ??= buildGraph();
    await audio.ready;
    await audio.ctx.resume();
    const constraints = { echoCancellation: settings.aec, noiseSuppression: false, autoGainControl: false };
    if (target && target !== 'default') constraints.deviceId = { exact: target };
    let missing = false, stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
    } catch (err) {
      if (err.name !== 'OverconstrainedError' && err.name !== 'NotFoundError') throw err;
      delete constraints.deviceId; // the saved device isn't connected
      missing = true;
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
    } finally {
      if (pendingOpen === opening) pendingOpen = null;
    }
    if (gen !== startGen) { stream.getTracks().forEach((t) => t.stop()); return; }
    audio.stream?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    audio.stream = stream;
    await listDevices();
    if (gen !== startGen) return;

    const track = stream.getAudioTracks()[0];
    track.onended = () => banner(`<b>${esc(track.label || 'The microphone')}</b> was disconnected. Pick another input in <a href="#" data-goto="settings">Settings</a>.`, true);
    applyDeviceProfile(currentDeviceId());
    connectSource();
    noise.floor = 0; noise.buckets = [];
    dead.lastSignal = 0; dead.warned = false;
    station.updateLatency(stream);
    setTimeout(() => station.updateLatency(stream), 1500);
    $('startOverlay').classList.add('hidden');
    keepAwake();
    const info = deviceInfo(currentDeviceId(), track.label);
    renderInput(info);
    const tips = info.kind === 'bluetooth'
      ? ' Bluetooth mics add delay and sound like a phone call; measure the latency in Settings before looping.'
      : '';
    if (missing) banner(`The saved input isn't connected, so <b>${esc(info.name)}</b> is used.${tips}`);
    else if (tips) banner(`Listening on <b>${esc(info.name)}</b>.${tips}`);
    else hideBanner();
  } catch (err) {
    if (gen !== startGen) return;
    const why = err.name === 'NotAllowedError' ? (IOS ? 'microphone access is off. Allow it in Settings › Safari › Microphone (or for this web app), then reload.' : 'microphone access was denied. Allow it in the browser\'s site settings, then reload.')
      : err.name === 'NotReadableError' ? 'the microphone is busy (another app, or a call?) or not working'
      : err.name === 'NotFoundError' ? 'no microphone was found'
      : err.message || err.name;
    if (audio.stream && err.name !== 'NotAllowedError') {
      settings.deviceId = currentDeviceId();
      save();
      await listDevices();
      banner(`Couldn't open <b>${esc(opening)}</b>: ${esc(why)}. Still using <b>${esc(deviceInfo(currentDeviceId()).name)}</b>.`, true);
    } else {
      banner(`Couldn't start the microphone: ${esc(why)}`, true);
    }
  } finally {
    clearTimeout(slow);
  }
}

async function resumeAudio() {
  await audio.ctx?.resume();
  if (audio.stream?.getAudioTracks()[0]?.readyState !== 'live') startAudio();
  else hideBanner();
  keepAwake();
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

// ---------------------------------------------------------------- inputs
// What kind of microphone a label describes. Labels differ per platform: Android says things
// like "Speakerphone", "Headset earpiece", "USB audio"; iOS "iPhone Microphone", "AirPods".
function deviceInfo(id, label) {
  const d = audio.devices.find((x) => x.deviceId === id);
  const l = label || d?.label || '';
  const name = l || (id && id !== 'default' ? 'Selected microphone' : 'Phone microphone');
  if (/irig|interface|guitar|instrument|hi-?z|focusrite|scarlett|presonus|behringer|umc\d|steinberg|motu|tascam/i.test(l)) return { name, kind: 'instrument', icon: '🎸', type: 'Instrument interface' };
  if (/bluetooth|airpods|buds|\bbt\b|hands-?free|hfp|jabra|beats|bose/i.test(l)) return { name, kind: 'bluetooth', icon: '🎧', type: 'Bluetooth' };
  if (/usb|uac|otg|lightning|rode|yeti|shure|samson|fifine|maono/i.test(l)) return { name, kind: 'usb', icon: '🔌', type: 'USB microphone' };
  if (/headset|headphone|wired|earpiece|line ?in|external|3\.5/i.test(l)) return { name, kind: 'headset', icon: '🎧', type: 'Wired headset' };
  if (!l || id === 'default' || /built-?in|internal|iphone|ipad|phone|speakerphone|bottom|front|back|top/i.test(l)) return { name, kind: 'builtin', icon: '📱', type: id === 'default' ? 'System default' : 'Built-in microphone' };
  return { name, kind: 'mic', icon: '🎙️', type: 'Microphone' };
}

async function listDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  audio.devices = devices;
  renderDeviceList();
  return devices;
}

function renderDeviceList() {
  const list = $('deviceList');
  const labelled = audio.devices.some((d) => d.label);
  if (!labelled) {
    list.innerHTML = '<p class="note">Microphones are listed once the app is started.</p>';
    return;
  }
  const current = audio.stream ? currentDeviceId() : settings.deviceId;
  list.replaceChildren(...audio.devices.map((d) => {
    const info = deviceInfo(d.deviceId);
    const b = document.createElement('button');
    b.className = 'device' + (d.deviceId === current ? ' active' : '');
    b.innerHTML = `<span class="dicon">${info.icon}</span><span><span class="dname"></span><span class="dtype"></span></span><span class="dcheck">${d.deviceId === current ? '✓' : ''}</span>`;
    b.querySelector('.dname').textContent = info.name;
    b.querySelector('.dtype').textContent = info.type;
    b.onclick = () => { if (d.deviceId !== current) switchDevice(d.deviceId); };
    return b;
  }));
}

function renderInput(info) {
  $('inputIcon').textContent = info.icon;
  $('inputName').textContent = info.name;
  // Through the speaker, the built-in mic hears the loops being played back
  $('echoHint').classList.toggle('hidden', !(info.kind === 'builtin' && !settings.aec) || settings.echoHintSeen);
}

async function switchDevice(id) {
  saveDeviceProfile();
  settings.deviceId = id;
  save();
  await startAudio();
}

// Gain and channel are remembered per input
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

// Hot-plugging: USB-C/OTG, headsets and Bluetooth come and go
async function onDeviceChange() {
  const before = new Set(audio.devices.map((d) => d.deviceId));
  const devices = await listDevices();
  if (!audio.stream) return;
  const track = audio.stream.getAudioTracks()[0];
  if (track?.readyState === 'ended' || (!devices.some((d) => d.deviceId === currentDeviceId()) && devices.length)) {
    banner('The microphone in use was disconnected. <button id="useDefault">Use the phone mic</button>', true);
    $('useDefault').onclick = () => switchDevice('default');
    return;
  }
  const added = devices.find((d) => !before.has(d.deviceId) && d.deviceId !== 'default' && d.label);
  if (added && before.size) {
    const info = deviceInfo(added.deviceId);
    banner(`${info.icon} <b>${esc(info.name)}</b> connected. <button id="useNew">Use it</button>`);
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

// Screen wake lock, re-taken when the app comes back to the foreground
let wakeLock = null;
async function keepAwake() {
  if (!settings.wake || !audio.stream || !('wakeLock' in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* not allowed right now */ }
}

// ----------------------------------------------------------------- UI basics
function banner(html, error = false) {
  const b = $('banner');
  b.innerHTML = html;
  b.classList.toggle('error', error);
  b.classList.remove('hidden');
}
function hideBanner() { $('banner').classList.add('hidden'); }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fillInstruments(sel) {
  for (const group of ['Guitar', 'Bass']) {
    const og = document.createElement('optgroup');
    og.label = group;
    for (const i of INSTRUMENTS.filter((x) => x.group === group)) og.appendChild(new Option(`${group === 'Bass' ? 'Bass ' : ''}${i.name.replace(/\s{2,}/g, ' · ')}`, i.id));
    sel.appendChild(og);
  }
  sel.value = settings.instrument;
  sel.onchange = () => {
    settings.instrument = sel.value;
    $('instrument').value = $('instrument2').value = sel.value;
    save();
    onInstrumentChange();
  };
}

function setupControls() {
  fillInstruments($('instrument'));
  fillInstruments($('instrument2'));

  $('start').onclick = startAudio;
  $('inputChip').onclick = () => showTab('settings');
  $('echoHintClose').onclick = () => { settings.echoHintSeen = true; save(); $('echoHint').classList.add('hidden'); };
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-goto]');
    if (go) { e.preventDefault(); showTab(go.dataset.goto); }
  });
  navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);
  $('iosNote').classList.toggle('hidden', !IOS);

  $('channel').value = settings.channel;
  $('channel').onchange = () => { settings.channel = $('channel').value; saveDeviceProfile(); if (audio.stream) connectSource(); };
  $('gain').value = settings.gain;
  $('gain').oninput = () => { settings.gain = Number($('gain').value); saveDeviceProfile(); applyGain(); };
  applyGain();
  $('aec').checked = settings.aec;
  $('aec').onchange = () => { settings.aec = $('aec').checked; save(); if (audio.stream) startAudio(); };
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
  $('wake').checked = settings.wake;
  $('wake').onchange = () => {
    settings.wake = $('wake').checked;
    save();
    if (settings.wake) keepAwake(); else wakeLock?.release();
  };

  for (const b of document.querySelectorAll('.tabbar button')) b.onclick = () => showTab(b.dataset.tab);
  showTab(['tuner', 'chords', 'loops', 'settings'].includes(settings.tab) ? settings.tab : 'tuner');

  for (const b of document.querySelectorAll('#anMode button')) b.onclick = () => { settings.anMode = b.dataset.mode; save(); syncSeg(); };
  syncSeg();
  $('sens').value = settings.sens;
  $('sens').oninput = () => { settings.sens = Number($('sens').value); save(); };
  $('vPrev').onclick = () => cycleVoicing(-1);
  $('vNext').onclick = () => cycleVoicing(1);
  $('anHistClear').onclick = () => { an.history = []; renderHistory(); };

  station.setup();
  setupInstall();
  document.addEventListener('keydown', onKey);
  onInstrumentChange();
  listDevices();
}

function syncSeg() {
  for (const b of document.querySelectorAll('#anMode button')) b.classList.toggle('active', b.dataset.mode === settings.anMode);
}

function showTab(tab) {
  settings.tab = tab;
  save();
  for (const b of document.querySelectorAll('.tabbar button')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const s of document.querySelectorAll('.tab')) s.classList.toggle('active', s.id === `tab-${tab}`);
  if (tab === 'settings') { listDevices(); station.renderLatency(); }
  window.scrollTo(0, 0);
}

function onInstrumentChange() {
  tuner.lockedString = null;
  tuner.tuned.clear();
  const btns = $('stringBtns');
  btns.replaceChildren();
  inst().tuning.forEach((m, s) => {
    const b = document.createElement('button');
    b.className = 'string';
    b.textContent = noteName(m);
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

// "Add to Home Screen": Android offers a prompt; iOS needs the Share menu
function setupInstall() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) return;
  if (IOS) $('installNote').textContent = 'To install: tap Share, then “Add to Home Screen”. It then opens full-screen and works offline.';
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    $('install').classList.remove('hidden');
    $('install').onclick = async () => { e.prompt(); await e.userChoice; $('install').classList.add('hidden'); };
  });
}

// ---------------------------------------------------------------- level meter
const meter = { clipTime: 0 };
function updateMeter(buf, now) {
  let peak = 0;
  for (let i = buf.length - 2048; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
  const db = 20 * Math.log10(peak + 1e-9);
  $('meterFill').style.width = Math.max(0, Math.min(100, ((db + 60) / 60) * 100)) + '%';
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
  $('tFreq').textContent = hasNote ? tuner.freq.toFixed(1) : '–';
  $('tTarget').textContent = hasNote ? noteName(tuner.target) : '–';
  const hint = $('tHint');
  if (!fresh) hint.textContent = audio.stream ? 'Play a single string…' : '';
  else if (abs < 3) hint.textContent = '✓ In tune';
  else if (abs > 50) hint.textContent = `${(abs / 100).toFixed(1)} semitones ${cents > 0 ? 'sharp ↓' : 'flat ↑'}`;
  else hint.textContent = cents > 0 ? 'Sharp: tune down ↓' : 'Flat: tune up ↑';
  hint.classList.toggle('go', fresh && abs < 3);
  syncStringButtons();
  drawGauge(fresh);
  drawHistory(now);
}

function drawGauge(fresh) {
  const { g, W, H } = fitCanvas($('gauge'));
  const cx = W / 2, cy = H - 16, R = Math.max(40, Math.min(W / 2 - 34, H - 58));
  g.clearRect(0, 0, W, H);
  const ang = (cents) => -Math.PI / 2 + (cents / 50) * (Math.PI / 3);
  const arc = (from, to, color, width) => { g.beginPath(); g.arc(cx, cy, R, ang(from), ang(to)); g.strokeStyle = color; g.lineWidth = width; g.stroke(); };
  arc(-50, 50, '#232833', 16);
  arc(-10, 10, '#3d3a22', 16);
  arc(-3, 3, '#1f5a46', 16);
  g.fillStyle = '#8b93a3';
  g.font = '12px system-ui';
  g.textAlign = 'center';
  for (let t = -50; t <= 50; t += 5) {
    const a = ang(t), major = t % 10 === 0;
    const r1 = R + 12, r2 = R + (major ? 24 : 18);
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    g.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
    g.strokeStyle = major ? '#8b93a3' : '#4a5160';
    g.lineWidth = major ? 2 : 1;
    g.stroke();
    if (major) g.fillText((t > 0 ? '+' : '') + t, cx + Math.cos(a) * (R + 36), cy + Math.sin(a) * (R + 36) + 4);
  }
  const a = ang(tuner.shownCents);
  const abs = Math.abs(tuner.cents);
  g.strokeStyle = !fresh ? '#3a404d' : abs < 3 ? '#5ad1a6' : abs < 10 ? '#f2c14e' : '#ef5b5b';
  g.lineWidth = 5;
  g.lineCap = 'round';
  g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * (R + 6), cy + Math.sin(a) * (R + 6)); g.stroke();
  g.fillStyle = g.strokeStyle;
  g.beginPath(); g.arc(cx, cy, 9, 0, Math.PI * 2); g.fill();
}

function drawHistory(now) {
  const { g, W, H } = fitCanvas($('history'));
  const span = 6000;
  tuner.history = tuner.history.filter((p) => now - p.t < span);
  g.clearRect(0, 0, W, H);
  g.fillStyle = 'rgba(90,209,166,0.1)';
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
}

// ---------------------------------------------------------------- chords
const an = { votes: new Map(), notes: [], key: '', keySince: 0, label: '', loggedKey: '', voicings: [], vIndex: 0, lastPoly: 0, lastSound: 0, lastOnset: -Infinity, history: [], mono: null, display: null };
const anUnionSet = new Set();

function updateAnalyzer(buf, now) {
  const tuning = inst().tuning;
  const minMidi = Math.min(...tuning) - 1;
  const maxMidi = Math.min(96, Math.max(...tuning) + inst().frets);
  const sounding = rmsOf(buf, 4096) > gate();
  if (sounding) an.lastSound = now;
  an.mono = sounding ? detectMono(buf) : null;

  if (now - an.lastPoly > 110) {
    an.lastPoly = now;
    // Analyse only what was played after the latest pick attack
    const sr = audio.ctx.sampleRate;
    const onset = findOnset(buf, { gate: gate() });
    let length = poly.size, fresh = false;
    if (onset >= 0) {
      length = buf.length - onset - Math.round(sr * 0.03);
      const at = audio.ctx.currentTime * sr - (buf.length - onset);
      if (length < sr * 0.2) return renderAnalyzer(false, now);
      if (at - an.lastOnset > 4096) { an.lastOnset = at; an.votes.clear(); fresh = true; }
    }
    const notes = sounding ? poly.analyze(buf, { minMidi, maxMidi, a4: settings.a4, relThreshold: settings.sens, gate: gate(), length }) : [];
    const present = new Map(notes.map((n) => [n.midi, n]));
    anUnionSet.clear();
    for (const k of an.votes.keys()) anUnionSet.add(k);
    for (const k of present.keys()) anUnionSet.add(k);
    for (const m of anUnionSet) {
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
  if (mode === 'chord' || (mode === 'auto' && pcs.size >= 2)) return an.notes.length ? { kind: 'chord', notes: an.notes } : null;
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
    $('anBoardTitle').textContent = 'Fretboard';
    $('vPrev').disabled = $('vNext').disabled = true;
    an.key = '';
    renderChordBox($('fretboard'), { tuning });
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
    $('anBoardTitle').textContent = `Where ${noteName(d.midi)} is`;
    $('vLabel').textContent = '';
    $('vPrev').disabled = $('vNext').disabled = true;
    renderNeck($('fretboard'), { tuning, maxFret: inst().frets, markers: pos.map((p) => ({ ...p, kind: 'root', label: NOTE_NAMES[pc(d.midi)] })) });
    $('anPositions').innerHTML = pos.map((p) => `<b>${stringLabel(p.string)}</b> fret ${p.fret}`).join(' · ') || 'Out of range for this instrument';
    return;
  }

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
  $('anAlt').innerHTML = cands.length > 1 ? 'or ' + cands.slice(1).map((c) => `<b>${esc(c.name)}</b>`).join('') : '';
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

function fingeringsWithFallback(midis, tuning) {
  let opts = findFingerings(midis, tuning, inst().frets);
  if (opts.length || midis.length < 3) return opts;
  for (let i = midis.length - 1; i >= 0 && !opts.length; i--) opts = findFingerings(midis.filter((_, j) => j !== i), tuning, inst().frets);
  return opts;
}

function drawVoicing() {
  const tuning = inst().tuning;
  const v = an.voicings[an.vIndex];
  $('vPrev').disabled = an.vIndex <= 0;
  $('vNext').disabled = an.vIndex >= an.voicings.length - 1;
  if (!v) {
    $('anBoardTitle').textContent = 'No playable shape found';
    $('vLabel').textContent = '';
    renderChordBox($('fretboard'), { tuning });
    $('anPositions').textContent = '';
    return;
  }
  $('anBoardTitle').textContent = 'Strings & frets';
  $('vLabel').textContent = `${an.vIndex + 1}/${an.voicings.length}`;
  const frets = completeVoicing(v.frets);
  const markers = [], muted = [];
  frets.forEach((f, s) => {
    if (f === null) return muted.push(s);
    const kind = v.frets[s] === null ? 'inferred' : pc(tuning[s] + f) === an.rootPc ? 'root' : 'note';
    markers.push({ string: s, fret: f, kind, label: NOTE_NAMES[pc(tuning[s] + f)] });
  });
  renderChordBox($('fretboard'), { tuning, markers, muted });
  const tab = frets.map((f) => (f === null ? 'x' : f)).join(frets.some((f) => f > 9) ? '-' : '');
  const inferred = frets.some((f, s) => f !== null && v.frets[s] === null);
  $('anPositions').innerHTML = `Shape <b>${tab}</b> (low → high)` +
    (inferred ? '<br><small>Dashed dots: octave doublings inferred from the shape.</small>' : '');
}

// Octave doublings hide in lower notes' overtones; fill them in when the shape and spectrum agree
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
      if (f > 0 && Math.max(hi, f) - Math.min(lo, f) > 4) continue;
      const level = poly.levelAt(midiToFreq(tuning[s] + f, settings.a4));
      if (level >= 0.35 && (best === null || Math.abs(f - lo) < Math.abs(best - lo))) best = f;
    }
    if (best !== null) out[s] = best;
  }
  return out;
}

function cycleVoicing(dir) {
  an.vIndex = Math.max(0, Math.min(an.voicings.length - 1, an.vIndex + dir));
  drawVoicing();
}

// Swipe left/right on the chord box to change voicing
{
  let x0 = null;
  const fb = () => $('fretboard');
  document.addEventListener('pointerdown', (e) => { x0 = fb().contains(e.target) ? e.clientX : null; });
  document.addEventListener('pointerup', (e) => {
    if (x0 === null) return;
    const dx = e.clientX - x0;
    x0 = null;
    if (Math.abs(dx) > 40 && an.voicings.length > 1) cycleVoicing(dx < 0 ? 1 : -1);
  });
}

function stringLabel(s) {
  const t = inst().tuning;
  return `${t.length - s}·${NOTE_NAMES[pc(t[s])]}`;
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
  const { g, W, H } = fitCanvas($('spectrum'));
  g.clearRect(0, 0, W, H);
  if (!poly) return;
  const fLo = 40, fHi = 4000;
  const xOf = (f) => (Math.log(f / fLo) / Math.log(fHi / fLo)) * W;
  g.font = '10px system-ui';
  for (let m = 36; m <= 96; m += 12) {
    const x = xOf(midiToFreq(m, settings.a4));
    g.strokeStyle = '#232833';
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
    g.fillStyle = '#5a6170';
    g.fillText(noteName(m), x + 2, H - 3);
  }
  const mag = poly.mag;
  let max = 1e-9;
  for (let k = 1; k < mag.length; k++) if (mag[k] > max) max = mag[k];
  g.beginPath();
  g.moveTo(0, H);
  let lastX = -1;
  for (let k = Math.floor(fLo / poly.binHz); k < Math.min(mag.length, fHi / poly.binHz); k++) {
    const x = xOf(k * poly.binHz);
    if (x - lastX < 0.75) continue;
    lastX = x;
    const db = 40 * Math.log10(mag[k] / max + 1e-9);
    g.lineTo(x, H - 13 - Math.max(0, (db + 70) / 70) * (H - 22));
  }
  g.lineTo(W, H);
  g.fillStyle = 'rgba(106,168,255,0.25)';
  g.strokeStyle = '#6aa8ff';
  g.fill();
  g.stroke();
  g.fillStyle = '#5ad1a6';
  g.strokeStyle = '#5ad1a6';
  for (const n of notes) {
    const x = xOf(n.freq);
    g.beginPath(); g.moveTo(x, 12); g.lineTo(x, H - 13); g.stroke();
    g.fillText(noteName(n.midi), x + 2, 10);
  }
}

// ---------------------------------------------------------------- keys (keyboards, Bluetooth pedals)
function onKey(e) {
  if (e.target.matches?.('input[type=number], select') || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  if (!station.onKey(e)) return;
  e.preventDefault();
}

// ---------------------------------------------------------------- main loop
// A live microphone always has some noise; exact digital zeros mean it isn't delivering audio
const dead = { lastSignal: 0, warned: false };
function checkDeadInput(buf, now) {
  if (!dead.lastSignal) dead.lastSignal = now;
  for (let i = buf.length - 2048; i < buf.length; i++) {
    if (buf[i] !== 0) { dead.lastSignal = now; if (dead.warned) { dead.warned = false; hideBanner(); } return; }
  }
  if (pendingOpen) { dead.lastSignal = now; return; }
  if (!dead.warned && now - dead.lastSignal > 3000 && audio.ctx.state === 'running') {
    dead.warned = true;
    banner('The microphone delivers silence. Another app (or a call) may be using it, or the device stopped. <button id="reopen">Reopen</button>', true);
    $('reopen').onclick = startAudio;
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  if (document.hidden) return;
  if (audio.analyser && audio.stream) {
    audio.analyser.getFloatTimeDomainData(audio.buf);
    checkDeadInput(audio.buf, now);
    trackNoiseFloor(audio.buf, now);
    updateMeter(audio.buf, now);
    if (settings.tab === 'tuner') updateTuner(audio.buf, now);
    else if (settings.tab === 'chords') updateAnalyzer(audio.buf, now);
  } else if (settings.tab === 'tuner') {
    drawTuner(now);
  }
  if (settings.tab === 'loops' && audio.ctx) station.frame(now);
}

// Back from the background: resume audio and the wake lock
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && audio.ctx) resumeAudio();
});
// Some browsers keep the context suspended until a touch
document.addEventListener('pointerdown', () => { if (audio.ctx && audio.ctx.state !== 'running') audio.ctx.resume(); });

setupControls();
requestAnimationFrame(frame);
globalThis.irigLab = { audio, settings, noise };

// Offline support, and the cross-origin isolation headers that enable shared loop buffers
// on hosts that can't send them (GitHub Pages): the service worker adds them.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(() => {
    if (!crossOriginIsolated && navigator.serviceWorker.controller === null && !sessionStorage.getItem('sw-reloaded')) {
      // First visit: reload once so the page is served through the worker
      navigator.serviceWorker.ready.then(() => { sessionStorage.setItem('sw-reloaded', '1'); location.reload(); });
    }
  }).catch(() => {});
}
