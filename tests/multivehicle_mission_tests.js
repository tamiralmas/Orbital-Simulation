/* Native multi-vehicle mission propagation regressions.
 * Run with: node tests/multivehicle_mission_tests.js */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { C, A, ME, MS, runMission } = require("./harness.js");
vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "js", "scriptgen.js"),
  "utf8"), { filename: "scriptgen.js" });

const spacecraft = (name, dryKg = 1000, propKg = 200) => ({
  name, dryKg, propKg, isp: 320, fovDeg: 50,
});
const launch = (incDeg = 28.5) => ({
  type: "launch", body: "earth", site: "", ascent: "direct",
  altKm: 400, incDeg, raanDeg: 0, targetPlane: "", planeTofDays: 0,
});
const coast = (days) => ({ type: "coast", days, mode: "kepler" });
const separate = (fromVehicle = "primary", dv1 = 0) => ({
  type: "separate", fromVehicle, afterSegment: 1, delayMin: 0,
  frame: "vnb", dv1, dv2: 0, dv3: 0,
});
const rendezvous = (tofHours, direction = "auto", maxDvKms = 1) => ({
  type: "rendezvous", targetVehicle: "primary", tofHours, direction,
  maxDvKms, terminalRangeKm: 0.001,
});
const mission = (name, segments, vehicles) => ({
  name, epoch: "2026-07-13T00:00:00Z",
  spacecraft: spacecraft("Target", 1000, 200),
  segments, vehicles,
});
const vectorError = (left, right) => A.V.mag(A.V.sub(left, right));
const errorWarnings = (segment) => (segment._warn || []).filter((warning) =>
  warning.level === "error");

{
  const transfer = rendezvous(6, "auto", 0.2);
  const plan = mission("Six-hour rendezvous", [launch(), coast(0.5)], [{
    id: "chaser", name: "Chaser", color: "#52d4c5",
    spacecraft: spacecraft("Chaser", 100, 50),
    segments: [separate(), transfer],
  }]);
  const { r, errs } = runMission(plan);
  assert.deepStrictEqual(errs, []);
  const chaser = r.vehicleResults.chaser;
  assert.ok(transfer._info.phasingWaitS > 4 * 3600,
    "long rendezvous did not use a passive phasing coast");
  assert.ok(transfer._info.transferTofS < transfer._info.requestedTofS);
  assert.ok(transfer._info.dv < 0.1,
    `six-hour co-orbital rendezvous cost ${transfer._info.dv} km/s`);
  assert.ok(chaser.events.some((event) => event.kind === "rendezvous_wait"));
  const complete = chaser.events.find((event) => event.kind === "rendezvous");
  assert.ok(complete && complete.rangeKm <= 1e-6,
    "six-hour rendezvous did not meet the target state");
  console.log("PASS  six-hour rendezvous remains low-dv and deterministic");
}

for (const [label, inclination, expectedSign] of [
  ["positive normal", 28.5, 1],
  ["negative normal", 151.5, -1],
]) {
  const transfer = rendezvous(0.5, "prograde", 0.2);
  const plan = mission("Local prograde " + label, [launch(inclination), coast(0.2)], [{
    id: "chaser", name: "Chaser", color: "#52d4c5",
    spacecraft: spacecraft("Chaser", 100, 50),
    segments: [separate(), transfer],
  }]);
  const { r, errs } = runMission(plan);
  assert.deepStrictEqual(errs, []);
  const target = r.vehicleResults.primary;
  const source = ME.sampleAtTime(target, plan.segments[0]._t1);
  const hz = A.V.cross(source.r, source.v)[2];
  assert.ok(expectedSign * hz > 0, `${label} fixture has the wrong h.z sign`);
  assert.strictEqual(transfer._info.direction, "prograde");
  assert.ok(transfer._info.dv < 0.1,
    `${label} local-prograde rendezvous selected a high-energy branch`);
}
console.log("PASS  rendezvous direction is local to either orbital normal");

{
  const transfer = rendezvous(6, "auto", 0.001);
  const plan = mission("Transactional rendezvous rejection", [launch(), coast(0.5)], [{
    id: "chaser", name: "Chaser", color: "#52d4c5",
    spacecraft: spacecraft("Chaser", 100, 50),
    segments: [separate("primary", 0.02), transfer],
  }]);
  const r = ME.recompute(plan);
  const chaser = r.vehicleResults.chaser;
  assert.ok(errorWarnings(transfer).some((warning) => /above.*limit/i.test(warning.msg)),
    "max-dv rejection did not report its cause");
  assert.ok(Math.abs(chaser.tEnd - plan.vehicles[0].segments[0]._t1) < 1e-9,
    "failed rendezvous advanced mission time");
  assert.strictEqual(transfer._t0, transfer._t1,
    "failed rendezvous committed a partial propagation arc");
  assert.ok(!chaser.events.some((event) =>
    event.kind === "rendezvous_wait" || event.kind === "rendezvous" ||
    (event.seg === 1 && event.kind === "burn")),
  "failed rendezvous retained a wait or maneuver event");
  assert.ok(Math.abs(chaser.totalDv - 0.02) < 1e-12,
    "failed rendezvous changed vehicle delta-v");
  console.log("PASS  rendezvous max-dv failure is transactional");
}

