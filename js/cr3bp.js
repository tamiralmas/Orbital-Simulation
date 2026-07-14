/* =============================================================================
 * Mission Trajectory Planner — cr3bp.js
 * Canonical circular restricted three-body problem (CR3BP) mathematics.
 *
 * Coordinates are barycentric and synodic unless a function explicitly says
 * "inertial".  The primary is fixed at x = -mu and the secondary at
 * x = 1 - mu.  Canonical units are:
 *   distance = the reviewed characteristic primary/secondary separation,
 *   time     = sqrt(distance^3 / (GM1 + GM2)),
 *   velocity = distance / time.
 * Thus the primaries rotate at exactly one radian per canonical time unit.
 *
 * This module deliberately contains no trajectory integrator or UI state.  It
 * is the validated dynamics layer used by later halo/Lissajous and targeting
 * work, and can also be loaded directly from file:// after constants.js.
 * ========================================================================== */
"use strict";

(function () {
  const C = globalThis.AstroConst;
  if (!C || !C.BODIES)
    throw new Error("cr3bp.js requires constants.js to be loaded first.");

  const SQRT3_OVER_2 = Math.sqrt(3) / 2;
  // Routh's linear-stability limit for the triangular equilibria.
  const ROUTH_MU = 0.5 * (1 - Math.sqrt(23 / 27));

  function finitePositive(value, label) {
    const number = +value;
    if (!(number > 0) || !Number.isFinite(number))
      throw new RangeError(`${label} must be a finite positive number.`);
    return number;
  }

  function vector(value, length, label) {
    if (!value || value.length < length)
      throw new TypeError(`${label} must contain ${length} finite values.`);
    const result = Array.from(value).slice(0, length).map(Number);
    if (!result.every(Number.isFinite))
      throw new TypeError(`${label} must contain ${length} finite values.`);
    return result;
  }

  function createSystem(definition) {
    const def = definition || {};
    const primary = C.BODIES[def.primaryId];
    const secondary = C.BODIES[def.secondaryId];
    if (!primary || !secondary)
      throw new Error("A CR3BP system needs primaryId and secondaryId from AstroConst.BODIES.");
    const primaryGM = finitePositive(def.primaryGM || primary.mu, "primary GM");
    const secondaryGM = finitePositive(def.secondaryGM || secondary.mu, "secondary GM");
    const distanceKm = finitePositive(def.distanceKm || secondary.aKm,
      "characteristic distance");
    const totalGM = primaryGM + secondaryGM;
    const mu = secondaryGM / totalGM;
    if (!(mu > 0 && mu <= 0.5))
      throw new RangeError("The CR3BP secondary must not be more massive than the primary.");
    const timeUnitS = Math.sqrt(distanceKm * distanceKm * distanceKm / totalGM);
    const velocityUnitKmS = distanceKm / timeUnitS;
    return Object.freeze({
      id: def.id || `${primary.id}-${secondary.id}`,
      name: def.name || `${primary.name}–${secondary.name}`,
      primaryId: primary.id,
      primaryName: primary.name,
      secondaryId: secondary.id,
      secondaryName: secondary.name,
      primaryGM,
      secondaryGM,
      totalGM,
      mu,
      distanceKm,
      timeUnitS,
      timeUnitDays: timeUnitS / C.DAY,
      velocityUnitKmS,
      meanMotionRadS: 1 / timeUnitS,
      periodS: 2 * Math.PI * timeUnitS,
      primaryX: -mu,
      secondaryX: 1 - mu,
      triangularPointsLinearlyStable: mu < ROUTH_MU,
      modelWarning: "Ideal circular, planar primary motion; not an operational ephemeris or navigation model.",
    });
  }

  const sunEarth = createSystem({
    id: "sun-earth",
    name: "Sun–Earth",
    primaryId: "sun",
    secondaryId: "earth",
    // constants.js derives aKm from its reviewed Standish/JPL mean element.
    distanceKm: C.BODIES.earth.aKm,
  });
  const earthMoon = createSystem({
    id: "earth-moon",
    name: "Earth–Moon",
    primaryId: "earth",
    secondaryId: "moon",
    // Mean lunar semimajor axis from constants.js; eccentricity is omitted by
    // definition in the circular model.
    distanceKm: C.BODIES.moon.aKm,
  });
  const SYSTEMS = Object.freeze({ sunEarth, earthMoon });
  const equilibriumCache = new WeakMap();

  function getSystem(id) {
    if (id === sunEarth || id === earthMoon) return id;
    const key = String(id || "").toLowerCase().replace(/[^a-z]/g, "");
    if (key === "sunearth" || key === "se") return sunEarth;
    if (key === "earthmoon" || key === "em") return earthMoon;
    throw new RangeError(`Unknown CR3BP system '${id}'.`);
  }

  function massParameter(systemOrMu) {
    const mu = typeof systemOrMu === "number"
      ? systemOrMu
      : systemOrMu && +systemOrMu.mu;
    if (!(mu > 0 && mu <= 0.5) || !Number.isFinite(mu))
      throw new RangeError("CR3BP mass parameter mu must be in (0, 0.5].");
    return mu;
  }

  function distances(mu, position) {
    const p = vector(position, 3, "position");
    const dx1 = p[0] + mu;
    const dx2 = p[0] - 1 + mu;
    const y = p[1], z = p[2];
    const r1sq = dx1 * dx1 + y * y + z * z;
    const r2sq = dx2 * dx2 + y * y + z * z;
    if (!(r1sq > 0) || !(r2sq > 0))
      throw new RangeError("The CR3BP field is singular at either primary.");
    return { p, dx1, dx2, y, z, r1sq, r2sq,
      r1: Math.sqrt(r1sq), r2: Math.sqrt(r2sq) };
  }

  function effectivePotential(systemOrMu, position) {
    const mu = massParameter(systemOrMu);
    const d = distances(mu, position);
    return 0.5 * (d.p[0] * d.p[0] + d.y * d.y) +
      (1 - mu) / d.r1 + mu / d.r2;
  }

  function effectivePotentialGradient(systemOrMu, position) {
    const mu = massParameter(systemOrMu);
    const d = distances(mu, position);
    const q1r3 = (1 - mu) / (d.r1sq * d.r1);
    const q2r3 = mu / (d.r2sq * d.r2);
    return [
      d.p[0] - q1r3 * d.dx1 - q2r3 * d.dx2,
      d.y * (1 - q1r3 - q2r3),
      -d.z * (q1r3 + q2r3),
    ];
  }

  function potentialHessian(systemOrMu, position) {
    const mu = massParameter(systemOrMu);
    const d = distances(mu, position);
    const q1r3 = (1 - mu) / (d.r1sq * d.r1);
    const q2r3 = mu / (d.r2sq * d.r2);
    const q1r5 = q1r3 / d.r1sq;
    const q2r5 = q2r3 / d.r2sq;
    const common = q1r3 + q2r3;
    const xx = 1 - common + 3 * (q1r5 * d.dx1 * d.dx1 + q2r5 * d.dx2 * d.dx2);
    const yy = 1 - common + 3 * d.y * d.y * (q1r5 + q2r5);
    const zz = -common + 3 * d.z * d.z * (q1r5 + q2r5);
    const xy = 3 * d.y * (q1r5 * d.dx1 + q2r5 * d.dx2);
    const xz = 3 * d.z * (q1r5 * d.dx1 + q2r5 * d.dx2);
    const yz = 3 * d.y * d.z * (q1r5 + q2r5);
    return [
      [xx, xy, xz],
      [xy, yy, yz],
      [xz, yz, zz],
    ];
  }

  /** Canonical synodic equations: [x,y,z,vx,vy,vz] -> time derivative. */
  function derivatives(systemOrMu, state) {
    const s = vector(state, 6, "state");
    const gradient = effectivePotentialGradient(systemOrMu, s);
    return [s[3], s[4], s[5],
      gradient[0] + 2 * s[4],
      gradient[1] - 2 * s[3],
      gradient[2]];
  }

  /** 6x6 analytic state Jacobian used by variational-equation integrators. */
  function jacobian(systemOrMu, state) {
    const s = vector(state, 6, "state");
    const h = potentialHessian(systemOrMu, s);
    return [
      [0, 0, 0, 1, 0, 0],
      [0, 0, 0, 0, 1, 0],
      [0, 0, 0, 0, 0, 1],
      [h[0][0], h[0][1], h[0][2], 0, 2, 0],
      [h[1][0], h[1][1], h[1][2], -2, 0, 0],
      [h[2][0], h[2][1], h[2][2], 0, 0, 0],
    ];
  }

  function jacobiConstant(systemOrMu, state) {
    const s = vector(state, 6, "state");
    return 2 * effectivePotential(systemOrMu, s) -
      (s[3] * s[3] + s[4] * s[4] + s[5] * s[5]);
  }

  function collinearResidual(systemOrMu, x) {
    if (!Number.isFinite(+x)) throw new TypeError("x must be finite.");
    return effectivePotentialGradient(systemOrMu, [+x, 0, 0])[0];
  }

  function collinearSlope(systemOrMu, x) {
    return potentialHessian(systemOrMu, [+x, 0, 0])[0][0];
  }

  function rootBracket(mu, pointName) {
    // Keep well clear of the analytic singularities.  1e-12 remains many
    // orders smaller than the L1/L2 secondary distance in either reviewed
    // system while avoiding overflow in the residual.
    const edge = 1e-12;
    if (pointName === "L1") return [-mu + edge, 1 - mu - edge];
    if (pointName === "L2") {
      let hi = 2;
      while (collinearResidual(mu, hi) <= 0 && hi < 1e6) hi *= 2;
      return [1 - mu + edge, hi];
    }
    if (pointName === "L3") {
      let lo = -2;
      while (collinearResidual(mu, lo) >= 0 && lo > -1e6) lo *= 2;
      return [lo, -mu - edge];
    }
    throw new RangeError("Collinear point must be L1, L2, or L3.");
  }

  /** Safeguarded Newton solve that never leaves the analytic sign bracket. */
  function solveCollinearPoint(systemOrMu, pointName) {
    const mu = massParameter(systemOrMu);
    const name = String(pointName || "").toUpperCase();
    let [lo, hi] = rootBracket(mu, name);
    let flo = collinearResidual(mu, lo);
    let fhi = collinearResidual(mu, hi);
    if (!(flo < 0 && fhi > 0))
      throw new Error(`${name} root did not have the expected sign bracket.`);

    let x = 0.5 * (lo + hi);
    let bestX = x;
    let bestResidual = Infinity;
    for (let iteration = 0; iteration < 160; iteration++) {
      const fx = collinearResidual(mu, x);
      const absolute = Math.abs(fx);
      if (absolute < bestResidual) {
        bestResidual = absolute;
        bestX = x;
      }
      if (absolute <= 5e-15) return x;
      if (fx < 0) {
        lo = x;
        flo = fx;
      } else {
        hi = x;
        fhi = fx;
      }
      if (hi - lo <= 4 * Number.EPSILON * Math.max(1, Math.abs(x))) break;

      const slope = collinearSlope(mu, x);
      const candidate = x - fx / slope;
      x = Number.isFinite(candidate) && candidate > lo && candidate < hi
        ? candidate
        : 0.5 * (lo + hi);
    }
    // At machine precision, return whichever bracket sample has the smallest
    // physical force residual rather than an arbitrary endpoint.
    for (const candidate of [lo, 0.5 * (lo + hi), hi]) {
      const residual = Math.abs(collinearResidual(mu, candidate));
      if (residual < bestResidual) {
        bestResidual = residual;
        bestX = candidate;
      }
    }
    return bestX;
  }

  function equilibriumResidualVector(systemOrMu, position) {
    return effectivePotentialGradient(systemOrMu, position);
  }

  function equilibriumResidual(systemOrMu, position) {
    const r = equilibriumResidualVector(systemOrMu, position);
    return Math.hypot(r[0], r[1], r[2]);
  }

  function stabilityAssessment(systemOrMu, pointName) {
    const mu = massParameter(systemOrMu);
    const name = String(pointName || "").toUpperCase();
    if (!["L1", "L2", "L3", "L4", "L5"].includes(name))
      throw new RangeError("Equilibrium point must be L1 through L5.");
    if (name === "L1" || name === "L2" || name === "L3") {
      return Object.freeze({
        status: "linearly-unstable",
        warning: `${name} is linearly unstable in the ideal CR3BP; bounded operations require orbit design and stationkeeping.`,
      });
    }
    if (mu < ROUTH_MU)
      return Object.freeze({ status: "linearly-stable", warning: null });
    if (Math.abs(mu - ROUTH_MU) <= 32 * Number.EPSILON)
      return Object.freeze({
        status: "marginal",
        warning: `${name} is at the Routh linear-stability boundary.`,
      });
    return Object.freeze({
      status: "linearly-unstable",
      warning: `${name} is linearly unstable because the system mass ratio exceeds the Routh limit.`,
    });
  }

  function equilibriumRecord(systemOrMu, name, position) {
    const system = typeof systemOrMu === "object" ? systemOrMu : null;
    const mu = massParameter(systemOrMu);
    const assessment = stabilityAssessment(mu, name);
    const distanceScale = system && system.distanceKm || 1;
    const dx1 = position[0] + mu;
    const dx2 = position[0] - 1 + mu;
    const d1 = Math.hypot(dx1, position[1], position[2]);
    const d2 = Math.hypot(dx2, position[1], position[2]);
    return Object.freeze({
      name,
      position: Object.freeze(position.slice()),
      x: position[0], y: position[1], z: position[2],
      jacobi: jacobiConstant(mu, position.concat([0, 0, 0])),
      residual: equilibriumResidual(mu, position),
      distanceFromPrimary: d1,
      distanceFromSecondary: d2,
      distanceFromPrimaryKm: d1 * distanceScale,
      distanceFromSecondaryKm: d2 * distanceScale,
      stability: assessment.status,
      warning: assessment.warning,
    });
  }

  function equilibriumPoints(systemOrMu) {
    if (systemOrMu && typeof systemOrMu === "object") {
      const cached = equilibriumCache.get(systemOrMu);
      if (cached) return cached;
    }
    const mu = massParameter(systemOrMu);
    const points = Object.freeze({
      L1: equilibriumRecord(systemOrMu, "L1", [solveCollinearPoint(mu, "L1"), 0, 0]),
      L2: equilibriumRecord(systemOrMu, "L2", [solveCollinearPoint(mu, "L2"), 0, 0]),
      L3: equilibriumRecord(systemOrMu, "L3", [solveCollinearPoint(mu, "L3"), 0, 0]),
      L4: equilibriumRecord(systemOrMu, "L4", [0.5 - mu, SQRT3_OVER_2, 0]),
      L5: equilibriumRecord(systemOrMu, "L5", [0.5 - mu, -SQRT3_OVER_2, 0]),
    });
    if (systemOrMu && typeof systemOrMu === "object")
      equilibriumCache.set(systemOrMu, points);
    return points;
  }

  function equilibriumPoint(systemOrMu, pointName) {
    const name = String(pointName || "").toUpperCase();
    const point = equilibriumPoints(systemOrMu)[name];
    if (!point) throw new RangeError("Equilibrium point must be L1 through L5.");
    return point;
  }

  function systemUnits(system) {
    if (!system || !(system.distanceKm > 0) || !(system.timeUnitS > 0))
      throw new TypeError("A CR3BP system definition is required for unit conversion.");
    return system;
  }

  function normalizePosition(system, positionKm) {
    const s = systemUnits(system);
    return vector(positionKm, 3, "position").map((value) => value / s.distanceKm);
  }

  function denormalizePosition(system, position) {
    const s = systemUnits(system);
    return vector(position, 3, "position").map((value) => value * s.distanceKm);
  }

  function normalizeVelocity(system, velocityKmS) {
    const s = systemUnits(system);
    return vector(velocityKmS, 3, "velocity").map((value) => value / s.velocityUnitKmS);
  }

  function denormalizeVelocity(system, velocity) {
    const s = systemUnits(system);
    return vector(velocity, 3, "velocity").map((value) => value * s.velocityUnitKmS);
  }

  function normalizeTime(system, seconds) {
    const s = systemUnits(system);
    if (!Number.isFinite(+seconds)) throw new TypeError("time must be finite.");
    return +seconds / s.timeUnitS;
  }

  function denormalizeTime(system, canonicalTime) {
    const s = systemUnits(system);
    if (!Number.isFinite(+canonicalTime)) throw new TypeError("time must be finite.");
    return +canonicalTime * s.timeUnitS;
  }

  function normalizeState(system, dimensionalState) {
    const state = vector(dimensionalState, 6, "state");
    return normalizePosition(system, state).concat(normalizeVelocity(system, state.slice(3)));
  }

  function denormalizeState(system, canonicalState) {
    const state = vector(canonicalState, 6, "state");
    return denormalizePosition(system, state).concat(denormalizeVelocity(system, state.slice(3)));
  }

  function rotateZ(v, angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
  }

  /** Canonical barycentric synodic state -> canonical barycentric inertial state. */
  function rotatingToInertial(state, canonicalTime, phaseRad) {
    const s = vector(state, 6, "state");
    const time = +canonicalTime;
    const phase = phaseRad === undefined ? 0 : +phaseRad;
    if (!Number.isFinite(time) || !Number.isFinite(phase))
      throw new TypeError("time and phase must be finite.");
    const r = s.slice(0, 3);
    // In normalized units omega = +z, so omega x r = [-y, x, 0].
    const transportedV = [s[3] - r[1], s[4] + r[0], s[5]];
    return rotateZ(r, time + phase).concat(rotateZ(transportedV, time + phase));
  }

  /** Canonical barycentric inertial state -> canonical barycentric synodic state. */
  function inertialToRotating(state, canonicalTime, phaseRad) {
    const s = vector(state, 6, "state");
    const time = +canonicalTime;
    const phase = phaseRad === undefined ? 0 : +phaseRad;
    if (!Number.isFinite(time) || !Number.isFinite(phase))
      throw new TypeError("time and phase must be finite.");
    const r = rotateZ(s.slice(0, 3), -(time + phase));
    const inertialVInRotatingAxes = rotateZ(s.slice(3), -(time + phase));
    return r.concat([
      inertialVInRotatingAxes[0] + r[1],
      inertialVInRotatingAxes[1] - r[0],
      inertialVInRotatingAxes[2],
    ]);
  }

  function rotatingToInertialDimensional(system, stateKm, seconds, phaseRad) {
    const normalized = normalizeState(system, stateKm);
    return denormalizeState(system,
      rotatingToInertial(normalized, normalizeTime(system, seconds), phaseRad));
  }

  function inertialToRotatingDimensional(system, stateKm, seconds, phaseRad) {
    const normalized = normalizeState(system, stateKm);
    return denormalizeState(system,
      inertialToRotating(normalized, normalizeTime(system, seconds), phaseRad));
  }

  globalThis.CR3BP = Object.freeze({
    ROUTH_MU,
    SYSTEMS,
    createSystem,
    getSystem,
    massParameter,
    effectivePotential,
    effectivePotentialGradient,
    potentialHessian,
    derivatives,
    jacobian,
    jacobiConstant,
    collinearResidual,
    solveCollinearPoint,
    equilibriumResidualVector,
    equilibriumResidual,
    stabilityAssessment,
    equilibriumPoint,
    equilibriumPoints,
    normalizePosition,
    denormalizePosition,
    normalizeVelocity,
    denormalizeVelocity,
    normalizeTime,
    denormalizeTime,
    normalizeState,
    denormalizeState,
    rotatingToInertial,
    inertialToRotating,
    rotatingToInertialDimensional,
    inertialToRotatingDimensional,
  });
})();
