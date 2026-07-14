/* Libration-family and ideal stationkeeping regressions. Run with:
 *   node tests/libration_tests.js */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

for (const file of ["constants.js", "cr3bp.js", "ode.js", "libration.js"])
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "js", file), "utf8"),
    { filename: file });

const R = globalThis.CR3BP;
const L = globalThis.Libration;
const EM = R.SYSTEMS.earthMoon;
const SE = R.SYSTEMS.sunEarth;

function near(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message}: ${actual} differs from ${expected} by ${Math.abs(actual - expected)}`);
}

function vectorNorm(values) {
  return Math.hypot(...values);
}

function assertPeriodic(orbit, family, message) {
  assert.strictEqual(orbit.periodicClaim, true, `${message} lost its periodic claim`);
  assert.strictEqual(orbit.family, family, `${message} has the wrong family label`);
  assert.match(orbit.correctionMethod, /STM.*crossing-time sensitivity/i,
    `${message} does not identify its differential-correction method`);
  assert.ok(orbit.period > 0 && orbit.halfPeriod > 0, `${message} has no physical period`);
  assert.ok(orbit.closureError < 2e-7,
    `${message} closure error ${orbit.closureError} is too large`);
  assert.ok(orbit.jacobiDrift < 2e-9,
    `${message} Jacobi drift ${orbit.jacobiDrift} is too large`);
  assert.ok(orbit.correctionResidual < 2e-8,
    `${message} shooting residual ${orbit.correctionResidual} is too large`);
  assert.match(orbit.warning, /unstable.*stationkeeping/i,
    `${message} lost its stability warning`);
}

// The two primary-side planar families must close under independent full-
// period propagation, not merely by mirroring a half-orbit sample set.
const planarL1 = L.generatePlanarLyapunov(EM, "L1", { size: "small", sampleCount: 91 });
const planarL2 = L.generatePlanarLyapunov(EM, "L2", { size: "medium", sampleCount: 91 });
assertPeriodic(planarL1, "planar-lyapunov", "Earth–Moon L1 planar Lyapunov");
assertPeriodic(planarL2, "planar-lyapunov", "Earth–Moon L2 planar Lyapunov");
assert.ok(planarL1.states.every((state) => Math.abs(state[2]) < 1e-14 &&
  Math.abs(state[5]) < 1e-14), "planar Lyapunov orbit acquired an out-of-plane state");
console.log("PASS  L1/L2 differential-corrected planar Lyapunov closure");

// Check the event-time component of the STM sensitivity against independent
// finite differences of the actual y=0 crossing. A fixed-time STM alone does
// not satisfy this derivative.
{
  const nominal = L.symmetryCrossing(EM, planarL1.initialState);
  const h = 2e-7;
  const plus = planarL1.initialState.slice(), minus = planarL1.initialState.slice();
  plus[4] += h;
  minus[4] -= h;
  const fp = L.symmetryCrossing(EM, plus).state[3];
  const fm = L.symmetryCrossing(EM, minus).state[3];
  const finiteDifference = (fp - fm) / (2 * h);
  const analytic = nominal.sensitivity(3, 4);
  near(analytic, finiteDifference, 3e-5,
    "y=0 crossing-time sensitivity d(vx_f)/d(vy_0)");
}
console.log("PASS  STM crossing-time sensitivity");

// A family request must produce distinct corrected small/medium 3-D halo
// members. L2 and Sun–Earth L1 exercise both collinear points and both reviewed
// systems without relying on hard-coded initial states.
const haloL1 = L.generateHaloFamily(EM, "L1", { sampleCount: 91 });
const haloL2 = L.generateHalo(EM, "L2", { size: "small", sampleCount: 91 });
const haloSEL1 = L.generateHalo(SE, "L1", { size: "small", sampleCount: 61 });
for (const [orbit, label] of [
  [haloL1.small, "Earth–Moon L1 small halo"],
  [haloL1.medium, "Earth–Moon L1 medium halo"],
  [haloL2, "Earth–Moon L2 small halo"],
  [haloSEL1, "Sun–Earth L1 small halo"],
]) {
  assertPeriodic(orbit, "halo", label);
  assert.ok(Math.abs(orbit.initialState[2]) > 0, `${label} is not three-dimensional`);
  near(orbit.initialState[1], 0, 0, `${label} initial y symmetry`);
  near(orbit.initialState[3], 0, 0, `${label} initial vx symmetry`);
  near(orbit.initialState[5], 0, 0, `${label} initial vz symmetry`);
}
assert.ok(haloL1.medium.zAmplitude > haloL1.small.zAmplitude,
  "medium halo member is not larger than the small member");
assert.ok(Math.abs(L.haloBifurcation(EM, "L1").verticalCriticalResidual) < 2e-8,
  "L1 vertical-critical planar orbit was not actually corrected");
assert.ok(Math.abs(L.haloBifurcation(EM, "L2").verticalCriticalResidual) < 2e-8,
  "L2 vertical-critical planar orbit was not actually corrected");
console.log("PASS  small/medium L1/L2 three-dimensional halo families");

// The default warm start must remain the same member produced by the full
// continuation solver; it is a performance cache, not a different orbit.
{
  const warm = L.haloBifurcation(EM, "L1");
  const solved = L.haloBifurcation(EM, "L1", { noCache: true });
  assert.strictEqual(warm.reviewedWarmStart, true,
    "the reviewed Earth-Moon L1 continuation warm start was not used");
  near(warm.amplitudeFraction, solved.amplitudeFraction, 2e-10,
    "warm-start bifurcation amplitude");
  near(warm.halfPeriod, solved.halfPeriod, 2e-8,
    "warm-start bifurcation half-period");
  for (let index = 0; index < warm.state.length; index++)
    near(warm.state[index], solved.state[index], 2e-9,
      `warm-start bifurcation state ${index}`);
}
console.log("PASS  reviewed bifurcation warm start matches full continuation");

// Lissajous is a bounded linear center-mode construction. It must never be
// presented as a nonlinear periodic solution merely because the samples look
// closed over a short interval.
{
  const seed = L.generateLissajousSeed(EM, "L1", {
    planarAmplitude: 0.004,
    verticalAmplitude: 0.006,
    duration: 20,
    sampleCount: 401,
  });
  assert.strictEqual(seed.type, "bounded-linear-seed");
  assert.strictEqual(seed.periodicClaim, false);
  assert.strictEqual(seed.boundedByConstruction, true);
  assert.match(seed.warning, /not a differential-corrected periodic orbit/i);
  const equilibriumX = R.equilibriumPoint(EM, "L1").x;
  const maxX = Math.max(...seed.states.map((state) => Math.abs(state[0] - equilibriumX)));
  const maxZ = Math.max(...seed.states.map((state) => Math.abs(state[2])));
  assert.ok(maxX <= seed.planarAmplitude * (1 + 2e-13),
    "linear Lissajous x amplitude escaped its bound");
  assert.ok(maxZ <= seed.verticalAmplitude * (1 + 2e-13),
    "linear Lissajous z amplitude escaped its bound");
  assert.ok(seed.states.every((state) => state.every(Number.isFinite)),
    "linear Lissajous seed contains a non-finite state");
}
console.log("PASS  bounded, explicitly non-periodic Lissajous seed");

// Every family/system/point/size combination exposed by the Planner must be a
// reviewed working option. Medium Lissajous must also be materially larger.
for (const system of [EM, SE]) {
  for (const point of ["L1", "L2"]) {
    for (const size of ["small", "medium"]) {
      assertPeriodic(L.generatePlanarLyapunov(system, point,
        { size, sampleCount: 31 }), "planar-lyapunov",
      `${system.name} ${point} ${size} planar option`);
      assertPeriodic(L.generateHalo(system, point,
        { size, sampleCount: 31 }), "halo",
      `${system.name} ${point} ${size} halo option`);
    }
    const smallSeed = L.generateLissajousSeed(system, point,
      { size: "small", sampleCount: 31 });
    const mediumSeed = L.generateLissajousSeed(system, point,
      { size: "medium", sampleCount: 31 });
    assert.ok(mediumSeed.planarAmplitude > smallSeed.planarAmplitude &&
      mediumSeed.verticalAmplitude > smallSeed.verticalAmplitude,
    `${system.name} ${point} Lissajous size selector had no effect`);
  }
}
console.log("PASS  full selectable libration option matrix");

// With identical initial conditions, deterministic propagation must remain
// bit-for-bit identical and issue no fictitious maintenance burns.
const zeroMaintenance = L.simulateStationkeeping(EM, planarL1, {
  duration: planarL1.period,
  correctionInterval: planarL1.period / 8,
});
assert.strictEqual(zeroMaintenance.burnCount, 0,
  "zero tracking error generated a stationkeeping burn");
assert.strictEqual(zeroMaintenance.totalDv, 0,
  "zero tracking error accumulated delta-v");
assert.deepStrictEqual(zeroMaintenance.finalTrackedState,
  zeroMaintenance.finalReferenceState,
  "zero-offset tracked and reference states diverged numerically");
console.log("PASS  zero-offset stationkeeping produces zero burns");

// Offset tracking is deterministic and obeys both per-burn and work caps.
{
  const options = {
    duration: 2 * planarL1.period,
    correctionInterval: planarL1.period / 10,
    initialOffset: [2e-6, -1e-6, 0.5e-6, 0, 0, 0],
    maxBurn: 2e-6,
    maxBurns: 3,
  };
  const first = L.simulateStationkeeping(EM, planarL1, options);
  const repeat = L.simulateStationkeeping(EM, planarL1, options);
  assert.deepStrictEqual(repeat, first,
    "identical stationkeeping inputs did not reproduce identical outputs");
  assert.strictEqual(first.burnCount, options.maxBurns,
    "stationkeeping burn-count cap was not exercised exactly");
  assert.strictEqual(first.capped, true,
    "tracker did not report that later corrections were capped");
  assert.ok(first.burns.every((burn) => burn.magnitude <= options.maxBurn * (1 + 1e-14)),
    "a stationkeeping burn exceeded maxBurn");
  near(first.totalDv, first.burns.reduce((sum, burn) => sum + burn.magnitude, 0),
    1e-18, "stationkeeping total delta-v bookkeeping");
  assert.ok(vectorNorm(first.initialOffset) > 0 && first.totalDv > 0,
    "nonzero deterministic offset did not exercise the tracker");
}
console.log("PASS  deterministic stationkeeping reproduction and caps");

assert.throws(() => L.simulateStationkeeping(EM, planarL1, {
  duration: 100 * planarL1.period,
  correctionInterval: planarL1.period / 100,
}), /1,000 correction epochs/,
"stationkeeping work-product cap did not reject a browser-freezing request");
console.log("PASS  stationkeeping correction-epoch work cap");

console.log("\n9/9 libration test groups clean");
