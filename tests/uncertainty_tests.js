/* Covariance, maneuver-error, and deterministic Monte Carlo regressions.
 * Run with: node tests/uncertainty_tests.js */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "js", "uncertainty.js"),
  "utf8"), { filename: "uncertainty.js" });

const U = globalThis.MissionUncertainty;
let groups = 0;

function diagonal(values) {
  return Array.from({ length: 6 }, (_, row) =>
    Array.from({ length: 6 }, (_, column) => row === column ? values[row] : 0));
}

function near(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} differs from ${expected}`);
}

function identity(size) {
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => row === column ? 1 : 0));
}

function matrixNear(actual, expected, tolerance, label) {
  assert.strictEqual(actual.length, expected.length, `${label} row count`);
  for (let row = 0; row < expected.length; row++) {
    assert.strictEqual(actual[row].length, expected[row].length,
      `${label} column count at row ${row}`);
    for (let column = 0; column < expected[row].length; column++) {
      near(actual[row][column], expected[row][column], tolerance,
        `${label}[${row}][${column}]`);
    }
  }
}

// Covariances must be symmetric positive-semidefinite; exact zero modes are
// valid and intentionally supported.
{
  const semidefinite = diagonal([4, 1, 0, 0.25, 0, 0]);
  const validated = U.validateCovariance(semidefinite);
  assert.strictEqual(validated[2][2], 0);
  const negative = diagonal([1, 1, 1, 1, 1, -0.1]);
  assert.throws(() => U.validateCovariance(negative),
    (error) => error.code === "NON_POSITIVE_SEMIDEFINITE");
  const asymmetric = diagonal([1, 1, 1, 1, 1, 1]);
  asymmetric[0][1] = 0.2;
  assert.throws(() => U.validateCovariance(asymmetric),
    (error) => error.code === "NON_SYMMETRIC_COVARIANCE");
  const tinyValid = diagonal([1e-16, 2e-16, 0, 4e-18, 0, 0]);
  assert.strictEqual(U.validateCovariance(tinyValid)[0][0], 1e-16,
    "small valid covariance was rounded away");
  const tinyIndefinite = diagonal([1e-12, 1e-12, 1e-12, 1e-12, 1e-12, 1e-12]);
  tinyIndefinite[0][1] = tinyIndefinite[1][0] = 2e-12;
  assert.throws(() => U.validateCovariance(tinyIndefinite),
    (error) => error.code === "NON_POSITIVE_SEMIDEFINITE",
    "small indefinite covariance passed an absolute-scale PSD tolerance");
  const tinyAsymmetric = diagonal([1e-12, 1e-12, 1e-12, 1e-12, 1e-12, 1e-12]);
  tinyAsymmetric[0][1] = 2e-12;
  assert.throws(() => U.validateCovariance(tinyAsymmetric),
    (error) => error.code === "NON_SYMMETRIC_COVARIANCE",
    "small asymmetric covariance passed an absolute-scale symmetry tolerance");
  console.log("PASS  covariance symmetry/PSD validation");
  groups++;
}

// For constant velocity, Phi=[I dtI;0 I] gives the exact analytic covariance.
{
  const state = [1, 2, 3, 4, 5, 6];
  const covariance = diagonal([1, 1, 1, 1, 1, 1]);
  const result = U.propagateCovariance({ state, covariance, dt: 10,
    propagator: (input, dt) => [input[0] + input[3] * dt,
      input[1] + input[4] * dt, input[2] + input[5] * dt,
      input[3], input[4], input[5]] });
  near(result.covariance[0][0], 101, 5e-7, "free-drift position variance");
  near(result.covariance[0][3], 10, 5e-8, "free-drift cross covariance");
  near(result.covariance[3][3], 1, 5e-9, "free-drift velocity variance");
  assert.strictEqual(result.evaluations, 13);
  assert.deepStrictEqual(result.finalState, [41, 52, 63, 4, 5, 6]);
  console.log("PASS  numerical STM and analytic free-drift covariance");
  groups++;
}

// A supplied STM plus process noise follows P=Phi P Phi^T+Q exactly.
{
  const phi = diagonal([2, 3, 4, 1, 1, 1]);
  const process = diagonal([0.5, 0, 0, 0, 0, 0]);
  const propagated = U.propagateLinear(diagonal([1, 1, 1, 1, 1, 1]), phi, process);
  near(propagated[0][0], 4.5, 1e-12, "linear covariance with process noise");
  near(propagated[1][1], 9, 1e-12, "linear covariance axis 1");
  near(propagated[2][2], 16, 1e-12, "linear covariance axis 2");
  console.log("PASS  supplied STM and process-noise propagation");
  groups++;
}

// An inertial impulse is independent of the incoming Cartesian state, so its
// burn transition is exactly I and the covariance update is exactly P + Q.
// This guards the fast path separately from the state-dependent RTN Jacobian.
{
  const state = [42164, -12, 4, 0.001, 3.074, -0.002];
  const covariance = diagonal([4, 9, 16, 4e-4, 9e-4, 16e-4]);
  covariance[0][3] = covariance[3][0] = 0.02;
  covariance[1][4] = covariance[4][1] = -0.03;
  covariance[2][5] = covariance[5][2] = 0.08;
  const maneuver = { dv: [0.02, -0.01, 0.005], frame: "inertial", execution: {
    magnitudeSigmaFraction: 0.015, pointingSigmaRad: 0.002, timingSigmaS: 1.5,
  } };
  const result = U.applyManeuverCovariance({ state, covariance, maneuver });
  const expected = covariance.map((row, rowIndex) => row.map((component, columnIndex) =>
    component + result.maneuverCovariance[rowIndex][columnIndex]));
  assert.deepStrictEqual(result.transition, identity(6),
    "inertial burn acquired a state-dependent transition");
  assert.strictEqual(result.evaluations, 0,
    "inertial burn unnecessarily evaluated a numerical Jacobian");
  assert.strictEqual(result.steps, null, "inertial burn exposed finite-difference steps");
  matrixNear(result.covariance, expected, 1e-12, "inertial P + Q");
  near(result.finalState[3], state[3] + maneuver.dv[0], 1e-15,
    "inertial burn vx");
  near(result.finalState[4], state[4] + maneuver.dv[1], 1e-15,
    "inertial burn vy");
  near(result.finalState[5], state[5] + maneuver.dv[2], 1e-15,
    "inertial burn vz");
  console.log("PASS  inertial maneuver identity transition and P + Q");
  groups++;
}

// RTN execution errors map magnitude along the burn and pointing across it;
// timing sensitivity maps into position at a common comparison epoch.
{
  const state = [7000, 0, 0, 0, 7.5, 0];
  const maneuver = { dv: [0, -0.01, 0], frame: "RTN", execution: {
    magnitudeSigmaFraction: 0.01, pointingSigmaRad: 0.01, timingSigmaS: 2,
  } };
  const noise = U.maneuverErrorCovariance(state, maneuver);
  near(noise[4][4], 1e-8, 1e-16, "magnitude execution variance");
  near(noise[3][3], 1e-8, 1e-16, "in-plane pointing variance");
  near(noise[5][5], 1e-8, 1e-16, "out-of-plane pointing variance");
  near(noise[1][1], 4e-4, 1e-14, "timing position variance");
  const applied = U.applyManeuverCovariance({ state,
    covariance: diagonal([0, 0, 0, 0, 0, 0]), maneuver });
  near(applied.finalState[4], 7.49, 1e-14, "nominal retrograde burn");
  console.log("PASS  RTN magnitude/pointing/timing execution covariance");
  groups++;
}

// At r=[R,0,0], v=[0,V,0], the RTN basis is the Cartesian basis. For an RTN
// burn [a,b,c], differentiating that moving basis gives the non-zero terms
// d(dv)/dy=[-b/R,a/R,0], d(dv)/dz=[-c/R,0,a/R], and
// d(dv)/dvz=[0,-c/V,b/V]. The numerical burn Jacobian and its propagated
// covariance must reproduce those analytic couplings.
{
  const radius = 7000;
  const speed = Math.sqrt(398600.4418 / radius);
  const state = [radius, 0, 0, 0, speed, 0];
  const covariance = diagonal([4, 9, 16, 4e-6, 9e-6, 16e-6]);
  const radialDv = 0.002, transverseDv = -0.01, normalDv = 0.003;
  const maneuver = { dv: [radialDv, transverseDv, normalDv], frame: "RTN",
    execution: { magnitudeSigmaFraction: 0.01, pointingSigmaRad: 0.002,
      timingSigmaS: 0.5 } };
  const result = U.applyManeuverCovariance({ state, covariance, maneuver,
    steps: [0.01, 0.01, 0.01, 1e-6, 1e-6, 1e-6] });
  const analytic = identity(6);
  analytic[3][1] = -transverseDv / radius;
  analytic[3][2] = -normalDv / radius;
  analytic[4][1] = radialDv / radius;
  analytic[4][5] = -normalDv / speed;
  analytic[5][2] = radialDv / radius;
  analytic[5][5] = 1 + transverseDv / speed;
  matrixNear(result.transition, analytic, 5e-10,
    "circular-state RTN burn transition");
  assert.strictEqual(result.evaluations, 13,
    "RTN burn did not use one nominal plus twelve central-difference evaluations");
  const expectedCovariance = U.propagateLinear(covariance, analytic,
    result.maneuverCovariance);
  matrixNear(result.covariance, expectedCovariance, 5e-9,
    "analytic RTN covariance coupling");
  near(result.covariance[1][3], covariance[1][1] * (-transverseDv / radius),
    5e-10, "along-track position / inertial vx covariance");
  near(result.covariance[2][5], covariance[2][2] * (radialDv / radius),
    5e-10, "cross-track position / inertial vz covariance");
  console.log("PASS  RTN moving-basis Jacobian analytic coupling");
  groups++;
}

// Monte Carlo is bit-for-bit repeatable for a seed, and its sampled input
// covariance converges to a correlated analytic covariance.
{
  const covariance = diagonal([4, 1, 0, 0.25, 0, 0]);
  covariance[0][1] = covariance[1][0] = 1.2;
  const options = { meanState: [0, 0, 0, 0, 0, 0], covariance,
    samples: 12000, seed: "dispersion-117", retainSamples: false };
  const first = U.runMonteCarlo(options);
  const second = U.runMonteCarlo(options);
  assert.deepStrictEqual(first.summary, second.summary,
    "identical seeded Monte Carlo runs diverged");
  near(first.summary.covariance[0][0], 4, 0.16, "sample x variance");
  near(first.summary.covariance[1][1], 1, 0.05, "sample y variance");
  near(first.summary.covariance[0][1], 1.2, 0.07, "sample xy covariance");
  near(first.summary.covariance[3][3], 0.25, 0.015, "sample vx variance");
  assert.notDeepStrictEqual(U.runMonteCarlo(Object.assign({}, options, { seed: "other" })).summary,
    first.summary, "different seeds produced identical statistics");
  console.log("PASS  deterministic seeded correlated Monte Carlo");
  groups++;
}

// A sampled maneuver cloud agrees with the analytic first-order execution
// covariance without a hidden two-body approximation.
{
  const state = [7000, 0, 0, 0, 7.5, 0];
  const zero = diagonal([0, 0, 0, 0, 0, 0]);
  const maneuver = { dv: [0, -0.01, 0], frame: "RTN", execution: {
    magnitudeSigmaFraction: 0.01, pointingSigmaRad: 0.01, timingSigmaS: 2,
  } };
  const analytic = U.maneuverErrorCovariance(state, maneuver);
  const sampled = U.runMonteCarlo({ meanState: state, covariance: zero,
    maneuvers: [maneuver], samples: 16000, seed: 1170 }).summary.covariance;
  near(sampled[4][4], analytic[4][4], analytic[4][4] * 0.05,
    "sampled magnitude variance");
  near(sampled[3][3], analytic[3][3], analytic[3][3] * 0.06,
    "sampled pointing variance");
  near(sampled[1][1], analytic[1][1], analytic[1][1] * 0.05,
    "sampled timing variance");
  console.log("PASS  analytic / sampled maneuver-error agreement");
  groups++;
}

// Adversarial GEO case: a large transverse RTN impulse followed by one day of
// free drift turns a modest along-track position uncertainty into radial
// velocity/position uncertainty because the RTN basis rotates with the sampled
// state. The old identity burn transition misses that term. A 3-D Gaussian
// 95% ellipsoid is contained by sqrt(chi2_3,95 * lambda_max), so that radius is
// a conservative scalar upper bound whose seeded sample coverage can be tested.
{
  const radius = 42164;
  const speed = Math.sqrt(398600.4418 / radius);
  const state = [radius, 0, 0, 0, speed, 0];
  const covariance = diagonal([0.1 * 0.1, 100 * 100, 0.1 * 0.1,
    1e-5 * 1e-5, 1e-5 * 1e-5, 1e-5 * 1e-5]);
  const maneuver = { dv: [0, 1, 0], frame: "RTN" };
  const driftSeconds = 86400;
  const drift = (sample, dt) => [sample[0] + sample[3] * dt,
    sample[1] + sample[4] * dt, sample[2] + sample[5] * dt,
    sample[3], sample[4], sample[5]];
  const driftTransition = identity(6);
  for (let axis = 0; axis < 3; axis++) driftTransition[axis][axis + 3] = driftSeconds;
  const zero = diagonal([0, 0, 0, 0, 0, 0]);
  const burn = U.applyManeuverCovariance({ state, covariance, maneuver,
    steps: [0.01, 0.01, 0.01, 1e-6, 1e-6, 1e-6] });
  const linearized = U.propagateLinear(burn.covariance, driftTransition, zero);
  const oldIdentityBurn = U.propagateLinear(covariance, identity(6),
    burn.maneuverCovariance);
  const oldLinearized = U.propagateLinear(oldIdentityBurn, driftTransition, zero);

  function largestPositionEigenvalue(matrix) {
    let vector = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)];
    for (let iteration = 0; iteration < 64; iteration++) {
      const product = [0, 1, 2].map((row) => matrix[row][0] * vector[0] +
        matrix[row][1] * vector[1] + matrix[row][2] * vector[2]);
      const magnitude = Math.hypot(...product);
      assert.ok(magnitude > 0, "position covariance lost every positive mode");
      vector = product.map((component) => component / magnitude);
    }
    return vector.reduce((sum, component, row) => sum + component *
      (matrix[row][0] * vector[0] + matrix[row][1] * vector[1] +
        matrix[row][2] * vector[2]), 0);
  }

  const chiSquare3At95 = 7.814727903251179;
  const linearizedUpper = Math.sqrt(chiSquare3At95 *
    largestPositionEigenvalue(linearized));
  const oldUpper = Math.sqrt(chiSquare3At95 *
    largestPositionEigenvalue(oldLinearized));
  const nominal = drift(burn.finalState, driftSeconds);
  const monteCarlo = U.runMonteCarlo({ meanState: state, covariance,
    maneuvers: [maneuver], propagationTime: driftSeconds, propagator: drift,
    samples: 16000, seed: "geo-rtn-jacobian", retainSamples: true });
  function coverage(bound) {
    const inside = monteCarlo.samples.reduce((count, sample) => count +
      (Math.hypot(sample[0] - nominal[0], sample[1] - nominal[1],
        sample[2] - nominal[2]) <= bound ? 1 : 0), 0);
    return inside / monteCarlo.samples.length;
  }
  const linearizedCoverage = coverage(linearizedUpper);
  const oldCoverage = coverage(oldUpper);
  assert.ok(linearizedCoverage >= 0.98,
    `RTN linearized 3-D bound covered only ${(100 * linearizedCoverage).toFixed(2)}%`);
  assert.ok(linearizedUpper > monteCarlo.summary.positionRadius.confidence,
    "linearized 3-D upper bound fell below the seeded empirical 95% radius");
  assert.ok(linearizedUpper > 2 * oldUpper,
    "RTN Jacobian did not materially increase the adversarial GEO bound");
  assert.ok(oldCoverage < 0.85,
    `legacy identity bound unexpectedly covered ${(100 * oldCoverage).toFixed(2)}%`);
  assert.ok(oldUpper < 0.7 * monteCarlo.summary.positionRadius.confidence,
    "legacy identity bound no longer demonstrates the known underestimation");
  console.log("PASS  adversarial GEO RTN linearized 3-D Monte Carlo coverage");
  groups++;
}

// The 2-D Gaussian confidence contour uses the closed-form chi-square(2)
// quantile and principal eigenvectors.
{
  const covariance = diagonal([4, 1, 0, 0, 0, 0]);
  const ellipse = U.confidenceEllipse(covariance, [0, 1], 0.95);
  const scale = Math.sqrt(-2 * Math.log(0.05));
  near(ellipse.semiMajor, 2 * scale, 1e-12, "95% ellipse semi-major");
  near(ellipse.semiMinor, scale, 1e-12, "95% ellipse semi-minor");
  near(ellipse.angleRad, 0, 1e-14, "ellipse principal angle");
  console.log("PASS  confidence ellipse geometry");
  groups++;
}

// Expensive work must fail before invoking user models or allocating an
// unbounded output cloud.
{
  const covariance = diagonal([1, 1, 1, 1, 1, 1]);
  assert.throws(() => U.runMonteCarlo({ meanState: [0, 0, 0, 0, 0, 0], covariance,
    samples: U.MAX_MONTE_CARLO_SAMPLES + 1 }), (error) => error.code === "INVALID_ARGUMENT");
  assert.throws(() => U.runMonteCarlo({ meanState: [0, 0, 0, 0, 0, 0], covariance,
    samples: 100, maxModelEvaluations: 99, propagator: (state) => state }),
  (error) => error.code === "MAX_EVALUATIONS_EXCEEDED");
  assert.throws(() => U.numericalStateTransition({ state: [0, 0, 0, 0, 0, 0], dt: 1,
    maxEvaluations: 12, propagator: (state) => state }), (error) =>
    error.code === "INVALID_ARGUMENT");
  console.log("PASS  Monte Carlo and STM work caps");
  groups++;
}

console.log(`\n${groups}/${groups} uncertainty test groups clean`);
