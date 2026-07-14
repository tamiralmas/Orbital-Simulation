/* Generated Planner Horizons table contracts. Run with:
 *   node tests/planner_ephemeris_tests.js */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "..");
for (const file of ["js/ephemeris-table.js", "js/planner-ephemeris-data.js",
  "js/planner-ephemeris.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(root, file), "utf8"), { filename: file });
}

const data = globalThis.MTP_PLANNER_EPHEMERIS;
const provider = globalThis.MTPPlannerEphemeris;
assert(data && provider, "generated data must create an offline provider");
assert(/NASA\/JPL Horizons/.test(provider.metadata.source));
assert.strictEqual(provider.metadata.bodyCount, 20);
assert.strictEqual(provider.metadata.sampleCount, 15380);
assert.strictEqual(provider.metadata.center, "500@10 (Sun center)");
assert(/ICRF/.test(provider.metadata.frame));
assert.strictEqual(provider.metadata.extrapolation, "forbidden");

for (const id of ["earth", "moon", "mars", "jupiter", "pluto"]) {
  const coverage = provider.coverage(id);
  assert(coverage && coverage.sampleCount >= 2, id + " coverage missing");
  const first = data.bodies[id].samples[0];
  const atFirst = provider.stateAt(id, coverage.startJD);
  for (let axis = 0; axis < 3; axis++) {
    assert(Math.abs(atFirst.r[axis] - first[axis + 1]) < 1e-9);
    assert(Math.abs(atFirst.v[axis] - first[axis + 4]) < 1e-12);
  }
  const middle = provider.stateAt(id, (coverage.startJD + coverage.stopJD) / 2);
  assert(middle && middle.r.every(Number.isFinite) && middle.v.every(Number.isFinite));
  assert.strictEqual(provider.stateAt(id, coverage.startJD - 1e-6), null,
    id + " must not extrapolate before coverage");
  assert.strictEqual(provider.stateAt(id, coverage.stopJD + 1e-6), null,
    id + " must not extrapolate after coverage");
}

assert(fs.existsSync(path.join(root, "get_planner_ephemerides.ps1")),
  "the release table must have a reproducible generator");
console.log("Planner ephemeris checks passed: 20 Horizons bodies / 15,380 bounded rows.");
