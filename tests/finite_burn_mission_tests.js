/* Planner integration tests for adaptive n-body coasts and real finite burns.
 * Run with: node tests/finite_burn_mission_tests.js */
"use strict";

const assert = require("assert");
const { C, A, ME } = require("./harness.js");

function clean(mission) {
  const result = ME.recompute(mission);
  const warnings = mission.segments.flatMap((segment) => segment._warn || []);
  assert.deepStrictEqual(warnings, []);
  return result;
}

const finiteMission = {
  name: "Finite burn regression",
  epoch: "2026-07-13T00:00:00Z",
  spacecraft: { name: "Finite burn demonstrator", dryKg: 1000, propKg: 500,
    isp: 320, fovDeg: 50 },
  segments: [
    { type: "launch", body: "earth", site: "", ascent: "direct",
      altKm: 300, incDeg: 28.5, raanDeg: 0 },
    { type: "finite_burn", durationMin: 10, thrustN: 2000, ispS: 320,
      direction: "prograde", dirX: 1, dirY: 0, dirZ: 0,
      massKg: "", gravity: "nbody" },
    { type: "coast", days: 0.02, mode: "adaptive-nbody" },
  ],
};
const finiteResult = clean(finiteMission);
const burnSegment = finiteMission.segments[1];
const burnSamples = finiteResult.samples.filter((sample) => sample.seg === 1);
assert.ok(burnSamples.length >= 150, "finite burn arc is not visibly sampled");
assert.ok(burnSamples.every((sample) => sample.forceModel === "finite-thrust-nbody"));
let previousApo = -Infinity;
for (const sample of burnSamples) {
  const coe = A.rvToCoe(sample.r, sample.v, C.BODIES.earth.mu);
  assert.ok(coe.ra >= previousApo - 0.02,
    `apoapsis regressed during prograde burn (${coe.ra} after ${previousApo})`);
  previousApo = coe.ra;
}
assert.ok(burnSegment._info.apoEnd > burnSegment._info.apoStart + 1000,
  "finite burn did not materially raise apoapsis");
assert.ok(burnSegment._info.massEndKg < burnSegment._info.massStartKg);
assert.ok(Math.abs(finiteResult.totalDv - burnSegment._info.dv) < 1e-12);
assert.ok(finiteResult.events.some((event) => event.kind === "burn" && event.finite) &&
  finiteResult.events.some((event) => event.kind === "burn_end" && event.finite));
const mid = ME.sampleAtTime(finiteResult,
  0.5 * (burnSegment._t0 + burnSegment._t1));
assert.strictEqual(mid.forceModel, "finite-thrust-nbody");
assert.ok(mid.massKg < burnSegment._info.massStartKg &&
  mid.massKg > burnSegment._info.massEndKg);
const postBurnCoast = finiteResult.samples.filter((sample) => sample.seg === 2);
assert.ok(postBurnCoast.length >= 150 && postBurnCoast.every((sample) =>
  Number.isFinite(sample.massKg) &&
  Math.abs(sample.massKg - burnSegment._info.massEndKg) < 1e-9),
"thrust-off adaptive coast did not preserve post-burn mass");
const coastMid = ME.sampleAtTime(finiteResult,
  0.5 * (finiteMission.segments[2]._t0 + finiteMission.segments[2]._t1));
assert.ok(Number.isFinite(coastMid.massKg) &&
  Math.abs(coastMid.massKg - burnSegment._info.massEndKg) < 1e-9,
"post-burn coast interpolation corrupted spacecraft mass");
console.log("PASS  Planner finite burn raises apoapsis continuously");

