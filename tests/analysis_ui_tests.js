/* Static contracts for the Planner Data and Track analysis workspace. */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const classic = fs.readFileSync(path.join(root, "classic.html"), "utf8");
const ui = fs.readFileSync(path.join(root, "js", "ui.js"), "utf8");
const ground = fs.readFileSync(path.join(root, "js", "groundtrack.js"), "utf8");
const css = fs.readFileSync(path.join(root, "css", "theme.css"), "utf8");

const ids = [
  "dataPane", "analysisStatus", "analysisRefresh", "analysisElements",
  "analysisMetric", "analysisCsv", "analysisCanvas", "analysisTooltip",
  "eclipseCompute", "eclipseSummary", "eclipseIntervals", "eclipseBands", "eclipse3d",
  "accessMask", "accessCompute", "accessCsv", "accessReport", "analysisJ2",
  "stationEditor", "stationName", "stationBody", "stationLat", "stationLon",
  "stationAlt", "stationMask", "stationAdd", "stationEditorStatus", "stationList",
  "j2Coast", "j2Apply", "j2Kepler", "j2Readout", "fleetMission", "fleetAdd", "fleetRemove", "fleetThreshold",
  "fleetAlignEpoch", "fleetList", "fleetReport", "fleetCanvas", "fleetCsv", "gtTools", "gtSwath", "gtFov",
  "gtOffNadir", "gtStations", "gtSwathWidth",
];
for (const id of ids) {
  const occurrences = html.match(new RegExp(`id=["']${id}["']`, "g")) || [];
  assert.strictEqual(occurrences.length, 1,
    `${id} should occur exactly once in index.html`);
}

assert(/class="tabbtn" data-pane="dataPane">Data</.test(html),
  "Data must be a first-class right-panel tab");
assert(/id="paneBtns"[\s\S]*data-pane="dataPane">Data</.test(html),
  "Cinematic transport must expose the same Data pane");
assert(html.indexOf('src="js/analysis.js"') < html.indexOf('src="js/ui.js"') &&
  html.indexOf('src="js/multicraft.js"') < html.indexOf('src="js/ui.js"'),
"analysis engines must load before Planner UI wiring");
assert(classic.indexOf('src="js/analysis.js"') < classic.indexOf('src="js/ui.js"') &&
  classic.indexOf('src="js/multicraft.js"') < classic.indexOf('src="js/ui.js"'),
"classic shared UI must load the same engines");
assert(!classic.includes('id="dataPane"'),
  "classic intentionally relies on guarded optional Data DOM");
assert(/function initAnalysisUI\(\)[\s\S]*if \(!\$\("dataPane"\)\) return/.test(ui) &&
  /function analysisAfterRecompute\(\)[\s\S]*if \(!\$\("dataPane"\)\) return/.test(ui),
"classic must be protected by optional-DOM guards");

