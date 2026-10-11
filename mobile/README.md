# iRig Lab Mobile

A phone and tablet fork of [iRig Lab](../README.md): the same tuner, chord finder and 3-track
loop station, rebuilt for touchscreens. It is an installable web app (PWA) that runs on
**iPhone/iPad (Safari)** and **Android (Chrome)** from one codebase, with no app store needed.

It works with any microphone the phone can use:

| Input | Notes |
|---|---|
| 📱 Built-in microphone | Fine for the tuner and chords. For overdubs, use headphones or turn on *Echo cancellation*, or the speaker leaks into the recording. |
| 🎧 Wired headset mic | Via the headphone jack or a USB-C/Lightning adapter. |
| 🔌 USB microphone / interface | Via USB-C (OTG) or the Lightning camera adapter, e.g. an iRig HD, a USB condenser mic or a Focusrite. |
| 🎧 Bluetooth headset mic | Works, but Bluetooth mics are phone-call quality (16 kHz) and add 150–300 ms of delay. Set the latency before looping. |

## Screens

- **Tuner**: a big note name and needle gauge, a cents/Hz readout, string buttons (tap one
  to lock the target), a drift graph, and 13 guitar and bass tunings.
- **Chords**: single notes and chords. Each chord is drawn as a **chord box** (strings top to
  bottom, as in chord books); swipe or use ‹ › to see other voicings. For a single note, the
  neck shows every place to play it.
- **Loops**: the 3-track loop station.
  - Big **Rec / Play / Dub** and **Stop** pads per track. They fire on *touch-down*, not release,
    so the timing follows your finger. Android also gives a short vibration.
  - Actions start on the next bar, with a BPM stepper, Tap tempo, a Click toggle and 19
    rhythms. Loops can be up to 90 s.
  - Export shares a track as WAV through the phone's share sheet (save to Files, send to an app).
- **Settings**:
  - **Input:** pick the input (hot-plugging is followed live), then gain, channel, echo
    cancellation and monitoring.
  - **Instrument:** the tuning and A4 reference.
  - **Loop timing:** latency calibration.
  - **App:** keep-screen-on and install.

A tap on the input chip at the top always leads to the input settings.

### Loop timing on phones

The delay from your playing to the speaker and back depends heavily on the device and the
connection. **Measure latency** (Settings › Loop timing) plays six clicks through the speaker
and listens with the current microphone on the same audio clock. A matched filter finds each
echo, and the median becomes the overdub offset. It needs the clicks to reach the microphone,
so turn the volume up and unplug headphones. With headphones or Bluetooth, use **Fine-tune**
by ear: record a few clicks along with the metronome and adjust until overdubs land on the beat.

## Run it on a phone

Phones only allow the microphone on **HTTPS** pages, so the app has to be served over HTTPS:

- **Hosted (recommended):** publish the `mobile/` folder on any static HTTPS host, e.g. GitHub
  Pages. Open the URL on the phone, tap **Tap to start**, and allow the microphone. Then install it:
  - *iPhone:* Share › **Add to Home Screen**.
  - *Android:* the **Install** button in Settings, or the browser menu › *Install app*.

  It then opens full-screen and works offline.
- **From this computer, over Wi-Fi:**
  ```bash
  python3 serve.py --https
  ```
  This prints `https://<computer IP>:8766`. Open that on the phone (same Wi-Fi) and accept the
  self-signed certificate warning once.
- **On this computer only:** `python3 serve.py`, then open `http://localhost:8766`.

The service worker (`sw.js`) caches the app for offline use. It also adds the cross-origin
isolation headers that static hosts can't send, so the loop station can share its buffers
between the audio thread and the UI (on the first visit the page reloads itself once to get them).

## Platform notes

- **iPhone:** iOS picks the microphone itself (the last one connected wins). The input list
  shows what's available, but iOS may ignore a choice that differs from its own. Audio pauses
  during calls and when the app is in the background; come back and it resumes (or tap
  **Resume**). Requires iOS 16.4 or newer.
- **Android:** the input list follows plug and unplug events. USB audio needs a phone with
  USB-C OTG (most phones from the last few years).
- **Bluetooth and USB foot pedals** that send key presses can drive the tracks: `Q W E` cycle
  tracks 1–3, `A S D` stop them, `Space` plays or stops all, `Z` undoes.

## Files

| File | What it does |
|---|---|
| `index.html`, `css/app.css` | Touch UI: tab bar, start screen, safe areas for notches |
| `js/app.js` | Audio, input picking, tuner, chord view, wake lock, interruptions, install |
| `js/station.js` | Loop station UI, share export, latency calibration flow |
| `js/station-worklet.js` | Loop engine (same as the desktop app) plus the calibration clicks |
| `js/calibrate.js` | Matched-filter latency measurement |
| `js/fretboard.js` | Portrait chord boxes and neck |
| `js/dsp.js`, `instruments.js`, `rhythms.js`, `wav.js` | Copied unchanged from the desktop app |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support, isolation headers, install metadata |
| `serve.py` | Dev server (HTTP or self-signed HTTPS for phones on the LAN) |

`npm test` runs the pitch/chord tests, the loop-engine tests and the calibration tests (the
calibration test simulates speaker → room → mic paths from 28 ms to 240 ms, with noise and hum).

This folder doesn't import anything from the desktop app, so it can be split into its own
repository at any time (`git subtree split --prefix mobile`).
