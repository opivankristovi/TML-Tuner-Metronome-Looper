// Portrait fretboard drawings: strings run top to bottom, lowest string on the left
// (the way chord charts are printed).
import { NOTE_NAMES } from './dsp.js';

const NS = 'http://www.w3.org/2000/svg';
const INLAYS = [3, 5, 7, 9, 15, 17, 19, 21];

function el(tag, attrs, parent, text) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  parent.appendChild(e);
  return e;
}

// Draws frets `first`..`last` (fret 0 = the nut area) with markers [{string, fret, label, kind}].
function draw(svg, { tuning, first, last, markers = [], muted = [], fretH = 34, showTuning = true }) {
  const n = tuning.length;
  const gap = n > 6 ? 30 : n > 4 ? 34 : 44;
  const left = 34, top = showTuning ? 46 : 30;
  const width = left + (n - 1) * gap + 30;
  const rows = last - first + 1;
  const height = top + rows * fretH + 14;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.replaceChildren();
  const xOf = (s) => left + s * gap;
  const yOf = (f) => (f === 0 && first === 0 ? top - 14 : top + (f - first + (first === 0 ? 0 : 1) - 0.5) * fretH);
  const right = xOf(n - 1);
  const boardTop = top, boardBottom = top + (first === 0 ? last : rows) * fretH;

  el('rect', { x: left - 8, y: boardTop, width: right - left + 16, height: boardBottom - boardTop, rx: 3, class: 'fb-wood' }, svg);
  const lo = first === 0 ? 1 : first;
  for (let f = lo; f <= last; f++) {
    const cy = yOf(f);
    if (INLAYS.includes(f)) el('circle', { cx: (left + right) / 2, cy, r: 5, class: 'fb-inlay' }, svg);
    if (f === 12) {
      el('circle', { cx: left + gap * 0.9, cy, r: 5, class: 'fb-inlay' }, svg);
      el('circle', { cx: right - gap * 0.9, cy, r: 5, class: 'fb-inlay' }, svg);
    }
    el('text', { x: left - 20, y: cy + 4, class: 'fb-fretnum' }, svg, f);
  }
  // nut or first-fret line, then frets
  el('line', { x1: left - 8, x2: right + 8, y1: boardTop, y2: boardTop, class: first === 0 ? 'fb-nut' : 'fb-fret' }, svg);
  for (let i = 1; i <= (first === 0 ? last : rows); i++) {
    const y = boardTop + i * fretH;
    el('line', { x1: left - 8, x2: right + 8, y1: y, y2: y, class: 'fb-fret' }, svg);
  }
  tuning.forEach((open, s) => {
    el('line', { x1: xOf(s), x2: xOf(s), y1: boardTop, y2: boardBottom, class: 'fb-string', 'stroke-width': 0.8 + (n - 1 - s) * 0.35 }, svg);
    if (showTuning) el('text', { x: xOf(s), y: 14, class: 'fb-tuning' }, svg, NOTE_NAMES[open % 12]);
  });
  for (const s of muted) el('text', { x: xOf(s), y: top - 9, class: 'fb-muted' }, svg, '×');
  for (const m of markers) {
    const g = el('g', { class: `fb-marker ${m.kind || 'note'}` }, svg);
    const x = xOf(m.string), y = m.fret === 0 ? top - 14 : yOf(m.fret);
    el('circle', { cx: x, cy: y, r: m.fret === 0 ? 9 : 12, class: m.fret === 0 ? 'open' : '' }, g);
    if (m.label) el('text', { x, y: y + 4 }, g, m.label);
  }
}

// Chord box: a 5-fret window around the shape (from the nut when it uses open strings)
export function renderChordBox(svg, { tuning, markers = [], muted = [] }) {
  const fretted = markers.filter((m) => m.fret > 0).map((m) => m.fret);
  const hi = fretted.length ? Math.max(...fretted) : 0;
  const lo = fretted.length ? Math.min(...fretted) : 1;
  const first = hi <= 5 ? 0 : lo;
  draw(svg, { tuning, first, last: first === 0 ? 5 : first + 4, markers, muted, fretH: 40 });
}

// The neck up to the 12th fret (for showing every place a note can be played; the
// pattern repeats above it)
export function renderNeck(svg, { tuning, maxFret, markers = [] }) {
  draw(svg, { tuning, first: 0, last: Math.min(maxFret, 12), markers: markers.filter((m) => m.fret <= 12), fretH: 22 });
}
