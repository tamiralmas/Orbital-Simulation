/* =============================================================================
 * Mission Trajectory Planner - force-models.js
 * Adaptive inertial n-body, deterministic environment, and finite-thrust
 * spacecraft propagation.
 *
 * Catalog ephemerides remain the default; callers may instead select a
 * bounded Sun-centered MissionEphemerisTable provider. Every point mass is
 * evaluated at the derivative epoch rather than numerically advanced with
 * the spacecraft. State units are km, km/s, and (when present) kg. Time is
 * seconds from epochJD and thrust/environment properties use SI units.
 *
 * This module has no DOM dependency and is safe to load from file://.
 * ========================================================================== */
"use strict";

(function () {
  const G0_M_S2 = 9.80665;
  const DRY_EVENT_NAME = "__dry_mass_cutoff__";

  function dependencies() {
    const C = globalThis.AstroConst;
    const A = globalThis.Astro;
    const ODE = globalThis.AstroODE;
    if (!C || !A || !ODE || typeof ODE.integrate !== "function") {
      throw new Error("MissionForceModels requires AstroConst, Astro, and AstroODE.");
    }
    return { C, A, ODE, E: globalThis.MissionEnvironmentModels || null };
  }

  function finite(value, name) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(name + " must be finite.");
    return number;
  }

  function nonnegative(value, name) {
    const number = finite(value, name);
    if (number < 0) throw new Error(name + " must be non-negative.");
    return number;
  }

  function positive(value, name) {
    const number = finite(value, name);
    if (!(number > 0)) throw new Error(name + " must be positive.");
    return number;
  }

  function vector3(value, name) {
    if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== 3) {
      throw new Error(name + " must be a three-component vector.");
    }
    const out = Array.from(value, Number);
    for (let i = 0; i < 3; i++) {
      if (!Number.isFinite(out[i])) throw new Error(name + " component " + i + " is invalid.");
    }
    return out;
  }

  function magnitude(vector) {
    return Math.hypot(vector[0], vector[1], vector[2]);
  }

  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]];
  }

  function bodyFrameAngularVelocity(A, body, jd, day) {
    const halfSpanS = 30;
    const before = A.bodyFrameAt(body, jd - halfSpanS / day);
    const current = A.bodyFrameAt(body, jd);
    const after = A.bodyFrameAt(body, jd + halfSpanS / day);
    const omega = [0, 0, 0];
    for (const axis of ["x", "y", "z"]) {
      const derivative = [(after[axis][0] - before[axis][0]) / (2 * halfSpanS),
        (after[axis][1] - before[axis][1]) / (2 * halfSpanS),
        (after[axis][2] - before[axis][2]) / (2 * halfSpanS)];
      const contribution = cross(current[axis], derivative);
      omega[0] += contribution[0]; omega[1] += contribution[1];
      omega[2] += contribution[2];
    }
    return [omega[0] * 0.5, omega[1] * 0.5, omega[2] * 0.5];
  }

  function normalized(vector, name) {
    const length = magnitude(vector);
    if (!(length > 0)) throw new Error(name + " must have non-zero magnitude.");
    return [vector[0] / length, vector[1] / length, vector[2] / length];
  }

  // Astro.bodyWorld intentionally rounds its memoization key for renderer
  // throughput. Force evaluation cannot inherit that quantization because it
  // makes event functions discontinuous by tens of metres for fast bodies.
  function catalogBodyState(bodyId, jd, C, A) {
    return {
      id: bodyId,
      jd,
      r: exactBodyWorld(bodyId, jd, C, A),
      v: A.bodyWorldVel(bodyId, jd, "sun").slice(),
      source: "Mission Trajectory Planner catalog ephemeris",
    };
  }

  function exactBodyWorld(bodyId, jd, C, A) {
    const body = C.BODIES[bodyId];
    if (!body || !body.parent) return [0, 0, 0];
    const parent = exactBodyWorld(body.parent, jd, C, A);
    const local = A.bodyLocalState(bodyId, jd).r;
    return [parent[0] + local[0], parent[1] + local[1], parent[2] + local[2]];
  }

  function normalizeEphemeris(value, fallbackValue) {
    if (value === undefined || value === null) {
      return { provider: null, fallback: "catalog" };
    }
    const wrapper = value && typeof value === "object" && value.provider
      ? value : { provider: value, fallback: fallbackValue };
    const provider = wrapper.provider;
    if (!provider || typeof provider.stateAt !== "function" ||
        typeof provider.has !== "function" || !provider.metadata) {
      throw new Error("ephemerisProvider must implement has(), stateAt(), and metadata.");
    }
    const center = String(provider.metadata.center || "").toLowerCase();
    if (!center.includes("sun") && !center.includes("500@10")) {
      throw new Error("Adaptive propagation requires Sun-centered ephemeris tables.");
    }
    const frame = String(provider.metadata.frame || "").toLowerCase();
    if (!frame.includes("j2000") || !frame.includes("ecliptic")) {
      throw new Error("Adaptive propagation requires ecliptic-J2000 ephemeris vectors.");
    }
    const fallback = String(wrapper.fallback === undefined ? "strict" : wrapper.fallback)
      .toLowerCase();
    if (fallback !== "strict" && fallback !== "catalog") {
      throw new Error("ephemeris fallback must be 'strict' or 'catalog'.");
    }
    return { provider, fallback };
  }

  function bodyStateKnown(bodyId, jd, C, A, ephemeris) {
    if (ephemeris && ephemeris.provider) {
      const provider = ephemeris.provider;
      if (provider.has(bodyId)) {
        const state = provider.stateAt(bodyId, jd);
        if (!state) {
          const coverage = typeof provider.coverage === "function"
            ? provider.coverage(bodyId) : null;
          const detail = coverage ? " (coverage " + coverage.startJD + " to " +
            coverage.stopJD + ")" : "";
          throw new RangeError("Ephemeris lookup for '" + bodyId + "' at JD " + jd +
            " is outside the bounded table" + detail + ".");
        }
        return { id: bodyId, jd, r: vector3(state.r, bodyId + " ephemeris r"),
          v: vector3(state.v, bodyId + " ephemeris v"), source: state.source ||
          provider.metadata.source };
      }
      // A Sun-centered table need not waste rows storing a zero Sun state.
      if (bodyId === "sun") {
        const metadata = provider.metadata;
        if (Number.isFinite(metadata.coverageStartJD) &&
            (jd < metadata.coverageStartJD || jd > metadata.coverageStopJD)) {
          throw new RangeError("Ephemeris lookup for implicit Sun origin at JD " + jd +
            " is outside the bounded table coverage (" + metadata.coverageStartJD +
            " to " + metadata.coverageStopJD + ").");
        }
        return { id: "sun", jd, r: [0, 0, 0], v: [0, 0, 0],
          source: provider.metadata.source };
      }
      if (ephemeris.fallback !== "catalog") {
        throw new RangeError("Ephemeris provider has no bounded table for '" + bodyId + "'.");
      }
    }
    return catalogBodyState(bodyId, jd, C, A);
  }

  function bodyStateAt(bodyId, jd, ephemerisValue) {
    const { C, A } = dependencies();
    if (!C.BODIES[bodyId]) throw new Error("Unknown body '" + bodyId + "'.");
    const epoch = finite(jd, "jd");
    return bodyStateKnown(bodyId, epoch, C, A,
      normalizeEphemeris(ephemerisValue, "strict"));
  }

  function normalizeBodyIds(value) {
    const { C } = dependencies();
    const source = value === undefined ? ["sun"] : value;
    if (!Array.isArray(source)) throw new Error("bodies must be an array of body IDs.");
    const seen = new Set();
    const result = [];
    for (const entry of source) {
      const id = String(entry);
      const body = C.BODIES[id];
      if (!body) throw new Error("Unknown point-mass body '" + id + "'.");
      if (!(body.mu > 0)) throw new Error("Point-mass body '" + id + "' has no positive GM.");
      if (!seen.has(id)) {
        seen.add(id);
        result.push(id);
      }
    }
    return result;
  }

  function pointMassAccelerationKnown(r, jd, bodyIds, C, A, ephemeris) {
    const acceleration = [0, 0, 0];
    for (const id of bodyIds) {
      const bodyPosition = bodyStateKnown(id, jd, C, A, ephemeris).r;
      const dx = bodyPosition[0] - r[0];
      const dy = bodyPosition[1] - r[1];
      const dz = bodyPosition[2] - r[2];
      const distance2 = dx * dx + dy * dy + dz * dz;
      if (!(distance2 > 0)) {
        throw new Error("Spacecraft state is singular at the center of '" + id + "'.");
      }
      const scale = C.BODIES[id].mu / (distance2 * Math.sqrt(distance2));
      acceleration[0] += dx * scale;
      acceleration[1] += dy * scale;
      acceleration[2] += dz * scale;
    }
    return acceleration;
  }

  /** Inertial point-mass acceleration in km/s^2 at a catalog epoch. */
  function pointMassAcceleration(rValue, jdValue, bodyIdsValue, ephemerisValue) {
    const { C, A } = dependencies();
    const r = vector3(rValue, "r");
    const jd = finite(jdValue, "jd");
    const bodyIds = normalizeBodyIds(bodyIdsValue);
    const ephemeris = normalizeEphemeris(ephemerisValue, "strict");
    return pointMassAccelerationKnown(r, jd, bodyIds, C, A, ephemeris);
  }

  function normalizeHooks(value) {
    if (value === undefined) return [];
    const hooks = typeof value === "function" ? [value] : value;
    if (!Array.isArray(hooks) || hooks.some((hook) => typeof hook !== "function")) {
      throw new Error("extraAccelerations must be a function or an array of functions.");
    }
    return hooks.slice();
  }

  function normalizeEnvironmentOptions(options, E, C, bodyIds, mass0) {
    const hasTopLevel = options.drag !== undefined || options.srp !== undefined ||
      options.harmonics !== undefined || options.earthHarmonics !== undefined;
    const value = options.environment !== undefined ? options.environment : hasTopLevel ? {
      drag: options.drag,
      srp: options.srp,
      harmonics: options.harmonics === undefined ? options.earthHarmonics : options.harmonics,
    } : null;
    if (!value) return null;
    if (!E || typeof E.normalizeConfiguration !== "function") {
      throw new Error("Environment options require MissionEnvironmentModels.");
    }
    const result = E.normalizeConfiguration(value);
    for (const spec of [result.drag, result.harmonics]) {
      if (spec && !C.BODIES[spec.body]) {
        throw new Error("Unknown environment body '" + spec.body + "'.");
      }
    }
    if (result.srp) {
      if (!C.BODIES[result.srp.source]) {
        throw new Error("Unknown SRP source body '" + result.srp.source + "'.");
      }
      for (const id of result.srp.occultingBodies) {
        if (!C.BODIES[id]) throw new Error("Unknown SRP occulting body '" + id + "'.");
      }
    }
    if (result.harmonics && !bodyIds.includes(result.harmonics.body)) {
      throw new Error("Earth harmonics require Earth in the selected point-mass bodies.");
    }
    for (const [name, spec] of [["drag", result.drag], ["SRP", result.srp]]) {
      if (spec && !(mass0 > 0) && !(spec.massKg > 0)) {
        throw new Error(name + " requires massKg on the propagation or model options.");
      }
    }
    return result;
  }

  function normalizeThrust(value, mass0) {
    if (value === undefined || value === null) return null;
    if (typeof value !== "object") throw new Error("thrust must be an object.");
    const thrustN = nonnegative(value.thrustN === undefined ? 0 : value.thrustN,
      "thrust.thrustN");
    const ispS = thrustN > 0 ? positive(value.ispS, "thrust.ispS")
      : (value.ispS === undefined ? 1 : positive(value.ispS, "thrust.ispS"));
    const dryMassKg = value.dryMassKg === undefined ? 0
      : nonnegative(value.dryMassKg, "thrust.dryMassKg");
    if (!(mass0 > 0)) throw new Error("massKg must be positive when thrust is configured.");
    if (dryMassKg > mass0) throw new Error("thrust.dryMassKg cannot exceed massKg.");
    const startS = value.startS === undefined ? -Infinity : Number(value.startS);
    const endS = value.endS === undefined ? Infinity : Number(value.endS);
    if (Number.isNaN(startS) || Number.isNaN(endS) || startS > endS) {
      throw new Error("thrust startS/endS must define an ordered interval.");
    }
    let throttle = value.throttle === undefined ? 1 : value.throttle;
    if (typeof throttle !== "function") {
      throttle = finite(throttle, "thrust.throttle");
      if (throttle < 0 || throttle > 1) throw new Error("thrust.throttle must be in [0, 1].");
    }
    const law = String(value.directionLaw || value.direction || "prograde").toLowerCase();
    const fixedLaws = new Set(["inertial", "inertial-fixed", "fixed"]);
    const velocityLaws = new Set(["prograde", "velocity"]);
    if (!fixedLaws.has(law) && !velocityLaws.has(law) && law !== "retrograde" &&
        typeof value.directionFunction !== "function") {
      throw new Error("Unsupported thrust direction law '" + law + "'.");
    }
    let fixedDirection = null;
    if (fixedLaws.has(law)) {
      fixedDirection = normalized(vector3(value.vector || value.fixedDirection,
        "thrust.vector"), "thrust.vector");
    }
    if (value.relativeTo !== undefined) normalizeBodyIds([value.relativeTo]);
    return {
      thrustN,
      ispS,
      dryMassKg,
      startS,
      endS,
      throttle,
      law,
      fixedDirection,
      relativeTo: value.relativeTo === undefined ? null : String(value.relativeTo),
      directionFunction: typeof value.directionFunction === "function"
        ? value.directionFunction : null,
    };
  }

  function throttleAt(thrust, snapshot) {
    if (snapshot.t < thrust.startS || snapshot.t > thrust.endS) return 0;
    const value = typeof thrust.throttle === "function"
      ? Number(thrust.throttle(snapshot)) : thrust.throttle;
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error("thrust.throttle returned a value outside [0, 1].");
    }
    return value;
  }

  function thrustDirection(thrust, snapshot) {
    if (thrust.directionFunction) {
      return normalized(vector3(thrust.directionFunction(snapshot),
        "thrust.directionFunction result"), "thrust.directionFunction result");
    }
    if (thrust.fixedDirection) return thrust.fixedDirection;
    let velocity = snapshot.v;
    if (thrust.relativeTo) {
      const referenceVelocity = snapshot.bodyState(thrust.relativeTo).v;
      velocity = [snapshot.v[0] - referenceVelocity[0],
        snapshot.v[1] - referenceVelocity[1], snapshot.v[2] - referenceVelocity[2]];
    }
    let direction = normalized(velocity, "velocity for thrust direction");
    if (thrust.law === "retrograde") direction = direction.map((component) => -component);
    return direction;
  }

  function buildSnapshot(t, y, context) {
    const r = y.slice(0, 3);
    const v = y.slice(3, 6);
    return {
      t,
      jd: context.epochJD + t / context.day,
      r,
      v,
      massKg: y.length > 6 ? y[6] : null,
      bodies: context.bodyIds.slice(),
      bodyState: (id) => {
        if (!context.C.BODIES[id]) throw new Error("Unknown body '" + id + "'.");
        const jd = context.epochJD + t / context.day;
        return bodyStateKnown(id, jd, context.C, context.A, context.ephemeris);
      },
    };
  }

  function environmentAcceleration(snapshot, context) {
    const environment = context.environment;
    if (!environment || (!environment.drag && !environment.srp && !environment.harmonics)) {
      return [0, 0, 0];
    }
    const E = context.E;
    const acceleration = [0, 0, 0];
    const add = (value) => {
      acceleration[0] += value[0];
      acceleration[1] += value[1];
      acceleration[2] += value[2];
    };
    if (environment.harmonics) {
      const spec = environment.harmonics;
      const body = context.C.BODIES[spec.body];
      const center = snapshot.bodyState(spec.body);
      const relative = [snapshot.r[0] - center.r[0], snapshot.r[1] - center.r[1],
        snapshot.r[2] - center.r[2]];
      const frame = context.A.bodyFrameAt(body, snapshot.jd);
      add(E.earthZonalAcceleration(relative, {
        degree: spec.degree,
        mu: body.mu,
        radiusKm: spec.radiusKm,
        pole: frame.z,
        coefficients: spec.coefficients,
      }));
    }
    if (environment.drag) {
      const spec = environment.drag;
      const body = context.C.BODIES[spec.body];
      const center = snapshot.bodyState(spec.body);
      const frame = context.A.bodyFrameAt(body, snapshot.jd);
      add(E.dragAcceleration({
        r: snapshot.r,
        v: snapshot.v,
        massKg: snapshot.massKg,
        bodyR: center.r,
        bodyV: center.v,
        bodyRadiusKm: spec.radiusKm === undefined ? E.EARTH_EQUATORIAL_RADIUS_KM
          : spec.radiusKm,
        rotHours: body.rotHours,
        pole: frame.z,
        angularVelocityRadS: bodyFrameAngularVelocity(context.A, body,
          snapshot.jd, context.day),
      }, spec));
    }
    if (environment.srp) {
      const spec = environment.srp;
      const sourceBody = context.C.BODIES[spec.source];
      const sun = snapshot.bodyState(spec.source);
      const occultors = spec.occultingBodies.filter((id) => id !== spec.source).map((id) => {
        const body = context.C.BODIES[id];
        return { id, r: snapshot.bodyState(id).r, radiusKm: body.radius };
      });
      add(E.solarRadiationPressureAcceleration({
        r: snapshot.r,
        massKg: snapshot.massKg,
        sunR: sun.r,
        sunRadiusKm: sourceBody.radius,
        occultors,
      }, spec));
    }
    return acceleration;
  }

  function derivative(t, y, context) {
    const snapshot = buildSnapshot(t, y, context);
    const gravity = pointMassAccelerationKnown(snapshot.r, snapshot.jd, context.bodyIds,
      context.C, context.A, context.ephemeris);
    const acceleration = gravity;
    const environment = environmentAcceleration(snapshot, context);
    acceleration[0] += environment[0];
    acceleration[1] += environment[1];
    acceleration[2] += environment[2];
    for (const hook of context.hooks) {
      const extra = vector3(hook(snapshot), "extra acceleration");
      acceleration[0] += extra[0];
      acceleration[1] += extra[1];
      acceleration[2] += extra[2];
    }

    let massRate = 0;
    const thrust = context.thrust;
    if (thrust && !context.thrustDisabled && thrust.thrustN > 0 &&
        snapshot.massKg > thrust.dryMassKg) {
      const throttle = throttleAt(thrust, snapshot);
      if (throttle > 0) {
        const forceN = thrust.thrustN * throttle;
        const direction = thrustDirection(thrust, snapshot);
        const thrustAcceleration = forceN / (snapshot.massKg * 1000);
        acceleration[0] += direction[0] * thrustAcceleration;
        acceleration[1] += direction[1] * thrustAcceleration;
        acceleration[2] += direction[2] * thrustAcceleration;
        massRate = -forceN / (thrust.ispS * G0_M_S2);
      }
    }
    const result = [snapshot.v[0], snapshot.v[1], snapshot.v[2],
      acceleration[0], acceleration[1], acceleration[2]];
    if (y.length > 6) result.push(massRate);
    return result;
  }

  function normalizeCollisionEvents(value, bodyIds, epochJD, day, ephemeris) {
    const { C, A } = dependencies();
    if (value === undefined || value === false) return [];
    const entries = value === true ? bodyIds : value;
    if (!Array.isArray(entries)) throw new Error("collisionBodies must be true or an array.");
    return entries.map((entry) => {
      const spec = typeof entry === "string" ? { body: entry } : entry;
      if (!spec || typeof spec !== "object") throw new Error("Invalid collision event.");
      const id = String(spec.body || spec.id || "");
      const body = C.BODIES[id];
      if (!body) throw new Error("Unknown collision body '" + id + "'.");
      const altitudeKm = spec.altitudeKm === undefined ? 0
        : nonnegative(spec.altitudeKm, "collision altitudeKm");
      const radius = body.radius + altitudeKm;
      return {
        name: "collision:" + id,
        direction: -1,
        terminal: spec.terminal === undefined ? true : Boolean(spec.terminal),
        fn: (t, y) => {
          const center = bodyStateKnown(id, epochJD + t / day, C, A, ephemeris).r;
          return Math.hypot(y[0] - center[0], y[1] - center[1], y[2] - center[2]) - radius;
        },
      };
    });
  }

  function normalizeSoiEvents(value, epochJD, day, ephemeris) {
    const { C, A } = dependencies();
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error("soiEvents must be an array.");
    return value.map((entry) => {
      const spec = typeof entry === "string" ? { body: entry } : entry;
      if (!spec || typeof spec !== "object") throw new Error("Invalid SOI event.");
      const id = String(spec.body || spec.id || "");
      const body = C.BODIES[id];
      if (!body || !Number.isFinite(body.soi)) {
        throw new Error("SOI event body '" + id + "' has no finite sphere of influence.");
      }
      const crossing = String(spec.crossing || spec.mode || "either").toLowerCase();
      const direction = crossing === "exit" ? 1 : crossing === "enter" ? -1 :
        crossing === "either" ? 0 : NaN;
      if (!Number.isFinite(direction)) throw new Error("SOI crossing must be enter, exit, or either.");
      return {
        name: "soi:" + id + ":" + crossing,
        direction,
        terminal: spec.terminal === undefined ? true : Boolean(spec.terminal),
        fn: (t, y) => {
          const center = bodyStateKnown(id, epochJD + t / day, C, A, ephemeris).r;
          return Math.hypot(y[0] - center[0], y[1] - center[1], y[2] - center[2]) - body.soi;
        },
      };
    });
  }

  function normalizeUserEvents(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error("events must be an array.");
    return value.slice();
  }

  function generatedOutputTimes(t0, t1, step) {
    const spacing = positive(step, "outputStep");
    const direction = t1 >= t0 ? 1 : -1;
    const span = Math.abs(t1 - t0);
    const count = Math.floor(span / spacing + 32 * Number.EPSILON * Math.max(1, span / spacing));
    const times = [];
    for (let index = 0; index <= count; index++) times.push(t0 + direction * index * spacing);
    const tolerance = 32 * Number.EPSILON * Math.max(1, span);
    if (Math.abs(times[times.length - 1] - t1) <= tolerance) times[times.length - 1] = t1;
    else times.push(t1);
    return times;
  }

  function normalizeRequestedTimes(options, t0, t1) {
    if (options.outputTimes !== undefined && options.outputStep !== undefined) {
      throw new Error("Use either outputTimes or outputStep, not both.");
    }
    if (options.outputStep !== undefined) return generatedOutputTimes(t0, t1, options.outputStep);
    if (options.outputTimes === undefined) return null;
    if (!Array.isArray(options.outputTimes) && !ArrayBuffer.isView(options.outputTimes)) {
      throw new Error("outputTimes must be a numeric vector.");
    }
    const direction = t1 >= t0 ? 1 : -1;
    const times = Array.from(options.outputTimes, Number);
    times.forEach((time, index) => {
      if (!Number.isFinite(time)) throw new Error("outputTimes component " + index + " is invalid.");
      if (direction * (time - t0) < 0 || direction * (time - t1) > 0) {
        throw new Error("outputTimes must stay inside the propagation interval.");
      }
      if (index > 0 && direction * (time - times[index - 1]) < 0) {
        throw new Error("outputTimes must be monotonic in the propagation direction.");
      }
    });
    return times;
  }

  function phaseOutputTimes(requested, start, end, direction) {
    if (requested === null) return null;
    const tolerance = 32 * Number.EPSILON * Math.max(1, Math.abs(start), Math.abs(end));
    return requested.filter((time) => direction * (time - start) >= -tolerance &&
      direction * (time - end) <= tolerance);
  }

  function appendPoint(times, states, time, state) {
    const last = times.length - 1;
    const tolerance = 32 * Number.EPSILON * Math.max(1, Math.abs(time),
      last >= 0 ? Math.abs(times[last]) : 0);
    if (last >= 0 && Math.abs(times[last] - time) <= tolerance) {
      times[last] = time;
      states[last] = state.slice();
      return;
    }
    times.push(time);
    states.push(state.slice());
  }

  function propagationOptions(options, outputTimes, events, context) {
    const pass = { context, events };
    const names = ["rtol", "atol", "minStep", "maxStep", "initialStep", "maxSteps",
      "maxRejectedSteps", "maxOutputPoints", "maxEvents", "maxEvaluations",
      "maxEventIterations", "eventTimeTolerance"];
    for (const name of names) if (options[name] !== undefined) pass[name] = options[name];
    if (outputTimes !== null) pass.outputTimes = outputTimes;
    return pass;
  }

  function segmentBoundaries(t0, t1, thrust) {
    const direction = t1 >= t0 ? 1 : -1;
    const points = [t0, t1];
    if (thrust) {
      for (const value of [thrust.startS, thrust.endS]) {
        if (Number.isFinite(value) && direction * (value - t0) > 0 &&
            direction * (value - t1) < 0) points.push(value);
      }
    }
    points.sort((a, b) => direction * (a - b));
    return points.filter((value, index) => index === 0 || value !== points[index - 1]);
  }

  /**
   * Propagate a heliocentric-inertial spacecraft state.
   *
   * Required: epochJD, r0[3], v0[3], and durationS (or t0S/t1S).
   * `bodies` selects catalog point masses. Finite thrust adds massKg and a
   * thrust object. `environment` selects bounded drag, SRP, or Earth J2-J4;
   * `ephemerisProvider` selects offline tables and fails closed at coverage.
   * Samples always include exact phase/cutoff endpoints in addition to any
   * requested output epochs.
   */
  function propagate(options) {
    const { C, A, ODE, E } = dependencies();
    if (!options || typeof options !== "object") throw new Error("Propagation options are required.");
    const epochJD = finite(options.epochJD, "epochJD");
    const t0 = options.t0S === undefined ? 0 : finite(options.t0S, "t0S");
    const t1 = options.t1S !== undefined ? finite(options.t1S, "t1S")
      : t0 + finite(options.durationS, "durationS");
    const direction = t1 >= t0 ? 1 : -1;
    const r0 = vector3(options.r0, "r0");
    const v0 = vector3(options.v0, "v0");
    const bodyIds = normalizeBodyIds(options.bodies);
    const hooks = normalizeHooks(options.extraAccelerations);
    const hasMass = options.massKg !== undefined || options.thrust !== undefined;
    const mass0 = hasMass ? positive(options.massKg, "massKg") : null;
    const thrust = normalizeThrust(options.thrust, mass0);
    const ephemeris = normalizeEphemeris(options.ephemerisProvider === undefined
      ? options.ephemeris : options.ephemerisProvider, options.ephemerisFallback);
    const environment = normalizeEnvironmentOptions(options, E, C, bodyIds, mass0);
    const state0 = r0.concat(v0);
    if (hasMass) state0.push(mass0);
    const context = {
      epochJD,
      day: C.DAY,
      C,
      A,
      bodyIds,
      hooks,
      ephemeris,
      environment,
      E,
      thrust,
      thrustDisabled: false,
    };

    const collisionValue = options.collisionBodies !== undefined
      ? options.collisionBodies : options.collisions;
    const userEvents = normalizeUserEvents(options.events);
    const physicalEvents = normalizeCollisionEvents(collisionValue, bodyIds, epochJD, C.DAY,
      ephemeris).concat(normalizeSoiEvents(options.soiEvents, epochJD, C.DAY, ephemeris));
    const dryEvent = thrust && direction > 0 && thrust.thrustN > 0 &&
      thrust.dryMassKg < mass0 ? {
        name: DRY_EVENT_NAME,
        direction: -1,
        terminal: true,
        fn: (t, y) => y[6] - thrust.dryMassKg,
      } : null;
    const requestedTimes = normalizeRequestedTimes(options, t0, t1);
    const boundaries = segmentBoundaries(t0, t1, thrust);
    const outputT = [];
    const outputY = [];
    const events = [];
    const stats = { attemptedSteps: 0, acceptedSteps: 0, rejectedSteps: 0,
      rhsEvaluations: 0, eventEvaluations: 0 };
    appendPoint(outputT, outputY, t0, state0);

    let currentT = t0;
    let currentState = state0.slice();
    let boundaryIndex = 1;
    let fuelDepleted = false;
    let status = "finished";
    let message = "Propagation reached t1.";
    while (direction * (t1 - currentT) > 0) {
      let phaseEnd = boundaries[Math.min(boundaryIndex, boundaries.length - 1)];
      if (direction * (phaseEnd - currentT) <= 0) {
        boundaryIndex++;
        continue;
      }
      const odeEvents = userEvents.concat(physicalEvents);
      if (dryEvent && !fuelDepleted) odeEvents.push(dryEvent);
      const outputs = phaseOutputTimes(requestedTimes, currentT, phaseEnd, direction);
      const result = ODE.integrate(derivative, currentT, currentState, phaseEnd,
        propagationOptions(options, outputs, odeEvents, context));
      for (let i = 0; i < result.t.length; i++) appendPoint(outputT, outputY,
        result.t[i], result.y[i]);
      appendPoint(outputT, outputY, result.tFinal, result.yFinal);
      for (const occurrence of result.events) {
        events.push(Object.assign({}, occurrence, { y: occurrence.y.slice(),
          type: occurrence.name === DRY_EVENT_NAME ? "dry-mass-cutoff" : "terminal" }));
      }
      for (const key of Object.keys(stats)) stats[key] += result.stats[key];
      currentT = result.tFinal;
      currentState = result.yFinal.slice();

      if (result.status === "event") {
        const atCutoff = result.events.some((event) => event.name === DRY_EVENT_NAME &&
          Math.abs(event.t - result.tFinal) <= Math.max(1e-9,
            32 * Number.EPSILON * Math.abs(result.tFinal)));
        const otherTerminal = result.events.some((event) => event.terminal &&
          event.name !== DRY_EVENT_NAME && Math.abs(event.t - result.tFinal) <= Math.max(1e-9,
            32 * Number.EPSILON * Math.abs(result.tFinal)));
        if (atCutoff && !otherTerminal) {
          fuelDepleted = true;
          context.thrustDisabled = true;
          currentState[6] = thrust.dryMassKg;
          outputY[outputY.length - 1][6] = thrust.dryMassKg;
          continue;
        }
        status = "event";
        message = "A terminal event stopped the propagation.";
        break;
      }
      boundaryIndex++;
    }

    const samples = outputT.map((time, index) => {
      const state = outputY[index];
      return {
        t: time,
        jd: epochJD + time / C.DAY,
        r: state.slice(0, 3),
        v: state.slice(3, 6),
        massKg: state.length > 6 ? state[6] : null,
      };
    });
    const finalState = currentState.slice();
    const propellantUsedKg = hasMass ? Math.max(0, mass0 - finalState[6]) : 0;
    return {
      success: true,
      status,
      message,
      epochJD,
      t: outputT,
      y: outputY,
      tFinal: currentT,
      yFinal: finalState,
      rFinal: finalState.slice(0, 3),
      vFinal: finalState.slice(3, 6),
      massFinalKg: hasMass ? finalState[6] : null,
      samples,
      events,
      stats,
      pointMassBodies: bodyIds.slice(),
      ephemerisMetadata: ephemeris.provider ? ephemeris.provider.metadata : Object.freeze({
        source: "Mission Trajectory Planner catalog ephemeris",
        interpolation: "catalog analytic elements",
        extrapolation: "catalog validity limits apply",
      }),
      ephemerisFallback: ephemeris.fallback,
      environmentModels: environment,
      propellantUsedKg,
      dryMassReached: fuelDepleted,
    };
  }

  function propagateFiniteThrust(options) {
    if (!options || !options.thrust) throw new Error("propagateFiniteThrust requires thrust options.");
    return propagate(options);
  }

  function osculatingElementsRelative(sample, bodyId, ephemerisValue) {
    const { C, A } = dependencies();
    const body = C.BODIES[bodyId];
    if (!body) throw new Error("Unknown reference body '" + bodyId + "'.");
    if (!sample || !Number.isFinite(sample.jd)) throw new Error("sample.jd is required.");
    const r = vector3(sample.r, "sample.r");
    const v = vector3(sample.v, "sample.v");
    const center = bodyStateKnown(bodyId, sample.jd, C, A,
      normalizeEphemeris(ephemerisValue, "strict"));
    const centerR = center.r;
    const centerV = center.v;
    return A.rvToCoe([r[0] - centerR[0], r[1] - centerR[1], r[2] - centerR[2]],
      [v[0] - centerV[0], v[1] - centerV[1], v[2] - centerV[2]], body.mu);
  }

  globalThis.MissionForceModels = {
    G0_M_S2,
    bodyStateAt,
    pointMassAcceleration,
    normalizeEphemeris,
    propagate,
    propagateInertial: propagate,
    propagateFiniteThrust,
    osculatingElementsRelative,
  };
})();
