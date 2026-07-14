/* Trajectory-analysis engine regressions. Run with:
 *   node tests/analysis_tests.js */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

for (const file of ["constants.js", "kepler.js", "analysis.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "js", file), "utf8"),
    { filename: file });
}

const C = globalThis.AstroConst;
const A = globalThis.Astro;
const X = globalThis.MissionAnalysis;
const V = A.V;

function near(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message}: ${actual} differs from ${expected} by ${Math.abs(actual - expected)}`);
}

let groups = 0;

// A dense eccentric orbit must preserve its endpoint/extrema geometry while
// dropping redundant samples. Every exported row is directly CSV-ready.
{
  const mu = C.BODIES.earth.mu;
  const elements = { a: 12000, e: 0.22, i: 0.63, Om: 0.41, w: 0.77 };
  const samples = [];
  for (let index = 0; index <= 720; index++) {
    const nu = 2 * Math.PI * index / 720;
    const state = A.coeToRV({ ...elements, nu }, mu);
    samples.push({ t: index * 10, r: state.r, v: state.v });
  }
  const result = X.extractOsculatingSeries({
    samples,
    mu,
    radiusKm: C.BODIES.earth.radius,
    epochJD: C.J2000_JD,
    targetPosition: [0, 0, 0],
    maxPoints: 90,
    tolerances: { altitudeKm: 0.5, speedKmS: 1e-4,
      trueAnomalyDeg: 0.05 },
  });
  assert.strictEqual(result.sourceCount, 721);
  assert.ok(result.decimated && result.outputCount > 6 && result.outputCount <= 90,
    `unexpected adaptive series size ${result.outputCount}`);
  assert.strictEqual(result.rows[0].sourceIndex, 0);
  assert.strictEqual(result.rows[result.rows.length - 1].sourceIndex, 720);
  const periapsis = result.rows.reduce((best, row) =>
    row.altitudeKm < best.altitudeKm ? row : best);
  const apoapsis = result.rows.reduce((best, row) =>
    row.altitudeKm > best.altitudeKm ? row : best);
  near(periapsis.radiusKm, elements.a * (1 - elements.e), 1e-8,
    "series periapsis radius");
  near(apoapsis.radiusKm, elements.a * (1 + elements.e), 1e-8,
    "series apoapsis radius");
  for (const row of result.rows) {
    near(row.aKm, elements.a, 1e-8, "osculating semi-major axis");
    near(row.e, elements.e, 1e-12, "osculating eccentricity");
    near(row.iDeg, elements.i / C.DEG, 1e-10, "osculating inclination");
    near(row.targetDistanceKm, row.radiusKm, 1e-12,
      "distance-to-target series");
  }
  assert.deepStrictEqual(result.csvRows[0], Array.from(X.SERIES_COLUMNS));
  assert.strictEqual(result.csvRows.length, result.rows.length + 1);
  const csv = X.rowsToCSV(result.columns, result.rows);
  assert.ok(csv.startsWith("timeS,jd,aKm,e,iDeg") && csv.split("\r\n").length ===
    result.rows.length + 1, "CSV serializer contract changed");
  console.log("PASS  osculating series, adaptive decimation, and CSV rows");
  groups++;
}

// Conical angular-disk geometry locates both the penumbral envelope and its
// nested umbra. A 500-km circular LEO spends roughly 38% of each orbit in
// shadow, close to the familiar one-third low-Earth-orbit eclipse fraction.
{
  const earth = C.BODIES.earth;
  const sun = C.BODIES.sun;
  const radius = earth.radius + 500;
  const n = Math.sqrt(earth.mu / radius ** 3);
  const period = 2 * Math.PI / n;
  const sunPosition = [C.AU, 0, 0];
  const atNoon = X.shadowGeometry({
    spacecraftPosition: [radius, 0, 0], lightPosition: sunPosition,
    occulterPosition: [0, 0, 0], lightRadiusKm: sun.radius,
    occulterRadiusKm: earth.radius,
  });
  const atMidnight = X.shadowGeometry({
    spacecraftPosition: [-radius, 0, 0], lightPosition: sunPosition,
    occulterPosition: [0, 0, 0], lightRadiusKm: sun.radius,
    occulterRadiusKm: earth.radius,
  });
  assert.strictEqual(atNoon.phase, "sunlight");
  assert.strictEqual(atMidnight.phase, "umbra");
  near(atMidnight.obscuration, 1, 1e-12, "midnight solar obscuration");
  const behindSun = X.shadowGeometry({
    spacecraftPosition: [0, 0, 0], lightPosition: [1000, 0, 0],
    occulterPosition: [2000, 0, 0], lightRadiusKm: 100,
    occulterRadiusKm: 200,
  });
  assert.strictEqual(behindSun.phase, "sunlight",
    "a body behind the light source cannot cause an eclipse");
  assert.strictEqual(behindSun.obscuration, 0);
  const eclipses = X.eclipseIntervals({
    stateAt: (time) => [radius * Math.cos(n * time),
      radius * Math.sin(n * time), 0],
    startTimeS: 0,
    endTimeS: period,
    stepS: 20,
    timeToleranceS: 1e-3,
    lightPosition: sunPosition,
    occulterPosition: [0, 0, 0],
    lightRadiusKm: sun.radius,
    occulterRadiusKm: earth.radius,
    epochJD: C.J2000_JD,
  });
  assert.strictEqual(eclipses.umbra.length, 1,
    "one circular orbit should contain one umbra interval");
  assert.strictEqual(eclipses.penumbra.length, 1,
    "one circular orbit should contain one penumbra envelope");
  const shadowFraction = eclipses.totals.umbraS / period;
  assert.ok(shadowFraction > 0.35 && shadowFraction < 0.40,
    `LEO eclipse fraction is implausible: ${shadowFraction}`);
  assert.ok(eclipses.totals.penumbraEnvelopeS > eclipses.totals.umbraS,
    "finite solar radius should make the penumbra envelope wider than umbra");
  assert.ok(eclipses.phases.some((phase) => phase.type === "penumbra"),
    "non-overlapping eclipse phases omitted partial penumbra");
  console.log("PASS  conical umbra/penumbra geometry and event bisection");
  groups++;
}

// A fixed spherical station under an equatorial circular orbit has an
// analytic horizon-contact duration. Elevation masks must shorten the pass,
// and the peak must occur at the overhead epoch.
{
  const earth = C.BODIES.earth;
  const orbitRadius = earth.radius + 500;
  const n = Math.sqrt(earth.mu / orbitRadius ** 3);
  const period = 2 * Math.PI / n;
  const frame = A.bodyFrameAt(earth, C.J2000_JD, 0);
  const stateAt = (time) => V.add(V.scale(frame.x, orbitRadius * Math.cos(n * time)),
    V.scale(frame.y, orbitRadius * Math.sin(n * time)));
  const baseStation = { id: "equator", name: "Equator test site", bodyId: "earth",
    latDeg: 0, lonDeg: 0, altKm: 0, elevationMaskDeg: 0 };
  const report = X.groundStationAccess({
    stations: [baseStation], stateAt,
    startTimeS: -period / 2, endTimeS: period / 2, stepS: 15,
    timeToleranceS: 1e-4, epochJD: C.J2000_JD,
    spinAt: () => 0,
  });
  assert.strictEqual(report.intervals.length, 1, "equatorial pass count");
  const expectedDuration = 2 * Math.acos(earth.radius / orbitRadius) / n;
  near(report.intervals[0].durationS, expectedDuration, 0.01,
    "analytic zero-mask access duration");
  near(report.intervals[0].maxElevationTimeS, 0, 1e-3,
    "overhead access epoch");
  near(report.intervals[0].maxElevationDeg, 90, 2e-6,
    "overhead elevation");
  const masked = X.groundStationAccess({
    stations: [{ ...baseStation, elevationMaskDeg: 10 }], stateAt,
    startTimeS: -period / 2, endTimeS: period / 2, stepS: 15,
    epochJD: C.J2000_JD, spinAt: () => 0,
  });
  assert.ok(masked.intervals[0].durationS < report.intervals[0].durationS,
    "elevation mask failed to shorten the pass");
  assert.deepStrictEqual(X.DSN_STATIONS.map((station) => station.complex),
    ["Goldstone", "Canberra", "Madrid"]);
  const opposite = X.accessGeometry(V.scale(frame.x, -orbitRadius), baseStation,
    C.J2000_JD, 0);
  assert.ok(!opposite.visible && opposite.elevationDeg < 0,
    "body occlusion should put the antipodal spacecraft below the horizon");
  assert.ok(opposite.occluded, "antipodal line of sight should intersect Earth");
  console.log("PASS  DSN/user station access windows and elevation masks");
  groups++;
}

// Cone/sphere intersections provide a closed nadir footprint, an off-nadir
// displaced center, and a clean miss once the boresight points past the limb.
{
  const radius = C.BODIES.earth.radius;
  const altitude = 500;
  const spacecraft = [radius + altitude, 0, 0];
  const nadir = X.sensorFootprint({ spacecraftPosition: spacecraft,
    bodyRadiusKm: radius, fovDeg: 10, boundarySamples: 72 });
  assert.ok(nadir.closed && nadir.center, "nadir cone should fully intersect Earth");
  near(nadir.center[0], radius, 1e-12, "nadir footprint center");
  const flatEarthWidth = 2 * altitude * Math.tan(5 * C.DEG);
  near(nadir.swathWidthKm, flatEarthWidth, flatEarthWidth * 0.012,
    "small-angle nadir swath width");
  const tilted = X.sensorFootprint({ spacecraftPosition: spacecraft,
    bodyRadiusKm: radius, fovDeg: 4, offNadirDeg: 20, azimuthDeg: 90,
    boundarySamples: 72 });
  assert.ok(tilted.closed && tilted.center,
    "moderate off-nadir cone should retain a closed footprint");
  assert.ok(Math.hypot(tilted.center[1], tilted.center[2]) > 100,
    "off-nadir footprint center did not move away from nadir");
  const miss = X.sensorFootprint({ spacecraftPosition: spacecraft,
    bodyRadiusKm: radius, fovDeg: 2, offNadirDeg: 80, boundarySamples: 72 });
  assert.strictEqual(miss.center, null, "past-limb boresight should miss the body");
  assert.ok(miss.hitFraction < 1, "past-limb cone incorrectly produced a closed swath");
  const tangent = X.raySphereIntersection([2, 1, 0], [-1, 0, 0], [0, 0, 0], 1);
  near(tangent.point[0], 0, 1e-12, "tangent ray x");
  near(tangent.point[1], 1, 1e-12, "tangent ray y");
  console.log("PASS  nadir/off-nadir sensor and body-intersection geometry");
  groups++;
}

// Solving the first-order J2 nodal equation at 700 km reproduces the mean
// solar rate and the standard retrograde SSO inclination near 98.19 degrees.
{
  const sso = X.sunSynchronousInclination({ altitudeKm: 700 });
  const sameSso = X.sunSynchronousInclination({ aKm: sso.aKm });
  near(sameSso.inclinationDeg, sso.inclinationDeg, 1e-13,
    "SSO semi-major-axis input form");
  assert.ok(sso.inclinationDeg > 98.1 && sso.inclinationDeg < 98.3,
    `700-km SSO inclination is implausible: ${sso.inclinationDeg}`);
  const rates = X.j2SecularRates({ aKm: sso.aKm, e: 0,
    iRad: sso.inclinationRad });
  near(rates.raanRateDegDay, 360 / 365.2422, 1e-10,
    "700-km sun-synchronous nodal rate");
  const propagated = X.applyJ2Secular({ a: sso.aKm, e: 0,
    i: sso.inclinationRad, Om: 0.2, w: 0.3, M: 0.4 }, C.DAY);
  near(propagated.Om, 0.2 + rates.raanRateRadS * C.DAY, 1e-14,
    "one-day J2 RAAN drift");
  assert.ok(Number.isFinite(propagated.w) && Number.isFinite(propagated.M));
  console.log("PASS  first-order J2 secular rates and 700-km SSO validation");
  groups++;
}

// Rocket-equation mass depletion and thrust-derived mass flow close exactly;
// a dry-mass cap reports infeasibility rather than silently clipping the burn.
{
  const burn = X.finiteBurnEstimate({ thrustN: 1000, ispS: 300,
    initialMassKg: 1000, deltaVKmS: 0.1, dryMassKg: 900 });
  const expectedFinal = 1000 / Math.exp(100 / (300 * X.G0_M_S2));
  near(burn.finalMassKg, expectedFinal, 1e-12, "finite-burn final mass");
  near(burn.durationS * burn.massFlowKgS, burn.propellantMassKg, 1e-12,
    "burn duration/mass-flow closure");
  near(X.G0_M_S2 * burn.ispS * Math.log(burn.initialMassKg / burn.finalMassKg),
    burn.deltaVMs, 1e-12, "rocket-equation delta-v closure");
  assert.ok(burn.feasible && burn.durationS < burn.constantMassDurationS,
    "mass depletion should reduce duration relative to a constant-mass estimate");
  const impossible = X.finiteBurnEstimate({ thrustN: 20, ispS: 220,
    initialMassKg: 100, dryMassKg: 95, deltaVKmS: 1 });
  assert.ok(!impossible.feasible && impossible.propellantShortfallKg > 0 &&
    impossible.maxDeltaVKmS < impossible.deltaVKmS,
  "dry-mass-limited burn should report its shortfall");
  const zero = X.finiteBurnEstimate({ thrustN: 10, ispS: 300,
    initialMassKg: 50, dryMassKg: 50, deltaVKmS: 0 });
  assert.strictEqual(zero.durationS, 0);
  assert.strictEqual(zero.propellantMassKg, 0);
  assert.ok(zero.feasible);
  console.log("PASS  finite-burn duration, propellant, and feasibility estimates");
  groups++;
}

// Unbounded or physically ambiguous requests must fail before doing work.
assert.throws(() => X.extractOsculatingSeries({ samples: [], mu: 1 }), /non-empty/);
assert.throws(() => X.sensorFootprint({ spacecraftPosition: [7000, 0, 0],
  bodyRadiusKm: 6371, fovDeg: 200 }), /below 180/);
assert.throws(() => X.j2SecularRates({ aKm: 7000, e: 1.1, iRad: 0 }), /elliptic/);
assert.throws(() => X.finiteBurnEstimate({ thrustN: 1, ispS: 0,
  initialMassKg: 1, deltaVKmS: 0 }), /specific impulse/);
assert.throws(() => X.normalizeStation({ latDeg: 0, lonDeg: 0,
  elevationMaskDeg: -1 }, 0, {}), /\[0, 90\)/);
assert.throws(() => X.adaptiveDecimateRows([{ timeS: 0 }, { timeS: 1 },
  { timeS: 2 }], { maxPoints: 1 }), /maxPoints/);
console.log("PASS  bounded analysis input contracts");
groups++;

console.log(`\n${groups}/${groups} trajectory-analysis test groups clean`);
