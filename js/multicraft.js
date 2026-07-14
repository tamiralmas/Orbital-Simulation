/* =============================================================================
 * Mission Trajectory Planner - multicraft.js
 * Dependency-free synchronized multi-spacecraft analysis engine.
 *
 * A craft descriptor supplies a state provider and may include epochJD plus a
 * bounded local-time domain. Providers return Cartesian position/velocity in
 * kilometres and kilometres per second. When every craft has epoch metadata,
 * the module maps their local elapsed times onto one absolute reference epoch.
 *
 * Supported provider forms:
 *   { id, sample(t) }
 *   { id, provider: function (t) { ... } }
 *   { id, provider: { sampleAtTime(t) { ... } } }
 *   { id, result, sampler: function (result, t) { ... } }
 *   { id, result }  // uses MissionEngine.sampleAtTime when available, or a
 *                   // bounded linear fallback over result.samples
 *
 * Load after propagator.js when mission results are used. Analytic/custom
 * providers have no dependencies. All public time values are seconds.
 * ========================================================================== */
"use strict";

(function () {
  const DAY = 86400;
  const DEFAULT_MAX_SAMPLES = 2049;
  const DEFAULT_INITIAL_INTERVALS = 32;
  const DEFAULT_MAX_DEPTH = 12;
  const DEFAULT_MAX_EVALUATIONS = 4096;
  const MAX_CRAFT = 128;
  const MAX_SYNC_SAMPLES = 100001;
  const GOLDEN_RATIO = (Math.sqrt(5) - 1) / 2;

  const PALETTE = Object.freeze([
    Object.freeze({ name: "ember", blueprint: "#e95420", cinematic: "#ff6842" }),
    Object.freeze({ name: "azure", blueprint: "#276db5", cinematic: "#5ca7ff" }),
    Object.freeze({ name: "teal", blueprint: "#178578", cinematic: "#52d4c5" }),
    Object.freeze({ name: "violet", blueprint: "#7253aa", cinematic: "#aa86ff" }),
    Object.freeze({ name: "gold", blueprint: "#a86d00", cinematic: "#ffc24d" }),
    Object.freeze({ name: "crimson", blueprint: "#b73345", cinematic: "#ff6178" }),
    Object.freeze({ name: "green", blueprint: "#347d43", cinematic: "#65d77a" }),
    Object.freeze({ name: "slate", blueprint: "#536473", cinematic: "#9aafc2" }),
    Object.freeze({ name: "magenta", blueprint: "#9b3e85", cinematic: "#ee78d1" }),
    Object.freeze({ name: "cyan", blueprint: "#087b9b", cinematic: "#3dd5f3" }),
    Object.freeze({ name: "brown", blueprint: "#8c5835", cinematic: "#d99967" }),
    Object.freeze({ name: "indigo", blueprint: "#4058a5", cinematic: "#7d91f8" }),
  ]);

  class MultiCraftError extends Error {
    constructor(code, message, details) {
      super(message);
      this.name = "MultiCraftError";
      this.code = code;
      if (details !== undefined) this.details = details;
    }
  }

  function fail(code, message, details) {
    throw new MultiCraftError(code, message, details);
  }

  function finite(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number)) fail("INVALID_ARGUMENT", label + " must be finite");
    return number;
  }

  function positive(value, fallback, label, allowZero) {
    const number = value === undefined ? fallback : finite(value, label);
    if (allowZero ? number < 0 : number <= 0) {
      fail("INVALID_ARGUMENT", label + (allowZero ? " cannot be negative" :
        " must be greater than zero"));
    }
    return number;
  }

  function integer(value, fallback, label, min, max) {
    const number = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(number) || number < min || number > max) {
      fail("INVALID_ARGUMENT", label + " must be an integer from " + min + " to " + max);
    }
    return number;
  }

  function vector3(value, label) {
    if (!value || typeof value.length !== "number" || value.length < 3) {
      fail("INVALID_STATE", label + " must contain three components");
    }
    const result = [Number(value[0]), Number(value[1]), Number(value[2])];
    if (!result.every(Number.isFinite)) fail("INVALID_STATE", label + " must be finite");
    return result;
  }

  function frozenVector(value) {
    return Object.freeze(value.slice(0, 3));
  }

  function hashString(value) {
    let hash = 2166136261;
    const text = String(value);
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function colorMetadata(key, paletteIndex) {
    const index = paletteIndex === undefined
      ? hashString(String(key).toLowerCase()) % PALETTE.length
      : ((Number(paletteIndex) % PALETTE.length) + PALETTE.length) % PALETTE.length;
    const color = PALETTE[index];
    return Object.freeze({
      key: String(key),
      index,
      name: color.name,
      blueprint: color.blueprint,
      cinematic: color.cinematic,
    });
  }

  function assignColors(crafts) {
    if (!Array.isArray(crafts)) fail("INVALID_ARGUMENT", "crafts must be an array");
    const ids = crafts.map((craft, index) => String(craft && craft.id !== undefined
      ? craft.id : "craft-" + (index + 1)));
    const unique = Array.from(new Set(ids)).sort();
    const used = new Set();
    const byId = new Map();
    for (const id of unique) {
      let index = hashString(id.toLowerCase()) % PALETTE.length;
      let probes = 0;
      while (used.has(index) && probes < PALETTE.length) {
        index = (index + 1) % PALETTE.length;
        probes++;
      }
      if (probes < PALETTE.length) used.add(index);
      byId.set(id, colorMetadata(id, index));
    }
    return Object.freeze(ids.map((id) => byId.get(id)));
  }

  function descriptorEpochJD(craft) {
    const candidates = [craft.epochJD, craft.result && craft.result.epochJD,
      craft.provider && craft.provider.epochJD];
    for (const value of candidates) {
      if (value !== undefined && value !== null) return finite(value, "epochJD");
    }
    return null;
  }

  function domainFromSamples(samples) {
    if (!Array.isArray(samples) || !samples.length) return null;
    const first = samples[0], last = samples[samples.length - 1];
    if (!first || !last || !Number.isFinite(Number(first.t)) ||
        !Number.isFinite(Number(last.t))) return null;
    return [Number(first.t), Number(last.t)];
  }

  function descriptorDomain(craft) {
    let start = craft.startTime;
    let end = craft.endTime;
    const provider = craft.provider;
    const result = craft.result;
    if (start === undefined && provider && provider.startTime !== undefined)
      start = provider.startTime;
    if (end === undefined && provider && provider.endTime !== undefined)
      end = provider.endTime;
    if (start === undefined && result && result.tStart !== undefined) start = result.tStart;
    if (end === undefined && result && result.tEnd !== undefined) end = result.tEnd;
    const sampleDomain = domainFromSamples(result && result.samples) ||
      domainFromSamples(provider && provider.samples) || domainFromSamples(craft.samples);
    if (sampleDomain) {
      if (start === undefined) start = sampleDomain[0];
      if (end === undefined) end = sampleDomain[1];
    }
    if (start === undefined || end === undefined) return null;
    start = finite(start, "craft start time");
    end = finite(end, "craft end time");
    if (end < start) fail("INVALID_ARGUMENT", "craft end time precedes start time");
    return [start, end];
  }

  function linearSample(samples, time) {
    if (!Array.isArray(samples) || !samples.length) return null;
    if (time <= samples[0].t) return samples[0];
    if (time >= samples[samples.length - 1].t) return samples[samples.length - 1];
    let low = 0, high = samples.length - 1;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (samples[middle].t <= time) low = middle;
      else high = middle;
    }
    const a = samples[low], b = samples[high];
    const span = b.t - a.t;
    if (!(span > 0)) return b;
    const fraction = (time - a.t) / span;
    const interpolate = (left, right) => left && right
      ? [0, 1, 2].map((i) => left[i] + (right[i] - left[i]) * fraction) : null;
    const positionA = a.worldPosition || a.position || a.w || a.r;
    const positionB = b.worldPosition || b.position || b.w || b.r;
    const velocityA = a.worldVelocity || a.velocity || a.wv || a.v;
    const velocityB = b.worldVelocity || b.velocity || b.wv || b.v;
    const sameFrame = a.cen === b.cen ? a.cen : undefined;
    const interpolatedPosition = interpolate(positionA, positionB);
    const interpolatedVelocity = interpolate(velocityA, velocityB);
    // Preserve the propagated result's `w`/`v` distinction so the normalizer
    // can add central-body inertial velocity when Astro is available.
    return a.w && b.w ? {
      t: time, w: interpolatedPosition, v: interpolatedVelocity, cen: sameFrame,
    } : {
      t: time, position: interpolatedPosition, velocity: interpolatedVelocity,
      cen: sameFrame,
    };
  }

  function resolveSampler(craft) {
    if (typeof craft === "function") return { call: craft, owner: craft };
    if (!craft || typeof craft !== "object") {
      fail("INVALID_ARGUMENT", "each craft must be a descriptor or provider function");
    }
    if (typeof craft.sample === "function") return { call: craft.sample.bind(craft), owner: craft };
    if (typeof craft.stateAt === "function") return { call: craft.stateAt.bind(craft), owner: craft };
    if (typeof craft.sampleAtTime === "function" && !craft.result) {
      return { call: craft.sampleAtTime.bind(craft), owner: craft };
    }
    if (typeof craft.provider === "function") return { call: craft.provider, owner: craft.provider };
    if (craft.provider && typeof craft.provider.sampleAtTime === "function") {
      return { call: craft.provider.sampleAtTime.bind(craft.provider), owner: craft.provider };
    }
    if (craft.provider && typeof craft.provider.stateAt === "function") {
      return { call: craft.provider.stateAt.bind(craft.provider), owner: craft.provider };
    }
    if (craft.provider && typeof craft.provider.sample === "function") {
      return { call: craft.provider.sample.bind(craft.provider), owner: craft.provider };
    }
    if (craft.result) {
      if (typeof craft.sampler === "function") {
        return { call: (time) => craft.sampler(craft.result, time), owner: craft.result };
      }
      if (typeof craft.result.sampleAtTime === "function") {
        return { call: craft.result.sampleAtTime.bind(craft.result), owner: craft.result };
      }
      if (globalThis.MissionEngine &&
          typeof globalThis.MissionEngine.sampleAtTime === "function") {
        return {
          call: (time) => globalThis.MissionEngine.sampleAtTime(craft.result, time),
          owner: craft.result,
        };
      }
      if (Array.isArray(craft.result.samples)) {
        return { call: (time) => linearSample(craft.result.samples, time), owner: craft.result };
      }
    }
    if (Array.isArray(craft.samples)) {
      return { call: (time) => linearSample(craft.samples, time), owner: craft };
    }
    fail("INVALID_ARGUMENT", "craft '" + (craft.id || "unnamed") +
      "' has no supported state provider");
  }

  function resolveWorldVelocity(raw, craft, localTime, velocity) {
    if (raw.worldVelocity || raw.velocity || raw.wv || !raw.w || !raw.v ||
        !raw.cen || raw.cen === "sun") return velocity;
    const astro = globalThis.Astro;
    if (!astro || typeof astro.bodyWorldVel !== "function" || craft.epochJD === null) {
      return velocity;
    }
    try {
      const bodyVelocity = astro.bodyWorldVel(raw.cen,
        craft.epochJD + localTime / DAY, "sun");
      if (bodyVelocity && bodyVelocity.length >= 3) {
        return [velocity[0] + bodyVelocity[0], velocity[1] + bodyVelocity[1],
          velocity[2] + bodyVelocity[2]];
      }
    } catch (error) {
      // A custom provider may use a non-catalog frame. Its velocity is already
      // the best available value, so leave it unchanged.
    }
    return velocity;
  }

  function normalizeState(raw, craft, globalTime, localTime) {
    if (Array.isArray(raw) && raw.length >= 6) {
      raw = { position: raw.slice(0, 3), velocity: raw.slice(3, 6) };
    }
    if (!raw || typeof raw !== "object") {
      fail("INVALID_STATE", "craft '" + craft.id + "' returned no state at t=" + localTime);
    }
    const position = vector3(raw.worldPosition || raw.position || raw.w || raw.r,
      "position from craft '" + craft.id + "'");
    let velocity = vector3(raw.worldVelocity || raw.velocity || raw.wv || raw.v,
      "velocity from craft '" + craft.id + "'");
    velocity = resolveWorldVelocity(raw, craft, localTime, velocity);
    return Object.freeze({
      craftId: craft.id,
      t: globalTime,
      localTime,
      position: frozenVector(position),
      velocity: frozenVector(velocity),
      raw,
    });
  }

  function normalizeCrafts(input, options) {
    if (!Array.isArray(input) || !input.length) {
      fail("INVALID_ARGUMENT", "crafts must be a non-empty array");
    }
    if (input.length > MAX_CRAFT) {
      fail("INVALID_ARGUMENT", "craft count exceeds the limit of " + MAX_CRAFT);
    }
    options = options || {};
    const colors = assignColors(input);
    const ids = new Set();
    const preliminary = input.map((descriptor, index) => {
      const object = typeof descriptor === "function" ? { provider: descriptor } : descriptor;
      const id = String(object.id === undefined ? "craft-" + (index + 1) : object.id).trim();
      if (!id) fail("INVALID_ARGUMENT", "craft ids cannot be empty");
      if (ids.has(id)) fail("DUPLICATE_CRAFT_ID", "duplicate craft id: " + id);
      ids.add(id);
      const sampler = resolveSampler(object);
      return {
        descriptor: object,
        id,
        name: String(object.name === undefined ? id : object.name),
        sampler: sampler.call,
        epochJD: descriptorEpochJD(object),
        localDomain: descriptorDomain(object),
        color: object.color ? Object.freeze({ key: id, index: null, name: "custom",
          blueprint: String(typeof object.color === "string" ? object.color
            : object.color.blueprint || object.color.cinematic || "#e95420"),
          cinematic: String(typeof object.color === "string" ? object.color
            : object.color.cinematic || object.color.blueprint || "#ff6842") }) : colors[index],
      };
    });
    const knownEpochs = preliminary.map((craft) => craft.epochJD)
      .filter((epoch) => epoch !== null);
    let referenceEpochJD = options.referenceEpochJD;
    if (referenceEpochJD !== undefined && referenceEpochJD !== null) {
      referenceEpochJD = finite(referenceEpochJD, "referenceEpochJD");
    } else {
      referenceEpochJD = knownEpochs.length === preliminary.length
        ? Math.min.apply(null, knownEpochs) : null;
    }
    const crafts = preliminary.map((craft) => {
      const offset = referenceEpochJD !== null && craft.epochJD !== null
        ? (referenceEpochJD - craft.epochJD) * DAY : 0;
      const globalDomain = craft.localDomain
        ? [craft.localDomain[0] - offset, craft.localDomain[1] - offset] : null;
      const normalized = {
        id: craft.id,
        name: craft.name,
        color: craft.color,
        epochJD: craft.epochJD,
        localDomain: craft.localDomain,
        globalDomain,
        offset,
        sample(globalTime) {
          const time = finite(globalTime, "sample time");
          const localTime = time + offset;
          if (craft.localDomain) {
            const slack = 32 * Number.EPSILON * Math.max(1, Math.abs(localTime));
            if (localTime < craft.localDomain[0] - slack ||
                localTime > craft.localDomain[1] + slack) {
              fail("TIME_OUT_OF_RANGE", "craft '" + craft.id + "' has no state at t=" + time,
                { craftId: craft.id, time, localTime, domain: craft.localDomain.slice() });
            }
          }
          return normalizeState(craft.sampler(localTime), normalized, time, localTime);
        },
      };
      return Object.freeze(normalized);
    });
    return Object.freeze({ crafts: Object.freeze(crafts), referenceEpochJD });
  }

  function commonDomain(fleet, options) {
    let start = options.start === undefined ? -Infinity : finite(options.start, "start");
    let end = options.end === undefined ? Infinity : finite(options.end, "end");
    for (const craft of fleet.crafts) {
      if (!craft.globalDomain) continue;
      start = Math.max(start, craft.globalDomain[0]);
      end = Math.min(end, craft.globalDomain[1]);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      fail("MISSING_TIME_DOMAIN", "start and end are required for unbounded providers");
    }
    if (end < start) fail("NO_COMMON_TIME", "craft time domains do not overlap");
    return [start, end];
  }

  function requestedTimes(fleet, options) {
    const maxSamples = integer(options.maxSamples, MAX_SYNC_SAMPLES, "maxSamples", 1,
      MAX_SYNC_SAMPLES);
    if (options.times !== undefined) {
      if (!Array.isArray(options.times) || !options.times.length ||
          options.times.length > maxSamples) {
        fail("INVALID_ARGUMENT", "times must be a non-empty array within maxSamples");
      }
      const times = options.times.map((value) => finite(value, "sample time"));
      for (let i = 1; i < times.length; i++) {
        if (!(times[i] > times[i - 1])) {
          fail("INVALID_ARGUMENT", "times must be strictly increasing");
        }
      }
      return times;
    }
    const domain = commonDomain(fleet, options);
    const start = domain[0], end = domain[1];
    if (start === end) return [start];
    if (options.step !== undefined) {
      const step = positive(options.step, 0, "step", false);
      const count = Math.floor((end - start) / step) + 1;
      const includeEnd = Math.abs(start + (count - 1) * step - end) >
        32 * Number.EPSILON * Math.max(1, Math.abs(end));
      if (count + (includeEnd ? 1 : 0) > maxSamples) {
        fail("MAX_SAMPLES_EXCEEDED", "requested synchronized grid exceeds maxSamples");
      }
      const times = Array.from({ length: count }, (_, index) => start + index * step);
      if (includeEnd) times.push(end);
      else times[times.length - 1] = end;
      return times;
    }
    const count = integer(options.count, 201, "count", 2, maxSamples);
    return Array.from({ length: count }, (_, index) => index === count - 1 ? end
      : start + (end - start) * index / (count - 1));
  }

  function synchronize(crafts, options) {
    options = options || {};
    const fleet = normalizeCrafts(crafts, options);
    const times = requestedTimes(fleet, options);
    const byCraft = fleet.crafts.map((craft) => ({ craft, states: [] }));
    const frames = times.map((time) => {
      const states = fleet.crafts.map((craft, index) => {
        const state = craft.sample(time);
        byCraft[index].states.push(state);
        return state;
      });
      return Object.freeze({
        t: time,
        jd: fleet.referenceEpochJD === null ? null : fleet.referenceEpochJD + time / DAY,
        states: Object.freeze(states),
      });
    });
    const series = byCraft.map((column) => Object.freeze({
      craftId: column.craft.id,
      name: column.craft.name,
      color: column.craft.color,
      states: Object.freeze(column.states),
    }));
    return Object.freeze({
      referenceEpochJD: fleet.referenceEpochJD,
      times: Object.freeze(times),
      crafts: Object.freeze(fleet.crafts.map((craft) => Object.freeze({
        id: craft.id, name: craft.name, color: craft.color,
      }))),
      frames: Object.freeze(frames),
      series: Object.freeze(series),
    });
  }

  function relativeState(craftA, craftB, time) {
    const a = craftA.sample(time), b = craftB.sample(time);
    const dr = [b.position[0] - a.position[0], b.position[1] - a.position[1],
      b.position[2] - a.position[2]];
    const dv = [b.velocity[0] - a.velocity[0], b.velocity[1] - a.velocity[1],
      b.velocity[2] - a.velocity[2]];
    const range = Math.hypot(dr[0], dr[1], dr[2]);
    const rangeRate = range > 0
      ? (dr[0] * dv[0] + dr[1] * dv[1] + dr[2] * dv[2]) / range
      : Math.hypot(dv[0], dv[1], dv[2]);
    return Object.freeze({
      t: time,
      craftA: craftA.id,
      craftB: craftB.id,
      range,
      rangeRate,
      relativePosition: frozenVector(dr),
      relativeVelocity: frozenVector(dv),
      stateA: a,
      stateB: b,
    });
  }

  function pairFleet(craftA, craftB, options) {
    const fleet = normalizeCrafts([craftA, craftB], options);
    return { fleet, a: fleet.crafts[0], b: fleet.crafts[1] };
  }

  function makeEvaluator(a, b, limit) {
    const cache = new Map();
    let evaluations = 0;
    function evaluate(time) {
      const key = Number(time);
      if (cache.has(key)) return cache.get(key);
      if (evaluations >= limit) {
        fail("MAX_EVALUATIONS_EXCEEDED", "relative-state evaluation cap reached (" +
          limit + ")", { time, evaluations });
      }
      const value = relativeState(a, b, key);
      cache.set(key, value);
      evaluations++;
      return value;
    }
    return {
      evaluate,
      cache,
      get evaluations() { return evaluations; },
    };
  }

  function adaptiveOptions(options) {
    const maxSamples = integer(options.maxSamples, DEFAULT_MAX_SAMPLES, "maxSamples", 5,
      100001);
    const initialIntervals = integer(options.initialIntervals,
      DEFAULT_INITIAL_INTERVALS, "initialIntervals", 1, 4096);
    if (2 * initialIntervals + 1 > maxSamples) {
      fail("INVALID_ARGUMENT", "maxSamples must allow endpoints and one midpoint per " +
        "initial interval");
    }
    return {
      maxSamples,
      initialIntervals,
      maxDepth: integer(options.maxDepth, DEFAULT_MAX_DEPTH, "maxDepth", 0, 24),
      minStep: positive(options.minStep, 0, "minStep", true),
      rangeTolerance: positive(options.rangeToleranceKm === undefined
        ? options.rangeTolerance : options.rangeToleranceKm, 0.01,
      "rangeToleranceKm", true),
      relativeTolerance: positive(options.relativeTolerance, 1e-5,
        "relativeTolerance", true),
      threshold: options.thresholdKm === undefined ? null
        : positive(options.thresholdKm, 0, "thresholdKm", true),
    };
  }

  function buildAdaptiveSeries(a, b, domain, options, evaluator) {
    const config = adaptiveOptions(options);
    const start = domain[0], end = domain[1];
    if (start === end) {
      const only = evaluator.evaluate(start);
      return { samples: [only], truncated: false, config };
    }
    const base = [];
    for (let index = 0; index <= config.initialIntervals; index++) {
      const time = index === config.initialIntervals ? end
        : start + (end - start) * index / config.initialIntervals;
      base.push(evaluator.evaluate(time));
    }
    let truncated = false;

    function refine(left, right, depth) {
      const width = right.t - left.t;
      if (depth >= config.maxDepth || width <= config.minStep) return;
      if (evaluator.cache.size >= config.maxSamples) { truncated = true; return; }
      const middleTime = left.t + width / 2;
      const middle = evaluator.evaluate(middleTime);
      const chord = 0.5 * (left.range + right.range);
      const curvature = Math.abs(middle.range - chord);
      const rateCurvature = Math.abs(left.rangeRate - 2 * middle.rangeRate +
        right.rangeRate) * width / 8;
      const scale = Math.max(1, left.range, middle.range, right.range);
      const tolerance = config.rangeTolerance + config.relativeTolerance * scale;
      let subdivide = Math.max(curvature, rateCurvature) > tolerance;
      if (config.threshold !== null) {
        const insideLeft = left.range <= config.threshold;
        const insideMiddle = middle.range <= config.threshold;
        const insideRight = right.range <= config.threshold;
        if (insideLeft !== insideMiddle || insideMiddle !== insideRight) subdivide = true;
        const nearest = Math.min(Math.abs(left.range - config.threshold),
          Math.abs(middle.range - config.threshold), Math.abs(right.range - config.threshold));
        if (nearest <= 4 * tolerance) subdivide = true;
      }
      if (!subdivide) return;
      refine(left, middle, depth + 1);
      refine(middle, right, depth + 1);
    }

    for (let index = 1; index < base.length; index++) {
      refine(base[index - 1], base[index], 0);
      if (evaluator.cache.size >= config.maxSamples) truncated = true;
    }
    const samples = Array.from(evaluator.cache.values())
      .filter((sample) => sample.t >= start && sample.t <= end)
      .sort((left, right) => left.t - right.t);
    return { samples, truncated, config };
  }

  function freezeRelativeSeries(a, b, fleet, domain, built, evaluations) {
    const samples = Object.freeze(built.samples.slice());
    let minRange = Infinity, maxRange = -Infinity;
    for (const sample of samples) {
      if (sample.range < minRange) minRange = sample.range;
      if (sample.range > maxRange) maxRange = sample.range;
    }
    return Object.freeze({
      pairId: a.id + "::" + b.id,
      craftA: Object.freeze({ id: a.id, name: a.name, color: a.color }),
      craftB: Object.freeze({ id: b.id, name: b.name, color: b.color }),
      referenceEpochJD: fleet.referenceEpochJD,
      start: domain[0],
      end: domain[1],
      samples,
      times: Object.freeze(samples.map((sample) => sample.t)),
      ranges: Object.freeze(samples.map((sample) => sample.range)),
      rangeRates: Object.freeze(samples.map((sample) => sample.rangeRate)),
      minRange,
      maxRange,
      evaluations,
      truncated: built.truncated,
    });
  }

  function relativeSeries(craftA, craftB, options) {
    options = options || {};
    const pair = pairFleet(craftA, craftB, options);
    const domain = commonDomain(pair.fleet, options);
    const config = adaptiveOptions(options);
    const evaluator = makeEvaluator(pair.a, pair.b, config.maxSamples);
    const built = buildAdaptiveSeries(pair.a, pair.b, domain, options, evaluator);
    return freezeRelativeSeries(pair.a, pair.b, pair.fleet, domain, built,
      evaluator.evaluations);
  }

  function goldenMinimum(evaluator, leftTime, rightTime, options) {
    let left = leftTime, right = rightTime;
    if (right < left) { const swap = left; left = right; right = swap; }
    const timeTolerance = positive(options.timeTolerance, 1e-3,
      "timeTolerance", false);
    const maxIterations = integer(options.maxRefinementIterations, 96,
      "maxRefinementIterations", 1, 512);
    if (left === right) {
      return { state: evaluator.evaluate(left), iterations: 0, bracket: [left, right] };
    }
    let x1 = right - GOLDEN_RATIO * (right - left);
    let x2 = left + GOLDEN_RATIO * (right - left);
    let f1 = evaluator.evaluate(x1), f2 = evaluator.evaluate(x2);
    let iterations = 0;
    while (iterations < maxIterations && right - left > timeTolerance) {
      iterations++;
      if (f1.range <= f2.range) {
        right = x2;
        x2 = x1;
        f2 = f1;
        x1 = right - GOLDEN_RATIO * (right - left);
        f1 = evaluator.evaluate(x1);
      } else {
        left = x1;
        x1 = x2;
        f1 = f2;
        x2 = left + GOLDEN_RATIO * (right - left);
        f2 = evaluator.evaluate(x2);
      }
    }
    const candidates = [f1, f2, evaluator.evaluate(left), evaluator.evaluate(right)];
    candidates.sort((a, b) => a.range - b.range || a.t - b.t);
    return { state: candidates[0], iterations, bracket: [leftTime, rightTime] };
  }

  function sampledMinimumBracket(samples, start, end) {
    const eligible = samples.filter((sample) => sample.t >= start && sample.t <= end);
    if (!eligible.length) return [start, end];
    let bestIndex = 0;
    for (let index = 1; index < eligible.length; index++) {
      if (eligible[index].range < eligible[bestIndex].range) bestIndex = index;
    }
    const left = bestIndex > 0 ? eligible[bestIndex - 1].t : start;
    const right = bestIndex + 1 < eligible.length ? eligible[bestIndex + 1].t : end;
    return [Math.max(start, left), Math.min(end, right)];
  }

  function closestObject(a, b, fleet, refined, sampledRange, evaluations) {
    const state = refined.state;
    return Object.freeze({
      pairId: a.id + "::" + b.id,
      craftA: a.id,
      craftB: b.id,
      referenceEpochJD: fleet.referenceEpochJD,
      t: state.t,
      jd: fleet.referenceEpochJD === null ? null : fleet.referenceEpochJD + state.t / DAY,
      range: state.range,
      rangeRate: state.rangeRate,
      relativePosition: state.relativePosition,
      relativeVelocity: state.relativeVelocity,
      bracket: Object.freeze(refined.bracket.slice()),
      sampledRange,
      iterations: refined.iterations,
      evaluations,
    });
  }

  function findClosestApproach(craftA, craftB, options) {
    options = options || {};
    const pair = pairFleet(craftA, craftB, options);
    const domain = commonDomain(pair.fleet, options);
    const maxEvaluations = integer(options.maxEvaluations,
      DEFAULT_MAX_EVALUATIONS, "maxEvaluations", 16, 1000000);
    const evaluator = makeEvaluator(pair.a, pair.b, maxEvaluations);
    const built = buildAdaptiveSeries(pair.a, pair.b, domain, options, evaluator);
    const bracket = sampledMinimumBracket(built.samples, domain[0], domain[1]);
    let refined;
    if (bracket[0] === domain[0] && built.samples[0].range <=
        Math.min.apply(null, built.samples.slice(1).map((sample) => sample.range))) {
      refined = { state: evaluator.evaluate(domain[0]), iterations: 0,
        bracket: [domain[0], domain[0]] };
    } else if (bracket[1] === domain[1] && built.samples[built.samples.length - 1].range <=
        Math.min.apply(null, built.samples.slice(0, -1).map((sample) => sample.range))) {
      refined = { state: evaluator.evaluate(domain[1]), iterations: 0,
        bracket: [domain[1], domain[1]] };
    } else {
      refined = goldenMinimum(evaluator, bracket[0], bracket[1], options);
    }
    const sampledRange = Math.min.apply(null, built.samples.map((sample) => sample.range));
    return closestObject(pair.a, pair.b, pair.fleet, refined, sampledRange,
      evaluator.evaluations);
  }

  function thresholdRoot(evaluator, leftSample, rightSample, threshold, options) {
    let left = leftSample.t, right = rightSample.t;
    let fLeft = leftSample.range - threshold;
    let fRight = rightSample.range - threshold;
    if (fLeft === 0) return left;
    if (fRight === 0) return right;
    if ((fLeft < 0) === (fRight < 0)) {
      fail("ROOT_NOT_BRACKETED", "conjunction threshold root is not bracketed");
    }
    const tolerance = positive(options.rootTimeTolerance === undefined
      ? options.timeTolerance : options.rootTimeTolerance, 1e-3,
    "rootTimeTolerance", false);
    const iterations = integer(options.maxRootIterations, 80,
      "maxRootIterations", 1, 512);
    for (let count = 0; count < iterations && right - left > tolerance; count++) {
      const middle = left + (right - left) / 2;
      const fMiddle = evaluator.evaluate(middle).range - threshold;
      if (fMiddle === 0) return middle;
      if ((fLeft < 0) === (fMiddle < 0)) { left = middle; fLeft = fMiddle; }
      else { right = middle; fRight = fMiddle; }
    }
    return left + (right - left) / 2;
  }

  function findConjunctions(craftA, craftB, options) {
    options = options || {};
    if (options.thresholdKm === undefined || options.thresholdKm === null) {
      fail("INVALID_ARGUMENT", "thresholdKm is required");
    }
    const threshold = positive(options.thresholdKm, 0, "thresholdKm", false);
    const pair = pairFleet(craftA, craftB, options);
    const domain = commonDomain(pair.fleet, options);
    const maxEvaluations = integer(options.maxEvaluations, 20000,
      "maxEvaluations", 16, 1000000);
    const maxIntervals = integer(options.maxIntervals, 256,
      "maxIntervals", 1, 10000);
    const evaluator = makeEvaluator(pair.a, pair.b, maxEvaluations);
    const adaptiveInput = Object.assign({}, options, { thresholdKm: threshold });
    const built = buildAdaptiveSeries(pair.a, pair.b, domain, adaptiveInput, evaluator);
    const samples = built.samples;
    const boundaries = [];
    let inside = samples[0].range <= threshold;
    let entry = inside ? { t: domain[0], clipped: true } : null;
    for (let index = 1; index < samples.length; index++) {
      const nextInside = samples[index].range <= threshold;
      if (!inside && nextInside) {
        entry = { t: thresholdRoot(evaluator, samples[index - 1], samples[index],
          threshold, options), clipped: false };
      } else if (inside && !nextInside) {
        boundaries.push({ entry, exit: { t: thresholdRoot(evaluator,
          samples[index - 1], samples[index], threshold, options), clipped: false } });
        if (boundaries.length > maxIntervals) {
          fail("MAX_INTERVALS_EXCEEDED", "conjunction interval cap reached (" +
            maxIntervals + ")");
        }
        entry = null;
      }
      inside = nextInside;
    }
    if (inside) boundaries.push({ entry, exit: { t: domain[1], clipped: true } });
    if (boundaries.length > maxIntervals) {
      fail("MAX_INTERVALS_EXCEEDED", "conjunction interval cap reached (" +
        maxIntervals + ")");
    }

    const intervals = [];
    const events = [];
    boundaries.forEach((boundary, index) => {
      const bracket = sampledMinimumBracket(samples, boundary.entry.t, boundary.exit.t);
      const refined = goldenMinimum(evaluator, bracket[0], bracket[1], options);
      const closest = closestObject(pair.a, pair.b, pair.fleet, refined,
        Math.min.apply(null, samples.filter((sample) => sample.t >= boundary.entry.t &&
          sample.t <= boundary.exit.t).map((sample) => sample.range)),
      evaluator.evaluations);
      const interval = Object.freeze({
        index,
        pairId: pair.a.id + "::" + pair.b.id,
        thresholdKm: threshold,
        start: boundary.entry.t,
        end: boundary.exit.t,
        duration: boundary.exit.t - boundary.entry.t,
        startClipped: boundary.entry.clipped,
        endClipped: boundary.exit.clipped,
        closestApproach: closest,
      });
      intervals.push(interval);
      events.push(Object.freeze({ type: "conjunction-entry", t: interval.start,
        pairId: interval.pairId, interval: index, clipped: interval.startClipped,
        thresholdKm: threshold }));
      events.push(Object.freeze({ type: "closest-approach", t: closest.t,
        pairId: interval.pairId, interval: index, range: closest.range,
        rangeRate: closest.rangeRate }));
      events.push(Object.freeze({ type: "conjunction-exit", t: interval.end,
        pairId: interval.pairId, interval: index, clipped: interval.endClipped,
        thresholdKm: threshold }));
    });
    events.sort((left, right) => left.t - right.t || left.type.localeCompare(right.type));
    const series = freezeRelativeSeries(pair.a, pair.b, pair.fleet, domain, built,
      evaluator.evaluations);
    return Object.freeze({
      pairId: pair.a.id + "::" + pair.b.id,
      craftA: pair.a.id,
      craftB: pair.b.id,
      referenceEpochJD: pair.fleet.referenceEpochJD,
      thresholdKm: threshold,
      intervals: Object.freeze(intervals),
      events: Object.freeze(events),
      series,
      evaluations: evaluator.evaluations,
      truncated: built.truncated,
    });
  }

  function allPairs(crafts) {
    const pairs = [];
    for (let first = 0; first < crafts.length; first++) {
      for (let second = first + 1; second < crafts.length; second++) {
        pairs.push([crafts[first], crafts[second]]);
      }
    }
    return pairs;
  }

  function analyzeFleet(crafts, options) {
    options = options || {};
    if (!Array.isArray(crafts) || crafts.length < 2) {
      fail("INVALID_ARGUMENT", "fleet analysis requires at least two craft");
    }
    const synchronized = synchronize(crafts,
      Object.assign({}, options, options.synchronize || {}));
    const pairs = allPairs(crafts).map((pair) => {
      const pairOptions = Object.assign({}, options, options.relative || {});
      const closestApproach = findClosestApproach(pair[0], pair[1], pairOptions);
      const conjunctions = options.thresholdKm === undefined ? null
        : findConjunctions(pair[0], pair[1], pairOptions);
      return Object.freeze({
        pairId: closestApproach.pairId,
        craftA: closestApproach.craftA,
        craftB: closestApproach.craftB,
        closestApproach,
        conjunctions,
      });
    });
    return Object.freeze({
      referenceEpochJD: synchronized.referenceEpochJD,
      synchronized,
      pairs: Object.freeze(pairs),
    });
  }

  globalThis.MissionMultiCraft = Object.freeze({
    DAY,
    MAX_CRAFT,
    MAX_SYNC_SAMPLES,
    DEFAULT_MAX_SAMPLES,
    DEFAULT_INITIAL_INTERVALS,
    PALETTE,
    MultiCraftError,
    colorMetadata,
    assignColors,
    synchronize,
    relativeSeries,
    findClosestApproach,
    findConjunctions,
    analyzeFleet,
  });
})();
