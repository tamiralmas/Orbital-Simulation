"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const catalogSource = read("js/deep-space-catalog.js");
const ephemerisSource = read("js/deep-space-ephemeris.js");
const deepSource = read("js/deep.js");
const constantsSource = read("js/constants.js");
const keplerSource = read("js/kepler.js");
const groundtrackSource = read("js/groundtrack.js");
const texturesSource = read("js/textures.js");
const generatorSource = read("get_deep_ephemerides.ps1");
const html = read("deep.html");
const unifiedHtml = read("live.html");
const shellSource = read("js/tracker-shell.js");

const sandbox = {};
sandbox.globalThis = sandbox;
vm.runInNewContext(constantsSource, sandbox, { filename: "constants.js" });
vm.runInNewContext(keplerSource, sandbox, { filename: "kepler.js" });
vm.runInNewContext(catalogSource, sandbox, { filename: "deep-space-catalog.js" });
vm.runInNewContext(ephemerisSource, sandbox, { filename: "deep-space-ephemeris.js" });
vm.runInNewContext(deepSource, sandbox, { filename: "deep.js" });
vm.runInNewContext(groundtrackSource, sandbox, { filename: "groundtrack.js" });

const catalog = sandbox.MTPDeepSpaceCatalog;
const ephemeris = sandbox.MTP_DEEP_EPHEMERIS;
const math = sandbox.MTPDeepMath;
const astro = sandbox.Astro;

assert(catalog, "deep-space catalog should load");
assert(ephemeris, "generated deep-space ephemeris should load");
assert(math && typeof math.stateAtTrajectory === "function", "bounded interpolation helper should be headless-testable");
assert(astro && typeof astro.utcJdToTdbJd === "function" &&
  typeof astro.bodyFrameAt === "function" && typeof astro.bodyLatLon === "function",
"IAU body orientation and UTC/TDB helpers should be headless-testable");
assert(typeof math.boundedHermiteWindow === "function" && typeof math.localOrbitWindowSpec === "function" &&
  typeof math.trajectoryCoverageBounds === "function" && typeof math.boundedPlaybackTime === "function",
"Deep local-track and static-coverage helpers should be headless-testable");
assert.strictEqual(math.cr3bpSystemIdForFrame("synodic:sun-earth"), "sun-earth");
assert.strictEqual(math.cr3bpSystemIdForFrame("earth"), "");
assert.strictEqual(math.isSynodicFrameId("synodic:earth-moon"), true);
assert.strictEqual(math.isSynodicFrameId("synodic:not-a-system"), false,
  "Deep must distinguish display-only synodic frames from physical body IDs");
assert.strictEqual(catalog.missions.length, 100, "Deep 100 should contain exactly 100 entries");
assert.strictEqual(new Set(catalog.missions.map((mission) => mission.horizonsId)).size, 100,
  "Horizons IDs should be unique");
assert.deepStrictEqual(
  Object.fromEntries(["LUNAR", "MARS", "INNER_HELIO", "OUTER", "SMALL_BODY", "OBSERVATORY"].map((group) => [
    group,
    catalog.missions.filter((mission) => mission.group === group).length,
  ])),
  { LUNAR: 20, MARS: 20, INNER_HELIO: 10, OUTER: 12, SMALL_BODY: 20, OBSERVATORY: 18 },
  "catalog should retain its reviewed regional balance"
);
assert(catalog.missions.every((mission) => mission.operationalStatus === "UNVERIFIED"),
  "catalog membership must not claim current operation");
