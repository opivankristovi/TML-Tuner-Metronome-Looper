// Metronome and drum patterns. `beats` = beats per bar (the BPM unit), `sub` = steps per beat.
// Voices: a accent click, c click, k kick, s snare, h closed hat, o open hat, r rim.
// Hits: X loud, x normal, - ghost, . rest. Each string has beats × sub steps.
export const RHYTHMS = [
  { id: 'click-4', group: 'Click', name: '4/4', beats: 4, sub: 1, p: { a: 'X...', c: '.xxx' } },
  { id: 'click-4-8', group: 'Click', name: '4/4 with 8ths', beats: 4, sub: 2, p: { a: 'X.......', c: '..x.x.x.', h: '.-.-.-.-' } },
  { id: 'click-3', group: 'Click', name: '3/4', beats: 3, sub: 1, p: { a: 'X..', c: '.xx' } },
  { id: 'click-2', group: 'Click', name: '2/4', beats: 2, sub: 1, p: { a: 'X.', c: '.x' } },
  { id: 'click-5', group: 'Click', name: '5/4', beats: 5, sub: 1, p: { a: 'X....', c: '.xxxx' } },
  { id: 'click-6-8', group: 'Click', name: '6/8 (BPM = dotted quarter)', beats: 2, sub: 3, p: { a: 'X.....', c: '.--x--' } },
  { id: 'click-7-8', group: 'Click', name: '7/8 (2+2+3, BPM = 8th)', beats: 7, sub: 1, p: { a: 'X......', c: '..x.x..' , h: '.-.-.--' } },

  { id: 'rock', group: 'Drums', name: 'Rock 4/4', beats: 4, sub: 4, p: { k: 'X.......X.x.....', s: '....X.......X...', h: 'x.x.x.x.x.x.x.x.' } },
  { id: 'pop', group: 'Drums', name: 'Pop 8-beat', beats: 4, sub: 4, p: { k: 'X.....x.X.......', s: '....X.......X...', h: 'x.x.x.x.x.x.x.x.' } },
  { id: 'half', group: 'Drums', name: 'Half-time', beats: 4, sub: 4, p: { k: 'X.........x.....', s: '........X.......', h: 'x.x.x.x.x.x.x.x.' } },
  { id: 'disco', group: 'Drums', name: 'Four on the floor', beats: 4, sub: 4, p: { k: 'X...X...X...X...', s: '....X.......X...', h: 'x...x...x...x...', o: '..x...x...x...x.' } },
  { id: 'funk', group: 'Drums', name: 'Funk 16ths', beats: 4, sub: 4, p: { k: 'X.....x...X..x..', s: '....X..-.-..X..-', h: 'x-x-x-x-x-x-x-x-' } },
  { id: 'hiphop', group: 'Drums', name: 'Hip-hop', beats: 4, sub: 4, p: { k: 'X......x..X.....', s: '....X.......X...', h: 'x.x.x.x.x.x.x.x.' } },
  { id: 'shuffle', group: 'Drums', name: 'Blues shuffle (12/8 feel)', beats: 4, sub: 3, p: { k: 'X.....X.....', s: '...X.....X..', h: 'x.xx.xx.xx.x' } },
  { id: 'waltz', group: 'Drums', name: 'Waltz 3/4', beats: 3, sub: 2, p: { k: 'X.....', s: '..x.x.', h: 'x.x.x.' } },
  { id: 'six-eight', group: 'Drums', name: '6/8 groove', beats: 2, sub: 3, p: { k: 'X.....', s: '...X..', h: 'x-xx-x' } },
  { id: 'reggae', group: 'Drums', name: 'Reggae one-drop', beats: 4, sub: 4, p: { k: '........X.......', r: '........X.......', h: '..x...x...x...x.' } },
  { id: 'bossa', group: 'Drums', name: 'Bossa nova', beats: 4, sub: 4, p: { k: 'X..xX..xX..xX..x', r: 'X..X..X...X..X..', h: '-x-x-x-x-x-x-x-x' } },
  { id: 'metal', group: 'Drums', name: 'Metal double kick', beats: 4, sub: 4, p: { k: 'xxxxxxxxxxxxxxxx', s: '....X.......X...', o: 'X...x...x...x...' } },
];
