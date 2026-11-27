# Fretwise

A small guitar practice web app for beginners: tuner, chord practice and chord-change drills
(metronome-paced and one-minute changes). It runs in Chrome on Android and keeps progress in
the phone's browser storage. There's no account and nothing is sent anywhere.

## Files

| File | What it is |
|---|---|
| `index.html`, `app.css`, `app.js` | The app |
| `music.js` | Chord shapes, pitch detection (YIN) and chord matching (chroma) |
| `sw.js`, `manifest.webmanifest`, `icon*` | Offline cache and "Add to Home screen" support |
| `test/detect.test.js` | Synthetic detection tests: `node test/detect.test.js` |

## Getting it on your phone

Browsers only allow the microphone on **https** pages (or `localhost`), so the app has to
be opened through one of these routes.

### Option A: GitHub Pages (permanent, recommended)
1. Create a free GitHub account and a new public repository, for example `fretwise`.
2. Upload all files in this folder except `test/`, `.claude/` and this README if you like.
3. Go to the repo's Settings → Pages, pick "Deploy from a branch", branch `main`, folder `/`.
4. After a minute, open `https://<your-user>.github.io/fretwise/` in Chrome on the phone.
5. Chrome menu (⋮) → **Add to Home screen** (or **Install app**).

### Option B: quick test over home Wi-Fi (no account)
1. On the computer, in this folder: `python3 -m http.server 8000`
2. On the phone, open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`,
   enter `http://192.168.0.37:8000` (the computer's address), set it to **Enabled** and relaunch Chrome.
3. Open `http://192.168.0.37:8000`. This only works while the computer is on and serving.

### Option C: USB cable
With USB debugging on: `adb reverse tcp:8000 tcp:8000`, then open `http://localhost:8000` on the phone.

## Tips for good detection
- Put the phone 30–60 cm from the guitar, in a quiet room.
- Strum once and let the chord ring. Muted or buzzing strings show up as "Missing …".
- If strums aren't picked up, raise **Mic sensitivity** under Progress → Settings.
- Detection is deliberately lenient. G7 also counts as G, and Fmaj7 as F.
- Every open string in a chord shape must ring (checked string by string at its exact pitch).
  If clean chords keep getting rejected, switch off **Require open strings to ring** in Settings.
- Metronome drills play your chosen chords in a new random order every time (never the same chord twice in a row).

## Updating
After changing files, bump `VERSION` in `sw.js` so installed copies fetch the new version.
