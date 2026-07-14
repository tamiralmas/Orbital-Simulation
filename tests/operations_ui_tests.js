/* Preset operations defaults and portable mission metadata contracts.
 * Run with: node tests/operations_ui_tests.js */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const ui = fs.readFileSync(path.join(root, "js", "ui.js"), "utf8");
const css = fs.readFileSync(path.join(root, "css", "theme.css"), "utf8");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
const { MS } = require("./harness.js");

const mission = MS.getPreset("leo_disposal_uncertainty");
assert.ok(mission.operations && mission.uncertainty,
  "feature preset metadata was stripped during cloning");
for (const key of ["sensorSwath", "stationMarkers", "eclipse3d",
  "comparisonPreset", "stations"]) {
  assert.ok(Object.prototype.hasOwnProperty.call(mission.operations, key),
    "operations preset missing " + key);
}
assert.match(ui, /applyMissionOperations\(m\)/,
  "mission load does not apply operations defaults");
assert.match(ui, /station\.preset/,
  "preset stations are not distinguished from persistent user stations");
assert.match(ui, /comparisonPreset[\s\S]{0,600}analyzeComparisonCraft\(\)/,
  "preset comparison craft is not initialized");
assert.match(ui, /\["uncertainty", "operations", "targetingValidation"\]/,
  "portable mission export does not preserve analysis metadata");
assert.match(ui, /format:\s*"mtp-mission-2"/,
  "portable mission export does not identify the native-vehicle format");
assert.match(ui, /vehicles:\s*\(S\.mission\.vehicles \|\| \[\]\)\.map\(cleanVehicle\)/,
  "portable mission export does not preserve native vehicle branches");
assert.match(ui, /fld\.t === "text"/,
  "TLE text fields are not editable in segment cards");
assert.match(css, /segment-long-field/,
  "long GP element fields have no responsive layout rule");
for (const script of ["environment-models.js", "ephemeris-table.js",
  "planner-ephemeris-data.js", "planner-ephemeris.js", "sgp4.js",
  "uncertainty.js", "offline.js"]) {
  assert.ok(index.includes(script), "Planner page does not load " + script);
}

console.log("Preset operations/UI contracts passed: Track, stations, eclipses, fleet, TLE, and portable metadata.");
