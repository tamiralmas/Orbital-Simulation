/* Static contracts for the optional Planner uncertainty / dispersion panel. */
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
  "uncertaintySection", "uncertaintyHead", "uncRun", "uncPosX", "uncPosY",
  "uncPosZ", "uncVelX", "uncVelY", "uncVelZ", "uncDvR", "uncDvT",
  "uncDvN", "uncMagPct", "uncPointDeg", "uncTimingS", "uncSamples",
  "uncSeed", "uncHours", "uncStatus", "uncResults", "uncCanvas",
];
for (const id of ids) {
  const occurrences = html.match(new RegExp(`id=["']${id}["']`, "g")) || [];
  assert.strictEqual(occurrences.length, 1,
    `${id} should occur exactly once in index.html`);
}

assert(html.indexOf('src="js/uncertainty.js"') < html.indexOf('src="js/ui.js"'),
  "uncertainty engine must load before Planner UI wiring");
assert(!classic.includes('id="uncertaintySection"'),
  "classic.html should continue to rely on guarded optional uncertainty DOM");
assert(/const MU = globalThis\.MissionUncertainty/.test(ui) &&
  /function uncertaintyPresent\(\)[\s\S]*uncertaintySection[\s\S]*uncRun/.test(ui) &&
  /function loadUncertaintyMissionDefaults\(\)[\s\S]*if \(!uncertaintyPresent\(\)\) return/.test(ui),
"shared ui.js must guard the optional engine and panel for classic.html");

