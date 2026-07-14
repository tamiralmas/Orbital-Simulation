/* Vallado/CelesTrak SGP4/SDP4 verification vectors. Run with:
 *   node tests/sgp4_tests.js
 * Source: AIAA-2006-6753 Rev 3, Appendix D/E (WGS-72, improved mode). */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "js", "sgp4.js"), "utf8"),
  { filename: "sgp4.js" });

const S = globalThis.MissionSGP4;
let groups = 0;

function vectorError(actual, expected) {
  return Math.hypot(...actual.map((component, index) => component - expected[index]));
}

function verify(state, position, velocity, label) {
  assert.ok(vectorError(state.position, position) < 1e-7,
    `${label} TEME position differs from the Vallado vector`);
  assert.ok(vectorError(state.velocity, velocity) < 2e-9,
    `${label} TEME velocity differs from the Vallado vector`);
}

const nearLine1 = "1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753";
const nearLine2 = "2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667";
const deepLine1 = "1 04632U 70093B   04031.91070959 -.00000084  00000-0  10000-3 0  9955";
const deepLine2 = "2 04632  11.4628 273.1101 1450506 207.6000 143.9350  1.20231981 44145";

// Vanguard 1 exercises the ordinary near-Earth SGP4 branch.
{
  const record = S.initializeTLE(nearLine1, nearLine2);
  assert.strictEqual(S.metadata(record).branch, "SGP4");
  verify(S.propagateMinutes(record, 0),
    [7022.46529266, -1400.08296755, 0.03995155],
    [1.893841015, 6.405893759, 4.534807250], "Vanguard epoch");
  verify(S.propagateMinutes(record, 360),
    [-7154.03120202, -3783.17682504, -3536.19412294],
    [4.741887409, -4.151817765, -2.093935425], "Vanguard +360 min");
  verify(S.propagateMinutes(record, 720),
    [-7134.59340119, 6531.68641334, 3260.27186483],
    [-4.113793027, -2.911922039, -2.557327851], "Vanguard +720 min");
  console.log("PASS  Vallado near-Earth SGP4 vectors");
  groups++;
}

// NORAD 04632 has a roughly 20-hour period and requires the complete SDP4
// lunar/solar periodic and deep-space resonance path.
{
  const record = S.initializeTLE(deepLine1, deepLine2);
  const metadata = S.metadata(record);
  assert.strictEqual(metadata.branch, "SDP4");
  assert.ok(metadata.periodMinutes > 225, "deep-space branch was not selected by period");
  verify(S.propagateMinutes(record, 0),
    [2334.11450085, -41920.44035349, -0.03867437],
    [2.826321032, -0.065091664, 0.570936053], "04632 epoch");
  verify(S.propagateMinutes(record, -5184),
    [-29020.02587128, 13819.84419063, -5713.33679183],
    [-1.768068390, -3.235371192, -0.395206135], "04632 -5184 min");
  assert.ok(record.irez !== 0 || record.method === "d",
    "SDP4 deep-space initialization coefficients are absent");
  console.log("PASS  Vallado deep-space SDP4 vectors");
  groups++;
}

// CCSDS OMM initialization follows the same combined SGP4/SDP4 initializer.
{
  const omm = {
    NORAD_CAT_ID: "00005", EPOCH: "2000-06-27T18:50:19.733568Z",
    MEAN_MOTION: 10.82419157, ECCENTRICITY: 0.1859667, INCLINATION: 34.2682,
    RA_OF_ASC_NODE: 348.7242, ARG_OF_PERICENTER: 331.7664, MEAN_ANOMALY: 19.3264,
    MEAN_MOTION_DOT: 0.00000023, MEAN_MOTION_DDOT: 0, BSTAR: 0.000028098,
  };
  const record = S.initializeOMM(omm);
  assert.strictEqual(S.metadata(record).source, "OMM");
  const tleState = S.propagateMinutes(S.initializeTLE(nearLine1, nearLine2), 60);
  const ommState = S.propagateMinutes(record, 60);
  assert.ok(vectorError(ommState.position, tleState.position) < 0.001,
    "equivalent OMM/TLE position differs materially");
  assert.ok(vectorError(ommState.velocity, tleState.velocity) < 1e-6,
    "equivalent OMM/TLE velocity differs materially");
  console.log("PASS  CCSDS OMM initialization");
  groups++;
}

// TLE identity/checksum validation fails closed instead of feeding malformed
// fixed-column data into the numerical core.
{
  assert.strictEqual(S.tleChecksum(nearLine1), Number(nearLine1[68]));
  assert.throws(() => S.initializeTLE(nearLine1.slice(0, 68) + "4", nearLine2),
    (error) => error.code === "INVALID_CHECKSUM");
  assert.throws(() => S.initializeTLE(nearLine1,
    nearLine2.slice(0, 2) + "00006" + nearLine2.slice(7)),
  (error) => error.code === "INVALID_CHECKSUM" || error.code === "SATELLITE_NUMBER_MISMATCH");
  console.log("PASS  strict fixed-column checksum and identity validation");
  groups++;
}

// Series generation and deep-space stepping are explicitly bounded.
{
  const record = S.initializeTLE(deepLine1, deepLine2);
  const series = S.propagateSeries(record, -240, 240, 60, { maxSamples: 9 });
  assert.strictEqual(series.length, 9);
  assert.ok(series.every((state) => state.branch === "SDP4"));
  assert.throws(() => S.propagateSeries(record, 0, 1000, 1, { maxSamples: 100 }),
    (error) => error.code === "MAX_SAMPLES_EXCEEDED");
  assert.throws(() => S.propagateMinutes(record, S.DEFAULT_MAX_ABS_MINUTES + 1),
    (error) => error.code === "TIME_LIMIT_EXCEEDED");
  console.log("PASS  bounded series/time work caps");
  groups++;
}

// The companion GMST transform preserves a full state in a round trip and
// includes the rotating-frame velocity term required by ground tracks.
{
  const record = S.initializeTLE(nearLine1, nearLine2);
  const teme = S.propagateMinutes(record, 37.25);
  const fixed = S.temeToEarthFixed(teme);
  const roundTrip = S.earthFixedToTEME(fixed, fixed.jd);
  assert.ok(vectorError(roundTrip.position, teme.position) < 1e-9);
  assert.ok(vectorError(roundTrip.velocity, teme.velocity) < 1e-12);
  assert.ok(fixed.warning.includes("polar motion"));
  console.log("PASS  TEME / pseudo-Earth-fixed state round trip");
  groups++;
}

console.log(`\n${groups}/${groups} SGP4/SDP4 test groups clean`);
