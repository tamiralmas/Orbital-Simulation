/* Headless Earth Live spacecraft-POV geometry and interaction contracts. */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { C, A } = require("./harness.js");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "js", "live.js"), "utf8");

globalThis.__MTP_TEST__ = true;
globalThis.document = { getElementById() { return null; } };
vm.runInThisContext(source, { filename: "live.js" });
delete globalThis.__MTP_TEST__;
delete globalThis.document;

const T = globalThis.MTPLivePovTest;
assert(T, "live.js should expose pure POV geometry in the headless test environment");
const nearVec = (actual, expected, message) => assert(A.V.mag(A.V.sub(actual, expected)) < 1e-12,
  message);

const state = { r: [7000, 0, 0] };
const height = 900;
const basis = T.povCameraForState(state, height);
assert(basis && basis.pov, "valid exterior state should produce a POV camera");
nearVec(basis.D, [1, 0, 0],
  "camera eye direction should run from Earth to the spacecraft");
nearVec(basis.F, [-1, 0, 0],
  "POV camera must look from the spacecraft back toward Earth");
const expectedF = (height / 2) / Math.tan(T.POV_FOV / 2);
const expectedEarthPx = expectedF * T.R_EQUATOR /
  Math.sqrt(7000 * 7000 - T.R_EQUATOR * T.R_EQUATOR);
assert(Math.abs(basis.earthPx - expectedEarthPx) < 1e-10,
  "Earth radius must use the exact exterior-sphere perspective silhouette");

const center = T.projectPov([0, 0, 0], basis, 600, 450);
assert(center.visible && Math.abs(center.x - 600) < 1e-12 &&
  Math.abs(center.y - 450) < 1e-12,
"Earth center should remain centered in spacecraft POV");
const eye = T.projectPov(state.r, basis, 600, 450);
assert.strictEqual(eye.visible, false,
  "the selected spacecraft at the camera eye must be clipped, not drawn as a marker");

// A positive Earth-centered depth is not sufficient in a close perspective
// view: most of the nominal near hemisphere is still below the true limb.
const hiddenPositiveDepth = [3000, Math.sqrt(6800 * 6800 - 3000 * 3000), 0];
const hiddenProjection = T.projectPov(hiddenPositiveDepth, basis, 600, 450);
assert(hiddenProjection.depth > 0 && T.earthOccludes(hiddenPositiveDepth, basis),
  "Earth POV must hide a positive-depth satellite whose sightline crosses Earth");
assert.strictEqual(T.earthOccludes([6800, 0, 0], basis), false,
  "a satellite between the POV eye and Earth should remain visible");
assert.strictEqual(T.earthOccludes([-6800, 40000, 0], basis), false,
  "a far-side satellite outside Earth's silhouette should remain visible");

const clippedTrail = T.visibleTrailStart([6800, 0, 0], [-6800, 0, 0], basis);
assert(clippedTrail && !T.earthOccludes(clippedTrail, basis) &&
  clippedTrail[0] >= T.R_EQUATOR && clippedTrail[0] - T.R_EQUATOR < 2,
  "a trail entering Earth should be clipped at the visible limb");
assert.strictEqual(T.visibleTrailStart([0, 20000, 0], [0, -20000, 0], basis), null,
  "two visible trail endpoints must not be joined when their midpoint crosses Earth");

const orthoBasis = { pov: false, D: [1, 0, 0] };
assert.strictEqual(T.earthOccludes([-7000, 0, 0], orthoBasis), true,
  "orthographic Earth Live should hide a far-side satellite within the disk");
assert.strictEqual(T.earthOccludes([7000, 0, 0], orthoBasis), false,
  "orthographic Earth Live should preserve a front-side satellite");
assert.strictEqual(T.earthOccludes([-7000, T.R_EQUATOR, 0], orthoBasis), false,
  "orthographic Earth Live should preserve an exact-limb point");

const advanced = T.povCameraForState({ r: [0, 7000, 0] }, height);
nearVec(advanced.D, [0, 1, 0],
  "POV orientation should update from each newly propagated spacecraft state");
nearVec(advanced.F, [0, -1, 0],
  "updated POV camera should continue looking toward Earth");
assert.strictEqual(T.validPovState({ r: [T.R_EQUATOR, 0, 0] }), false,
  "camera eye must remain outside Earth's surface");

assert(/pov:\s*\$\("btnLivePov"\)/.test(source) &&
  /dom\.pov\.setAttribute\("aria-pressed",\s*povActive/.test(source) &&
  /dom\.pov\.classList\.toggle\("active",\s*povActive\)/.test(source),
"POV button should be guarded and expose active accessibility state");
assert(/addEventListener\("wheel",[\s\S]*?setPovActive\(false, true\)/.test(source) &&
  /drag\.moved = true;[\s\S]*?setPovActive\(false, true\)/.test(source) &&
  /function resetView\(\)[\s\S]*?setPovActive\(false, false\)/.test(source) &&
  /function fitSelected\(\)[\s\S]*?setPovActive\(false, true\)/.test(source),
"manual drag/wheel, Reset, and Fit should leave POV predictably");
assert(/function clearSelection\(\)[\s\S]*?setPovActive\(false, true\)[\s\S]*?syncPovControl\(\)/.test(source) &&
  /event\.key\.toLowerCase\(\) === "v"/.test(source),
"selection clearing should disable POV and V should toggle it");
assert(/function markerData\(basis\)[\s\S]*?!p\.visible \|\| earthOccludes\(state\.r, basis\)[\s\S]*?continue/.test(source) &&
  /visibleTrailStart\(state\.r, state\.trailR, basis\)/.test(source),
"Earth markers must be filtered before drawing/picking and their trails must use limb clipping");
assert(/function drawOrbitPass[\s\S]*?earthOccludes\(point, basis\)[\s\S]*?earthOccludes\(midpoint\(previousPoint, point\), basis\)/.test(source),
"Earth selected-orbit strokes must break at hidden points and hidden mid-segments");
assert(/function nearestMarker[\s\S]*?for \(const marker of screenMarkers\)/.test(source) &&
  /screenMarkers = displayState\.markers \? markerData\(basis\) : \[\]/.test(source),
"Earth picking must consume the already occlusion-filtered marker list");

console.log("Earth Live POV checks passed: exact spacecraft eye, Earth-facing perspective, and deterministic exits.");
