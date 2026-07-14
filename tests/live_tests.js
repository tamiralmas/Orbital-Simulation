"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const catalogSource = fs.readFileSync(path.join(root, "js", "live-catalog.js"), "utf8");
const liveSource = fs.readFileSync(path.join(root, "js", "live.js"), "utf8");
const shellSource = fs.readFileSync(path.join(root, "js", "tracker-shell.js"), "utf8");
const themeSource = fs.readFileSync(path.join(root, "css", "theme.css"), "utf8");
const html = fs.readFileSync(path.join(root, "live.html"), "utf8");
const plannerHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");

const sandbox = {};
sandbox.globalThis = sandbox;
vm.runInNewContext(catalogSource, sandbox, { filename: "live-catalog.js" });
const catalog = sandbox.MTPLiveCatalog;

assert(catalog, "catalog should export MTPLiveCatalog");
assert.strictEqual(catalog.asOf, "2026-07-12", "catalog review date should be pinned");
assert.strictEqual(catalog.missions.length, 100, "catalog should contain exactly 100 entries");
assert.strictEqual(new Set(catalog.missions.map((mission) => mission.norad)).size, 100,
  "NORAD IDs should be unique");
assert.deepStrictEqual(
  Object.fromEntries(["STATIONS", "SCIENCE", "RESOURCE"].map((group) => [
    group,
    catalog.missions.filter((mission) => mission.group === group).length,
  ])),
  { STATIONS: 10, SCIENCE: 40, RESOURCE: 50 },
  "catalog should retain its reviewed group balance"
);

assert(catalog.cacheMaxAgeMs >= 2 * 60 * 60 * 1000,
  "orbital-element cache should suppress refetches for at least two hours");
assert(catalog.refreshMinAgeMs >= 2 * 60 * 60 * 1000,
  "manual and failed requests should respect CelesTrak's two-hour request interval");
for (const group of ["STATIONS", "SCIENCE", "RESOURCE"]) {
  assert(catalog.sources[group].includes("GROUP=" + group), group + " should use its named CelesTrak group");
  assert(catalog.sources[group].includes("FORMAT=JSON"), group + " should request OMM JSON");
}
assert(!Object.values(catalog.sources).some((url) => /GROUP=ACTIVE/i.test(url)),
  "the tracker must not request CelesTrak's large ACTIVE group");

for (const mission of catalog.missions) {
  assert(Number.isInteger(mission.norad) && mission.norad > 0, "every entry needs a positive integer NORAD ID");
  assert(mission.name && mission.agency && mission.kind && mission.summary, "every entry needs display metadata");
  assert(!mission.wiki || /^https:\/\/en\.wikipedia\.org\/wiki\//.test(mission.wiki),
    "curated Wikipedia overrides should remain on en.wikipedia.org");
}

const ids = Array.from(html.matchAll(/\sid="([^"]+)"/g), (match) => match[1]);
assert.strictEqual(ids.length, new Set(ids).size, "live.html IDs should be unique");
for (const script of ["js/constants.js", "js/kepler.js", "js/sgp4.js", "js/textures-data.js", "js/textures.js",
  "js/theme.js", "js/tracker-shell.js"]) {
  assert(html.includes('src="' + script + '"'), "live.html should load " + script);
}
assert(/not telemetry/i.test(html) && /not for pass prediction/i.test(html),
  "the accuracy limitation should be prominent in live.html");
assert(/OMM-derived SGP4\/SDP4 orbital predictions/i.test(html) &&
  /id="liveHudModel">SGP4 \/ SDP4</.test(html) &&
  /Vallado SGP4\/SDP4/.test(html) && !/no SGP4 drag model/i.test(html),
  "Earth Live provenance should identify the real GP propagator without claiming telemetry");
assert(/id="btnTrackerEarth"[^>]*>Earth 100<\/button>/.test(html) &&
  /id="btnTrackerDeep"[^>]*>Deep 100<\/button>/.test(html) &&
  /class="planner-link" href="index\.html"/.test(html),
  "the combined tracker should expose Earth 100, Deep 100, and the planner");
assert(/location\.hash[^;]+#deep/.test(shellSource) &&
  shellSource.includes('"js/groundtrack.js", "js/live-catalog.js", "js/live.js"') &&
  /"js\/deep-space-ephemeris\.js"[\s\S]*?deep-space-archives\.js[\s\S]*?"js\/deep\.js"/.test(shellSource),
  "the unified shell should load only the selected Earth or Deep controller stack");
