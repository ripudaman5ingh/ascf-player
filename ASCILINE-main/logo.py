#!/usr/bin/env python3
"""
ASCILINE logo.

Prints the ASCILINE wordmark as an ANSI-shadow block banner. With --animate it
glitches the letters through ASCILINE's own density ramp (@%#*+=-:.) in the
terminal -- the logo doing what the engine does.

Usage:
    python logo.py              # print the static banner
    python logo.py --animate    # run the density-ramp glitch (Ctrl-C to stop)
    python logo.py --no-color   # plain, no ANSI color
"""
import sys
import time
import random
import shutil
import os

# Enable ANSI escape codes on Windows terminal
if os.name == 'nt':
    os.system("")

# Static wordmark + play arrow, rendered once (ANSI-shadow). Kept inline so the
# script has zero dependencies.
WORDMARK = r"""
 █████╗ ███████╗ ██████╗██╗██╗     ██╗███╗   ██╗███████╗  ██
██╔══██╗██╔════╝██╔════╝██║██║     ██║████╗  ██║██╔════╝  █████
███████║███████╗██║     ██║██║     ██║██╔██╗ ██║█████╗    ████████
██╔══██║╚════██║██║     ██║██║     ██║██║╚██╗██║██╔══╝    ████████
██║  ██║███████║╚██████╗██║███████╗██║██║ ╚████║███████╗  █████
╚═╝  ╚═╝╚══════╝ ╚═════╝╚═╝╚══════╝╚═╝╚═╝  ╚═══╝╚══════╝  ██
""".strip("\n")

RAMP = "@%#*+=-:."  # ASCILINE's density ramp = the glitch alphabet

# Column ranges of each glyph (incl. the play arrow), used to glitch one at a time.
LETTERS = [
    (0, 7), (8, 15), (16, 23), (24, 26), (27, 34),
    (35, 37), (38, 47), (48, 55), (58, 65),
]

CYAN, DIM, RESET = "\033[36m", "\033[2m", "\033[0m"
HOLD_SECONDS = 0.1  # beat to hold the fully glitched wordmark before restoring


def _color(s, code, enabled):
    return f"{code}{s}{RESET}" if enabled else s


def render_static(color=True):
    out = _color(WORDMARK, CYAN, color)
    return f"{out}\n"


def animate(color=True, seconds=None):
    """Glitch random letters through the density ramp until interrupted."""
    rows = WORDMARK.split("\n")
    width = max(len(r) for r in rows)
    grid = [list(r.ljust(width)) for r in rows]
    home = "\033[H"
    sys.stdout.write("\033[2J\033[?25l")  # clear + hide cursor
    start = time.time()
    try:
        while seconds is None or time.time() - start < seconds:
            # Sweep left to right, turning letters into ASCII
            glitched_letters = set()
            for lo, hi in LETTERS:
                glitched_letters.add((lo, hi))
                steps = random.randint(2, 4)
                for s in range(steps):
                    frame = []
                    for r, row in enumerate(grid):
                        line = []
                        for c, ch in enumerate(row):
                            is_glitching = any(l <= c <= h for l, h in glitched_letters)
                            if r < 6 and ch != " " and is_glitching and random.random() < 0.8:
                                line.append(RAMP[random.randrange(len(RAMP))])
                            else:
                                line.append(ch)
                        frame.append("".join(line))
                    art = "\n".join(frame)
                    sys.stdout.write(home + _color(art, CYAN, color) + "\n")
                    sys.stdout.flush()
                    time.sleep(0.06)
            
            # Hold the fully glitched state for a moment
            time.sleep(HOLD_SECONDS)

            # Sweep left to right, restoring letters to normal
            for lo, hi in LETTERS:
                glitched_letters.remove((lo, hi))
                steps = random.randint(2, 4)
                for s in range(steps):
                    frame = []
                    for r, row in enumerate(grid):
                        line = []
                        for c, ch in enumerate(row):
                            is_glitching = any(l <= c <= h for l, h in glitched_letters)
                            if r < 6 and ch != " " and is_glitching and random.random() < 0.8:
                                line.append(RAMP[random.randrange(len(RAMP))])
                            else:
                                line.append(ch)
                        frame.append("".join(line))
                    art = "\n".join(frame)
                    sys.stdout.write(home + _color(art, CYAN, color) + "\n")
                    sys.stdout.flush()
                    time.sleep(0.07)

            # Post-wave intense single-letter glitches (Original style)
            num_glitches = random.randint(2, 4)
            for _ in range(num_glitches):
                lo, hi = random.choice(LETTERS)
                steps = random.randint(4, 7)
                for s in range(steps):
                    frame = []
                    for r, row in enumerate(grid):
                        line = []
                        for c, ch in enumerate(row):
                            if r < 6 and ch != " " and lo <= c <= hi and random.random() < 0.65:
                                line.append(RAMP[random.randrange(len(RAMP))])
                            else:
                                line.append(ch)
                        frame.append("".join(line))
                    art = "\n".join(frame)
                    sys.stdout.write(home + _color(art, CYAN, color) + "\n")
                    sys.stdout.flush()
                    time.sleep(0.06)
                
                # Settle back to clean between glitches
                sys.stdout.write(home + _color(WORDMARK, CYAN, color) + "\n")
                sys.stdout.flush()
                time.sleep(random.uniform(0.3, 0.8))
    except KeyboardInterrupt:
        pass
    finally:
        sys.stdout.write("\033[?25h")  # restore cursor
        sys.stdout.flush()


def main(argv):
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    
    color = "--no-color" not in argv
    if "--animate" in argv:
        animate(color=color)
    else:
        print(render_static(color=color))


if __name__ == "__main__":
    main(sys.argv[1:])
