/* Headless contracts for the unified Earth 100 / Deep 100 shell. */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "js", "tracker-shell.js"), "utf8");
const html = fs.readFileSync(path.join(root, "live.html"), "utf8");

function element(id) {
  const classes = new Set();
  return {
    id, textContent: "", innerHTML: "", hidden: false, checked: true, placeholder: "", dataset: {}, attributes: {}, listeners: {}, children: [], parentNode: null,
    classList: {
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    addEventListener(name, fn) { this.listeners[name] = fn; },
    appendChild(child) {
      if (child.parentNode && child.parentNode.children) {
        child.parentNode.children = child.parentNode.children.filter((entry) => entry !== child);
      }
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
  };
}

async function runMode(hash, narrow = false, theme = "blueprint", failArchive = false,
    restoredHistory = false) {
  const ids = ["app", "liveSource", "liveAccuracy", "liveCatalogMeta", "liveSearch", "liveGroup",
    "liveSidebar", "liveMissionList", "liveViz", "liveCanvas", "liveLegend", "liveScaleReadout",
    "liveSceneTitle", "liveHudModel", "liveTopFrameSlot", "liveDeepDisplaySlot",
    "liveTopStatusSlot", "liveSidebarStatusSlot",
    "liveCardElementNote", "btnLiveFitSelected", "liveSpeed", "btnLiveResetView", "liveTransportNote",
    "btnLiveRefresh", "btnTrackerEarth", "btnTrackerDeep", "liveTopStatus", "liveCard",
    "btnCatalogToggle", "btnLivePov", "btnLiveDisplay", "liveDisplayPanel", "liveOptPaths", "liveOptMarkers",
    "liveOptLabels", "liveOptGrid", "liveOptSoi", "liveOptTextures", "liveOptFlat", "liveOptMinor", "liveOptOrbits", "liveOptHistory", "liveOptLagrange", "liveDeepViewControls",
    "liveFocusBody", "liveFrameBody", "liveCr3bpSystem", "btnLiveGround", "liveGroundPanel", "liveGroundCanvas",
    "liveGroundTitle", "liveGroundStatus", "btnLiveGroundClose"];
  const elements = new Map(ids.map((id) => [id, element(id)]));
  elements.get("app").dataset.theme = theme;
  elements.get("liveCard").hidden = true;
  elements.get("liveGroundPanel").hidden = true;
  elements.get("liveOptSoi").checked = false;
  elements.get("liveOptFlat").checked = false;
  elements.get("liveOptMinor").checked = false;
  elements.get("liveOptHistory").checked = restoredHistory;
  elements.get("liveTopFrameSlot").appendChild(elements.get("liveDeepViewControls"));
  elements.get("liveTopStatusSlot").appendChild(elements.get("liveTopStatus"));
  const named = {
    ".live-kicker": element("kicker"),
    ".live-sidebar-title": element("sidebar-title"),
    ".live-sidebar-copy": element("sidebar-copy"),
  };
  const labels = Array.from({ length: 6 }, (_, i) => element("label-" + i));
  const loaded = [];
  const observers = [];
  const document = {
    title: "",
    listeners: {},
    getElementById(id) { return elements.get(id) || null; },
    querySelector(selector) { return named[selector] || null; },
    querySelectorAll(selector) { return selector === "#liveCard .live-detail-label" ? labels : []; },
    createElement(tag) { return element(tag); },
    body: {
      appendChild(script) {
        loaded.push(script.src);
        if (failArchive && script.src === "js/deep-space-archives.js") {
          if (script.onerror) script.onerror();
        } else if (script.onload) script.onload();
      },
    },
    addEventListener(name, fn) { this.listeners[name] = fn; },
  };
  const location = { hash, reloadCount: 0, reload() { this.reloadCount++; } };
  const mediaListeners = [];
  const mediaQuery = {
    matches: narrow,
    addEventListener(name, fn) { if (name === "change") mediaListeners.push(fn); },
  };
  const window = {
    listeners: {},
    addEventListener(name, fn) { this.listeners[name] = fn; },
    matchMedia() { return mediaQuery; },
  };
  class MutationObserver {
    constructor(callback) { this.callback = callback; }
    observe(target, options) { observers.push({ callback: this.callback, target, options }); }
  }
  const sandbox = { document, location, window, MutationObserver, Promise, Error, Object, String, console };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "tracker-shell.js" });
  await new Promise((resolve) => setImmediate(resolve));
  return { sandbox, elements, named, labels, loaded, document, location, observers,
    mediaQuery, mediaListeners };
}

