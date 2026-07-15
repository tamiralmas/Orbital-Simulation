/* =============================================================================
 * Mission Trajectory Planner — theme.js
 * Dual-UI controller: Blueprint Light ⇄ Cinematic Overlay.
 *
 * Owns: the canvas palettes (exposed as globalThis.MTPTheme for renderer.js
 * and groundtrack.js), the theme switcher (persisted in localStorage), the
 * sidebar / pane / display-options toggles, and the derived readouts that
 * make each design language live (drawing title block, transport info line,
 * cinematic meta strip).
 * Extracted from the "Mission Planner" design-canvas export so index.html
 * runs standalone — no design-tool runtime required.
 * ========================================================================== */
"use strict";

(function () {
  /* Canvas palettes matching the two chrome themes (renderer reads MTPTheme) */
  const PALETTES = {
    blueprint: {
      bg: "#f7f6f1", starRGB: "28,29,32", starAlpha: 0.12,
      grid: "rgba(28,29,32,0.10)",
      paperGrid: "rgba(28,29,32,0.07)",
      scalebarLeft: true,
      hudSegColor: "#1c1d20",
      trajFuture: "rgba(85,86,79,0.55)",
      trajGlow: "rgba(229,84,30,0.16)", trajPast: "rgba(229,84,30,0.95)",
      apsisOrbit: "rgba(29,78,216,0.48)", apsisApo: "#1d4ed8", apsisPeri: "#b45309",
      soiStroke: "rgba(107,33,168,0.45)", soiFill: "rgba(107,33,168,0.65)",
      labelPlanet: "rgba(28,29,32,0.85)", labelMoon: "rgba(85,86,79,0.8)",
      labelMinor: "rgba(138,136,126,0.8)",
      ship: "#1c1d20", shipLanded: "#2f9e5b", shipGlowRGB: "229,84,30",
      shipLabel: "rgba(200,66,18,0.95)",
      scalebar: "rgba(28,29,32,0.7)", scalebarText: "rgba(28,29,32,0.85)",
      orbitDarken: true,
      paperBodies: true, paperBodyFill: "#fbfaf6",
      paperBodyHatch: "#e3e0d2", paperBodyStroke: "#1c1d20",
      paperBodyFeature: "#8f8c7f",
      events: {
        burn: "#c62828", burn_end: "#c62828",
        soi_entry: "#6b21a8", soi_exit: "#6b21a8", flyby: "#6b21a8",
        libration: "#6b21a8", cr3bp: "#6b21a8", stationkeep: "#0e7e74",
        launch: "#2a6f3a", landing: "#2a6f3a", liftoff: "#2a6f3a",
        entry: "#b8860b", splashdown: "#b8860b", impact: "#c62828",
        apsis: "#1d4ed8", obs: "#0e7e74", note: null,
      },
    },
    cinematic: {
      bg: "#070a12", starRGB: "200,215,235", starAlpha: 1,
      grid: "rgba(120,130,160,0.10)",
      trajFuture: "rgba(154,163,181,0.5)",
      trajGlow: "rgba(255,106,61,0.22)", trajPast: "rgba(255,106,61,0.95)",
      apsisOrbit: "rgba(88,166,255,0.42)", apsisApo: "#58a6ff", apsisPeri: "#fbbf24",
      soiStroke: "rgba(210,168,255,0.35)", soiFill: "rgba(210,168,255,0.5)",
      labelPlanet: "rgba(233,236,242,0.85)", labelMoon: "rgba(154,163,181,0.75)",
      labelMinor: "rgba(154,163,181,0.6)",
      ship: "#ffffff", shipLanded: "#7dd3a0", shipGlowRGB: "255,106,61",
      shipLabel: "rgba(255,157,124,0.95)",
      scalebar: "rgba(154,163,181,0.8)", scalebarText: "rgba(154,163,181,0.9)",
      scalebarBottom: 185, scalebarRight: 30,
      orbitDarken: false,
      events: {
        burn: "#ff6a3d", burn_end: "#ff6a3d",
        soi_entry: "#c4a5ff", soi_exit: "#c4a5ff", flyby: "#c4a5ff",
        libration: "#c4a5ff", cr3bp: "#c4a5ff", stationkeep: "#45c4b0",
        launch: "#7dd3a0", landing: "#7dd3a0", liftoff: "#7dd3a0",
        entry: "#fbbf24", splashdown: "#fbbf24", impact: "#ff5555",
        apsis: "#58a6ff", obs: "#45c4b0", note: null,
      },
    },
  };

  /* Ground-track panel sub-palettes (per design language) */
  PALETTES.blueprint.gt = {
    bg: "#fbfaf6", grid: "rgba(28,29,32,0.13)", gridStrong: "rgba(28,29,32,0.32)",
    night: "rgba(43,58,86,0.15)",
    trackPast: "rgba(229,84,30,0.95)", trackFuture: "rgba(85,86,79,0.6)",
    foot: "rgba(29,78,216,0.8)", footFill: "rgba(29,78,216,0.08)",
    marker: "#1c1d20", text: "rgba(28,29,32,0.78)", texAlpha: 1,
  };
  PALETTES.cinematic.gt = {
    bg: "#0a0e18", grid: "rgba(150,160,190,0.16)", gridStrong: "rgba(150,160,190,0.38)",
    night: "rgba(1,3,9,0.55)",
    trackPast: "rgba(255,106,61,0.95)", trackFuture: "rgba(154,163,181,0.55)",
    foot: "rgba(88,166,255,0.85)", footFill: "rgba(88,166,255,0.10)",
    marker: "#ffffff", text: "rgba(205,213,230,0.85)", texAlpha: 0.9,
  };

  let current = null;
  let openPane = null;
  const mobileMedia = globalThis.matchMedia
    ? globalThis.matchMedia("(max-width: 720px)") : { matches: false };
  let mobileSnapshot = null;

  const $ = (id) => document.getElementById(id);

  function applyTheme(t, persist) {
    current = t;
    const app = $("app");
    if (app) app.setAttribute("data-theme", t);
    document.body.style.background = t === "blueprint" ? "#f5f4ef" : "#070a12";
    globalThis.MTPTheme = PALETTES[t];
    const btn = $("btnTheme");
    if (btn) btn.textContent = t === "blueprint" ? "Cinematic UI" : "Blueprint UI";
    const hs = $("hudSeg");
    if (hs) hs.style.color = t === "blueprint" ? "#1c1d20" : "";
    const pt = $("planTitle");
    if (pt) pt.textContent = t === "blueprint" ? "01 — MISSION PLAN" : "FLIGHT PLAN";
    const gt = $("gtTitle");
    if (gt) gt.textContent = t === "blueprint" ? "DETAIL C — GROUND TRACK" : "GROUND TRACK";
    syncTgls();
    // display options: dropdown collapsed by default in cinematic, open panel in blueprint
    const dop = $("dispOpts");
    if (dop) dop.classList.toggle("collapsed", t === "cinematic");
    const right = $("right");
    if (right) right.classList.toggle("open", t === "cinematic" && !!openPane);
    if (persist) { try { localStorage.setItem("mtp-theme", t); } catch (e) {} }
    // layout geometry differs between themes → re-fit the canvas
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  }

  function setPane(pane) {
    openPane = pane;
    if (pane && mobileMedia.matches) {
      const app = $("app");
      if (app) app.classList.add("left-collapsed");
    }
    const right = $("right");
    if (right) right.classList.toggle("open", !!pane);
    if (pane) {
      const tab = document.querySelector('.tabbtn[data-pane="' + pane + '"]');
      if (tab) tab.click();
    }
    document.querySelectorAll("#paneBtns button").forEach((x) =>
      x.classList.toggle("active", x.dataset.pane === openPane));
    syncTgls();
  }

  // Internal tab clicks must also update the cinematic bottom-pill state.
  function syncPane(pane) {
    openPane = pane || null;
    const right = $("right");
    if (right && current === "cinematic") right.classList.toggle("open", !!openPane);
    document.querySelectorAll("#paneBtns button").forEach((x) =>
      x.classList.toggle("active", x.dataset.pane === openPane));
    syncTgls();
  }

  function syncTgls() {
    const app = $("app");
    const leftTgl = $("leftTgl");
    const rightTgl = $("rightTgl");
    if (leftTgl) leftTgl.textContent = mobileMedia.matches
      ? (app.classList.contains("left-collapsed") ? "PLAN" : "CLOSE")
      : (app.classList.contains("left-collapsed") ? "»" : "«");
    if (rightTgl) {
      const closed = current === "cinematic"
        ? !openPane
        : app.classList.contains("right-collapsed");
      rightTgl.textContent = mobileMedia.matches
        ? (closed ? "DATA" : "CLOSE") : (closed ? "«" : "»");
    }
  }

  function updateDerived() {
    const txt = (id) => { const el = $(id); return el ? el.textContent : ""; };
    const dv = txt("hudDv");
    const planDv = $("planDv");
    if (planDv) planDv.textContent = dv && dv !== "—" ? "ΔV " + dv.toUpperCase() : "";

    const scrub = $("scrub"), epochEl = $("epochInp");
    const tEnd = scrub ? parseFloat(scrub.max) || 0 : 0;
    const epochMs = epochEl && epochEl.value ? Date.parse(epochEl.value) : NaN;
    let endDate = "—";
    if (isFinite(epochMs) && tEnd > 1) endDate = new Date(epochMs + tEnd * 1000).toISOString().slice(0, 10);
    const yr = tEnd / 31557600;
    const met = tEnd <= 1 ? "" : yr >= 0.15 ? yr.toFixed(1) + " YR" : (tEnd / 86400).toFixed(1) + " D";
    const ti = $("transportInfo");
    if (ti && !ti.dataset.hold) ti.textContent = tEnd > 1 ? "T-END " + endDate + " · MET " + met : "—";

    const segCount = $("segList") ? $("segList").children.length : 0;
    const name = $("missionName") ? $("missionName").value : "";
    const lastWord = (name.trim().split(/\s+/).pop() || "MTP").replace(/[^A-Za-z0-9-]/g, "").toUpperCase();
    if ($("tbDwg")) $("tbDwg").textContent = (lastWord || "MTP") + "-TRAJ-" + String(segCount).padStart(2, "0");
    const frameSel = $("frameSel");
    let frameLabel = "SUN ECLIPJ2000";
    if (frameSel && frameSel.selectedIndex >= 0 && frameSel.value !== "inertial") {
      frameLabel = frameSel.options[frameSel.selectedIndex].text
        .replace(/[↳\u00a0]/g, "").trim().replace(/-relative$/i, "").toUpperCase() + " REL";
    }
    if ($("tbFrame")) $("tbFrame").textContent = frameLabel;
    const date = txt("hudDate");
    if ($("tbEpoch")) $("tbEpoch").textContent = date && date !== "—" ? date.slice(0, 10) : "—";

    const cm = $("cineMeta");
    if (cm) {
      const start = isFinite(epochMs) ? new Date(epochMs).toISOString().slice(0, 10) : "—";
      const vehicle = txt("hudVehicle") || "Vehicle";
      cm.textContent = vehicle + " · " + start + " → " + endDate + " · " +
        segCount + " segments · Δv " +
        (dv && dv !== "—" ? dv : "—") + " · " + frameLabel;
    }
  }

  function setHudCollapsed(collapsed, persist) {
    const hud = $("hud");
    const toggle = $("hudToggle");
    if (!hud || !toggle) return;
    hud.classList.toggle("hud-collapsed", !!collapsed);
    toggle.textContent = collapsed ? "+" : "\u2212";
    toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    const action = collapsed ? "Expand telemetry" : "Collapse telemetry";
    toggle.setAttribute("aria-label", action);
    toggle.title = action;
    if (persist) {
      try { localStorage.setItem("mtp-hud-collapsed", collapsed ? "1" : "0"); } catch (e) {}
    }
  }

  function setCineHudDetails(expanded, persist) {
    const hud = $("hud");
    const toggle = $("cineHudDetails");
    if (!hud || !toggle) return;
    hud.classList.toggle("hud-details-expanded", !!expanded);
    toggle.textContent = expanded ? "DETAILS −" : "DETAILS +";
    toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    toggle.title = expanded ? "Hide apsis and engine details" :
      "Show apsis and engine details";
    if (persist) {
      try { localStorage.setItem("mtp-cine-hud-details", expanded ? "1" : "0"); } catch (e) {}
    }
  }

  function syncMobileMode() {
    const app = $("app");
    if (!app) return;
    if (mobileMedia.matches && !mobileSnapshot) {
      mobileSnapshot = {
        leftCollapsed: app.classList.contains("left-collapsed"),
        rightCollapsed: app.classList.contains("right-collapsed"),
        pane: openPane,
        hudCollapsed: !!($("hud") && $("hud").classList.contains("hud-collapsed")),
        displayCollapsed: !!($("dispOpts") && $("dispOpts").classList.contains("collapsed")),
      };
      app.classList.add("left-collapsed", "right-collapsed");
      setPane(null);
      if ($("dispOpts")) $("dispOpts").classList.add("collapsed");
      setHudCollapsed(true, false);
    } else if (!mobileMedia.matches && mobileSnapshot) {
      app.classList.toggle("left-collapsed", mobileSnapshot.leftCollapsed);
      app.classList.toggle("right-collapsed", mobileSnapshot.rightCollapsed);
      if ($("dispOpts")) $("dispOpts").classList.toggle("collapsed",
        mobileSnapshot.displayCollapsed);
      setHudCollapsed(mobileSnapshot.hudCollapsed, false);
      const restoredPane = mobileSnapshot.pane;
      mobileSnapshot = null;
      setPane(restoredPane);
    }
    syncTgls();
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  }

  /* ------------------------------- boot -------------------------------- */
  let saved = null;
  let savedHud = null;
  let savedCineHud = null;
  try { saved = localStorage.getItem("mtp-theme"); } catch (e) {}
  try { savedHud = localStorage.getItem("mtp-hud-collapsed"); } catch (e) {}
  try { savedCineHud = localStorage.getItem("mtp-cine-hud-details"); } catch (e) {}
  applyTheme(saved === "cinematic" || saved === "blueprint" ? saved : "blueprint", false);
  setHudCollapsed(savedHud === "1", false);
  setCineHudDetails(savedCineHud === "1", false);
  syncMobileMode();
  if (mobileMedia.addEventListener) mobileMedia.addEventListener("change", syncMobileMode);

  const btn = $("btnTheme");
  if (btn) btn.addEventListener("click", () =>
    applyTheme(current === "blueprint" ? "cinematic" : "blueprint", true));

  /* cinematic pane pills: open/close the right panel + activate the real tab */
  document.querySelectorAll("#paneBtns button").forEach((b) => {
    b.addEventListener("click", () =>
      setPane(openPane === b.dataset.pane ? null : b.dataset.pane));
  });

  /* sidebar collapse toggles */
  const app = $("app");
  const leftTgl = $("leftTgl");
  const rightTgl = $("rightTgl");
  const hudToggle = $("hudToggle");
  const cineHudDetails = $("cineHudDetails");
  if (leftTgl) leftTgl.addEventListener("click", () => {
    if (mobileMedia.matches && app.classList.contains("left-collapsed")) {
      app.classList.add("right-collapsed");
      setPane(null);
    }
    app.classList.toggle("left-collapsed");
    syncTgls();
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  });
  if (rightTgl) rightTgl.addEventListener("click", () => {
    if (current === "cinematic") {
      setPane(openPane ? null : (mobileMedia.matches ? "dataPane" : "scriptPane"));
    } else {
      const openingMobileTools = mobileMedia.matches &&
        app.classList.contains("right-collapsed");
      if (openingMobileTools)
        app.classList.add("left-collapsed");
      app.classList.toggle("right-collapsed");
      if (openingMobileTools) {
        const dataTab = document.querySelector('.tabbtn[data-pane="dataPane"]');
        if (dataTab) dataTab.click();
      }
      syncTgls();
      requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    }
  });
  if (hudToggle) hudToggle.addEventListener("click", () =>
    setHudCollapsed(!$("hud").classList.contains("hud-collapsed"), true));
  if (cineHudDetails) cineHudDetails.addEventListener("click", () =>
    setCineHudDetails(!$("hud").classList.contains("hud-details-expanded"), true));

  /* collapsible display options (blueprint) */
  const dispTgl = $("dispTgl");
  if (dispTgl) dispTgl.addEventListener("click", () =>
    $("dispOpts").classList.toggle("collapsed"));

  setInterval(updateDerived, 600);

  globalThis.MTPThemeCtl = { applyTheme, setPane, syncPane, get current() { return current; } };
})();
