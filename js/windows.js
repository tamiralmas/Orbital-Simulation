/* =============================================================================
 * Mission Trajectory Planner - windows.js
 * Dependency-free launch-window (porkchop) search engine.
 *
 * Evaluates single-revolution Lambert transfers between catalog bodies and
 * reports hyperbolic excess velocity at both ends. The synchronous grid core
 * is accompanied by a scheduled async iterator/callback wrapper so a browser
 * can paint progress between bounded chunks without a worker or build step.
 *
 * Load after constants.js and kepler.js. Units are km, s, and Julian days.
 * ========================================================================== */
"use strict";

(function () {
  const C = globalThis.AstroConst;
  const A = globalThis.Astro;
  if (!C || !A) throw new Error("windows.js requires constants.js and kepler.js");

  const { BODIES, DAY } = C;
  const V = A.V;
  const MAX_GRID_CELLS = 20000;
  const MAX_AXIS_SAMPLES = 512;
  const DEFAULT_DEPARTURE_COUNT = 80;
  const DEFAULT_TOF_COUNT = 60;
  const DEFAULT_CHUNK_SIZE = 96;
  const CACHE_LIMIT = 12;
  const METRICS = [
    "c3",
    "departureVInfinity",
    "arrivalVInfinity",
    "totalCharacteristicVelocity",
  ];

  const cache = new Map();
  let cacheHits = 0;
  let cacheMisses = 0;

  function firstDefined() {
    for (let i = 0; i < arguments.length; i++) {
      if (arguments[i] !== undefined && arguments[i] !== null) return arguments[i];
    }
    return undefined;
  }

  function bodyId(value, label) {
    const id = String(value === undefined ? "" : value).trim().toLowerCase();
    if (!BODIES[id]) throw new Error(`Unknown ${label} body: ${value}`);
    return id;
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

  function count(value, fallback, label) {
    const number = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(number) || number < 1 || number > MAX_AXIS_SAMPLES) {
      throw new Error(`${label} must be an integer from 1 to ${MAX_AXIS_SAMPLES}`);
    }
    return number;
  }

  function julianDate(value, label) {
    if (typeof value === "number") return finite(value, label);
    if (value instanceof Date) {
      if (!Number.isFinite(value.getTime())) throw new Error(`${label} is invalid`);
      return A.dateToJD(value.getTime());
    }
    if (typeof value === "string" && value.trim()) return A.dateToJD(value);
    throw new Error(`${label} must be a Julian date, Date, or ISO date string`);
  }

  function parentAncestors(id) {
    const result = [];
    let current = BODIES[id] && BODIES[id].parent;
    while (current && BODIES[current]) {
      result.push(current);
      current = BODIES[current].parent;
    }
    return result;
  }

  function defaultCentralBody(departureBody, arrivalBody) {
    const arrivalAncestors = new Set(parentAncestors(arrivalBody));
    const common = parentAncestors(departureBody).find((id) => arrivalAncestors.has(id));
    if (!common) {
      throw new Error(`No common central body for ${departureBody} and ${arrivalBody}`);
    }
    return common;
  }

  function normalizePair(input) {
    input = input || {};
    const departureBody = bodyId(firstDefined(input.departureBody,
      input.departureBodyId, input.from), "departure");
    const arrivalBody = bodyId(firstDefined(input.arrivalBody,
      input.arrivalBodyId, input.to), "arrival");
    if (departureBody === arrivalBody) {
      throw new Error("Departure and arrival bodies must be different");
    }
    const centralValue = firstDefined(input.centralBody, input.centralBodyId);
    const centralBody = centralValue === undefined
      ? defaultCentralBody(departureBody, arrivalBody)
      : bodyId(centralValue, "central");
    if (centralBody === departureBody || centralBody === arrivalBody) {
      throw new Error("The central body cannot also be a transfer endpoint");
    }
    if (!parentAncestors(departureBody).includes(centralBody) ||
        !parentAncestors(arrivalBody).includes(centralBody)) {
      throw new Error("The central body must be a common ancestor of both endpoints");
    }
    if (!(BODIES[centralBody].mu > 0)) {
      throw new Error(`Central body ${centralBody} has no valid gravitational parameter`);
    }
    return {
      departureBody,
      arrivalBody,
      centralBody,
      prograde: input.prograde === undefined ? true : Boolean(input.prograde),
    };
  }

  function normalizeCell(input) {
    const pair = normalizePair(input);
    const departureJD = julianDate(firstDefined(input.departureJD,
      input.departureDate, input.departure), "departure date");
    const tofDays = positive(firstDefined(input.tofDays,
      input.timeOfFlightDays, input.tof), "time of flight");
    return { ...pair, departureJD, tofDays };
  }

  function normalizeGrid(input) {
    input = input || {};
    const pair = normalizePair(input);
    const departureStartJD = julianDate(firstDefined(input.departureStartJD,
      input.startJD, input.departureStart), "departure start");
    const departureEndJD = julianDate(firstDefined(input.departureEndJD,
      input.endJD, input.departureEnd), "departure end");
    const departureCount = count(firstDefined(input.departureCount,
      input.departureSteps), DEFAULT_DEPARTURE_COUNT, "departure count");
    const tofMinDays = positive(firstDefined(input.tofMinDays,
      input.minTofDays, input.tofStartDays), "minimum time of flight");
    const tofMaxDays = positive(firstDefined(input.tofMaxDays,
      input.maxTofDays, input.tofEndDays), "maximum time of flight");
    const tofCount = count(firstDefined(input.tofCount, input.tofSteps),
      DEFAULT_TOF_COUNT, "time-of-flight count");

    if (departureEndJD < departureStartJD ||
        (departureCount > 1 && departureEndJD === departureStartJD)) {
      throw new Error("Departure end must be after departure start");
    }
    if (tofMaxDays < tofMinDays || (tofCount > 1 && tofMaxDays === tofMinDays)) {
      throw new Error("Maximum time of flight must exceed the minimum");
    }
    const totalCells = departureCount * tofCount;
    if (totalCells > MAX_GRID_CELLS) {
      throw new Error(`Grid has ${totalCells} cells; maximum is ${MAX_GRID_CELLS}`);
    }
    return {
      ...pair,
      departureStartJD,
      departureEndJD,
      departureCount,
      tofMinDays,
      tofMaxDays,
      tofCount,
      totalCells,
    };
  }

  function fixedKeyNumber(number) {
    return Number(number).toPrecision(15);
  }

  function cacheKey(spec) {
    return [
      "windows-v1",
      spec.departureBody,
      spec.arrivalBody,
      spec.centralBody,
      spec.prograde ? "prograde" : "retrograde",
      fixedKeyNumber(spec.departureStartJD),
      fixedKeyNumber(spec.departureEndJD),
      spec.departureCount,
      fixedKeyNumber(spec.tofMinDays),
      fixedKeyNumber(spec.tofMaxDays),
      spec.tofCount,
    ].join("|");
  }

  function positionRelativeTo(body, central, jd) {
    return V.sub(A.bodyWorld(body, jd), A.bodyWorld(central, jd));
  }

  function velocityRelativeTo(body, central, jd) {
    return V.sub(A.bodyWorldVel(body, jd, "sun"),
      A.bodyWorldVel(central, jd, "sun"));
  }

  function frozenVector(vector) {
    return Object.freeze([vector[0], vector[1], vector[2]]);
  }

  function invalidCell(spec, arrivalJD, reason) {
    return Object.freeze({
      valid: false,
      departureBody: spec.departureBody,
      arrivalBody: spec.arrivalBody,
      centralBody: spec.centralBody,
      departureJD: spec.departureJD,
      arrivalJD,
      tofDays: spec.tofDays,
      prograde: spec.prograde,
      error: reason,
    });
  }

  function evaluateNormalizedCell(spec) {
    const arrivalJD = spec.departureJD + spec.tofDays;
    try {
      const r1 = positionRelativeTo(spec.departureBody, spec.centralBody,
        spec.departureJD);
      const r2 = positionRelativeTo(spec.arrivalBody, spec.centralBody, arrivalJD);
      const departureBodyVelocity = velocityRelativeTo(spec.departureBody,
        spec.centralBody, spec.departureJD);
      const arrivalBodyVelocity = velocityRelativeTo(spec.arrivalBody,
        spec.centralBody, arrivalJD);
      const solution = A.lambert(r1, r2, spec.tofDays * DAY,
        BODIES[spec.centralBody].mu, spec.prograde);
      if (!solution) {
        return invalidCell(spec, arrivalJD,
          "No single-revolution Lambert solution for this cell");
      }

      const departureVInfinityVector = V.sub(solution.v1, departureBodyVelocity);
      const arrivalVInfinityVector = V.sub(solution.v2, arrivalBodyVelocity);
      const departureVInfinity = V.mag(departureVInfinityVector);
      const arrivalVInfinity = V.mag(arrivalVInfinityVector);
      const c3 = departureVInfinity * departureVInfinity;
      const totalCharacteristicVelocity = departureVInfinity + arrivalVInfinity;
      const values = [departureVInfinity, arrivalVInfinity, c3,
        totalCharacteristicVelocity].concat(r1, r2, solution.v1, solution.v2);
      if (!values.every(Number.isFinite)) {
        return invalidCell(spec, arrivalJD, "Lambert solution produced non-finite state data");
      }

      return Object.freeze({
        valid: true,
        departureBody: spec.departureBody,
        arrivalBody: spec.arrivalBody,
        centralBody: spec.centralBody,
        departureJD: spec.departureJD,
        arrivalJD,
        tofDays: spec.tofDays,
        prograde: spec.prograde,
        c3,
        departureVInfinity,
        arrivalVInfinity,
        totalCharacteristicVelocity,
        departurePosition: frozenVector(r1),
        arrivalPosition: frozenVector(r2),
        departureBodyVelocity: frozenVector(departureBodyVelocity),
        arrivalBodyVelocity: frozenVector(arrivalBodyVelocity),
        transferDepartureVelocity: frozenVector(solution.v1),
        transferArrivalVelocity: frozenVector(solution.v2),
        departureVInfinityVector: frozenVector(departureVInfinityVector),
        arrivalVInfinityVector: frozenVector(arrivalVInfinityVector),
      });
    } catch (error) {
      return invalidCell(spec, arrivalJD,
        error && error.message ? error.message : "Cell evaluation failed");
    }
  }

  function evaluateCell(input) {
    return evaluateNormalizedCell(normalizeCell(input));
  }

  function axis(start, end, samples) {
    if (samples === 1) return [start];
    const result = new Array(samples);
    const step = (end - start) / (samples - 1);
    for (let i = 0; i < samples; i++) result[i] = start + i * step;
    result[samples - 1] = end;
    return result;
  }

  function createGrid(spec, key) {
    const departuresJD = axis(spec.departureStartJD, spec.departureEndJD,
      spec.departureCount);
    const timesOfFlightDays = axis(spec.tofMinDays, spec.tofMaxDays, spec.tofCount);
    const ranges = {};
    const minima = {};
    for (const metric of METRICS) {
      ranges[metric] = { min: Infinity, max: -Infinity };
      minima[metric] = null;
    }
    return {
      cacheKey: key,
      config: {
        departureBody: spec.departureBody,
        arrivalBody: spec.arrivalBody,
        centralBody: spec.centralBody,
        prograde: spec.prograde,
        departureStartJD: spec.departureStartJD,
        departureEndJD: spec.departureEndJD,
        departureCount: spec.departureCount,
        tofMinDays: spec.tofMinDays,
        tofMaxDays: spec.tofMaxDays,
        tofCount: spec.tofCount,
      },
      units: {
        c3: "km^2/s^2",
        departureVInfinity: "km/s",
        arrivalVInfinity: "km/s",
        totalCharacteristicVelocity: "km/s",
      },
      departuresJD,
      timesOfFlightDays,
      width: spec.departureCount,
      height: spec.tofCount,
      totalCells: spec.totalCells,
      validCells: 0,
      cells: new Array(spec.totalCells),
      ranges,
      minima,
    };
  }

  function compactCell(detail, departureIndex, tofIndex, index) {
    if (!detail.valid) {
      return Object.freeze({
        valid: false,
        index,
        departureIndex,
        tofIndex,
        departureJD: detail.departureJD,
        arrivalJD: detail.arrivalJD,
        tofDays: detail.tofDays,
        error: detail.error,
      });
    }
    return Object.freeze({
      valid: true,
      index,
      departureIndex,
      tofIndex,
      departureJD: detail.departureJD,
      arrivalJD: detail.arrivalJD,
      tofDays: detail.tofDays,
      c3: detail.c3,
      departureVInfinity: detail.departureVInfinity,
      arrivalVInfinity: detail.arrivalVInfinity,
      totalCharacteristicVelocity: detail.totalCharacteristicVelocity,
    });
  }

  function recordCell(grid, cell) {
    grid.cells[cell.index] = cell;
    if (!cell.valid) return;
    grid.validCells++;
    for (const metric of METRICS) {
      const value = cell[metric];
      const range = grid.ranges[metric];
      if (value < range.min) range.min = value;
      if (value > range.max) range.max = value;
      if (!grid.minima[metric] || value < grid.minima[metric][metric]) {
        grid.minima[metric] = cell;
      }
    }
  }

  function fillRange(grid, spec, start, end) {
    for (let index = start; index < end; index++) {
      const departureIndex = index % spec.departureCount;
      const tofIndex = Math.floor(index / spec.departureCount);
      const detail = evaluateNormalizedCell({
        departureBody: spec.departureBody,
        arrivalBody: spec.arrivalBody,
        centralBody: spec.centralBody,
        prograde: spec.prograde,
        departureJD: grid.departuresJD[departureIndex],
        tofDays: grid.timesOfFlightDays[tofIndex],
      });
      recordCell(grid, compactCell(detail, departureIndex, tofIndex, index));
    }
  }

  function freezeGrid(grid) {
    for (const metric of METRICS) {
      const range = grid.ranges[metric];
      if (!Number.isFinite(range.min)) range.min = null;
      if (!Number.isFinite(range.max)) range.max = null;
      Object.freeze(range);
    }
    Object.freeze(grid.ranges);
    Object.freeze(grid.minima);
    Object.freeze(grid.config);
    Object.freeze(grid.units);
    Object.freeze(grid.departuresJD);
    Object.freeze(grid.timesOfFlightDays);
    Object.freeze(grid.cells);
    return Object.freeze(grid);
  }

  function cached(key) {
    if (!cache.has(key)) {
      cacheMisses++;
      return null;
    }
    cacheHits++;
    const result = cache.get(key);
    cache.delete(key);
    cache.set(key, result);
    return result;
  }

  function store(key, result) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, result);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return result;
  }

  function evaluateGrid(input) {
    const spec = normalizeGrid(input);
    const key = cacheKey(spec);
    const hit = cached(key);
    if (hit) return hit;
    const grid = createGrid(spec, key);
    fillRange(grid, spec, 0, spec.totalCells);
    return store(key, freezeGrid(grid));
  }

  function abortError() {
    const error = new Error("Launch-window grid evaluation was aborted");
    error.name = "AbortError";
    return error;
  }

  function defaultYieldControl() {
    return new Promise((resolve) => {
      if (typeof globalThis.requestIdleCallback === "function") {
        globalThis.requestIdleCallback(() => resolve(), { timeout: 30 });
      } else {
        globalThis.setTimeout(resolve, 0);
      }
    });
  }

  async function* iterateGrid(input, options) {
    options = options || {};
    const spec = normalizeGrid(input);
    const key = cacheKey(spec);
    const hit = cached(key);
    if (hit) {
      yield Object.freeze({
        grid: hit,
        cells: hit.cells,
        startIndex: 0,
        endIndex: hit.totalCells,
        completed: hit.totalCells,
        total: hit.totalCells,
        progress: 1,
        done: true,
        fromCache: true,
      });
      return;
    }

    const chunkSize = count(options.chunkSize, DEFAULT_CHUNK_SIZE, "chunk size");
    const yieldControl = typeof options.yieldControl === "function"
      ? options.yieldControl : defaultYieldControl;
    const signal = options.signal;
    let grid = createGrid(spec, key);
    let cursor = 0;
    while (cursor < spec.totalCells) {
      if (signal && signal.aborted) throw abortError();
      const startIndex = cursor;
      const endIndex = Math.min(spec.totalCells, startIndex + chunkSize);
      fillRange(grid, spec, startIndex, endIndex);
      cursor = endIndex;
      const done = cursor === spec.totalCells;
      if (done) grid = store(key, freezeGrid(grid));
      yield Object.freeze({
        grid,
        cells: Object.freeze(grid.cells.slice(startIndex, endIndex)),
        startIndex,
        endIndex,
        completed: cursor,
        total: spec.totalCells,
        progress: cursor / spec.totalCells,
        done,
        fromCache: false,
      });
      if (!done) await yieldControl();
    }
  }

  async function evaluateGridAsync(input, options) {
    options = options || {};
    let result = null;
    for await (const progress of iterateGrid(input, options)) {
      result = progress.grid;
      if (typeof options.onChunk === "function") options.onChunk(progress);
    }
    return result;
  }

  function clearCache() {
    cache.clear();
    cacheHits = 0;
    cacheMisses = 0;
  }

  function cacheInfo() {
    return Object.freeze({
      size: cache.size,
      limit: CACHE_LIMIT,
      hits: cacheHits,
      misses: cacheMisses,
      keys: Object.freeze(Array.from(cache.keys())),
    });
  }

  globalThis.MissionWindows = Object.freeze({
    MAX_GRID_CELLS,
    MAX_AXIS_SAMPLES,
    DEFAULT_DEPARTURE_COUNT,
    DEFAULT_TOF_COUNT,
    DEFAULT_CHUNK_SIZE,
    evaluateCell,
    evaluateGrid,
    iterateGrid,
    evaluateGridAsync,
    clearCache,
    cacheInfo,
  });
})();
