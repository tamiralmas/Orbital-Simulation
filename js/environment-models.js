/* =============================================================================
 * Mission Trajectory Planner - environment-models.js
 * Deterministic perturbation models for adaptive inertial propagation.
 *
 * State units are km, km/s, and kg. Aerodynamic/SRP inputs use SI area,
 * density, and pressure values and are converted back to km/s^2. Models are
 * deliberately bounded and expose their assumptions through MODEL_METADATA.
 * ========================================================================== */
"use strict";

(function () {
  const EARTH_EQUATORIAL_RADIUS_KM = 6378.1363;
  const EARTH_MU_KM3_S2 = 398600.435436;
  const EARTH_ZONALS = Object.freeze({
    2: 1.08262668e-3,
    3: -2.5324105e-6,
    4: -1.6198976e-6,
  });
  const SOLAR_PRESSURE_1_AU_N_M2 = 4.56e-6;
  const SUN_RADIUS_KM = 695700;
  const AU_KM = 149597870.7;

  // Static, piecewise-exponential density reference. It intentionally stops
  // at 1,000 km rather than pretending to predict space weather beyond its
  // stated range. Log interpolation keeps density positive and continuous.
  const EARTH_DENSITY_TABLE = Object.freeze([
    [0, 1.225], [25, 3.899e-2], [30, 1.774e-2], [40, 3.972e-3],
    [50, 1.057e-3], [60, 3.206e-4], [70, 8.770e-5], [80, 1.905e-5],
    [90, 3.396e-6], [100, 5.297e-7], [110, 9.661e-8], [120, 2.438e-8],
    [130, 8.484e-9], [140, 3.845e-9], [150, 2.070e-9], [180, 5.464e-10],
    [200, 2.789e-10], [250, 7.248e-11], [300, 2.418e-11], [350, 9.158e-12],
    [400, 3.725e-12], [450, 1.585e-12], [500, 6.967e-13], [600, 1.454e-13],
    [700, 3.614e-14], [800, 1.170e-14], [900, 5.245e-15], [1000, 3.019e-15],
  ].map(Object.freeze));

  const MODEL_METADATA = Object.freeze({
    atmosphere: Object.freeze({
      name: "bounded piecewise-exponential Earth reference atmosphere",
      coverageKm: Object.freeze([0, 1000]),
      variability: "static nominal density; no solar/geomagnetic weather",
      extrapolation: "zero above 1,000 km; sea-level value below 0 km",
    }),
    srp: Object.freeze({
      name: "cannonball solar-radiation pressure",
      pressureAt1AuNPerM2: SOLAR_PRESSURE_1_AU_N_M2,
      shadow: "finite angular-disk occultation with fractional penumbra",
    }),
    earthGravity: Object.freeze({
      name: "axisymmetric Earth zonal harmonics",
      referenceRadiusKm: EARTH_EQUATORIAL_RADIUS_KM,
      coefficients: EARTH_ZONALS,
      supportedDegree: 4,
      tesseralTerms: false,
    }),
  });

  function finite(value, name) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(name + " must be finite.");
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
    const result = Array.from(value, Number);
    if (result.some((component) => !Number.isFinite(component))) {
      throw new Error(name + " contains an invalid component.");
    }
    return result;
  }

  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]];
  }
  function magnitude(a) { return Math.hypot(a[0], a[1], a[2]); }
  function normalized(a, name) {
    const length = magnitude(a);
    if (!(length > 0)) throw new Error(name + " has zero magnitude.");
    return [a[0] / length, a[1] / length, a[2] / length];
  }
  function subtract(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }

  function legendreAndDerivative(degree, s) {
    if (degree === 2) return [(3 * s * s - 1) / 2, 3 * s];
    if (degree === 3) return [(5 * s * s * s - 3 * s) / 2,
      (15 * s * s - 3) / 2];
    if (degree === 4) return [(35 * s ** 4 - 30 * s * s + 3) / 8,
      (140 * s ** 3 - 60 * s) / 8];
    throw new Error("Only Earth zonal degrees 2 through 4 are supported.");
  }

  /** Earth J2/J3/J4 perturbing acceleration only (the monopole is separate). */
  function earthZonalAcceleration(relativePositionValue, options) {
    const relativePosition = vector3(relativePositionValue, "relativePosition");
    options = options || {};
    const degree = options.degree === undefined ? 4 : Number(options.degree);
    if (!Number.isInteger(degree) || degree < 2 || degree > 4) {
      throw new Error("Earth harmonic degree must be an integer from 2 through 4.");
    }
    const mu = positive(options.mu === undefined ? EARTH_MU_KM3_S2 : options.mu,
      "Earth harmonic mu");
    const radius = positive(options.radiusKm === undefined ? EARTH_EQUATORIAL_RADIUS_KM
      : options.radiusKm, "Earth harmonic radiusKm");
    const pole = normalized(vector3(options.pole || options.zAxis || [0, 0, 1],
      "Earth harmonic pole"), "Earth harmonic pole");
    const coefficients = Object.assign({}, EARTH_ZONALS, options.coefficients || {});
    const r = magnitude(relativePosition);
    if (!(r > 0)) throw new Error("Earth harmonic acceleration is singular at the center.");
    const z = dot(relativePosition, pole);
    const s = z / r;
    const perpendicular = [relativePosition[0] - z * pole[0],
      relativePosition[1] - z * pole[1], relativePosition[2] - z * pole[2]];
    const acceleration = [0, 0, 0];
    for (let n = 2; n <= degree; n++) {
      const jn = finite(coefficients[n], "Earth J" + n);
      const [pn, derivativePn] = legendreAndDerivative(n, s);
      const k = mu * jn * radius ** n;
      const horizontal = k * r ** (-n - 3) * ((n + 1) * pn + s * derivativePn);
      const axial = k * r ** (-n - 2) * ((n + 1) * s * pn -
        (1 - s * s) * derivativePn);
      for (let axis = 0; axis < 3; axis++) {
        acceleration[axis] += horizontal * perpendicular[axis] + axial * pole[axis];
      }
    }
    return acceleration;
  }

  /** Perturbing gravitational potential energy per unit mass (km^2/s^2). */
  function earthZonalPotential(relativePositionValue, options) {
    const relativePosition = vector3(relativePositionValue, "relativePosition");
    options = options || {};
    const degree = options.degree === undefined ? 4 : Number(options.degree);
    if (!Number.isInteger(degree) || degree < 2 || degree > 4) {
      throw new Error("Earth harmonic degree must be an integer from 2 through 4.");
    }
    const mu = positive(options.mu === undefined ? EARTH_MU_KM3_S2 : options.mu,
      "Earth harmonic mu");
    const radius = positive(options.radiusKm === undefined ? EARTH_EQUATORIAL_RADIUS_KM
      : options.radiusKm, "Earth harmonic radiusKm");
    const pole = normalized(vector3(options.pole || options.zAxis || [0, 0, 1],
      "Earth harmonic pole"), "Earth harmonic pole");
    const coefficients = Object.assign({}, EARTH_ZONALS, options.coefficients || {});
    const r = magnitude(relativePosition);
    if (!(r > 0)) throw new Error("Earth harmonic potential is singular at the center.");
    const s = dot(relativePosition, pole) / r;
    let potential = 0;
    for (let n = 2; n <= degree; n++) {
      const [pn] = legendreAndDerivative(n, s);
      potential += mu * finite(coefficients[n], "Earth J" + n) * radius ** n *
        r ** (-n - 1) * pn;
    }
    return potential;
  }

  function atmosphericDensity(altitudeKmValue, options) {
    const altitudeKm = finite(altitudeKmValue, "atmospheric altitudeKm");
    options = options || {};
    const scale = options.densityScale === undefined ? 1
      : finite(options.densityScale, "atmospheric densityScale");
    if (scale < 0) throw new Error("atmospheric densityScale must be non-negative.");
    if (altitudeKm > EARTH_DENSITY_TABLE[EARTH_DENSITY_TABLE.length - 1][0]) return 0;
    if (altitudeKm <= EARTH_DENSITY_TABLE[0][0]) return scale * EARTH_DENSITY_TABLE[0][1];
    let low = 0;
    let high = EARTH_DENSITY_TABLE.length - 1;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (EARTH_DENSITY_TABLE[middle][0] <= altitudeKm) low = middle;
      else high = middle;
    }
    const left = EARTH_DENSITY_TABLE[low];
    const right = EARTH_DENSITY_TABLE[high];
    const fraction = (altitudeKm - left[0]) / (right[0] - left[0]);
    return scale * Math.exp(Math.log(left[1]) + fraction *
      (Math.log(right[1]) - Math.log(left[1])));
  }

  function resolvedMass(state, config, modelName) {
    const value = config.massKg === undefined ? state.massKg : config.massKg;
    return positive(value, modelName + " massKg");
  }

  /** Cannonball drag against a rigidly co-rotating Earth atmosphere. */
  function dragAcceleration(state, config) {
    if (!state || typeof state !== "object") throw new Error("drag state is required.");
    config = config || {};
    const r = vector3(state.r, "drag spacecraft r");
    const v = vector3(state.v, "drag spacecraft v");
    const centerR = vector3(state.bodyR || [0, 0, 0], "drag body r");
    const centerV = vector3(state.bodyV || [0, 0, 0], "drag body v");
    const pole = normalized(vector3(state.pole || [0, 0, 1], "drag body pole"),
      "drag body pole");
    const radiusKm = positive(state.bodyRadiusKm === undefined
      ? EARTH_EQUATORIAL_RADIUS_KM : state.bodyRadiusKm, "drag body radiusKm");
    const rotHours = finite(state.rotHours === undefined ? 23.9344696 : state.rotHours,
      "drag rotHours");
    if (rotHours === 0) throw new Error("drag rotHours must be non-zero.");
    const areaM2 = positive(config.areaM2, "drag areaM2");
    const cd = positive(config.cd === undefined ? 2.2 : config.cd, "drag cd");
    const massKg = resolvedMass(state, config, "drag");
    const relativeR = subtract(r, centerR);
    const altitudeKm = magnitude(relativeR) - radiusKm;
    const densityKgM3 = atmosphericDensity(altitudeKm, config);
    if (densityKgM3 === 0) return [0, 0, 0];
    const omega = 2 * Math.PI / (rotHours * 3600);
    const angularVelocity = state.angularVelocityRadS === undefined
      ? [pole[0] * omega, pole[1] * omega, pole[2] * omega]
      : vector3(state.angularVelocityRadS, "drag angular velocity");
    const atmosphereV = cross(angularVelocity, relativeR);
    const relativeV = [v[0] - centerV[0] - atmosphereV[0],
      v[1] - centerV[1] - atmosphereV[1], v[2] - centerV[2] - atmosphereV[2]];
    const speedKmS = magnitude(relativeV);
    if (speedKmS === 0) return [0, 0, 0];
    // -0.5*rho*Cd*A/m*v^2 [m/s^2], converted to km/s^2 while v is km/s.
    const scale = -500 * densityKgM3 * cd * areaM2 / massKg * speedKmS;
    return [relativeV[0] * scale, relativeV[1] * scale, relativeV[2] * scale];
  }

  function circleOverlapArea(radiusA, radiusB, separation) {
    if (separation >= radiusA + radiusB) return 0;
    if (separation <= Math.abs(radiusA - radiusB)) {
      return Math.PI * Math.min(radiusA, radiusB) ** 2;
    }
    const a = Math.acos(Math.max(-1, Math.min(1,
      (separation * separation + radiusA * radiusA - radiusB * radiusB) /
      (2 * separation * radiusA))));
    const b = Math.acos(Math.max(-1, Math.min(1,
      (separation * separation + radiusB * radiusB - radiusA * radiusA) /
      (2 * separation * radiusB))));
    const radicand = Math.max(0, (-separation + radiusA + radiusB) *
      (separation + radiusA - radiusB) * (separation - radiusA + radiusB) *
      (separation + radiusA + radiusB));
    return radiusA * radiusA * a + radiusB * radiusB * b - 0.5 * Math.sqrt(radicand);
  }

  /** Fraction of the finite solar disk visible from the spacecraft, in [0,1]. */
  function eclipseVisibility(spacecraftPositionValue, sun, occultors) {
    const spacecraft = vector3(spacecraftPositionValue, "eclipse spacecraft position");
    if (!sun || typeof sun !== "object") throw new Error("eclipse Sun state is required.");
    const sunVector = subtract(vector3(sun.r, "eclipse Sun position"), spacecraft);
    const sunDistance = magnitude(sunVector);
    const sunRadius = positive(sun.radiusKm === undefined ? SUN_RADIUS_KM : sun.radiusKm,
      "eclipse Sun radiusKm");
    if (!(sunDistance > sunRadius)) throw new Error("Spacecraft must lie outside the Sun.");
    const sunAngularRadius = Math.asin(Math.min(1, sunRadius / sunDistance));
    const sunDirection = sunVector.map((value) => value / sunDistance);
    let visible = 1;
    for (const occultor of occultors || []) {
      if (!occultor || typeof occultor !== "object") continue;
      const occultorVector = subtract(vector3(occultor.r, "occultor position"), spacecraft);
      const occultorDistance = magnitude(occultorVector);
      const occultorRadius = positive(occultor.radiusKm, "occultor radiusKm");
      // An object farther than the Sun cannot occult the solar disk.
      if (!(occultorDistance > occultorRadius) || occultorDistance >= sunDistance) continue;
      const occultorDirection = occultorVector.map((value) => value / occultorDistance);
      const separation = Math.acos(Math.max(-1, Math.min(1,
        dot(sunDirection, occultorDirection))));
      const occultorAngularRadius = Math.asin(Math.min(1, occultorRadius / occultorDistance));
      const overlap = circleOverlapArea(sunAngularRadius, occultorAngularRadius, separation);
      visible = Math.min(visible, Math.max(0, 1 - overlap /
        (Math.PI * sunAngularRadius * sunAngularRadius)));
    }
    return visible;
  }

  /** Cannonball SRP, directed away from the Sun, with fractional eclipses. */
  function solarRadiationPressureAcceleration(state, config) {
    if (!state || typeof state !== "object") throw new Error("SRP state is required.");
    config = config || {};
    const spacecraft = vector3(state.r, "SRP spacecraft r");
    const sunR = vector3(state.sunR, "SRP Sun r");
    const fromSun = subtract(spacecraft, sunR);
    const distanceKm = magnitude(fromSun);
    if (!(distanceKm > 0)) throw new Error("SRP is singular at the Sun center.");
    const areaM2 = positive(config.areaM2, "SRP areaM2");
    const cr = positive(config.cr === undefined ? 1.3 : config.cr, "SRP cr");
    const massKg = resolvedMass(state, config, "SRP");
    const pressure = (config.pressureAt1AuNPerM2 === undefined
      ? SOLAR_PRESSURE_1_AU_N_M2 : positive(config.pressureAt1AuNPerM2,
        "SRP pressureAt1AuNPerM2")) * (AU_KM / distanceKm) ** 2;
    const visibility = config.eclipse === false ? 1 : eclipseVisibility(spacecraft,
      { r: sunR, radiusKm: state.sunRadiusKm || SUN_RADIUS_KM }, state.occultors || []);
    // N/kg is m/s^2; divide by 1000 to return km/s^2.
    const scale = pressure * cr * areaM2 / massKg / 1000 * visibility / distanceKm;
    return [fromSun[0] * scale, fromSun[1] * scale, fromSun[2] * scale];
  }

  function normalizeToggle(value, defaults, name) {
    if (value === undefined || value === null || value === false) return null;
    if (value === true) return Object.assign({}, defaults);
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new Error(name + " must be false, true, or an options object.");
    }
    return Object.assign({}, defaults, value);
  }

  /** Normalize public force-model selection without binding it to a catalog. */
  function normalizeConfiguration(value) {
    if (value === undefined || value === null || value === false) return Object.freeze({
      drag: null, srp: null, harmonics: null,
    });
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new Error("environment must be an options object.");
    }
    const drag = normalizeToggle(value.drag === undefined ? value.atmosphereDrag : value.drag,
      { body: "earth", cd: 2.2, areaM2: 10 }, "environment.drag");
    const srp = normalizeToggle(value.srp === undefined ? value.solarRadiationPressure : value.srp,
      { source: "sun", occultingBodies: ["earth", "moon"], cr: 1.3, areaM2: 10,
        eclipse: true }, "environment.srp");
    const harmonics = normalizeToggle(value.harmonics === undefined
      ? value.earthHarmonics : value.harmonics,
    { body: "earth", degree: 4 }, "environment.harmonics");
    if (drag) {
      drag.body = String(drag.body || "earth");
      if (drag.body !== "earth") {
        throw new Error("The bounded reference atmosphere currently supports Earth only.");
      }
      positive(drag.areaM2, "environment.drag.areaM2");
      positive(drag.cd, "environment.drag.cd");
      if (drag.massKg !== undefined) positive(drag.massKg, "environment.drag.massKg");
    }
    if (srp) {
      srp.source = String(srp.source || "sun");
      if (srp.source !== "sun") {
        throw new Error("The cannonball solar-radiation model requires the Sun source.");
      }
      srp.occultingBodies = Object.freeze(Array.from(srp.occultingBodies || [], String));
      positive(srp.areaM2, "environment.srp.areaM2");
      positive(srp.cr, "environment.srp.cr");
      if (srp.massKg !== undefined) positive(srp.massKg, "environment.srp.massKg");
    }
    if (harmonics) {
      harmonics.body = String(harmonics.body || "earth");
      if (harmonics.body !== "earth") {
        throw new Error("Only Earth J2/J3/J4 harmonics are currently supported.");
      }
      const degree = Number(harmonics.degree);
      if (!Number.isInteger(degree) || degree < 2 || degree > 4) {
        throw new Error("environment.harmonics.degree must be 2, 3, or 4.");
      }
      harmonics.degree = degree;
      if (harmonics.coefficients) {
        harmonics.coefficients = Object.freeze(Object.assign({}, harmonics.coefficients));
      }
    }
    return Object.freeze({ drag: drag && Object.freeze(drag), srp: srp && Object.freeze(srp),
      harmonics: harmonics && Object.freeze(harmonics) });
  }

  globalThis.MissionEnvironmentModels = Object.freeze({
    EARTH_EQUATORIAL_RADIUS_KM,
    EARTH_MU_KM3_S2,
    EARTH_ZONALS,
    EARTH_DENSITY_TABLE,
    SOLAR_PRESSURE_1_AU_N_M2,
    MODEL_METADATA,
    atmosphericDensity,
    dragAcceleration,
    earthZonalAcceleration,
    earthZonalPotential,
    eclipseVisibility,
    solarRadiationPressureAcceleration,
    normalizeConfiguration,
  });
})();
