/* Planner integration checks for generated ephemerides and deterministic
 * environment coasts. Run with: node tests/propagator_environment_tests.js */
"use strict";

const { C, A, ME, runMission } = require("./harness.js");
let failed = 0, count = 0;

function check(name, fn) {
  count++;
  try {
    fn();
    console.log("PASS  " + name);
  } catch (error) {
    failed++;
    console.error("FAIL  " + name + "\n  " + error.message);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function mission(extra) {
  return {
    id: "environment-integration",
    name: "Environment integration",
    epoch: "2026-07-13T00:00:00Z",
    spacecraft: { dryKg: 700, propKg: 100, isp: 300 },
    segments: [
      { type: "launch", body: "earth", site: "ksc", ascent: "direct",
        altKm: 350, incDeg: 51.6, raanDeg: 0 },
      Object.assign({ type: "coast", days: 0.2, mode: "adaptive-environment",
        ephemeris: "planner-horizons", drag: "on", srp: "on",
        harmonics: "j4", massKg: 800, areaM2: 20, cd: 2.2, cr: 1.4,
        densityScale: 1 }, extra || {}),
    ],
  };
}

check("Planner environment coast and provenance", () => {
  const m = mission();
  const { r, errs } = runMission(m);
  assert(!errs.length, errs.join("\n"));
  const segment = m.segments[1];
  assert(segment._info.model === "adaptive deterministic environment",
    "environment model label was not retained");
  assert(/Horizons/i.test(segment._info.ephemeris),
    "generated ephemeris provenance is missing");
  assert(segment._info.environmentModels.includes("drag") &&
    segment._info.environmentModels.includes("srp") &&
    segment._info.environmentModels.includes("harmonics"),
    "selected environment models were not reported");
  assert(r.samples.some((sample) => sample.forceEphemeris === "planner-horizons"),
    "trajectory samples lost the ephemeris frame tag");
  const boundary = r.samples.findIndex((sample, index) => index > 0 &&
    sample.seg === 1 && r.samples[index - 1].seg === 0 &&
    Math.abs(sample.t - r.samples[index - 1].t) < 1e-9);
  assert(boundary > 0, "launch/environment boundary was not retained");
  assert(A.V.mag(A.V.sub(r.samples[boundary].w,
    r.samples[boundary - 1].w)) < 1e-6,
  "switching force ephemerides teleported the displayed spacecraft");
  const boundarySample = r.samples[boundary];
  const catalogEarth = A.bodyWorld("earth", r.epochJD + boundarySample.t / C.DAY);
  assert(A.V.mag(A.V.sub(boundarySample.w,
    A.V.add(catalogEarth, boundarySample.r))) < 1e-7,
  "displayed environment state detached from the rendered central body");
});

check("Horizons-frame off-grid interpolation", () => {
  const { r, errs } = runMission(mission());
  assert(!errs.length, errs.join("\n"));
  const pairIndex = r.samples.findIndex((sample, index) => index > 0 &&
    sample.forceModel === "adaptive-environment" &&
    r.samples[index - 1].forceModel === "adaptive-environment" &&
    sample.t > r.samples[index - 1].t);
  assert(pairIndex > 0, "no adaptive sample interval found");
  const a = r.samples[pairIndex - 1], b = r.samples[pairIndex];
  const sample = ME.sampleAtTime(r, 0.5 * (a.t + b.t));
  const forceCenter = globalThis.MissionForceModels.bodyStateAt("earth",
    r.epochJD + sample.t / C.DAY, globalThis.MTPPlannerEphemeris);
  const forceReconstructed = A.V.add(forceCenter.r, sample.r);
  assert(A.V.mag(A.V.sub(forceReconstructed, sample.forceW)) < 1e-7,
    "interpolated force-frame state lost its Horizons ephemeris");
  const catalogCenter = A.bodyWorld("earth", r.epochJD + sample.t / C.DAY);
  const displayReconstructed = A.V.add(catalogCenter, sample.r);
  assert(A.V.mag(A.V.sub(displayReconstructed, sample.w)) < 1e-7,
    "interpolated display state detached from the rendered Earth");
});

check("Generated table fails closed outside coverage", () => {
  const m = mission();
  m.epoch = "2030-01-01T00:00:00Z";
  const { errs } = runMission(m);
  assert(errs.some((message) => /outside the bounded table/i.test(message)),
    "out-of-coverage generated ephemeris did not fail closed");
});

console.log(`\n${count - failed}/${count} Planner environment integration groups clean`);
if (failed) process.exit(1);
