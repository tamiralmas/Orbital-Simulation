/* Planner-level CR3BP/Lagrange integration regression tests.
 * Run with: node tests/cr3bp_mission_tests.js */
"use strict";

const assert = require("assert");
const { C, A, ME, MS } = require("./harness.js");
const R3 = globalThis.CR3BP;

function cleanPreset(id) {
  const mission = MS.getPreset(id);
  const result = ME.recompute(mission);
  const warnings = mission.segments.flatMap((segment) => segment._warn || []);
  assert.deepStrictEqual(warnings, [], `${id} emitted a segment warning`);
  return { mission, result };
}

// Four reference cycles previously followed a freely propagated, unstable
// numerical reference away from the corrected halo. The operational tracker
// must instead return to the same phase of the authored periodic solution.
{
  const mission = MS.getPreset("earth_moon_l2_halo");
  const station = mission.segments.find((segment) => segment.type === "stationkeep");
  station.cycles = 4;
  const result = ME.recompute(mission);
  const system = R3.getSystem(result.cr3bpSystem);
  const periodS = result.cr3bpOrbit.periodSeconds;
  const phaseStates = [];
  for (let cycle = 1; cycle <= 4; cycle++)
    phaseStates.push(ME.sampleAtTime(result,
      Math.min(station._t1, station._t0 + cycle * periodS)).synodic);
  const maximumCycleDriftKm = Math.max(...phaseStates.slice(1).map((state) =>
    A.V.mag(A.V.sub(state.slice(0, 3), phaseStates[0].slice(0, 3))) *
      system.distanceKm));
  assert.ok(maximumCycleDriftKm < 0.001,
    `phase-locked stationkeeping drifted ${maximumCycleDriftKm} km in four cycles`);
  assert.strictEqual(result.events.filter((event) => event.kind === "stationkeep").length, 48,
    "four stationkeeping cycles lost correction epochs");
  assert.strictEqual(station._info.model,
    "phase-locked ideal impulsive reference tracking");
}

{
  const { mission, result } = cleanPreset("earth_moon_l2_halo");
  assert.strictEqual(result.cr3bpSystem, "earth-moon");
  assert.strictEqual(result.cr3bpOrbit.family, "halo");
  assert.strictEqual(result.cr3bpOrbit.periodicClaim, true);
  assert.ok(result.cr3bpOrbit.closureError < 1e-8,
    "corrected halo does not close in canonical state");
  assert.ok(result.samples.length > 250, "halo path is undersampled for display");
  assert.ok(result.events.filter((event) => event.kind === "stationkeep").length > 0,
    "stationkeeping corrections were not surfaced as events");
  assert.ok(result.totalDv > 0 && result.totalDv < 0.01,
    "stationkeeping estimate is absent or implausibly large");

  const system = R3.getSystem("earth-moon");
  const coast = result.samples.filter((sample) => sample.seg === 1);
  const jacobi = coast.map((sample) => R3.jacobiConstant(system, sample.synodic));
  assert.ok(Math.max(...jacobi) - Math.min(...jacobi) < 1e-9,
    "adaptive CR3BP coast does not preserve the Jacobi integral");
  for (const sample of result.samples) {
    assert.strictEqual(sample.cr3bp, true);
    assert.ok(sample.w.every(Number.isFinite) && sample.synodic.every(Number.isFinite));
    const primary = A.bodyWorld(system.primaryId, result.epochJD + sample.t / C.DAY);
    assert.ok(A.V.mag(A.V.sub(sample.w, A.V.add(primary, sample.r))) < 1e-5,
      "embedded world and primary-relative positions disagree");
  }
  const a = coast[Math.floor(coast.length / 2)];
  const b = coast[Math.floor(coast.length / 2) + 1];
  const mid = ME.sampleAtTime(result, 0.5 * (a.t + b.t));
  assert.strictEqual(mid.cr3bp, true);
  assert.strictEqual(mid.cr3bpSystem, "earth-moon");
  assert.ok(mid.w.every(Number.isFinite), "off-grid CR3BP interpolation is non-finite");
  assert.ok(mission.segments[1]._info.jacobiDrift < 1e-9);

  const station = mission.segments[2];
  const stationSamples = result.samples.filter((sample) => sample.seg === 2);
  const beforeStation = result.samples.filter((sample) =>
    sample.t <= station._t0 && sample.seg !== 2).slice(-1)[0];
  assert.ok(stationSamples[0]._breakBefore,
    "injected stationkeeping offset was connected as fictitious motion");
  assert.ok(Math.abs((stationSamples[0].synodic[0] - beforeStation.synodic[0]) *
    system.distanceKm - mission.segments[2].offsetKm) < 1e-6,
  "stationkeeping radial offset was not present at segment start");
  assert.ok(result.events.some((event) => event.kind === "note" &&
    event.seg === 2 && event.label.includes("radial offset")),
  "stationkeeping dispersion event was not surfaced");
  assert.ok(station._info.correctionEpochs <= 1000);
  assert.strictEqual(station._info.samplesPerCheck, 8,
    "stationkeeping output cadence lost its reviewed interval sampling");
  assert.ok(new Set(stationSamples.map((sample) => sample.t)).size >= 90,
    "stationkeeping retained only sparse correction endpoints");
  let maximumStationkeepingChord = 0;
  for (let index = 1; index < stationSamples.length; index++)
    maximumStationkeepingChord = Math.max(maximumStationkeepingChord,
      A.V.mag(A.V.sub(stationSamples[index].r, stationSamples[index - 1].r)));
  assert.ok(maximumStationkeepingChord < 25000,
    `stationkeeping path retained a ${maximumStationkeepingChord} km display chord`);
}

// Gateway propagates two independent halo families. Both stationkeeping
// histories need the same time-resolved contract as the standalone L2 case.
{
  const { mission, result } = cleanPreset("gateway_halo_operations");
  for (const [vehicleId, vehicleResult] of Object.entries(result.vehicleResults)) {
    const definition = vehicleId === "primary" ? mission
      : mission.vehicles.find((vehicle) => vehicle.id === vehicleId);
    const segmentIndex = definition.segments.findIndex((segment) =>
      segment.type === "stationkeep");
    const samples = vehicleResult.samples.filter((sample) => sample.seg === segmentIndex);
    assert.ok(samples.length >= 100,
      `${vehicleId} stationkeeping path is too sparse for its halo`);
    assert.strictEqual(vehicleResult.events.filter((event) =>
      event.kind === "stationkeep").length, 12,
    `${vehicleId} lost its configured correction events`);
  }
}

{
  const { mission, result } = cleanPreset("sun_earth_l1_lissajous");
  assert.strictEqual(result.cr3bpSystem, "sun-earth");
  assert.strictEqual(result.cr3bpOrbit.family, "lissajous");
  assert.strictEqual(result.cr3bpOrbit.periodicClaim, false,
    "linear Lissajous seed was incorrectly advertised as periodic");
  assert.strictEqual(mission.segments[0]._info.periodic, false);
  assert.ok(mission.segments[1]._info.jacobiDrift < 1e-9);
  assert.ok(result.samples.some((sample) => sample.seg === 2),
    "Sun-Earth stationkeeping segment produced no samples");
}

{
  const mission = MS.getPreset("earth_moon_l2_halo");
  mission.segments[2].cycles = 100;
  mission.segments[2].corrections = 100;
  ME.recompute(mission);
  assert.ok(mission.segments[2]._warn.some((warning) =>
    warning.level === "error" && warning.msg.includes("1,000 correction epochs")),
  "Planner did not fail fast on an excessive stationkeeping work request");
}

console.log("4/4 Planner CR3BP mission groups clean");
