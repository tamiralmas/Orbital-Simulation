/* Earth Live ground-track, motion-cue, and display-option contracts. */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { C, A } = require("./harness.js");

const root = path.resolve(__dirname, "..");
const liveSource = fs.readFileSync(path.join(root, "js", "live.js"), "utf8");
const themeSource = fs.readFileSync(path.join(root, "js", "theme.js"), "utf8");

vm.runInThisContext(fs.readFileSync(path.join(root, "js", "sgp4.js"), "utf8"),
  { filename: "sgp4.js" });
globalThis.__MTP_TEST__ = true;
globalThis.document = { getElementById() { return null; } };
vm.runInThisContext(liveSource, { filename: "live.js" });
delete globalThis.__MTP_TEST__;
delete globalThis.document;

const T = globalThis.MTPLivePovTest;
assert(T && typeof T.groundWindowSpec === "function",
  "Earth Live should expose its pure bounded ground-window policy");

const atMs = Date.UTC(2026, 6, 12);
const leo = T.groundWindowSpec(92.7, atMs);
assert(leo.firstMs < atMs && leo.lastMs > atMs,
  "LEO ground window should bracket the displayed UTC");
assert(leo.count >= 240 && leo.count <= 1200 && leo.stepS <= 60,
  "LEO track should use smooth bounded samples instead of sparse long chords");
const deepOrbit = T.groundWindowSpec(64 * 60, atMs);
assert(deepOrbit.lastMs - deepOrbit.firstMs <= 24 * 3600 * 1000,
  "high-orbit ground windows should remain readable and bounded to one day");

const jd = 2440587.5 + atMs / 86400000;
const plannerX = T.earthFixedStateToPlanner({ jd, position: [7000, 0, 0], velocity: [0, 0, 0] });
const plannerY = T.earthFixedStateToPlanner({ jd, position: [0, 7000, 0], velocity: [0, 0, 0] });
const llPlannerX = A.bodyLatLon(T.earthBody, plannerX.position, jd);
const llPlannerY = A.bodyLatLon(T.earthBody, plannerY.position, jd);
assert(Math.abs(llPlannerX.lam) < 1e-12 && Math.abs(llPlannerX.phi) < 1e-12 &&
  Math.abs(llPlannerY.lam - Math.PI / 2) < 1e-12,
  "Earth-fixed SGP4 coordinates should embed exactly in the Planner body frame used by textures and Track");
const light = T.sunDirectionPlanner(jd);
assert(Math.abs(A.V.mag(light) - 1) < 1e-12,
  "Earth Live lighting should stay in the Planner's ecliptic world frame");

vm.runInThisContext(fs.readFileSync(path.join(root, "js", "groundtrack.js"), "utf8"),
  { filename: "groundtrack.js" });
const body = { id: "earth", tiltDeg: 0, rotHours: 24 };
const ll0 = globalThis.MTPGroundTrack.bodyLatLon(body, [1, 0, 0], C.J2000_JD, 0);
const ll90 = globalThis.MTPGroundTrack.bodyLatLon(body, [1, 0, 0], C.J2000_JD, Math.PI / 2);
assert(Math.abs(ll0.lam) < 1e-12 && Math.abs(ll90.lam - Math.PI / 2) < 1e-12,
  "ground-track spin override should align OMM coordinates with the live textured globe");

const exactPoint = { u: 0.35, v: 0.42, t: 5 };
const split = globalThis.MTPGroundTrack.splitTrackPoints([
  { u: 0.1, v: 0.4, t: 0 },
  { u: 0.6, v: 0.45, t: 10 },
], 5, exactPoint);
assert.deepStrictEqual(split.past[split.past.length - 1], exactPoint,
  "past Track color should end at the continuously interpolated spacecraft point");
assert.deepStrictEqual(split.future[0], exactPoint,
  "future Track color should begin at the same continuously interpolated spacecraft point");
const frozenSplit = globalThis.MTPGroundTrack.splitTrackPoints([
  { u: 0.1, v: 0.4, t: 0 },
  { u: 0.6, v: 0.45, t: 10 },
], 5, exactPoint);
assert.deepStrictEqual(frozenSplit, split,
  "the exact-current Track split should be deterministic for an unchanged displayed time");
let previousEndpoint = -Infinity;
for (let tNow = 1; tNow <= 9; tNow++) {
  const point = { u: 0.1 + 0.05 * tNow, v: 0.4, t: tNow };
  const progressing = globalThis.MTPGroundTrack.splitTrackPoints([
    { u: 0.1, v: 0.4, t: 0 }, { u: 0.6, v: 0.4, t: 10 },
  ], tNow, point);
  const endpoint = progressing.past[progressing.past.length - 1];
  assert.deepStrictEqual(endpoint, point,
    "orange Track endpoint should follow the interpolated marker at t=" + tNow);
  assert(endpoint.t >= previousEndpoint, "orange Track progression must remain monotonic");
  previousEndpoint = endpoint.t;
}
assert(globalThis.MTPGroundTrack.shouldBreakTrackSegment(
  { u: 0.1, v: 0.02, t: 0 }, { u: 0.49, v: 0.03, t: 1 }),
  "large longitude swings near a pole should break instead of drawing random map chords");
