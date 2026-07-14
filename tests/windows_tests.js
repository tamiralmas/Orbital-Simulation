/* Launch-window / porkchop engine regressions. Run with:
 *   node tests/windows_tests.js */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

for (const file of ["constants.js", "kepler.js", "windows.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "js", file), "utf8"),
    { filename: file });
}

const C = globalThis.AstroConst;
const A = globalThis.Astro;
const W = globalThis.MissionWindows;

function near(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message}: ${actual} differs from ${expected} by ${Math.abs(actual - expected)}`);
}

(async function run() {
  let groups = 0;

  // The approximate JPL/Standish catalog and the existing Lambert solver
  // reproduce the classic 2005 Earth-Mars opportunity without a fixture.
  const classic = W.evaluateCell({
    departureBody: "earth",
    arrivalBody: "mars",
    departureDate: "2005-08-10T00:00:00Z",
    tofDays: 196,
  });
  assert.ok(classic.valid, `classic Earth-Mars cell failed: ${classic.error}`);
  near(classic.c3, 15.8931, 0.1, "classic Earth-Mars C3 (km^2/s^2)");
  near(classic.departureVInfinity * classic.departureVInfinity,
    classic.c3, 1e-12, "C3 is departure v-infinity squared");
  near(classic.totalCharacteristicVelocity,
    classic.departureVInfinity + classic.arrivalVInfinity, 1e-12,
    "total characteristic velocity is the endpoint v-infinity sum");
  assert.ok(Object.isFrozen(classic) && Object.isFrozen(classic.departurePosition),
    "cell results should be immutable cache-safe values");
  console.log("PASS  classic 2005 Earth-Mars cell");
  groups++;

  // Cassini's VVEJGA launch targeted Venus first. With the historical launch
  // instant and a 193.5-day first leg, the catalog/Lambert model should retain
  // the mission's published roughly 16.6 km^2/s^2 departure-energy class.
  const cassini = W.evaluateCell({
    departureBody: "earth",
    arrivalBody: "venus",
    departureDate: "1997-10-15T08:43:00Z",
    tofDays: 193.5,
  });
  assert.ok(cassini.valid, `Cassini Earth-Venus cell failed: ${cassini.error}`);
  near(cassini.c3, 16.6, 0.35, "Cassini 1997 VVEJGA launch C3 (km^2/s^2)");
  assert.ok(cassini.arrivalJD > cassini.departureJD &&
    cassini.departureVInfinity > 3.9 && cassini.departureVInfinity < 4.3,
  "Cassini first-leg endpoint state is implausible");
  console.log("PASS  Cassini 1997 VVEJGA launch-energy regression");
  groups++;

  // Independently reconstruct both excess-velocity vectors. This catches a
  // subtle but common porkchop error: comparing a heliocentric transfer
  // velocity to a body-local or zero velocity.
  const departureBodyVelocity = A.bodyWorldVel("earth", classic.departureJD, "sun");
  const arrivalBodyVelocity = A.bodyWorldVel("mars", classic.arrivalJD, "sun");
  const departureExcess = A.V.mag(A.V.sub(classic.transferDepartureVelocity,
    departureBodyVelocity));
  const arrivalExcess = A.V.mag(A.V.sub(classic.transferArrivalVelocity,
    arrivalBodyVelocity));
  near(classic.departureVInfinity, departureExcess, 1e-12,
    "departure hyperbolic excess velocity");
  near(classic.arrivalVInfinity, arrivalExcess, 1e-12,
    "arrival hyperbolic excess velocity");
  console.log("PASS  endpoint frame and v-infinity contract");
  groups++;

  W.clearCache();
  const opportunityConfig = {
    from: "earth",
    to: "mars",
    departureStart: "2005-06-01T00:00:00Z",
    departureEnd: "2005-11-28T00:00:00Z",
    departureCount: 61,
    tofMinDays: 120,
    tofMaxDays: 360,
    tofCount: 61,
  };
  const opportunity = W.evaluateGrid(opportunityConfig);
  const minimum = opportunity.minima.c3;
  assert.strictEqual(opportunity.width, 61, "departure axis width");
  assert.strictEqual(opportunity.height, 61, "TOF axis height");
  assert.strictEqual(opportunity.cells.length, 3721, "bounded grid cell count");
  assert.strictEqual(opportunity.validCells, opportunity.totalCells,
    "classic opportunity grid has unexpected Lambert holes");
  assert.ok(minimum.c3 > 15 && minimum.c3 < 17,
    `classic opportunity minimum C3 is implausible: ${minimum.c3}`);
  const minimumDate = A.jdToDate(minimum.departureJD);
  assert.strictEqual(minimumDate.getUTCFullYear(), 2005,
    "classic opportunity year shifted");
  assert.strictEqual(minimumDate.getUTCMonth(), 7,
    "classic opportunity should fall in August");
  assert.ok(minimum.tofDays >= 180 && minimum.tofDays <= 215,
    `classic opportunity TOF is implausible: ${minimum.tofDays} d`);
  assert.strictEqual(opportunity.cells[minimum.index], minimum,
    "minimum must refer to its row-major grid cell");
  assert.ok(Object.isFrozen(opportunity) && Object.isFrozen(opportunity.cells),
    "completed grids should be immutable");
  console.log("PASS  bounded Earth-Mars opportunity grid");
  groups++;

  // A normalized config key should make repeat searches O(1), return the
  // exact immutable value, and preserve deterministic minima/ranges.
  const repeat = W.evaluateGrid({ ...opportunityConfig });
  assert.strictEqual(repeat, opportunity, "identical grid config missed the cache");
  const cache = W.cacheInfo();
  assert.strictEqual(cache.size, 1, "unexpected cache entry count");
  assert.strictEqual(cache.hits, 1, "repeat search did not register a cache hit");
  assert.strictEqual(cache.misses, 1, "first search should be the only cache miss");
  console.log("PASS  deterministic grid cache");
  groups++;

  assert.throws(() => W.evaluateGrid({
    from: "earth",
    to: "mars",
    departureStart: "2005-01-01",
    departureEnd: "2006-01-01",
    departureCount: 201,
    tofMinDays: 100,
    tofMaxDays: 400,
    tofCount: 101,
  }), /maximum is 20000/, "oversized grid should fail before Lambert work");
  assert.throws(() => W.evaluateCell({
    from: "earth", to: "earth", departureJD: 2451545, tofDays: 100,
  }), /must be different/, "same-body window should be rejected");
  assert.throws(() => W.evaluateCell({
    from: "earth", to: "mars", centralBody: "jupiter",
    departureJD: 2451545, tofDays: 100,
  }), /common ancestor/, "unrelated Lambert center should be rejected");
  console.log("PASS  grid and pair bounds");
  groups++;

  const chunkConfig = {
    from: "earth",
    to: "mars",
    departureStart: "2005-08-06T00:00:00Z",
    departureEnd: "2005-08-14T00:00:00Z",
    departureCount: 5,
    tofMinDays: 192,
    tofMaxDays: 200,
    tofCount: 3,
  };
  W.clearCache();
  const synchronous = W.evaluateGrid(chunkConfig);
  const canonical = JSON.stringify(synchronous);
  W.clearCache();
  const chunks = [];
  let yields = 0;
  let asyncResult = null;
  for await (const progress of W.iterateGrid(chunkConfig, {
    chunkSize: 4,
    yieldControl: () => { yields++; return Promise.resolve(); },
  })) {
    chunks.push([progress.startIndex, progress.endIndex, progress.done,
      progress.fromCache]);
    asyncResult = progress.grid;
  }
  assert.deepStrictEqual(chunks, [
    [0, 4, false, false],
    [4, 8, false, false],
    [8, 12, false, false],
    [12, 15, true, false],
  ], "async iterator chunk boundaries changed");
  assert.strictEqual(yields, 3, "iterator should yield control only between chunks");
  assert.strictEqual(JSON.stringify(asyncResult), canonical,
    "chunked and synchronous grid results differ");
  console.log("PASS  deterministic scheduled async iterator");
  groups++;

  const callbackChunks = [];
  const callbackResult = await W.evaluateGridAsync(chunkConfig, {
    chunkSize: 2,
    onChunk: (progress) => callbackChunks.push(progress),
  });
  assert.strictEqual(callbackResult, asyncResult,
    "async callback wrapper should reuse the completed cache entry");
  assert.strictEqual(callbackChunks.length, 1,
    "a cached async request should report one completed chunk");
  assert.ok(callbackChunks[0].done && callbackChunks[0].fromCache,
    "cached async completion flags are incorrect");
  console.log("PASS  callback wrapper and cached completion");
  groups++;

  console.log(`\n${groups}/${groups} launch-window test groups clean`);
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
