/* =============================================================================
 * Mission Trajectory Planner - analysis.js
 * Dependency-free trajectory analysis helpers for the Data/Track panels.
 *
 * Includes:
 *  - osculating-element series extraction with bounded adaptive decimation
 *  - conical solar umbra / penumbra geometry and interval location
 *  - spherical-body ground-station access reports (DSN + user sites)
 *  - nadir and off-nadir sensor-cone / body-intersection footprints
 *  - first-order J2 secular rates and sun-synchronous inclination targeting
 *  - finite-burn duration and propellant estimates from the rocket equation
 *
 * Load after constants.js and kepler.js. Unless explicitly labeled otherwise,
 * units are km, s, radians, kg, newtons, and Julian days.
 * ========================================================================== */
"use strict";

(function () {
  const C = globalThis.AstroConst;
  const A = globalThis.Astro;
  if (!C || !A) throw new Error("analysis.js requires constants.js and kepler.js");

  const { BODIES, DAY, DEG } = C;
  const V = A.V;
  const TWO_PI = 2 * Math.PI;
  const RAD_TO_DEG = 1 / DEG;
  const EARTH_J2 = 1.08262668e-3;
  const EARTH_EQUATORIAL_RADIUS_KM = 6378.1363;
  const G0_M_S2 = 9.80665;
  const MAX_SERIES_POINTS = 20000;
  const MAX_OUTPUT_POINTS = 5000;
  const MAX_EVENT_GRID_POINTS = 200000;

  const DSN_STATIONS = Object.freeze([
    Object.freeze({ id: "dsn-goldstone-14", name: "Goldstone DSS-14",
      complex: "Goldstone", bodyId: "earth", latDeg: 35.4259,
      lonDeg: -116.8889, altKm: 1.001, elevationMaskDeg: 10 }),
    Object.freeze({ id: "dsn-canberra-43", name: "Canberra DSS-43",
      complex: "Canberra", bodyId: "earth", latDeg: -35.3985,
      lonDeg: 148.9819, altKm: 0.691, elevationMaskDeg: 10 }),
    Object.freeze({ id: "dsn-madrid-63", name: "Madrid DSS-63",
      complex: "Madrid", bodyId: "earth", latDeg: 40.4314,
      lonDeg: -4.2486, altKm: 0.731, elevationMaskDeg: 10 }),
  ]);

  const SERIES_COLUMNS = Object.freeze([
    "timeS", "jd", "aKm", "e", "iDeg", "raanDeg",
    "argPeriapsisDeg", "trueAnomalyDeg", "radiusKm", "altitudeKm",
    "speedKmS", "targetDistanceKm",
  ]);

  function firstDefined() {
    for (let i = 0; i < arguments.length; i++) {
      if (arguments[i] !== undefined && arguments[i] !== null) return arguments[i];
    }
    return undefined;
  }

  function finite(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${label} must be finite`);
    return number;
  }

  function positive(value, label) {
    const number = finite(value, label);
    if (!(number > 0)) throw new Error(`${label} must be greater than zero`);
    return number;
  }

  function nonnegative(value, label) {
    const number = finite(value, label);
    if (number < 0) throw new Error(`${label} must not be negative`);
    return number;
  }

  function clamp(value, lo, hi) { return Math.max(lo, Math.min(hi, value)); }

  function wrapRadians(value) {
    value %= TWO_PI;
    return value < 0 ? value + TWO_PI : value;
  }

  function wrapDegrees(value) {
    value %= 360;
    return value < 0 ? value + 360 : value;
  }

  function vector(value, label) {
    if (!value || value.length < 3) throw new Error(`${label} must be a 3-vector`);
    const out = [Number(value[0]), Number(value[1]), Number(value[2])];
    if (!out.every(Number.isFinite)) throw new Error(`${label} must contain finite values`);
    return out;
  }

  function sampleTime(sample, index) {
    if (Array.isArray(sample)) return finite(sample[0], `sample ${index} time`);
    return finite(firstDefined(sample && sample.t, sample && sample.timeS,
      sample && sample.time), `sample ${index} time`);
  }

  function samplePosition(sample, index) {
    if (Array.isArray(sample)) return vector(sample.slice(1, 4), `sample ${index} position`);
    return vector(firstDefined(sample && sample.r, sample && sample.position,
      sample && sample.spacecraft), `sample ${index} position`);
  }

  function sampleVelocity(sample, index) {
    if (Array.isArray(sample)) return vector(sample.slice(4, 7), `sample ${index} velocity`);
    return vector(firstDefined(sample && sample.v, sample && sample.velocity),
      `sample ${index} velocity`);
  }

  function normalizeStateSamples(samples, needVelocity) {
    if (!Array.isArray(samples) || samples.length < 1) {
      throw new Error("samples must be a non-empty array");
    }
    if (samples.length > MAX_SERIES_POINTS) {
      throw new Error(`samples exceeds the ${MAX_SERIES_POINTS}-point analysis limit`);
    }
    const out = samples.map((sample, index) => ({
      t: sampleTime(sample, index),
      r: samplePosition(sample, index),
      v: needVelocity ? sampleVelocity(sample, index) : null,
      jd: !Array.isArray(sample) && Number.isFinite(sample.jd) ? Number(sample.jd) : null,
      original: sample,
    }));
    for (let i = 1; i < out.length; i++) {
      if (!(out[i].t > out[i - 1].t)) {
        throw new Error("sample times must be strictly increasing");
      }
    }
    return out;
  }

  function stateInterpolator(samples) {
    const normalized = normalizeStateSamples(samples, false);
    return function (time) {
      time = finite(time, "state time");
      if (time < normalized[0].t || time > normalized[normalized.length - 1].t) return null;
      let lo = 0, hi = normalized.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (normalized[mid].t <= time) lo = mid; else hi = mid;
      }
      if (normalized[lo].t === time || lo === hi) return V.clone(normalized[lo].r);
      if (normalized[hi].t === time) return V.clone(normalized[hi].r);
      const u = (time - normalized[lo].t) / (normalized[hi].t - normalized[lo].t);
      return V.add(V.scale(normalized[lo].r, 1 - u), V.scale(normalized[hi].r, u));
    };
  }

  /* -------------------- element series and decimation -------------------- */

  function unwrapNear(value, previous) {
    while (value - previous > 180) value -= 360;
    while (value - previous < -180) value += 360;
    return value;
  }

  function decimationChannels(rows, userTolerances) {
    const floors = {
      aKm: 0.1, e: 1e-6, iDeg: 0.002, _raan: 0.01,
      _argPeriapsis: 0.01, _trueAnomaly: 0.02, altitudeKm: 0.1,
      speedKmS: 1e-5, targetDistanceKm: 0.1,
    };
    const aliases = {
      raanDeg: "_raan", argPeriapsisDeg: "_argPeriapsis",
      trueAnomalyDeg: "_trueAnomaly",
    };
    const keys = Object.keys(floors).filter((key) => rows.some((row) =>
      Number.isFinite(row[key])));
    return keys.map((key) => {
      const values = rows.map((row) => row[key]).filter(Number.isFinite);
      const range = values.length ? Math.max(...values) - Math.min(...values) : 0;
      const publicKey = Object.keys(aliases).find((name) => aliases[name] === key) || key;
      const supplied = userTolerances && firstDefined(userTolerances[publicKey],
        userTolerances[key]);
      const tolerance = supplied === undefined
        ? Math.max(floors[key], range * 0.001)
        : positive(supplied, `${publicKey} decimation tolerance`);
      return { key, tolerance };
    });
  }

  function spanCandidate(rows, from, to, channels) {
    if (to - from < 2) return null;
    const t0 = rows[from].timeS, t1 = rows[to].timeS;
    let bestIndex = -1, bestScore = -Infinity;
    for (let index = from + 1; index < to; index++) {
      const u = (rows[index].timeS - t0) / (t1 - t0);
      let score = 0;
      for (const channel of channels) {
        const a = rows[from][channel.key], b = rows[to][channel.key];
        const value = rows[index][channel.key];
        if (![a, b, value].every(Number.isFinite)) continue;
        const predicted = a + u * (b - a);
        score = Math.max(score, Math.abs(value - predicted) / channel.tolerance);
      }
      if (score > bestScore) { bestScore = score; bestIndex = index; }
    }
    return bestIndex < 0 ? null : { from, to, index: bestIndex, score: bestScore };
  }

  function heapPush(heap, item) {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent].score >= item.score) break;
      heap[i] = heap[parent]; i = parent;
    }
    heap[i] = item;
  }

  function heapPop(heap) {
    const root = heap[0], last = heap.pop();
    if (heap.length && last) {
      let i = 0;
      while (true) {
        let child = i * 2 + 1;
        if (child >= heap.length) break;
        if (child + 1 < heap.length && heap[child + 1].score > heap[child].score) child++;
        if (heap[child].score <= last.score) break;
        heap[i] = heap[child]; i = child;
      }
      heap[i] = last;
    }
    return root;
  }

  function adaptiveDecimateRows(rows, options) {
    options = options || {};
    if (!Array.isArray(rows) || rows.length <= 2) return rows ? rows.slice() : [];
    const maxPoints = options.maxPoints === undefined ? 1000 : Number(options.maxPoints);
    if (!Number.isInteger(maxPoints) || maxPoints < 2 || maxPoints > MAX_OUTPUT_POINTS) {
      throw new Error(`maxPoints must be an integer from 2 to ${MAX_OUTPUT_POINTS}`);
    }
    if (rows.length <= maxPoints) return rows.slice();
    const channels = decimationChannels(rows, options.tolerances);
    const selected = new Set([0, rows.length - 1]);
    const heap = [];
    const first = spanCandidate(rows, 0, rows.length - 1, channels);
    if (first) heapPush(heap, first);
    while (heap.length && selected.size < maxPoints) {
      const span = heapPop(heap);
      if (!(span.score > 1)) break;
      selected.add(span.index);
      const left = spanCandidate(rows, span.from, span.index, channels);
      const right = spanCandidate(rows, span.index, span.to, channels);
      if (left) heapPush(heap, left);
      if (right) heapPush(heap, right);
    }
    return Array.from(selected).sort((a, b) => a - b).map((index) => rows[index]);
  }

  function extractOsculatingSeries(options) {
    options = options || {};
    const mu = positive(options.mu, "gravitational parameter");
    const radiusKm = nonnegative(firstDefined(options.radiusKm,
      options.bodyRadiusKm, 0), "body radius");
    const samples = normalizeStateSamples(options.samples, true);
    const epochJD = options.epochJD === undefined ? null : finite(options.epochJD, "epoch JD");
    const targetAt = typeof options.targetPositionAt === "function"
      ? options.targetPositionAt
      : (options.targetPosition ? () => vector(options.targetPosition, "target position") : null);
    const rows = [];
    let lastRaan = null, lastArg = null, lastNu = null;
    for (let index = 0; index < samples.length; index++) {
      const sample = samples[index];
      const coe = A.rvToCoe(sample.r, sample.v, mu);
      if (![coe.a, coe.e, coe.i, coe.Om, coe.w, coe.nu].every(Number.isFinite)) {
        throw new Error(`sample ${index} does not define a valid osculating orbit`);
      }
      let raanDeg = coe.Om * RAD_TO_DEG;
      let argDeg = coe.w * RAD_TO_DEG;
      let nuDeg = wrapDegrees(coe.nu * RAD_TO_DEG);
      const unwrappedRaan = lastRaan === null ? raanDeg : unwrapNear(raanDeg, lastRaan);
      const unwrappedArg = lastArg === null ? argDeg : unwrapNear(argDeg, lastArg);
      const unwrappedNu = lastNu === null ? nuDeg : unwrapNear(nuDeg, lastNu);
      lastRaan = unwrappedRaan; lastArg = unwrappedArg; lastNu = unwrappedNu;
      const radius = V.mag(sample.r);
      const target = targetAt ? vector(targetAt(sample.t, sample.original),
        "target position") : null;
      rows.push({
        timeS: sample.t,
        jd: sample.jd === null && epochJD !== null ? epochJD + sample.t / DAY : sample.jd,
        aKm: coe.a,
        e: coe.e,
        iDeg: coe.i * RAD_TO_DEG,
        raanDeg: wrapDegrees(raanDeg),
        argPeriapsisDeg: wrapDegrees(argDeg),
        trueAnomalyDeg: nuDeg,
        radiusKm: radius,
        altitudeKm: radius - radiusKm,
        speedKmS: V.mag(sample.v),
        targetDistanceKm: target ? V.mag(V.sub(sample.r, target)) : null,
        sourceIndex: index,
        _raan: unwrappedRaan,
        _argPeriapsis: unwrappedArg,
        _trueAnomaly: unwrappedNu,
      });
    }
    const kept = options.decimate === false ? rows : adaptiveDecimateRows(rows, {
      maxPoints: options.maxPoints,
      tolerances: options.tolerances,
    });
    const publicRows = kept.map((row) => {
      const copy = { ...row };
      delete copy._raan; delete copy._argPeriapsis; delete copy._trueAnomaly;
      return Object.freeze(copy);
    });
    const csvRows = [Array.from(SERIES_COLUMNS)].concat(publicRows.map((row) =>
      SERIES_COLUMNS.map((column) => row[column])));
    return Object.freeze({
      sourceCount: rows.length,
      outputCount: publicRows.length,
      decimated: publicRows.length < rows.length,
      columns: SERIES_COLUMNS,
      rows: Object.freeze(publicRows),
      csvRows: Object.freeze(csvRows.map(Object.freeze)),
    });
  }

  function csvEscape(value) {
    if (value === null || value === undefined) return "";
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function rowsToCSV(columns, rows) {
    if (!Array.isArray(columns) || !Array.isArray(rows)) {
      throw new Error("columns and rows must be arrays");
    }
    const lines = [columns.map(csvEscape).join(",")];
    for (const row of rows) {
      const values = Array.isArray(row) ? row : columns.map((column) => row[column]);
      lines.push(values.map(csvEscape).join(","));
    }
    return lines.join("\r\n");
  }

  /* ------------------------- eclipse geometry ------------------------- */

  function circleOverlapFraction(sourceRadius, occulterRadius, separation) {
    if (separation >= sourceRadius + occulterRadius) return 0;
    if (occulterRadius >= sourceRadius + separation) return 1;
    if (sourceRadius >= occulterRadius + separation) {
      return (occulterRadius * occulterRadius) / (sourceRadius * sourceRadius);
    }
    const d = Math.max(separation, 1e-15);
    const x = clamp((d * d + sourceRadius * sourceRadius - occulterRadius * occulterRadius) /
      (2 * d * sourceRadius), -1, 1);
    const y = clamp((d * d + occulterRadius * occulterRadius - sourceRadius * sourceRadius) /
      (2 * d * occulterRadius), -1, 1);
    const area = sourceRadius * sourceRadius * Math.acos(x) +
      occulterRadius * occulterRadius * Math.acos(y) -
      0.5 * Math.sqrt(Math.max(0, (-d + sourceRadius + occulterRadius) *
        (d + sourceRadius - occulterRadius) *
        (d - sourceRadius + occulterRadius) *
        (d + sourceRadius + occulterRadius)));
    return clamp(area / (Math.PI * sourceRadius * sourceRadius), 0, 1);
  }

  function shadowGeometry(options) {
    options = options || {};
    const spacecraft = vector(firstDefined(options.spacecraftPosition,
      options.spacecraft, options.r), "spacecraft position");
    const light = vector(firstDefined(options.lightPosition, options.light),
      "light position");
    const occulter = vector(firstDefined(options.occulterPosition,
      options.occulter), "occulter position");
    const lightRadiusKm = positive(firstDefined(options.lightRadiusKm,
      options.lightRadius), "light-source radius");
    const occulterRadiusKm = positive(firstDefined(options.occulterRadiusKm,
      options.occulterRadius), "occulter radius");
    const toLight = V.sub(light, spacecraft), toOcculter = V.sub(occulter, spacecraft);
    const lightDistanceKm = V.mag(toLight), occulterDistanceKm = V.mag(toOcculter);
    if (!(lightDistanceKm > lightRadiusKm)) {
      throw new Error("spacecraft must be outside the light source");
    }
    if (!(occulterDistanceKm > occulterRadiusKm)) {
      throw new Error("spacecraft must be outside the occulting body");
    }
    const lightAngularRadius = Math.asin(clamp(lightRadiusKm / lightDistanceKm, 0, 1));
    const occulterAngularRadius = Math.asin(clamp(occulterRadiusKm / occulterDistanceKm, 0, 1));
    const separation = Math.acos(clamp(V.dot(toLight, toOcculter) /
      (lightDistanceKm * occulterDistanceKm), -1, 1));
    const foreground = occulterDistanceKm < lightDistanceKm;
    const rawPenumbraMargin = lightAngularRadius + occulterAngularRadius - separation;
    const rawUmbraMargin = occulterAngularRadius - lightAngularRadius - separation;
    const penumbraMargin = foreground ? rawPenumbraMargin : -Math.abs(rawPenumbraMargin);
    const umbraMargin = foreground ? rawUmbraMargin : -Math.abs(rawUmbraMargin);
    let phase = "sunlight";
    if (penumbraMargin > 0) phase = umbraMargin >= 0 ? "umbra" : "penumbra";
    const annular = phase === "penumbra" &&
      lightAngularRadius > occulterAngularRadius + separation;
    return Object.freeze({
      phase,
      annular,
      foreground,
      obscuration: foreground ? circleOverlapFraction(lightAngularRadius,
        occulterAngularRadius, separation) : 0,
      lightAngularRadiusRad: lightAngularRadius,
      occulterAngularRadiusRad: occulterAngularRadius,
      separationRad: separation,
      penumbraMarginRad: penumbraMargin,
      umbraMarginRad: umbraMargin,
      lightDistanceKm,
      occulterDistanceKm,
    });
  }

  function uniformTimes(start, end, step) {
    start = finite(start, "start time"); end = finite(end, "end time");
    step = positive(step, "analysis step");
    if (!(end > start)) throw new Error("end time must be after start time");
    const count = Math.ceil((end - start) / step);
    if (count + 1 > MAX_EVENT_GRID_POINTS) {
      throw new Error(`event grid exceeds ${MAX_EVENT_GRID_POINTS} points`);
    }
    const times = [];
    for (let i = 0; i <= count; i++) times.push(i === count ? end : start + i * step);
    return times;
  }

  function refineRoot(fn, a, b, fa, fb, tolerance) {
    if (fa === 0) return a;
    if (fb === 0) return b;
    for (let i = 0; i < 80 && b - a > tolerance; i++) {
      const middle = 0.5 * (a + b), fm = fn(middle);
      if (!Number.isFinite(fm)) throw new Error("event function returned a non-finite value");
      if ((fa >= 0) === (fm >= 0)) { a = middle; fa = fm; }
      else { b = middle; fb = fm; }
    }
    return 0.5 * (a + b);
  }

  function positiveIntervals(times, fn, tolerance) {
    const intervals = [];
    let previousTime = times[0], previousValue = fn(previousTime);
    if (!Number.isFinite(previousValue)) throw new Error("event function returned a non-finite value");
    let start = previousValue >= 0 ? previousTime : null;
    for (let i = 1; i < times.length; i++) {
      const time = times[i], value = fn(time);
      if (!Number.isFinite(value)) throw new Error("event function returned a non-finite value");
      if (previousValue < 0 && value >= 0) {
        start = refineRoot(fn, previousTime, time, previousValue, value, tolerance);
      } else if (previousValue >= 0 && value < 0 && start !== null) {
        const end = refineRoot(fn, previousTime, time, previousValue, value, tolerance);
        if (end > start) intervals.push([start, end]);
        start = null;
      }
      previousTime = time; previousValue = value;
    }
    if (start !== null && times[times.length - 1] > start) {
      intervals.push([start, times[times.length - 1]]);
    }
    return intervals;
  }

  function intervalRecord(type, pair, epochJD) {
    const record = {
      type,
      startTimeS: pair[0],
      endTimeS: pair[1],
      durationS: pair[1] - pair[0],
    };
    if (epochJD !== null) {
      record.startJD = epochJD + pair[0] / DAY;
      record.endJD = epochJD + pair[1] / DAY;
    }
    return Object.freeze(record);
  }

  function resolvePosition(source, time, label) {
    const value = typeof source === "function" ? source(time) : source;
    if (value && !Array.isArray(value)) {
      return vector(firstDefined(value.r, value.position, value.spacecraft), label);
    }
    return vector(value, label);
  }

  function eclipseIntervals(options) {
    options = options || {};
    let spacecraftAt = options.spacecraftPositionAt || options.stateAt;
    let sampleTimes = null;
    if (!spacecraftAt && options.samples) {
      const normalized = normalizeStateSamples(options.samples, false);
      spacecraftAt = stateInterpolator(options.samples);
      sampleTimes = normalized.map((sample) => sample.t);
    }
    if (typeof spacecraftAt !== "function") {
      throw new Error("eclipse analysis needs stateAt, spacecraftPositionAt, or samples");
    }
    const lightSource = firstDefined(options.lightPositionAt, options.lightPosition);
    const occulterSource = firstDefined(options.occulterPositionAt, options.occulterPosition);
    if (!lightSource || !occulterSource) {
      throw new Error("eclipse analysis needs light and occulter positions");
    }
    const lightRadiusKm = positive(firstDefined(options.lightRadiusKm,
      options.lightRadius), "light-source radius");
    const occulterRadiusKm = positive(firstDefined(options.occulterRadiusKm,
      options.occulterRadius), "occulter radius");
    let times;
    if (options.stepS !== undefined || !sampleTimes) {
      const start = finite(firstDefined(options.startTimeS, options.startS,
        sampleTimes && sampleTimes[0]), "start time");
      const end = finite(firstDefined(options.endTimeS, options.endS,
        sampleTimes && sampleTimes[sampleTimes.length - 1]), "end time");
      times = uniformTimes(start, end, firstDefined(options.stepS, (end - start) / 500));
    } else {
      times = sampleTimes;
    }
    const timeToleranceS = positive(firstDefined(options.timeToleranceS, 0.05),
      "event time tolerance");
    const geometryAt = (time) => shadowGeometry({
      spacecraftPosition: resolvePosition(spacecraftAt, time, "spacecraft position"),
      lightPosition: resolvePosition(lightSource, time, "light position"),
      occulterPosition: resolvePosition(occulterSource, time, "occulter position"),
      lightRadiusKm,
      occulterRadiusKm,
    });
    const penumbraPairs = positiveIntervals(times,
      (time) => geometryAt(time).penumbraMarginRad, timeToleranceS);
    const umbraPairs = positiveIntervals(times,
      (time) => geometryAt(time).umbraMarginRad, timeToleranceS);
    const boundaries = Array.from(new Set([times[0], times[times.length - 1]]
      .concat(...penumbraPairs, ...umbraPairs))).sort((a, b) => a - b);
    const phasePairs = [];
    for (let i = 1; i < boundaries.length; i++) {
      const pair = [boundaries[i - 1], boundaries[i]];
      if (!(pair[1] > pair[0])) continue;
      const phase = geometryAt(0.5 * (pair[0] + pair[1])).phase;
      if (phase === "umbra" || phase === "penumbra") phasePairs.push({ phase, pair });
    }
    const epochJD = options.epochJD === undefined ? null : finite(options.epochJD, "epoch JD");
    const penumbra = penumbraPairs.map((pair) => intervalRecord("penumbra", pair, epochJD));
    const umbra = umbraPairs.map((pair) => intervalRecord("umbra", pair, epochJD));
    const phases = phasePairs.map((item) => intervalRecord(item.phase, item.pair, epochJD));
    const sum = (items) => items.reduce((total, item) => total + item.durationS, 0);
    const partial = phases.filter((item) => item.type === "penumbra");
    return Object.freeze({
      penumbra: Object.freeze(penumbra),
      umbra: Object.freeze(umbra),
      phases: Object.freeze(phases),
      totals: Object.freeze({
        penumbraEnvelopeS: sum(penumbra),
        umbraS: sum(umbra),
        partialPenumbraS: sum(partial),
      }),
    });
  }

  /* ----------------------- ground-station access ----------------------- */

  function normalizeStation(station, index, defaults) {
    station = station || {};
    const bodyId = String(firstDefined(station.bodyId, defaults.bodyId, "earth")).toLowerCase();
    const body = BODIES[bodyId];
    if (!body || !(body.radius > 0)) throw new Error(`station ${index} has an unknown body`);
    const latDeg = finite(firstDefined(station.latDeg, station.latitudeDeg,
      station.latitude), `station ${index} latitude`);
    if (latDeg < -90 || latDeg > 90) throw new Error(`station ${index} latitude is out of range`);
    const rawLon = finite(firstDefined(station.lonDeg, station.longitudeDeg,
      station.longitude), `station ${index} longitude`);
    const lonDeg = ((rawLon + 180) % 360 + 360) % 360 - 180;
    const altKm = finite(firstDefined(station.altKm, station.altitudeKm, 0),
      `station ${index} altitude`);
    if (!(body.radius + altKm > 0)) throw new Error(`station ${index} altitude is below body center`);
    const elevationMaskDeg = finite(firstDefined(station.elevationMaskDeg,
      station.maskDeg, defaults.elevationMaskDeg, 0), `station ${index} elevation mask`);
    if (elevationMaskDeg < 0 || elevationMaskDeg >= 90) {
      throw new Error(`station ${index} elevation mask must be in [0, 90)`);
    }
    return Object.freeze({
      id: String(station.id || `user-station-${index + 1}`),
      name: String(station.name || station.id || `User station ${index + 1}`),
      complex: station.complex ? String(station.complex) : null,
      bodyId, latDeg, lonDeg, altKm, elevationMaskDeg,
    });
  }

  function stationPosition(station, jd, spinOverride) {
    const normalized = normalizeStation(station, 0, {});
    const body = BODIES[normalized.bodyId];
    jd = finite(jd, "station Julian date");
    const up = A.bodyDirection(body, normalized.latDeg * DEG,
      normalized.lonDeg * DEG, jd, spinOverride);
    if (!up) throw new Error("body-fixed station transform failed");
    return Object.freeze({
      r: V.scale(up, body.radius + normalized.altKm),
      up: V.clone(up),
      bodyId: normalized.bodyId,
      jd,
    });
  }

  function accessGeometry(spacecraftPosition, station, jd, spinOverride) {
    const spacecraft = vector(spacecraftPosition, "spacecraft position");
    const site = stationPosition(station, jd, spinOverride);
    const line = V.sub(spacecraft, site.r), rangeKm = V.mag(line);
    if (!(rangeKm > 0)) return Object.freeze({ elevationDeg: 90, rangeKm: 0,
      visible: true, stationPosition: site.r });
    const elevationDeg = Math.asin(clamp(V.dot(V.scale(line, 1 / rangeKm),
      site.up), -1, 1)) * RAD_TO_DEG;
    const mask = firstDefined(station.elevationMaskDeg, station.maskDeg, 0);
    const bodyRadius = BODIES[site.bodyId].radius;
    const a = V.dot(line, line), b = 2 * V.dot(site.r, line);
    const c = V.dot(site.r, site.r) - bodyRadius * bodyRadius;
    const discriminant = b * b - 4 * a * c;
    let occluded = false;
    if (discriminant >= 0 && a > 0) {
      const root = Math.sqrt(Math.max(0, discriminant));
      const t1 = (-b - root) / (2 * a), t2 = (-b + root) / (2 * a);
      const epsilon = 1e-10;
      occluded = (t1 > epsilon && t1 < 1 - epsilon) ||
        (t2 > epsilon && t2 < 1 - epsilon);
    }
    return Object.freeze({
      elevationDeg,
      rangeKm,
      occluded,
      visible: !occluded && elevationDeg >= mask,
      stationPosition: site.r,
    });
  }

  function maximizeElevation(fn, start, end) {
    if (!(end > start)) return { time: start, value: fn(start) };
    const divisions = 24;
    let bestIndex = 0, bestValue = -Infinity;
    const values = [];
    for (let i = 0; i <= divisions; i++) {
      const time = start + (end - start) * i / divisions;
      const value = fn(time); values.push({ time, value });
      if (value > bestValue) { bestValue = value; bestIndex = i; }
    }
    let a = values[Math.max(0, bestIndex - 1)].time;
    let b = values[Math.min(divisions, bestIndex + 1)].time;
    const ratio = (Math.sqrt(5) - 1) / 2;
    let c = b - ratio * (b - a), d = a + ratio * (b - a);
    let fc = fn(c), fd = fn(d);
    for (let i = 0; i < 60 && b - a > 1e-4; i++) {
      if (fc > fd) { b = d; d = c; fd = fc; c = b - ratio * (b - a); fc = fn(c); }
      else { a = c; c = d; fc = fd; d = a + ratio * (b - a); fd = fn(d); }
    }
    const time = fc > fd ? c : d;
    const value = Math.max(bestValue, fc, fd);
    if (bestValue >= value) return values[bestIndex];
    return { time, value };
  }

  function groundStationAccess(options) {
    options = options || {};
    let spacecraftAt = options.spacecraftPositionAt || options.stateAt;
    let sampleTimes = null;
    if (!spacecraftAt && options.samples) {
      const normalized = normalizeStateSamples(options.samples, false);
      spacecraftAt = stateInterpolator(options.samples);
      sampleTimes = normalized.map((sample) => sample.t);
    }
    if (typeof spacecraftAt !== "function") {
      throw new Error("access analysis needs stateAt, spacecraftPositionAt, or samples");
    }
    const bodyId = String(firstDefined(options.bodyId, "earth")).toLowerCase();
    if (!BODIES[bodyId]) throw new Error(`unknown access body ${bodyId}`);
    let stationInputs = options.stations === undefined ? Array.from(DSN_STATIONS) : options.stations;
    if (!Array.isArray(stationInputs)) throw new Error("stations must be an array");
    if (Array.isArray(options.userStations)) stationInputs = stationInputs.concat(options.userStations);
    const stations = stationInputs.map((station, index) => normalizeStation(station, index, {
      bodyId,
      elevationMaskDeg: options.elevationMaskDeg,
    })).filter((station) => station.bodyId === bodyId);
    if (!stations.length) return Object.freeze({ stations: Object.freeze([]),
      intervals: Object.freeze([]) });
    const epochJD = finite(firstDefined(options.epochJD, C.J2000_JD), "epoch JD");
    const jdAt = typeof options.jdAt === "function" ? options.jdAt :
      (time) => epochJD + time / DAY;
    let times;
    if (options.stepS !== undefined || !sampleTimes) {
      const start = finite(firstDefined(options.startTimeS, options.startS,
        sampleTimes && sampleTimes[0]), "start time");
      const end = finite(firstDefined(options.endTimeS, options.endS,
        sampleTimes && sampleTimes[sampleTimes.length - 1]), "end time");
      times = uniformTimes(start, end, firstDefined(options.stepS, (end - start) / 500));
    } else times = sampleTimes;
    const tolerance = positive(firstDefined(options.timeToleranceS, 0.05),
      "event time tolerance");
    const worldCoordinates = Boolean(options.worldCoordinates);
    const bodyPositionAt = options.bodyPositionAt || ((time) =>
      A.bodyWorld(bodyId, finite(jdAt(time), "access Julian date")));
    const spinAt = typeof options.spinAt === "function" ? options.spinAt : () => undefined;
    const craftRelative = (time) => {
      const craft = resolvePosition(spacecraftAt, time, "spacecraft position");
      return worldCoordinates ? V.sub(craft,
        resolvePosition(bodyPositionAt, time, "body position")) : craft;
    };
    const reports = [];
    for (const station of stations) {
      const elevationAt = (time) => accessGeometry(craftRelative(time), station,
        finite(jdAt(time), "access Julian date"), spinAt(time, station)).elevationDeg;
      const pairs = positiveIntervals(times,
        (time) => elevationAt(time) - station.elevationMaskDeg, tolerance);
      const intervals = pairs.map((pair) => {
        const maximum = maximizeElevation(elevationAt, pair[0], pair[1]);
        return Object.freeze({
          stationId: station.id,
          stationName: station.name,
          bodyId,
          elevationMaskDeg: station.elevationMaskDeg,
          startTimeS: pair[0],
          endTimeS: pair[1],
          durationS: pair[1] - pair[0],
          maxElevationDeg: maximum.value,
          maxElevationTimeS: maximum.time,
          startJD: finite(jdAt(pair[0]), "rise Julian date"),
          endJD: finite(jdAt(pair[1]), "set Julian date"),
          clippedAtStart: Math.abs(pair[0] - times[0]) <= tolerance,
          clippedAtEnd: Math.abs(pair[1] - times[times.length - 1]) <= tolerance,
        });
      });
      reports.push(Object.freeze({ station, intervals: Object.freeze(intervals) }));
    }
    const intervals = reports.flatMap((report) => report.intervals)
      .sort((a, b) => a.startTimeS - b.startTimeS || a.stationId.localeCompare(b.stationId));
    return Object.freeze({
      stations: Object.freeze(reports),
      intervals: Object.freeze(intervals),
    });
  }

  /* ------------------------- sensor footprints ------------------------- */

  function raySphereIntersection(originValue, directionValue, centerValue, radiusValue) {
    const origin = vector(originValue, "ray origin");
    const direction = V.norm(vector(directionValue, "ray direction"));
    if (V.mag(direction) === 0) throw new Error("ray direction must be nonzero");
    const center = centerValue === undefined ? [0, 0, 0] : vector(centerValue, "sphere center");
    const radius = positive(radiusValue, "sphere radius");
    const m = V.sub(origin, center);
    const b = V.dot(m, direction), c = V.dot(m, m) - radius * radius;
    const discriminant = b * b - c;
    if (discriminant < 0) return null;
    const root = Math.sqrt(Math.max(0, discriminant));
    let distance = -b - root;
    if (distance < 0) distance = -b + root;
    if (distance < 0) return null;
    return Object.freeze({
      distanceKm: distance,
      point: V.add(origin, V.scale(direction, distance)),
    });
  }

  function perpendicularBasis(axis) {
    const q = V.norm(axis);
    const reference = Math.abs(q[2]) < 0.85 ? [0, 0, 1] : [0, 1, 0];
    const x = V.norm(V.cross(reference, q));
    return { x, y: V.norm(V.cross(q, x)) };
  }

  function surfaceArcDistance(a, b, center, radius) {
    const na = V.norm(V.sub(a, center)), nb = V.norm(V.sub(b, center));
    return radius * Math.acos(clamp(V.dot(na, nb), -1, 1));
  }

  function sensorFootprint(options) {
    options = options || {};
    const spacecraft = vector(firstDefined(options.spacecraftPosition,
      options.spacecraft, options.r), "spacecraft position");
    const center = options.bodyCenter === undefined ? [0, 0, 0]
      : vector(options.bodyCenter, "body center");
    const radius = positive(firstDefined(options.bodyRadiusKm,
      options.radiusKm), "body radius");
    const relative = V.sub(spacecraft, center), spacecraftRadiusKm = V.mag(relative);
    if (!(spacecraftRadiusKm > radius)) throw new Error("spacecraft must be above the body surface");
    const fullFovDeg = positive(firstDefined(options.fovDeg,
      options.fullFovDeg), "sensor field of view");
    const halfAngle = 0.5 * fullFovDeg * DEG;
    if (!(halfAngle < Math.PI / 2)) throw new Error("sensor field of view must be below 180 degrees");
    const boundarySamples = firstDefined(options.boundarySamples, options.samples, 72);
    if (!Number.isInteger(boundarySamples) || boundarySamples < 8 || boundarySamples > 720) {
      throw new Error("boundarySamples must be an integer from 8 to 720");
    }
    const nadir = V.scale(relative, -1 / spacecraftRadiusKm);
    const tangent = perpendicularBasis(nadir);
    const offNadir = finite(firstDefined(options.offNadirDeg, 0), "off-nadir angle") * DEG;
    if (Math.abs(offNadir) >= Math.PI / 2) {
      throw new Error("off-nadir angle must be between -90 and 90 degrees");
    }
    const azimuth = finite(firstDefined(options.azimuthDeg, 0), "sensor azimuth") * DEG;
    const tiltDirection = V.add(V.scale(tangent.x, Math.cos(azimuth)),
      V.scale(tangent.y, Math.sin(azimuth)));
    let boresight = options.boresight
      ? V.norm(vector(options.boresight, "sensor boresight"))
      : V.norm(V.add(V.scale(nadir, Math.cos(offNadir)),
        V.scale(tiltDirection, Math.sin(offNadir))));
    if (V.mag(boresight) === 0) throw new Error("sensor boresight must be nonzero");
    const coneBasis = perpendicularBasis(boresight);
    const centerHit = raySphereIntersection(spacecraft, boresight, center, radius);
    const boundary = [];
    const pointsByIndex = new Array(boundarySamples).fill(null);
    for (let index = 0; index < boundarySamples; index++) {
      const angle = TWO_PI * index / boundarySamples;
      const around = V.add(V.scale(coneBasis.x, Math.cos(angle)),
        V.scale(coneBasis.y, Math.sin(angle)));
      const direction = V.add(V.scale(boresight, Math.cos(halfAngle)),
        V.scale(around, Math.sin(halfAngle)));
      const hit = raySphereIntersection(spacecraft, direction, center, radius);
      if (!hit) continue;
      let latDeg = null, lonDeg = null;
      if (options.body && Number.isFinite(options.jd)) {
        const ll = A.bodyLatLon(options.body, V.sub(hit.point, center), options.jd,
          options.spinOverride);
        if (ll) { latDeg = ll.phi * RAD_TO_DEG; lonDeg = ll.lam * RAD_TO_DEG; }
      }
      const point = Object.freeze({ index, point: hit.point, latDeg, lonDeg });
      boundary.push(point); pointsByIndex[index] = point;
    }
    const diameters = [];
    if (boundarySamples % 2 === 0) {
      for (let index = 0; index < boundarySamples / 2; index++) {
        const a = pointsByIndex[index], b = pointsByIndex[index + boundarySamples / 2];
        if (a && b) diameters.push(surfaceArcDistance(a.point, b.point, center, radius));
      }
    }
    return Object.freeze({
      center: centerHit ? centerHit.point : null,
      boresight: Object.freeze(boresight),
      nadir: Object.freeze(nadir),
      boundary: Object.freeze(boundary),
      closed: boundary.length === boundarySamples,
      hitFraction: boundary.length / boundarySamples,
      spacecraftAltitudeKm: spacecraftRadiusKm - radius,
      minimumDiameterKm: diameters.length ? Math.min(...diameters) : null,
      maximumDiameterKm: diameters.length ? Math.max(...diameters) : null,
      swathWidthKm: diameters.length ? Math.max(...diameters) : null,
    });
  }

  function sensorSwathSeries(samples, options) {
    if (!Array.isArray(samples)) throw new Error("sensor swath samples must be an array");
    if (samples.length > 2000) throw new Error("sensor swath series exceeds 2000 samples");
    options = options || {};
    return Object.freeze(samples.map((sample, index) => {
      const time = sampleTime(sample, index);
      const dynamic = typeof options.optionsAt === "function"
        ? options.optionsAt(time, sample) || {} : {};
      return Object.freeze({
        timeS: time,
        footprint: sensorFootprint({ ...options, ...dynamic,
          spacecraftPosition: samplePosition(sample, index) }),
      });
    }));
  }

  /* --------------------------- J2 secular model --------------------------- */

  function j2SecularRates(options) {
    options = options || {};
    const aKm = positive(firstDefined(options.aKm, options.a), "semi-major axis");
    const e = nonnegative(firstDefined(options.e, 0), "eccentricity");
    if (!(e < 1)) throw new Error("J2 secular rates require an elliptic orbit");
    const iRad = options.iDeg !== undefined ? finite(options.iDeg, "inclination") * DEG
      : finite(firstDefined(options.iRad, options.i), "inclination");
    const mu = positive(firstDefined(options.mu, BODIES.earth.mu),
      "gravitational parameter");
    const radiusKm = positive(firstDefined(options.radiusKm,
      EARTH_EQUATORIAL_RADIUS_KM), "reference radius");
    const j2 = positive(firstDefined(options.j2, EARTH_J2), "J2 coefficient");
    const pKm = aKm * (1 - e * e);
    if (!(aKm * (1 - e) > radiusKm)) {
      throw new Error("orbit periapsis must exceed the reference radius");
    }
    const meanMotionRadS = Math.sqrt(mu / (aKm * aKm * aKm));
    const c = Math.cos(iRad), factor = j2 * meanMotionRadS * (radiusKm / pKm) ** 2;
    const raanRateRadS = -1.5 * factor * c;
    const argPeriapsisRateRadS = 0.75 * factor * (5 * c * c - 1);
    const meanAnomalyCorrectionRadS = 0.75 * factor * Math.sqrt(1 - e * e) *
      (3 * c * c - 1);
    const convert = RAD_TO_DEG * DAY;
    return Object.freeze({
      aKm, e, iRad, pKm, meanMotionRadS,
      raanRateRadS,
      argPeriapsisRateRadS,
      meanAnomalyCorrectionRadS,
      meanAnomalyRateRadS: meanMotionRadS + meanAnomalyCorrectionRadS,
      raanRateDegDay: raanRateRadS * convert,
      argPeriapsisRateDegDay: argPeriapsisRateRadS * convert,
      meanAnomalyCorrectionDegDay: meanAnomalyCorrectionRadS * convert,
    });
  }

  function sunSynchronousInclination(options) {
    options = options || {};
    const radiusKm = positive(firstDefined(options.radiusKm,
      EARTH_EQUATORIAL_RADIUS_KM), "reference radius");
    const aKm = options.aKm === undefined
      ? radiusKm + positive(options.altitudeKm, "altitude")
      : positive(options.aKm, "semi-major axis");
    const e = nonnegative(firstDefined(options.e, 0), "eccentricity");
    if (!(e < 1)) throw new Error("sun-synchronous inclination requires an elliptic orbit");
    const mu = positive(firstDefined(options.mu, BODIES.earth.mu),
      "gravitational parameter");
    const j2 = positive(firstDefined(options.j2, EARTH_J2), "J2 coefficient");
    const targetRateDegDay = finite(firstDefined(options.targetRateDegDay,
      360 / 365.2422), "target nodal rate");
    const pKm = aKm * (1 - e * e);
    const n = Math.sqrt(mu / (aKm * aKm * aKm));
    const target = targetRateDegDay * DEG / DAY;
    const cosine = -target / (1.5 * j2 * n * (radiusKm / pKm) ** 2);
    if (Math.abs(cosine) > 1) throw new Error("requested nodal rate has no J2 inclination solution");
    const inclinationRad = Math.acos(cosine);
    return Object.freeze({
      aKm, altitudeKm: aKm - radiusKm, e,
      inclinationRad,
      inclinationDeg: inclinationRad * RAD_TO_DEG,
      targetRateDegDay,
    });
  }

  function applyJ2Secular(elements, dtS, options) {
    elements = elements || {};
    dtS = finite(dtS, "J2 propagation duration");
    const rates = j2SecularRates({ ...options, ...elements });
    const Om = wrapRadians(finite(firstDefined(elements.Om, elements.raanRad, 0),
      "ascending-node longitude") + rates.raanRateRadS * dtS);
    const w = wrapRadians(finite(firstDefined(elements.w, elements.argPeriapsisRad, 0),
      "argument of periapsis") + rates.argPeriapsisRateRadS * dtS);
    const M = wrapRadians(finite(firstDefined(elements.M, elements.meanAnomalyRad, 0),
      "mean anomaly") + rates.meanAnomalyRateRadS * dtS);
    return Object.freeze({ ...elements, Om, w, M, rates });
  }

  /* ----------------------- finite-burn estimates ----------------------- */

  function finiteBurnEstimate(options) {
    options = options || {};
    const thrustN = positive(options.thrustN, "thrust");
    const ispS = positive(firstDefined(options.ispS, options.isp), "specific impulse");
    const initialMassKg = positive(firstDefined(options.initialMassKg,
      options.massKg), "initial mass");
    const throttle = positive(firstDefined(options.throttle, 1), "throttle");
    if (throttle > 1) throw new Error("throttle must not exceed 1");
    const effectiveThrustN = thrustN * throttle;
    let deltaVKmS;
    if (options.deltaVVectorKmS !== undefined || Array.isArray(options.deltaV)) {
      deltaVKmS = V.mag(vector(firstDefined(options.deltaVVectorKmS,
        options.deltaV), "delta-v vector"));
    } else if (options.deltaVMs !== undefined) {
      deltaVKmS = nonnegative(options.deltaVMs, "delta-v") / 1000;
    } else {
      deltaVKmS = nonnegative(firstDefined(options.deltaVKmS,
        options.deltaV, 0), "delta-v");
    }
    const deltaVMs = deltaVKmS * 1000;
    const exhaustVelocityMs = ispS * G0_M_S2;
    const exponent = deltaVMs / exhaustVelocityMs;
    if (exponent > 700) throw new Error("requested delta-v exceeds the finite mass-ratio limit");
    const massRatio = Math.exp(exponent);
    const finalMassKg = initialMassKg / massRatio;
    const propellantMassKg = initialMassKg - finalMassKg;
    const massFlowKgS = effectiveThrustN / exhaustVelocityMs;
    const durationS = propellantMassKg / massFlowKgS;
    const constantMassDurationS = initialMassKg * deltaVMs / effectiveThrustN;
    let dryMassKg = null, availablePropellantKg = Infinity, maxDeltaVKmS = Infinity;
    if (options.dryMassKg !== undefined) {
      dryMassKg = nonnegative(options.dryMassKg, "dry mass");
      if (!(dryMassKg < initialMassKg) && !(deltaVMs === 0 && dryMassKg === initialMassKg)) {
        throw new Error("dry mass must be below initial mass");
      }
      availablePropellantKg = initialMassKg - dryMassKg;
      maxDeltaVKmS = dryMassKg > 0
        ? exhaustVelocityMs * Math.log(initialMassKg / dryMassKg) / 1000
        : Infinity;
    }
    const feasible = propellantMassKg <= availablePropellantKg +
      Math.max(1e-12, initialMassKg * 1e-12);
    return Object.freeze({
      thrustN,
      effectiveThrustN,
      throttle,
      ispS,
      exhaustVelocityMs,
      initialMassKg,
      dryMassKg,
      deltaVKmS,
      deltaVMs,
      massRatio,
      finalMassKg,
      propellantMassKg,
      massFlowKgS,
      durationS,
      constantMassDurationS,
      availablePropellantKg,
      propellantShortfallKg: feasible ? 0 : propellantMassKg - availablePropellantKg,
      maxDeltaVKmS,
      feasible,
    });
  }

  globalThis.MissionAnalysis = Object.freeze({
    DSN_STATIONS,
    SERIES_COLUMNS,
    EARTH_J2,
    EARTH_EQUATORIAL_RADIUS_KM,
    G0_M_S2,
    extractOsculatingSeries,
    adaptiveDecimateRows,
    rowsToCSV,
    shadowGeometry,
    eclipseIntervals,
    normalizeStation,
    stationPosition,
    accessGeometry,
    groundStationAccess,
    raySphereIntersection,
    sensorFootprint,
    sensorSwathSeries,
    surfaceArcDistance,
    j2SecularRates,
    sunSynchronousInclination,
    applyJ2Secular,
    finiteBurnEstimate,
  });
})();