{
  const targetBurn = {
    type: "impulse", frame: "vnb", dv1: 0.01, dv2: 0, dv3: 0,
  };
  const transfer = rendezvous(0.25, "auto", 0.2);
  const capture = {
    type: "dock", targetVehicle: "primary",
    captureRangeKm: 0.000001, captureRateMps: 0.000001,
  };
  const release = {
    type: "undock", frame: "inertial", dv1: 0.001, dv2: 0, dv3: 0,
  };
  const followerSegments = [
    separate(), transfer, capture, coast(0.06), release, coast(0.005),
  ];
  const plan = mission("Docked assembly continuity",
    [launch(), coast(0.05), targetBurn, coast(0.05)], [{
      id: "follower", name: "Follower", color: "#52d4c5",
      spacecraft: spacecraft("Follower", 100, 50),
      segments: followerSegments,
    }]);
  const { r, errs } = runMission(plan);
  assert.deepStrictEqual(errs, []);
  const target = r.vehicleResults.primary;
  const follower = r.vehicleResults.follower;
  const dockEvent = follower.events.find((event) => event.kind === "dock");
  assert.ok(dockEvent && dockEvent.rangeKm <= capture.captureRangeKm + 1e-12);
  assert.ok(dockEvent.relativeRateMps <= capture.captureRateMps + 1e-9);
  const rendezvousSamples = follower.samples.filter((sample) => sample.seg === 1);
  const beforeDock = rendezvousSamples[rendezvousSamples.length - 1];
  const atDock = follower.samples.find((sample) => sample.seg === 2);
  assert.ok(beforeDock && atDock && Number.isFinite(beforeDock.massKg));
  assert.ok(Math.abs(atDock.massKg - beforeDock.massKg) < 1e-12,
    "docking replaced the follower's own mass");
  assert.ok(atDock.massKg > 100 && atDock.massKg < 200,
    "docking copied the 1,200 kg target mass instead of preserving the follower mass");

  const burnEvent = target.events.find((event) => event.kind === "burn" && event.seg === 2);
  assert.ok(burnEvent, "target impulse fixture did not emit a burn");
  for (const offset of [-10, 0, 10, 123.456]) {
    const time = burnEvent.t + offset;
    const targetState = ME.sampleAtTime(target, time);
    const followerState = ME.sampleAtTime(follower, time);
    assert.ok(vectorError(targetState.r, followerState.r) < 1e-5,
      `joined position diverged ${offset}s from target impulse`);
    assert.ok(vectorError(targetState.v, followerState.v) < 1e-8,
      `joined velocity diverged ${offset}s from target impulse`);
    assert.strictEqual(followerState.dockedTo, "primary",
      "off-grid joined state lost dockedTo metadata");
  }

  const undockEvent = follower.events.find((event) => event.kind === "undock");
  assert.ok(undockEvent, "undock event was not emitted");
  const released = ME.sampleAtTime(follower, undockEvent.t);
  const targetAtRelease = ME.sampleAtTime(target, undockEvent.t);
  assert.ok(!released.dockedTo, "undock did not clear joined-state metadata");
  assert.ok(Math.abs(vectorError(released.v, targetAtRelease.v) - 0.001) < 1e-9,
    "undock impulse was not applied independently");
  const afterReleaseTime = undockEvent.t + 300;
  assert.ok(vectorError(ME.sampleAtTime(follower, afterReleaseTime).r,
    ME.sampleAtTime(target, afterReleaseTime).r) > 0.1,
  "released vehicle did not diverge from the target");
  assert.ok(Math.abs(target.totalDv - 0.01) < 1e-12,
    "follower maneuvers changed target vehicle delta-v");
  console.log("PASS  docked coast is exact across target burns and undocks independently");
}

