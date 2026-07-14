/* Deterministic launch-site and schematic-ascent regressions. Run with:
 *   node tests/launch_tests.js
 *
 * Launch aerodynamics remain outside the patched-conic model. These tests
 * protect the public visual bridge from the selected surface pad to the
 * established MECO conic without depending on canvas timing. */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { C, A, ME, MS } = require("./harness.js");

// Reuse the same body-fixed convention as the textured globe and Track map.
// This script is DOM-free until draw() is called, so its pure conversion is
// safe in the headless engine harness.
vm.runInThisContext(fs.readFileSync(
  path.join(__dirname, "..", "js", "groundtrack.js"), "utf8"),
{ filename: "groundtrack.js" });

const V = A.V;
const GT = globalThis.MTPGroundTrack;
const earth = C.BODIES.earth;
const EPOCH = "2030-01-01T00:00:00Z";

function near(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message}: ${actual} is not within ${tolerance} of ${expected}`);
}

function nearVec(actual, expected, tolerance, message) {
  const error = V.mag(V.sub(actual, expected));
  assert.ok(error <= tolerance, `${message}: vector error ${error} > ${tolerance}`);
}

function wrappedDegError(actual, expected) {
  return ((actual - expected + 540) % 360) - 180;
}

function angleBetween(a, b) {
  const dot = Math.max(-1, Math.min(1, V.dot(V.norm(a), V.norm(b))));
  return Math.acos(dot);
}

// Earth-fixed longitude must use the same Vallado GMST convention as the GP
// adapter. UTC stands in for UT1 because the offline planner has no EOP table.
{
  const jd = A.dateToJD(EPOCH);
  const theta = A.greenwichMeanSiderealTime(jd);
  const obliquity = 23.439291111 * C.DEG;
  const expectedGreenwich = [Math.cos(theta),
    Math.cos(obliquity) * Math.sin(theta),
    -Math.sin(obliquity) * Math.sin(theta)];
  const frame = A.bodyFrameAt(earth, jd);
  nearVec(frame.x, expectedGreenwich, 1e-13,
    "Earth Greenwich axis is not GMST-aligned");
  assert.strictEqual(frame.model, "gmst-utc-approx-ut1");
}

function expectedPadVelocity(body, site, jd) {
  const halfSpanS = 30;
  const before = A.bodyDirection(body, site.latDeg * C.DEG,
    site.lonDeg * C.DEG, jd - halfSpanS / C.DAY);
  const after = A.bodyDirection(body, site.latDeg * C.DEG,
    site.lonDeg * C.DEG, jd + halfSpanS / C.DAY);
  return V.scale(V.sub(after, before), body.radius / (2 * halfSpanS));
}

function launchResult(siteId, overrides) {
  const launch = Object.assign(ME.defaultSegment("launch"), {
    body: "earth",
    site: siteId,
    ascent: "meco",
    altKm: 300,
    incDeg: 51.6,
    raanDeg: 15,
    targetPlane: "",
  }, overrides || {});
  const result = ME.recompute({ epoch: EPOCH, segments: [launch] });
  return {
    launch,
    result,
    samples: result.samples.filter((sample) => sample.seg === 0),
  };
}

// The first public state is the selected physical pad, not a generic point
// 140 km above the Pacific. Longitude must account for Earth rotation at the
// mission epoch, and independently selected pads must remain distinct.
const siteStarts = new Map();
for (const site of C.LAUNCH_SITES.filter((candidate) => candidate.id)) {
  const siteId = site.id;
  const { result, samples } = launchResult(siteId);
  assert.ok(samples.length >= 3,
    `${siteId} launch needs a surface, an interior ascent, and a MECO sample`);
  const pad = samples[0];
  assert.strictEqual(pad.t, 0, `${siteId} pad is not mission T+0`);
  assert.strictEqual(pad.cen, "earth", `${siteId} pad uses the wrong central body`);
  near(V.mag(pad.r), earth.radius, 1e-7,
    `${siteId} first sample is not on Earth's surface`);

  const ll = GT.bodyLatLon(earth, pad.r, result.epochJD);
  near(ll.phi / C.DEG, site.latDeg, 1e-7,
    `${siteId} body-fixed latitude does not match the selected site`);
  near(wrappedDegError(ll.lam / C.DEG, site.lonDeg), 0, 1e-7,
    `${siteId} body-fixed longitude does not match the selected site`);
  nearVec(pad.v, expectedPadVelocity(earth, site, result.epochJD), 1e-9,
    `${siteId} pad velocity is not fixed to the rotating Earth`);
  siteStarts.set(siteId, pad.r);
}
assert.strictEqual(siteStarts.size, C.LAUNCH_SITES.length - 1,
  "not every configured Earth launch site was exercised");
