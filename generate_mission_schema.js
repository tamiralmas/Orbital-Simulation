/* Generate docs/mission.schema.json directly from MissionEngine.SEGMENT_TYPES.
 * Run with: node generate_mission_schema.js */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = __dirname;
require(path.join(root, "tests", "harness.js"));
vm.runInThisContext(fs.readFileSync(path.join(root, "js", "mission-schema.js"), "utf8"),
  { filename: "mission-schema.js" });
const schema = globalThis.MissionSchema.build(globalThis.MissionEngine.SEGMENT_TYPES,
  globalThis.AstroConst);
const docs = path.join(root, "docs");
fs.mkdirSync(docs, { recursive: true });
const output = path.join(docs, "mission.schema.json");
fs.writeFileSync(output, JSON.stringify(schema, null, 2) + "\n", "utf8");
console.log(`Wrote ${Object.keys(schema.$defs).length} segment definitions to ${output}.`);