(async () => {
  assert(/Earth 100 \/ Deep 100/.test(html),
    "live.html should identify both mission catalogs without crowding the header with dated prose");

  const earth = await runMode("#earth");
  assert.strictEqual(earth.sandbox.MTPTrackerShell.mode, "earth");
  assert.deepStrictEqual(earth.loaded, ["js/groundtrack.js", "js/live-catalog.js", "js/live.js"],
    "Earth mode should load the small shared map renderer, not the large Deep ephemeris bundle");
  assert.strictEqual(earth.named[".live-sidebar-title"].textContent, "Earth 100 catalog");
  assert.strictEqual(earth.elements.get("liveSceneTitle").textContent, "Earth 100");
  assert.strictEqual(earth.elements.get("liveHudModel").textContent, "SGP4 / SDP4");
  assert.strictEqual(earth.elements.get("liveDeepViewControls").parentNode,
    earth.elements.get("liveTopFrameSlot"),
    "desktop Blueprint should keep the guarded Deep controls in its top action lane");
  assert.strictEqual(earth.elements.get("liveTopStatus").parentNode,
    earth.elements.get("liveSidebarStatusSlot"),
    "Blueprint should relocate changing source and accuracy prose out of the control bar");
  assert(earth.elements.get("btnTrackerEarth").classList.contains("active"));
  assert.strictEqual(earth.elements.get("btnLiveRefresh").hidden, false);
  assert.strictEqual(earth.elements.get("liveDeepViewControls").hidden, true);
  assert.strictEqual(earth.elements.get("btnLiveGround").hidden, false,
    "Earth mode should expose the same Track action as Deep and the Planner");
  assert.strictEqual(earth.sandbox.MTPTrackerDisplay.state.grid, true,
    "Earth reference grid should start on");
  assert.strictEqual(earth.sandbox.MTPTrackerDisplay.state.soi, false);
  assert.strictEqual(earth.sandbox.MTPTrackerDisplay.state.flat, false);
  assert.strictEqual(earth.sandbox.MTPTrackerDisplay.state.paths, true);
  assert.strictEqual(earth.sandbox.MTPTrackerDisplay.state.history, false,
    "Earth mode must not opt into a Deep historical overlay");
  assert.strictEqual(earth.sandbox.MTPTrackerDisplay.state.lagrange, false,
    "Earth mode must not opt into Deep ideal-CR3BP reference markers");
  earth.elements.get("liveOptPaths").checked = false;
  earth.elements.get("liveOptPaths").listeners.change();
  assert.strictEqual(earth.sandbox.MTPTrackerDisplay.state.paths, false,
    "shared display state should update immediately from guarded controls");
  earth.document.listeners.keydown({ key: "g", target: null, preventDefault() {} });
  assert.strictEqual(earth.elements.get("liveGroundPanel").hidden, false,
    "G should open the Planner-style ground track in Earth mode");
  earth.document.listeners.keydown({ key: "G", target: null, preventDefault() {} });
  assert.strictEqual(earth.elements.get("liveGroundPanel").hidden, true,
    "the case-insensitive G shortcut should toggle the ground track closed");
  earth.document.listeners.keydown({ key: "g", target: { tagName: "INPUT" }, preventDefault() {} });
  earth.document.listeners.keydown({ key: "g", target: { tagName: "DIV", isContentEditable: true }, preventDefault() {} });
  assert.strictEqual(earth.elements.get("liveGroundPanel").hidden, true,
    "typing G in form or contenteditable fields must not toggle Track");
  assert.strictEqual(typeof earth.sandbox.window.listeners.hashchange, "function",
    "browser Back/Forward scope changes should reload the selected controller");

  const deep = await runMode("#deep");
  assert.strictEqual(deep.sandbox.MTPTrackerShell.mode, "deep");
  assert.deepStrictEqual(deep.loaded, ["js/renderer.js", "js/groundtrack.js", "js/deep-space-catalog.js",
    "js/deep-space-ephemeris.js", "js/deep-space-archives.js", "js/deep.js"]);
  assert.strictEqual(deep.named[".live-sidebar-title"].textContent, "Deep 100 catalog");
  assert.strictEqual(deep.elements.get("liveSceneTitle").textContent, "Deep 100");
  assert.strictEqual(deep.elements.get("liveHudModel").textContent, "HORIZONS");
  assert(deep.elements.get("btnTrackerDeep").classList.contains("active"));
  assert.strictEqual(deep.elements.get("btnLiveRefresh").hidden, true);
  assert.strictEqual(deep.elements.get("liveDeepViewControls").hidden, false);
  assert.strictEqual(deep.elements.get("liveDeepViewControls").parentNode,
    deep.elements.get("liveTopFrameSlot"),
    "desktop Deep Blueprint should place Focus/Frame inline with the topbar buttons");
  assert.strictEqual(deep.elements.get("btnLiveGround").hidden, false);
  assert.strictEqual(deep.elements.get("liveOptGrid").checked, false,
    "Deep reference grid should start off at both the control and shared-state levels");
  assert.strictEqual(deep.sandbox.MTPTrackerDisplay.state.grid, false);
  assert.strictEqual(deep.sandbox.MTPTrackerDisplay.state.minor, true,
    "Deep minor bodies should match the Planner's visible-by-default behavior");
  assert.strictEqual(deep.elements.get("liveOptMinor").checked, true,
    "declared Deep defaults should override a browser-restored hidden-minor checkbox");
  assert.strictEqual(deep.sandbox.MTPTrackerDisplay.setOption("minor", false), true);
  assert.strictEqual(deep.sandbox.MTPTrackerDisplay.state.minor, false);
  assert.strictEqual(deep.elements.get("liveOptMinor").checked, false,
    "the shared display setter should visibly hide Deep minor bodies");
  assert.strictEqual(deep.sandbox.MTPTrackerDisplay.state.history, false,
    "historic mission paths should be selected-only and opt-in by default");
  assert.strictEqual(deep.sandbox.MTPTrackerDisplay.state.lagrange, false,
    "ideal L1-L5 reference markers should remain explicitly opt-in");
  assert.strictEqual(deep.elements.get("liveOptLagrange").checked, false,
    "the guarded Deep L1-L5 checkbox should match its off-by-default state");
  assert.strictEqual(deep.sandbox.MTPTrackerDisplay.setOption("lagrange", true), true);
  assert.strictEqual(deep.sandbox.MTPTrackerDisplay.state.lagrange, true);
  assert.strictEqual(deep.elements.get("liveOptLagrange").checked, true,
    "the shared display setter should visibly enable ideal L1-L5 markers");
  assert(/id="liveOptLagrange"/.test(html) && /L1-L5 \(ideal CR3BP\)/.test(html) &&
    /id="liveCr3bpSystem"[\s\S]*?Earth-Moon[\s\S]*?Sun-Earth/.test(html),
  "Deep Display should expose guarded ideal-CR3BP markers and both reviewed systems");
  const restoredHistory = await runMode("#deep", false, "blueprint", false, true);
  assert.strictEqual(restoredHistory.elements.get("liveOptHistory").checked, false,
    "a browser-restored checkbox must not silently opt a new Deep load into mission history");
  assert.strictEqual(restoredHistory.sandbox.MTPTrackerDisplay.state.history, false,
    "restored form state and the Deep display controller must not disagree");
  assert.strictEqual(deep.sandbox.MTPTrackerDisplay.setOption("history", true), true);
  assert.strictEqual(deep.sandbox.MTPTrackerDisplay.state.history, true);
  assert.strictEqual(deep.elements.get("liveOptHistory").checked, true,
    "the guarded display setter should visibly reflect archive-only auto-enable behavior");
  assert(/id="liveOptHistory"[^>]*>/.test(html) && /historic mission path/i.test(html),
    "the shared Display component should expose a clearly historical selected-only Deep option");
  assert(deep.elements.get("app").classList.contains("display-open"),
    "Planner-style Display options should start expanded");
  deep.elements.get("btnLiveDisplay").listeners.click();
  assert(deep.elements.get("liveDisplayPanel").classList.contains("collapsed"),
    "Display heading should collapse its vertical Planner-style option list");
  assert(!deep.elements.get("app").classList.contains("display-open"));
  deep.elements.get("btnLiveDisplay").listeners.click();
  assert(!deep.elements.get("liveDisplayPanel").classList.contains("collapsed"));
  deep.elements.get("btnLiveGround").listeners.click();
  assert.strictEqual(deep.elements.get("liveGroundPanel").hidden, false);
  assert(deep.elements.get("app").classList.contains("ground-open"));
  assert(deep.elements.get("app").classList.contains("display-open"),
    "desktop Track and Display components should occupy their independent Planner zones");
  deep.elements.get("btnCatalogToggle").listeners.click();
  assert(deep.elements.get("app").classList.contains("catalog-collapsed"));
  assert.strictEqual(deep.elements.get("btnCatalogToggle").attributes["aria-expanded"], "false");
  assert.strictEqual(deep.labels[0].textContent, "Horizons ID");
  assert.strictEqual(deep.labels[5].textContent, "Destination");

  const deepWithoutArchiveAsset = await runMode("#deep", false, "blueprint", true);
  assert.strictEqual(deepWithoutArchiveAsset.loaded[deepWithoutArchiveAsset.loaded.length - 1], "js/deep.js",
    "a missing optional archive asset must not prevent the bounded current Deep controller from loading");
  assert(!/Could not load/.test(deepWithoutArchiveAsset.elements.get("liveSource").textContent),
    "optional mission history should fail closed without marking current Deep data offline");

  const cinematic = await runMode("#deep", false, "cinematic");
  assert(cinematic.elements.get("liveDisplayPanel").classList.contains("collapsed") &&
    !cinematic.elements.get("app").classList.contains("display-open"),
  "Cinematic Live should start with the same compact Display pill as the Planner");
  assert.strictEqual(cinematic.elements.get("liveDeepViewControls").parentNode,
    cinematic.elements.get("liveTopFrameSlot"),
    "desktop Cinematic should use the same inline Focus/Frame topbar slot");
  assert.strictEqual(cinematic.elements.get("liveTopStatus").parentNode,
    cinematic.elements.get("liveTopStatusSlot"),
    "Cinematic should retain its floating scene-status hierarchy");
  assert.strictEqual(cinematic.elements.get("liveGroundTitle").textContent, "GROUND TRACK");

  const responsive = await runMode("#deep", false, "blueprint");
  responsive.elements.get("liveFocusBody").value = "mars";
  responsive.mediaQuery.matches = true;
  for (const listener of responsive.mediaListeners) listener({ matches: true });
  assert.strictEqual(responsive.elements.get("liveDeepViewControls").parentNode,
    responsive.elements.get("liveDeepDisplaySlot"),
    "crossing into compact layout should move the existing controls into Display");
  assert.strictEqual(responsive.elements.get("liveFocusBody").value, "mars",
    "responsive reparenting must preserve the selected Focus value");
  responsive.mediaQuery.matches = false;
  for (const listener of responsive.mediaListeners) listener({ matches: false });
  assert.strictEqual(responsive.elements.get("liveDeepViewControls").parentNode,
    responsive.elements.get("liveTopFrameSlot"),
    "crossing back to desktop should restore the same controls to the topbar");

  const preservedDisplay = await runMode("#deep", false, "blueprint");
  assert(preservedDisplay.elements.get("app").classList.contains("display-open"));
  preservedDisplay.elements.get("app").dataset.theme = "cinematic";
  for (const observer of preservedDisplay.observers) observer.callback();
  assert(preservedDisplay.elements.get("app").classList.contains("display-open"),
    "theme switching should preserve the user's open Display state");
  preservedDisplay.elements.get("btnLiveDisplay").listeners.click();
  preservedDisplay.elements.get("app").dataset.theme = "blueprint";
  for (const observer of preservedDisplay.observers) observer.callback();
  assert(preservedDisplay.elements.get("liveDisplayPanel").classList.contains("collapsed"),
    "theme switching should also preserve the user's collapsed Display state");

  const compactCinematic = await runMode("#deep", true, "cinematic");
  assert.strictEqual(compactCinematic.elements.get("liveDeepViewControls").parentNode,
    compactCinematic.elements.get("liveDeepDisplaySlot"),
    "compact Cinematic should keep Focus/Frame reachable through Display instead of hiding them in the header");

  const narrow = await runMode("#deep", true);
  assert(narrow.elements.get("app").classList.contains("catalog-collapsed") &&
    narrow.elements.get("app").classList.contains("display-open"),
    "narrow Live should start with the catalog tucked behind its edge tab and Display discoverable");
  narrow.elements.get("btnCatalogToggle").listeners.click();
  assert(!narrow.elements.get("app").classList.contains("catalog-collapsed") &&
    !narrow.elements.get("app").classList.contains("display-open"),
    "opening the narrow catalog should collapse competing overlays instead of stacking them");
  narrow.elements.get("btnLiveGround").listeners.click();
  assert.strictEqual(narrow.elements.get("liveGroundPanel").hidden, false);
  narrow.elements.get("app").dataset.theme = "cinematic";
  for (const observer of narrow.observers) observer.callback();
  narrow.elements.get("app").dataset.theme = "blueprint";
  for (const observer of narrow.observers) observer.callback();
  assert.strictEqual(narrow.elements.get("liveGroundPanel").hidden, false,
    "theme switching must preserve an open compact Track panel");
  assert(narrow.elements.get("liveDisplayPanel").classList.contains("collapsed"),
    "Blueprint Display should remain tucked away while the preserved compact Track panel is open");

  console.log("Unified tracker shell checks passed: one page, two scale-correct modes, selected data only.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
