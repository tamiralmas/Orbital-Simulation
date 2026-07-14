/* Headless renderer-geometry regressions. Run with:
 *   node tests/renderer_tests.js
 * No DOM or canvas implementation is required. */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { C, A, ME, MS } = require("./harness.js");
require(path.join(__dirname, "..", "js", "missions.js"));

const cr3bpSource = fs.readFileSync(path.join(__dirname, "..", "js", "cr3bp.js"), "utf8");
vm.runInThisContext(cr3bpSource, { filename: "cr3bp.js" });

const rendererSource = fs.readFileSync(path.join(__dirname, "..", "js", "renderer.js"), "utf8");
vm.runInThisContext(rendererSource, { filename: "renderer.js" });

const T = globalThis.MTPRender._test;
const V = A.V;
const nearVec = (a, b, tol, msg) => assert.ok(V.mag(V.sub(a, b)) <= tol,
  `${msg}: error ${V.mag(V.sub(a, b))} > ${tol}`);
const angleDeg = (a, b) => Math.acos(Math.max(-1, Math.min(1,
  V.dot(V.norm(a), V.norm(b))))) * 180 / Math.PI;

// Scale-bar anchors supplied by Live are CSS-pixel canvas coordinates. The
// Planner keeps its palette defaults, and hostile/compact anchors are clamped.
{
  const anchored = T.scaleBarLayout(800, 600, 100, 60, { x: 240, y: 72 });
  assert.deepStrictEqual(anchored, { x0: 240, y0: 72, labelX: 260 },
    "explicit scale-bar anchor changed coordinate semantics");
  const low = T.scaleBarLayout(800, 600, 100, 60, { x: -100, y: -100 });
  assert.strictEqual(low.x0, 6, "scale bar escaped the left canvas edge");
  assert.strictEqual(low.y0, 18, "scale bar label escaped the top canvas edge");
  const high = T.scaleBarLayout(800, 600, 100, 60, { x: 900, y: 900 });
  assert.strictEqual(high.x0, 694, "scale bar escaped the right canvas edge");
  assert.strictEqual(high.y0, 594, "scale bar escaped the bottom canvas edge");
}

