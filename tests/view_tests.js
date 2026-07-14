/* Headless behavior checks for Auto Time and the audited view contracts. */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { C, ME, MS } = require("./harness.js");

const root = path.resolve(__dirname, "..");
const uiSource = fs.readFileSync(path.join(root, "js", "ui.js"), "utf8");
const themeSource = fs.readFileSync(path.join(root, "css", "theme.css"), "utf8");
const indexSource = fs.readFileSync(path.join(root, "index.html"), "utf8");
const MAJOR = new Set(["burn", "flyby", "launch", "landing", "liftoff",
  "entry", "splashdown", "impact", "separation", "rendezvous", "dock", "undock"]);

assert(/const AUTOPACE_EVENTS = new Set\(\["burn", "flyby", "launch", "landing", "liftoff",\s*\n\s*"entry", "splashdown", "impact", "separation", "rendezvous", "dock", "undock"\]\)/.test(uiSource),
  "Auto Time should pace major mission events only");
assert(!/const AUTOPACE_EVENTS[^;]+(?:apsis|soi_entry|soi_exit|obs)/s.test(uiSource),
  "minor navigation markers must not repeatedly brake Auto Time");
assert(/const isAutoEvent = \(event, kinds\) => kinds\.has\(event\.kind\) && !event\.patchCorrection/.test(uiSource) &&
  /filter\(\(event\) => isAutoEvent\(event, AUTOPACE_EVENTS\)\)/.test(uiSource) &&
  /isAutoEvent\(event, AUTOCAM_SHOT_EVENTS\)/.test(uiSource),
"tiny numerical SOI patch corrections must not trigger pacing or camera cuts");
assert(/function refreshActivePlaybackEvents\(\)[\s\S]*?activeVehicleResult\(\)[\s\S]*?const events = result && result\.events/.test(uiSource),
  "Auto Time and Auto Camera must follow the selected native vehicle only");
assert(MS.PRESETS.some((preset) => ME.recompute(MS.getPreset(preset.id)).events.some((event) =>
  event.patchCorrection)),
"view regression requires at least one numerical SOI patch event");
assert(uiSource.includes("/ 2.5"), "Auto Time should retain the five-real-second approach ramp");
assert(uiSource.includes("target < rateSmooth ? 2.0 : 3.0"),
  "Auto Time should retain readable brake/acceleration smoothing");
assert(/S\.evW = paced\.map\(\(event\) => event\._burn && event\._burn\.handoff \? 180 : 70\)/.test(uiSource),
  "patched-conic apsis previews need a readable but bounded Auto Time window");
assert(/function resetPace\(\)[\s\S]*?lastRate = S\.speedMode === "auto" && S\.result[\s\S]*?autoRate\(\)/.test(uiSource),
  "pace resets should re-anchor the Auto camera's real-time event rate");
assert(/nowR - shot\.since > 6500/.test(uiSource),
  "Auto camera should retain its long anti-churn shot latch");
assert(/focusMode = "ship"/.test(uiSource) && /focusMode = "body"/.test(uiSource),
  "Auto camera should lock to exact ship/body focus modes");
assert(/const burnPreview = globalThis\.MTPRender\.burnPreviewState[\s\S]*?const wantFrame = displayCenId/.test(uiSource),
  "Auto camera should hold the burn-body frame through a patched-conic preview");
assert(/const AUTO_RENDER_INTERVAL_MS = 1000 \/ 30/.test(uiSource) &&
  /const MANUAL_RENDER_INTERVAL_MS = 1000 \/ 60/.test(uiSource) &&
  /const paintInterval = S\.playing[\s\S]*?S\.speedMode === "auto" \|\| hasComplexNativeScene\(\)[\s\S]*?AUTO_RENDER_INTERVAL_MS/.test(uiSource),
  "Auto Time should cap expensive full-canvas paints without changing clock integration");
assert(/setAutoCam\(false\);\s*setPov\(false\);\s*setViewBtn\(null\);\s*S\.frameBody/s.test(uiSource),
  "manual frame selection should clear incompatible camera states");
const blueprintLive = themeSource.match(
  /#app\[data-theme="blueprint"\] \.auxbtns \.live-link\s*\{([^}]+)\}/);
const cinematicLive = themeSource.match(
  /#app\[data-theme="cinematic"\] \.auxbtns \.live-link\s*\{([^}]+)\}/);
const blueprintLiveLayout = themeSource.match(
  /\[data-theme="blueprint"\] \.auxbtns \.live-link\s*\{([^}]+)\}/);
const cinematicLiveLayout = themeSource.match(
  /\[data-theme="cinematic"\] \.auxbtns \.live-link\s*\{([^}]+)\}/);