assert.ok(V.mag(V.sub(siteStarts.get("ksc"), siteStarts.get("vandenberg"))) > 1000,
  "KSC and Vandenberg collapsed onto the same launch point");
assert.ok(V.mag(V.sub(siteStarts.get("ksc"), siteStarts.get("baikonur"))) > 1000,
  "KSC and Baikonur collapsed onto the same launch point");

// An ordinary launch without target-plane steering must progress smoothly
// outward in its site-compatible plane. In particular, the first advancing
// state may not jump directly to the old fixed 140 km burnout display altitude.
{
  const { result, samples } = launchResult("ksc");
  const altitudes = samples.map((sample) => V.mag(sample.r) - earth.radius);
  const downrange = samples.map((sample) => angleBetween(samples[0].r, sample.r));
  near(altitudes[0], 0, 1e-7, "ascent does not begin at pad altitude");
  assert.ok(samples[0].t === 0 && samples[samples.length - 1].t > 0,
    "launch visual bridge has no positive displayed duration");
  for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i].t > samples[i - 1].t,
      `launch sample ${i} does not advance monotonically in time`);
    assert.ok(altitudes[i] > altitudes[i - 1],
      `launch sample ${i} does not advance monotonically in altitude`);
    assert.ok(downrange[i] >= downrange[i - 1] - 1e-12,
      `launch sample ${i} moved backward toward the pad`);
    assert.ok(V.mag(samples[i].r) >= earth.radius - 1e-7,
      `launch sample ${i} cut through Earth's interior`);
    assert.notStrictEqual(samples[i]._interp, "kepler",
      "schematic atmospheric ascent must not be interpolated as a two-body coast");
  }
  assert.ok(altitudes[1] > 0 && altitudes[1] < altitudes[altitudes.length - 1],
    "first visible ascent state jumped directly to MECO altitude");
  const middle = ME.sampleAtTime(result,
    0.5 * samples[samples.length - 1].t);
  const middleAlt = V.mag(middle.r) - earth.radius;
  assert.ok(middleAlt > 0 && middleAlt < altitudes[altitudes.length - 1],
    "off-grid playback jumped directly from the pad to MECO");
  assert.ok(downrange[downrange.length - 1] > 0 &&
    downrange[downrange.length - 1] <= 20 * C.DEG,
  "MECO is not a local downrange continuation of the selected launch pad");
  assert.strictEqual(samples.length, 21,
    "schematic gravity turn lost its smooth display cadence");
  const chord = V.sub(samples[samples.length - 1].r, samples[0].r);
  const chordNorm2 = V.dot(chord, chord);
  const maximumCurveOffset = samples.reduce((maximum, sample) => {
    const along = Math.max(0, Math.min(1,
      V.dot(V.sub(sample.r, samples[0].r), chord) / chordNorm2));
    const onChord = V.add(samples[0].r, V.scale(chord, along));
    return Math.max(maximum, V.mag(V.sub(sample.r, onChord)));
  }, 0);
  assert.ok(maximumCurveOffset > 120,
    `launch still reads as a straight surface-to-LEO chord (${maximumCurveOffset} km curve)`);
  assert.strictEqual(result.events.find((event) => event.kind === "launch").t, 0,
    "Launch event no longer marks liftoff at T+0");
}

