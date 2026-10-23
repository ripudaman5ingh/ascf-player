#!/usr/bin/env python3
"""Local convert-and-play portal for .ascf clips.

Drop an .mp4 -> runs the ASCILINE compiler -> plays the .ascf in <ascf-player>.
Local app: needs Python + FFmpeg. Run with the interpreter that has the
compiler's deps installed (see README): python3 portal.py
"""
import http.server
import json
import os
import re
import struct
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.abspath(__file__))
ASCILINE = os.path.join(ROOT, "ASCILINE-main")
COMPILER = os.path.join(ASCILINE, "compiler.py")
OUT_DIR = os.path.join(ASCILINE, "static_player")

# Fixed compile settings, as requested.
COMPILE_ARGS = ["--cols", "700", "--pixel", "--quantize", "2"]


def ascf_meta(path):
    """(fps, cols, rows, totalFrames) from an ASC2 .ascf header."""
    with open(path, "rb") as f:
        h = f.read(18)
    return (struct.unpack(">f", h[4:8])[0],
            struct.unpack(">H", h[10:12])[0],
            struct.unpack(">H", h[12:14])[0],
            struct.unpack(">I", h[14:18])[0])


def convert(mp4_path, out_name, with_depth=True):
    """Run the compiler on mp4_path. Returns (ascf, mp3|None, depth|None)."""
    subprocess.run(
        [sys.executable, COMPILER, mp4_path, *COMPILE_ARGS, "--out", out_name],
        cwd=ASCILINE, check=True,
    )
    ascf = f"{out_name}.ascf"
    mp3 = f"{out_name}.mp3"
    if not os.path.exists(os.path.join(OUT_DIR, ascf)):
        raise RuntimeError("compiler produced no .ascf")
    mp3 = mp3 if os.path.exists(os.path.join(OUT_DIR, mp3)) else None

    depth = None
    if with_depth:
        # Best-effort: a depth failure must never sink the .ascf/.mp3 flow.
        try:
            import depth as depthmod
            fps, cols, rows, total = ascf_meta(os.path.join(OUT_DIR, ascf))
            dname = f"{out_name}.depth"
            n = depthmod.generate_depth(
                mp4_path, cols, rows, fps, os.path.join(OUT_DIR, dname),
                total, progress=lambda m: print(m, flush=True))
            depth = dname
            print(f"depth done: {n} frames -> {dname}", flush=True)
        except Exception as e:  # noqa: BLE001 - degrade, don't fail the convert
            print(f"depth skipped: {e}", flush=True)
    return ascf, mp3, depth


def safe_name(raw):
    stem = os.path.splitext(os.path.basename(raw or "clip"))[0]
    stem = re.sub(r"[^A-Za-z0-9_-]", "_", stem).strip("_")
    return stem or "clip"


class Handler(http.server.BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/octet-stream"):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/":
            with open(os.path.join(ROOT, "portal.html"), "rb") as f:
                return self._send(200, f.read(), "text/html; charset=utf-8")
        if path == "/player.js":
            with open(os.path.join(ROOT, "dist", "ascf-player.js"), "rb") as f:
                return self._send(200, f.read(), "text/javascript")
        if path.startswith("/out/"):
            name = os.path.basename(path)  # strips any traversal
            fp = os.path.join(OUT_DIR, name)
            if os.path.isfile(fp):
                ctype = "audio/mpeg" if name.endswith(".mp3") else "application/octet-stream"
                with open(fp, "rb") as f:
                    return self._send(200, f.read(), ctype)
            return self._send(404, "not found", "text/plain")
        return self._send(404, "not found", "text/plain")

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/convert":
            return self._send(404, "not found", "text/plain")
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0:
            return self._send(400, "empty upload", "text/plain")
        raw_name = self.path.split("name=", 1)[1] if "name=" in self.path else "clip.mp4"
        out_name = safe_name(raw_name)
        fd, tmp = tempfile.mkstemp(suffix=".mp4")
        try:
            with os.fdopen(fd, "wb") as f:
                remaining = length
                while remaining:
                    chunk = self.rfile.read(min(1 << 20, remaining))
                    if not chunk:
                        break
                    f.write(chunk)
                    remaining -= len(chunk)
            ascf, mp3, depth = convert(tmp, out_name)
            self._send(200, json.dumps({
                "ascf": f"/out/{ascf}",
                "mp3": f"/out/{mp3}" if mp3 else None,
                "depth": f"/out/{depth}" if depth else None,
                "download": ascf,
            }), "application/json")
        except subprocess.CalledProcessError as e:
            self._send(500, f"compile failed: {e}", "text/plain")
        except Exception as e:  # noqa: BLE001 - report anything to the browser
            self._send(500, f"error: {e}", "text/plain")
        finally:
            os.unlink(tmp)


def selftest():
    """Generate a tiny clip via ffmpeg and run the compile path."""
    fd, mp4 = tempfile.mkstemp(suffix=".mp4")
    os.close(fd)
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i",
         "testsrc=duration=1:size=160x120:rate=10", "-pix_fmt", "yuv420p", mp4],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        ascf, _, _ = convert(mp4, "selftest", with_depth=False)
        assert os.path.exists(os.path.join(OUT_DIR, ascf)), "no .ascf produced"
        assert safe_name("../../etc/passwd.mp4") == "passwd"
        print("selftest ok:", ascf)
    finally:
        os.unlink(mp4)
        os.remove(os.path.join(OUT_DIR, "selftest.ascf"))


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    port = 8000
    os.makedirs(OUT_DIR, exist_ok=True)
    print(f"Portal running at http://localhost:{port}  (Ctrl-C to stop)")
    http.server.HTTPServer(("127.0.0.1", port), Handler).serve_forever()
