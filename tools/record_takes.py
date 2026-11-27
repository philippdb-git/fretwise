#!/usr/bin/env python3
"""Guided recording of guitar takes for Fretwise detection tests.

Each take: press Enter, wait for the countdown, strum once and let it ring.
Commands at the prompt: Enter = record, r = redo previous take, s = skip, q = quit.
"""
import os, signal, subprocess, sys, time

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'recordings')
DEVICE = 'plughw:CARD=Microphone,DEV=0'  # Trust GXT 232 USB mic
SECONDS = 4

STRINGS = ['low E', 'A', 'D', 'G', 'B', 'high E']
CHORDS = {  # low E -> high e, -1 = not played
    'C':  [-1, 3, 2, 0, 1, 0],
    'G':  [3, 2, 0, 0, 0, 3],
    'D':  [-1, -1, 0, 2, 3, 2],
    'Em': [0, 2, 2, 0, 0, 0],
    'Am': [-1, 0, 2, 2, 1, 0],
}

def takes():
    for name, frets in CHORDS.items():
        yield f'{name}_clean_1', f'{name}: play it CLEAN'
        for s, f in enumerate(frets):
            if f == 0:
                yield f'{name}_mute-open-{s}', f'{name}: lightly touch the open {STRINGS[s]} string so it does NOT ring'
        for s, f in enumerate(frets):
            if f > 0:
                yield f'{name}_unpressed-{s}', f'{name}: finger on the {STRINGS[s]} string (fret {f}) only resting, NOT pressed down'
        yield f'{name}_clean_2', f'{name}: play it CLEAN again'

def record(path):
    subprocess.run(['arecord', '-q', '-D', DEVICE, '-f', 'S16_LE', '-r', '48000', '-c', '1',
                    '-d', str(SECONDS), path], check=False)

def main():
    os.makedirs(OUT, exist_ok=True)
    plan = list(takes())
    print(f'\n{len(plan)} takes, {SECONDS} s each. Hold the guitar about 50 cm from the microphone.')
    print('Enter = record   r = redo previous   s = skip   q = quit\n')
    i = 0
    while i < len(plan):
        tag, text = plan[i]
        cmd = input(f'[{i + 1}/{len(plan)}] {text}  > ').strip().lower()
        if cmd == 'q':
            break
        if cmd == 's':
            i += 1; continue
        if cmd == 'r':
            i = max(0, i - 1); continue
        for n in (3, 2, 1):
            print(f'   {n}…', flush=True); time.sleep(0.6)
        print('   >>> STRUM NOW <<<', flush=True)
        path = os.path.join(OUT, tag + '.wav')
        record(path)
        print(f'   saved {os.path.basename(path)}\n')
        i += 1
    print('Done. Tell Claude in the chat that the recordings are ready.')

if __name__ == '__main__':
    main()