// Preserve the pre-fix MECO conic and speed while anchoring an ordinary
// no-target launch plane to the selected site. The 300 km field is the transfer
// ellipse's apoapsis target; MECO is reached on its ascending arc at 140 km.
{
  const { result, samples } = launchResult("ksc");
  const pad = samples[0];
  const meco = samples[samples.length - 1];
  const coe = A.rvToCoe(meco.r, meco.v, earth.mu);
  near(coe.ra - earth.radius, 300, 1e-8,
    "MECO transfer ellipse ignored the requested target altitude");
  near(coe.rp - earth.radius, -30, 1e-8,
    "MECO transfer ellipse lost its established disposal periapsis");
  near(V.mag(meco.r) - earth.radius, 140, 1e-8,
    "the established MECO burnout altitude changed while adding pad playback");
  near(V.mag(meco.v), A.visViva(earth.mu, V.mag(meco.r), coe.a), 1e-10,
    "site anchoring changed the solved MECO speed");
  assert.ok(V.dot(meco.r, meco.v) > 0,
    "MECO is not on the ascending leg toward target apoapsis");

  const orbitNormal = V.norm(V.cross(meco.r, meco.v));
  const spinAxis = A.bodyFrameAt(earth, result.epochJD).z;
  near(Math.acos(Math.max(-1, Math.min(1, V.dot(orbitNormal, spinAxis)))) / C.DEG,
    51.6, 1e-8,
  "site anchoring changed the requested Earth-equatorial inclination");
  near(V.dot(orbitNormal, V.norm(pad.r)), 0, 1e-9,
    "selected pad does not lie in the solved launch orbit plane");
  for (let i = 1; i < samples.length; i++) {
    near(V.dot(orbitNormal, V.norm(samples[i].r)), 0, 1e-8,
      `ascent sample ${i} left the site-anchored launch plane`);
  }
}

// Apollo exercises the separate target-plane contract. Its powered ascent may
// dogleg from KSC into a Moon-optimized final orbit, so the pad need not lie in
// the final plane. The endpoint must remain geographically bounded while the
// final orbit materially reduces the translunar injection plane-change cost.
{
  const apollo = MS.getPreset("apollo11");
  const result = ME.recompute(apollo);
  const launch = apollo.segments[0];
  const samples = result.samples.filter((sample) => sample.seg === 0);
  const pad = samples[0], meco = samples[samples.length - 1];
  const ksc = C.launchSite("ksc");

  assert.strictEqual(pad.t, 0, "Apollo no longer begins at launch-epoch T+0");
  near(V.mag(pad.r), earth.radius, 1e-7,
    "Apollo no longer begins on Earth's surface");
  const padLl = GT.bodyLatLon(earth, pad.r, result.epochJD);
  near(padLl.phi / C.DEG, ksc.latDeg, 1e-7,
    "Apollo launch latitude does not match KSC");
  near(wrappedDegError(padLl.lam / C.DEG, ksc.lonDeg), 0, 1e-7,
    "Apollo launch longitude does not match KSC");

  const endpointAngle = angleBetween(pad.r, meco.r) / C.DEG;
  assert.ok(endpointAngle > 0 && endpointAngle <= 10,
    `Apollo powered-ascent endpoint is not geographically bounded (${endpointAngle}°)`);

  const orbitNormal = V.norm(V.cross(meco.r, meco.v));
  const targetJd = result.epochJD + Math.max(+launch.planeTofDays || 0, 0);
  const targetDirection = V.norm(ME.relBodyState(
    launch.targetPlane, launch.body, targetJd).r);
  const planeMissDeg = Math.asin(Math.min(1,
    Math.abs(V.dot(orbitNormal, targetDirection)))) / C.DEG;
  assert.ok(planeMissDeg <= 1,
    `Apollo final launch plane misses the Moon direction by ${planeMissDeg}°`);

  const tli = result.events.find((event) => event.kind === "burn" &&
    event.label.includes("Transfer injection") && event.label.includes("Moon"));
  assert.ok(tli && tli.dv >= 3.0 && tli.dv <= 3.3,
    `Apollo translunar injection Δv left its expected range (${tli && tli.dv} km/s)`);
  const warnings = [];
  apollo.segments.forEach((segment, index) => (segment._warn || []).forEach((warning) =>
    warnings.push(`segment ${index + 1}: ${warning.msg}`)));
  assert.deepStrictEqual(warnings, [],
    "Apollo target-plane launch introduced mission warnings");
}

