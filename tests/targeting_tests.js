/* Tangent-periapsis targeting regressions. Run with:
 *   node tests/targeting_tests.js */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

for (const file of ["constants.js", "kepler.js", "targeting.js", "ode.js",
  "cr3bp.js", "libration.js", "windows.js", "analysis.js", "force-models.js",
  "propagator.js", "missions.js"])
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "js", file), "utf8"),
    { filename: file });

const C = globalThis.AstroConst;
const A = globalThis.Astro;
const T = globalThis.MissionTargeting;
const ME = globalThis.MissionEngine;
const MS = globalThis.Missions;

function near(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message}: ${actual} differs from ${expected} by ${Math.abs(actual - expected)}`);
}

// Reproduce Apollo 11's second return-targeting state from the event's exact
// pre-burn endpoint. The former solver put its Lambert endpoint on the 40-km
// radius circle but arrived with radial velocity, yielding a 2,500+ km error
// in true osculating periapsis.
const mission = MS.getPreset("apollo11");
const result = ME.recompute(mission);
const correction = result.events.find((event) =>
  event.kind === "burn" && event.label.includes("Return targeting"));
assert.ok(correction && correction._burn, "Apollo return correction event is missing");
const segment = mission.segments[correction.seg];
const rpTarget = C.BODIES.earth.radius + segment.periKm;
const solved = T.solveLambertToPeriapsis({
  r1: correction._burn.r,
  vCurrent: correction._burn.v0,
  tof: segment.tofDays * C.DAY,
  mu: C.BODIES.earth.mu,
  rpTarget,
});
assert.ok(solved.best, "Apollo tangent-periapsis targeter found no solution");
near(solved.best.rpAchieved, rpTarget, 1e-3,
  "Apollo achieved periapsis radius");
near(solved.best.radialSpeed, 0, 1e-9,
  "Apollo arrival radial speed");
assert.ok(solved.best.dv < 1,
  `Apollo correction delta-v is implausibly large (${solved.best.dv} km/s)`);
const justBefore = A.propagateUniversal(solved.best.r2, solved.best.v2, -10,
  C.BODIES.earth.mu);
assert.ok(A.V.dot(justBefore.r, justBefore.v) < 0,
  "targeted endpoint is not approached inbound");
console.log("PASS  Apollo tangent-periapsis targeting");

// Both Lambert orientations are searched, but duplicate roots at the 0/2π
// seam must not appear twice or destabilize the minimum-delta-v choice.
assert.ok(solved.candidates.length >= 1 && solved.candidates.length <= 8,
  `unexpected candidate count ${solved.candidates.length}`);
for (let i = 1; i < solved.candidates.length; i++)
  assert.ok(solved.candidates[i].dv >= solved.candidates[i - 1].dv,
    "periapsis candidates are not sorted by departure delta-v");
console.log("PASS  bounded branch search and deterministic ranking");

// GMAT-style insertion Vary/Achieve: raise the opposite apsis from a circular
// 300-km parking state to GEO radius. The applied vector and achieved conic
// must be the same solution, not separate scalar bookkeeping estimates.
const earth = C.BODIES.earth;
const parkingRadius = earth.radius + 300;
const parkingSpeed = Math.sqrt(earth.mu / parkingRadius);
const insertion = T.solveInsertionImpulse({
  r: [parkingRadius, 0, 0],
  v: [0, parkingSpeed, 0],
  mu: earth.mu,
  at: "periapsis",
  goal: "opposite-apsis",
  target: 42164,
});
assert.strictEqual(insertion.converged, true, insertion.report.status);
near(insertion.achievedOppositeRadius, 42164, 1e-3,
  "targeted opposite apsis");
near(A.V.mag(insertion.dvVec), insertion.dv, 1e-12,
  "insertion applied-vector magnitude");
assert.ok(insertion.report.iterations <= 80 && Math.abs(insertion.report.residual) < 1e-5);
console.log("PASS  insertion opposite-apsis Vary/Achieve");

const targetPeriod = 12 * 3600;
const periodTarget = T.solveInsertionImpulse({
  r: [parkingRadius, 0, 0],
  v: [0, parkingSpeed, 0],
  mu: earth.mu,
  at: "periapsis",
  goal: "period",
  target: targetPeriod,
});
assert.strictEqual(periodTarget.converged, true, periodTarget.report.status);
near(periodTarget.achievedPeriod, targetPeriod, 1e-4,
  "targeted orbital period");
console.log("PASS  insertion-period Vary/Achieve");

const targetedMission = {
  name: "Targeted insertion regression",
  epoch: "2026-01-01T00:00:00Z",
  segments: [
    { type: "launch", body: "earth", site: "", ascent: "direct",
      altKm: 300, incDeg: 28.5, raanDeg: 0 },
    { type: "insertion", at: "periapsis", shape: "elliptical", apoKm: 10000,
      targetMode: "period", targetValue: 12, maxDays: 1 },
  ],
};
const targetedResult = ME.recompute(targetedMission);
assert.deepStrictEqual(targetedMission.segments.flatMap((segment) => segment._warn), []);
near(targetedMission.segments[1]._info.targetAchieved, 12, 1e-8,
  "Planner targeted insertion period");
const targetedBurn = targetedResult.events.find((event) => event.kind === "burn" &&
  event.label.includes("targeted"));
assert.ok(targetedBurn && Math.abs(targetedBurn.dv -
  targetedMission.segments[1]._info.dv) < 1e-12,
  "Planner target report and applied burn differ");
console.log("PASS  Planner insertion Target integration");

// Transfer-card Vary/Achieve uses the same bounded aim-point solve as the
// applied Lambert burn. Departure date and TOF are staged in the Windows
// pane; the segment then reports the achieved periapsis and residual.
const transferMission = MS.getPreset("apollo11");
const transferSegment = transferMission.segments.find((segment) =>
  segment.type === "transfer");
transferSegment.targetMode = "arrival-periapsis";
transferSegment.targetValue = 110;
ME.recompute(transferMission);
assert.deepStrictEqual(transferMission.segments.flatMap((segment) => segment._warn), []);
assert.strictEqual(transferSegment._info.targetStatus, "converged");
near(transferSegment._info.targetAchieved, 110, 1,
  "Planner targeted transfer periapsis altitude");
assert.ok(transferSegment._info.targetIterations <= 26 &&
  Math.abs(transferSegment._info.targetResidual) <= 1,
  "Planner transfer target did not report bounded convergence");
console.log("PASS  Planner transfer Target integration");

// Transfer-window Vary/Achieve must move both independent variables through
// the downstream evaluator, remain inside explicit bounds, and stop on the
// requested periapsis tolerance. This analytic surface has a nonzero
// derivative in both date and TOF, exercising the coupled update directly.
const joint = T.solveTransferDateTof({
  target: 150,
  departureBoundsJD: [9, 13],
  tofBoundsDays: [3, 9],
  initialDepartureJD: 10,
  initialTofDays: 5,
  toleranceKm: 1e-7,
  maxEvaluations: 160,
  evaluate: ({ departureJD, tofDays }) => ({
    achieved: 100 + 12 * (departureJD - 10) + 4 * (tofDays - 5),
  }),
});
assert.strictEqual(joint.converged, true, joint.status);
near(joint.achieved, 150, 1e-7, "joint date/TOF achieved periapsis");
assert.ok(joint.variedDeparture && joint.variedTof,
  "joint solver did not vary both departure date and TOF");
assert.ok(joint.departureJD >= 9 && joint.departureJD <= 13 &&
  joint.tofDays >= 3 && joint.tofDays <= 9 && joint.evaluations <= 160,
"joint solver escaped a configured bound or evaluation cap");
console.log("PASS  bounded joint Transfer date/TOF Vary/Achieve");

const windowSeed = globalThis.MissionWindows.evaluateCell({
  from: "earth", to: "mars", departureDate: "2005-08-10T00:00:00Z", tofDays: 196,
});
const mars = C.BODIES.mars;
const fixedImpact = T.hyperbolicImpactParameter(mars.radius + 1000,
  windowSeed.arrivalVInfinity, mars.mu);
const physicalJoint = T.solveTransferDateTof({
  target: 300,
  departureBoundsJD: [A.dateToJD("2005-06-01T00:00:00Z"),
    A.dateToJD("2005-11-28T00:00:00Z")],
  tofBoundsDays: [120, 360],
  initialDepartureJD: windowSeed.departureJD,
  initialTofDays: windowSeed.tofDays,
  toleranceKm: 1,
  maxEvaluations: 240,
  evaluate: ({ departureJD, tofDays }) => {
    const cell = globalThis.MissionWindows.evaluateCell({ from: "earth", to: "mars",
      departureJD, tofDays });
    return { valid: cell.valid, achieved: cell.valid
      ? T.hyperbolicPeriapsisFromImpact(fixedImpact, cell.arrivalVInfinity, mars.mu) -
        mars.radius : NaN };
  },
});
assert.strictEqual(physicalJoint.converged, true, physicalJoint.status);
near(physicalJoint.achieved, 300, 1, "Earth-Mars joint window periapsis");
assert.ok(physicalJoint.variedDeparture && physicalJoint.variedTof &&
  physicalJoint.evaluations <= 240,
"Earth-Mars target did not genuinely vary both bounded window variables");
console.log("PASS  physical Earth-Mars joint window target");

const impactRp = earth.radius + 300;
const impact = T.hyperbolicImpactParameter(impactRp, 4.25, earth.mu);
near(T.hyperbolicPeriapsisFromImpact(impact, 4.25, earth.mu), impactRp, 1e-9,
  "hyperbolic B-plane impact/periapsis round trip");
const impossibleJoint = T.solveTransferDateTof({
  target: 10, departureBoundsJD: [0, 1], tofBoundsDays: [1, 2],
  maxIterations: 4, maxEvaluations: 20,
  evaluate: () => ({ achieved: 100 }),
});
assert.strictEqual(impossibleJoint.converged, false);
assert.ok(["bounds-exhausted", "evaluation-limit", "iteration-limit"].includes(
  impossibleJoint.status));
console.log("PASS  joint Transfer failure and hyperbolic B-plane report");

const unbracketed = T.solveBoundedScalar((x) => x * x + 1, -1, 1);
assert.strictEqual(unbracketed.converged, false);
assert.strictEqual(unbracketed.status, "unbracketed");
console.log("PASS  bounded targeting failure report");

console.log("\n10/10 targeting test groups clean");