assert(/Earth 100 \/ Deep 100/.test(html) && !/2026-07-12<\/span>/.test(html),
  "the tracker brand should identify both scopes without a dated status sentence in the header");
assert(/id="liveOptTextures"[^>]*type="checkbox" checked>\s*textures\s*<\/label>/i.test(html),
  "Live Display should use the requested concise Textures label");
assert(/class="live-deep-only"\s+data-live-deep-only[^>]*>[\s\S]{0,180}?id="liveOptMinor"[^>]*type="checkbox" checked>\s*minor bodies/i.test(html),
  "Deep Display should expose a visible-by-default, Deep-only minor-body control");
for (const id of ["btnCatalogToggle", "btnLivePov", "btnLiveDisplay", "liveDisplayPanel", "liveOptPaths",
  "liveOptMarkers", "liveOptLabels", "liveOptGrid", "liveOptSoi", "liveOptTextures", "liveOptFlat", "liveOptMinor", "liveOptOrbits", "liveOptHistory",
  "liveTopFrameSlot", "liveDeepViewControls", "liveFocusBody", "liveFrameBody", "btnLiveGround",
  "liveGroundPanel", "liveGroundCanvas", "liveGroundStatus", "btnLiveGroundClose"]) {
  assert(html.includes('id="' + id + '"'), "live tracker should expose shared control #" + id);
}
assert(/MTPTrackerDisplay/.test(shellSource) && /displaySubscribers/.test(shellSource) &&
  /setPanelOpen/.test(shellSource) && /setGroundOpen/.test(shellSource),
  "Earth and Deep controllers should share one guarded display-panel state contract");
assert(/displayState\.paths/.test(liveSource) && /displayState\.markers/.test(liveSource) &&
  /displayState\.labels/.test(liveSource) && /displayState\.grid/.test(liveSource) &&
  /displayState\.textures/.test(liveSource),
  "Earth 100 should honor path, marker, label, grid, and texture options");
assert(/id="liveDisplayPanel"[^>]*>\s*<button id="btnLiveDisplay"[\s\S]*?<label><input id="liveOptPaths"/.test(html) &&
  !/id="liveDisplayPanel"[^>]*(?:hidden|collapsed)/.test(html),
  "Live Display should use the Planner's expanded vertical button-and-label structure");