assert(blueprintLive && /color:\s*#fff/.test(blueprintLive[1]),
  "Blueprint Live text must outrank the global #app anchor color");
assert(cinematicLive && /color:\s*#ff9d7c/.test(cinematicLive[1]),
  "Cinematic Live text must outrank the global #app anchor color");
assert(blueprintLiveLayout && cinematicLiveLayout &&
  /flex:\s*0 0 auto/.test(blueprintLiveLayout[1]) && /min-width:\s*42px/.test(blueprintLiveLayout[1]) &&
  /flex:\s*0 0 auto/.test(cinematicLiveLayout[1]) && /min-width:\s*42px/.test(cinematicLiveLayout[1]),
  "Live navigation must retain a readable non-shrinking label in both themes");
const desktopCompactStart = themeSource.indexOf("@media (max-width: 2000px)");
const twoRowStart = themeSource.indexOf("@media (max-width: 1380px)", desktopCompactStart);
const desktopCompact = desktopCompactStart >= 0 && twoRowStart > desktopCompactStart
  ? themeSource.slice(desktopCompactStart, twoRowStart) : "";
assert(desktopCompact && /#topbar\s*\{[^}]*gap:\s*8px 10px;[^}]*padding-inline:\s*14px/.test(desktopCompact) &&
  /#presetSel\s*\{[^}]*max-width:\s*155px/.test(desktopCompact) &&
  /#frameSel\s*\{[^}]*max-width:\s*175px/.test(desktopCompact) &&
  /\.viewbtns button\s*\{[^}]*padding:\s*5px 8px/.test(desktopCompact),
  "Blueprint must enter its compact one-row contract before a 1920px desktop viewport can overflow");
assert(/@media \(max-width: 1380px\)[\s\S]*?grid-template-areas: "logo preset" "controls controls"/.test(themeSource),
  "narrow Blueprint should use a deliberate two-row topbar");
