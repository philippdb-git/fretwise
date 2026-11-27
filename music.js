// Music theory + signal analysis for Fretwise. Pure functions, no DOM.
// Works in the browser (window.Music) and in Node (module.exports) for tests.
(function (root) {
  'use strict';

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  // Standard tuning, low E to high e, as MIDI numbers.
  const STRINGS = [
    { name: 'E', label: 'E2', midi: 40 },
    { name: 'A', label: 'A2', midi: 45 },
    { name: 'D', label: 'D3', midi: 50 },
    { name: 'G', label: 'G3', midi: 55 },
    { name: 'B', label: 'B3', midi: 59 },
    { name: 'e', label: 'E4', midi: 64 },
  ];

  const INTERVALS = {
    maj: [0, 4, 7],
    min: [0, 3, 7],
    '7': [0, 4, 7, 10],
    maj7: [0, 4, 7, 11],
    m7: [0, 3, 7, 10],
  };

  // frets: low E -> high e, -1 = don't play. fingers: 0 = open/none.
  const CHORDS = [
    { key: 'C', root: 0, type: 'maj', frets: [-1, 3, 2, 0, 1, 0], fingers: [0, 3, 2, 0, 1, 0] },
    { key: 'G', root: 7, type: 'maj', frets: [3, 2, 0, 0, 0, 3], fingers: [2, 1, 0, 0, 0, 3] },
    { key: 'D', root: 2, type: 'maj', frets: [-1, -1, 0, 2, 3, 2], fingers: [0, 0, 0, 1, 3, 2] },
    { key: 'A', root: 9, type: 'maj', frets: [-1, 0, 2, 2, 2, 0], fingers: [0, 0, 1, 2, 3, 0] },
    { key: 'E', root: 4, type: 'maj', frets: [0, 2, 2, 1, 0, 0], fingers: [0, 2, 3, 1, 0, 0] },
    { key: 'Am', root: 9, type: 'min', frets: [-1, 0, 2, 2, 1, 0], fingers: [0, 0, 2, 3, 1, 0] },
    { key: 'Em', root: 4, type: 'min', frets: [0, 2, 2, 0, 0, 0], fingers: [0, 2, 3, 0, 0, 0] },
    { key: 'Dm', root: 2, type: 'min', frets: [-1, -1, 0, 2, 3, 1], fingers: [0, 0, 0, 2, 3, 1] },
    { key: 'A7', root: 9, type: '7', frets: [-1, 0, 2, 0, 2, 0], fingers: [0, 0, 2, 0, 3, 0] },
    { key: 'B7', root: 11, type: '7', frets: [-1, 2, 1, 2, 0, 2], fingers: [0, 2, 1, 3, 0, 4] },
    { key: 'C7', root: 0, type: '7', frets: [-1, 3, 2, 3, 1, 0], fingers: [0, 3, 2, 4, 1, 0] },
    { key: 'D7', root: 2, type: '7', frets: [-1, -1, 0, 2, 1, 2], fingers: [0, 0, 0, 2, 1, 3] },
    { key: 'E7', root: 4, type: '7', frets: [0, 2, 0, 1, 0, 0], fingers: [0, 2, 0, 1, 0, 0] },
    { key: 'G7', root: 7, type: '7', frets: [3, 2, 0, 0, 0, 1], fingers: [3, 2, 0, 0, 0, 1] },
    { key: 'Fmaj7', root: 5, type: 'maj7', frets: [-1, -1, 3, 2, 1, 0], fingers: [0, 0, 3, 2, 1, 0] },
    { key: 'F', root: 5, type: 'maj', frets: [-1, -1, 3, 2, 1, 1], fingers: [0, 0, 3, 2, 1, 1], note: 'Small F: index finger covers the top two strings' },
  ];
  const CHORD_BY_KEY = Object.fromEntries(CHORDS.map(c => [c.key, c]));

  const SUFFIX = { maj: '', min: 'm', '7': '7', maj7: 'maj7', m7: 'm7' };
  // Every chord the detector can "hear", so a wrong chord loses to the right name.
  const LIBRARY = [];
  for (let r = 0; r < 12; r++) {
    for (const type of Object.keys(INTERVALS)) {
      LIBRARY.push({ name: NOTE_NAMES[r] + SUFFIX[type], tones: INTERVALS[type].map(i => (r + i) % 12) });
    }
  }

  function chordTones(chord) {
    return INTERVALS[chord.type].map(i => (chord.root + i) % 12);
  }
  function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function freqToMidi(f) { return 69 + 12 * Math.log2(f / 440); }
  function pitchClass(m) { return ((Math.round(m) % 12) + 12) % 12; }
  function chordNotesMidi(chord) {
    return chord.frets.map((f, i) => (f < 0 ? null : STRINGS[i].midi + f)).filter(m => m !== null);
  }

  // ---- Pitch detection (YIN) for the tuner -------------------------------
  // buf: Float32Array of time-domain samples. Returns {freq, clarity} or null.
  function yin(buf, sampleRate, minF = 60, maxF = 1100, threshold = 0.15) {
    const tauMin = Math.floor(sampleRate / maxF);
    const tauMax = Math.min(Math.floor(sampleRate / minF), Math.floor(buf.length / 2));
    const W = buf.length - tauMax;
    if (W < 256) return null;
    const d = new Float32Array(tauMax + 1);
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let i = 0; i < W; i++) {
        const diff = buf[i] - buf[i + tau];
        s += diff * diff;
      }
      d[tau] = s;
    }
    // cumulative mean normalized difference
    const cmnd = new Float32Array(tauMax + 1);
    cmnd[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      running += d[tau];
      cmnd[tau] = running > 0 ? (d[tau] * tau) / running : 1;
    }
    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) {
      if (cmnd[t] < threshold) {
        while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) return null;
    // parabolic interpolation
    let better = tau;
    if (tau > 1 && tau < tauMax) {
      const a = cmnd[tau - 1], b = cmnd[tau], c = cmnd[tau + 1];
      const denom = a - 2 * b + c;
      if (denom !== 0) better = tau + (a - c) / (2 * denom);
    }
    return { freq: sampleRate / better, clarity: 1 - cmnd[tau] };
  }

  // Nearest note + cents, and the nearest guitar string.
  function describePitch(freq) {
    const m = freqToMidi(freq);
    const nearest = Math.round(m);
    const cents = (m - nearest) * 100;
    let stringIdx = 0, bestDist = Infinity;
    STRINGS.forEach((s, i) => {
      const dist = Math.abs(m - s.midi);
      if (dist < bestDist) { bestDist = dist; stringIdx = i; }
    });
    const s = STRINGS[stringIdx];
    return {
      note: NOTE_NAMES[pitchClass(nearest)],
      octave: Math.floor(nearest / 12) - 1,
      cents,
      stringIdx,
      stringCents: (m - s.midi) * 100,
    };
  }

  // ---- Chroma (12 pitch-class energies) from an FFT ----------------------
  // dbSpectrum: Float32Array from AnalyserNode.getFloatFrequencyData.
  function chromaFromSpectrum(dbSpectrum, sampleRate, fftSize, minF = 75, maxF = 1050) {
    const chroma = new Float64Array(12);
    const binHz = sampleRate / fftSize;
    const lo = Math.max(2, Math.floor(minF / binHz));
    const hi = Math.min(dbSpectrum.length - 2, Math.ceil(maxF / binHz));
    const mag = i => Math.pow(10, dbSpectrum[i] / 20);
    let peak = -Infinity;
    for (let i = lo; i <= hi; i++) peak = Math.max(peak, dbSpectrum[i]);
    const floorDb = peak - 45; // ignore anything far below the loudest partial
    for (let i = lo; i <= hi; i++) {
      const v = dbSpectrum[i];
      if (v < floorDb) continue;
      if (v < dbSpectrum[i - 1] || v < dbSpectrum[i + 1]) continue; // local peaks only
      // refine the peak frequency
      const a = dbSpectrum[i - 1], b = v, c = dbSpectrum[i + 1];
      const denom = a - 2 * b + c;
      const offset = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
      const f = (i + offset) * binHz;
      const m = freqToMidi(f);
      const dev = Math.abs(m - Math.round(m));
      if (dev > 0.35) continue; // between notes: noise
      const weight = 1 / (1 + f / 400); // favour fundamentals over upper partials
      chroma[pitchClass(m)] += mag(i) * weight * (1 - dev);
    }
    let max = 0;
    for (const v of chroma) max = Math.max(max, v);
    if (max > 0) for (let k = 0; k < 12; k++) chroma[k] /= max;
    return chroma;
  }

  function cosine(chroma, tones) {
    let dot = 0, norm = 0;
    for (let k = 0; k < 12; k++) norm += chroma[k] * chroma[k];
    for (const t of tones) dot += chroma[t];
    if (norm === 0) return 0;
    return dot / (Math.sqrt(norm) * Math.sqrt(tones.length));
  }

  const STRING_LABELS = ['low E', 'A', 'D', 'G', 'B', 'high E'];

  // Loudest dB value within ±cents of f.
  function bandPeakDb(db, sampleRate, fftSize, f, cents = 45) {
    const binHz = sampleRate / fftSize;
    const r = Math.pow(2, cents / 1200);
    let lo = Math.floor(f / r / binHz), hi = Math.ceil(f * r / binHz);
    lo = Math.max(1, Math.min(lo, Math.round(f / binHz) - 1));
    hi = Math.min(db.length - 1, Math.max(hi, Math.round(f / binHz) + 1));
    let p = -Infinity;
    for (let i = lo; i <= hi; i++) p = Math.max(p, db[i]);
    return p;
  }

  // Median dB in the bands 1–2.5 semitones either side of f: the local "floor".
  function localFloorDb(db, sampleRate, fftSize, f) {
    const binHz = sampleRate / fftSize, vals = [];
    for (const [a, b] of [[-2.5, -1], [1, 2.5]]) {
      const lo = Math.floor(f * Math.pow(2, a / 12) / binHz), hi = Math.ceil(f * Math.pow(2, b / 12) / binHz);
      for (let i = Math.max(1, lo); i <= hi && i < db.length; i++) vals.push(db[i]);
    }
    vals.sort((x, y) => x - y);
    return vals.length ? vals[Math.floor(vals.length / 2)] : -Infinity;
  }

  // Checks each open string of the shape at its exact pitch (octave matters, unlike chroma).
  // Tuned to be forgiving with real guitars and phone mics:
  // - A string counts as ringing when its pitch stands out as a clear peak above the
  //   nearby spectrum (phone mics hear little of the low E's 82 Hz, so absolute level
  //   against the loudest note is not used).
  // - A "covered" string (a lower note in the chord has an overtone at the same pitch,
  //   e.g. the open high E over a fretted E in C) cannot be told apart reliably; it is
  //   only flagged when it is far quieter than that lower note.
  function openStringCheck(spectrum, chord) {
    const { db, sampleRate, fftSize } = spectrum;
    const played = chord.frets.map((fr, s) => (fr < 0 ? null : STRINGS[s].midi + fr));
    const out = [];
    chord.frets.forEach((fr, s) => {
      if (fr !== 0) return;
      const m = STRINGS[s].midi, f = midiToFreq(m);
      const level = bandPeakDb(db, sampleRate, fftSize, f);
      const prominence = level - localFloorDb(db, sampleRate, fftSize, f);
      let ok = prominence >= 12;
      const coveredBy = played.filter(pm => pm !== null && [12, 19, 24].includes(m - pm));
      for (const pm of coveredBy) {
        if (level < bandPeakDb(db, sampleRate, fftSize, midiToFreq(pm)) - 15) ok = false;
      }
      out.push({ string: s, label: STRING_LABELS[s], ok, covered: coveredBy.length > 0, prominence });
    });
    return out;
  }

  // Lenient check: is the target chord the best (or near-best) explanation?
  // With `spectrum` ({db, sampleRate, fftSize}) every open string is also required.
  function matchChord(chroma, chord, spectrum) {
    const tones = chordTones(chord);
    const score = cosine(chroma, tones);
    let best = { name: null, score: -1 };
    for (const c of LIBRARY) {
      const s = cosine(chroma, c.tones);
      if (s > best.score) best = { name: c.name, score: s };
    }
    // Only notes the shape actually contains can be "missing" (open C7 has no G).
    const shapeTones = [...new Set(chordNotesMidi(chord).map(pitchClass))];
    const missing = shapeTones.filter(t => chroma[t] < 0.18).map(t => NOTE_NAMES[t]);
    const extra = [];
    for (let k = 0; k < 12; k++) if (!tones.includes(k) && chroma[k] > 0.55) extra.push(NOTE_NAMES[k]);
    const openMissing = spectrum ? openStringCheck(spectrum, chord).filter(o => !o.ok).map(o => o.label) : [];
    const ok = score >= 0.78 && score >= best.score - 0.04 && missing.length === 0 && openMissing.length === 0;
    return { ok, score, heard: best.name, heardScore: best.score, missing, extra, openMissing };
  }

  // ---- Live analysis state (shared by the app and the offline tests) -------
  // Tracks the noise floor, decides when sound is loud enough, and spots new strums.
  function createLevelTracker() {
    let noise = 0.001, prevRms = 0, onsetAt = 0, onsetId = 0, quietSince = 0, strumPeak = 0;
    const hist = [];
    return {
      get noise() { return noise; },
      gate(sens) { return Math.max(0.012 * Math.pow(0.7, sens - 1), noise * 3); },
      update(rms, now, sens) {
        const gate = this.gate(sens);
        const loud = rms > gate;
        // Noise floor = the quietest moments (5th percentile) of the last ~8 s. A steady
        // noisy room raises the threshold; a long-ringing guitar does not, because the
        // short gaps between strums and chord changes keep the estimate low.
        hist.push(rms);
        if (hist.length > 200) hist.shift();
        if (hist.length >= 10) {
          const sorted = [...hist].sort((a, b) => a - b);
          noise = sorted[Math.floor(sorted.length * 0.05)];
        }
        // A new strum: sound starts after a real pause (not a flicker around the threshold
        // as a strum fades), or jumps sharply to near the last strum's peak while ringing.
        if (!loud) { if (!quietSince) quietSince = now; }
        const pausedLongEnough = quietSince && now - quietSince >= 150;
        if (loud && (pausedLongEnough || onsetId === 0 || (rms > prevRms * 2 && rms > strumPeak * 0.5))) {
          onsetAt = now; onsetId++; strumPeak = 0;
        }
        if (loud) { quietSince = 0; strumPeak = Math.max(strumPeak, rms); }
        prevRms = rms;
        return { loud, gate, sinceOnset: loud ? now - onsetAt : 0, onsetId };
      },
    };
  }

  // The FFT window still holds the pick attack (energy at every pitch) for a while after a strum.
  const SETTLE_MS = 120;
  // A string rings when its pitch stands this far (median over the strum) above the nearby
  // spectrum. Tuned on 36 real recordings (tools/analyze.js): clean strings ended around
  // 21 dB or more but can sit near 16 dB early in a strum; muted or unpressed strings were
  // mostly 0–15 dB. 13 dB is on the generous side on purpose: phone mics hear less bass than
  // the test mic, and rejecting a clean chord is worse than letting a slightly faulty one through.
  const STRING_RING_DB = 13;
  const MIN_BODY_FRAMES = 5;

  // Prominence of each played string's exact pitch in one spectrum.
  function stringProminences(spectrum, chord) {
    const { db, sampleRate, fftSize } = spectrum;
    const out = [];
    chord.frets.forEach((fr, s) => {
      if (fr < 0) return;
      const f = midiToFreq(STRINGS[s].midi + fr);
      out.push({ string: s, fret: fr, prominence: bandPeakDb(db, sampleRate, fftSize, f) - localFloorDb(db, sampleRate, fftSize, f) });
    });
    return out;
  }
  const median = a => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };

  // Judges one strum against a chord.
  // - Notes: the chord's notes must match for a short, mostly continuous time (a single
  //   bad moment takes time off instead of starting over).
  // - Strings (when checkStrings is on): every string of the shape, open or fretted, must
  //   ring at its exact pitch, judged by the median over the body of the strum (frames at
  //   least 30% as loud as the strum's peak), so one loud moment or one dip doesn't decide.
  // frame: {loud, chroma, spectrum, rms, dt, sinceOnset, onsetId}
  function createStrumJudge() {
    let holdMs = 0, lastOnset = -1, bodyMs = 0, notesOk = false, peak = 0, proms = {};
    const reset = () => { holdMs = 0; bodyMs = 0; notesOk = false; peak = 0; proms = {}; };
    return {
      reset,
      feed(f, chord, checkStrings = true) {
        if (f.onsetId !== lastOnset) { lastOnset = f.onsetId; reset(); }
        if (!(f.loud && f.chroma && f.sinceOnset >= SETTLE_MS)) return null;
        bodyMs += f.dt;
        peak = Math.max(peak, f.rms);
        const r = matchChord(f.chroma, chord);
        holdMs = r.ok ? holdMs + f.dt : Math.max(0, holdMs - f.dt);
        if (holdMs >= 250) notesOk = true;
        if (f.spectrum && f.rms >= peak * 0.3) {
          stringProminences(f.spectrum, chord).forEach(p => { (proms[p.string] = proms[p.string] || []).push(p.prominence); });
        }
        const strings = Object.entries(proms).map(([s, a]) => {
          const m = median(a);
          return { string: +s, fret: chord.frets[s], label: STRING_LABELS[s], median: m, frames: a.length, ok: m >= STRING_RING_DB };
        });
        const enough = strings.length > 0 && strings.every(x => x.frames >= MIN_BODY_FRAMES);
        const dead = checkStrings && enough ? strings.filter(x => !x.ok) : [];
        const stringsOk = !checkStrings || (enough && dead.length === 0);
        return { r, notesOk, strings, dead, enough, clean: notesOk && stringsOk, bodyMs };
      },
    };
  }

  const api = {
    createLevelTracker, createStrumJudge, SETTLE_MS, STRING_RING_DB, bandPeakDb, localFloorDb, stringProminences,
    NOTE_NAMES, STRINGS, CHORDS, CHORD_BY_KEY, LIBRARY, INTERVALS,
    chordTones, midiToFreq, freqToMidi, pitchClass, chordNotesMidi,
    yin, describePitch, chromaFromSpectrum, cosine, matchChord, openStringCheck, STRING_LABELS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Music = api;
})(typeof window !== 'undefined' ? window : globalThis);
