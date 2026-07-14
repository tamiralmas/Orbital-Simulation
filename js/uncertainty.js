/* =============================================================================
 * Mission Trajectory Planner - uncertainty.js
 * Deterministic, bounded covariance and Monte Carlo mission-design analysis.
 *
 * State convention: [x,y,z,vx,vy,vz] in caller-selected consistent units.
 * The Planner uses km and km/s. Covariance therefore uses km^2, km^2/s,
 * and km^2/s^2 in its corresponding blocks.
 * ========================================================================== */
"use strict";

(function () {
  const DIMENSION = 6;
  const DEFAULT_MONTE_CARLO_SAMPLES = 1000;
  const MAX_MONTE_CARLO_SAMPLES = 20000;
  const MAX_MODEL_EVALUATIONS = 20000;
  const MAX_STM_EVALUATIONS = 64;

  class UncertaintyError extends Error {
    constructor(code, message, details) {
      super(message);
      this.name = "MissionUncertaintyError";
      this.code = code;
      if (details) Object.assign(this, details);
    }
  }

  function fail(code, message, details) {
    throw new UncertaintyError(code, message, details);
  }

  function finite(value, name) {
    const number = Number(value);
    if (!Number.isFinite(number)) fail("INVALID_ARGUMENT", name + " must be finite.");
    return number;
  }

  function nonnegative(value, fallback, name) {
    const number = value === undefined ? fallback : finite(value, name);
    if (number < 0) fail("INVALID_ARGUMENT", name + " must be non-negative.");
    return number;
  }

  function integer(value, fallback, name, minimum, maximum) {
    const number = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
      fail("INVALID_ARGUMENT", name + " must be an integer from " + minimum +
        " through " + maximum + ".");
    }
    return number;
  }

  function stateVector(value, name) {
    name = name || "state";
    let source = value;
    if (value && !Array.isArray(value) && !ArrayBuffer.isView(value)) {
      const position = value.r || value.position;
      const velocity = value.v || value.velocity;
      if (position && velocity) source = Array.from(position).concat(Array.from(velocity));
    }
    if ((!Array.isArray(source) && !ArrayBuffer.isView(source)) ||
        source.length !== DIMENSION) {
      fail("INVALID_STATE", name + " must contain six Cartesian components.");
    }
    const result = Array.from(source, Number);
    result.forEach((component, index) => {
      if (!Number.isFinite(component)) {
        fail("INVALID_STATE", name + " component " + index + " must be finite.");
      }
    });
    return result;
  }

  function vector3(value, name) {
    if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== 3) {
      fail("INVALID_ARGUMENT", name + " must have three components.");
    }
    return Array.from(value, (component, index) => finite(component,
      name + "[" + index + "]"));
  }

  function zeros(rows, columns) {
    return Array.from({ length: rows }, () => new Array(columns).fill(0));
  }

  function identity(size) {
    const result = zeros(size, size);
    for (let index = 0; index < size; index++) result[index][index] = 1;
    return result;
  }

  function matrix(value, rows, columns, name) {
    if (!Array.isArray(value) || value.length !== rows) {
      fail("INVALID_MATRIX", name + " must have " + rows + " rows.");
    }
    return value.map((row, rowIndex) => {
      if ((!Array.isArray(row) && !ArrayBuffer.isView(row)) || row.length !== columns) {
        fail("INVALID_MATRIX", name + " row " + rowIndex + " must have " +
          columns + " columns.");
      }
      return Array.from(row, (component, columnIndex) => finite(component,
        name + "[" + rowIndex + "][" + columnIndex + "]"));
    });
  }

  function transpose(value) {
    const result = zeros(value[0].length, value.length);
    for (let row = 0; row < value.length; row++) {
      for (let column = 0; column < value[0].length; column++) {
        result[column][row] = value[row][column];
      }
    }
    return result;
  }

  function multiply(left, right) {
    if (left[0].length !== right.length) fail("INVALID_MATRIX", "Matrix dimensions do not align.");
    const result = zeros(left.length, right[0].length);
    for (let row = 0; row < left.length; row++) {
      for (let inner = 0; inner < right.length; inner++) {
        const coefficient = left[row][inner];
        for (let column = 0; column < right[0].length; column++) {
          result[row][column] += coefficient * right[inner][column];
        }
      }
    }
    return result;
  }

  function multiplyVector(value, vector) {
    return value.map((row) => row.reduce((sum, component, index) =>
      sum + component * vector[index], 0));
  }

  function addMatrices(left, right) {
    return left.map((row, rowIndex) => row.map((component, columnIndex) =>
      component + right[rowIndex][columnIndex]));
  }

  function outer(left, right) {
    return left.map((l) => right.map((r) => l * r));
  }

  function symmetrize(value) {
    return value.map((row, rowIndex) => row.map((component, columnIndex) =>
      rowIndex === columnIndex ? component :
        0.5 * (component + value[columnIndex][rowIndex])));
  }

  function freezeMatrix(value) {
    return Object.freeze(value.map((row) => Object.freeze(row.slice())));
  }

  function matrixMagnitude(value) {
    let scale = 0;
    for (const row of value) {
      for (const component of row) scale = Math.max(scale, Math.abs(component));
    }
    return scale;
  }

  // Bounded Jacobi eigensolver for small real symmetric matrices. It handles
  // positive-semidefinite covariances with exact zero modes more reliably than
  // an ordinary Cholesky factorization.
  function symmetricEigen(value) {
    const size = value.length;
    const a = symmetrize(value);
    const vectors = identity(size);
    const scale = matrixMagnitude(a);
    const threshold = Math.max(Number.MIN_VALUE, 1e-14 * scale);
    const maxIterations = 64 * size * size;
    let iterations = 0;
    for (; iterations < maxIterations; iterations++) {
      let p = 0, q = 1, largest = 0;
      for (let row = 0; row < size; row++) {
        for (let column = row + 1; column < size; column++) {
          const magnitude = Math.abs(a[row][column]);
          if (magnitude > largest) { largest = magnitude; p = row; q = column; }
        }
      }
      if (largest <= threshold) break;
      const app = a[p][p], aqq = a[q][q], apq = a[p][q];
      const angle = 0.5 * Math.atan2(2 * apq, aqq - app);
      const cosine = Math.cos(angle), sine = Math.sin(angle);
      for (let index = 0; index < size; index++) {
        if (index === p || index === q) continue;
        const aip = a[index][p], aiq = a[index][q];
        a[index][p] = a[p][index] = cosine * aip - sine * aiq;
        a[index][q] = a[q][index] = sine * aip + cosine * aiq;
      }
      a[p][p] = cosine * cosine * app - 2 * sine * cosine * apq +
        sine * sine * aqq;
      a[q][q] = sine * sine * app + 2 * sine * cosine * apq +
        cosine * cosine * aqq;
      a[p][q] = a[q][p] = 0;
      for (let row = 0; row < size; row++) {
        const vip = vectors[row][p], viq = vectors[row][q];
        vectors[row][p] = cosine * vip - sine * viq;
        vectors[row][q] = sine * vip + cosine * viq;
      }
    }
    if (iterations === maxIterations) {
      fail("EIGEN_FAILURE", "Covariance eigensolver did not converge within its work cap.");
    }
    const order = Array.from({ length: size }, (_, index) => index)
      .sort((left, right) => a[right][right] - a[left][left]);
    return {
      values: order.map((index) => a[index][index]),
      vectors: vectors.map((row) => order.map((index) => row[index])),
      iterations,
      scale,
    };
  }

  function validateCovariance(value, name) {
    name = name || "covariance";
    const input = matrix(value, DIMENSION, DIMENSION, name);
    const scale = matrixMagnitude(input);
    const symmetryTolerance = Math.max(Number.MIN_VALUE, 1e-10 * scale);
    for (let row = 0; row < DIMENSION; row++) {
      for (let column = row + 1; column < DIMENSION; column++) {
        if (Math.abs(input[row][column] - input[column][row]) > symmetryTolerance) {
          fail("NON_SYMMETRIC_COVARIANCE", name + " must be symmetric.", { row, column });
        }
      }
    }
    const result = symmetrize(input);
    const eigen = symmetricEigen(result);
    const negativeTolerance = Math.max(Number.MIN_VALUE, 1e-11 * eigen.scale);
    const minimum = Math.min(...eigen.values);
    if (minimum < -negativeTolerance) {
      fail("NON_POSITIVE_SEMIDEFINITE", name + " has a negative eigenvalue.",
        { minimumEigenvalue: minimum });
    }
    for (let index = 0; index < DIMENSION; index++) {
      if (result[index][index] < 0 && result[index][index] >= -negativeTolerance) {
        result[index][index] = 0;
      }
    }
    return result;
  }

  function covarianceSquareRoot(value) {
    const covariance = validateCovariance(value);
    const eigen = symmetricEigen(covariance);
    const root = zeros(DIMENSION, DIMENSION);
    for (let column = 0; column < DIMENSION; column++) {
      const sigma = Math.sqrt(Math.max(0, eigen.values[column]));
      for (let row = 0; row < DIMENSION; row++) {
        root[row][column] = eigen.vectors[row][column] * sigma;
      }
    }
    return root;
  }

  function stateTransition(value) {
    return matrix(value, DIMENSION, DIMENSION, "state transition matrix");
  }

  function propagateLinear(covarianceValue, transitionValue, processNoiseValue) {
    const covariance = validateCovariance(covarianceValue);
    const transition = stateTransition(transitionValue);
    const noise = processNoiseValue === undefined || processNoiseValue === null
      ? zeros(DIMENSION, DIMENSION) : validateCovariance(processNoiseValue, "process noise");
    const propagated = addMatrices(multiply(multiply(transition, covariance),
      transpose(transition)), noise);
    return freezeMatrix(validateCovariance(symmetrize(propagated), "propagated covariance"));
  }

  function callPropagator(propagator, state, dt, context, label) {
    let output;
    try {
      output = propagator(state.slice(), dt, context);
    } catch (error) {
      fail("MODEL_FAILURE", (label || "Propagator") + " failed: " +
        (error && error.message ? error.message : String(error)), { cause: error });
    }
    return stateVector(output, "propagated state");
  }

  function numericalStateTransition(options) {
    if (!options || typeof options.propagator !== "function") {
      fail("INVALID_ARGUMENT", "propagator(state, dt, context) is required.");
    }
    const state = stateVector(options.state);
    const dt = finite(options.dt === undefined ? 0 : options.dt, "dt");
    const maxEvaluations = integer(options.maxEvaluations, 13, "maxEvaluations", 13,
      MAX_STM_EVALUATIONS);
    const suppliedSteps = options.steps === undefined ? null : stateVector(options.steps, "steps");
    const steps = state.map((component, index) => suppliedSteps
      ? Math.abs(suppliedSteps[index])
      : Math.max(index < 3 ? 1e-3 : 1e-7, Math.abs(component) * 1e-7));
    if (steps.some((step) => !(step > 0))) {
      fail("INVALID_ARGUMENT", "All finite-difference steps must be positive.");
    }
    let evaluations = 0;
    const nominal = callPropagator(options.propagator, state, dt, options.context,
      "Nominal covariance propagation");
    evaluations++;
    const transition = zeros(DIMENSION, DIMENSION);
    for (let column = 0; column < DIMENSION; column++) {
      if (evaluations + 2 > maxEvaluations) {
        fail("MAX_EVALUATIONS_EXCEEDED", "Numerical STM evaluation cap reached.",
          { evaluations, maxEvaluations });
      }
      const plus = state.slice(), minus = state.slice();
      plus[column] += steps[column];
      minus[column] -= steps[column];
      const upper = callPropagator(options.propagator, plus, dt, options.context,
        "Positive STM perturbation");
      const lower = callPropagator(options.propagator, minus, dt, options.context,
        "Negative STM perturbation");
      evaluations += 2;
      for (let row = 0; row < DIMENSION; row++) {
        transition[row][column] = (upper[row] - lower[row]) / (2 * steps[column]);
      }
    }
    return Object.freeze({
      state: Object.freeze(state),
      finalState: Object.freeze(nominal),
      transition: freezeMatrix(transition),
      steps: Object.freeze(steps),
      dt,
      evaluations,
    });
  }

  function propagateCovariance(options) {
    options = options || {};
    const state = stateVector(options.state);
    const covariance = validateCovariance(options.covariance);
    let transition, finalState, evaluations = 0, steps = null;
    if (options.transition || options.stm) {
      transition = stateTransition(options.transition || options.stm);
      if (options.finalState !== undefined) finalState = stateVector(options.finalState,
        "finalState");
      else if (typeof options.propagator === "function") {
        finalState = callPropagator(options.propagator, state,
          finite(options.dt === undefined ? 0 : options.dt, "dt"), options.context,
          "Nominal covariance propagation");
        evaluations = 1;
      } else finalState = state.slice();
    } else {
      const numerical = numericalStateTransition(options);
      transition = numerical.transition.map((row) => row.slice());
      finalState = numerical.finalState.slice();
      evaluations = numerical.evaluations;
      steps = numerical.steps;
    }
    const propagated = propagateLinear(covariance, transition, options.processNoise);
    return Object.freeze({
      state: Object.freeze(state),
      finalState: Object.freeze(finalState),
      covariance: propagated,
      transition: freezeMatrix(transition),
      steps,
      dt: finite(options.dt === undefined ? 0 : options.dt, "dt"),
      evaluations,
    });
  }

  function norm(vector) {
    return Math.hypot(...vector);
  }

  function cross(left, right) {
    return [left[1] * right[2] - left[2] * right[1],
      left[2] * right[0] - left[0] * right[2],
      left[0] * right[1] - left[1] * right[0]];
  }

  function scale(vector, factor) {
    return vector.map((component) => component * factor);
  }

  function addVector(left, right) {
    return left.map((component, index) => component + right[index]);
  }

  function unit(vector, name) {
    const magnitude = norm(vector);
    if (!(magnitude > 1e-15)) fail("SINGULAR_FRAME", name + " has zero magnitude.");
    return scale(vector, 1 / magnitude);
  }

  function rtnBasis(stateValue) {
    const state = stateVector(stateValue);
    const radial = unit(state.slice(0, 3), "Radial vector");
    const normal = unit(cross(state.slice(0, 3), state.slice(3, 6)),
      "Orbital angular momentum");
    const transverse = unit(cross(normal, radial), "Transverse vector");
    return Object.freeze({ radial: Object.freeze(radial), transverse: Object.freeze(transverse),
      normal: Object.freeze(normal) });
  }

  function resolveDeltaV(stateValue, maneuver) {
    maneuver = maneuver || {};
    const vector = vector3(maneuver.dv, "maneuver dv");
    const frame = String(maneuver.frame || "inertial").toLowerCase();
    if (frame === "inertial" || frame === "eci" || frame === "teme") return vector;
    if (frame !== "rtn" && frame !== "rsw" && frame !== "lvlh") {
      fail("INVALID_ARGUMENT", "maneuver frame must be inertial or RTN.");
    }
    const basis = rtnBasis(stateValue);
    return [basis.radial[0] * vector[0] + basis.transverse[0] * vector[1] +
      basis.normal[0] * vector[2],
    basis.radial[1] * vector[0] + basis.transverse[1] * vector[1] +
      basis.normal[1] * vector[2],
    basis.radial[2] * vector[0] + basis.transverse[2] * vector[1] +
      basis.normal[2] * vector[2]];
  }

  function executionModel(maneuver, dvMagnitude) {
    const execution = maneuver && maneuver.execution || {};
    const fraction = nonnegative(execution.magnitudeSigmaFraction, 0,
      "magnitudeSigmaFraction");
    if (fraction > 1) fail("INVALID_ARGUMENT", "magnitudeSigmaFraction cannot exceed 1.");
    const magnitudeSigma = execution.magnitudeSigmaKmS === undefined
      ? fraction * dvMagnitude : nonnegative(execution.magnitudeSigmaKmS, 0,
        "magnitudeSigmaKmS");
    const pointingSigma = nonnegative(execution.pointingSigmaRad, 0, "pointingSigmaRad");
    if (pointingSigma > Math.PI / 2) {
      fail("INVALID_ARGUMENT", "pointingSigmaRad cannot exceed pi/2.");
    }
    const timingSigma = nonnegative(execution.timingSigmaS, 0, "timingSigmaS");
    const timingSensitivity = execution.timingSensitivity === undefined ? null
      : stateVector(execution.timingSensitivity, "timingSensitivity");
    return { magnitudeSigma, pointingSigma, timingSigma, timingSensitivity };
  }

  function maneuverErrorCovariance(stateValue, maneuver) {
    const state = stateVector(stateValue);
    const dv = resolveDeltaV(state, maneuver);
    const magnitude = norm(dv);
    const model = executionModel(maneuver, magnitude);
    const result = zeros(DIMENSION, DIMENSION);
    if (magnitude > 0) {
      const direction = scale(dv, 1 / magnitude);
      const magnitudePart = outer(direction, direction);
      const pointingVariance = Math.pow(magnitude * model.pointingSigma, 2);
      const magnitudeVariance = model.magnitudeSigma * model.magnitudeSigma;
      for (let row = 0; row < 3; row++) {
        for (let column = 0; column < 3; column++) {
          const identityComponent = row === column ? 1 : 0;
          result[row + 3][column + 3] += magnitudeVariance *
            magnitudePart[row][column] + pointingVariance *
            (identityComponent - magnitudePart[row][column]);
        }
      }
    }
    if (model.timingSigma > 0) {
      const sensitivity = model.timingSensitivity || [-dv[0], -dv[1], -dv[2], 0, 0, 0];
      const timing = outer(sensitivity, sensitivity);
      for (let row = 0; row < DIMENSION; row++) {
        for (let column = 0; column < DIMENSION; column++) {
          result[row][column] += timing[row][column] * model.timingSigma * model.timingSigma;
        }
      }
    }
    return freezeMatrix(validateCovariance(result, "maneuver error covariance"));
  }

  function deterministicManeuverState(stateValue, maneuver) {
    const state = stateVector(stateValue);
    const dv = resolveDeltaV(state, maneuver);
    const finalState = state.slice();
    for (let axis = 0; axis < 3; axis++) finalState[axis + 3] += dv[axis];
    return finalState;
  }

  function applyManeuverCovariance(options) {
    options = options || {};
    const state = stateVector(options.state);
    const covariance = validateCovariance(options.covariance);
    const dv = resolveDeltaV(state, options.maneuver);
    const finalState = deterministicManeuverState(state, options.maneuver);
    const maneuverCovariance = maneuverErrorCovariance(state, options.maneuver);
    const frame = String(options.maneuver && options.maneuver.frame || "inertial").toLowerCase();
    let transition = identity(DIMENSION), steps = null, evaluations = 0;
    if (frame !== "inertial" && frame !== "eci" && frame !== "teme") {
      const numerical = numericalStateTransition({
        state,
        dt: 0,
        steps: options.steps,
        maxEvaluations: options.maxEvaluations,
        propagator: (candidate) => deterministicManeuverState(candidate, options.maneuver),
      });
      transition = numerical.transition.map((row) => row.slice());
      steps = numerical.steps.slice();
      evaluations = numerical.evaluations;
    }
    const finalCovariance = propagateLinear(covariance, transition,
      maneuverCovariance.map((row) => row.slice()));
    return Object.freeze({
      state: Object.freeze(state),
      finalState: Object.freeze(finalState),
      nominalDeltaV: Object.freeze(dv),
      maneuverCovariance,
      covariance: finalCovariance,
      transition: freezeMatrix(transition),
      steps: steps ? Object.freeze(steps) : null,
      evaluations,
    });
  }

  function seedValue(seed) {
    if (typeof seed === "number" && Number.isFinite(seed)) return seed >>> 0;
    const text = String(seed === undefined ? 1170 : seed);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function createRng(seed) {
    const initialSeed = seedValue(seed);
    let state = initialSeed || 0x6d2b79f5;
    let spare = null;
    function uniform() {
      state = (state + 0x6d2b79f5) >>> 0;
      let value = state;
      value = Math.imul(value ^ value >>> 15, value | 1);
      value ^= value + Math.imul(value ^ value >>> 7, value | 61);
      return ((value ^ value >>> 14) >>> 0) / 4294967296;
    }
    function normal() {
      if (spare !== null) { const value = spare; spare = null; return value; }
      const first = Math.max(Number.MIN_VALUE, uniform());
      const second = uniform();
      const radius = Math.sqrt(-2 * Math.log(first));
      const angle = 2 * Math.PI * second;
      spare = radius * Math.sin(angle);
      return radius * Math.cos(angle);
    }
    return Object.freeze({ seed: initialSeed, uniform, normal });
  }

  function perpendicularBasis(direction) {
    const axis = Math.abs(direction[0]) <= Math.abs(direction[1]) &&
      Math.abs(direction[0]) <= Math.abs(direction[2]) ? [1, 0, 0]
      : Math.abs(direction[1]) <= Math.abs(direction[2]) ? [0, 1, 0] : [0, 0, 1];
    const first = unit(cross(direction, axis), "Pointing-error basis");
    return [first, unit(cross(direction, first), "Pointing-error basis")];
  }

  function sampleManeuver(stateValue, maneuver, rng, context) {
    const state = stateVector(stateValue);
    const nominal = resolveDeltaV(state, maneuver);
    const magnitude = norm(nominal);
    const model = executionModel(maneuver, magnitude);
    let actual = nominal.slice();
    let magnitudeError = 0, pointingErrors = [0, 0];
    if (magnitude > 0) {
      const direction = scale(nominal, 1 / magnitude);
      const basis = perpendicularBasis(direction);
      magnitudeError = model.magnitudeSigma * rng.normal();
      pointingErrors = [model.pointingSigma * rng.normal(),
        model.pointingSigma * rng.normal()];
      const perturbedDirection = unit(addVector(direction,
        addVector(scale(basis[0], pointingErrors[0]),
          scale(basis[1], pointingErrors[1]))), "Perturbed maneuver direction");
      actual = scale(perturbedDirection, Math.max(0, magnitude + magnitudeError));
    }
    const timingError = model.timingSigma * rng.normal();
    let finalState;
    if (maneuver && typeof maneuver.execute === "function") {
      finalState = callPropagator((input) => maneuver.execute(input, actual.slice(),
        timingError, context), state, 0, context, "Maneuver execution callback");
    } else {
      finalState = state.slice();
      for (let axis = 0; axis < 3; axis++) {
        finalState[axis] -= actual[axis] * timingError;
        finalState[axis + 3] += actual[axis];
      }
    }
    return Object.freeze({
      state: Object.freeze(finalState),
      nominalDeltaV: Object.freeze(nominal),
      actualDeltaV: Object.freeze(actual),
      magnitudeError,
      pointingErrors: Object.freeze(pointingErrors),
      timingError,
    });
  }

  function quantile(sorted, probability) {
    if (!sorted.length) return NaN;
    const index = (sorted.length - 1) * probability;
    const lower = Math.floor(index), upper = Math.ceil(index);
    if (lower === upper) return sorted[lower];
    const fraction = index - lower;
    return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
  }

  function confidenceEllipse(covarianceValue, indices, probability) {
    const covariance = validateCovariance(covarianceValue);
    if (!Array.isArray(indices) || indices.length !== 2 ||
        !indices.every((value) => Number.isSafeInteger(value) && value >= 0 && value < DIMENSION) ||
        indices[0] === indices[1]) {
      fail("INVALID_ARGUMENT", "confidence ellipse requires two distinct state indices.");
    }
    const confidence = probability === undefined ? 0.95 : finite(probability, "probability");
    if (!(confidence > 0 && confidence < 1)) {
      fail("INVALID_ARGUMENT", "probability must be between zero and one.");
    }
    const a = covariance[indices[0]][indices[0]];
    const b = covariance[indices[0]][indices[1]];
    const d = covariance[indices[1]][indices[1]];
    const root = Math.hypot(a - d, 2 * b);
    const majorVariance = Math.max(0, 0.5 * (a + d + root));
    const minorVariance = Math.max(0, 0.5 * (a + d - root));
    const chiSquareScale = Math.sqrt(-2 * Math.log(1 - confidence));
    return Object.freeze({
      indices: Object.freeze(indices.slice()),
      probability: confidence,
      semiMajor: chiSquareScale * Math.sqrt(majorVariance),
      semiMinor: chiSquareScale * Math.sqrt(minorVariance),
      angleRad: 0.5 * Math.atan2(2 * b, a - d),
      chiSquareScale,
    });
  }

  function summarizeSamples(samples, probability) {
    if (!Array.isArray(samples) || samples.length < 2) {
      fail("INVALID_ARGUMENT", "At least two Monte Carlo samples are required.");
    }
    const confidence = probability === undefined ? 0.95 : finite(probability, "confidence");
    if (!(confidence > 0 && confidence < 1)) {
      fail("INVALID_ARGUMENT", "confidence must be between zero and one.");
    }
    const normalized = samples.map((sample, index) => stateVector(sample,
      "sample " + index));
    const mean = new Array(DIMENSION).fill(0);
    normalized.forEach((sample) => sample.forEach((component, index) => mean[index] += component));
    for (let index = 0; index < DIMENSION; index++) mean[index] /= normalized.length;
    const covariance = zeros(DIMENSION, DIMENSION);
    normalized.forEach((sample) => {
      const error = sample.map((component, index) => component - mean[index]);
      for (let row = 0; row < DIMENSION; row++) {
        for (let column = 0; column < DIMENSION; column++) {
          covariance[row][column] += error[row] * error[column];
        }
      }
    });
    const denominator = normalized.length - 1;
    for (let row = 0; row < DIMENSION; row++) {
      for (let column = 0; column < DIMENSION; column++) covariance[row][column] /= denominator;
    }
    const lowerProbability = 0.5 * (1 - confidence);
    const upperProbability = 1 - lowerProbability;
    const intervals = Array.from({ length: DIMENSION }, (_, index) => {
      const values = normalized.map((sample) => sample[index]).sort((a, b) => a - b);
      return Object.freeze({ lower: quantile(values, lowerProbability), median: quantile(values, 0.5),
        upper: quantile(values, upperProbability) });
    });
    const positionErrors = normalized.map((sample) => Math.hypot(sample[0] - mean[0],
      sample[1] - mean[1], sample[2] - mean[2])).sort((a, b) => a - b);
    const velocityErrors = normalized.map((sample) => Math.hypot(sample[3] - mean[3],
      sample[4] - mean[4], sample[5] - mean[5])).sort((a, b) => a - b);
    const validatedCovariance = freezeMatrix(validateCovariance(covariance,
      "sample covariance"));
    return Object.freeze({
      count: normalized.length,
      confidence,
      mean: Object.freeze(mean),
      covariance: validatedCovariance,
      sigma: Object.freeze(validatedCovariance.map((row, index) =>
        Math.sqrt(Math.max(0, row[index])))),
      intervals: Object.freeze(intervals),
      positionRadius: Object.freeze({ median: quantile(positionErrors, 0.5),
        confidence: quantile(positionErrors, confidence), max: positionErrors[positionErrors.length - 1] }),
      velocityRadius: Object.freeze({ median: quantile(velocityErrors, 0.5),
        confidence: quantile(velocityErrors, confidence), max: velocityErrors[velocityErrors.length - 1] }),
      ellipses: Object.freeze({
        xy: confidenceEllipse(validatedCovariance, [0, 1], confidence),
        xz: confidenceEllipse(validatedCovariance, [0, 2], confidence),
        yz: confidenceEllipse(validatedCovariance, [1, 2], confidence),
      }),
    });
  }

  function runMonteCarlo(options) {
    options = options || {};
    const meanState = stateVector(options.meanState === undefined ? options.state : options.meanState,
      "meanState");
    const covariance = validateCovariance(options.covariance);
    const samplesRequested = integer(options.samples, DEFAULT_MONTE_CARLO_SAMPLES, "samples", 2,
      MAX_MONTE_CARLO_SAMPLES);
    const modelLimit = integer(options.maxModelEvaluations, samplesRequested,
      "maxModelEvaluations", 0, MAX_MODEL_EVALUATIONS);
    if (typeof options.propagator === "function" && samplesRequested > modelLimit) {
      fail("MAX_EVALUATIONS_EXCEEDED", "Monte Carlo samples exceed maxModelEvaluations.",
        { samples: samplesRequested, maxModelEvaluations: modelLimit });
    }
    if (options.maneuvers !== undefined && !Array.isArray(options.maneuvers)) {
      fail("INVALID_ARGUMENT", "maneuvers must be an array.");
    }
    const maneuvers = options.maneuvers || [];
    if (maneuvers.length > 64) fail("MAX_MANEUVERS_EXCEEDED", "At most 64 maneuvers are allowed.");
    const root = covarianceSquareRoot(covariance);
    const rng = createRng(options.seed);
    const outputs = new Array(samplesRequested);
    let modelEvaluations = 0;
    for (let sampleIndex = 0; sampleIndex < samplesRequested; sampleIndex++) {
      const normal = Array.from({ length: DIMENSION }, () => rng.normal());
      let state = addVector(meanState, multiplyVector(root, normal));
      const context = Object.freeze({ sampleIndex, seed: rng.seed,
        propagationTime: options.propagationTime });
      for (let index = 0; index < maneuvers.length; index++) {
        state = sampleManeuver(state, maneuvers[index], rng,
          Object.freeze({ sampleIndex, maneuverIndex: index, seed: rng.seed })).state.slice();
      }
      if (typeof options.propagator === "function") {
        state = callPropagator(options.propagator, state,
          finite(options.propagationTime === undefined ? 0 : options.propagationTime,
            "propagationTime"), context, "Monte Carlo propagator");
        modelEvaluations++;
      }
      outputs[sampleIndex] = state;
    }
    const summary = summarizeSamples(outputs, options.confidence);
    const retain = options.retainSamples === true;
    return Object.freeze({
      seed: rng.seed,
      samplesRequested,
      modelEvaluations,
      meanState: Object.freeze(meanState),
      inputCovariance: freezeMatrix(covariance),
      summary,
      samples: retain ? Object.freeze(outputs.map((sample) => Object.freeze(sample.slice()))) : null,
      retainedSamples: retain,
    });
  }

  globalThis.MissionUncertainty = Object.freeze({
    DIMENSION,
    DEFAULT_MONTE_CARLO_SAMPLES,
    MAX_MONTE_CARLO_SAMPLES,
    MAX_MODEL_EVALUATIONS,
    MAX_STM_EVALUATIONS,
    UncertaintyError,
    validateCovariance: (value, name) => freezeMatrix(validateCovariance(value, name)),
    propagateLinear,
    numericalStateTransition,
    propagateCovariance,
    rtnBasis,
    resolveDeltaV,
    maneuverErrorCovariance,
    applyManeuverCovariance,
    createRng,
    sampleManeuver,
    confidenceEllipse,
    summarizeSamples,
    runMonteCarlo,
  });
})();
