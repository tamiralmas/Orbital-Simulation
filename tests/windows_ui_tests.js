/* Static contracts for the dependency-free Planner launch-window panel. */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const classic = fs.readFileSync(path.join(root, "classic.html"), "utf8");
const ui = fs.readFileSync(path.join(root, "js", "ui.js"), "utf8");
const css = fs.readFileSync(path.join(root, "css", "theme.css"), "utf8");

const ids = [
  "windowsPane", "winFrom", "winTo", "winStart", "winEnd", "winTofMin",
  "winTofMax", "winGrid", "winMetric", "winGenerate", "winCancel",
  "winProgress", "winProgressBar", "winCanvas", "winTooltip", "winSelection",
  "winSelectionReadout", "winApplySegment", "winApply", "winStatus",
  "winTargeting", "winTargetGoal", "winTargetSeed", "winTargetTolerance",
  "winTargetSolve", "winTargetStatus",
];
for (const id of ids) {
  const occurrences = html.match(new RegExp(`id=["']${id}["']`, "g")) || [];
  assert.strictEqual(occurrences.length, 1, `${id} should occur exactly once in index.html`);
}

assert(/class="tabbtn" data-pane="windowsPane">Windows</.test(html),
  "Windows must be a first-class right-panel tab");
assert(/id="paneBtns"[\s\S]*data-pane="windowsPane">Windows</.test(html),
  "Cinematic transport must expose the same Windows pane");
assert(/id="winFrom"[\s\S]*id="winTo"[\s\S]*id="winStart"[\s\S]*id="winEnd"/.test(html),
  "body-pair and departure-range controls are incomplete");
assert(/id="winTofMin"[\s\S]*id="winTofMax"[\s\S]*id="winGrid"[\s\S]*id="winMetric"/.test(html),
  "TOF, resolution, and metric controls are incomplete");
assert(/value="80x60" selected/.test(html) && /value="120x80"/.test(html),
  "standard and detailed bounded-grid choices must remain available");
for (const metric of ["c3", "departureVInfinity", "arrivalVInfinity",
  "totalCharacteristicVelocity"]) {
  assert(html.includes(`value="${metric}"`), `missing ${metric} color option`);
}
assert(/id="winStatus"[^>]*role="status"[^>]*aria-live="polite"/.test(html),
  "generation and apply state must be announced accessibly");

assert(html.indexOf('src="js/windows.js"') < html.indexOf('src="js/ui.js"'),
  "window engine must load before Planner UI wiring");
assert(classic.indexOf('src="js/windows.js"') < classic.indexOf('src="js/ui.js"'),
  "classic shared UI must receive the engine without receiving unstyled pane DOM");
assert(!classic.includes('id="windowsPane"'),
  "classic.html intentionally relies on guarded optional window DOM");

