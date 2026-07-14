/* =============================================================================
 * Mission Trajectory Planner — groundtrack.js
 * Ground-track / satellite-vision panel: equirectangular map of the current
 * central body with the body-fixed sub-satellite track, day/night terminator,
 * horizon-visibility footprint and event markers.
 *
 * Longitude/latitude use exactly the same body-frame construction as the
 * textured-globe renderer (axial tilt about world X + rotHours spin), so the
 * track lines up with the downloaded NASA texture used as the base map.
 * All styling comes from the active theme palette (MTPTheme.gt).
 * ========================================================================== */
"use strict";

(function () {
  const C = globalThis.AstroConst;
  const A = globalThis.Astro;
  const { BODIES, DAY } = C;
  const V = A.V;
  const TWO_PI = 2 * Math.PI;

  const GT_DEFAULT = {
    bg: "#0a0e18", grid: "rgba(150,160,190,0.16)", gridStrong: "rgba(150,160,190,0.38)",
    night: "rgba(1,3,9,0.55)",
    trackPast: "rgba(53,208,255,0.95)", trackFuture: "rgba(139,148,158,0.55)",
    foot: "rgba(88,166,255,0.85)", footFill: "rgba(88,166,255,0.10)",
    marker: "#ffffff", text: "rgba(205,213,230,0.85)", texAlpha: 0.9,
    swath: "rgba(255,106,61,0.95)", swathFill: "rgba(255,106,61,0.16)",
    station: "rgba(126,231,135,0.95)",
  };
  const EV_DEFAULT = {
    burn: "#f85149", soi_entry: "#d2a8ff", soi_exit: "#d2a8ff", flyby: "#d2a8ff",
    launch: "#7ee787", landing: "#7ee787", liftoff: "#7ee787",
    entry: "#e3b341", splashdown: "#e3b341", impact: "#ff5555", apsis: "#58a6ff",
  };

  /* body-fixed spherical coordinates of a world-frame direction at jd.
   * Matches textures.js spriteFor: axis = Z tilted by tiltDeg about world X;
   * spin from rotHours. Returns { lam (-π..π], phi } in the texture frame. */
  function bodyLatLon(body, nWorld, jd, spinOverride) {
    return A.bodyLatLon(body, nWorld, jd, spinOverride);
  }

  const uOf = (lam) => lam / TWO_PI + 0.5;        // 0..1 across the map
  const vOf = (phi) => 0.5 - phi / Math.PI;

  let _trk = { result: null, key: null, pts: [], evs: [] }; // per-(result,body) cache

  /** Equirectangular longitude is undefined at a pole. Besides ordinary
   * dateline wrapping, break large near-polar longitude swings instead of
   * drawing a false chord across most of the map. */
  function shouldBreakTrackSegment(a, b) {
    if (!a || !b || !Number.isFinite(a.u) || !Number.isFinite(a.v) ||
        !Number.isFinite(b.u) || !Number.isFinite(b.v)) return true;
    if (b.breakBefore) return true;
    if (a.rangeIndex !== undefined && b.rangeIndex !== undefined && a.rangeIndex !== b.rangeIndex) return true;
    if (a.segmentKey !== undefined && b.segmentKey !== undefined && a.segmentKey !== b.segmentKey) return true;
    if ((Number.isFinite(a.t) || Number.isFinite(b.t)) &&
        (!Number.isFinite(a.t) || !Number.isFinite(b.t) || b.t < a.t)) return true;
    const du = Math.abs(b.u - a.u);
    if (du > 0.5) return true;
    const polarA = Math.abs(0.5 - a.v) > 80 / 180;
    const polarB = Math.abs(0.5 - b.v) > 80 / 180;
    return polarA && polarB && du > 0.25;
  }

  /** Split a cached track at the exact continuously interpolated current
   * point. Without this bridge, a complete cached segment changes from future
   * to past in one frame while the marker moves smoothly through it. */
  function splitTrackPoints(pts, tNow, currentPoint) {
    let lo = 0, hi = pts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].t <= tNow) lo = mid + 1;
      else hi = mid;
    }
    if (!currentPoint || !Number.isFinite(currentPoint.u) || !Number.isFinite(currentPoint.v) ||
        !Number.isFinite(currentPoint.t)) {
      return { past: pts.slice(0, lo), future: pts.slice(Math.max(lo - 1, 0)), splitIndex: lo };
    }
    const exact = { ...currentPoint };
    const past = pts.slice(0, lo);
    if (past.length && Math.abs(past[past.length - 1].t - exact.t) < 1e-9) {
      exact.breakBefore = Boolean(past[past.length - 1].breakBefore);
      past[past.length - 1] = exact;
    }
    else past.push(exact);
    const future = pts.slice(lo);
    if (future.length && Math.abs(future[0].t - exact.t) < 1e-9) future[0] = exact;
    else future.unshift(exact);
    return { past, future, splitIndex: lo };
  }

  /** wrap-aware polyline: pts = [{u,v}] in 0..1; breaks on dateline jumps */
  function drawTrackLine(g, pts, W, H, start, end) {
    g.beginPath();
    let open = false;
    const i0 = start || 0, i1 = end === undefined ? pts.length : end;
    for (let i = i0; i < i1; i++) {
      const p = pts[i];
      if (!p || !Number.isFinite(p.u) || !Number.isFinite(p.v)) { open = false; continue; }
      if (i > i0 && shouldBreakTrackSegment(pts[i - 1], p)) open = false;
      if (!open) { g.moveTo(p.u * W, p.v * H); open = true; }
      else g.lineTo(p.u * W, p.v * H);
    }
    g.stroke();
  }

  /**
   * Render the panel.
   * st: { result, tNow, epochJD, bodyId, sampleAtTime }
   * Returns { latDeg, lonDeg, altKm } of the sub-satellite point (or null).
   */
  function draw(cv, st) {
    const g = cv.getContext("2d");
    const W = cv.width, H = cv.height;
    const pal = (globalThis.MTPTheme && globalThis.MTPTheme.gt) || GT_DEFAULT;
    const evPal = (globalThis.MTPTheme && globalThis.MTPTheme.events) || EV_DEFAULT;
    /* Live catalogs can use a different inertial convention than the mission
       planner. Optional body/spin/Sun providers keep this shared map exact
       without changing the Planner's existing defaults. */
    const body = st.body || BODIES[st.bodyId];
    const bodyWorldAt = typeof st.bodyWorldAt === "function" ? st.bodyWorldAt : A.bodyWorld;
    const latLon = (direction, atJd) => bodyLatLon(body, direction, atJd,
      typeof st.spinAt === "function" ? st.spinAt(atJd) : undefined);
    g.clearRect(0, 0, W, H);
    if (!body) return null;

    /* ---------------- base map: NASA texture or flat tone ---------------- */
    g.fillStyle = pal.bg;
    g.fillRect(0, 0, W, H);
    const tex = globalThis.MTPTex && globalThis.MTPTex.mapCanvas
      ? globalThis.MTPTex.mapCanvas(st.bodyId) : null;
    if (tex) {
      g.globalAlpha = pal.texAlpha;
      g.drawImage(tex, 0, 0, W, H);
      g.globalAlpha = 1;
    } else {
      g.globalAlpha = 0.25;
      g.fillStyle = body.color;
      g.fillRect(0, 0, W, H);
      g.globalAlpha = 1;
    }

    /* ------------------------- graticule + labels ------------------------ */
    g.lineWidth = 1;
    g.font = "9px 'JetBrains Mono', Consolas, monospace";
    for (let lon = -180; lon <= 180; lon += 30) {
      const x = (lon / 360 + 0.5) * W;
      g.strokeStyle = lon === 0 ? pal.gridStrong : pal.grid;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
      if (lon % 60 === 0 && lon > -180 && lon < 180) {
        g.fillStyle = pal.text;
        g.fillText((lon > 0 ? "+" : "") + lon, x + 2, H - 3);
      }
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const y = (0.5 - lat / 180) * H;
      g.strokeStyle = lat === 0 ? pal.gridStrong : pal.grid;
      g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
      if (lat !== 0) { g.fillStyle = pal.text; g.fillText((lat > 0 ? "+" : "") + lat, 2, y - 2); }
    }

    const jdNow = st.epochJD + st.tNow / DAY;

    /* ------------------- day/night terminator shading -------------------- */
    if (st.bodyId !== "sun" && !st.fullBright) {
      const bw = bodyWorldAt(st.bodyId, jdNow);
      const sunDir = typeof st.sunDirectionAt === "function"
        ? V.norm(st.sunDirectionAt(jdNow)) : V.norm(V.scale(bw, -1)); // body to Sun
      const ss = latLon(sunDir, jdNow);                     // subsolar point
      g.fillStyle = pal.night;
      if (Math.abs(ss.phi) < 0.01) {
        // near-equinox: terminator ≈ two meridians; night centered on antisolar
        const uA = uOf(ss.lam > 0 ? ss.lam - Math.PI : ss.lam + Math.PI);
        const x0 = (uA - 0.25) * W, wp = 0.5 * W;
        g.fillRect(x0, 0, wp, H);
        if (x0 < 0) g.fillRect(x0 + W, 0, -x0, H);
        if (x0 + wp > W) g.fillRect(0, 0, x0 + wp - W, H);
      } else {
        // terminator: tan(phi_t) = -cos(lam - lam_s) / tan(phi_s)
        g.beginPath();
        const N = 96;
        for (let i = 0; i <= N; i++) {
          const u = i / N;
          const lam = (u - 0.5) * TWO_PI;
          const phiT = Math.atan(-Math.cos(lam - ss.lam) / Math.tan(ss.phi));
          const y = vOf(phiT) * H;
          if (i === 0) g.moveTo(0, y); else g.lineTo(u * W, y);
        }
        // close around the night pole (opposite the subsolar hemisphere)
        const nightY = ss.phi > 0 ? H : 0;
        g.lineTo(W, nightY); g.lineTo(0, nightY);
        g.closePath();
        g.fill();
      }
    }

    /* --------------------------- the track ------------------------------- *
     * Cached per (mission result, body): only the past/future split moves
     * with tNow, so the trig work happens once, not 12× per second.        */
    const obsMode = !!(st.obsRanges && st.obsRanges.length);
    let currentRangeIndex = -1;
    if (obsMode) {
      for (let index = 0; index < st.obsRanges.length; index++) {
        const range = st.obsRanges[index];
        if (st.tNow >= range[0] && st.tNow <= range[1]) { currentRangeIndex = index; break; }
      }
    }
    const smp = st.sampleAtTime(st.result, st.tNow);
    let obsVec = null;
    if (obsMode && currentRangeIndex >= 0 && smp) {
      const direction = V.sub(smp.w, bodyWorldAt(st.bodyId, jdNow));
      if (V.mag(direction) > body.radius) obsVec = direction;
    }
    let currentGround = null;
    if ((smp && smp.cen === st.bodyId) || obsVec) {
      const vector = obsVec || smp.r;
      const radius = V.mag(vector);
      const ll = latLon(vector, jdNow);
      currentGround = {
        vector, radius, ll,
        point: {
          u: uOf(ll.lam), v: vOf(ll.phi), t: st.tNow,
          rangeIndex: obsMode ? currentRangeIndex : undefined,
          segmentKey: smp && smp.seg !== undefined ? smp.seg : undefined,
        },
      };
    }
    const obsKey = obsMode ? st.obsRanges.map((range) => range[0] + ":" + range[1]).join(",") : "";
    const ckey = st.bodyId + "|" + st.result.samples.length + "|" +
      st.result.tEnd + "|" + st.epochJD + (obsMode ? "|obs:" + obsKey : "");
    if (_trk.result !== st.result || _trk.key !== ckey) {
      const ss0 = st.result.samples;
      const pts = [];
      const stride = Math.max(1, Math.ceil(ss0.length / 2400));
      let breakNext = false;
      for (let i = 0; i < ss0.length; i += stride) {
        const s = ss0[i];
        if (obsMode) {
          // observation: sub-spacecraft point on the OBSERVED body, over
          // the observation window(s) — the ship can be in any frame.
          let rangeIndex = -1;
          for (let index = 0; index < st.obsRanges.length; index++) {
            const range = st.obsRanges[index];
            if (s.t >= range[0] && s.t <= range[1]) { rangeIndex = index; break; }
          }
          if (rangeIndex < 0) { breakNext = pts.length > 0; continue; }
          const jd2 = st.epochJD + s.t / DAY;
          const dir = V.sub(s.w, bodyWorldAt(st.bodyId, jd2));
          if (V.mag(dir) < body.radius) { breakNext = pts.length > 0; continue; }
          const ll = latLon(dir, jd2);
          pts.push({
            u: uOf(ll.lam), v: vOf(ll.phi), t: s.t, rangeIndex,
            segmentKey: s.seg !== undefined ? s.seg : undefined,
            breakBefore: breakNext,
          });
          breakNext = false;
          continue;
        }
        if (s.cen !== st.bodyId || V.mag(s.r) < body.radius * 0.999) {
          breakNext = pts.length > 0;
          continue;
        }
        const ll = latLon(s.r, st.epochJD + s.t / DAY);
        pts.push({
          u: uOf(ll.lam), v: vOf(ll.phi), t: s.t,
          segmentKey: s.seg !== undefined ? s.seg : undefined,
          breakBefore: breakNext,
        });
        breakNext = false;
      }
      const evs = [];
      for (const ev of st.result.events) {
        if (!((globalThis.MTPTheme && globalThis.MTPTheme.events) || EV_DEFAULT)[ev.kind]) continue;
        const smp = st.sampleAtTime(st.result, ev.t);
        if (!smp || smp.cen !== st.bodyId) continue;
        const ll = latLon(smp.r, st.epochJD + ev.t / DAY);
        evs.push({ u: uOf(ll.lam), v: vOf(ll.phi), kind: ev.kind });
      }
      _trk = { result: st.result, key: ckey, pts, evs };
    }
    // Both strokes meet the continuously interpolated spacecraft marker.
    const pts = _trk.pts;
    const split = splitTrackPoints(pts, st.tNow, currentGround && currentGround.point);
    if (split.future.length > 1) {
      g.strokeStyle = pal.trackFuture;
      g.lineWidth = 1.1;
      g.setLineDash([4, 4]);
      drawTrackLine(g, split.future, W, H);
      g.setLineDash([]);
    }
    if (split.past.length > 1) {
      g.strokeStyle = pal.trackPast;
      g.lineWidth = 1.6;
      drawTrackLine(g, split.past, W, H);
    }

    /* ------------------------- event markers (cached) -------------------- */
    for (const ev of _trk.evs) {
      const col = evPal[ev.kind];
      if (!col) continue;
      const x = ev.u * W, y = ev.v * H;
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(x, y - 3.5); g.lineTo(x + 3.5, y); g.lineTo(x, y + 3.5); g.lineTo(x - 3.5, y);
      g.closePath(); g.fill();
    }

    /* Optional fixed ground sites. Planner passes the DSN catalog only when
       the user enables it; live modes need not know about these controls. */
    if (Array.isArray(st.stations)) {
      g.font = "8px 'JetBrains Mono', Consolas, monospace";
      g.textBaseline = "middle";
      for (const station of st.stations) {
        if (!station || station.bodyId !== st.bodyId ||
            !Number.isFinite(station.latDeg) || !Number.isFinite(station.lonDeg)) continue;
        const x = uOf(station.lonDeg * Math.PI / 180) * W;
        const y = vOf(station.latDeg * Math.PI / 180) * H;
        g.strokeStyle = pal.station || GT_DEFAULT.station;
        g.fillStyle = pal.station || GT_DEFAULT.station;
        g.lineWidth = 1;
        g.beginPath(); g.arc(x, y, 3.5, 0, TWO_PI); g.stroke();
        g.beginPath(); g.arc(x, y, 1.2, 0, TWO_PI); g.fill();
        const label = station.complex || station.name || station.id || "SITE";
        g.fillText(String(label).slice(0, 10), x + 5, y);
      }
      g.textBaseline = "alphabetic";
    }

    /* --------------- current point + visibility footprint ---------------- */
    let out = null;
    if (currentGround) {
      const r = currentGround.radius;
      const ll = currentGround.ll;
      const x = uOf(ll.lam) * W, y = vOf(ll.phi) * H;

      /* Sensor cone / sphere intersection. It intentionally layers over the
         existing horizon footprint so the two answer different questions:
         visibility versus actual instrument coverage. */
      let sensorFootprint = null;
      if (st.sensor && globalThis.MissionAnalysis &&
          typeof globalThis.MissionAnalysis.sensorFootprint === "function" &&
          r > body.radius * 1.000001) {
        try {
          sensorFootprint = globalThis.MissionAnalysis.sensorFootprint({
            spacecraftPosition: currentGround.vector,
            bodyRadiusKm: body.radius,
            body,
            jd: jdNow,
            fovDeg: st.sensor.fovDeg,
            offNadirDeg: st.sensor.offNadirDeg,
            azimuthDeg: st.sensor.azimuthDeg || 0,
            boundarySamples: 96,
          });
          const boundary = sensorFootprint.boundary.map((point) => ({
            u: uOf(point.lonDeg * Math.PI / 180),
            v: vOf(point.latDeg * Math.PI / 180),
          })).filter((point) => Number.isFinite(point.u) && Number.isFinite(point.v));
          const wraps = boundary.some((point, index) => index > 0 &&
            Math.abs(point.u - boundary[index - 1].u) > 0.5);
          g.strokeStyle = pal.swath || GT_DEFAULT.swath;
          g.fillStyle = pal.swathFill || GT_DEFAULT.swathFill;
          g.lineWidth = 1.5;
          if (sensorFootprint.closed && boundary.length > 2 && !wraps) {
            g.beginPath();
            boundary.forEach((point, index) => index === 0
              ? g.moveTo(point.u * W, point.v * H)
              : g.lineTo(point.u * W, point.v * H));
            g.closePath(); g.fill(); g.stroke();
          } else if (boundary.length > 1) {
            drawTrackLine(g, boundary, W, H);
          }
        } catch (error) {
          sensorFootprint = { error: error.message, swathWidthKm: null, closed: false };
        }
      }

      if (r > body.radius * 1.0005) {
        // horizon-limited footprint: angular radius acos(R/r)
        const del = Math.acos(Math.min(1, body.radius / r));
        const pts = [];
        for (let k = 0; k <= 72; k++) {
          const th = (k / 72) * TWO_PI;
          const phi = Math.asin(Math.sin(ll.phi) * Math.cos(del) +
            Math.cos(ll.phi) * Math.sin(del) * Math.cos(th));
          const lam = ll.lam + Math.atan2(
            Math.sin(th) * Math.sin(del) * Math.cos(ll.phi),
            Math.cos(del) - Math.sin(ll.phi) * Math.sin(phi));
          const lamW = Math.atan2(Math.sin(lam), Math.cos(lam)); // wrap to (-π,π]
          pts.push({ u: uOf(lamW), v: vOf(phi) });
        }
        const wraps = pts.some((p, i) => i > 0 && Math.abs(p.u - pts[i - 1].u) > 0.5);
        g.strokeStyle = pal.foot;
        g.lineWidth = 1.2;
        if (!wraps) {
          g.beginPath();
          pts.forEach((p, i) => i === 0 ? g.moveTo(p.u * W, p.v * H) : g.lineTo(p.u * W, p.v * H));
          g.closePath();
          g.fillStyle = pal.footFill;
          g.fill();
          g.stroke();
        } else {
          drawTrackLine(g, pts, W, H);
        }
      }

      // sub-satellite marker: crosshair + dot
      g.strokeStyle = pal.marker;
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(x - 8, y); g.lineTo(x - 3, y); g.moveTo(x + 3, y); g.lineTo(x + 8, y);
      g.moveTo(x, y - 8); g.lineTo(x, y - 3); g.moveTo(x, y + 3); g.lineTo(x, y + 8);
      g.stroke();
      g.fillStyle = pal.marker;
      g.beginPath(); g.arc(x, y, 2.2, 0, TWO_PI); g.fill();

      out = {
        latDeg: ll.phi * 180 / Math.PI,
        lonDeg: ll.lam * 180 / Math.PI,
        altKm: r - body.radius,
        rangeKm: r,
        observing: obsMode,
        sensorSwathWidthKm: sensorFootprint && sensorFootprint.swathWidthKm,
        sensorClosed: sensorFootprint && sensorFootprint.closed,
        sensorError: sensorFootprint && sensorFootprint.error,
      };
    }
    return out;
  }

  globalThis.MTPGroundTrack = { draw, bodyLatLon, splitTrackPoints, shouldBreakTrackSegment };
})();
