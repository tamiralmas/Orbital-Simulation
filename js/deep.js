/* =============================================================================
 * Mission Trajectory Planner - Deep 100 tracker controller.
 *
 * The page consumes release-generated NASA/JPL Horizons vectors. Positions
 * are interpolated only between adjacent bundled position/velocity samples
 * with cubic Hermite interpolation. There is intentionally no extrapolation,
 * runtime Horizons request, telemetry claim, or inferred operational status.
 * ========================================================================== */
"use strict";

(function () {
  function finiteVector3(v) {
    return Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  }

  function sampleState(sample) {
    if (!Array.isArray(sample) || sample.length < 7 || !sample.slice(0, 7).every(Number.isFinite)) return null;
    return { r: sample.slice(1, 4), v: sample.slice(4, 7) };
  }

  /** Bounded position/velocity interpolation; returns null outside coverage. */
  function stateAtTrajectory(trajectory, atMs) {
    if (!trajectory || !Number.isFinite(atMs) || !Array.isArray(trajectory.samples) || !trajectory.samples.length) return null;
    const samples = trajectory.samples;
    const first = samples[0];
    const last = samples[samples.length - 1];
    if (!Array.isArray(first) || !Array.isArray(last) || atMs < first[0] || atMs > last[0]) return null;

    if (atMs === first[0]) {
      const state = sampleState(first);
      return state && Object.assign(state, { atMs, trajectory });
    }
    if (atMs === last[0]) {
      const state = sampleState(last);
      return state && Object.assign(state, { atMs, trajectory });
    }

    let lo = 0;
    let hi = samples.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (samples[mid][0] <= atMs) lo = mid;
      else hi = mid;
    }

    const a = samples[lo];
    const b = samples[hi];
    if (!a || !b || a.length < 7 || b.length < 7 ||
        !a.slice(0, 7).every(Number.isFinite) || !b.slice(0, 7).every(Number.isFinite)) return null;
    const dtMs = b[0] - a[0];
    if (!(dtMs > 0)) return null;
    const dt = dtMs / 1000;
    const u = (atMs - a[0]) / dtMs;
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    const dh00 = 6 * u2 - 6 * u;
    const dh10 = 3 * u2 - 4 * u + 1;
    const dh01 = -6 * u2 + 6 * u;
    const dh11 = 3 * u2 - 2 * u;
    const r = [0, 0, 0];
    const v = [0, 0, 0];
    for (let axis = 0; axis < 3; axis++) {
      r[axis] = h00 * a[1 + axis] + h10 * dt * a[4 + axis] +
        h01 * b[1 + axis] + h11 * dt * b[4 + axis];
      v[axis] = (dh00 * a[1 + axis] + dh01 * b[1 + axis]) / dt +
        dh10 * a[4 + axis] + dh11 * b[4 + axis];
    }
    if (!finiteVector3(r) || !finiteVector3(v)) return null;
    return { r, v, atMs, trajectory };
  }

  /** Return the union of all valid static-vector coverage. Playback may move
   * within this interval, but must never imply positions beyond it. */
  function trajectoryCoverageBounds(trajectories) {
    let startMs = Infinity;
    let stopMs = -Infinity;
    for (const trajectory of trajectories || []) {
      if (!trajectory || !Array.isArray(trajectory.samples) || !trajectory.samples.length) continue;
      const firstMs = trajectory.samples[0][0];
      const lastMs = trajectory.samples[trajectory.samples.length - 1][0];
      if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs) || lastMs < firstMs) continue;
      startMs = Math.min(startMs, firstMs);
      stopMs = Math.max(stopMs, lastMs);
    }
    return Number.isFinite(startMs) && Number.isFinite(stopMs) ? { startMs, stopMs } : null;
  }

  function boundedPlaybackTime(atMs, bounds) {
    if (!Number.isFinite(atMs) || !bounds || !Number.isFinite(bounds.startMs) ||
        !Number.isFinite(bounds.stopMs) || bounds.stopMs < bounds.startMs) {
      return { atMs, boundary: "" };
    }
    if (atMs < bounds.startMs) return { atMs: bounds.startMs, boundary: "start" };
    if (atMs > bounds.stopMs) return { atMs: bounds.stopMs, boundary: "end" };
    return { atMs, boundary: "" };
  }

  /** Densify a bounded portion of a Horizons vector table with the same cubic
   * Hermite state function used for the current marker. Official rows inside
   * the window, clipped window endpoints, and includeMs are retained exactly;
   * no sample is created outside source coverage. */
  function boundedHermiteWindow(trajectory, startMs, stopMs, desiredStepMs, maxPoints, includeMs) {
    if (!trajectory || !Array.isArray(trajectory.samples) || trajectory.samples.length < 2) return [];
    const source = trajectory.samples;
    const coverageStart = source[0][0];
    const coverageStop = source[source.length - 1][0];
    if (!Number.isFinite(startMs) || !Number.isFinite(stopMs) || stopMs < coverageStart || startMs > coverageStop) return [];
    const firstMs = Math.max(coverageStart, startMs);
    const lastMs = Math.min(coverageStop, stopMs);
    if (lastMs < firstMs) return [];
    const limit = Math.max(4, Math.floor(Number.isFinite(maxPoints) ? maxPoints : 2400));
    let rawInside = 0;
    for (const sample of source) if (sample[0] >= firstMs && sample[0] <= lastMs) rawInside++;
    const interiorCapacity = Math.max(1, limit - rawInside - 3);
    const spanMs = lastMs - firstMs;
    const stepMs = Math.max(1, Number.isFinite(desiredStepMs) && desiredStepMs > 0 ? desiredStepMs : spanMs,
      spanMs / interiorCapacity);
    const times = [];
    const addTime = (value) => {
      if (!Number.isFinite(value) || value < firstMs || value > lastMs) return;
      times.push(value);
    };
    addTime(firstMs);
    addTime(lastMs);
    if (Number.isFinite(includeMs)) addTime(Math.max(firstMs, Math.min(lastMs, includeMs)));
    for (let i = 0; i + 1 < source.length; i++) {
      const aMs = source[i][0];
      const bMs = source[i + 1][0];
      if (bMs < firstMs || aMs > lastMs) continue;
      const a = Math.max(firstMs, aMs);
      const b = Math.min(lastMs, bMs);
      addTime(a);
      const subdivisions = Math.max(1, Math.ceil((b - a) / stepMs));
      for (let j = 1; j < subdivisions; j++) addTime(a + (b - a) * j / subdivisions);
      addTime(b);
    }
    times.sort((a, b) => a - b);
    const states = [];
    let previous = -Infinity;
    for (const atMs of times) {
      if (Math.abs(atMs - previous) < 1e-3) continue;
      const state = stateAtTrajectory(trajectory, atMs);
      if (state) states.push(state);
      previous = atMs;
    }
    return states;
  }

  /** Choose a stable, several-orbit local display window. The supplied state
   * is already relative to the requested body. A null result means the craft
   * is outside that body's SOI and a local surface/orbit track is not useful. */
  function localOrbitWindowSpec(trajectory, atMs, body, relativeState) {
    if (!trajectory || !Array.isArray(trajectory.samples) || trajectory.samples.length < 2 ||
        !body || !relativeState || !finiteVector3(relativeState.r) ||
        !finiteVector3(relativeState.v) || !Number.isFinite(atMs)) return null;
    const distanceKm = Math.hypot(...relativeState.r);
    const speedKmS = Math.hypot(...relativeState.v);
    const localLimit = Number.isFinite(body.soi) ? body.soi * 1.05 : body.radius * 250;
    if (!(distanceKm > 0) || !(localLimit > 0) || distanceKm > localLimit) return null;
    const surface = distanceKm <= body.radius * 1.08;
    const energy = speedKmS * speedKmS / 2 - body.mu / distanceKm;
    const semiMajorKm = energy < 0 ? -body.mu / (2 * energy) : NaN;
    const periodMs = !surface && semiMajorKm > body.radius
      ? 2 * Math.PI * Math.sqrt(semiMajorKm * semiMajorKm * semiMajorKm / body.mu) * 1000 : NaN;
    const rotationMs = Math.abs(body.rotHours || 24) * 3600000;
    const rawHalfSpanMs = Number.isFinite(periodMs)
      ? Math.max(3 * 3600000, Math.min(7 * 86400000, periodMs * 3))
      : (surface ? Math.max(6 * 3600000, Math.min(2 * 86400000, rotationMs / 2)) : 86400000);
    const sourceStepMs = Math.max(1000, Number(trajectory.stepSeconds || 0) * 1000 ||
      (trajectory.samples[1][0] - trajectory.samples[0][0]));
    const desiredStepMs = Number.isFinite(periodMs)
      ? Math.max(15000, Math.min(sourceStepMs / 8, periodMs / 48))
      : Math.max(30000, Math.min(sourceStepMs / 4, 300000));
    const coverageStart = trajectory.samples[0][0];
    const coverageStop = trajectory.samples[trajectory.samples.length - 1][0];
    /* Advance the rolling window by one short, trajectory-cadence-derived
     * track leg.  The former halfSpan/2 bucket replaced roughly 1.5 local
     * orbits at once.  It also derived its absolute Unix-time bucket from a
     * slightly changing osculating period, amplifying tiny state changes into
     * large endpoint jumps.  These source-anchored fixed buckets retain the
     * same bounded several-orbit window while exchanging only a short leg. */
    const shiftStepMs = Math.max(15000, Math.min(300000, sourceStepMs / 8));
    const halfSpanQuantumMs = Math.max(1000, Math.min(15000, shiftStepMs / 8));
    const halfSpanMs = Math.max(halfSpanQuantumMs,
      Math.round(rawHalfSpanMs / halfSpanQuantumMs) * halfSpanQuantumMs);
    const centerMs = coverageStart + Math.floor((atMs - coverageStart) / shiftStepMs) * shiftStepMs;
    return {
      startMs: Math.max(coverageStart, centerMs - halfSpanMs),
      stopMs: Math.min(coverageStop, centerMs + halfSpanMs),
      desiredStepMs,
      shiftStepMs,
      periodMs,
      surface,
      distanceKm,
    };
  }

  /** Translate a heliocentric point from its own epoch into a moving display
   * frame at the displayed epoch. `bodyWorld` is injected for deterministic
   * headless tests and is Astro.bodyWorld in the application. */
  function pointInFrame(point, pointJd, displayJd, frameId, bodyWorld) {
    if (!finiteVector3(point)) return null;
    if (!frameId || frameId === "inertial" || frameId === "sun") return point.slice();
    if (typeof bodyWorld !== "function") return null;
    const thenOrigin = bodyWorld(frameId, pointJd);
    const nowOrigin = bodyWorld(frameId, displayJd);
    if (!finiteVector3(thenOrigin) || !finiteVector3(nowOrigin)) return null;
    return [
      point[0] - thenOrigin[0] + nowOrigin[0],
      point[1] - thenOrigin[1] + nowOrigin[1],
      point[2] - thenOrigin[2] + nowOrigin[2],
    ];
  }

  /** Moving-frame transform when the renderer and mission layer share one
   * body-position provider. At the displayed epoch the transform cancels,
   * leaving current official spacecraft vectors in the same global space as
   * the rendered official body centers. */
  function pointInProviderFrame(point, pointMs, displayMs, frameId, bodyWorldAtMs) {
    if (!finiteVector3(point) || !Number.isFinite(pointMs) || !Number.isFinite(displayMs)) return null;
    if (!frameId || frameId === "inertial" || frameId === "sun") return point.slice();
    if (typeof bodyWorldAtMs !== "function") return null;
    const thenOrigin = bodyWorldAtMs(frameId, pointMs);
    const nowOrigin = bodyWorldAtMs(frameId, displayMs);
    if (!finiteVector3(thenOrigin) || !finiteVector3(nowOrigin)) return null;
    return VEC_ADD(VEC_SUB(point, thenOrigin), nowOrigin);
  }

  /** Orbit-camera pose whose eye is exactly at craftWorld and whose view
   * center is targetWorld. Kept pure for deterministic POV regressions. */
  function povCameraPose(craftWorld, targetWorld) {
    if (!finiteVector3(craftWorld) || !finiteVector3(targetWorld)) return null;
    const dx = craftWorld[0] - targetWorld[0];
    const dy = craftWorld[1] - targetWorld[1];
    const dz = craftWorld[2] - targetWorld[2];
    const dist = Math.hypot(dx, dy, dz);
    if (!(dist > 1e-6)) return null;
    return {
      focus: targetWorld.slice(),
      yaw: Math.atan2(dy, dx),
      pitch: Math.asin(Math.max(-1, Math.min(1, dz / dist))),
      dist,
    };
  }

  function VEC_SUB(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function VEC_ADD(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }

  function selectedFitDistance(extentKm, frameId, bodies) {
    const extent = Number.isFinite(extentKm) && extentKm > 0 ? extentKm : 0;
    const body = frameId && frameId !== "inertial" && bodies ? bodies[frameId] : null;
    const localMinimum = body && Number.isFinite(body.radius) && body.radius > 0
      ? Math.max(500, body.radius * 1.5) : 500;
    return Math.max(localMinimum, extent * 3.1);
  }

  /** Camera floor: body focus stops just above the true spherical surface;
   * free mission focus may continue to a small visualization-scale floor. */
  function zoomFloorKm(focusBodyId, bodies, freeFloorKm) {
    const body = focusBodyId && bodies ? bodies[focusBodyId] : null;
    return body && Number.isFinite(body.radius) && body.radius > 0
      ? Math.max(1e-3, body.radius * 1.12)
      : Math.max(1e-3, Number.isFinite(freeFloorKm) ? freeFloorKm : 100);
  }

  /** Pick the visible body at a screen point.  Renderer body projections are
   * painter-sorted by depth only while drawing; their map therefore also
   * contains bodies that a nearer disk subsequently covers.  This helper
   * treats every rendered disk as an occluder, even when that body is not an
   * allowed focus target, and only then scores the remaining hit targets. */
  function pickVisibleBody(bodyProjections, point, minimumHitRadius, allowedIds) {
    if (!bodyProjections || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    const minHit = Math.max(1, Number.isFinite(minimumHitRadius) ? minimumHitRadius : 12);
    const allows = (id) => !allowedIds ||
      (typeof allowedIds.has === "function" ? allowedIds.has(id) :
        (Array.isArray(allowedIds) ? allowedIds.includes(id) : true));
    const disks = [];
    for (const [id, projection] of Object.entries(bodyProjections)) {
      if (!projection || !Number.isFinite(projection.x) || !Number.isFinite(projection.y) ||
          !Number.isFinite(projection.z) || !(projection.r > 0)) continue;
      disks.push({ id, x: projection.x, y: projection.y, z: projection.z, r: projection.r });
    }
    let best = null;
    let bestScore = Infinity;
    for (const candidate of disks) {
      if (!allows(candidate.id)) continue;
      const dx = candidate.x - point.x;
      const dy = candidate.y - point.y;
      const distance = Math.hypot(dx, dy);
      const hitRadius = Math.max(minHit, candidate.r);
      if (distance > hitRadius) continue;

      let hidden = false;
      for (const foreground of disks) {
        if (foreground.id === candidate.id || foreground.z >= candidate.z - 1e-9) continue;
        const centerDistance = Math.hypot(foreground.x - candidate.x, foreground.y - candidate.y);
        const fullyCovered = centerDistance + candidate.r <= foreground.r + 1e-6;
        const pointerCovered = Math.hypot(foreground.x - point.x, foreground.y - point.y) <= foreground.r;
        if (fullyCovered || pointerCovered) { hidden = true; break; }
      }
      if (hidden) continue;

      const score = distance / hitRadius;
      if (score < bestScore || (Math.abs(score - bestScore) < 1e-9 && (!best || candidate.z < best.z))) {
        best = candidate;
        bestScore = score;
      }
    }
    return best ? best.id : null;
  }

  function isRecentBodyPointerPick(pick, point, eventTime) {
    return Boolean(pick && point && Number.isFinite(pick.x) && Number.isFinite(pick.y) &&
      Number.isFinite(pick.at) && Number.isFinite(point.x) && Number.isFinite(point.y) &&
      Number.isFinite(eventTime) && eventTime >= pick.at && eventTime - pick.at <= 650 &&
      Math.hypot(point.x - pick.x, point.y - pick.y) <= 16);
  }

  /** Validate and split a display-only historical Horizons polyline. Archive
   * rows intentionally contain positions only: they are never interpolated
   * into a current state. Invalid rows, reversed/duplicate epochs, and source
   * producer-declared gaps break the stroke so the canvas cannot
   * invent a connecting leg. */
  function archivePathSegments(archive, maxPoints) {
    const samples = archive && Array.isArray(archive.samples) ? archive.samples : [];
    if (samples.length < 2) return [];
    const explicitGap = Number(archive.maxGapMs);
    /* Geometry-preserving simplification intentionally removes thousands of
     * smooth one-day source rows, so a long interval between retained
     * vertices is not a missing-data gap. Generated archives publish both
     * source counts and cadence. Only a producer-supplied threshold may turn
     * those sparse retained epochs into a stroke break. */
    const gapLimit = explicitGap > 0 ? explicitGap : Infinity;
    const segments = [];
    let segment = [];
    let previous = null;
    const flush = () => {
      if (segment.length >= 2) segments.push(segment);
      segment = [];
      previous = null;
    };
    for (const sample of samples) {
      if (!Array.isArray(sample) || sample.length < 4 ||
          !sample.slice(0, 4).every(Number.isFinite)) {
        flush();
        continue;
      }
      const point = { t: sample[0], r: sample.slice(1, 4) };
      if (previous && (point.t <= previous.t || point.t - previous.t > gapLimit)) flush();
      segment.push(point);
      previous = point;
    }
    flush();
    if (!segments.length) return [];

    const limit = Math.max(4, Math.floor(Number.isFinite(maxPoints) ? maxPoints : 2400));
    let drawable = segments;
    if (drawable.length * 2 > limit) drawable = drawable.slice(0, Math.floor(limit / 2));
    const total = drawable.reduce((sum, points) => sum + points.length, 0);
    if (total <= limit) return drawable;
    let stride = Math.max(2, Math.ceil(total / limit));
    while (true) {
      const reduced = drawable.map((points) => {
        const next = [points[0]];
        for (let i = stride; i < points.length - 1; i += stride) next.push(points[i]);
        next.push(points[points.length - 1]);
        return next;
      });
      if (reduced.reduce((sum, points) => sum + points.length, 0) <= limit) return reduced;
      stride++;
    }
  }

  function archivePathAvailable(archive) {
    return archivePathSegments(archive, 4).some((segment) => segment.length >= 2);
  }

  /** Current vectors always win by default. History is an explicit display
   * choice, except that selecting an archive-only catalog entry may visibly
   * enable it so the selection has something honest to show. */
  function selectedPathKind(currentTrajectory, archive, historyEnabled) {
    if (historyEnabled && archivePathAvailable(archive)) return "history";
    return currentTrajectory ? "current" : "none";
  }

  function shouldAutoEnableHistory(currentTrajectory, archive) {
    return !currentTrajectory && archivePathAvailable(archive);
  }

  /** Surface sites are an explicit catalog fact, never inferred from altitude:
   * a proximity threshold large enough for topography would also catch real
   * low orbiters. */
  function isSurfaceMission(mission) {
    return Boolean(mission && typeof mission.surfaceBody === "string" && mission.surfaceBody);
  }

  /** Bodies that can own a Deep camera focus/reference frame.  The shared
   * renderer can draw every cataloged minor body, so its interaction allowlist
   * must include asteroids and comets as well as planets, moons, and dwarfs. */
  function isFocusableBody(body) {
    return Boolean(body && (body.id === "sun" || body.type === "planet" ||
      body.type === "moon" || body.type === "dwarf" || body.type === "asteroid" ||
      body.type === "comet"));
  }

  const SYNODIC_FRAME_PREFIX = "synodic:";

  /** Synodic frames are display-only rotating coordinates. They must never
   * be treated as catalog bodies or passed into body/surface lookups. */
  function cr3bpSystemIdForFrame(frameId) {
    return typeof frameId === "string" && frameId.startsWith(SYNODIC_FRAME_PREFIX)
      ? frameId.slice(SYNODIC_FRAME_PREFIX.length) : "";
  }

  function isSynodicFrameId(frameId) {
    const id = cr3bpSystemIdForFrame(frameId);
    return id === "sun-earth" || id === "earth-moon";
  }

  /** Mirror renderer.js minor-body visibility for non-renderer consumers such
   * as POV targeting. A hidden minor remains available when it is the exact
   * active Focus or Frame, matching the Planner and preventing a blank view. */
  function bodyVisibleWithMinorOption(body, showMinor, focusId, frameId, bodies) {
    if (!body) return false;
    let current = body;
    let hasMinorAncestor = false;
    let depth = 0;
    while (current && depth++ < 32) {
      if (current.type === "dwarf" || current.type === "asteroid" || current.type === "comet") {
        hasMinorAncestor = true;
        break;
      }
      current = current.parent && bodies ? bodies[current.parent] : null;
    }
    return showMinor !== false || !hasMinorAncestor || body.id === focusId || body.id === frameId;
  }

  /** Identical inertial-to-body-fixed construction used by groundtrack.js
   * and the texture mapper. `spinAt` supplies the body's sidereal angle. */
  function bodyLatLon(body, nWorld, jd, spinAt) {
    const astro = globalThis.Astro;
    if (!astro || typeof astro.bodyLatLon !== "function" || !body || !finiteVector3(nWorld)) return null;
    const spin = typeof spinAt === "function" ? spinAt(body, jd) : undefined;
    return astro.bodyLatLon(body, nWorld, jd, spin);
  }

  globalThis.MTPDeepMath = Object.freeze({
    stateAtTrajectory, pointInFrame, pointInProviderFrame, povCameraPose,
    selectedFitDistance, zoomFloorKm, bodyLatLon, trajectoryCoverageBounds,
    boundedPlaybackTime, boundedHermiteWindow, localOrbitWindowSpec, pickVisibleBody,
    isRecentBodyPointerPick, isFocusableBody, archivePathSegments,
    bodyVisibleWithMinorOption, archivePathAvailable, selectedPathKind, shouldAutoEnableHistory,
    isSurfaceMission, cr3bpSystemIdForFrame, isSynodicFrameId,
  });

  /* Keep the interpolation helper headless-testable without constructing DOM. */
  if (typeof document === "undefined") return;

  const C = globalThis.AstroConst;
  const Astro = globalThis.Astro;
  const Render = globalThis.MTPRender;
  const catalog = globalThis.MTPDeepSpaceCatalog;
  const ephemeris = globalThis.MTP_DEEP_EPHEMERIS;
  const archives = globalThis.MTP_DEEP_ARCHIVES || Object.freeze({ trajectories: Object.freeze({}) });
  const trackerDisplay = globalThis.MTPTrackerDisplay;
  const $ = (id) => document.getElementById(id);
  const app = $("app");
  const canvas = $("liveCanvas");
  const list = $("liveMissionList");
  if (!C || !Astro || !Render || !catalog || !ephemeris || !app || !canvas || !list) return;

  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return;

  const AU = C.AU;
  const DAY_MS = 86400000;
  const V = Astro.V;
  const referenceBodies = ephemeris.referenceBodies || Object.freeze({});
  const MAX_PATH_POINTS = 2400;
  const MAX_ARCHIVE_PATH_POINTS = 4800;
  const MAX_BODY_ORBIT_POINTS = 360;
  const MAX_GROUND_SAMPLES = 2400;
  const GROUND_FRAME_MS = 100;
  const FREE_ZOOM_FLOOR_KM = 100;
  const GROUPS = Object.freeze(["LUNAR", "MARS", "INNER_HELIO", "OUTER", "SMALL_BODY", "OBSERVATORY"]);
  const GROUP_SHORT = Object.freeze({
    LUNAR: "Moon", MARS: "Mars", INNER_HELIO: "Inner / Sun",
    OUTER: "Outer", SMALL_BODY: "Small body", OBSERVATORY: "Observatory",
  });
  const LEGEND_CLASS = Object.freeze({
    LUNAR: "lunar", MARS: "mars", INNER_HELIO: "inner-helio",
    OUTER: "outer", SMALL_BODY: "small-body", OBSERVATORY: "observatory",
  });

  const dom = {
    search: $("liveSearch"), group: $("liveGroup"), empty: $("liveEmpty"),
    catalogMeta: $("liveCatalogMeta"), topStatus: $("liveTopStatus"),
    source: $("liveSource"), catalogToggle: $("btnCatalogToggle"),
    play: $("btnLivePlay"), now: $("btnLiveNow"), speed: $("liveSpeed"),
    utc: $("liveUtc"), mode: $("liveMode"), fitAll: $("btnLiveFitAll"),
    resetView: $("btnLiveResetView"), scale: $("liveScaleReadout"),
    transportNote: $("liveTransportNote"),
    card: $("liveCard"), cardClose: $("liveCardClose"),
    cardGroup: $("liveCardGroup"), cardTitle: $("liveCardTitle"),
    cardMeta: $("liveCardMeta"), cardSummary: $("liveCardSummary"),
    detailId: $("liveDetailNorad"), detailCoverage: $("liveDetailEpoch"),
    detailDistance: $("liveDetailAltitude"), detailSpeed: $("liveDetailSpeed"),
    detailStatus: $("liveDetailApsides"), detailDestination: $("liveDetailPlane"),
    ephemerisNote: $("liveCardElementNote"), wiki: $("liveWiki"),
    fitSelected: $("btnLiveFitSelected"),
    optPaths: $("liveOptPaths"), optMarkers: $("liveOptMarkers"),
    optLabels: $("liveOptLabels"), optGrid: $("liveOptGrid"),
    optTextures: $("liveOptTextures"), optMinor: $("liveOptMinor"), optOrbits: $("liveOptOrbits"),
    optHistory: $("liveOptHistory"), optLagrange: $("liveOptLagrange"),
    cr3bpSystem: $("liveCr3bpSystem"),
    viewControls: $("liveDeepViewControls"), focusBody: $("liveFocusBody"),
    frameBody: $("liveFrameBody"), ground: $("btnLiveGround"), pov: $("btnLivePov"),
    groundPanel: $("liveGroundPanel"), groundCanvas: $("liveGroundCanvas"),
    groundStatus: $("liveGroundStatus"), groundClose: $("btnLiveGroundClose"),
  };

  const viewBodies = Object.values(C.BODIES).filter(isFocusableBody);
  const focusableBodyIds = new Set(viewBodies.map((body) => body.id));
  const povBodies = Object.values(C.BODIES).filter((body) => body && Number.isFinite(body.radius));
  const display = trackerDisplay && trackerDisplay.state ? trackerDisplay.state :
    { paths: true, markers: true, labels: true, grid: false, textures: true, minor: true, orbits: true,
      soi: false, flat: false, history: false, lagrange: false };
  let focusBodyId = "sun";
  let frameBodyId = "inertial";
  let cr3bpSystemId = "earth-moon";
  let librationFocus = null;
  let lastHistoryEnabled = Boolean(display.history);

  function setSource(state, text) {
    if (dom.topStatus) dom.topStatus.dataset.state = state;
    if (dom.source) dom.source.textContent = text;
  }

  function appendBodyOption(select, value, label) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }

  function populateViewControls() {
    if (dom.viewControls) dom.viewControls.hidden = false;
    if (dom.focusBody) {
      dom.focusBody.replaceChildren();
      appendBodyOption(dom.focusBody, "", "Selected mission");
      for (const body of viewBodies) {
        const parent = body.parent && C.BODIES[body.parent];
        const referenceNote = body.id !== "sun" && !referenceBodies[body.id] ? " - approximate" : "";
        appendBodyOption(dom.focusBody, body.id, (parent && parent.id !== "sun"
          ? body.name + " (" + parent.name + ")" : body.name) + referenceNote);
      }
      dom.focusBody.value = focusBodyId;
      dom.focusBody.addEventListener("change", () => setFocusBody(dom.focusBody.value));
    }
    if (dom.frameBody) {
      dom.frameBody.replaceChildren();
      appendBodyOption(dom.frameBody, "inertial", "Sun / inertial");
      appendBodyOption(dom.frameBody, "synodic:sun-earth", "Sun-Earth / synodic (ideal CR3BP)");
      appendBodyOption(dom.frameBody, "synodic:earth-moon", "Earth-Moon / synodic (ideal CR3BP)");
      for (const body of viewBodies) {
        if (body.id === "sun") continue;
        const parent = body.parent && C.BODIES[body.parent];
        appendBodyOption(dom.frameBody, body.id, body.name + " relative" +
          (parent && parent.id !== "sun" ? " (" + parent.name + ")" : "") +
          (referenceBodies[body.id] ? "" : " - approximate"));
      }
      dom.frameBody.value = frameBodyId;
      dom.frameBody.addEventListener("change", () => setFrameBody(dom.frameBody.value));
    }
    if (dom.cr3bpSystem) {
      dom.cr3bpSystem.value = cr3bpSystemId;
      dom.cr3bpSystem.addEventListener("change", () => setCr3bpSystem(dom.cr3bpSystem.value));
    }
  }

  function bindDisplayToggles() {
    if (trackerDisplay && typeof trackerDisplay.subscribe === "function") {
      trackerDisplay.subscribe((state) => {
        if (!state.markers) { hoveredId = null; screenMarkers = []; }
        if (!state.lagrange) screenLibrationPoints = [];
        const nextHistory = Boolean(state.history);
        if (nextHistory !== lastHistoryEnabled) {
          lastHistoryEnabled = nextHistory;
          updateSelectedCard(true);
          if (nextHistory && selectedId && archiveById.has(selectedId)) fitSelected();
        }
      });
      return;
    }
    const bindings = [
      [dom.optPaths, "paths"], [dom.optMarkers, "markers"], [dom.optLabels, "labels"],
      [dom.optGrid, "grid"], [dom.optTextures, "textures"], [dom.optOrbits, "orbits"],
      [dom.optMinor, "minor"], [dom.optHistory, "history"],
    ];
    for (const [element, key] of bindings) {
      if (!element) continue;
      element.checked = display[key];
      element.addEventListener("change", () => {
        display[key] = element.checked;
        if (key === "markers" && !display.markers) { hoveredId = null; screenMarkers = []; }
        if (key === "history") {
          lastHistoryEnabled = Boolean(display.history);
          updateSelectedCard(true);
          if (display.history && selectedId && archiveById.has(selectedId)) fitSelected();
        }
      });
    }
  }

  function setHistoryEnabled(enabled) {
    const next = Boolean(enabled);
    if (trackerDisplay && typeof trackerDisplay.setOption === "function") {
      trackerDisplay.setOption("history", next);
      return;
    }
    display.history = next;
    lastHistoryEnabled = next;
    if (dom.optHistory) dom.optHistory.checked = next;
  }

  /* -------------------------- data integrity --------------------------- */
  const missionById = new Map();
  const trajectoryById = new Map();
  const archiveById = new Map();
  const archiveSegmentsById = new Map();
  let catalogError = "";
  if (!Array.isArray(catalog.missions) || catalog.missions.length !== 100) {
    catalogError = "Catalog integrity error: expected exactly 100 entries.";
  }
  for (const mission of catalog.missions || []) {
    const id = String(mission.horizonsId);
    if (missionById.has(id)) catalogError = "Catalog integrity error: duplicate Horizons ID " + id + ".";
    if (!GROUPS.includes(mission.group)) catalogError = "Catalog integrity error: unsupported group " + mission.group + ".";
    if (isSurfaceMission(mission) && !C.BODIES[mission.surfaceBody]) {
      catalogError = "Catalog integrity error: unknown surface body " + mission.surfaceBody + ".";
    }
    missionById.set(id, mission);
  }
  for (const id of Object.keys(ephemeris.trajectories || {})) {
    const trajectory = ephemeris.trajectories[id];
    if (!missionById.has(String(id))) catalogError = "Ephemeris integrity error: unknown Horizons ID " + id + ".";
    if (trajectory && Array.isArray(trajectory.samples) && trajectory.samples.length >= 2) {
      trajectoryById.set(String(id), trajectory);
    }
  }
  for (const id of Object.keys(archives.trajectories || {})) {
    const archive = archives.trajectories[id];
    const segments = archivePathSegments(archive, MAX_ARCHIVE_PATH_POINTS);
    if (missionById.has(String(id)) && segments.length) {
      archiveById.set(String(id), archive);
      archiveSegmentsById.set(String(id), segments);
    }
  }
  if (trajectoryById.size !== Number(ephemeris.covered)) {
    catalogError = "Ephemeris integrity error: coverage count does not match trajectory bundle.";
  }
  if (catalogError) setSource("offline", catalogError);

  /* --------------------------- visual palette -------------------------- */
  const BLUEPRINT_COLORS = Object.freeze({
    LUNAR: "#1d4ed8", MARS: "#c2410c", INNER_HELIO: "#b45309",
    OUTER: "#6b21a8", SMALL_BODY: "#0e7e74", OBSERVATORY: "#2f6f3e",
    trajectory: "#c84618",
  });
  const CINEMATIC_COLORS = Object.freeze({
    LUNAR: "#58a6ff", MARS: "#ff6a3d", INNER_HELIO: "#fbbf24",
    OUTER: "#c4a5ff", SMALL_BODY: "#45c4b0", OBSERVATORY: "#7dd3a0",
    trajectory: "#ff8f69",
  });

  function colors() {
    return app.dataset.theme === "cinematic" ? CINEMATIC_COLORS : BLUEPRINT_COLORS;
  }

  let paletteTheme = "";
  function syncPalette() {
    const theme = app.dataset.theme || "blueprint";
    if (theme === paletteTheme) return;
    paletteTheme = theme;
    const next = colors();
    for (const [id, entry] of rows) {
      const mission = missionById.get(id);
      if (mission && entry.dot) entry.dot.style.backgroundColor = next[mission.group];
    }
    for (const group of GROUPS) {
      const swatch = document.querySelector(".live-legend-swatch." + LEGEND_CLASS[group]);
      if (swatch) swatch.style.backgroundColor = next[group];
    }
  }

  /* -------------------------- catalog UI ------------------------------- */
  const rows = new Map();
  let visibleMissions = catalog.missions.slice();
  let selectedId = null;
  let hoveredId = null;

  function selectedPathType(id) {
    const key = String(id == null ? selectedId : id);
    const mission = missionById.get(key);
    if (isSurfaceMission(mission) && trajectoryById.has(key)) return "surface";
    if (display.history && archiveSegmentsById.has(key)) return "history";
    return trajectoryById.has(key) ? "current" : "none";
  }

  function syncRowTabStops(preferredId) {
    const visibleIds = new Set(visibleMissions.map((mission) => String(mission.horizonsId)));
    const firstId = visibleMissions.length ? String(visibleMissions[0].horizonsId) : null;
    const activeId = visibleIds.has(preferredId) ? preferredId :
      (visibleIds.has(selectedId) ? selectedId : firstId);
    for (const [id, entry] of rows) entry.row.tabIndex = id === activeId ? 0 : -1;
  }

  function moveRowFocus(id, command) {
    if (!visibleMissions.length) return;
    let index = visibleMissions.findIndex((mission) => String(mission.horizonsId) === id);
    if (command === "home") index = 0;
    else if (command === "end") index = visibleMissions.length - 1;
    else index = (Math.max(index, 0) + command + visibleMissions.length) % visibleMissions.length;
    const nextId = String(visibleMissions[index].horizonsId);
    const next = rows.get(nextId);
    if (next) {
      syncRowTabStops(nextId);
      next.row.focus();
    }
  }

  function buildList() {
    const fragment = document.createDocumentFragment();
    for (const mission of catalog.missions) {
      const id = String(mission.horizonsId);
      const row = document.createElement("button");
      row.type = "button";
      row.className = "live-mission-row";
      row.dataset.horizonsId = id;
      row.setAttribute("aria-pressed", "false");
      row.tabIndex = -1;
      row.title = mission.name + " - Horizons " + id;

      const dot = document.createElement("span");
      dot.className = "live-row-dot group-" + mission.group;
      dot.setAttribute("aria-hidden", "true");

      const copy = document.createElement("span");
      copy.className = "live-row-copy";
      const name = document.createElement("span");
      name.className = "live-row-name";
      name.textContent = mission.name;
      const meta = document.createElement("span");
      meta.className = "live-row-meta";
      meta.textContent = GROUP_SHORT[mission.group] + " / " + mission.agency + " / " + id;
      copy.append(name, meta);

      const state = document.createElement("span");
      state.className = "live-row-state";
      state.textContent = trajectoryById.has(id) ? (isSurfaceMission(mission) ? "SITE" : "BUNDLE") :
        (archiveById.has(id) ? "HISTORY" : "CATALOG");
      row.classList.toggle("has-history", archiveById.has(id));
      row.append(dot, copy, state);
      row.addEventListener("click", () => selectMission(id, true));
      row.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown") { moveRowFocus(id, 1); event.preventDefault(); }
        else if (event.key === "ArrowUp") { moveRowFocus(id, -1); event.preventDefault(); }
        else if (event.key === "Home") { moveRowFocus(id, "home"); event.preventDefault(); }
        else if (event.key === "End") { moveRowFocus(id, "end"); event.preventDefault(); }
      });
      rows.set(id, { row, state, dot });
      fragment.appendChild(row);
    }
    list.replaceChildren(fragment);
    syncRowTabStops(null);
    syncPalette();
  }

  function applyFilters() {
    const query = dom.search ? dom.search.value.trim().toLowerCase() : "";
    const group = dom.group ? dom.group.value : "ALL";
    visibleMissions = [];
    for (const mission of catalog.missions) {
      const id = String(mission.horizonsId);
      const haystack = (mission.name + " " + mission.agency + " " + mission.destination + " " +
        mission.groupLabel + " " + id).toLowerCase();
      const visible = (group === "ALL" || mission.group === group) && (!query || haystack.includes(query));
      const entry = rows.get(id);
      if (entry) entry.row.hidden = !visible;
      if (visible) visibleMissions.push(mission);
    }
    if (dom.empty) dom.empty.hidden = visibleMissions.length !== 0;
    if (selectedId && !visibleMissions.some((mission) => String(mission.horizonsId) === selectedId)) clearSelection();
    syncRowTabStops(selectedId);
    updateCatalogMeta();
  }

  function updateCatalogMeta() {
    if (!dom.catalogMeta) return;
    dom.catalogMeta.textContent = catalog.missions.length + " catalog entries / " +
      trajectoryById.size + " with bundle / " + archiveById.size + " histories / " +
      stateById.size + " at displayed UTC / " +
      visibleMissions.length + " shown";
  }

  function updateRowStates() {
    for (const mission of catalog.missions) {
      const id = String(mission.horizonsId);
      const entry = rows.get(id);
      if (!entry) continue;
      const valid = stateById.has(id);
      const bundled = trajectoryById.has(id);
      const historical = archiveById.has(id);
      entry.row.classList.toggle("has-elements", valid);
      entry.row.classList.toggle("has-history", historical);
      entry.state.textContent = valid ? (isSurfaceMission(mission) ? "SITE" : "VECTOR") : (bundled ? "OUTSIDE" :
        (historical ? "HISTORY" : "CATALOG"));
      entry.state.title = valid ? (isSurfaceMission(mission)
        ? "Bundled Horizons surface-site vector covers the displayed UTC"
        : "Bundled vector covers the displayed UTC") :
        (bundled ? "Displayed UTC is outside this trajectory bundle" :
          (historical ? "Bounded historical mission path available; no current position" :
            "No current-window trajectory bundle"));
    }
    updateCatalogMeta();
  }

  /* ------------------------------ clock -------------------------------- */
  const bundleCoverage = trajectoryCoverageBounds(trajectoryById.values());
  const initialClock = boundedPlaybackTime(Date.now(), bundleCoverage);
  let playing = !initialClock.boundary;
  let speed = 1;
  let simMs = initialClock.atMs;
  let anchorSimMs = simMs;
  let anchorPerfMs = performance.now();
  let lastClockSecond = -1;
  let playbackBoundary = initialClock.boundary;

  function currentClockMs(perfMs) {
    if (playing) {
      const bounded = boundedPlaybackTime(anchorSimMs + (perfMs - anchorPerfMs) * speed, bundleCoverage);
      simMs = bounded.atMs;
      if (bounded.boundary) {
        playing = false;
        playbackBoundary = bounded.boundary;
        anchorSimMs = simMs;
        anchorPerfMs = perfMs;
        updateClockControls(true);
      }
    }
    return simMs;
  }

  function reanchorClock(nextMs) {
    simMs = nextMs;
    anchorSimMs = simMs;
    anchorPerfMs = performance.now();
  }

  function setPlaying(next) {
    if (playing === next) return;
    const now = currentClockMs(performance.now());
    if (next && bundleCoverage && now >= bundleCoverage.stopMs) {
      playbackBoundary = "end";
      updateClockControls(true);
      return;
    }
    playbackBoundary = "";
    playing = next;
    reanchorClock(now);
    updateClockControls(true);
  }

  function togglePlay() { setPlaying(!playing); }

  function returnToNow() {
    speed = 1;
    if (dom.speed) dom.speed.value = "1";
    const bounded = boundedPlaybackTime(Date.now(), bundleCoverage);
    playbackBoundary = bounded.boundary;
    playing = !bounded.boundary;
    reanchorClock(bounded.atMs);
    updateStates(simMs, true);
    updateClockControls(true);
  }

  function updateClockControls(force) {
    const wholeSecond = Math.floor(simMs / 1000);
    if (force || wholeSecond !== lastClockSecond) {
      lastClockSecond = wholeSecond;
      const date = new Date(simMs);
      if (dom.utc && Number.isFinite(date.getTime())) {
        const iso = date.toISOString();
        dom.utc.dateTime = iso;
        dom.utc.textContent = iso.slice(0, 10) + " " + iso.slice(11, 19) + " UTC";
      }
    }
    if (dom.play) {
      dom.play.textContent = playing ? "Pause" : "Play";
      dom.play.setAttribute("aria-pressed", playing ? "true" : "false");
    }
    if (dom.mode) {
      const atNow = playing && speed === 1 && Math.abs(simMs - Date.now()) < 5000;
      dom.mode.className = atNow ? "is-live" : (playing ? "is-sim" : "is-paused");
      dom.mode.textContent = playbackBoundary === "end" ? "END" :
        (playbackBoundary === "start" ? "START" : (atNow ? "NOW" : (playing ? "SIM" : "PAUSED")));
    }
  }

  /* ----------------------- bounded ephemeris states -------------------- */
  let stateById = new Map();
  let lastStatePerf = -Infinity;
  let lastStateSimMs = NaN;
  let lastCoverageCount = -1;
  let lastSourceMinute = "";
  let lastCardPerf = -Infinity;

  function updateStates(atMs, force, perfMs) {
    const nowPerf = Number.isFinite(perfMs) ? perfMs : performance.now();
    if (!force && atMs === lastStateSimMs) return;
    if (!force && nowPerf - lastStatePerf < 50) return;
    lastStatePerf = nowPerf;
    lastStateSimMs = atMs;
    const next = new Map();
    for (const [id, trajectory] of trajectoryById) {
      const state = stateAtTrajectory(trajectory, atMs);
      if (state) next.set(id, state);
    }
    stateById = next;

    const minute = new Date(atMs).toISOString().slice(0, 16);
    const coverageChanged = next.size !== lastCoverageCount;
    if (force || coverageChanged) {
      lastCoverageCount = next.size;
      updateRowStates();
    }
    if (!catalogError && (force || coverageChanged || minute !== lastSourceMinute)) {
      lastSourceMinute = minute;
      const boundaryNote = playbackBoundary
        ? " / playback paused at bundle " + playbackBoundary + " (no extrapolation)" : "";
      setSource("cached", "Static Horizons bundle / " + next.size + "/100 at displayed UTC / generated " +
        formatShortUtc(Date.parse(ephemeris.generatedAt)) + boundaryNote);
    }
    updateSelectedCard(force, nowPerf);
  }

  /* ----------------------------- camera -------------------------------- */
  const camera = Render.createCamera();
  const view = { width: 1, height: 1, dpr: 1 };
  let screenMarkers = [];
  let screenBodies = {};
  let screenLibrationPoints = [];
  let lastScaleText = "";
  let lastBasis = null;
  let lastOccluders = [];
  let pathFrameCache = { trajectory: null, alignmentKey: "", windowKey: "", points: [] };
  let archiveFrameCache = { archive: null, alignmentKey: "", segments: [] };
  let groundOpen = false;
  let groundAdapterCache = { trajectory: null, bodyId: "", windowKey: "", value: null };
  let lastGroundPerf = -Infinity;
  let providerDisplayMs = NaN;
  const providerBodyCache = new Map();
  const bodyOrbitPathCache = new Map();
  let povActive = false;
  let povTargetId = null;
  let lastPovButtonKey = "";

  function clamp(value, lo, hi) { return Math.max(lo, Math.min(hi, value)); }

  function currentZoomFloor() {
    return zoomFloorKm(camera.focusMode === "body" ? camera.focusBody : null,
      C.BODIES, FREE_ZOOM_FLOOR_KM);
  }

  function alignmentBodyId() {
    if (focusBodyId && focusBodyId !== "sun") return focusBodyId;
    return frameBodyId !== "inertial" && !isSynodicFrameId(frameBodyId) ? frameBodyId : null;
  }

  function alignmentKey() {
    return "frame:" + frameBodyId + "|focus:" + (focusBodyId || "mission");
  }

  function referenceStateForBody(bodyId, atMs) {
    const reference = bodyId && referenceBodies[bodyId];
    return reference ? stateAtTrajectory(reference, atMs) : null;
  }

  function hasReferenceAt(bodyId, atMs) {
    const reference = bodyId && referenceBodies[bodyId];
    return !!(reference && atMs >= reference.startMs && atMs <= reference.stopMs);
  }

  function authoritativeBodyWorldAtMs(bodyId, atMs) {
    const reference = referenceStateForBody(bodyId, atMs);
    return reference ? reference.r : Astro.bodyWorld(bodyId, 2440587.5 + atMs / DAY_MS);
  }

  function authoritativeBodyStateAtMs(bodyId, atMs) {
    const reference = referenceStateForBody(bodyId, atMs);
    if (reference) return reference;
    const dtMs = 30000;
    const r = Astro.bodyWorld(bodyId, 2440587.5 + atMs / DAY_MS);
    const before = Astro.bodyWorld(bodyId, 2440587.5 + (atMs - dtMs) / DAY_MS);
    const after = Astro.bodyWorld(bodyId, 2440587.5 + (atMs + dtMs) / DAY_MS);
    return { r, v: V.scale(V.sub(after, before), 1 / (2 * dtMs / 1000)), atMs };
  }

  function localWindowFor(trajectory, bodyId, atMs) {
    const body = C.BODIES[bodyId];
    const craft = stateAtTrajectory(trajectory, atMs);
    const origin = body && authoritativeBodyStateAtMs(bodyId, atMs);
    if (!craft || !origin) return null;
    return localOrbitWindowSpec(trajectory, atMs, body, {
      r: V.sub(craft.r, origin.r),
      v: V.sub(craft.v, origin.v),
    });
  }

  function prepareBodyProvider(atMs) {
    if (providerDisplayMs === atMs) return;
    providerDisplayMs = atMs;
    providerBodyCache.clear();
  }

  function bodyAtDisplay(bodyId) {
    if (providerBodyCache.has(bodyId)) return providerBodyCache.get(bodyId);
    const point = authoritativeBodyWorldAtMs(bodyId, providerDisplayMs);
    providerBodyCache.set(bodyId, point);
    return point;
  }

  function renderedBodyWorldAtMs(bodyId, atMs) {
    return providerDisplayMs === atMs ? bodyAtDisplay(bodyId) : authoritativeBodyWorldAtMs(bodyId, atMs);
  }

  function deepBodyWorld(bodyId, jd) {
    const atMs = (jd - 2440587.5) * DAY_MS;
    if (Number.isFinite(providerDisplayMs) && Math.abs(atMs - providerDisplayMs) < 1) {
      return bodyAtDisplay(bodyId);
    }
    return authoritativeBodyWorldAtMs(bodyId, atMs);
  }

  function deepBodyOrbitPath(bodyId, jd) {
    const body = C.BODIES[bodyId];
    if (!body || !body.parent || !referenceBodies[bodyId]) return null;
    const atMs = (jd - 2440587.5) * DAY_MS;
    if (!hasReferenceAt(bodyId, atMs) ||
        (body.parent !== "sun" && !hasReferenceAt(body.parent, atMs))) return null;
    const bucketSeconds = Math.max(21600, Math.min(7 * C.DAY, (body.periodS || C.DAY) / 8));
    const key = Math.floor(atMs / (bucketSeconds * 1000));
    const cached = bodyOrbitPathCache.get(bodyId);
    if (cached && cached.key === key) return cached.value;
    const child = referenceStateForBody(bodyId, atMs);
    const parent = body.parent === "sun"
      ? { r: [0, 0, 0], v: [0, 0, 0] } : referenceStateForBody(body.parent, atMs);
    if (!child || !parent) return null;
    const r = V.sub(child.r, parent.r);
    const v = V.sub(child.v, parent.v);
    const coe = Astro.rvToCoe(r, v, C.BODIES[body.parent].mu);
    if (!(coe.e < 1) || !(coe.a > 0) || !Number.isFinite(coe.nu)) return null;
    const points = [];
    for (let i = 0; i <= MAX_BODY_ORBIT_POINTS; i++) {
      const nu = coe.nu + 2 * Math.PI * i / MAX_BODY_ORBIT_POINTS;
      points.push(Astro.coeToRV({ a: coe.a, e: coe.e, i: coe.i, Om: coe.Om, w: coe.w, nu },
        C.BODIES[body.parent].mu).r);
    }
    const value = { points, parentLocal: true };
    bodyOrbitPathCache.set(bodyId, { key, value });
    return value;
  }

  /** The renderer, camera, markers, and Deep paths now share the same body
   * provider. Current marker transforms therefore cancel to the official
   * heliocentric point instead of applying a second body correction. */
  function currentAlignment(atMs) {
    const focusBody = focusBodyId && focusBodyId !== "sun" ? focusBodyId : null;
    const synodicSystemId = cr3bpSystemIdForFrame(frameBodyId);
    const synodicSystem = synodicSystemId && globalThis.CR3BP
      ? globalThis.CR3BP.getSystem(synodicSystemId) : null;
    const movingBody = frameBodyId !== "inertial" && !synodicSystem ? frameBodyId : null;
    const bodyId = focusBody || movingBody;
    const synodicExact = !synodicSystem ||
      (hasReferenceAt(synodicSystem.primaryId, atMs) && hasReferenceAt(synodicSystem.secondaryId, atMs));
    const exact = (!focusBody || hasReferenceAt(focusBody, atMs)) &&
      (!movingBody || hasReferenceAt(movingBody, atMs)) && synodicExact;
    const jd = 2440587.5 + atMs / DAY_MS;
    const frameContext = Render._test && typeof Render._test.displayFrameContext === "function"
      ? Render._test.displayFrameContext(frameBodyId, jd, deepBodyWorld) : null;
    return {
      bodyId,
      synodicSystem,
      exact,
      mode: synodicSystem ? "synodic" : (!bodyId ? "inertial" : (exact ? "horizons" : "approximate")),
      frameOffset: movingBody ? renderedBodyWorldAtMs(movingBody, atMs) :
        (frameContext && frameContext.offset ? frameContext.offset : [0, 0, 0]),
    };
  }

  function pointAtCurrentAlignment(point, atMs) {
    return pointForDisplay(point, atMs, atMs);
  }

  function pointForDisplay(point, pointMs, displayMs) {
    const helper = Render._test && Render._test.pointInDisplayFrame;
    if (typeof helper === "function") {
      return helper(point, frameBodyId, 2440587.5 + pointMs / DAY_MS,
        2440587.5 + displayMs / DAY_MS, deepBodyWorld);
    }
    if (isSynodicFrameId(frameBodyId)) return point.slice();
    return pointInProviderFrame(point, pointMs, displayMs, frameBodyId, authoritativeBodyWorldAtMs);
  }

  function selectedStateAt(atMs) {
    const trajectory = selectedId ? trajectoryById.get(selectedId) : null;
    return trajectory ? stateAtTrajectory(trajectory, atMs) : null;
  }

  function nearestPovTarget(craftWorld) {
    let best = null;
    let bestDistance = Infinity;
    for (const body of povBodies) {
      if (!bodyVisibleWithMinorOption(body, display.minor, focusBodyId, frameBodyId, C.BODIES)) continue;
      const world = bodyAtDisplay(body.id);
      const distance = V.mag(V.sub(craftWorld, world));
      if (distance > 1e-6 && distance < bestDistance) {
        best = { body, world, distance };
        bestDistance = distance;
      }
    }
    return best;
  }

  function syncPovButton(state) {
    if (!dom.pov) return;
    const usable = !!state;
    const key = (usable ? "1" : "0") + "|" + (povActive ? "1" : "0") + "|" + (povTargetId || "");
    if (key === lastPovButtonKey) return;
    lastPovButtonKey = key;
    dom.pov.disabled = !usable;
    dom.pov.setAttribute("aria-disabled", usable ? "false" : "true");
    dom.pov.setAttribute("aria-pressed", povActive ? "true" : "false");
    if (dom.pov.classList) dom.pov.classList.toggle("active", povActive);
    const target = povTargetId && C.BODIES[povTargetId];
    dom.pov.setAttribute("aria-label", povActive && target
      ? "Exit spacecraft point of view toward " + target.name
      : "Enter selected spacecraft point of view");
    dom.pov.title = povActive && target
      ? "Exit POV toward " + target.name + " (V)" : "Selected spacecraft POV (V)";
  }

  function leavePov() {
    povActive = false;
    povTargetId = null;
    syncPovButton(selectedStateAt(simMs));
  }

  function updatePovCamera(atMs, suppliedState) {
    const state = suppliedState || selectedStateAt(atMs);
    if (!state) {
      if (povActive) { povActive = false; povTargetId = null; }
      syncPovButton(null);
      return false;
    }
    syncPovButton(state);
    if (!povActive) return false;
    prepareBodyProvider(atMs);
    const target = nearestPovTarget(state.r);
    const displayedCraft = pointForDisplay(state.r, atMs, atMs);
    const displayedTarget = target && pointForDisplay(target.world, atMs, atMs);
    const pose = target && povCameraPose(displayedCraft, displayedTarget);
    if (!target || !pose) {
      povActive = false;
      povTargetId = null;
      syncPovButton(state);
      return false;
    }
    povTargetId = target.body.id;
    camera.focusMode = "free";
    camera.freeFocus = pose.focus;
    camera.pan = [0, 0, 0];
    camera.yaw = pose.yaw;
    camera.pitch = pose.pitch;
    camera.dist = pose.dist;
    syncPovButton(state);
    return true;
  }

  function setPovActive(next) {
    if (!next) { leavePov(); return; }
    const state = selectedStateAt(simMs);
    if (!state) { leavePov(); return; }
    librationFocus = null;
    povActive = true;
    updatePovCamera(simMs, state);
  }

  function groundBodyChoice() {
    if (frameBodyId !== "inertial" && C.BODIES[frameBodyId]) {
      return { bodyId: frameBodyId, source: "frame" };
    }
    if (focusBodyId && focusBodyId !== "sun" && C.BODIES[focusBodyId]) {
      return { bodyId: focusBodyId, source: "focus" };
    }
    return { bodyId: null, source: focusBodyId === "sun" ? "sun" : "mission" };
  }

  function setGroundStatus(text, state) {
    if (!dom.groundStatus) return;
    dom.groundStatus.textContent = text;
    if (state) dom.groundStatus.dataset.state = state;
    else delete dom.groundStatus.dataset.state;
  }

  function clearGroundCanvas() {
    if (!dom.groundCanvas) return;
    const groundContext = dom.groundCanvas.getContext("2d");
    if (groundContext) groundContext.clearRect(0, 0, dom.groundCanvas.width, dom.groundCanvas.height);
  }

  function resizeGroundCanvas() {
    if (!dom.groundCanvas) return false;
    const rect = dom.groundCanvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width || dom.groundCanvas.clientWidth || 1));
    const height = Math.max(1, Math.round(rect.height || dom.groundCanvas.clientHeight || 1));
    /* MTPGroundTrack draws its fonts and line widths in canvas pixels. Keep
       those pixels equal to CSS pixels rather than silently shrinking the
       entire map UI on a high-DPI display. */
    const pixelWidth = width;
    const pixelHeight = height;
    if (dom.groundCanvas.width === pixelWidth && dom.groundCanvas.height === pixelHeight) return false;
    dom.groundCanvas.width = pixelWidth;
    dom.groundCanvas.height = pixelHeight;
    return true;
  }

  function invalidateGroundTrack() {
    lastGroundPerf = -Infinity;
  }

  function groundAdapterFor(trajectory, bodyId, atMs) {
    if (!trajectory || !Array.isArray(trajectory.samples) || !trajectory.samples.length) return null;
    if (!bodyId || !C.BODIES[bodyId]) return null;
    const window = localWindowFor(trajectory, bodyId, atMs);
    if (!window) return null;
    const windowKey = window.startMs + ":" + window.stopMs;
    if (groundAdapterCache.trajectory === trajectory && groundAdapterCache.bodyId === bodyId &&
        groundAdapterCache.windowKey === windowKey) {
      return groundAdapterCache.value;
    }
    const denseStates = boundedHermiteWindow(trajectory, window.startMs, window.stopMs,
      window.desiredStepMs, MAX_GROUND_SAMPLES, atMs);
    if (denseStates.length < 2) return null;
    const firstMs = denseStates[0].atMs;
    const lastMs = denseStates[denseStates.length - 1].atMs;
    const samples = [];
    let referenceExact = true;
    const alignedWorld = (r, atMs) => {
      const reference = referenceStateForBody(bodyId, atMs);
      if (!reference) {
        referenceExact = false;
        return r.slice();
      }
      const astroOrigin = Astro.bodyWorld(bodyId, 2440587.5 + atMs / DAY_MS);
      return V.add(V.sub(r, reference.r), astroOrigin);
    };
    const addState = (state) => {
      const r = state.r.slice();
      samples.push({
        t: (state.atMs - firstMs) / 1000,
        r,
        w: alignedWorld(r, state.atMs),
        v: state.v.slice(),
        cen: "sun",
      });
    };
    for (const state of denseStates) addState(state);
    const tEnd = (lastMs - firstMs) / 1000;
    const result = { samples, events: [], tEnd };
    const sampleAtTime = (_result, t) => {
      if (!Number.isFinite(t) || t < 0 || t > tEnd) return null;
      const atMs = firstMs + t * 1000;
      const state = stateAtTrajectory(trajectory, atMs);
      if (!state) return null;
      const reference = referenceStateForBody(bodyId, atMs);
      const w = reference
        ? V.add(V.sub(state.r, reference.r), Astro.bodyWorld(bodyId, 2440587.5 + atMs / DAY_MS))
        : state.r.slice();
      return { t, r: state.r.slice(), w, v: state.v.slice(), cen: "sun" };
    };
    const value = {
      result,
      firstMs,
      lastMs,
      epochJD: 2440587.5 + firstMs / DAY_MS,
      obsRanges: [[0, tEnd]],
      sampleAtTime,
      referenceExact,
      periodMs: window.periodMs,
      orbitCount: Number.isFinite(window.periodMs) ? (lastMs - firstMs) / window.periodMs : NaN,
    };
    groundAdapterCache = { trajectory, bodyId, windowKey, value };
    return value;
  }

  function formatKilometers(value) {
    if (!Number.isFinite(value)) return "-- km";
    if (Math.abs(value) >= 1000) return Math.round(value).toLocaleString("en-US") + " km";
    if (Math.abs(value) >= 100) return value.toFixed(0) + " km";
    return value.toFixed(1) + " km";
  }

  function updateGroundTrack(nowPerf, force) {
    /* tracker-shell.js owns the shared panel. Read its actual hidden state so
       opening Display (which closes Ground Track) cannot leave a stale local
       toggle that reverses the next click. */
    if (dom.groundPanel) groundOpen = !dom.groundPanel.hidden;
    if (!groundOpen || !dom.groundCanvas) return;
    if (!force && nowPerf - lastGroundPerf < GROUND_FRAME_MS) return;
    lastGroundPerf = nowPerf;
    resizeGroundCanvas();
    const groundTrack = globalThis.MTPGroundTrack;
    if (!groundTrack || typeof groundTrack.draw !== "function") {
      clearGroundCanvas();
      setGroundStatus("Ground-track renderer unavailable.", "unavailable");
      return;
    }
    if (!selectedId) {
      clearGroundCanvas();
      setGroundStatus("Select a mission to draw its ground track.", "waiting");
      return;
    }
    const trajectory = trajectoryById.get(selectedId);
    if (!trajectory) {
      clearGroundCanvas();
      setGroundStatus("The selected catalog entry has no bundled trajectory.", "unavailable");
      return;
    }
    const choice = groundBodyChoice();
    if (!choice.bodyId) {
      clearGroundCanvas();
      setGroundStatus("The Sun has no surface ground track. Choose a planet or moon in Focus or Frame.", "waiting");
      return;
    }
    const body = C.BODIES[choice.bodyId];
    const adapter = groundAdapterFor(trajectory, choice.bodyId, simMs);
    if (!body || !adapter) {
      clearGroundCanvas();
      setGroundStatus("Ground-track data are unavailable for this selection.", "unavailable");
      return;
    }
    const details = groundTrack.draw(dom.groundCanvas, {
      result: adapter.result,
      tNow: (simMs - adapter.firstMs) / 1000,
      epochJD: adapter.epochJD,
      bodyId: choice.bodyId,
      sampleAtTime: adapter.sampleAtTime,
      obsRanges: adapter.obsRanges,
      fullBright: Boolean(display.flat),
    });
    const sourceLabel = choice.source === "focus" ? "Focus body" : "Frame body";
    const referenceLabel = adapter.referenceExact ? "Horizons body reference" : "approximate built-in body reference";
    const selectedMission = missionById.get(selectedId);
    const windowLabel = isSurfaceMission(selectedMission) && selectedMission.surfaceBody === choice.bodyId
      ? "surface-site record; no orbital trail" : (Number.isFinite(adapter.orbitCount)
        ? adapter.orbitCount.toFixed(1) + " local orbits shown" : "bounded local window");
    if (details) {
      setGroundStatus(body.name + " / " + details.latDeg.toFixed(2) + " deg lat / " +
        details.lonDeg.toFixed(2) + " deg lon / " + formatKilometers(details.altKm) +
        " altitude / " + windowLabel + " / " + sourceLabel + " / " + referenceLabel +
        " / ephemeris, not telemetry", "ready");
    } else if (simMs < adapter.firstMs || simMs > adapter.lastMs) {
      setGroundStatus(body.name + " / Displayed UTC is outside the selected mission's bundle. " +
        "The bounded bundle track remains visible; no current point is extrapolated. / " + sourceLabel +
        " / " + referenceLabel, "outside");
    } else {
      setGroundStatus(body.name + " / No above-surface ground point at the displayed UTC. / " + sourceLabel +
        " / " + referenceLabel,
        "unavailable");
    }
  }

  function setGroundOpen(next) {
    groundOpen = !!next;
    if (dom.groundPanel) {
      dom.groundPanel.hidden = !groundOpen;
      dom.groundPanel.setAttribute("aria-hidden", groundOpen ? "false" : "true");
    }
    if (dom.ground) {
      dom.ground.setAttribute("aria-pressed", groundOpen ? "true" : "false");
      dom.ground.setAttribute("aria-expanded", groundOpen ? "true" : "false");
    }
    if (groundOpen) {
      invalidateGroundTrack();
      updateGroundTrack(performance.now(), true);
    }
  }

  function setFocusBody(id) {
    leavePov();
    librationFocus = null;
    if (!id) {
      if (selectedId && selectedPathType(selectedId) !== "none") fitSelected();
      else setFocusBody("sun");
      return;
    }
    const body = C.BODIES[id];
    if (!body || !viewBodies.includes(body)) return;
    focusBodyId = id;
    camera.focusMode = "body";
    camera.focusBody = id;
    camera.freeFocus = null;
    camera.pan = [0, 0, 0];
    camera.dist = clamp(body.radius * 4, currentZoomFloor(), 2000 * AU);
    pathFrameCache = { trajectory: null, alignmentKey: "", windowKey: "", points: [] };
    if (dom.focusBody && dom.focusBody.value !== id) dom.focusBody.value = id;
    invalidateGroundTrack();
  }

  function setCr3bpSystem(id) {
    const next = id === "sun-earth" ? "sun-earth" : "earth-moon";
    cr3bpSystemId = next;
    if (librationFocus) librationFocus.systemId = next;
    if (dom.cr3bpSystem && dom.cr3bpSystem.value !== next) dom.cr3bpSystem.value = next;
    lastScaleText = "";
  }

  function setFrameBody(id) {
    const next = id === "inertial" || id === "sun" ? "inertial" : id;
    if (next !== "inertial" && !isSynodicFrameId(next) &&
        (!C.BODIES[next] || !viewBodies.includes(C.BODIES[next]))) return;
    frameBodyId = next;
    const frameSystem = cr3bpSystemIdForFrame(next);
    if (frameSystem) setCr3bpSystem(frameSystem);
    pathFrameCache = { trajectory: null, alignmentKey: "", windowKey: "", points: [] };
    archiveFrameCache = { archive: null, alignmentKey: "", segments: [] };
    if (dom.frameBody && dom.frameBody.value !== next) dom.frameBody.value = next;
    invalidateGroundTrack();
  }

  function librationRecordAt(systemId, name, atMs) {
    if (!Render._test || typeof Render._test.librationPointRecords !== "function") return null;
    const jd = 2440587.5 + atMs / DAY_MS;
    const records = Render._test.librationPointRecords(systemId, jd, frameBodyId, deepBodyWorld);
    return records.find((record) => record.name === name) || null;
  }

  function setLibrationFocus(marker) {
    if (!marker || !marker.systemId || !marker.name || !finiteVector3(marker.world)) return;
    leavePov();
    focusBodyId = "";
    librationFocus = { systemId: marker.systemId, name: marker.name };
    camera.focusMode = "free";
    camera.freeFocus = marker.world.slice();
    camera.pan = [0, 0, 0];
    if (dom.focusBody) dom.focusBody.value = "";
    invalidateGroundTrack();
  }

  function updateLibrationFocus(atMs) {
    if (!librationFocus) return false;
    const marker = librationRecordAt(librationFocus.systemId, librationFocus.name, atMs);
    if (!marker) return false;
    camera.focusMode = "free";
    camera.freeFocus = marker.world.slice();
    return true;
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    view.width = width;
    view.height = height;
    view.dpr = dpr;
  }

  function deepScaleBarOptions() {
    if (!dom.scale || typeof dom.scale.getBoundingClientRect !== "function") {
      return { visible: true, anchor: null };
    }
    const style = typeof getComputedStyle === "function" ? getComputedStyle(dom.scale) : null;
    const readoutRect = dom.scale.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const visible = (!style || (style.display !== "none" && style.visibility !== "hidden")) &&
      readoutRect.width > 0 && readoutRect.height > 0;
    if (!visible) return { visible: false, anchor: null };
    return {
      visible: true,
      anchor: {
        x: readoutRect.right - canvasRect.left + 16,
        y: readoutRect.bottom - canvasRect.top - 1,
      },
    };
  }

  function resetView() {
    leavePov();
    librationFocus = null;
    camera.yaw = -0.7;
    camera.pitch = 0.42;
    camera.dist = 13 * AU;
    camera.fov = 50 * Math.PI / 180;
    camera.focusMode = "body";
    camera.focusBody = "sun";
    camera.freeFocus = null;
    camera.pan = [0, 0, 0];
    focusBodyId = "sun";
    frameBodyId = "inertial";
    pathFrameCache = { trajectory: null, alignmentKey: "", windowKey: "", points: [] };
    if (dom.focusBody) dom.focusBody.value = "sun";
    if (dom.frameBody) dom.frameBody.value = "inertial";
    invalidateGroundTrack();
  }

  function fitAll() {
    leavePov();
    librationFocus = null;
    let maxRadius = 5 * AU;
    for (const mission of visibleMissions) {
      const state = stateById.get(String(mission.horizonsId));
      if (state) maxRadius = Math.max(maxRadius, V.mag(state.r));
    }
    camera.focusMode = "body";
    camera.focusBody = "sun";
    camera.freeFocus = null;
    camera.pan = [0, 0, 0];
    camera.dist = clamp(maxRadius * 2.7, 4 * AU, 2000 * AU);
    focusBodyId = "sun";
    pathFrameCache = { trajectory: null, alignmentKey: "", windowKey: "", points: [] };
    if (dom.focusBody) dom.focusBody.value = "sun";
    invalidateGroundTrack();
  }

  function midpointState(trajectory) {
    if (!trajectory || !trajectory.samples || !trajectory.samples.length) return null;
    const atMs = (trajectory.samples[0][0] + trajectory.samples[trajectory.samples.length - 1][0]) / 2;
    return stateAtTrajectory(trajectory, atMs);
  }

  function fitSelected() {
    leavePov();
    librationFocus = null;
    const pathType = selectedPathType(selectedId);
    if (pathType === "history") {
      const archive = archiveById.get(selectedId);
      const frameOffset = currentAlignment(simMs).frameOffset;
      const points = [];
      for (const segment of frameArchiveSegmentsFor(archive, selectedId)) {
        for (const point of segment) points.push(displayPathPoint(point.r, frameOffset));
      }
      if (!points.length) return;
      const lo = points[0].slice();
      const hi = points[0].slice();
      for (const point of points) {
        for (let axis = 0; axis < 3; axis++) {
          lo[axis] = Math.min(lo[axis], point[axis]);
          hi[axis] = Math.max(hi[axis], point[axis]);
        }
      }
      const center = lo.map((value, axis) => (value + hi[axis]) / 2);
      let extent = 0;
      for (const point of points) extent = Math.max(extent, V.mag(V.sub(point, center)));
      camera.focusMode = "free";
      focusBodyId = "";
      camera.freeFocus = center;
      camera.pan = [0, 0, 0];
      if (dom.focusBody) dom.focusBody.value = "";
      camera.dist = clamp(selectedFitDistance(extent, frameBodyId, C.BODIES), currentZoomFloor(), 2000 * AU);
      invalidateGroundTrack();
      return;
    }
    const trajectory = selectedId ? trajectoryById.get(selectedId) : null;
    if (!trajectory) return;
    const mission = missionById.get(selectedId);
    if (isSurfaceMission(mission)) {
      setFocusBody(mission.surfaceBody);
      return;
    }
    const state = stateAtTrajectory(trajectory, simMs) || midpointState(trajectory);
    if (!state) return;
    camera.focusMode = "free";
    focusBodyId = "";
    pathFrameCache = { trajectory: null, alignmentKey: "", windowKey: "", points: [] };
    const center = pointForDisplay(state.r, state.atMs, simMs);
    if (!center) return;
    const frameOffset = currentAlignment(simMs).frameOffset;
    let extent = 0;
    for (const point of framePathFor(trajectory, simMs)) {
      const displayPoint = displayPathPoint(point.r, frameOffset);
      const dx = displayPoint[0] - center[0];
      const dy = displayPoint[1] - center[1];
      const dz = displayPoint[2] - center[2];
      extent = Math.max(extent, Math.hypot(dx, dy, dz));
    }
    camera.freeFocus = center;
    camera.pan = [0, 0, 0];
    if (dom.focusBody) dom.focusBody.value = "";
    camera.dist = clamp(selectedFitDistance(extent, frameBodyId, C.BODIES), currentZoomFloor(), 2000 * AU);
    invalidateGroundTrack();
  }

  function projectWorld(point, basis) {
    if (!basis) return null;
    const rel = V.sub(point, basis.center);
    const depth = V.dot(rel, basis.F) + camera.dist;
    const near = Math.max(1e-3, camera.dist * 1e-4);
    if (depth <= near) return null;
    return {
      x: view.width / 2 + basis.f * V.dot(rel, basis.Rt) / depth,
      y: view.height / 2 - basis.f * V.dot(rel, basis.Up) / depth,
      depth,
    };
  }

  /* ----------------------------- drawing ------------------------------- */
  function pointOccluded(point, basis, occluders) {
    return Boolean(point && basis && basis.eye &&
      typeof Astro.pointOccludedBySpheres === "function" &&
      Astro.pointOccludedBySpheres(point, basis.eye, occluders));
  }

  function projectedOccluders(basis, occluders) {
    if (!basis || !Array.isArray(occluders) || !occluders.length) return [];
    const disks = [];
    for (const sphere of occluders) {
      if (!sphere || !finiteVector3(sphere.center) || !(sphere.radius > 0)) continue;
      if (sphere.projected && Number.isFinite(sphere.projected.x) &&
          Number.isFinite(sphere.projected.y) && sphere.projected.r > 0) {
        disks.push({ x: sphere.projected.x, y: sphere.projected.y, radius: sphere.projected.r });
        continue;
      }
      const projected = projectWorld(sphere.center, basis);
      if (!projected || !(projected.depth > sphere.radius)) continue;
      const denominator = Math.sqrt(projected.depth * projected.depth - sphere.radius * sphere.radius);
      const radius = basis.f * sphere.radius / denominator;
      if (!(radius > 0) || !Number.isFinite(radius)) continue;
      disks.push({ x: projected.x, y: projected.y, radius });
    }
    return disks;
  }

  function segmentNearProjectedDisk(a, b, disks) {
    if (!a || !b || !disks.length) return false;
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const length2 = abx * abx + aby * aby;
    for (const disk of disks) {
      let u = length2 > 1e-9
        ? ((disk.x - a.x) * abx + (disk.y - a.y) * aby) / length2 : 0;
      u = clamp(u, 0, 1);
      const dx = a.x + abx * u - disk.x;
      const dy = a.y + aby * u - disk.y;
      const margin = disk.radius + 2;
      if (dx * dx + dy * dy <= margin * margin) return true;
    }
    return false;
  }

  function drawPath(points, basis, color, dashed, alpha, occluders, refinementBudget) {
    if (points.length < 2) return;
    const spheres = Array.isArray(occluders) ? occluders : [];
    const disks = projectedOccluders(basis, spheres);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = dashed ? 1.15 : 1.8;
    if (dashed) ctx.setLineDash([5, 6]);
    if (app.dataset.theme === "cinematic" && !dashed) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
    }
    ctx.beginPath();
    let pen = false;
    const emit = (point, projected) => {
      if (pointOccluded(point, basis, spheres)) {
        pen = false;
        return;
      }
      if (!projected || projected.x < -view.width * 2 || projected.x > view.width * 3 ||
          projected.y < -view.height * 2 || projected.y > view.height * 3) {
        pen = false;
        return;
      }
      if (!pen) { ctx.moveTo(projected.x, projected.y); pen = true; }
      else ctx.lineTo(projected.x, projected.y);
    };
    const refine = (a, projectedA, b, projectedB, depth) => {
      if (!segmentNearProjectedDisk(projectedA, projectedB, disks)) {
        emit(b, projectedB);
        return;
      }
      /* Never fall back to an unchecked chord when a very large apparent
       * planet consumes this frame's adaptive work allowance. Breaking the
       * pen is conservative: a later clear segment can safely reopen it. */
      if (!refinementBudget || refinementBudget.remaining <= 0) {
        pen = false;
        return;
      }
      refinementBudget.remaining--;
      const screenLength = projectedA && projectedB
        ? Math.hypot(projectedB.x - projectedA.x, projectedB.y - projectedA.y) : 0;
      /* A minimum refinement depth catches a hidden middle even when a sparse
       * 3-D chord projects to a very short screen segment. The pixel bound
       * keeps long POV chords from stepping visibly across a planetary limb. */
      if (depth >= 9 || (depth >= 3 && screenLength <= 2)) {
        emit(b, projectedB);
        return;
      }
      const middle = [
        (a[0] + b[0]) / 2,
        (a[1] + b[1]) / 2,
        (a[2] + b[2]) / 2,
      ];
      const projectedMiddle = projectWorld(middle, basis);
      refine(a, projectedA, middle, projectedMiddle, depth + 1);
      refine(middle, projectedMiddle, b, projectedB, depth + 1);
    };
    let previous = points[0];
    let projectedPrevious = projectWorld(previous, basis);
    emit(previous, projectedPrevious);
    for (let i = 1; i < points.length; i++) {
      const point = points[i];
      const projected = projectWorld(point, basis);
      refine(previous, projectedPrevious, point, projected, 0);
      previous = point;
      projectedPrevious = projected;
    }
    ctx.stroke();
    ctx.restore();
  }

  function framePathFor(trajectory, atMs) {
    const key = alignmentKey();
    const localFrameBody = frameBodyId !== "inertial" && !isSynodicFrameId(frameBodyId)
      ? frameBodyId : null;
    const localWindow = localFrameBody ? localWindowFor(trajectory, localFrameBody, atMs) : null;
    const windowKey = localWindow ? localWindow.startMs + ":" + localWindow.stopMs : "global";
    if (pathFrameCache.trajectory === trajectory && pathFrameCache.alignmentKey === key &&
        pathFrameCache.windowKey === windowKey) {
      return pathFrameCache.points;
    }
    const samples = trajectory && trajectory.samples || [];
    const points = [];
    const addState = (state) => {
      let r = state.r.slice();
      if (isSynodicFrameId(frameBodyId) && Render._test &&
          typeof Render._test.pointRelativeToDisplayFrame === "function") {
        r = Render._test.pointRelativeToDisplayFrame(r, frameBodyId,
          2440587.5 + state.atMs / DAY_MS, deepBodyWorld);
      } else if (frameBodyId !== "inertial") {
        r = V.sub(r, authoritativeBodyWorldAtMs(frameBodyId, state.atMs));
      }
      points.push({ t: state.atMs, r });
    };
    if (localWindow) {
      const denseStates = boundedHermiteWindow(trajectory, localWindow.startMs, localWindow.stopMs,
        localWindow.desiredStepMs, MAX_PATH_POINTS, atMs);
      for (const state of denseStates) addState(state);
    } else {
      const stride = Math.max(1, Math.ceil(samples.length / MAX_PATH_POINTS));
      const addSample = (sample) => addState({
        atMs: sample[0], r: sample.slice(1, 4), v: sample.slice(4, 7), trajectory,
      });
      for (let i = 0; i < samples.length; i += stride) addSample(samples[i]);
      if (samples.length && (!points.length || points[points.length - 1].t !== samples[samples.length - 1][0])) {
        addSample(samples[samples.length - 1]);
      }
    }
    pathFrameCache = { trajectory, alignmentKey: key, windowKey, points };
    return points;
  }

  function frameArchiveSegmentsFor(archive, id) {
    const key = alignmentKey();
    if (archiveFrameCache.archive === archive && archiveFrameCache.alignmentKey === key) {
      return archiveFrameCache.segments;
    }
    const sourceSegments = archiveSegmentsById.get(String(id)) ||
      archivePathSegments(archive, MAX_ARCHIVE_PATH_POINTS);
    const segments = sourceSegments.map((segment) => segment.map((point) => {
      let r = point.r.slice();
      if (isSynodicFrameId(frameBodyId) && Render._test &&
          typeof Render._test.pointRelativeToDisplayFrame === "function") {
        r = Render._test.pointRelativeToDisplayFrame(r, frameBodyId,
          2440587.5 + point.t / DAY_MS, deepBodyWorld);
      } else if (frameBodyId !== "inertial") {
        r = V.sub(r, authoritativeBodyWorldAtMs(frameBodyId, point.t));
      }
      return { t: point.t, r };
    }));
    archiveFrameCache = { archive, alignmentKey: key, segments };
    return segments;
  }

  function displayPathPoint(relativePoint, frameOffset) {
    return frameBodyId === "inertial" ? relativePoint : V.add(relativePoint, frameOffset);
  }

  function drawSelectedTrajectory(basis, atMs, palette, alignment, occluders) {
    const pathType = selectedPathType(selectedId);
    if (pathType === "surface") return;
    if (pathType === "history") {
      const archive = archiveById.get(selectedId);
      if (!archive) return;
      const mission = missionById.get(selectedId);
      const pathColor = mission ? palette[mission.group] : palette.trajectory;
      const refinementBudget = { remaining: 12000 };
      for (const segment of frameArchiveSegmentsFor(archive, selectedId)) {
        const displayed = segment.map((point) => displayPathPoint(point.r, alignment.frameOffset));
        drawPath(displayed, basis, pathColor, false,
          app.dataset.theme === "cinematic" ? 0.78 : 0.82, occluders, refinementBudget);
      }
      return;
    }
    const trajectory = selectedId ? trajectoryById.get(selectedId) : null;
    if (!trajectory || !trajectory.samples.length) return;
    const mission = missionById.get(selectedId);
    const pathColor = mission ? palette[mission.group] : palette.trajectory;
    const points = framePathFor(trajectory, atMs);
    const frameOffset = alignment.frameOffset;
    const past = [];
    const future = [];
    if (atMs <= points[0].t) {
      for (const point of points) future.push(displayPathPoint(point.r, frameOffset));
    } else if (atMs >= points[points.length - 1].t) {
      for (const point of points) past.push(displayPathPoint(point.r, frameOffset));
    } else {
      const current = stateAtTrajectory(trajectory, atMs);
      for (const point of points) {
        const displayPoint = displayPathPoint(point.r, frameOffset);
        if (point.t <= atMs) past.push(displayPoint);
        else future.push(displayPoint);
      }
      if (current) {
        const currentPoint = pointAtCurrentAlignment(current.r, atMs);
        if (currentPoint) {
          past.push(currentPoint);
          future.unshift(currentPoint);
        }
      }
    }
    const refinementBudget = { remaining: 12000 };
    drawPath(future, basis, pathColor, true, app.dataset.theme === "cinematic" ? 0.48 : 0.58,
      occluders, refinementBudget);
    drawPath(past, basis, pathColor, false, 0.92, occluders, refinementBudget);
  }

  function markerData(basis, atMs, alignment) {
    const markers = [];
    for (const mission of visibleMissions) {
      const id = String(mission.horizonsId);
      const trajectory = trajectoryById.get(id);
      const state = trajectory ? stateAtTrajectory(trajectory, atMs) : null;
      if (!state) continue;
      const point = pointAtCurrentAlignment(state.r, atMs);
      if (pointOccluded(point, basis, lastOccluders)) continue;
      const projected = point && projectWorld(point, basis);
      if (projected) markers.push({ id, mission, state, x: projected.x, y: projected.y, depth: projected.depth });
    }
    markers.sort((a, b) => b.depth - a.depth);
    return markers;
  }

  function drawMarker(marker, palette) {
    const selected = marker.id === selectedId;
    const hovered = marker.id === hoveredId;
    const cinematic = app.dataset.theme === "cinematic";
    const radius = selected ? 6 : (hovered ? 4.8 : 3.3);
    const color = palette[marker.mission.group];
    ctx.save();
    if (cinematic) {
      ctx.shadowColor = color;
      ctx.shadowBlur = selected || hovered ? 14 : 6;
    }
    ctx.beginPath();
    ctx.arc(marker.x, marker.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = cinematic ? "rgba(255,255,255,.9)" : "#fff";
    ctx.lineWidth = selected ? 1.8 : 0.9;
    ctx.stroke();

    if (display.labels && (selected || hovered)) {
      const label = marker.mission.name;
      ctx.font = cinematic ? "500 11px Archivo, sans-serif" : "600 10px Archivo, sans-serif";
      const textWidth = ctx.measureText(label).width;
      const left = clamp(marker.x + 10, 5, view.width - textWidth - 17);
      const top = clamp(marker.y - 20, 5, view.height - 23);
      ctx.fillStyle = cinematic ? "rgba(7,10,18,.9)" : "rgba(251,250,246,.95)";
      ctx.strokeStyle = selected ? color : (cinematic ? "rgba(255,255,255,.22)" : "rgba(28,29,32,.35)");
      ctx.lineWidth = 1;
      ctx.fillRect(left, top, textWidth + 12, 18);
      ctx.strokeRect(left, top, textWidth + 12, 18);
      ctx.fillStyle = cinematic ? "#f4f7fb" : "#1c1d20";
      ctx.fillText(label, left + 6, top + 12.5);
    }
    ctx.restore();
  }

  function draw(atMs) {
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    syncPalette();
    const out = {};
    const jd = 2440587.5 + atMs / DAY_MS;
    prepareBodyProvider(atMs);
    const alignment = currentAlignment(atMs);
    const selectedTrajectory = selectedId ? trajectoryById.get(selectedId) : null;
    const exactSelectedState = selectedTrajectory ? stateAtTrajectory(selectedTrajectory, atMs) : null;
    const librationUpdated = updateLibrationFocus(atMs);
    const povUpdated = updatePovCamera(atMs, exactSelectedState);
    if (!povUpdated && !librationUpdated && focusBodyId === "" && exactSelectedState) {
      camera.freeFocus = pointAtCurrentAlignment(exactSelectedState.r, atMs);
    }
    const scaleBar = deepScaleBarOptions();
    Render.draw(ctx, view.width, view.height, {
      camera,
      jd,
      epochJD: jd,
      result: null,
      tNow: 0,
      frameBody: frameBodyId,
      cr3bpSystem: cr3bpSystemId,
      shipSmp: null,
      bodyWorld: deepBodyWorld,
      bodyOrbitPath: deepBodyOrbitPath,
      options: { grid: display.grid, minor: display.minor, orbits: display.orbits, soi: display.soi,
        labels: display.labels, textures: display.textures, flatLight: display.flat,
        events: false, apsides: false, lagrange: display.lagrange,
        scaleBar: scaleBar.visible, scaleBarAnchor: scaleBar.anchor },
      out,
    });
    lastBasis = out.basis || null;
    lastOccluders = Array.isArray(out.occluders) ? out.occluders : [];
    screenBodies = out.bodies && typeof out.bodies === "object" ? out.bodies : {};
    screenLibrationPoints = Array.isArray(out.librationPoints) ? out.librationPoints : [];
    const palette = colors();
    if (display.paths) drawSelectedTrajectory(lastBasis, atMs, palette, alignment, lastOccluders);
    screenMarkers = display.markers ? markerData(lastBasis, atMs, alignment) : [];
    if (display.markers) {
      for (const marker of screenMarkers) {
        if (marker.x < -20 || marker.x > view.width + 20 || marker.y < -20 || marker.y > view.height + 20) continue;
        drawMarker(marker, palette);
      }
    }

    if (dom.scale) {
      const focusText = librationFocus
        ? librationFocus.name + " / " + (alignment.synodicSystem && alignment.synodicSystem.id === librationFocus.systemId
          ? alignment.synodicSystem.name : (globalThis.CR3BP ? globalThis.CR3BP.getSystem(librationFocus.systemId).name : "CR3BP"))
        : (camera.focusMode === "body" && C.BODIES[camera.focusBody]
          ? C.BODIES[camera.focusBody].name : (povActive && povTargetId
            ? "POV toward " + C.BODIES[povTargetId].name : "mission"));
      let frameText = frameBodyId === "inertial" ? "Sun / inertial" :
        (alignment.synodicSystem ? alignment.synodicSystem.name + " / synodic / ideal CR3BP" :
          C.BODIES[frameBodyId].name + " relative");
      if (alignment.synodicSystem) frameText += alignment.exact
        ? " / Horizons axes" : " / approximate axes";
      else if (alignment.bodyId) frameText += alignment.exact
        ? " / Horizons body reference" : " / approximate body reference";
      const scaleText = "Camera: " + formatCameraDistance(camera.dist) + " / focus " + focusText + " / " + frameText;
      if (scaleText !== lastScaleText) {
        lastScaleText = scaleText;
        dom.scale.textContent = scaleText;
      }
    }
  }

  /* --------------------------- detail card ----------------------------- */
  function safeWikipediaUrl(mission) {
    if (/^https:\/\/en\.wikipedia\.org\/wiki\/[^\s]+$/i.test(mission.wiki || "")) return mission.wiki;
    return "https://en.wikipedia.org/wiki/Special:Search?search=" + encodeURIComponent(mission.name);
  }

  function formatShortUtc(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return "unknown UTC";
    const iso = new Date(ms).toISOString();
    return iso.slice(0, 10) + " " + iso.slice(11, 16) + " UTC";
  }

  function formatDate(ms) {
    return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "unknown";
  }

  function formatAu(value) {
    if (!Number.isFinite(value)) return "--";
    if (value >= 100) return value.toFixed(0);
    if (value >= 10) return value.toFixed(1);
    if (value >= 1) return value.toFixed(2);
    return value.toFixed(3);
  }

  function formatCameraDistance(value) {
    if (value >= 0.01 * AU) return formatAu(value / AU) + " AU";
    const body = camera.focusMode === "body" ? C.BODIES[camera.focusBody] : null;
    const radii = body && Number.isFinite(body.radius) && body.radius > 0
      ? " (" + (value / body.radius).toFixed(2) + " " + body.name + " radii)" : "";
    return formatKilometers(value) + radii;
  }

  function formatCadence(seconds) {
    if (seconds >= 3600) return (seconds / 3600).toFixed(seconds % 3600 ? 1 : 0) + "-hour";
    return Math.round(seconds / 60) + "-minute";
  }

  function archiveCoverage(archive) {
    const samples = archive && Array.isArray(archive.samples) ? archive.samples : [];
    const startMs = Number.isFinite(archive && archive.startMs) ? archive.startMs :
      (samples.length && Number.isFinite(samples[0][0]) ? samples[0][0] : NaN);
    const stopMs = Number.isFinite(archive && archive.stopMs) ? archive.stopMs :
      (samples.length && Number.isFinite(samples[samples.length - 1][0])
        ? samples[samples.length - 1][0] : NaN);
    return { startMs, stopMs };
  }

  function selectMission(id, autoFit) {
    id = String(id);
    if (!missionById.has(id)) return;
    selectedId = id;
    if (!trajectoryById.has(id) && archiveById.has(id) && !display.history) {
      setHistoryEnabled(true);
    }
    for (const [rowId, entry] of rows) entry.row.setAttribute("aria-pressed", rowId === selectedId ? "true" : "false");
    syncRowTabStops(selectedId);
    const selectedRow = rows.get(selectedId);
    if (selectedRow) selectedRow.row.scrollIntoView({ block: "nearest" });
    updateSelectedCard(true);
    if (dom.card) dom.card.hidden = false;
    /* A body focus is an intentional close-view choice. Catalog selection
     * updates the mission without replacing that focus with an AU-scale track;
     * the explicit Fit selected track button may still switch to mission focus. */
    const preserveBodyFocus = camera.focusMode === "body" && focusBodyId && focusBodyId !== "sun";
    if (autoFit && selectedPathType(id) !== "none" && !preserveBodyFocus && !povActive) fitSelected();
    if (povActive) updatePovCamera(simMs);
    invalidateGroundTrack();
  }

  function clearSelection() {
    selectedId = null;
    leavePov();
    for (const entry of rows.values()) entry.row.setAttribute("aria-pressed", "false");
    syncRowTabStops(null);
    if (dom.card) dom.card.hidden = true;
    invalidateGroundTrack();
  }

  function ephemerisStatus(mission, trajectory, state) {
    if (state) {
      if (isSurfaceMission(mission)) return catalog.ephemerisStatusLabels.SURFACE;
      if (trajectory.trajectoryClass === "PREDICTED") return catalog.ephemerisStatusLabels.PREDICTED;
      if (trajectory.trajectoryClass === "ARCHIVE") return catalog.ephemerisStatusLabels.ARCHIVE;
      return catalog.ephemerisStatusLabels.CURRENT;
    }
    return trajectory ? "Outside bundled coverage" : catalog.ephemerisStatusLabels.CATALOG;
  }

  function updateSelectedCard(force, perfMs) {
    if (!selectedId || !dom.card) return;
    const nowPerf = Number.isFinite(perfMs) ? perfMs : performance.now();
    if (!force && nowPerf - lastCardPerf < 250) return;
    lastCardPerf = nowPerf;
    const mission = missionById.get(selectedId);
    const trajectory = trajectoryById.get(selectedId);
    const archive = archiveById.get(selectedId);
    const state = stateById.get(selectedId);
    const historyShown = selectedPathType(selectedId) === "history";
    if (!mission) return;

    if (dom.cardGroup) dom.cardGroup.textContent = mission.groupLabel;
    if (dom.cardTitle) dom.cardTitle.textContent = mission.name;
    if (dom.cardMeta) dom.cardMeta.textContent = mission.agency + " / " + mission.destination;
    if (dom.cardSummary) dom.cardSummary.textContent = mission.summary +
      (historyShown ? " A bounded historical mission path is shown; it is not a current spacecraft position." : "") +
      " Catalog inclusion and trajectory availability do not verify that the mission is currently operating.";
    if (dom.detailId) dom.detailId.textContent = mission.horizonsId;
    if (dom.detailDestination) dom.detailDestination.textContent = mission.destination;
    if (dom.detailCoverage) {
      const archiveRange = archiveCoverage(archive);
      dom.detailCoverage.textContent = historyShown && Number.isFinite(archiveRange.startMs) &&
        Number.isFinite(archiveRange.stopMs)
        ? "Historic: " + formatShortUtc(archiveRange.startMs) + " to " + formatShortUtc(archiveRange.stopMs)
        : (trajectory ? formatShortUtc(trajectory.startMs) + " to " + formatShortUtc(trajectory.stopMs)
          : "No current bundle");
    }
    if (dom.detailDistance) dom.detailDistance.textContent = state
      ? formatAu(V.mag(state.r) / AU) + " AU" : "--";
    if (dom.detailSpeed) dom.detailSpeed.textContent = state
      ? V.mag(state.v).toFixed(3) + " km/s" : "--";
    if (dom.detailStatus) dom.detailStatus.textContent = state
      ? ephemerisStatus(mission, trajectory, state) :
        (historyShown ? "Historical path only" : ephemerisStatus(mission, trajectory, state));
    if (dom.wiki) dom.wiki.href = safeWikipediaUrl(mission);
    if (dom.fitSelected) {
      dom.fitSelected.disabled = selectedPathType(selectedId) === "none";
      dom.fitSelected.textContent = isSurfaceMission(mission) ? "Focus surface site" : "Fit selected track";
    }

    if (dom.ephemerisNote) {
      if (historyShown && archive) {
        const range = archiveCoverage(archive);
        const currentNotice = state
          ? " The current marker and numeric readouts still come only from the current-window bundle."
          : " No current position or marker is inferred.";
        dom.ephemerisNote.textContent = "Historical Horizons path shown" +
          (Number.isFinite(range.startMs) && Number.isFinite(range.stopMs)
            ? " from " + formatDate(range.startMs) + " to " + formatDate(range.stopMs) : "") +
          ". It is a bounded display-only polyline" +
          (archive.cadenceLabel ? " at " + archive.cadenceLabel + " cadence" : "") +
          "; it is not interpolated into the live clock and is never extrapolated." + currentNotice +
          " Ephemeris data is not telemetry and does not verify operational status.";
      } else if (state) {
        if (isSurfaceMission(mission)) {
          dom.ephemerisNote.textContent = "Surface-site position is cubic-Hermite interpolation between " +
            formatCadence(trajectory.stepSeconds) + " bundled Horizons vectors. The marker is registered to the " +
            "IAU-oriented " + C.BODIES[mission.surfaceBody].name + " globe; an orbital path is not applicable. " +
            "Source JDTDB epochs are converted to UTC instants. Generated " +
            formatShortUtc(Date.parse(ephemeris.generatedAt)) + "; this is ephemeris data, not rover telemetry.";
        } else {
          const predictionNotice = trajectory.trajectoryClass === "PREDICTED"
            ? " The published source marks this trajectory predictive from " +
              String(trajectory.predictionStartDate || "an earlier mission epoch") + "."
            : "";
          dom.ephemerisNote.textContent = "Position is cubic-Hermite interpolation between " +
            formatCadence(trajectory.stepSeconds) + " bundled Horizons vectors. " +
            "Source JDTDB epochs are converted to UTC instants. Generated " +
            formatShortUtc(Date.parse(ephemeris.generatedAt)) + "; this is ephemeris/prediction data, not telemetry." +
            predictionNotice;
        }
      } else if (trajectory) {
        dom.ephemerisNote.textContent = "The displayed UTC is outside this mission's " +
          formatDate(trajectory.startMs) + " to " + formatDate(trajectory.stopMs) +
          " bundle. Its current marker is hidden and no extrapolation is performed.";
      } else if (archive) {
        dom.ephemerisNote.textContent = "A bounded historical Horizons path is available for this mission. " +
          "Enable Historic mission path (selected) in Display to show it. No current position is inferred.";
      } else {
        dom.ephemerisNote.textContent = "No current-window Horizons vector was available when this static bundle was generated. " +
          "This entry remains catalog metadata only; no position is inferred.";
      }
    }
  }

  /* ---------------------------- interaction ---------------------------- */
  let drag = null;

  function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function nearestMarker(point, radius) {
    let best = null;
    let bestD2 = radius * radius;
    for (const marker of screenMarkers) {
      const dx = marker.x - point.x;
      const dy = marker.y - point.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD2) { best = marker; bestD2 = d2; }
    }
    return best;
  }

  function nearestBody(point, radius) {
    return pickVisibleBody(screenBodies, point, radius, focusableBodyIds);
  }

  function nearestLibrationPoint(point, radius) {
    let best = null;
    let bestD2 = radius * radius;
    for (const marker of screenLibrationPoints) {
      const dx = marker.x - point.x;
      const dy = marker.y - point.y;
      const hitRadius = Math.max(radius, Number(marker.r) || 0);
      const d2 = dx * dx + dy * dy;
      if (d2 <= hitRadius * hitRadius && d2 <= bestD2) { best = marker; bestD2 = d2; }
    }
    return best;
  }

  let lastBodyPointerPick = null;
  let lastLibrationPointerPick = null;

  canvas.addEventListener("pointerdown", (event) => {
    leavePov();
    const point = canvasPoint(event);
    drag = { pointerId: event.pointerId, x: point.x, y: point.y, yaw: camera.yaw, pitch: camera.pitch, moved: false };
    if (canvas.setPointerCapture) canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener("pointermove", (event) => {
    const point = canvasPoint(event);
    if (drag && drag.pointerId === event.pointerId) {
      const dx = point.x - drag.x;
      const dy = point.y - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      camera.yaw = drag.yaw - dx * 0.006;
      camera.pitch = clamp(drag.pitch + dy * 0.006, -Math.PI * 0.49, Math.PI * 0.49);
      hoveredId = null;
      return;
    }
    const marker = nearestMarker(point, 10);
    const libration = marker ? null : nearestLibrationPoint(point, 12);
    const bodyId = marker || libration ? null : nearestBody(point, 12);
    hoveredId = marker ? marker.id : null;
    canvas.style.cursor = marker || libration || bodyId ? "pointer" : "grab";
  });

  canvas.addEventListener("pointerup", (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = canvasPoint(event);
    const moved = drag.moved;
    drag = null;
    if (canvas.hasPointerCapture && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (!moved) {
      /* Do not reinterpret the second click against the camera view produced
         by the first click; its dblclick event still belongs to that original
         visible body. */
      if (!isRecentBodyPointerPick(lastBodyPointerPick, point, event.timeStamp) &&
          !isRecentBodyPointerPick(lastLibrationPointerPick, point, event.timeStamp)) {
        const marker = nearestMarker(point, 12);
        if (marker) {
          lastBodyPointerPick = null;
          lastLibrationPointerPick = null;
          selectMission(marker.id, false);
        } else {
          const libration = nearestLibrationPoint(point, 12);
          if (libration) {
            lastBodyPointerPick = null;
            lastLibrationPointerPick = { marker: libration, x: point.x, y: point.y, at: event.timeStamp };
            setLibrationFocus(libration);
          } else {
            const bodyId = nearestBody(point, 12);
            lastLibrationPointerPick = null;
            if (bodyId) {
              lastBodyPointerPick = { id: bodyId, x: point.x, y: point.y, at: event.timeStamp };
              setFocusBody(bodyId);
            } else {
              lastBodyPointerPick = null;
            }
          }
        }
      }
    }
  });
  canvas.addEventListener("pointercancel", () => {
    drag = null; lastBodyPointerPick = null; lastLibrationPointerPick = null;
  });
  canvas.addEventListener("lostpointercapture", () => { drag = null; });
  canvas.addEventListener("pointerleave", () => { if (!drag) hoveredId = null; });
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    leavePov();
    camera.dist = clamp(camera.dist * Math.exp(event.deltaY * 0.0012), currentZoomFloor(), 2000 * AU);
  }, { passive: false });
  canvas.addEventListener("dblclick", (event) => {
    const point = canvasPoint(event);
    const retainedBodyId = isRecentBodyPointerPick(lastBodyPointerPick, point, event.timeStamp)
      ? lastBodyPointerPick.id : null;
    const retainedLibration = isRecentBodyPointerPick(lastLibrationPointerPick, point, event.timeStamp)
      ? lastLibrationPointerPick.marker : null;
    const marker = retainedBodyId || retainedLibration ? null : nearestMarker(point, 12);
    if (marker) {
      lastBodyPointerPick = null;
      lastLibrationPointerPick = null;
      selectMission(marker.id, false);
      fitSelected();
      return;
    }
    const libration = retainedLibration || nearestLibrationPoint(point, 12);
    if (libration) {
      lastBodyPointerPick = null;
      lastLibrationPointerPick = null;
      setLibrationFocus(libration);
      return;
    }
    let bodyId = retainedBodyId || nearestBody(point, 12);
    /* The first click of a double-click can immediately center and zoom the
       chosen body.  Preserve that exact visible pick for the ensuing dblclick
       event instead of interpreting its now-stale screen coordinate as empty. */
    lastBodyPointerPick = null;
    lastLibrationPointerPick = null;
    if (bodyId) {
      setFocusBody(bodyId);
      return;
    }
    if (selectedId && selectedPathType(selectedId) !== "none") fitSelected();
    else fitAll();
  });
  canvas.addEventListener("keydown", (event) => {
    if (event.key === "+" || event.key === "=") { leavePov(); camera.dist = clamp(camera.dist / 1.18, currentZoomFloor(), 2000 * AU); event.preventDefault(); }
    else if (event.key === "-") { leavePov(); camera.dist = clamp(camera.dist * 1.18, currentZoomFloor(), 2000 * AU); event.preventDefault(); }
    else if (event.key.toLowerCase() === "r") { resetView(); event.preventDefault(); }
    else if (event.key.toLowerCase() === "f") { if (selectedId && selectedPathType(selectedId) !== "none") fitSelected(); else fitAll(); event.preventDefault(); }
    else if (event.key.toLowerCase() === "v") { setPovActive(!povActive); event.preventDefault(); }
    else if (event.key === "Escape") { clearSelection(); event.preventDefault(); }
    else if (event.key === " ") { togglePlay(); event.preventDefault(); }
  });

  if (dom.search) dom.search.addEventListener("input", applyFilters);
  if (dom.group) dom.group.addEventListener("change", applyFilters);
  if (dom.cardClose) dom.cardClose.addEventListener("click", clearSelection);
  if (dom.fitSelected) dom.fitSelected.addEventListener("click", fitSelected);
  if (dom.fitAll) dom.fitAll.addEventListener("click", fitAll);
  if (dom.resetView) dom.resetView.addEventListener("click", resetView);
  if (dom.play) dom.play.addEventListener("click", togglePlay);
  if (dom.now) dom.now.addEventListener("click", returnToNow);
  if (dom.pov) dom.pov.addEventListener("click", () => setPovActive(!povActive));
  /* The unified tracker shell owns these buttons and its collision state.
     Retain a guarded fallback for a future standalone Deep shell only. */
  const sharedDisplay = globalThis.MTPTrackerDisplay;
  if (!sharedDisplay && dom.ground) dom.ground.addEventListener("click", () => setGroundOpen(!groundOpen));
  if (!sharedDisplay && dom.groundClose) dom.groundClose.addEventListener("click", () => setGroundOpen(false));
  if (dom.speed) dom.speed.addEventListener("change", () => {
    const now = currentClockMs(performance.now());
    const nextSpeed = Number(dom.speed.value);
    speed = Number.isFinite(nextSpeed) && nextSpeed > 0 ? nextSpeed : 1;
    reanchorClock(now);
    updateClockControls(true);
  });
  if (dom.catalogToggle) dom.catalogToggle.addEventListener("click", () => {
    const collapsed = app.classList.toggle("catalog-collapsed");
    dom.catalogToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    requestAnimationFrame(resizeCanvas);
  });
  window.addEventListener("resize", () => {
    resizeCanvas();
    if (groundOpen) { resizeGroundCanvas(); invalidateGroundTrack(); }
  });

  /* ------------------------------- boot -------------------------------- */
  populateViewControls();
  bindDisplayToggles();
  if (sharedDisplay) groundOpen = Boolean(dom.groundPanel && !dom.groundPanel.hidden);
  else setGroundOpen(false);
  buildList();
  applyFilters();
  resizeCanvas();
  resetView();
  updateStates(simMs, true);
  fitAll();
  updateClockControls(true);
  if (dom.transportNote) {
    const coverageStart = Date.parse(ephemeris.coverageStartUtc || "");
    const coverageStop = Date.parse(ephemeris.coverageStopUtc || "");
    dom.transportNote.textContent = "NASA/JPL Horizons release-generated vectors / " +
      formatShortUtc(coverageStart) + " to " + formatShortUtc(coverageStop) +
      " / source TDB converted to UTC / mission-aware 15 min-6 h cadence / cubic Hermite / no extrapolation / not telemetry";
  }
  if (globalThis.MTPTex && typeof globalThis.MTPTex.init === "function") globalThis.MTPTex.init();

  let lastPaintPerf = -Infinity;
  function frame(nowPerf) {
    const frameGap = drag ? 1000 / 60 : (playing ? 1000 / 30 : 1000 / 10);
    if (document.hidden) {
      requestAnimationFrame(frame);
      return;
    }
    currentClockMs(nowPerf);
    updateStates(simMs, false, nowPerf);
    updateClockControls(false);
    if (nowPerf - lastPaintPerf >= frameGap) {
      lastPaintPerf = nowPerf;
      draw(simMs);
    }
    updateGroundTrack(nowPerf, false);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  globalThis.MTPDeep = Object.freeze({
    catalog,
    ephemeris,
    stateAtTrajectory,
    fitAll,
    fitSelected,
    get displayedTimeMs() { return simMs; },
  });
})();