{
  const plan = mission("Dependency ordering", [launch(), coast(0.1)], [
    { id: "grandchild", name: "Grandchild", spacecraft: spacecraft("Grandchild"),
      segments: [separate("child")] },
    { id: "child", name: "Child", spacecraft: spacecraft("Child"),
      segments: [separate("primary")] },
  ]);
  const { r, errs } = runMission(plan);
  assert.deepStrictEqual(errs, []);
  assert.ok(r.vehicleResults.child.samples.length && r.vehicleResults.grandchild.samples.length,
    "dependency resolution still depends on declaration order");
  assert.strictEqual(r.vehicleResults.grandchild.samples[0].vehicleId, "grandchild");

  const invalidIds = mission("Invalid vehicle ids", [launch(), coast(0.02)], [
    { id: "primary", name: "Reserved", segments: [separate()] },
    { id: "duplicate", name: "First", segments: [separate()] },
    { id: "duplicate", name: "Second", segments: [separate()] },
  ]);
  const invalidResult = ME.recompute(invalidIds);
  assert.ok(invalidResult.vehicleWarnings.length >= 2);
  assert.deepStrictEqual(Object.keys(invalidResult.vehicleResults).sort(),
    ["duplicate", "primary"]);

  const capped = mission("Vehicle cap", [launch(), coast(0.02)],
    Array.from({ length: 8 }, (_, index) => ({
      id: "branch" + (index + 1), name: "Branch " + (index + 1),
      segments: [separate()],
    })));
  const cappedResult = ME.recompute(capped);
  assert.strictEqual(Object.keys(cappedResult.vehicleResults).length, 8,
    "more than seven secondary vehicles were propagated");
  assert.ok(cappedResult.vehicleWarnings.some((warning) => /seven secondary/i.test(warning)));

  const unresolved = mission("Unresolved dependency", [launch(), coast(0.02)], [{
    id: "orphan", name: "Orphan", segments: [separate("missing")],
  }]);
  const unresolvedResult = ME.recompute(unresolved);
  assert.ok(errorWarnings(unresolved.vehicles[0].segments[0]).some((warning) =>
    /has not been propagated/i.test(warning.msg)));
  assert.strictEqual(unresolvedResult.vehicleResults.orphan.samples.length, 0);

  const cyclic = mission("Dependency cycle", [launch(), coast(0.02)], [
    { id: "a", name: "A", segments: [separate("b")] },
    { id: "b", name: "B", segments: [separate("a")] },
  ]);
  const cyclicResult = ME.recompute(cyclic);
  assert.ok(cyclicResult.vehicleWarnings.some((warning) => /cycle|unresolved/i.test(warning)));
  assert.ok(errorWarnings(cyclic.vehicles[0].segments[0]).length ||
    errorWarnings(cyclic.vehicles[1].segments[0]).length,
  "dependency cycle did not fail a dependent segment");

  const failedParent = mission("Failed parent segment", [
    launch(), { type: "coast", days: 0, mode: "kepler" },
  ], [{
    id: "child", name: "Child", spacecraft: spacecraft("Child"),
    segments: [separate("primary"), coast(0.01)],
  }]);
  failedParent.vehicles[0].segments[0].afterSegment = 2;
  const failedParentResult = ME.recompute(failedParent);
  assert.ok(errorWarnings(failedParent.vehicles[0].segments[0]).some((warning) =>
    /did not complete successfully/i.test(warning.msg)),
  "separation from an errored parent segment was not rejected");
  assert.strictEqual(failedParentResult.vehicleResults.child.samples.length, 0,
    "child propagated from the stale state of a failed parent segment");
  console.log("PASS  dependency ordering, id validation, cap, and cycle failures");
}

{
  const minimalCoast = { type: "coast" };
  const minimalSeparate = { type: "separate", fromVehicle: "primary" };
  const minimalRendezvous = { type: "rendezvous", targetVehicle: "primary" };
  const minimalDock = { type: "dock", targetVehicle: "primary" };
  const minimalUndock = { type: "undock" };
  const plan = mission("Schema-default hydration", [launch(), minimalCoast], [{
    id: "chaser", name: "Chaser", spacecraft: spacecraft("Chaser"),
    segments: [minimalSeparate, minimalRendezvous, minimalDock,
      { type: "coast", days: 0.002 }, minimalUndock],
  }]);
  const { r, errs } = runMission(plan);
  assert.deepStrictEqual(errs, []);
  assert.strictEqual(minimalCoast.days, 1);
  assert.strictEqual(minimalSeparate.dv1, 0.001);
  assert.strictEqual(minimalRendezvous.tofHours, 6);
  assert.strictEqual(minimalRendezvous.terminalRangeKm, 0.001);
  assert.strictEqual(minimalDock.captureRangeKm, 0.00025);
  assert.strictEqual(minimalUndock.dv1, -0.001);
  assert.ok(r.vehicleResults.chaser.events.some((event) => event.kind === "undock"),
    "schema-valid minimal native segments did not execute their defaults");
  console.log("PASS  schema-valid minimal segments hydrate runtime defaults");
}

