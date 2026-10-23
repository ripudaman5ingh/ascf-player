/**
 * <ascf-player> — plays ASCILINE .ascf clips on a canvas.
 *
 *   <ascf-player src="clip.ascf" audio="clip.mp3" controls loop autoplay></ascf-player>
 *
 * Decoding lives in ./decoder.js (DOM-free); this file only fetches, paints and
 * exposes the media API. Visuals autoplay freely — it's a canvas, not <video> —
 * audio still needs a user gesture, so a blocked audio track leaves the picture
 * running and flags the unmute button.
 */
import { openAscf } from './decoder.js';

const TEMPLATE = `
<style>
  :host {
    display: block;
    position: relative;
    background: var(--ascf-background, #050505);
    border-radius: var(--ascf-radius, 0);
    overflow: hidden;
    color: var(--ascf-color, #d0d0d0);
    font-family: var(--ascf-ui-font, system-ui, sans-serif);
  }
  :host([hidden]) { display: none; }
  [hidden] { display: none !important; }   /* all:unset below would otherwise revive hidden buttons */
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: var(--ascf-fit, contain);
    image-rendering: var(--ascf-image-rendering, pixelated);
  }
  .controls {
    position: absolute;
    inset: auto 0 0 0;
    display: flex;
    align-items: center;
    gap: .5rem;
    padding: var(--ascf-controls-padding, .4rem .6rem);
    background: var(--ascf-controls-background, linear-gradient(transparent, rgba(0,0,0,.65)));
    color: var(--ascf-controls-color, currentColor);
    font: var(--ascf-controls-font, 500 12px/1 ui-monospace, monospace);
    opacity: var(--ascf-controls-opacity, 1);
    transition: opacity .2s;
  }
  .controls[hidden] { display: none; }
  button {
    all: unset;
    cursor: pointer;
    padding: 0 .25rem;
    line-height: 1;
    font-size: var(--ascf-button-size, 14px);
  }
  button:focus-visible { outline: 2px solid var(--ascf-accent, #4af); }
  input[type=range] {
    flex: 1;
    min-width: 3rem;
    accent-color: var(--ascf-accent, #4af);
    cursor: pointer;
  }
  .time { font-variant-numeric: tabular-nums; white-space: nowrap; }
</style>
<canvas part="canvas"></canvas>
<div class="controls" part="controls" hidden>
  <button part="button play" class="pp" aria-label="Play">&#9654;</button>
  <input part="seek" class="seek" type="range" min="0" max="1" step="0.01" value="0" aria-label="Seek">
  <span part="time" class="time">0:00</span>
  <button part="button mute" class="mute" aria-label="Mute" hidden>&#128266;</button>
</div>
<audio class="audio" hidden></audio>
`;

