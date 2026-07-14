/* Earth Live Vallado propagation and TEME/body-frame integration checks. */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { C, A } = require("./harness.js");

const root = path.resolve(__dirname, "..");
const sgp4Source = fs.readFileSync(path.join(root, "js", "sgp4.js"), "utf8");
const liveSource = fs.readFileSync(path.join(root, "js", "live.js"), "utf8");
const html = fs.readFileSync(path.join(root, "live.html"), "utf8");

vm.runInThisContext(sgp4Source, { filename: "sgp4.js" });
globalThis.__MTP_TEST__ = true;
globalThis.document = { getElementById() { return null; } };
vm.runInThisContext(liveSource, { filename: "live.js" });
delete globalThis.__MTP_TEST__;
delete globalThis.document;

const S = globalThis.MissionSGP4;
const T = globalThis.MTPLivePovTest;
assert(S && T, "the bundled SGP4 core and Earth Live frame adapter should load headlessly");

const nearOmm = {
  OBJECT_NAME: "LIVE SGP4 TEST", NORAD_CAT_ID: "25544",
  EPOCH: "2026-07-12T00:00:00.000Z",
  MEAN_MOTION: 15.5, ECCENTRICITY: 0.0004, INCLINATION: 51.64,
  RA_OF_ASC_NODE: 130, ARG_OF_PERICENTER: 80, MEAN_ANOMALY: 20,
  MEAN_MOTION_DOT: 0.0001, MEAN_MOTION_DDOT: 0, BSTAR: 0.0001,
};
const deepOmm = {
  OBJECT_NAME: "LIVE SDP4 TEST", NORAD_CAT_ID: "4632",
  EPOCH: "2004-01-31T21:51:25.308Z",
  MEAN_MOTION: 1.20231981, ECCENTRICITY: 0.1450506, INCLINATION: 11.4628,
  RA_OF_ASC_NODE: 273.1101, ARG_OF_PERICENTER: 207.6, MEAN_ANOMALY: 143.935,
  MEAN_MOTION_DOT: -0.00000084, MEAN_MOTION_DDOT: 0, BSTAR: 0.0001,
};

const nearRecord = S.initializeOMM(nearOmm);
const deepRecord = S.initializeOMM(deepOmm);
assert.strictEqual(S.metadata(nearRecord).branch, "SGP4",
  "ordinary Earth orbits should use the near-Earth SGP4 branch");
assert.strictEqual(S.metadata(deepRecord).branch, "SDP4",
  "periods above 225 minutes should use the deep-space SDP4 branch");

const angleError = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
function verifyPlannerFrame(record, minutes) {
  const teme = S.propagateMinutes(record, minutes);
  const fixed = S.temeToEarthFixed(teme);
  const planner = T.temeStateToPlanner(teme);
  assert(planner && planner.position.every(Number.isFinite) && planner.velocity.every(Number.isFinite),
    "TEME output should become a finite Planner-frame state");
  const ll = A.bodyLatLon(T.earthBody, planner.position, teme.jd);
  const fixedLon = Math.atan2(fixed.position[1], fixed.position[0]);
  const fixedLat = Math.asin(fixed.position[2] / A.V.mag(fixed.position));
  assert(angleError(ll.lam, fixedLon) < 1e-12 && Math.abs(ll.phi - fixedLat) < 1e-12,
    "Planner Track longitude/latitude must reproduce the SGP4 Earth-fixed state exactly");
  assert(Math.abs(A.V.mag(planner.position) - A.V.mag(teme.position)) < 1e-9,
    "the body-frame rotation must preserve SGP4 radius");
  assert(Math.abs(A.V.mag(planner.velocity) - A.V.mag(teme.velocity)) < 5e-5,
    "the time-dependent body-frame transform must preserve inertial speed");
}

verifyPlannerFrame(nearRecord, 0);
verifyPlannerFrame(nearRecord, 360);
verifyPlannerFrame(deepRecord, -1440);
verifyPlannerFrame(deepRecord, 1440);

const vanguard = S.initializeTLE(
  "1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753",
  "2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667"
);
verifyPlannerFrame(vanguard, 360);

assert(/propagateLegacyJ2/.test(liveSource) && /"J2 fallback"/.test(liveSource) &&
  /fallbackReason/.test(liveSource),
  "a failed SGP4 record should retain an explicit, inspectable J2 fallback");
assert(/src="js\/kepler\.js"[\s\S]*?src="js\/sgp4\.js"[\s\S]*?src="js\/tracker-shell\.js"/.test(html),
  "live.html must load SGP4 before the Earth controller is selected by the shared shell");

console.log("Live SGP4 checks passed: OMM SGP4/SDP4, TLE core, and exact Earth-fixed Track alignment.");
