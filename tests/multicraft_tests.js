/* Multi-spacecraft engine regressions. Run with:
 *   node tests/multicraft_tests.js */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "js", "multicraft.js"),
  "utf8"), { filename: "multicraft.js" });

const M = globalThis.MissionMultiCraft;

function near(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected}, got ${actual}`);
}

function craft(id, sample, startTime, endTime, epochJD) {
  return { id, sample, startTime, endTime, epochJD };
}

let groups = 0;

// Absolute epochs are mapped to each provider's local elapsed time. Craft B
// starts 20 seconds later, so the shared domain begins at global t=20 while
// both providers still describe the same inertial trajectory.
{
  const epoch = 2451545;
  const a = craft("early", (t) => ({ position: [t, 0, 0], velocity: [1, 0, 0] }),
    0, 100, epoch);
  const b = craft("late", (t) => ({ position: [20 + t, 0, 0], velocity: [1, 0, 0] }),
    0, 100, epoch + 20 / M.DAY);
  const sync = M.synchronize([a, b], { step: 20 });
  near(sync.referenceEpochJD, epoch, 1e-12, "shared reference epoch");
  near(sync.times[0], 20, 2e-5, "absolute overlap start");
  near(sync.times[sync.times.length - 1], 100, 1e-12, "absolute overlap end");
  sync.frames.forEach((frame) => {
    near(frame.states[0].position[0], frame.states[1].position[0], 2e-5,
      "epoch-aligned position");
  });
  near(sync.frames[0].states[1].localTime, 0, 2e-5, "late craft local start");
  assert.strictEqual(sync.frames.length, sync.series[0].states.length,
    "row and column synchronized views differ");
  assert.ok(Object.isFrozen(sync) && Object.isFrozen(sync.frames[0].states),
    "synchronized output should be immutable");
  console.log("PASS  absolute-epoch synchronized sampling");
  groups++;
}

// Equal-radius, equal-rate circular craft have an analytic constant chord
// separation and exactly zero range rate despite both moving continuously.
{
  const radius = 7000;
  const omega = 0.001;
  const phase = 0.2;
  const circular = (offset) => (t) => {
    const angle = omega * t + offset;
    return {
      position: [radius * Math.cos(angle), radius * Math.sin(angle), 0],
      velocity: [-radius * omega * Math.sin(angle), radius * omega * Math.cos(angle), 0],
    };
  };
  const a = craft("lead", circular(0), 0, 12000);
  const b = craft("trail", circular(phase), 0, 12000);
  const expected = 2 * radius * Math.sin(phase / 2);
  const series = M.relativeSeries(a, b, {
    initialIntervals: 12,
    maxSamples: 101,
    rangeToleranceKm: 1e-8,
    relativeTolerance: 1e-12,
  });
  series.samples.forEach((sample) => {
    near(sample.range, expected, 2e-9, "co-orbital chord range");
    near(sample.rangeRate, 0, 2e-12, "co-orbital range rate");
  });
  assert.ok(series.samples.length <= 101, "adaptive series exceeded its sample cap");
  const closest = M.findClosestApproach(a, b, {
    initialIntervals: 12,
    maxSamples: 101,
  });
  near(closest.range, expected, 2e-9, "co-orbital closest range");
  console.log("PASS  analytic co-orbital relative motion");
  groups++;
}

// A straight-line flyby has an exact closest approach at t=10 s and 3 km.
// The returned bracket comes from sampled range, followed by bounded golden-
// section refinement rather than choosing the nearest grid point.
{
  const moving = craft("moving", (t) => ({
    position: [t, 0, 0], velocity: [1, 0, 0],
  }), 0, 20);
  const fixed = craft("fixed", () => ({
    position: [10, 3, 0], velocity: [0, 0, 0],
  }), 0, 20);
  const closest = M.findClosestApproach(moving, fixed, {
    initialIntervals: 7,
    maxSamples: 129,
    timeTolerance: 1e-8,
    maxRefinementIterations: 128,
  });
  near(closest.t, 10, 1e-6, "linear closest-approach epoch");
  near(closest.range, 3, 1e-10, "linear closest-approach range");
  near(closest.rangeRate, 0, 1e-6, "linear closest-approach range rate");
  assert.ok(closest.iterations > 0 && closest.evaluations < 300,
    "closest-approach refinement was not bounded");
  console.log("PASS  bracketed golden-section closest approach");
  groups++;
}

// For the same linear flyby, a 5 km conjunction sphere is crossed at 6 s and
// 14 s because sqrt((t-10)^2 + 3^2) = 5.
{
  const moving = craft("passer", (t) => ({
    position: [t, 0, 0], velocity: [1, 0, 0],
  }), 0, 20);
  const fixed = craft("target", () => ({
    position: [10, 3, 0], velocity: [0, 0, 0],
  }), 0, 20);
  const report = M.findConjunctions(moving, fixed, {
    thresholdKm: 5,
    initialIntervals: 5,
    maxSamples: 257,
    rangeToleranceKm: 1e-5,
    rootTimeTolerance: 1e-8,
    timeTolerance: 1e-8,
  });
  assert.strictEqual(report.intervals.length, 1, "expected one conjunction interval");
  const interval = report.intervals[0];
  near(interval.start, 6, 1e-6, "conjunction entry");
  near(interval.end, 14, 1e-6, "conjunction exit");
  near(interval.duration, 8, 2e-6, "conjunction duration");
  near(interval.closestApproach.t, 10, 1e-6, "conjunction closest epoch");
  near(interval.closestApproach.range, 3, 1e-10, "conjunction closest range");
  assert.deepStrictEqual(report.events.map((event) => event.type),
    ["conjunction-entry", "closest-approach", "conjunction-exit"]);
  console.log("PASS  conjunction intervals and timeline events");
  groups++;
}

// Tight curvature tolerances force subdivision, but hard limits prevent an
// adversarial provider from creating unbounded work.
{
  const wave = craft("wave", (t) => ({
    position: [t, 10 * Math.sin(8 * t), 0],
    velocity: [1, 80 * Math.cos(8 * t), 0],
  }), 0, 2);
  const origin = craft("origin", () => ({
    position: [0, 0, 0], velocity: [0, 0, 0],
  }), 0, 2);
  const series = M.relativeSeries(wave, origin, {
    initialIntervals: 4,
    maxSamples: 33,
    maxDepth: 20,
    rangeToleranceKm: 1e-12,
    relativeTolerance: 0,
  });
  assert.ok(series.samples.length <= 33, "adaptive series violated maxSamples");
  assert.strictEqual(series.truncated, true,
    "strict curved series should report that its sample budget was exhausted");
  assert.strictEqual(series.evaluations, series.samples.length,
    "sample accounting should be exact");
  console.log("PASS  bounded adaptive relative sampling");
  groups++;
}

// Fleet analysis enumerates every unordered pair, and theme color assignment
// remains stable when the mission manager changes list ordering.
{
  const crafts = ["alpha", "beta", "gamma"].map((id, index) => craft(id, (t) => ({
    position: [index * 10, t, 0], velocity: [0, 1, 0],
  }), 0, 10));
  const colors = M.assignColors(crafts);
  const reversed = M.assignColors(crafts.slice().reverse());
  const byId = Object.fromEntries(colors.map((color) => [color.key, color]));
  reversed.forEach((color) => assert.deepStrictEqual(color, byId[color.key],
    "color metadata changed with list ordering"));
  const analysis = M.analyzeFleet(crafts, {
    count: 3,
    initialIntervals: 2,
    maxSamples: 17,
  });
  assert.strictEqual(analysis.pairs.length, 3, "three craft should produce three pairs");
  assert.strictEqual(new Set(analysis.pairs.map((pair) => pair.pairId)).size, 3,
    "fleet pair ids are not unique");
  console.log("PASS  N-craft pair analysis and deterministic colors");
  groups++;
}

// Invalid and unbounded inputs fail with stable, inspectable error codes.
{
  assert.throws(() => M.synchronize([
    craft("same", () => [0, 0, 0, 0, 0, 0], 0, 1),
    craft("same", () => [0, 0, 0, 0, 0, 0], 0, 1),
  ]), (error) => error instanceof M.MultiCraftError &&
    error.code === "DUPLICATE_CRAFT_ID");
  assert.throws(() => M.synchronize([
    { id: "unbounded", sample: () => [0, 0, 0, 0, 0, 0] },
  ]), (error) => error instanceof M.MultiCraftError &&
    error.code === "MISSING_TIME_DOMAIN");
  assert.throws(() => M.relativeSeries(
    craft("bad", () => [NaN, 0, 0, 0, 0, 0], 0, 1),
    craft("good", () => [0, 0, 0, 0, 0, 0], 0, 1),
  ), (error) => error instanceof M.MultiCraftError && error.code === "INVALID_STATE");
  assert.throws(() => M.findConjunctions(
    craft("one", () => [0, 0, 0, 0, 0, 0], 0, 1),
    craft("two", () => [1, 0, 0, 0, 0, 0], 0, 1),
  ), (error) => error instanceof M.MultiCraftError &&
    error.code === "INVALID_ARGUMENT");
  console.log("PASS  bounded input and state validation");
  groups++;
}

console.log(`\nAll ${groups} multi-spacecraft regression groups passed.`);
