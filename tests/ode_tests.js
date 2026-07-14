/* Focused tests for the dependency-free Dormand-Prince 5(4) integrator.
 * Run with: node tests/ode_tests.js */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "js", "ode.js"), "utf8"),
  { filename: "ode.js" });

const { integrate, ODEError } = globalThis.AstroODE;

function near(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    message + `: expected ${expected}, got ${actual}`);
}

function expectCode(code, fn) {
  assert.throws(fn, (error) => error instanceof ODEError && error.code === code,
    "expected AstroODEError code " + code);
}

// Dense sampling must return exactly the requested epochs while retaining the
// fifth-order endpoint accuracy of the adaptive solution.
{
  const times = Array.from({ length: 11 }, (_, i) => i / 10);
  const result = integrate((t, y) => [y[0]], 0, [1], 1, {
    rtol: 1e-11,
    atol: 1e-13,
    outputTimes: times,
  });
  assert.strictEqual(result.status, "finished");
  assert.deepStrictEqual(result.t, times);
  result.t.forEach((time, i) => near(result.y[i][0], Math.exp(time), 2e-10,
    "dense exponential sample"));
  near(result.yFinal[0], Math.E, 2e-11, "exponential endpoint");
  assert.ok(result.stats.acceptedSteps > 0 && result.stats.rhsEvaluations > 0);

  // The same inputs must make identical step decisions and results.
  const repeat = integrate((t, y) => [y[0]], 0, [1], 1, {
    rtol: 1e-11,
    atol: 1e-13,
    outputTimes: times,
  });
  assert.deepStrictEqual(repeat.stats, result.stats);
  assert.deepStrictEqual(repeat.y, result.y);
}

// Backward propagation and generated fixed output use descending epochs and
// finish on the exact caller-supplied endpoint.
{
  const result = integrate((t, y) => [y[0]], 1, [Math.E], 0, {
    rtol: 1e-11,
    atol: 1e-13,
    outputStep: 0.2,
  });
  assert.deepStrictEqual(result.t, [1, 0.8, 0.6, 0.3999999999999999,
    0.19999999999999996, 0]);
  near(result.yFinal[0], 1, 3e-11, "backward exponential endpoint");
  result.t.forEach((time, i) => near(result.y[i][0], Math.exp(time), 3e-10,
    "backward dense sample"));

  const decimalEndpoint = integrate(() => [1], 0, [0], 0.3, { outputStep: 0.1 });
  assert.deepStrictEqual(decimalEndpoint.t, [0, 0.1, 0.2, 0.3],
    "floating-point outputStep generated a duplicate endpoint");
}

// A vector oscillator exercises per-component tolerances and long-running
// conservative dynamics without depending on the current mission engine.
{
  const result = integrate((t, y) => [y[1], -y[0]], 0, [1, 0], 20 * Math.PI, {
    rtol: [1e-10, 1e-10],
    atol: [1e-12, 1e-12],
    maxStep: 0.25,
  });
  near(result.yFinal[0], 1, 2e-9, "oscillator position after ten periods");
  near(result.yFinal[1], 0, 2e-9, "oscillator velocity after ten periods");
  const energy = 0.5 * (result.yFinal[0] ** 2 + result.yFinal[1] ** 2);
  near(energy, 0.5, 2e-9, "oscillator energy");
}

// A normalized circular two-body orbit is a project-specific six-state check
// of position/velocity coupling, inverse-cube acceleration, and conservation.
{
  const gravity = (t, y) => {
    const radius = Math.hypot(y[0], y[1], y[2]);
    const factor = -1 / (radius * radius * radius);
    return [y[3], y[4], y[5], factor * y[0], factor * y[1], factor * y[2]];
  };
  const result = integrate(gravity, 0, [1, 0, 0, 0, 1, 0], 2 * Math.PI, {
    rtol: 1e-11,
    atol: 1e-13,
    maxStep: 0.1,
  });
  const expected = [1, 0, 0, 0, 1, 0];
  result.yFinal.forEach((value, i) => near(value, expected[i], 2e-9,
    "circular two-body state component " + i));
  const radius = Math.hypot(...result.yFinal.slice(0, 3));
  const speed = Math.hypot(...result.yFinal.slice(3));
  near(0.5 * speed * speed - 1 / radius, -0.5, 2e-10,
    "circular two-body specific energy");
}