// The optional eclipse overlay uses true conical umbra/penumbra dimensions,
// and fleet geometry is cached independently of the primary trajectory.
{
  const earth = C.BODIES.earth, sun = C.BODIES.sun;
  const cone = T.shadowConeGeometry([0, 0, 0], [C.AU, 0, 0], sun.radius,
    earth.radius, 2e6);
  assert.ok(cone && cone.umbraLength > 1e6 && cone.umbraLength < 2e6,
    "Earth umbra cone length is implausible");
  assert.ok(cone.umbraEndRadius >= 0 && cone.penumbraEndRadius > earth.radius,
    "shadow cone does not narrow/widen into umbra/penumbra");
  const fleetResult = ME.recompute(MS.getPreset("apollo11"));
  const first = T.fleetTrajectoryCache(fleetResult, "earth", fleetResult.epochJD);
  const second = T.fleetTrajectoryCache(fleetResult, "earth", fleetResult.epochJD);
  assert.strictEqual(first, second, "fleet display path missed its per-result cache");
  assert.ok(first.points.length > 1 && first.points.length <= 1601,
    "fleet display path exceeded its bounded point cap");
  assert.strictEqual(first.times.length, first.points.length,
    "fleet display geometry lost its time axis");
  const nativeMission = ME.recompute(MS.getPreset("apollo11_full"));
  const eagle = nativeMission.vehicleResults.eagle;
  const nativeExact = T.fleetTrajectoryCache(eagle, "moon", eagle.epochJD, true);
  assert.ok(nativeExact.points.length > 1 &&
    nativeExact.points.length <= Math.max(eagle.samples.length, 6000),
  "native fleet exact densification exceeded its render-aware point budget");
  assert(nativeExact.breaks.some(Boolean),
    "joined native follower history should leave a path break instead of a coincident tail");
  assert.strictEqual(T.fleetTimeCovered(nativeExact.times, nativeExact.times[0] - 1), false,
    "an inactive vehicle exposed its trajectory before separation");
  assert.strictEqual(T.fleetTimeCovered(nativeExact.times, nativeExact.times[0]), true,
    "an inactive vehicle disappeared at its first independent state");
  const eagleWindow = T.nativeFleetPathWindow(eagle, nativeExact.times[0]);
  assert.ok(eagleWindow > 0 && eagleWindow < eagle.tEnd - nativeExact.times[0],
    "a non-rendezvous secondary still requested its entire later trajectory");
  assert(/scene\.multiCraft/.test(rendererSource) && /slice\(0, 7\)/.test(rendererSource),
    "renderer does not enforce the seven-comparison-craft display cap");
  assert.strictEqual(T.nativeFleetPointLimit(1), 4800,
    "one inactive native craft lost the reviewed display detail cap");
  assert.strictEqual(T.nativeFleetPointLimit(2), 3000,
    "two inactive native craft did not share the fleet point budget");
  assert.strictEqual(T.nativeFleetPointLimit(7), 900,
    "large native fleets escaped the bounded per-craft floor");
  const issMission = ME.recompute(MS.getPreset("crew_dragon_iss_docking"));
  const iss = issMission.vehicleResults.iss;
  const issPath = T.fleetTrajectoryCache(iss, "earth", iss.epochJD, true);
  const issRange = T.fleetVisibleRange(issPath.times, 1.25 * 3600, 2 * 3600);
  assert.ok(issRange.end - issRange.start > 2 &&
    issRange.end - issRange.start < issPath.points.length / 4,
  "ISS rendezvous context did not reduce to a local moving path window");
  assert.ok(issPath.times[issRange.end - 1] - issPath.times[issRange.start] <=
    2 * 3600 + 300,
  "ISS local path window retained multiple days of target history");
  assert.strictEqual(T.nativeFleetPathWindow(iss, 1.25 * 3600), 2 * 3600,
    "the reviewed ISS context window changed");
  assert(/fleetTrajectoryCache\(craft\.result,[\s\S]*!!craft\.nativeMissionVehicle/.test(rendererSource) &&
    /cache\.denseDocked\[index\]/.test(rendererSource),
  "native mission paths must use exact fleet geometry and suppress joined follower history");
}

// Repeated CR3BP stationkeeping cycles share one local reference-cycle canvas
// window; the integrated mission history remains intact for playback/data.
{
  const halo = ME.recompute(MS.getPreset("earth_moon_l2_halo"));
  const sample = halo.samples.find((entry) => entry.seg === 2);
  const windowS = T.activeTrajectoryWindow(halo, sample);
  assert.ok(windowS > halo.cr3bpOrbit.periodSeconds &&
    windowS < 1.1 * halo.cr3bpOrbit.periodSeconds,
  "active Lagrange rendering did not reduce to one nearby reference cycle");
  const apollo = ME.recompute(MS.getPreset("apollo11"));
  assert.strictEqual(T.activeTrajectoryWindow(apollo, apollo.samples[0]), null,
    "a non-CR3BP sample inherited the stationkeeping display window");
}

assert.strictEqual(T.isStaticApsisFrame("inertial", "sun"), true,
  "heliocentric conics should be cacheable in the inertial frame");
assert.strictEqual(T.isStaticApsisFrame("earth", "earth"), true,
  "central-body conics should be cacheable in their local frame");
assert.strictEqual(T.isStaticApsisFrame("earth", "sun"), false,
  "a moving third-body frame must retain per-epoch apsis geometry");
assert(/frameEpochKey = isStaticApsisFrame\(frameBody, apsisState\.cen\) \? "static"/.test(rendererSource),
  "apsis cache key does not use the static inertial/Sun-frame contract");
assert(/if \(opts\.scaleBar !== false\)\s*\n\s*drawScaleBar\([^;]+opts\.scaleBarAnchor\)/.test(rendererSource),
  "scene options should support anchored and suppressed scale bars");

// Planet occultation is a line-of-sight problem, not a camera-depth sign.
// Exercise the shared pure geometry with simple exact coordinates so Live,
// Deep, and the Planner cannot silently diverge at a body's limb.
{
  const eye = [10, 0, 0];
  const center = [0, 0, 0];
  const radius = 2;
  const hidden = (point) => A.pointOccludedBySphere(point, eye, center, radius);

  assert.strictEqual(hidden([-5, 0, 0]), true,
    "a sphere should hide a point centered behind it");
  assert.strictEqual(hidden([5, 0, 0]), false,
    "a point between the camera and sphere should remain visible");
  assert.strictEqual(hidden([9, 0, 0]), false,
    "a point near the camera must not be mistaken for a sphere intersection");
  assert.strictEqual(hidden([-2, 0, 0]), true,
    "the far surface should be hidden by the sphere's near surface");
  assert.strictEqual(hidden([2, 0, 0]), false,
    "the camera-facing surface should remain visible");
  assert.strictEqual(hidden([-5, 3, 0]), true,
    "a ray just inside the perspective limb should be hidden");
  assert.strictEqual(hidden([-5, 3.2, 0]), false,
    "a far point outside the perspective limb should remain visible");

  const tangent = [0.4, Math.sqrt(3.84), 0];
  const pastTangent = [-9.2, 2 * Math.sqrt(3.84), 0];
  assert.strictEqual(hidden(tangent), false,
    "the exact tangent surface point should remain visible without limb flicker");
  assert.strictEqual(hidden(pastTangent), false,
    "an exact tangent ray beyond the sphere should remain visible");

  const orthographicHidden = (point) =>
    A.pointOccludedBySphereOrthographic(point, [1, 0, 0], center, radius);
  assert.strictEqual(orthographicHidden([-5, 0, 0]), true,
    "orthographic views should hide far-side points inside the projected disk");
  assert.strictEqual(orthographicHidden([5, 0, 0]), false,
    "orthographic views should preserve the camera-facing point");
  assert.strictEqual(orthographicHidden([-5, 1.99, 0]), true,
    "orthographic points just inside the limb should be hidden");
  assert.strictEqual(orthographicHidden([-5, 2, 0]), false,
    "the exact orthographic limb should remain visible");
  assert.strictEqual(orthographicHidden([-5, 2.01, 0]), false,
    "far-side geometry outside the orthographic silhouette should remain visible");

  const spheres = [
    { id: "mars", center, radius },
    { id: "off-ray", center: [0, 20, 0], radius: 1 },
  ];
  assert.strictEqual(A.pointOccludedBySpheres([-5, 0, 0], eye, spheres), true,
    "the on-ray body should win a multi-body occultation query");
  assert.strictEqual(A.pointOccludedBySpheres([-5, 0, 0], eye, spheres, "mars"), false,
    "an explicitly ignored body must not hide its own render geometry");
}

// An optional scene provider must be authoritative for body centers and
// world-space orbit paths, while an ordinary Planner scene keeps Astro.
{
  const jd = C.J2000_JD + 123;
  nearVec(T.bodyWorldForScene({}, "earth", jd), A.bodyWorld("earth", jd), 0,
    "default renderer body source diverged from Astro");
  const providedPath = [[10, 20, 30], [11, 21, 31]];
  const calls = [];
  const scene = {
    bodyWorld(id, atJd) { calls.push([id, atJd]); return id === "moon" ? [130, 0, 0] : [100, 0, 0]; },
    bodyOrbitPath(id, atJd) { return id === "moon" && atJd === jd ? providedPath : null; },
  };
  nearVec(T.bodyWorldForScene(scene, "earth", jd), [100, 0, 0], 0,
    "scene provider did not override the parent body center");
  nearVec(T.bodyWorldForScene(scene, "moon", jd), [130, 0, 0], 0,
    "scene provider did not override the child body center");
  assert.deepStrictEqual(V.sub(T.bodyWorldForScene(scene, "moon", jd),
    T.bodyWorldForScene(scene, "earth", jd)), [30, 0, 0],
  "provider body hierarchy did not share one world coordinate source");
  assert.strictEqual(T.bodyOrbitPathForScene(scene, "moon", jd), providedPath,
    "renderer did not preserve the provider's world-space orbit path");
  assert.strictEqual(T.bodyOrbitPathForScene({}, "moon", jd), null,
    "Planner scenes should retain the built-in orbit path fallback");
  assert(calls.length >= 4, "body provider was not consulted for each requested center");

  const gradient = { addColorStop() {} };
  const context = new Proxy({
    measureText() { return { width: 10 }; },
    createRadialGradient() { return gradient; },
    createLinearGradient() { return gradient; },
  }, {
    get(target, property) { return property in target ? target[property] : (() => {}); },
  });
  const camera = globalThis.MTPRender.createCamera();
  camera.focusBody = "earth";
  const out = {};
  globalThis.MTPRender.draw(context, 800, 600, {
    camera, jd, epochJD: jd, result: null, tNow: 0, frameBody: "inertial", shipSmp: null,
    bodyWorld(id, atJd) {
      if (id === "earth") return [100, 0, 0];
      if (id === "moon") return [130, 0, 0];
      return A.bodyWorld(id, atJd);
    },
    options: { grid: false, orbits: false, soi: false, labels: false, textures: false,
      events: false, apsides: false },
    out,
  });
  nearVec(out.basis.center, [100, 0, 0], 0,
    "camera focus did not use the authoritative body provider");
  nearVec(out.bodyPositions.earth, [100, 0, 0], 0,
    "rendered parent body did not use the authoritative provider");
  nearVec(out.bodyPositions.moon, [130, 0, 0], 0,
    "rendered child body did not share the authoritative provider");
  nearVec(out.basis.eye,
    V.sub(out.basis.center, V.scale(out.basis.F, camera.dist)), 0,
    "renderer did not expose the exact world-space camera eye to overlays");
  const earthOccluder = out.occluders.find((sphere) => sphere.id === "earth");
  assert(earthOccluder && earthOccluder.radius === C.BODIES.earth.radius,
    "renderer did not expose Earth's physical sphere as an overlay occluder");
  nearVec(earthOccluder.center, out.bodyPositions.earth, 0,
    "overlay occluder and rendered Earth used different body centers");
}

assert(/pointOccludedBySpheres\(sw, eyeWorld, occluders\)/.test(rendererSource) &&
  /if \(p\) \{[\s\S]*if \(occluded\) g\.globalAlpha \*= 0\.78/.test(rendererSource),
"the selected Planner arrow must remain visible as an occluded navigation indicator");
assert(/pointOccludedBySpheres\(displayPoint, eyeWorld, occluders\)[\s\S]*if \(!projected \|\| occluded\) continue/.test(rendererSource),
"inactive spacecraft must retain physical planetary occultation");

// Synodic display geometry is evaluated at each point's own epoch and then
// restored at one display epoch. Two inertial points representing the same
// rotating coordinate at different dates must therefore coincide on screen.
{
  const frame = "synodic:earth-moon";
  const jdA = C.J2000_JD + 10;
  const jdB = C.J2000_JD + 19;
  const jdDisplay = C.J2000_JD + 31;
  const basisA = T.synodicFrameBasis(CR3BP.SYSTEMS.earthMoon, jdA);
  const basisB = T.synodicFrameBasis(CR3BP.SYSTEMS.earthMoon, jdB);
  const displayBasis = T.synodicFrameBasis(CR3BP.SYSTEMS.earthMoon, jdDisplay);
  const displayContext = T.displayFrameContext(frame, jdDisplay);
  const inertialVector = V.norm([0.31, -0.82, 0.47]);
  nearVec(T.vectorFromDisplayFrame(
    T.vectorRelativeToDisplayFrame(inertialVector, displayContext), displayContext),
  inertialVector, 1e-12, "synodic camera/vector transform did not round-trip");
  const rotating = [0.27 * basisA.separationKm, -0.11 * basisA.separationKm,
    0.02 * basisA.separationKm];
  const rotatingB = rotating.slice();
  const inertialA = T.synodicWorld(rotating, basisA);
  const inertialB = T.synodicWorld(rotatingB, basisB);
  const shownA = T.pointInDisplayFrame(inertialA, frame, jdA, jdDisplay);
  const shownB = T.pointInDisplayFrame(inertialB, frame, jdB, jdDisplay);
  const expectedA = V.add(displayBasis.origin, rotating);
  const expectedB = V.add(displayBasis.origin, rotatingB);
  nearVec(shownA, expectedA, 1e-6,
    "Earth-Moon rotating coordinate was not restored at display epoch");
  nearVec(shownB, expectedB, 1e-6,
    "historical point used display-epoch axes instead of its own epoch");
  nearVec(shownA, shownB, 1e-6,
    "equal rotating coordinates did not remain frozen across point epochs");
}

// L1-L5 are virtual points derived from the reviewed CR3BP mass ratio, but
// their world geometry uses the actual primary/secondary separation and axes.
{
  const jd = C.J2000_JD + 77;
  const system = CR3BP.SYSTEMS.sunEarth;
  const basis = T.synodicFrameBasis(system, jd);
  const markers = T.librationPointRecords(system, jd, "inertial");
  assert.deepStrictEqual(markers.map((marker) => marker.name), ["L1", "L2", "L3", "L4", "L5"],
    "renderer did not expose all five ordered equilibrium markers");
  const expected = CR3BP.equilibriumPoints(system);
  for (const marker of markers) {
    nearVec(T.synodicCoordinates(marker.inertialWorld, basis),
      expected[marker.name].position.map((value) => value * basis.separationKm), 1e-5,
      marker.name + " did not use the epoch's actual Sun-Earth state");
  }
  assert.strictEqual(C.BODIES[markers[0].id], undefined,
    "virtual L-points must not leak into the massive-body catalog");
  assert(/A\.pointOccludedBySpheres\(marker\.world, eyeWorld, occluders\)/.test(rendererSource),
    "L-point markers must use the same physical occultation test as spacecraft");
}

// Exercise the complete draw path in a rotating frame. The current Earth and
// Moon must lie on the fixed synodic x-axis and virtual points must be exposed
// through a separate pick channel rather than scene.out.bodies.
{
  const gradient = { addColorStop() {} };
  const context = new Proxy({
    measureText() { return { width: 10 }; },
    createRadialGradient() { return gradient; },
    createLinearGradient() { return gradient; },
  }, {
    get(target, property) { return property in target ? target[property] : (() => {}); },
  });
  const jd = C.J2000_JD + 40;
  const camera = globalThis.MTPRender.createCamera();
  camera.focusBody = "earth";
  camera.dist = 1.5e6;
  const out = {};
  globalThis.MTPRender.draw(context, 900, 650, {
    camera, jd, epochJD: jd, result: null, tNow: 0,
    frameBody: "synodic:earth-moon", cr3bpSystem: "earth-moon", shipSmp: null,
    options: { grid: false, orbits: false, soi: false, labels: false, textures: false,
      events: false, apsides: false, lagrange: true },
    out,
  });
  const basis = T.synodicFrameBasis(CR3BP.SYSTEMS.earthMoon, jd);
  const earthLocal = V.sub(out.bodyPositions.earth, basis.origin);
  const moonLocal = V.sub(out.bodyPositions.moon, basis.origin);
  assert.ok(Math.abs(earthLocal[1]) < 1e-6 && Math.abs(earthLocal[2]) < 1e-6 &&
    Math.abs(moonLocal[1]) < 1e-6 && Math.abs(moonLocal[2]) < 1e-6,
  "current primaries did not remain on the fixed synodic x-axis");
  assert.ok(out.librationPoints.length >= 3,
    "rotating-frame draw did not expose visible L-point pick targets");
  assert.strictEqual(Object.keys(out.bodies).some((id) => id.startsWith("libration:")), false,
    "virtual L-points leaked into the body pick channel");
}

// Deep reuses the Planner's minor-body declutter contract. Ordinary minor
// bodies disappear, while an exact Focus or Frame remains rendered so users
// cannot select a body and blank the view by hiding its category.
{
  const gradient = { addColorStop() {} };
  const context = new Proxy({
    measureText() { return { width: 10 }; },
    createRadialGradient() { return gradient; },
    createLinearGradient() { return gradient; },
  }, {
    get(target, property) { return property in target ? target[property] : (() => {}); },
  });
  const drawBodies = (focusBody, frameBody) => {
    const camera = globalThis.MTPRender.createCamera();
    camera.focusBody = focusBody;
    camera.dist = 100 * C.AU;
    const out = {};
    globalThis.MTPRender.draw(context, 800, 600, {
      camera, jd: C.J2000_JD, epochJD: C.J2000_JD, result: null, tNow: 0,
      frameBody, shipSmp: null,
      options: { grid: false, minor: false, orbits: false, soi: false, labels: false,
        textures: false, events: false, apsides: false },
      out,
    });
    return out.bodies;
  };
  assert.strictEqual(Boolean(drawBodies("sun", "inertial").vesta), false,
    "minor:false should hide an ordinary Vesta render/pick target");
  assert(Boolean(drawBodies("vesta", "inertial").vesta),
    "minor:false should preserve the active minor Focus");
  assert(Boolean(drawBodies("sun", "vesta").vesta),
    "minor:false should preserve the active minor Frame");
}

// A perspective body's far-side limb can be closer to the camera than the
// body's center. The former center-depth front pass painted that hidden
// trajectory point back over the texture, making the ship look as if it had
// travelled through the planet. The front pass must use the physical sphere.
{
  const eye = [10, 0, 0];
  const center = [0, 0, 0];
  const radius = 2;
  const focalLength = 100;
  const apparentRadius = focalLength * radius / Math.sqrt(10 * 10 - radius * radius);
  const disks = [{
    x: 0, y: 0, r: apparentRadius,
    sphere: { id: "test-body", center, radius },
  }];
  const screenX = (point) => focalLength * point[1] / (10 - point[0]);
  const hiddenNearLimb = [0.2, 1.999, 0];
  assert.ok(10 - hiddenNearLimb[0] < 10,
    "regression point must be nearer than the body center");
  assert.ok(screenX(hiddenNearLimb) < apparentRadius,
    "regression point must project inside the body silhouette");
  assert.strictEqual(T.trajectoryFrontPassSkip(hiddenNearLimb, eye,
    screenX(hiddenNearLimb), 0, disks), true,
  "far-side limb path was repainted over the planet");

  const visibleNearLimb = [1, 1.75, 0];
  assert.strictEqual(T.trajectoryFrontPassSkip(visibleNearLimb, eye,
    screenX(visibleNearLimb), 0, disks), false,
  "camera-facing limb path should remain visible");
  assert.strictEqual(T.trajectoryFrontPassSkip([0, 3, 0], eye, 30, 0, disks), true,
    "front pass should not repaint path that never overlaps a body disk");
}

// A recompute with the same number of samples and duration must not reuse
// the preceding result's geometry.
{
  const make = (x) => ({
    epochJD: C.J2000_JD, tEnd: 10, events: [],
    samples: [
      { t: 0, cen: "sun", r: [x, 0, 0], v: [0, 0, 0], w: [x, 0, 0] },
      { t: 10, cen: "sun", r: [x + 1, 0, 0], v: [0, 0, 0], w: [x + 1, 0, 0] },
    ],
  });
  const r1 = make(1), r2 = make(100);
  assert.strictEqual(T.trajectoryCache(r1, "inertial", r1.epochJD).rel[0][0], 1);
  assert.strictEqual(T.trajectoryCache(r2, "inertial", r2.epochJD).rel[0][0], 100);
}

// The dense active bridge must contain the exact universal-variable state,
// rather than the visibly inward straight chord between sparse endpoints.
{
  const earth = C.BODIES.earth;
  const epochJD = C.J2000_JD + 9000;
  const r0 = [7000, 0, 0];
  const v0 = [0, Math.sqrt(earth.mu / 7000), 0];
  const span = 180;
  const end = A.propagateUniversal(r0, v0, span, earth.mu);
  const world = (r, t) => V.add(A.bodyWorld("earth", epochJD + t / C.DAY), r);
  const result = {
    epochJD, tEnd: span, events: [],
    samples: [
      { t: 0, cen: "earth", seg: 0, r: r0, v: v0, w: world(r0, 0), _interp: null },
      { t: span, cen: "earth", seg: 0, r: end.r, v: end.v,
        w: world(end.r, span), _interp: "kepler" },
    ],
  };
  const tm = span / 2;
  const exact = ME.sampleAtTime(result, tm);
  const chord = V.scale(V.add(r0, end.r), 0.5);
  assert.ok(V.mag(V.sub(chord, exact.r)) > 10,
    "test span must expose a material sparse-chord error");

  const localBridge = T.currentTrajectoryBridge(result, tm, "earth");
  nearVec(localBridge.current, exact.r, 1e-8,
    "body-relative active trajectory bridge missed the spacecraft");
  nearVec(localBridge.past[localBridge.past.length - 1], exact.r, 1e-8,
    "past trajectory did not end at the exact spacecraft state");
  nearVec(localBridge.future[0], exact.r, 1e-8,
    "future trajectory did not start at the exact spacecraft state");

  const localGeom = T.osculatingGeometry(exact, epochJD + tm / C.DAY, "earth", 64);
  nearVec(localGeom.pts[0], localBridge.current, 1e-7,
    "local apsis orbit and trajectory use different coordinates");

  const exactStartBridge = T.currentTrajectoryBridge(result, 0, "earth");
  assert.ok(exactStartBridge.future.length >= 2,
    "future path must connect to the spacecraft at an exact sample timestamp");
  nearVec(exactStartBridge.future[0], r0, 1e-8,
    "exact-timestamp future path did not start at the spacecraft");

  const inertialBridge = T.currentTrajectoryBridge(result, tm, "inertial");
  const inertialGeom = T.osculatingGeometry(exact, epochJD + tm / C.DAY, "inertial", 64);
  nearVec(inertialGeom.pts[0], inertialBridge.current, 1e-5,
    "inertial apsis orbit and trajectory use different epoch transforms");
}

// Completed and upcoming sparse Kepler spans must use the same propagated
// curve as the ship/apsis geometry, not just repair whichever span is active.
{
  const earth = C.BODIES.earth;
  const epochJD = C.J2000_JD + 9100;
  const r0 = [7000, 0, 0];
  const v0 = [0, Math.sqrt(earth.mu / 7000), 0];
  const period = 2 * Math.PI * Math.sqrt(Math.pow(7000, 3) / earth.mu);
  const t1 = period * 0.35; // 126 degrees: Apollo-like sparse departure chord
  const t2 = period * 0.42;
  const s1 = A.propagateUniversal(r0, v0, t1, earth.mu);
  const s2 = A.propagateUniversal(r0, v0, t2, earth.mu);
  const world = (r, t) => V.add(A.bodyWorld("earth", epochJD + t / C.DAY), r);
  const result = {
    epochJD, tEnd: t2, events: [],
    samples: [
      { t: 0, cen: "earth", seg: 0, r: r0, v: v0,
        w: world(r0, 0), _interp: null },
      { t: t1, cen: "earth", seg: 0, r: s1.r, v: s1.v,
        w: world(s1.r, t1), _interp: "kepler" },
      { t: t2, cen: "earth", seg: 0, r: s2.r, v: s2.v,
        w: world(s2.r, t2), _interp: "kepler" },
    ],
  };

  const local = T.trajectoryCache(result, "earth", epochJD);
  assert.ok(local.denseAdded > 20,
    "sparse stored orbit was left as a straight endpoint chord");
  assert.ok(local.denseRel.length <= result.samples.length + 12000,
    "whole-trajectory densification exceeded its global point budget");
  const endIndex = local.sampleDenseIndex[1];
  assert.ok(endIndex > 2, "first stored span did not receive exact interior points");
  const midIndex = Math.round(endIndex / 2);
  const denseTime = local.denseT[midIndex];
  const exact = ME.sampleAtTime(result, denseTime);
  nearVec(local.denseRel[midIndex], exact.r, 1e-7,
    "cached body-relative path point was not exact propagation");
  const f = denseTime / t1;
  const chord = V.add(V.scale(r0, 1 - f), V.scale(s1.r, f));
  assert.ok(V.mag(V.sub(chord, local.denseRel[midIndex])) > 1000,
    "regression span does not distinguish the exact orbit from its chord");
  const apsis = T.osculatingGeometry(exact, epochJD + denseTime / C.DAY,
    "earth", 64);
  nearVec(apsis.pts[0], local.denseRel[midIndex], 1e-7,
    "stored orange path and apsis geometry use different propagated states");

  const inertial = T.trajectoryCache(result, "inertial", epochJD);
  nearVec(inertial.denseRel[midIndex], exact.w, 1e-6,
    "cached inertial path lost the per-point epoch/frame transform");
}

// Burn endpoint metadata must represent the exact applied impulse, and the
// preview must interpolate only visually before reaching the solved state.
{
  const launch = ME.defaultSegment("launch");
  launch.ascent = "direct";
  launch.altKm = 300;
  const impulse = ME.defaultSegment("impulse");
  impulse.dv1 = 0.2;
  const coast = ME.defaultSegment("coast");
  coast.days = 0.02;
  const result = ME.recompute({
    epoch: "2030-01-01T00:00:00Z",
    segments: [launch, impulse, coast],
  });
  const ev = result.events.find((e) => e._burn);
  assert.ok(ev, "an applied impulse must retain private preview endpoints");
  const eventSample = ME.sampleAtTime(result, ev.t);
  const eventBridge = T.currentTrajectoryBridge(result, ev.t, "earth");
  assert.ok(eventBridge.future.length >= 2,
    "future path must be drawable at an exact burn timestamp");
  nearVec(eventBridge.future[0], eventSample.r, 1e-7,
    "post-burn future path did not begin at the spacecraft");
  nearVec(V.sub(ev._burn.v1, ev._burn.v0),
    V.scale(V.norm(ev._burn.v0), 0.2), 1e-10,
    "burn preview endpoint does not match the solved impulse");
  const startSmp = ME.sampleAtTime(result, ev.t);
  const atStart = T.burnPreviewState(result, ev.t, startSmp);
  const middleT = (atStart.start + atStart.end) / 2;
  const middleSmp = ME.sampleAtTime(result, middleT);
  const middle = T.burnPreviewState(result, middleT, middleSmp);
  const endSmp = ME.sampleAtTime(result, atStart.end);
  const atEnd = T.burnPreviewState(result, atStart.end, endSmp);
  assert.ok(middle && middle.fraction > 0 && middle.fraction < 1,
    "burn preview did not produce a gradual intermediate state");
  assert.ok(atEnd && atEnd.fraction === 1,
    "preview must reach the exact post-burn state at the end of its visual ramp");
  nearVec(atEnd.state.v, endSmp.v, 1e-12,
    "preview endpoint diverges from the actual post-burn velocity");
  nearVec(atStart.state.r, startSmp.r, 1e-12,
    "preview start detached from the spacecraft");
  nearVec(middle.state.r, middleSmp.r, 1e-12,
    "preview midpoint detached from the spacecraft");
  nearVec(atEnd.state.r, endSmp.r, 1e-12,
    "preview endpoint detached from the spacecraft");
  const mu = C.BODIES[ev._burn.cen].mu;
  const ra0 = A.rvToCoe(atStart.state.r, atStart.state.v, mu).ra;
  const raMid = A.rvToCoe(middle.state.r, middle.state.v, mu).ra;
  const ra1 = A.rvToCoe(atEnd.state.r, atEnd.state.v, mu).ra;
  assert.ok(ra0 < raMid && raMid < ra1,
    "a prograde visual burn ramp must raise apoapsis monotonically");
  const middleGeom = T.osculatingGeometry(middle.state,
    result.epochJD + middle.state.t / C.DAY, "earth", 64);
  nearVec(middleGeom.pts[0], middleSmp.r, 1e-7,
    "gradual apsis preview path does not pass through the spacecraft");
  assert.strictEqual(T.burnPreviewState(result, atStart.end + 1,
    ME.sampleAtTime(result, atStart.end + 1)), null,
    "visual preview must not continue after its labelled ramp");

  // A burn with enough coast before it uses the complementary lead-in
  // formula and must likewise remain attached to the pre-burn spacecraft.
  const launch2 = ME.defaultSegment("launch");
  launch2.ascent = "direct";
  launch2.altKm = 300;
  const coastBefore = ME.defaultSegment("coast");
  coastBefore.days = 0.01;
  const impulse2 = ME.defaultSegment("impulse");
  impulse2.dv1 = 0.2;
  const coastAfter = ME.defaultSegment("coast");
  coastAfter.days = 0.01;
  const leadResult = ME.recompute({
    epoch: "2030-01-01T00:00:00Z",
    segments: [launch2, coastBefore, impulse2, coastAfter],
  });
  const leadEv = leadResult.events.find((e) => e._burn);
  const leadAtEvent = T.burnPreviewState(leadResult, leadEv.t,
    ME.sampleAtTime(leadResult, leadEv.t));
  const leadT = (leadAtEvent.start + leadEv.t) / 2;
  const leadSmp = ME.sampleAtTime(leadResult, leadT);
  const leadPreview = T.burnPreviewState(leadResult, leadT, leadSmp);
  const leadDv = V.sub(leadEv._burn.v1, leadEv._burn.v0);
  nearVec(leadPreview.state.r, leadSmp.r, 1e-12,
    "pre-burn gradual preview detached from the spacecraft");
  nearVec(leadPreview.state.v,
    V.add(leadSmp.v, V.scale(leadDv, leadPreview.fraction)), 1e-12,
    "pre-burn gradual preview applied the wrong partial impulse");
}


// Interplanetary departures now draw a real local hyperbolic coast instead of
// interpolating the ship from parking orbit to an SOI point at the same epoch.
// The finite AP guide ends at ignition; exact local geometry is visible from
// then through the later, position-continuous frame patch.
for (const presetId of ["cassini", "voyager1", "voyager2"]) {
  const result = ME.recompute(MS.getPreset(presetId));
  assert.strictEqual(T.burnPreviewTimings(result), T.burnPreviewTimings(result),
    presetId + " repeated burn timing queries bypassed the result cache");
  const departure = result.events.find((event) =>
    event.kind === "burn" && event._burn && event._burn.continuousSoi);
  assert.ok(departure && departure._burn.handoff && !departure._burn.instantSoi,
    presetId + " Earth departure lacks continuous-SOI burn metadata");
  assert.strictEqual(departure._burn.cen, "earth",
    presetId + " departure is not expressed in the parking-orbit frame");
  const exitEvent = result.events.find((event) => event.kind === "soi_exit" &&
    event.seg === departure.seg && event.t > departure.t && event.body === "sun");
  assert.ok(exitEvent && exitEvent.t - departure.t > 3600,
    presetId + " did not retain a time-resolved Earth escape coast");

  const atOneSecond = ME.sampleAtTime(result, departure.t + 1);
  const atTenMinutes = ME.sampleAtTime(result, departure.t + 600);
  assert.strictEqual(atOneSecond.cen, "earth",
    presetId + " jumped to the Sun frame one second after ignition");
  assert.strictEqual(atTenMinutes.cen, "earth",
    presetId + " jumped to the Sun frame during the local escape coast");
  assert.ok(V.mag(atOneSecond.r) < 2 * V.mag(departure._burn.r),
    presetId + " marker teleported away from parking orbit at ignition");

  const sameTime = result.samples.map((sample, index) => ({ sample, index }))
    .filter(({ sample }) => Math.abs(sample.t - exitEvent.t) < 1e-4);
  const localExit = sameTime.find(({ sample }) => sample.cen === "earth");
  const parentEntry = sameTime.find(({ sample }) => sample.cen === "sun");
  assert.ok(localExit && parentEntry && parentEntry.index > localExit.index,
    presetId + " SOI patch lacks ordered local/parent samples");
  nearVec(localExit.sample.w, parentEntry.sample.w, 1e-7,
    presetId + " SOI frame patch is not position-continuous");
  assert.ok(!parentEntry.sample._breakBefore,
    presetId + " continuous SOI patch retained a hard path break");

  const departureCache = T.trajectoryCache(result, "inertial", result.epochJD);
  const localDense = departureCache.sampleDenseIndex[localExit.index];
  const parentDense = departureCache.sampleDenseIndex[parentEntry.index];
  assert.strictEqual(T.hasPolylineBreak(departureCache.denseBreakBefore,
    localDense, parentDense), false,
  presetId + " renderer disconnects the continuous SOI handoff");

  const atEvent = T.burnPreviewState(result, departure.t,
    ME.sampleAtTime(result, departure.t));
  assert.ok(atEvent && atEvent.mode === "escape" && atEvent.state.cen === "earth",
    presetId + " ignition does not expose the Earth escape state");
  assert.ok(atEvent.start < departure.t && atEvent.end > departure.t,
    presetId + " escape preview does not straddle ignition");
  const preTimes = [atEvent.start, (atEvent.start + departure.t) / 2,
    departure.t - 0.01];
  const prePreviews = preTimes.map((time) => T.burnPreviewState(result, time,
    ME.sampleAtTime(result, time)));
  assert(prePreviews.every((preview) => preview && !preview.apoOpen &&
    T.shouldDrawFiniteApsis(preview)),
  presetId + " finite apoapsis disappeared before ignition");
  const radii = prePreviews.map((preview) =>
    A.rvToCoe(preview.state.r, preview.state.v, C.BODIES.earth.mu).ra);
  for (let i = 1; i < radii.length; i++)
    assert.ok(radii[i] > radii[i - 1],
      presetId + " illustrative apoapsis did not rise monotonically");
  assert.ok(radii[radii.length - 1] > C.BODIES.moon.aKm,
    presetId + " Earth escape apoapsis did not visibly rise past the Moon");

  const postT = 0.5 * (departure.t + atEvent.end);
  const postLive = ME.sampleAtTime(result, postT);
  const post = T.burnPreviewState(result, postT, postLive);
  assert.ok(atEvent.apoOpen && post.apoOpen &&
    !T.shouldDrawFiniteApsis(atEvent) && !T.shouldDrawFiniteApsis(post),
  presetId + " retained a numeric apoapsis after escape ignition");
  const postDisplay = T.burnPreviewDisplayState(result, postLive, post);
  nearVec(postDisplay.w, postLive.w, 1e-10,
    presetId + " post-ignition display interpolates toward the distant SOI");
  nearVec(postDisplay.r, postLive.r, 1e-10,
    presetId + " post-ignition local position is not the propagated state");

  const forbiddenPostGeom = { pts: [[1, 0, 0], [2, 0, 0]] };
  const postBridge = T.trajectoryBridgeForDisplay(result, postT, "earth",
    forbiddenPostGeom, post);
  assert.strictEqual(postBridge.previewFuture, null,
    presetId + " exact escape accepted a closed post-ignition guide");
  assert.strictEqual(postBridge.previewAlpha, 0,
    presetId + " closed escape path survived ignition");
  assert.strictEqual(postBridge.solvedAlpha, 1,
    presetId + " exact local escape path was faded behind an omitted coast");
}

// Apollo 11 exercises both missing transition classes: hyperbolic lunar
// capture must visibly lower a finite illustrative apoapsis after LOI, and the
// patched-conic lunar departure must retain local burn metadata so its
// apoapsis rises before the frame handoff. The visible capture path shares the
// apsis geometry while retaining the distinct exact future bridge underneath.
{
  const apollo = globalThis.Missions.getPreset("apollo11");
  const result = ME.recompute(apollo);

  // Find a stored timestamp whose dense past range has the parity that
  // exposed the original endpoint bug. Mission geometry legitimately changes
  // sample counts, so the regression selects by its behavioral conditions
  // instead of pinning one brittle Apollo sample index.
  const parityCache = T.trajectoryCache(result, "inertial", result.epochJD);
  let paritySample = null, parityBridge = null, parityEnd = 0, parityStride = 0;
  for (let i = 0; i < result.samples.length; i++) {
    const end = parityCache.sampleDenseIndex[i] + 1;
    const stride = Math.max(1, Math.ceil(end / 3800));
    const legacyLast = end - 1 - ((end - 1) % stride);
    if (stride !== 2 || legacyLast === end - 1) continue;
    if (V.mag(V.sub(parityCache.denseRel[legacyLast],
      parityCache.denseRel[end - 1])) <= 100000) continue;
    const bridge = T.currentTrajectoryBridge(result, result.samples[i].t, "inertial");
    if (bridge.past.length !== 1) continue;
    paritySample = result.samples[i];
    parityBridge = bridge;
    parityEnd = end;
    parityStride = stride;
    break;
  }
  assert.ok(paritySample && parityBridge,
    "Apollo no longer supplies a deterministic decimated-endpoint parity case");
  assert.strictEqual(parityStride, 2,
    "Apollo parity regression requires a decimated past path");
  assert.strictEqual(parityBridge.past.length, 1,
    "exact stored timestamp should have a one-point past bridge");
  const emitted = [];
  for (let i = 0; i < parityEnd; i = T.nextPolylineIndex(i, parityEnd, parityStride))
    emitted.push(i);
  assert.strictEqual(emitted[emitted.length - 1], parityEnd - 1,
    "strided polyline omitted its requested range endpoint");
  assert.strictEqual(new Set(emitted).size, emitted.length,
    "endpoint-inclusive stride emitted a duplicate point");
  const legacyLast = parityEnd - 1 - ((parityEnd - 1) % parityStride);
  assert.ok(V.mag(V.sub(parityCache.denseRel[legacyLast],
    parityCache.denseRel[parityEnd - 1])) > 100000,
    "Apollo parity setup must expose the former large endpoint gap");
  nearVec(parityCache.denseRel[parityEnd - 1], parityBridge.current, 1e-7,
    "dense past endpoint does not meet the exact-timestamp bridge");

  const captureEv = result.events.find((e) => e.label.includes("Moon orbit insertion"));
  assert.ok(captureEv && captureEv._burn,
    "Apollo lunar capture must retain preview endpoints");
  const captureStart = T.burnPreviewState(result, captureEv.t,
    ME.sampleAtTime(result, captureEv.t));
  assert.ok(captureStart && captureStart.mode === "capture",
    "hyperbolic-to-bound lunar insertion must enter capture preview mode");
  assert.ok(captureStart.end - captureStart.start >= 900,
    "lunar capture preview is too fast to read");
  const captureMidT = (captureStart.start + captureStart.end) / 2;
  const captureMid = T.burnPreviewState(result, captureMidT,
    ME.sampleAtTime(result, captureMidT));
  const captureEnd = T.burnPreviewState(result, captureStart.end,
    ME.sampleAtTime(result, captureStart.end));
  const moonMu = C.BODIES.moon.mu;
  const capRa0 = A.rvToCoe(captureStart.state.r, captureStart.state.v, moonMu).ra;
  const capRaMid = A.rvToCoe(captureMid.state.r, captureMid.state.v, moonMu).ra;
  const capRa1 = A.rvToCoe(captureEnd.state.r, captureEnd.state.v, moonMu).ra;
  assert.ok(capRa0 > capRaMid && capRaMid > capRa1,
    "Apollo lunar capture must lower the illustrative apoapsis monotonically");
  nearVec(captureEnd.state.v, ME.sampleAtTime(result, captureStart.end).v, 1e-9,
    "capture preview must finish on the solved post-burn state");

  const captureGeom = T.osculatingGeometry(captureMid.state,
    result.epochJD + captureMidT / C.DAY, "moon", 64);
  const exactCaptureBridge = T.currentTrajectoryBridge(result, captureMidT, "moon");
  const displayBridge = T.trajectoryBridgeForDisplay(result, captureMidT,
    "moon", captureGeom, captureMid);
  assert.strictEqual(displayBridge.previewFuture, captureGeom.pts,
    "burn-preview trajectory and apsis overlay must share identical geometry");
  assert.notStrictEqual(displayBridge.future, displayBridge.previewFuture,
    "capture preview must retain the distinct exact future bridge");
  assert.ok(displayBridge.future.length > 1 && exactCaptureBridge.future.length > 1,
    "capture exact future bridge is not drawable");
  nearVec(displayBridge.future[0], exactCaptureBridge.future[0], 1e-8,
    "capture preview altered the exact future bridge");
  assert.strictEqual(displayBridge.previewAlpha, 1,
    "capture preview geometry should remain fully visible");
  assert.strictEqual(displayBridge.solvedAlpha, 0,
    "capture exact future should remain hidden behind the preview geometry");
  assert.strictEqual(displayBridge.previewActive, true,
    "preview geometry must suppress the conflicting solved future track");

  const departureEv = result.events.find((e) => e.label.includes("Trans-Earth injection"));
  assert.ok(departureEv && departureEv._burn && departureEv._burn.cen === "moon",
    "Apollo lunar departure must retain local preview endpoints before frame handoff");
  const departureNear = T.burnPreviewState(result, departureEv.t - 1,
    ME.sampleAtTime(result, departureEv.t - 1));
  assert.ok(departureNear && departureNear.mode === "escape",
    "bound-to-hyperbolic lunar departure must enter escape preview mode");
  assert.ok(departureNear.end - departureNear.start >= 900,
    "lunar departure preview is too fast to read");
  const departureStart = T.burnPreviewState(result, departureNear.start,
    ME.sampleAtTime(result, departureNear.start));
  const departureMidT = (departureNear.start + departureNear.end) / 2;
  const departureMid = T.burnPreviewState(result, departureMidT,
    ME.sampleAtTime(result, departureMidT));
  const depRa0 = A.rvToCoe(departureStart.state.r, departureStart.state.v, moonMu).ra;
  const depRaMid = A.rvToCoe(departureMid.state.r, departureMid.state.v, moonMu).ra;
  const depRa1 = A.rvToCoe(departureNear.state.r, departureNear.state.v, moonMu).ra;
  assert.ok(depRa0 < depRaMid && depRaMid < depRa1,
    "Apollo lunar departure must raise the illustrative apoapsis monotonically");
  const departureAtEvent = T.burnPreviewState(result, departureEv.t,
    ME.sampleAtTime(result, departureEv.t));
  assert.ok(departureAtEvent && departureAtEvent.apoOpen &&
    !T.shouldDrawFiniteApsis(departureAtEvent),
  "Apollo departure did not switch from finite AP to AP OPEN at ignition");
  const departureJustAfter = T.burnPreviewState(result, departureEv.t + 0.01,
    ME.sampleAtTime(result, departureEv.t + 0.01));
  assert.ok(departureJustAfter.apoOpen &&
    !T.shouldDrawFiniteApsis(departureJustAfter),
  "Apollo numeric apoapsis reappeared just after the frame handoff");
  const departurePostT = (departureEv.t + departureAtEvent.end) / 2;
  const departurePostLive = ME.sampleAtTime(result, departurePostT);
  const departurePost = T.burnPreviewState(result, departurePostT,
    departurePostLive);
  assert.ok(departureAtEvent && departurePost && departurePost.state.cen === "moon",
    "Apollo departure preview left the explicit lunar escape coast");
  assert.strictEqual(departurePostLive.cen, "moon",
    "Apollo escaped the Moon before traversing its SOI");
  const exactMoonR = departurePostLive.r;
  const exactMoonV = departurePostLive.v;
  nearVec(departurePost.state.r, exactMoonR, 1e-7,
    "Apollo post-handoff preview did not retain the exact spacecraft position");
  nearVec(departurePost.state.v, exactMoonV, 1e-9,
    "Apollo post-handoff preview mixed an illustrative velocity into the exact state");
  const departurePostDisplay = T.burnPreviewDisplayState(result,
    departurePostLive, departurePost);
  nearVec(departurePostDisplay.w, departurePostLive.w, 1e-8,
    "Apollo return display diverged from the solved local hyperbola");
  const forbiddenMoonGeom = { pts: [[1, 0, 0], [2, 0, 0]] };
  const departurePostBridge = T.trajectoryBridgeForDisplay(result,
    departurePostT, "moon", forbiddenMoonGeom, departurePost);
  assert.strictEqual(departurePostBridge.previewFuture, null,
    "Apollo return trajectory retained a fabricated finite lunar ellipse");
  assert.strictEqual(departurePostBridge.previewAlpha, 0,
    "Apollo return finite lunar ellipse remained visible after ignition");
  assert.strictEqual(departurePostBridge.solvedAlpha, 1,
    "Apollo position-continuous Earth-return path was unnecessarily delayed");
}

// Long J2 coasts retain only bounded, analytically sampled display spans.
// Sparse endpoints must never be joined by aliased chords through Earth.
{
  const makeJ2 = (days) => ME.recompute({
    name: `J2 renderer ${days} d`, epoch: "2026-07-13T00:00:00Z",
    spacecraft: { name: "J2", dryKg: 1000, propKg: "", isp: 320 },
    segments: [
      { type: "launch", body: "earth", site: "", ascent: "direct",
        altKm: 700, incDeg: 98.19, raanDeg: 0 },
      { type: "coast", days, mode: "j2-secular" },
    ],
  });
  const chordRadius = (a, b) => {
    const d = V.sub(b, a);
    const d2 = V.dot(d, d);
    const u = d2 > 0 ? Math.max(0, Math.min(1, -V.dot(a, d) / d2)) : 0;
    return V.mag(V.add(a, V.scale(d, u)));
  };
  const month = makeJ2(30);
  const monthCache = T.trajectoryCache(month, "earth", month.epochJD);
  const j2StartT = month.samples.find((sample) => sample.seg === 1).t;
  assert.ok(monthCache.denseAdded > 1000 && monthCache.denseAdded <= 12000,
    "30-day J2 history was not densely but boundedly sampled");
  for (let index = 1; index < monthCache.denseRel.length; index++) {
    if (monthCache.denseBreakBefore[index] || monthCache.denseT[index - 1] < j2StartT)
      continue;
    assert.ok(chordRadius(monthCache.denseRel[index - 1], monthCache.denseRel[index]) >
      C.BODIES.earth.radius,
    "rendered 30-day J2 chord crossed Earth");
  }

  const year = makeJ2(365);
  const yearCache = T.trajectoryCache(year, "earth", year.epochJD);
  assert.ok(yearCache.denseBreakBefore.filter(Boolean).length > 100,
    "under-resolved year-long J2 history retained false full-orbit chords");
  const midT = year.tEnd / 2;
  const active = T.currentTrajectoryBridge(year, midT, "earth");
  for (const points of [active.past, active.future]) {
    for (let index = 1; index < points.length; index++)
      assert.ok(chordRadius(points[index - 1], points[index]) > C.BODIES.earth.radius,
        "bounded active J2 bridge crossed Earth");
  }
}

console.log("PASS  renderer cache identity");
console.log("PASS  optional authoritative body provider");
console.log("PASS  exact active trajectory bridge");
console.log("PASS  exact cached past/future trajectory arcs");
console.log("PASS  frame-aligned osculating path");
console.log("PASS  labelled burn-preview endpoints");
console.log("PASS  historical Earth-departure apsis ramps");
console.log("PASS  Apollo lunar capture/departure apsis ramps");
console.log("PASS  burn-preview trajectory layering");
console.log("PASS  bounded long-duration J2 display paths");
console.log("PASS  conical eclipse overlay and bounded fleet rendering");
