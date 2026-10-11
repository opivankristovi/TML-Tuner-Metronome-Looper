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

// markers: [{string, fret, label, kind: 'root'|'note'|'alt'}]; muted: [string indices]
export function renderFretboard(svg, { tuning, maxFret, markers = [], muted = [], minFrets = 12 }) {
  const highest = markers.reduce((m, k) => Math.max(m, k.fret), 0);
  const frets = Math.min(maxFret, Math.max(minFrets, highest + 2));
  const n = tuning.length;
  const left = 46, top = 22, gap = 26, fw = 52;
  const width = left + 20 + frets * fw;
  const height = top * 2 + (n - 1) * gap + 14;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.replaceChildren();
  const yOf = (s) => top + (n - 1 - s) * gap; // highest string on top
  const xOf = (f) => (f === 0 ? left - 16 : left + (f - 0.5) * fw);
  const bottom = yOf(0);

  el('rect', { x: left, y: top - 8, width: frets * fw, height: bottom - top + 16, class: 'fb-wood', rx: 3 }, svg);
  for (const f of INLAYS) if (f <= frets) el('circle', { cx: xOf(f), cy: (top + bottom) / 2, r: 5, class: 'fb-inlay' }, svg);
  if (frets >= 12) {
    el('circle', { cx: xOf(12), cy: top + gap * 0.9, r: 5, class: 'fb-inlay' }, svg);
    el('circle', { cx: xOf(12), cy: bottom - gap * 0.9, r: 5, class: 'fb-inlay' }, svg);
  }
  for (let f = 0; f <= frets; f++) {
    const x = left + f * fw;
    el('line', { x1: x, x2: x, y1: top - 8, y2: bottom + 8, class: f === 0 ? 'fb-nut' : 'fb-fret' }, svg);
    if (f > 0) el('text', { x: xOf(f), y: bottom + 24, class: 'fb-fretnum' }, svg, f);
  }
  tuning.forEach((open, s) => {
    const y = yOf(s);
    el('line', { x1: left, x2: left + frets * fw, y1: y, y2: y, class: 'fb-string', 'stroke-width': 0.8 + (n - 1 - s) * 0.4 }, svg);
    el('text', { x: 10, y: y + 4, class: 'fb-tuning' }, svg, NOTE_NAMES[open % 12]);
  });
  for (const s of muted) el('text', { x: left - 16, y: yOf(s) + 5, class: 'fb-muted' }, svg, '×');
  for (const m of markers) {
    const g = el('g', { class: `fb-marker ${m.kind || 'note'}` }, svg);
    const x = xOf(m.fret), y = yOf(m.string);
    if (m.fret === 0) el('circle', { cx: x, cy: y, r: 9, class: 'open' }, g);
    else el('circle', { cx: x, cy: y, r: 10.5 }, g);
    if (m.label) el('text', { x, y: y + 4 }, g, m.label);
  }
}
