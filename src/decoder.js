/**
 * decoder.js — DOM-free ASCILINE .ascf decoder.
 *
 * No document, no canvas, no fetch: give it a ReadableStream<Uint8Array> (or a
 * Uint8Array) and it hands back the header plus an async iterator of frames.
 * Runs in a browser, a worker, or Node 18+.
 *
 * Container:
 *   header 18B  'ASC2' | fps f32 | mode u8 | pixel u8 | cols u16 | rows u16 | totalFrames u32  (all BE)
 *   header 14B  'ASCF' — legacy, no totalFrames
 *   then per frame: [len u32 BE][message]
 *
 * Message (mode > 1):
 *   [frameIndex u32 BE][tag u8][payload]
 *   0 RAW   raw framebuffer
 *   1 ZLIB  deflate(framebuffer)
 *   2 DELTA deflate(indices u32 LE ++ changed cells) patched onto previous frame
 *   3 RLE   deflate([count u16 LE][cell]...)
 * Mode 1 is plain text: "frameIndex\n" + the ASCII art.
 *
 * Frames must be decoded in order — DELTA patches the previous frame.
 */

export const TAG_RAW = 0, TAG_ZLIB = 1, TAG_DELTA = 2, TAG_RLE_FULL = 3, TAG_PROFILE = 4;

const td = new TextDecoder();

async function inflate(bytes) {
  const ds = new DecompressionStream('deflate');
  const w = ds.writable.getWriter();
  w.write(bytes);
  w.close();
  const reader = ds.readable.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

export function parseHeader(bytes) {
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== 'ASC2' && magic !== 'ASCF') throw new Error('not an .ascf file (bad magic)');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const h = {
    fps: dv.getFloat32(4, false),
    renderMode: bytes[8],
    pixelMode: bytes[9] === 1,
    cols: dv.getUint16(10, false),
    rows: dv.getUint16(12, false),
    totalFrames: magic === 'ASC2' ? dv.getUint32(14, false) : 0,
    headerSize: magic === 'ASC2' ? 18 : 14,
  };
  h.cellBytes = h.pixelMode ? 3 : 4;
  h.duration = h.totalFrames / h.fps || 0;
  return h;
}

/** Stateful frame decoder. cellBytes: 3 pixel (BGR), 4 ASCII ([char,R,G,B]). */
export function makeDecoder(cellBytes) {
  let prev = null;

  async function decode(message) {
    const bytes = message instanceof Uint8Array ? message : new Uint8Array(message);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const frameIndex = dv.getUint32(0, false);
    const tag = bytes[4];
    const payload = bytes.subarray(5);
    let frame;

    if (tag === TAG_RAW) {
      frame = payload.slice();
    } else if (tag === TAG_ZLIB) {
      frame = await inflate(payload);
    } else if (tag === TAG_DELTA) {
      if (!prev) throw new Error('DELTA frame before any keyframe');
      const body = await inflate(payload);
      const n = body.length / (4 + cellBytes);
      const idx = new DataView(body.buffer, body.byteOffset, body.byteLength);
      frame = prev.slice();
      const valuesOffset = n * 4;
      for (let j = 0; j < n; j++) {
        const dst = idx.getUint32(j * 4, true) * cellBytes;
        const src = valuesOffset + j * cellBytes;
        for (let c = 0; c < cellBytes; c++) frame[dst + c] = body[src + c];
      }
    } else if (tag === TAG_RLE_FULL) {
      const body = await inflate(payload);
      const bv = new DataView(body.buffer, body.byteOffset, body.byteLength);
      const stride = 2 + cellBytes;
      let cells = 0;
      for (let off = 0; off < body.length; off += stride) cells += bv.getUint16(off, true);
      frame = new Uint8Array(cells * cellBytes);
      let dst = 0;
      for (let off = 0; off < body.length; off += stride) {
        const count = bv.getUint16(off, true);
        const v = off + 2;
        for (let i = 0; i < count; i++) for (let c = 0; c < cellBytes; c++) frame[dst++] = body[v + c];
      }
    } else if (tag === TAG_PROFILE) {
      // ponytail: lossy DCT profile frames unsupported — repeat last frame rather
      // than die. Port _pDecodePlane from ASCILINE's codec.js if you compile with --profile.
      if (prev) return { frameIndex, frame: prev };
      throw new Error('PROFILE (tag 4) frames are not supported by this decoder');
    } else {
      throw new Error('unknown ASCILINE codec tag: ' + tag);
    }

    prev = frame;
    return { frameIndex, frame };
  }

  return { decode, reset() { prev = null; } };
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Open a .ascf stream.
 * @param {ReadableStream<Uint8Array>|Uint8Array|ArrayBuffer} source
 * @returns header fields plus `frames()` — an async generator of
 *          `{index, time, data}` (data = full framebuffer) or `{index, time, text}`
 *          for render mode 1 — and `cancel()`.
 */
export async function openAscf(source) {
  let buf = new Uint8Array(0);
  let done = false;
  let reader = null;

  if (source instanceof Uint8Array || source instanceof ArrayBuffer) {
    buf = source instanceof Uint8Array ? source : new Uint8Array(source);
    done = true;
  } else {
    reader = source.getReader();
  }
  const pull = async () => {
    if (done || !reader) return true;
    const { done: d, value } = await reader.read();
    if (value) buf = concat(buf, value);
    return d;
  };
  const need = async (n) => {
    while (buf.length < n && !done) done = await pull();
    return buf.length >= n;
  };

  if (!(await need(18)) && buf.length < 14) throw new Error('truncated .ascf header');
  const header = parseHeader(buf);
  buf = buf.subarray(header.headerSize);
  const dec = makeDecoder(header.cellBytes);

  async function* frames() {
    for (;;) {
      if (!(await need(4))) return;
      const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, false);
      if (!(await need(4 + len))) return;
      const msg = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);

      if (header.renderMode === 1) {
        const s = td.decode(msg);
        const nl = s.indexOf('\n');
        const index = parseInt(s.slice(0, nl), 10);
        yield { index, time: index / header.fps, text: s.slice(nl + 1) };
      } else {
        const { frameIndex, frame } = await dec.decode(msg);
        yield { index: frameIndex, time: frameIndex / header.fps, data: frame };
      }
    }
  }

  return { ...header, frames, cancel: () => reader && reader.cancel().catch(() => {}) };
}
