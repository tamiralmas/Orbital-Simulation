/* =============================================================================
 * Mission Trajectory Planner — gifenc.js
 * Standards-correct animated GIF89a encoder, written from the specification
 * (GIF89a, CompuServe 1990). No dependencies. Prioritizes compatibility:
 *  - Global 256-color table built by median-cut over sampled frames
 *  - Per-frame Graphic Control Extension (delay, disposal = "do not dispose")
 *  - NETSCAPE2.0 application extension for looping
 *  - LZW with an explicit initial Clear code, dictionary reset at 4096 codes,
 *    LSB-first bit packing, 255-byte sub-blocks
 * ========================================================================== */
"use strict";

(function () {

  /* --------------------- median-cut palette (256) ---------------------- */
  function buildPalette(frames, width, height) {
    // sample up to ~120k pixels across frames
    const samples = [];
    const nFrames = frames.length;
    const framePick = Math.max(1, Math.floor(nFrames / 8));
    let stride = Math.max(1, Math.floor((width * height * Math.ceil(nFrames / framePick)) / 120000));
    for (let f = 0; f < nFrames; f += framePick) {
      const d = frames[f];
      for (let i = 0; i < width * height; i += stride) {
        samples.push((d[i * 4] << 16) | (d[i * 4 + 1] << 8) | d[i * 4 + 2]);
      }
    }
    if (samples.length === 0) samples.push(0);

    // median cut
    let boxes = [samples];
    const range = (box) => {
      let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
      for (const p of box) {
        const r = (p >> 16) & 255, g = (p >> 8) & 255, b = p & 255;
        if (r < rMin) rMin = r; if (r > rMax) rMax = r;
        if (g < gMin) gMin = g; if (g > gMax) gMax = g;
        if (b < bMin) bMin = b; if (b > bMax) bMax = b;
      }
      const dr = rMax - rMin, dg = gMax - gMin, db = bMax - bMin;
      const ch = dg >= dr && dg >= db ? 1 : (dr >= db ? 0 : 2);
      return { spread: Math.max(dr, dg, db), ch };
    };
    while (boxes.length < 256) {
      let bi = -1, bs = -1, bch = 0;
      for (let i = 0; i < boxes.length; i++) {
        if (boxes[i].length < 2) continue;
        const { spread, ch } = range(boxes[i]);
        // weight spread by log(count) so populous boxes split first
        const score = spread * Math.log2(boxes[i].length + 1);
        if (score > bs) { bs = score; bi = i; bch = ch; }
      }
      if (bi < 0 || bs <= 0) break;
      const box = boxes[bi];
      const shift = bch === 0 ? 16 : bch === 1 ? 8 : 0;
      box.sort((a, b) => ((a >> shift) & 255) - ((b >> shift) & 255));
      const mid = box.length >> 1;
      boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid));
    }
    const palette = new Uint8Array(256 * 3);
    boxes.forEach((box, i) => {
      let r = 0, g = 0, b = 0;
      for (const p of box) { r += (p >> 16) & 255; g += (p >> 8) & 255; b += p & 255; }
      const n = Math.max(box.length, 1);
      palette[i * 3] = Math.round(r / n);
      palette[i * 3 + 1] = Math.round(g / n);
      palette[i * 3 + 2] = Math.round(b / n);
    });
    return palette; // boxes.length <= 256; the rest stays black
  }

  /* --------- nearest palette index with a quantized lookup cache -------- */
  function makeMapper(palette) {
    const cache = new Int16Array(1 << 15).fill(-1); // 5-bit/channel key
    return function nearest(r, g, b) {
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      let idx = cache[key];
      if (idx >= 0) return idx;
      let bd = Infinity;
      for (let i = 0; i < 256; i++) {
        const dr = r - palette[i * 3], dg = g - palette[i * 3 + 1], db = b - palette[i * 3 + 2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; idx = i; }
      }
      cache[key] = idx;
      return idx;
    };
  }

  const BAYER4 = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
  ];

  function quantizeFrame(rgba, width, height, nearest, dither) {
    const out = new Uint8Array(width * height);
    let p = 0;
    for (let y = 0; y < height; y++) {
      const brow = BAYER4[y & 3];
      for (let x = 0; x < width; x++, p++) {
        let r = rgba[p * 4], g = rgba[p * 4 + 1], b = rgba[p * 4 + 2];
        if (dither) {
          const o = (brow[x & 3] / 16 - 0.5) * 14; // small ordered dither
          r = Math.max(0, Math.min(255, r + o));
          g = Math.max(0, Math.min(255, g + o));
          b = Math.max(0, Math.min(255, b + o));
        }
        out[p] = nearest(r | 0, g | 0, b | 0);
      }
    }
    return out;
  }

  /* ------------------------------ LZW ---------------------------------- */
  function lzwEncode(indices, minCodeSize, pushByte) {
    const CLEAR = 1 << minCodeSize;
    const EOI = CLEAR + 1;
    let codeSize = minCodeSize + 1;
    let next = EOI + 1;
    // dictionary: key = (prefixCode << 8) | byte  ->  code
    const dict = new Int32Array(4096 << 8).fill(-1);

    let cur = 0, nbits = 0;
    const emit = (code) => {
      cur |= code << nbits;
      nbits += codeSize;
      while (nbits >= 8) { pushByte(cur & 255); cur >>= 8; nbits -= 8; }
    };
    const reset = () => { dict.fill(-1); codeSize = minCodeSize + 1; next = EOI + 1; };

    emit(CLEAR);
    let prev = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const key = (prev << 8) | k;
      const hit = dict[key];
      if (hit >= 0) { prev = hit; continue; }
      emit(prev);
      if (next < 4096) {
        dict[key] = next++;
        // The decoder adds its first entry one code later than the encoder,
        // so the encoder must widen one step later: when next EXCEEDS 2^size.
        if (next === (1 << codeSize) + 1 && codeSize < 12) codeSize++;
      }
      if (next >= 4096) { emit(CLEAR); reset(); }
      prev = k;
    }
    emit(prev);
    emit(EOI);
    if (nbits > 0) pushByte(cur & 255);
  }

  /* --------------------------- file assembly --------------------------- */
  function u16(bytes, v) { bytes.push(v & 255, (v >> 8) & 255); }

  /**
   * encode({ width, height, frames:[Uint8ClampedArray(RGBA)...],
   *          delayCs (per-frame hundredths of a second), loop (0=forever),
   *          dither (bool) })  ->  Uint8Array
   */
  function encode(opts) {
    const { width, height, frames } = opts;
    const delayCs = Math.max(1, Math.round(opts.delayCs || 6));
    const loop = opts.loop === undefined ? 0 : opts.loop;
    const dither = opts.dither !== false;
    if (!frames || !frames.length) throw new Error("No frames.");

    const palette = buildPalette(frames, width, height);
    const nearest = makeMapper(palette);

    const bytes = [];
    // Header + Logical Screen Descriptor
    for (const c of "GIF89a") bytes.push(c.charCodeAt(0));
    u16(bytes, width); u16(bytes, height);
    bytes.push(0xf7); // GCT present, 8-bit color resolution, GCT size 2^(7+1)=256
    bytes.push(0);    // background color index
    bytes.push(0);    // pixel aspect ratio
    for (let i = 0; i < 768; i++) bytes.push(palette[i]);

    // NETSCAPE2.0 looping extension
    bytes.push(0x21, 0xff, 0x0b);
    for (const c of "NETSCAPE2.0") bytes.push(c.charCodeAt(0));
    bytes.push(0x03, 0x01);
    u16(bytes, loop);
    bytes.push(0x00);

    for (let f = 0; f < frames.length; f++) {
      // Graphic Control Extension
      bytes.push(0x21, 0xf9, 0x04);
      bytes.push(0x04); // disposal method 1 (do not dispose), no transparency
      u16(bytes, delayCs);
      bytes.push(0x00, 0x00);
      // Image Descriptor
      bytes.push(0x2c);
      u16(bytes, 0); u16(bytes, 0); u16(bytes, width); u16(bytes, height);
      bytes.push(0x00); // no local color table, not interlaced

      // LZW-compressed indices in 255-byte sub-blocks
      const indices = quantizeFrame(frames[f], width, height, nearest, dither);
      bytes.push(8); // LZW minimum code size (256-color palette)
      let block = [];
      lzwEncode(indices, 8, (b) => {
        block.push(b);
        if (block.length === 255) { bytes.push(255, ...block); block = []; }
      });
      if (block.length) bytes.push(block.length, ...block);
      bytes.push(0x00); // block terminator

      if (opts.onFrame) opts.onFrame(f + 1, frames.length);
    }
    bytes.push(0x3b); // trailer
    return new Uint8Array(bytes);
  }

  /* ------- reference LZW decoder (used by the self-test only) ---------- */
  function lzwDecode(data, minCodeSize, expectedCount) {
    const CLEAR = 1 << minCodeSize, EOI = CLEAR + 1;
    let codeSize = minCodeSize + 1;
    let dict = [], out = [];
    const resetDict = () => {
      dict = [];
      for (let i = 0; i < CLEAR; i++) dict.push([i]);
      dict.push(null, null); // clear, eoi
    };
    resetDict();
    let bitPos = 0, prevEntry = null;
    const readCode = () => {
      let v = 0;
      for (let b = 0; b < codeSize; b++) {
        const byte = data[bitPos >> 3];
        if (byte === undefined) return null;
        v |= ((byte >> (bitPos & 7)) & 1) << b;
        bitPos++;
      }
      return v;
    };
    for (;;) {
      const code = readCode();
      if (code === null || code === EOI) break;
      if (code === CLEAR) { resetDict(); codeSize = minCodeSize + 1; prevEntry = null; continue; }
      let entry;
      if (code < dict.length && dict[code]) entry = dict[code];
      else if (code === dict.length && prevEntry) entry = prevEntry.concat(prevEntry[0]);
      else throw new Error("Bad LZW code " + code);
      out.push(...entry);
      if (prevEntry && dict.length < 4096) {
        dict.push(prevEntry.concat(entry[0]));
        if (dict.length === (1 << codeSize) && codeSize < 12) codeSize++;
      }
      prevEntry = entry;
      if (expectedCount && out.length >= expectedCount) break;
    }
    return out;
  }

  /* ------------------- streaming encoder (v1.4) ------------------------ *
   * Encodes frame-by-frame so long exports never hold raw RGBA for the
   * whole animation. The global palette locks after the first 8 frames
   * (buffered), which a mission's stable star-field/theme palette suits.  */
  function makeSink() {
    let buf = new Uint8Array(1 << 20), len = 0;
    const ensure = (extra) => {
      if (len + extra <= buf.length) return;
      let cap = buf.length;
      while (cap < len + extra) cap *= 2;
      const nb = new Uint8Array(cap);
      nb.set(buf.subarray(0, len));
      buf = nb;
    };
    return {
      push(...bs) { ensure(bs.length); for (const b of bs) buf[len++] = b; },
      pushMany(arr, count) { ensure(count); buf.set(arr.subarray(0, count), len); len += count; },
      u16(v) { this.push(v & 255, (v >> 8) & 255); },
      result() { return buf.slice(0, len); },
      get length() { return len; },
    };
  }

  function createEncoder(opts) {
    const { width, height } = opts;
    const delayCs = Math.max(1, Math.round(opts.delayCs || 6));
    const loop = opts.loop === undefined ? 0 : opts.loop;
    const dither = opts.dither !== false;
    const sink = makeSink();
    let palette = null, nearest = null;
    const pending = [];
    let frameCount = 0;

    function writeHeader() {
      for (const c of "GIF89a") sink.push(c.charCodeAt(0));
      sink.u16(width); sink.u16(height);
      sink.push(0xf7, 0, 0);
      for (let i = 0; i < 768; i++) sink.push(palette[i]);
      sink.push(0x21, 0xff, 0x0b);
      for (const c of "NETSCAPE2.0") sink.push(c.charCodeAt(0));
      sink.push(0x03, 0x01);
      sink.u16(loop);
      sink.push(0x00);
    }
    function writeFrame(rgba) {
      sink.push(0x21, 0xf9, 0x04, 0x04);
      sink.u16(delayCs);
      sink.push(0x00, 0x00);
      sink.push(0x2c);
      sink.u16(0); sink.u16(0); sink.u16(width); sink.u16(height);
      sink.push(0x00);
      const indices = quantizeFrame(rgba, width, height, nearest, dither);
      sink.push(8);
      const block = new Uint8Array(255);
      let bl = 0;
      lzwEncode(indices, 8, (b) => {
        block[bl++] = b;
        if (bl === 255) { sink.push(255); sink.pushMany(block, 255); bl = 0; }
      });
      if (bl) { sink.push(bl); sink.pushMany(block, bl); }
      sink.push(0x00);
    }
    function lockPalette() {
      palette = buildPalette(pending, width, height);
      nearest = makeMapper(palette);
      writeHeader();
      for (const fr of pending) writeFrame(fr);
      pending.length = 0;
    }
    return {
      addFrame(rgba) {
        frameCount++;
        if (!palette) {
          pending.push(rgba instanceof Uint8ClampedArray ? new Uint8ClampedArray(rgba) : new Uint8ClampedArray(rgba));
          if (pending.length >= 8) lockPalette();
        } else writeFrame(rgba);
      },
      finish() {
        if (!palette) {
          if (!pending.length) throw new Error("No frames.");
          lockPalette();
        }
        sink.push(0x3b);
        return sink.result();
      },
      get frames() { return frameCount; },
      get bytes() { return sink.length; },
    };
  }

  globalThis.GifEnc = { encode, createEncoder, lzwEncode, lzwDecode, buildPalette, makeMapper, quantizeFrame };
})();
