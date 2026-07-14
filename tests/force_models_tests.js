/* Adaptive n-body / finite-thrust force-model regressions. Run with:
 *   node tests/force_models_tests.js */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

for (const file of ["constants.js", "kepler.js", "ode.js", "force-models.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "js", file), "utf8"),
    { filename: file });
}

const C = globalThis.AstroConst;
const A = globalThis.Astro;
const F = globalThis.MissionForceModels;

function near(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message}: ${actual} differs from ${expected} by ${Math.abs(actual - expected)}`);
}

function vectorError(left, right) {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

const epochJD = A.dateToJD(new Date("2026-01-01T00:00:00Z"));
let groups = 0;

// With the Sun as the sole (fixed-origin) point mass, adaptive n-body
// integration must reduce to the existing universal-variable solution.
{
  const r0 = [C.AU, 0, 0];
  const v0 = [0, Math.sqrt(C.BODIES.sun.mu / C.AU), 0];
  const duration = 37 * C.DAY;
  const expected = A.propagateUniversal(r0, v0, duration, C.BODIES.sun.mu);
  const result = F.propagate({
    epochJD, r0, v0, durationS: duration, bodies: ["sun"],
    rtol: 2e-11, atol: [1e-5, 1e-5, 1e-5, 1e-11, 1e-11, 1e-11],
    maxStep: 0.5 * C.DAY,
  });
  assert.strictEqual(result.status, "finished");
  assert.ok(vectorError(result.rFinal, expected.r) < 0.02,
    "adaptive two-body position diverged from universal propagation");
  assert.ok(vectorError(result.vFinal, expected.v) < 2e-9,
    "adaptive two-body velocity diverged from universal propagation");

  const initialEnergy = A.V.mag(v0) ** 2 / 2 - C.BODIES.sun.mu / A.V.mag(r0);
  const finalEnergy = A.V.mag(result.vFinal) ** 2 / 2 -
    C.BODIES.sun.mu / A.V.mag(result.rFinal);
  assert.ok(Math.abs((finalEnergy - initialEnergy) / initialEnergy) < 2e-10,
    "two-body specific-energy drift exceeded the bounded tolerance");
  console.log("PASS  adaptive two-body reduction and energy bound");
  groups++;
}

// Adding a moving point mass must produce a deterministic, non-zero third-body
// perturbation while sampling each body at the derivative epoch.
{
  const earth = F.bodyStateAt("earth", epochJD);
  const r0 = [earth.r[0] + 50000, earth.r[1], earth.r[2]];
  const localSpeed = Math.sqrt(C.BODIES.earth.mu / 50000);
  const v0 = [earth.v[0], earth.v[1] + localSpeed, earth.v[2]];
  const base = F.propagate({ epochJD, r0, v0, durationS: 2 * C.DAY,
    bodies: ["sun"], rtol: 1e-10, maxStep: 1800 });
  const perturbed = F.propagate({ epochJD, r0, v0, durationS: 2 * C.DAY,
    bodies: ["sun", "earth"], rtol: 1e-10, maxStep: 1800 });
  assert.ok(vectorError(base.rFinal, perturbed.rFinal) > 1000,
    "selected Earth point mass produced no material perturbation");
  const repeat = F.propagate({ epochJD, r0, v0, durationS: 2 * C.DAY,
    bodies: ["sun", "earth"], rtol: 1e-10, maxStep: 1800 });
  assert.deepStrictEqual(repeat.rFinal, perturbed.rFinal,
    "n-body propagation should be deterministic");
  console.log("PASS  selectable moving third-body perturbation");
  groups++;
}

// Conservative equations support round-trip propagation in either time
// direction. The epoch mapping remains fixed while t descends.
{
  const r0 = [0.72 * C.AU, 0.03 * C.AU, 0];
  const v0 = [-2, 34.5, 0.4];
  const duration = 5 * C.DAY;
  const forward = F.propagate({ epochJD, r0, v0, durationS: duration,
    bodies: ["sun"], rtol: 1e-11, maxStep: 7200 });
  const backward = F.propagate({ epochJD, t0S: duration, t1S: 0,
    r0: forward.rFinal, v0: forward.vFinal, bodies: ["sun"],
    rtol: 1e-11, maxStep: 7200 });
  assert.ok(vectorError(backward.rFinal, r0) < 0.01,
    "backward propagation did not recover the initial position");
  assert.ok(vectorError(backward.vFinal, v0) < 2e-9,
    "backward propagation did not recover the initial velocity");
  assert.ok(backward.samples.every((sample, index) => index === 0 ||
    sample.t <= backward.samples[index - 1].t), "backward samples are not descending");
  console.log("PASS  forward/backward inertial propagation");
  groups++;
}

// In force-free space, a constant fixed-direction burn has the Tsiolkovsky
// velocity change and the exact constant-flow propellant use.
{
  const mass0 = 1000;
  const thrustN = 1000;
  const ispS = 300;
  const duration = 100;
  const result = F.propagateFiniteThrust({
    epochJD, r0: [0, 0, 0], v0: [0, 0, 0], durationS: duration, bodies: [],
    massKg: mass0, outputStep: 10, rtol: 1e-11,
    atol: [1e-11, 1e-11, 1e-11, 1e-13, 1e-13, 1e-13, 1e-10],
    thrust: { thrustN, ispS, dryMassKg: 100, direction: "inertial", vector: [1, 0, 0] },
  });
  const expectedMass = mass0 - thrustN * duration / (ispS * F.G0_M_S2);
  const expectedDv = ispS * F.G0_M_S2 * Math.log(mass0 / expectedMass) / 1000;
  near(result.massFinalKg, expectedMass, 2e-8, "finite-burn final mass (kg)");
  near(result.propellantUsedKg, mass0 - expectedMass, 2e-8,
    "finite-burn propellant accounting (kg)");
  near(result.vFinal[0], expectedDv, 2e-11, "finite-burn rocket-equation delta-v (km/s)");
  near(result.vFinal[1], 0, 1e-14, "fixed-direction transverse velocity");
  assert.ok(result.samples.length >= 11 && result.samples.every((sample, index) =>
    index === 0 || sample.massKg <= result.samples[index - 1].massKg),
  "continuous burn samples did not preserve monotonic mass depletion");
  console.log("PASS  finite-thrust rocket equation and mass conservation");
  groups++;
}

// Dry mass is a hard cutoff rather than a numerical overshoot. Propagation
// continues ballistically with the final mass pinned exactly to the floor.
{
  const result = F.propagateFiniteThrust({
    epochJD, r0: [0, 0, 0], v0: [0, 0, 0], durationS: 1000, bodies: [], massKg: 100,
    outputStep: 25, thrust: { thrustN: 1000, ispS: 100, dryMassKg: 90,
      direction: "inertial-fixed", vector: [1, 0, 0] },
  });
  near(result.massFinalKg, 90, 1e-12, "dry-mass cutoff floor");
  assert.ok(result.dryMassReached, "dry-mass event was not reported");
  assert.strictEqual(result.status, "finished", "dry mass should not terminate the coast");
  assert.ok(result.events.some((event) => event.type === "dry-mass-cutoff"));
  assert.ok(result.samples.every((sample) => sample.massKg >= 90 - 1e-10),
    "a continuous sample crossed below dry mass");
  console.log("PASS  dry-mass cutoff and post-burn coast");
  groups++;
}

// A zero-thrust configuration must reduce bit-for-bit closely to the same
// gravity-only trajectory and leave mass untouched.
{
  const r0 = [C.AU, 12000, 500];
  const v0 = [-0.002, 29.8, 0.01];
  const duration = C.DAY;
  const coast = F.propagate({ epochJD, r0, v0, durationS: duration,
    bodies: ["sun"], rtol: 1e-11, maxStep: 1800 });
  const off = F.propagateFiniteThrust({ epochJD, r0, v0, durationS: duration,
    bodies: ["sun"], massKg: 800, rtol: 1e-11, maxStep: 1800,
    thrust: { thrustN: 0, direction: "prograde", dryMassKg: 500 },
  });
  assert.ok(vectorError(coast.rFinal, off.rFinal) < 1e-6,
    "thrust-off position did not reduce to gravity-only propagation");
  assert.ok(vectorError(coast.vFinal, off.vFinal) < 1e-12,
    "thrust-off velocity did not reduce to gravity-only propagation");
  near(off.massFinalKg, 800, 0, "thrust-off mass");
  console.log("PASS  thrust-off gravity reduction");
  groups++;
}

// A continuous prograde finite burn in low Earth orbit must grow the
// osculating apoapsis progressively, not teleport directly to its final path.
{
  const earth = F.bodyStateAt("earth", epochJD);
  const radius = C.BODIES.earth.radius + 400;
  const localR = [radius, 0, 0];
  const localV = [0, Math.sqrt(C.BODIES.earth.mu / radius), 0];
  const result = F.propagateFiniteThrust({
    epochJD,
    r0: A.V.add(earth.r, localR),
    v0: A.V.add(earth.v, localV),
    durationS: 360,
    bodies: ["sun", "earth"],
    massKg: 1200,
    outputStep: 20,
    maxStep: 5,
    rtol: 3e-10,
    thrust: { thrustN: 240, ispS: 320, dryMassKg: 800,
      direction: "prograde", relativeTo: "earth", startS: 0, endS: 300 },
  });
  const duringBurn = result.samples.filter((sample) => sample.t <= 300 + 1e-9);
  const apoapses = duringBurn.map((sample) => F.osculatingElementsRelative(sample, "earth").ra);
  for (let i = 1; i < apoapses.length; i++) {
    assert.ok(apoapses[i] >= apoapses[i - 1] - 0.02,
      `apoapsis decreased during prograde burn at sample ${i}: ${apoapses[i - 1]} -> ${apoapses[i]}`);
  }
  assert.ok(apoapses[apoapses.length - 1] - apoapses[0] > 150,
    "finite prograde burn did not visibly raise apoapsis");
  assert.ok(new Set(apoapses.map((value) => value.toFixed(3))).size > 10,
    "apoapsis path changed in too few discrete jumps");
  console.log("PASS  continuous monotonic apoapsis raise");
  groups++;
}

// Built-in SOI exit events are located against the moving body ephemeris and
// stop at the requested physical boundary.
{
  const earth = F.bodyStateAt("earth", epochJD);
  const initialDistance = C.BODIES.earth.soi - 1000;
  const result = F.propagate({
    epochJD,
    r0: [earth.r[0] + initialDistance, earth.r[1], earth.r[2]],
    v0: [earth.v[0] + 5, earth.v[1], earth.v[2]],
    durationS: 1000,
    bodies: ["sun", "earth"],
    maxStep: 5,
    rtol: 1e-11,
    atol: [1e-5, 1e-5, 1e-5, 1e-10, 1e-10, 1e-10],
    soiEvents: [{ body: "earth", crossing: "exit", terminal: true }],
  });
  assert.strictEqual(result.status, "event");
  assert.ok(result.events.some((event) => event.name === "soi:earth:exit"));
  const finalJD = epochJD + result.tFinal / C.DAY;
  const earthFinal = F.bodyStateAt("earth", finalJD).r;
  near(A.V.mag(A.V.sub(result.rFinal, earthFinal)), C.BODIES.earth.soi, 1e-3,
    "SOI terminal radius (km)");
  console.log("PASS  moving-body SOI terminal event");
  groups++;
}

console.log(`\n${groups}/${groups} force-model test groups clean`);