assert(catalog.missions.every((mission) => /^https:\/\/en\.wikipedia\.org\/wiki\//.test(mission.wiki)),
  "curated mission links should remain on en.wikipedia.org");
const marsSurfaceIds = ["-76", "-84", "-168", "-189", "-253", "-254", "-530"];
for (const id of marsSurfaceIds) {
  const mission = catalog.missions.find((item) => item.horizonsId === id);
  assert(mission, id + " should remain in the curated Mars surface catalog");
  assert.strictEqual(mission.surfaceBody, "mars",
    mission.name + " should be explicitly classified as a Mars surface record");
}
assert(!catalog.missions.find((mission) => mission.horizonsId === "-143").surfaceBody,
  "ExoMars Trace Gas Orbiter must remain an orbital mission rather than a surface record");

const trajectories = ephemeris.trajectories;
const trajectoryIds = Object.keys(trajectories);
assert.strictEqual(ephemeris.requested, 100, "bundle should report all requested catalog entries");
assert.strictEqual(ephemeris.covered, trajectoryIds.length, "covered count should match trajectory object count");
assert.strictEqual(ephemeris.unavailable.length, ephemeris.requested - ephemeris.covered,
  "unavailable list should account for remaining catalog entries");
assert.strictEqual(new Set(trajectoryIds.concat(ephemeris.unavailable.map(String))).size, 100,
  "covered and unavailable IDs should partition the catalog");
const catalogIds = new Set(catalog.missions.map((mission) => String(mission.horizonsId)));
for (const id of trajectoryIds.concat(ephemeris.unavailable.map(String))) {
  assert(catalogIds.has(id), "bundle ID should exist in catalog: " + id);
}
assert.strictEqual(ephemeris.sourceTimeScale, "TDB",
  "Horizons vector epochs should retain their published source time scale");
assert.strictEqual(ephemeris.sampleTimeScale, "UTC",
  "stored sample times should be UTC instants suitable for JavaScript Date and the live clock");
assert.strictEqual(Date.parse(ephemeris.coverageStartUtc),
  Math.min(...trajectoryIds.map((id) => trajectories[id].startMs)),
  "UTC coverage metadata should match the first stored mission instant");
assert.strictEqual(Date.parse(ephemeris.coverageStopUtc),
  Math.max(...trajectoryIds.map((id) => trajectories[id].stopMs)),
  "UTC coverage metadata should match the last stored mission instant");

const maxStepByGroup = { LUNAR: 900, MARS: 1800, OBSERVATORY: 10800,
  INNER_HELIO: 21600, OUTER: 21600, SMALL_BODY: 21600 };

for (const [id, trajectory] of Object.entries(trajectories)) {
  const mission = catalog.missions.find((item) => item.horizonsId === String(id));
  assert(trajectory.stepSeconds <= maxStepByGroup[mission.group],
    mission.name + " cadence is too coarse for its mission region");
  assert(Array.isArray(trajectory.samples) && trajectory.samples.length >= 2, id + " needs at least two samples");
  assert.strictEqual(trajectory.samples[0][0], trajectory.startMs, id + " first sample should match startMs");
  assert.strictEqual(trajectory.samples[trajectory.samples.length - 1][0], trajectory.stopMs,
    id + " last sample should match stopMs");
  let previous = -Infinity;
  for (const sample of trajectory.samples) {
    assert.strictEqual(sample.length, 7, id + " samples should contain UTC, position, and velocity");
    assert(sample.every(Number.isFinite), id + " samples should contain finite values");
    assert(sample[0] > previous, id + " sample UTCs should be strictly increasing");
    previous = sample[0];
  }
  assert.strictEqual(math.stateAtTrajectory(trajectory, trajectory.startMs - 1), null,
    id + " must not extrapolate before coverage");
  assert.strictEqual(math.stateAtTrajectory(trajectory, trajectory.stopMs + 1), null,
    id + " must not extrapolate after coverage");
  const atStart = math.stateAtTrajectory(trajectory, trajectory.startMs);
  assert.deepStrictEqual(Array.from(atStart.r), Array.from(trajectory.samples[0].slice(1, 4)),
    id + " should reproduce the first vector exactly");
  assert.deepStrictEqual(Array.from(atStart.v), Array.from(trajectory.samples[0].slice(4, 7)),
    id + " should reproduce the first velocity exactly");
}

const requiredReferences = {
  mercury: ["199", 21600], venus: ["299", 21600], earth: ["399", 21600],
  moon: ["301", 900], mars: ["499", 1800], phobos: ["401", 10800],
  deimos: ["402", 10800], jupiter: ["599", 21600], io: ["501", 10800],
  europa: ["502", 10800], ganymede: ["503", 10800], callisto: ["504", 10800],
  saturn: ["699", 21600], enceladus: ["602", 10800], titan: ["606", 10800],
  uranus: ["799", 21600], neptune: ["899", 21600], triton: ["801", 10800],
  pluto: ["999", 21600], charon: ["901", 10800],
};
const references = ephemeris.referenceBodies;
assert(references && typeof references === "object", "bundle should include bounded reference-body vectors");
assert.deepStrictEqual(Object.keys(references).sort(), Object.keys(requiredReferences).sort(),
  "bundle should cover every reviewed planet and major-moon reference");
let referenceSampleCount = 0;
for (const [bodyId, [horizonsId, maxStep]] of Object.entries(requiredReferences)) {
  const reference = references[bodyId];
  assert.strictEqual(String(reference.horizonsId), horizonsId, bodyId + " should retain its stable Horizons ID");
  assert(reference.stepSeconds <= maxStep, bodyId + " reference cadence should remain bounded");
  assert.strictEqual(reference.samples[0][0], reference.startMs, bodyId + " first reference row should match startMs");
  assert.strictEqual(reference.samples[reference.samples.length - 1][0], reference.stopMs,
    bodyId + " last reference row should match stopMs");
  let previous = -Infinity;
  for (const sample of reference.samples) {
    assert.strictEqual(sample.length, 7, bodyId + " reference rows should contain UTC, position, and velocity");
    assert(sample.every(Number.isFinite), bodyId + " reference rows should remain finite");
    assert(sample[0] > previous, bodyId + " reference UTCs should be strictly increasing");
    previous = sample[0];
  }
  referenceSampleCount += reference.samples.length;
  assert.strictEqual(math.stateAtTrajectory(reference, reference.startMs - 1), null,
    bodyId + " reference must not extrapolate before coverage");
  assert.strictEqual(math.stateAtTrajectory(reference, reference.stopMs + 1), null,
    bodyId + " reference must not extrapolate after coverage");
}
assert(referenceSampleCount <= 16000, "reference-body bundle should retain its reviewed sample bound");
assert.strictEqual(ephemeris.referenceCenter, "500@10 (Sun center)",
  "reference vectors should remain Sun-centered");
assert.strictEqual(ephemeris.referenceFrame, "ICRF / ecliptic J2000",
  "reference vectors should use the mission bundle frame");
assert.strictEqual(ephemeris.referenceSourceTimeScale, "TDB");
assert.strictEqual(ephemeris.referenceSampleTimeScale, "UTC");

function localDistanceCheck(missionId, bodyId) {
  const trajectory = trajectories[missionId];
  const reference = references[bodyId];
  assert(trajectory, missionId + " should remain in the preserved mission bundle");
  const atMs = Date.UTC(2026, 6, 12);
  const mission = math.stateAtTrajectory(trajectory, atMs);
  const body = math.stateAtTrajectory(reference, atMs);
  const localKm = Math.hypot(...mission.r.map((value, axis) => value - body.r[axis]));
  const approximate = sandbox.Astro.bodyWorld(bodyId, 2440587.5 + atMs / 86400000);
  const oldApproximateKm = Math.hypot(...mission.r.map((value, axis) => value - approximate[axis]));
  return { localKm, oldApproximateKm, atMs, mission };
}
const lroLocal = localDistanceCheck("-85", "moon");
const odysseyLocal = localDistanceCheck("-53", "mars");
const opportunityLocal = localDistanceCheck("-253", "mars");
assert(lroLocal.localKm < 5000 && lroLocal.oldApproximateKm > 40000,
  "LRO should resolve near the bundled Moon reference instead of the mismatched approximate Moon");
assert(odysseyLocal.localKm < 10000 && odysseyLocal.oldApproximateKm > 40000,
  "Mars Odyssey should resolve near the bundled Mars reference instead of the mismatched approximate Mars");
assert(Math.abs(opportunityLocal.localKm - 3394.1481436151093) < 0.1,
  "Opportunity should sit on the official rendered Mars surface in the global view");

/* Horizons surface targets rotate in Mars's IAU body-fixed frame; they are
 * not orbiters. Verify both the absolute landing-site registration and the
 * absence of visible drift across every official row in the static bundle.
 * A full-sol-only check is insufficient because the legacy tilt/spin frame
 * returned to its starting point after drawing one false loop per sol. */
const marsBody = sandbox.AstroConst.BODIES.mars;
const roverSites = {
  "-76": { longitudeDeg: 137.444, latitudeDeg: -4.590 },
  "-189": { longitudeDeg: 135.626, latitudeDeg: 4.502 },
  "-253": { longitudeDeg: -5.523, latitudeDeg: -1.948 },
  "-254": { longitudeDeg: 175.481, latitudeDeg: -14.572 },
};
const wrapRadians = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
const firstRoverUtcJd = 2440587.5 + trajectories["-76"].startMs / 86400000;
const tdbOffsetSeconds = (astro.utcJdToTdbJd(firstRoverUtcJd) - firstRoverUtcJd) * 86400;
assert(tdbOffsetSeconds > 69.18 && tdbOffsetSeconds < 69.19,
  "Mars IAU orientation should convert the stored 2026 UTC instant to its matching TDB epoch");
const marsFrame = astro.bodyFrameAt(marsBody, firstRoverUtcJd);
assert(marsFrame && marsFrame.model === "iau",
  "Mars should use its IAU pole and prime-meridian model instead of the generic tilt/spin frame");
for (const axis of [marsFrame.x, marsFrame.y, marsFrame.z]) {
  assert(Math.abs(Math.hypot(...axis) - 1) < 1e-12, "Mars IAU frame axes should remain normalized");
}
assert(Math.abs(astro.V.dot(marsFrame.x, marsFrame.y)) < 1e-12 &&
  Math.abs(astro.V.dot(marsFrame.x, marsFrame.z)) < 1e-12 &&
  Math.abs(astro.V.dot(marsFrame.y, marsFrame.z)) < 1e-12,
"Mars IAU body frame should remain orthogonal");

for (const [id, expected] of Object.entries(roverSites)) {
  const trajectory = trajectories[id];
  assert(trajectory, id + " should retain its bundled Mars surface vectors");
  let seedLatLon = null;
  let minimumAltitudeKm = Infinity;
  let maximumAltitudeKm = -Infinity;
  let maximumAngularDriftDeg = 0;
  for (const sample of trajectory.samples) {
    const mars = math.stateAtTrajectory(references.mars, sample[0]);
    assert(mars, id + " should have a matching official Mars reference at every surface row");
    const local = sample.slice(1, 4).map((value, axis) => value - mars.r[axis]);
    const altitudeKm = Math.hypot(...local) - marsBody.radius;
    minimumAltitudeKm = Math.min(minimumAltitudeKm, altitudeKm);
    maximumAltitudeKm = Math.max(maximumAltitudeKm, altitudeKm);
    const jdUtc = 2440587.5 + sample[0] / 86400000;
    const latLon = astro.bodyLatLon(marsBody, local, jdUtc);
    assert(latLon && Number.isFinite(latLon.lam) && Number.isFinite(latLon.phi),
      id + " should resolve to a finite IAU Mars longitude and latitude");
    if (!seedLatLon) seedLatLon = latLon;
    const longitudeDelta = wrapRadians(latLon.lam - seedLatLon.lam);
    const cosineSeparation = Math.sin(seedLatLon.phi) * Math.sin(latLon.phi) +
      Math.cos(seedLatLon.phi) * Math.cos(latLon.phi) * Math.cos(longitudeDelta);
    const separationDeg = Math.acos(Math.max(-1, Math.min(1, cosineSeparation))) * 180 / Math.PI;
    maximumAngularDriftDeg = Math.max(maximumAngularDriftDeg, separationDeg);
  }
  assert(minimumAltitudeKm > -1 && maximumAltitudeKm < 10 &&
    maximumAltitudeKm - minimumAltitudeKm < 0.01,
  id + " should remain a nearly fixed surface-radius record rather than an orbit");
  assert(maximumAngularDriftDeg < 0.003,
    id + " should remain visually fixed in Mars's IAU body frame across the full bundle");
  assert(Math.abs(wrapRadians(seedLatLon.lam - expected.longitudeDeg * Math.PI / 180)) < 0.02 * Math.PI / 180 &&
    Math.abs(seedLatLon.phi - expected.latitudeDeg * Math.PI / 180) < 0.02 * Math.PI / 180,
  id + " should register at its reviewed Mars landing-site longitude and latitude");
}

function sharedReferenceDistance(check, focusBodyId, frameBodyId) {
  const bodyAtMs = (bodyId, atMs) => math.stateAtTrajectory(references[bodyId], atMs).r;
  const displayed = math.pointInProviderFrame(check.mission.r, check.atMs, check.atMs,
    frameBodyId, bodyAtMs);
  const renderedFocus = bodyAtMs(focusBodyId, check.atMs);
  return Math.hypot(...displayed.map((value, axis) => value - renderedFocus[axis]));
}
assert(Math.abs(sharedReferenceDistance(lroLocal, "moon", "earth") - lroLocal.localKm) < 1e-6,
  "Earth frame plus Moon focus should preserve LRO's exact Moon-local distance");
assert(Math.abs(sharedReferenceDistance(odysseyLocal, "mars", "earth") - odysseyLocal.localKm) < 1e-6,
  "Earth frame plus Mars focus should preserve Mars Odyssey's exact Mars-local distance");

const synthetic = {
  samples: [
    [0, 0, 0, 0, 1, 0, 0],
    [1000, 1, 1, 0, 1, 2, 0],
  ],
};
const midpoint = math.stateAtTrajectory(synthetic, 500);
assert(Math.abs(midpoint.r[0] - 0.5) < 1e-12 && Math.abs(midpoint.r[1] - 0.25) < 1e-12,
  "cubic Hermite interpolation should use endpoint velocities, not linear position blending");
assert(Math.abs(midpoint.v[0] - 1) < 1e-12 && Math.abs(midpoint.v[1] - 1) < 1e-12,
  "cubic Hermite derivative should return a consistent velocity");

const deepAtMs = Date.UTC(2026, 6, 12, 12);
const tgoTrajectory = trajectories["-143"];
const tgoState = math.stateAtTrajectory(tgoTrajectory, deepAtMs);
const marsState = math.stateAtTrajectory(references.mars, deepAtMs);
const tgoRelative = {
  r: tgoState.r.map((value, axis) => value - marsState.r[axis]),
  v: tgoState.v.map((value, axis) => value - marsState.v[axis]),
};
const tgoWindow = math.localOrbitWindowSpec(tgoTrajectory, deepAtMs, sandbox.AstroConst.BODIES.mars, tgoRelative);
assert(tgoWindow && tgoWindow.periodMs > 1.9 * 3600000 && tgoWindow.periodMs < 2.1 * 3600000,
  "TGO should resolve as a close, approximately two-hour Mars orbit");
const tgoDense = math.boundedHermiteWindow(tgoTrajectory, tgoWindow.startMs, tgoWindow.stopMs,
  tgoWindow.desiredStepMs, 2400, deepAtMs);
assert(tgoDense.length < 2400 && tgoDense.length > 250,
  "TGO local display should be smoothly densified while retaining a hard point bound");
assert(Math.abs((tgoDense[tgoDense.length - 1].atMs - tgoDense[0].atMs) / tgoWindow.periodMs - 6) < 0.01,
  "TGO local display should show six readable orbits instead of the whole 60-day bundle");
assert(tgoDense.some((state) => state.atMs === deepAtMs),
  "the exact displayed-time state should be retained in the local window");
const tgoOfficialInWindow = tgoTrajectory.samples.filter((sample) =>
  sample[0] >= tgoWindow.startMs && sample[0] <= tgoWindow.stopMs);
assert(tgoOfficialInWindow.every((sample) => tgoDense.some((state) => state.atMs === sample[0])),
  "local Hermite densification should preserve every official Horizons row in its bounded window");
const tgoTrackPoints = tgoDense.map((state) => {
  const reference = math.stateAtTrajectory(references.mars, state.atMs);
  const local = state.r.map((value, axis) => value - reference.r[axis]);
  const ll = sandbox.MTPGroundTrack.bodyLatLon(sandbox.AstroConst.BODIES.mars, local,
    2440587.5 + state.atMs / 86400000, 0);
  return { u: ll.lam / (2 * Math.PI) + 0.5, v: 0.5 - ll.phi / Math.PI,
    t: (state.atMs - tgoDense[0].atMs) / 1000 };
});
const tgoExactState = math.stateAtTrajectory(tgoTrajectory, deepAtMs);
const tgoExactReference = math.stateAtTrajectory(references.mars, deepAtMs);
const tgoExactLocal = tgoExactState.r.map((value, axis) => value - tgoExactReference.r[axis]);
const tgoExactLl = sandbox.MTPGroundTrack.bodyLatLon(sandbox.AstroConst.BODIES.mars, tgoExactLocal,
  2440587.5 + deepAtMs / 86400000, 0);
const tgoExactPoint = { u: tgoExactLl.lam / (2 * Math.PI) + 0.5,
  v: 0.5 - tgoExactLl.phi / Math.PI, t: (deepAtMs - tgoDense[0].atMs) / 1000 };
const tgoTrackSplit = sandbox.MTPGroundTrack.splitTrackPoints(tgoTrackPoints, tgoExactPoint.t, tgoExactPoint);
const tgoPastEnd = tgoTrackSplit.past[tgoTrackSplit.past.length - 1];
const tgoFutureStart = tgoTrackSplit.future[0];
assert(Math.abs(tgoPastEnd.u - tgoExactPoint.u) < 1e-12 &&
  Math.abs(tgoPastEnd.v - tgoExactPoint.v) < 1e-12 &&
  Math.abs(tgoFutureStart.u - tgoExactPoint.u) < 1e-12 &&
  Math.abs(tgoFutureStart.v - tgoExactPoint.v) < 1e-12,
  "real TGO/Mars reference subtraction should place both Track colors under the exact marker");
function minimumBodyChordRadius(states, reference) {
  const local = states.map((state) => {
    const body = math.stateAtTrajectory(reference, state.atMs);
    return state.r.map((value, axis) => value - body.r[axis]);
  });
  let minimum = Infinity;
  for (let i = 1; i < local.length; i++) {
    const a = local[i - 1];
    const d = local[i].map((value, axis) => value - a[axis]);
    const dd = d.reduce((sum, value) => sum + value * value, 0);
    const u = dd > 0 ? Math.max(0, Math.min(1,
      -a.reduce((sum, value, axis) => sum + value * d[axis], 0) / dd)) : 0;
    minimum = Math.min(minimum, Math.hypot(...a.map((value, axis) => value + u * d[axis])));
  }
  return minimum;
}
assert(minimumBodyChordRadius(tgoDense, references.mars) > sandbox.AstroConst.BODIES.mars.radius,
  "densified TGO chords should remain above Mars instead of forming a through-planet starburst");

const rollingBody = { radius: 100, mu: 100000, soi: 1000000, rotHours: 24 };
const rollingCoverageStart = Date.UTC(2026, 6, 1);
const rollingTrajectory = {
  stepSeconds: 600,
  samples: [
    [rollingCoverageStart, 1000, 0, 0, 0, 10, 0],
    [rollingCoverageStart + 100000000, 1000, 0, 0, 0, 10, 0],
  ],
};
const rollingRelative = { r: [1000, 0, 0], v: [0, 10, 0] };
const rollingAtMs = rollingCoverageStart + 50000000;
const rollingSeed = math.localOrbitWindowSpec(rollingTrajectory, rollingAtMs, rollingBody, rollingRelative);
const rollingPerturbed = math.localOrbitWindowSpec(rollingTrajectory, rollingAtMs, rollingBody,
  { r: rollingRelative.r, v: [0, 10.000001, 0] });
assert.strictEqual(rollingPerturbed.startMs, rollingSeed.startMs);
assert.strictEqual(rollingPerturbed.stopMs, rollingSeed.stopMs,
  "tiny osculating-state changes must not jitter an otherwise unchanged Deep Track window");
const rollingBoundary = rollingCoverageStart +
  (Math.floor((rollingAtMs - rollingCoverageStart) / rollingSeed.shiftStepMs) + 1) * rollingSeed.shiftStepMs;
const rollingBefore = math.localOrbitWindowSpec(rollingTrajectory, rollingBoundary - 0.01,
  rollingBody, rollingRelative);
const rollingAfter = math.localOrbitWindowSpec(rollingTrajectory, rollingBoundary + 0.01,
  rollingBody, rollingRelative);
assert(Math.abs((rollingAfter.startMs - rollingBefore.startMs) - rollingSeed.shiftStepMs) < 1e-3 &&
  Math.abs((rollingAfter.stopMs - rollingBefore.stopMs) - rollingSeed.shiftStepMs) < 1e-3,
  "rolling Deep Track history should advance by one rendered sample instead of replacing whole orbit legs");
assert(rollingBefore.startMs >= rollingTrajectory.samples[0][0] &&
  rollingAfter.stopMs <= rollingTrajectory.samples[rollingTrajectory.samples.length - 1][0],
  "rolling Deep Track history must remain inside the static ephemeris bounds");

const overlapBodies = {
  planet: { x: 0, y: 0, z: 10, r: 10 },
  hiddenMoon: { x: 0, y: 0, z: 20, r: 2 },
  limbMoon: { x: 11, y: 0, z: 20, r: 3 },
};
assert.strictEqual(math.pickVisibleBody(overlapBodies, { x: 0, y: 0 }, 12,
  new Set(["planet", "hiddenMoon", "limbMoon"])), "planet",
"a click through overlapping disks should select the foreground body");
assert.strictEqual(math.pickVisibleBody(overlapBodies, { x: 11, y: 0 }, 12,
  new Set(["hiddenMoon"])), null,
"an enlarged hit target must not create a ghost pick for a fully hidden moon");
assert.strictEqual(math.pickVisibleBody(overlapBodies, { x: 13, y: 0 }, 12,
  new Set(["limbMoon"])), "limbMoon",
"the visible part of a moon at a planetary limb should remain reliably pickable");
assert.strictEqual(math.pickVisibleBody({ closePlanet: { x: 0, y: 0, z: 10, r: 400 } },
  { x: 300, y: 0 }, 12, new Set(["closePlanet"])), "closePlanet",
"every visible part of a close planet disk should remain a body-focus target");
const firstBodyClick = { id: "mars", x: 80, y: 90, at: 1000 };
assert.strictEqual(math.isRecentBodyPointerPick(firstBodyClick, { x: 82, y: 91 }, 1250), true,
  "the empty second pointerup of a body double-click should retain its first visible body pick");
assert.strictEqual(math.isRecentBodyPointerPick(firstBodyClick, { x: 120, y: 90 }, 1250), false);
assert.strictEqual(math.isRecentBodyPointerPick(firstBodyClick, { x: 80, y: 90 }, 1800), false,
  "stale or spatially unrelated clicks must not reuse an earlier body pick");

const syntheticArchive = {
  startMs: 0,
  stopMs: 1000001000,
  maxGapMs: 100000,
  samples: [
    [0, 1, 2, 3], [1000, 2, 3, 4], [NaN, 0, 0, 0],
    [2000, 3, 4, 5], [3000, 4, 5, 6],
    [1000000000, 5, 6, 7], [1000001000, 6, 7, 8],
    [500, 7, 8, 9], [600, 8, 9, 10],
  ],
};
const archiveSegments = math.archivePathSegments(syntheticArchive, 32);
assert.strictEqual(archiveSegments.length, 4,
  "historical polylines should break at invalid rows, large source gaps, and reversed epochs");
assert(archiveSegments.every((segment) => segment.length === 2),
  "gap splitting must retain drawable endpoints without reconnecting missing history");
assert.strictEqual(math.stateAtTrajectory(syntheticArchive, 500), null,
  "position-only archive rows must never be interpolated into a current spacecraft state");
const currentVector = { samples: [[0, 0, 0, 0, 0, 0, 0], [1, 1, 1, 1, 0, 0, 0]] };
assert.strictEqual(math.selectedPathKind(currentVector, syntheticArchive, false), "current",
  "Voyager and Pioneer should retain their current-window paths by default");
assert.strictEqual(math.selectedPathKind(currentVector, syntheticArchive, true), "history",
  "the selected mission may explicitly replace its short window with bounded history");
assert.strictEqual(math.selectedPathKind(null, syntheticArchive, false), "none");
assert.strictEqual(math.shouldAutoEnableHistory(null, syntheticArchive), true,
  "an archive-only Cassini selection should explicitly enable its honest historical path");
assert.strictEqual(math.shouldAutoEnableHistory(currentVector, syntheticArchive), false,
  "current Voyager/Pioneer selections must not auto-enable historical clutter");

const focusKinds = [
  ["earth", "planet"], ["moon", "moon"], ["ceres", "dwarf"], ["vesta", "asteroid"],
];
const focusableIds = new Set(Object.values(sandbox.AstroConst.BODIES)
  .filter(math.isFocusableBody).map((body) => body.id));
const focusProjections = Object.fromEntries(focusKinds.map(([id], index) =>
  [id, { x: index * 40, y: 20, z: 100 + index, r: id === "vesta" ? 1.7 : 5 }]));
for (let index = 0; index < focusKinds.length; index++) {
  const [id, kind] = focusKinds[index];
  assert.strictEqual(math.isFocusableBody(sandbox.AstroConst.BODIES[id]), true,
    kind + " bodies should be valid Deep focus targets");
  assert.strictEqual(math.pickVisibleBody(focusProjections, { x: index * 40, y: 20 }, 12,
    focusableIds), id, kind + " bodies should survive the Deep canvas-picking allowlist");
}
assert.strictEqual(math.isFocusableBody({ id: "test-comet", type: "comet" }), true,
  "future cataloged comets should remain valid Deep focus targets");
assert.strictEqual(math.isFocusableBody({ id: "spacecraft", type: "spacecraft" }), false,
  "spacecraft markers should continue through the higher-priority mission picker");
assert(focusableIds.has("bennu") && focusableIds.has("apophis") && focusableIds.has("didymos"),
  "small near-Earth asteroids should be available in Deep focus and frame controls");
assert.strictEqual(math.bodyVisibleWithMinorOption(sandbox.AstroConst.BODIES.vesta,
  false, "sun", "inertial", sandbox.AstroConst.BODIES), false,
"an ordinary minor body should be hidden when the Planner-matching option is off");
assert.strictEqual(math.bodyVisibleWithMinorOption(sandbox.AstroConst.BODIES.earth,
  false, "sun", "inertial", sandbox.AstroConst.BODIES), true,
"hiding minor bodies must not hide a major planet");
assert.strictEqual(math.bodyVisibleWithMinorOption(sandbox.AstroConst.BODIES.vesta,
  false, "vesta", "inertial", sandbox.AstroConst.BODIES), true,
"the active minor Focus must remain visible");
assert.strictEqual(math.bodyVisibleWithMinorOption(sandbox.AstroConst.BODIES.vesta,
  false, "sun", "vesta", sandbox.AstroConst.BODIES), true,
"the active minor Frame must remain visible");
assert.strictEqual(math.bodyVisibleWithMinorOption(sandbox.AstroConst.BODIES.charon,
  false, "sun", "inertial", sandbox.AstroConst.BODIES), false,
"moons of hidden minor bodies should follow their parent visibility");

const bundleCoverage = math.trajectoryCoverageBounds(Object.values(trajectories));
assert.deepStrictEqual([bundleCoverage.startMs, bundleCoverage.stopMs],
  [Date.parse(ephemeris.coverageStartUtc), Date.parse(ephemeris.coverageStopUtc)],
  "playback bounds should match the generated static bundle");
const afterThirtyDays = deepAtMs + 30 * 86400000;
assert.strictEqual(math.boundedPlaybackTime(afterThirtyDays, bundleCoverage).boundary, "",
  "a 30-day run from July 12 should remain inside static coverage");
const expectedAtThirtyDays = Object.values(trajectories).filter((trajectory) =>
  trajectory.startMs <= afterThirtyDays && trajectory.stopMs >= afterThirtyDays).length;
assert.strictEqual(Object.values(trajectories).filter((trajectory) =>
  math.stateAtTrajectory(trajectory, afterThirtyDays)).length, expectedAtThirtyDays,
"a bounded partial source record may end inside the release window without affecting other missions");
const fullWindowCount = Object.values(trajectories).filter((trajectory) =>
  trajectory.startMs <= bundleCoverage.startMs && trajectory.stopMs >= bundleCoverage.stopMs).length;
assert(expectedAtThirtyDays >= fullWindowCount && fullWindowCount >= 40,
  "the long-window mission core should remain visible after a month");
const beyondBundle = math.boundedPlaybackTime(bundleCoverage.stopMs + 86400000, bundleCoverage);
assert.strictEqual(beyondBundle.atMs, bundleCoverage.stopMs,
  "playback should clamp at the last official vector instead of hiding every marker");
assert.strictEqual(beyondBundle.boundary, "end", "the playback clamp should identify the bundle end honestly");
assert.strictEqual(Object.values(trajectories).filter((trajectory) =>
  math.stateAtTrajectory(trajectory, beyondBundle.atMs)).length, fullWindowCount,
"the clamped bundle endpoint should retain every full-window mission marker");

const boundedRecoveryIds = ["-152", "-1176", "-74", "-21", "-43", "-78"];
for (const id of boundedRecoveryIds) {
  const trajectory = trajectories[id];
  assert(trajectory, id + " should retain its official partial-window vectors");
  assert(trajectory.startMs <= deepAtMs && trajectory.stopMs >= deepAtMs,
    id + " should be selectable at the release audit instant");
  assert(trajectory.stopMs < bundleCoverage.stopMs,
    id + " should remain bounded at its source kernel end rather than being extrapolated");
}

const ulyssesMission = catalog.missions.find((mission) => mission.name === "Ulysses");
const ulysses = trajectories["-55"];
assert(ulyssesMission && ulyssesMission.horizonsId === "-55" && ulysses,
  "Ulysses should use its reviewed NAIF/Horizons spacecraft ID -55");
assert.strictEqual(ulysses.trajectoryClass, "PREDICTED",
  "the post-mission Ulysses kernel must not be presented as a current measured trajectory");
assert.strictEqual(ulysses.predictionStartDate, "2009-06-30",
  "Ulysses should retain the prediction cutoff published with its official NAIF kernel");
const ulyssesAuditUtc = Date.UTC(2026, 6, 12);
const ulyssesSourceRow = ulysses.samples.reduce((best, sample) =>
  Math.abs(sample[0] - ulyssesAuditUtc) < Math.abs(best[0] - ulyssesAuditUtc) ? sample : best);
assert.deepStrictEqual(Array.from(ulyssesSourceRow.slice(1, 4)),
  [196612971.236, -78147636.154, 5175637.948],
  "Ulysses should retain the exact generated Sun-centered Horizons source vector");
assert(Math.abs(ulyssesAuditUtc - ulyssesSourceRow[0]) <= 2,
  "the UTC request boundary and converted source JDTDB row should describe the same real instant");
const ulyssesAt = math.stateAtTrajectory(ulysses, ulyssesAuditUtc);
const ulyssesH = [
  ulyssesAt.r[1] * ulyssesAt.v[2] - ulyssesAt.r[2] * ulyssesAt.v[1],
  ulyssesAt.r[2] * ulyssesAt.v[0] - ulyssesAt.r[0] * ulyssesAt.v[2],
  ulyssesAt.r[0] * ulyssesAt.v[1] - ulyssesAt.r[1] * ulyssesAt.v[0],
];
const ulyssesInclination = Math.acos(ulyssesH[2] / Math.hypot(...ulyssesH)) * 180 / Math.PI;
assert(ulyssesInclination > 77 && ulyssesInclination < 80,
  "Ulysses should retain its distinctive high-inclination solar-polar trajectory");

const movingFramePoint = math.pointInFrame([13, 2, 0], 100, 200, "earth", (_bodyId, jd) =>
  jd === 100 ? [10, 0, 0] : [20, 0, 0]);
assert.deepStrictEqual(Array.from(movingFramePoint), [23, 2, 0],
  "historical points should retain body-relative geometry at their epoch and move to the displayed body origin");
assert.deepStrictEqual(Array.from(math.pointInFrame([13, 2, 0], 100, 200, "inertial", () => [99, 0, 0])),
  [13, 2, 0], "inertial points should not be translated");

const providerWorld = (_bodyId, atMs) => atMs === 100 ? [10, 0, 0] : [20, 0, 0];
assert.deepStrictEqual(Array.from(math.pointInProviderFrame([13, 2, 0], 100, 200, "earth", providerWorld)),
  [23, 2, 0], "shared-provider moving frames should retain point-epoch body-relative geometry");
assert.deepStrictEqual(Array.from(math.pointInProviderFrame([13, 2, 0], 200, 200, "earth", providerWorld)),
  [13, 2, 0], "shared-provider transforms should cancel exactly for current official markers");
assert.deepStrictEqual(Array.from(math.pointInProviderFrame([13, 2, 0], 100, 200, "inertial", providerWorld)),
  [13, 2, 0], "inertial shared-provider points should remain globally authoritative");

const povPose = math.povCameraPose([13, 4, 5], [10, 0, 0]);
const povDirection = [
  Math.cos(povPose.pitch) * Math.cos(povPose.yaw),
  Math.cos(povPose.pitch) * Math.sin(povPose.yaw),
  Math.sin(povPose.pitch),
];
const reconstructedEye = povPose.focus.map((value, axis) => value + povDirection[axis] * povPose.dist);
assert.deepStrictEqual(reconstructedEye.map((value) => Math.round(value * 1e12) / 1e12), [13, 4, 5],
  "POV orbit-camera pose should place the camera eye exactly at the selected spacecraft");

assert.strictEqual(math.selectedFitDistance(2000, "moon", { moon: { radius: 1737.4 } }), 6200,
  "body-relative selected-track fitting should use local extent instead of an AU-scale minimum");
assert(math.selectedFitDistance(0, "moon", { moon: { radius: 1737.4 } }) < 3000,
  "body-relative fit minimum should remain useful for close local viewing");

const testBodies = { earth: { radius: 6371 } };
assert(Math.abs(math.zoomFloorKm("earth", testBodies, 100) - 6371 * 1.12) < 1e-12,
  "body focus should stop the camera just above the physical surface");
assert.strictEqual(math.zoomFloorKm(null, testBodies, 100), 100,
  "mission focus should retain a bounded close-up visualization floor");

const noTilt = { tiltDeg: 0 };
const prime = math.bodyLatLon(noTilt, [1, 0, 0], 0, () => 0);
const pole = math.bodyLatLon(noTilt, [0, 0, 1], 0, () => 0);
const quarterSpin = math.bodyLatLon(noTilt, [1, 0, 0], 0, () => Math.PI / 2);
assert(Math.abs(prime.lam) < 1e-12 && Math.abs(prime.phi) < 1e-12,
  "body-fixed longitude and latitude should preserve the zero-spin prime direction");
assert(Math.abs(pole.phi - Math.PI / 2) < 1e-12,
  "body-fixed latitude should preserve the north rotational pole");
assert(Math.abs(quarterSpin.lam - Math.PI / 2) < 1e-12,
  "body-fixed longitude should use the texture-registered sidereal spin convention");

const ids = Array.from(html.matchAll(/\sid="([^"]+)"/g), (match) => match[1]);
assert.strictEqual(ids.length, new Set(ids).size, "deep.html IDs should be unique");
for (const script of [
  "js/constants.js", "js/kepler.js", "js/textures-data.js", "js/textures.js", "js/renderer.js",
  "js/deep-space-catalog.js", "js/deep-space-ephemeris.js", "js/theme.js", "js/deep.js",
]) {
  assert(html.includes('src="' + script + '"'), "deep.html should load " + script);
  assert(fs.existsSync(path.join(root, script)), script + " should exist");
}
assert(/class="tracker-link" href="live\.html#earth"/.test(html) &&
  /class="planner-link" href="index\.html"/.test(html),
  "Deep 100 should link to Earth 100 and the planner");
assert(/location\.replace\("live\.html#deep"\)/.test(html),
  "legacy deep.html should forward into the combined tracker Deep mode");
assert(/id="btnTrackerEarth"[^>]*>Earth 100<\/button>/.test(unifiedHtml) &&
  /id="btnTrackerDeep"[^>]*>Deep 100<\/button>/.test(unifiedHtml),
  "Earth 100 and Deep 100 should share one tracker page");
assert(/=== "#deep"/.test(shellSource) &&
  shellSource.includes('{ src: "js/deep-space-archives.js", optional: true }') &&
  /"js\/deep-space-ephemeris\.js"[\s\S]*?deep-space-archives\.js[\s\S]*?"js\/deep\.js"/.test(shellSource),
  "Deep mode should be selected and loaded by the unified tracker shell");
assert(/src="js\/cr3bp\.js"/.test(unifiedHtml) &&
  unifiedHtml.indexOf('src="js/cr3bp.js"') < unifiedHtml.indexOf('src="js/tracker-shell.js"'),
  "the combined tracker should load reviewed CR3BP geometry before Deep starts");
assert(/configureDeep[\s\S]*Deep 100 catalog/.test(shellSource) &&
  /configureDeep[\s\S]*operational status unverified/.test(shellSource),
  "the unified Deep mode should retain its catalog and accuracy language");
assert(/not telemetry/i.test(html) && /operational status unverified/i.test(html) && /no extrapolation/i.test(html),
  "accuracy and status caveats should be prominent");
assert(/const Render = globalThis\.MTPRender/.test(deepSource) && /Render\.draw/.test(deepSource),
  "deep view should render shared solar-system bodies through MTPRender");
assert(/A && typeof A\.bodyFrameAt === "function" \? A\.bodyFrameAt\(body, jd\)/.test(texturesSource) &&
  /nw\[0\] \* frame\.x\[0\][\s\S]*?nw\[0\] \* frame\.y\[0\][\s\S]*?nw\[0\] \* frame\.z\[0\]/.test(texturesSource),
  "textured globes should sample maps through the shared epoch-correct body frame");
assert(/function bodyLatLon\(body, nWorld, jd, spinOverride\) \{\s*return A\.bodyLatLon\(body, nWorld, jd, spinOverride\);\s*\}/.test(groundtrackSource),
  "ground maps should use the same body-fixed transform as textured globes and Horizons surface sites");
assert(/stateAtTrajectory/.test(deepSource) && /cubic Hermite/i.test(deepSource),
  "deep controller should document and use bounded cubic Hermite interpolation");
assert(/pointInFrame/.test(deepSource) && /frameBody: frameBodyId/.test(deepSource) &&
  /MAX_PATH_POINTS = 2400/.test(deepSource),
  "Deep view should use bounded, epoch-correct moving-body frame transforms");
assert(/authoritativeBodyWorldAtMs/.test(deepSource) && /bodyWorld: deepBodyWorld/.test(deepSource) &&
  /bodyOrbitPath: deepBodyOrbitPath/.test(deepSource) && /approximate body reference/.test(deepSource),
  "Deep should give the renderer its bounded Horizons body source with explicit approximate fallback");
assert(/return "frame:" \+ frameBodyId \+ "\|focus:"/.test(deepSource) &&
  /const bodyId = focusBody \|\| movingBody/.test(deepSource) &&
  /frameOffset: movingBody \? renderedBodyWorldAtMs\(movingBody, atMs\)/.test(deepSource) &&
  /function pointForDisplay\(point, pointMs, displayMs\)[\s\S]*?pointInDisplayFrame[\s\S]*?deepBodyWorld/.test(deepSource),
  "Deep shared-provider transforms should keep independent frame/focus choices and share renderer frame geometry");
assert(/function markerData\(basis, atMs, alignment\)[\s\S]*?stateAtTrajectory\(trajectory, atMs\)/.test(deepSource) &&
  /const alignment = currentAlignment\(atMs\)[\s\S]*?markerData\(lastBasis, atMs, alignment\)/.test(deepSource),
  "mission markers should use exact displayed-time states and one shared per-paint reference origin");
assert(!/function markerData\(basis, atMs[^)]*\)[\s\S]*?stateById\.get\(id\)/.test(deepSource),
  "marker drawing must not reuse throttled catalog-card states");
