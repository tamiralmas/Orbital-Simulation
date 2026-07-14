/* =============================================================================
 * Mission Trajectory Planner - ode.js
 * Deterministic adaptive integration for higher-fidelity dynamics.
 *
 * Dormand-Prince 5(4) with:
 *  - scalar or per-component relative/absolute tolerances
 *  - forward and backward integration
 *  - bounded adaptive steps and explicit work/output/event caps
 *  - quartic dense output at caller-requested times
 *  - direction-filtered, terminal or non-terminal zero-crossing events
 *
 * This module has no DOM or engine dependency and is safe to load from file://.
 * ========================================================================== */
"use strict";

(function () {
  const EPS = Number.EPSILON;

  class ODEError extends Error {
    constructor(code, message, details) {
      super(message);
      this.name = "AstroODEError";
      this.code = code;
      if (details) Object.assign(this, details);
    }
  }

  const C = [0, 1 / 5, 3 / 10, 4 / 5, 8 / 9, 1, 1];
  const A = [
    [],
    [1 / 5],
    [3 / 40, 9 / 40],
    [44 / 45, -56 / 15, 32 / 9],
    [19372 / 6561, -25360 / 2187, 64448 / 6561, -212 / 729],
    [9017 / 3168, -355 / 33, 46732 / 5247, 49 / 176, -5103 / 18656],
    [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84],
  ];
  const B5 = [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84, 0];
  const B4 = [5179 / 57600, 0, 7571 / 16695, 393 / 640,
    -92097 / 339200, 187 / 2100, 1 / 40];

  // Shampine's quartic continuous extension used with Dormand-Prince 5(4).
  // For theta=(t-t0)/h, y(theta)=y0+h*Q*[theta,theta^2,theta^3,theta^4].
  const DENSE_P = [
    [1, -8048581381 / 2820520608, 8663915743 / 2820520608,
      -12715105075 / 11282082432],
    [0, 0, 0, 0],
    [0, 131558114200 / 32700410799, -68118460800 / 10900136933,
      87487479700 / 32700410799],
    [0, -1754552775 / 470086768, 14199869525 / 1410260304,
      -10690763975 / 1880347072],
    [0, 127303824393 / 49829197408, -318862633887 / 49829197408,
      701980252875 / 199316789632],
    [0, -282668133 / 205662961, 2019193451 / 616988883,
      -1453857185 / 822651844],
    [0, 40617522 / 29380423, -110615467 / 29380423,
      69997945 / 29380423],
  ];

  function fail(code, message, details) {
    throw new ODEError(code, message, details);
  }

  function finiteNumber(value, name) {
    const n = Number(value);
    if (!Number.isFinite(n)) fail("INVALID_ARGUMENT", name + " must be finite.");
    return n;
  }

  function integerOption(value, fallback, name, minimum) {
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < minimum)
      fail("INVALID_ARGUMENT", name + " must be a safe integer >= " + minimum + ".");
    return n;
  }

  function positiveOption(value, fallback, name, allowZero) {
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n) || (allowZero ? n < 0 : n <= 0))
      fail("INVALID_ARGUMENT", name + " must be " + (allowZero ? "non-negative" : "positive") + ".");
    return n;
  }

  function toleranceVector(value, fallback, dimension, name, allowZero) {
    const source = value === undefined ? fallback : value;
    if (typeof source === "number") {
      if (!Number.isFinite(source) || (allowZero ? source < 0 : source <= 0))
        fail("INVALID_ARGUMENT", name + " must be " +
          (allowZero ? "non-negative" : "positive") + ".");
      return new Array(dimension).fill(source);
    }
    if (!Array.isArray(source) && !ArrayBuffer.isView(source))
      fail("INVALID_ARGUMENT", name + " must be a number or a vector.");
    if (source.length !== dimension)
      fail("INVALID_ARGUMENT", name + " must have " + dimension + " components.");
    const out = Array.from(source, Number);
    for (let i = 0; i < dimension; i++) {
      if (!Number.isFinite(out[i]) || (allowZero ? out[i] < 0 : out[i] <= 0))
        fail("INVALID_ARGUMENT", name + " component " + i + " is invalid.");
    }
    return out;
  }

  function cloneFiniteState(y0) {
    if ((!Array.isArray(y0) && !ArrayBuffer.isView(y0)) || y0.length < 1)
      fail("INVALID_ARGUMENT", "y0 must be a non-empty numeric vector.");
    const y = Array.from(y0, Number);
    for (let i = 0; i < y.length; i++) {
      if (!Number.isFinite(y[i]))
        fail("INVALID_ARGUMENT", "y0 component " + i + " must be finite.");
    }
    return y;
  }

  function snapshotStats(stats) {
    return {
      attemptedSteps: stats.attemptedSteps,
      acceptedSteps: stats.acceptedSteps,
      rejectedSteps: stats.rejectedSteps,
      rhsEvaluations: stats.rhsEvaluations,
      eventEvaluations: stats.eventEvaluations,
    };
  }

  function errorDetails(t, y, step, stats, extra) {
    return Object.assign({
      t,
      state: y.slice(),
      step,
      stats: snapshotStats(stats),
    }, extra || {});
  }

  function normalizeEvents(events) {
    if (events === undefined) return [];
    if (!Array.isArray(events)) fail("INVALID_ARGUMENT", "events must be an array.");
    return events.map((entry, index) => {
      const object = typeof entry === "function" ? { fn: entry } : entry;
      if (!object || typeof object.fn !== "function")
        fail("INVALID_ARGUMENT", "Event " + index + " must be a function or have fn(t, y).");
      const direction = object.direction === undefined ? 0 : Number(object.direction);
      if (direction !== -1 && direction !== 0 && direction !== 1)
        fail("INVALID_ARGUMENT", "Event " + index + " direction must be -1, 0, or 1.");
      return {
        fn: object.fn,
        direction,
        terminal: Boolean(object.terminal),
        name: object.name === undefined ? "event " + index : String(object.name),
      };
    });
  }

  function normalizeOutputTimes(options, t0, t1, direction, maxOutputPoints) {
    if (options.outputTimes !== undefined && options.outputStep !== undefined)
      fail("INVALID_ARGUMENT", "Use either outputTimes or outputStep, not both.");

    let times = null;
    if (options.outputTimes !== undefined) {
      if (!Array.isArray(options.outputTimes) && !ArrayBuffer.isView(options.outputTimes))
        fail("INVALID_ARGUMENT", "outputTimes must be a numeric vector.");
      if (options.outputTimes.length > maxOutputPoints)
        fail("MAX_OUTPUT_POINTS", "Requested output exceeds maxOutputPoints (" +
          maxOutputPoints + ").", { requested: options.outputTimes.length });
      times = Array.from(options.outputTimes, Number);
      const spanTol = 32 * EPS * Math.max(1, Math.abs(t0), Math.abs(t1));
      for (let i = 0; i < times.length; i++) {
        let value = times[i];
        if (!Number.isFinite(value))
          fail("INVALID_ARGUMENT", "outputTimes component " + i + " must be finite.");
        if (Math.abs(value - t0) <= spanTol) value = t0;
        if (Math.abs(value - t1) <= spanTol) value = t1;
        if (direction * (value - t0) < 0 || direction * (value - t1) > 0)
          fail("INVALID_ARGUMENT", "outputTimes must stay inside the integration interval.");
        if (i > 0 && direction * (value - times[i - 1]) < 0)
          fail("INVALID_ARGUMENT", "outputTimes must be monotonic in the integration direction.");
        times[i] = value;
      }
    } else if (options.outputStep !== undefined) {
      const step = positiveOption(options.outputStep, 0, "outputStep", false);
      const span = Math.abs(t1 - t0);
      const ratio = span / step;
      const intervals = Math.floor(ratio + 32 * EPS * Math.max(1, ratio));
      const timeTolerance = 32 * EPS * Math.max(1, span, intervals * step);
      const exactLast = Math.abs(intervals * step - span) <= timeTolerance;
      const count = intervals + 1 + (exactLast ? 0 : 1);
      if (count > maxOutputPoints)
        fail("MAX_OUTPUT_POINTS", "Requested output exceeds maxOutputPoints (" +
          maxOutputPoints + ").", { requested: count });
      times = new Array(count);
      for (let i = 0; i <= intervals; i++) times[i] = t0 + direction * i * step;
      if (!exactLast) times[count - 1] = t1;
      else times[count - 1] = t1; // make the endpoint bit-for-bit exact
    }
    return times;
  }

  function buildDenseStep(t0, y0, t1, y1, h, stages) {
    const dimension = y0.length;
    const q = Array.from({ length: dimension }, () => [0, 0, 0, 0]);
    for (let i = 0; i < dimension; i++) {
      for (let power = 0; power < 4; power++) {
        let sum = 0;
        for (let stage = 0; stage < 7; stage++)
          sum += stages[stage][i] * DENSE_P[stage][power];
        q[i][power] = sum;
      }
    }
    return { t0, t1, y0: y0.slice(), y1: y1.slice(), h, q };
  }

  function denseValue(step, time) {
    if (time === step.t0) return step.y0.slice();
    if (time === step.t1) return step.y1.slice();
    let theta = (time - step.t0) / step.h;
    theta = Math.max(0, Math.min(1, theta));
    const out = new Array(step.y0.length);
    for (let i = 0; i < out.length; i++) {
      const q = step.q[i];
      out[i] = step.y0[i] + step.h * theta *
        (q[0] + theta * (q[1] + theta * (q[2] + theta * q[3])));
    }
    return out;
  }

  function makeEvaluator(rhs, dimension, context, limits, stats) {
    return function evaluate(t, y) {
      if (stats.rhsEvaluations >= limits.maxEvaluations)
        fail("MAX_EVALUATIONS_EXCEEDED", "Derivative evaluation cap reached (" +
          limits.maxEvaluations + ").", errorDetails(t, y, 0, stats));
      let value;
      try {
        value = rhs(t, y, context);
      } catch (error) {
        if (error instanceof ODEError) throw error;
        fail("DERIVATIVE_FAILURE", "Derivative function failed at t=" + t + ": " +
          (error && error.message ? error.message : String(error)),
        errorDetails(t, y, 0, stats, { cause: error }));
      }
      stats.rhsEvaluations++;
      if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== dimension)
        fail("INVALID_DERIVATIVE", "Derivative must return " + dimension + " components.",
          errorDetails(t, y, 0, stats));
      const out = Array.from(value, Number);
      for (let i = 0; i < dimension; i++) {
        if (!Number.isFinite(out[i]))
          fail("NONFINITE_DERIVATIVE", "Derivative component " + i +
            " is non-finite at t=" + t + ".", errorDetails(t, y, 0, stats));
      }
      return out;
    };
  }

  function eventValue(event, index, t, y, context, stats) {
    let value;
    try {
      value = Number(event.fn(t, y, context));
    } catch (error) {
      fail("EVENT_FAILURE", "Event '" + event.name + "' failed at t=" + t + ": " +
        (error && error.message ? error.message : String(error)),
      errorDetails(t, y, 0, stats, { eventIndex: index, cause: error }));
    }
    stats.eventEvaluations++;
    if (!Number.isFinite(value))
      fail("NONFINITE_EVENT", "Event '" + event.name + "' returned a non-finite value at t=" +
        t + ".", errorDetails(t, y, 0, stats, { eventIndex: index }));
    return value;
  }

  function eventCrossed(left, right, event, integrationDirection) {
    if (left === 0) return false; // it was recorded at the preceding endpoint
    if (right !== 0 && (left < 0) === (right < 0)) return false;
    if (event.direction === 0) return true;
    const chronologicalChange = integrationDirection > 0 ? right - left : left - right;
    return event.direction * chronologicalChange > 0;
  }

  function locateEvent(event, index, dense, f0, f1, options, context, stats) {
    if (f1 === 0) return { fraction: 1, t: dense.t1, y: dense.y1.slice(), value: 0 };
    let lo = 0, hi = 1, flo = f0, fhi = f1;
    const timeTolerance = options.eventTimeTolerance;
    for (let iteration = 0; iteration < options.maxEventIterations; iteration++) {
      const mid = 0.5 * (lo + hi);
      const t = dense.t0 + mid * dense.h;
      const y = denseValue(dense, t);
      const fm = eventValue(event, index, t, y, context, stats);
      if (fm === 0 || Math.abs((hi - lo) * dense.h) <= timeTolerance)
        return { fraction: mid, t, y, value: fm };
      if ((flo < 0) === (fm < 0)) { lo = mid; flo = fm; }
      else { hi = mid; fhi = fm; }
    }
    const width = Math.abs((hi - lo) * dense.h);
    fail("EVENT_ROOT_FAILURE", "Event '" + event.name +
      "' root did not converge within " + options.maxEventIterations + " iterations.",
    errorDetails(dense.t0, dense.y0, dense.h, stats,
      { eventIndex: index, bracketWidth: width, bracketValues: [flo, fhi] }));
  }

  function initialStepSize(t, y, direction, span, maxStep, atol, rtol, evaluate, f0) {
    const dimension = y.length;
    let d0 = 0, d1 = 0;
    for (let i = 0; i < dimension; i++) {
      const scale = Math.max(Number.MIN_VALUE,
        atol[i] + rtol[i] * Math.abs(y[i]));
      const ys = y[i] / scale, fs = f0[i] / scale;
      d0 += ys * ys;
      d1 += fs * fs;
    }
    d0 = Math.sqrt(d0 / dimension);
    d1 = Math.sqrt(d1 / dimension);
    let h0 = d0 < 1e-5 || d1 < 1e-5 ? 1e-6 : 0.01 * d0 / d1;
    h0 = Math.min(h0, span, maxStep);
    if (!(h0 > 0)) return Math.min(span, maxStep);
    const trial = y.map((value, i) => value + direction * h0 * f0[i]);
    const f1 = evaluate(t + direction * h0, trial);
    let d2 = 0;
    for (let i = 0; i < dimension; i++) {
      const scale = Math.max(Number.MIN_VALUE,
        atol[i] + rtol[i] * Math.max(Math.abs(y[i]), Math.abs(trial[i])));
      const value = (f1[i] - f0[i]) / scale;
      d2 += value * value;
    }
    d2 = Math.sqrt(d2 / dimension) / h0;
    const curvature = Math.max(d1, d2);
    const h1 = curvature <= 1e-15 ? Math.max(1e-6, h0 * 1e-3)
      : Math.pow(0.01 / curvature, 1 / 5);
    return Math.min(100 * h0, h1, span, maxStep);
  }

  function resultObject(status, message, outputT, outputY, tFinal, yFinal, events, stats) {
    return {
      success: true,
      status,
      message,
      t: outputT,
      y: outputY,
      tFinal,
      yFinal: yFinal.slice(),
      events,
      stats: snapshotStats(stats),
    };
  }

  /**
   * Integrate y'=rhs(t,y,context) from t0 to t1.
   *
   * Default output contains the initial state and every accepted step endpoint.
   * `outputTimes` returns only those monotonic requested epochs; `outputStep`
   * generates fixed epochs including both interval endpoints. A terminal event
   * may end the integration before later requested output epochs.
   */
  function integrate(rhs, t0Value, y0Value, t1Value, options) {
    if (typeof rhs !== "function") fail("INVALID_ARGUMENT", "rhs must be a function.");
    const t0 = finiteNumber(t0Value, "t0");
    const t1 = finiteNumber(t1Value, "t1");
    const y = cloneFiniteState(y0Value);
    options = options || {};
    if (typeof options !== "object") fail("INVALID_ARGUMENT", "options must be an object.");

    const span = Math.abs(t1 - t0);
    if (!Number.isFinite(span))
      fail("INVALID_ARGUMENT", "The integration interval is too large for finite arithmetic.");
    const dimension = y.length;
    const rtol = toleranceVector(options.rtol, 1e-9, dimension, "rtol", true);
    const atol = toleranceVector(options.atol, 1e-12, dimension, "atol", true);
    for (let i = 0; i < dimension; i++) {
      if (rtol[i] === 0 && atol[i] === 0)
        fail("INVALID_ARGUMENT", "rtol and atol cannot both be zero for component " + i + ".");
    }

    const limits = {
      maxSteps: integerOption(options.maxSteps, 100000, "maxSteps", 1),
      maxRejectedSteps: integerOption(options.maxRejectedSteps, 10000,
        "maxRejectedSteps", 0),
      maxOutputPoints: integerOption(options.maxOutputPoints, 100001,
        "maxOutputPoints", 0),
      maxEvents: integerOption(options.maxEvents, 1000, "maxEvents", 0),
      maxEvaluations: integerOption(options.maxEvaluations, 1000000,
        "maxEvaluations", 1),
    };
    const eventOptions = {
      maxEventIterations: integerOption(options.maxEventIterations, 80,
        "maxEventIterations", 1),
      eventTimeTolerance: positiveOption(options.eventTimeTolerance,
        Math.max(1e-12, 32 * EPS * Math.max(1, Math.abs(t0), Math.abs(t1))),
        "eventTimeTolerance", false),
    };
    const events = normalizeEvents(options.events);
    const direction = t1 >= t0 ? 1 : -1;
    const requestedTimes = normalizeOutputTimes(options, t0, t1, direction,
      limits.maxOutputPoints);
    const fixedOutput = requestedTimes !== null;
    const outputT = [], outputY = [], foundEvents = [];
    const stats = {
      attemptedSteps: 0,
      acceptedSteps: 0,
      rejectedSteps: 0,
      rhsEvaluations: 0,
      eventEvaluations: 0,
    };
    const context = options.context;
    const evaluate = makeEvaluator(rhs, dimension, context, limits, stats);

    function appendOutput(time, state) {
      if (outputT.length >= limits.maxOutputPoints)
        fail("MAX_OUTPUT_POINTS", "Output point cap reached (" +
          limits.maxOutputPoints + ").", errorDetails(time, state, 0, stats));
      outputT.push(time);
      outputY.push(state.slice());
    }

    let outputIndex = 0;
    if (fixedOutput) {
      while (outputIndex < requestedTimes.length && requestedTimes[outputIndex] === t0) {
        appendOutput(t0, y);
        outputIndex++;
      }
    } else {
      appendOutput(t0, y);
    }

    const initialEventValues = events.map((event, index) =>
      eventValue(event, index, t0, y, context, stats));
    let initialTerminal = false;
    for (let i = 0; i < events.length; i++) {
      if (initialEventValues[i] !== 0) continue;
      if (foundEvents.length >= limits.maxEvents)
        fail("MAX_EVENTS_EXCEEDED", "Event occurrence cap reached (" +
          limits.maxEvents + ").", errorDetails(t0, y, 0, stats, { eventIndex: i }));
      foundEvents.push({
        index: i,
        name: events[i].name,
        t: t0,
        y: y.slice(),
        value: 0,
        direction: events[i].direction,
        terminal: events[i].terminal,
      });
      if (events[i].terminal) initialTerminal = true;
    }
    if (initialTerminal)
      return resultObject("event", "A terminal event occurred at the initial epoch.",
        outputT, outputY, t0, y, foundEvents, stats);

    if (t0 === t1)
      return resultObject("finished", "The integration interval has zero duration.",
        outputT, outputY, t0, y, foundEvents, stats);

    const minStep = positiveOption(options.minStep, 0, "minStep", true);
    const maxStep = positiveOption(options.maxStep, span, "maxStep", false);
    if (minStep > maxStep)
      fail("INVALID_ARGUMENT", "minStep cannot exceed maxStep.");
    let f = evaluate(t0, y);
    let hAbs;
    if (options.initialStep !== undefined) {
      hAbs = positiveOption(options.initialStep, 0, "initialStep", false);
    } else {
      hAbs = initialStepSize(t0, y, direction, span, maxStep, atol, rtol, evaluate, f);
    }
    hAbs = Math.min(span, maxStep, Math.max(minStep, hAbs));

    let t = t0;
    let state = y.slice();
    let eventValues = initialEventValues;
    while (direction * (t1 - t) > 0) {
      if (stats.attemptedSteps >= limits.maxSteps)
        fail("MAX_STEPS_EXCEEDED", "Adaptive step cap reached (" +
          limits.maxSteps + ") before t1.", errorDetails(t, state, direction * hAbs, stats));

      const remaining = Math.abs(t1 - t);
      hAbs = Math.min(hAbs, maxStep, remaining);
      const machineFloor = 16 * EPS * Math.max(1, Math.abs(t));
      if (!(hAbs > 0) || t + direction * hAbs === t || hAbs < machineFloor)
        fail("STEP_UNDERFLOW", "Step size underflow at t=" + t + ".",
          errorDetails(t, state, direction * hAbs, stats,
            { machineFloor, configuredMinStep: minStep }));

      const h = direction * hAbs;
      stats.attemptedSteps++;
      const stages = new Array(7);
      stages[0] = f;
      for (let stage = 1; stage < 7; stage++) {
        const trial = new Array(dimension);
        for (let i = 0; i < dimension; i++) {
          let sum = 0;
          for (let j = 0; j < stage; j++) sum += A[stage][j] * stages[j][i];
          trial[i] = state[i] + h * sum;
        }
        stages[stage] = evaluate(t + C[stage] * h, trial);
      }

      const candidate = new Array(dimension);
      let errorNormSq = 0;
      for (let i = 0; i < dimension; i++) {
        let y5 = state[i], error = 0;
        for (let stage = 0; stage < 7; stage++) {
          y5 += h * B5[stage] * stages[stage][i];
          error += h * (B5[stage] - B4[stage]) * stages[stage][i];
        }
        if (!Number.isFinite(y5))
          fail("NONFINITE_STATE", "Integrated state component " + i +
            " became non-finite at t=" + (t + h) + ".",
          errorDetails(t, state, h, stats));
        candidate[i] = y5;
        const scale = Math.max(Number.MIN_VALUE,
          atol[i] + rtol[i] * Math.max(Math.abs(state[i]), Math.abs(y5)));
        const normalized = error / scale;
        errorNormSq += normalized * normalized;
      }
      const errorNorm = Math.sqrt(errorNormSq / dimension);
      const accepted = Number.isFinite(errorNorm) && errorNorm <= 1;
      const factor = errorNorm === 0 ? 10 : !Number.isFinite(errorNorm) ? 0.2
        : Math.max(0.2, Math.min(accepted ? 10 : 1, 0.9 * Math.pow(errorNorm, -1 / 5)));

      if (!accepted) {
        stats.rejectedSteps++;
        if (stats.rejectedSteps > limits.maxRejectedSteps)
          fail("MAX_REJECTIONS_EXCEEDED", "Rejected-step cap reached (" +
            limits.maxRejectedSteps + ").", errorDetails(t, state, h, stats,
            { errorNorm }));
        const reduced = hAbs * factor;
        if (reduced < minStep && remaining > minStep)
          fail("MIN_STEP_EXCEEDED", "Required step is smaller than minStep at t=" + t + ".",
            errorDetails(t, state, h, stats,
              { errorNorm, requiredStep: reduced, configuredMinStep: minStep }));
        hAbs = reduced;
        continue;
      }

      const tNext = remaining === hAbs ? t1 : t + h;
      const dense = buildDenseStep(t, state, tNext, candidate, h, stages);
      const nextEventValues = events.map((event, index) =>
        eventValue(event, index, tNext, candidate, context, stats));
      const roots = [];
      for (let i = 0; i < events.length; i++) {
        if (!eventCrossed(eventValues[i], nextEventValues[i], events[i], direction)) continue;
        const root = locateEvent(events[i], i, dense, eventValues[i], nextEventValues[i],
          eventOptions, context, stats);
        roots.push({ event: events[i], index: i, root });
      }
      roots.sort((left, right) => left.root.fraction - right.root.fraction ||
        left.index - right.index);

      let terminal = null;
      for (const occurrence of roots) {
        if (terminal && occurrence.root.fraction > terminal.root.fraction) break;
        if (foundEvents.length >= limits.maxEvents)
          fail("MAX_EVENTS_EXCEEDED", "Event occurrence cap reached (" +
            limits.maxEvents + ").", errorDetails(occurrence.root.t,
          occurrence.root.y, h, stats, { eventIndex: occurrence.index }));
        foundEvents.push({
          index: occurrence.index,
          name: occurrence.event.name,
          t: occurrence.root.t,
          y: occurrence.root.y.slice(),
          value: occurrence.root.value,
          direction: occurrence.event.direction,
          terminal: occurrence.event.terminal,
        });
        if (occurrence.event.terminal && !terminal) terminal = occurrence;
      }

      const acceptedEndT = terminal ? terminal.root.t : tNext;
      const acceptedEndY = terminal ? terminal.root.y : candidate;
      if (fixedOutput) {
        const timeSlack = 32 * EPS * Math.max(1, Math.abs(acceptedEndT));
        while (outputIndex < requestedTimes.length &&
          direction * (requestedTimes[outputIndex] - acceptedEndT) <= timeSlack) {
          const outputTime = requestedTimes[outputIndex];
          if (direction * (outputTime - t) >= -timeSlack)
            appendOutput(outputTime, denseValue(dense, outputTime));
          outputIndex++;
        }
      } else {
        appendOutput(acceptedEndT, acceptedEndY);
      }

      stats.acceptedSteps++;
      if (terminal)
        return resultObject("event", "A terminal event stopped the integration.",
          outputT, outputY, acceptedEndT, acceptedEndY, foundEvents, stats);

      t = tNext;
      state = candidate;
      f = stages[6]; // FSAL: k7 is the next accepted step's k1
      eventValues = nextEventValues;
      hAbs *= factor;
    }

    return resultObject("finished", "Integration reached t1.",
      outputT, outputY, t, state, foundEvents, stats);
  }

  globalThis.AstroODE = {
    integrate,
    ODEError,
  };
})();
