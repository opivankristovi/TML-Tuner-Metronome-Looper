# iRig Lab

Tuner, note/chord analyzer and looper for guitar or bass through an **IK Multimedia iRig HD**
(or any audio input). It runs in the browser with the Web Audio API and needs no build step
or dependencies.

## Run

```bash
./start.sh
```

The script switches the iRig HD's PipeWire profile to `pro-audio` (by default PipeWire leaves
it `off`, so it has no input). It then serves the folder on `http://localhost:8765` and opens
a Chromium app window. You can also serve the folder yourself with
`python3 -m http.server 8765` and open it in any Chromium or Firefox browser. It must be
`localhost`, because microphone access needs a secure origin.

The first time, press **Start audio** and allow microphone access. The app picks the iRig
automatically when it's listed.

## Features

**Tuner** (key `1`)
- Chromatic tuner using the McLeod Pitch Method, accurate to about ±1 cent, from B0 (5-string bass) to E6.
- Needle gauge, cents/Hz readout, a 6-second drift graph, and a ✓ on each string once it has held in tune.
- **Auto** targets the nearest note. Click a string button to lock the target to that string; useful when it's far out of tune.
- Presets: standard, drop D, E♭, D standard, drop C, DADGAD, open G/D, 7-string; 4/5/6-string bass and drop D bass.
- Adjustable A4 reference (415–466 Hz).

**Note & Chord** (key `2`)
- **Single note**: name, octave and cents, plus every place on the neck where that note can be played.
- **Chord**: polyphonic detection finds the individual notes, names the chord (major, minor,
  7ths, 6ths, sus, dim, aug, add9, 9ths, power chords, slash/inversions), and shows the
  most likely **strings and frets**. Use ‹ › to step through alternative voicings.
- Spectrum view with the detected notes marked, and a history strip of what you played.
- **Hold** keeps the last result on screen. **Sensitivity** sets how weak a note can be and
  still count (higher means stricter, with fewer false notes).

**Looper** (key `3`)
- `Space` cycles: Record → Play (closes the loop) → Overdub → Play …
- `S` stop · `Z` undo · `Shift+Z` redo · `Del` clear.
- Unlimited overdub layers, each with its own volume, mute, delete and WAV export. **Export WAV** saves the full mix.
- Overdubs are shifted by the measured round-trip latency so they line up with what you heard.
  If overdubs land late or early, nudge **Latency offset**.

**Input bar**: device, channel (Mix/Left/Right), software gain, a level meter with a clip
light, and **Monitor** to hear the input through the computer (this adds latency; most
players monitor through an amp or the iRig's headphone out instead).

## How it works

| File | What it does |
|---|---|
| `js/dsp.js` | FFT, MPM pitch detector, polyphonic detector (iterative harmonic salience with spectral-smoothness subtraction), onset detection, chord naming, fingering search |
| `js/looper-worklet.js` | Sample-accurate looper running on the audio thread |
| `js/app.js` | Audio graph, UI, analysis loop |
| `js/fretboard.js` | SVG fretboard |
| `js/instruments.js` | Tunings |
| `test/dsp.test.js` | Synthesised plucked-string tests: `npm test` |

How the chord analysis works:
1. After each pick attack it analyses only the audio from 30 ms after the attack, so the
   attack noise and the previous chord don't blur the result.
2. Octave doublings blend into the overtones of lower notes, so the chord view fills those
   strings in from the hand shape and draws them as dashed dots.

## Troubleshooting

- **"The input delivers pure digital silence"**: the device isn't streaming. Run
  `journalctl -k | grep usb_set_interface`. Errors such as `usb_set_interface failed (-71)` /
  `cannot set freq 48000 to ep 0x82` mean the USB port can't run the iRig HD's full-speed audio
  stream. Unplug and replug it, ideally through a USB 2.0 hub or into a different port, then
  press **Restart audio**.
- **No iRig in the Input list**: run `pactl list cards short` and check that the card exists,
  then `pactl set-card-profile alsa_card.usb-IK_Multimedia_iRig_HD-00 pro-audio`.
- **Level too low**: turn up the gain wheel on the iRig HD first. The software Gain slider comes after the converter.
