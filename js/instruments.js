// Tunings as MIDI note numbers, lowest string first.
export const INSTRUMENTS = [
  { id: 'gtr-std', group: 'Guitar', name: 'Standard  E A D G B E', tuning: [40, 45, 50, 55, 59, 64], frets: 22 },
  { id: 'gtr-dropd', group: 'Guitar', name: 'Drop D  D A D G B E', tuning: [38, 45, 50, 55, 59, 64], frets: 22 },
  { id: 'gtr-eb', group: 'Guitar', name: 'E♭ standard  E♭ A♭ D♭ G♭ B♭ E♭', tuning: [39, 44, 49, 54, 58, 63], frets: 22 },
  { id: 'gtr-d', group: 'Guitar', name: 'D standard  D G C F A D', tuning: [38, 43, 48, 53, 57, 62], frets: 22 },
  { id: 'gtr-dropc', group: 'Guitar', name: 'Drop C  C G C F A D', tuning: [36, 43, 48, 53, 57, 62], frets: 22 },
  { id: 'gtr-dadgad', group: 'Guitar', name: 'DADGAD  D A D G A D', tuning: [38, 45, 50, 55, 57, 62], frets: 22 },
  { id: 'gtr-openg', group: 'Guitar', name: 'Open G  D G D G B D', tuning: [38, 43, 50, 55, 59, 62], frets: 22 },
  { id: 'gtr-opend', group: 'Guitar', name: 'Open D  D A D F# A D', tuning: [38, 45, 50, 54, 57, 62], frets: 22 },
  { id: 'gtr-7', group: 'Guitar', name: '7-string  B E A D G B E', tuning: [35, 40, 45, 50, 55, 59, 64], frets: 24 },
  { id: 'bass-4', group: 'Bass', name: '4-string  E A D G', tuning: [28, 33, 38, 43], frets: 24 },
  { id: 'bass-dropd', group: 'Bass', name: '4-string drop D  D A D G', tuning: [26, 33, 38, 43], frets: 24 },
  { id: 'bass-5', group: 'Bass', name: '5-string  B E A D G', tuning: [23, 28, 33, 38, 43], frets: 24 },
  { id: 'bass-6', group: 'Bass', name: '6-string  B E A D G C', tuning: [23, 28, 33, 38, 43, 48], frets: 24 },
];

export const isBass = (inst) => inst.group === 'Bass';
