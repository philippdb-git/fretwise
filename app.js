// Fretwise app: tuner, chord practice, chord-change drills, progress.
(() => {
  'use strict';
  const M = window.Music;
  const $ = id => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---------------------------------------------------------------- storage
  const STORE_KEY = 'fretwise.v1';
  const defaults = () => ({
    days: [], clean: 0, minute: {}, metro: {}, recent: [],
    prefs: {
      practice: ['C', 'G', 'D', 'Em', 'Am'], shuffle: true,
      metroSeq: ['G', 'C', 'D'], bpm: 60, beats: 4, rounds: 16,
      pairA: 'C', pairB: 'G', sens: 5, strictOpen: true, showDetail: false,
    },
  });
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const d = JSON.parse(raw), def = defaults();
        return { ...def, ...d, prefs: { ...def.prefs, ...(d.prefs || {}) } };
      }
    } catch (e) { /* storage unavailable */ }
    return defaults();
  }
  let S = load();
  function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { /* ignore */ } }
  const dayStr = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  function markDay() { const t = dayStr(new Date()); if (!S.days.includes(t)) { S.days.push(t); save(); } }
  function streak() {
    const have = new Set(S.days), d = new Date();
    if (!have.has(dayStr(d))) d.setDate(d.getDate() - 1);
    let n = 0;
    while (have.has(dayStr(d))) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }
  function addRecent(text) { S.recent.unshift({ at: Date.now(), text }); S.recent = S.recent.slice(0, 12); save(); }

  // ---------------------------------------------------------------- toast
  let toastTimer;
  function toast(msg, ms = 3200) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  // ---------------------------------------------------------------- audio engine
  const Engine = {
    ctx: null, analyser: null, stream: null, src: null, running: false,
    timeBuf: null, freqBuf: null, listeners: new Set(), mode: 'pitch',
    noise: 0.001, last: 0, wake: null, prevRms: 0, onsetAt: 0, rmsHist: [],

    ensureCtx() {
      if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    },
    async start(test = false) {
      if (this.running) return true;
      try {
        if (!test) {
          if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw Object.assign(new Error('insecure'), { name: 'InsecureContext' });
          }
          this.stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          });
        }
        const ctx = this.ensureCtx();
        await ctx.resume();
        const an = ctx.createAnalyser();
        an.fftSize = 16384; an.smoothingTimeConstant = 0; an.minDecibels = -120; an.maxDecibels = 0;
        this.analyser = an;
        if (this.stream) { this.src = ctx.createMediaStreamSource(this.stream); this.src.connect(an); }
        this.timeBuf = new Float32Array(an.fftSize);
        this.freqBuf = new Float32Array(an.frequencyBinCount);
        this.running = true;
        this.loop();
        this.requestWake();
        setMicUi('on');
        return true;
      } catch (err) {
        setMicUi('err');
        if (err.name === 'InsecureContext') toast('The microphone only works over https or localhost. See README for how to open the app.', 6000);
        else if (err.name === 'NotAllowedError') toast('Microphone blocked. Allow it in Chrome: lock icon → Permissions → Microphone.', 6000);
        else if (err.name === 'NotFoundError') toast('No microphone found.');
        else toast('Could not start the microphone: ' + err.message);
        return false;
      }
    },
    stop() {
      this.running = false;
      if (this.stream) this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
      if (this.src) { this.src.disconnect(); this.src = null; }
      this.releaseWake();
      setMicUi('off');
    },
    loop() {
      if (!this.running) return;
      this.tick();
      requestAnimationFrame(() => this.loop());
    },
    gate() {
      const base = 0.012 * Math.pow(0.7, S.prefs.sens - 1);
      return Math.max(base, this.noise * 3);
    },
    tick() {
      const now = performance.now();
      if (now - this.last < 40) return;
      const dt = this.last ? now - this.last : 40;
      this.last = now;
      const an = this.analyser, buf = this.timeBuf, sr = this.ctx.sampleRate;
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      const n = 2048, off = buf.length - n;
      for (let i = off; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / n);
      const gate = this.gate();
      const loud = rms > gate;
      // Noise floor = the quiet end (10th percentile) of the last ~5 s. A steady noisy
      // room raises the threshold instead of counting as one endless strum.
      this.rmsHist.push(rms);
      if (this.rmsHist.length > 125) this.rmsHist.shift();
      if (this.rmsHist.length >= 10) {
        const sorted = [...this.rmsHist].sort((a, b) => a - b);
        this.noise = sorted[Math.floor(sorted.length * 0.1)];
      }
      // A new strum: sound starts, or jumps up sharply while ringing.
      if (loud && (this.prevRms <= gate || rms > this.prevRms * 2)) this.onsetAt = now;
      this.prevRms = rms;
      const frame = {
        time: this.ctx.currentTime, dt, rms, loud, level: Math.sqrt(clamp(rms / 0.15, 0, 1)),
        sinceOnset: loud ? now - this.onsetAt : 0,
      };
      if (loud && this.mode === 'chroma') {
        an.getFloatFrequencyData(this.freqBuf);
        frame.chroma = M.chromaFromSpectrum(this.freqBuf, sr, an.fftSize);
        frame.spectrum = { db: this.freqBuf, sampleRate: sr, fftSize: an.fftSize };
      }
      if (loud && this.mode === 'pitch') {
        frame.pitch = M.yin(buf.subarray(buf.length - 2848), sr);
      }
      $('levelBar').style.width = (frame.level * 100).toFixed(0) + '%';
      this.listeners.forEach(fn => fn(frame));
    },
    async requestWake() {
      try { if ('wakeLock' in navigator) this.wake = await navigator.wakeLock.request('screen'); } catch (e) { /* optional */ }
    },
    releaseWake() { try { this.wake && this.wake.release(); } catch (e) { /* ignore */ } this.wake = null; },
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Engine.running) Engine.requestWake();
  });

  function setMicUi(state) {
    const b = $('micBtn');
    b.classList.toggle('on', state === 'on');
    b.classList.toggle('err', state === 'err');
    $('micLabel').textContent = state === 'on' ? 'Listening' : state === 'err' ? 'Mic off' : 'Start mic';
    if (state !== 'on') $('levelBar').style.width = '0';
  }
  async function startMic() { return Engine.running ? true : Engine.start(!!window.__fretTestMode); }
  $('micBtn').addEventListener('click', () => { if (Engine.running) Engine.stop(); else startMic(); });

  // Plucked reference tone (also used by the test harness)
  let pluckWave = null;
  function pluck(freqs, { dest, gain = 0.25, dur = 2.2, strum = 0.018 } = {}) {
    const ctx = Engine.ensureCtx();
    if (!pluckWave) {
      const N = 12, re = new Float32Array(N), im = new Float32Array(N);
      for (let h = 1; h < N; h++) im[h] = 1 / Math.pow(h, 1.3);
      pluckWave = ctx.createPeriodicWave(re, im);
    }
    const t0 = ctx.currentTime + 0.02;
    freqs.forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain(), t = t0 + i * strum;
      o.setPeriodicWave(pluckWave); o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain / Math.sqrt(freqs.length), t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(dest || ctx.destination);
      o.start(t); o.stop(t + dur + 0.05);
    });
  }

  // ---------------------------------------------------------------- chord diagram
  const SVGNS = 'http://www.w3.org/2000/svg';
  function diagram(chord) {
    const W = 140, H = 172, x0 = 22, dx = 19.2, y0 = 34, dy = 26, frets = 5;
    const p = [`<svg viewBox="0 0 ${W} ${H}" xmlns="${SVGNS}" role="img" aria-label="${chord.key} chord diagram">`];
    p.push(`<rect x="${x0}" y="${y0 - 4}" width="${dx * 5}" height="5" rx="1.5" fill="var(--ink)"/>`);
    for (let f = 1; f <= frets; f++) p.push(`<line x1="${x0}" x2="${x0 + dx * 5}" y1="${y0 + f * dy}" y2="${y0 + f * dy}" stroke="var(--line)" stroke-width="1.6"/>`);
    for (let s = 0; s < 6; s++) {
      const x = x0 + s * dx;
      p.push(`<line x1="${x}" x2="${x}" y1="${y0}" y2="${y0 + frets * dy}" stroke="var(--muted)" stroke-width="${1.9 - s * 0.18}"/>`);
      const fr = chord.frets[s];
      if (fr < 0) p.push(`<text x="${x}" y="${y0 - 12}" text-anchor="middle" font-size="13" font-weight="700" fill="var(--muted)">×</text>`);
      else if (fr === 0) p.push(`<circle cx="${x}" cy="${y0 - 16}" r="4.5" fill="none" stroke="var(--ink)" stroke-width="1.6"/>`);
    }
    // barre: same finger on same fret across several strings
    const seen = {};
    chord.frets.forEach((fr, s) => {
      if (fr <= 0) return;
      const k = chord.fingers[s] + '@' + fr;
      (seen[k] = seen[k] || []).push(s);
    });
    Object.entries(seen).forEach(([k, ss]) => {
      const fr = +k.split('@')[1], y = y0 + (fr - 0.5) * dy;
      if (ss.length > 1) {
        const a = x0 + Math.min(...ss) * dx, b = x0 + Math.max(...ss) * dx;
        p.push(`<rect x="${a - 8.5}" y="${y - 8.5}" width="${b - a + 17}" height="17" rx="8.5" fill="var(--accent)"/>`);
      }
      ss.forEach(s => {
        const x = x0 + s * dx;
        p.push(`<circle cx="${x}" cy="${y}" r="8.5" fill="var(--accent)"/>`);
        p.push(`<text x="${x}" y="${y + 4.3}" text-anchor="middle" font-size="11.5" font-weight="700" fill="#fff">${chord.fingers[s] || ''}</text>`);
      });
    });
    M.STRINGS.forEach((st, s) => p.push(`<text x="${x0 + s * dx}" y="${H - 4}" text-anchor="middle" font-size="10" font-weight="600" fill="var(--muted)">${st.name}</text>`));
    p.push('</svg>');
    return p.join('');
  }

  function chips(container, keys, isOn, onTap) {
    container.innerHTML = '';
    keys.forEach(k => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip'; b.textContent = k;
      b.setAttribute('aria-pressed', String(isOn(k)));
      b.addEventListener('click', () => onTap(k));
      container.appendChild(b);
    });
  }
  const ALL_KEYS = M.CHORDS.map(c => c.key);

  // Chord check for a frame; open strings are required unless switched off in Settings.
  function check(f, chord) {
    return M.matchChord(f.chroma, chord, S.prefs.strictOpen ? f.spectrum : undefined);
  }
  // The FFT window still holds the pick attack (energy at every pitch) for a while after a strum.
  const SETTLE_MS = 120;
  const settled = f => f.loud && f.chroma && f.sinceOnset >= SETTLE_MS;
  const isClean = (f, chord) => !!(settled(f) && check(f, chord).ok);

  // Accumulates how long a condition has been (mostly) true: a single bad frame
  // takes time off instead of starting over, so real, slightly noisy strums still count.
  function holdTimer() {
    let ms = 0;
    return { add(ok, dt) { ms = ok ? ms + dt : Math.max(0, ms - dt); return ms; }, reset() { ms = 0; } };
  }

  // ---------------------------------------------------------------- tabs
  let currentTab = 'tune';
  const tabHandlers = {};
  function showTab(name) {
    if (currentTab === 'drills' && name !== 'drills') { Metro.stop(false); Minute.stop(false); }
    currentTab = name;
    document.querySelectorAll('.view').forEach(v => { v.hidden = v.dataset.view !== name; });
    document.querySelectorAll('.tabbar button').forEach(b => {
      if (b.dataset.tab === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    Engine.mode = name === 'tune' ? 'pitch' : 'chroma';
    if (tabHandlers[name]) tabHandlers[name]();
    try { localStorage.setItem('fretwise.tab', name); } catch (e) { /* ignore */ }
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('.tabbar button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // ---------------------------------------------------------------- tuner
  const Tuner = (() => {
    const wrap = document.querySelector('.tuner');
    const hist = [];
    let lastPitchAt = 0;
    const inTune = holdTimer();
    const done = new Set();
    const btns = M.STRINGS.map((s, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'string-btn'; b.setAttribute('role', 'listitem');
      b.innerHTML = `${s.name.toUpperCase()}<small>${s.label}</small>`;
      b.setAttribute('aria-label', `Play reference ${s.label}`);
      b.addEventListener('click', () => pluck([M.midiToFreq(s.midi)], { gain: 0.35 }));
      $('tStrings').appendChild(b);
      return b;
    });
    function onFrame(f) {
      if (currentTab !== 'tune') return;
      const now = performance.now();
      if (f.pitch && f.pitch.clarity > 0.8 && f.pitch.freq > 70 && f.pitch.freq < 1000) {
        hist.push(f.pitch.freq); if (hist.length > 5) hist.shift();
        lastPitchAt = now;
        const freq = [...hist].sort((a, b) => a - b)[Math.floor(hist.length / 2)];
        const d = M.describePitch(freq);
        const c = d.stringCents;
        const ok = Math.abs(c) < 5;
        $('tNote').textContent = d.note; $('tOct').textContent = d.octave;
        $('tNeedle').style.left = (50 + clamp(c, -50, 50)) + '%';
        $('tHz').textContent = `${freq.toFixed(1)} Hz · ${c > 0 ? '+' : ''}${c.toFixed(0)} cents from ${M.STRINGS[d.stringIdx].label}`;
        const target = M.STRINGS[d.stringIdx].name.toUpperCase();
        let hint;
        if (ok) hint = `${target} string is in tune`;
        else if (c < -50) hint = `Much too low: tighten toward ${target}`;
        else if (c > 50) hint = `Much too high: loosen toward ${target}`;
        else if (c < 0) hint = `A bit low: tighten slightly`;
        else hint = `A bit high: loosen slightly`;
        $('tHint').textContent = hint;
        $('tHint').classList.toggle('in', ok);
        wrap.classList.add('live'); wrap.classList.toggle('in', ok);
        btns.forEach((b, i) => { b.classList.toggle('near', i === d.stringIdx && !ok); b.classList.toggle('ok', i === d.stringIdx && ok); });
        if (inTune.add(ok, f.dt) > 700 && !done.has(d.stringIdx)) {
          done.add(d.stringIdx); btns[d.stringIdx].classList.add('done');
          if (done.size === 6) { toast('All six strings in tune. Ready to play!'); markDay(); }
        }
      } else if (now - lastPitchAt > 700) {
        hist.length = 0; inTune.reset();
        wrap.classList.remove('live', 'in');
        btns.forEach(b => b.classList.remove('near', 'ok'));
        if (Engine.running) { $('tHint').textContent = 'Pluck one string and let it ring.'; $('tHint').classList.remove('in'); }
      }
    }
    Engine.listeners.add(onFrame);
    return {};
  })();

  // ---------------------------------------------------------------- chord practice
  const Practice = (() => {
    let current = null, count = 0, locked = false, loudMs = 0, lastMsgAt = 0, order = 0, peak = 0, hints = {};
    const hold = holdTimer();
    const cols = [];
    M.NOTE_NAMES.forEach(n => {
      const c = document.createElement('div'); c.className = 'note-col';
      c.innerHTML = `<div class="note-bar"></div><span>${n}</span>`;
      $('pNotes').appendChild(c); cols.push(c);
    });

    function renderPicker() {
      chips($('pChips'), ALL_KEYS, k => S.prefs.practice.includes(k), k => {
        const list = S.prefs.practice;
        if (list.includes(k)) { if (list.length > 1) list.splice(list.indexOf(k), 1); else toast('Keep at least one chord.'); }
        else list.push(k);
        save(); renderPicker();
        if (!list.includes(current.key)) next();
      });
      $('pShuffle').checked = S.prefs.shuffle;
    }
    $('pEdit').addEventListener('click', () => {
      const p = $('pPicker'); p.hidden = !p.hidden;
      $('pEdit').textContent = p.hidden ? 'Choose chords' : 'Done';
      if (!p.hidden) renderPicker();
    });
    $('pShuffle').addEventListener('change', e => { S.prefs.shuffle = e.target.checked; save(); });

    function show(key) {
      current = M.CHORD_BY_KEY[key];
      $('pName').textContent = current.key;
      $('pNote').textContent = current.note || ' ';
      $('pDiagram').innerHTML = diagram(current);
      const shape = new Set(M.chordNotesMidi(current).map(M.pitchClass));
      cols.forEach((c, i) => c.classList.toggle('tone', shape.has(i)));
      locked = false; hold.reset(); loudMs = 0; peak = 0; hints = {}; lastMsgAt = 0;
      status(Engine.running ? 'Strum the chord and let it ring.' : 'Start the mic, then strum the chord.');
    }
    function next() {
      const list = S.prefs.practice;
      let key;
      if (S.prefs.shuffle && list.length > 1) {
        do { key = list[Math.floor(Math.random() * list.length)]; } while (current && key === current.key);
      } else { order = (order + 1) % list.length; key = list[order]; }
      show(key);
    }
    function status(text, kind = '') {
      const s = $('pStatus'); s.textContent = text; s.className = 'status' + (kind ? ' ' + kind : '');
    }
    $('pSkip').addEventListener('click', next);

    function onFrame(f) {
      if (currentTab !== 'chords' || !current) return;
      cols.forEach((c, i) => {
        const v = f.chroma ? f.chroma[i] : 0;
        c.firstChild.style.height = Math.max(4, v * 100).toFixed(0) + '%';
      });
      if (locked) return;
      if (!f.loud || !f.chroma) {
        hold.reset(); loudMs = 0; peak = 0; hints = {};
        return;
      }
      loudMs += f.dt;
      peak = Math.max(peak, f.rms);
      if (!settled(f)) return;
      const r = check(f, current);
      if (f.rms >= peak * 0.3) detail(f, r);
      if (hold.add(r.ok, f.dt) >= 250) {
        locked = true; count++; S.clean++; save(); markDay();
        $('pCount').textContent = count;
        status(`Clean ${current.key}!`, 'good');
        const card = document.querySelector('.practice');
        card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
        setTimeout(next, 1100);
        return;
      }
      // Collect hints only from the body of the strum (not the attack or the fading tail),
      // then show the most common one.
      if (!r.ok && f.rms >= peak * 0.3) {
        const h = hintFor(r);
        hints[h] = (hints[h] || 0) + 1;
      }
      const now = performance.now();
      if (loudMs > 700 && now - lastMsgAt > 500) {
        const top = Object.entries(hints).sort((a, b) => b[1] - a[1])[0];
        if (top) { lastMsgAt = now; status(top[0], 'warn'); }
      }
    }
    let detailAt = 0;
    function detail(f, r) {
      const el = $('pDetail');
      if (!S.prefs.showDetail) { el.hidden = true; return; }
      const now = performance.now();
      if (now - detailAt < 200) return;
      detailAt = now; el.hidden = false;
      const opens = f.spectrum ? M.openStringCheck(f.spectrum, current) : [];
      const parts = [`Heard ${r.heard || '?'} (match ${Math.round(r.score * 100)}%)`];
      parts.push(r.missing.length ? `missing ${r.missing.join(', ')}` : 'all notes present');
      if (opens.length) parts.push('open strings: ' + opens.map(o => `${o.label} ${o.ok ? '✓' : '✗'}`).join(', '));
      parts.push(r.ok ? 'CLEAN' : 'not yet');
      el.textContent = parts.join(' · ');
    }
    function hintFor(r) {
      if (r.missing.length) return `Missing ${r.missing.join(' and ')}. Check that every string rings clearly.`;
      if (r.openMissing.length) {
        const many = r.openMissing.length > 1;
        return `Open ${r.openMissing.join(' and ')} string${many ? 's aren\'t' : ' isn\'t'} ringing. A finger may be touching ${many ? 'them' : 'it'}.`;
      }
      if (r.heard && r.heard !== current.key) return `Sounds like ${r.heard}. Check your finger positions.`;
      return 'Almost. Strum again and let it ring.';
    }
    Engine.listeners.add(onFrame);
    tabHandlers.chords = () => {
      if (!current) { order = -1; next(); }
      else if (!locked) status(Engine.running ? 'Strum the chord and let it ring.' : 'Start the mic, then strum the chord.');
    };
    return { finish() { if (count) addRecent(`Chord practice: ${count} clean`); } };
  })();

  // ---------------------------------------------------------------- drills: segment control
  function setSeg(which) {
    $('segMetro').setAttribute('aria-selected', String(which === 'metro'));
    $('segMinute').setAttribute('aria-selected', String(which === 'minute'));
    $('metroPanel').hidden = which !== 'metro';
    $('minutePanel').hidden = which !== 'minute';
    if (which === 'metro') Minute.stop(false); else Metro.stop(false);
  }
  $('segMetro').addEventListener('click', () => setSeg('metro'));
  $('segMinute').addEventListener('click', () => setSeg('minute'));

  function click(time, accent) {
    const ctx = Engine.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = accent ? 2400 : 1800;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(accent ? 0.6 : 0.35, time + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    o.connect(g); g.connect(ctx.destination); o.start(time); o.stop(time + 0.06);
  }
  const LAG = 0.17; // seconds the FFT window trails the live sound

  // ---------------------------------------------------------------- metronome drill
  const Metro = (() => {
    let run = null;
    function seqKey() { return [...S.prefs.metroSeq].sort().join(' · ') + ` @ ${S.prefs.bpm}`; }
    // A fresh random order for every drill: random first chord, never the same chord twice in a row.
    function randomOrder(set, n) {
      const out = [];
      for (let i = 0; i < n; i++) {
        const options = set.filter(k => k !== out[i - 1]);
        out.push(options[Math.floor(Math.random() * options.length)]);
      }
      return out;
    }
    function renderSetup() {
      chips($('mChips'), ALL_KEYS, k => S.prefs.metroSeq.includes(k), k => {
        const s = S.prefs.metroSeq;
        if (s.includes(k)) s.splice(s.indexOf(k), 1); else s.push(k);
        save(); renderSetup();
      });
      $('mSeq').innerHTML = '';
      S.prefs.metroSeq.forEach((k, i) => {
        if (i) { const a = document.createElement('span'); a.className = 'arrow'; a.textContent = '·'; $('mSeq').appendChild(a); }
        const b = document.createElement('span'); b.textContent = k; $('mSeq').appendChild(b);
      });
      if (S.prefs.metroSeq.length) { const a = document.createElement('span'); a.className = 'arrow'; a.textContent = '(random order)'; $('mSeq').appendChild(a); }
      $('mBpm').textContent = S.prefs.bpm;
      $('mBeats').value = String(S.prefs.beats);
      $('mRounds').value = String(S.prefs.rounds);
      const best = S.metro[seqKey()];
      $('mBestLine').textContent = best ? `Best at this tempo: ${best.score} of ${best.of} clean` : ' ';
    }
    document.querySelectorAll('[data-bpm]').forEach(b => b.addEventListener('click', () => {
      S.prefs.bpm = clamp(S.prefs.bpm + +b.dataset.bpm, 30, 160); save(); renderSetup();
    }));
    $('mBeats').addEventListener('change', e => { S.prefs.beats = +e.target.value; save(); });
    $('mRounds').addEventListener('change', e => { S.prefs.rounds = +e.target.value; save(); });

    function panel(which) { $('mSetup').hidden = which !== 'setup'; $('mRun').hidden = which !== 'run'; $('mDone').hidden = which !== 'done'; }

    async function start() {
      if (S.prefs.metroSeq.length < 2) { toast('Pick at least two chords.'); return; }
      if (!(await startMic())) return;
      const ctx = Engine.ctx, beatDur = 60 / S.prefs.bpm, beats = S.prefs.beats;
      const countIn = Math.max(4, beats);
      run = {
        seq: S.prefs.metroSeq.slice(), order: randomOrder(S.prefs.metroSeq, S.prefs.rounds), beats, beatDur, countIn, rounds: S.prefs.rounds,
        t0: ctx.currentTime + 0.35, nextBeat: 0, results: new Array(S.prefs.rounds).fill(null),
        hold: holdTimer(), key: seqKey(),
      };
      run.total = countIn + run.rounds * beats;
      run.timer = setInterval(schedule, 25);
      schedule();
      $('mBeatDots').innerHTML = '';
      for (let i = 0; i < beats; i++) { const d = document.createElement('div'); d.className = 'beat' + (i === 0 ? ' first' : ''); $('mBeatDots').appendChild(d); }
      $('mResults').innerHTML = '';
      run.resEls = run.results.map((_, i) => {
        const e = document.createElement('div'); e.className = 'res'; e.textContent = run.order[i];
        $('mResults').appendChild(e); return e;
      });
      panel('run');
      run.raf = requestAnimationFrame(draw);
    }
    function schedule() {
      const ctx = Engine.ctx;
      while (run && run.nextBeat < run.total && run.t0 + run.nextBeat * run.beatDur < ctx.currentTime + 0.12) {
        const i = run.nextBeat;
        const accent = i < run.countIn ? i % 4 === 0 : (i - run.countIn) % run.beats === 0;
        click(run.t0 + i * run.beatDur, accent);
        run.nextBeat++;
      }
    }
    function draw() {
      if (!run) return;
      const now = Engine.ctx.currentTime;
      const b = (now - run.t0) / run.beatDur;
      const inCount = b < run.countIn;
      const slot = Math.floor((b - run.countIn) / run.beats);
      const beatInBar = inCount ? Math.floor(Math.max(0, b)) % run.beats : Math.floor(b - run.countIn) % run.beats;
      const chordAt = s => run.order[clamp(s, 0, run.rounds - 1)];
      if (inCount) {
        $('mProgress').textContent = `Get ready… ${Math.max(1, Math.ceil(run.countIn - b))}`;
        $('mNow').textContent = chordAt(0); $('mNext').textContent = chordAt(1);
        $('mNextDia').innerHTML = diagram(M.CHORD_BY_KEY[chordAt(1)]);
      } else if (slot < run.rounds) {
        $('mProgress').textContent = `Change ${slot + 1} of ${run.rounds}`;
        if ($('mNow').textContent !== chordAt(slot) || run.shown !== slot) {
          run.shown = slot;
          $('mNow').textContent = chordAt(slot);
          const nx = slot + 1 < run.rounds ? chordAt(slot + 1) : '–';
          $('mNext').textContent = nx;
          $('mNextDia').innerHTML = nx !== '–' ? diagram(M.CHORD_BY_KEY[nx]) : '';
        }
        run.resEls.forEach((e, i) => e.classList.toggle('cur', i === slot));
      }
      [...$('mBeatDots').children].forEach((d, i) => d.classList.toggle('on', b >= 0 && i === beatInBar));
      // mark misses once a slot (plus analysis lag) is over
      const bLag = (now - LAG - run.t0) / run.beatDur - run.countIn;
      for (let s = 0; s < run.rounds; s++) {
        if (run.results[s] === null && bLag >= (s + 1) * run.beats) { run.results[s] = false; run.resEls[s].classList.add('miss'); }
      }
      if (b >= run.total + 0.3) { finish(); return; }
      run.raf = requestAnimationFrame(draw);
    }
    function onFrame(f) {
      if (!run || currentTab !== 'drills') return;
      const b = (f.time - LAG - run.t0) / run.beatDur - run.countIn;
      if (b < 0) return;
      const slot = Math.floor(b / run.beats);
      if (slot >= run.rounds || run.results[slot] !== null) { run.hold.reset(); return; }
      const chord = M.CHORD_BY_KEY[run.order[slot]];
      const ok = isClean(f, chord);
      if (run.hold.add(ok, f.dt) >= 200) {
        run.results[slot] = true; run.resEls[slot].classList.add('ok'); run.hold.reset();
        S.clean++; markDay();
      }
    }
    Engine.listeners.add(onFrame);
    function finish() {
      const r = run; stop(false);
      const score = r.results.filter(Boolean).length;
      const prev = S.metro[r.key];
      const isBest = !prev || score > prev.score;
      if (isBest) S.metro[r.key] = { score, of: r.rounds, at: Date.now() };
      addRecent(`Metronome ${r.key} BPM: ${score}/${r.rounds}`);
      save();
      $('mScore').textContent = score;
      $('mDoneLine').textContent = `${score} of ${r.rounds} changes clean at ${Math.round(60 / r.beatDur)} BPM.` +
        (isBest && prev ? ' New best!' : prev ? ` Best: ${prev.score}.` : '') +
        (score / r.rounds >= 0.85 ? ' Try 5 BPM faster next time.' : score / r.rounds < 0.5 ? ' Try 5–10 BPM slower.' : '');
      $('mDoneResults').innerHTML = '';
      r.results.forEach((ok, i) => {
        const e = document.createElement('div'); e.className = 'res ' + (ok ? 'ok' : 'miss'); e.textContent = r.order[i];
        $('mDoneResults').appendChild(e);
      });
      panel('done');
    }
    function stop(toSetup = true) {
      if (!run) { if (toSetup) panel('setup'); return; }
      clearInterval(run.timer); cancelAnimationFrame(run.raf); run = null;
      if (toSetup) { panel('setup'); renderSetup(); }
      else if (!$('mRun').hidden) { panel('setup'); renderSetup(); }
    }
    $('mStart').addEventListener('click', start);
    $('mStop').addEventListener('click', () => stop(true));
    $('mAgain').addEventListener('click', () => { panel('setup'); renderSetup(); });
    renderSetup();
    return { stop, renderSetup };
  })();

  // ---------------------------------------------------------------- one-minute drill
  const Minute = (() => {
    let run = null;
    const pairKey = () => [S.prefs.pairA, S.prefs.pairB].join(' ⇄ ');
    function renderSetup() {
      chips($('oChipsA'), ALL_KEYS, k => k === S.prefs.pairA, k => {
        if (k === S.prefs.pairB) S.prefs.pairB = S.prefs.pairA;
        S.prefs.pairA = k; save(); renderSetup();
      });
      chips($('oChipsB'), ALL_KEYS, k => k === S.prefs.pairB, k => {
        if (k === S.prefs.pairA) S.prefs.pairA = S.prefs.pairB;
        S.prefs.pairB = k; save(); renderSetup();
      });
      const best = bestFor(S.prefs.pairA, S.prefs.pairB);
      $('oBestLine').textContent = best != null ? `Your best for ${S.prefs.pairA} and ${S.prefs.pairB}: ${best} changes` : ' ';
    }
    const canon = (a, b) => [a, b].sort().join(' ⇄ ');
    const bestFor = (a, b) => (S.minute[canon(a, b)] || {}).best;
    function panel(which) { $('oSetup').hidden = which !== 'setup'; $('oRun').hidden = which !== 'run'; $('oDone').hidden = which !== 'done'; }

    async function start() {
      if (!(await startMic())) return;
      run = {
        a: S.prefs.pairA, b: S.prefs.pairB, expect: Math.random() < 0.5 ? 0 : 1, count: 0, hold: holdTimer(),
        startAt: performance.now() + 3000, endAt: performance.now() + 63000,
      };
      $('oCount').textContent = '0';
      setChord(run.expect ? run.b : run.a);
      panel('run');
      run.raf = requestAnimationFrame(draw);
    }
    function setChord(k) { $('oNow').textContent = k; $('oDia').innerHTML = diagram(M.CHORD_BY_KEY[k]); }
    function draw() {
      if (!run) return;
      const now = performance.now();
      if (now < run.startAt) $('oTimer').textContent = 'Ready… ' + Math.ceil((run.startAt - now) / 1000);
      else $('oTimer').textContent = Math.max(0, Math.ceil((run.endAt - now) / 1000)) + 's';
      if (now >= run.endAt) { finish(); return; }
      run.raf = requestAnimationFrame(draw);
    }
    function onFrame(f) {
      if (!run || currentTab !== 'drills' || performance.now() < run.startAt) return;
      const key = run.expect ? run.b : run.a;
      const ok = isClean(f, M.CHORD_BY_KEY[key]);
      if (run.hold.add(ok, f.dt) >= 200) {
        run.count++; run.expect ^= 1; run.hold.reset(); S.clean++; markDay();
        $('oCount').textContent = run.count;
        setChord(run.expect ? run.b : run.a);
        const c = $('oRun'); c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash');
      }
    }
    Engine.listeners.add(onFrame);
    function finish() {
      const r = run; stop(false, true);
      const k = canon(r.a, r.b), prev = (S.minute[k] || {}).best;
      const isBest = prev == null || r.count > prev;
      if (isBest) S.minute[k] = { best: r.count, at: Date.now() };
      addRecent(`One minute ${r.a} ⇄ ${r.b}: ${r.count}`);
      save();
      $('oScore').textContent = r.count;
      $('oDoneLine').textContent = isBest && prev != null ? `New best! Previous: ${prev}.` : prev != null ? `Your best is ${prev}.` : 'First score saved. Beat it next time.';
      panel('done');
    }
    function stop(toSetup = true, finishing = false) {
      if (run) { cancelAnimationFrame(run.raf); run = null; }
      if (finishing) return;
      if (toSetup || !$('oRun').hidden) { panel('setup'); renderSetup(); }
    }
    $('oStart').addEventListener('click', start);
    $('oStop').addEventListener('click', () => stop(true));
    $('oAgain').addEventListener('click', () => { panel('setup'); renderSetup(); });
    renderSetup();
    return { stop, renderSetup };
  })();
  tabHandlers.drills = () => { Metro.renderSetup(); Minute.renderSetup(); };

  // ---------------------------------------------------------------- progress
  function ago(t) {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60); if (h < 24) return h + ' h ago';
    const d = Math.round(h / 24); return d === 1 ? 'yesterday' : d + ' days ago';
  }
  function list(el, rows, empty) {
    el.innerHTML = '';
    if (!rows.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = empty; el.appendChild(li); return; }
    rows.forEach(([a, b]) => {
      const li = document.createElement('li');
      const x = document.createElement('span'); x.textContent = a;
      const y = document.createElement('span'); y.className = 'when'; y.textContent = b;
      li.append(x, y); el.appendChild(li);
    });
  }
  tabHandlers.progress = () => {
    $('sStreak').textContent = streak();
    $('sDays').textContent = S.days.length;
    $('sClean').textContent = S.clean;
    list($('sMinute'), Object.entries(S.minute).sort((a, b) => b[1].best - a[1].best).map(([k, v]) => [`${k}: ${v.best}`, ago(v.at)]), 'No one-minute drills yet.');
    list($('sMetro'), Object.entries(S.metro).map(([k, v]) => [`${k} BPM: ${v.score}/${v.of}`, ago(v.at)]), 'No metronome drills yet.');
    list($('sRecent'), S.recent.map(r => [r.text, ago(r.at)]), 'Nothing yet. Go play!');
    $('sSens').value = S.prefs.sens;
    $('sStrict').checked = S.prefs.strictOpen;
    $('sDetail').checked = S.prefs.showDetail;
  };
  $('sSens').addEventListener('input', e => { S.prefs.sens = +e.target.value; save(); });
  $('sStrict').addEventListener('change', e => { S.prefs.strictOpen = e.target.checked; save(); });
  $('sDetail').addEventListener('change', e => { S.prefs.showDetail = e.target.checked; save(); if (!e.target.checked) $('pDetail').hidden = true; });
  $('sReset').addEventListener('click', () => { $('sResetConfirm').hidden = false; });
  $('sResetNo').addEventListener('click', () => { $('sResetConfirm').hidden = true; });
  $('sResetYes').addEventListener('click', () => {
    const prefs = S.prefs; S = defaults(); S.prefs = prefs; save();
    $('sResetConfirm').hidden = true; tabHandlers.progress(); toast('Progress reset.');
  });
  window.addEventListener('pagehide', () => Practice.finish());

  // ---------------------------------------------------------------- test harness (?test)
  if (new URLSearchParams(location.search).has('test')) {
    window.__fretTestMode = true;
    window.fretTest = {
      Engine, S,
      start: () => Engine.start(true),
      chord(key) { pluck(M.chordNotesMidi(M.CHORD_BY_KEY[key]).map(M.midiToFreq), { dest: Engine.analyser, gain: 0.6, dur: 3 }); },
      note(freq) { pluck([freq], { dest: Engine.analyser, gain: 0.5, dur: 3 }); },
      frets(frets, dest) { pluck(frets.map((f, i) => (f < 0 ? null : M.midiToFreq(M.STRINGS[i].midi + f))).filter(Boolean), { dest: dest || Engine.analyser, gain: 0.6, dur: 3 }); },
    };
  }

  // ---------------------------------------------------------------- boot
  let startTab = 'tune';
  try { startTab = localStorage.getItem('fretwise.tab') || 'tune'; } catch (e) { /* ignore */ }
  showTab(['tune', 'chords', 'drills', 'progress'].includes(startTab) ? startTab : 'tune');
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