assert(/MA\.extractOsculatingSeries\(/.test(ui) &&
  /targetPositionAt:[\s\S]*analysisTargetAt/.test(ui),
"Data refresh must use the bounded osculating-series engine including target range");
assert(/CR3BP state selected[\s\S]*intentionally excluded/.test(ui) &&
  /Jacobi C/.test(ui), "CR3BP states must be labeled instead of misreported as two-body elements");
assert(/const chart = \$\("analysisCanvas"\), tooltip = \$\("analysisTooltip"\)/.test(ui) &&
  /chart\.addEventListener\("pointermove"[\s\S]*AN\.hoverIndex/.test(ui),
  "analysis chart needs a hover crosshair/readout");
assert(/_analysis\.csv/.test(ui) && /MA\.rowsToCSV\(AN\.series\.columns/.test(ui),
  "time-series CSV export is not wired");

assert(/MA\.eclipseIntervals\(/.test(ui) && /lightRadiusKm:\s*BODIES\.sun\.radius/.test(ui),
  "Data pane must compute conical local-body eclipse intervals");
assert(/function buildEclipseBands\(\)[\s\S]*eclipse-band/.test(ui),
  "eclipse phases must produce timeline bands");
assert(/function missionLocalLegs\(\)[\s\S]*legs\.length >= 96/.test(ui) &&
  /Mission total across[\s\S]*umbraFraction/.test(ui),
  "eclipse analysis must integrate bounded totals across the mission");
assert(/eclipse3d[\s\S]*S\.options\.shadowCones/.test(ui) &&
  /opts\.shadowCones/.test(fs.readFileSync(path.join(root, "js", "renderer.js"), "utf8")),
  "3D conical shadow visualization must be optional and renderer-backed");
assert(/MA\.groundStationAccess\(/.test(ui) && /MA\.DSN_STATIONS/.test(ui),
  "DSN access must use the analysis catalog and access-window engine");
assert(/rise_utc[\s\S]*set_utc[\s\S]*max_elevation_deg/.test(ui),
  "DSN CSV must include rise, set, and maximum elevation");
assert(/USER_STATION_KEY = "mtp-user-stations-v1"/.test(ui) &&
  /MAX_USER_STATIONS = 32/.test(ui) && /function addUserStation\(\)/.test(ui) &&
  /function removeUserStation\(id\)/.test(ui),
  "user station editor must persist a bounded add/remove catalog");
assert(/stationsForBody\(bodyId/.test(ui) &&
  /st\.stations = stationsForBody\(bodyId/.test(ui) &&
  /bodyId:\s*leg\.cen/.test(ui),
  "custom body stations must feed both access calculations and Track markers");

assert(/MissionAnalysis\.sensorFootprint/.test(ground) &&
  /sensorSwathWidthKm/.test(ground),
"Track map must draw and report the sensor cone footprint");
assert(/Array\.isArray\(st\.stations\)/.test(ground) && /station\.complex/.test(ground),
  "Track map must support optional fixed ground-station markers");
assert(/analysisJ2[\s\S]*j2SecularRates/.test(ui) &&
  /applyJ2CoastMode\("j2-secular"\)/.test(ui) &&
  /applyJ2CoastMode\("kepler"\)/.test(ui) &&
  /Chart preview is opt-in; Coast model changes use the explicit buttons/.test(ui),
"J2 must offer explicit chart preview and Coast model controls, never a silent preset mutation");

assert(/MM\.relativeSeries\(/.test(ui) && /MM\.findClosestApproach\(/.test(ui) &&
  /MM\.findConjunctions\(/.test(ui),
"comparison craft must provide relative range, closest approach, and conjunctions");
assert(/fleetAlignEpoch[\s\S]*mission\.epoch = S\.mission\.epoch/.test(ui),
  "comparison craft must offer explicit same-epoch alignment without changing the source mission");
assert(/referenceEpochJD[\s\S]*sample\.t \/ DAY/.test(ui),
  "relative-range CSV must retain the synchronized absolute epoch");
assert(/AN\.crafts\.length >= 7/.test(ui) &&
  /multiCraft:\s*nativeVehicles\.concat\(AN\.crafts\.map/.test(ui) &&
  /AN\.conjunctionEvents/.test(ui) && /kind:\s*"conjunction"/.test(ui),
  "bounded native and comparison craft must drive simultaneous rendering and timeline conjunctions");
assert(/data-fleet-color/.test(ui) && /data-remove-craft/.test(ui),
  "fleet manager must expose per-craft colors and removal");

for (const selector of ["analysis-head", "element-cell", "analysisCanvas",
  "analysis-tooltip", "station-row", "fleet-row", "gtTools"]) {
  assert(new RegExp(`\\[data-theme="blueprint"\\][^\\n]*${selector}`).test(css),
    `${selector} needs a Blueprint treatment`);
  assert(new RegExp(`\\[data-theme="cinematic"\\][^\\n]*${selector}`).test(css),
    `${selector} needs a Cinematic treatment`);
}

assert(/class="shortcut-card"/.test(ui) && /<kbd>Space<\/kbd>/.test(ui) &&
  /\[data-theme="blueprint"\] \.shortcut-card/.test(css) &&
  /\[data-theme="cinematic"\] \.shortcut-card/.test(css),
  "Guide must include a dual-theme keyboard shortcut reference card");

console.log("Planner analysis UI contracts passed: mission eclipses, station editor, swath, J2, and N-craft fleet.");
