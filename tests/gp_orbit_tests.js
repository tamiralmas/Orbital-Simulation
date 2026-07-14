/* Planner segment integration for SGP4/SDP4 GP element sets.
 * Run with: node tests/gp_orbit_tests.js */
"use strict";

const { C, A, ME, runMission } = require("./harness.js");
let failed = 0, count = 0;

const LINE1 = "1 04632U 70093B   04031.91070959 -.00000084  00000-0  10000-3 0  9955";
const LINE2 = "2 04632  11.4628 273.1101 1450506 207.6000 143.9350  1.20231981 44145";
const RECORD = globalThis.MissionSGP4.initializeTLE(LINE1, LINE2);
const META = globalThis.MissionSGP4.metadata(RECORD);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function check(name, fn) {
  count++;
  try { fn(); console.log("PASS  " + name); }
  catch (error) { failed++; console.error("FAIL  " + name + "\n  " + error.message); }
}

function run(stepMin = 20) {
  const mission = {
    id: "sdp4-integration",
    name: "SDP4 integration",
    epoch: A.jdToStr(META.epochJD),
    spacecraft: { dryKg: 100, propKg: 0, isp: 0 },
    segments: [{ type: "gp_orbit", line1: LINE1, line2: LINE2,
      days: 4, stepMin, strictChecksum: "strict" }],
  };
  return { mission, output: runMission(mission) };
}

check("Planner dispatches the SDP4 branch", () => {
  const { mission, output } = run();
  assert(!output.errs.length, output.errs.join("\n"));
  assert(mission.segments[0]._info.model === "SDP4", "deep-space branch not reported");
  const effective = Math.min(20, META.periodMinutes / 64);
  assert(output.r.samples.length === Math.ceil(4 * 1440 / effective) + 1,
    "unexpected bounded output sample count");
  assert(Math.abs(output.r.tEnd / C.DAY - 4) < 1e-8, "segment duration changed");
});

check("TEME mapping matches Planner ground coordinates", () => {
  const { output } = run();
  const sample = output.r.samples[0];
  const raw = globalThis.MissionSGP4.propagateDate(RECORD,
    A.jdToDate(output.r.epochJD));
  const fixed = globalThis.MissionSGP4.temeToEarthFixed(raw, raw.jd);
  const ground = A.bodyLatLon(C.BODIES.earth, sample.r, raw.jd);
  const expectedLon = Math.atan2(fixed.position[1], fixed.position[0]);
  const expectedLat = Math.asin(fixed.position[2] / Math.hypot(...fixed.position));
  assert(Math.abs(Math.atan2(Math.sin(ground.lam - expectedLon),
    Math.cos(ground.lam - expectedLon))) < 1e-10, "longitude frame mismatch");
  assert(Math.abs(ground.phi - expectedLat) < 1e-10, "latitude frame mismatch");
  assert(Math.abs(A.V.mag(sample.r) - A.V.mag(raw.position)) < 1e-8,
    "TEME mapping changed position magnitude");
  assert(Math.abs(A.V.mag(sample.v) - A.V.mag(raw.velocity)) < 2e-5,
    "TEME mapping changed inertial speed");
});

check("Planner GP velocity is the derivative of mapped position", () => {
  const { output } = run();
  const t = 2 * C.DAY;
  const halfSpanS = 30;
  const before = ME.sampleAtTime(output.r, t - halfSpanS);
  const center = ME.sampleAtTime(output.r, t);
  const after = ME.sampleAtTime(output.r, t + halfSpanS);
  const finiteDifference = A.V.scale(A.V.sub(after.r, before.r), 1 / (2 * halfSpanS));
  assert(A.V.mag(A.V.sub(finiteDifference, center.v)) < 2e-4,
    "mapped velocity does not match dr/dt");
});

check("SDP4 off-grid path stays outside Earth", () => {
  const { output } = run();
  for (let index = 1; index < output.r.samples.length; index++) {
    const a = output.r.samples[index - 1], b = output.r.samples[index];
    const midpoint = ME.sampleAtTime(output.r, 0.5 * (a.t + b.t));
    assert(A.V.mag(midpoint.r) > C.BODIES.earth.radius,
      "interpolated GP path crossed Earth");
  }
});

check("Coarse requested cadence cannot create false planet crossings", () => {
  const { mission, output } = run(1440);
  const info = mission.segments[0]._info;
  assert(info.cadenceMinutes <= META.periodMinutes / 64 + 1e-10,
    "stored GP cadence was not curvature-bounded");
  for (let t = 0; t <= output.r.tEnd; t += 300) {
    const sample = ME.sampleAtTime(output.r, t);
    const altitude = A.V.mag(sample.r) - C.BODIES.earth.radius;
    assert(altitude > 0, "exact off-grid GP path crossed Earth at T+" + t);
  }
});

check("A GP state reset breaks the preceding drawn trajectory", () => {
  const launch = ME.defaultSegment("launch");
  launch.ascent = "direct";
  launch.altKm = 300;
  const gp = { type: "gp_orbit", line1: LINE1, line2: LINE2,
    days: 0.1, stepMin: 20, strictChecksum: "strict" };
  const mission = {
    id: "sdp4-reset-break",
    name: "SDP4 reset break",
    epoch: A.jdToStr(META.epochJD),
    spacecraft: { dryKg: 100, propKg: 0, isp: 0 },
    segments: [launch, gp],
  };
  const output = runMission(mission);
  assert(output.errs.some((message) => message.includes("resets the preceding trajectory")),
    "intentional GP state reset warning was not reported");
  const first = output.r.samples.findIndex((sample) => sample.seg === 1);
  assert(first > 0, "first GP sample was not stored after the launch state");
  assert(output.r.samples[first]._breakBefore === true,
    "first GP sample did not break the unrelated preceding trajectory");
  assert(Math.abs(output.r.samples[first].t - output.r.samples[first - 1].t) < 1e-8,
    "GP reset unexpectedly changed the mission epoch");
  assert(A.V.mag(A.V.sub(output.r.samples[first].r,
    output.r.samples[first - 1].r)) > 1,
  "regression setup did not create a material state reset");
});

console.log(`\n${count - failed}/${count} GP orbit integration groups clean`);
if (failed) process.exit(1);
