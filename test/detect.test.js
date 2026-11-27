// Synthetic tests: run with `node test/detect.test.js`
const M = require('../music.js');
const SR = 48000, N = 16384;

function pluck(freqs, len, seed = 1) {
  const out = new Float32Array(len);
  let rnd = seed;
  const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  for (const f of freqs) {
    const amp = 0.6 + 0.4 * rand(), detune = 1 + (rand() - 0.5) * 0.004;
    for (let h = 1; h <= 10; h++) {
      const ff = f * h * detune; if (ff > SR / 2) break;
      const a = amp / Math.pow(h, 1.3), ph = rand() * 6.28;
      for (let i = 0; i < len; i++) out[i] += a * Math.sin(6.283185 * ff * i / SR + ph) * Math.exp(-i / SR * (1.5 + h * 0.4));
    }
  }
  for (let i = 0; i < len; i++) out[i] += (rand() - 0.5) * 0.02; // room noise
  return out;
}
function fftDb(x) { // radix-2 FFT with Blackman window, like AnalyserNode
  const n = x.length, re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) { const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / n) + 0.08 * Math.cos(4 * Math.PI * i / n); re[i] = x[i] * w; }
  for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) { const ang = -2 * Math.PI / len; for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) { const c = Math.cos(ang * k), s = Math.sin(ang * k), a = i + k, b = a + len / 2; const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; } }
  const db = new Float32Array(n / 2); for (let i = 0; i < n / 2; i++) db[i] = 20 * Math.log10(Math.hypot(re[i], im[i]) / n + 1e-12); return db;
}

let fail = 0;
// Tuner: each open string, plus slightly flat
for (const s of M.STRINGS) {
  for (const cents of [0, -20]) {
    const f = M.midiToFreq(s.midi + cents / 100);
    const buf = pluck([f], 2848).subarray(0);
    const r = M.yin(buf, SR); const d = r && M.describePitch(r.freq);
    const ok = d && d.note.toUpperCase() === s.name.toUpperCase() && Math.abs(d.stringCents - cents) < 4;
    if (!ok) fail++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} tuner ${s.label} ${cents}c -> ${r ? r.freq.toFixed(1) : '-'} Hz ${d ? d.note + ' ' + d.stringCents.toFixed(1) + 'c' : ''}`);
  }
}
// Chords: each played chord vs every target
let wrongAccepts = 0, rejects = 0;
for (const played of M.CHORDS) {
  const freqs = M.chordNotesMidi(played).map(M.midiToFreq);
  const db = fftDb(pluck(freqs, N, played.key.length * 7 + 3));
  const chroma = M.chromaFromSpectrum(db, SR, N);
  const self = M.matchChord(chroma, played);
  if (!self.ok) { rejects++; fail++; }
  const accepted = M.CHORDS.filter(t => t !== played && M.matchChord(chroma, t).ok).map(t => t.key);
  wrongAccepts += accepted.length;
  console.log(`${self.ok ? 'ok  ' : 'FAIL'} chord ${played.key.padEnd(6)} score ${self.score.toFixed(2)} heard ${self.heard} missing [${self.missing}]${accepted.length ? '  also accepted as: ' + accepted.join(',') : ''}`);
}
// Wrong-chord cases: missing a string (e.g., muted G string in C)
const cBroken = M.chordNotesMidi({ ...M.CHORD_BY_KEY.C, frets: [-1, 3, 2, -1, 1, -1] });
const r = M.matchChord(M.chromaFromSpectrum(fftDb(pluck(cBroken.map(M.midiToFreq), N)), SR, N), M.CHORD_BY_KEY.C);
console.log(`info C with G+e muted -> ok=${r.ok} missing [${r.missing}]`);

// Open strings: full shape must pass with spectrum; each muted open string must fail.
console.log('\nOpen-string checks');
let caught = 0, total = 0;
for (const chord of M.CHORDS) {
  const play = frets => {
    const notes = frets.map((f, i) => f < 0 ? null : M.STRINGS[i].midi + f).filter(x => x !== null);
    const db = fftDb(pluck(notes.map(M.midiToFreq), N, chord.key.length * 7 + 3));
    return M.matchChord(M.chromaFromSpectrum(db, SR, N), chord, { db, sampleRate: SR, fftSize: N });
  };
  const full = play(chord.frets);
  if (!full.ok) { fail++; console.log(`FAIL ${chord.key} full shape rejected: open missing [${full.openMissing}] missing [${full.missing}]`); }
  const res = [];
  chord.frets.forEach((f, s) => {
    if (f !== 0) return;
    total++;
    const r = play(chord.frets.map((x, i) => i === s ? -1 : x));
    if (!r.ok) caught++;
    res.push(`${M.STRING_LABELS[s]}:${r.ok ? 'MISSED' : 'caught'}`);
  });
  console.log(`${full.ok ? 'ok  ' : 'FAIL'} ${chord.key.padEnd(6)} ${res.join('  ') || '(no open strings)'}`);
}
console.log(`muted open strings caught: ${caught}/${total}`);
console.log(`\n${fail ? fail + ' failures' : 'all passed'}; wrong-chord accepts: ${wrongAccepts}`);
process.exit(fail ? 1 : 0);
