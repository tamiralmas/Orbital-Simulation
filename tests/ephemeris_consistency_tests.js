/* Catalog position/velocity coherence regressions.
 * Run with: node tests/ephemeris_consistency_tests.js */
"use strict";

const assert = require("assert");
const { C, A } = require("./harness.js");

const jd = A.dateToJD("2026-07-13T00:00:00Z");
let checked = 0;
let worst = { id: null, error: 0 };

function centralDifference(bodyId, dt) {
  const before = A.bodyWorld(bodyId, jd - dt / C.DAY);
  const after = A.bodyWorld(bodyId, jd + dt / C.DAY);
  return A.V.scale(A.V.sub(after, before), 1 / (2 * dt));
}

for (const body of Object.values(C.BODIES)) {
  if (!body.parent) continue;
  // Richardson cancellation permits a long enough interval to avoid Julian-
  // date floating-point quantization while removing short-period truncation.
  const d60 = centralDifference(body.id, 60);
  const d30 = centralDifference(body.id, 30);
  const finiteDifference = A.V.add(A.V.scale(d30, 4 / 3), A.V.scale(d60, -1 / 3));
  const analytic = A.bodyWorldVel(body.id, jd);
  const error = A.V.mag(A.V.sub(finiteDifference, analytic));
  const scale = Math.max(A.V.mag(analytic), 1e-6);
  const relative = error / scale;
  assert.ok(relative < 2e-7,
    `${body.id} bodyWorld/bodyWorldVel mismatch ${relative.toExponential(3)}`);
  if (relative > worst.error) worst = { id: body.id, error: relative };
  checked++;
}

assert.ok(checked >= 30, "too few catalog bodies were checked");
console.log(`PASS  ${checked} coherent catalog state derivatives; worst ${worst.id} ` +
  `${worst.error.toExponential(3)} relative`);
