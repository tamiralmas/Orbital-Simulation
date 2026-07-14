/* Preset regression sweep: every bundled mission must propagate to its end
 * with zero segment warnings (any level). Run with:  node tests/run_tests.js */
"use strict";
const { C, A, ME, MS, runMission, missionVehicles } = require("./harness.js");
let failed = 0, count = 0;

// Historical presets are intentionally date-pinned. Compare closest-approach
// events to the real encounter epochs with mission-appropriate day-scale
// tolerances rather than brittle exact-second snapshots of this simplified
// ephemeris model.
const HISTORICAL_ENCOUNTERS = {
  cassini: [
    { body: "venus", occurrence: 0, utc: "1998-04-26T13:45:00Z", toleranceDays: 1 },
    { body: "venus", occurrence: 1, utc: "1999-06-24T20:29:00Z", toleranceDays: 2 },
    { body: "earth", occurrence: 0, utc: "1999-08-18T03:28:00Z", toleranceDays: 1 },
    { body: "jupiter", occurrence: 0, utc: "2000-12-30T10:05:00Z", toleranceDays: 1 },
  ],
  voyager1: [
    { body: "jupiter", occurrence: 0, utc: "1979-03-05T12:05:00Z", toleranceDays: 1 },
    { body: "saturn", occurrence: 0, utc: "1980-11-12T23:46:00Z", toleranceDays: 4 },
  ],
  voyager2: [
    { body: "jupiter", occurrence: 0, utc: "1979-07-09T22:29:00Z", toleranceDays: 1.5 },
    { body: "saturn", occurrence: 0, utc: "1981-08-25T03:24:00Z", toleranceDays: 1 },
    { body: "uranus", occurrence: 0, utc: "1986-01-24T17:59:00Z", toleranceDays: 6 },
    { body: "neptune", occurrence: 0, utc: "1989-08-25T03:56:00Z", toleranceDays: 1.25 },
  ],
};