assert(/selectedFitDistance\(extent, frameBodyId/.test(deepSource) && !/0\.08 \* AU/.test(deepSource),
  "selected body-relative tracks should fit at local scale");
assert(/const preserveBodyFocus = camera\.focusMode === "body"[\s\S]*?!preserveBodyFocus && !povActive\) fitSelected\(\)/.test(deepSource),
  "catalog selection should preserve an intentional close body focus");
assert(/pov: \$\("btnLivePov"\)/.test(deepSource) && /function updatePovCamera/.test(deepSource) &&
  /povCameraPose\(displayedCraft, displayedTarget\)/.test(deepSource) &&
  /pointForDisplay\(state\.r, atMs, atMs\)/.test(deepSource) &&
  /event\.key\.toLowerCase\(\) === "v"/.test(deepSource),
  "Deep POV should be guarded, follow the selected spacecraft in every display frame, and expose the V shortcut");
assert(/leavePov\(\);[\s\S]*?camera\.dist = clamp/.test(deepSource) &&
  /setAttribute\("aria-pressed", povActive \? "true" : "false"\)/.test(deepSource) &&
  /classList\.toggle\("active", povActive\)/.test(deepSource) && /Selected spacecraft POV \(V\)/.test(deepSource),
  "manual camera changes should leave POV and its active state should be accessible");
