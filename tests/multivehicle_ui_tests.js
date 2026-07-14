/* Static contracts for the native multi-vehicle Planner surface.
 * Run with: node tests/multivehicle_ui_tests.js */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const index = read("index.html");
const css = read("css/theme.css");
const ui = read("js/ui.js");
const renderer = read("js/renderer.js");

for (const id of ["vehicleBar", "vehicleSel", "vehicleColor", "btnVehicleAdd",
  "btnVehicleRemove", "vehicleCount", "hudVehicle", "formationReadout"]) {
  assert(new RegExp(`id="${id}"`).test(index), `Planner shell is missing #${id}`);
}

assert(/function buildVehicleSelector\(\)[\s\S]*if \(!host \|\| !select \|\| !S\.mission\) return/.test(ui),
  "mission-vehicle DOM wiring must remain guarded for classic.html");
assert(/definitions\.length >= 8/.test(ui) && /slice\(0, 7\)/.test(ui),
  "vehicle editor must preserve the eight-total-vehicle cap");
assert(/activeSegments\(\)/.test(ui) && /activeSpacecraft\(\)/.test(ui) &&
  /activeVehicleResult\(\)/.test(ui),
"vehicle selection must route segment, spacecraft, and result state together");
assert(/refreshActivePlaybackEvents\(\)[\s\S]*activeVehicleResult\(\)/.test(ui) &&
  /refreshActiveGroundTrackLegs\(\)[\s\S]*activeVehicleResult\(\)/.test(ui),
"Auto Time/camera and Track must use the selected vehicle");
assert(/function syncActivePlaybackBounds\(keepTime\)[\s\S]*resultTimeBounds\(activeVehicleResult\(\)\)/.test(ui) &&
  /const playbackEnd = resultTimeBounds\(activeVehicleResult\(\)\)\.end/.test(ui),
"selected-vehicle playback must remain inside that vehicle's state coverage");
assert(/select\.onchange = \(\) => \{[\s\S]*analysisAfterRecompute\(\);[\s\S]*refreshNativeFormationAnalysis\(false\);[\s\S]*buildTicks\(\);/.test(ui),
"vehicle selection must rebuild ticks after clearing the previous branch's analysis events");
assert(/function buildTicks\(\)[\s\S]*const bounds = resultTimeBounds\(active\)[\s\S]*grp\[0\]\.t - bounds\.start/.test(ui) &&
  /function buildEclipseBands\(\)[\s\S]*start - bounds\.start/.test(ui),
"timeline ticks and eclipse bands must align to the selected vehicle's scrub domain");
assert(/function gifTimes\(result,[\s\S]*resultTimeBounds\(result\)/.test(ui) &&
  /const exportResult = activeVehicleResult\(\)/.test(ui) &&
  /result: exportResult, tNow: t, epochJD: exportResult\.epochJD/.test(ui),
"GIF timing, cameras, and Track overlays must use the selected native vehicle");
assert(/function comparisonDescriptors\(comparison\)[\s\S]*result: active/.test(ui) &&
  /const primary = S\.result\.vehicleResults && S\.result\.vehicleResults\.primary \|\| S\.result;[\s\S]*primary\.events\.find/.test(ui),
"fleet analysis must use a coherent selected result while root mission windows remain primary-only");
assert(/const missionResult = ME\.recompute\(mission\);[\s\S]*missionResult\.vehicleResults && missionResult\.vehicleResults\.primary/.test(ui) &&
  /computeEclipseReport\(\)[\s\S]*ME\.sampleAtTime\(vehicleResult, time\)/.test(ui) &&
  /computeAccessReport\(\)[\s\S]*ME\.sampleAtTime\(vehicleResult, time\)/.test(ui),
"comparison, eclipse, and access analysis must not mix aggregate bounds with primary samples");
assert(/function uncertaintyEventWindow[\s\S]*const vehicleResult = activeVehicleResult\(\)[\s\S]*vehicleResult\.samples/.test(ui) &&
  /vehicleId: S\.activeVehicleId, vehicleResult: activeVehicleResult\(\)/.test(ui) &&
  /function populateJ2Coasts\(\)[\s\S]*const segments = activeSegments\(\)/.test(ui),
"uncertainty and J2 tools must remain on the selected native vehicle");
assert(/best\.vehicleId[\s\S]*vehicleSelect\.onchange\(\)/.test(ui) &&
  /nativeMissionVehicle[\s\S]*viewShip\(\)/.test(ui),
"timeline and canvas picking must switch native vehicles");
assert(/for \(const id of \["hudSeg", "hudCentral", "hudAlt", "hudVel", "hudApsis", "hudTgt"\]\)/.test(ui),
  "an unavailable branch must clear stale primary telemetry");
assert(/targetVehicleResult\.samples\[0\]\.t[\s\S]*targetVehicleResult\.samples\[targetVehicleResult\.samples\.length - 1\]\.t/.test(ui),
  "formation target telemetry must require simultaneous coverage");
assert(/function refreshNativeFormationAnalysis\(force\)[\s\S]*MM\.findClosestApproach[\s\S]*MM\.findConjunctions/.test(ui) &&
  /AN\.nativeConjunctionEvents/.test(ui) && /closest \$\{esc\(ME\.fmtKm\(closest\.range\)\)\}/.test(ui),
"native mission vehicles must expose closest approach and conjunction intervals");
assert(/\["dryKg", "propKg", "isp"\]\.includes\(fld\.k\)\) scheduleRecompute\(\)/.test(ui),
  "vehicle mass/propulsion edits must recompute dependent physics");
assert(/vehicle\.color = color\.value;[\s\S]*result\.color = color\.value;[\s\S]*MTPRender\.invalidateCache\(\)/.test(ui),
  "trajectory color edits should invalidate rendering without re-running physics");
assert(/function updatePropellant\(\)[\s\S]*if \(ev\.kind === "burn_end"\) continue/.test(ui),
"finite-burn end report events must not consume propellant a second time");
assert(/jsonImportFile[\s\S]*ME\.applySegmentDefaults\(s, \{ legacyLaunch:[\s\S]*ME\.applySegmentDefaults\(segment, \{ legacyLaunch:[\s\S]*const definitions/.test(ui),
"JSON import must hydrate schema defaults before validating vehicle references");

for (const theme of ["blueprint", "cinematic"]) {
  assert(new RegExp(`\\[data-theme="${theme}"\\] #vehicleBar`).test(css),
    `#vehicleBar needs a ${theme} treatment`);
  assert(new RegExp(`\\[data-theme="${theme}"\\] \\.vehicle-bar-controls select`).test(css),
    `vehicle controls need a ${theme} treatment`);
}
assert(/\.vehicle-bar-controls\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 30px 28px 28px/s.test(css),
  "vehicle controls need a bounded non-overlapping grid");
assert(/\.vehicle-bar-controls button:disabled/.test(css) &&
  /button:hover:not\(:disabled\)/.test(css),
"vehicle limits and primary-only controls need a visible disabled state");
assert(/@media \(max-width: 760px\)[\s\S]*#vehicleBar/.test(css),
  "vehicle editor needs a compact-width contract");

assert(/fleetTrajectoryCache\(craft\.result,[\s\S]*!!craft\.nativeMissionVehicle/.test(renderer) &&
  /cache\.denseDocked\[index\]/.test(renderer) &&
  /nativeFleetPointLimit\(nativeFleetCount\)/.test(renderer) &&
  /fleetVisibleRange\(cached\.times, craft\.localTime/.test(renderer) &&
  /Math\.ceil\(\(visible\.end - visible\.start\) \/ nativePointLimit\)/.test(renderer) &&
  /FLEET_EXACT_POINT_CAP - samples\.length/.test(renderer),
"native paths must be exact, joined-tail-safe, and bounded for rendering");
assert(/if \(craft\.nativeMissionVehicle\) g\.setLineDash\(\[4, 6\]\)/.test(renderer) &&
  /pathWindowS: result\.role === "rendezvous-target" \? 2 \* 3600 : null/.test(ui) &&
  /!fleetTimeCovered\(cached\.times, craft\.localTime\)/.test(renderer) &&
  /nativeFleetPathWindow\(craft\.result, craft\.localTime\)/.test(renderer),
"inactive native paths should be dashed, coverage-gated, and locally windowed");
assert(/const activeWindowS = activeTrajectoryWindow\(result, shipSmp\)/.test(renderer) &&
  /Math\.abs\(ev\.t - tNow\) > activeWindowS \/ 2/.test(renderer),
"repeated CR3BP cycles and correction markers should stay within the current display cycle");
assert(/let povRestoreFrame = null/.test(ui) &&
  /S\.frameBody = povRestoreFrame/.test(ui),
"Planner POV should restore the user's prior reference frame on exit");
assert(/const resumePlayback = !!S\.playing/.test(ui) &&
  /if \(resumePlayback\)[\s\S]*S\.playing = true/.test(ui) &&
  /S\.frameBody = "inertial";[\s\S]*S\.options\.lagrange = false/.test(ui),
"mission replacement must preserve active playback and clear stale view state");
assert(/function hasComplexNativeScene\(\)[\s\S]*results\.length > 1/.test(ui) &&
  /S\.speedMode === "auto" \|\| hasComplexNativeScene\(\)/.test(ui) &&
  /MANUAL_RENDER_INTERVAL_MS = 1000 \/ 60/.test(ui),
"high-refresh playback must retain simulation timing while bounding canvas repaint work");
assert(/const shipLabel = String\(scene\.shipName \|\| "SC"\)/.test(renderer),
  "the active marker must identify the selected vehicle");

console.log("Native multi-vehicle UI checks passed: guarded editor, both themes, active views, and bounded exact paths.");
