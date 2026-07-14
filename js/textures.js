/* =============================================================================
 * Mission Trajectory Planner — textures.js
 * Textured-sphere rendering for catalog bodies.
 *
 * Texture data is optional: run get_textures.ps1 (project root) once to
 * download NASA-imagery-based equirectangular maps (Solar System Scope pack,
 * CC-BY 4.0) and pack them into js/textures-data.js as base64 data URIs.
 * Keeping the pixels inline avoids canvas tainting, so PNG/GIF export keeps
 * working even when index.html is opened straight from disk.
 *
 * Rendering model: orthographic shaded sphere.
 *  - Per-pixel: disk (x,y) → view-space normal → world normal via the camera
 *    basis → body-frame lat/lon (axial tilt + spin) → equirectangular sample.
 *  - Lighting: Lambert term toward the Sun + small ambient + limb darkening.
 *  - Sprites are cached by (body, size, light, spin, camera) buckets and
 *    evicted LRU. Bodies without a loaded texture fall back to the renderer's
 *    gradient look.
 * ========================================================================== */
"use strict";

(function () {
  const A = globalThis.Astro;

  const maps = {};                 // bodyId -> {ready, px, w, h}
  const sprites = new Map();       // cacheKey -> canvas (LRU by insertion)
  const MAX_SPRITES = 60;
  const MAX_R = 300;               // max rendered sprite radius (px)
  const SPRITE_REFRESH_MS = 80;    // bound expensive CPU sphere rebuilds

  /* ------------------------- texture ingestion ------------------------- */
  function ingest(id, img) {
    // downsample to ≤1024 wide for fast CPU sampling
    const w = Math.min(img.naturalWidth || 1024, 1024);
    const h = Math.max(1, Math.round(w / 2));
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const g = cv.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0, w, h);
    try {
      maps[id] = { ready: true, px: g.getImageData(0, 0, w, h).data, w, h };
      // A newly decoded map only invalidates that body's derived assets.
      // Clearing the entire cache here caused repeated startup rebuilds.
      for (const key of sprites.keys()) if (key.startsWith(id + "|")) sprites.delete(key);
      delete mapCvs[id];
      delete _last[id];
      delete _lastBuildMs[id];
    } catch (e) {
      // tainted canvas (shouldn't happen with data URIs) — ignore texture
      console.warn("Texture unusable for", id, e.message);
    }
  }

  let initStarted = false;
  function init() {
    if (initStarted) return;
    initStarted = true;
    const data = globalThis.MTP_TEXTURE_DATA;
    if (!data) return;
    const priority = ["earth", "sun", "moon", "mars", "jupiter", "saturn", "venus", "mercury"];
    const rank = new Map(priority.map((id, i) => [id, i]));
    const ids = Object.keys(data).sort((a, b) =>
      (rank.has(a) ? rank.get(a) : 100) - (rank.has(b) ? rank.get(b) : 100));
    let nextIndex = 0;
    const scheduleNext = () => {
      if (nextIndex >= ids.length) return;
      if (globalThis.requestIdleCallback)
        globalThis.requestIdleCallback(loadNext, { timeout: 250 });
      else setTimeout(loadNext, 16);
    };
    const loadNext = () => {
      if (nextIndex >= ids.length) return;
      const id = ids[nextIndex++];
      const img = new Image();
      img.onload = () => { ingest(id, img); scheduleNext(); };
      img.onerror = () => { console.warn("Texture failed to decode:", id); scheduleNext(); };
      img.src = data[id];
    };
    loadNext();
  }

  const has = (id) => !!(maps[id] && maps[id].ready);

  /* Equirectangular base-map canvas for the ground-track panel. */
  const mapCvs = {};
  function mapCanvas(id) {
    const t = maps[id];
    if (!t || !t.ready) return null;
    if (mapCvs[id]) return mapCvs[id];
    const c = document.createElement("canvas");
    c.width = t.w; c.height = t.h;
    c.getContext("2d").putImageData(
      new ImageData(new Uint8ClampedArray(t.px), t.w, t.h), 0, 0);
    mapCvs[id] = c;
    return c;
  }

  /* --------------------------- sphere sprite --------------------------- */
  const q = (x, s) => Math.round(x / s) * s;

  /* Per-frame rebuild budget: during camera/spin motion at most N sprites
   * are re-rendered per frame; other bodies reuse their last sprite (a
   * slightly stale sub-frame is invisible; a 60 fps stall is not). */
  let _builds = 0, _largeBuilds = 0;
  const _last = {};
  const _lastBuildMs = {};
  function beginFrame() { _builds = 0; _largeBuilds = 0; }

  /**
   * Shaded, textured sphere sprite.
   * body: catalog body; rPx: on-screen radius (px); Lw: world-space unit
   * vector toward the light (Sun); jd: displayed UTC Julian date; basis:
   * {Rt, Up, F} camera basis (world); emissive: skip lighting (the Sun).
   */
  function spriteFor(body, rPx, Lw, jd, basis, emissive) {
    const tex = maps[body.id];
    if (!tex) return null;
    const frame = A && typeof A.bodyFrameAt === "function" ? A.bodyFrameAt(body, jd) : null;
    if (!frame) return null;
    const requestedR = Math.max(4, Math.min(Math.round(rPx), MAX_R));
    // Auto camera easing used to miss the cache at every one-pixel radius
    // change and rebuild a 600x600 shaded globe repeatedly. Bucket only the
    // derived sprite resolution; drawImage still scales it to the exact disk.
    const radiusBucket = requestedR < 48 ? 1 : (requestedR < 120 ? 3 : 6);
    const R = Math.max(4, Math.min(MAX_R,
      Math.round(requestedR / radiusBucket) * radiusBucket));
    // quantization coarsens for small apparent sizes (rotation/lighting
    // detail is invisible below ~40 px, so don't rebuild sprites for it)
    const small = R < 40;
    const qs = small ? 0.5 : 0.06;      // spin buckets
    const ql = small ? 0.15 : 0.06;     // light buckets
    const qb = small ? 0.12 : 0.04;     // camera-basis buckets
    const key = body.id + "|" + R + "|" + (emissive ? "e" : (
      q(Lw[0], ql) + "," + q(Lw[1], ql) + "," + q(Lw[2], ql))) +
      "|" + q(frame.phase, qs) +
      "|" + q(frame.z[0], qb) + "," + q(frame.z[1], qb) + "," + q(frame.z[2], qb) +
      "|" + q(basis.Rt[0], qb) + "," + q(basis.Rt[1], qb) + "," + q(basis.Rt[2], qb) +
      "," + q(basis.Up[0], qb) + "," + q(basis.Up[1], qb) + "," + q(basis.Up[2], qb);
    const hit = sprites.get(key);
    if (hit) { sprites.delete(key); sprites.set(key, hit); _last[body.id] = hit; return hit; } // LRU bump
    const nowMs = globalThis.performance && typeof globalThis.performance.now === "function"
      ? globalThis.performance.now() : Date.now();
    const large = R >= 96;
    if (_last[body.id] && ((nowMs - (_lastBuildMs[body.id] || 0)) < SPRITE_REFRESH_MS ||
        (large && _largeBuilds >= 1))) return _last[body.id];
    // over budget this frame → serve the previous sprite instead of stalling
    if (_builds >= 2 && _last[body.id]) return _last[body.id];
    _builds++;
    if (large) _largeBuilds++;

    const size = 2 * R + 2;
    const cv = document.createElement("canvas");
    cv.width = size; cv.height = size;
    const g = cv.getContext("2d");
    const out = g.createImageData(size, size);
    const o = out.data;

    const { Rt, Up, F } = basis;
    const tw = tex.w, th = tex.h, tp = tex.px;

    for (let y = 0; y < size; y++) {
      const ny = -(y - R) / R;
      for (let x = 0; x < size; x++) {
        const nx = (x - R) / R;
        const rr2 = nx * nx + ny * ny;
        if (rr2 > 1) continue;
        const nz = Math.sqrt(1 - rr2);
        // world normal (camera looks along F; front hemisphere faces −F)
        const nw = [
          nx * Rt[0] + ny * Up[0] - nz * F[0],
          nx * Rt[1] + ny * Up[1] - nz * F[1],
          nx * Rt[2] + ny * Up[2] - nz * F[2],
        ];
        // body-frame components
        const xs = nw[0] * frame.x[0] + nw[1] * frame.x[1] + nw[2] * frame.x[2];
        const ys = nw[0] * frame.y[0] + nw[1] * frame.y[1] + nw[2] * frame.y[2];
        const zb = nw[0] * frame.z[0] + nw[1] * frame.z[1] + nw[2] * frame.z[2];
        const lon = Math.atan2(ys, xs);
        const lat = Math.asin(Math.max(-1, Math.min(1, zb)));
        let u = lon / (2 * Math.PI) + 0.5;
        u -= Math.floor(u);
        const v = Math.min(0.99999, Math.max(0, 0.5 - lat / Math.PI));
        const ti = ((v * th | 0) * tw + (u * tw | 0)) * 4;

        let shade = 1;
        if (!emissive) {
          const l = nw[0] * Lw[0] + nw[1] * Lw[1] + nw[2] * Lw[2];
          shade = 0.16 + 0.84 * Math.pow(Math.max(0, l), 0.9);
          shade *= 0.72 + 0.28 * nz;                    // limb darkening
        }
        const oi = (y * size + x) * 4;
        o[oi] = tp[ti] * shade;
        o[oi + 1] = tp[ti + 1] * shade;
        o[oi + 2] = tp[ti + 2] * shade;
        // soft antialiased edge
        const rr = Math.sqrt(rr2) * R;
        o[oi + 3] = rr > R - 1 ? Math.max(0, Math.min(255, (R - rr) * 255)) : 255;
      }
    }
    g.putImageData(out, 0, 0);
    if (sprites.size >= MAX_SPRITES) sprites.delete(sprites.keys().next().value);
    sprites.set(key, cv);
    _last[body.id] = cv;
    _lastBuildMs[body.id] = nowMs;
    return cv;
  }

  /** Spin angle from the body's rotation period at Julian date jd. */
  function spinAt(body, jd) {
    const frame = A && typeof A.bodyFrameAt === "function" ? A.bodyFrameAt(body, jd) : null;
    return frame ? frame.phase : 0;
  }

  function bodyLatLon(body, nWorld, jd, spinOverride) {
    return A && typeof A.bodyLatLon === "function"
      ? A.bodyLatLon(body, nWorld, jd, spinOverride) : null;
  }

  globalThis.MTPTex = { init, has, spriteFor, spinAt, bodyLatLon, mapCanvas, beginFrame };
})();