assert(/function pointOccluded\(point, basis, occluders\)[\s\S]*?basis\.eye[\s\S]*?Astro\.pointOccludedBySpheres\(point, basis\.eye, occluders\)/.test(deepSource) &&
  /lastOccluders = Array\.isArray\(out\.occluders\) \? out\.occluders : \[\]/.test(deepSource),
  "Deep overlays must consume the renderer's exact camera eye and physical body spheres");
assert(/function markerData\(basis, atMs, alignment\)[\s\S]*?pointOccluded\(point, basis, lastOccluders\)\) continue;[\s\S]*?markers\.push/.test(deepSource) &&
  /screenMarkers = display\.markers \? markerData\(lastBasis, atMs, alignment\) : \[\]/.test(deepSource) &&
  /function nearestMarker[\s\S]*?for \(const marker of screenMarkers\)/.test(deepSource),
  "Deep must remove occulted markers before labels and pointer picking consume screenMarkers");
assert(/screenBodies = out\.bodies && typeof out\.bodies === "object" \? out\.bodies : \{\}/.test(deepSource) &&
  /function nearestBody\(point, radius\)[\s\S]*?pickVisibleBody\(screenBodies, point, radius, focusableBodyIds\)/.test(deepSource) &&
  /const marker = nearestMarker\(point, 12\);[\s\S]*?if \(marker\)[\s\S]*?else \{[\s\S]*?nearestBody\(point, 12\)[\s\S]*?setFocusBody\(bodyId\)/.test(deepSource),
  "Deep canvas clicks should preserve mission priority and otherwise focus only visible rendered bodies");
assert(/const viewBodies = Object\.values\(C\.BODIES\)\.filter\(isFocusableBody\)/.test(deepSource),
  "Deep focus/frame controls should expose the same planets, moons, dwarfs, asteroids, and comets as canvas picking");
assert(/appendBodyOption\(dom\.frameBody, "synodic:sun-earth", "Sun-Earth \/ synodic \(ideal CR3BP\)"\)/.test(deepSource) &&
  /appendBodyOption\(dom\.frameBody, "synodic:earth-moon", "Earth-Moon \/ synodic \(ideal CR3BP\)"\)/.test(deepSource),
  "Deep Frame should expose both ideal CR3BP synodic systems without adding virtual catalog bodies");
assert(/canvas\.addEventListener\("dblclick", \(event\)/.test(deepSource) &&
  /const retainedBodyId = isRecentBodyPointerPick\(lastBodyPointerPick, point, event\.timeStamp\)[\s\S]*?const retainedLibration = isRecentBodyPointerPick\(lastLibrationPointerPick[\s\S]*?const marker = retainedBodyId \|\| retainedLibration \? null : nearestMarker\(point, 12\)[\s\S]*?let bodyId = retainedBodyId \|\| nearestBody\(point, 12\)/.test(deepSource),
  "Deep double-click should retain a body or virtual point picked before its camera recenter");
assert(/function drawSelectedTrajectory\(basis, atMs, palette, alignment, occluders\)/.test(deepSource) &&
  /drawPath\(future,[\s\S]{0,180}?occluders, refinementBudget\);[\s\S]{0,100}?drawPath\(past,[\s\S]{0,100}?occluders, refinementBudget\);/.test(deepSource) &&
  /function drawPath\(points, basis, color, dashed, alpha, occluders(?:, refinementBudget)?\)[\s\S]*?pointOccluded\(point, basis, spheres\)\) \{\s*pen = false/.test(deepSource),
  "Deep past and future mission paths must break whenever a body hides a path point");
assert(/function selectedPathType\(id\)[\s\S]*?missionById\.get\(key\)[\s\S]*?isSurfaceMission\(mission\)[\s\S]*?return "surface"/.test(deepSource),
  "Deep surface metadata should classify rover selections separately from current orbital paths");
assert(/function drawSelectedTrajectory\(basis, atMs, palette, alignment, occluders\)[\s\S]*?const pathType = selectedPathType\(selectedId\);\s*if \(pathType === "surface"\) return;[\s\S]*?framePathFor\(trajectory, atMs\)/.test(deepSource),
  "Deep should stop before generating or drawing a selected orbital path for a surface record");
assert(/function segmentNearProjectedDisk/.test(deepSource) &&
  /const refine = \(a, projectedA, b, projectedB, depth\)/.test(deepSource) &&
  /refine\(a, projectedA, middle, projectedMiddle, depth \+ 1\);[\s\S]*?refine\(middle, projectedMiddle, b, projectedB, depth \+ 1\);/.test(deepSource),
  "Deep must refine sparse chords near planetary disks so visible endpoints cannot bridge across a hidden middle");
assert(/Astro\.rvToCoe\(r, v/.test(deepSource) && /parentLocal: true/.test(deepSource) &&
  /bodyOrbitPathCache/.test(deepSource),
  "authoritative body orbit paths should be bounded cached parent-local osculating curves");
assert(/MTPGroundTrack/.test(deepSource) && /obsRanges: adapter\.obsRanges/.test(deepSource) &&
  /The Sun has no surface ground track/.test(deepSource),
  "Deep view should adapt bounded mission vectors to the guarded ground-track renderer");
assert(/splitTrackPoints/.test(groundtrackSource) && /shouldBreakTrackSegment/.test(groundtrackSource),
  "Deep Track should use exact-current color splitting and discontinuity-safe map strokes");
assert(/if \(dom\.groundPanel\) groundOpen = !dom\.groundPanel\.hidden/.test(deepSource) &&
  /if \(!sharedDisplay && dom\.ground\)/.test(deepSource),
  "Deep ground-track state should follow the shared shell without duplicate button ownership");
assert(/groundAdapterCache\.trajectory === trajectory && groundAdapterCache\.bodyId === bodyId/.test(deepSource) &&
  /groundAdapterCache\.windowKey === windowKey/.test(deepSource) && /w: alignedWorld\(r, state\.atMs\)/.test(deepSource),
  "ground-track adapters should cache per mission/body/window and preserve exact mission-to-body displacement");
assert(/boundedHermiteWindow\(trajectory, window\.startMs, window\.stopMs/.test(deepSource) &&
  /localWindowFor\(trajectory, localFrameBody, atMs\)/.test(deepSource),
  "close reference-frame paths and ground tracks should share bounded Hermite local windows");
assert(/liveOptPaths/.test(deepSource) && /liveFocusBody/.test(deepSource) && /liveFrameBody/.test(deepSource) &&
  /populateViewControls\(\)/.test(deepSource) && /bindDisplayToggles\(\)/.test(deepSource),
  "Deep view should honor optional display, focus, and reference-frame controls");
assert(/const display = trackerDisplay && trackerDisplay\.state \? trackerDisplay\.state/.test(deepSource) &&
  /trackerDisplay && typeof trackerDisplay\.subscribe === "function"/.test(deepSource),
  "Deep should consume shell-owned display state without resetting choices made during bundle loading");
assert(/const archives = globalThis\.MTP_DEEP_ARCHIVES \|\|/.test(deepSource) &&
  /if \(!trajectoryById\.has\(id\) && archiveById\.has\(id\) && !display\.history\)[\s\S]*?setHistoryEnabled\(true\)/.test(deepSource) &&
  /selectedPathType\(selectedId\) === "history"/.test(deepSource),
  "Cassini-like archive-only selections should auto-show a clearly historical selected-only path");
assert(/const exactSelectedState = selectedTrajectory \? stateAtTrajectory\(selectedTrajectory, atMs\) : null/.test(deepSource) &&
  /const bundleCoverage = trajectoryCoverageBounds\(trajectoryById\.values\(\)\)/.test(deepSource) &&
  !/trajectoryCoverageBounds\(archiveById/.test(deepSource),
  "historical paths must not become current markers or widen the current playback bundle");
assert(/currentZoomFloor\(\)/.test(deepSource) && /formatCameraDistance/.test(deepSource),
  "Deep close-up controls should enforce surface floors and expose a legible kilometer scale");
assert(/function deepScaleBarOptions\(\)[\s\S]*?x: readoutRect\.right - canvasRect\.left \+ 16[\s\S]*?y: readoutRect\.bottom - canvasRect\.top - 1/.test(deepSource) &&
  /scaleBar: scaleBar\.visible, scaleBarAnchor: scaleBar\.anchor/.test(deepSource),
  "Deep should anchor the physical scale immediately to the right of its visible camera/focus readout");
assert(/ephemeris\.coverageStartUtc/.test(deepSource) && /ephemeris\.coverageStopUtc/.test(deepSource) &&
  /source TDB converted to UTC/.test(deepSource),
  "transport coverage note should use exact generated UTC bounds and disclose the source time conversion");
assert(/boundedPlaybackTime\(anchorSimMs \+ \(perfMs - anchorPerfMs\) \* speed/.test(deepSource) &&
  /playback paused at bundle/.test(deepSource),
  "Deep playback should stop honestly at the bounded static ephemeris edge");
assert(/soi: display\.soi/.test(deepSource) && /flatLight: display\.flat/.test(deepSource),
  "Deep display options should forward SOI and full-bright choices to the shared renderer");
assert(/minor: display\.minor/.test(deepSource) && /liveOptMinor/.test(deepSource),
  "Deep Display should forward its Planner-matching minor-body choice to the shared renderer");
assert(/cr3bpSystem: cr3bpSystemId/.test(deepSource) && /lagrange: display\.lagrange/.test(deepSource) &&
  /screenLibrationPoints = Array\.isArray\(out\.librationPoints\)/.test(deepSource),
  "Deep should forward the selected ideal system and consume renderer-owned L1-L5 pick records");
assert(/function framePathFor[\s\S]*?pointRelativeToDisplayFrame[\s\S]*?2440587\.5 \+ state\.atMs \/ DAY_MS/.test(deepSource) &&
  /function frameArchiveSegmentsFor[\s\S]*?pointRelativeToDisplayFrame[\s\S]*?2440587\.5 \+ point\.t \/ DAY_MS/.test(deepSource),
  "Deep synodic paths must evaluate each point in its own epoch axes instead of freezing today's frame");
assert(/function nearestLibrationPoint/.test(deepSource) &&
  /const marker = nearestMarker\(point, 12\);[\s\S]*?const libration = nearestLibrationPoint\(point, 12\);[\s\S]*?nearestBody\(point, 12\)/.test(deepSource) &&
  /function setLibrationFocus[\s\S]*?camera\.focusMode = "free"[\s\S]*?function updateLibrationFocus/.test(deepSource),
  "spacecraft picks should retain priority while visible virtual L-points can become epoch-updated free-camera focuses");
assert(/ideal CR3BP/.test(deepSource) && /not telemetry or navigation data/i.test(unifiedHtml),
  "Deep must label Lagrange geometry as an ideal reference rather than live telemetry");
assert(/function nearestPovTarget\(craftWorld\)[\s\S]*?bodyVisibleWithMinorOption\(body, display\.minor, focusBodyId, frameBodyId, C\.BODIES\)/.test(deepSource),
  "Deep POV must not target a minor body that the display intentionally hides");
assert(/fullBright: Boolean\(display\.flat\)/.test(deepSource),
  "Deep Full Bright should also suppress night shading on its shared ground map");
assert(!/\bfetch\s*\(|XMLHttpRequest/.test(deepSource),
  "static Deep 100 must not make runtime Horizons requests");
assert(/"LUNAR"[\s\S]*?"15 m"[\s\S]*?"MARS"[\s\S]*?"30 m"[\s\S]*?"OBSERVATORY"[\s\S]*?"3 h"/.test(generatorSource),
  "release generator should retain mission-aware local-orbiter cadence");
assert(/function Get-TrajectoryClass[\s\S]*?TargetId -eq "-55"[\s\S]*?return "PREDICTED"/.test(generatorSource) &&
  /predictionStartDate = "2009-06-30"/.test(generatorSource),
  "release generation should retain Ulysses' verified post-2009 prediction semantics");
assert(/ValidateSet\("Full", "ReferencesOnly"\)/.test(generatorSource) &&
  /Mode -eq "ReferencesOnly"[\s\S]*?ExistingPayload/.test(generatorSource),
  "release generator should support a preservation-safe reference-only refresh");
assert(/Test-UsableReference/.test(generatorSource) && /ReferencePreserved/.test(generatorSource) &&
  /foreach \(\$RequiredBody in @\("moon", "mars"\)\)/.test(generatorSource),
  "full generation should preserve usable references on transient failures and require Moon/Mars coverage");
assert(/function Test-UsableMission/.test(generatorSource) && /Get-ExistingMission/.test(generatorSource) &&
  /MissionPreserved\.Add\(\$Id\)/.test(generatorSource),
  "full generation should preserve each healthy same-window mission after a transient target failure");
assert(/function Invoke-HorizonsRows/.test(generatorSource) &&
  /BoundaryMarginMs = 300000/.test(generatorSource) &&
  /\(\?:before\|prior to\)/.test(generatorSource) && /after A\\\.D\\\./.test(generatorSource) &&
  /RetryStartUtcMs/.test(generatorSource) && /RetryStopUtcMs/.test(generatorSource),
  "release generation should retain bounded partial records when source kernels end inside the release window");
assert(/\$Failed\.Clear\(\)[\s\S]*?\$Trajectories\.Contains/.test(generatorSource) &&
  /\$SameWindow[\s\S]*?Mission coverage regressed/.test(generatorSource),
  "full generation should rebuild unavailable semantics and abort unexpected same-window coverage regression");
assert(/CENTER=\$\(Encode "'500@10'"\)/.test(generatorSource) &&
  /REF_PLANE=\$\(Encode "'ECLIPTIC'"\)/.test(generatorSource) &&
  /REF_SYSTEM=\$\(Encode "'ICRF'"\)/.test(generatorSource),
  "mission and reference vectors should share a Sun-centered ICRF/ecliptic Horizons query");
assert(/function Convert-JdTdbToUnixMsUtc/.test(generatorSource) &&
  /function Convert-UnixMsUtcToJdTdb/.test(generatorSource) &&
  /sampleTimeScale = "UTC"/.test(generatorSource) &&
  /NormalizeExistingTimeScale/.test(generatorSource),
  "release generation should convert source JDTDB epochs into UTC instants without relabeling them");
assert(generatorSource.indexOf("$Trajectories.Count -eq 0") < generatorSource.lastIndexOf("Write-GeneratedPayload $Payload"),
  "a failed network regeneration must abort before replacing the existing bundle");

console.log("Deep tracker checks passed: 100 catalog entries, " + ephemeris.covered +
  " bounded mission trajectories, " + Object.keys(references).length + " reference bodies, " +
  referenceSampleCount + " bounded reference rows, exact local frames, cubic Hermite, and no extrapolation.");
