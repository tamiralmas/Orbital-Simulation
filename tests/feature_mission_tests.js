/* Acceptance checks for the five v1.18 feature-validation missions.
 * Run with: node tests/feature_mission_tests.js */
"use strict";

const assert = require("assert");
const { C, A, MS, runMission } = require("./harness.js");

const IDS = ["leo_environment_lab", "geo_srp_horizons", "sdp4_validation",
  "leo_disposal_uncertainty", "mars_joint_target_lab"];
for (const id of IDS) assert.ok(MS.PRESETS.some((preset) => preset.id === id),
  `missing feature-validation preset ${id}`);
console.log("PASS  five feature-validation missions are bundled");

{
  const mission = MS.getPreset("leo_environment_lab");
  const { errs } = runMission(mission);
  assert.deepStrictEqual(errs, []);
  const info = mission.segments[1]._info;
  assert.strictEqual(info.model, "adaptive deterministic environment");
  assert.match(info.ephemeris, /Horizons/i);
  assert.match(info.environmentModels, /drag/);
  assert.match(info.environmentModels, /harmonics/);
  console.log("PASS  LEO drag/J2-J4/Horizons mission");
}

{
  const mission = MS.getPreset("geo_srp_horizons");
  const { errs } = runMission(mission);
  assert.deepStrictEqual(errs, []);
  assert.match(mission.segments[1]._info.environmentModels, /srp/);
  assert.strictEqual(mission.segments[1].environment, undefined,
    "preset should exercise the editable Coast environment fields");
  console.log("PASS  GEO SRP/eclipse/Horizons mission");
}

{
  const mission = MS.getPreset("sdp4_validation");
  const { r, errs } = runMission(mission);
  assert.deepStrictEqual(errs, []);
  assert.strictEqual(mission.segments[0]._info.model, "SDP4");
  assert.ok(r.samples.every((sample) => sample.forceEphemeris === "gp-elements"));
  console.log("PASS  full SDP4 GP mission");
}

{
  const mission = MS.getPreset("leo_disposal_uncertainty");
  assert.ok(mission.uncertainty && mission.operations,
    "preset analysis metadata was not retained by getPreset");
  const { r, errs } = runMission(mission);
  assert.deepStrictEqual(errs, []);
  const options = mission.uncertainty;
  assert.strictEqual(options.source.beforeSegment, 1);
  const firstBurn = r.samples.findIndex((entry) => entry.seg === 1);
  assert.ok(firstBurn > 0, "disposal burn boundary was not emitted");
  const sample = r.samples[firstBurn - 1];
  const flownPostBurn = r.samples[firstBurn];
  assert.ok(A.V.mag(sample.r) > C.BODIES.earth.radius,
    "configured uncertainty source was not above Earth");
  const covariance = Array.from({ length: 6 }, (_, row) =>
    Array.from({ length: 6 }, (_, column) => row === column
      ? (row < 3 ? options.positionSigmaKm ** 2 : options.velocitySigmaKmS ** 2) : 0));
  const dispersion = globalThis.MissionUncertainty.runMonteCarlo({
    meanState: sample.r.concat(sample.v),
    covariance,
    samples: options.samples,
    seed: options.seed,
    maneuvers: [options.maneuver],
    propagationTime: options.propagationHours * 3600,
    propagator: (state, dt) => {
      const propagated = A.propagateUniversal(state.slice(0, 3), state.slice(3), dt,
        C.BODIES.earth.mu);
      return propagated.r.concat(propagated.v);
    },
    maxModelEvaluations: options.samples,
    retainSamples: true,
  });
  const nominal = globalThis.MissionUncertainty.applyManeuverCovariance({
    state: sample.r.concat(sample.v), covariance, maneuver: options.maneuver,
  });
  assert.ok(A.V.mag(A.V.sub(nominal.finalState.slice(3), flownPostBurn.v)) < 1e-9,
    "uncertainty maneuver does not match the single flown disposal burn");
  assert.strictEqual(dispersion.samplesRequested, 1000);
  assert.strictEqual(dispersion.modelEvaluations, 1000);
  assert.ok(dispersion.summary.positionRadius.confidence > 0);
  assert.ok(dispersion.summary.ellipses.xy.semiMajor > 0);
  assert.ok(dispersion.samples.every((state) =>
    A.V.mag(state.slice(0, 3)) > C.BODIES.earth.radius),
  "retained disposal dispersion intersected Earth");
  console.log("PASS  seeded covariance/maneuver Monte Carlo mission");
}

{
  const mission = MS.getPreset("mars_joint_target_lab");
  const { errs } = runMission(mission);
  assert.deepStrictEqual(errs, []);
  const depart = mission.segments.find((segment) => segment.type === "depart");
  const expected = C.BODIES.mars.radius + mission.targetingValidation.targetPeriapsisKm;
  assert.ok(Math.abs(depart._info.rpTargeted - expected) <= 1,
    "applied Mars trajectory missed its joint-targeted periapsis");
  assert.strictEqual(depart._info.fixedAim, true,
    "validation mission must fly the fixed B-plane aim solved by the Windows pane");
  assert.ok(Math.abs(depart._info.aimOffsetKm -
    mission.targetingValidation.fixedAimOffsetKm) < 1e-9,
  "applied trajectory did not retain the solved B-plane aim");
  assert.ok(mission.targetingValidation.variedDeparture &&
    mission.targetingValidation.variedTof);
  const evaluateVariant = (epoch, tofDays) => {
    const variant = MS.getPreset("mars_joint_target_lab");
    variant.epoch = epoch;
    variant.segments.find((segment) => segment.type === "depart").tofDays = tofDays;
    const outcome = runMission(variant);
    assert.deepStrictEqual(outcome.errs, []);
    const variantDepart = variant.segments.find((segment) => segment.type === "depart");
    return variantDepart._info.rpTargeted - C.BODIES.mars.radius;
  };
  const metadata = mission.targetingValidation;
  const seedAchieved = evaluateVariant(metadata.seedEpoch, metadata.seedTofDays);
  const dateOnlyAchieved = evaluateVariant(metadata.solvedEpoch, metadata.seedTofDays);
  const tofOnlyAchieved = evaluateVariant(metadata.seedEpoch, metadata.solvedTofDays);
  assert.ok(Math.abs(seedAchieved - metadata.targetPeriapsisKm) > 500,
    "seed trajectory should not already satisfy the applied target");
  assert.ok(Math.abs(dateOnlyAchieved - seedAchieved) > 100,
    "departure date did not materially influence the applied trajectory");
  assert.ok(Math.abs(tofOnlyAchieved - seedAchieved) > 100,
    "time of flight did not materially influence the applied trajectory");

  const missedAim = MS.getPreset("mars_joint_target_lab");
  const missedDepart = missedAim.segments.find((segment) => segment.type === "depart");
  missedDepart.aimOffsetKm = 700000;
  missedDepart.periKm = 696610.5;
  const missed = runMission(missedAim);
  assert.ok(missed.errs.some((message) => /fixed B-plane aim|sphere of influence/i.test(message)),
    "a fixed aim that misses Mars must be a mission error");
  assert.ok(!missed.r.samples.some((sample) => sample.cen === "mars"),
    "missed fixed aim unexpectedly entered the Mars frame");
  assert.ok(!Number.isFinite(missedDepart._info.rpTargeted),
    "a closest-distance outside the target SOI was misreported as periapsis");
  console.log("PASS  joint departure-date/TOF target mission");
}

console.log("\n5/5 feature-validation missions clean");