// The target is not accidentally hard-coded to the common 300 km case.
for (const altKm of [200, 500]) {
  const { samples } = launchResult("ksc", { altKm });
  const meco = samples[samples.length - 1];
  const coe = A.rvToCoe(meco.r, meco.v, earth.mu);
  near(coe.ra - earth.radius, altKm, 1e-8,
    `${altKm} km MECO target was not honored`);
}

// Saved missions predating the `ascent` field must keep their legacy direct
// circular insertion. The default site remains KSC for backward compatibility.
{
  const legacy = {
    type: "launch", body: "earth", altKm: 420,
    incDeg: 51.6, raanDeg: 15,
  };
  const result = ME.recompute({ epoch: EPOCH, segments: [legacy] });
  const endpoint = result.samples[result.samples.length - 1];
  const coe = A.rvToCoe(endpoint.r, endpoint.v, earth.mu);
  near(V.mag(endpoint.r) - earth.radius, 420, 1e-8,
    "legacy launch no longer inserts at its requested altitude");
  near(coe.e, 0, 1e-12,
    "legacy launch without `ascent` no longer inserts into a circular orbit");
  assert.ok(result.events[0].label.includes("420 km circular"),
    "legacy direct-launch event changed its public meaning");
}

// An explicitly blank-site direct insertion is a reviewed orbital-state
// initialization, not a fictitious radial ascent from an arbitrary surface
// point. Preserve the established one-second downstream timing invisibly.
{
  const initialized = {
    type: "launch", body: "earth", site: "", ascent: "direct", altKm: 420,
    incDeg: 51.6, raanDeg: 15,
  };
  const result = ME.recompute({ epoch: EPOCH, segments: [initialized] });
  assert.ok(result.events[0].initialization &&
    result.events[0].label.startsWith("Orbit initialization"),
  "blank-site direct insertion still claims a physical surface launch");
  const initialization = result.samples.filter((sample) => sample.seg === 0);
  assert.strictEqual(initialization.length, 2,
    "orbital initialization should preserve timing without drawing an ascent");
  assert.ok(initialization[0]._breakBefore,
    "orbital initialization must break any preceding trajectory");
  for (const sample of initialization)
    near(V.mag(sample.r) - earth.radius, 420, 1e-8,
      "orbital initialization inserted a surface point");
  nearVec(initialization[0].r, initialization[1].r, 1e-12,
    "orbital initialization created a visible radial bridge");
}

// Default editor values are part of saved-mission compatibility.
{
  const defaults = ME.defaultSegment("launch");
  assert.strictEqual(defaults.site, "ksc", "default launch site changed");
  assert.strictEqual(defaults.ascent, "meco", "default ascent mode changed");
  assert.strictEqual(defaults.altKm, 200, "default target altitude changed");
  assert.strictEqual(defaults.incDeg, 28.5, "default inclination changed");
}

// A short visual bridge may offset absolute playback by its own duration,
// but it must not change the established MECO-to-apoapsis coast. Protect the
// four date-pinned historical launches most sensitive to a launch rewrite.
const BASE_MECO_TO_INSERTION = 802.3787699599418;
for (const presetId of ["apollo11", "cassini", "voyager1", "voyager2"]) {
  const result = ME.recompute(MS.getPreset(presetId));
  const launchSamples = result.samples.filter((sample) => sample.seg === 0);
  const launchEnd = launchSamples[launchSamples.length - 1].t;
  const firstPostLaunch = result.events.find((event) => event.t > launchEnd + 1e-9);
  assert.ok(firstPostLaunch && firstPostLaunch.kind === "burn",
    `${presetId} lost its first post-launch insertion burn`);
  near(firstPostLaunch.t - launchEnd, BASE_MECO_TO_INSERTION, 1e-6,
    `${presetId} launch rewrite changed the solved coast to insertion`);
  assert.strictEqual(result.events.find((event) => event.kind === "launch").t, 0,
    `${presetId} liftoff moved away from its date-pinned epoch`);
}

console.log("PASS  launch pads use selected body-fixed sites");
console.log("PASS  launch ascent is visible and altitude-monotone");
console.log("PASS  MECO conics, burnout altitude, and target apoapsides are preserved");
console.log("PASS  Apollo target-plane dogleg remains bounded and TLI-efficient");
console.log("PASS  legacy direct launches remain compatible");
console.log("PASS  historical launch-to-insertion timing is preserved");
