/* =============================================================================
 * Mission Trajectory Planner - unified Earth 100 / Deep 100 tracker shell.
 *
 * Both catalogs share one URL and one UI, but retain separate renderers and
 * accuracy contracts. Only the selected mode's data/controller is loaded;
 * this avoids parsing the multi-megabyte Horizons bundle in Earth mode and
 * avoids pretending Earth-orbit and heliocentric scales fit one camera.
 * ========================================================================== */
"use strict";

(function () {
  const $ = (id) => document.getElementById(id);
  const app = $("app");
  if (!app) return;

  const mode = String(location.hash || "").toLowerCase() === "#deep" ? "deep" : "earth";
  app.dataset.trackerMode = mode;
  app.classList.toggle("deep-app", mode === "deep");

  const setText = (id, value) => { const el = $(id); if (el) el.textContent = value; };
  const setAttr = (id, name, value) => { const el = $(id); if (el) el.setAttribute(name, value); };
  const setLabels = (values) => {
    const labels = document.querySelectorAll("#liveCard .live-detail-label");
    for (let i = 0; i < labels.length && i < values.length; i++) labels[i].textContent = values[i];
  };
  const setDeepControls = (visible) => {
    const controls = $("liveDeepViewControls");
    if (controls) controls.hidden = !visible;
    const options = document.querySelectorAll("[data-live-deep-only]");
    for (const option of options) option.hidden = !visible;
  };

  function configureEarth() {
    document.title = "Live Mission Tracker - Earth 100";
    setText("liveSceneTitle", "Earth 100");
    setText("liveHudModel", "SGP4 / SDP4");
    setText("liveSource", "Earth catalog ready; checking orbital elements");
    setText("liveAccuracy", "Public orbital predictions / not telemetry / not for pass prediction or operations");
    setText("liveCatalogMeta", "100 Earth catalog entries / waiting for elements");
    const kicker = document.querySelector(".live-kicker");
    if (kicker) kicker.textContent = "01 / Earth-orbit spacecraft";
    const title = document.querySelector(".live-sidebar-title");
    if (title) title.textContent = "Earth 100 catalog";
    const copy = document.querySelector(".live-sidebar-copy");
    if (copy) copy.textContent = "Select a row or marker to inspect its visualization-grade Earth orbit. Catalog membership does not assert operational status.";
    const search = $("liveSearch");
    if (search) { search.placeholder = "Search name, agency, NORAD"; search.setAttribute("aria-label", "Search Earth missions"); }
    const group = $("liveGroup");
    if (group) group.innerHTML = '<option value="ALL">All Earth groups</option><option value="STATIONS">Stations</option><option value="SCIENCE">Science</option><option value="RESOURCE">Earth observation</option>';
    setAttr("liveSidebar", "aria-label", "Earth 100 mission catalog");
    setAttr("liveMissionList", "aria-label", "One hundred tracked Earth-orbit spacecraft");
    setAttr("liveViz", "aria-label", "Interactive Earth-orbit view");
    setAttr("liveCanvas", "aria-label", "Interactive three-dimensional Earth view with mission markers. Drag to rotate, use the mouse wheel to zoom, and click a marker for details.");
    const legend = $("liveLegend");
    if (legend) legend.innerHTML = '<span class="live-legend-item"><span class="live-legend-swatch stations"></span>Stations</span><span class="live-legend-item"><span class="live-legend-swatch science"></span>Science</span><span class="live-legend-item"><span class="live-legend-swatch resource"></span>Earth observation</span>';
    setText("liveScaleReadout", "Earth radius: -- px");
    setLabels(["NORAD ID", "Element epoch", "Altitude at displayed time", "Speed", "Perigee / apogee", "Inclination / period"]);
    setText("liveCardElementNote", "Current public orbital elements have not been loaded for this entry.");
    setText("btnLiveFitSelected", "Fit selected orbit");
    const speed = $("liveSpeed");
    if (speed) speed.innerHTML = '<option value="1">1x real time</option><option value="10">10x</option><option value="60">60x</option><option value="600">600x</option><option value="3600">3600x</option>';
    setText("btnLiveResetView", "Earth view");
    setText("liveGroundStatus", "Select an Earth-orbit mission");
    setText("liveTransportNote", "CelesTrak OMM + Vallado SGP4/SDP4 prediction; not telemetry or operations. Failed records show a labeled J2 fallback. No conjunction or ground-pass guarantee.");
    setDeepControls(false);
  }

  function configureDeep() {
    document.title = "Live Mission Tracker - Deep 100";
    setText("liveSceneTitle", "Deep 100");
    setText("liveHudModel", "HORIZONS");
    setText("liveSource", "Static Horizons bundle / checking coverage");
    setText("liveAccuracy", "Ephemerides and predictions / not telemetry / operational status unverified");
    setText("liveCatalogMeta", "100 deep-space catalog entries / checking bundled coverage");
    const kicker = document.querySelector(".live-kicker");
    if (kicker) kicker.textContent = "02 / Beyond-Earth mission assets";
    const title = document.querySelector(".live-sidebar-title");
    if (title) title.textContent = "Deep 100 catalog";
    const copy = document.querySelector(".live-sidebar-copy");
    if (copy) copy.textContent = "Browse active and historical missions. A marker appears only when the bounded trajectory covers the displayed UTC; catalog inclusion never proves current operation.";
    const search = $("liveSearch");
    if (search) { search.placeholder = "Search mission, agency, target"; search.setAttribute("aria-label", "Search deep-space missions"); }
    const group = $("liveGroup");
    if (group) group.innerHTML = '<option value="ALL">All deep regions</option><option value="LUNAR">Moon</option><option value="MARS">Mars</option><option value="INNER_HELIO">Inner / Sun</option><option value="OUTER">Outer / interstellar</option><option value="SMALL_BODY">Small bodies</option><option value="OBSERVATORY">Observatories</option>';
    setAttr("liveSidebar", "aria-label", "Deep 100 mission catalog");
    setAttr("liveMissionList", "aria-label", "One hundred deep-space mission assets");
    setAttr("liveViz", "aria-label", "Interactive heliocentric mission view");
    setAttr("liveCanvas", "aria-label", "Interactive three-dimensional heliocentric view with bounded deep-space mission ephemerides. Drag to rotate, use the mouse wheel to zoom, and click a marker for details.");
    const legend = $("liveLegend");
    if (legend) legend.innerHTML = '<span class="live-legend-item"><span class="live-legend-swatch lunar"></span>Moon</span><span class="live-legend-item"><span class="live-legend-swatch mars"></span>Mars</span><span class="live-legend-item"><span class="live-legend-swatch inner-helio"></span>Inner / Sun</span><span class="live-legend-item"><span class="live-legend-swatch outer"></span>Outer</span><span class="live-legend-item"><span class="live-legend-swatch small-body"></span>Small bodies</span><span class="live-legend-item"><span class="live-legend-swatch observatory"></span>Observatories</span>';
    setText("liveScaleReadout", "Camera distance: -- AU");
    setLabels(["Horizons ID", "Bundle coverage", "Distance from Sun", "Heliocentric speed", "Ephemeris status", "Destination"]);
    setText("liveCardElementNote", "No trajectory is inferred outside the generated data window.");
    setText("btnLiveFitSelected", "Fit selected track");
    const speed = $("liveSpeed");
    if (speed) speed.innerHTML = '<option value="1">1x real time</option><option value="60">60x</option><option value="3600">1 h/s</option><option value="21600">6 h/s</option><option value="86400">1 d/s</option>';
    setText("btnLiveResetView", "Sun view");
    setText("liveGroundStatus", "Select a mission and a planetary or lunar reference frame");
    setText("liveTransportNote", "NASA/JPL Horizons bounded vectors / mission-aware cadence / cubic Hermite / no extrapolation / not telemetry");
    const refresh = $("btnLiveRefresh");
    if (refresh) refresh.hidden = true;
    setDeepControls(true);
  }

  /* One guarded control surface feeds both controllers. Keeping the panel
   * state in the shell prevents Earth and Deep modes from growing slightly
   * different display-option behavior and gives dynamically loaded scripts
   * a stable subscription point. */
  /* Earth retains its familiar equatorial grid. Deep starts clean because a
   * heliocentric grid becomes a dense orange fan at close planetary scales. */
  const gridInput = $("liveOptGrid");
  if (gridInput) gridInput.checked = mode === "earth";

  const displayState = {
    paths: true,
    markers: true,
    labels: true,
    grid: mode === "earth",
    soi: false,
    textures: true,
    flat: false,
    minor: true,
    orbits: true,
    history: false,
    lagrange: false,
  };
  const displayInputs = {
    paths: $("liveOptPaths"),
    markers: $("liveOptMarkers"),
    labels: $("liveOptLabels"),
    grid: $("liveOptGrid"),
    soi: $("liveOptSoi"),
    textures: $("liveOptTextures"),
    flat: $("liveOptFlat"),
    minor: $("liveOptMinor"),
    orbits: $("liveOptOrbits"),
    history: $("liveOptHistory"),
    lagrange: $("liveOptLagrange"),
  };
  const displaySubscribers = new Set();

  function notifyDisplay() {
    for (const subscriber of displaySubscribers) subscriber(displayState);
  }

  function setDisplayOption(key, value) {
    if (!Object.prototype.hasOwnProperty.call(displayState, key)) return false;
    const next = Boolean(value);
    displayState[key] = next;
    const input = displayInputs[key];
    if (input) input.checked = next;
    notifyDisplay();
    return true;
  }

  for (const [key, input] of Object.entries(displayInputs)) {
    if (!input) continue;
    /* Browsers may restore checkbox properties across a reload even though
       this controller intentionally starts from mode-specific defaults.
       Make the declared state authoritative so the visible controls and the
       renderer cannot disagree (especially for opt-in mission history). */
    input.checked = Boolean(displayState[key]);
    input.addEventListener("change", () => {
      displayState[key] = Boolean(input.checked);
      notifyDisplay();
    });
  }

  function setPanelOpen(open) {
    const panel = $("liveDisplayPanel");
    const trigger = $("btnLiveDisplay");
    const narrow = typeof window.matchMedia === "function" && window.matchMedia("(max-width: 720px)").matches;
    if (open && narrow) setGroundOpen(false);
    if (panel) {
      panel.hidden = false;
      panel.classList.toggle("collapsed", !open);
    }
    if (trigger) {
      trigger.setAttribute("aria-expanded", String(open));
      trigger.title = open ? "Collapse display options" : "Expand display options";
    }
    app.classList.toggle("display-open", open);
  }

  function setGroundOpen(open) {
    const panel = $("liveGroundPanel");
    const trigger = $("btnLiveGround");
    const next = Boolean(open);
    const narrow = typeof window.matchMedia === "function" && window.matchMedia("(max-width: 720px)").matches;
    if (next && narrow) setPanelOpen(false);
    if (panel) panel.hidden = !next;
    if (trigger) {
      trigger.setAttribute("aria-expanded", String(next));
      trigger.setAttribute("aria-pressed", String(next));
      trigger.classList.toggle("active", next);
    }
    app.classList.toggle("ground-open", next);
  }

  const displayTrigger = $("btnLiveDisplay");
  const groundTrigger = $("btnLiveGround");
  const groundClose = $("btnLiveGroundClose");
  if (displayTrigger) displayTrigger.addEventListener("click", () => {
    const panel = $("liveDisplayPanel");
    const opening = !panel || panel.classList.contains("collapsed");
    setPanelOpen(opening);
  });
  if (groundTrigger) groundTrigger.addEventListener("click", () => {
    const panel = $("liveGroundPanel");
    const opening = !panel || panel.hidden;
    setGroundOpen(opening);
  });
  if (groundClose) groundClose.addEventListener("click", () => setGroundOpen(false));
  if (document.addEventListener) document.addEventListener("keydown", (event) => {
    const target = event.target;
    const tag = target && target.tagName ? String(target.tagName).toLowerCase() : "";
    if (String(event.key || "").toLowerCase() === "g" &&
        tag !== "input" && tag !== "select" && tag !== "textarea" &&
        !(target && target.isContentEditable)) {
      const panel = $("liveGroundPanel");
      setGroundOpen(!panel || panel.hidden);
      if (typeof event.preventDefault === "function") event.preventDefault();
      return;
    }
    if (event.key !== "Escape") return;
    if (app.classList.contains("ground-open")) setGroundOpen(false);
    else if (app.classList.contains("display-open")) setPanelOpen(false);
  });

  /* The catalog uses the same edge-tab interaction as the Planner's left
   * panel. Own it in the shell so it responds while the selected controller
   * is still loading; capture prevents the legacy guarded controller binding
   * from toggling the class a second time. */
  const catalogToggle = $("btnCatalogToggle");
  function setCatalogCollapsed(collapsed) {
    app.classList.toggle("catalog-collapsed", collapsed);
    if (catalogToggle) {
      catalogToggle.setAttribute("aria-expanded", String(!collapsed));
      catalogToggle.setAttribute("aria-label", collapsed ? "Expand mission catalog" : "Collapse mission catalog");
      catalogToggle.title = collapsed ? "Expand mission catalog" : "Collapse mission catalog";
    }
  }
  if (catalogToggle) catalogToggle.addEventListener("click", (event) => {
    if (event && typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
    const opening = app.classList.contains("catalog-collapsed");
    const narrow = typeof window.matchMedia === "function" && window.matchMedia("(max-width: 720px)").matches;
    if (opening && narrow) {
      setPanelOpen(false);
      setGroundOpen(false);
    }
    setCatalogCollapsed(!opening);
    if (typeof requestAnimationFrame === "function" && typeof window.dispatchEvent === "function" &&
        typeof Event === "function") {
      requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    }
  }, true);

  const compactThemeQuery = typeof window.matchMedia === "function"
    ? window.matchMedia("(max-width: 720px)") : null;
  let themeComponentsInitialized = false;

  function syncDeepControlSlot() {
    const deepControls = $("liveDeepViewControls");
    const compact = Boolean(compactThemeQuery && compactThemeQuery.matches);
    const controlSlot = compact ? $("liveDeepDisplaySlot") : $("liveTopFrameSlot");
    if (deepControls && controlSlot && deepControls.parentNode !== controlSlot) {
      controlSlot.appendChild(deepControls);
    }
  }

  function syncStatusSlot() {
    const status = $("liveTopStatus");
    const cinematic = app.dataset.theme === "cinematic";
    const statusSlot = cinematic ? $("liveTopStatusSlot") : $("liveSidebarStatusSlot");
    if (status && statusSlot && status.parentNode !== statusSlot) statusSlot.appendChild(status);
  }

  function syncThemeComponents() {
    const cinematic = app.dataset.theme === "cinematic";
    syncDeepControlSlot();
    syncStatusSlot();
    setText("liveGroundTitle", cinematic ? "GROUND TRACK" : "DETAIL C \u2014 GROUND TRACK");
    /* Match the Planner contract: Blueprint presents the technical option
     * list, while Cinematic starts as a compact Display pill. */
    if (!themeComponentsInitialized) {
      setPanelOpen(!cinematic && !app.classList.contains("ground-open"));
      themeComponentsInitialized = true;
    }
  }
  syncThemeComponents();
  if (typeof MutationObserver === "function") {
    new MutationObserver(syncThemeComponents).observe(app, {
      attributes: true, attributeFilter: ["data-theme"],
    });
  }
  if (compactThemeQuery && typeof compactThemeQuery.addEventListener === "function") {
    compactThemeQuery.addEventListener("change", syncDeepControlSlot);
  }
  const initiallyNarrow = typeof window.matchMedia === "function" && window.matchMedia("(max-width: 720px)").matches;
  if (initiallyNarrow) setCatalogCollapsed(true);

  const card = $("liveCard");
  const syncCardState = () => app.classList.toggle("card-open", Boolean(card && !card.hidden));
  syncCardState();
  if (card && typeof MutationObserver === "function") {
    new MutationObserver(syncCardState).observe(card, { attributes: true, attributeFilter: ["hidden"] });
  }

  globalThis.MTPTrackerDisplay = Object.freeze({
    state: displayState,
    subscribe(subscriber) {
      if (typeof subscriber !== "function") return () => {};
      displaySubscribers.add(subscriber);
      subscriber(displayState);
      return () => displaySubscribers.delete(subscriber);
    },
    setOption: setDisplayOption,
    setPanelOpen,
    setGroundOpen,
  });

  function selectMode(next) {
    if (next === mode) return;
    location.hash = next;
  }
  window.addEventListener("hashchange", () => location.reload());

  const earthButton = $("btnTrackerEarth");
  const deepButton = $("btnTrackerDeep");
  if (earthButton) {
    earthButton.classList.toggle("active", mode === "earth");
    earthButton.setAttribute("aria-pressed", String(mode === "earth"));
    earthButton.addEventListener("click", () => selectMode("earth"));
  }
  if (deepButton) {
    deepButton.classList.toggle("active", mode === "deep");
    deepButton.setAttribute("aria-pressed", String(mode === "deep"));
    deepButton.addEventListener("click", () => selectMode("deep"));
  }

  if (mode === "deep") configureDeep(); else configureEarth();

  function loadScript(src, optional) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.onload = resolve;
      script.onerror = () => optional ? resolve() : reject(new Error("Could not load " + src));
      document.body.appendChild(script);
    });
  }

  const files = mode === "deep"
    ? ["js/renderer.js", "js/groundtrack.js", "js/deep-space-catalog.js", "js/deep-space-ephemeris.js",
      { src: "js/deep-space-archives.js", optional: true }, "js/deep.js"]
    : ["js/groundtrack.js", "js/live-catalog.js", "js/live.js"];

  (async () => {
    try {
      for (const file of files) {
        if (typeof file === "string") await loadScript(file, false);
        else await loadScript(file.src, file.optional);
      }
    } catch (error) {
      const status = $("liveTopStatus");
      if (status) status.dataset.state = "offline";
      setText("liveSource", error && error.message ? error.message : "Tracker failed to load");
    }
  })();

  globalThis.MTPTrackerShell = Object.freeze({ mode, selectMode });
})();