assert(globalThis.MTPGroundTrack.shouldBreakTrackSegment(
  { u: 0.98, v: 0.5, t: 0 }, { u: 0.02, v: 0.5, t: 1 }),
  "ordinary dateline wrapping should remain segmented");
assert(!globalThis.MTPGroundTrack.shouldBreakTrackSegment(
  { u: 0.1, v: 0.5, t: 0 }, { u: 0.2, v: 0.55, t: 1 }),
  "ordinary finite mid-latitude Track motion should stay connected");
assert(globalThis.MTPGroundTrack.shouldBreakTrackSegment(
  { u: NaN, v: 0.5, t: 0 }, { u: 0.2, v: 0.5, t: 1 }),
  "nonfinite Track geometry should always start a new path instead of poisoning the canvas stroke");
assert(globalThis.MTPGroundTrack.shouldBreakTrackSegment(
  { u: 0.2, v: 0.5, t: 10, rangeIndex: 0 },
  { u: 0.25, v: 0.5, t: 100, rangeIndex: 1, breakBefore: true }),
  "separate observation windows must not be joined by a false forward-time chord");
assert(/PALETTES\.blueprint\.gt\s*=\s*\{[\s\S]*?texAlpha:\s*1\s*,/.test(themeSource),
  "Blueprint Track should draw agency map imagery at full opacity instead of washing it into paper white");
const priorTheme = globalThis.MTPTheme;
const priorTextures = globalThis.MTPTex;
const mapAlphas = [];
globalThis.MTPTheme = {
  gt: {
    bg: "#fbfaf6", grid: "#ddd", gridStrong: "#999", night: "rgba(0,0,0,.1)",
    trackPast: "#e5541e", trackFuture: "#777", foot: "#15c", footFill: "rgba(0,0,0,0)",
    marker: "#111", text: "#333", texAlpha: 1,
  },
  events: {},
};
globalThis.MTPTex = {
  mapCanvas() { return { agencyTexture: true }; },
  spinAt() { return 0; },
};
const fakeContext = {
  globalAlpha: 1,
  clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
  fillText() {}, setLineDash() {}, closePath() {}, fill() {}, arc() {},
  drawImage() { mapAlphas.push(this.globalAlpha); },
};
globalThis.MTPGroundTrack.draw({ width: 120, height: 60, getContext() { return fakeContext; } }, {
  result: { samples: [{ t: 0, r: [7000, 0, 0], v: [0, 0, 0], cen: "earth" }], events: [], tEnd: 0 },
  tNow: 0, epochJD: C.J2000_JD, bodyId: "earth", body: C.BODIES.earth,
  sampleAtTime() { return { t: 0, r: [7000, 0, 0], v: [0, 0, 0], cen: "earth" }; },
  fullBright: true,
});
assert.deepStrictEqual(mapAlphas, [1],
  "the shared Track renderer should apply the active Blueprint texture opacity at drawImage");
globalThis.MTPTheme = priorTheme;
globalThis.MTPTex = priorTextures;

assert(/groundTrack\.draw\(dom\.groundCanvas/.test(liveSource) &&
  /body:\s*liveEarthBody/.test(liveSource) &&
  !/spinAt:\s*\(jd\) => gmstRad/.test(liveSource) &&
  /sunDirectionAt:\s*sunDirectionPlanner/.test(liveSource) &&
  /textures\.spriteFor\(liveEarthBody,[\s\S]*?sunDirectionPlanner\(jd\), jd, basis/.test(liveSource),
  "Earth Track, agency texture, and SGP4 state should share the Planner body frame and UTC epoch");
assert(/MOTION_TRAIL_MS/.test(liveSource) &&
  /state\.trailR = propagateOMM\(model, atMs - MOTION_TRAIL_MS\)\.r/.test(liveSource) &&
  /visibleTrailStart\(state\.r, state\.trailR, basis\)/.test(liveSource) &&
  /project\(tailPoint, basis\)/.test(liveSource),
  "cached short propagated trails should remain legible while clipping their hidden endpoint at Earth's limb");
assert(/Boolean\(displayState\.flat\)/.test(liveSource) && /displayState\.soi/.test(liveSource) &&
  /ctx\.globalAlpha = 1;[\s\S]*?Scale that bounded sprite/.test(liveSource),
  "Earth Live should honor Full Bright/SOI and keep the Blueprint globe opaque");

console.log("Live ground-track checks passed: bounded tracks, exact progress, SGP4 body-frame alignment, and opaque maps.");