const nbodyMission = {
  name: "Adaptive n-body coast regression",
  epoch: "2026-07-13T00:00:00Z",
  spacecraft: { name: "Coast", dryKg: 1000, propKg: "", isp: 320 },
  segments: [
    { type: "launch", body: "earth", site: "", ascent: "direct",
      altKm: 1000, incDeg: 28.5, raanDeg: 0 },
    { type: "coast", days: 0.1, mode: "adaptive-nbody" },
  ],
};
const nbodyResult = clean(nbodyMission);
const nbodySamples = nbodyResult.samples.filter((sample) => sample.seg === 1);
assert.ok(nbodySamples.length >= 150);
assert.ok(nbodySamples.every((sample) => sample.forceModel === "adaptive-nbody"));
assert.ok(nbodyMission.segments[1]._info.forceBodies.includes("earth") &&
  nbodyMission.segments[1]._info.forceBodies.includes("moon") &&
  nbodyMission.segments[1]._info.forceBodies.includes("sun"));
console.log("PASS  Planner selectable adaptive n-body coast");

const denseMission = JSON.parse(JSON.stringify(nbodyMission));
denseMission.name = "One-day adaptive interpolation regression";
denseMission.segments[0].altKm = 700;
denseMission.segments[0].incDeg = 98.19;
denseMission.segments[1].days = 1;
const denseResult = clean(denseMission);
assert.ok(denseResult.samples.filter((sample) => sample.seg === 1).length > 900,
  "bound n-body coast was not sampled by local orbital period");
let denseMinAltitude = Infinity, denseMaxAltitude = -Infinity;
for (let time = denseMission.segments[1]._t0;
  time <= denseMission.segments[1]._t1; time += 300) {
  const sample = ME.sampleAtTime(denseResult, time);
  const altitude = A.V.mag(sample.r) - C.BODIES.earth.radius;
  denseMinAltitude = Math.min(denseMinAltitude, altitude);
  denseMaxAltitude = Math.max(denseMaxAltitude, altitude);
}
assert.ok(denseMinAltitude > 690 && denseMaxAltitude < 710,
  `adaptive interpolation invented a false altitude swing (${denseMinAltitude} to ${denseMaxAltitude} km)`);
const overlongMission = JSON.parse(JSON.stringify(denseMission));
overlongMission.name = "Overlong local n-body guard";
overlongMission.segments[1].days = 30;
ME.recompute(overlongMission);
assert.ok(overlongMission.segments[1]._warn.some((warning) =>
  warning.level === "error" && warning.msg.includes("too many local revolutions")),
"overlong bound n-body coast did not fail fast with a bounded-display explanation");
console.log("PASS  adaptive n-body sampling and long-arc guard remain physical");

function escapeNbodyMission(days) {
  return {
    name: `Hyperbolic adaptive sampling ${days} d`,
    epoch: "2026-07-13T00:00:00Z",
    spacecraft: { name: "Escape", dryKg: 1000, propKg: "", isp: 320 },
    segments: [
      { type: "launch", body: "earth", site: "", ascent: "direct",
        altKm: 300, incDeg: 28.5, raanDeg: 0 },
      { type: "impulse", frame: "vnb", dv1: 4, dv2: 0, dv3: 0 },
      { type: "coast", days, mode: "adaptive-nbody" },
    ],
  };
}
const longEscapeMission = escapeNbodyMission(3);
const longEscape = clean(longEscapeMission);
const referenceEscape = clean(escapeNbodyMission(0.1));
assert.ok(longEscape.samples.filter((sample) => sample.seg === 2).length > 3000,
  "hyperbolic n-body coast fell back to a sparse duration-only output grid");
let maxEscapePositionError = 0, maxEscapeVelocityError = 0;
for (let time = longEscapeMission.segments[2]._t0;
  time <= referenceEscape.tEnd; time += 120) {
  const actual = ME.sampleAtTime(longEscape, time);
  const expected = ME.sampleAtTime(referenceEscape, time);
  maxEscapePositionError = Math.max(maxEscapePositionError,
    A.V.mag(A.V.sub(actual.w, expected.w)));
  maxEscapeVelocityError = Math.max(maxEscapeVelocityError,
    A.V.mag(A.V.sub(actual.worldV, expected.worldV)));
}
assert.ok(maxEscapePositionError < 0.01 && maxEscapeVelocityError < 0.0003,
  `hyperbolic output alias remained (${maxEscapePositionError} km, ${maxEscapeVelocityError} km/s)`);