assert(/function windowPresent\(\)[\s\S]*windowsPane[\s\S]*winCanvas/.test(ui) &&
  /function initWindowPlanner\(\)[\s\S]*if \(!windowPresent\(\)/.test(ui),
"classic.html must be protected by an early optional-DOM guard");
assert(/async function generateWindowPlot\(\)[\s\S]*MW\.iterateGrid\(config/.test(ui),
  "UI must use the responsive MissionWindows iterator");
assert(/chunkSize:\s*96[\s\S]*yieldControl:[\s\S]*requestAnimationFrame/.test(ui),
  "Lambert work must yield between bounded chunks");
assert(/winCancel[\s\S]*WIN\.signal\.aborted = true/.test(ui),
  "Cancel must abort the active grid iterator");
assert(/winProgressBar[\s\S]*progress\.progress \* 100/.test(ui),
  "chunk progress must drive the visible progress bar");
assert(/Band boundaries provide contour-like structure/.test(ui) &&
  /function windowPalette\(theme\)/.test(ui),
  "canvas must provide band contours with theme-aware palettes");
assert(/windowCellHtml\(cell\)[\s\S]*Departure v[\s\S]*Arrival v[\s\S]*Total/.test(ui),
  "hover/selection readout must expose all endpoint metrics");
assert(/pointermove[\s\S]*showWindowTooltip/.test(ui) &&
  /addEventListener\("click", \(event\) => stageWindowCell/.test(ui),
  "canvas hover and click staging are not wired");
assert(/function stageWindowCell\(cell, preserveTarget\)[\s\S]*Review it[\s\S]*use Apply/.test(ui) &&
  /winApply"\)\.addEventListener\("click", applyWindowSelection\)/.test(ui),
  "plot click must stage a solution before an explicit Apply confirmation");
assert(/segment\.type !== "depart" && segment\.type !== "transfer"/.test(ui) &&
  /segment\.target !== to \|\| windowSegmentSource\(index\) !== from/.test(ui),
  "Apply target must be a relevant source/target Transfer or Depart segment");
assert(/segment\.tofDays = \+cell\.tofDays/.test(ui) &&
  /cell\.departureJD - windowDepartureOffset\(index\) \/ DAY/.test(ui) &&
  /Mission T\+0 was shifted to keep that injection date exact/.test(ui),
  "Apply must write TOF and align the segment's real injection epoch");
assert(/async function solveWindowTransferTarget\(\)[\s\S]*MT\.solveTransferDateTofAsync\(/.test(ui) &&
  /departureBoundsJD:\s*\[startJD, endJD\][\s\S]*tofBoundsDays:\s*\[tofMin, tofMax\]/.test(ui),
  "Transfer Vary/Achieve must jointly solve date and TOF inside visible bounds");
assert(/function evaluateAppliedWindowTarget\([\s\S]*ME\.recompute\(mission\)/.test(ui) &&
  /evaluate:\s*\(\{ departureJD, tofDays \}\)[\s\S]*evaluateAppliedWindowTarget\(/.test(ui),
  "joint targeting must evaluate the actual applied mission engine, not a detached analytic proxy");
assert(/segment\.type !== "transfer" && segment\.type !== "depart"/.test(ui) &&
  /fixedAimOffsetKm = seedEvaluation\.aimOffsetKm/.test(ui),
  "both Transfer and Depart targeting must hold one engine-derived B-plane aim fixed");
assert(/yieldControl:\s*\(\) => new Promise\([\s\S]*requestAnimationFrame/.test(ui) &&
  /signal,\s*\n\s*yieldEvery:\s*1/.test(ui),
  "applied-trajectory targeting must yield between evaluations and remain cancelable");
assert(/segment\.targetMode = "arrival-periapsis"/.test(ui) &&
  /segment\.aimOffsetKm = targetSolution\.fixedAimOffsetKm/.test(ui) &&
  /WIN\.targetSolution && WIN\.targetSolution\.converged/.test(ui),
  "a converged joint target must be committed explicitly with the staged solution");
assert(/targetSolution\.segmentIndex === index/.test(ui) &&
  /achievedTarget[\s\S]*targetSolution\.toleranceKm/.test(ui) &&
  /Target controls changed\. Solve again/.test(ui),
  "Apply must reject stale controls and verify the actual achieved target before success");
assert(/const missionSnapshot = JSON\.parse\(JSON\.stringify\(S\.mission\)\)/.test(ui) &&
  /evaluateAppliedWindowTarget\([\s\S]*missionSnapshot, departureOffset/.test(ui) &&
  /missionFingerprint === windowTargetFingerprint\(S\.mission, index\)/.test(ui) &&
  /function windowTargetBusy\(busy\)/.test(ui),
  "cooperative targeting must use one mission snapshot and block stale mid-solve application");
assert(/function clearWindowPlot\(message\)[\s\S]*windowBusy\(false\);[\s\S]*windowTargetBusy\(false\)/.test(ui),
  "replacing a target run must always re-enable its controls");

for (const kind of ["burn_end", "libration", "cr3bp", "stationkeep"]) {
  assert(new RegExp(`${kind}:\\s*["']#[0-9a-fA-F]{6}["']`).test(ui),
    `${kind} events must remain visible in the timeline and cinematic event strip`);
}

assert(/\[data-theme="blueprint"\] #winCanvas/.test(css) &&
  /\[data-theme="cinematic"\] #winCanvas/.test(css),
  "the porkchop canvas needs explicit styling in both Planner themes");
assert(/\[data-theme="blueprint"\] \.window-tooltip/.test(css) &&
  /\[data-theme="cinematic"\] \.window-tooltip/.test(css),
  "hover cards need explicit Blueprint and Cinematic treatments");
assert(/\[data-theme="blueprint"\] \.window-selection/.test(css) &&
  /\[data-theme="cinematic"\] \.window-selection/.test(css),
  "confirmation cards need explicit Blueprint and Cinematic treatments");
assert(/\[data-theme="blueprint"\] \.window-targeting/.test(css) &&
  /\[data-theme="cinematic"\] \.window-targeting/.test(css),
  "joint target controls need explicit Blueprint and Cinematic treatments");

console.log("Launch-window UI contracts passed: responsive plot, joint Vary/Achieve, explicit apply, two themes.");