assert(/@media \(max-width: 620px\)[\s\S]*?\.ctrlstack\s*\{[\s\S]*?flex-direction: column/.test(themeSource),
  "phone-width Blueprint should split view and auxiliary controls into separate rows");
const phoneSheetStart = themeSource.indexOf("/* At phone widths the three-column Blueprint grid");
const phoneSheetEnd = themeSource.indexOf('[data-theme="blueprint"] #titleBlock', phoneSheetStart);
const phoneSheet = phoneSheetStart >= 0 && phoneSheetEnd > phoneSheetStart
  ? themeSource.slice(phoneSheetStart, phoneSheetEnd) : "";
assert(/@media \(max-width: 720px\)/.test(phoneSheet) &&
  /#layout\s*\{[^}]*position:\s*relative;[^}]*display:\s*block/.test(phoneSheet) &&
  /:is\(#left, #viz, #right\)\s*\{[^}]*grid-column:\s*auto/.test(phoneSheet) &&
  /#viz\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0/.test(phoneSheet),
  "phone-width Blueprint should retain a full-size canvas instead of a zero-width grid column");
assert(/:not\(\.right-collapsed\) #left\s*\{[^}]*visibility:\s*hidden;[^}]*pointer-events:\s*none/.test(phoneSheet) &&
  /:not\(\.right-collapsed\) :is\(#hud, #dispOpts\)\s*\{[^}]*visibility:\s*hidden;[^}]*pointer-events:\s*none/.test(phoneSheet),
  "phone-width Blueprint should expose one technical sheet without covered telemetry controls");
assert(/#dispOpts\s*\{[^}]*left:\s*auto;[^}]*right:\s*18px/.test(phoneSheet),
  "phone-width Blueprint Display must remain reachable beside the mission sheet");

// CR3BP controls belong to the existing Display panel, never the crowded
// topbar. The same DOM receives explicit Blueprint and Cinematic treatment.
{
  const displayStart = indexSource.indexOf('<div id="dispOpts">');
  const displayEnd = indexSource.indexOf('</div>', displayStart);
  const displaySource = indexSource.slice(displayStart, displayEnd);
  const topbarSource = indexSource.slice(indexSource.indexOf('<header id="topbar">'),
    indexSource.indexOf('</header>'));
  assert(displaySource.includes('id="optLagrange"') &&
    displaySource.includes('id="cr3bpSystemSel"'),
  "L1-L5 and CR3BP system controls must live in Planner Display");
  assert(!topbarSource.includes("optLagrange") && !topbarSource.includes("cr3bpSystemSel"),
    "CR3BP controls must not add more topbar pressure");
  assert(/\[data-theme="blueprint"\] #dispOpts > label\.display-system/.test(themeSource) &&
    /\[data-theme="cinematic"\] #dispOpts > label\.display-system/.test(themeSource),
  "CR3BP system selection needs explicit styling in both Planner themes");
  assert(uiSource.includes('value="synodic:sun-earth"') &&
    uiSource.includes('value="synodic:earth-moon"'),
  "Planner frame selector is missing a reviewed synodic system");
  assert(/const el = \$\(id\);\s*\n\s*if \(!el\) continue;[\s\S]*?optLagrange/.test(uiSource) ||
    /\["optLagrange", "lagrange"\][\s\S]*?if \(!el\) continue/.test(uiSource),
  "new Display wiring must remain guarded for classic.html");
  assert(/S\.pickOut && S\.pickOut\.events[\s\S]*?S\.pickOut && S\.pickOut\.librationPoints/.test(uiSource),
  "mission events must retain pick priority over virtual L-points");
  assert(/focusMode = "free"/.test(uiSource) && /librationPointWorld/.test(uiSource),
    "L-point focus must use a time-updated free-camera target");
}

function simulatedDuration(presetId) {
  const result = ME.recompute(MS.getPreset(presetId));
  const events = result.events.filter((event) => MAJOR.has(event.kind));
  const times = events.map((event) => event.t);
  const windows = events.map((event) =>
    event._burn && event._burn.handoff ? 180 : 70);
  const frameDt = 1 / 60;
  let t = 0;
  let smoothRate = null;
  let frames = 0;
  let maxLogChange = 0;

  const cruiseRate = (gap) => {
    const realSeconds = Math.min(12, Math.max(2.8,
      3.4 + 1.35 * Math.log10(gap / C.DAY + 0.02)));
    return gap / realSeconds;
  };

  const targetRate = (at) => {
    let lo = 0, hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= at) lo = mid + 1;
      else hi = mid;
    }
    const previous = lo > 0 ? times[lo - 1] : 0;
    const next = lo < times.length ? times[lo] : result.tEnd;
    const gap = Math.max(next - previous, 1);
    const cruise = cruiseRate(gap);
    const floor = Math.max(30, cruise / 320);
    const ramp = (distance, baseWindow) => {
      const window = Math.max(baseWindow, floor * 1.8);
      return Math.min(cruise,
        floor + Math.sqrt(Math.max(distance - window, 0) * cruise / 2.5));
    };
    const before = lo > 0 ? ramp(at - previous, windows[lo - 1] || 70) : Infinity;
    const after = ramp(next - at, windows[lo] || 70);
    return Math.min(before, after, Math.max(cruise, floor));
  };

  while (t < result.tEnd && frames < 2e6) {
    const target = targetRate(t);
    if (smoothRate === null) smoothRate = target;
    const previousSmooth = smoothRate;
    const tau = target < smoothRate ? 2.0 : 3.0;
    const k = 1 - Math.exp(-frameDt / tau);
    smoothRate = Math.exp(Math.log(smoothRate) +
      (Math.log(Math.max(target, 1)) - Math.log(smoothRate)) * k);
    maxLogChange = Math.max(maxLogChange,
      Math.abs(Math.log(smoothRate / Math.max(previousSmooth, 1e-9))));
    let step = frameDt * smoothRate;

    let lo = 0, hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    if (lo < times.length) {
      const distance = times[lo] - t;
      const crawl = Math.max(targetRate(Math.max(times[lo] - 1, 0)), 30);
      const window = Math.max(windows[lo] || 70, crawl * 1.8);
      if (distance > window) {
        const remaining = distance - window;
        step = Math.min(step, Math.max(frameDt * crawl * 1.15, remaining * 0.30));
      } else {
        step = Math.min(step, Math.max(frameDt * crawl * 1.15, 0.001));
      }
    }
    t += step;
    frames++;
  }

  assert(t >= result.tEnd, presetId + " Auto Time simulation did not complete");
  return { seconds: frames * frameDt, maxLogChange, eventCount: events.length };
}

const bounds = {
  apollo11: [110, 180],
  cassini: [190, 300],
  voyager2: [145, 240],
  mars2026: [45, 90],
  europa: [70, 130],
};
for (const [id, range] of Object.entries(bounds)) {
  const result = simulatedDuration(id);
  assert(result.seconds >= range[0] && result.seconds <= range[1],
    id + " Auto Time duration " + result.seconds.toFixed(1) + " s is outside the audited range");
  assert(result.maxLogChange < 0.065,
    id + " Auto Time rate changes too abruptly in one display frame");
  console.log("PASS ", id.padEnd(12), result.seconds.toFixed(1).padStart(6) + " s",
    "major events=" + result.eventCount, "max frame rate change=" +
    (100 * (Math.exp(result.maxLogChange) - 1)).toFixed(1) + "%");
}

console.log("View/Auto Time checks passed: stable focus contracts, responsive Blueprint topbar/rails, and bounded pacing.");
