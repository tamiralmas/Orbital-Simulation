"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const sandbox = {};
sandbox.globalThis = sandbox;
vm.runInNewContext(read("js/deep-space-catalog.js"), sandbox, { filename: "deep-space-catalog.js" });
vm.runInNewContext(read("js/deep-space-archives.js"), sandbox, { filename: "deep-space-archives.js" });

const archives = sandbox.MTP_DEEP_ARCHIVES;
const expectedIds = ["-23", "-24", "-31", "-32", "-82"];
assert(archives && archives.trajectories, "generated Deep archive bundle should load");
assert.strictEqual(archives.schemaVersion, 1);
assert.strictEqual(archives.center, "500@10 (Sun center)");
assert(/ICRF/i.test(archives.frame) && /ecliptic/i.test(archives.frame));
assert(/UTC.*JDTDB/i.test(archives.timeScale), "archive timestamps must disclose JDTDB-to-UTC conversion");
assert(/do not extrapolate/i.test(archives.outOfCoverage));
assert.deepStrictEqual(Object.keys(archives.trajectories).sort(), expectedIds.slice().sort(),
  "archive asset should contain only the five selected-history missions");

const catalogIds = new Set(sandbox.MTPDeepSpaceCatalog.missions.map((mission) => mission.horizonsId));
for (const id of expectedIds) {
  const record = archives.trajectories[id];
  assert(catalogIds.has(id), id + " archive must map to a reviewed Deep 100 entry");
  assert.strictEqual(record.targetId, id);
  assert(record.trajectoryClass === "HISTORY" || record.trajectoryClass === "ARCHIVE");
  assert.strictEqual(record.operationalStatus, "UNVERIFIED");
  assert.strictEqual(record.sourceStepSeconds, 86400);
  assert.strictEqual(record.continuous, true,
    id + " simplified vertices should remain one continuous source path");
  assert(record.sourceSampleCount > record.samples.length,
    id + " should retain a compact geometry-preserving path rather than every source row");
  assert(record.samples.length >= 50, id + " should preserve meaningful encounter geometry");
  assert.strictEqual(record.samples[0][0], record.startMs);
  assert.strictEqual(record.samples[record.samples.length - 1][0], record.stopMs);
  let previous = -Infinity;
  for (const sample of record.samples) {
    assert.strictEqual(sample.length, 4, id + " archive rows are [UTC ms, x, y, z]");
    assert(sample.every(Number.isFinite), id + " archive coordinates must remain finite");
    assert(sample[0] > previous, id + " archive timestamps must be strictly increasing");
    previous = sample[0];
  }
}

assert.strictEqual(archives.trajectories["-82"].trajectoryClass, "ARCHIVE",
  "destroyed Cassini must be presented as archival, never current");
assert(archives.trajectories["-82"].stopMs <= Date.parse("2017-09-15T11:58:00Z"),
  "Cassini archive must stop before the official final source-vector boundary");
for (const id of ["-23", "-24", "-31", "-32"]) {
  assert.strictEqual(archives.trajectories[id].trajectoryClass, "HISTORY");
  assert(archives.trajectories[id].stopMs >= Date.parse("2026-06-27T00:00:00Z") &&
    archives.trajectories[id].stopMs < Date.parse("2026-06-29T00:00:00Z"),
    id + " history should hand off at the current bundle window without including its predictions");
}

const assetBytes = fs.statSync(path.join(ROOT, "js/deep-space-archives.js")).size;
assert(assetBytes < 400000, "selected-history archive should stay compact enough for the buildless Deep page");

const generator = read("get_deep_archives.ps1");
assert(/ssd\.jpl\.nasa\.gov\/api\/horizons\.api/.test(generator) &&
  /CENTER=.*500@10/.test(generator) && /REF_SYSTEM=.*ICRF/.test(generator),
"archive generator should use official Sun-centered Horizons vectors");
assert(/Convert-JdTdbToUnixMsUtc/.test(generator) && /Convert-UnixMsUtcToJdTdb/.test(generator),
  "archive generator should convert source JDTDB and UTC request instants both ways");
assert(/prior to/.test(generator) && /after A\\\.D\\\./.test(generator) && /BoundaryMarginMs/.test(generator),
  "archive generator should clip queries to authoritative two-sided source coverage");
assert(/Compress-ArchiveRows/.test(generator) && /simplificationToleranceKm/.test(generator),
  "archive generator should reproducibly simplify dense source paths");
assert(/\.tmp/.test(generator) && /Move-Item -LiteralPath/.test(generator),
  "archive generator should replace its output atomically");

console.log("Deep archive checks passed: 5 official histories, " +
  Object.values(archives.trajectories).reduce((sum, record) => sum + record.samples.length, 0) +
  " display vertices in " + assetBytes + " bytes.");
