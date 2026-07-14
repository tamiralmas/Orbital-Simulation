/* Deterministic atmosphere/SRP/harmonic regressions. Run with:
 *   node tests/environment_models_tests.js */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

for (const file of ["constants.js", "kepler.js", "ode.js", "ephemeris-table.js",
  "environment-models.js", "force-models.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "js", file), "utf8"),
    { filename: file });
}

const C = globalThis.AstroConst;
const A = globalThis.Astro;
const T = globalThis.MissionEphemerisTable;
const E = globalThis.MissionEnvironmentModels;
const F = globalThis.MissionForceModels;
const epochJD = A.dateToJD(new Date("2026-01-01T00:00:00Z"));
let groups = 0;

function near(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message}: ${actual} differs from ${expected} by ${Math.abs(actual - expected)}`);
}

function mag(value) { return Math.hypot(value[0], value[1], value[2]); }

function fixedEarthProvider(durationS) {
  return T.createProvider({
    source: "fixed Earth integration regression table",
    center: "500@10 (Sun center)",
    frame: "ICRF / ecliptic J2000",
    timeScale: "TDB",
    units: "km and km/s",
    bodies: { earth: { samples: [
      [epochJD, 0, 0, 0, 0, 0, 0],
      [epochJD + durationS / C.DAY, 0, 0, 0, 0, 0, 0],
    ] } },
  });
}

// Density is continuous in log space and explicitly bounded above 1,000 km.
{
  near(E.atmosphericDensity(400), 3.725e-12, 1e-25,
    "400-km reference density");
  near(E.atmosphericDensity(225), Math.sqrt(2.789e-10 * 7.248e-11), 1e-22,
    "logarithmic density interpolation");
  assert.strictEqual(E.atmosphericDensity(1000.001), 0,
    "atmosphere must not extrapolate above its coverage");
  assert.strictEqual(E.MODEL_METADATA.atmosphere.coverageKm[1], 1000);
  console.log("PASS  bounded piecewise-exponential atmosphere");
  groups++;
}

// Cannonball drag must oppose atmosphere-relative velocity and reproduce the
// SI analytic magnitude after conversion to km/s^2.
{
  const radius = E.EARTH_EQUATORIAL_RADIUS_KM + 400;
  const speed = 7.7;
  const state = { r: [radius, 0, 0], v: [0, speed, 0], massKg: 1000,
    bodyR: [0, 0, 0], bodyV: [0, 0, 0], bodyRadiusKm: E.EARTH_EQUATORIAL_RADIUS_KM,
    rotHours: 1e30, pole: [0, 0, 1] };
  const acceleration = E.dragAcceleration(state, { areaM2: 12, cd: 2.2 });
  const expected = 0.5 * E.atmosphericDensity(400) * 2.2 * 12 / 1000 *
    (speed * 1000) ** 2 / 1000;
  near(mag(acceleration), expected, expected * 2e-12, "drag acceleration magnitude");
  assert.ok(acceleration[1] < 0 && acceleration[0] === 0 && acceleration[2] === 0,
    "drag acceleration should oppose relative velocity");
  console.log("PASS  drag sign and analytic magnitude");
  groups++;
}

// Atmosphere rotation is derived from the same body frame used by textures,
// launch sites, and ground coordinates. A fixed surface point therefore has
// exactly zero air-relative velocity regardless of the frame's sign convention.
{
  const body = C.BODIES.earth;
  const frame = A.bodyFrameAt(body, epochJD);
  const halfSpanS = 30;
  const before = A.bodyFrameAt(body, epochJD - halfSpanS / C.DAY);
  const after = A.bodyFrameAt(body, epochJD + halfSpanS / C.DAY);
  let omega = [0, 0, 0];
  for (const axis of ["x", "y", "z"]) {
    const derivative = A.V.scale(A.V.sub(after[axis], before[axis]), 1 / (2 * halfSpanS));
    omega = A.V.add(omega, A.V.cross(frame[axis], derivative));
  }
  omega = A.V.scale(omega, 0.5);
  const relativeR = A.V.scale(frame.x, E.EARTH_EQUATORIAL_RADIUS_KM + 400);
  const atmosphereV = A.V.cross(omega, relativeR);
  const fixed = E.dragAcceleration({ r: relativeR, v: atmosphereV, massKg: 1000,
    bodyR: [0, 0, 0], bodyV: [0, 0, 0],
    bodyRadiusKm: E.EARTH_EQUATORIAL_RADIUS_KM, rotHours: body.rotHours,
    pole: frame.z, angularVelocityRadS: omega }, { areaM2: 12, cd: 2.2 });
  assert.deepStrictEqual(fixed, [0, 0, 0],
    "a body-fixed spacecraft should have zero atmospheric drag");
  const retrograde = E.dragAcceleration({ r: relativeR,
    v: A.V.scale(atmosphereV, -1), massKg: 1000,
    bodyR: [0, 0, 0], bodyV: [0, 0, 0],
    bodyRadiusKm: E.EARTH_EQUATORIAL_RADIUS_KM, rotHours: body.rotHours,
    pole: frame.z, angularVelocityRadS: omega }, { areaM2: 12, cd: 2.2 });
  const relativeVelocity = A.V.scale(atmosphereV, -2);
  assert.ok(A.V.dot(retrograde, relativeVelocity) < 0,
    "drag must oppose the body-frame atmosphere-relative velocity");
  console.log("PASS  body-frame-consistent atmospheric co-rotation");
  groups++;
}

// J2 agrees with the standard equatorial expression. Negative Earth J3 adds
// the expected southward equatorial acceleration, while J4 remains smaller.
{
  const radius = 7000;
  const r = [radius, 0, 0];
  const j2 = E.earthZonalAcceleration(r, { degree: 2, pole: [0, 0, 1] });
  const expectedJ2X = -1.5 * E.EARTH_ZONALS[2] * E.EARTH_MU_KM3_S2 *
    E.EARTH_EQUATORIAL_RADIUS_KM ** 2 / radius ** 4;
  near(j2[0], expectedJ2X, Math.abs(expectedJ2X) * 2e-15,
    "equatorial J2 acceleration");
  near(j2[1], 0, 0, "equatorial J2 y");
  near(j2[2], 0, 0, "equatorial J2 z");
  const j3 = E.earthZonalAcceleration(r, { degree: 3, pole: [0, 0, 1] });
  const expectedJ3Z = 1.5 * E.EARTH_MU_KM3_S2 * E.EARTH_ZONALS[3] *
    E.EARTH_EQUATORIAL_RADIUS_KM ** 3 / radius ** 5;
  near(j3[2], expectedJ3Z, Math.abs(expectedJ3Z) * 2e-14,
    "equatorial J3 acceleration");
  assert.ok(j3[2] < 0, "negative Earth J3 should point south at the equator");
  const j4 = E.earthZonalAcceleration(r, { degree: 4, pole: [0, 0, 1] });
  assert.ok(Math.abs(j4[0] - j3[0]) < Math.abs(j2[0]) * 0.01,
    "J4 correction should remain a small perturbation to J2");
  console.log("PASS  Earth J2/J3/J4 signs and magnitudes");
  groups++;
}

// SRP at 1 AU has the cannonball analytic magnitude. A foreground Earth disk
// must suppress it completely; an off-axis Earth must not.
{
  const spacecraft = [C.AU + 7000, 0, 0];
  const sun = { r: [0, 0, 0], radiusKm: C.BODIES.sun.radius };
  const earth = { r: [C.AU, 0, 0], radiusKm: E.EARTH_EQUATORIAL_RADIUS_KM };
  near(E.eclipseVisibility(spacecraft, sun, [earth]), 0, 0,
    "full Earth umbra visibility");
  const clearEarth = { r: [C.AU, 50000, 0], radiusKm: E.EARTH_EQUATORIAL_RADIUS_KM };
  near(E.eclipseVisibility(spacecraft, sun, [clearEarth]), 1, 1e-15,
    "clear solar disk visibility");

  const atOneAu = [C.AU, 0, 0];
  const lit = E.solarRadiationPressureAcceleration({ r: atOneAu, massKg: 1000,
    sunR: [0, 0, 0], sunRadiusKm: C.BODIES.sun.radius, occultors: [] },
  { areaM2: 20, cr: 1.5 });
  const expected = E.SOLAR_PRESSURE_1_AU_N_M2 * 1.5 * 20 / 1000 / 1000;
  near(mag(lit), expected, expected * 2e-15, "one-AU SRP magnitude");
  assert.ok(lit[0] > 0, "SRP should point away from the Sun");
  const dark = E.solarRadiationPressureAcceleration({ r: spacecraft, massKg: 1000,
    sunR: [0, 0, 0], sunRadiusKm: C.BODIES.sun.radius, occultors: [earth] },
  { areaM2: 20, cr: 1.5 });
  assert.deepStrictEqual(dark, [0, 0, 0], "umbra should fully suppress SRP");
  console.log("PASS  SRP magnitude and eclipse suppression");
  groups++;
}

// The adaptive force-model selector must preserve old defaults bit-for-bit.
// Its conservative degree-4 path stays outside Earth and conserves the full
// monopole-plus-zonal energy over multiple revolutions.
{
  const durationS = 6 * 3600;
  const provider = fixedEarthProvider(durationS);
  const frame = A.bodyFrameAt(C.BODIES.earth, epochJD);
  const radius = 7000;
  const speed = Math.sqrt(C.BODIES.earth.mu / radius);
  const r0 = frame.x.map((value) => value * radius);
  const v0 = frame.y.map((value) => value * speed);
  const baseOptions = { epochJD, r0, v0, durationS, bodies: ["earth"],
    ephemerisProvider: provider, outputStep: 60, maxStep: 15, rtol: 2e-11,
    atol: [1e-7, 1e-7, 1e-7, 1e-11, 1e-11, 1e-11] };
  const defaultResult = F.propagate(baseOptions);
  const disabledResult = F.propagate(Object.assign({}, baseOptions, { environment: false }));
  assert.deepStrictEqual(disabledResult.rFinal, defaultResult.rFinal,
    "environment-off position should preserve the existing API exactly");
  assert.deepStrictEqual(disabledResult.vFinal, defaultResult.vFinal,
    "environment-off velocity should preserve the existing API exactly");

  const harmonics = F.propagate(Object.assign({}, baseOptions, {
    environment: { harmonics: { body: "earth", degree: 4 } },
  }));
  assert.ok(mag(harmonics.rFinal.map((value, axis) => value - defaultResult.rFinal[axis])) > 1,
    "selected higher harmonics should produce a resolved state difference");
  const energies = harmonics.samples.map((sample) => {
    const r = mag(sample.r);
    return mag(sample.v) ** 2 / 2 - C.BODIES.earth.mu / r +
      E.earthZonalPotential(sample.r, { degree: 4, mu: C.BODIES.earth.mu,
        pole: frame.z });
  });
  const reference = energies[0];
  const maxRelativeDrift = Math.max(...energies.map((value) =>
    Math.abs((value - reference) / reference)));
  assert.ok(maxRelativeDrift < 2e-9,
    "degree-4 conservative energy drift exceeded its integration bound: " + maxRelativeDrift);
  const radii = harmonics.samples.map((sample) => mag(sample.r));
  assert.ok(Math.min(...radii) > C.BODIES.earth.radius &&
    Math.max(...radii) - Math.min(...radii) < 60,
  "degree-4 integrated state left its bounded LEO envelope");
  assert.strictEqual(harmonics.environmentModels.harmonics.degree, 4);
  console.log("PASS  selectable force integration, energy, and state bounds");
  groups++;
}

// Runtime mass validation must fail before an accidentally infinite
// acceleration can enter the ODE.
{
  assert.throws(() => F.propagate({ epochJD, r0: [C.AU, 0, 0], v0: [0, 30, 0],
    durationS: 10, bodies: ["sun"], environment: { srp: true } }), /requires massKg/);
  assert.throws(() => E.normalizeConfiguration({ harmonics: { degree: 5 } }),
    /degree must be 2, 3, or 4/);
  console.log("PASS  environment configuration fail-closed validation");
  groups++;
}

console.log(`\n${groups}/${groups} environment-model test groups clean`);
