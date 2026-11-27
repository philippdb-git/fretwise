// Replays recorded takes through Fretwise's detection, frame by frame like the app.
// Usage: node tools/analyze.js [recordings/*.wav]
// File names: <Chord>_clean_N.wav (should pass), <Chord>_mute-open-<s>.wav and
// <Chord>_unpressed-<s>.wav (should be rejected; s = string index, 0 = low E).
const fs = require('fs'), path = require('path');
const M = require('../music.js');

const N = 16384, HOP_MS = 40, SENS = 5;

function readWav(file) {
  const b = fs.readFileSync(file);
  let p = 12, fmt = null, data = null;
  while (p < b.length - 8) {
    const id = b.toString('ascii', p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { channels: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') data = b.subarray(p + 8, p + 8 + Math.min(size, b.length - p - 8));
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data || fmt.bits !== 16) throw new Error('need 16-bit PCM WAV: ' + file);
  const n = Math.floor(data.length / 2 / fmt.channels), x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = data.readInt16LE(i * 2 * fmt.channels) / 32768;
  return { x, rate: fmt.rate };
}

// AnalyserNode-style spectrum: Blackman window, |X|/N, in dB.
const win = new Float64Array(N);
for (let i = 0; i < N; i++) win[i] = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / N) + 0.08 * Math.cos(4 * Math.PI * i / N);
const re = new Float64Array(N), im = new Float64Array(N);
function spectrumDb(x, end) {
  for (let i = 0; i < N; i++) { const j = end - N + i; re[i] = (j >= 0 ? x[j] : 0) * win[i]; im[i] = 0; }
  for (let i = 1, j = 0; i < N; i++) { let bit = N >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  const db = new Float32Array(N / 2);
  for (let i = 0; i < N / 2; i++) db[i] = 20 * Math.log10(Math.hypot(re[i], im[i]) / N + 1e-20);
  return db;
}

function analyze(file) {
  const base = path.basename(file, '.wav');
  const [key, kind] = base.split('_');
  const chord = M.CHORD_BY_KEY[key];
  if (!chord) return null;
  const expectClean = kind === 'clean';
  const { x, rate } = readWav(file);
  const hop = Math.round(rate * HOP_MS / 1000);
  const levels = M.createLevelTracker(), judge = M.createStrumJudge();
  let clean = false, last = null, frames = 0, maxRms = 0, lastOnsetCount = 0;
  const strings = {}; // per played string: prominence samples over settled frames
  const rawFrames = {};
  for (let end = 2048, t = 0; end <= x.length; end += hop, t += HOP_MS) {
    let sum = 0;
    for (let i = end - 2048; i < end; i++) sum += x[i] * x[i];
    const rms = Math.sqrt(sum / 2048);
    maxRms = Math.max(maxRms, rms);
    const lv = levels.update(rms, t, SENS);
    const f = { loud: lv.loud, rms, dt: HOP_MS, sinceOnset: lv.sinceOnset, onsetId: lv.onsetId };
    if (lv.loud) {
      const db = spectrumDb(x, end);
      f.chroma = M.chromaFromSpectrum(db, rate, N);
      f.spectrum = { db, sampleRate: rate, fftSize: N };
      if (f.sinceOnset >= M.SETTLE_MS) {
        frames++;
        chord.frets.forEach((fr, s) => {
          if (fr < 0) return;
          const fq = M.midiToFreq(M.STRINGS[s].midi + fr);
          const prom = M.bandPeakDb(db, rate, N, fq) - M.localFloorDb(db, rate, N, fq);
          (strings[s] = strings[s] || []).push(prom);
          (rawFrames[s] = rawFrames[s] || []).push([prom, rms]);
        });
      }
    }
    lastOnsetCount = lv.onsetId;
    const j = judge.feed(f, chord, true);
    if (j) { last = j; if (j.clean) clean = true; }
  }
  const med = a => { const b = [...a].sort((p, q) => p - q); return b[Math.floor(b.length / 2)]; };
  const strReport = Object.entries(strings).map(([s, a]) =>
    `${M.STRING_LABELS[s]}${chord.frets[s] === 0 ? '(o)' : '(' + chord.frets[s] + ')'} ${med(a).toFixed(0)}/${Math.max(...a).toFixed(0)}`).join('  ');
  return {
    base, expectClean, clean, ok: clean === expectClean, frames, maxRms,
    notes: last ? (last.notesOk ? 'notes OK' : `notes: heard ${last.r.heard} missing [${last.r.missing}]`) : 'never loud/settled',
    open: last ? (last.enough ? `dead [${last.dead.map(d => d.label + ' ' + d.median.toFixed(0) + 'dB').join(', ')}]` : 'strings: not enough frames') : '',
    onsets: lastOnsetCount,
    strReport, rawFrames, key, kind, frets: chord.frets,
  };
}

if (process.argv[2] === '--dump') {
  const dir = path.join(__dirname, '..', 'recordings');
  const out = fs.readdirSync(dir).filter(f => f.endsWith('.wav')).sort().map(f => analyze(path.join(dir, f))).filter(Boolean)
    .map(r => ({ base: r.base, key: r.key, kind: r.kind, frets: r.frets, frames: r.rawFrames }));
  fs.writeFileSync(process.argv[3], JSON.stringify(out));
  process.exit(0);
}
const files = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.readdirSync(path.join(__dirname, '..', 'recordings')).filter(f => f.endsWith('.wav')).sort().map(f => path.join(__dirname, '..', 'recordings', f));
let right = 0, total = 0;
for (const file of files) {
  const r = analyze(file);
  if (!r) continue;
  total++; if (r.ok) right++;
  console.log(`${r.ok ? 'ok  ' : 'BAD '} ${r.base.padEnd(20)} expect ${r.expectClean ? 'clean ' : 'reject'} got ${r.clean ? 'clean ' : 'reject'} | peak ${(20 * Math.log10(r.maxRms)).toFixed(0)} dBFS | strums ${r.onsets} | ${r.notes} | ${r.open}`);
  console.log(`      string prominence median/max dB: ${r.strReport}`);
}
console.log(`\n${right}/${total} takes judged as expected`);