for (const p of MS.PRESETS) {
  count++;
  const m = MS.getPreset(p.id);
  const { r, errs } = runMission(m);
  const vehicleRuns = missionVehicles(m).map((vehicle) => ({
    id: vehicle.id,
    segments: vehicle.segments,
    result: r.vehicleResults && r.vehicleResults[vehicle.id] ||
      (vehicle.id === "primary" ? r : null),
  })).filter((vehicle) => vehicle.result);
  if (p.spacecraft && JSON.stringify(m.spacecraft) !== JSON.stringify(p.spacecraft))
    errs.push("  preset spacecraft metadata was not preserved by getPreset()");
  // Off-grid samples on two-body arcs must remain on the propagated conic.
  for (const vehicle of vehicleRuns) {
    const result = vehicle.result;
    const k = result.samples.findIndex((s, i) => i > 0 && s._interp === "kepler" &&
      s.cen === result.samples[i - 1].cen && s.t - result.samples[i - 1].t > 1);
    if (k > 0) {
      const a = result.samples[k - 1], b = result.samples[k], tm = (a.t + b.t) / 2;
      const sm = ME.sampleAtTime(result, tm);
      const hm0 = A.V.mag(A.V.cross(a.r, a.v));
      const hm1 = A.V.mag(A.V.cross(sm.r, sm.v));
      if (!(hm0 > 0) || Math.abs(hm1 - hm0) / hm0 > 1e-8)
        errs.push(`  ${vehicle.id} off-grid Kepler interpolation does not conserve angular momentum`);
    }
  }
  // A path hidden by a planet is a render concern; the propagated spacecraft
  // itself must nevertheless remain on or above the physical surface. Check
  // stored states and an off-grid point in every continuous interval so a
  // real surface crossing cannot be mistaken for an occlusion regression.
  const assertSurfaceClear = (s, where) => {
    if (!s || s.landed) return;
    const body = C.BODIES[s.cen];
    if (!body) return;
    const alt = A.V.mag(s.r) - body.radius;
    if (alt < -1e-6)
      errs.push(`  ${where} crosses ${body.name}'s surface by ${(-alt).toFixed(3)} km`);
  };
  for (const vehicle of vehicleRuns) {
    const result = vehicle.result;
    result.samples.forEach((s, i) =>
      assertSurfaceClear(s, `${vehicle.id} sample #${i}`));
    for (let i = 1; i < result.samples.length; i++) {
      const a = result.samples[i - 1], b = result.samples[i];
      if (a.cen !== b.cen || b.t <= a.t || a.landed || b.landed) continue;
      assertSurfaceClear(ME.sampleAtTime(result, 0.5 * (a.t + b.t)),
        `${vehicle.id} interval #${i - 1}-${i}`);
    }
  }


  // Departures must spend real simulation time on a continuous local
  // hyperbola before entering the parent frame. The old same-timestamp SOI
  // replacement avoided a surface crossing but visibly teleported the ship.
  for (const vehicle of vehicleRuns) {
    const result = vehicle.result, segments = vehicle.segments;
    const continuousDepartures = result.events.filter((event) =>
      event._burn && event._burn.continuousSoi);
    const continuousSegments = segments.filter((segment) =>
      segment.type === "depart" || (segment.type === "return" && segment._info.escapeCoastS));
    if (continuousDepartures.length !== continuousSegments.length)
      errs.push(`  ${vehicle.id} expected ${continuousSegments.length} continuous-SOI departure event(s), ` +
        `found ${continuousDepartures.length}`);
    for (const event of continuousDepartures) {
    const sourceId = event._burn.cen;
    const source = C.BODIES[sourceId];
    const parentId = source && source.parent;
    const exitEvent = result.events.find((candidate) => candidate.kind === "soi_exit" &&
      candidate.seg === event.seg && candidate.t > event.t && candidate.body === parentId);
    if (!source || !parentId || !exitEvent) {
      errs.push(`  ${source ? source.name : sourceId} departure lacks a later SOI exit`);
      continue;
    }
    if (!(exitEvent.t - event.t > 3600))
      errs.push(`  ${source.name} local escape coast is unrealistically short`);
    if (Math.abs(exitEvent.t - event._burn.exitT) > 0.05)
      errs.push(`  ${source.name} propagated SOI exit missed its solved epoch by ` +
        `${Math.abs(exitEvent.t - event._burn.exitT).toFixed(3)} s`);

    const local = result.samples.filter((sample) => sample.cen === sourceId &&
      sample.t >= event.t - 1e-6 && sample.t <= exitEvent.t + 1e-6);
    if (local.length < 3) {
      errs.push(`  ${source.name} escape coast has no drawable local samples`);
    } else {
      // An escape burn may occur shortly before periapsis, so a small initial
      // inward leg is physical. Once the hyperbola is outbound it must not
      // reverse inward again before the SOI boundary.
      let outbound = false;
      for (let i = 1; i < local.length; i++) {
        const previousRadius = A.V.mag(local[i - 1].r);
        const radius = A.V.mag(local[i].r);
        if (radius > previousRadius + 1e-5) outbound = true;
        else if (outbound && radius + 1e-5 < previousRadius) {
          errs.push(`  ${source.name} escape radius reverses inward before the SOI`);
          break;
        }
      }
    }

    const sameTime = result.samples.map((sample, index) => ({ sample, index }))
      .filter(({ sample }) => Math.abs(sample.t - exitEvent.t) < 1e-4);
    const localExit = sameTime.find(({ sample }) => sample.cen === sourceId);
    const parentEntry = sameTime.find(({ sample }) => sample.cen === parentId);
    if (!localExit || !parentEntry) {
      errs.push(`  ${source.name} SOI handoff lacks same-time local/parent states`);
      continue;
    }
    const posGap = A.V.mag(A.V.sub(localExit.sample.w, parentEntry.sample.w));
    const jd = result.epochJD + exitEvent.t / C.DAY;
    const sourceInParentV = ME.relBodyState(sourceId, parentId, jd).v;
    const localParentV = A.V.add(sourceInParentV, localExit.sample.v);
    const velGap = A.V.mag(A.V.sub(localParentV, parentEntry.sample.v));
    if (posGap > 1e-4)
      errs.push(`  ${source.name} SOI position discontinuity is ${posGap.toFixed(6)} km`);
    if (velGap > 1e-7)
      errs.push(`  ${source.name} SOI velocity discontinuity is ${velGap.toFixed(9)} km/s`);
    if (parentEntry.sample._breakBefore)
      errs.push(`  ${source.name} continuous SOI handoff retained a polyline break`);

    const segment = segments[event.seg];
    if (!(segment._info.patchDv < 1e-3))
      errs.push(`  ${source.name} SOI targeting residual is ` +
        `${(segment._info.patchDv * 1000).toFixed(3)} m/s`);
    const appliedBurn = A.V.mag(A.V.sub(event._burn.v1, event._burn.v0));
    if (Math.abs(appliedBurn - event.dv) > 1e-10)
      errs.push(`  ${source.name} departure event delta-v differs from its applied vector`);
    }
  }

  for (const vehicle of vehicleRuns) {
    for (const segment of vehicle.segments.filter((item) => item.type === "return" &&
      isFinite(item._info.rpTargeted))) {
      const target = C.BODIES[segment.target];
      const requested = target.radius + (+segment.periKm || 40);
      if (Math.abs(segment._info.rpTargeted - requested) > 1)
        errs.push(`  ${vehicle.id} ${target.name} return periapsis misses its target by ` +
          `${Math.abs(segment._info.rpTargeted - requested).toFixed(3)} km`);
      if (Math.abs(segment._info.arrivalRadialSpeed) > 1e-7)
        errs.push(`  ${vehicle.id} ${target.name} return endpoint is not tangent ` +
          `(radial speed ${segment._info.arrivalRadialSpeed.toExponential(3)} km/s)`);
    }
  }

  const encounterChecks = HISTORICAL_ENCOUNTERS[p.id] || [];
  const primaryResult = r.vehicleResults && r.vehicleResults.primary || r;
  for (const check of encounterChecks) {
    const matches = primaryResult.events.filter((event) =>
      event.kind === "flyby" && event.body === check.body);
    const event = matches[check.occurrence || 0];
    if (!event) {
      errs.push(`  missing historical ${check.body} encounter #${(check.occurrence || 0) + 1}`);
      continue;
    }
    const actualJD = primaryResult.epochJD + event.t / C.DAY;
    const expectedJD = A.dateToJD(check.utc);
    const errorDays = Math.abs(actualJD - expectedJD);
    if (errorDays > check.toleranceDays)
      errs.push(`  historical ${check.body} encounter differs by ${errorDays.toFixed(2)} d ` +
        `(limit ${check.toleranceDays.toFixed(2)} d)`);
  }

  // pass criterion: zero segment warnings (interplanetary presets normally
  // end mid-coast, so r.ended is not required)
  const ok = errs.length === 0;
  const sampleCount = vehicleRuns.reduce((sum, vehicle) =>
    sum + vehicle.result.samples.length, 0);
  console.log(`${ok ? "PASS" : "FAIL"}  ${p.id.padEnd(14)} ${(r.tEnd / C.DAY).toFixed(1).padStart(8)} d  ` +
    `dv=${r.totalDv.toFixed(2)} km/s  samples=${sampleCount}  ${r.computeMs.toFixed(0)}ms`);
  if (!ok) { failed++; errs.forEach((e) => console.log(e)); }
}
console.log(`\n${count - failed}/${count} presets clean`);
if (failed || count < 9) { console.error("TESTS FAILED"); process.exit(1); }
