#!/usr/bin/env python3
"""Per-frame depth companion for .ascf clips (Depth Anything V2).

Produces a .depth file alongside the .ascf: one uint8 depth value per cell,
same cols x rows grid and frame order as the color clip.

Format (all big-endian, matches .ascf conventions):
  b"DPTH" | cols u16 | rows u16 | count u32     (12-byte header)
  then count * (cols*rows) bytes, row-major top->bottom.

The model loads ONCE per process (module-global). Frames come from ffmpeg at
the .ascf's own fps so depth lines up with the color cells frame-for-frame.
"""
import json
import struct
import subprocess

import numpy as np

MODEL = "depth-anything/Depth-Anything-V2-Small-hf"
_pipe = None


def _get_pipe():
    global _pipe
    if _pipe is None:
        from transformers import pipeline  # heavy import, deferred to first use
        _pipe = pipeline("depth-estimation", model=MODEL, device="mps")
    return _pipe


def _probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "json", path],
        capture_output=True, text=True, check=True,
    )
    s = json.loads(out.stdout)["streams"][0]
    return int(s["width"]), int(s["height"])


def _frames_depth(mp4, cols, rows, fps):
    """Yield a rows x cols uint8 depth grid per sampled frame."""
    from PIL import Image
    w, h = _probe(mp4)
    pipe = _get_pipe()
    proc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", mp4, "-vf", f"fps={fps}",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE,
    )
    fb = w * h * 3
    try:
        while True:
            buf = proc.stdout.read(fb)
            if len(buf) < fb:
                break  # partial tail == end of stream
            img = Image.frombytes("RGB", (w, h), buf)
            depth = pipe(img)["depth"].convert("L").resize((cols, rows))  # (W,H)
            yield np.asarray(depth, dtype=np.uint8)
    finally:
        proc.stdout.close()
        proc.wait()


def write_depth_file(path, cols, rows, grids, total=0, progress=lambda m: None):
    """Stream depth grids to disk; header count is back-patched at the end."""
    count = 0
    with open(path, "wb") as f:
        f.write(b"DPTH" + struct.pack(">HHI", cols, rows, 0))  # count placeholder
        for g in grids:
            f.write(np.asarray(g, dtype=np.uint8).tobytes())
            count += 1
            if count % 10 == 0 or count == total:
                progress(f"depth {count}/{total or '?'}")
        f.seek(4)
        f.write(struct.pack(">HHI", cols, rows, count))
    return count


def generate_depth(mp4, cols, rows, fps, path, total=0, progress=lambda m: None):
    return write_depth_file(path, cols, rows,
                            _frames_depth(mp4, cols, rows, fps), total, progress)


def _read(path):
    with open(path, "rb") as f:
        b = f.read()
    assert b[:4] == b"DPTH", "bad magic"
    cols, rows, n = struct.unpack(">HHI", b[4:12])
    return cols, rows, n, b[12:]


if __name__ == "__main__":
    # Format round-trip check — no model, no ffmpeg.
    import os
    import tempfile
    p = tempfile.mktemp(suffix=".depth")
    grids = [np.full((3, 4), v, np.uint8) for v in (10, 200)]
    n = write_depth_file(p, 4, 3, grids)
    cols, rows, cnt, payload = _read(p)
    assert (cols, rows, cnt, n) == (4, 3, 2, 2), (cols, rows, cnt, n)
    assert len(payload) == 2 * 4 * 3 and payload[0] == 10 and payload[12] == 200
    os.unlink(p)
    print("depth format ok")
