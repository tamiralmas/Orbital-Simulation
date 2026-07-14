/* Headless engine loader for Node - no DOM, no build step.
 * Loads the engine scripts in dependency order into this context and
 * exposes the same globals the browser sees. Used by run_tests.js and
 * ad-hoc physics experiments (`node -e` or scratch scripts). */
"use strict";
const fs = require("fs"), vm = require("vm"), path = require("path");
const ROOT = path.join(__dirname, "..", "js");
global.performance = require("perf_hooks").performance;
for (const f of ["constants.js", "kepler.js", "targeting.js", "ode.js",
  "cr3bp.js", "libration.js", "windows.js", "analysis.js", "environment-models.js",
  "ephemeris-table.js", "planner-ephemeris-data.js", "planner-ephemeris.js",
  "force-models.js", "sgp4.js", "uncertainty.js", "propagator.js",
  "missions.js", "multicraft.js"])
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), "utf8"), { filename: f });
const C = globalThis.AstroConst, A = globalThis.Astro,
      ME = globalThis.MissionEngine, MS = globalThis.Missions;
const DAY = C.DAY;
function dstr(epochJD, t) { return A.jdToStr(epochJD + t / DAY).slice(0, 16); }
function missionVehicles(mission) {
  const vehicles = [{
    id: "primary",
    segments: Array.isArray(mission && mission.segments) ? mission.segments : [],
  }];
  for (const vehicle of Array.isArray(mission && mission.vehicles) ? mission.vehicles : []) {
    vehicles.push({
      id: String(vehicle && vehicle.id || "(unnamed)"),
      segments: Array.isArray(vehicle && vehicle.segments) ? vehicle.segments : [],
    });
  }
  return vehicles;
}
function runMission(m) {
  const r = ME.recompute(m);
  const errs = [];
  missionVehicles(m).forEach((vehicle) => vehicle.segments.forEach((s, i) =>
    (s._warn || []).forEach((w) => errs.push(
      `  ${vehicle.id} seg#${i + 1} ${s.type} [${w.level}] ${w.msg}`))));
  for (const warning of r.vehicleWarnings || [])
    errs.push(`  mission vehicles [warning] ${warning}`);
  return { r, errs };
}
module.exports = { C, A, ME, MS, runMission, dstr, missionVehicles };