console.log("PASS  hyperbolic adaptive coast uses a local dynamical timescale");

const centralMission = {
  name: "Central-relative finite-thrust reduction",
  epoch: "2026-07-13T00:00:00Z",
  spacecraft: { name: "Central", dryKg: 1000, propKg: 500, isp: 1e9 },
  segments: [
    { type: "launch", body: "earth", site: "", ascent: "direct",
      altKm: 700, incDeg: 98.19, raanDeg: 0 },
    { type: "finite_burn", durationMin: 60, thrustN: 1e-6, ispS: 1e9,
      direction: "inertial", dirX: 1, dirY: 0, dirZ: 0,
      massKg: "", gravity: "central-relative" },
  ],
};
const centralResult = clean(centralMission);
const centralSegment = centralMission.segments[1];
const startCandidates = centralResult.samples.filter((sample) =>
  sample.t <= centralSegment._t0 + 1e-9);
const centralStart = startCandidates[startCandidates.length - 1];
const centralEnd = centralResult.samples[centralResult.samples.length - 1];
const centralExpected = A.propagateUniversal(centralStart.r, centralStart.v,
  3600, C.BODIES.earth.mu);
assert.ok(A.V.mag(A.V.sub(centralEnd.r, centralExpected.r)) < 0.01 &&
  A.V.mag(A.V.sub(centralEnd.v, centralExpected.v)) < 1e-5,
"central-relative force model did not reduce to local two-body dynamics");
assert.strictEqual(centralEnd.forceModel, "finite-thrust-central-relative");
console.log("PASS  central-relative finite-thrust frame follows its body");

// An impulsive burn between two adaptive arcs must update the inertial cache
// as well as the central-body-relative velocity. Otherwise the second arc
// silently restarts from the pre-burn world velocity and discards the burn.
function impulseBridgeMission(withBurn) {
  const segments = [
    { type: "launch", body: "earth", site: "", ascent: "direct",
      altKm: 1000, incDeg: 28.5, raanDeg: 0 },
    { type: "coast", days: 0.05, mode: "adaptive-nbody" },
  ];
  if (withBurn)
    segments.push({ type: "impulse", frame: "vnb", dv1: 0.1, dv2: 0, dv3: 0 });
  segments.push({ type: "coast", days: 0.05, mode: "adaptive-nbody" });
  return {
    name: withBurn ? "Adaptive impulse bridge" : "Adaptive no-burn control",
    epoch: "2026-07-13T00:00:00Z",
    spacecraft: { name: "Bridge", dryKg: 1000, propKg: "", isp: 320 },
    segments,
  };
}
const bridgeMission = impulseBridgeMission(true);
const bridgeResult = clean(bridgeMission);
const controlResult = clean(impulseBridgeMission(false));
const burnSample = bridgeResult.samples.find((sample) => sample.seg === 2 &&
  sample.forceModel === "adaptive-nbody");
assert.ok(burnSample && burnSample.worldV, "adaptive impulse sample lost its inertial state");
const burnJd = bridgeResult.epochJD + burnSample.t / C.DAY;
const coherentWorldV = A.V.add(A.bodyWorldVel(burnSample.cen, burnJd), burnSample.v);
assert.ok(A.V.mag(A.V.sub(coherentWorldV, burnSample.worldV)) < 1e-10,
  "post-impulse local and inertial velocities diverged");
const bridgeEnd = bridgeResult.samples[bridgeResult.samples.length - 1];
const controlEnd = controlResult.samples[controlResult.samples.length - 1];
assert.ok(A.V.mag(A.V.sub(bridgeEnd.w, controlEnd.w)) > 100,
  "adaptive coast discarded the preceding impulse position effect");
assert.ok(A.V.mag(A.V.sub(bridgeEnd.worldV, controlEnd.worldV)) > 0.05,
  "adaptive coast discarded the preceding impulse velocity effect");
console.log("PASS  impulse remains coherent across adaptive n-body arcs");

console.log("\n6/6 Planner force-model groups clean");
