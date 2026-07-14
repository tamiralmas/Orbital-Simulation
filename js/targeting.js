/* =============================================================================
 * Mission Trajectory Planner — targeting.js
 * Reusable bounded targeting helpers for return corridors and later
 * GMAT-style Vary/Achieve controls. Dependency-free; load after kepler.js.
 * ========================================================================== */
"use strict";

(function () {
  const A = globalThis.Astro;
  if (!A) throw new Error("targeting.js requires kepler.js to be loaded first.");
  const V = A.V;
  const TWO_PI = 2 * Math.PI;

  function finiteVector(value, label) {
    if (!value || value.length < 3)
      throw new TypeError(`${label} must contain three finite values.`);
    const out = [Number(value[0]), Number(value[1]), Number(value[2])];
    if (!out.every(Number.isFinite))
      throw new TypeError(`${label} must contain three finite values.`);
    return out;
  }

  function arrivalPlane(r1, v1, normal) {
    const e1 = V.norm(finiteVector(r1, "departure position"));
    let h = normal ? finiteVector(normal, "plane normal")
      : V.cross(r1, finiteVector(v1, "departure velocity"));
    if (V.mag(h) < 1e-12) {
      const reference = Math.abs(e1[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
      h = V.cross(e1, reference);
    }
    h = V.norm(h);
    const e2 = V.norm(V.cross(h, e1));
    return { e1, e2, h };
  }

  function pointOnCircle(plane, radius, theta) {
    return V.scale(V.add(V.scale(plane.e1, Math.cos(theta)),
      V.scale(plane.e2, Math.sin(theta))), radius);
  }

  function lambertAtAngle(r1, tof, mu, rpTarget, plane, theta, prograde) {
    const r2 = pointOnCircle(plane, rpTarget, theta);
    const solution = A.lambert(r1, r2, tof, mu, prograde);
    if (!solution) return null;
    return {
      theta,
      prograde,
      r2,
      v1: solution.v1,
      v2: solution.v2,
      radialSpeed: V.dot(r2, solution.v2) / rpTarget,
    };
  }

  function refineTangency(r1, tof, mu, rpTarget, plane, prograde, a, b) {
    let lo = a.theta, hi = b.theta, flo = a.radialSpeed, fhi = b.radialSpeed;
    let best = Math.abs(flo) <= Math.abs(fhi) ? a : b;
    for (let iteration = 0; iteration < 72; iteration++) {
      const mid = 0.5 * (lo + hi);
      const sample = lambertAtAngle(r1, tof, mu, rpTarget, plane, mid, prograde);
      if (!sample) return best;
      if (Math.abs(sample.radialSpeed) < Math.abs(best.radialSpeed)) best = sample;
      if (Math.abs(sample.radialSpeed) < 1e-12 || hi - lo < 2e-14) break;
      if (flo * sample.radialSpeed <= 0) {
        hi = mid;
        fhi = sample.radialSpeed;
      } else {
        lo = mid;
        flo = sample.radialSpeed;
      }
    }
    return best;
  }

  function isPeriapsisArrival(candidate, mu, rpTarget, tof) {
    const speed = V.mag(candidate.v2);
    const circular = Math.sqrt(mu / rpTarget);
    if (speed < circular * (1 - 2e-9)) return false;
    const coe = A.rvToCoe(candidate.r2, candidate.v2, mu);
    if (!isFinite(coe.rp) || Math.abs(coe.rp - rpTarget) > Math.max(0.01, rpTarget * 1e-8))
      return false;
    const probe = Math.max(0.1, Math.min(60, tof * 1e-5));
    const before = A.propagateUniversal(candidate.r2, candidate.v2, -probe, mu);
    return V.dot(before.r, before.v) < 0;
  }

  function sameRoot(a, b) {
    const d = Math.abs(a.theta - b.theta);
    return a.prograde === b.prograde && Math.min(d, TWO_PI - d) < 1e-7;
  }

  /**
   * Solve a single-revolution Lambert arrival whose endpoint is the requested
   * periapsis, rather than merely a point at the requested radius.
   *
   * options: { r1, vCurrent, tof, mu, rpTarget, normal?, angleSamples? }
   * Returns { best, candidates, plane }. Each candidate includes the exact
   * tangent endpoint, achieved rp, radial residual, and departure delta-v.
   */
  function solveLambertToPeriapsis(options) {
    const opts = options || {};
    const r1 = finiteVector(opts.r1, "departure position");
    const vCurrent = finiteVector(opts.vCurrent, "departure velocity");
    const tof = +opts.tof, mu = +opts.mu, rpTarget = +opts.rpTarget;
    if (!(tof > 0) || !(mu > 0) || !(rpTarget > 0) ||
        ![tof, mu, rpTarget].every(Number.isFinite))
      throw new RangeError("tof, mu, and rpTarget must be finite positive values.");
    const plane = arrivalPlane(r1, vCurrent, opts.normal);
    const samples = Math.max(48, Math.min(720, Math.round(+opts.angleSamples || 144)));
    const candidates = [];

    for (const prograde of [true, false]) {
      let previous = null;
      for (let index = 0; index <= samples; index++) {
        const theta = TWO_PI * index / samples;
        const current = lambertAtAngle(r1, tof, mu, rpTarget,
          plane, theta, prograde);
        if (!current) {
          previous = null;
          continue;
        }
        let root = null;
        if (Math.abs(current.radialSpeed) < 1e-10) root = current;
        else if (previous && previous.radialSpeed * current.radialSpeed < 0)
          root = refineTangency(r1, tof, mu, rpTarget, plane,
            prograde, previous, current);
        if (root && isPeriapsisArrival(root, mu, rpTarget, tof)) {
          const coe = A.rvToCoe(root.r2, root.v2, mu);
          const dvVec = V.sub(root.v1, vCurrent);
          const record = Object.assign(root, {
            dvVec,
            dv: V.mag(dvVec),
            rpAchieved: coe.rp,
            eccentricity: coe.e,
          });
          if (!candidates.some((item) => sameRoot(item, record))) candidates.push(record);
        }
        previous = current;
      }
    }
    candidates.sort((a, b) => a.dv - b.dv);
    return { best: candidates[0] || null, candidates, plane };
  }

  /** Bounded hybrid secant/bisection scalar solve with a readable report. */
  function solveBoundedScalar(fn, lowerValue, upperValue, options) {
    const opts = options || {};
    let lower = +lowerValue, upper = +upperValue;
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || !(upper > lower))
      throw new RangeError("Scalar target bounds must be finite and increasing.");
    const tolerance = opts.tolerance === undefined ? 1e-9 : +opts.tolerance;
    const xTolerance = opts.xTolerance === undefined ? 1e-12 : +opts.xTolerance;
    const maxIterations = Math.max(1, Math.min(200,
      Math.round(opts.maxIterations === undefined ? 72 : +opts.maxIterations)));
    if (!(tolerance > 0) || !(xTolerance > 0))
      throw new RangeError("Scalar target tolerances must be positive.");
    let fLower = +fn(lower), fUpper = +fn(upper);
    if (!Number.isFinite(fLower) || !Number.isFinite(fUpper))
      return { converged: false, status: "nonfinite-bound", lower, upper,
        fLower, fUpper, iterations: 0 };
    if (Math.abs(fLower) <= tolerance)
      return { converged: true, status: "converged", value: lower,
        residual: fLower, lower, upper, iterations: 0 };
    if (Math.abs(fUpper) <= tolerance)
      return { converged: true, status: "converged", value: upper,
        residual: fUpper, lower, upper, iterations: 0 };
    if (fLower * fUpper > 0)
      return { converged: false, status: "unbracketed", lower, upper,
        fLower, fUpper, iterations: 0 };
    let bestValue = Math.abs(fLower) < Math.abs(fUpper) ? lower : upper;
    let bestResidual = Math.abs(fLower) < Math.abs(fUpper) ? fLower : fUpper;
    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      let value = upper - fUpper * (upper - lower) / (fUpper - fLower);
      const width = upper - lower;
      if (!(value > lower + 0.1 * width && value < upper - 0.1 * width))
        value = 0.5 * (lower + upper);
      const residual = +fn(value);
      if (!Number.isFinite(residual))
        return { converged: false, status: "nonfinite-iterate", value,
          residual, lower, upper, iterations: iteration };
      if (Math.abs(residual) < Math.abs(bestResidual)) {
        bestValue = value;
        bestResidual = residual;
      }
      if (Math.abs(residual) <= tolerance || width <= xTolerance) {
        return { converged: true, status: "converged", value,
          residual, lower, upper, iterations: iteration };
      }
      if (fLower * residual <= 0) {
        upper = value;
        fUpper = residual;
      } else {
        lower = value;
        fLower = residual;
      }
    }
    return { converged: false, status: "iteration-limit", value: bestValue,
      residual: bestResidual, lower, upper, iterations: maxIterations };
  }

  /**
   * Vary a tangential insertion impulse at a known apsis to achieve either an
   * opposite-apsis radius or an orbital period. This is the bounded engine
   * behind the Planner's GMAT-style Vary/Achieve insertion control.
   */
  function solveInsertionImpulse(options) {
    const opts = options || {};
    const r = finiteVector(opts.r, "position");
    const v = finiteVector(opts.v, "velocity");
    const mu = +opts.mu;
    const at = String(opts.at || "periapsis").toLowerCase();
    const goal = String(opts.goal || "opposite-apsis").toLowerCase();
    const target = +opts.target;
    if (!(mu > 0) || !(target > 0) || !Number.isFinite(mu) || !Number.isFinite(target))
      throw new RangeError("mu and insertion target must be finite positive values.");
    if (at !== "periapsis" && at !== "apoapsis")
      throw new RangeError("at must be 'periapsis' or 'apoapsis'.");
    if (goal !== "opposite-apsis" && goal !== "period")
      throw new RangeError("goal must be 'opposite-apsis' or 'period'.");
    const radius = V.mag(r);
    const radialDirection = V.scale(r, 1 / radius);
    const radialSpeed = V.dot(v, radialDirection);
    const tangentVelocity = V.sub(v, V.scale(radialDirection, radialSpeed));
    const tangentSpeed = V.mag(tangentVelocity);
    if (!(tangentSpeed > 0)) throw new RangeError("Tangential speed is zero at insertion.");
    if (Math.abs(radialSpeed) > Math.max(1e-8, tangentSpeed * 1e-5))
      throw new RangeError("Insertion targeting requires a state at an apsis (radial speed near zero).");
    const tangent = V.scale(tangentVelocity, 1 / tangentSpeed);
    let targetA;
    if (goal === "period")
      targetA = Math.cbrt(mu * Math.pow(target / TWO_PI, 2));
    else targetA = 0.5 * (radius + target);
    const oppositeRadius = 2 * targetA - radius;
    if (!(targetA > radius / 2) || !(oppositeRadius > 0))
      throw new RangeError("Requested insertion orbit has no positive opposite apsis.");
    if (at === "periapsis" && oppositeRadius < radius - 1e-7)
      throw new RangeError("A periapsis burn cannot target an apoapsis below the burn radius.");
    if (at === "apoapsis" && oppositeRadius > radius + 1e-7)
      throw new RangeError("An apoapsis burn cannot target a periapsis above the burn radius.");
    const requiredSpeed = Math.sqrt(mu * (2 / radius - 1 / targetA));
    const expectedDv = requiredSpeed - tangentSpeed;
    const margin = Math.max(0.05, Math.abs(expectedDv) * 0.5 + 0.01);
    const measure = (dv) => {
      const trialV = V.add(v, V.scale(tangent, dv));
      const coe = A.rvToCoe(r, trialV, mu);
      if (!(coe.a > 0) || !(coe.e < 1)) return Number.POSITIVE_INFINITY;
      if (goal === "period")
        return TWO_PI * Math.sqrt(coe.a * coe.a * coe.a / mu) - target;
      const achieved = at === "periapsis" ? coe.ra : coe.rp;
      return achieved - target;
    };
    let lower = expectedDv - margin, upper = expectedDv + margin;
    let report = solveBoundedScalar(measure, lower, upper, {
      tolerance: goal === "period" ? 1e-5 : 1e-6,
      xTolerance: 1e-13,
      maxIterations: 80,
    });
    if (!report.converged) {
      // A near-escape upper trial can be non-finite. The analytic vis-viva
      // estimate is still safely inside the elliptic branch, so tighten the
      // bracket symmetrically around it and retry.
      lower = expectedDv - margin * 0.25;
      upper = expectedDv + margin * 0.25;
      report = solveBoundedScalar(measure, lower, upper, {
        tolerance: goal === "period" ? 1e-5 : 1e-6,
        xTolerance: 1e-13,
        maxIterations: 80,
      });
    }
    if (!report.converged)
      return { converged: false, report, at, goal, target };
    const dvVec = V.scale(tangent, report.value);
    const finalV = V.add(v, dvVec);
    const coe = A.rvToCoe(r, finalV, mu);
    return {
      converged: true,
      report,
      at,
      goal,
      target,
      dvVec,
      dv: Math.abs(report.value),
      signedDv: report.value,
      finalV,
      achievedOppositeRadius: at === "periapsis" ? coe.ra : coe.rp,
      achievedPeriod: TWO_PI * Math.sqrt(coe.a * coe.a * coe.a / mu),
      elements: coe,
    };
  }

  function normalizeTransferEvaluation(value, target) {
    const record = value && typeof value === "object" ? value : { achieved: value };
    const achieved = Number(record.achieved !== undefined ? record.achieved
      : record.achievedPeriapsisKm);
    const residual = record.residual === undefined ? achieved - target
      : Number(record.residual);
    return {
      valid: Number.isFinite(achieved) && Number.isFinite(residual) && record.valid !== false,
      achieved,
      residual,
      detail: record,
    };
  }

  /**
   * Bounded two-variable Vary/Achieve solver for a Transfer card.
   *
   * The caller supplies the downstream evaluator because only the mission
   * propagator knows how a date/TOF pair maps to the requested arrival
   * condition. Both variables are differentiated and stepped together by a
   * damped Gauss-Newton update; a bounded pattern-search fallback handles a
   * flat or invalid local derivative. The scalar goal is intentionally
   * under-determined, so the normalized distance from the seed is used only
   * as a tie-breaker, never as the convergence criterion.
   *
   * options: {
   *   evaluate({ departureJD, tofDays }) -> achieved number or record,
   *   target, departureBoundsJD:[lo,hi], tofBoundsDays:[lo,hi],
   *   initialDepartureJD?, initialTofDays?, toleranceKm?, maxIterations?,
   *   maxEvaluations?
   * }
   */
  function solveTransferDateTof(options) {
    const opts = options || {};
    if (typeof opts.evaluate !== "function")
      throw new TypeError("Transfer targeting requires an evaluate function.");
    const target = Number(opts.target);
    const dateBounds = opts.departureBoundsJD;
    const tofBounds = opts.tofBoundsDays;
    if (!Number.isFinite(target)) throw new RangeError("Transfer target must be finite.");
    if (!Array.isArray(dateBounds) || dateBounds.length < 2 ||
        !dateBounds.slice(0, 2).every(Number.isFinite) || !(dateBounds[1] > dateBounds[0]))
      throw new RangeError("Departure-date bounds must be finite and increasing.");
    if (!Array.isArray(tofBounds) || tofBounds.length < 2 ||
        !tofBounds.slice(0, 2).every(Number.isFinite) || !(tofBounds[1] > tofBounds[0]) ||
        !(tofBounds[0] > 0))
      throw new RangeError("TOF bounds must be finite, positive, and increasing.");
    const tolerance = opts.toleranceKm === undefined ? 1 : Number(opts.toleranceKm);
    const maxIterations = Math.max(1, Math.min(80, Math.round(
      opts.maxIterations === undefined ? 36 : Number(opts.maxIterations))));
    const maxEvaluations = Math.max(9, Math.min(500, Math.round(
      opts.maxEvaluations === undefined ? 220 : Number(opts.maxEvaluations))));
    if (!(tolerance > 0) || !Number.isFinite(tolerance))
      throw new RangeError("Transfer target tolerance must be positive.");
    const clamp = (value, bounds) => Math.max(bounds[0], Math.min(bounds[1], value));
    const dateSpan = dateBounds[1] - dateBounds[0];
    const tofSpan = tofBounds[1] - tofBounds[0];
    const seed = {
      departureJD: clamp(Number.isFinite(Number(opts.initialDepartureJD))
        ? Number(opts.initialDepartureJD) : 0.5 * (dateBounds[0] + dateBounds[1]), dateBounds),
      tofDays: clamp(Number.isFinite(Number(opts.initialTofDays))
        ? Number(opts.initialTofDays) : 0.5 * (tofBounds[0] + tofBounds[1]), tofBounds),
    };
    let evaluations = 0;
    const history = [];
    const evaluate = (departureJD, tofDays) => {
      if (evaluations >= maxEvaluations) return null;
      let raw;
      try { raw = opts.evaluate({ departureJD, tofDays }); }
      catch (error) { raw = { valid: false, error: error && error.message }; }
      evaluations++;
      const normalized = normalizeTransferEvaluation(raw, target);
      const record = {
        departureJD, tofDays, achieved: normalized.achieved,
        residual: normalized.residual, valid: normalized.valid,
        detail: normalized.detail,
      };
      history.push(record);
      return record;
    };
    const distance = (record) => {
      const dd = (record.departureJD - seed.departureJD) / dateSpan;
      const dt = (record.tofDays - seed.tofDays) / tofSpan;
      return dd * dd + dt * dt;
    };
    const better = (candidate, current) => candidate && candidate.valid &&
      (!current || !current.valid || Math.abs(candidate.residual) < Math.abs(current.residual) - 1e-12 ||
       (Math.abs(Math.abs(candidate.residual) - Math.abs(current.residual)) <= 1e-12 &&
        distance(candidate) < distance(current)));
    let current = evaluate(seed.departureJD, seed.tofDays);
    let best = current && current.valid ? current : null;
    let dateTrust = dateSpan * 0.25;
    let tofTrust = tofSpan * 0.25;
    let status = "iteration-limit";
    let iteration = 0;

    for (iteration = 1; iteration <= maxIterations && evaluations < maxEvaluations; iteration++) {
      if (best && Math.abs(best.residual) <= tolerance) { status = "converged"; break; }
      if (!current || !current.valid) current = best;
      if (!current) {
        current = evaluate(0.5 * (dateBounds[0] + dateBounds[1]),
          0.5 * (tofBounds[0] + tofBounds[1]));
        if (better(current, best)) best = current;
        if (!current || !current.valid) { status = "no-valid-evaluation"; break; }
      }

      const hDate = Math.max(dateSpan * 1e-6, Math.min(dateTrust * 0.2, dateSpan * 0.02));
      const hTof = Math.max(tofSpan * 1e-6, Math.min(tofTrust * 0.2, tofSpan * 0.02));
      const dateProbeX = clamp(current.departureJD +
        (current.departureJD + hDate <= dateBounds[1] ? hDate : -hDate), dateBounds);
      const tofProbeX = clamp(current.tofDays +
        (current.tofDays + hTof <= tofBounds[1] ? hTof : -hTof), tofBounds);
      const dateProbe = evaluate(dateProbeX, current.tofDays);
      const tofProbe = evaluate(current.departureJD, tofProbeX);
      if (better(dateProbe, best)) best = dateProbe;
      if (better(tofProbe, best)) best = tofProbe;
      const gd = dateProbe && dateProbe.valid && dateProbeX !== current.departureJD
        ? (dateProbe.residual - current.residual) / (dateProbeX - current.departureJD) : 0;
      const gt = tofProbe && tofProbe.valid && tofProbeX !== current.tofDays
        ? (tofProbe.residual - current.residual) / (tofProbeX - current.tofDays) : 0;
      const scaledD = gd * dateSpan, scaledT = gt * tofSpan;
      const norm2 = scaledD * scaledD + scaledT * scaledT;
      let accepted = null;
      if (norm2 > 1e-24 && Number.isFinite(norm2)) {
        const normalizedDateStep = -current.residual * scaledD / norm2;
        const normalizedTofStep = -current.residual * scaledT / norm2;
        let scale = 1;
        for (let line = 0; line < 8 && evaluations < maxEvaluations; line++) {
          const candidate = evaluate(
            clamp(current.departureJD + Math.max(-dateTrust, Math.min(dateTrust,
              normalizedDateStep * dateSpan * scale)), dateBounds),
            clamp(current.tofDays + Math.max(-tofTrust, Math.min(tofTrust,
              normalizedTofStep * tofSpan * scale)), tofBounds));
          if (better(candidate, best)) best = candidate;
          if (candidate && candidate.valid &&
              Math.abs(candidate.residual) < Math.abs(current.residual)) {
            accepted = candidate; break;
          }
          scale *= 0.5;
        }
      }
      if (!accepted) {
        const directions = [[1, 1], [1, -1], [-1, 1], [-1, -1],
          [1, 0], [-1, 0], [0, 1], [0, -1]];
        for (const direction of directions) {
          if (evaluations >= maxEvaluations) break;
          const candidate = evaluate(clamp(current.departureJD + direction[0] * dateTrust,
            dateBounds), clamp(current.tofDays + direction[1] * tofTrust, tofBounds));
          if (better(candidate, best)) best = candidate;
          if (better(candidate, accepted || current)) accepted = candidate;
        }
      }
      if (accepted && accepted.valid &&
          Math.abs(accepted.residual) < Math.abs(current.residual)) {
        current = accepted;
        dateTrust = Math.min(dateSpan * 0.5, dateTrust * 1.15);
        tofTrust = Math.min(tofSpan * 0.5, tofTrust * 1.15);
      } else {
        dateTrust *= 0.5;
        tofTrust *= 0.5;
      }
      if (dateTrust <= Math.max(1e-8, dateSpan * 1e-9) &&
          tofTrust <= Math.max(1e-8, tofSpan * 1e-9)) {
        status = best && Math.abs(best.residual) <= tolerance ? "converged" : "bounds-exhausted";
        break;
      }
    }
    if (best && Math.abs(best.residual) <= tolerance) status = "converged";
    else if (evaluations >= maxEvaluations) status = "evaluation-limit";
    const report = {
      converged: status === "converged",
      status,
      target,
      toleranceKm: tolerance,
      departureBoundsJD: dateBounds.slice(0, 2),
      tofBoundsDays: tofBounds.slice(0, 2),
      initialDepartureJD: seed.departureJD,
      initialTofDays: seed.tofDays,
      departureJD: best ? best.departureJD : null,
      tofDays: best ? best.tofDays : null,
      achieved: best ? best.achieved : null,
      residual: best ? best.residual : null,
      iterations: Math.min(iteration, maxIterations),
      evaluations,
      variedDeparture: !!best && Math.abs(best.departureJD - seed.departureJD) > dateSpan * 1e-10,
      variedTof: !!best && Math.abs(best.tofDays - seed.tofDays) > tofSpan * 1e-10,
      bestDetail: best ? best.detail : null,
      history: Object.freeze(history.map((record) => Object.freeze(record))),
    };
    return Object.freeze(report);
  }

  /** Cooperative counterpart to solveTransferDateTof. Its numerical steps and
   * report contract are the same, but the evaluator may return a Promise and
   * yieldControl is awaited between bounded mission-engine evaluations. */
  async function solveTransferDateTofAsync(options) {
    const opts = options || {};
    if (typeof opts.evaluate !== "function")
      throw new TypeError("Transfer targeting requires an evaluate function.");
    const target = Number(opts.target);
    const dateBounds = opts.departureBoundsJD;
    const tofBounds = opts.tofBoundsDays;
    if (!Number.isFinite(target)) throw new RangeError("Transfer target must be finite.");
    if (!Array.isArray(dateBounds) || dateBounds.length < 2 ||
        !dateBounds.slice(0, 2).every(Number.isFinite) || !(dateBounds[1] > dateBounds[0]))
      throw new RangeError("Departure-date bounds must be finite and increasing.");
    if (!Array.isArray(tofBounds) || tofBounds.length < 2 ||
        !tofBounds.slice(0, 2).every(Number.isFinite) || !(tofBounds[1] > tofBounds[0]) ||
        !(tofBounds[0] > 0))
      throw new RangeError("TOF bounds must be finite, positive, and increasing.");
    const tolerance = opts.toleranceKm === undefined ? 1 : Number(opts.toleranceKm);
    const maxIterations = Math.max(1, Math.min(80, Math.round(
      opts.maxIterations === undefined ? 36 : Number(opts.maxIterations))));
    const maxEvaluations = Math.max(9, Math.min(500, Math.round(
      opts.maxEvaluations === undefined ? 220 : Number(opts.maxEvaluations))));
    if (!(tolerance > 0) || !Number.isFinite(tolerance))
      throw new RangeError("Transfer target tolerance must be positive.");
    const signal = opts.signal || null;
    const yieldControl = typeof opts.yieldControl === "function"
      ? opts.yieldControl : null;
    const yieldEvery = Math.max(1, Math.round(+opts.yieldEvery || 1));
    const abortIfNeeded = () => {
      if (!signal || !signal.aborted) return;
      const error = new Error("Transfer targeting was canceled.");
      error.name = "AbortError";
      throw error;
    };
    const clamp = (value, bounds) => Math.max(bounds[0], Math.min(bounds[1], value));
    const dateSpan = dateBounds[1] - dateBounds[0];
    const tofSpan = tofBounds[1] - tofBounds[0];
    const seed = {
      departureJD: clamp(Number.isFinite(Number(opts.initialDepartureJD))
        ? Number(opts.initialDepartureJD) : 0.5 * (dateBounds[0] + dateBounds[1]), dateBounds),
      tofDays: clamp(Number.isFinite(Number(opts.initialTofDays))
        ? Number(opts.initialTofDays) : 0.5 * (tofBounds[0] + tofBounds[1]), tofBounds),
    };
    let evaluations = 0;
    const history = [];
    const evaluate = async (departureJD, tofDays) => {
      if (evaluations >= maxEvaluations) return null;
      abortIfNeeded();
      let raw;
      try { raw = await opts.evaluate({ departureJD, tofDays }); }
      catch (error) {
        if (error && error.name === "AbortError") throw error;
        raw = { valid: false, error: error && error.message };
      }
      evaluations++;
      const normalized = normalizeTransferEvaluation(raw, target);
      const record = {
        departureJD, tofDays, achieved: normalized.achieved,
        residual: normalized.residual, valid: normalized.valid,
        detail: normalized.detail,
      };
      history.push(record);
      if (yieldControl && evaluations % yieldEvery === 0) await yieldControl();
      abortIfNeeded();
      return record;
    };
    const distance = (record) => {
      const dd = (record.departureJD - seed.departureJD) / dateSpan;
      const dt = (record.tofDays - seed.tofDays) / tofSpan;
      return dd * dd + dt * dt;
    };
    const better = (candidate, current) => candidate && candidate.valid &&
      (!current || !current.valid || Math.abs(candidate.residual) < Math.abs(current.residual) - 1e-12 ||
       (Math.abs(Math.abs(candidate.residual) - Math.abs(current.residual)) <= 1e-12 &&
        distance(candidate) < distance(current)));
    let current = await evaluate(seed.departureJD, seed.tofDays);
    let best = current && current.valid ? current : null;
    let dateTrust = dateSpan * 0.25;
    let tofTrust = tofSpan * 0.25;
    let status = "iteration-limit";
    let iteration = 0;

    for (iteration = 1; iteration <= maxIterations && evaluations < maxEvaluations; iteration++) {
      if (best && Math.abs(best.residual) <= tolerance) { status = "converged"; break; }
      if (!current || !current.valid) current = best;
      if (!current) {
        current = await evaluate(0.5 * (dateBounds[0] + dateBounds[1]),
          0.5 * (tofBounds[0] + tofBounds[1]));
        if (better(current, best)) best = current;
        if (!current || !current.valid) { status = "no-valid-evaluation"; break; }
      }

      const hDate = Math.max(dateSpan * 1e-6, Math.min(dateTrust * 0.2, dateSpan * 0.02));
      const hTof = Math.max(tofSpan * 1e-6, Math.min(tofTrust * 0.2, tofSpan * 0.02));
      const dateProbeX = clamp(current.departureJD +
        (current.departureJD + hDate <= dateBounds[1] ? hDate : -hDate), dateBounds);
      const tofProbeX = clamp(current.tofDays +
        (current.tofDays + hTof <= tofBounds[1] ? hTof : -hTof), tofBounds);
      const dateProbe = await evaluate(dateProbeX, current.tofDays);
      const tofProbe = await evaluate(current.departureJD, tofProbeX);
      if (better(dateProbe, best)) best = dateProbe;
      if (better(tofProbe, best)) best = tofProbe;
      const gd = dateProbe && dateProbe.valid && dateProbeX !== current.departureJD
        ? (dateProbe.residual - current.residual) / (dateProbeX - current.departureJD) : 0;
      const gt = tofProbe && tofProbe.valid && tofProbeX !== current.tofDays
        ? (tofProbe.residual - current.residual) / (tofProbeX - current.tofDays) : 0;
      const scaledD = gd * dateSpan, scaledT = gt * tofSpan;
      const norm2 = scaledD * scaledD + scaledT * scaledT;
      let accepted = null;
      if (norm2 > 1e-24 && Number.isFinite(norm2)) {
        const normalizedDateStep = -current.residual * scaledD / norm2;
        const normalizedTofStep = -current.residual * scaledT / norm2;
        let scale = 1;
        for (let line = 0; line < 8 && evaluations < maxEvaluations; line++) {
          const candidate = await evaluate(
            clamp(current.departureJD + Math.max(-dateTrust, Math.min(dateTrust,
              normalizedDateStep * dateSpan * scale)), dateBounds),
            clamp(current.tofDays + Math.max(-tofTrust, Math.min(tofTrust,
              normalizedTofStep * tofSpan * scale)), tofBounds));
          if (better(candidate, best)) best = candidate;
          if (candidate && candidate.valid &&
              Math.abs(candidate.residual) < Math.abs(current.residual)) {
            accepted = candidate; break;
          }
          scale *= 0.5;
        }
      }
      if (!accepted) {
        const directions = [[1, 1], [1, -1], [-1, 1], [-1, -1],
          [1, 0], [-1, 0], [0, 1], [0, -1]];
        for (const direction of directions) {
          if (evaluations >= maxEvaluations) break;
          const candidate = await evaluate(clamp(current.departureJD + direction[0] * dateTrust,
            dateBounds), clamp(current.tofDays + direction[1] * tofTrust, tofBounds));
          if (better(candidate, best)) best = candidate;
          if (better(candidate, accepted || current)) accepted = candidate;
        }
      }
      if (accepted && accepted.valid &&
          Math.abs(accepted.residual) < Math.abs(current.residual)) {
        current = accepted;
        dateTrust = Math.min(dateSpan * 0.5, dateTrust * 1.15);
        tofTrust = Math.min(tofSpan * 0.5, tofTrust * 1.15);
      } else {
        dateTrust *= 0.5;
        tofTrust *= 0.5;
      }
      if (dateTrust <= Math.max(1e-8, dateSpan * 1e-9) &&
          tofTrust <= Math.max(1e-8, tofSpan * 1e-9)) {
        status = best && Math.abs(best.residual) <= tolerance ? "converged" : "bounds-exhausted";
        break;
      }
    }
    if (best && Math.abs(best.residual) <= tolerance) status = "converged";
    else if (evaluations >= maxEvaluations) status = "evaluation-limit";
    return Object.freeze({
      converged: status === "converged",
      status,
      target,
      toleranceKm: tolerance,
      departureBoundsJD: dateBounds.slice(0, 2),
      tofBoundsDays: tofBounds.slice(0, 2),
      initialDepartureJD: seed.departureJD,
      initialTofDays: seed.tofDays,
      departureJD: best ? best.departureJD : null,
      tofDays: best ? best.tofDays : null,
      achieved: best ? best.achieved : null,
      residual: best ? best.residual : null,
      iterations: Math.min(iteration, maxIterations),
      evaluations,
      variedDeparture: !!best && Math.abs(best.departureJD - seed.departureJD) > dateSpan * 1e-10,
      variedTof: !!best && Math.abs(best.tofDays - seed.tofDays) > tofSpan * 1e-10,
      bestDetail: best ? best.detail : null,
      history: Object.freeze(history.map((record) => Object.freeze(record))),
    });
  }

  function hyperbolicImpactParameter(rpKm, vInfinityKmS, mu) {
    const rp = Number(rpKm), vinf = Number(vInfinityKmS), gm = Number(mu);
    if (!(rp > 0) || !(vinf > 0) || !(gm > 0) ||
        ![rp, vinf, gm].every(Number.isFinite))
      throw new RangeError("Hyperbolic impact inputs must be finite and positive.");
    return rp * Math.sqrt(1 + 2 * gm / (rp * vinf * vinf));
  }

  function hyperbolicPeriapsisFromImpact(impactKm, vInfinityKmS, mu) {
    const impact = Number(impactKm), vinf = Number(vInfinityKmS), gm = Number(mu);
    if (!(impact > 0) || !(vinf > 0) || !(gm > 0) ||
        ![impact, vinf, gm].every(Number.isFinite))
      throw new RangeError("Hyperbolic impact inputs must be finite and positive.");
    const focus = gm / (vinf * vinf);
    return Math.sqrt(focus * focus + impact * impact) - focus;
  }

  globalThis.MissionTargeting = Object.freeze({
    arrivalPlane,
    pointOnCircle,
    solveLambertToPeriapsis,
    solveBoundedScalar,
    solveInsertionImpulse,
    solveTransferDateTof,
    solveTransferDateTofAsync,
    hyperbolicImpactParameter,
    hyperbolicPeriapsisFromImpact,
  });
})();
