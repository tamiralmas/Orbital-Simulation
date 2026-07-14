/* Cooperative joint-target solver regressions.
 * Run with: node tests/targeting_async_tests.js */
"use strict";

const assert = require("assert");
require("./harness.js");
const T = globalThis.MissionTargeting;

(async () => {
  const options = {
    target: 12,
    departureBoundsJD: [90, 110],
    tofBoundsDays: [10, 30],
    initialDepartureJD: 100,
    initialTofDays: 20,
    toleranceKm: 1e-8,
    maxIterations: 24,
    maxEvaluations: 80,
    evaluate: ({ departureJD, tofDays }) => ({
      valid: true,
      achieved: 2 * (departureJD - 100) + 3 * (tofDays - 20),
    }),
  };
  const synchronous = T.solveTransferDateTof(options);
  let yields = 0;
  const asynchronous = await T.solveTransferDateTofAsync({ ...options,
    yieldEvery: 1,
    yieldControl: () => { yields++; return Promise.resolve(); },
  });
  assert.deepStrictEqual(asynchronous, synchronous,
    "cooperative solver diverged from the deterministic synchronous report");
  assert.strictEqual(yields, asynchronous.evaluations,
    "cooperative solver did not yield after every requested evaluation");
  assert.ok(asynchronous.variedDeparture && asynchronous.variedTof,
    "cooperative solver did not jointly vary both controls");

  const signal = { aborted: false };
  let abortYields = 0;
  await assert.rejects(T.solveTransferDateTofAsync({ ...options, signal,
    yieldEvery: 1,
    yieldControl: () => {
      abortYields++;
      if (abortYields === 2) signal.aborted = true;
      return Promise.resolve();
    },
  }), (error) => error && error.name === "AbortError");
  assert.strictEqual(abortYields, 2,
    "cooperative target cancellation did not stop at the requested yield");
  console.log("Cooperative joint-target solver passed: parity, per-evaluation yield, cancellation.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
