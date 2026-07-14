/* Canonical CR3BP dynamics regressions. Run with:
 *   node tests/cr3bp_tests.js
 * These tests intentionally load only constants.js and cr3bp.js: the CR3BP
 * math layer must remain usable without the Planner propagator or a DOM. */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

for (const file of ["constants.js", "cr3bp.js"])
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "js", file), "utf8"),
    { filename: file });

const C = globalThis.AstroConst;
const R = globalThis.CR3BP;
const SE = R.SYSTEMS.sunEarth;
const EM = R.SYSTEMS.earthMoon;

function near(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message}: ${actual} differs from ${expected} by ${Math.abs(actual - expected)}`);
}

function nearArray(actual, expected, tolerance, message) {
  assert.strictEqual(actual.length, expected.length, `${message}: vector lengths differ`);
  for (let i = 0; i < actual.length; i++)
    near(actual[i], expected[i], tolerance, `${message} component ${i}`);
}

// Reviewed primary data and canonical units come directly from constants.js.
assert.strictEqual(SE.distanceKm, C.BODIES.earth.aKm,
  "Sun–Earth distance unit diverged from the reviewed Earth mean element");
assert.strictEqual(EM.distanceKm, C.BODIES.moon.aKm,
  "Earth–Moon distance unit diverged from the reviewed lunar mean element");
near(SE.mu, C.BODIES.earth.mu / (C.BODIES.sun.mu + C.BODIES.earth.mu), 0,
  "Sun–Earth mass parameter is inconsistent");
near(EM.mu, C.BODIES.moon.mu / (C.BODIES.earth.mu + C.BODIES.moon.mu), 0,
  "Earth–Moon mass parameter is inconsistent");
near(SE.periodS, 2 * Math.PI * Math.sqrt(SE.distanceKm ** 3 / SE.totalGM), 1e-8,
  "Sun–Earth canonical period is inconsistent");
near(EM.periodS, 2 * Math.PI * Math.sqrt(EM.distanceKm ** 3 / EM.totalGM), 1e-8,
  "Earth–Moon canonical period is inconsistent");
console.log("PASS  reviewed systems and canonical units");

const sePoints = R.equilibriumPoints(SE);
const emPoints = R.equilibriumPoints(EM);

// Reference distances and Jacobi constants for this project's reviewed GMs
// and characteristic mean separations.  These values are independent frozen
// regressions, not Hill-radius approximations.
near(sePoints.L1.distanceFromSecondaryKm, 1491554.9071, 0.1,
  "Sun–Earth L1 distance from Earth");
near(sePoints.L2.distanceFromSecondaryKm, 1501535.6924, 0.1,
  "Sun–Earth L2 distance from Earth");
near(sePoints.L1.jacobi, 3.0008906938353, 2e-12,
  "Sun–Earth L1 Jacobi constant");
near(sePoints.L2.jacobi, 3.0008866891539, 2e-12,
  "Sun–Earth L2 Jacobi constant");

near(emPoints.L1.distanceFromSecondaryKm, 58019.1382, 0.1,
  "Earth–Moon L1 distance from Moon");
near(emPoints.L2.distanceFromSecondaryKm, 64514.9067, 0.1,
  "Earth–Moon L2 distance from Moon");
near(emPoints.L1.jacobi, 3.1883411036246, 2e-12,
  "Earth–Moon L1 Jacobi constant");
near(emPoints.L2.jacobi, 3.1721604488791, 2e-12,
  "Earth–Moon L2 Jacobi constant");
near(emPoints.L3.jacobi, 3.0121471491497, 2e-12,
  "Earth–Moon L3 Jacobi constant");
console.log("PASS  reference L-point distances and Jacobi constants");

for (const [systemName, points] of [["Sun–Earth", sePoints], ["Earth–Moon", emPoints]]) {
  for (const pointName of ["L1", "L2", "L3", "L4", "L5"])
    assert.ok(points[pointName].residual < 1e-12,
      `${systemName} ${pointName} equilibrium residual ${points[pointName].residual} exceeds 1e-12`);
  assert.ok(points.L1.x > -points.L1.distanceFromPrimary &&
    points.L1.x < 1 - (systemName === "Sun–Earth" ? SE.mu : EM.mu),
  `${systemName} L1 is outside the primary/secondary bracket`);
}
assert.ok(emPoints.L2.x > EM.secondaryX, "Earth–Moon L2 is not beyond the Moon");
assert.ok(emPoints.L3.x < EM.primaryX, "Earth–Moon L3 is not beyond Earth");
console.log("PASS  bracketed L1–L3 solves and equilibrium residuals");

for (const points of [sePoints, emPoints]) {
  near(points.L4.x, points.L5.x, 0, "L4/L5 x symmetry");
  near(points.L4.y, -points.L5.y, 0, "L4/L5 y symmetry");
  near(points.L4.z, points.L5.z, 0, "L4/L5 z symmetry");
  near(points.L4.jacobi, points.L5.jacobi, 0, "L4/L5 Jacobi symmetry");
  near(points.L4.distanceFromPrimary, 1, 2e-15,
    "L4 is not equidistant from the primary");
  near(points.L4.distanceFromSecondary, 1, 2e-15,
    "L4 is not equidistant from the secondary");
}
console.log("PASS  analytic L4/L5 symmetry");

// The analytic state Jacobian must match the equations of motion.  A central
// finite difference is used only as an independent regression oracle here.
{
  const state = [0.72, -0.19, 0.08, 0.04, 0.16, -0.03];
  const analytic = R.jacobian(EM, state);
  const h = 1e-7;
  for (let column = 0; column < 6; column++) {
    const plus = state.slice(), minus = state.slice();
    plus[column] += h;
    minus[column] -= h;
    const fp = R.derivatives(EM, plus);
    const fm = R.derivatives(EM, minus);
    for (let row = 0; row < 6; row++)
      near(analytic[row][column], (fp[row] - fm[row]) / (2 * h), 3e-8,
        `state Jacobian [${row},${column}]`);
  }

  // dC/dt must vanish algebraically along the rotating-frame equations.
  const gradient = R.effectivePotentialGradient(EM, state);
  const rate = R.derivatives(EM, state);
  const dCdt = 2 * (gradient[0] * state[3] + gradient[1] * state[4] +
    gradient[2] * state[5]) - 2 * (state[3] * rate[3] +
    state[4] * rate[4] + state[5] * rate[5]);
  near(dCdt, 0, 2e-15, "Jacobi derivative along the CR3BP equations");
}
console.log("PASS  rotating equations, Jacobian, and Jacobi invariant");

// Position and velocity transforms include omega x r; testing velocity is
// essential because a position-only rotation can appear correct while giving
// a physically wrong inertial trajectory.
{
  const rotating = [0.81, -0.13, 0.055, 0.021, 0.143, -0.018];
  for (const time of [-17.2, 0, 0.37, 8 * Math.PI + 0.1]) {
    const inertial = R.rotatingToInertial(rotating, time, 0.23);
    nearArray(R.inertialToRotating(inertial, time, 0.23), rotating, 3e-15,
      `canonical rotating/inertial round trip at t=${time}`);
  }

  const dimensional = [301200, -51600, 2200, 0.42, 0.91, -0.07];
  const seconds = 1234567;
  const inertialKm = R.rotatingToInertialDimensional(EM, dimensional, seconds, -0.5);
  nearArray(R.inertialToRotatingDimensional(EM, inertialKm, seconds, -0.5),
    dimensional, 2e-10, "dimensional rotating/inertial round trip");
  nearArray(R.denormalizeState(EM, R.normalizeState(EM, dimensional)),
    dimensional, 1e-12, "canonical unit round trip");
}
console.log("PASS  position/velocity frame and unit round trips");

// Collinear points are not parking locations.  Keep the warning in the core
// API so later UIs and stationkeeping tools cannot silently imply stability.
for (const points of [sePoints, emPoints]) {
  for (const name of ["L1", "L2", "L3"]) {
    assert.strictEqual(points[name].stability, "linearly-unstable");
    assert.match(points[name].warning, /unstable.*stationkeeping/i,
      `${name} does not carry its required stationkeeping warning`);
  }
  for (const name of ["L4", "L5"]) {
    assert.strictEqual(points[name].stability, "linearly-stable");
    assert.strictEqual(points[name].warning, null);
  }
}
assert.match(SE.modelWarning, /not an operational ephemeris/i,
  "system definition lost the CR3BP fidelity warning");
console.log("PASS  equilibrium stability warnings");

console.log("\n7/7 CR3BP test groups clean");
