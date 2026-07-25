// Decodes the real test.ascf headlessly and checks the frames are sane.
// Run: npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openAscf } from '../src/decoder.js';

const bytes = new Uint8Array(readFileSync(new URL('../demo/test.ascf', import.meta.url)));
const clip = await openAscf(bytes);

assert.equal(clip.cols, 200);
assert.equal(clip.rows, 112);
assert.equal(Math.round(clip.fps), 24);
assert.equal(clip.totalFrames, 120);
assert.equal(clip.pixelMode, true);
assert.equal(clip.cellBytes, 3);

let n = 0;
let lastFrame = null;
let changed = 0;
for await (const f of clip.frames()) {
  assert.equal(f.index, n, 'frames arrive in order');
  assert.equal(f.data.length, clip.cols * clip.rows * 3, 'full framebuffer per frame');
  assert.equal(f.time.toFixed(4), (n / clip.fps).toFixed(4));
  if (lastFrame && !lastFrame.every((v, i) => v === f.data[i])) changed++;
  lastFrame = f.data.slice();
  n++;
}

assert.equal(n, clip.totalFrames, 'decoded every frame');
assert.ok(changed > n / 2, 'frames actually differ (not a stuck picture)');
assert.ok(lastFrame.some((v) => v !== lastFrame[0]), 'last frame is not a flat colour');

console.log(`ok — ${n} frames, ${clip.cols}x${clip.rows} @ ${clip.fps}fps, ${changed} distinct transitions`);

// test.ascf is all RLE_FULL, so build a synthetic ASCII-mode (4 bytes/cell) clip
// that exercises RAW, ZLIB, DELTA and RLE against hand-computed expectations.
const COLS = 2, ROWS = 2, CELL = 4;
const deflate = async (bytes) => {
  const cs = new CompressionStream('deflate');
  const w = cs.writable.getWriter();
  w.write(bytes); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
};
const msg = (index, tag, payload) => {
  const out = new Uint8Array(5 + payload.length);
  new DataView(out.buffer).setUint32(0, index, false);
  out[4] = tag;
  out.set(payload, 5);
  return out;
};
const u32le = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const u32be = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, false); return b; };
const u16le = (n) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; };
const cat = (...parts) => { const t = parts.reduce((a, p) => a + p.length, 0), o = new Uint8Array(t); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };

const raw0 = new Uint8Array([65, 1, 2, 3, 66, 4, 5, 6, 67, 7, 8, 9, 68, 10, 11, 12]);
const raw1 = raw0.slice(); raw1.set([90, 99, 98, 97], 8);              // cell 2 changes
const messages = [
  msg(0, 0, raw0),                                                     // RAW
  msg(1, 2, await deflate(cat(u32le(2), new Uint8Array([90, 99, 98, 97])))), // DELTA
  msg(2, 1, await deflate(raw1)),                                      // ZLIB
  msg(3, 3, await deflate(cat(u16le(4), new Uint8Array([88, 1, 1, 1])))), // RLE: 4 identical cells
];
const header = new Uint8Array(18);
const hv = new DataView(header.buffer);
header.set([0x41, 0x53, 0x43, 0x32]);            // 'ASC2'
hv.setFloat32(4, 10, false);
header[8] = 6; header[9] = 0;                    // mode 6, not pixel -> 4 bytes/cell
hv.setUint16(10, COLS, false); hv.setUint16(12, ROWS, false);
hv.setUint32(14, messages.length, false);
const framed = messages.map((m) => cat(u32be(m.length), m));
const synthetic = await openAscf(cat(header, ...framed));

assert.equal(synthetic.cellBytes, CELL);
const out = [];
for await (const f of synthetic.frames()) out.push(f.data);
assert.deepEqual([...out[0]], [...raw0], 'RAW');
assert.deepEqual([...out[1]], [...raw1], 'DELTA patches previous frame');
assert.deepEqual([...out[2]], [...raw1], 'ZLIB');
assert.deepEqual([...out[3]], [88, 1, 1, 1, 88, 1, 1, 1, 88, 1, 1, 1, 88, 1, 1, 1], 'RLE_FULL');
console.log('ok — RAW / ZLIB / DELTA / RLE_FULL all decode as expected');