assert(/\[data-theme="blueprint"\] :is\(#dispOpts, #liveDisplayPanel\)\s*\{[\s\S]*?background:\s*var\(--panel2\)[\s\S]*?border:\s*1px solid var\(--line\)/.test(themeSource) &&
  /\[data-theme="cinematic"\] :is\(#dispOpts, #liveDisplayPanel\):not\(\.collapsed\)\s*\{[\s\S]*?border-radius:\s*12px[\s\S]*?backdrop-filter:\s*blur\(18px\)/.test(themeSource) &&
  /:is\(#dispOpts, #liveDisplayPanel\) > label:has\(input:checked\)::before/.test(themeSource),
  "Planner and Live Display must share the exact same Blueprint and Cinematic component rules");
assert(!/\[data-theme="(?:blueprint|cinematic)"\] #liveDisplayPanel[^\{]*\{[^}]*(?:background|border-radius|backdrop-filter|font-size|text-transform):/s.test(themeSource),
  "Live Display must not override the shared Planner component with a lookalike theme block");
assert(/id="liveOptSoi"[^>]*type="checkbox"/.test(html) &&
  /id="liveOptFlat"[^>]*type="checkbox"/.test(html) &&
  /soi:\s*false/.test(shellSource) && /flat:\s*false/.test(shellSource),
  "Live Display should expose off-by-default SOI and Full Bright controls");
assert(/gridInput\.checked = mode === "earth"/.test(shellSource),
  "Earth should start with the reference grid on while Deep starts with it off");
assert(/id="btnLivePov"[^>]*aria-pressed="false"[^>]*disabled>POV<\/button>/.test(html) &&
  /class="live-viewbtns"[\s\S]*?id="btnLiveGround"(?![^>]*hidden)[^>]*>Track<\/button>/.test(html) &&
  /const next = Boolean\(open\)/.test(shellSource),
  "Both Live modes should expose POV and the same Planner-style Track view control");
assert(/:is\(#gtPanel, #liveGroundPanel\)/.test(themeSource) &&
  /:is\(#gtHead, #liveGroundHead\)/.test(themeSource) &&
  /\[data-theme="blueprint"\] :is\(#gtPanel, #liveGroundPanel\)/.test(themeSource) &&
  /\[data-theme="cinematic"\] :is\(#gtPanel, #liveGroundPanel\)/.test(themeSource) &&
  /id="liveGroundHead"[\s\S]*?id="liveGroundTitle">GROUND TRACK<[\s\S]*?id="liveGroundStatus"[\s\S]*?id="btnLiveGroundClose"/.test(html),
  "Planner and Live ground tracks must share the exact same panel, header, status, and close-button rules");
assert(!/\[data-theme="(?:blueprint|cinematic)"\] #liveGroundPanel\s*\{[^}]*(?:background|border|border-radius|box-shadow|backdrop-filter):/s.test(themeSource),
  "Live ground track must not override the shared Planner surface treatment");
assert(/id="btnCatalogToggle" class="edgeTgl live-catalog-edge"/.test(html) &&
  !/id="btnCatalogToggle"[^>]*>Catalog<\/button>/.test(html) &&
  /#btnCatalogToggle::before\s*\{\s*content:\s*"«"/.test(themeSource) &&
  /catalog-collapsed #btnCatalogToggle::before\s*\{\s*content:\s*"»"/.test(themeSource),
  "catalog collapse should use the Planner edge-tab affordance and directional arrows");
assert(/display-open\.card-open #liveDisplayPanel[\s\S]*?max-height:\s*calc\(50% - 30px\)/.test(themeSource) &&
  /ground-open\.card-open #liveCard/.test(themeSource) &&
  /@media \(max-width: 720px\)[\s\S]*?visibility:\s*hidden/.test(themeSource),
  "live overlay zones should prevent card/display/ground collisions at desktop and narrow widths");
assert(/#liveLegend\s*\{[\s\S]*?bottom:\s*34px/.test(themeSource) &&
  /#liveScaleReadout\s*\{[\s\S]*?left:\s*14px;\s*bottom:\s*14px/.test(themeSource) &&
  /#app\.live-app\[data-theme="cinematic"\] #liveLegend\s*\{[\s\S]*?left:\s*342px;[\s\S]*?bottom:\s*106px/.test(themeSource) &&
  /#app\.live-app\[data-theme="cinematic"\] #liveScaleReadout\s*\{[\s\S]*?left:\s*342px;[\s\S]*?bottom:\s*86px/.test(themeSource) &&
  /#app\.live-app\[data-theme="cinematic"\]\.catalog-collapsed #liveLegend,[\s\S]*?#app\.live-app\[data-theme="cinematic"\]\.catalog-collapsed #liveScaleReadout\s*\{\s*left:\s*30px/.test(themeSource),
  "Live legend and scale should retain Blueprint defaults while sharing the Cinematic rail alignment");
assert(/class="live-link" href="live\.html"[^>]*>Live<\/a>/.test(plannerHtml),
  "the planner tracker link should retain the compact Blueprint label");
assert(/SGP4\.initializeOMM\(record/.test(liveSource) &&
  /SGP4\.propagateDate\(model\.sgp4Record, atMs\)/.test(liveSource) &&
  /temeStateToPlanner\(teme\)/.test(liveSource),
  "Earth Live should initialize CelesTrak OMM through the bundled SGP4/SDP4 core");
assert(/propagateLegacyJ2/.test(liveSource) && /propagator:\s*"J2 fallback"/.test(liveSource) &&
  /OmDot:\s*-1\.5/.test(liveSource) && /wDot:\s*0\.75/.test(liveSource),
  "the former J2 approximation should survive only as an explicit labeled fallback");
assert(/MEAN_MOTION_DDOT/.test(liveSource) && /sourceFrame:\s*"TEME"/.test(liveSource),
  "OMM normalization should retain the SGP4 derivative fields and report its source frame");
assert(/ELEMENT_STALE_MS = 3\.5 \* DAY_MS/.test(liveSource) &&
  /future\/predictive epoch/.test(liveSource) && /stale-elements/.test(themeSource),
  "Earth Live should expose provider-stale and future/predictive element epochs instead of calling every fetch current");
assert(!/package\.json|node_modules|React|Vue|Angular/.test(liveSource),
  "live controller should stay dependency-free");

console.log("Live tracker checks passed: 100 unique entries, bounded OMM cache, Vallado SGP4/SDP4, and labeled fallback.");
