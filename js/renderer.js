/* =============================================================================
 * Mission Trajectory Planner — renderer.js
 * Dependency-free 3D → 2D canvas renderer.
 *
 * A perspective orbit camera (yaw / pitch / distance about a focus point)
 * projects heliocentric-ecliptic world coordinates (km) onto the canvas.
 * Trajectories can be displayed in the inertial frame or re-expressed
 * relative to any body ("rotating with" that body's translation — classic
 * planet-centered plots).
 *
 * v1.1: textured planets (see textures.js), physically-sized Saturn ring
 * bands with planet occlusion, minor-body declutter, and a "free" focus
 * mode used by the cinematic auto-camera.
 * ========================================================================== */
"use strict";

(function () {
  const C = globalThis.AstroConst;
  const A = globalThis.Astro;
  const { BODIES, AU, DAY } = C;
  const V = A.V;
  const TEX = globalThis.MTPTex;

  /* ------------------------- theme palette ----------------------------- */
  const PAL_DEFAULT = {
    bg: "#04060c", starRGB: "200,215,235", starAlpha: 1,
    grid: "rgba(88,110,140,0.13)",
    trajFuture: "rgba(139,148,158,0.55)",
    trajGlow: "rgba(53,208,255,0.20)", trajPast: "rgba(53,208,255,0.95)",
    apsisOrbit: "rgba(88,166,255,0.42)", apsisApo: "#58a6ff", apsisPeri: "#e3b341",
    soiStroke: "rgba(210,168,255,0.35)", soiFill: "rgba(210,168,255,0.5)",
    labelPlanet: "rgba(201,209,217,0.85)", labelMoon: "rgba(139,148,158,0.75)",
    labelMinor: "rgba(139,148,158,0.6)",
    ship: "#ffffff", shipLanded: "#7ee787", shipGlowRGB: "53,208,255",
    shipLabel: "rgba(53,208,255,0.9)",
    scalebar: "rgba(139,148,158,0.8)", scalebarText: "rgba(139,148,158,0.9)",
    orbitDarken: false,
    events: {
      burn: "#f85149", soi_entry: "#d2a8ff", soi_exit: "#d2a8ff", flyby: "#d2a8ff",
      launch: "#7ee787", landing: "#7ee787", liftoff: "#7ee787",
      entry: "#e3b341", splashdown: "#e3b341", impact: "#ff5555",
      apsis: "#58a6ff", obs: "#3fb6b2", note: null,
    },
  };
  const P = () => globalThis.MTPTheme || PAL_DEFAULT;

  /* ------------------------------ camera ------------------------------- */
  function createCamera() {
    return {
      yaw: -0.7, pitch: 0.42, dist: 6 * AU, fov: 50 * Math.PI / 180,
      focusMode: "body",      // 'body' | 'ship' | 'free'
      focusBody: "sun",
      freeFocus: null,        // world-space focus point for 'free' mode
      pan: [0, 0, 0],         // world-space pan offset
    };
  }

  function bodyWorldForScene(scene, bodyId, jd) {
    return scene && typeof scene.bodyWorld === "function"
      ? scene.bodyWorld(bodyId, jd) : A.bodyWorld(bodyId, jd);
  }

  function bodyOrbitPathForScene(scene, bodyId, jd) {
    return scene && typeof scene.bodyOrbitPath === "function"
      ? scene.bodyOrbitPath(bodyId, jd) : null;
  }

  /* -------------------------- display frames -------------------------- *
   * Ordinary body-relative frames translate an inertial point by the
   * selected body's position at that point's epoch.  A synodic frame must do
   * one additional operation: rotate the point into the instantaneous
   * primary-secondary axes at that same epoch.  The resulting coordinates
   * are restored at the display epoch's barycentre, so a historical path is
   * stationary in the rotating frame instead of being frozen with today's
   * Sun/Earth/Moon orientation.  These are virtual display frames only; they
   * never enter AstroConst.BODIES or the propagation engine. */
  const SYNODIC_PREFIX = "synodic:";
  let _synodicBasisCache = new Map();

  function synodicSystemForFrame(frameBody) {
    if (typeof frameBody !== "string" || !frameBody.startsWith(SYNODIC_PREFIX) ||
        !globalThis.CR3BP) return null;
    try { return globalThis.CR3BP.getSystem(frameBody.slice(SYNODIC_PREFIX.length)); }
    catch (error) { return null; }
  }

  function isSynodicFrame(frameBody) { return !!synodicSystemForFrame(frameBody); }

  function synodicFrameBasis(systemOrId, jd, worldProvider) {
    if (!globalThis.CR3BP) return null;
    const system = typeof systemOrId === "object"
      ? systemOrId : globalThis.CR3BP.getSystem(systemOrId);
    const bodyWorld = typeof worldProvider === "function" ? worldProvider : A.bodyWorld;
    const canCache = bodyWorld === A.bodyWorld;
    const cacheKey = system.id + "|" + (+jd).toFixed(9);
    if (canCache && _synodicBasisCache.has(cacheKey))
      return _synodicBasisCache.get(cacheKey);

    const primary = bodyWorld(system.primaryId, jd);
    const secondary = bodyWorld(system.secondaryId, jd);
    const separationVector = V.sub(secondary, primary);
    const separationKm = V.mag(separationVector);
    if (!(separationKm > 0) || !isFinite(separationKm)) return null;
    const xAxis = V.scale(separationVector, 1 / separationKm);

    // Derive the instantaneous orbital normal from the same position source
    // used to draw the bodies. This also keeps a future authoritative scene
    // provider coherent without requiring a separate velocity hook.
    const deltaDays = 30 / DAY;
    const relBefore = V.sub(bodyWorld(system.secondaryId, jd - deltaDays),
      bodyWorld(system.primaryId, jd - deltaDays));
    const relAfter = V.sub(bodyWorld(system.secondaryId, jd + deltaDays),
      bodyWorld(system.primaryId, jd + deltaDays));
    const relativeVelocity = V.sub(relAfter, relBefore);
    let zAxis = V.norm(V.cross(separationVector, relativeVelocity));
    if (V.mag(zAxis) < 1e-10) {
      const fallback = Math.abs(xAxis[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
      zAxis = V.norm(V.cross(xAxis, fallback));
    }
    const yAxis = V.norm(V.cross(zAxis, xAxis));
    zAxis = V.norm(V.cross(xAxis, yAxis));
    const primaryWeight = system.primaryGM / system.totalGM;
    const secondaryWeight = system.secondaryGM / system.totalGM;
    const origin = V.add(V.scale(primary, primaryWeight),
      V.scale(secondary, secondaryWeight));
    const basis = Object.freeze({
      system, jd: +jd, origin, xAxis, yAxis, zAxis, separationKm,
    });
    if (canCache) {
      if (_synodicBasisCache.size > 20000) _synodicBasisCache = new Map();
      _synodicBasisCache.set(cacheKey, basis);
    }
    return basis;
  }

  function synodicCoordinates(worldPoint, basis) {
    const relative = V.sub(worldPoint, basis.origin);
    return [V.dot(relative, basis.xAxis), V.dot(relative, basis.yAxis),
      V.dot(relative, basis.zAxis)];
  }

  function synodicWorld(coordinates, basis) {
    return V.add(basis.origin, V.add(V.scale(basis.xAxis, coordinates[0]),
      V.add(V.scale(basis.yAxis, coordinates[1]),
        V.scale(basis.zAxis, coordinates[2]))));
  }

  function vectorRelativeToDisplayFrame(vector, context) {
    if (!context || context.kind !== "synodic") return V.clone(vector);
    const basis = context.basis;
    return [V.dot(vector, basis.xAxis), V.dot(vector, basis.yAxis),
      V.dot(vector, basis.zAxis)];
  }

  function vectorFromDisplayFrame(vector, context) {
    if (!context || context.kind !== "synodic") return V.clone(vector);
    const basis = context.basis;
    return V.add(V.scale(basis.xAxis, vector[0]),
      V.add(V.scale(basis.yAxis, vector[1]), V.scale(basis.zAxis, vector[2])));
  }

  function displayFrameContext(frameBody, jd, worldProvider) {
    const bodyWorld = typeof worldProvider === "function" ? worldProvider : A.bodyWorld;
    if (frameBody === "inertial")
      return { kind: "inertial", frameBody, jd, offset: [0, 0, 0] };
    const system = synodicSystemForFrame(frameBody);
    if (system) {
      const basis = synodicFrameBasis(system, jd, bodyWorld);
      if (basis) return { kind: "synodic", frameBody, jd, offset: basis.origin, basis };
    }
    return { kind: "body", frameBody, jd, offset: bodyWorld(frameBody, jd) };
  }

  function pointRelativeToDisplayFrame(worldPoint, frameBody, jdPoint, worldProvider, context) {
    const ctx = context && context.frameBody === frameBody && context.jd === jdPoint
      ? context : displayFrameContext(frameBody, jdPoint, worldProvider);
    if (ctx.kind === "inertial") return V.clone(worldPoint);
    if (ctx.kind === "synodic") return synodicCoordinates(worldPoint, ctx.basis);
    return V.sub(worldPoint, ctx.offset);
  }

  function pointInDisplayFrame(worldPoint, frameBody, jdPoint, jdDisplay,
      worldProvider, pointContext, displayContext) {
    const local = pointRelativeToDisplayFrame(worldPoint, frameBody, jdPoint,
      worldProvider, pointContext);
    const target = displayContext && displayContext.frameBody === frameBody &&
      displayContext.jd === jdDisplay
      ? displayContext : displayFrameContext(frameBody, jdDisplay, worldProvider);
    return target.kind === "inertial" ? local : V.add(local, target.offset);
  }

  function librationPointRecords(systemOrId, jd, frameBody, worldProvider,
      displayContext) {
    if (!globalThis.CR3BP) return [];
    let system;
    try { system = typeof systemOrId === "object"
      ? systemOrId : globalThis.CR3BP.getSystem(systemOrId); }
    catch (error) { return []; }
    const bodyWorld = typeof worldProvider === "function" ? worldProvider : A.bodyWorld;
    const basis = synodicFrameBasis(system, jd, bodyWorld);
    if (!basis) return [];
    const targetContext = displayContext || displayFrameContext(frameBody, jd, bodyWorld);
    const points = globalThis.CR3BP.equilibriumPoints(system);
    return ["L1", "L2", "L3", "L4", "L5"].map((name) => {
      const equilibrium = points[name];
      // The mass ratio is reviewed by CR3BP; actual primary/secondary states
      // supply this epoch's origin, axes, and separation.
      const rotatingKm = equilibrium.position.map((value) => value * basis.separationKm);
      const inertialWorld = synodicWorld(rotatingKm, basis);
      return Object.freeze({
        id: `libration:${system.id}:${name.toLowerCase()}`,
        name,
        label: `${name} · ${system.name}`,
        systemId: system.id,
        systemName: system.name,
        stability: equilibrium.stability,
        rotatingKm,
        inertialWorld,
        world: pointInDisplayFrame(inertialWorld, frameBody, jd, jd, bodyWorld,
          null, targetContext),
      });
    });
  }

  function librationPointWorld(systemId, pointName, jd, frameBody) {
    const name = String(pointName || "").toUpperCase();
    const record = librationPointRecords(systemId, jd, frameBody || "inertial")
      .find((item) => item.name === name);
    return record ? V.clone(record.world) : null;
  }

  /* --------------------------- starfield ------------------------------- */
  const STARS = (() => {
    const out = [];
    let s = 987654321;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    for (let i = 0; i < 420; i++) {
      const z = rnd() * 2 - 1, phi = rnd() * Math.PI * 2;
      const r = Math.sqrt(1 - z * z);
      out.push({
        d: [r * Math.cos(phi), r * Math.sin(phi), z],
        m: 0.25 + rnd() * 0.75, big: rnd() > 0.92,
      });
    }
    return out;
  })();

  /* -------------------- Saturn's rings (real structure) ----------------- *
   * Radii in units of Saturn's mean radius; per-band tone + opacity.       */
  const SATURN_BANDS = [
    { r0: 1.24, r1: 1.53, col: "#8d8272", a: 0.28 },   // C ring (faint)
    { r0: 1.53, r1: 1.95, col: "#d9c8a5", a: 0.85 },   // B ring (bright)
    /* Cassini Division: 1.95–2.03 (gap) */
    { r0: 2.03, r1: 2.27, col: "#c4b28e", a: 0.60 },   // A ring
    { r0: 2.32, r1: 2.34, col: "#b7a685", a: 0.30 },   // F ring (thin)
  ];

  /* ---------------------- frame-relative traj cache -------------------- */
  const TRAJECTORY_DENSE_STEP = 1.5 * Math.PI / 180;
  const TRAJECTORY_SAFE_J2_STEP = 15 * Math.PI / 180;
  const TRAJECTORY_MAX_SPAN_PIECES = 96;
  const TRAJECTORY_MAX_ADDITIONS = 12000;
  const FLEET_EXACT_POINT_CAP = 6000;
  let _cache = {
    result: null, key: null, rel: null, evRel: null,
    denseRel: null, denseT: null, denseBreakBefore: null, sampleDenseIndex: null,
  };
  let _apsisCache = { result: null, key: null, pts: null, apo: null, peri: null, coe: null };
  let _bridgeCache = {
    result: null, frameBody: null, i0: -1, i1: -1,
    windowKey: null, base: null,
  };
  let _burnTimingCache = { result: null, timings: null };
  let _fleetTrajectoryCache = new WeakMap();

  /* Estimate how far a propagated span sweeps around its central body. The
     endpoint angle alone aliases a near-complete revolution to a tiny angle,
     so bound conics also use elapsed mean anomaly. */
  function trajectorySpanSweep(a, b) {
    if (!a || !b || a.cen !== b.cen || b.t <= a.t ||
        V.mag(a.r) <= 0 || V.mag(b.r) <= 0) return 0;
    const c = Math.max(-1, Math.min(1, V.dot(V.norm(a.r), V.norm(b.r))));
    let sweep = Math.acos(c);
    const body = BODIES[a.cen];
    if (!body) return sweep;
    const coe = A.rvToCoe(a.r, a.v, body.mu);
    if (coe.e < 1 && coe.a > 0 && isFinite(coe.a)) {
      const period = 2 * Math.PI * Math.sqrt((coe.a * coe.a * coe.a) / body.mu);
      if (period > 0 && isFinite(period))
        sweep = Math.max(sweep, 2 * Math.PI * (b.t - a.t) / period);
    }
    return isFinite(sweep) ? sweep : 0;
  }

  /* Stored engine samples are intentionally sparse in inexpensive Kepler
     coasts. Allocate exact intermediate display points only to spans whose
     curvature needs them. The global addition budget keeps even pathological
     missions bounded, while proportional allocation protects the widest arcs
     first instead of blindly exhausting the budget at the mission start. */
  function trajectoryDensePlan(samples, additionBudget) {
    const maxAdditions = Number.isFinite(additionBudget)
      ? Math.max(0, Math.floor(additionBudget)) : TRAJECTORY_MAX_ADDITIONS;
    const wanted = new Array(samples.length).fill(0);
    let totalWanted = 0;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1], b = samples[i];
      const exactInterpolated = b._interp === "kepler" || b._interp === "j2" ||
        (a.forceModel && b.forceModel) ||
        (a.cr3bp && b.cr3bp && a.cr3bpSystem === b.cr3bpSystem);
      if (a.cen !== b.cen || !exactInterpolated || b._breakBefore ||
          a.landed || b.landed || b.t <= a.t) continue;
      const pieces = Math.min(TRAJECTORY_MAX_SPAN_PIECES,
        Math.max(1, Math.ceil(trajectorySpanSweep(a, b) / TRAJECTORY_DENSE_STEP)));
      wanted[i] = pieces - 1;
      totalWanted += wanted[i];
    }
    if (totalWanted <= maxAdditions) return wanted;
    const scale = maxAdditions / totalWanted;
    for (let i = 1; i < wanted.length; i++) wanted[i] = Math.floor(wanted[i] * scale);
    return wanted;
  }

  /* Advance through a half-open polyline range while guaranteeing that its
     final requested point is emitted. A plain `i += stride` can stop one point
     early, leaving a visible gap before a separately stroked active bridge. */
  function nextPolylineIndex(i, end, stride) {
    if (i >= end - 1) return end;
    return Math.min(i + stride, end - 1);
  }

  function hasPolylineBreak(breaks, previousIndex, index) {
    if (!breaks || previousIndex < 0) return false;
    for (let i = previousIndex + 1; i <= index; i++) {
      if (breaks[i]) return true;
    }
    return false;
  }

  /* The trajectory is painted once behind all bodies, then only the pieces
     that are genuinely visible in front of a body are painted again. A
     point's depth relative to the body center is not sufficient in a
     perspective view: near the apparent limb, the far ray/sphere
     intersection can still be closer to the camera than the center. */
  function trajectoryFrontPassSkip(point, eyeWorld, sx, sy, disks) {
    let overlapsDisk = false;
    for (let i = 0; i < disks.length; i++) {
      const d = disks[i];
      const dx = sx - d.x, dy = sy - d.y;
      if (dx * dx + dy * dy >= (d.r + 2) * (d.r + 2)) continue;
      overlapsDisk = true;
      const sphere = d.sphere;
      if (sphere && typeof A.pointOccludedBySphere === "function" &&
          A.pointOccludedBySphere(point, eyeWorld, sphere.center, sphere.radius))
        return true;
    }
    // The front pass only repairs trajectory pieces covered by a body in the
    // first painter pass; everything outside those disks is already visible.
    return !overlapsDisk;
  }

  function trajectoryCache(result, frameBody, epochJD) {
    const key = (result && result.samples.length) + "|" + frameBody + "|" +
      (result ? result.tEnd : 0) + "|" + epochJD;
    // A recompute can preserve both sample count and end time. Keying only
    // those scalars returned the previous mission geometry after a burn edit
    // while the independently rebuilt apsis ellipse showed the new orbit.
    if (_cache.result === result && _cache.key === key) return _cache;
    const rel = [];
    const evRel = [];
    const denseRel = [];
    const denseT = [];
    const denseBreakBefore = [];
    const denseDocked = [];
    const sampleDenseIndex = [];
    let previousDenseDocked = false;
    if (result) {
      for (const s of result.samples) {
        const jdPoint = epochJD + s.t / DAY;
        rel.push(pointRelativeToDisplayFrame(s.w, frameBody, jdPoint));
      }
      const extraByEnd = trajectoryDensePlan(result.samples);
      const forcedBreakBefore = [];
      for (let i = 0; i < result.samples.length; i++) {
        const a = result.samples[i];
        sampleDenseIndex[i] = denseRel.length;
        denseRel.push(rel[i]);
        denseT.push(a.t);
        const sampleDocked = !!a.dockedTo;
        denseBreakBefore.push(!!a._breakBefore || !!forcedBreakBefore[i] ||
          sampleDocked !== previousDenseDocked);
        denseDocked.push(sampleDocked);
        previousDenseDocked = sampleDocked;
        if (i + 1 >= result.samples.length) continue;
        const b = result.samples[i + 1];
        const extras = extraByEnd[i + 1];
        if (b._interp === "j2") {
          const safePieces = Math.ceil(
            trajectorySpanSweep(a, b) / TRAJECTORY_SAFE_J2_STEP);
          if (extras + 1 < safePieces) {
            // The global 12k-point budget cannot represent this many old
            // revolutions without drawing false chords through Earth. Omit
            // that historical span; the active bridge below still shows a
            // bounded exact window around the spacecraft while scrubbing.
            forcedBreakBefore[i + 1] = true;
            continue;
          }
        }
        for (let k = 1; k <= extras; k++) {
          const t = a.t + (b.t - a.t) * k / (extras + 1);
          const smp = globalThis.MissionEngine.sampleAtTime(result, t);
          const p = sampleToFrame(result, smp, frameBody);
          if (p) {
            denseRel.push(p);
            denseT.push(t);
            const interpolatedDocked = !!smp.dockedTo;
            denseBreakBefore.push(interpolatedDocked !== previousDenseDocked);
            denseDocked.push(interpolatedDocked);
            previousDenseDocked = interpolatedDocked;
          }
        }
      }
      for (const ev of result.events) {
        if (ev && Array.isArray(ev.w)) {
          const jdPoint = epochJD + ev.t / DAY;
          evRel.push(pointRelativeToDisplayFrame(ev.w, frameBody, jdPoint));
          continue;
        }
        const smp = globalThis.MissionEngine.sampleAtTime(result, ev.t);
        if (!smp) { evRel.push(null); continue; }
        const jdPoint = epochJD + ev.t / DAY;
        evRel.push(pointRelativeToDisplayFrame(smp.w, frameBody, jdPoint));
      }
    }
    _cache = {
      result, key, rel, evRel, denseRel, denseT, denseBreakBefore, denseDocked,
      sampleDenseIndex,
      denseAdded: denseRel.length - rel.length,
    };
    return _cache;
  }

  function fleetTrajectoryCache(result, frameBody, epochJD, exact) {
    if (!result || !Array.isArray(result.samples) || !result.samples.length)
      return { points: [], breaks: [], times: [] };
    let byFrame = _fleetTrajectoryCache.get(result);
    if (!byFrame) { byFrame = new Map(); _fleetTrajectoryCache.set(result, byFrame); }
    const key = frameBody + "|" + epochJD + "|" + (exact ? "exact" : "coarse");
    if (byFrame.has(key)) return byFrame.get(key);
    const samples = result.samples;
    const stride = exact ? 1 : Math.max(1, Math.ceil(samples.length / 1600));
    // Inactive vehicles previously spent the full primary-path 12k addition
    // budget apiece even though each path is later downsampled for canvas.
    // Allocate only the exact samples that can survive the fleet draw cap.
    // J2 spans that cannot meet the safe angular step are still broken below,
    // never joined with a false chord through a planet.
    const extraByEnd = exact ? trajectoryDensePlan(samples,
      Math.max(0, FLEET_EXACT_POINT_CAP - samples.length)) : null;
    const points = [], breaks = [], times = [];
    let previous = -1, joinedGap = false, forcedBreak = false;
    for (let index = 0; index < samples.length; index++) {
      const sample = samples[index];
      if (sample.dockedTo) { joinedGap = true; continue; }
      const nextJoined = index + 1 < samples.length && !!samples[index + 1].dockedTo;
      const previousJoined = index > 0 && !!samples[index - 1].dockedTo;
      if (index !== samples.length - 1 && index % stride !== 0 &&
          !nextJoined && !previousJoined) continue;
      const jdPoint = epochJD + sample.t / DAY;
      points.push(pointRelativeToDisplayFrame(sample.w, frameBody, jdPoint));
      times.push(sample.t);
      let broken = joinedGap || forcedBreak || !!sample._breakBefore;
      for (let scan = previous + 1; !broken && scan <= index; scan++)
        broken = !!samples[scan]._breakBefore || !!samples[scan].dockedTo;
      breaks.push(broken);
      previous = index;
      joinedGap = false; forcedBreak = false;
      if (!exact || index + 1 >= samples.length) continue;
      const next = samples[index + 1];
      if (next.dockedTo || next._breakBefore) {
        if (next.dockedTo) joinedGap = true;
        continue;
      }
      const extras = extraByEnd[index + 1] || 0;
      if (next._interp === "j2") {
        const safePieces = Math.ceil(
          trajectorySpanSweep(sample, next) / TRAJECTORY_SAFE_J2_STEP);
        if (extras + 1 < safePieces) {
          forcedBreak = true;
          continue;
        }
      }
      for (let part = 1; part <= extras; part++) {
        const t = sample.t + (next.t - sample.t) * part / (extras + 1);
        const interpolated = globalThis.MissionEngine.sampleAtTime(result, t);
        if (!interpolated || interpolated.dockedTo) {
          joinedGap = true;
          continue;
        }
        points.push(sampleToFrame(result, interpolated, frameBody));
        times.push(t);
        breaks.push(joinedGap);
        joinedGap = false;
      }
    }
    const cached = { points, breaks, times };
    byFrame.set(key, cached);
    return cached;
  }

  function fleetVisibleRange(times, centerTime, windowS) {
    if (!Array.isArray(times) || times.length < 2)
      return { start: 0, end: times ? times.length : 0 };
    if (!(Number.isFinite(centerTime) && Number.isFinite(windowS) && windowS > 0))
      return { start: 0, end: times.length };
    const firstTime = centerTime - windowS / 2;
    const lastTime = centerTime + windowS / 2;
    let lo = 0, hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < firstTime) lo = mid + 1; else hi = mid;
    }
    const start = Math.max(0, lo - 1);
    lo = 0; hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= lastTime) lo = mid + 1; else hi = mid;
    }
    const end = Math.min(times.length, Math.max(start + 2, lo + 1));
    return { start, end };
  }

  function fleetTimeCovered(times, centerTime) {
    return Array.isArray(times) && times.length > 0 && Number.isFinite(centerTime) &&
      centerTime >= times[0] && centerTime <= times[times.length - 1];
  }

  function nativeFleetPathWindow(result, centerTime) {
    if (!result || !Array.isArray(result.samples) || result.samples.length < 2)
      return 2 * 3600;
    if (result.role === "rendezvous-target") return 2 * 3600;
    if (result.cr3bpOrbit && Number.isFinite(result.cr3bpOrbit.periodSeconds) &&
        result.cr3bpOrbit.periodSeconds > 0)
      return Math.min(30 * DAY, Math.max(2 * 3600,
        result.cr3bpOrbit.periodSeconds * 1.08));

    // Bound inactive vehicles need only local orbital context. Derive one
    // revolution from the current osculating state so a lunar lander, relay,
    // or station target cannot paint its entire later mission over the active
    // spacecraft. Transfer/landing states fall back to a bounded fraction of
    // their available history instead of inventing a closed orbit.
    const first = result.samples[0].t, last = result.samples[result.samples.length - 1].t;
    const sampleTime = Math.min(last, Math.max(first,
      Number.isFinite(centerTime) ? centerTime : first));
    const sample = globalThis.MissionEngine.sampleAtTime(result, sampleTime);
    const body = sample && BODIES[sample.cen];
    if (sample && body && body.mu > 0) {
      try {
        const coe = A.rvToCoe(sample.r, sample.v, body.mu);
        if (Number.isFinite(coe.a) && coe.a > body.radius && coe.e < 1) {
          const period = 2 * Math.PI * Math.sqrt(coe.a ** 3 / body.mu);
          if (Number.isFinite(period) && period > 0)
            return Math.min(14 * DAY, Math.max(30 * 60, period * 1.15));
        }
      } catch (_) { /* fall through to the open-trajectory display window */ }
    }
    return Math.min(2 * DAY, Math.max(2 * 3600, (last - first) / 12));
  }

  function activeTrajectoryWindow(result, sample) {
    const orbit = result && result.cr3bpOrbit;
    if (!sample || !sample.cr3bp || !orbit ||
        !(Number.isFinite(orbit.periodSeconds) && orbit.periodSeconds > 0)) return null;
    // One nearby reference cycle is enough to communicate the halo/Lissajous
    // geometry. Painting every configured stationkeeping cycle produces a
    // false visual divergence even when the integrated tracker is stable.
    return orbit.periodSeconds * 1.08;
  }
  function invalidateCache() {
    _cache = {
      result: null, key: null, rel: null, evRel: null,
      denseRel: null, denseT: null, denseBreakBefore: null, denseDocked: null,
      sampleDenseIndex: null,
    };
    _apsisCache = { result: null, key: null, pts: null, apo: null, peri: null, coe: null };
    _bridgeCache = {
      result: null, frameBody: null, i0: -1, i1: -1,
      windowKey: null, base: null,
    };
    _burnTimingCache = { result: null, timings: null };
    _fleetTrajectoryCache = new WeakMap();
    _synodicBasisCache = new Map();
  }

  function nativeFleetPointLimit(nativeVehicleCount) {
    const count = Math.max(1, Math.floor(nativeVehicleCount) || 1);
    return Math.min(4800, Math.max(900, Math.floor(FLEET_EXACT_POINT_CAP / count)));
  }

  /* Convert a propagated local state to the same time-dependent reference
     frame used by trajectoryCache. Body-relative frames translate every
     point at that point's epoch, then restore the frame body's display-time
     origin in draw(). */
  function localToFrame(r, cenId, frameBody, jdPoint) {
    const world = cenId === "sun" ? V.clone(r)
      : V.add(A.bodyWorld(cenId, jdPoint), r);
    return pointRelativeToDisplayFrame(world, frameBody, jdPoint);
  }

  function sampleToFrame(result, smp, frameBody) {
    if (!smp) return null;
    const jdPoint = result.epochJD + smp.t / DAY;
    return pointRelativeToDisplayFrame(smp.w, frameBody, jdPoint);
  }

  /* Insert tNow exactly and use a finer short-lived bridge for the active
     interval. trajectoryCache separately densifies every eligible stored
     Kepler span, so completed and upcoming arcs remain just as faithful. */
  function currentTrajectoryBridge(result, tNow, frameBody) {
    const ss = result && result.samples;
    if (!ss || !ss.length) return { lo: 0, hi: 0, past: [], future: [], current: null };
    let lo = 0, hi = ss.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (ss[m].t <= tNow) lo = m + 1; else hi = m;
    }
    const i0 = Math.max(0, lo - 1);
    const i1 = Math.min(i0 + 1, ss.length - 1);
    const a = ss[i0], b = ss[i1];
    const exactArc = a.cen === b.cen &&
      (b._interp === "kepler" || b._interp === "rk4" || b._interp === "j2" ||
        (a.forceModel && b.forceModel)) &&
      !a.landed && !b.landed;
    if (b._breakBefore) {
      const current = sampleToFrame(result,
        globalThis.MissionEngine.sampleAtTime(result, tNow), frameBody);
      const pa = sampleToFrame(result, a, frameBody);
      const pb = sampleToFrame(result, b, frameBody);
      const before = tNow < b.t;
      return {
        lo: i0, hi: i1,
        past: before && pa && current ? [pa, current] : (current ? [current] : []),
        future: before ? [] : (pb ? [pb] : []),
        current,
        discontinuity: true,
      };
    }
    if (i0 === i1 || b.t <= a.t || tNow < a.t ||
        (tNow === a.t && b._interp !== "j2") || tNow >= b.t) {
      const smp = globalThis.MissionEngine.sampleAtTime(result, tNow);
      const p = sampleToFrame(result, smp, frameBody);
      const adjacent = i1 > i0 ? sampleToFrame(result, b, frameBody) : null;
      const atStart = tNow <= a.t && p;
      return {
        lo: i0, hi: i1,
        past: tNow >= a.t && p ? [p] : [],
        // At an exact stored/event timestamp, connect the current point to
        // the following stored point. A one-point bridge is not stroked and
        // previously left a visible dashed-path gap after a burn.
        future: atStart && adjacent ? [p, adjacent] : (tNow <= b.t && p ? [p] : []),
        current: p,
      };
    }
    // Do not invent a curved bridge across an impulse, landing, or patched-
    // conic handoff. For non-propagated intervals, split the engine's own
    // interpolation at the exact current state and preserve its discontinuity.
    if (!exactArc) {
      const current = sampleToFrame(result,
        globalThis.MissionEngine.sampleAtTime(result, tNow), frameBody);
      const pa = sampleToFrame(result, a, frameBody);
      const pb = sampleToFrame(result, b, frameBody);
      return {
        lo: i0, hi: i1,
        past: pa && current ? [pa, current] : (current ? [current] : []),
        future: current && pb ? [current, pb] : (current ? [current] : []),
        current,
      };
    }
    const fullSweep = trajectorySpanSweep(a, b);
    let bridgeStart = a.t, bridgeEnd = b.t, windowKey = "full";
    if (b._interp === "j2" && fullSweep > 128 * TRAJECTORY_SAFE_J2_STEP) {
      const body = BODIES[a.cen];
      const coe = body ? A.rvToCoe(a.r, a.v, body.mu) : null;
      const period = coe && coe.e < 1 && coe.a > 0
        ? 2 * Math.PI * Math.sqrt(coe.a ** 3 / body.mu) : 0;
      if (period > 0 && isFinite(period)) {
        const bucket = Math.max(period / 8, 1);
        const bucketIndex = Math.floor((tNow - a.t) / bucket);
        const centerT = Math.min(b.t, Math.max(a.t,
          a.t + (bucketIndex + 0.5) * bucket));
        bridgeStart = Math.max(a.t, centerT - period);
        bridgeEnd = Math.min(b.t, centerT + period);
        windowKey = String(bucketIndex);
      }
    }
    if (_bridgeCache.result !== result || _bridgeCache.frameBody !== frameBody ||
        _bridgeCache.i0 !== i0 || _bridgeCache.i1 !== i1 ||
        _bridgeCache.windowKey !== windowKey) {
      // The active bridge gets a finer target than the cached whole-mission
      // path because the ship and osculating overlay meet here every frame.
      const windowSweep = fullSweep *
        ((bridgeEnd - bridgeStart) / Math.max(b.t - a.t, 1e-9));
      const pieces = Math.min(128, Math.max(4,
        Math.ceil(windowSweep / (0.5 * Math.PI / 180))));
      const base = [];
      for (let k = 0; k <= pieces; k++) {
        const t = bridgeStart + (bridgeEnd - bridgeStart) * k / pieces;
        const smp = globalThis.MissionEngine.sampleAtTime(result, t);
        const p = sampleToFrame(result, smp, frameBody);
        if (p) base.push({ t, p });
      }
      _bridgeCache = { result, frameBody, i0, i1, windowKey, base };
    }
    const nowSmp = globalThis.MissionEngine.sampleAtTime(result, tNow);
    const current = sampleToFrame(result, nowSmp, frameBody);
    const past = [], future = [];
    for (const item of _bridgeCache.base) {
      if (item.t < tNow - 1e-7) past.push(item.p);
      else if (item.t > tNow + 1e-7) future.push(item.p);
    }
    if (current) { past.push(current); future.unshift(current); }
    return { lo: i0, hi: i1, past, future, current };
  }

  /* During a visual burn ramp the osculating orbit is deliberately different
     from the instantaneous solver trajectory. Burn/capture previews retain the
     shared display conic. An escape stops having a finite apoapsis at ignition,
     so its closed guide ends there and only the exact open path may fade in. */
  function trajectoryBridgeForDisplay(result, tNow, frameBody, previewGeometry, preview) {
    const bridge = currentTrajectoryBridge(result, tNow, frameBody);
    if (preview && preview.mode === "escape" && preview.apoOpen) {
      return Object.assign({}, bridge, {
        previewFuture: null,
        previewAlpha: 0,
        // Departures now propagate their local hyperbolic coast explicitly;
        // there is no omitted-distance bridge to fade across after ignition.
        solvedAlpha: 1,
        previewActive: true,
      });
    }
    if (!previewGeometry || !previewGeometry.pts || previewGeometry.pts.length < 2)
      return bridge;
    const solvedAlpha = preview && preview.mode === "escape" ? preview.solvedBlend : 0;
    return Object.assign({}, bridge, {
      previewFuture: previewGeometry.pts,
      previewAlpha: 1 - solvedAlpha,
      solvedAlpha,
      previewActive: true,
    });
  }

  const wrap2pi = (x) => {
    const y = x % (2 * Math.PI);
    return y < 0 ? y + 2 * Math.PI : y;
  };
  function meanFromTrue(nu, e) {
    const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2),
      Math.sqrt(1 + e) * Math.cos(nu / 2));
    return wrap2pi(E - e * Math.sin(E));
  }

  /* Build one future osculating revolution in the selected display frame.
     Unlike the old closed ellipse translated to the central body's current
     position, this applies the central and frame-body ephemerides at every
     point's own time. It therefore overlays the propagated trajectory in
     heliocentric and third-body frames as well as in local frames. */
  function osculatingGeometry(state, stateJD, frameBody, nPts) {
    const body = state && BODIES[state.cen];
    if (!body || state.landed) return null;
    const coe = A.rvToCoe(state.r, state.v, body.mu);
    if (!(coe.e < 1 && coe.a > 0 && isFinite(coe.ra) && isFinite(coe.rp))) return null;
    const period = 2 * Math.PI * Math.sqrt((coe.a * coe.a * coe.a) / body.mu);
    if (!(period > 0 && isFinite(period))) return null;
    const count = nPts || 128;
    const pts = [];
    const M0 = meanFromTrue(coe.nu, coe.e);
    const meanRate = 2 * Math.PI / period;
    const staticFrame = isStaticApsisFrame(frameBody, state.cen);
    if (staticFrame) {
      // In the central-body frame the conic is stationary. Sampling eccentric
      // anomaly starts the closed line at the exact current state and avoids
      // hundreds of universal-variable iterations during a burn preview.
      const E0 = 2 * Math.atan2(Math.sqrt(1 - coe.e) * Math.sin(coe.nu / 2),
        Math.sqrt(1 + coe.e) * Math.cos(coe.nu / 2));
      for (let k = 0; k <= count; k++) {
        const E = E0 + 2 * Math.PI * k / count;
        const nu = A.trueFromEccAnomaly(E, coe.e);
        const r = A.coeToRV({ ...coe, nu }, body.mu).r;
        pts.push(localToFrame(r, state.cen, frameBody, stateJD));
      }
    } else {
      for (let k = 0; k <= count; k++) {
        const dt = period * k / count;
        const st = A.propagateUniversal(state.r, state.v, dt, body.mu);
        pts.push(localToFrame(st.r, state.cen, frameBody, stateJD + dt / DAY));
      }
    }
    const atApsis = (targetM) => {
      const dt = wrap2pi(targetM - M0) / meanRate;
      const st = A.propagateUniversal(state.r, state.v, dt, body.mu);
      return localToFrame(st.r, state.cen, frameBody, stateJD + dt / DAY);
    };
    return { coe, period, pts, peri: atApsis(0), apo: atApsis(Math.PI) };
  }

  function isStaticApsisFrame(frameBody, centralBody) {
    return frameBody === centralBody ||
      (frameBody === "inertial" && centralBody === "sun");
  }

  function boundedPreviewA(body, rMag) {
    // Escape/capture has no finite apoapsis. The old camera-scale-only cap
    // stopped an Earth escape near 50,000 km, so its AP never visibly crossed
    // the Moon before changing to AP OPEN. Let the illustrative ellipse grow
    // through 85% of the current body's SOI; the 92% ceiling keeps the guide
    // clearly inside the frame boundary and distinct from the exact hyperbola.
    const raByScale = Math.max(rMag * 6, body.radius * 8);
    const ra = isFinite(body.soi)
      ? Math.min(body.soi * 0.92, Math.max(body.soi * 0.85, raByScale))
      : raByScale;
    return 0.5 * (rMag + Math.max(ra, rMag * 1.25));
  }

  function speedForA(mu, rMag, a) {
    return Math.sqrt(Math.max(0, mu * (2 / rMag - 1 / a)));
  }

  /* Re-express a post-handoff spacecraft state in the burn body's local
     frame. All generated handoffs are position-continuous; combining a real
     position with an unrelated illustrative velocity would manufacture a
     false post-ignition conic. */
  function stateInBurnFrame(result, live, burn, eventT) {
    if (!result || !live || !burn || !BODIES[burn.cen]) return null;
    if (live.cen === burn.cen) return live;
    return actualStateInBodyFrame(result, live, burn.cen);
  }

  function actualStateInBodyFrame(result, live, bodyId) {
    if (!result || !live || !BODIES[bodyId]) return null;
    if (live.cen === bodyId) return live;
    const jd = result.epochJD + live.t / DAY;
    const worldR = live.w || (live.cen === "sun" ? V.clone(live.r)
      : V.add(A.bodyWorld(live.cen, jd), live.r));
    const worldV = live.cen === "sun" ? V.clone(live.v)
      : V.add(A.bodyWorldVel(live.cen, jd), live.v);
    return {
      cen: bodyId, t: live.t, seg: live.seg, landed: false,
      r: V.sub(worldR, A.bodyWorld(bodyId, jd)),
      v: V.sub(worldV, A.bodyWorldVel(bodyId, jd)),
    };
  }

  /* Burn endpoints and their visual windows are immutable within one solved
     result. Auto camera and the renderer both query them every animation
     frame, so cache the coefficient/timing work instead of repeating two
     rvToCoe conversions for every burn at native monitor refresh. */
  function burnPreviewTimings(result) {
    if (!result || !result.events) return [];
    if (_burnTimingCache.result === result) return _burnTimingCache.timings;
    const timings = [];
    const missionStart = result.samples && result.samples.length ? result.samples[0].t : 0;
    for (const event of result.events) {
      const burn = event._burn;
      if (!burn || !BODIES[burn.cen]) continue;
      const body = BODIES[burn.cen];
      const coe0 = A.rvToCoe(burn.r, burn.v0, body.mu);
      const coe1 = A.rvToCoe(burn.r, burn.v1, body.mu);
      const bound0 = coe0.e < 1 && coe0.a > 0 && isFinite(coe0.a);
      const bound1 = coe1.e < 1 && coe1.a > 0 && isFinite(coe1.a);
      if (!bound0 && !bound1) continue;
      const mode = !bound0 && bound1 ? "capture" : (bound0 && !bound1 ? "escape" : "burn");
      const referenceA = bound1 ? coe1.a : coe0.a;
      const period = 2 * Math.PI * Math.sqrt((referenceA * referenceA * referenceA) / body.mu);
      const duration = Math.min(1800, Math.max(240, period * 0.15));
      let start, end;
      if (mode === "capture") {
        // The spacecraft remains in the captured body's frame after insertion.
        start = event.t;
        end = event.t + duration;
      } else if (mode === "escape") {
        // Straddle a patched-conic handoff: most of the raise leads into the
        // impulse, with a short attached overlap in the new solver frame.
        const lead = Math.min(duration * 0.75, Math.max(0, event.t - missionStart));
        start = event.t - lead;
        end = start + duration;
      } else {
        const lead = Math.min(duration, Math.max(0, event.t - missionStart));
        start = event.t - lead;
        end = event.t + (duration - lead);
      }
      timings.push({ event, duration, start, end, mode, coe0, coe1 });
    }
    _burnTimingCache = { result, timings };
    return timings;
  }

  /* Deterministic, visual-only ramp around an instantaneous burn.
     It never changes result.samples or the solved mission. Bound-to-unbound
     departures use a finite, explicitly idealized display ellipse only before
     ignition; captures retain one while the finite apoapsis lowers. */
  function burnPreviewState(result, tNow, currentState) {
    if (!result || !result.events) return null;
    const live = currentState || globalThis.MissionEngine.sampleAtTime(result, tNow);
    if (!live || live.landed) return null;
    let chosen = null;
    for (const timing of burnPreviewTimings(result)) {
      const ev = timing.event, b = ev._burn;
      const { duration, start, end, mode, coe0, coe1 } = timing;
      if (tNow < start || tNow > end) continue;
      let previewLive = live;
      if (live.cen !== b.cen) {
        if (mode !== "escape" || tNow < ev.t) continue;
        previewLive = stateInBurnFrame(result, live, b, ev.t);
        if (!previewLive) continue;
      }
      const score = Math.abs(ev.t - tNow);
      if (!chosen || score < chosen.score)
        chosen = { event: ev, duration, start, end, score, mode, coe0, coe1,
          live: previewLive };
    }
    if (!chosen) return null;
    const b = chosen.event._burn;
    // A bounded escape guide must finish raising by ignition. Previously the
    // escape window reserved 25% of its duration for the post-burn handoff,
    // so the pre-burn fraction stopped near 0.84 and the displayed lunar AP
    // appeared to stall around 35,000 km before becoming an open trajectory.
    const rampEnd = chosen.mode === "escape" ? chosen.event.t
      : chosen.start + chosen.duration;
    const raw = Math.max(0, Math.min(1,
      (tNow - chosen.start) / Math.max(rampEnd - chosen.start, 1e-9)));
    const f = raw * raw * (3 - 2 * raw);
    const apoOpen = chosen.mode === "escape" && tNow >= chosen.event.t;
    let solvedBlend = 0;
    if (chosen.mode === "escape" && tNow > chosen.event.t) {
      const postSpan = Math.max(chosen.end - chosen.event.t, 1e-9);
      const handoffRaw = Math.max(0, Math.min(1, (tNow - chosen.event.t) / postSpan));
      solvedBlend = handoffRaw * handoffRaw * (3 - 2 * handoffRaw);
    }
    const previewLive = chosen.live;
    let v;
    if (chosen.mode === "escape" && apoOpen) {
      // There is no finite osculating apoapsis after an escape impulse. Keep
      // the exact (or explicit instant-SOI bridge) velocity instead of making
      // a bounded ellipse from unrelated position and velocity sources.
      v = V.clone(previewLive.v);
    } else if (chosen.mode === "capture" || chosen.mode === "escape") {
      const rMag = V.mag(previewLive.r);
      const aLimit = boundedPreviewA(BODIES[b.cen], V.mag(b.r));
      const a0 = chosen.mode === "capture" ? aLimit : chosen.coe0.a;
      const a1 = chosen.mode === "capture" ? chosen.coe1.a : aLimit;
      // Geometric interpolation makes a large illustrative apsis change read
      // steadily instead of collapsing almost entirely in the last frames.
      const a = Math.exp(Math.log(a0) + (Math.log(a1) - Math.log(a0)) * f);
      v = V.scale(V.norm(previewLive.v), speedForA(BODIES[b.cen].mu, rMag, a));
    } else {
      const dv = V.sub(b.v1, b.v0);
      let beforeBurn = tNow < chosen.event.t;
      if (Math.abs(tNow - chosen.event.t) < 1e-7) {
        // Most event timestamps resolve to the post-impulse duplicate sample;
        // a burn at mission T+0 resolves to the first (pre-impulse) sample.
        // Pick the matching endpoint so the visual state stays continuous.
        beforeBurn = V.mag(V.sub(previewLive.v, b.v0)) <= V.mag(V.sub(previewLive.v, b.v1));
      }
      v = beforeBurn
        ? V.add(previewLive.v, V.scale(dv, f))
        : V.sub(previewLive.v, V.scale(dv, 1 - f));
    }
    return {
      event: chosen.event,
      mode: chosen.mode,
      fraction: f,
      apoOpen,
      solvedBlend,
      previewAlpha: apoOpen ? 0 : 1 - solvedBlend,
      start: chosen.start,
      end: chosen.end,
      state: {
        cen: previewLive.cen, t: previewLive.t, seg: previewLive.seg, landed: false,
        // Before ignition this keeps the preview conic on the spacecraft. An
        // open escape stores the exact/bridge state but never draws apsides.
        // This remains visualization, not finite-thrust integration.
        r: V.clone(previewLive.r),
        v,
      },
    };
  }

  function thrustDirectionLabel(direction, state) {
    const d = V.norm(direction || [0, 0, 0]);
    if (!state || V.mag(d) === 0) return "VECTOR";
    const v = V.norm(state.v), r = V.norm(state.r);
    const n = V.norm(V.cross(state.r, state.v));
    const tests = [
      [V.dot(d, v), "PROGRADE"], [-V.dot(d, v), "RETROGRADE"],
      [V.dot(d, r), "RADIAL OUT"], [-V.dot(d, r), "RADIAL IN"],
      [V.dot(d, n), "NORMAL"], [-V.dot(d, n), "ANTINORMAL"],
    ].sort((a, b) => b[0] - a[0]);
    return tests[0][0] >= 0.82 ? tests[0][1] : "VECTOR";
  }

  /* Truthful engine/thrust readout for both propagation models. A finite
     burn is genuinely active over a time interval. Ordinary Planner burns
     are impulses, so their longer visual cue is explicitly called a preview
     rather than pretending the engine is continuously firing. */
  function thrustCueState(result, tNow, currentState) {
    if (!result || !currentState || currentState.landed) return {
      active: false, engineOn: false, label: "OFF", direction: null,
    };
    const mission = result.mission;
    const segment = mission && mission.segments && mission.segments[currentState.seg];
    if (segment && segment.type === "launch" &&
        tNow >= segment._t0 - 1e-6 && tNow <= segment._t1 + 1e-6) {
      let direction = V.norm(currentState.v);
      if (V.mag(direction) === 0) direction = V.norm(currentState.r);
      return {
        active: true, engineOn: true, schematic: true, direction,
        directionLabel: "ASCENT",
        label: "ON · ASCENT MODEL · FLIGHT PATH",
      };
    }
    if (segment && segment.type === "finite_burn" &&
        tNow >= segment._t0 - 1e-6 && tNow <= segment._t1 + 1e-6) {
      const law = String(segment.direction || "prograde");
      let direction = law === "retrograde" ? V.scale(V.norm(currentState.v), -1)
        : law === "inertial"
          ? V.norm([+segment.dirX || 0, +segment.dirY || 0, +segment.dirZ || 0])
          : V.norm(currentState.v);
      if (V.mag(direction) === 0) direction = V.norm(currentState.r);
      const directionLabel = law === "inertial"
        ? thrustDirectionLabel(direction, currentState) : law.toUpperCase();
      return {
        active: true, engineOn: true, finite: true, direction, directionLabel,
        thrustN: +segment.thrustN || 0,
        label: `ON · ${directionLabel} · ${(+segment.thrustN || 0).toFixed(0)} N`,
      };
    }
    const preview = burnPreviewState(result, tNow, currentState);
    const burn = preview && preview.event && preview.event._burn;
    if (burn) {
      const direction = V.norm(V.sub(burn.v1, burn.v0));
      if (V.mag(direction) > 0) {
        const directionLabel = thrustDirectionLabel(direction,
          preview.state || currentState);
        return {
          active: true, engineOn: false, impulse: true, direction,
          directionLabel, event: preview.event,
          label: `IMPULSE PREVIEW · ${directionLabel}`,
        };
      }
    }
    return { active: false, engineOn: false, label: "OFF", direction: null };
  }

  /* Visual-only spacecraft state used around a burn. Escape states are exact
     from ignition onward; their continuous local coast must never be replaced
     by screen-space interpolation toward a distant SOI point. */
  function burnPreviewDisplayState(result, live, preview) {
    if (!result || !live || !preview) return live;
    if (preview.mode !== "escape") return Object.assign({}, live, {
      cen: preview.state.cen,
      r: V.clone(preview.state.r),
      v: V.clone(preview.state.v),
      w: preview.state.cen === "sun" ? V.clone(preview.state.r)
        : V.add(A.bodyWorld(preview.state.cen, result.epochJD + preview.state.t / DAY),
          preview.state.r),
    });
    if (preview.apoOpen) return live;
    const bodyId = preview.state.cen;
    const exactLocal = actualStateInBodyFrame(result, live, bodyId);
    if (!exactLocal) return live;
    const q = preview.solvedBlend;
    const mix = (a, b) => V.add(V.scale(a, 1 - q), V.scale(b, q));
    const r = mix(preview.state.r, exactLocal.r);
    const v = mix(preview.state.v, exactLocal.v);
    const jd = result.epochJD + live.t / DAY;
    return {
      cen: bodyId, t: live.t, seg: live.seg, landed: false,
      r, v, w: V.add(A.bodyWorld(bodyId, jd), r),
      interp: true,
    };
  }

  function shouldDrawFiniteApsis(preview) {
    return !(preview && preview.mode === "escape" && preview.apoOpen);
  }

  function shadowConeGeometry(lightPosition, occulterPosition, lightRadius,
    occulterRadius, maxLength) {
    const separation = V.sub(occulterPosition, lightPosition);
    const distance = V.mag(separation);
    if (!(distance > lightRadius + occulterRadius) || !(lightRadius > occulterRadius) ||
        !(occulterRadius > 0)) return null;
    const axis = V.scale(separation, 1 / distance);
    const umbraLength = occulterRadius * distance / (lightRadius - occulterRadius);
    const displayLength = Math.max(occulterRadius * 4, Math.min(umbraLength * 1.2,
      Number.isFinite(maxLength) && maxLength > 0 ? maxLength : umbraLength * 1.2));
    return {
      axis,
      distance,
      umbraLength,
      displayLength,
      umbraEndRadius: Math.max(0, occulterRadius * (1 - displayLength / umbraLength)),
      penumbraEndRadius: occulterRadius + displayLength *
        (lightRadius + occulterRadius) / distance,
    };
  }

  function burnPreviewNotice(preview) {
    if (!preview) return null;
    const pct = Math.round(preview.fraction * 100);
    const action = preview.mode === "capture" ? "CAPTURE / AP LOWERING"
      : (preview.mode === "escape" ? (preview.apoOpen
        ? "ESCAPE / AP OPEN" : "ESCAPE / AP RAISING") : "BURN");
    return {
      primary: `IDEALIZED ${action} ${pct}%`,
      secondary: "DISPLAY PREVIEW · SOLVER BURN IS INSTANTANEOUS",
    };
  }

  /* ------------------------------- draw -------------------------------- */
  function draw(g, w, h, scene) {
    const { camera, jd, result, tNow, frameBody, shipSmp } = scene;
    const opts = scene.options || {};
    const activeBurnPreview = result && shipSmp
      ? burnPreviewState(result, tNow, shipSmp) : null;
    const renderShipSmp = activeBurnPreview
      ? burnPreviewDisplayState(result, shipSmp, activeBurnPreview) : shipSmp;
    /* Deep-space views may supply bounded authoritative body positions while
     * Planner callers omit these hooks and retain the existing Astro model. */
    const bodyWorld = (bodyId, atJd) => bodyWorldForScene(scene, bodyId, atJd);
    const flat = !!opts.flatLight;           // "full bright": no night side
    const evPick = [], fleetPick = [];
    const f = (h / 2) / Math.tan(camera.fov / 2);
    const cx = w / 2, cy = h / 2;

    /* camera basis */
    const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
    const cyw = Math.cos(camera.yaw), syw = Math.sin(camera.yaw);
    const u = [cp * cyw, cp * syw, sp];             // center -> camera direction
    const F = [-u[0], -u[1], -u[2]];                // view direction
    let Rt = V.cross(F, [0, 0, 1]);
    if (V.mag(Rt) < 1e-9) Rt = [1, 0, 0];
    Rt = V.norm(Rt);
    const Up = V.cross(Rt, F);
    const near = Math.max(1e-3, camera.dist * 1e-4);

    /* focus */
    const displayFrame = displayFrameContext(frameBody, jd, bodyWorld);
    const frameOffset = displayFrame.offset;
    const textureCameraBasis = displayFrame.kind === "synodic" ? {
      Rt: vectorFromDisplayFrame(Rt, displayFrame),
      Up: vectorFromDisplayFrame(Up, displayFrame),
      F: vectorFromDisplayFrame(F, displayFrame),
    } : { Rt, Up, F };
    const displayAtCurrentEpoch = (worldPoint) => pointInDisplayFrame(worldPoint,
      frameBody, jd, jd, bodyWorld, displayFrame, displayFrame);
    let focusWorld;
    if (camera.focusMode === "ship" && renderShipSmp) {
      const shipJD = scene.epochJD + renderShipSmp.t / DAY;
      focusWorld = pointInDisplayFrame(renderShipSmp.w, frameBody, shipJD, jd,
        bodyWorld, shipJD === jd ? displayFrame : null, displayFrame);
    } else if (camera.focusMode === "free" && camera.freeFocus) {
      focusWorld = camera.freeFocus;
    } else {
      focusWorld = displayAtCurrentEpoch(bodyWorld(camera.focusBody, jd));
    }
    const center = V.add(focusWorld, camera.pan);
    /* Exact world-space camera position. Overlay renderers use this with the
       physical body spheres below so POV and close-focus occlusion is based
       on the eye-to-point sightline rather than a projected depth shortcut. */
    const eyeWorld = V.sub(center, V.scale(F, camera.dist));

    const eye = (p) => {
      const rl = V.sub(p, center);
      return [V.dot(rl, Rt), V.dot(rl, Up), V.dot(rl, F) + camera.dist];
    };
    const scr = (e) => [cx + (f * e[0]) / e[2], cy - (f * e[1]) / e[2]];
    const project = (p) => {
      const e = eye(p);
      if (e[2] <= near) return null;
      const s = scr(e);
      return { x: s[0], y: s[1], z: e[2] };
    };

    if (TEX && TEX.beginFrame) TEX.beginFrame();

    /* background */
    g.fillStyle = P().bg;
    g.fillRect(0, 0, w, h);

    /* stars (infinitely distant: rotation only) */
    for (const st of STARS) {
      const ze = V.dot(st.d, F);
      if (ze <= 0.02) continue;
      const sx = cx + (f * V.dot(st.d, Rt)) / ze;
      const sy = cy - (f * V.dot(st.d, Up)) / ze;
      if (sx < 0 || sx > w || sy < 0 || sy > h) continue;
      const stA = st.m * 0.6 * (P().starAlpha == null ? 1 : P().starAlpha);
      if (stA <= 0.01) continue;
      g.fillStyle = `rgba(${P().starRGB},${stA.toFixed(2)})`;
      g.fillRect(sx, sy, st.big ? 1.6 : 1, st.big ? 1.6 : 1);
    }

    /* polyline with optional per-point skip (used for ring occlusion).
       Allocation-free scalar math — this is the render hot path. */
    const polyline = (pts, stride, skipFn, start, end, offset, breaks) => {
      g.beginPath();
      let pex = 0, pey = 0, pez = 0, have = false, open = false, prevSkip = false;
      let previousIndex = -1;
      const n = pts.length;
      const step = stride || 1;
      const i0 = start === undefined ? 0 : start;
      const i1 = end === undefined ? n : Math.min(end, n);
      const ox = offset ? offset[0] : 0, oy = offset ? offset[1] : 0, oz = offset ? offset[2] : 0;
      const RtX = Rt[0], RtY = Rt[1], RtZ = Rt[2];
      const UpX = Up[0], UpY = Up[1], UpZ = Up[2];
      const FX = F[0], FY = F[1], FZ = F[2];
      const cX = center[0], cY = center[1], cZ = center[2], D = camera.dist;
      for (let i = i0; i < i1; i = nextPolylineIndex(i, i1, step)) {
        if (hasPolylineBreak(breaks, previousIndex, i)) {
          have = false;
          open = false;
          prevSkip = false;
        }
        const p = pts[i];
        const rx = p[0] + ox - cX, ry = p[1] + oy - cY, rz = p[2] + oz - cZ;
        const ex = rx * RtX + ry * RtY + rz * RtZ;
        const ey = rx * UpX + ry * UpY + rz * UpZ;
        const ez = rx * FX + ry * FY + rz * FZ + D;
        const skip = skipFn ? skipFn(p, ex, ey, ez, i) : false;
        if (have && !skip && !prevSkip) {
          if (pez > near && ez > near) {
            if (!open) { g.moveTo(cx + (f * pex) / pez, cy - (f * pey) / pez); open = true; }
            g.lineTo(cx + (f * ex) / ez, cy - (f * ey) / ez);
          } else if (pez > near || ez > near) {
            const t = (near - pez) / (ez - pez);
            const mx = pex + (ex - pex) * t, my = pey + (ey - pey) * t, mz = near * 1.0001;
            if (pez > near) {
              if (!open) { g.moveTo(cx + (f * pex) / pez, cy - (f * pey) / pez); open = true; }
              g.lineTo(cx + (f * mx) / mz, cy - (f * my) / mz);
              open = false;
            } else {
              g.moveTo(cx + (f * mx) / mz, cy - (f * my) / mz);
              g.lineTo(cx + (f * ex) / ez, cy - (f * ey) / ez);
              open = true;
            }
          } else open = false;
        } else if (skip) open = false;
        pex = ex; pey = ey; pez = ez; have = true;
        prevSkip = skip;
        previousIndex = i;
      }
      g.stroke();
    };

    /* ecliptic grid rings around the Sun */
    if (opts.grid !== false && P().paperGrid) {
      /* blueprint: screen-space graph-paper grid */
      g.strokeStyle = P().paperGrid;
      g.lineWidth = 1;
      g.beginPath();
      for (let gx = 0.5; gx < w; gx += 44) { g.moveTo(gx, 0); g.lineTo(gx, h); }
      for (let gy = 0.5; gy < h; gy += 44) { g.moveTo(0, gy); g.lineTo(w, gy); }
      g.stroke();
    }
    if (opts.grid !== false && !P().paperGrid) {
      g.strokeStyle = P().grid;
      g.lineWidth = 1;
      const rings = [0.4, 1, 2, 5, 10, 20, 40];
      for (const rAU of rings) {
        const pts = [];
        for (let k = 0; k <= 90; k++) {
          const a = (k / 90) * 2 * Math.PI;
          const world = [rAU * AU * Math.cos(a), rAU * AU * Math.sin(a), 0];
          pts.push(displayAtCurrentEpoch(world));
        }
        polyline(pts);
      }
    }

    /* bodies: positions now */
    const showMinor = opts.minor !== false;
    const bodyPos = {}, bodyPrj = {}, bodyActual = {};
    for (const id in BODIES) {
      bodyActual[id] = bodyWorld(id, jd);
      bodyPos[id] = displayAtCurrentEpoch(bodyActual[id]);
      bodyPrj[id] = project(bodyPos[id]);
    }
    const hasMinorAncestor = (b) => {
      let cur = b;
      while (cur && cur.id !== "sun") {
        if (C.isMinor(cur)) return true;
        cur = BODIES[cur.parent];
      }
      return false;
    };
    const isShown = (b) => showMinor || !hasMinorAncestor(b) ||
      b.id === camera.focusBody || b.id === frameBody;

    /* orbit paths */
    if (opts.orbits !== false) {
      const orbitFocus = BODIES[camera.focusBody];
      const localOrbitFocus = orbitFocus && orbitFocus.id !== "sun" &&
        camera.dist < orbitFocus.radius * 120 ? orbitFocus.id : null;
      for (const id in BODIES) {
        const b = BODIES[id];
        if (!b.parent || !isShown(b)) continue;
        // At local-body scale, heliocentric and parent-system orbits become a
        // dense set of near-straight lines through the focused globe. Retain
        // only the focused body's satellites; mission trajectories remain.
        if (localOrbitFocus && b.parent !== localOrbitFocus) continue;
        const parentE = eye(bodyPos[b.parent]);
        const dPar = Math.hypot(parentE[0], parentE[1], parentE[2]);
        const appOrbit = (f * 2 * b.aKm) / Math.max(dPar, near);
        if (appOrbit < 5 && camera.focusBody !== id && frameBody !== id) continue;
        // precision trigger uses the BODY's own distance: an orbit passing
        // close to the camera magnifies the 181-point chord sag far beyond
        // what the parent-distance estimate suggests (oblique views).
        const bodyE = eye(bodyPos[id]);
        const dBody = Math.hypot(bodyE[0], bodyE[1], bodyE[2]);
        const appLocal = (f * 2 * b.aKm) / Math.max(dBody, near);
        const parentW = bodyPos[b.parent];
        const parentActual = bodyActual[b.parent];
        {
          const oa = id === camera.focusBody ? 0.5 : (C.isMinor(b) ? 0.16 : 0.28);
          if (P().orbitDarken) {
            const [or1, og1, ob1] = hexToRgb(b.color);
            g.strokeStyle = `rgba(${(or1 * 0.5) | 0},${(og1 * 0.5) | 0},${(ob1 * 0.5) | 0},${Math.min(1, oa * 2.4)})`;
          } else g.strokeStyle = hexA(b.color, oa);
        }
        g.lineWidth = 1;
        const providedPath = bodyOrbitPathForScene(scene, id, jd);
        const providedPoints = Array.isArray(providedPath) ? providedPath
          : (providedPath && Array.isArray(providedPath.points) ? providedPath.points : null);
        if (providedPoints && providedPoints.length > 1) {
          /* Providers may return world points directly or a cached osculating
           * parent-local path; the latter follows the authoritative current
           * parent position without rebuilding its geometry every paint. */
          if (displayFrame.kind === "synodic") {
            const mapped = providedPoints.map((point) => displayAtCurrentEpoch(
              providedPath && providedPath.parentLocal ? V.add(parentActual, point) : point));
            polyline(mapped);
          } else {
            polyline(providedPoints, 1, null, 0, providedPoints.length,
              providedPath && providedPath.parentLocal ? parentW : null);
          }
          continue;
        }
        let pts;
        if (appLocal > 2600) {
          // zoomed in: the cached 181-point ellipse has a chord sag of
          // ~1.5e-4·a (≈23,000 km for Earth) — visibly missing the body.
          // Sample a fine local arc through the exact current true anomaly
          // instead, so the orbit line passes through the body itself.
          const el = A.elementsAt(b, jd);
          const muP = BODIES[b.parent].mu;
          const nu0 = A.trueFromEccAnomaly(A.solveKeplerE(el.M, el.e), el.e);
          const halfSpan = Math.min(Math.PI, (6 * Math.PI * w) / appLocal);
          pts = [];
          for (let k = 0; k <= 64; k++) {
            const nu = nu0 + (k / 32 - 1) * halfSpan;
            const actual = V.add(parentActual,
              A.coeToRV({ a: el.a, e: el.e, i: el.i, Om: el.Om, w: el.w, nu }, muP).r);
            pts.push(displayAtCurrentEpoch(actual));
          }
          polyline(pts);
        } else {
          pts = A.bodyOrbitPath(id);
          // The path is cached in parent-local coordinates; pass the parent
          // translation into the projector instead of allocating 181 world
          // vectors for every visible orbit on every frame.
          if (displayFrame.kind === "synodic") {
            const mapped = pts.map((point) => displayAtCurrentEpoch(V.add(parentActual, point)));
            polyline(mapped);
          } else polyline(pts, 1, null, 0, pts.length, parentW);
        }
      }
    }

    let previewTrajectoryGeometry = null;
    /* Live osculating orbit + apsides. The normal overlay is the exact
       current conic. In the short lead-in to an impulse, a labelled visual
       preview blends the pre/post velocity vectors so the planned apoapsis
       raise can be read gradually; the solved burn itself remains instant. */
    if (opts.apsides !== false && shipSmp && !shipSmp.landed && !shipSmp.cr3bp &&
        BODIES[shipSmp.cen]) {
      const preview = activeBurnPreview;
      const apsisState = preview ? preview.state : shipSmp;
      const cenBody = BODIES[apsisState.cen];
      const coe = A.rvToCoe(apsisState.r, apsisState.v, cenBody.mu);
      if (shouldDrawFiniteApsis(preview) &&
          coe.e < 1 && coe.a > 0 && isFinite(coe.ra) && isFinite(coe.rp) &&
          coe.rp >= cenBody.radius - 1e-6) {
        const stateJD = scene.epochJD + apsisState.t / DAY;
        const period = 2 * Math.PI * Math.sqrt((coe.a * coe.a * coe.a) / cenBody.mu);
        // A non-central display frame changes as its origin moves. Bucket the
        // start epoch finely enough to keep the swept orbit visually attached
        // without rebuilding 129 propagated points at display refresh rate.
        const epochBucketS = Math.min(300, Math.max(5, period / 720));
        // Sun-centered conics are also stationary in the inertial frame.
        // Treating that case as time-dependent rebuilt 129 propagated points
        // at nearly every accelerated Cassini/Voyager frame even though the
        // geometry had not changed.
        const frameEpochKey = isStaticApsisFrame(frameBody, apsisState.cen) ? "static"
          : Math.floor((stateJD * DAY) / epochBucketS);
        const previewKey = preview
          ? preview.event.t + ":" + preview.fraction.toFixed(2) : "live";
        const key = [apsisState.cen, apsisState.seg, frameBody, frameEpochKey, previewKey,
          Math.round(coe.a * 10), coe.e.toFixed(7), coe.i.toFixed(6),
          coe.Om.toFixed(6), coe.w.toFixed(6)].join("|");
        if (_apsisCache.result !== result || _apsisCache.key !== key) {
          const geom = osculatingGeometry(apsisState, stateJD, frameBody, 128);
          _apsisCache = {
            result, key, coe,
            pts: geom.pts,
            peri: geom.peri,
            apo: geom.apo,
          };
        }
        if (preview) previewTrajectoryGeometry = _apsisCache;
        const apsisOffset = frameBody === "inertial" ? null : frameOffset;
        g.save();
        g.globalAlpha *= preview ? preview.previewAlpha : 1;
        g.strokeStyle = P().apsisOrbit || PAL_DEFAULT.apsisOrbit;
        g.lineWidth = 1.1;
        g.setLineDash([3, 5]);
        polyline(_apsisCache.pts, 1, null, 0, _apsisCache.pts.length, apsisOffset);
        g.setLineDash([]);
        const fmtApsis = (radius) => {
          if (apsisState.cen === "sun") return (radius / AU).toFixed(3) + " AU";
          const alt = radius - cenBody.radius;
          if (Math.abs(alt) >= 1e6) return (alt / 1e6).toFixed(2) + "M km";
          if (Math.abs(alt) >= 1e4) return Math.round(alt).toLocaleString("en-US") + " km";
          return alt.toFixed(0) + " km";
        };
        for (const mark of [
          { local: _apsisCache.apo, label: "AP " + fmtApsis(coe.ra), color: P().apsisApo || PAL_DEFAULT.apsisApo },
          { local: _apsisCache.peri, label: "PE " + fmtApsis(coe.rp), color: P().apsisPeri || PAL_DEFAULT.apsisPeri },
        ]) {
          const pr = project(apsisOffset ? V.add(mark.local, apsisOffset) : mark.local);
          if (!pr) continue;
          g.fillStyle = mark.color;
          g.beginPath(); g.arc(pr.x, pr.y, 3.2, 0, 2 * Math.PI); g.fill();
          g.font = "10px Consolas, monospace";
          g.fillText(mark.label, pr.x + 6, pr.y - 5);
        }
        g.restore();
      }
    }

    /* Optional physical conical umbra / penumbra guide for the active local
       body. It is a geometry overlay, not a lighting post-process: the exact
       interval classifier remains MissionAnalysis.shadowGeometry. */
    if (opts.shadowCones && shipSmp && shipSmp.cen !== "sun" && BODIES[shipSmp.cen]) {
      const shadowBody = BODIES[shipSmp.cen];
      const maxLength = Math.max(camera.dist * 2.5, shadowBody.soi || 0,
        shadowBody.radius * 20);
      const cone = shadowConeGeometry(bodyPos.sun, bodyPos[shadowBody.id],
        BODIES.sun.radius, shadowBody.radius, maxLength);
      if (cone) {
        const center = bodyPos[shadowBody.id];
        let perpendicular = V.sub(Rt, V.scale(cone.axis, V.dot(Rt, cone.axis)));
        if (V.mag(perpendicular) < 1e-8)
          perpendicular = V.sub(Up, V.scale(cone.axis, V.dot(Up, cone.axis)));
        perpendicular = V.norm(perpendicular);
        const end = V.add(center, V.scale(cone.axis, cone.displayLength));
        const corners = (endRadius) => [
          V.add(center, V.scale(perpendicular, shadowBody.radius)),
          V.add(end, V.scale(perpendicular, endRadius)),
          V.sub(end, V.scale(perpendicular, endRadius)),
          V.sub(center, V.scale(perpendicular, shadowBody.radius)),
        ].map(project);
        const drawCone = (projected, fill, stroke, dash) => {
          if (projected.some((point) => !point)) return;
          g.save(); g.fillStyle = fill; g.strokeStyle = stroke; g.lineWidth = 1;
          if (dash) g.setLineDash(dash);
          g.beginPath(); g.moveTo(projected[0].x, projected[0].y);
          for (let index = 1; index < projected.length; index++)
            g.lineTo(projected[index].x, projected[index].y);
          g.closePath(); g.fill(); g.stroke(); g.restore();
        };
        const blueprint = !!P().paperBodies;
        drawCone(corners(cone.penumbraEndRadius),
          blueprint ? "rgba(229,84,30,.055)" : "rgba(227,179,65,.055)",
          blueprint ? "rgba(229,84,30,.35)" : "rgba(227,179,65,.34)", [4, 5]);
        drawCone(corners(cone.umbraEndRadius),
          blueprint ? "rgba(28,29,32,.075)" : "rgba(139,92,246,.09)",
          blueprint ? "rgba(28,29,32,.4)" : "rgba(139,92,246,.48)", null);
      }
    }

    /* SOI circles (screen-facing) */
    if (opts.soi) {
      for (const id in BODIES) {
        const b = BODIES[id];
        if (!b.parent || !isFinite(b.soi) || !isShown(b)) continue;
        const prj = bodyPrj[id];
        if (!prj) continue;
        const rp = (f * b.soi) / prj.z;
        if (rp < 8 || rp > Math.max(w, h) * 2) continue;
        g.strokeStyle = P().soiStroke;
        g.setLineDash([4, 5]);
        g.lineWidth = 1;
        g.beginPath();
        g.arc(prj.x, prj.y, rp, 0, 2 * Math.PI);
        g.stroke();
        g.setLineDash([]);
        g.fillStyle = P().soiFill;
        g.font = "10px Segoe UI, sans-serif";
        g.fillText(b.name + " SOI", prj.x + rp * 0.72, prj.y - rp * 0.72);
      }
    }

    /* trajectory — drawn in two passes: fully before the bodies, then the
       parts that lie IN FRONT of large body disks again afterwards, so a
       nearer path is no longer swallowed by a farther textured planet. */
    const bigDisks = [];        // filled in the body loop: projected disk + physical sphere
    const occluders = [];       // rendered physical spheres for shared overlays
    const frontSkip = (p, ex, ey, ez) => {
      if (ez <= near) return true;
      const sx = cx + (f * ex) / ez, sy = cy - (f * ey) / ez;
      const worldPoint = frameBody === "inertial" ? p : V.add(p, frameOffset);
      return trajectoryFrontPassSkip(worldPoint, eyeWorld, sx, sy, bigDisks);
    };
    const fleetItems = Array.isArray(scene.multiCraft) ? scene.multiCraft.slice(0, 7) : [];
    const nativeFleetCount = fleetItems.reduce((count, craft) =>
      count + (craft && craft.nativeMissionVehicle ? 1 : 0), 0);
    const nativePointLimit = nativeFleetPointLimit(nativeFleetCount);
    const drawFleetPasses = fleetItems.length ? (skipFn) => {
      for (const craft of fleetItems) {
        if (!craft || !craft.result || !Array.isArray(craft.result.samples)) continue;
        const cached = fleetTrajectoryCache(craft.result, frameBody,
          Number.isFinite(craft.epochJD) ? craft.epochJD : craft.result.epochJD,
          !!craft.nativeMissionVehicle);
        if (cached.points.length < 2) continue;
        if (craft.nativeMissionVehicle && !fleetTimeCovered(cached.times, craft.localTime))
          continue;
        const color = /^#[0-9a-f]{6}$/i.test(craft.color || "") ? craft.color : "#52d4c5";
        const pathWindowS = Number.isFinite(craft.pathWindowS) && craft.pathWindowS > 0
          ? craft.pathWindowS : (craft.nativeMissionVehicle
            ? nativeFleetPathWindow(craft.result, craft.localTime) : null);
        const visible = fleetVisibleRange(cached.times, craft.localTime,
          pathWindowS);
        if (visible.end - visible.start < 2) continue;
        g.save();
        g.globalAlpha *= skipFn ? 0.92 : 0.58;
        g.strokeStyle = color; g.lineWidth = skipFn ? 1.35 : 1.15;
        if (craft.nativeMissionVehicle) g.setLineDash([4, 6]);
        const fleetStride = craft.nativeMissionVehicle
          ? Math.max(1, Math.ceil((visible.end - visible.start) / nativePointLimit)) : 1;
        polyline(cached.points, fleetStride, skipFn, visible.start, visible.end,
          frameBody === "inertial" ? null : frameOffset, cached.breaks);
        g.restore();
      }
    } : null;
    if (drawFleetPasses) drawFleetPasses(null);
    let drawTrajPasses = null;
    if (result && result.samples.length > 1) {
      const cache = trajectoryCache(result, frameBody, scene.epochJD);
      const rel = cache.denseRel;
      const relOffset = frameBody === "inertial" ? null : frameOffset;
      // All completed/upcoming Kepler spans use cached exact display samples.
      // Replace only the active span with the still-finer bridge containing
      // tNow, so the spacecraft cannot detach from either half of the path.
      const ss = result.samples;
      const bridge = trajectoryBridgeForDisplay(result, tNow, frameBody,
        previewTrajectoryGeometry, activeBurnPreview);
      const denseIndex = cache.sampleDenseIndex;
      const pastEnd = (denseIndex[bridge.lo] == null ? bridge.lo : denseIndex[bridge.lo]) + 1;
      const futureStart = denseIndex[bridge.hi] == null ? bridge.hi : denseIndex[bridge.hi];
      const activeWindowS = activeTrajectoryWindow(result, shipSmp);
      const activeRange = fleetVisibleRange(cache.denseT, tNow, activeWindowS);
      const pastStart = activeWindowS ? activeRange.start : 0;
      const futureEnd = activeWindowS ? activeRange.end : rel.length;
      const strideFor = (n) => Math.max(1, Math.ceil(n / 3800));
      drawTrajPasses = (skipFn, frontUnderlay) => {
        const denseSkip = (p, ex, ey, ez, index) =>
          !!cache.denseDocked[index] || !!(skipFn && skipFn(p, ex, ey, ez));
        const bridgeJoined = !!(ss[bridge.lo] && ss[bridge.lo].dockedTo) ||
          !!(ss[bridge.hi] && ss[bridge.hi].dockedTo);
        if (tNow < ss[ss.length - 1].t) {
          const count = futureEnd - futureStart;
          g.strokeStyle = frontUnderlay ? P().bg : P().trajFuture;
          g.lineWidth = frontUnderlay ? 3.4 : 1.1;
          g.setLineDash([5, 6]);
          const drawFutureLayer = (alpha, points, includeCached) => {
            if (!(alpha > 0)) return;
            g.save();
            g.globalAlpha *= alpha;
            if (!bridgeJoined && points && points.length > 1)
              polyline(points, 1, skipFn, 0, points.length, relOffset);
            if (includeCached && futureStart < futureEnd - 1)
              polyline(rel, strideFor(count), denseSkip, futureStart, futureEnd, relOffset,
                cache.denseBreakBefore);
            g.restore();
          };
          if (bridge.previewActive) {
            drawFutureLayer(bridge.previewAlpha, bridge.previewFuture, false);
            drawFutureLayer(bridge.solvedAlpha, bridge.future, true);
          } else drawFutureLayer(1, bridge.future, true);
          g.setLineDash([]);
        }
        if (tNow > ss[0].t || bridge.past.length > 1) {
          const st = strideFor(pastEnd - pastStart);
          if (!skipFn) {
            g.strokeStyle = P().trajGlow;
            g.lineWidth = 3.4;
            if (pastEnd - pastStart > 1) polyline(rel, st, denseSkip, pastStart, pastEnd, relOffset,
              cache.denseBreakBefore);
            if (!bridgeJoined && bridge.past.length > 1)
              polyline(bridge.past, 1, null, 0, bridge.past.length, relOffset);
          }
          g.strokeStyle = frontUnderlay ? P().bg : P().trajPast;
          g.lineWidth = frontUnderlay ? 3.8 : 1.4;
          if (pastEnd - pastStart > 1) polyline(rel, st, denseSkip, pastStart, pastEnd, relOffset,
            cache.denseBreakBefore);
          if (!bridgeJoined && bridge.past.length > 1)
            polyline(bridge.past, 1, skipFn, 0, bridge.past.length, relOffset);
        }
      };
      drawTrajPasses(null);
      /* event markers */
      if (opts.events !== false) {
        const colors = P().events;
        result.events.forEach((ev, i) => {
          if (activeWindowS && Math.abs(ev.t - tNow) > activeWindowS / 2) return;
          const col = colors[ev.kind];
          if (!col || !cache.evRel[i]) return;
          const p = project(frameBody === "inertial" ? cache.evRel[i]
            : V.add(cache.evRel[i], frameOffset));
          if (!p) return;
          if (scene.out) evPick.push({ x: p.x, y: p.y, t: ev.t, label: ev.label,
            vehicleId: ev.vehicleId || "primary" });
          const past = ev.t <= tNow;
          g.fillStyle = past ? col : hexA(col, 0.45);
          g.beginPath();
          g.moveTo(p.x, p.y - 4); g.lineTo(p.x + 4, p.y);
          g.lineTo(p.x, p.y + 4); g.lineTo(p.x - 4, p.y);
          g.closePath(); g.fill();
          if (opts.eventLabels) {
            g.fillStyle = hexA(col, past ? 0.9 : 0.5);
            g.font = "10px Segoe UI, sans-serif";
            g.fillText(shortLabel(ev), p.x + 6, p.y - 5);
          }
        });
      }
    }

    /* bodies (painter-sorted far -> near) */
    const drawList = [], bodyPick = {};
    for (const id in BODIES) {
      const prj = bodyPrj[id];
      if (!prj) continue;
      const b = BODIES[id];
      if (!isShown(b)) continue;
      // skip tiny moons visually merged with parent (unless focused)
      if (b.parent && b.parent !== "sun" && id !== camera.focusBody && frameBody !== id) {
        const pPrj = bodyPrj[b.parent];
        if (pPrj) {
          const sep = Math.hypot(prj.x - pPrj.x, prj.y - pPrj.y);
          if (sep < 5) continue;
        }
      }
      drawList.push({ id, prj, b });
    }
    drawList.sort((a, b) => b.prj.z - a.prj.z);
    g.font = "11px Segoe UI, sans-serif";

    let _ringGeom = null;    // per-frame geometry shared by the two half passes
    const drawRings = (id, b, prj, appR, half) => {
      // half: -1 = far side only, +1 = near side only
      const centerE = eye(bodyPos[id]);
      const skipFn = (p, ex, ey, ez) => {
        // occlusion by the planet disk + wrong half selection
        const behind = ez > centerE[2];
        if ((half < 0 && !behind) || (half > 0 && behind)) return true;
        if (behind && ez > near) {
          const sx = cx + (f * ex) / ez, sy = cy - (f * ey) / ez;
          if (Math.hypot(sx - prj.x, sy - prj.y) < appR * 0.99) return true;
        }
        return false;
      };
      if (!_ringGeom || _ringGeom.id !== id) {
        const tilt = (b.tiltDeg || 0) * Math.PI / 180;
        const axActual = [Math.sin(tilt), 0, Math.cos(tilt)];
        const e1Actual = V.norm([axActual[2], 0, -axActual[0]]);
        const e2Actual = V.cross(axActual, e1Actual);
        const e1 = vectorRelativeToDisplayFrame(e1Actual, displayFrame);
        const e2 = vectorRelativeToDisplayFrame(e2Actual, displayFrame);
        const lines = [];
        for (const band of SATURN_BANDS) {
          const wPx = ((band.r1 - band.r0) * b.radius * f) / prj.z;
          if (wPx < 0.5) continue;
          const nLines = Math.max(2, Math.min(22, Math.round(wPx / 1.3)));
          for (let li = 0; li < nLines; li++) {
            const rr = (band.r0 + ((li + 0.5) / nLines) * (band.r1 - band.r0)) * b.radius;
            const pts = [];
            for (let k = 0; k <= 72; k++) {
              const a = (k / 72) * 2 * Math.PI;
              pts.push(V.add(bodyPos[id],
                V.add(V.scale(e1, rr * Math.cos(a)), V.scale(e2, rr * Math.sin(a)))));
            }
            lines.push({ pts, col: band.col, a: band.a, lw: Math.max(1, wPx / nLines + 0.25) });
          }
        }
        _ringGeom = { id, lines };
      }
      for (const ln of _ringGeom.lines) {
        g.strokeStyle = hexA(ln.col, ln.a);
        g.lineWidth = ln.lw;
        polyline(ln.pts, 1, skipFn);
      }
      g.lineWidth = 1;
    };

    for (const { id, prj, b } of drawList) {
      // true sphere silhouette: f·R/√(z²−R²). The naive f·R/z draws bodies
      // up to ~35% too small at close range, leaving surface events (and
      // the horizon) hanging visibly off the disk.
      const zz = Math.max(prj.z * prj.z - b.radius * b.radius, (b.radius * 0.06) ** 2);
      const appR = (f * b.radius) / Math.sqrt(zz);
      // Never draw a body the camera is inside of or grazing past: the
      // projected disk explodes across the whole screen (the "texture
      // flash" seen when zooming into / dragging near a focused planet).
      if (prj.z < b.radius * 0.85 || !isFinite(appR)) continue;
      const r = Math.max(appR, id === "sun" ? 4 : (C.isMinor(b) ? 1.7 : 2.2));
      bodyPick[id] = { x: prj.x, y: prj.y, z: prj.z, r };
      const sphere = {
        id,
        center: V.clone(bodyPos[id]),
        radius: b.radius,
        projected: { x: prj.x, y: prj.y, r: appR, depth: prj.z },
      };
      occluders.push(sphere);
      if (r >= 10) bigDisks.push({ x: prj.x, y: prj.y, r, z: prj.z, sphere });
      const textured = opts.textures !== false && TEX && TEX.has(id) && appR >= 2;

      if (b.rings && appR > 3) drawRings(id, b, prj, appR, -1); // far half first

      if (id === "sun") {
        const gr = g.createRadialGradient(prj.x, prj.y, 0, prj.x, prj.y, r * 6);
        gr.addColorStop(0, "rgba(255,215,110,0.95)");
        gr.addColorStop(0.25, "rgba(255,180,46,0.35)");
        gr.addColorStop(1, "rgba(255,180,46,0)");
        g.fillStyle = gr;
        g.beginPath(); g.arc(prj.x, prj.y, r * 6, 0, 2 * Math.PI); g.fill();
        if (textured) {
          const sp = TEX.spriteFor(b, r, [0, 0, 1], jd, textureCameraBasis, true,
            !!scene.textureMotion);
          if (sp) g.drawImage(sp, prj.x - r - 1, prj.y - r - 1, 2 * r + 2, 2 * r + 2);
          else { g.fillStyle = "#ffd76e"; g.beginPath(); g.arc(prj.x, prj.y, r, 0, 2 * Math.PI); g.fill(); }
        } else if (P().paperBodies) {
          g.fillStyle = "#f6ecc9";
          g.beginPath(); g.arc(prj.x, prj.y, r, 0, 2 * Math.PI); g.fill();
          g.strokeStyle = P().paperBodyStroke; g.lineWidth = 1.5;
          g.beginPath(); g.arc(prj.x, prj.y, r, 0, 2 * Math.PI); g.stroke();
          g.lineWidth = 1;
          for (let ti = 0; ti < 12; ti++) {
            const ta = (ti / 12) * 6.283;
            g.beginPath();
            g.moveTo(prj.x + Math.cos(ta) * (r + 2.5), prj.y + Math.sin(ta) * (r + 2.5));
            g.lineTo(prj.x + Math.cos(ta) * (r + 2.5 + Math.max(3, r * 0.28)), prj.y + Math.sin(ta) * (r + 2.5 + Math.max(3, r * 0.28)));
            g.stroke();
          }
        } else {
          g.fillStyle = "#ffd76e";
          g.beginPath(); g.arc(prj.x, prj.y, r, 0, 2 * Math.PI); g.fill();
        }
      } else if (textured) {
        const Lw = displayFrame.kind === "synodic"
          ? V.norm(V.sub(bodyActual.sun, bodyActual[id]))
          : V.norm(V.sub(bodyPos.sun, bodyPos[id]));
        const sp = TEX.spriteFor(b, r, Lw, jd, textureCameraBasis, flat,
          !!scene.textureMotion);
        if (sp) g.drawImage(sp, prj.x - r - 1, prj.y - r - 1, 2 * r + 2, 2 * r + 2);
      } else if (P().paperBodies) {
        // blueprint technical-drawing style: simplified planetary features in ink
        g.save();
        g.beginPath(); g.arc(prj.x, prj.y, r, 0, 2 * Math.PI);
        g.fillStyle = P().paperBodyFill; g.fill();
        g.clip();
        g.translate(prj.x, prj.y);
        const featCol = P().paperBodyFeature || P().paperBodyHatch;
        const flw = Math.max(1, Math.min(2.2, r * 0.022));
        let hsum = 0;
        for (let ci = 0; ci < id.length; ci++) hsum += id.charCodeAt(ci) * (ci + 7);
        const frac = (n) => { const x = Math.sin(hsum * 12.9898 + n * 78.233) * 43758.5453; return x - Math.floor(x); };
        /* latitude bands, curved to the sphere */
        const latLines = (step, tilt) => {
          g.save(); if (tilt) g.rotate(tilt);
          g.strokeStyle = featCol;
          for (let yy = -r + step; yy < r - step * 0.4; yy += step) {
            const xw = Math.sqrt(Math.max(0, r * r - yy * yy)) * 0.98;
            g.lineWidth = Math.abs(yy) < step * 0.6 ? flw * 1.6 : flw;
            g.beginPath();
            g.moveTo(-xw, yy);
            g.quadraticCurveTo(0, yy + yy * 0.3, xw, yy);
            g.stroke();
          }
          g.restore();
        };
        /* cratered surface: deterministic circles */
        const craters = (n, scale) => {
          g.strokeStyle = featCol; g.lineWidth = flw;
          for (let i = 0; i < n; i++) {
            const a = frac(i) * 6.283, rr = Math.sqrt(frac(i + 40)) * r * 0.72;
            const cr = r * scale * (0.5 + frac(i + 80));
            const ccx = Math.cos(a) * rr, ccy = Math.sin(a) * rr;
            g.beginPath();
            g.arc(ccx, ccy, cr, 0, 2 * Math.PI);
            g.stroke();
            /* inner shadow rim */
            g.beginPath();
            g.arc(ccx + cr * 0.18, ccy + cr * 0.18, cr * 0.62, 0.6, 2.9);
            g.stroke();
          }
        };
        /* storm oval (Jupiter GRS, Neptune dark spot) */
        const spot = (fx, fy, fr) => {
          g.strokeStyle = featCol; g.lineWidth = flw;
          g.beginPath();
          g.ellipse(fx * r, fy * r, fr * r, fr * r * 0.55, 0, 0, 2 * Math.PI);
          g.stroke();
          g.beginPath();
          g.ellipse(fx * r, fy * r, fr * r * 0.55, fr * r * 0.28, 0, 0, 2 * Math.PI);
          g.stroke();
        };
        const stipple = (step) => {
          g.fillStyle = featCol;
          for (let yy = -r; yy <= r; yy += step)
            for (let xx = -r + (Math.round(yy / step) % 2 ? step / 2 : 0); xx <= r; xx += step)
              if (xx * xx + yy * yy < r * r * 0.92) g.fillRect(xx, yy, 1.3, 1.3);
        };
        /* globe graticule meridians (Earth) */
        const meridians = () => {
          g.strokeStyle = featCol; g.lineWidth = 1.1;
          for (const k of [0.35, 0.7]) {
            g.beginPath(); g.ellipse(0, 0, r * k, r * 0.985, 0, 0, 2 * Math.PI); g.stroke();
          }
        };
        /* polar cap: chord line + stippled cap region (Mars) */
        const cap = () => {
          const yy = -r * 0.62, xw = Math.sqrt(Math.max(0, r * r - yy * yy));
          g.strokeStyle = featCol; g.lineWidth = 1.2;
          g.beginPath(); g.moveTo(-xw, yy); g.quadraticCurveTo(0, yy + yy * 0.35, xw, yy); g.stroke();
          g.fillStyle = featCol;
          for (let sy = -r; sy < yy; sy += 2.5)
            for (let sx = -r; sx <= r; sx += 2.5)
              if (sx * sx + sy * sy < r * r * 0.94) g.fillRect(sx, sy, 1.1, 1.1);
        };
        if (r >= 5) {
          if (id === "mercury") craters(9, 0.12);
          else if (id === "venus") latLines(Math.max(3.2, r / 5), -0.45);
          else if (id === "earth") { meridians(); latLines(Math.max(4, r / 3.2)); }
          else if (id === "moon") craters(6, 0.16);
          else if (id === "mars") { craters(4, 0.1); cap(); }
          else if (id === "jupiter") { latLines(Math.max(3.2, r / 6)); spot(0.3, 0.32, 0.26); }
          else if (id === "saturn") latLines(Math.max(3.6, r / 4.5));
          else if (id === "uranus") latLines(Math.max(3.6, r / 4.5), 1.5708);
          else if (id === "neptune") { latLines(Math.max(3.4, r / 5)); spot(-0.28, -0.3, 0.22); }
          else {
            const pick = hsum % 3;
            if (pick === 0) craters(4 + (hsum % 4), 0.14);
            else if (pick === 1) stipple(4.5);
            else latLines(Math.max(3.6, r / 4), (frac(3) - 0.5) * 1.2);
          }
        }
        /* terminator: hatch the anti-sun lune */
        if (!flat && r >= 6 && id !== "sun") {
          const sp2 = bodyPrj.sun;
          let tlx = -0.5, tly = -0.5;
          if (sp2) {
            const tdx = sp2.x - prj.x, tdy = sp2.y - prj.y;
            const tdl = Math.hypot(tdx, tdy) || 1;
            tlx = tdx / tdl; tly = tdy / tdl;
          }
          g.save();
          g.beginPath();
          g.arc(0, 0, r, 0, 2 * Math.PI);
          g.arc(tlx * r * 0.75, tly * r * 0.75, r * 1.3, 0, 2 * Math.PI);
          g.clip("evenodd");
          g.strokeStyle = featCol; g.lineWidth = 0.9; g.globalAlpha = 0.75;
          g.beginPath();
          for (let hd = -2 * r; hd <= 2 * r; hd += 3) {
            g.moveTo(hd - r * 1.6, -r * 1.6);
            g.lineTo(hd + r * 1.6, r * 1.6);
          }
          g.stroke();
          g.globalAlpha = 1;
          g.restore();
        }
        g.restore();
        g.strokeStyle = P().paperBodyStroke;
        g.lineWidth = Math.max(1.2, Math.min(2, r * 0.02));
        g.beginPath(); g.arc(prj.x, prj.y, r, 0, 2 * Math.PI); g.stroke();
        g.lineWidth = 1;
      } else {
        // gradient fallback (sun-lit)
        const sunPrj = bodyPrj.sun;
        let lx = -0.4, ly = -0.4;
        if (sunPrj) {
          const dx = sunPrj.x - prj.x, dy = sunPrj.y - prj.y;
          const dl = Math.hypot(dx, dy) || 1;
          lx = dx / dl; ly = dy / dl;
        }
        const gr = g.createRadialGradient(
          prj.x + lx * r * 0.45, prj.y + ly * r * 0.45, r * 0.1, prj.x, prj.y, r * 1.05);
        gr.addColorStop(0, lighten(b.color, flat ? 0.25 : 0.35));
        gr.addColorStop(0.75, b.color);
        gr.addColorStop(1, flat ? b.color : darken(b.color, 0.55));
        g.fillStyle = gr;
        g.beginPath(); g.arc(prj.x, prj.y, r, 0, 2 * Math.PI); g.fill();
      }

      if (b.rings && appR > 3) drawRings(id, b, prj, appR, +1); // near half over

      if (opts.labels !== false) {
        const minor = C.isMinor(b);
        const showLabel = !minor || appR > 2.5 ||
          id === camera.focusBody || id === frameBody;
        if (showLabel) {
          const isPlanet = !b.parent || b.parent === "sun";
          g.fillStyle = minor ? P().labelMinor : isPlanet ? P().labelPlanet : P().labelMoon;
          g.fillText(b.name, prj.x + r + 4, prj.y + 3);
        }
      }
    }

    /* trajectory front pass: the parts nearer than the big disks */
    if (drawTrajPasses && bigDisks.length) {
      // A narrow theme-colored separation beneath camera-facing trajectory
      // segments makes a low orbit read as passing above the textured globe,
      // while the physical sphere test still removes every far-side segment.
      g.save(); g.globalAlpha *= 0.72; drawTrajPasses(frontSkip, true); g.restore();
      drawTrajPasses(frontSkip, false);
    }
    if (drawFleetPasses && bigDisks.length) drawFleetPasses(frontSkip);

    /* Virtual CR3BP equilibrium points. They are deliberately not catalog
       bodies: no transfer/POV selector can accidentally treat one as a
       massive object. Drawing after the physical spheres keeps them visually
       above a nearby body, while the ray test still hides a genuine far-side
       marker. The spacecraft remains the final, highest-ranked marker. */
    const librationPick = [];
    if (opts.lagrange && globalThis.CR3BP) {
      const markers = librationPointRecords(scene.cr3bpSystem || "earth-moon",
        jd, frameBody, bodyWorld, displayFrame);
      const markerColor = P().apsisApo || PAL_DEFAULT.apsisApo;
      for (const marker of markers) {
        const p = project(marker.world);
        const occluded = typeof A.pointOccludedBySpheres === "function" &&
          A.pointOccludedBySpheres(marker.world, eyeWorld, occluders);
        if (!p || occluded) continue;
        const r = 4.5;
        g.save();
        g.strokeStyle = markerColor;
        g.fillStyle = P().bg;
        g.lineWidth = 1.35;
        g.beginPath();
        g.moveTo(p.x, p.y - r); g.lineTo(p.x + r, p.y);
        g.lineTo(p.x, p.y + r); g.lineTo(p.x - r, p.y);
        g.closePath(); g.fill(); g.stroke();
        g.beginPath();
        g.moveTo(p.x - 2, p.y); g.lineTo(p.x + 2, p.y);
        g.moveTo(p.x, p.y - 2); g.lineTo(p.x, p.y + 2); g.stroke();
        if (opts.labels !== false) {
          g.fillStyle = markerColor;
          g.font = "10px Consolas, monospace";
          g.fillText(marker.name, p.x + 7, p.y - 6);
        }
        g.restore();
        librationPick.push(Object.assign({}, marker, { x: p.x, y: p.y, r: 11 }));
      }
    }

    /* Native inactive and external comparison spacecraft. Their paths and
       markers share the main camera, epoch, display frame, and physical body
       occlusion. The selected marker is deliberately drawn last so it remains
       unambiguous at rendezvous. */
    for (const craft of fleetItems) {
      if (!craft || !craft.result || !Array.isArray(craft.result.samples) ||
          !craft.result.samples.length || !Number.isFinite(craft.localTime)) continue;
      const firstTime = craft.result.samples[0].t;
      const lastTime = craft.result.samples[craft.result.samples.length - 1].t;
      if (craft.localTime < firstTime || craft.localTime > lastTime) continue;
      const sample = globalThis.MissionEngine.sampleAtTime(craft.result, craft.localTime);
      if (!sample || !sample.w || sample.dockedTo ||
          (renderShipSmp && renderShipSmp.dockedTo === craft.id)) continue;
      const craftEpoch = Number.isFinite(craft.epochJD) ? craft.epochJD : craft.result.epochJD;
      const sampleJD = craftEpoch + sample.t / DAY;
      const displayPoint = pointInDisplayFrame(sample.w, frameBody, sampleJD, jd,
        bodyWorld, sampleJD === jd ? displayFrame : null, displayFrame);
      const projected = project(displayPoint);
      const occluded = typeof A.pointOccludedBySpheres === "function" &&
        A.pointOccludedBySpheres(displayPoint, eyeWorld, occluders);
      if (!projected || occluded) continue;
      const color = /^#[0-9a-f]{6}$/i.test(craft.color || "") ? craft.color : "#52d4c5";
      g.save(); g.strokeStyle = color; g.fillStyle = P().bg; g.lineWidth = 1.5;
      g.beginPath(); g.arc(projected.x, projected.y, 4.2, 0, 2 * Math.PI); g.fill(); g.stroke();
      g.beginPath(); g.moveTo(projected.x - 6, projected.y); g.lineTo(projected.x + 6, projected.y);
      g.moveTo(projected.x, projected.y - 6); g.lineTo(projected.x, projected.y + 6); g.stroke();
      if (opts.labels !== false) {
        g.fillStyle = color; g.font = "10px Segoe UI, sans-serif";
        g.fillText(String(craft.name || craft.id || "CRAFT").slice(0, 28),
          projected.x + 9, projected.y - 7);
      }
      fleetPick.push({ id: craft.id, name: craft.name, x: projected.x, y: projected.y,
        r: 10, nativeMissionVehicle: !!craft.nativeMissionVehicle });
      g.restore();
    }

    /* spacecraft */
    if (renderShipSmp) {
      const shipJD = scene.epochJD + renderShipSmp.t / DAY;
      const sw = pointInDisplayFrame(renderShipSmp.w, frameBody, shipJD, jd,
        bodyWorld, shipJD === jd ? displayFrame : null, displayFrame);
      const p = project(sw);
      const occluded = typeof A.pointOccludedBySpheres === "function" &&
        A.pointOccludedBySpheres(sw, eyeWorld, occluders);
      if (p) {
        g.save();
        // The selected Planner vehicle is a navigation indicator as well as
        // scene geometry. Keep its arrow visible through a planet while all
        // trajectories and inactive craft retain physical occultation.
        if (occluded) g.globalAlpha *= 0.78;
        // orientation from velocity direction
        const vdir = V.norm(renderShipSmp.v);
        const directionScale = (14 * p.z) / f;
        const tipWorld = V.add(renderShipSmp.w, V.scale(vdir, directionScale));
        const tip = project(pointInDisplayFrame(tipWorld, frameBody, shipJD, jd,
          bodyWorld, shipJD === jd ? displayFrame : null, displayFrame));
        let ang = 0;
        if (tip) ang = Math.atan2(tip.y - p.y, tip.x - p.x);
        const thrustCue = thrustCueState(result, tNow, renderShipSmp);
        if (thrustCue.active && thrustCue.direction) {
          const cueScale = (38 * p.z) / f;
          const cueWorld = V.add(renderShipSmp.w,
            V.scale(thrustCue.direction, cueScale));
          const cueTip = project(pointInDisplayFrame(cueWorld, frameBody, shipJD, jd,
            bodyWorld, shipJD === jd ? displayFrame : null, displayFrame));
          if (cueTip) {
            const cueAngle = Math.atan2(cueTip.y - p.y, cueTip.x - p.x);
            const pulse = thrustCue.engineOn ? 0.82 + 0.18 * Math.sin(tNow * 0.18) : 0.72;
            g.save();
            g.translate(p.x, p.y);
            g.rotate(cueAngle);
            g.globalAlpha *= pulse;
            g.strokeStyle = P().events.burn || "#f85149";
            g.fillStyle = P().events.burn || "#f85149";
            g.lineWidth = P().paperBodies ? 1.2 : 1.8;
            if (P().paperBodies) g.setLineDash([5, 3]);
            g.beginPath(); g.moveTo(10, 0); g.lineTo(39, 0); g.stroke();
            g.setLineDash([]);
            g.beginPath();
            g.moveTo(39, 0); g.lineTo(32, -3.5); g.lineTo(32, 3.5);
            g.closePath(); g.fill();
            // Plume points opposite acceleration. Blueprint keeps a precise
            // outline; Cinematic adds the ember glow appropriate to its UI.
            if (!P().paperBodies) {
              const plume = g.createLinearGradient(-25, 0, -5, 0);
              plume.addColorStop(0, "rgba(255,106,61,0)");
              plume.addColorStop(1, "rgba(255,190,120,0.92)");
              g.fillStyle = plume;
            } else g.fillStyle = "rgba(198,40,40,0.18)";
            g.beginPath();
            g.moveTo(-5, 0); g.lineTo(-22, -4.5); g.lineTo(-15, 0);
            g.lineTo(-22, 4.5); g.closePath(); g.fill();
            if (P().paperBodies) {
              g.strokeStyle = P().events.burn || "#c62828";
              g.stroke();
            }
            g.restore();
            if (opts.labels !== false) {
              g.fillStyle = P().events.burn || "#f85149";
              g.font = "9px Consolas, monospace";
              g.fillText(thrustCue.engineOn ? "THRUST" : "BURN VECTOR",
                p.x + Math.cos(cueAngle) * 43 + 4,
                p.y + Math.sin(cueAngle) * 43 - 4);
            }
          }
        }
        const gr = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, 12);
        gr.addColorStop(0, `rgba(${P().shipGlowRGB},0.5)`);
        gr.addColorStop(1, `rgba(${P().shipGlowRGB},0)`);
        g.fillStyle = gr;
        g.beginPath(); g.arc(p.x, p.y, 12, 0, 2 * Math.PI); g.fill();
        g.save();
        g.translate(p.x, p.y);
        g.rotate(ang);
        g.fillStyle = renderShipSmp.landed ? P().shipLanded : P().ship;
        g.beginPath();
        g.moveTo(6.5, 0); g.lineTo(-4.5, 3.6); g.lineTo(-2.5, 0); g.lineTo(-4.5, -3.6);
        g.closePath(); g.fill();
        g.restore();
        if (occluded) {
          g.strokeStyle = P().shipLabel;
          g.lineWidth = 1;
          g.setLineDash([2, 3]);
          g.beginPath(); g.arc(p.x, p.y, 8.5, 0, 2 * Math.PI); g.stroke();
          g.setLineDash([]);
        }
        if (opts.labels !== false) {
          g.fillStyle = P().shipLabel;
          g.font = "11px Segoe UI, sans-serif";
          const shipLabel = String(scene.shipName || "SC").slice(0, 28)
            + (renderShipSmp.landed ? " (landed)" : "");
          g.fillText(shipLabel, p.x + 10, p.y - 8);
        }
        g.restore();
      }
    }

    /* scale bar */
    if (opts.scaleBar !== false)
      drawScaleBar(g, w, h, f, camera.dist, opts.scaleBarAnchor);

    /* expose projections for click-picking in the UI */
    if (scene.out) {
      scene.out.bodies = bodyPick;
      scene.out.bodyPositions = bodyPos;
      scene.out.events = evPick;
      scene.out.vehicles = fleetPick;
      scene.out.librationPoints = librationPick;
      scene.out.basis = { Rt, Up, F, f, center, eye: eyeWorld };
      scene.out.occluders = occluders;
    }
  }

  function scaleBarLayout(w, h, px, labelWidth, anchor) {
    const defaultX = P().scalebarLeft ? 22 : w - px - (P().scalebarRight || 22);
    const defaultY = h - (P().scalebarBottom || 20);
    const requestedX = anchor && isFinite(anchor.x) ? +anchor.x : defaultX;
    const requestedY = anchor && isFinite(anchor.y) ? +anchor.y : defaultY;
    const x0 = Math.max(6, Math.min(w - px - 6, requestedX));
    const y0 = Math.max(18, Math.min(h - 6, requestedY));
    const centeredLabelX = x0 + px / 2 - labelWidth / 2;
    const labelX = Math.max(4, Math.min(w - labelWidth - 4, centeredLabelX));
    return { x0, y0, labelX };
  }

  function drawScaleBar(g, w, h, f, dist, anchor) {
    const kmPerPx = dist / f;
    const targetPx = 110;
    const raw = kmPerPx * targetPx;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    let nice = pow;
    for (const m of [1, 2, 5, 10]) if (m * pow <= raw) nice = m * pow;
    const px = nice / kmPerPx;
    const label = nice >= 0.05 * AU ? (nice / AU).toPrecision(2) + " AU"
      : nice >= 1e6 ? (nice / 1e6).toPrecision(2) + "M km"
      : Math.round(nice).toLocaleString("en-US") + " km";
    g.font = "10px Consolas, monospace";
    const layout = scaleBarLayout(w, h, px, g.measureText(label).width, anchor);
    const x0 = layout.x0, y0 = layout.y0;
    g.strokeStyle = P().scalebar;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x0, y0); g.lineTo(x0 + px, y0);
    g.moveTo(x0, y0 - 4); g.lineTo(x0, y0 + 4);
    g.moveTo(x0 + px, y0 - 4); g.lineTo(x0 + px, y0 + 4);
    g.stroke();
    g.fillStyle = P().scalebarText;
    g.fillText(label, layout.labelX, y0 - 7);
  }

  function shortLabel(ev) {
    const s = ev.label;
    const cut = s.indexOf(" — ");
    return cut > 0 ? s.slice(0, cut) : s.slice(0, 26);
  }

  /* color helpers */
  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function hexA(hex, a) {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r},${g},${b},${a})`;
  }
  function lighten(hex, k) {
    const [r, g, b] = hexToRgb(hex);
    return `rgb(${Math.min(255, r + 255 * k) | 0},${Math.min(255, g + 255 * k) | 0},${Math.min(255, b + 255 * k) | 0})`;
  }
  function darken(hex, k) {
    const [r, g, b] = hexToRgb(hex);
    return `rgb(${(r * (1 - k)) | 0},${(g * (1 - k)) | 0},${(b * (1 - k)) | 0})`;
  }

  globalThis.MTPRender = {
    createCamera, draw, invalidateCache, burnPreviewState, burnPreviewDisplayState,
    burnPreviewNotice,
    thrustCueState,
    librationPointWorld,
    // Small pure-geometry surface for headless regression tests. Keeping
    // these helpers here lets tests verify render coordinates without a DOM
    // or a canvas implementation.
    _test: {
      trajectoryCache,
      fleetTrajectoryCache,
      currentTrajectoryBridge,
      trajectoryBridgeForDisplay,
      osculatingGeometry,
      burnPreviewState,
      burnPreviewDisplayState,
      thrustCueState,
      burnPreviewTimings,
      stateInBurnFrame,
      shouldDrawFiniteApsis,
      isStaticApsisFrame,
      scaleBarLayout,
      burnPreviewNotice,
      localToFrame,
      nextPolylineIndex,
      hasPolylineBreak,
      nativeFleetPointLimit,
      fleetVisibleRange,
      fleetTimeCovered,
      nativeFleetPathWindow,
      activeTrajectoryWindow,
      trajectoryFrontPassSkip,
      shadowConeGeometry,
      bodyWorldForScene,
      bodyOrbitPathForScene,
      synodicSystemForFrame,
      isSynodicFrame,
      synodicFrameBasis,
      synodicCoordinates,
      synodicWorld,
      vectorRelativeToDisplayFrame,
      vectorFromDisplayFrame,
      displayFrameContext,
      pointRelativeToDisplayFrame,
      pointInDisplayFrame,
      librationPointRecords,
    },
  };
})();
