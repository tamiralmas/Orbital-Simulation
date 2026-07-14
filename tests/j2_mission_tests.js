/* Planner integration tests for the selectable first-order Earth J2 coast.
 * Run with: node tests/j2_mission_tests.js */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { C, A, ME } = require("./harness.js");
vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "js", "scriptgen.js"),
  "utf8"), { filename: "scriptgen.js" });

function signedAngleDeg(value) {
  value = (value + 180) % 360;
  if (value < 0) value += 360;
  return value - 180;
}

const mission = {
  name: "Sun-synchronous J2 regression",
  epoch: "2026-07-13T00:00:00Z",
  spacecraft: { name: "J2 demonstrator", dryKg: 1000, propKg: "", isp: 320 },
  segments: [
    { type: "launch", body: "earth", site: "", ascent: "direct",
      altKm: 700, incDeg: 98.19, raanDeg: 15 },
    { type: "coast", days: 1, mode: "j2-secular" },
  ],
};
const result = ME.recompute(mission);
const warnings = mission.segments.flatMap((segment) => segment._warn || []);
assert.deepStrictEqual(warnings, []);
const segment = mission.segments[1];
const samples = result.samples.filter((sample) => sample.seg === 1);
assert.ok(samples.length > 500 && samples.length <= 722,
  `unexpected J2 sample count ${samples.length}`);
assert.strictEqual(segment._info.model, "first-order Earth J2 secular");
assert.ok(segment._info.raanRateDegDay > 0.95 &&
  segment._info.raanRateDegDay < 1.02,
  `unexpected sun-synchronous nodal drift ${segment._info.raanRateDegDay} deg/day`);

const first = A.rvToCoe(samples[0].r, samples[0].v, C.BODIES.earth.mu);
const last = A.rvToCoe(samples[samples.length - 1].r,
  samples[samples.length - 1].v, C.BODIES.earth.mu);
const actualDrift = signedAngleDeg((last.Om - first.Om) / C.DEG);
assert.ok(Math.abs(actualDrift - segment._info.raanRateDegDay) < 1e-6,
  `applied nodal drift ${actualDrift} does not match reported rate`);
assert.ok(samples.every((sample) => A.V.mag(sample.r) > C.BODIES.earth.radius),
  "J2 propagation crossed the Earth surface");
const midpoint = ME.sampleAtTime(result,
  0.5 * (segment._t0 + segment._t1));
assert.ok(midpoint && midpoint.interp &&
  A.V.mag(midpoint.r) > C.BODIES.earth.radius,
  "J2 Hermite interpolation did not preserve the orbit");
const script = globalThis.ScriptGen.generate(mission, result);
assert.ok(script.includes("J2SecularProp") &&
  script.includes("Earth J2 drift: RAAN"),
  "mission script did not preserve the selected J2 force model");
console.log("PASS  Planner Earth J2 nodal/periapsis drift");

const longMission = JSON.parse(JSON.stringify(mission));
longMission.name = "Thirty-day J2 interpolation regression";
longMission.segments[1].days = 30;
const longResult = ME.recompute(longMission);
assert.deepStrictEqual(longMission.segments.flatMap((segment) => segment._warn || []), []);
let minimumAltitude = Infinity, maximumAltitude = -Infinity;
for (let time = longMission.segments[1]._t0;
  time <= longMission.segments[1]._t1; time += 600) {
  const sample = ME.sampleAtTime(longResult, time);
  const altitude = A.V.mag(sample.r) - C.BODIES.earth.radius;
  minimumAltitude = Math.min(minimumAltitude, altitude);
  maximumAltitude = Math.max(maximumAltitude, altitude);
}
assert.ok(minimumAltitude > 699.9 && maximumAltitude < 700.1,
  `analytic J2 interpolation aliased revolutions (${minimumAltitude} to ${maximumAltitude} km)`);
console.log("PASS  long J2 coast interpolation remains physical");

const invalid = {
  name: "Non-Earth J2 guard",
  epoch: "2026-07-13T00:00:00Z",
  spacecraft: { name: "Guard", dryKg: 100, propKg: "", isp: 320 },
  segments: [
    { type: "launch", body: "mars", site: "", ascent: "direct",
      altKm: 400, incDeg: 25, raanDeg: 0 },
    { type: "coast", days: 0.1, mode: "j2-secular" },
  ],
};
ME.recompute(invalid);
assert.ok(invalid.segments[1]._warn.some((warning) =>
  warning.level === "error" && warning.msg.includes("Earth-centered only")));
console.log("PASS  J2 model rejects unsupported central bodies clearly");

console.log("\n3/3 Planner J2 groups clean");