assert(/S\.mission && S\.mission\.uncertainty/.test(ui) &&
  /positionSigmaKm/.test(ui) && /velocitySigmaKmS/.test(ui) &&
  /metadata\.maneuver/.test(ui),
"preset-level uncertainty metadata must initialize state and maneuver inputs");
assert(/uncertaintyCovariance\(sigmas\)/.test(ui) &&
  /frame:\s*"RTN"/.test(ui) && /magnitudeSigmaFraction/.test(ui) &&
  /pointingSigmaRad/.test(ui) && /timingSigmaS/.test(ui),
"run configuration must include a diagonal state covariance and RTN execution errors");
assert(/readUncertaintyNumber\("uncSamples", "Samples", 100, 5000, true\)/.test(ui) &&
  /maxModelEvaluations:\s*samples/.test(ui) && /retainSamples:\s*true/.test(ui),
"user-facing Monte Carlo work must remain bounded while retaining chart samples");
assert(/MU\.runMonteCarlo\(options\)/.test(ui) &&
  /A\.propagateUniversal\([\s\S]*body\.mu/.test(ui),
"dispersion runs must use the deterministic uncertainty engine and local two-body propagation");
assert(/function uncertaintySourceSample/.test(ui) &&
  /beforeSegment/.test(ui) && /sourceTime:\s*sample\.t/.test(ui) &&
  /Run uses \$\{sourceLabel\}, independent of the displayed mission time/.test(ui),
"preset pre-maneuver sources must retain their own epoch and visible source wording");
assert(/nominalOrbit\.rp > body\.radius/.test(ui) &&
  /function retainedDispersionIntersectsBody[\s\S]*A\.rvToCoe[\s\S]*orbit\.rp > body\.radius/.test(ui) &&
  /osculating[\s\S]*periapsis at or below/.test(ui),
"nominal and retained dispersion trajectories must reject surface-crossing osculating orbits");
assert(/summary\.positionRadius\.confidence/.test(ui) &&
  /summary\.velocityRadius\.confidence/.test(ui) &&
  /summary\.ellipses\.xy/.test(ui) && /Endpoint position \(est\. 95%\)/.test(ui),
"the visible report must label its position, velocity, and XY results as endpoint estimates");
assert(/function activeEndpointDispersion/.test(ui) &&
  /Estimated 95% endpoint position containment/.test(ui) &&
  /function eventEpochDispersion/.test(ui) &&
  /MU\.propagateCovariance/.test(ui) && /CHI_SQUARE_3D_95/.test(ui),
"endpoint Monte Carlo and linearized event-epoch covariance must remain distinctly labeled");
assert(/function uncertaintyEventWindow\(source, linearized, maneuverApplied\)/.test(ui) &&
  /uncertaintyEventWindow\(source, linearized,\s*Math\.hypot\(\.\.\.dv\) > 0\)/.test(ui),
"event confidence must be gated by an explicit mission-compatible propagation window");
assert(/if \(maneuverApplied\)[\s\S]*source\.beforeSegment[\s\S]*segments\[modeledSegment\]\.type !== "impulse"/.test(ui) &&
  /samples\.find\(\(entry\) => entry\.seg === modeledSegment\)/.test(ui) &&
  /uncertaintyStatesMatch\(postBurn, linearized\.state/.test(ui) &&
  /not tied to a mission impulse/.test(ui) && /does not match the flown mission impulse/.test(ui),
"a nonzero analyzed maneuver must match its named mission impulse and flown post-burn state");
assert(/segment\.type !== "coast"/.test(ui) &&
  /segment\.mode !== undefined && segment\.mode !== "kepler"/.test(ui) &&
  /entry\.cen !== source\.sample\.cen[\s\S]*entry\.cr3bp \|\| entry\.landed/.test(ui) &&
  /first\.t > endTime \+ 1e-6 \|\| last\.t < startTime - 1e-6/.test(ui) &&
  /endTime = Math\.max\(endTime, last\.t\)/.test(ui),
"only a contiguous same-body local Kepler coast may extend event confidence");
assert(/function eventEpochDispersion\(bodyId, missionTime\)[\s\S]*analysis\.eventWindow\.supported[\s\S]*missionTime > analysis\.eventWindow\.endTime/.test(ui) &&
  /ME\.sampleAtTime\(analysis\.vehicleResult, time\)[\s\S]*uncertaintyStatesMatch\(nominal, propagated\.finalState/.test(ui),
"event-epoch covariance must respect its supported window and the nominal flown state");
assert(/function clearUncertaintyOutput\(message, kind\)[\s\S]*AN\.uncertaintyRunId\+\+[\s\S]*AN\.uncertainty = null[\s\S]*AN\.accessConfidence = null/.test(ui) &&
  /addEventListener\("input", \(\) => \{[\s\S]*clearUncertaintyOutput\("Assumptions changed\.[\s\S]*computeAccessReport\(\)[\s\S]*refreshFleetSummary\(\)/.test(ui),
"uncertainty edits must invalidate stale results/cache and refresh access and fleet confidence");
assert(/interval\.maxElevationTimeS/.test(ui) &&
  /primary_position_95_km_at_max_elevation/.test(ui) &&
  /primaryTime[\s\S]*eventEpochDispersion/.test(ui) &&
  /closest\.range - eventDispersion\.radiusKm/.test(ui) &&
  /Comparison-craft covariance is not modeled/.test(ui),
"access and conjunction outputs must state time-correlated primary confidence and its limits");
assert(/first-order primary covariance/.test(ui) &&
  /First-order primary position estimated-95%[\s\S]*max-axis upper bound/.test(ui) &&
  /this screen cannot rule out a threshold crossing/.test(ui),
"event confidence wording must identify the first-order estimated upper bound and avoid false clearance");
assert(/function drawUncertaintyChart\(\)[\s\S]*errors\.length \/ 2000[\s\S]*95% ellipse/.test(ui),
  "dispersion canvas must cap plotted points and draw the 95% ellipse");

assert(/\[data-theme="blueprint"\] #uncCanvas/.test(css) &&
  /\[data-theme="cinematic"\] #uncCanvas/.test(css),
"dispersion chart must have explicit Blueprint and Cinematic treatments");
assert(/\[data-theme="blueprint"\] \.uncertainty-fieldset/.test(css) &&
  /\[data-theme="cinematic"\] \.uncertainty-fieldset/.test(css) &&
  /@media \(max-width: 620px\)[\s\S]*\.uncertainty-vector-grid/.test(css),
"uncertainty controls must retain both design languages and a narrow layout");
assert(/\[data-theme="blueprint"\] \.analysis-confidence/.test(css) &&
  /\[data-theme="cinematic"\] \.analysis-confidence/.test(css),
"uncertainty confidence annotations must be styled in both design languages");

console.log("Uncertainty UI contracts passed: seeded endpoint cloud, event-epoch covariance, two themes.");