const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export class AscfPlayer extends HTMLElement {
  static observedAttributes = ['src', 'audio', 'controls', 'muted', 'loop'];

  #root; #canvas; #ctx; #audioEl; #ui;
  #header = null;
  #buf = [];
  #streamDone = true;
  #abort = null;
  #raf = 0;
  #paused = true;
  #base = 0;          // clock value when the current play run started
  #t0 = 0;            // performance.now() at that moment
  #time = 0;
  #skipUntil = 0;     // frames before this are decoded but not shown (seek)
  #audioBlocked = false;
  #lastEmit = 0;
  #lastTick = 0;
  #starting = null;
  #imageData = null;
  #charW = 0;
  #font = '';

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.innerHTML = TEMPLATE;
    this.#canvas = this.#root.querySelector('canvas');
    this.#ctx = this.#canvas.getContext('2d');
    this.#audioEl = this.#root.querySelector('.audio');
    this.#ui = {
      bar: this.#root.querySelector('.controls'),
      pp: this.#root.querySelector('.pp'),
      seek: this.#root.querySelector('.seek'),
      time: this.#root.querySelector('.time'),
      mute: this.#root.querySelector('.mute'),
    };

    this.#ui.pp.addEventListener('click', () => (this.paused ? this.play() : this.pause()));
    this.#ui.mute.addEventListener('click', () => { this.muted = !this.muted; });
    this.#ui.seek.addEventListener('input', (e) => {
      if (this.duration) this.currentTime = Number(e.target.value) * this.duration;
    });
    // A click anywhere is the gesture that lets blocked audio start.
    this.addEventListener('click', (e) => {
      if (this.#audioBlocked) this.#startAudio();
      else if (!e.composedPath().includes(this.#ui.bar) && !this.hasAttribute('controls')) {
        this.paused ? this.play() : this.pause();
      }
    });
  }

  connectedCallback() {
    this.#ui.bar.hidden = !this.hasAttribute('controls');
    if (this.src && this.hasAttribute('autoplay')) this.play();
  }

  disconnectedCallback() { this.#stop(); }

  attributeChangedCallback(name, old, val) {
    if (old === val) return;
    if (name === 'src') {
      this.#stop();
      this.#header = null;
      this.#time = 0;
      if (this.isConnected && this.hasAttribute('autoplay')) this.play();
    }
    if (name === 'audio') this.#audioEl.src = val || '';
    if (name === 'controls') this.#ui.bar.hidden = val === null;
    if (name === 'muted') this.#audioEl.muted = val !== null;
  }

  // ---- media API ----
  get src() { return this.getAttribute('src'); }
  set src(v) { this.setAttribute('src', v); }
  get audio() { return this.getAttribute('audio'); }
  set audio(v) { v == null ? this.removeAttribute('audio') : this.setAttribute('audio', v); }
  get loop() { return this.hasAttribute('loop'); }
  set loop(v) { this.toggleAttribute('loop', !!v); }
  get muted() { return this.hasAttribute('muted'); }
  set muted(v) { this.toggleAttribute('muted', !!v); this.#syncUI(); }
  get volume() { return this.#audioEl.volume; }
  set volume(v) { this.#audioEl.volume = v; }
  get paused() { return this.#paused; }
  get duration() { return this.#header ? this.#header.duration : 0; }
  get currentTime() { return this.#time; }
  set currentTime(t) { this.#seek(t); }
  /** Frames per second and grid size of the loaded clip (null until metadata). */
  get metadata() { return this.#header; }

  async play() {
    if (!this.src) return;
    // Serialised: connectedCallback and attributeChangedCallback can both land here,
    // and two concurrent opens would abort each other's stream.
    if (this.#starting) return this.#starting;
    this.#paused = false;
    this.#starting = (async () => {
      if (!this.#header || (this.#streamDone && !this.#buf.length)) await this.#open(this.#time);
      this.#t0 = performance.now();
      this.#base = this.#time;
      this.#startAudio();
      this.#syncUI();
      this.dispatchEvent(new Event('play'));
      if (!this.#raf && !this.#paused) this.#raf = requestAnimationFrame(this.#tick);
    })();
    try { await this.#starting; } finally { this.#starting = null; }
  }

  pause() {
    if (this.#paused) return;
    this.#time = this.#clock(performance.now());
    this.#paused = true;
    cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    this.#audioEl.pause();
    this.#syncUI();
    this.dispatchEvent(new Event('pause'));
  }

  // ---- internals ----
  #startAudio() {
    if (!this.audio) return;
    if (this.#audioEl.src !== new URL(this.audio, location.href).href) this.#audioEl.src = this.audio;
    this.#audioEl.muted = this.muted;
    if (Math.abs(this.#audioEl.currentTime - this.#time) > 0.3) this.#audioEl.currentTime = this.#time;
    this.#audioEl.play().then(
      () => { this.#audioBlocked = false; this.#syncUI(); },
      () => { this.#audioBlocked = true; this.#syncUI(); }, // needs a user gesture; picture keeps playing
    );
  }

  #stop() {
    cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    if (this.#abort) this.#abort.abort();
    this.#abort = null;
    this.#buf = [];
    this.#streamDone = true;
    this.#audioEl.pause();
  }

  async #open(startAt = 0) {
    this.#stop();
    this.#paused = false;
    this.#skipUntil = startAt;
    this.#time = startAt;
    const abort = new AbortController();
    this.#abort = abort;
    let clip;
    try {
      const res = await fetch(this.src, { signal: abort.signal });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      clip = await openAscf(res.body);
    } catch (err) {
      if (err.name !== 'AbortError') {
        this.dispatchEvent(new CustomEvent('error', { detail: err }));
        console.error('[ascf-player]', err);
      }
      return;
    }
    if (abort.signal.aborted) return;
    this.#header = clip;
    this.#setupCanvas(clip);
    this.dispatchEvent(new Event('loadedmetadata'));
    this.#streamDone = false;
    this.#pump(clip, abort);
  }

  async #pump(clip, abort) {
    try {
      for await (const frame of clip.frames()) {
        if (abort.signal.aborted) break;
        if (frame.time < this.#skipUntil) continue;   // decoded for state, not shown
        this.#buf.push(frame);
        while (this.#buf.length > 90 && !abort.signal.aborted) {
          await new Promise((r) => setTimeout(r, 40));
        }
      }
    } catch (err) {
      if (!abort.signal.aborted) console.error('[ascf-player]', err);
    }
    if (!abort.signal.aborted) this.#streamDone = true;
  }

  #seek(t) {
    const dur = this.duration;
    t = Math.max(0, dur ? Math.min(t, dur) : t);
    this.#time = t;
    this.#base = t;
    this.#t0 = performance.now();
    if (this.audio) this.#audioEl.currentTime = t;
    const buffered = this.#buf.length && this.#buf[0].time <= t && this.#buf[this.#buf.length - 1].time >= t;
    if (buffered) {
      while (this.#buf.length > 1 && this.#buf[0].time < t) this.#buf.shift();
    } else {
      // ponytail: .ascf has no seek index, so an out-of-buffer seek restarts the
      // stream and re-decodes up to the target. Add a keyframe index to the format
      // if scrubbing long clips has to be instant.
      const wasPaused = this.#paused;
      this.#open(t).then(() => { if (wasPaused) this.pause(); else this.play(); });
    }
    this.#syncUI();
    this.dispatchEvent(new Event('seeked'));
  }

  #clock(now) {
    if (this.audio && !this.#audioEl.paused && this.#audioEl.readyState >= 1) return this.#audioEl.currentTime;
    return this.#base + (now - this.#t0) / 1000;
  }

  #tick = (now) => {
    if (this.#paused) { this.#raf = 0; return; }
    this.#raf = requestAnimationFrame(this.#tick);
    const clock = this.#clock(now);

    if (!this.#buf.length) {
      // #abort is only set while a stream is live, so a tick that beats the first
      // fetch can't be mistaken for the end of the clip.
      if (this.#streamDone && this.#abort) this.#end();
      else { this.#t0 += now - (this.#lastTick || now); }   // stall the clock while buffering
      this.#lastTick = now;
      return;
    }
    this.#lastTick = now;

    while (this.#buf.length > 1 && this.#buf[0].time < clock - 0.1) this.#buf.shift();
    if (this.#buf[0].time > clock + 0.05) return;

    const frame = this.#buf.shift();
    this.#time = frame.time;
    this.#draw(frame);

    if (now - this.#lastEmit > 250) {
      this.#lastEmit = now;
      this.#syncUI();
      this.dispatchEvent(new Event('timeupdate'));
    }
  };

  #end() {
    if (this.loop) {
      this.#time = 0;
      this.#stop();          // play() reopens from the top and restarts the rAF loop
      this.play();
      return;
    }
    this.pause();
    this.dispatchEvent(new Event('ended'));
  }

  #setupCanvas(h) {
    const cs = getComputedStyle(this);
    const v = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
    if (h.pixelMode) {
      this.#canvas.width = h.cols;
      this.#canvas.height = h.rows;
      this.#imageData = this.#ctx.createImageData(h.cols, h.rows);
      const d = this.#imageData.data;
      for (let i = 3; i < d.length; i += 4) d[i] = 255;
    } else {
      this.#font = `${v('--ascf-font-weight', 'bold')} 8px ${v('--ascf-font-family', '"Courier New", monospace')}`;
      this.#ctx.font = this.#font;
      this.#charW = this.#ctx.measureText('M').width;
      this.#canvas.width = Math.round(h.cols * this.#charW);
      this.#canvas.height = h.rows * 8;
      this.#imageData = null;
    }
    this.style.aspectRatio ||= `${this.#canvas.width} / ${this.#canvas.height}`;
    this.#ctx.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
  }

  #draw(frame) {
    const h = this.#header;
    const ctx = this.#ctx;
    if (h.pixelMode) {
      const src = frame.data, dst = this.#imageData.data;
      for (let s = 0, d = 0; s < src.length; s += 3, d += 4) {
        dst[d] = src[s + 2]; dst[d + 1] = src[s + 1]; dst[d + 2] = src[s];   // BGR -> RGB
      }
      // Optional playback effect: a pure mutation of the decoded RGB grid. Set
      // player.pixelEffect = (imageData, {cols, rows, time}) => {} to hook in.
      if (this.pixelEffect) this.pixelEffect(this.#imageData, { cols: h.cols, rows: h.rows, time: this.#time });
      ctx.putImageData(this.#imageData, 0, 0);
      return;
    }

    const cs = getComputedStyle(this);
    ctx.fillStyle = cs.getPropertyValue('--ascf-background').trim() || '#050505';
    ctx.fillRect(0, 0, this.#canvas.width, this.#canvas.height);
    ctx.font = this.#font;
    ctx.textBaseline = 'top';

    if (h.renderMode === 1) {
      ctx.fillStyle = cs.color;
      frame.text.split('\n').forEach((line, r) => ctx.fillText(line, 0, r * 8));
      return;
    }

    const cells = frame.data;
    let col = 0, row = 0, prev = -1;
    for (let i = 0; i < cells.length; i += 4) {
      const packed = (cells[i + 1] << 16) | (cells[i + 2] << 8) | cells[i + 3];
      if (packed !== prev) {
        ctx.fillStyle = `rgb(${cells[i + 1]},${cells[i + 2]},${cells[i + 3]})`;
        prev = packed;
      }
      ctx.fillText(String.fromCharCode(cells[i]), col * this.#charW, row * 8);
      if (++col >= h.cols) { col = 0; row++; }
    }
  }

  #syncUI() {
    const { pp, seek, time, mute } = this.#ui;
    pp.innerHTML = this.#paused ? '&#9654;' : '&#10074;&#10074;';
    pp.setAttribute('aria-label', this.#paused ? 'Play' : 'Pause');
    mute.hidden = !this.audio;
    mute.innerHTML = this.muted || this.#audioBlocked ? '&#128263;' : '&#128266;';
    mute.setAttribute('aria-label', this.muted || this.#audioBlocked ? 'Unmute' : 'Mute');
    const dur = this.duration;
    if (document.activeElement !== this) seek.value = dur ? this.#time / dur : 0;
    time.textContent = dur ? `${fmt(this.#time)} / ${fmt(dur)}` : fmt(this.#time);
    this.#audioEl.muted = this.muted;
  }
}

if (!customElements.get('ascf-player')) customElements.define('ascf-player', AscfPlayer);

export default AscfPlayer;
export { openAscf } from './decoder.js';
