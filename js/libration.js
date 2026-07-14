/* =============================================================================
 * Mission Trajectory Planner — libration.js
 * Validated libration-region design tools on top of CR3BP + AstroODE.
 *
 * Periodic Lyapunov and halo states are single-shooting solutions corrected at
 * the y=0 symmetry crossing with a propagated state-transition matrix (STM).
 * Lissajous output is deliberately labelled as a bounded linear seed, not a
 * corrected periodic orbit. Stationkeeping is a deterministic ideal impulsive
 * reference tracker, not an operational guidance law.
 * ========================================================================== */
"use strict";

(function () {
  const R = globalThis.CR3BP;
  const ODE = globalThis.AstroODE;
  if (!R) throw new Error("libration.js requires cr3bp.js to be loaded first.");
  if (!ODE || typeof ODE.integrate !== "function")
    throw new Error("libration.js requires ode.js to be loaded first.");

  class LibrationError extends Error {
    constructor(code, message, details) {
      super(message);
      this.name = "LibrationError";
      this.code = code;
      if (details) Object.assign(this, details);
    }
  }

  const bifurcationCache = new WeakMap();

  /* Reviewed continuation warm starts for the four selectable CR3BP
   * system/point pairs.  These are the vertical-critical planar members
   * produced by haloBifurcation's full STM continuation with the reviewed
   * constants.  They only skip that deterministic 0.6-1.8 s discovery scan;
   * every requested halo member is still differentially corrected and
   * independently closure-checked below.  Custom solver tolerances and
   * noCache:true deliberately retain the full continuation path. */
  const REVIEWED_BIFURCATIONS = Object.freeze({
    "earth-moon|L1": Object.freeze({
      amplitudeFraction: 0.08960341230928529,
      state: Object.freeze([0.8233909065526498, 0, 0, 0, 0.12632639833884982, 0]),
      halfPeriod: 1.371497041599699,
      verticalCriticalResidual: -3.1829365532143328e-12,
    }),
    "earth-moon|L2": Object.freeze({
      amplitudeFraction: 0.2103041480578368,
      state: Object.freeze([1.120386237388089, 0, 0, 0, 0.17604041467562132, 0]),
      halfPeriod: 1.707765439322294,
      verticalCriticalResidual: 5.480837138305272e-12,
    }),
    "sun-earth|L1": Object.freeze({
      amplitudeFraction: 0.11536213668884855,
      state: Object.freeze([0.9888763868585311, 0, 0, 0, 0.008798187212331639, 0]),
      halfPeriod: 1.530121265247863,
      verticalCriticalResidual: -5.348681567096669e-12,
    }),
    "sun-earth|L2": Object.freeze({
      amplitudeFraction: 0.16456712943692636,
      state: Object.freeze([1.0083823364567093, 0, 0, 0, 0.009751563960563973, 0]),
      halfPeriod: 1.5512619287353515,
      verticalCriticalResidual: -1.4069674245109631e-11,
    }),
  });

  function fail(code, message, details) {
    throw new LibrationError(code, message, details);
  }

  function finite(value, name) {
    const number = Number(value);
    if (!Number.isFinite(number)) fail("INVALID_ARGUMENT", `${name} must be finite.`);
    return number;
  }

  function positive(value, fallback, name, allowZero) {
    if (value === undefined) return fallback;
    const number = finite(value, name);
    if (allowZero ? number < 0 : number <= 0)
      fail("INVALID_ARGUMENT", `${name} must be ${allowZero ? "non-negative" : "positive"}.`);
    return number;
  }

  function integer(value, fallback, name, minimum) {
    if (value === undefined) return fallback;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < minimum)
      fail("INVALID_ARGUMENT", `${name} must be an integer >= ${minimum}.`);
    return number;
  }

  function stateVector(value, name) {
    if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== 6)
      fail("INVALID_ARGUMENT", `${name} must contain exactly six values.`);
    const out = Array.from(value, Number);
    if (!out.every(Number.isFinite))
      fail("INVALID_ARGUMENT", `${name} must contain exactly six finite values.`);
    return out;
  }

  function resolveSystem(system) {
    if (typeof system === "string") system = R.getSystem(system);
    if (!system || !(system.distanceKm > 0) || !(system.timeUnitS > 0) ||
      !(system.mu > 0))
      fail("INVALID_ARGUMENT", "A dimensional CR3BP system definition is required.");
    return system;
  }

  function pointName(value) {
    const name = String(value || "").toUpperCase();
    if (name !== "L1" && name !== "L2")
      fail("INVALID_ARGUMENT", "Periodic libration families currently support L1 or L2.");
    return name;
  }

  function norm(values) {
    let sum = 0;
    for (const value of values) sum += value * value;
    return Math.sqrt(sum);
  }

  function difference(left, right) {
    return left.map((value, index) => value - right[index]);
  }

  function scaledAdd(left, right, scale) {
    return left.map((value, index) => value + scale * right[index]);
  }

  /** Center-mode frequencies and eigenvector ratios at a collinear point. */
  function linearModes(systemValue, pointValue) {
    const system = resolveSystem(systemValue);
    const point = pointName(pointValue);
    const x = R.equilibriumPoint(system, point).x;
    const h = R.potentialHessian(system, [x, 0, 0]);
    const a = 4 - h[0][0] - h[1][1];
    const b = h[0][0] * h[1][1];
    const discriminant = a * a - 4 * b;
    if (!(discriminant > 0))
      fail("MODE_FAILURE", `${system.name} ${point} has no real planar center mode.`);
    const lambdaSquaredStable = 0.5 * (-a - Math.sqrt(discriminant));
    if (!(lambdaSquaredStable < 0) || !(h[2][2] < 0))
      fail("MODE_FAILURE", `${system.name} ${point} center frequencies are not real.`);
    const planarFrequency = Math.sqrt(-lambdaSquaredStable);
    const verticalFrequency = Math.sqrt(-h[2][2]);
    const yPerX = -(planarFrequency * planarFrequency + h[0][0]) /
      (2 * planarFrequency);
    return Object.freeze({
      point,
      equilibriumX: x,
      planarFrequency,
      planarPeriod: 2 * Math.PI / planarFrequency,
      verticalFrequency,
      verticalPeriod: 2 * Math.PI / verticalFrequency,
      yPerX,
      vyPerX: yPerX * planarFrequency,
      hessian: h.map((row) => Object.freeze(row.slice())),
    });
  }

  function augmentedInitial(state) {
    const out = state.slice();
    for (let row = 0; row < 6; row++)
      for (let column = 0; column < 6; column++)
        out.push(row === column ? 1 : 0);
    return out;
  }

  function augmentedDerivative(t, augmented, system) {
    const derivative = R.derivatives(system, augmented);
    const matrix = R.jacobian(system, augmented);
    for (let row = 0; row < 6; row++) {
      for (let column = 0; column < 6; column++) {
        let value = 0;
        for (let k = 0; k < 6; k++)
          value += matrix[row][k] * augmented[6 + k * 6 + column];
        derivative.push(value);
      }
    }
    return derivative;
  }

  function correctionIntegratorOptions(system, extra) {
    return Object.assign({
      context: system,
      rtol: 2e-11,
      atol: 2e-13,
      maxStep: 0.015,
      maxSteps: 200000,
      maxEvaluations: 2000000,
    }, extra || {});
  }

  /** Propagate the state + STM to the next opposite-direction y=0 crossing. */
  function symmetryCrossing(systemValue, initialState, options) {
    const system = resolveSystem(systemValue);
    const state = stateVector(initialState, "initialState");
    options = options || {};
    if (Math.abs(state[1]) > 1e-12 || Math.abs(state[3]) > 1e-10 ||
      Math.abs(state[5]) > 1e-10)
      fail("INVALID_SYMMETRY_STATE",
        "A symmetry-crossing solve needs y=vx=vz=0 initially.");
    if (Math.abs(state[4]) < 1e-12)
      fail("INVALID_SYMMETRY_STATE", "Initial vy is too small to select a crossing direction.");

    const maxTime = positive(options.maxTime, 8, "maxTime", false);
    const kickTime = Math.min(1e-5, maxTime * 1e-5);
    let first;
    try {
      first = ODE.integrate(augmentedDerivative, 0, augmentedInitial(state), kickTime,
        correctionIntegratorOptions(system, { outputTimes: [kickTime] }));
    } catch (error) {
      fail("INTEGRATION_FAILURE", "STM propagation failed before the first symmetry crossing.",
        { cause: error });
    }
    let crossing;
    try {
      crossing = ODE.integrate(augmentedDerivative, kickTime, first.yFinal, maxTime,
        correctionIntegratorOptions(system, {
          events: [{
            name: "opposite y=0 symmetry crossing",
            fn: (time, value) => value[1],
            direction: state[4] > 0 ? -1 : 1,
            terminal: true,
          }],
          eventTimeTolerance: 2e-12,
        }));
    } catch (error) {
      fail("INTEGRATION_FAILURE", "STM propagation failed while seeking a symmetry crossing.",
        { cause: error });
    }
    if (crossing.status !== "event" || !(crossing.tFinal > kickTime))
      fail("NO_SYMMETRY_CROSSING", "No opposite-direction y=0 crossing was found.");

    const augmented = crossing.yFinal;
    const finalState = augmented.slice(0, 6);
    const stm = Array.from({ length: 6 }, (_, row) =>
      augmented.slice(6 + row * 6, 12 + row * 6));
    const flow = R.derivatives(system, finalState);
    if (Math.abs(flow[1]) < 1e-10)
      fail("SINGULAR_CORRECTION", "The symmetry crossing is tangent to y=0.");

    // Event-time correction: dt_f/dp = -Phi_y,p / ydot_f.  This is the
    // crossing-time sensitivity used by both Lyapunov and halo shooting.
    const sensitivity = (stateIndex, parameterIndex) =>
      stm[stateIndex][parameterIndex] -
      flow[stateIndex] * stm[1][parameterIndex] / flow[1];
    return {
      time: crossing.tFinal,
      state: finalState,
      stm,
      flow,
      sensitivity,
      stats: crossing.stats,
    };
  }

  function correctedPlanarState(system, point, x0, vySeed, options) {
    options = options || {};
    const tolerance = positive(options.correctionTolerance, 3e-10,
      "correctionTolerance", false);
    const maxIterations = integer(options.maxCorrectionIterations, 18,
      "maxCorrectionIterations", 1);
    let state = [x0, 0, 0, 0, vySeed, 0];
    let measurement = null;
    let totalIterations = 0;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      measurement = symmetryCrossing(system, state, options);
      totalIterations++;
      const residual = Math.abs(measurement.state[3]);
      if (residual <= tolerance)
        return { state, crossing: measurement, iterations: totalIterations, residual };
      const derivative = measurement.sensitivity(3, 4);
      if (!Number.isFinite(derivative) || Math.abs(derivative) < 1e-10)
        fail("SINGULAR_CORRECTION", `${system.name} ${point} planar correction is singular.`);
      let delta = -measurement.state[3] / derivative;
      const cap = 0.45 * Math.max(Math.abs(state[4]), 1e-4);
      if (Math.abs(delta) > cap) delta = Math.sign(delta) * cap;

      let accepted = null;
      for (const scale of [1, 0.5, 0.25, 0.125, 0.0625]) {
        const trial = state.slice();
        trial[4] += scale * delta;
        if (!(trial[4] > 1e-10)) continue;
        try {
          const candidate = symmetryCrossing(system, trial, options);
          if (Math.abs(candidate.state[3]) < residual) {
            accepted = { state: trial, measurement: candidate };
            break;
          }
        } catch (error) {
          if (!(error instanceof LibrationError)) throw error;
        }
      }
      if (!accepted)
        fail("CORRECTION_DIVERGED", `${system.name} ${point} planar correction did not descend.`,
          { residual, iterations: totalIterations });
      state = accepted.state;
      measurement = accepted.measurement;
      if (Math.abs(measurement.state[3]) <= tolerance)
        return { state, crossing: measurement, iterations: totalIterations, residual:
          Math.abs(measurement.state[3]) };
    }
    fail("CORRECTION_DID_NOT_CONVERGE", `${system.name} ${point} planar correction exceeded its iteration cap.`,
      { iterations: totalIterations, residual: measurement && Math.abs(measurement.state[3]) });
  }

  function planarSeed(system, point, xAmplitude, vySeed, options) {
    const modes = linearModes(system, point);
    const amplitude = Math.abs(xAmplitude);
    const x0 = modes.equilibriumX - amplitude; // reviewed primary-side branch
    const seed = vySeed === undefined ? modes.vyPerX * (-amplitude) : vySeed;
    if (!(seed > 0))
      fail("INVALID_ARGUMENT", "The primary-side Lyapunov seed must have positive vy.");
    return correctedPlanarState(system, point, x0, seed, options);
  }

  function orbitScales(system, point) {
    const equilibrium = R.equilibriumPoint(system, point);
    const gamma = Math.abs(equilibrium.x - system.secondaryX);
    return { equilibrium, gamma };
  }

  function selectedAmplitude(system, point, options, kind) {
    const scales = orbitScales(system, point);
    if (options.amplitudeKm !== undefined)
      return positive(options.amplitudeKm, 0, "amplitudeKm", false) / system.distanceKm;
    if (options.amplitude !== undefined)
      return positive(options.amplitude, 0, "amplitude", false);
    const size = options.size === undefined ? "small" : String(options.size).toLowerCase();
    const fractions = kind === "halo"
      ? { small: 0.06, medium: 0.15 }
      // 0.08 gamma fails the reviewed Sun-Earth L1 primary-side branch;
      // 0.06 remains inside the converged continuation envelope for every
      // selectable Sun-Earth/Earth-Moon L1/L2 combination.
      : { small: 0.04, medium: 0.06 };
    if (!(size in fractions))
      fail("INVALID_ARGUMENT", "size must be 'small' or 'medium'.");
    return fractions[size] * scales.gamma;
  }

  function sampleCorrectedOrbit(system, initialState, period, options) {
    const sampleCount = integer(options.sampleCount, 241, "sampleCount", 9);
    const times = Array.from({ length: sampleCount }, (_, index) =>
      period * index / (sampleCount - 1));
    let result;
    try {
      result = ODE.integrate((time, state) => R.derivatives(system, state),
        0, initialState, period, {
          rtol: 1e-11,
          atol: 1e-13,
          maxStep: Math.min(0.015, period / 120),
          maxSteps: 200000,
          maxEvaluations: 1500000,
          outputTimes: times,
        });
    } catch (error) {
      fail("INTEGRATION_FAILURE", "Full-period libration-orbit validation failed.",
        { cause: error });
    }
    const jacobi0 = R.jacobiConstant(system, initialState);
    let minJacobi = Infinity, maxJacobi = -Infinity;
    for (const state of result.y) {
      const value = R.jacobiConstant(system, state);
      minJacobi = Math.min(minJacobi, value);
      maxJacobi = Math.max(maxJacobi, value);
    }
    const closureVector = difference(result.yFinal, initialState);
    return {
      times: result.t,
      states: result.y,
      finalState: result.yFinal,
      closureVector,
      closureError: norm(closureVector),
      positionClosureError: norm(closureVector.slice(0, 3)),
      velocityClosureError: norm(closureVector.slice(3)),
      jacobi: jacobi0,
      jacobiDrift: maxJacobi - minJacobi,
      integrationStats: result.stats,
    };
  }

  function periodicResult(system, point, family, size, correction, options) {
    const period = 2 * correction.crossing.time;
    const validation = sampleCorrectedOrbit(system, correction.state, period, options);
    const warning = `${point} periodic orbits are linearly unstable in the ideal CR3BP and require stationkeeping in practice.`;
    return Object.freeze({
      type: "differentially-corrected-periodic-orbit",
      family,
      size,
      model: "ideal-cr3bp",
      periodicClaim: true,
      correctionMethod: "STM single shooting with y=0 crossing-time sensitivity",
      system,
      systemId: system.id,
      point,
      initialState: Object.freeze(correction.state.slice()),
      halfPeriod: correction.crossing.time,
      period,
      periodSeconds: R.denormalizeTime(system, period),
      periodDays: R.denormalizeTime(system, period) / 86400,
      correctionIterations: correction.iterations,
      correctionResidual: correction.residual,
      jacobi: validation.jacobi,
      jacobiDrift: validation.jacobiDrift,
      closureError: validation.closureError,
      positionClosureError: validation.positionClosureError,
      velocityClosureError: validation.velocityClosureError,
      times: Object.freeze(validation.times.slice()),
      states: Object.freeze(validation.states.map((state) => Object.freeze(state.slice()))),
      warning,
      stability: "linearly-unstable",
      integrationStats: Object.freeze(validation.integrationStats),
    });
  }

  function generatePlanarLyapunov(systemValue, pointValue, options) {
    const system = resolveSystem(systemValue);
    const point = pointName(pointValue);
    options = options || {};
    const amplitude = selectedAmplitude(system, point, options, "planar");
    const { gamma } = orbitScales(system, point);
    if (!(amplitude < 0.65 * gamma))
      fail("INVALID_ARGUMENT", "Planar amplitude must stay below 65% of the secondary distance.");
    const correction = planarSeed(system, point, amplitude, undefined, options);
    const size = options.size || "custom";
    return periodicResult(system, point, "planar-lyapunov", size, correction, options);
  }

  function generatePlanarFamily(system, point, options) {
    options = options || {};
    return Object.freeze({
      small: generatePlanarLyapunov(system, point, Object.assign({}, options, { size: "small",
        amplitude: undefined, amplitudeKm: undefined })),
      medium: generatePlanarLyapunov(system, point, Object.assign({}, options, { size: "medium",
        amplitude: undefined, amplitudeKm: undefined })),
    });
  }

  function cachedBifurcation(system, point) {
    let byPoint = bifurcationCache.get(system);
    if (!byPoint) {
      byPoint = Object.create(null);
      bifurcationCache.set(system, byPoint);
    }
    return { get: () => byPoint[point], set: (value) => { byPoint[point] = value; } };
  }

  /** Locate the planar vertical-critical orbit from which the halo family bifurcates. */
  function haloBifurcation(systemValue, pointValue, options) {
    const system = resolveSystem(systemValue);
    const point = pointName(pointValue);
    options = options || {};
    const cache = cachedBifurcation(system, point);
    const useCache = !options.noCache && options.correctionTolerance === undefined &&
      options.maxCorrectionIterations === undefined;
    if (useCache) {
      const cached = cache.get();
      if (cached) return cached;
      const reviewed = REVIEWED_BIFURCATIONS[system.id + "|" + point];
      if (reviewed) {
        const { gamma } = orbitScales(system, point);
        const result = Object.freeze({
          system,
          point,
          amplitudeFraction: reviewed.amplitudeFraction,
          amplitude: reviewed.amplitudeFraction * gamma,
          state: Object.freeze(reviewed.state.slice()),
          halfPeriod: reviewed.halfPeriod,
          verticalCriticalResidual: reviewed.verticalCriticalResidual,
          reviewedWarmStart: true,
        });
        cache.set(result);
        return result;
      }
    }
    const { gamma } = orbitScales(system, point);
    let fraction = 0.02;
    // Small continuation steps are intentional: Sun–Earth L1 has a narrow
    // primary-side shooting basin near the vertical-critical orbit.
    let step = 0.005;
    let previous = null;
    let beforePrevious = null;
    let bracket = null;

    while (fraction <= 0.36) {
      let seed;
      if (previous) {
        seed = previous.correction.state[4];
        if (beforePrevious) {
          const slope = (previous.correction.state[4] - beforePrevious.correction.state[4]) /
            (previous.fraction - beforePrevious.fraction);
          seed += slope * (fraction - previous.fraction);
        }
      }
      let correction;
      try {
        correction = planarSeed(system, point, fraction * gamma, seed, options);
      } catch (error) {
        if (previous && step > 0.0005) {
          step *= 0.5;
          fraction = previous.fraction + step;
          continue;
        }
        throw error;
      }
      const indicator = correction.crossing.sensitivity(5, 2);
      const current = { fraction, correction, indicator };
      if (previous && previous.indicator * indicator <= 0) {
        bracket = [previous, current];
        break;
      }
      beforePrevious = previous;
      previous = current;
      step = Math.min(0.005, step * 1.5);
      fraction += step;
    }
    if (!bracket)
      fail("BIFURCATION_NOT_FOUND", `${system.name} ${point} halo bifurcation was not bracketed.`);

    let [low, high] = bracket;
    for (let iteration = 0; iteration < 30; iteration++) {
      if (Math.abs(low.indicator) < 2e-9) { high = low; break; }
      if (Math.abs(high.indicator) < 2e-9) { low = high; break; }
      if (high.fraction - low.fraction < 2e-9) break;
      let trialFraction = low.fraction - low.indicator *
        (high.fraction - low.fraction) / (high.indicator - low.indicator);
      if (!(trialFraction > low.fraction && trialFraction < high.fraction) ||
        trialFraction - low.fraction < 0.1 * (high.fraction - low.fraction) ||
        high.fraction - trialFraction < 0.1 * (high.fraction - low.fraction))
        trialFraction = 0.5 * (low.fraction + high.fraction);
      const weight = (trialFraction - low.fraction) / (high.fraction - low.fraction);
      const vySeed = low.correction.state[4] + weight *
        (high.correction.state[4] - low.correction.state[4]);
      const correction = planarSeed(system, point, trialFraction * gamma, vySeed, options);
      const indicator = correction.crossing.sensitivity(5, 2);
      const trial = { fraction: trialFraction, correction, indicator };
      if (low.indicator * indicator <= 0) high = trial;
      else low = trial;
    }
    const best = Math.abs(low.indicator) <= Math.abs(high.indicator) ? low : high;
    const result = Object.freeze({
      system,
      point,
      amplitudeFraction: best.fraction,
      amplitude: best.fraction * gamma,
      state: Object.freeze(best.correction.state.slice()),
      halfPeriod: best.correction.crossing.time,
      verticalCriticalResidual: best.indicator,
    });
    if (useCache) cache.set(result);
    return result;
  }

  function haloMeasurement(system, state, options) {
    const crossing = symmetryCrossing(system, state, options);
    return {
      crossing,
      residualVector: [crossing.state[3], crossing.state[5]],
      residual: Math.hypot(crossing.state[3], crossing.state[5]),
    };
  }

  function correctedHaloState(system, point, initialState, gamma, options) {
    options = options || {};
    const tolerance = positive(options.correctionTolerance, 5e-10,
      "correctionTolerance", false);
    const maxIterations = integer(options.maxCorrectionIterations, 18,
      "maxCorrectionIterations", 1);
    let state = stateVector(initialState, "initialState");
    let measurement = haloMeasurement(system, state, options);
    let iterations = 0;

    while (measurement.residual > tolerance && iterations < maxIterations) {
      iterations++;
      const crossing = measurement.crossing;
      const a = crossing.sensitivity(3, 0);
      const b = crossing.sensitivity(3, 4);
      const c = crossing.sensitivity(5, 0);
      const d = crossing.sensitivity(5, 4);
      const determinant = a * d - b * c;
      if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12)
        fail("SINGULAR_CORRECTION", `${system.name} ${point} halo correction is singular.`);
      const vx = crossing.state[3], vz = crossing.state[5];
      let dx = (-vx * d + b * vz) / determinant;
      let dvy = (-a * vz + c * vx) / determinant;
      const capScale = Math.min(1,
        0.20 * gamma / Math.max(Math.abs(dx), Number.MIN_VALUE),
        0.35 * Math.max(Math.abs(state[4]), 1e-4) /
          Math.max(Math.abs(dvy), Number.MIN_VALUE));
      dx *= capScale;
      dvy *= capScale;

      let accepted = null;
      for (const scale of [1, 0.5, 0.25, 0.125, 0.0625]) {
        const trial = state.slice();
        trial[0] += scale * dx;
        trial[4] += scale * dvy;
        if (!(trial[4] > 1e-10)) continue;
        try {
          const candidate = haloMeasurement(system, trial, options);
          if (candidate.residual < measurement.residual) {
            accepted = { state: trial, measurement: candidate };
            break;
          }
        } catch (error) {
          if (!(error instanceof LibrationError)) throw error;
        }
      }
      if (!accepted)
        fail("CORRECTION_DIVERGED", `${system.name} ${point} halo correction did not descend.`,
          { residual: measurement.residual, iterations });
      state = accepted.state;
      measurement = accepted.measurement;
    }
    if (measurement.residual > tolerance)
      fail("CORRECTION_DID_NOT_CONVERGE", `${system.name} ${point} halo correction exceeded its iteration cap.`,
        { residual: measurement.residual, iterations });
    return {
      state,
      crossing: measurement.crossing,
      residual: measurement.residual,
      iterations,
    };
  }

  function generateHalo(systemValue, pointValue, options) {
    const system = resolveSystem(systemValue);
    const point = pointName(pointValue);
    options = options || {};
    const { gamma } = orbitScales(system, point);
    const zAmplitude = selectedAmplitude(system, point, options, "halo");
    if (!(zAmplitude <= 0.22 * gamma))
      fail("INVALID_ARGUMENT", "Validated halo z amplitude must not exceed 22% of the secondary distance.");
    const hemisphere = options.hemisphere === undefined
      ? "north" : String(options.hemisphere).toLowerCase();
    if (hemisphere !== "north" && hemisphere !== "south")
      fail("INVALID_ARGUMENT", "hemisphere must be 'north' or 'south'.");
    const zSign = hemisphere === "north" ? 1 : -1;
    const bifurcation = haloBifurcation(system, point, options);

    let fraction = Math.min(0.005, zAmplitude / gamma);
    let state = bifurcation.state.slice();
    let correction = null;
    while (fraction <= zAmplitude / gamma + 1e-14) {
      state[2] = zSign * fraction * gamma;
      correction = correctedHaloState(system, point, state, gamma, options);
      state = correction.state.slice();
      if (fraction === zAmplitude / gamma) break;
      fraction = Math.min(zAmplitude / gamma, fraction + 0.02);
    }
    const size = options.size || "custom";
    const result = periodicResult(system, point, "halo", size, correction, options);
    return Object.freeze(Object.assign({}, result, {
      hemisphere,
      zAmplitude: Math.abs(result.initialState[2]),
      zAmplitudeKm: Math.abs(result.initialState[2]) * system.distanceKm,
      bifurcationAmplitudeFraction: bifurcation.amplitudeFraction,
    }));
  }

  function generateHaloFamily(system, point, options) {
    options = options || {};
    return Object.freeze({
      small: generateHalo(system, point, Object.assign({}, options, { size: "small",
        amplitude: undefined, amplitudeKm: undefined })),
      medium: generateHalo(system, point, Object.assign({}, options, { size: "medium",
        amplitude: undefined, amplitudeKm: undefined })),
    });
  }

  /** Bounded linear center-mode seed. This does not make a periodic claim. */
  function generateLissajousSeed(systemValue, pointValue, options) {
    const system = resolveSystem(systemValue);
    const point = pointName(pointValue);
    options = options || {};
    const modes = linearModes(system, point);
    const { gamma } = orbitScales(system, point);
    const size = options.size === undefined ? "small" : String(options.size).toLowerCase();
    const sizeAmplitudes = {
      small: { planar: 0.04, vertical: 0.06 },
      medium: { planar: 0.08, vertical: 0.12 },
    };
    if (!(size in sizeAmplitudes))
      fail("INVALID_ARGUMENT", "size must be 'small' or 'medium'.");
    const planarAmplitude = positive(options.planarAmplitude,
      sizeAmplitudes[size].planar * gamma, "planarAmplitude", false);
    const verticalAmplitude = positive(options.verticalAmplitude,
      sizeAmplitudes[size].vertical * gamma, "verticalAmplitude", false);
    if (planarAmplitude > 0.25 * gamma || verticalAmplitude > 0.25 * gamma)
      fail("INVALID_ARGUMENT", "Linear Lissajous amplitudes must stay within 25% of the L-point scale.");
    const planarPhase = finite(options.planarPhase === undefined ? 0 : options.planarPhase,
      "planarPhase");
    const verticalPhase = finite(options.verticalPhase === undefined ? Math.PI / 2 : options.verticalPhase,
      "verticalPhase");
    const duration = positive(options.duration,
      6 * modes.planarPeriod, "duration", false);
    const sampleCount = integer(options.sampleCount, 721, "sampleCount", 9);
    const ax = -planarAmplitude;
    const by = modes.yPerX * ax;
    const times = new Array(sampleCount);
    const states = new Array(sampleCount);
    for (let index = 0; index < sampleCount; index++) {
      const time = duration * index / (sampleCount - 1);
      const p = modes.planarFrequency * time + planarPhase;
      const zPhase = modes.verticalFrequency * time + verticalPhase;
      times[index] = time;
      states[index] = [
        modes.equilibriumX + ax * Math.cos(p),
        by * Math.sin(p),
        verticalAmplitude * Math.cos(zPhase),
        -ax * modes.planarFrequency * Math.sin(p),
        by * modes.planarFrequency * Math.cos(p),
        -verticalAmplitude * modes.verticalFrequency * Math.sin(zPhase),
      ];
    }
    return Object.freeze({
      type: "bounded-linear-seed",
      family: "lissajous",
      size,
      model: "linearized-cr3bp-center-modes",
      periodicClaim: false,
      boundedByConstruction: true,
      system,
      systemId: system.id,
      point,
      initialState: Object.freeze(states[0].slice()),
      duration,
      durationSeconds: R.denormalizeTime(system, duration),
      planarFrequency: modes.planarFrequency,
      verticalFrequency: modes.verticalFrequency,
      planarAmplitude,
      verticalAmplitude,
      times: Object.freeze(times),
      states: Object.freeze(states.map((state) => Object.freeze(state))),
      warning: "Linearized bounded Lissajous seed only; it is not a differential-corrected periodic orbit and will drift under nonlinear CR3BP propagation.",
    });
  }

  function integrateStateHistory(system, initialState, start, end, outputTimes) {
    try {
      return ODE.integrate((time, state) => R.derivatives(system, state),
        start, initialState, end, {
          rtol: 2e-11,
          atol: 2e-13,
          maxStep: Math.min(0.02, Math.abs(end - start) / 20 || 0.02),
          maxSteps: 100000,
          maxEvaluations: 1000000,
          outputTimes,
        }).y;
    } catch (error) {
      fail("INTEGRATION_FAILURE", "Stationkeeping propagation failed.", { cause: error });
    }
  }

  /** Smooth state on a generated reference orbit. Periodic corrected families
   * wrap by phase; bounded non-periodic seeds clamp to their authored span. */
  function referenceStateAt(referenceOrbit, time, wrapPeriodic) {
    if (!referenceOrbit || !Array.isArray(referenceOrbit.times) ||
        !Array.isArray(referenceOrbit.states) || referenceOrbit.times.length < 2 ||
        referenceOrbit.times.length !== referenceOrbit.states.length)
      fail("INVALID_ARGUMENT", "referenceOrbit must provide matching times and states.");
    const times = referenceOrbit.times;
    const states = referenceOrbit.states;
    const first = times[0], last = times[times.length - 1];
    let at = finite(time, "time");
    if (wrapPeriodic && referenceOrbit.periodicClaim === true &&
        referenceOrbit.period > 0) {
      const period = referenceOrbit.period;
      at = first + ((at - first) % period + period) % period;
      if (Math.abs(at - first) <= 32 * Number.EPSILON * Math.max(1, Math.abs(time)))
        return states[0].slice();
    } else at = Math.max(first, Math.min(last, at));
    if (at <= first) return states[0].slice();
    if (at >= last) return states[states.length - 1].slice();
    let lo = 0, hi = times.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= at) lo = mid; else hi = mid;
    }
    const h = times[hi] - times[lo];
    const u = (at - times[lo]) / h;
    const u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    const dh00 = (6 * u2 - 6 * u) / h;
    const dh10 = 3 * u2 - 4 * u + 1;
    const dh01 = (-6 * u2 + 6 * u) / h;
    const dh11 = 3 * u2 - 2 * u;
    const a = states[lo], b = states[hi];
    const out = new Array(6);
    for (let axis = 0; axis < 3; axis++) {
      out[axis] = h00 * a[axis] + h10 * h * a[axis + 3] +
        h01 * b[axis] + h11 * h * b[axis + 3];
      out[axis + 3] = dh00 * a[axis] + dh10 * a[axis + 3] +
        dh01 * b[axis] + dh11 * b[axis + 3];
    }
    return out;
  }

  /** Deterministic ideal impulsive reference tracker in canonical units. */
  function simulateStationkeeping(systemValue, referenceOrbit, options) {
    const system = resolveSystem(systemValue);
    options = options || {};
    if (!referenceOrbit || !referenceOrbit.initialState || !(referenceOrbit.period > 0))
      fail("INVALID_ARGUMENT", "referenceOrbit must provide initialState and period.");
    const phaseLocked = options.phaseLocked === true &&
      referenceOrbit.periodicClaim === true && Array.isArray(referenceOrbit.times) &&
      Array.isArray(referenceOrbit.states);
    const referencePhase = finite(options.referencePhase === undefined ? 0
      : options.referencePhase, "referencePhase");
    const referenceInitial = phaseLocked
      ? referenceStateAt(referenceOrbit, referencePhase, true)
      : stateVector(referenceOrbit.initialState, "referenceOrbit.initialState");
    const offset = options.initialOffset === undefined
      ? [0, 0, 0, 0, 0, 0]
      : stateVector(options.initialOffset, "initialOffset");
    const duration = positive(options.duration, 3 * referenceOrbit.period, "duration", false);
    const interval = positive(options.correctionInterval,
      referenceOrbit.period / 12, "correctionInterval", false);
    const positionDeadband = positive(options.positionDeadband, 0,
      "positionDeadband", true);
    const velocityDeadband = positive(options.velocityDeadband, 0,
      "velocityDeadband", true);
    const maxBurn = positive(options.maxBurn, 5e-5, "maxBurn", false);
    const maxBurns = integer(options.maxBurns, 100, "maxBurns", 0);
    // A correction epoch can span more than a day in Earth-Moon halo cases.
    // Preserve integrated states inside each interval so the public trajectory
    // cannot collapse a curved CR3BP arc into a hundred-thousand-kilometre
    // display chord. This output cadence does not alter controller epochs.
    const samplesPerCorrection = integer(options.samplesPerCorrection, 8,
      "samplesPerCorrection", 1);
    const positionGain = positive(options.positionGain, 1 / interval,
      "positionGain", true);
    const correctionEpochs = Math.ceil(duration / interval -
      16 * Number.EPSILON * Math.max(1, duration / interval));
    if (correctionEpochs > 1000)
      fail("INVALID_ARGUMENT", "Stationkeeping is limited to 1,000 correction epochs per segment.");

    let referenceState = referenceInitial.slice();
    let trackedState = scaledAdd(referenceInitial, offset, 1);
    let time = 0;
    const burns = [];
    const history = [{ time, referenceState: referenceState.slice(),
      trackedState: trackedState.slice(), positionError: norm(offset.slice(0, 3)),
      velocityError: norm(offset.slice(3)) }];
    let capped = false;

    while (time < duration - 16 * Number.EPSILON * Math.max(1, duration)) {
      const next = Math.min(duration, time + interval);
      const outputTimes = Array.from({ length: samplesPerCorrection }, (_, index) =>
        time + (next - time) * (index + 1) / samplesPerCorrection);
      const referenceArc = phaseLocked
        ? outputTimes.map((outputTime) => referenceStateAt(referenceOrbit,
          referencePhase + outputTime, true))
        : integrateStateHistory(system, referenceState, time, next, outputTimes);
      const trackedArc = integrateStateHistory(system, trackedState, time, next,
        outputTimes);
      for (let index = 0; index + 1 < outputTimes.length; index++) {
        const sampleError = difference(trackedArc[index], referenceArc[index]);
        history.push({
          time: outputTimes[index],
          referenceState: referenceArc[index].slice(),
          trackedState: trackedArc[index].slice(),
          positionError: norm(sampleError.slice(0, 3)),
          velocityError: norm(sampleError.slice(3)),
          burnIndex: null,
        });
      }
      referenceState = referenceArc[referenceArc.length - 1];
      trackedState = trackedArc[trackedArc.length - 1];
      const error = difference(trackedState, referenceState);
      const positionError = norm(error.slice(0, 3));
      const velocityError = norm(error.slice(3));
      let burn = null;
      if (positionError > positionDeadband || velocityError > velocityDeadband) {
        if (burns.length < maxBurns) {
          let deltaV = [
            -error[3] - positionGain * error[0],
            -error[4] - positionGain * error[1],
            -error[5] - positionGain * error[2],
          ];
          const rawMagnitude = norm(deltaV);
          if (rawMagnitude > maxBurn)
            deltaV = deltaV.map((value) => value * maxBurn / rawMagnitude);
          const magnitude = norm(deltaV);
          if (magnitude > 0) {
            trackedState = trackedState.slice();
            for (let index = 0; index < 3; index++) trackedState[index + 3] += deltaV[index];
            burn = Object.freeze({
              time: next,
              deltaV: Object.freeze(deltaV),
              magnitude,
              magnitudeKmS: magnitude * system.velocityUnitKmS,
              positionError,
              velocityError,
              saturated: rawMagnitude > maxBurn,
            });
            burns.push(burn);
          }
        } else {
          capped = true;
        }
      }
      time = next;
      history.push({ time, referenceState: referenceState.slice(),
        trackedState: trackedState.slice(), positionError, velocityError,
        burnIndex: burn ? burns.length - 1 : null });
    }
    const totalDv = burns.reduce((sum, burn) => sum + burn.magnitude, 0);
    return Object.freeze({
      type: "ideal-impulsive-reference-tracking",
      model: "cr3bp-deterministic-reference-tracker",
      system,
      systemId: system.id,
      duration,
      correctionInterval: interval,
      correctionEpochs,
      samplesPerCorrection,
      phaseLocked,
      referencePhase,
      initialOffset: Object.freeze(offset),
      burns: Object.freeze(burns),
      burnCount: burns.length,
      totalDv,
      totalDvKmS: totalDv * system.velocityUnitKmS,
      capped,
      finalReferenceState: Object.freeze(referenceState),
      finalTrackedState: Object.freeze(trackedState),
      history: Object.freeze(history.map((entry) => Object.freeze(entry))),
      warning: "Ideal instantaneous reference-tracking corrections; no navigation error, maneuver execution error, or operational targeting constraints.",
    });
  }

  globalThis.Libration = Object.freeze({
    LibrationError,
    linearModes,
    symmetryCrossing,
    haloBifurcation,
    generatePlanarLyapunov,
    generatePlanarFamily,
    generateHalo,
    generateHaloFamily,
    generateLissajousSeed,
    referenceStateAt,
    simulateStationkeeping,
  });
})();
