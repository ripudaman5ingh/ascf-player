# ascf-player

A zero-dependency Web Component that plays `.ascf` clips on a `<canvas>`, the way asciinema plays terminal
recordings — plus a local convert-and-play portal that turns an `.mp4` into an `.ascf` and plays it.

No `<video>` tag, no browser codec, **no autoplay restrictions** — the picture is just cells painted on a
canvas, so it starts without a user gesture. Only audio (a separate `.mp3`) needs one, per browser policy.

## Local convert-and-play portal

Drop an `.mp4` in the browser; a small Python backend runs the bundled compiler
(`ASCILINE-main/compiler.py`) and the page plays the resulting `.ascf` with `<ascf-player>`.

**This is a local app, not a static site** — it needs **Python 3.9+** and **FFmpeg** installed, because the
conversion runs FFmpeg + OpenCV on your machine.

Make sure **ffmpeg** is on your PATH (e.g. `brew install ffmpeg`), then:

```sh
./start.sh            # first run makes the venv + installs deps, starts the
                      # portal on http://localhost:8000, and opens the browser
```

Or do it by hand:

```sh
python3 -m venv .venv
.venv/bin/pip install -r ASCILINE-main/requirements.txt   # numpy + opencv-python
.venv/bin/python portal.py                                # serves http://localhost:8000
open http://localhost:8000                                # Linux: xdg-open, Windows: start
```

Every upload is compiled with `compiler.py <file>.mp4 --cols 700 --pixel --quantize 0`. Output `.ascf`
(and `.mp3` if the video had audio) land in `ASCILINE-main/static_player/`; the page auto-plays the result
and offers a **Download .ascf** button.

## Embed

```html
<script type="module" src="https://unpkg.com/ascf-player"></script>

<ascf-player src="clip.ascf" controls autoplay loop></ascf-player>
```

Script tag instead of a module (defines `<ascf-player>`, plus `window.AscfPlayer`):

```html
<script src="https://unpkg.com/ascf-player/dist/ascf-player.js"></script>
```

npm:

```sh
npm install ascf-player
```

```js
import 'ascf-player';                              // registers <ascf-player>
import { openAscf } from 'ascf-player/decoder';    // DOM-free decoder, works in Node/workers too
```

## Attributes

| Attribute | Meaning |
|---|---|
| `src` | URL of the `.ascf` file (required) |
| `audio` | URL of the companion `.mp3`, if the clip has sound |
| `controls` | show the play / seek / mute bar |
| `autoplay` | start as soon as it connects (visuals always allowed) |
| `loop` | restart at the end |
| `muted` | start muted — pairs with `autoplay` for sound-on-click |

Setting an attribute at runtime works too; `src` reloads the clip.

## JS API

```js
const p = document.querySelector('ascf-player');
p.play(); p.pause();
p.currentTime = 5;        // seeks (re-decodes — see note below)
p.duration; p.paused; p.muted; p.loop; p.volume;
p.metadata;               // { fps, cols, rows, renderMode, pixelMode, totalFrames, duration }
```

Events: `loadedmetadata`, `play`, `pause`, `timeupdate`, `seeked`, `ended`, `error`.

Autoplay with sound the moment the visitor clicks anywhere on the player:

```html
<ascf-player src="clip.ascf" audio="clip.mp3" controls autoplay muted loop></ascf-player>
```

If audio playback is blocked, the picture keeps running and the mute button flips to "unmute" — the next
click on the player starts the track.

## Theming

Everything is a CSS custom property on the host, so one clip can match any site:

```css
ascf-player {
  --ascf-background: #0b0d10;       /* canvas + host backdrop */
  --ascf-color: #d0d0d0;            /* text colour in plain-text render mode */
  --ascf-radius: 14px;
  --ascf-accent: #f472b6;           /* seek bar / focus ring */
  --ascf-fit: contain;              /* object-fit of the canvas */
  --ascf-image-rendering: pixelated;
  --ascf-font-family: "Courier New", monospace;  /* ASCII cell font */
  --ascf-font-weight: bold;
  --ascf-controls-background: linear-gradient(transparent, rgba(0,0,0,.65));
  --ascf-controls-color: currentColor;
  --ascf-controls-font: 500 12px/1 ui-monospace, monospace;
  --ascf-controls-padding: .4rem .6rem;
  --ascf-controls-opacity: 1;
  --ascf-button-size: 14px;
}
```

Shadow parts are exposed for anything the properties don't cover:
`::part(canvas)`, `::part(controls)`, `::part(button)`, `::part(play)`, `::part(mute)`, `::part(seek)`,
`::part(time)`.

## The decoder on its own

`src/decoder.js` has no `document`, no `canvas` and no `fetch` — hand it a `ReadableStream<Uint8Array>`,
a `Uint8Array` or an `ArrayBuffer` and it gives you the header plus an async iterator of frames. It runs
in a browser, a worker, or Node 18+ (it uses the platform's `DecompressionStream`).

```js
import { openAscf } from 'ascf-player/decoder';

const clip = await openAscf((await fetch('clip.ascf')).body);
console.log(clip.cols, clip.rows, clip.fps, clip.totalFrames);

for await (const frame of clip.frames()) {
  // frame.index, frame.time, and either
  //   frame.data — full framebuffer: 3 bytes/cell BGR (pixel mode) or 4 bytes/cell [char, R, G, B]
  //   frame.text — plain ASCII art, for render mode 1
}
```

Frames must be consumed in order: `DELTA` frames patch the previous one.

Format, for reference (all big-endian in the header):

```
header 18B  'ASC2' | fps f32 | renderMode u8 | pixelMode u8 | cols u16 | rows u16 | totalFrames u32
header 14B  'ASCF' — legacy, no totalFrames
per frame   [len u32][frameIndex u32][tag u8][payload]
            tag 0 RAW · 1 ZLIB · 2 DELTA (deflate: indices u32LE ++ changed cells) · 3 RLE_FULL
```

## Notes / limits

- **Seeking** re-opens the stream and re-decodes up to the target when the seek lands outside the frame
  buffer — `.ascf` has no keyframe index, so there's nothing to seek to. Fine for clips; noticeable on
  long ones.
- **`PROFILE` frames (tag 4)** from ASCILINE's lossy DCT mode are not decoded; the previous frame is held
  instead of failing.

## Demo & dev

```sh
npm run demo   # http://localhost:8080/demo/  — plays demo/test.ascf
npm test       # decodes the real test.ascf headlessly, plus a synthetic all-codecs clip
npm run build  # regenerate dist/ascf-player.js
```

MIT
# ascf-player