{
  const plan = MS.getPreset("crew_dragon_iss_docking");
  const { r, errs } = runMission(plan);
  assert.deepStrictEqual(errs, []);
  const station = r.vehicleResults.iss;
  const dragon = r.vehicleResults.primary;
  const dock = dragon.events.find((event) => event.kind === "dock");
  const undock = dragon.events.find((event) => event.kind === "undock");
  assert.ok(dock && undock && undock.t - dock.t > 1801,
    "bundled ISS mission lost its joined coast fixture");
  const time = dock.t + 1801;
  const stationState = ME.sampleAtTime(station, time);
  const dragonState = ME.sampleAtTime(dragon, time);
  assert.ok(dragonState.joinedExact,
    "joined GP coast did not delegate to the target's exact provider");
  assert.ok(vectorError(stationState.r, dragonState.r) < 1e-10,
    "off-grid joined position diverged from the SGP4 target");
  assert.ok(vectorError(stationState.v, dragonState.v) < 1e-12,
    "off-grid joined velocity diverged from the SGP4 target");
  assert.strictEqual(dragonState.dockedTo, "iss");
  console.log("PASS  bundled ISS docking follows the exact off-grid SGP4 state");
}

{
  const plan = MS.getPreset("leo_conjunction_lab");
  const { r, errs } = runMission(plan);
  assert.deepStrictEqual(errs, []);
  const debris = { id: "debris", result: r.vehicleResults.debris,
    sampler: ME.sampleAtTime };
  const protectedCraft = { id: "primary", result: r.vehicleResults.primary,
    sampler: ME.sampleAtTime };
  const noBurn = { id: "no_burn_reference", result: r.vehicleResults.no_burn_reference,
    sampler: ME.sampleAtTime };
  const options = { maxSamples: 801, initialIntervals: 48, maxDepth: 9,
    rangeToleranceKm: 0.001, relativeTolerance: 1e-6, maxEvaluations: 12000,
    timeTolerance: 0.01 };
  const avoided = globalThis.MissionMultiCraft.findClosestApproach(protectedCraft,
    debris, options);
  const baseline = globalThis.MissionMultiCraft.findClosestApproach(noBurn,
    debris, options);
  assert.ok(Math.abs(avoided.range - 2.34923) < 0.002,
    `avoidance closest approach changed to ${avoided.range} km`);
  assert.ok(Math.abs(baseline.range - 0.9204) < 0.002,
    `no-burn closest approach changed to ${baseline.range} km`);
  const avoidedIntervals = globalThis.MissionMultiCraft.findConjunctions(
    protectedCraft, debris, { ...options, thresholdKm: 2, maxIntervals: 128 });
  const baselineIntervals = globalThis.MissionMultiCraft.findConjunctions(
    noBurn, debris, { ...options, thresholdKm: 2, maxIntervals: 128 });
  assert.strictEqual(avoidedIntervals.intervals.length, 0);
  assert.ok(baselineIntervals.intervals.length > 0,
    "no-burn reference no longer crosses the two-kilometre threshold");
  console.log("PASS  conjunction lab exposes avoided and no-burn closest approaches");
}

{
  const plan = MS.getPreset("electric_geo_raise");
  const result = ME.recompute(plan);
  const starts = result.vehicleResults.primary.events.filter((event) =>
    event.kind === "burn" && event.finite);
  assert.strictEqual(starts.length, 2, "finite-burn fixture lost a start event");
  assert(starts.every((event) => event.vehicleId === "primary" &&
    Array.isArray(event.w) && event.w.length === 3),
  "finite-burn start events lost vehicle identity or exact world position");
  console.log("PASS  finite-burn starts retain vehicle-aware event geometry");
}

{
  const plan = MS.getPreset("apollo11_full");
  const result = ME.recompute(plan);
  const vehiclePlans = globalThis.ScriptGen.vehiclePlans(plan, result);
  assert.deepStrictEqual(vehiclePlans.map((vehicle) => vehicle.id), ["primary", "eagle"],
    "script export lost dependency-ordered vehicle sections");
  const script = globalThis.ScriptGen.generate(plan, result);
  assert(/Create Spacecraft SC_PRIMARY;/.test(script) &&
    /Create Spacecraft SC_EAGLE;/.test(script),
  "script export did not create unique spacecraft resources");
  assert(/VEHICLE eagle[\s\S]*Depends on: primary/.test(script) &&
    /Separate SC_EAGLE from SC_PRIMARY/.test(script) &&
    /Passive phasing \+ single-revolution terminal Lambert rendezvous/.test(script) &&
    /Dock SC_EAGLE to SC_PRIMARY/.test(script) &&
    /Undock SC_EAGLE from SC_PRIMARY/.test(script),
  "script export omitted native vehicle operations or dependencies");
  console.log("PASS  dependency-ordered multi-vehicle script export");
}

console.log("\n12/12 native multi-vehicle mission checks clean");
