/* Offline shell and generated schema contracts. Run with:
 *   node tests/offline_schema_tests.js */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const offline = read("js/offline.js");
const worker = read("sw.js");
const schemaPage = read("schema.html");
const schemaModule = read("js/mission-schema.js");
const schema = JSON.parse(read("docs/mission.schema.json"));
const { MS } = require("./harness.js");

assert(/\^https\?:\$/.test(offline) && /serviceWorker\.register\("\.\/sw\.js"/.test(offline),
  "registration must be HTTP(S)-only and file-safe");
for (const asset of ["index.html", "classic.html", "live.html", "schema.html",
  "planner-ephemeris-data.js", "textures-data.js"]) {
  assert(worker.includes(asset), "offline manifest missing " + asset);
}
assert(/request\.mode === "navigate"/.test(worker) && /caches\.match/.test(worker),
  "service worker must provide an offline navigation fallback");
assert(schemaPage.includes("js/mission-schema.js") && schemaPage.includes("js/schema-doc.js"),
  "schema page must load its pure generator before the renderer");
assert(/Object\.entries\(segmentTypes\)/.test(schemaModule),
  "schema must be generated from live segment definitions");
assert(schema.$schema === "https://json-schema.org/draft/2020-12/schema");
assert(schema.$defs && Object.keys(schema.$defs).length >= 18,
  "generated schema must contain every current segment type");
assert(schema.properties.segments.items.oneOf.length === Object.keys(schema.$defs).length,
  "segment union and generated definitions must remain synchronized");
assert.deepStrictEqual(schema.properties.format.enum, ["mtp-mission-1", "mtp-mission-2"],
  "portable schema must identify both legacy and native-vehicle formats");
assert.strictEqual(schema.properties.vehicles.maxItems, 7,
  "portable schema must retain the seven-secondary-vehicle cap");
for (const preset of MS.PRESETS) {
  const vehicles = [{ id: "primary", segments: preset.segments }]
    .concat(preset.vehicles || []);
  for (const vehicle of vehicles) for (const segment of vehicle.segments) {
    const definition = schema.$defs[segment.type];
    assert(definition, `schema missing ${segment.type} used by ${preset.id}/${vehicle.id}`);
    for (const key of definition.required || []) {
      assert(Object.prototype.hasOwnProperty.call(segment, key),
        `${preset.id}/${vehicle.id}/${segment.type} lacks schema-required key ${key}`);
    }
  }
}
for (const type of ["separate", "rendezvous", "dock"])
  assert.strictEqual(schema.$defs[type].properties[
    type === "separate" ? "fromVehicle" : "targetVehicle"]["x-mtp-ref"], "vehicle",
  `${type} schema must identify its mission-local vehicle reference`);
assert.deepStrictEqual(schema.$defs.coast.required, ["type"],
  "runtime-defaulted Coast fields must remain optional in portable JSON");
assert.deepStrictEqual(schema.$defs.gp_orbit.required.sort(), ["line1", "line2", "type"],
  "GP orbit must require its two element lines");

console.log(`Offline/schema checks passed: ${Object.keys(schema.$defs).length} generated segment definitions.`);