// Terminal events are located through the accepted-step dense interpolant.
// A downward-only event at the same zero must be ignored.
{
  const result = integrate((t, y) => [y[0]], 0, [1], 2, {
    rtol: 1e-11,
    atol: 1e-13,
    outputStep: 0.1,
    events: [
      { name: "ignored downward", fn: (t, y) => y[0] - 2, direction: -1 },
      { name: "double", fn: (t, y) => y[0] - 2, direction: 1, terminal: true },
    ],
  });
  assert.strictEqual(result.status, "event");
  assert.strictEqual(result.events.length, 1);
  assert.strictEqual(result.events[0].name, "double");
  near(result.tFinal, Math.log(2), 2e-10, "terminal event time");
  near(result.yFinal[0], 2, 2e-10, "terminal event state");
  assert.ok(result.t.every((time) => time <= result.tFinal));
}

// Backward event direction is defined in chronological time, matching common
// astrodynamics event conventions rather than integration order.
{
  const result = integrate((t) => [1], 2, [2], 0, {
    events: [{ name: "chronological rise", fn: (t, y) => y[0] - 1,
      direction: 1, terminal: true }],
  });
  assert.strictEqual(result.status, "event");
  near(result.tFinal, 1, 1e-11, "backward event time");
  near(result.yFinal[0], 1, 1e-11, "backward event state");
}

// Zero-duration integration is well-defined and can report an initial event
// without evaluating the derivative.
{
  let calls = 0;
  const result = integrate(() => { calls++; return [0]; }, 4, [7], 4, {
    events: [{ fn: (t, y) => y[0] - 7, terminal: true, name: "initial" }],
  });
  assert.strictEqual(result.status, "event");
  assert.strictEqual(result.tFinal, 4);
  assert.strictEqual(result.events.length, 1);
  assert.strictEqual(calls, 0);
}

// Every unbounded-work failure carries a stable code and useful diagnostics.
expectCode("MAX_STEPS_EXCEEDED", () => integrate((t, y) => [1], 0, [0], 10, {
  maxStep: 1,
  initialStep: 1,
  maxSteps: 1,
}));
expectCode("MAX_OUTPUT_POINTS", () => integrate((t, y) => [1], 0, [0], 10, {
  outputStep: 0.1,
  maxOutputPoints: 10,
}));
expectCode("MAX_EVENTS_EXCEEDED", () => integrate((t, y) => [1], 0, [0], 1, {
  maxEvents: 0,
  events: [{ fn: (t, y) => y[0] }],
}));
expectCode("MIN_STEP_EXCEEDED", () => integrate((t, y) => [1000 * y[0]], 0, [1], 1, {
  rtol: 1e-12,
  atol: 1e-14,
  initialStep: 0.1,
  minStep: 0.1,
}));
expectCode("NONFINITE_DERIVATIVE", () => integrate(() => [NaN], 0, [1], 1));

// Input contracts reject ambiguous or unsafe requests before integration.
expectCode("INVALID_ARGUMENT", () => integrate((t, y) => [0], 0, [1], 1, {
  outputTimes: [0, 0.8, 0.7, 1],
}));
expectCode("INVALID_ARGUMENT", () => integrate((t, y) => [0], 0, [1], 1, {
  rtol: 0,
  atol: 0,
}));

const relativeOnlyZero = integrate(() => [0], 0, [0], 1, { rtol: 1e-9, atol: 0 });
assert.strictEqual(relativeOnlyZero.yFinal[0], 0,
  "relative-only tolerance failed on an exactly stationary zero component");

console.log("PASS  adaptive Dormand-Prince accuracy");
console.log("PASS  deterministic requested-time dense output");
console.log("PASS  forward/backward propagation");
console.log("PASS  normalized two-body conservation");
console.log("PASS  directional terminal events");
console.log("PASS  bounded-work failures");
