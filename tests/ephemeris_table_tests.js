/* Bounded offline ephemeris-table regressions. Run with:
 *   node tests/ephemeris_table_tests.js */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

for (const file of ["constants.js", "kepler.js", "ode.js", "ephemeris-table.js",
  "force-models.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "js", file), "utf8"),
    { filename: file });
}

const C = globalThis.AstroConst;
const T = globalThis.MissionEphemerisTable;
const F = globalThis.MissionForceModels;
const epochJD = 2461041.5;
let groups = 0;

function providerWithBodies(bodies) {
  return T.createProvider({
    source: "NASA/JPL Horizons synthetic regression vectors",
    generatedAt: "2026-07-13T00:00:00Z",
    center: "500@10 (Sun center)",
    frame: "ICRF / ecliptic J2000",
    timeScale: "TDB",
    units: "km and km/s",
    bodies,
  });
}

// Cubic Hermite interpolation must honor both position and velocity and
// return null, rather than extrapolating, outside explicit coverage.
{
  const tenSecondsJD = 10 / C.DAY;
  const provider = providerWithBodies({
    earth: { sourceId: "399", cadenceSeconds: 10, samples: [
      [epochJD, 0, 2, 3, 0, -1, 0.5],
      [epochJD + tenSecondsJD, 100, -8, 8, 20, -1, 0.5],
    ] },
  });
  const middle = provider.stateAt("earth", epochJD + 5 / C.DAY);
  assert.ok(Math.abs(middle.r[0] - 25) < 5e-4,
    "Hermite lookup should exactly reproduce the quadratic midpoint");
  assert.ok(Math.abs(middle.v[0] - 10) < 1e-4,
    "Hermite velocity should be the derivative of interpolated position");
  assert.ok(Math.abs(middle.r[1] + 3) < 5e-4 && Math.abs(middle.v[1] + 1) < 5e-6,
    "linear position/velocity axes should remain coherent");
  assert.strictEqual(provider.stateAt("earth", epochJD - 1e-6), null,
    "provider must not extrapolate before coverage");
  assert.strictEqual(provider.stateAt("earth", epochJD + tenSecondsJD + 1e-6), null,
    "provider must not extrapolate after coverage");
  assert.strictEqual(provider.stateAt("mars", epochJD), null,
    "provider must not invent missing bodies");
  const coverage = provider.coverage("earth");
  assert.strictEqual(coverage.sampleCount, 2);
  assert.strictEqual(coverage.sourceId, "399");
  assert.strictEqual(provider.metadata.extrapolation, "forbidden");
  assert.match(provider.metadata.source, /JPL Horizons/);
  assert.match(provider.metadata.interpolation, /cubic Hermite/);
  console.log("PASS  bounded Hermite state and velocity lookup");
  groups++;
}

// A generated bundle adapter must retain source/coverage metadata and convert
// UTC milliseconds to Julian dates without changing exact endpoint states.
{
  const startMs = Date.UTC(2026, 0, 1);
  const stopMs = startMs + 60000;
  const provider = T.fromHorizonsBundle({
    source: "NASA/JPL Horizons release-generated vectors",
    generatedAt: "2026-01-01T01:00:00Z",
    referenceCenter: "500@10 (Sun center)",
    referenceFrame: "ICRF / ecliptic J2000",
    referenceSampleTimeScale: "UTC",
    units: "km and km/s",
    referenceBodies: {
      earth: { horizonsId: "399", stepSeconds: 60, samples: [
        [startMs, 1, 2, 3, 4, 5, 6], [stopMs, 241, 302, 363, 4, 5, 6],
      ] },
    },
  });
  const startJD = T.UNIX_EPOCH_JD + startMs / 86400000;
  assert.deepStrictEqual(provider.stateAt("earth", startJD).r, [1, 2, 3]);
  assert.strictEqual(provider.coverage("earth").cadenceSeconds, 60);
  assert.strictEqual(provider.coverage("earth").sourceId, "399");
  assert.strictEqual(provider.metadata.timeScale, "UTC");
  console.log("PASS  generated Horizons bundle adapter metadata");
  groups++;
}

// Adaptive force propagation can explicitly select a bounded provider. It
// must use its states, expose its provenance, and fail closed at the edge.
{
  const durationS = 1200;
  const provider = providerWithBodies({
    earth: { samples: [
      [epochJD, 0, 0, 0, 0, 0, 0],
      [epochJD + durationS / C.DAY, 0, 0, 0, 0, 0, 0],
    ] },
  });
  const radius = 7000;
  const speed = Math.sqrt(C.BODIES.earth.mu / radius);
  const result = F.propagate({
    epochJD, r0: [radius, 0, 0], v0: [0, speed, 0], durationS,
    bodies: ["earth"], ephemerisProvider: provider, maxStep: 10, rtol: 1e-11,
  });
  assert.strictEqual(result.status, "finished");
  assert.strictEqual(result.ephemerisMetadata.source, provider.metadata.source);
  const initialEnergy = speed * speed / 2 - C.BODIES.earth.mu / radius;
  const finalRadius = Math.hypot(...result.rFinal);
  const finalSpeed = Math.hypot(...result.vFinal);
  const finalEnergy = finalSpeed * finalSpeed / 2 - C.BODIES.earth.mu / finalRadius;
  assert.ok(Math.abs((finalEnergy - initialEnergy) / initialEnergy) < 2e-10,
    "table-driven point mass should preserve the two-body energy bound");
  assert.throws(() => F.propagate({
    epochJD, r0: [radius, 0, 0], v0: [0, speed, 0], durationS: durationS + 1,
    bodies: ["earth"], ephemerisProvider: provider, maxStep: 10,
  }), /outside the bounded table/,
  "force propagation must not extrapolate a selected table");
  assert.throws(() => F.propagate({
    epochJD, r0: [radius, 0, 0], v0: [0, speed, 0], durationS: 10,
    bodies: ["mars"], ephemerisProvider: provider,
  }), /no bounded table for 'mars'/,
  "strict providers must not silently mix in catalog bodies");
  console.log("PASS  table-selected force propagation and fail-closed coverage");
  groups++;
}

// Metadata and work bounds are part of the provider contract, not optional
// prose: malformed/unbounded assets are rejected before use.
{
  assert.throws(() => T.createProvider({ center: "Sun", frame: "J2000",
    timeScale: "TDB", units: "km and km/s", bodies: { earth: { samples: [
      [1, 0, 0, 0, 0, 0, 0], [2, 0, 0, 0, 0, 0, 0],
    ] } } }), /source metadata/);
  assert.throws(() => providerWithBodies({ earth: { samples: [
    [epochJD, 0, 0, 0, 0, 0, 0], [epochJD, 1, 0, 0, 0, 0, 0],
  ] } }), /strictly increasing/);
  assert.throws(() => T.createProvider({ source: "test", center: "Sun", frame: "J2000",
    timeScale: "TDB", units: "km and km/s", bodies: {
      earth: { samples: [[1, 0, 0, 0, 0, 0, 0], [2, 0, 0, 0, 0, 0, 0]] },
      mars: { samples: [[1, 0, 0, 0, 0, 0, 0], [2, 0, 0, 0, 0, 0, 0]] },
    } }, { maxBodies: 1 }), /body cap/);
  console.log("PASS  provider metadata and resource bounds");
  groups++;
}

console.log(`\n${groups}/${groups} ephemeris-table test groups clean`);
