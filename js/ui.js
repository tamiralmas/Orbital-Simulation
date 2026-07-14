/* =============================================================================
 * Mission Trajectory Planner — ui.js
 * Application shell: mission editing, animation, cinematic auto-camera,
 * HUD, exports, tabs.
 * ========================================================================== */
"use strict";

(function () {
  const C = globalThis.AstroConst;
  const A = globalThis.Astro;
  const ME = globalThis.MissionEngine;
  const MW = globalThis.MissionWindows;
  const MT = globalThis.MissionTargeting;
  const MA = globalThis.MissionAnalysis;
  const MM = globalThis.MissionMultiCraft;
  const MU = globalThis.MissionUncertainty;
  const { BODIES, DAY, AU } = C;
  const V = A.V;
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value === undefined || value === null ? "" : value)
    .replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;",
      '"': "&quot;", "'": "&#39;" })[ch]);

  /* ------------------------------ state -------------------------------- */
  const S = {
    mission: null,
    result: null,
    tNow: 0,
    playing: false,
    speed: 21600,
    camera: globalThis.MTPRender.createCamera(),
    frameBody: "inertial",
    options: { orbits: true, labels: true, soi: false, grid: false, events: true, apsides: true, flatLight: false,
               eventLabels: false, minor: true, textures: true, lagrange: false,
               shadowCones: false },
    cr3bpSystem: "earth-moon",
    virtualFocus: null,
    expanded: new Set(),
    expandedByVehicle: new Map(),
    activeVehicleId: "primary",
    pickOut: {},
    gifCancel: false,
    autoCam: true,          // cinematic auto-camera (on by default)
    autoCamHinted: false,
    exporting: false,       // GIF export in progress (suspends the live loop)
    speedMode: "auto",      // "auto" = Auto Time pacing, "manual" = speedSel value
    pov: false,             // onboard camera
    gtOpen: false,          // ground-track panel
  };
  const AN = {
    leg: null,
    series: null,
    rows: null,
    hoverIndex: null,
    eclipse: null,
    access: null,
    accessConfidence: null,
    comparison: null,
    comparisonSeries: null,
    comparisonClosest: null,
    conjunctions: null,
    crafts: [],
    fleetSeries: [],
    conjunctionEvents: [],
    nativeFormation: [],
    nativeConjunctionEvents: [],
    nativeFormationKey: "",
    userStations: [],
    uncertainty: null,
    uncertaintyRunId: 0,
    themeObserver: null,
  };

  /* ------------------------------ format ------------------------------- */
  const pad = (n, w = 2) => String(Math.floor(Math.abs(n))).padStart(w, "0");
  function fmtMet(t) {
    const sign = t < 0 ? "-" : "+";
    const at = Math.abs(t);
    const d = Math.floor(at / DAY);
    return `T${sign}${pad(d, 2)}:${pad((at % DAY) / 3600)}:${pad((at % 3600) / 60)}:${pad(at % 60)}`;
  }
  function fmtDist(km) {
    if (!isFinite(km)) return "—";
    if (Math.abs(km) >= 0.05 * AU) return (km / AU).toFixed(3) + " AU";
    if (Math.abs(km) >= 1e6) return (km / 1e6).toFixed(2) + "M km";
    return Math.round(km).toLocaleString("en-US") + " km";
  }

  /* --------------------------- mission mgmt ---------------------------- */
  function cleanSegment(seg) {
    const out = {};
    for (const k in seg) if (!k.startsWith("_")) out[k] = seg[k];
    return out;
  }

  function cleanVehicle(vehicle) {
    return {
      id: vehicle.id,
      name: vehicle.name || vehicle.id,
      color: vehicle.color,
      role: vehicle.role || "vehicle",
      spacecraft: Object.assign({}, vehicle.spacecraft || {}),
      segments: (vehicle.segments || []).map(cleanSegment),
    };
  }

  function missionVehicleDefinitions() {
    if (!S.mission) return [];
    const primary = {
      id: "primary",
      name: S.mission.spacecraft && S.mission.spacecraft.name || "Primary spacecraft",
      color: "#e95420",
      spacecraft: S.mission.spacecraft,
      segments: S.mission.segments,
      primary: true,
    };
    return [primary].concat((S.mission.vehicles || []).map((vehicle) =>
      Object.assign({ primary: false }, vehicle)));
  }

  function activeVehicleDefinition() {
    const definitions = missionVehicleDefinitions();
    return definitions.find((vehicle) => vehicle.id === S.activeVehicleId) || definitions[0] || null;
  }

  function activeSegments() {
    const vehicle = activeVehicleDefinition();
    return vehicle && Array.isArray(vehicle.segments) ? vehicle.segments : [];
  }

  function activeSpacecraft() {
    const vehicle = activeVehicleDefinition();
    return vehicle && vehicle.spacecraft || null;
  }

  function activeVehicleResult() {
    if (!S.result) return null;
    return S.result.vehicleResults && S.result.vehicleResults[S.activeVehicleId] || S.result;
  }

  function resultTimeBounds(result) {
    const samples = result && Array.isArray(result.samples) ? result.samples : [];
    return samples.length
      ? { start: samples[0].t, end: samples[samples.length - 1].t }
      : { start: 0, end: 0 };
  }

  function syncActivePlaybackBounds(keepTime) {
    const bounds = resultTimeBounds(activeVehicleResult());
    S.tNow = keepTime
      ? Math.min(bounds.end, Math.max(bounds.start, S.tNow))
      : bounds.start;
    const scrub = $("scrub");
    if (scrub) {
      scrub.min = bounds.start;
      scrub.max = Math.max(bounds.end, bounds.start || 1);
      scrub.value = S.tNow;
    }
    return bounds;
  }

  function refreshActivePlaybackEvents() {
    const result = activeVehicleResult();
    const events = result && result.events || [];
    const paced = events.filter((event) => isAutoEvent(event, AUTOPACE_EVENTS));
    S.evT = paced.map((event) => event.t);
    S.evW = paced.map((event) => event._burn && event._burn.handoff ? 180 : 70);
    S.camEvT = events.filter((event) =>
      isAutoEvent(event, AUTOCAM_SHOT_EVENTS)).map((event) => event.t);
  }

  function refreshActiveGroundTrackLegs() {
    S.gtLegs = [];
    let localRun = null;
    const result = activeVehicleResult();
    for (const sample of result && result.samples || []) {
      if (sample.cen === "sun") { localRun = null; continue; }
      if (!localRun || localRun.cen !== sample.cen) {
        localRun = { t: sample.t, cen: sample.cen };
        S.gtLegs.push(localRun);
      } else localRun.t = sample.t;
    }
  }

  function vehicleOptionsHtml(selected, excludeCurrent) {
    return missionVehicleDefinitions().filter((vehicle) =>
      !excludeCurrent || vehicle.id !== S.activeVehicleId).map((vehicle) =>
      `<option value="${esc(vehicle.id)}" ${vehicle.id === selected ? "selected" : ""}>` +
      `${esc(vehicle.name || vehicle.id)}${vehicle.id === "primary" ? " (primary)" : ""}</option>`).join("");
  }

  function recompute(keepTime) {
    if (WIN && WIN.signal && WIN.signal.kind === "target")
      WIN.signal.aborted = true;
    try {
      S.result = ME.recompute(S.mission);
    } catch (e) {
      console.error(e);
      banner("Engine error: " + e.message, true);
      return;
    }
    globalThis.MTPRender.invalidateCache();
    refreshActivePlaybackEvents();
    S.ascentDv = activeSegments().reduce((a2, sg) =>
      a2 + ((sg._info && isFinite(sg._info.ascentDv)) ? sg._info.ascentDv : 0), 0);
    refreshActiveGroundTrackLegs();
    syncActivePlaybackBounds(keepTime);
    if (!keepTime) { resetPace(); resetAutoCamera(true); }
    buildVehicleSelector();
    buildSegmentList();
    buildTicks();
    updateTotals();
    updatePropellant();
    updateScript();
    updateBanner();
    updateHud();
    syncWindowApplySegments();
    analysisAfterRecompute();
  }

  function defaultSpacecraft() {
    return { name: "Spacecraft", notes: "", dryKg: 1000, propKg: "", isp: 320, fovDeg: 50 };
  }

  function loadMission(m, viewHint) {
    const resumePlayback = !!S.playing;
    S.playing = false;
    updatePlayBtn();
    setPov(false);
    clearVirtualFocus();
    cancelTopView();
    // A synodic frame, virtual L-point focus, or POV inherited from the
    // previous mission can make an unrelated replacement scene appear fixed
    // or empty. Reset those transient view contracts before recomputing; a
    // new libration mission opts back into its own frame below.
    S.frameBody = "inertial";
    S.cr3bpSystem = "earth-moon";
    S.options.lagrange = false;
    S.mission = m;
    const allVehicles = [{ segments: m.segments || [], spacecraft: m.spacecraft }]
      .concat(Array.isArray(m.vehicles) ? m.vehicles : []);
    for (const vehicle of allVehicles) for (const segment of vehicle.segments || []) {
      // v1.17 corrected the old absolute-inertial "central-only" model to a
      // translating central-relative frame; preserve saved missions while
      // presenting the physically accurate name in the editor.
      if (segment.type === "finite_burn" && segment.gravity === "central-only")
        segment.gravity = "central-relative";
    }
    m.spacecraft = Object.assign(defaultSpacecraft(), m.spacecraft || {});
    m.vehicles = (Array.isArray(m.vehicles) ? m.vehicles : []).slice(0, 7).map((vehicle, index) => ({
      id: String(vehicle.id || `vehicle${index + 1}`),
      name: vehicle.name || vehicle.spacecraft && vehicle.spacecraft.name || `Vehicle ${index + 1}`,
      color: vehicle.color || ["#52d4c5", "#a371f7", "#e3b341", "#58a6ff"][index % 4],
      role: vehicle.role || "vehicle",
      spacecraft: Object.assign(defaultSpacecraft(), vehicle.spacecraft || {}),
      segments: Array.isArray(vehicle.segments) ? vehicle.segments : [],
    }));
    S.activeVehicleId = "primary";
    $("missionName").value = m.name || "Untitled mission";
    $("epochInp").value = m.epoch;
    S.expanded = new Set();
    S.expandedByVehicle = new Map([["primary", S.expanded]]);
    buildVehicleSelector();
    buildSpacecraftCard();
    recompute(false);
    configureWindowForMission();
    updateMissionMeta();
    applyMissionOperations(m);
    loadUncertaintyMissionDefaults();
    const libration = m.segments.find((seg) => seg.type === "libration");
    if (libration && globalThis.CR3BP) {
      S.cr3bpSystem = libration.system || "earth-moon";
      S.frameBody = "synodic:" + S.cr3bpSystem;
      S.options.lagrange = true;
      const frameSelect = $("frameSel");
      if (frameSelect) frameSelect.value = S.frameBody;
      const systemSelect = $("cr3bpSystemSel");
      if (systemSelect) systemSelect.value = S.cr3bpSystem;
      const toggle = $("optLagrange");
      if (toggle) toggle.checked = true;
      globalThis.MTPRender.invalidateCache();
    } else {
      const initial = currentSample();
      S.frameBody = initial && initial.cen !== "sun" ? initial.cen : "inertial";
      const frameSelect = $("frameSel");
      if (frameSelect) frameSelect.value = S.frameBody;
      const toggle = $("optLagrange");
      if (toggle) toggle.checked = false;
    }
    // choose an initial view
    if (!S.autoCam) {
      if (viewHint === "solar" || m.segments.some((s) => s.type === "depart")) viewSolar();
      else viewMission();
    } else {
      const initial = currentSample();
      if (initial) {
        S.camera.focusMode = "ship";
        S.camera.pan = [0, 0, 0];
      }
      globalThis.MTPRender.invalidateCache();
    }
    if (resumePlayback) {
      const bounds = resultTimeBounds(activeVehicleResult());
      if (bounds.end > bounds.start) {
        S.playing = true;
        updatePlayBtn();
      }
    }
  }

  function loadPreset(id) {
    const m = globalThis.Missions.getPreset(id);
    if (m) loadMission(m);
  }

  function newMission() {
    const epoch = new Date().toISOString().slice(0, 19) + "Z";
    const insertion = ME.defaultSegment("insertion");
    insertion.at = "apoapsis"; insertion.shape = "circular"; insertion.maxDays = 0.5;
    loadMission({
      name: "New mission", epoch,
      description: "A blank mission plan. Start with the Launch segment, then add transfers.",
      history: [],
      segments: [ME.defaultSegment("launch"), insertion,
                 ME.defaultSegment("coast")],
    }, "mission");
  }

  /* --------------------------- spacecraft card -------------------------- */
  function buildVehicleSelector() {
    const host = $("vehicleBar"), select = $("vehicleSel");
    if (!host || !select || !S.mission) return;
    const definitions = missionVehicleDefinitions();
    if (!definitions.some((vehicle) => vehicle.id === S.activeVehicleId))
      S.activeVehicleId = "primary";
    select.innerHTML = definitions.map((vehicle) =>
      `<option value="${esc(vehicle.id)}">${esc(vehicle.name || vehicle.id)}` +
      `${vehicle.id === "primary" ? " - primary" : ""}</option>`).join("");
    select.value = S.activeVehicleId;
    host.classList.toggle("single", definitions.length === 1);
    const color = $("vehicleColor");
    const active = activeVehicleDefinition();
    const planTitle = $("planTitle");
    if (planTitle && active)
      planTitle.textContent = `01 - MISSION PLAN / ${(active.name || active.id).toUpperCase()}`;
    if (color) {
      color.value = active && /^#[0-9a-f]{6}$/i.test(active.color || "")
        ? active.color : "#52d4c5";
      color.disabled = !active || active.primary;
      color.onchange = () => {
        const vehicle = activeVehicleDefinition();
        if (!vehicle || vehicle.primary) return;
        vehicle.color = color.value;
        const result = activeVehicleResult();
        if (result) result.color = color.value;
        globalThis.MTPRender.invalidateCache();
      };
    }
    const remove = $("btnVehicleRemove");
    if (remove) remove.disabled = S.activeVehicleId === "primary";
    const count = $("vehicleCount");
    if (count) count.textContent = `${definitions.length}/8`;

    select.onchange = () => {
      S.expandedByVehicle.set(S.activeVehicleId, S.expanded);
      S.activeVehicleId = select.value || "primary";
      S.expanded = S.expandedByVehicle.get(S.activeVehicleId) || new Set();
      S.expandedByVehicle.set(S.activeVehicleId, S.expanded);
      S.ascentDv = activeSegments().reduce((sum, segment) => sum +
        (segment._info && isFinite(segment._info.ascentDv) ? segment._info.ascentDv : 0), 0);
      syncActivePlaybackBounds(true);
      refreshActivePlaybackEvents();
      refreshActiveGroundTrackLegs();
      resetPace();
      resetAutoCamera(true);
      buildVehicleSelector();
      buildSpacecraftCard();
      buildSegmentList();
      updatePropellant();
      updateTotals();
      updateHud();
      analysisAfterRecompute();
      if ($("dataPane") && $("dataPane").classList.contains("active"))
        refreshNativeFormationAnalysis(false);
      else updateFormationReadout(currentSample());
      buildTicks();
      globalThis.MTPRender.invalidateCache();
      gtLastDraw = 0;
    };

    const add = $("btnVehicleAdd");
    if (add) {
      add.disabled = definitions.length >= 8;
      add.onclick = () => {
        if (definitions.length >= 8) return;
        const used = new Set(definitions.map((vehicle) => vehicle.id));
        let number = 2, id = "vehicle2";
        while (used.has(id)) id = `vehicle${++number}`;
        const separation = ME.defaultSegment("separate");
        separation.fromVehicle = "primary";
        separation.afterSegment = 1;
        const vehicle = {
          id,
          name: `Vehicle ${number}`,
          color: ["#52d4c5", "#a371f7", "#e3b341", "#58a6ff"][
            (S.mission.vehicles || []).length % 4],
          spacecraft: defaultSpacecraft(),
          segments: [separation],
        };
        S.mission.vehicles.push(vehicle);
        S.expandedByVehicle.set(S.activeVehicleId, S.expanded);
        S.activeVehicleId = id;
        S.expanded = new Set([0]);
        S.expandedByVehicle.set(id, S.expanded);
        buildVehicleSelector();
        buildSpacecraftCard();
        recompute(true);
      };
    }
    if (remove) remove.onclick = () => {
      const id = S.activeVehicleId;
      if (id === "primary") return;
      const referenced = missionVehicleDefinitions().some((vehicle) =>
        (vehicle.segments || []).some((segment) =>
          segment.fromVehicle === id || segment.targetVehicle === id));
      if (referenced) {
        banner("This vehicle is referenced by a separation, rendezvous, or docking segment.", true);
        return;
      }
      const vehicle = activeVehicleDefinition();
      if (!vehicle || !window.confirm(`Remove ${vehicle.name || id} and its mission plan?`)) return;
      S.mission.vehicles = S.mission.vehicles.filter((entry) => entry.id !== id);
      S.expandedByVehicle.delete(id);
      S.activeVehicleId = "primary";
      S.expanded = S.expandedByVehicle.get("primary") || new Set();
      buildVehicleSelector();
      buildSpacecraftCard();
      recompute(true);
    };
  }

  const SC_FIELDS = [
    { k: "name", label: "Name", t: "text" },
    { k: "dryKg", label: "Dry mass (kg)", t: "num" },
    { k: "propKg", label: "Propellant (kg, blank = no tracking)", t: "num", optional: true },
    { k: "isp", label: "Engine Isp (s)", t: "num" },
    { k: "fovDeg", label: "POV camera FOV (°)", t: "num" },
    { k: "notes", label: "Notes", t: "textarea" },
  ];
  function buildSpacecraftCard() {
    const panel = $("scPanel");
    if (!panel || !S.mission) return;
    const sc = activeSpacecraft();
    if (!sc) return;
    if ($("gtFov") && +sc.fovDeg > 0) $("gtFov").value = sc.fovDeg;
    const grid = panel.querySelector(".fgrid");
    grid.innerHTML = "";
    for (const fld of SC_FIELDS) {
      const lab = document.createElement("label");
      lab.textContent = fld.label;
      let inp;
      if (fld.t === "textarea") {
        inp = document.createElement("textarea");
        inp.rows = 2;
        inp.value = sc[fld.k] || "";
      } else {
        inp = document.createElement("input");
        inp.type = fld.t === "num" ? "number" : "text";
        if (fld.t === "num") inp.step = "any";
        inp.value = sc[fld.k] === "" || sc[fld.k] === undefined ? "" : sc[fld.k];
        if (fld.optional) inp.placeholder = "(off)";
      }
      inp.id = "scField_" + fld.k;
      lab.htmlFor = inp.id;
      inp.addEventListener("change", () => {
        let v = inp.value;
        if (inp.type === "number") v = v === "" ? "" : +v;
        sc[fld.k] = v;
        if (fld.k === "name") {
          const active = activeVehicleDefinition();
          if (active && !active.primary) active.name = v || active.id;
          const result = activeVehicleResult();
          if (result) result.name = v || active && active.id || "Spacecraft";
          buildVehicleSelector();
        }
        if (fld.k === "fovDeg" && $("gtFov") && +v > 0) {
          $("gtFov").value = v;
          gtLastDraw = 0;
        }
        updateSpacecraftHead();
        updatePropellant();
        if (["dryKg", "propKg", "isp"].includes(fld.k)) scheduleRecompute();
        else updateScript();
      });
      grid.appendChild(lab);
      grid.appendChild(inp);
      if (fld.t === "textarea") { lab.style.gridColumn = "1 / -1"; inp.style.gridColumn = "1 / -1"; }
    }
    updateSpacecraftHead();
  }
  function updateSpacecraftHead() {
    const nmEl = $("scName");
    const spacecraft = activeSpacecraft();
    if (nmEl && spacecraft)
      nmEl.textContent = (spacecraft.name || "Spacecraft").toUpperCase();
  }
  /** rocket-equation propellant budget over the mission's burns */
  function updatePropellant() {
    const el = $("scBudget");
    S.prop = null;
    const sc = activeSpacecraft();
    if (!sc || !el) return;
    const dry = +sc.dryKg, prop = +sc.propKg, isp = +sc.isp;
    if (!(dry > 0) || !(prop > 0) || !(isp > 0)) {
      el.textContent = "";
      el.classList.remove("bad-txt");
      return;
    }
    const ve = isp * 0.00980665;                     // exhaust velocity, km/s
    let m = dry + prop, depletedAt = null;
    const vehicleResult = activeVehicleResult();
    if (vehicleResult) for (const ev of vehicleResult.events) {
      // Finite-burn end markers repeat the characteristic dv for reporting;
      // the start event has already charged that maneuver to the budget.
      if (ev.kind === "burn_end") continue;
      if (!isFinite(ev.dv) || ev.dv <= 0) continue;
      m = m / Math.exp(ev.dv / ve);
      if (m < dry && depletedAt === null) depletedAt = ev.t;
    }
    const remaining = Math.max(m - dry, 0);
    const capDv = ve * Math.log((dry + prop) / dry);
    S.prop = { remaining, capDv, depletedAt };
    if (depletedAt !== null) {
      el.textContent = "OUT OF PROPELLANT " + fmtMet(depletedAt) +
        " (capacity " + capDv.toFixed(2) + " km/s)";
      el.classList.add("bad-txt");
    } else {
      el.textContent = Math.round(100 * remaining / prop) + "% PROP · CAP " +
        capDv.toFixed(2) + " KM/S";
      el.classList.remove("bad-txt");
    }
  }

  /* --------------------------- banner/status --------------------------- */
  let bannerTimer = null;
  function banner(msg, isError) {
    const b = $("banner");
    clearTimeout(bannerTimer);
    bannerTimer = null;
    b.textContent = msg;
    b.className = isError ? "show error" : "show";
    if (!isError) bannerTimer = setTimeout(() => {
      bannerTimer = null;
      updateBanner();
    }, 4000);
  }
  function updateBanner() {
    const b = $("banner");
    clearTimeout(bannerTimer);
    bannerTimer = null;
    if (S.result && S.result.vehicleWarnings && S.result.vehicleWarnings.length) {
      b.textContent = "VEHICLE PLAN ERROR - " + S.result.vehicleWarnings.join(" ");
      b.className = "show error";
    } else if (S.result && S.result.crashed) {
      b.textContent = "UNPLANNED IMPACT — the trajectory hits a surface; later segments are unreachable. " +
        "Check the flagged segment.";
      b.className = "show error";
    } else b.className = "";
  }

  /* --------------------------- segment editor -------------------------- */
  function bodySelectHtml(value, allowNone) {
    const opt = (b, indent) =>
      `<option value="${esc(b.id)}" ${value === b.id ? "selected" : ""}>` +
      `${indent ? "&nbsp;&nbsp;↳ " : ""}${esc(b.name)}</option>`;
    let html = "";
    if (allowNone) html += `<option value="" ${!value ? "selected" : ""}>— none —</option>`;
    html += opt(BODIES.sun, false);
    const groups = [
      ["Planets & moons", (b) => b.type === "planet"],
      ["Dwarf planets", (b) => b.type === "dwarf"],
      ["Asteroids", (b) => b.type === "asteroid"],
      ["Custom", (b) => b.type === "custom" || b.type === "comet"],
    ];
    for (const [label, pred] of groups) {
      const tops = Object.values(BODIES).filter((b) => b.parent === "sun" && pred(b));
      if (!tops.length) continue;
      html += `<optgroup label="${esc(label)}">`;
      for (const p of tops) {
        html += opt(p, false);
        for (const m of C.childrenOf(p.id)) html += opt(m, true);
      }
      html += `</optgroup>`;
    }
    return html;
  }

  function siteSelectHtml(value) {
    return C.LAUNCH_SITES.map((s) =>
      `<option value="${s.id}" ${value === s.id ? "selected" : ""}>${s.name}` +
      `${s.latDeg !== null ? ` (${s.latDeg.toFixed(1)}°)` : ""}</option>`).join("");
  }

  function segSummary(seg) {
    const nm = (id) => (BODIES[id] ? BODIES[id].name : id);
    switch (seg.type) {
      case "launch": return `${nm(seg.body)} · ${seg.altKm} km · ${seg.incDeg}°` +
        (seg.ascent === "meco" ? " · MECO" : "");
      case "coast": return `${seg.days} d · ${seg.mode}`;
      case "finite_burn": return `${seg.thrustN} N · ${seg.durationMin} min · ${seg.direction}`;
      case "coast_to": return `${seg.event} · ≤${seg.maxDays} d`;
      case "impulse": return `${seg.frame} [${seg.dv1}, ${seg.dv2}, ${seg.dv3}] km/s`;
      case "hohmann": return `→ r=${fmtDist(+seg.rTargetKm)}`;
      case "transfer": return `→ ${nm(seg.target)} · TOF ${seg.tofDays} d` +
        (seg.targetMode === "arrival-periapsis" ? ` · target ${seg.targetValue} km` : "");
      case "depart": return `→ ${nm(seg.target)} · TOF ${seg.tofDays} d`;
      case "insertion": return (seg.at === "apoapsis" ? "@apo · " : "") +
        (seg.shape === "circular" ? "circularize" : `ellipse, other apsis ${seg.apoKm} km`);
      case "flyby": return +seg.dvKms ? `powered · ${seg.dvKms} km/s` : "unpowered swing-by";
      case "observe": return `→ ${nm(seg.target)} · ${seg.days} d`;
      case "return": return `→ ${nm(seg.target)} · peri ${seg.periKm} km`;
      case "libration": return `${seg.system} ${seg.point} · ${seg.family}`;
      case "cr3bp_coast": return `${seg.cycles} reference cycles`;
      case "stationkeep": return `${seg.cycles} cycles · ${seg.corrections} checks/cycle`;
      case "land": return `stay ${seg.stayDays} d`;
      case "ascend": return `to ${seg.altKm} km`;
      case "reentry": return `interface ${seg.interfaceKm} km`;
      case "separate": return `from ${seg.fromVehicle} / after #${seg.afterSegment} / ` +
        `${(1000 * Math.hypot(+seg.dv1 || 0, +seg.dv2 || 0, +seg.dv3 || 0)).toFixed(1)} m/s`;
      case "rendezvous": return `to ${seg.targetVehicle} / TOF ${seg.tofHours} h / ` +
        `terminal <=${seg.terminalRangeKm} km`;
      case "dock": return `with ${seg.targetVehicle} / capture <=${seg.captureRangeKm} km / ` +
        `${seg.captureRateMps} m/s`;
      case "undock": return `from joined target / ` +
        `${(1000 * Math.hypot(+seg.dv1 || 0, +seg.dv2 || 0, +seg.dv3 || 0)).toFixed(1)} m/s`;
      default: return "";
    }
  }

  function segInfoLine(seg) {
    const i = seg._info || {};
    const parts = [];
    if (isFinite(i.dv)) parts.push(`Δv ${i.dv.toFixed(3)} km/s`);
    if (isFinite(i.c3)) parts.push(`C3 ${i.c3.toFixed(2)} km²/s²`);
    if (isFinite(i.vInf)) parts.push(`v∞ ${i.vInf.toFixed(2)} km/s`);
    if (isFinite(i.vEsc)) parts.push(`v_esc ${i.vEsc.toFixed(2)} km/s`);
    if (isFinite(i.vInfIn)) parts.push(`v∞ ${i.vInfIn.toFixed(2)}→${i.vInfOut.toFixed(2)} km/s`);
    if (isFinite(i.turnDeg)) parts.push(`bent ${i.turnDeg.toFixed(1)}°`);
    if (isFinite(i.speedGain))
      parts.push(`${i.speedGain >= 0 ? "+" : ""}${i.speedGain.toFixed(2)} km/s parent-frame`);
    if (isFinite(i.assistDv)) parts.push(`free Δv ${i.assistDv.toFixed(2)} km/s`);
    if (i.system && i.point && i.family) parts.push(`${i.system} ${i.point} ${i.family}`);
    if (isFinite(i.periodDays)) parts.push(`period ${i.periodDays.toFixed(2)} d`);
    if (isFinite(i.jacobiDrift)) parts.push(`Jacobi drift ${i.jacobiDrift.toExponential(2)}`);
    if (isFinite(i.burns)) parts.push(`${i.burns} stationkeeping corrections`);
    if (i.targetStatus) parts.push(`Target ${i.targetStatus}` +
      (isFinite(i.targetIterations) ? ` in ${i.targetIterations} iterations` : "") +
      (isFinite(i.targetAchieved) ? ` · achieved ${i.targetAchieved.toFixed(3)}` : "") +
      (isFinite(i.targetResidual) ? ` · residual ${i.targetResidual.toFixed(3)}` : ""));
    if (isFinite(i.propellantUsedKg)) parts.push(`${i.propellantUsedKg.toFixed(2)} kg propellant`);
    if (isFinite(i.apoStart) && isFinite(i.apoEnd))
      parts.push(`AP ${ME.fmtKm(i.apoStart)} → ${ME.fmtKm(i.apoEnd)}`);
    if (i.model) parts.push(i.model);
    if (i.environmentModels) parts.push(i.environmentModels);
    if (i.ephemeris) parts.push(i.ephemeris);
    if (isFinite(i.periodMinutes)) parts.push(`${i.periodMinutes.toFixed(2)} min period`);
    if (isFinite(i.raanRateDegDay))
      parts.push(`RAAN drift ${i.raanRateDegDay.toFixed(4)}°/day`);
    if (isFinite(i.rpAlt)) parts.push(`flyby periapsis ${ME.fmtKm(i.rpAlt)}`);
    if (i.meco) parts.push(i.meco);
    if (isFinite(i.rotCredit) && Math.abs(i.rotCredit) > 0.001)
      parts.push(`rotation credit ${(i.rotCredit * 1000).toFixed(0)} m/s`);
    if (isFinite(i.waitS) && i.waitS > 1) parts.push(`ignition wait ${(i.waitS / 3600).toFixed(2)} h`);
    if (isFinite(i.ascentDv)) parts.push(`ascent Δv ≈ ${i.ascentDv.toFixed(1)} km/s (bookkept)`);
    if (isFinite(i.raanAuto)) parts.push(`RAAN auto ${i.raanAuto.toFixed(1)}°`);
    if (seg._t1 > seg._t0) parts.push(`${fmtMet(seg._t0)} → ${fmtMet(seg._t1)}`);
    return parts.join(" · ");
  }

  function segmentFieldVisible(seg, key) {
    if (seg.type === "coast") {
      const adaptive = seg.mode === "adaptive-environment";
      if (key === "ephemeris")
        return adaptive || seg.mode === "adaptive-nbody";
      if (["drag", "srp", "harmonics"].includes(key)) return adaptive;
      if (["massKg", "areaM2"].includes(key))
        return adaptive && (seg.drag === "on" || seg.srp === "on");
      if (["cd", "densityScale"].includes(key)) return adaptive && seg.drag === "on";
      if (key === "cr") return adaptive && seg.srp === "on";
    }
    if (seg.type === "transfer") {
      if (key === "targetValue") return String(seg.targetMode || "off") !== "off";
      if (key === "periKm") return String(seg.targetMode || "off") === "off";
    }
    if (seg.type === "insertion") {
      if (key === "targetValue") return String(seg.targetMode || "off") !== "off";
      if (key === "shape" || key === "apoKm") return String(seg.targetMode || "off") === "off";
    }
    if (seg.type === "finite_burn" && ["dirX", "dirY", "dirZ"].includes(key))
      return seg.direction === "inertial";
    if (seg.type === "libration" && key === "hemisphere") return seg.family === "halo";
    return true;
  }

  const OPTION_LABELS = {
    "j2-secular": "J2 secular (Earth)",
    "adaptive-nbody": "Adaptive n-body",
    "adaptive-environment": "Adaptive environment",
    "planner-horizons": "Offline Horizons (bounded)",
    "central-relative": "Central-relative",
    "arrival-periapsis": "Arrival periapsis",
    "opposite-apsis": "Opposite apsis",
    "planar-lyapunov": "Planar Lyapunov",
    "earth-moon": "Earth-Moon",
    "sun-earth": "Sun-Earth",
    catalog: "Catalog ephemeris",
    strict: "Strict checksum",
    relaxed: "Relaxed checksum",
    off: "Off",
    on: "On",
    j2: "J2",
    j3: "J2 + J3",
    j4: "J2 + J3 + J4",
  };

  function buildSegmentList() {
    const list = $("segList");
    if (!list) return;
    list.innerHTML = "";
    const segments = activeSegments();
    segments.forEach((seg, i) => {
      const spec = ME.SEGMENT_TYPES[seg.type] || { label: seg.type, short: seg.type, color: "#888", fields: [], doc: "" };
      const card = document.createElement("div");
      card.className = "seg" + (S.expanded.has(i) ? " open" : "");
      const errs = (seg._warn || []).filter((w) => w.level === "error").length;
      const warns = (seg._warn || []).length - errs;
      card.innerHTML = `
        <div class="seg-head" style="border-left-color:${esc(spec.color)}">
          <span class="seg-idx">${i + 1}</span>
          <span class="seg-short" style="color:${esc(spec.color)}">${esc(spec.short)}</span>
          <span class="seg-sum">${esc(segSummary(seg))}</span>
          ${errs ? `<span class="badge err">${errs} ERR</span>` : ""}
          ${warns ? `<span class="badge warn">${warns} WARN</span>` : ""}
          <span class="seg-btns">
            <button data-act="up" title="Move up">▲</button>
            <button data-act="down" title="Move down">▼</button>
            <button data-act="dup" title="Duplicate">⧉</button>
            <button data-act="del" title="Remove">✕</button>
          </span>
        </div>
        <div class="seg-body"></div>`;
      const body = card.querySelector(".seg-body");

      /* fields */
      const grid = document.createElement("div");
      grid.className = "fgrid";
      for (const fld of spec.fields) {
        const lab = document.createElement("label");
        lab.textContent = fld.label;
        let inp;
        if (fld.t === "sel") {
          inp = document.createElement("select");
          inp.innerHTML = fld.opts.map((o) =>
            `<option value="${esc(o)}" ${seg[fld.k] === o ? "selected" : ""}>` +
            `${esc(OPTION_LABELS[o] || o)}</option>`).join("");
        } else if (fld.t === "body" || fld.t === "bodyOpt") {
          inp = document.createElement("select");
          inp.innerHTML = bodySelectHtml(seg[fld.k], fld.t === "bodyOpt");
        } else if (fld.t === "vehicle" || fld.t === "vehicleOpt") {
          inp = document.createElement("select");
          inp.innerHTML = (fld.t === "vehicleOpt" ? `<option value="">-- none --</option>` : "") +
            vehicleOptionsHtml(seg[fld.k], true);
        } else if (fld.t === "site") {
          inp = document.createElement("select");
          inp.innerHTML = siteSelectHtml(seg[fld.k] || "");
        } else if (fld.t === "text") {
          inp = document.createElement("input");
          inp.type = "text";
          inp.value = seg[fld.k] === undefined ? "" : seg[fld.k];
          inp.spellcheck = false;
          lab.classList.add("segment-long-field");
          inp.classList.add("segment-long-field");
        } else {
          inp = document.createElement("input");
          inp.type = "number";
          inp.step = "any";
          if (fld.min !== undefined) inp.min = fld.min;
          if (fld.max !== undefined) inp.max = fld.max;
          inp.value = seg[fld.k] === "" || seg[fld.k] === undefined ? "" : seg[fld.k];
          if (fld.optional) inp.placeholder = "(blank = center)";
        }
        inp.id = `segField_${i}_${fld.k}`;
        lab.htmlFor = inp.id;
        const visible = segmentFieldVisible(seg, fld.k);
        lab.hidden = !visible;
        inp.hidden = !visible;
        inp.addEventListener("change", () => {
          let v = inp.value;
          if (inp.type === "number") v = v === "" ? "" : +v;
          seg[fld.k] = v;
          scheduleRecompute();
          if (["targetMode", "direction", "family", "mode", "drag", "srp"]
            .includes(fld.k)) buildSegmentList();
        });
        grid.appendChild(lab);
        grid.appendChild(inp);
      }
      body.appendChild(grid);

      const info = segInfoLine(seg);
      if (info) {
        const d = document.createElement("div");
        d.className = "seg-info";
        d.textContent = info;
        body.appendChild(d);
      }
      for (const wn of seg._warn || []) {
        const d = document.createElement("div");
        d.className = "seg-warnline " + wn.level;
        d.textContent = (wn.level === "error" ? "✕ " : "▲ ") + wn.msg;
        body.appendChild(d);
      }
      const doc = document.createElement("div");
      doc.className = "seg-doc";
      doc.textContent = spec.doc;
      body.appendChild(doc);

      /* interactions */
      const head = card.querySelector(".seg-head");
      head.tabIndex = 0;
      head.setAttribute("role", "button");
      head.setAttribute("aria-expanded", String(card.classList.contains("open")));
      const toggleCard = () => {
        if (S.expanded.has(i)) S.expanded.delete(i); else S.expanded.add(i);
        card.classList.toggle("open");
        head.setAttribute("aria-expanded", String(card.classList.contains("open")));
      };
      head.addEventListener("click", (e) => {
        if (e.target.tagName === "BUTTON") return;
        toggleCard();
      });
      head.addEventListener("keydown", (e) => {
        if (e.target !== head || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        toggleCard();
      });
      card.querySelectorAll(".seg-btns button").forEach((btn) => {
        btn.setAttribute("aria-label", btn.title);
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const act = btn.dataset.act;
          const segs = activeSegments();
          if (act === "del") { segs.splice(i, 1); S.expanded.delete(i); }
          if (act === "dup") segs.splice(i + 1, 0, JSON.parse(JSON.stringify(cleanSegment(seg))));
          if (act === "up" && i > 0) [segs[i - 1], segs[i]] = [segs[i], segs[i - 1]];
          if (act === "down" && i < segs.length - 1) [segs[i + 1], segs[i]] = [segs[i], segs[i + 1]];
          recompute(true);
        });
      });
      list.appendChild(card);
    });
  }

  let recomputeTimer = null;
  function scheduleRecompute() {
    clearTimeout(recomputeTimer);
    recomputeTimer = setTimeout(() => recompute(true), 260);
  }

  function updateTotals() {
    const r = S.result;
    const vehicleResult = activeVehicleResult();
    const sampleCount = r.vehicleResults
      ? Object.values(r.vehicleResults).reduce((sum, result) => sum + result.samples.length, 0)
      : r.samples.length;
    $("totals").innerHTML =
      `<b>${(r.tEnd / DAY).toFixed(2)} d</b> mission · ` +
      `<b>${(vehicleResult ? vehicleResult.totalDv : 0).toFixed(2)} km/s</b> selected vehicle Δv` +
      (r.vehicleOrder && r.vehicleOrder.length > 1
        ? ` · <b>${r.totalDv.toFixed(2)} km/s</b> sum across vehicles` : "") + ` · ` +
      (S.ascentDv > 0.05 ? `launch ascent ≈ <b>${S.ascentDv.toFixed(1)} km/s</b> (bookkept, not in total) · ` : ``) +
      `${sampleCount.toLocaleString()} samples · ${r.computeMs.toFixed(0)} ms` +
      (r.ended ? ` · <span class="ok-txt">nominal end</span>` : "") +
      (r.crashed ? ` · <span class="bad-txt">IMPACT</span>` : "");
  }

  function updateMissionMeta() {
    const m = S.mission;
    let html = "";
    if (m.description) html += `<p>${esc(m.description)}</p>`;
    if (m.history && m.history.length) {
      html += `<details><summary>Historical timeline (approx.)</summary><ul>` +
        m.history.map((h) => `<li>${esc(h)}</li>`).join("") + `</ul></details>`;
    }
    $("missionMeta").innerHTML = html;
  }

  /* ------------------------------ timeline ----------------------------- */
  function buildTicks() {
    const ticks = $("ticks");
    ticks.innerHTML = "";
    const active = activeVehicleResult();
    const bounds = resultTimeBounds(active);
    const span = Math.max(bounds.end - bounds.start, 1);
    const colors = {
      burn: "#e0442e", burn_end: "#e0442e",
      soi_entry: "#9a6ff2", soi_exit: "#9a6ff2", flyby: "#9a6ff2",
      libration: "#9a6ff2", cr3bp: "#9a6ff2", stationkeep: "#0e9488",
      launch: "#2f9e5b", landing: "#2f9e5b", liftoff: "#2f9e5b",
      entry: "#c08a12", splashdown: "#c08a12", impact: "#e0442e", apsis: "#3b82f6",
      obs: "#0e9488", conjunction: "#d946ef",
      separation: "#0e9488", rendezvous_wait: "#c08a12", rendezvous: "#e0442e",
      dock: "#2f9e5b", undock: "#0e9488",
    };
    /* cluster events that would overlap on the strip (within ~0.6% of it) */
    const timelineEvents = (active && active.events || []).concat(AN.conjunctionEvents || [],
      AN.nativeConjunctionEvents || []).filter((event) =>
        event.t >= bounds.start - 1e-6 && event.t <= bounds.end + 1e-6);
    const evs = timelineEvents.filter((ev) => colors[ev.kind])
      .slice().sort((a, b) => a.t - b.t);
    const groups = [];
    for (const ev of evs) {
      const grp = groups[groups.length - 1];
      if (grp && (ev.t - grp[grp.length - 1].t) / span < 0.006) grp.push(ev);
      else groups.push([ev]);
    }
    for (const grp of groups) {
      const d = document.createElement("div");
      d.className = grp.length > 1 ? "tick multi" : "tick";
      d.style.left = ((grp[0].t - bounds.start) / span) * 100 + "%";
      d.style.background = colors[grp[0].kind];
      d.title = grp.map((ev) => fmtMet(ev.t) + "  " + ev.label).join("\n") +
        (grp.length > 1 ? "\n(" + grp.length + " events \u2014 click steps through them)" : "");
      d.tabIndex = 0;
      d.setAttribute("role", "button");
      d.setAttribute("aria-label", d.title.replace(/\n/g, ". "));
      const activateTick = () => {
        const next = grp.find((ev) => ev.t > S.tNow + 1e-6) || grp[0];
        const vehicleSelect = $("vehicleSel");
        if (next.vehicleId && vehicleSelect && vehicleSelect.value !== next.vehicleId &&
            Array.from(vehicleSelect.options).some((option) => option.value === next.vehicleId)) {
          vehicleSelect.value = next.vehicleId;
          vehicleSelect.onchange();
        }
        S.tNow = next.t; $("scrub").value = next.t; resetPace(); resetAutoCamera(true); updateHud();
      };
      d.addEventListener("click", activateTick);
      d.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault(); activateTick();
      });
      ticks.appendChild(d);
    }
    /* optional event chip strip (cinematic transport) */
    const strip = $("eventStrip");
    if (strip) {
      strip.innerHTML = "";
      const stripEvents = S.result.events.concat(AN.conjunctionEvents || [],
        AN.nativeConjunctionEvents || []);
      for (const ev of stripEvents) {
        if (!colors[ev.kind]) continue;
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "evchip";
        const cut = ev.label.indexOf(" — ");
        chip.textContent = cut > 0 ? ev.label.slice(0, cut) : ev.label.slice(0, 22);
        chip.title = fmtMet(ev.t) + "  " + ev.label;
        chip.addEventListener("click", () => {
          const vehicleSelect = $("vehicleSel");
          if (ev.vehicleId && vehicleSelect && vehicleSelect.value !== ev.vehicleId &&
              Array.from(vehicleSelect.options).some((option) => option.value === ev.vehicleId)) {
            vehicleSelect.value = ev.vehicleId;
            vehicleSelect.onchange();
          }
          S.tNow = ev.t; $("scrub").value = ev.t;
          resetPace(); resetAutoCamera(true); updateHud();
        });
        strip.appendChild(chip);
      }
    }
  }

  /* ------------------------------ views -------------------------------- */
  const SYNODIC_PREFIX = "synodic:";
  function synodicSystemId(frameBody) {
    return typeof frameBody === "string" && frameBody.startsWith(SYNODIC_PREFIX)
      ? frameBody.slice(SYNODIC_PREFIX.length) : null;
  }
  function frameDescription(frameBody) {
    const systemId = synodicSystemId(frameBody);
    if (systemId && globalThis.CR3BP) {
      try { return globalThis.CR3BP.getSystem(systemId).name + " synodic"; }
      catch (error) {}
    }
    return frameBody === "inertial" ? "Heliocentric inertial"
      : (BODIES[frameBody] ? BODIES[frameBody].name + "-relative" : "Unknown frame");
  }
  function clearVirtualFocus() { S.virtualFocus = null; }
  function syncVirtualFocus() {
    if (!S.virtualFocus || S.camera.focusMode !== "free" ||
        !globalThis.MTPRender || !globalThis.MTPRender.librationPointWorld || !S.result) return;
    const jd = S.result.epochJD + S.tNow / DAY;
    const world = globalThis.MTPRender.librationPointWorld(S.virtualFocus.systemId,
      S.virtualFocus.name, jd, S.frameBody);
    if (world) S.camera.freeFocus = world;
  }
  function focusLibrationPoint(marker) {
    if (!marker) return;
    setAutoCam(false, true);
    setPov(false);
    S.virtualFocus = { systemId: marker.systemId, name: marker.name };
    S.cr3bpSystem = marker.systemId;
    const systemSelect = $("cr3bpSystemSel");
    if (systemSelect) systemSelect.value = marker.systemId;
    S.camera.focusMode = "free";
    S.camera.freeFocus = V.clone(marker.world);
    S.camera.pan = [0, 0, 0];
    setViewBtn(null);
    banner("Focus: " + marker.label + " — press F to zoom to it");
  }

  function setViewBtn(which) {
    S.viewBtn = which || null;
    const m = { solar: "btnViewSolar", mission: "btnViewMission", ship: "btnViewShip", focus: "btnFocus" };
    for (const k in m) { const b = $(m[k]); if (b) b.classList.toggle("active", k === S.viewBtn); }
  }
  function viewSolar() {
    setAutoCam(false, true);
    setPov(false);
    const cam = S.camera;
    clearVirtualFocus();
    cam.focusMode = "body"; cam.focusBody = "sun"; cam.pan = [0, 0, 0];
    // fit outermost body relevant to the mission
    let maxA = 2 * AU;
    const allVehicleResults = S.result && S.result.vehicleResults
      ? Object.values(S.result.vehicleResults) : (S.result ? [S.result] : []);
    for (const result of allVehicleResults) for (const s of result.samples) {
      const b = BODIES[s.cen];
      if (b && b.parent === "sun") maxA = Math.max(maxA, b.aKm * 1.35);
      if (s.cen === "sun") maxA = Math.max(maxA, V.mag(s.w) * 1.2);
    }
    cam.dist = Math.max(maxA * 2.2, 3 * AU);
    setViewBtn("solar");
    S.frameBody = "inertial";
    $("frameSel").value = "inertial";
    globalThis.MTPRender.invalidateCache();
  }

  function viewMission() {
    setAutoCam(false, true);
    setPov(false);
    const cam = S.camera;
    clearVirtualFocus();
    const smp = currentSample();
    const cen = smp ? smp.cen : "earth";
    cam.focusMode = "body"; cam.focusBody = cen; cam.pan = [0, 0, 0];
    let maxR = BODIES[cen].radius * 8;
    const vehicleResult = activeVehicleResult();
    if (vehicleResult) for (const s of vehicleResult.samples) {
      if (s.cen === cen) maxR = Math.max(maxR, V.mag(s.r));
    }
    cam.dist = maxR * 2.8;
    setViewBtn("mission");
    S.frameBody = cen === "sun" ? "inertial" : cen;
    $("frameSel").value = S.frameBody;
    globalThis.MTPRender.invalidateCache();
  }

  function viewShip() {
    setAutoCam(false, true);
    setPov(false);
    const cam = S.camera;
    clearVirtualFocus();
    const smp = currentSample();
    if (!smp) return;
    cam.focusMode = "ship"; cam.pan = [0, 0, 0];
    const cen = smp.cen;
    cam.dist = Math.max(V.mag(smp.r) * 0.35, BODIES[cen].radius * 3, 2000);
    setViewBtn("ship");
    S.frameBody = cen === "sun" ? "inertial" : cen;
    $("frameSel").value = S.frameBody;
    globalThis.MTPRender.invalidateCache();
  }

  /* zoom straight to whatever is focused (double-click a body to focus it) */
  function viewFocus() {
    setAutoCam(false, true);
    setPov(false);
    const cam = S.camera;
    cam.pan = [0, 0, 0];
    let frame = null;
    if (S.virtualFocus && cam.focusMode === "free") {
      syncVirtualFocus();
      if (globalThis.CR3BP) {
        try {
          const system = globalThis.CR3BP.getSystem(S.virtualFocus.systemId);
          cam.dist = Math.max(2000, system.distanceKm * 0.04);
        } catch (error) { cam.dist = Math.max(2000, cam.dist * 0.25); }
      }
    } else if (cam.focusMode === "ship") {
      const smp = currentSample();
      if (!smp) return;
      const cen = BODIES[smp.cen];
      // frame the spacecraft with a bit of its central body for context
      cam.dist = Math.max(cen.radius * 0.35, Math.min(V.mag(smp.r) * 0.12, cen.radius * 6), 800);
      frame = smp.cen === "sun" ? "inertial" : smp.cen;
    } else {
      clearVirtualFocus();
      const b = BODIES[cam.focusBody] || BODIES.earth;
      cam.focusMode = "body";
      cam.focusBody = b.id;
      cam.dist = b.radius * 4;             // fills a good part of the view
      frame = b.id === "sun" ? "inertial" : b.id;
    }
    if (frame && frame !== S.frameBody) {
      const sel = $("frameSel");
      if ([...sel.options].some((o) => o.value === frame)) {
        S.frameBody = frame;
        sel.value = frame;
        globalThis.MTPRender.invalidateCache();
      }
    }
    setViewBtn("focus");
  }

  let savedPitch = null;
  function viewTop() {
    const cam = S.camera;
    if (savedPitch === null) {
      setAutoCam(false, true);
      setPov(false);
      savedPitch = { p: cam.pitch, y: cam.yaw }; cam.pitch = 1.5533; cam.yaw = -Math.PI / 2;
    }
    else { cam.pitch = savedPitch.p; cam.yaw = savedPitch.y; savedPitch = null; }
    $("btnTop").classList.toggle("active", savedPitch !== null);
  }
  function exitTopView() { if (savedPitch !== null) viewTop(); }
  function cancelTopView() {
    if (savedPitch === null) return;
    savedPitch = null;
    $("btnTop").classList.remove("active");
  }

  /* ------------------------ observation windows ------------------------- */
  function obsTargetAtT(t) {
    const result = activeVehicleResult();
    if (!result) return null;
    const smp = t === S.tNow ? currentSample() : ME.sampleAtTime(result, t);
    if (!smp) return null;
    const sg = activeSegments()[smp.seg];
    return sg && sg.type === "observe" && BODIES[sg.target] ? sg.target : null;
  }
  function activeObserve() { return obsTargetAtT(S.tNow); }
  function obsRangesFor(bodyId) {
    const out = [];
    for (const sg of activeSegments()) {
      if (sg.type === "observe" && sg.target === bodyId && sg._t1 > sg._t0)
        out.push([sg._t0, sg._t1]);
    }
    return out;
  }

  /* ----------------------- onboard (POV) camera ------------------------- */
  let povRestoreFrame = null;
  function setPov(on) {
    if (S.pov === on) return;
    if (on) {
      povRestoreFrame = S.frameBody;
      // Leave Top before setting POV so viewTop's own setPov(false) call is a
      // no-op and cannot immediately cancel the requested onboard view.
      clearVirtualFocus(); setAutoCam(false, true); exitTopView(); setViewBtn(null);
      S.camera.pan = [0, 0, 0];
      S.pov = true;
    } else {
      S.pov = false;
      S.camera.fov = 50 * Math.PI / 180;
      const selector = $("frameSel");
      if (povRestoreFrame && selector && [...selector.options].some((option) =>
        option.value === povRestoreFrame)) {
        S.frameBody = povRestoreFrame;
        selector.value = povRestoreFrame;
        globalThis.MTPRender.invalidateCache();
      }
      povRestoreFrame = null;
    }
    const b = $("btnPov");
    if (b) b.classList.toggle("active", on);
  }
  function povTick() {
    if (!S.pov || !S.result) return;
    const smp = currentSample();
    if (!smp) return;
    const cam = S.camera;
    // during an observation window the camera looks at the observed body
    const obsT = activeObserve();
    let lookBody = smp.cen, vec = smp.r;
    if (obsT) {
      lookBody = obsT;
      vec = V.sub(smp.w, A.bodyWorld(obsT, S.result.epochJD + S.tNow / DAY));
    }
    const cen = BODIES[lookBody];
    const u = V.norm(vec);
    if (!isFinite(u[0]) || V.mag(vec) === 0) return;
    // place the eye exactly at the spacecraft, looking at the target
    cam.fov = Math.min(140, Math.max(15,
      (activeSpacecraft() && +activeSpacecraft().fovDeg) || 50)) * Math.PI / 180;
    cam.focusMode = "body";
    cam.focusBody = lookBody;
    cam.pan = [0, 0, 0];
    cam.dist = Math.max(V.mag(vec), cen.radius * 1.02);
    cam.yaw = Math.atan2(u[1], u[0]);
    cam.pitch = Math.asin(Math.max(-1, Math.min(1, u[2])));
    const wantFrame = smp.cen === "sun" ? "inertial" : smp.cen;
    if (S.frameBody !== wantFrame) {
      S.frameBody = wantFrame;
      $("frameSel").value = wantFrame;
      globalThis.MTPRender.invalidateCache();
    }
  }

  /* ---------------------- ground track / sat vision --------------------- */
  let gtLastDraw = 0;
  function setGt(on) {
    S.gtOpen = on;
    const p = $("gtPanel"), b = $("btnTrack");
    if (p) p.classList.toggle("hidden", !on);
    if (b) b.classList.toggle("active", on);
    gtLastDraw = 0;
  }
  function gtBody() {
    const smp = currentSample();
    if (!smp) return null;
    if (smp.cen !== "sun") return smp.cen;
    const legs = S.gtLegs || [];
    if (!legs.length) return null;
    let lo = 0, hi = legs.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (legs[m].t <= S.tNow) lo = m + 1; else hi = m; }
    return (lo > 0 ? legs[lo - 1] : legs[0]).cen;
  }

  const USER_STATION_KEY = "mtp-user-stations-v1";
  const MAX_USER_STATIONS = 32;
  function readUserStations() {
    try {
      const raw = JSON.parse(localStorage.getItem(USER_STATION_KEY) || "[]");
      if (!Array.isArray(raw)) return [];
      return raw.slice(0, MAX_USER_STATIONS).filter((station) => station &&
        BODIES[station.bodyId] && station.bodyId !== "sun" &&
        Number.isFinite(+station.latDeg) && Number.isFinite(+station.lonDeg));
    } catch (error) { return []; }
  }
  function writeUserStations() {
    try { localStorage.setItem(USER_STATION_KEY,
      JSON.stringify(AN.userStations.filter((station) => !station.preset))); }
    catch (error) {}
  }
  function stationsForBody(bodyId, dsnMask) {
    const custom = AN.userStations.filter((station) => station.bodyId === bodyId);
    if (bodyId !== "earth" || !MA) return custom.slice();
    const mask = Math.min(89, Math.max(0, Number.isFinite(+dsnMask) ? +dsnMask : 10));
    return MA.DSN_STATIONS.map((station) => ({ ...station,
      elevationMaskDeg: mask })).concat(custom);
  }

  function gtTick(now) {
    const vehicleResult = activeVehicleResult();
    if (!S.gtOpen || !vehicleResult || !globalThis.MTPGroundTrack) return;
    const cv2 = $("gtCv");
    // The map is an analysis overlay, not the animation clock. During
    // playback a five-Hz update remains readable while avoiding a second
    // texture/map pass competing with every main-canvas frame.
    const interval = S.playing ? 200 : 80;
    if (!cv2 || now - gtLastDraw < interval) return;
    gtLastDraw = now;
    const obsT = activeObserve();
    const bodyId = obsT || gtBody();
    const sub = $("gtSub");
    if (!bodyId) {
      cv2.getContext("2d").clearRect(0, 0, cv2.width, cv2.height);
      if (sub) sub.textContent = "no body-centric leg";
      return;
    }
    const st = {
      result: vehicleResult, tNow: S.tNow, epochJD: vehicleResult.epochJD,
      bodyId, sampleAtTime: ME.sampleAtTime,
    };
    if (MA && $("gtStations") && $("gtStations").checked)
      st.stations = stationsForBody(bodyId, $("accessMask") && +$("accessMask").value);
    if (MA && $("gtSwath") && $("gtSwath").checked) {
      st.sensor = {
        fovDeg: Math.min(179, Math.max(1, +$("gtFov").value || 50)),
        offNadirDeg: Math.min(89, Math.max(-89, +$("gtOffNadir").value || 0)),
      };
    }
    if (obsT) st.obsRanges = obsRangesFor(obsT);
    const info = globalThis.MTPGroundTrack.draw(cv2, st);
    const swathWidth = $("gtSwathWidth");
    if (swathWidth) {
      if (!st.sensor) swathWidth.textContent = "SWATH —";
      else if (info && isFinite(info.sensorSwathWidthKm))
        swathWidth.textContent = "SWATH " + ME.fmtKm(info.sensorSwathWidthKm);
      else swathWidth.textContent = info && info.sensorError ? "SWATH NO INTERCEPT" : "SWATH OPEN";
    }
    if (sub) {
      const nm = BODIES[bodyId].name.toUpperCase();
      sub.textContent = info
        ? (info.observing ? "OBSERVING " : "") + nm +
          " · φ " + (info.latDeg >= 0 ? "+" : "") + info.latDeg.toFixed(1) +
          "° λ " + (info.lonDeg >= 0 ? "+" : "") + info.lonDeg.toFixed(1) +
          (info.observing ? "° · RANGE " + ME.fmtKm(info.rangeKm)
                          : "° · ALT " + ME.fmtKm(info.altKm))
        : nm + " · spacecraft not in this frame";
    }
  }

  /* ------------------------ mission analysis UI ------------------------ */
  const ANALYSIS_METRICS = {
    altitudeKm: { label: "Altitude", unit: "km" },
    speedKmS: { label: "Speed", unit: "km/s" },
    targetDistanceKm: { label: "Distance to target", unit: "km" },
    aKm: { label: "Semi-major axis", unit: "km" },
    e: { label: "Eccentricity", unit: "" },
    iDeg: { label: "Inclination", unit: "deg" },
    raanDeg: { label: "RAAN", unit: "deg" },
    argPeriapsisDeg: { label: "Argument of periapsis", unit: "deg" },
    trueAnomalyDeg: { label: "True anomaly", unit: "deg" },
    range: { label: "Relative range", unit: "km" },
  };

  function analysisPresent() {
    return !!($("dataPane") && $("analysisCanvas") && MA);
  }

  function setAnalysisStatus(message, kind) {
    const el = $("analysisStatus");
    if (!el) return;
    el.textContent = message;
    el.className = "analysis-status" + (kind ? " " + kind : "");
  }

  const UNCERTAINTY_DEFAULTS = Object.freeze({
    positionSigmaKm: 0.1,
    velocitySigmaKmS: 0.0001,
    samples: 1000,
    seed: 1170,
    propagationHours: 6,
    maneuver: Object.freeze({
      dv: Object.freeze([0, 0, 0]),
      frame: "RTN",
      execution: Object.freeze({ magnitudeSigmaFraction: 0.005,
        pointingSigmaRad: 0.15 * C.DEG, timingSigmaS: 0.5 }),
    }),
  });

  function uncertaintyPresent() {
    return !!($("uncertaintySection") && $("uncRun"));
  }

  function uncertaintyVector(value, fallback) {
    if (Array.isArray(value) && value.length === 3)
      return value.map((component, index) => Number.isFinite(+component) ? +component : fallback[index]);
    if (Number.isFinite(+value)) return [+value, +value, +value];
    return fallback.slice();
  }

  function setUncertaintyValue(id, value) {
    const input = $(id);
    if (input) input.value = String(value);
  }

  function uncertaintyEmptyResults() {
    return '<div class="uncertainty-result"><label>Endpoint position (est. 95%)</label><strong>--</strong></div>' +
      '<div class="uncertainty-result"><label>Endpoint velocity (est. 95%)</label><strong>--</strong></div>' +
      '<div class="uncertainty-result"><label>Endpoint XY ellipse (95%)</label><strong>--</strong></div>' +
      '<div class="uncertainty-result"><label>Source / endpoint</label><strong>--</strong></div>' +
      '<div class="uncertainty-result"><label>Run</label><strong>--</strong></div>';
  }

  function setUncertaintyStatus(message, kind) {
    const status = $("uncStatus");
    if (!status) return;
    status.textContent = message;
    status.className = "analysis-readout uncertainty-status" + (kind ? " " + kind : "");
  }

  function clearUncertaintyOutput(message, kind) {
    if (!uncertaintyPresent()) return;
    AN.uncertaintyRunId++;
    AN.uncertainty = null;
    AN.accessConfidence = null;
    const results = $("uncResults");
    if (results) results.innerHTML = uncertaintyEmptyResults();
    const run = $("uncRun");
    if (run) { run.disabled = !MU; run.textContent = "Run"; }
    setUncertaintyStatus(message || (MU
      ? "Ready. Results use a bounded two-body local propagation model."
      : "Uncertainty engine is unavailable. Reload the full Planner."), kind || (!MU ? "error" : ""));
    drawUncertaintyChart();
  }

  function loadUncertaintyMissionDefaults() {
    if (!uncertaintyPresent()) return;
    const metadata = S.mission && S.mission.uncertainty || null;
    const stateMetadata = metadata && metadata.state || {};
    let position = uncertaintyVector(metadata && metadata.positionSigmaKm !== undefined
      ? metadata.positionSigmaKm : stateMetadata.positionSigmaKm,
    [UNCERTAINTY_DEFAULTS.positionSigmaKm, UNCERTAINTY_DEFAULTS.positionSigmaKm,
      UNCERTAINTY_DEFAULTS.positionSigmaKm]);
    let velocity = uncertaintyVector(metadata && metadata.velocitySigmaKmS !== undefined
      ? metadata.velocitySigmaKmS : stateMetadata.velocitySigmaKmS,
    [UNCERTAINTY_DEFAULTS.velocitySigmaKmS, UNCERTAINTY_DEFAULTS.velocitySigmaKmS,
      UNCERTAINTY_DEFAULTS.velocitySigmaKmS]);
    const covariance = metadata && (metadata.covariance || stateMetadata.covariance);
    if (Array.isArray(covariance) && covariance.length === 6 &&
        covariance.every((row) => Array.isArray(row) && row.length === 6)) {
      const diagonal = covariance.map((row, index) => Math.sqrt(Math.max(0, +row[index] || 0)));
      position = diagonal.slice(0, 3);
      velocity = diagonal.slice(3, 6);
    }
    ["uncPosX", "uncPosY", "uncPosZ"].forEach((id, index) =>
      setUncertaintyValue(id, Math.max(0, position[index])));
    ["uncVelX", "uncVelY", "uncVelZ"].forEach((id, index) =>
      setUncertaintyValue(id, Math.max(0, velocity[index])));

    const maneuver = metadata && metadata.maneuver || UNCERTAINTY_DEFAULTS.maneuver;
    const dv = uncertaintyVector(maneuver.dv, UNCERTAINTY_DEFAULTS.maneuver.dv);
    ["uncDvR", "uncDvT", "uncDvN"].forEach((id, index) =>
      setUncertaintyValue(id, dv[index]));
    const execution = maneuver.execution || {};
    const magnitudeFraction = Number.isFinite(+execution.magnitudeSigmaFraction)
      ? +execution.magnitudeSigmaFraction : UNCERTAINTY_DEFAULTS.maneuver.execution.magnitudeSigmaFraction;
    const pointingRad = Number.isFinite(+execution.pointingSigmaRad)
      ? +execution.pointingSigmaRad : UNCERTAINTY_DEFAULTS.maneuver.execution.pointingSigmaRad;
    const timingS = Number.isFinite(+execution.timingSigmaS)
      ? +execution.timingSigmaS : UNCERTAINTY_DEFAULTS.maneuver.execution.timingSigmaS;
    setUncertaintyValue("uncMagPct", Math.max(0, magnitudeFraction) * 100);
    setUncertaintyValue("uncPointDeg", Math.max(0, pointingRad) / C.DEG);
    setUncertaintyValue("uncTimingS", Math.max(0, timingS));
    setUncertaintyValue("uncSamples", metadata && Number.isFinite(+metadata.samples)
      ? Math.min(5000, Math.max(100, Math.round(+metadata.samples)))
      : UNCERTAINTY_DEFAULTS.samples);
    setUncertaintyValue("uncSeed", metadata && metadata.seed !== undefined
      ? metadata.seed : UNCERTAINTY_DEFAULTS.seed);
    setUncertaintyValue("uncHours", metadata && Number.isFinite(+metadata.propagationHours)
      ? Math.min(8760, Math.max(0, +metadata.propagationHours))
      : UNCERTAINTY_DEFAULTS.propagationHours);
    const sourceLabel = metadata && metadata.source && metadata.source.label;
    clearUncertaintyOutput(metadata
      ? sourceLabel
        ? `Preset uncertainty assumptions loaded. Run uses ${sourceLabel}, independent of the displayed mission time.`
        : "Preset uncertainty assumptions loaded. Run uses the displayed spacecraft state."
      : "General design assumptions loaded. Run uses the displayed spacecraft state.");
  }

  function readUncertaintyNumber(id, label, minimum, maximum, integer) {
    const input = $(id);
    const raw = input ? String(input.value).trim() : "";
    const value = raw === "" ? NaN : Number(raw);
    if (!Number.isFinite(value) || value < minimum || value > maximum ||
        (integer && !Number.isInteger(value))) {
      throw new Error(label + " must be " + (integer ? "an integer " : "") +
        "from " + minimum + " through " + maximum + ".");
    }
    return value;
  }

  function uncertaintyCovariance(sigmas) {
    return Array.from({ length: 6 }, (_, row) => Array.from({ length: 6 }, (_, column) =>
      row === column ? sigmas[row] * sigmas[row] : 0));
  }

  function fmtUncertaintyDistance(km) {
    const magnitude = Math.abs(km);
    if (magnitude >= 1e6) return (km / 1e6).toFixed(3) + "M km";
    if (magnitude >= 1000) return km.toFixed(1) + " km";
    if (magnitude >= 1) return km.toFixed(3) + " km";
    if (magnitude >= 0.001) return (km * 1000).toFixed(2) + " m";
    return (km * 1e6).toFixed(2) + " mm";
  }

  function fmtUncertaintyVelocity(kmS) {
    const magnitude = Math.abs(kmS);
    if (magnitude >= 1) return kmS.toFixed(4) + " km/s";
    if (magnitude >= 0.001) return (kmS * 1000).toFixed(3) + " m/s";
    return (kmS * 1e6).toFixed(2) + " mm/s";
  }

  function activeEndpointDispersion(bodyId) {
    const analysis = AN.uncertainty;
    const radius = analysis && analysis.result && analysis.result.summary &&
      analysis.result.summary.positionRadius &&
      +analysis.result.summary.positionRadius.confidence;
    if (!analysis || analysis.bodyId !== bodyId || !(radius >= 0) ||
        !Number.isFinite(radius)) return null;
    const horizonHours = +analysis.propagationHours || 0;
    const sourceTime = Number.isFinite(+analysis.sourceTime) ? +analysis.sourceTime : 0;
    return { radiusKm: radius, confidence: 0.95, horizonHours, sourceTime,
      endpointTime: sourceTime + horizonHours * 3600,
      sourceLabel: analysis.sourceLabel || "dispersion source" };
  }

  const CHI_SQUARE_3D_95 = 7.814727903251179;
  function positionVarianceUpperBound(covariance) {
    let bound = 0;
    for (let row = 0; row < 3; row++) {
      let rowSum = 0;
      for (let column = 0; column < 3; column++)
        rowSum += Math.abs(covariance[row][column]);
      bound = Math.max(bound, rowSum);
    }
    return bound;
  }

  function uncertaintyStatesMatch(sample, state, positionToleranceKm, velocityToleranceKmS) {
    if (!sample || !sample.r || !sample.v || !Array.isArray(state) || state.length !== 6)
      return false;
    const positionError = V.mag(V.sub(sample.r, state.slice(0, 3)));
    const velocityError = V.mag(V.sub(sample.v, state.slice(3, 6)));
    return positionError <= positionToleranceKm && velocityError <= velocityToleranceKmS;
  }

  /* Event confidence is only associated with the flown nominal trajectory when
   * the uncertainty source either lies inside an unforced Kepler coast or its
   * analyzed maneuver exactly replaces the configured instantaneous mission
   * impulse. Any later maneuver, frame change, or non-Kepler force model closes
   * the supported event interval. */
  function uncertaintyEventWindow(source, linearized, maneuverApplied) {
    const startTime = +source.sample.t;
    const unavailable = (reason) => Object.freeze({ startTime, endTime: startTime,
      supported: false, reason });
    const vehicleResult = activeVehicleResult();
    const segments = activeSegments();
    if (!vehicleResult || !Array.isArray(vehicleResult.samples) || !segments.length)
      return unavailable("Mission samples are unavailable.");
    let firstCoastSegment;
    if (maneuverApplied) {
      const modeledSegment = source.beforeSegment;
      if (!Number.isSafeInteger(modeledSegment) || modeledSegment < 0 ||
          !segments[modeledSegment] ||
          segments[modeledSegment].type !== "impulse")
        return unavailable("The analyzed maneuver is not tied to a mission impulse.");
      const postBurn = vehicleResult.samples.find((entry) => entry.seg === modeledSegment);
      if (!postBurn || postBurn.cen !== source.sample.cen ||
          Math.abs(postBurn.t - startTime) > 1e-6 ||
          !uncertaintyStatesMatch(postBurn, linearized.state, 1e-5, 1e-7))
        return unavailable("The analyzed maneuver does not match the flown mission impulse.");
      firstCoastSegment = modeledSegment + 1;
    } else {
      firstCoastSegment = Number.isSafeInteger(source.beforeSegment)
        ? source.beforeSegment : Number(source.sample.seg);
    }
    if (!Number.isSafeInteger(firstCoastSegment) || firstCoastSegment < 0)
      return unavailable("The uncertainty source is not associated with a mission segment.");

    let endTime = startTime, coastCount = 0;
    for (let index = firstCoastSegment; index < segments.length; index++) {
      const segment = segments[index];
      if (!segment || segment.type !== "coast" ||
          (segment.mode !== undefined && segment.mode !== "kepler")) break;
      const samples = vehicleResult.samples.filter((entry) => entry.seg === index);
      if (!samples.length || samples.some((entry) => entry.cen !== source.sample.cen ||
          entry.cr3bp || entry.landed)) break;
      const first = samples[0], last = samples[samples.length - 1];
      if (first.t > endTime + 1e-6 || last.t < startTime - 1e-6) break;
      endTime = Math.max(endTime, last.t);
      coastCount++;
    }
    return Object.freeze({ startTime, endTime, supported: endTime > startTime + 1e-6,
      reason: coastCount
        ? "Matched mission impulse followed by uninterrupted local two-body coast."
        : "No uninterrupted local two-body coast follows the uncertainty source." });
  }

  /* Linearized, time-correlated confidence for one event epoch. The primary
   * state/covariance is propagated from its named source with the same local
   * two-body model used by the Monte Carlo panel. The row-sum matrix norm is a
   * conservative upper bound on the largest position-covariance eigenvalue. */
  function eventEpochDispersion(bodyId, missionTime) {
    const analysis = AN.uncertainty;
    if (!analysis || analysis.bodyId !== bodyId || !analysis.linearized ||
        !analysis.eventWindow || !analysis.eventWindow.supported ||
        !Number.isFinite(+missionTime) || missionTime < analysis.sourceTime - 1e-6 ||
        missionTime > analysis.sourceTime + analysis.propagationHours * 3600 + 1e-6 ||
        missionTime > analysis.eventWindow.endTime + 1e-6)
      return null;
    const time = +missionTime;
    const key = time.toFixed(3);
    if (analysis.eventCache && analysis.eventCache.has(key))
      return analysis.eventCache.get(key);
    try {
      const body = BODIES[bodyId];
      const dt = time - analysis.sourceTime;
      const source = analysis.linearized;
      const propagated = Math.abs(dt) <= 1e-9
        ? { finalState: source.state, covariance: source.covariance, evaluations: 0 }
        : MU.propagateCovariance({
          state: source.state,
          covariance: source.covariance,
          dt,
          propagator: (state, elapsed) => {
            const output = A.propagateUniversal(state.slice(0, 3),
              state.slice(3, 6), elapsed, body.mu);
            return output.r.concat(output.v);
          },
          maxEvaluations: 13,
        });
      const varianceUpper = positionVarianceUpperBound(propagated.covariance);
      const nominal = ME.sampleAtTime(analysis.vehicleResult, time);
      if (!nominal || nominal.cen !== bodyId ||
          !uncertaintyStatesMatch(nominal, propagated.finalState, 1e-3, 1e-6)) return null;
      const record = Object.freeze({
        missionTime: time,
        dt,
        radiusKm: Math.sqrt(Math.max(0, CHI_SQUARE_3D_95 * varianceUpper)),
        confidence: 0.95,
        evaluations: propagated.evaluations || 0,
        method: "first-order two-body covariance / conservative 3D estimated-95% max-axis upper bound",
      });
      if (!analysis.eventCache) analysis.eventCache = new Map();
      if (analysis.eventCache.size >= 512) analysis.eventCache.clear();
      analysis.eventCache.set(key, record);
      return record;
    } catch (error) {
      return null;
    }
  }

  function uncertaintyContextMarkup(bodyId, eventContext) {
    const endpoint = activeEndpointDispersion(bodyId);
    if (!endpoint) return '<div class="analysis-confidence nominal">Nominal geometry only. ' +
      'Run Uncertainty for estimated endpoint dispersion design context.</div>';
    return '<div class="analysis-confidence bounded"><strong>Estimated 95% endpoint position containment: ' +
      esc(fmtUncertaintyDistance(endpoint.radiusKm)) + '</strong> at ' +
      esc(fmtMet(endpoint.endpointTime)) + ' (+' + endpoint.horizonHours.toFixed(2) + ' h from ' +
      esc(endpoint.sourceLabel) + '). ' + esc(eventContext ||
        'Event epochs are nominal until an event-time covariance estimate is requested.') + '</div>';
  }

  function renderUncertaintyResults() {
    const host = $("uncResults"), analysis = AN.uncertainty;
    if (!host || !analysis) return;
    const summary = analysis.result.summary;
    const ellipse = summary.ellipses.xy;
    const endpointTime = analysis.sourceTime + analysis.propagationHours * 3600;
    host.innerHTML =
      `<div class="uncertainty-result"><label>Endpoint position (est. 95%)</label><strong>${esc(fmtUncertaintyDistance(summary.positionRadius.confidence))}</strong></div>` +
      `<div class="uncertainty-result"><label>Endpoint velocity (est. 95%)</label><strong>${esc(fmtUncertaintyVelocity(summary.velocityRadius.confidence))}</strong></div>` +
      `<div class="uncertainty-result"><label>Endpoint XY ellipse (95%)</label><strong>${esc(fmtUncertaintyDistance(ellipse.semiMajor))} x ${esc(fmtUncertaintyDistance(ellipse.semiMinor))} @ ${(ellipse.angleRad / C.DEG).toFixed(1)} deg</strong></div>` +
      `<div class="uncertainty-result"><label>Source / endpoint</label><strong>${esc(analysis.sourceLabel)} at ${esc(fmtMet(analysis.sourceTime))} / ${esc(fmtMet(endpointTime))}</strong></div>` +
      `<div class="uncertainty-result"><label>Run</label><strong>${analysis.result.samplesRequested.toLocaleString("en-US")} samples / seed ${esc(analysis.seed)}</strong></div>`;
  }

  function drawUncertaintyChart() {
    const canvas = $("uncCanvas");
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (!(rect.width > 20)) return;
    const cssW = rect.width, cssH = cssW / (640 / 260);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelW = Math.max(2, Math.round(cssW * dpr));
    const pixelH = Math.max(2, Math.round(cssH * dpr));
    if (canvas.width !== pixelW || canvas.height !== pixelH) {
      canvas.width = pixelW; canvas.height = pixelH;
    }
    const ctx = canvas.getContext("2d"), palette = analysisPalette();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = palette.bg; ctx.fillRect(0, 0, cssW, cssH);
    if (!AN.uncertainty || !AN.uncertainty.result.samples) {
      ctx.fillStyle = palette.text; ctx.font = "10px 'JetBrains Mono', monospace";
      ctx.fillText("RUN MONTE CARLO TO PLOT LOCAL XY DISPERSION", 12, 22);
      return;
    }
    const result = AN.uncertainty.result, mean = result.summary.mean;
    const samples = result.samples;
    const errors = samples.map((state) => [state[0] - mean[0], state[1] - mean[1]]);
    const ellipse = result.summary.ellipses.xy;
    let extent = Math.max(ellipse.semiMajor, ellipse.semiMinor,
      ...errors.map((point) => Math.max(Math.abs(point[0]), Math.abs(point[1]))));
    if (!(extent > 0) || !Number.isFinite(extent)) extent = 1e-6;
    extent *= 1.08;
    const left = 38, right = 12, top = 12, bottom = 28;
    const width = cssW - left - right, height = cssH - top - bottom;
    const centerX = left + width / 2, centerY = top + height / 2;
    const scale = Math.min(width, height) / (2 * extent);
    const pointAt = (x, y) => [centerX + x * scale, centerY - y * scale];

    ctx.strokeStyle = palette.grid; ctx.lineWidth = 1;
    for (const fraction of [-1, -0.5, 0, 0.5, 1]) {
      const x = centerX + fraction * extent * scale;
      const y = centerY - fraction * extent * scale;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, cssH - bottom); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(cssW - right, y); ctx.stroke();
    }
    const stride = Math.max(1, Math.ceil(errors.length / 2000));
    ctx.fillStyle = palette.line; ctx.globalAlpha = 0.32;
    for (let index = 0; index < errors.length; index += stride) {
      const plotted = pointAt(errors[index][0], errors[index][1]);
      ctx.fillRect(plotted[0] - 1, plotted[1] - 1, 2, 2);
    }
    ctx.globalAlpha = 1;

    const cosine = Math.cos(ellipse.angleRad), sine = Math.sin(ellipse.angleRad);
    ctx.beginPath();
    for (let index = 0; index <= 96; index++) {
      const angle = 2 * Math.PI * index / 96;
      const major = ellipse.semiMajor * Math.cos(angle);
      const minor = ellipse.semiMinor * Math.sin(angle);
      const plotted = pointAt(major * cosine - minor * sine,
        major * sine + minor * cosine);
      if (index) ctx.lineTo(plotted[0], plotted[1]);
      else ctx.moveTo(plotted[0], plotted[1]);
    }
    ctx.strokeStyle = palette.current; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = palette.current; ctx.beginPath(); ctx.arc(centerX, centerY, 2.5, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = palette.text; ctx.font = "8px 'JetBrains Mono', monospace";
    ctx.fillText("+/- " + fmtUncertaintyDistance(extent), 4, cssH - 8);
    ctx.fillText("95% ellipse", Math.max(left, cssW - 78), 11);
  }

  function uncertaintySourceSample() {
    const metadata = S.activeVehicleId === "primary" && S.mission &&
      S.mission.uncertainty || {};
    const source = metadata.source || {};
    const beforeSegment = Number(source.beforeSegment);
    const vehicleResult = activeVehicleResult();
    if (Number.isSafeInteger(beforeSegment) && beforeSegment >= 0 && vehicleResult &&
        Array.isArray(vehicleResult.samples)) {
      const first = vehicleResult.samples.findIndex((entry) => entry.seg === beforeSegment);
      if (first > 0) return { sample: vehicleResult.samples[first - 1], beforeSegment,
        label: String(source.label || `state before segment ${beforeSegment + 1}`) };
      throw new Error("The configured pre-maneuver uncertainty source state is unavailable.");
    }
    return { sample: currentSample(), beforeSegment: null,
      label: "displayed spacecraft state" };
  }

  function retainedDispersionIntersectsBody(state, body) {
    const position = state.slice(0, 3), velocity = state.slice(3, 6);
    if (!(V.mag(position) > body.radius)) return true;
    const orbit = A.rvToCoe(position, velocity, body.mu);
    return !Number.isFinite(orbit.rp) || !(orbit.rp > body.radius);
  }

  function executeUncertaintyRun(runId) {
    const run = $("uncRun");
    try {
      if (runId !== AN.uncertaintyRunId) return;
      if (!MU) throw new Error("Uncertainty engine is unavailable.");
      const source = uncertaintySourceSample();
      const sample = source.sample;
      if (!sample || !sample.r || !sample.v || sample.cr3bp || sample.landed)
        throw new Error("Select a non-landed two-body spacecraft state before running dispersion.");
      const body = BODIES[sample.cen];
      if (!body || !(body.mu > 0)) throw new Error("The current central body has no usable gravity parameter.");
      if (!(V.mag(sample.r) > body.radius))
        throw new Error("The uncertainty source state must be above the central body's surface.");
      const sigmas = [
        readUncertaintyNumber("uncPosX", "Position X sigma", 0, 1e6),
        readUncertaintyNumber("uncPosY", "Position Y sigma", 0, 1e6),
        readUncertaintyNumber("uncPosZ", "Position Z sigma", 0, 1e6),
        readUncertaintyNumber("uncVelX", "Velocity X sigma", 0, 100),
        readUncertaintyNumber("uncVelY", "Velocity Y sigma", 0, 100),
        readUncertaintyNumber("uncVelZ", "Velocity Z sigma", 0, 100),
      ];
      const dv = [readUncertaintyNumber("uncDvR", "Radial delta-v", -100, 100),
        readUncertaintyNumber("uncDvT", "Along-track delta-v", -100, 100),
        readUncertaintyNumber("uncDvN", "Normal delta-v", -100, 100)];
      const magnitudeSigmaFraction = readUncertaintyNumber("uncMagPct",
        "Magnitude sigma", 0, 100) / 100;
      const pointingSigmaRad = readUncertaintyNumber("uncPointDeg",
        "Pointing sigma", 0, 90) * C.DEG;
      const timingSigmaS = readUncertaintyNumber("uncTimingS", "Timing sigma", 0, 86400);
      const samples = readUncertaintyNumber("uncSamples", "Samples", 100, 5000, true);
      const propagationHours = readUncertaintyNumber("uncHours", "Horizon", 0, 8760);
      const seed = String($("uncSeed") ? $("uncSeed").value : "").trim() || "1170";
      const maneuver = { dv, frame: "RTN", execution: {
        magnitudeSigmaFraction, pointingSigmaRad, timingSigmaS,
      } };
      const options = {
        meanState: sample.r.concat(sample.v),
        covariance: uncertaintyCovariance(sigmas),
        samples,
        seed,
        confidence: 0.95,
        propagationTime: propagationHours * 3600,
        maxModelEvaluations: samples,
        retainSamples: true,
        propagator: (state, dt) => {
          const propagated = A.propagateUniversal(state.slice(0, 3), state.slice(3, 6), dt, body.mu);
          return propagated.r.concat(propagated.v);
        },
      };
      let linearized = { state: options.meanState.slice(),
        covariance: options.covariance.map((row) => row.slice()) };
      if (Math.hypot(...dv) > 0) {
        const nominal = MU.applyManeuverCovariance({ state: options.meanState,
          covariance: options.covariance, maneuver });
        const nominalOrbit = A.rvToCoe(nominal.finalState.slice(0, 3),
          nominal.finalState.slice(3, 6), body.mu);
        if (!(nominalOrbit.rp > body.radius))
          throw new Error("The nominal maneuver produces a surface-intersecting orbit.");
        options.maneuvers = [maneuver];
        linearized = { state: nominal.finalState.slice(),
          covariance: nominal.covariance.map((row) => row.slice()) };
      }
      const result = MU.runMonteCarlo(options);
      if (result.samples && result.samples.some((state) =>
        retainedDispersionIntersectsBody(state, body)))
        throw new Error("At least one retained dispersion trajectory has an osculating " +
          "periapsis at or below the central body's surface.");
      if (runId !== AN.uncertaintyRunId) return;
      const eventWindow = uncertaintyEventWindow(source, linearized,
        Math.hypot(...dv) > 0);
      AN.uncertainty = { result, bodyId: sample.cen, sourceTime: sample.t,
        propagationHours, seed, sourceLabel: source.label, linearized, eventWindow,
        vehicleId: S.activeVehicleId, vehicleResult: activeVehicleResult(),
        eventCache: new Map() };
      renderUncertaintyResults();
      drawUncertaintyChart();
      if (AN.access && AN.leg && AN.leg.cen === sample.cen) computeAccessReport();
      if (AN.crafts.length) refreshFleetSummary();
      setUncertaintyStatus(`${body.name} estimated two-body endpoint dispersion from ` +
        `${source.label} at ${fmtMet(sample.t)} through ` +
        `${fmtMet(sample.t + propagationHours * 3600)} (+${propagationHours.toFixed(2)} h). ` +
        `Initial state covariance` +
        `${options.maneuvers ? " and maneuver execution errors" : ""} were sampled. ` +
        (eventWindow.supported
          ? `Access and fleet reports can propagate first-order primary covariance through ` +
            `the matching uninterrupted Kepler coast ending ${fmtMet(eventWindow.endTime)}.`
          : `Event confidence is withheld: ${eventWindow.reason}`), "ready");
    } catch (error) {
      AN.uncertainty = null;
      AN.accessConfidence = null;
      const results = $("uncResults");
      if (results) results.innerHTML = uncertaintyEmptyResults();
      drawUncertaintyChart();
      if (AN.access && AN.leg) computeAccessReport();
      if (AN.crafts.length) refreshFleetSummary();
      setUncertaintyStatus("Dispersion run failed: " + error.message, "error");
    } finally {
      if (runId === AN.uncertaintyRunId && run) {
        run.disabled = false; run.textContent = "Run";
      }
    }
  }

  function runUncertainty() {
    if (!uncertaintyPresent()) return;
    const run = $("uncRun");
    if (!MU) { setUncertaintyStatus("Uncertainty engine is unavailable. Reload the full Planner.", "error"); return; }
    const runId = ++AN.uncertaintyRunId;
    run.disabled = true; run.textContent = "Running...";
    setUncertaintyStatus("Running bounded seeded samples...", "busy");
    requestAnimationFrame(() => executeUncertaintyRun(runId));
  }

  function analysisAfterRecompute() {
    if (!$("dataPane")) return;
    AN.leg = null;
    AN.series = null;
    AN.rows = null;
    AN.hoverIndex = null;
    AN.eclipse = null;
    AN.access = null;
    AN.comparison = null;
    AN.comparisonSeries = null;
    AN.comparisonClosest = null;
    AN.conjunctions = null;
    AN.crafts = [];
    AN.fleetSeries = [];
    AN.conjunctionEvents = [];
    AN.nativeFormation = [];
    AN.nativeConjunctionEvents = [];
    AN.nativeFormationKey = "";
    clearUncertaintyOutput("Mission changed. Run dispersion again at the displayed time.");
    const csv = $("analysisCsv"), accessCsv = $("accessCsv"), fleetCsv = $("fleetCsv");
    if (csv) csv.disabled = true;
    if (accessCsv) accessCsv.disabled = true;
    if (fleetCsv) fleetCsv.disabled = true;
    if ($("fleetRemove")) $("fleetRemove").disabled = true;
    if ($("eclipseSummary")) $("eclipseSummary").textContent =
      "Conical Sun / local-body shadow; compute on demand.";
    if ($("eclipseIntervals")) $("eclipseIntervals").innerHTML = "";
    if ($("accessReport")) $("accessReport").innerHTML =
      '<span class="hint">No access report computed.</span>';
    if ($("fleetReport")) $("fleetReport").textContent = "No comparison craft added.";
    renderFleetManager();
    buildEclipseBands();
    populateFleetSelector();
    populateJ2Coasts();
    renderCurrentElements();
    drawAnalysisChart();
    drawFleetChart();
    setAnalysisStatus("Mission changed. Refresh to analyze the local leg at the displayed time.");
  }

  function currentLocalLeg() {
    const current = currentSample();
    const vehicleResult = activeVehicleResult();
    if (!current || !vehicleResult || !vehicleResult.samples.length) return null;
    if (current.cr3bp) return { cr3bp: true, current, cen: current.cen,
      start: current.t, end: current.t, samples: [] };
    const all = vehicleResult.samples;
    let pivot = 0, best = Infinity;
    for (let index = 0; index < all.length; index++) {
      const sample = all[index];
      if (sample.cen !== current.cen || sample.cr3bp) continue;
      const distance = Math.abs(sample.t - S.tNow);
      if (distance < best) { best = distance; pivot = index; }
    }
    let first = pivot, last = pivot;
    while (first > 0 && all[first - 1].cen === current.cen && !all[first - 1].cr3bp) first--;
    while (last + 1 < all.length && all[last + 1].cen === current.cen && !all[last + 1].cr3bp) last++;
    const unique = [];
    for (let index = first; index <= last; index++) {
      const sample = all[index];
      if (!sample.r || !sample.v || !sample.r.every(isFinite) || !sample.v.every(isFinite)) continue;
      if (unique.length && sample.t <= unique[unique.length - 1].t) {
        if (sample.t === unique[unique.length - 1].t) unique[unique.length - 1] = sample;
        continue;
      }
      unique.push(sample);
    }
    if (!unique.length) return null;
    let samples = unique;
    if (samples.length > 6000) {
      const stride = Math.ceil(samples.length / 5999);
      samples = samples.filter((sample, index) => index % stride === 0 ||
        index === unique.length - 1);
    }
    return {
      cr3bp: false,
      current,
      cen: current.cen,
      start: unique[0].t,
      end: unique[unique.length - 1].t,
      samples,
      target: activeTarget(current.seg),
    };
  }

  function missionLocalLegs() {
    const vehicleResult = activeVehicleResult();
    if (!vehicleResult || !Array.isArray(vehicleResult.samples)) return [];
    const legs = [];
    let leg = null;
    for (const sample of vehicleResult.samples) {
      const usable = sample && !sample.cr3bp && sample.cen !== "sun" &&
        BODIES[sample.cen] && sample.r && sample.v &&
        sample.r.every(isFinite) && sample.v.every(isFinite);
      if (!usable) { leg = null; continue; }
      if (!leg || leg.cen !== sample.cen || sample.t < leg.end) {
        leg = { cen: sample.cen, start: sample.t, end: sample.t, samples: [sample] };
        legs.push(leg);
        if (legs.length >= 96) break;
      } else if (sample.t === leg.end) leg.samples[leg.samples.length - 1] = sample;
      else { leg.end = sample.t; leg.samples.push(sample); }
    }
    return legs.filter((item) => item.end > item.start && item.samples.length > 1);
  }

  function analysisTargetAt(leg, time) {
    if (!leg.target || !BODIES[leg.target]) return null;
    const jd = S.result.epochJD + time / DAY;
    return V.sub(A.bodyWorld(leg.target, jd), A.bodyWorld(leg.cen, jd));
  }

  function analysisRows() {
    if (!AN.series) return [];
    let rows = Array.from(AN.series.rows);
    const enabled = $("analysisJ2") && $("analysisJ2").checked;
    const coastIndex = $("j2Coast") && $("j2Coast").value !== ""
      ? +$("j2Coast").value : NaN;
    const coastRows = AN.leg && AN.leg.samples ? rows.filter((row) => {
      const sample = AN.leg.samples[row.sourceIndex];
      return sample && sample.seg === coastIndex;
    }) : [];
    const alreadyJ2 = AN.leg && AN.leg.samples && AN.leg.samples.some((sample) =>
      sample.seg === coastIndex && sample._interp === "j2");
    if (!enabled || alreadyJ2 || !AN.leg || AN.leg.cen !== "earth" || !coastRows.length) return rows;
    const first = coastRows[0];
    try {
      const rates = MA.j2SecularRates({ aKm: first.aKm, e: first.e,
        iDeg: first.iDeg });
      rows = rows.map((row) => {
        const sample = AN.leg.samples[row.sourceIndex];
        if (!sample || sample.seg !== coastIndex) return row;
        return { ...row,
          raanDeg: row.raanDeg + rates.raanRateDegDay * (row.timeS - first.timeS) / DAY,
          argPeriapsisDeg: row.argPeriapsisDeg + rates.argPeriapsisRateDegDay *
            (row.timeS - first.timeS) / DAY,
        };
      });
    } catch (error) {}
    return rows;
  }

  function elementCell(label, value) {
    return `<div class="element-cell"><label>${esc(label)}</label><strong>${esc(value)}</strong></div>`;
  }

  function renderCurrentElements() {
    const host = $("analysisElements"), j2 = $("j2Readout");
    if (!host || !S.result) return;
    const sample = currentSample();
    if (!sample) {
      host.innerHTML = '<span class="hint">No spacecraft state.</span>';
      if (j2) j2.textContent = "J2 unavailable without an Earth-centered state.";
      return;
    }
    if (sample.cr3bp) {
      let cj = null;
      try { cj = globalThis.CR3BP.jacobiConstant(
        globalThis.CR3BP.getSystem(sample.cr3bpSystem), sample.synodic); }
      catch (error) {}
      host.innerHTML = elementCell("Dynamics", "CR3BP / synodic") +
        elementCell("System", sample.cr3bpSystem || "—") +
        elementCell("Jacobi C", isFinite(cj) ? cj.toFixed(8) : "—") +
        elementCell("Canonical x, y", sample.synodic
          ? sample.synodic.slice(0, 2).map((value) => value.toFixed(6)).join(", ") : "—");
      if (j2) j2.textContent = "J2 projection is not applied to CR3BP states.";
      return;
    }
    const body = BODIES[sample.cen];
    if (!body || !(body.mu > 0)) return;
    const coe = A.rvToCoe(sample.r, sample.v, body.mu);
    const degrees = (value) => isFinite(value) ? (value / C.DEG).toFixed(3) + "°" : "—";
    const radiusText = (value) => isFinite(value)
      ? (sample.cen === "sun" ? (value / AU).toFixed(5) + " AU" : ME.fmtKm(value)) : "—";
    host.innerHTML =
      elementCell("Central body", body.name) +
      elementCell("Semi-major axis", radiusText(coe.a)) +
      elementCell("Eccentricity", isFinite(coe.e) ? coe.e.toFixed(7) : "—") +
      elementCell("Inclination", degrees(coe.i)) +
      elementCell("RAAN Ω", degrees(coe.Om)) +
      elementCell("Argument ω", degrees(coe.w)) +
      elementCell("True anomaly ν", degrees(coe.nu)) +
      elementCell("AP / PE radius", radiusText(coe.ra) + " / " + radiusText(coe.rp));
    if (!j2) return;
    if (sample.cen !== "earth" || !(coe.a > 0) || !(coe.e < 1)) {
      j2.textContent = "Available for bound Earth-centered osculating orbits. Analysis only; mission propagation is unchanged.";
      return;
    }
    try {
      const rates = MA.j2SecularRates({ aKm: coe.a, e: coe.e, iRad: coe.i });
      let sso = "SSO reference unavailable";
      try {
        const ref = MA.sunSynchronousInclination({ aKm: coe.a, e: coe.e });
        sso = `SSO reference ${ref.inclinationDeg.toFixed(3)}°`;
      } catch (error) {}
      const selectedCoast = $("j2Coast") && $("j2Coast").value !== ""
        ? +$("j2Coast").value : NaN;
      const alreadyJ2 = AN.leg && AN.leg.samples && AN.leg.samples.some((item) =>
        item.seg === selectedCoast && item._interp === "j2");
      j2.textContent = (alreadyJ2 ? "Selected leg already includes the J2 secular model. " : "") +
        `Ω̇ ${rates.raanRateDegDay.toFixed(5)} deg/day · ` +
        `ω̇ ${rates.argPeriapsisRateDegDay.toFixed(5)} deg/day · ${sso}. ` +
        "Chart preview is opt-in; Coast model changes use the explicit buttons above.";
    } catch (error) { j2.textContent = "J2 unavailable: " + error.message; }
  }

  function refreshAnalysis() {
    if (!analysisPresent()) {
      setAnalysisStatus("Analysis engine is unavailable. Reload the Planner.", "error");
      return;
    }
    refreshNativeFormationAnalysis(false);
    const leg = currentLocalLeg();
    AN.leg = leg;
    AN.eclipse = null;
    AN.access = null;
    buildEclipseBands();
    if (!leg) {
      AN.series = null; AN.rows = null;
      setAnalysisStatus("No analyzable spacecraft state at this time.", "error");
      renderCurrentElements(); drawAnalysisChart(); return;
    }
    if (leg.cr3bp) {
      AN.series = null; AN.rows = null;
      $("analysisCsv").disabled = true;
      setAnalysisStatus("CR3BP state selected. Two-body osculating elements and local-body reports are intentionally excluded; Jacobi C is shown instead.");
      renderCurrentElements(); drawAnalysisChart(); return;
    }
    try {
      const body = BODIES[leg.cen];
      AN.series = MA.extractOsculatingSeries({
        samples: leg.samples.map((sample) => ({ t: sample.t, r: sample.r,
          v: sample.v, jd: S.result.epochJD + sample.t / DAY })),
        mu: body.mu,
        radiusKm: body.radius,
        epochJD: S.result.epochJD,
        targetPositionAt: leg.target ? (time) => analysisTargetAt(leg, time) : undefined,
        maxPoints: 900,
      });
      AN.rows = analysisRows();
      $("analysisCsv").disabled = false;
      setAnalysisStatus(`${body.name} local leg · ${fmtMet(leg.start)} to ${fmtMet(leg.end)} · ` +
        `${AN.series.outputCount.toLocaleString()} chart points from ` +
        `${AN.series.sourceCount.toLocaleString()} states.`, "ready");
    } catch (error) {
      AN.series = null; AN.rows = null; $("analysisCsv").disabled = true;
      setAnalysisStatus("Analysis failed: " + error.message, "error");
    }
    renderCurrentElements();
    drawAnalysisChart();
  }

  function analysisPalette() {
    const cinematic = $("app") && $("app").dataset.theme === "cinematic";
    return cinematic
      ? { bg: "#090d17", grid: "rgba(255,255,255,.10)", text: "#9aa3b5",
          line: "#ff6a3d", fill: "rgba(255,106,61,.12)", current: "#ffffff" }
      : { bg: "#ffffff", grid: "rgba(28,29,32,.13)", text: "#55564f",
          line: "#e5541e", fill: "rgba(229,84,30,.10)", current: "#1c1d20" };
  }

  function seriesTime(row) { return Number.isFinite(row.timeS) ? row.timeS : row.t; }
  function chartValue(value, unit) {
    if (!isFinite(value)) return "—";
    const magnitude = Math.abs(value);
    const digits = magnitude >= 10000 ? 0 : magnitude >= 100 ? 1 : magnitude >= 1 ? 3 : 6;
    return value.toFixed(digits) + (unit ? " " + unit : "");
  }

  function drawLineChart(canvas, rows, key, options) {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (!(rect.width > 20)) return;
    const ratio = options && options.aspect || (canvas === $("fleetCanvas") ? 640 / 220 : 640 / 300);
    const cssW = rect.width, cssH = cssW / ratio;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pw = Math.max(2, Math.round(cssW * dpr)), ph = Math.max(2, Math.round(cssH * dpr));
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = pw / dpr, H = ph / dpr, pal = analysisPalette();
    ctx.clearRect(0, 0, W, H); ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, W, H);
    const usable = (rows || []).filter((row) => isFinite(seriesTime(row)) && isFinite(row[key]));
    if (!usable.length) {
      ctx.fillStyle = pal.text; ctx.font = "10px 'JetBrains Mono', monospace";
      ctx.fillText("NO SERIES FOR THIS METRIC", 12, 22);
      canvas._analysisPlot = null; return;
    }
    const left = 45, right = 10, top = 13, bottom = 28;
    const t0 = seriesTime(usable[0]), t1 = seriesTime(usable[usable.length - 1]);
    let lo = Math.min(...usable.map((row) => row[key]));
    let hi = Math.max(...usable.map((row) => row[key]));
    if (!(hi > lo)) { const pad = Math.max(Math.abs(lo) * .02, 1e-9); lo -= pad; hi += pad; }
    else { const pad = (hi - lo) * .08; lo -= pad; hi += pad; }
    const xOf = (time) => left + (time - t0) / Math.max(t1 - t0, 1) * (W - left - right);
    const yOf = (value) => top + (hi - value) / (hi - lo) * (H - top - bottom);
    ctx.strokeStyle = pal.grid; ctx.lineWidth = 1; ctx.fillStyle = pal.text;
    ctx.font = "8px 'JetBrains Mono', monospace";
    for (let index = 0; index <= 4; index++) {
      const y = top + index * (H - top - bottom) / 4;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(W - right, y); ctx.stroke();
      const value = hi - index * (hi - lo) / 4;
      ctx.fillText(chartValue(value, ""), 3, y + 3);
    }
    for (let index = 0; index <= 4; index++) {
      const x = left + index * (W - left - right) / 4;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, H - bottom); ctx.stroke();
      const seconds = t0 + index * (t1 - t0) / 4;
      const relative = seconds - t0;
      ctx.fillText((Math.abs(t1 - t0) >= 2 * DAY
        ? (relative / DAY).toFixed(1) + " d" : (relative / 3600).toFixed(1) + " h"),
      Math.max(2, Math.min(W - 34, x - 12)), H - 9);
    }
    ctx.beginPath();
    usable.forEach((row, index) => index ? ctx.lineTo(xOf(seriesTime(row)), yOf(row[key]))
      : ctx.moveTo(xOf(seriesTime(row)), yOf(row[key])));
    ctx.lineTo(xOf(seriesTime(usable[usable.length - 1])), H - bottom);
    ctx.lineTo(xOf(seriesTime(usable[0])), H - bottom); ctx.closePath();
    ctx.fillStyle = pal.fill; ctx.fill();
    ctx.beginPath();
    usable.forEach((row, index) => index ? ctx.lineTo(xOf(seriesTime(row)), yOf(row[key]))
      : ctx.moveTo(xOf(seriesTime(row)), yOf(row[key])));
    ctx.strokeStyle = pal.line; ctx.lineWidth = 1.7; ctx.stroke();
    const cursorTime = options && isFinite(options.cursorTime) ? options.cursorTime : null;
    if (cursorTime !== null && cursorTime >= t0 && cursorTime <= t1) {
      const x = xOf(cursorTime);
      ctx.strokeStyle = pal.current; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, H - bottom); ctx.stroke(); ctx.setLineDash([]);
    }
    if (options && Number.isInteger(options.hoverIndex) && usable[options.hoverIndex]) {
      const row = usable[options.hoverIndex], x = xOf(seriesTime(row)), y = yOf(row[key]);
      ctx.strokeStyle = pal.current; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, H - bottom); ctx.stroke();
      ctx.fillStyle = pal.line; ctx.beginPath(); ctx.arc(x, y, 3, 0, 2 * Math.PI); ctx.fill();
    }
    canvas._analysisPlot = { left, right, top, bottom, W, H, rows: usable, key, t0, t1 };
  }

  function drawAnalysisChart() {
    const canvas = $("analysisCanvas");
    if (!canvas) return;
    AN.rows = analysisRows();
    const key = $("analysisMetric") ? $("analysisMetric").value : "altitudeKm";
    drawLineChart(canvas, AN.rows, key, { cursorTime: S.tNow, hoverIndex: AN.hoverIndex });
  }

  function drawFleetChart() {
    const canvas = $("fleetCanvas");
    if (!canvas) return;
    const box = canvas.getBoundingClientRect();
    const cssW = Math.max(120, box.width || 640), cssH = Math.max(100, box.height || 220);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pw = Math.round(cssW * dpr), ph = Math.round(cssH * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    const ctx = canvas.getContext("2d"), pal = analysisPalette();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH); ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, cssW, cssH);
    const series = AN.fleetSeries.filter((entry) => entry.series && entry.series.samples.length);
    if (!series.length) {
      ctx.fillStyle = pal.text; ctx.font = "10px 'JetBrains Mono', monospace";
      ctx.fillText("ADD CRAFT TO PLOT RELATIVE RANGE", 12, 22); return;
    }
    const rows = series.flatMap((entry) => entry.series.samples);
    const t0 = Math.min(...rows.map((row) => row.t));
    const t1 = Math.max(...rows.map((row) => row.t));
    let lo = Math.min(...rows.map((row) => row.range));
    let hi = Math.max(...rows.map((row) => row.range));
    if (!(hi > lo)) { const pad = Math.max(1, Math.abs(lo) * .02); lo -= pad; hi += pad; }
    else { const pad = (hi - lo) * .08; lo = Math.max(0, lo - pad); hi += pad; }
    const left = 49, right = 11, top = 15, bottom = 28;
    const xOf = (time) => left + (time - t0) / Math.max(1, t1 - t0) * (cssW - left - right);
    const yOf = (value) => top + (hi - value) / Math.max(1e-12, hi - lo) *
      (cssH - top - bottom);
    ctx.strokeStyle = pal.grid; ctx.fillStyle = pal.text; ctx.lineWidth = 1;
    ctx.font = "8px 'JetBrains Mono', monospace";
    for (let index = 0; index <= 4; index++) {
      const y = top + index * (cssH - top - bottom) / 4;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(cssW - right, y); ctx.stroke();
      ctx.fillText(chartValue(hi - index * (hi - lo) / 4, ""), 3, y + 3);
    }
    for (let index = 0; index <= 4; index++) {
      const x = left + index * (cssW - left - right) / 4;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, cssH - bottom); ctx.stroke();
      const relative = index * (t1 - t0) / 4;
      ctx.fillText(Math.abs(t1 - t0) >= 2 * DAY ? (relative / DAY).toFixed(1) + " d"
        : (relative / 3600).toFixed(1) + " h", Math.max(2, x - 12), cssH - 9);
    }
    for (const entry of series) {
      ctx.beginPath();
      entry.series.samples.forEach((row, index) => index
        ? ctx.lineTo(xOf(row.t), yOf(row.range))
        : ctx.moveTo(xOf(row.t), yOf(row.range)));
      ctx.strokeStyle = entry.color; ctx.lineWidth = 1.7; ctx.stroke();
    }
    const cursor = S.tNow;
    if (cursor >= t0 && cursor <= t1) {
      const x = xOf(cursor); ctx.strokeStyle = pal.current; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, cssH - bottom); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function updateAnalysisLive() {
    const pane = $("dataPane");
    if (!pane || !pane.classList.contains("active")) return;
    renderCurrentElements();
    if (AN.leg && !AN.leg.cr3bp && (S.tNow < AN.leg.start || S.tNow > AN.leg.end))
      setAnalysisStatus("The displayed time moved to another central-body leg. Refresh to rebuild its reports.");
    else if (AN.leg && !AN.leg.cr3bp) {
      const sample = currentSample();
      if (sample && activeTarget(sample.seg) !== AN.leg.target)
        setAnalysisStatus("The active target changed within this body leg. Refresh to rebuild target-distance data.");
    }
    drawAnalysisChart();
    drawFleetChart();
  }

  function buildEclipseBands() {
    const host = $("eclipseBands");
    if (!host) return;
    host.innerHTML = "";
    const active = activeVehicleResult();
    const bounds = resultTimeBounds(active);
    const span = bounds.end - bounds.start;
    if (!AN.eclipse || !active || !(span > 0)) return;
    for (const interval of AN.eclipse.phases) {
      const band = document.createElement("span");
      band.className = "eclipse-band " + interval.type;
      const start = Math.max(bounds.start, interval.startTimeS);
      const end = Math.min(bounds.end, interval.endTimeS);
      band.style.left = (100 * (start - bounds.start) / span).toFixed(5) + "%";
      band.style.width = (100 * Math.max(0, end - start) / span).toFixed(5) + "%";
      band.title = interval.type.toUpperCase() + " " + fmtMet(start) + " to " + fmtMet(end);
      host.appendChild(band);
    }
  }

  function durationText(seconds) {
    if (!isFinite(seconds)) return "—";
    if (seconds >= DAY) return (seconds / DAY).toFixed(2) + " d";
    if (seconds >= 3600) return (seconds / 3600).toFixed(2) + " h";
    if (seconds >= 60) return (seconds / 60).toFixed(1) + " min";
    return seconds.toFixed(1) + " s";
  }

  function computeEclipseReport() {
    if (!MA || !S.result) return;
    const vehicleResult = activeVehicleResult();
    const legs = missionLocalLegs();
    if (!legs.length) {
      $("eclipseSummary").textContent = "This mission has no finite planet/moon-centered leg.";
      $("eclipseIntervals").innerHTML = ""; AN.eclipse = null; buildEclipseBands(); return;
    }
    try {
      const phases = [];
      let umbraS = 0, partialPenumbraS = 0, penumbraEnvelopeS = 0, analyzedS = 0;
      for (const leg of legs) {
        const body = BODIES[leg.cen];
        const step = Math.max(1, Math.min(3600, (leg.end - leg.start) / 500));
        const report = MA.eclipseIntervals({
          spacecraftPositionAt: (time) => {
            const sample = ME.sampleAtTime(vehicleResult, time);
            return sample && sample.w;
          },
          lightPositionAt: (time) => A.bodyWorld("sun",
            vehicleResult.epochJD + time / DAY),
          occulterPositionAt: (time) => A.bodyWorld(leg.cen,
            vehicleResult.epochJD + time / DAY),
          lightRadiusKm: BODIES.sun.radius,
          occulterRadiusKm: body.radius,
          startTimeS: leg.start,
          endTimeS: leg.end,
          stepS: step,
          epochJD: vehicleResult.epochJD,
        });
        analyzedS += leg.end - leg.start;
        umbraS += report.totals.umbraS;
        partialPenumbraS += report.totals.partialPenumbraS;
        penumbraEnvelopeS += report.totals.penumbraEnvelopeS;
        report.phases.forEach((phase) => phases.push({ ...phase,
          bodyId: leg.cen, bodyName: body.name }));
      }
      phases.sort((a, b) => a.startTimeS - b.startTimeS || a.type.localeCompare(b.type));
      AN.eclipse = { phases, totals: { umbraS, partialPenumbraS,
        penumbraEnvelopeS, analyzedS }, legs: legs.length };
      const umbraFraction = analyzedS > 0 ? 100 * umbraS / analyzedS : 0;
      $("eclipseSummary").textContent = `Mission total across ${legs.length} local leg` +
        `${legs.length === 1 ? "" : "s"} · umbra ${durationText(umbraS)} ` +
        `(${umbraFraction.toFixed(1)}% of analyzed local flight) · partial penumbra ` +
        `${durationText(partialPenumbraS)} · ${phases.length} interval` +
        `${phases.length === 1 ? "" : "s"}.`;
      $("eclipseIntervals").innerHTML = phases.length
        ? '<table class="analysis-table"><thead><tr><th>Body</th><th>Type</th><th>Start</th><th>End</th><th>Duration</th></tr></thead><tbody>' +
          phases.slice(0, 300).map((interval) => `<tr><td>${esc(interval.bodyName)}</td>` +
            `<td>${esc(interval.type)}</td><td>${esc(fmtMet(interval.startTimeS))}</td>` +
            `<td>${esc(fmtMet(interval.endTimeS))}</td>` +
            `<td>${esc(durationText(interval.durationS))}</td></tr>`).join("") + "</tbody></table>"
        : '<span class="hint">No eclipse occurred on the analyzed local legs.</span>';
      buildEclipseBands();
    } catch (error) {
      AN.eclipse = null; buildEclipseBands();
      $("eclipseSummary").textContent = "Eclipse analysis failed: " + error.message;
    }
  }

  function computeAccessReport() {
    if (!MA) return;
    const vehicleResult = activeVehicleResult();
    if (!AN.leg || S.tNow < AN.leg.start || S.tNow > AN.leg.end) refreshAnalysis();
    const leg = AN.leg;
    if (!leg || leg.cr3bp || leg.cen === "sun" || !(leg.end > leg.start)) {
      $("accessReport").innerHTML = '<span class="hint">Select a finite planet/moon-centered leg.</span>';
      $("accessCsv").disabled = true; AN.access = null; AN.accessConfidence = null; return;
    }
    try {
      const mask = Math.min(89, Math.max(0, +$("accessMask").value || 0));
      const stations = stationsForBody(leg.cen, mask);
      if (!stations.length) {
        $("accessReport").innerHTML = `<span class="hint">No ${esc(BODIES[leg.cen].name)} ` +
          `stations are configured. Add one in Station catalog.</span>`;
        $("accessCsv").disabled = true; AN.access = null; AN.accessConfidence = null; return;
      }
      AN.access = MA.groundStationAccess({
        spacecraftPositionAt: (time) => {
          const sample = ME.sampleAtTime(vehicleResult, time);
          return sample && sample.r;
        },
        bodyId: leg.cen,
        stations,
        epochJD: vehicleResult.epochJD,
        startTimeS: leg.start,
        endTimeS: leg.end,
        stepS: Math.max(2, Math.min(900, (leg.end - leg.start) / 600)),
      });
      AN.accessConfidence = AN.access.intervals.map((interval, index) => index < 500
        ? eventEpochDispersion(leg.cen, interval.maxElevationTimeS) : null);
      $("accessCsv").disabled = !AN.access.intervals.length;
      const displayedIntervals = AN.access.intervals.slice(0, 250);
      const confidenceCount = AN.accessConfidence.filter(Boolean).length;
      const table = displayedIntervals.length
        ? '<table class="analysis-table"><thead><tr><th>Station</th><th>Rise</th><th>Set</th><th>Duration</th><th>Max el.</th><th>Primary pos. est. 95% bound</th></tr></thead><tbody>' +
          displayedIntervals.map((interval, index) => `<tr>` +
            `<td>${esc(interval.stationName)}</td>` +
            `<td>${esc(fmtMet(interval.startTimeS))}</td><td>${esc(fmtMet(interval.endTimeS))}</td>` +
            `<td>${esc(durationText(interval.durationS))}</td>` +
            `<td>${interval.maxElevationDeg.toFixed(1)}°</td>` +
            `<td>${AN.accessConfidence[index]
              ? esc(fmtUncertaintyDistance(AN.accessConfidence[index].radiusKm))
              : "—"}</td></tr>`).join("") + "</tbody></table>"
        : '<span class="hint">No station passes above their elevation masks on this leg.</span>';
      const eventContext = confidenceCount
        ? `Linearized primary covariance was propagated to ${confidenceCount} pass maximum-elevation ` +
          `epoch${confidenceCount === 1 ? "" : "s"}; rise/set times remain nominal.`
        : "No pass maximum occurred inside the supported covariance interval; rise/set times remain nominal.";
      $("accessReport").innerHTML = table + uncertaintyContextMarkup(leg.cen, eventContext);
    } catch (error) {
      AN.access = null; AN.accessConfidence = null; $("accessCsv").disabled = true;
      $("accessReport").textContent = "Access analysis failed: " + error.message;
    }
  }

  function stationBodyOptions(selected) {
    const bodies = Object.values(BODIES).filter((body) => body.id !== "sun" &&
      body.radius > 0).sort((a, b) => a.name.localeCompare(b.name));
    return bodies.map((body) => `<option value="${esc(body.id)}" ` +
      `${body.id === selected ? "selected" : ""}>${esc(body.name)}</option>`).join("");
  }

  function renderStationEditor(message, error) {
    const list = $("stationList"), status = $("stationEditorStatus");
    if (!list) return;
    const dsn = MA ? MA.DSN_STATIONS.map((station) =>
      `<div class="station-row fixed"><span class="station-swatch"></span><span>` +
      `<strong>${esc(station.complex)}</strong><small>Earth · ${station.latDeg.toFixed(3)}°, ` +
      `${station.lonDeg.toFixed(3)}° · DSN</small></span><span class="station-lock">fixed</span></div>`).join("") : "";
    const user = AN.userStations.map((station) =>
      `<div class="station-row" data-station-id="${esc(station.id)}">` +
      `<span class="station-swatch user"></span><span><strong>${esc(station.name)}</strong>` +
      `<small>${esc(BODIES[station.bodyId].name)} · ${(+station.latDeg).toFixed(3)}°, ` +
      `${(+station.lonDeg).toFixed(3)}° · ${(+station.altKm).toFixed(2)} km · mask ` +
      `${(+station.elevationMaskDeg).toFixed(1)}°</small></span>` +
      `<button type="button" data-remove-station="${esc(station.id)}" aria-label="Remove ${esc(station.name)}">Remove</button></div>`).join("");
    list.innerHTML = dsn + user || '<span class="hint">No stations configured.</span>';
    if (status && message) {
      status.textContent = message;
      status.className = "analysis-readout" + (error ? " error" : " success");
    }
  }

  function addUserStation() {
    const name = String($("stationName") ? $("stationName").value : "").trim();
    const bodyId = $("stationBody") ? $("stationBody").value : "earth";
    const latDeg = +($("stationLat") && $("stationLat").value);
    const lonDeg = +($("stationLon") && $("stationLon").value);
    const altKm = +($("stationAlt") && $("stationAlt").value);
    const elevationMaskDeg = +($("stationMask") && $("stationMask").value);
    const body = BODIES[bodyId];
    if (!name || name.length > 48 || !body || bodyId === "sun" ||
        ![latDeg, lonDeg, altKm, elevationMaskDeg].every(Number.isFinite) ||
        latDeg < -90 || latDeg > 90 || lonDeg < -180 || lonDeg > 180 ||
        elevationMaskDeg < 0 || elevationMaskDeg >= 90 || body.radius + altKm <= 0) {
      renderStationEditor("Enter a name, valid body, latitude [-90, 90], longitude [-180, 180], altitude, and mask [0, 90).", true);
      return;
    }
    if (AN.userStations.length >= MAX_USER_STATIONS) {
      renderStationEditor(`Station cap reached (${MAX_USER_STATIONS}). Remove one before adding another.`, true);
      return;
    }
    const id = "user-" + Date.now().toString(36) + "-" +
      Math.floor(Math.random() * 1679616).toString(36).padStart(4, "0");
    AN.userStations.push({ id, name, bodyId, latDeg, lonDeg, altKm,
      elevationMaskDeg, complex: null });
    writeUserStations();
    if ($("stationName")) $("stationName").value = "";
    renderStationEditor(`${name} added to ${body.name}.`);
    gtLastDraw = 0;
  }

  function removeUserStation(id) {
    const index = AN.userStations.findIndex((station) => station.id === id);
    if (index < 0) return;
    const removed = AN.userStations.splice(index, 1)[0];
    writeUserStations();
    renderStationEditor(`${removed.name} removed.`);
    gtLastDraw = 0;
  }

  function applyMissionOperations(mission) {
    AN.userStations = AN.userStations.filter((station) => !station.preset);
    const operations = mission && mission.operations;
    if (!operations) {
      renderStationEditor();
      return;
    }
    const setValue = (id, value) => {
      const element = $(id);
      if (element && value !== undefined && value !== null) element.value = value;
    };
    const setChecked = (id, value) => {
      const element = $(id);
      if (element && value !== undefined) element.checked = Boolean(value);
    };
    setValue("gtFov", operations.sensorFovDeg);
    setValue("gtOffNadir", operations.sensorOffNadirDeg);
    setChecked("gtSwath", operations.sensorSwath);
    setChecked("gtStations", operations.stationMarkers);
    setChecked("eclipse3d", operations.eclipse3d);
    if (operations.eclipse3d !== undefined)
      S.options.shadowCones = Boolean(operations.eclipse3d);
    setValue("fleetThreshold", operations.conjunctionThresholdKm);
    if (Array.isArray(operations.stations)) {
      for (const station of operations.stations.slice(0, MAX_USER_STATIONS)) {
        if (AN.userStations.length >= MAX_USER_STATIONS) break;
        if (!station || !BODIES[station.bodyId]) continue;
        const id = String(station.id || "preset-station");
        if (AN.userStations.some((item) => item.id === id)) continue;
        AN.userStations.push({ ...station, id, preset: true });
      }
    }
    renderStationEditor("Preset operations defaults loaded.");
    gtLastDraw = 0;
    if (operations.comparisonPreset && $("fleetMission")) {
      const value = "preset:" + operations.comparisonPreset;
      if (Array.from($("fleetMission").options).some((option) => option.value === value)) {
        $("fleetMission").value = value;
        if ($("fleetAlignEpoch")) $("fleetAlignEpoch").checked = true;
        analyzeComparisonCraft();
      }
    }
  }

  function populateFleetSelector() {
    const select = $("fleetMission");
    if (!select || !globalThis.Missions) return;
    const previous = select.value;
    const presets = globalThis.Missions.PRESETS.map((mission) =>
      `<option value="preset:${esc(mission.id)}">Preset · ${esc(mission.name)}</option>`).join("");
    const saved = Object.keys(missionStore()).sort().map((name) =>
      `<option value="saved:${encodeURIComponent(name)}">Saved · ${esc(name)}</option>`).join("");
    select.innerHTML = presets + saved;
    if (Array.from(select.options).some((option) => option.value === previous)) select.value = previous;
  }

  function populateJ2Coasts() {
    const select = $("j2Coast");
    if (!select || !S.mission || !S.result) return;
    const previous = select.value;
    const options = [];
    const segments = activeSegments();
    const vehicleResult = activeVehicleResult();
    segments.forEach((segment, index) => {
      if (segment.type !== "coast") return;
      const sample = vehicleResult.samples.find((item) => item.seg === index && item.cen === "earth" &&
        !item.cr3bp && item.r && item.v);
      if (!sample) return;
      const coe = A.rvToCoe(sample.r, sample.v, BODIES.earth.mu);
      if (!(coe.a > 0) || !(coe.e < 1)) return;
      options.push(`<option value="${index}">#${index + 1} Coast · ` +
        `${esc(segment.mode || "kepler")}</option>`);
    });
    select.innerHTML = options.length ? options.join("")
      : '<option value="">No bound Earth Coast</option>';
    if (options.length && Array.from(select.options).some((option) => option.value === previous))
      select.value = previous;
    const disabled = !options.length;
    if ($("j2Apply")) $("j2Apply").disabled = disabled;
    if ($("j2Kepler")) $("j2Kepler").disabled = disabled;
  }

  function applyJ2CoastMode(mode) {
    const select = $("j2Coast");
    const index = select ? +select.value : NaN;
    const segment = Number.isInteger(index) && activeSegments()[index];
    if (!segment || segment.type !== "coast") {
      banner("Select a bound Earth Coast before changing its propagation model.", true); return;
    }
    segment.mode = mode;
    recompute(true);
    refreshAnalysis();
    banner(`Segment #${index + 1} now uses ${mode === "j2-secular"
      ? "first-order Earth J2 secular propagation" : "Kepler propagation"}.`);
  }

  function selectedComparisonMission() {
    const value = $("fleetMission") && $("fleetMission").value;
    if (!value) return null;
    if (value.startsWith("preset:")) return globalThis.Missions.getPreset(value.slice(7));
    if (value.startsWith("saved:")) {
      const saved = missionStore()[decodeURIComponent(value.slice(6))];
      return saved ? JSON.parse(JSON.stringify(saved)) : null;
    }
    return null;
  }

  function refreshNativeFormationAnalysis(force) {
    const active = activeVehicleResult();
    const results = S.result && S.result.vehicleResults;
    const host = $("formationReadout");
    if (!MM || !active || !results) {
      AN.nativeFormation = [];
      AN.nativeConjunctionEvents = [];
      if (host && !MM) host.textContent = "Relative-motion analysis engine is unavailable.";
      return;
    }
    const threshold = Math.max(0.001, +($("fleetThreshold") && $("fleetThreshold").value) ||
      +(S.mission.operations && S.mission.operations.conjunctionThresholdKm) || 100);
    const targets = Object.values(results).filter((result) =>
      result.id !== active.id && result.samples && result.samples.length);
    const key = `${S.activeVehicleId}|${threshold}|` + targets.map((result) =>
      `${result.id}:${result.samples.length}:${result.tEnd}`).join("|");
    if (!force && AN.nativeFormationKey === key) return;
    AN.nativeFormationKey = key;
    AN.nativeFormation = [];
    AN.nativeConjunctionEvents = [];
    if (!active.samples || !active.samples.length || !targets.length) {
      updateFormationReadout(currentSample());
      buildTicks();
      return;
    }
    const selected = { id: active.id, name: active.name, result: active,
      sampler: ME.sampleAtTime };
    const options = {
      maxSamples: 801,
      initialIntervals: 48,
      maxDepth: 9,
      rangeToleranceKm: 0.001,
      relativeTolerance: 1e-6,
      maxEvaluations: 12000,
      timeTolerance: 0.01,
    };
    for (const target of targets) {
      const descriptor = { id: target.id, name: target.name, result: target,
        sampler: ME.sampleAtTime };
      try {
        const closest = MM.findClosestApproach(selected, descriptor, options);
        const conjunctions = MM.findConjunctions(selected, descriptor, {
          ...options, thresholdKm: threshold, maxIntervals: 128,
        });
        AN.nativeFormation.push({ targetId: target.id, targetName: target.name,
          color: target.color, closest, conjunctions, thresholdKm: threshold });
        for (const event of conjunctions.events) {
          const localTime = conjunctions.referenceEpochJD === null
            ? event.t
            : (conjunctions.referenceEpochJD + event.t / DAY - active.epochJD) * DAY;
          const action = event.type === "conjunction-entry" ? "ENTRY" :
            event.type === "conjunction-exit" ? "EXIT" : "CLOSEST";
          const detail = event.type === "closest-approach" && isFinite(event.range)
            ? ` - ${ME.fmtKm(event.range)}` : ` - threshold ${ME.fmtKm(threshold)}`;
          AN.nativeConjunctionEvents.push({ kind: "conjunction", t: localTime,
            label: `${action} - ${active.name} / ${target.name}${detail}`,
            vehicleId: active.id, targetVehicle: target.id, color: target.color });
        }
      } catch (error) {
        AN.nativeFormation.push({ targetId: target.id, targetName: target.name,
          color: target.color, error: error.message, thresholdKm: threshold });
      }
    }
    AN.nativeConjunctionEvents.sort((left, right) => left.t - right.t ||
      left.label.localeCompare(right.label));
    updateFormationReadout(currentSample());
    buildTicks();
  }

  function selectedComparisonKey() {
    return $("fleetMission") ? $("fleetMission").value : "";
  }

  function comparisonDescriptors(comparison) {
    const active = activeVehicleResult();
    const definition = activeVehicleDefinition();
    const compared = comparison.result && comparison.result.vehicleResults
      ? comparison.result.vehicleResults.primary : comparison.result;
    return [{ id: S.activeVehicleId, name: definition && definition.name || S.mission.name,
      result: active,
      sampler: ME.sampleAtTime },
    { id: comparison.id || "comparison", name: comparison.mission.name, result: compared,
      sampler: ME.sampleAtTime }];
  }

  const FLEET_COLORS = ["#e95420", "#276db5", "#178578", "#7253aa",
    "#a86d00", "#b73345", "#347d43"];

  function syncFleetAliases() {
    const first = AN.crafts[0] || null;
    AN.comparison = first;
    AN.comparisonSeries = first ? first.series : null;
    AN.comparisonClosest = first ? first.closest : null;
    AN.conjunctions = first ? first.conjunctions : null;
    AN.fleetSeries = AN.crafts.map((craft) => ({ id: craft.id,
      name: craft.mission.name, color: craft.color, series: craft.series }));
    AN.conjunctionEvents = [];
    for (const craft of AN.crafts) {
      const report = craft.conjunctions;
      if (!report || !Array.isArray(report.events) || !isFinite(report.referenceEpochJD)) continue;
      for (const event of report.events) {
      const active = activeVehicleResult();
      const bounds = resultTimeBounds(active);
      const localTime = (report.referenceEpochJD + event.t / DAY - active.epochJD) * DAY;
      if (localTime < bounds.start || localTime > bounds.end) continue;
        const action = event.type === "conjunction-entry" ? "ENTRY" :
          event.type === "conjunction-exit" ? "EXIT" : "CLOSEST";
        const detail = event.type === "closest-approach" && isFinite(event.range)
          ? ` · ${ME.fmtKm(event.range)}` : ` · threshold ${ME.fmtKm(report.thresholdKm)}`;
        AN.conjunctionEvents.push({ kind: "conjunction", t: localTime,
          label: `${action} · ${S.mission.name} / ${craft.mission.name}${detail}`,
          craftId: craft.id, color: craft.color });
      }
    }
    AN.conjunctionEvents.sort((a, b) => a.t - b.t || a.label.localeCompare(b.label));
  }

  function renderFleetManager() {
    const host = $("fleetList");
    if (!host) return;
    if (!AN.crafts.length) {
      host.innerHTML = '<div class="fleet-row primary"><span class="fleet-color primary"></span>' +
        `<span><strong>${esc(S.mission ? S.mission.name : "Primary craft")}</strong>` +
        '<small>primary mission</small></span></div>';
      return;
    }
    host.innerHTML = '<div class="fleet-row primary"><span class="fleet-color primary"></span>' +
      `<span><strong>${esc(S.mission.name)}</strong><small>primary mission</small></span></div>` +
      AN.crafts.map((craft) => `<div class="fleet-row" data-craft-id="${esc(craft.id)}">` +
        `<input class="fleet-color-input" type="color" value="${esc(craft.color)}" ` +
        `data-fleet-color="${esc(craft.id)}" aria-label="Color for ${esc(craft.mission.name)}">` +
        `<span><strong>${esc(craft.mission.name)}</strong><small>` +
        `${craft.alignEpoch ? "T+0 aligned" : "historical epoch"} · ` +
        `${craft.series.samples.length.toLocaleString()} samples</small></span>` +
        `<button type="button" data-remove-craft="${esc(craft.id)}" ` +
        `aria-label="Remove ${esc(craft.mission.name)}">Remove</button></div>`).join("");
  }

  function refreshFleetSummary() {
    const report = $("fleetReport");
    if (!report) return;
    if (!AN.crafts.length) {
      report.textContent = "No comparison craft added."; return;
    }
    report.innerHTML = AN.crafts.map((craft) => {
      const closest = craft.closest;
      const count = craft.conjunctions.intervals.length;
      const primaryTime = Number.isFinite(closest.jd)
        ? (closest.jd - S.result.epochJD) * DAY : closest.t;
      const primarySample = ME.sampleAtTime(activeVehicleResult(), primaryTime);
      const eventDispersion = primarySample &&
        eventEpochDispersion(primarySample.cen, primaryTime);
      let confidence = '<small class="fleet-confidence">Nominal relative geometry; ' +
        'no time-correlated covariance screening applied.</small>';
      if (eventDispersion) {
        const threshold = craft.conjunctions.thresholdKm;
        const lowerRange = Math.max(0, closest.range - eventDispersion.radiusKm);
        const screening = lowerRange <= threshold
          ? `The conservative primary bound overlaps the ${esc(ME.fmtKm(threshold))} threshold; ` +
            `this screen cannot rule out a threshold crossing.`
          : `Nominal range minus that conservative primary bound is ${esc(ME.fmtKm(lowerRange))}, outside the ` +
            `${esc(ME.fmtKm(threshold))} threshold.`;
        confidence = `<small class="fleet-confidence">First-order primary position estimated-95% ` +
          `max-axis upper bound ` +
          `${esc(fmtUncertaintyDistance(eventDispersion.radiusKm))} at this closest-approach epoch. ` +
          `${screening} Comparison-craft covariance is not modeled.</small>`;
      }
      return `<div class="fleet-summary"><strong style="color:${esc(craft.color)}">` +
        `${esc(craft.mission.name)}</strong><span>Closest ${esc(ME.fmtKm(closest.range))} at ` +
        `${esc(closest.jd ? A.jdToStr(closest.jd) : fmtMet(closest.t))} · ${count} conjunction ` +
        `interval${count === 1 ? "" : "s"}${confidence}</span></div>`;
    }).join("");
  }

  function analyzeComparisonCraft() {
    if (!MM) {
      $("fleetReport").textContent = "Multi-spacecraft analysis engine is unavailable."; return;
    }
    const mission = selectedComparisonMission();
    const sourceKey = selectedComparisonKey();
    if (!mission) { $("fleetReport").textContent = "Select a comparison mission."; return; }
    const existingIndex = AN.crafts.findIndex((craft) => craft.sourceKey === sourceKey);
    if (existingIndex < 0 && AN.crafts.length >= 7) {
      $("fleetReport").textContent = "Fleet cap reached: primary plus seven comparison craft."; return;
    }
    try {
      const sourceEpoch = mission.epoch;
      const alignEpoch = !$("fleetAlignEpoch") || $("fleetAlignEpoch").checked;
      if (alignEpoch) mission.epoch = S.mission.epoch;
      mission.spacecraft = Object.assign(defaultSpacecraft(), mission.spacecraft || {});
      const missionResult = ME.recompute(mission);
      const result = missionResult.vehicleResults && missionResult.vehicleResults.primary || missionResult;
      const craftId = "fleet-" + sourceKey.replace(/[^a-z0-9_-]/gi, "-");
      const comparison = { id: craftId, sourceKey, mission, result, missionResult, alignEpoch,
        color: existingIndex >= 0 ? AN.crafts[existingIndex].color
          : FLEET_COLORS[AN.crafts.length % FLEET_COLORS.length] };
      const descriptors = comparisonDescriptors(comparison);
      const options = { maxSamples: 1201, initialIntervals: 32, maxDepth: 9,
        rangeToleranceKm: 10, relativeTolerance: 1e-5, maxEvaluations: 12000,
        timeTolerance: .1 };
      comparison.series = MM.relativeSeries(descriptors[0], descriptors[1], options);
      comparison.closest = MM.findClosestApproach(descriptors[0], descriptors[1], options);
      const threshold = Math.max(.001, +$("fleetThreshold").value || 100);
      comparison.conjunctions = MM.findConjunctions(descriptors[0], descriptors[1], {
        ...options, thresholdKm: threshold, maxIntervals: 128,
      });
      if (existingIndex >= 0) AN.crafts[existingIndex] = comparison;
      else AN.crafts.push(comparison);
      syncFleetAliases();
      $("fleetRemove").disabled = false;
      $("fleetCsv").disabled = false;
      comparison.sourceEpoch = sourceEpoch;
      renderFleetManager(); refreshFleetSummary(); buildTicks();
      drawFleetChart();
    } catch (error) {
      $("fleetReport").textContent = "Comparison unavailable: " + error.message;
      drawFleetChart();
    }
  }

  function removeComparisonCraft(id) {
    let index = typeof id === "string" ? AN.crafts.findIndex((craft) => craft.id === id) : -1;
    if (index < 0) {
      const selected = selectedComparisonKey();
      index = AN.crafts.findIndex((craft) => craft.sourceKey === selected);
    }
    if (index < 0) index = AN.crafts.length - 1;
    if (index >= 0) AN.crafts.splice(index, 1);
    syncFleetAliases(); renderFleetManager(); refreshFleetSummary(); buildTicks();
    if ($("fleetRemove")) $("fleetRemove").disabled = !AN.crafts.length;
    if ($("fleetCsv")) $("fleetCsv").disabled = !AN.crafts.length;
    drawFleetChart();
  }

  function resizeAnalysisCanvases() {
    drawAnalysisChart(); drawFleetChart(); drawUncertaintyChart();
  }

  function initAnalysisUI() {
    if (!$("dataPane")) return;
    AN.userStations = readUserStations();
    if ($("stationBody")) {
      $("stationBody").innerHTML = stationBodyOptions("earth");
      $("stationBody").value = "earth";
    }
    renderStationEditor();
    renderFleetManager();
    populateFleetSelector();
    if ($("uncRun")) $("uncRun").addEventListener("click", runUncertainty);
    ["uncPosX", "uncPosY", "uncPosZ", "uncVelX", "uncVelY", "uncVelZ",
      "uncDvR", "uncDvT", "uncDvN", "uncMagPct", "uncPointDeg", "uncTimingS",
      "uncSamples", "uncSeed", "uncHours"].forEach((id) => {
      const input = $(id);
      if (!input) return;
      input.addEventListener("input", () => {
        const run = $("uncRun");
        if (!AN.uncertainty && !(run && run.disabled)) return;
        clearUncertaintyOutput("Assumptions changed. Run dispersion again before using confidence results.");
        if (AN.access && AN.leg) computeAccessReport();
        if (AN.crafts.length) refreshFleetSummary();
      });
    });
    if ($("analysisRefresh")) $("analysisRefresh").addEventListener("click", refreshAnalysis);
    if ($("analysisMetric")) $("analysisMetric").addEventListener("change", () => {
      AN.hoverIndex = null; drawAnalysisChart();
    });
    if ($("analysisJ2")) $("analysisJ2").addEventListener("change", () => {
      AN.hoverIndex = null; AN.rows = analysisRows(); drawAnalysisChart(); renderCurrentElements();
    });
    if ($("j2Coast")) $("j2Coast").addEventListener("change", () => {
      AN.hoverIndex = null; AN.rows = analysisRows(); drawAnalysisChart(); renderCurrentElements();
    });
    if ($("j2Apply")) $("j2Apply").addEventListener("click", () =>
      applyJ2CoastMode("j2-secular"));
    if ($("j2Kepler")) $("j2Kepler").addEventListener("click", () =>
      applyJ2CoastMode("kepler"));
    if ($("eclipseCompute")) $("eclipseCompute").addEventListener("click", computeEclipseReport);
    if ($("eclipse3d")) $("eclipse3d").addEventListener("change", (event) => {
      S.options.shadowCones = event.target.checked;
    });
    if ($("accessCompute")) $("accessCompute").addEventListener("click", computeAccessReport);
    if ($("stationAdd")) $("stationAdd").addEventListener("click", addUserStation);
    if ($("stationList")) $("stationList").addEventListener("click", (event) => {
      const button = event.target.closest("[data-remove-station]");
      if (button) removeUserStation(button.dataset.removeStation);
    });
    if ($("fleetAdd")) $("fleetAdd").addEventListener("click", analyzeComparisonCraft);
    if ($("fleetRemove")) $("fleetRemove").addEventListener("click", removeComparisonCraft);
    if ($("fleetList")) {
      $("fleetList").addEventListener("click", (event) => {
        const button = event.target.closest("[data-remove-craft]");
        if (button) removeComparisonCraft(button.dataset.removeCraft);
      });
      $("fleetList").addEventListener("input", (event) => {
        const input = event.target.closest("[data-fleet-color]");
        if (!input || !/^#[0-9a-f]{6}$/i.test(input.value)) return;
        const craft = AN.crafts.find((item) => item.id === input.dataset.fleetColor);
        if (!craft) return;
        craft.color = input.value;
        syncFleetAliases(); refreshFleetSummary(); drawFleetChart();
      });
    }
    if ($("fleetThreshold")) $("fleetThreshold").addEventListener("change", () => {
      AN.nativeFormationKey = "";
      refreshNativeFormationAnalysis(true);
    });

    const chart = $("analysisCanvas"), tooltip = $("analysisTooltip");
    if (chart) {
      chart.addEventListener("pointermove", (event) => {
        const plot = chart._analysisPlot;
        if (!plot) return;
        const rect = chart.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const ratio = Math.max(0, Math.min(1, (x - plot.left) /
          Math.max(1, plot.W - plot.left - plot.right)));
        const wanted = plot.t0 + ratio * (plot.t1 - plot.t0);
        let bestIndex = 0, distance = Infinity;
        plot.rows.forEach((row, index) => {
          const candidate = Math.abs(seriesTime(row) - wanted);
          if (candidate < distance) { distance = candidate; bestIndex = index; }
        });
        AN.hoverIndex = bestIndex; drawAnalysisChart();
        const row = plot.rows[bestIndex], metric = ANALYSIS_METRICS[plot.key] || { label: plot.key, unit: "" };
        if (tooltip) {
          tooltip.hidden = false;
          tooltip.textContent = `${fmtMet(seriesTime(row))} · ${metric.label} ` +
            chartValue(row[plot.key], metric.unit);
          const maxLeft = Math.max(4, rect.width - tooltip.offsetWidth - 4);
          tooltip.style.left = Math.min(maxLeft, Math.max(4, x + 10)) + "px";
          tooltip.style.top = Math.max(4, event.clientY - rect.top - 32) + "px";
        }
      });
      chart.addEventListener("pointerleave", () => {
        AN.hoverIndex = null; if (tooltip) tooltip.hidden = true; drawAnalysisChart();
      });
    }
    if ($("analysisCsv")) $("analysisCsv").addEventListener("click", () => {
      const rows = analysisRows();
      if (!rows.length) return;
      const csv = MA.rowsToCSV(AN.series.columns, rows);
      download(fileStem() + "_analysis.csv", new Blob([csv], { type: "text/csv" }));
    });
    if ($("accessCsv")) $("accessCsv").addEventListener("click", () => {
      if (!AN.access) return;
      const columns = ["station", "rise_utc", "set_utc", "duration_s",
        "max_elevation_deg", "primary_position_95_km_at_max_elevation"];
      const rows = AN.access.intervals.map((interval, index) => ({
        station: interval.stationName,
        rise_utc: A.jdToStr(interval.startJD),
        set_utc: A.jdToStr(interval.endJD),
        duration_s: interval.durationS,
        max_elevation_deg: interval.maxElevationDeg,
        primary_position_95_km_at_max_elevation:
          AN.accessConfidence && AN.accessConfidence[index]
            ? AN.accessConfidence[index].radiusKm : "",
      }));
      download(fileStem() + "_dsn_access.csv", new Blob([MA.rowsToCSV(columns, rows)],
        { type: "text/csv" }));
    });
    if ($("fleetCsv")) $("fleetCsv").addEventListener("click", () => {
      if (!AN.fleetSeries.length) return;
      const columns = ["craft", "time_s", "jd", "range_km", "range_rate_km_s"];
      const rows = AN.fleetSeries.flatMap((entry) => entry.series.samples.map((sample) => ({
        craft: entry.name,
        time_s: sample.t,
        jd: entry.series.referenceEpochJD === null ? "" :
          entry.series.referenceEpochJD + sample.t / DAY,
        range_km: sample.range,
        range_rate_km_s: sample.rangeRate,
      })));
      download(fileStem() + "_relative_range.csv", new Blob([MA.rowsToCSV(columns, rows)],
        { type: "text/csv" }));
    });
    ["gtSwath", "gtStations", "gtFov", "gtOffNadir"].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener("change", () => { gtLastDraw = 0; });
    });
    if ($("gtFov") && S.mission && S.mission.spacecraft)
      $("gtFov").value = +S.mission.spacecraft.fovDeg || 50;
    if (globalThis.MutationObserver && $("app")) {
      AN.themeObserver = new MutationObserver(resizeAnalysisCanvases);
      AN.themeObserver.observe($("app"), { attributes: true, attributeFilter: ["data-theme"] });
    }
    renderCurrentElements();
    drawUncertaintyChart();
  }

  /* ------------------------- cinematic auto-camera ---------------------- *
   * Close-ups on events (burns, flybys, landings…), wide solar-system
   * shots for long cruises. Locks focus exactly to a body or spacecraft,
   * eases distance, and switches the display frame at deliberate cuts.
   * Any manual camera input hands control back to the user.                */
  // Only mission-defining events alter pacing. Apsides, SOI boundaries, and
  // observation markers stay on the timeline but no longer make the clock
  // repeatedly brake for what looks like no visible reason.
  const AUTOPACE_EVENTS = new Set(["burn", "flyby", "launch", "landing", "liftoff",
    "entry", "splashdown", "impact", "separation", "rendezvous", "dock", "undock"]);
  const AUTOCAM_SHOT_EVENTS = new Set(["burn", "flyby", "launch", "landing", "liftoff",
    "entry", "splashdown", "impact", "separation", "rendezvous", "dock", "undock"]);
  const isAutoEvent = (event, kinds) => kinds.has(event.kind) && !event.patchCorrection;

  function setAutoCam(on, silent) {
    if (S.autoCam === on) return;
    S.autoCam = on;
    if (on) clearVirtualFocus();
    $("btnAuto").classList.toggle("active", on);
    if (!on && !silent && !S.autoCamHinted) {
      banner("Auto camera off — press Auto to re-engage.");
      S.autoCamHinted = true;
    }
    if (on) {
      setPov(false);      // Auto / POV / Top are mutually exclusive
      exitTopView();
      setViewBtn(null);
      S.camera.pan = [0, 0, 0];
      resetAutoCamera(true);
    }
  }

  function nearestAutoEvent(windowS) {
    let best = null, bestD = Infinity;
    const result = activeVehicleResult();
    for (const e of result && result.events || []) {
      if (!isAutoEvent(e, AUTOCAM_SHOT_EVENTS)) continue;
      const d = e.t - S.tNow;
      if (d > windowS || d < -0.5 * windowS) continue;
      const ad = Math.abs(d);
      if (ad < bestD) { bestD = ad; best = e; }
    }
    return best;
  }

  /** time-dilation factor near events (only at fast playback speeds) */
  function dwellFactor() {
    if (!S.autoCam || S.speed < 3600) return 1;
    const W = 3 * S.speed;                 // ~3 real seconds of sim-time
    let f = 1;
    const result = activeVehicleResult();
    for (const e of result && result.events || []) {
      if (!isAutoEvent(e, AUTOPACE_EVENTS)) continue;
      const d = e.t - S.tNow;
      if (d >= 0 && d < W) f = Math.min(f, Math.max(0.08, Math.pow(d / W, 0.8)));
      else if (d < 0 && d > -0.35 * W)
        f = Math.min(f, 0.08 + 0.92 * (-d / (0.35 * W)));
    }
    return f;
  }

  /* ------------------- Auto Time (speed = AUTO · paced) ------------------ *
   * Per-gap pacing: cruises between major events compress to a few real
   * seconds, while the clock eases to a floor rate around mission-defining
   * events. The bounded step guard prevents crossing a crawl zone.         */
  function gapCruiseRate(gap) {
    // real seconds allotted to a gap grow ~logarithmically with its length
    const tReal = Math.min(12, Math.max(2.8, 3.4 + 1.35 * Math.log10(gap / DAY + 0.02)));
    return gap / tReal;
  }
  function autoRate(tAt, resultOverride) {
    const tRef = tAt === undefined ? S.tNow : tAt;
    const T = S.evT || [];
    const result = resultOverride || activeVehicleResult();
    const bounds = resultTimeBounds(result);
    const tEnd = bounds.end;
    let lo = 0, hi = T.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] <= tRef) lo = m + 1; else hi = m; }
    const prev = lo > 0 ? T[lo - 1] : bounds.start;
    const next = lo < T.length ? T[lo] : tEnd;
    const gap = Math.max(next - prev, 1);
    const cruise = gapCruiseRate(gap);
    // Scale-aware crawl: roughly 320x below cruise (min 30 s/s). The 2.5
    // coefficient starts each approach about five nominal real seconds out
    // (integral of the square-root ramp), instead of braking at the last beat.
    const floorR = Math.max(30, cruise / 320);
    const W = S.evW || [];
    const ramp = (d, wBase) => {
      const w = Math.max(wBase, floorR * 1.8);
      return Math.min(cruise,
        floorR + Math.sqrt(Math.max(d - w, 0) * cruise / 2.5));
    };
    const rPrev = lo > 0 ? ramp(tRef - prev, W[lo - 1] !== undefined ? W[lo - 1] : 70) : Infinity;
    const rNext = ramp(next - tRef, lo < T.length && W[lo] !== undefined ? W[lo] : 70);
    return Math.min(Math.min(rPrev, rNext), Math.max(cruise, floorR));
  }
  let lastRate = 21600;
  let rateSmooth = null;
  function resetPace() {
    rateSmooth = null;
    // Auto camera measures event proximity in real seconds. Re-anchor that
    // conversion after loads, scrubs, resets, and speed changes so it cannot
    // reuse the previous mission/time's high cruise rate for one latched shot.
    lastRate = S.speedMode === "auto" && S.result
      ? Math.max(autoRate(), 1)
      : Math.max(S.speed || 1, 1);
  }
  function effectiveRate(dt) {
    const target = S.speedMode === "auto" ? autoRate() : S.speed * dwellFactor();
    if (S.speedMode !== "auto") { lastRate = target; return target; }
    if (rateSmooth == null || !isFinite(rateSmooth) || rateSmooth <= 0) rateSmooth = target;
    // Glide between rates in log-space. A two-second brake and three-second
    // acceleration keep large compression changes legible without skipping.
    const tau = target < rateSmooth ? 2.0 : 3.0;
    const k = 1 - Math.exp(-(dt || 0.016) / tau);
    rateSmooth = Math.exp(Math.log(rateSmooth) +
      (Math.log(Math.max(target, 1)) - Math.log(rateSmooth)) * k);
    lastRate = rateSmooth;
    return rateSmooth;
  }
  /** frame time step, clamped so a fast cruise step can never jump past an
   *  event's crawl zone (the discrete-integration overshoot guard) */
  function advanceStep(dt) {
    let step = dt * effectiveRate(dt);
    if (S.speedMode === "auto") {
      const T = S.evT || [];
      let lo = 0, hi = T.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] <= S.tNow) lo = m + 1; else hi = m; }
      if (lo < T.length) {
        const dNext = T[lo] - S.tNow;
        const crawlR = Math.max(autoRate(Math.max(T[lo] - 1, 0)), 30); // approximately the event floor
        const w = Math.max(S.evW && S.evW[lo] !== undefined ? S.evW[lo] : 70, crawlR * 1.8);
        if (dNext > w) {
          // Approach the crawl zone in several bounded steps if a dropped
          // frame arrives with a stale high rate; never teleport to its edge.
          const remain = dNext - w;
          step = Math.min(step, Math.max(dt * crawlR * 1.15, remain * 0.30));
        } else step = Math.min(step, Math.max(dt * crawlR * 1.15, 0.001));
      }
    }
    return step;
  }
  function fmtRate(r) {
    if (r >= DAY) return (r / DAY).toFixed(r >= 10 * DAY ? 0 : 1) + " d/s";
    if (r >= 3600) return (r / 3600).toFixed(1) + " h/s";
    if (r >= 60) return Math.round(r / 60) + " min/s";
    return Math.round(r) + " s/s";
  }

  let shot = { mode: "", since: 0, cen: "" };   // shot latch (anti-churn)
  function resetAutoCamera(hard) {
    shot = { mode: "", since: 0, cen: "" };
    if (hard && S.autoCam && S.camera) {
      S.camera.freeFocus = null;
      S.camera.pan = [0, 0, 0];
    }
  }
  function autoCamTick(dtReal) {
    if (!S.autoCam || !S.result || !S.result.samples.length) return;
    const cam = S.camera;
    const vehicleResult = activeVehicleResult();
    const smp = currentSample();
    if (!smp) return;
    const jd = S.result.epochJD + S.tNow / DAY;
    if (smp.cr3bp && globalThis.CR3BP) {
      const system = globalThis.CR3BP.getSystem(smp.cr3bpSystem);
      const orbit = vehicleResult.cr3bpOrbit;
      let extent = system.distanceKm * 0.04;
      if (orbit && orbit.states && orbit.states.length) {
        const equilibrium = globalThis.CR3BP.equilibriumPoint(system, orbit.point).position;
        extent = orbit.states.reduce((largest, state) => Math.max(largest,
          V.mag(V.sub(state.slice(0, 3), equilibrium)) * system.distanceKm), extent);
      }
      cam.focusMode = "ship";
      cam.focusBody = system.secondaryId;
      cam.freeFocus = null;
      cam.pan = [0, 0, 0];
      const targetDist = Math.max(extent * 5.5, BODIES[system.secondaryId].radius * 8);
      const k = 1 - Math.exp(-dtReal / 1.15);
      cam.dist = Math.exp(Math.log(cam.dist) +
        (Math.log(targetDist) - Math.log(cam.dist)) * k);
      const wantFrame = "synodic:" + system.id;
      if (S.frameBody !== wantFrame) {
        S.frameBody = wantFrame;
        const selector = $("frameSel");
        if (selector) selector.value = wantFrame;
        globalThis.MTPRender.invalidateCache();
      }
      return;
    }
    // Escape previews deliberately overlap patched-conic frame handoffs for
    // a short, labelled interval. Keep Auto camera in that burn-body frame
    // while the renderer's preview is active so Apollo's lunar departure and
    // the historical Earth departures do not snap straight to a huge parent-
    // frame composition at the burn timestamp.
    const burnPreview = globalThis.MTPRender.burnPreviewState
      ? globalThis.MTPRender.burnPreviewState(vehicleResult, S.tNow, smp) : null;
    const displaySmp = burnPreview && globalThis.MTPRender.burnPreviewDisplayState
      ? globalThis.MTPRender.burnPreviewDisplayState(vehicleResult, smp, burnPreview) : smp;
    const displayCenId = burnPreview && burnPreview.mode === "escape"
      ? displaySmp.cen : smp.cen;
    const cen = BODIES[displayCenId] || BODIES[smp.cen];
    const obsT = activeObserve();

    /* ---- decide the shot: distances measured in REAL seconds at the
       current pace (stable under Auto Time), with a long latch so the
       camera stops flip-flopping between compositions */
    const rateRef = Math.max(lastRate, 1);
    const T2 = S.camEvT || [];
    let lo2 = 0, hi2 = T2.length;
    while (lo2 < hi2) { const m = (lo2 + hi2) >> 1; if (T2[m] <= S.tNow) lo2 = m + 1; else hi2 = m; }
    const dNextR = lo2 < T2.length ? (T2[lo2] - S.tNow) / rateRef : Infinity;
    const dPrevR = lo2 > 0 ? (S.tNow - T2[lo2 - 1]) / rateRef : Infinity;
    const nearEvent = dNextR < 6 || dPrevR < 3 ||
      (shot.mode === "event" && dNextR < 7);   // bridge only tight major-event clusters
    let want = obsT ? "observe" : nearEvent ? "event"
      : (displayCenId !== "sun" ? "local" : "cruise");
    const nowR = performance.now();
    const cenChanged = shot.cen !== displayCenId;
    if (want !== shot.mode) {
      if (!shot.mode || nowR - shot.since > 6500 || (cenChanged && nowR - shot.since > 2200))
        shot = { mode: want, since: nowR, cen: displayCenId };
    } else shot.cen = displayCenId;

    let dist, focusMode, focusBody = "sun";
    if (shot.mode === "observe" && obsT) {
      // observation: frame the observed body with the ship in view
      const tw = A.bodyWorld(obsT, jd);
      const range = V.mag(V.sub(smp.w, tw));
      focusMode = "body"; focusBody = obsT;
      dist = Math.max(range * 2.7, BODIES[obsT].radius * 5.5);
    } else if (displayCenId !== "sun") {
      const localR = displayCenId === displaySmp.cen ? displaySmp.r
        : V.sub(displaySmp.w, A.bodyWorld(displayCenId, jd));
      const localV = displayCenId === displaySmp.cen ? displaySmp.v : smp.v;
      const rNow = Math.max(V.mag(localR), cen.radius * 1.1);
      if (shot.mode === "event") {
        // event close-up: follow the ship near its central body
        focusMode = "ship";
        dist = Math.max(rNow * 2.6, cen.radius * 3.8);
        if (isFinite(cen.soi)) dist = Math.min(dist, cen.soi * 1.8);
      } else {
        // Stable local shot: frame the osculating orbit, not the instantaneous
        // radius, so eccentric coasts do not make the zoom breathe every frame.
        const coe = A.rvToCoe(localR, localV, cen.mu);
        let extent = rNow;
        if (coe.e < 1 && isFinite(coe.ra)) {
          const cap = isFinite(cen.soi) ? cen.soi * 0.9 : coe.ra;
          extent = Math.max(rNow, Math.min(coe.ra, cap));
        }
        focusMode = "body"; focusBody = displayCenId;
        dist = Math.max(extent * 3.2, cen.radius * 7.5);
      }
    } else {
      if (shot.mode === "event") {
        // deep-space maneuver: pull in around the ship
        focusMode = "ship";
        dist = Math.max(V.mag(smp.w) * 0.45, 0.6 * AU);
      } else {
        // cruise: wide solar-system shot framing the ship's orbit
        focusMode = "body"; focusBody = "sun";
        dist = Math.max(V.mag(smp.w) * 3.1, 3.5 * AU);
      }
    }

    // Body/ship focus modes track moving targets exactly. Only zoom is eased,
    // eliminating world-coordinate lag that could let the target leave frame.
    cam.focusMode = focusMode;
    cam.focusBody = focusBody;
    cam.freeFocus = null;
    cam.pan = [0, 0, 0];
    const kDist = 1 - Math.exp(-dtReal / (shot.mode === "event" ? 0.75 : 1.15));
    cam.dist = Math.exp(Math.log(cam.dist) + (Math.log(dist) - Math.log(cam.dist)) * kDist);

    const wantFrame = displayCenId === "sun" ? "inertial" : displayCenId;
    if (S.frameBody !== wantFrame) {
      S.frameBody = wantFrame;
      $("frameSel").value = wantFrame;
      globalThis.MTPRender.invalidateCache();
    }
  }

  /* ------------------------------ HUD ---------------------------------- */
  let sampleCache = { result: null, t: NaN, value: null };
  function currentSample() {
    const result = activeVehicleResult();
    if (!result || !result.samples || !result.samples.length) return null;
    const first = result.samples[0].t;
    const last = result.samples[result.samples.length - 1].t;
    if (S.tNow < first - 1e-6 || S.tNow > last + 1e-6) return null;
    if (sampleCache.result === result && sampleCache.t === S.tNow) return sampleCache.value;
    sampleCache = { result, t: S.tNow, value: ME.sampleAtTime(result, S.tNow) };
    return sampleCache.value;
  }
  function setText(id, value) {
    const el = $(id);
    if (el && el.textContent !== value) el.textContent = value;
    return el;
  }
  function apsisText(smp) {
    if (!smp || smp.landed || !BODIES[smp.cen]) return "—";
    if (smp.cr3bp && globalThis.CR3BP) {
      const system = globalThis.CR3BP.getSystem(smp.cr3bpSystem);
      return `CR3BP · C_J ${globalThis.CR3BP.jacobiConstant(system, smp.synodic).toFixed(6)}`;
    }
    const body = BODIES[smp.cen];
    const coe = A.rvToCoe(smp.r, smp.v, body.mu);
    if (!isFinite(coe.rp)) return "—";
    const val = (r) => smp.cen === "sun"
      ? (r / AU).toFixed(3) + " AU"
      : ME.fmtKm(r - body.radius);
    return isFinite(coe.ra) && coe.e < 1
      ? "AP " + val(coe.ra) + " · PE " + val(coe.rp)
      : "ESCAPE · PE " + val(coe.rp);
  }
  function activeTarget(segIdx) {
    // the active segment's target, else the next segment that has one
    const segments = activeSegments();
    for (let i = segIdx; i < segments.length; i++) {
      const tb = segments[i]._targetBody;
      if (tb && tb !== "sun") return tb;
    }
    return null;
  }
  function updateFormationReadout(sample) {
    const host = $("formationReadout");
    if (!host || !S.result || !S.result.vehicleResults) return;
    const ids = (S.result.vehicleOrder || Object.keys(S.result.vehicleResults))
      .filter((id) => id !== S.activeVehicleId);
    if (!ids.length) {
      host.textContent = "Primary vehicle only.";
      return;
    }
    if (!sample) {
      host.textContent = "The selected vehicle has no state at this time.";
      return;
    }
    const rows = [];
    for (const id of ids) {
      const result = S.result.vehicleResults[id];
      if (!result || !result.samples.length || S.tNow < result.samples[0].t ||
          S.tNow > result.samples[result.samples.length - 1].t) continue;
      const target = ME.sampleAtTime(result, S.tNow);
      if (!target || !target.w) continue;
      const rangeKm = V.mag(V.sub(sample.w, target.w));
      const relativeRate = sample.cen === target.cen
        ? 1000 * V.mag(V.sub(sample.v, target.v)) : null;
      const joined = sample.dockedTo === id || target.dockedTo === S.activeVehicleId;
      const report = AN.nativeFormation.find((entry) => entry.targetId === id);
      const closest = report && report.closest;
      const closestTime = closest && (closest.referenceEpochJD === null
        ? closest.t
        : (closest.referenceEpochJD + closest.t / DAY - result.epochJD) * DAY);
      const detail = report && report.error
        ? `<small>closest-approach analysis unavailable: ${esc(report.error)}</small>`
        : closest
          ? `<small>closest ${esc(ME.fmtKm(closest.range))} at ${esc(fmtMet(closestTime))}` +
            ` / ${report.conjunctions.intervals.length} interval` +
            `${report.conjunctions.intervals.length === 1 ? "" : "s"} inside ` +
            `${esc(ME.fmtKm(report.thresholdKm))}</small>`
          : "";
      rows.push(`<div><b>${esc(result.name || id)}</b> / ${joined ? "JOINED / " : ""}` +
        `${esc(fmtDist(rangeKm))}` +
        (relativeRate !== null ? ` / ${relativeRate.toFixed(2)} m/s` : "") +
        `${detail}</div>`);
    }
    host.innerHTML = rows.length ? rows.join("") : "No simultaneous secondary state.";
  }
  function updateHud() {
    const smp = currentSample();
    const jd = S.result.epochJD + S.tNow / DAY;
    const vehicle = activeVehicleDefinition();
    const vehicleResult = activeVehicleResult();
    setText("hudMet", fmtMet(S.tNow));
    setText("hudDate", A.jdToStr(jd));
    setText("hudVehicle", vehicle ? vehicle.name || vehicle.id : "--");
    setText("cineMeta", `${S.mission.name || "Mission"} / ` +
      `${vehicle ? vehicle.name || vehicle.id : "vehicle"}`);
    updateFormationReadout(smp);
    if (!smp) {
      for (const id of ["hudSeg", "hudCentral", "hudAlt", "hudVel", "hudApsis", "hudTgt"])
        setText(id, "—");
      setText("hudDv", (vehicleResult ? vehicleResult.totalDv : 0).toFixed(2) + " km/s" +
        (S.result.vehicleOrder && S.result.vehicleOrder.length > 1
          ? ` / SUM ${S.result.totalDv.toFixed(2)}` : ""));
      setText("hudFrame", frameDescription(S.frameBody) + (S.autoCam ? " · AUTO" : ""));
      updateAnalysisLive();
      return;
    }
    const segments = activeSegments();
    const seg = segments[smp.seg];
    const spec = seg ? ME.SEGMENT_TYPES[seg.type] : null;
    const hudSeg = setText("hudSeg", seg ? `#${smp.seg + 1} ${spec ? spec.short : seg.type}` : "—");
    hudSeg.style.color =
      (globalThis.MTPTheme && globalThis.MTPTheme.hudSegColor) || (spec ? spec.color : "#c9d1d9");
    const cenB = BODIES[smp.cen];
    const cr3bpSystem = smp.cr3bp && globalThis.CR3BP
      ? globalThis.CR3BP.getSystem(smp.cr3bpSystem) : null;
    setText("hudCentral", cr3bpSystem ? cr3bpSystem.name + " CR3BP" : cenB.name);
    const rm = V.mag(smp.r);
    setText("hudAlt", smp.cen === "sun" ? fmtDist(rm) : fmtDist(rm - cenB.radius) +
      (smp.landed ? " (surface)" : ""));
    setText("hudVel", smp.landed ? "0 (landed)" : V.mag(smp.v).toFixed(3) + " km/s");
    const apsisPreview = globalThis.MTPRender && globalThis.MTPRender.burnPreviewState
      ? globalThis.MTPRender.burnPreviewState(vehicleResult, S.tNow, smp) : null;
    setText("hudApsis", seg && seg.type === "launch" && smp.t < seg._t1 - 1e-6
      ? "POWERED ASCENT · MECO TARGET"
      : (apsisPreview && apsisPreview.apoOpen
        ? "AP OPEN · PE —"
        : apsisText(apsisPreview ? apsisPreview.state : smp)));
    const targetVehicleId = seg && (seg._targetVehicle || seg.targetVehicle || seg.fromVehicle);
    const targetVehicleResult = targetVehicleId && S.result.vehicleResults &&
      S.result.vehicleResults[targetVehicleId];
    const targetVehicleSample = targetVehicleResult && targetVehicleResult.samples.length &&
      S.tNow >= targetVehicleResult.samples[0].t &&
      S.tNow <= targetVehicleResult.samples[targetVehicleResult.samples.length - 1].t
      ? ME.sampleAtTime(targetVehicleResult, S.tNow) : null;
    const tgt = activeTarget(smp.seg);
    if (targetVehicleSample && targetVehicleSample.w) {
      setText("hudTgt", `${targetVehicleResult.name || targetVehicleId} / ` +
        `${fmtDist(V.mag(V.sub(smp.w, targetVehicleSample.w)))}`);
    } else if (tgt && BODIES[tgt]) {
      const d = V.mag(V.sub(smp.w, A.bodyWorld(tgt, jd)));
      setText("hudTgt", `${BODIES[tgt].name} · ${fmtDist(d)}`);
    } else setText("hudTgt", "—");
    setText("hudDv", (vehicleResult ? vehicleResult.totalDv : 0).toFixed(2) + " km/s" +
      (S.result.vehicleOrder && S.result.vehicleOrder.length > 1
        ? ` / SUM ${S.result.totalDv.toFixed(2)}` : "") +
      (S.ascentDv > 0.05 ? " (+" + S.ascentDv.toFixed(1) + " asc)" : ""));
    setText("hudFrame", frameDescription(S.frameBody) + (S.autoCam ? " · AUTO" : ""));
    updateAnalysisLive();
  }

  /* --------------------------- script/guide ---------------------------- */
  function updateScript() {
    $("scriptPre").textContent = globalThis.ScriptGen.generate(S.mission, S.result);
  }

  function buildGuide() {
    const segRows = Object.entries(ME.SEGMENT_TYPES).map(([k, v]) =>
      `<tr><td style="color:${v.color};white-space:nowrap">${v.short}</td><td>${v.doc}</td></tr>`).join("");
    const siteRows = C.LAUNCH_SITES.filter((s) => s.id).map((s) =>
      `<tr><td style="white-space:nowrap">${s.name}</td><td>${s.latDeg.toFixed(1)}°</td></tr>`).join("");
    $("guidePane").innerHTML = `
<h3>What is this?</h3>
<p>A browser-based mission trajectory planner inspired by NASA's
<a href="https://gmat.atlassian.net/" target="_blank" rel="noreferrer">General Mission Analysis Tool (GMAT)</a>.
A mission is an ordered list of <b>segments</b> (left panel). The engine executes them in order,
producing a time-tagged trajectory you can animate, edit and export.
  It is an educational design approximation. It now includes bounded n-body, finite-thrust,
  perturbation, targeting and dispersion tools, while operational mission design adds higher-order
  force models, navigation estimation, validated ephemerides, constraints and independent review.</p>

<h3>The physics that is real</h3>
<ul>
<li><b>Kepler's equation</b> M = E − e·sin E, solved by Newton iteration
(hyperbolic form M = e·sinh H − H for escape orbits).</li>
<li><b>Universal-variable propagation</b> (Stumpff functions C(z), S(z)) — exact two-body
motion for elliptic, parabolic and hyperbolic orbits alike.</li>
<li><b>Numerical propagation</b> — adaptive Dormand–Prince 5(4) integration with bounded work,
moving point-mass gravity, collision events, finite thrust and optional environment forces.</li>
<li><b>Vis-viva</b>: v² = μ(2/r − 1/a) — used for insertions, Hohmann legs and Δv estimates.</li>
<li><b>Hohmann transfer</b>: Δv₁ = √(μ/r₁)(√(2r₂/(r₁+r₂)) − 1),
Δv₂ = √(μ/r₂)(1 − √(2r₁/(r₁+r₂))), TOF = π√(a³/μ).</li>
<li><b>Lambert's problem</b> (universal variables, bisection on z) — finds the orbit connecting
two positions in a given time. Powers Transfer / Departure / Return segments.</li>
<li><b>Escape &amp; excess speed</b>: v_esc = √(2μ/r); C3 = v∞² (negative C3 = still bound).</li>
<li><b>Patched conics</b>: sphere of influence r_SOI = a·(m/M)^{2/5}; crossing an SOI
re-expresses the state about the new central body.</li>
<li><b>Gravity assists</b>: an unpowered FLYBY rotates the v∞ vector by
δ = 2·asin(1/e) with e = 1 + r_p·v∞²/μ — the planet-frame speed is conserved while the
Sun-frame velocity changes, exactly how VVEJGA-class tours are flown
(load the Cassini–Huygens preset).</li>
<li><b>Launch-window plane targeting</b>: RAAN chosen so the parking-orbit plane contains
the target's direction — like choosing the real launch time/azimuth.</li>
<li><b>Launch sites &amp; Earth rotation</b>: a site's latitude is the minimum direct-ascent
inclination, and the surface rotation credits ≈ 0.465·cos(i) km/s to eastward ascents
(retrograde launches pay it back).</li>
<li><b>MECO → circularization</b>: launches deliver a suborbital-periapsis transfer ellipse;
an Insertion burn at apoapsis completes the orbit — the OMS-2 pattern real vehicles fly.</li>
<li><b>Osculating apsides</b>: the blue dashed orbit and AP/PE markers are derived from the
current state vector. Under this engine's impulsive-burn model, apoapsis changes at the burn
instant and then stays fixed during an ideal two-body coast.</li>
<li><b>B-plane-style aiming</b>: encounter periapsis is met by iterating a lateral aim-point
offset on the Lambert arc.</li>
<li><b>Ignition-point optimization</b>: injection burns scan the parking orbit for the
minimum-Δv departure point (why TLI happens at a specific moment).</li>
</ul>

<h3>Launch-window search</h3>
<p>The <b>Windows</b> tab scans a departure-date / time-of-flight grid with the
same Lambert solver used by mission segments. Color by C3, endpoint v-infinity,
or total characteristic delta-v; hover for all four values. Clicking a cell only
stages it. The separate Apply button confirms the choice, writes the TOF to a
matching Transfer or Depart segment, and shifts T+0 so that segment's actual
injection event lands on the selected departure date. Its joint Vary/Achieve control first derives
one B-plane aim from the seed, holds that aim fixed, and evaluates every date/TOF trial through the
same patched-conic mission engine that Apply uses. A result is never accepted from the detached
porkchop estimate alone.</p>

<h3>Force models, GP data &amp; uncertainty</h3>
<p>Adaptive Coast and Finite Burn cards can use the bounded release-generated Horizons table,
simple Earth atmosphere/drag, eclipse-aware solar-radiation pressure and selectable Earth J2–J4.
GP Orbit cards propagate valid TLE/OMM mean elements with the vendored Vallado SGP4/SDP4 model;
they are not converted to osculating Kepler ellipses. The Data pane's seeded Monte Carlo accepts
Cartesian state covariance plus RTN magnitude, pointing and timing error. Its 95% figures are
finite-sample estimates at one configured endpoint. Station passes and conjunction times remain
nominal, while their reports propagate linearized primary position covariance to individual
max-elevation and closest-approach epochs within the selected horizon. Comparison-craft covariance
is not inferred.</p>

<h3>Native mission vehicles</h3>
<p>The vehicle selector above the left panel switches between the mission's primary craft and up
to seven secondary craft. A secondary vehicle begins with <b>Separate</b>, which copies an exact
state from another vehicle at a named segment boundary. <b>Rendezvous</b> uses a bounded phasing
wait plus a terminal Lambert transfer, <b>Dock</b> accepts only a close, slow capture, and
<b>Undock</b> releases the joined craft with an optional impulse. Click any native vehicle marker
to select it; its cards, trajectory, HUD, Track view, camera and Auto Time then use that vehicle
while the other native trajectories remain visible. Its scrubber, timeline, eclipse/access tools
and GIF export use only that vehicle's state coverage. Opening Data computes exact-provider
closest approach and conjunction-threshold intervals against every other native vehicle. Mission
JSON and script exports always retain the complete native fleet.</p>
<p class="hint">These are synchronized test-particle histories, not a contact or assembly-dynamics
solver. Docked craft share the target's state exactly, but the engine does not combine mass,
propellant, center of mass, attitude, flexible structure, sensors, navigation, autonomous GNC or
docking-contact forces. Vehicle dependencies must be acyclic.</p>

<h3>Segment reference</h3>
<table class="ref">${segRows}</table>

<h3>Launch sites</h3>
<table class="ref">${siteRows}</table>
<p class="hint">Latitude sets the physical floor on inclination for a direct ascent; real ranges
add azimuth (range-safety) corridors that this app does not model.</p>

<h3>Reading the segment table</h3>
<p>Each card is one mission phase, executed top to bottom. The colored code is the phase type.
Expand a card to edit parameters — the trajectory recomputes automatically. Computed results
(Δv, C3, v∞, flyby turn angles, timings) appear inside the card; yellow ▲ = questionable physics,
red ✕ = the segment could not execute. Total Δv counts maneuvers only
(launch/ascent estimates are bookkept separately).</p>

<h3>Cinematic auto-camera</h3>
<p>The <b>Auto</b> camera (on by default) directs the view for you: stable body framing during
local flight, exact spacecraft tracking for major-event close-ups, and wide solar-system framing
during long cruises. It changes shots only for burns, flybys, launch, entry and landing events;
apsis, SOI and observation markers no longer cause repeated cuts.
Any drag / zoom / view button hands control back — press Auto to re-engage.</p>

<h3>Auto Time &amp; the cameras</h3>
<p>The speed selector's <b>AUTO · paced</b> mode (the default) drives playback for you:
cruises between major events compress to a few real seconds each, and the clock eases gradually
around burns, flybys, launch, entry and landing so nothing flashes past — the live
rate shows in the transport bar. Pick any manual speed to opt out. Three camera aids:
<b>Auto</b> composes shots (event close-ups, wide cruise framing), <b>POV</b> (V) rides
onboard looking back at the central body, and <b>Track</b> (G) opens the ground-track panel.</p>

<h3>CR3BP rotating views</h3>
<p>The frame selector includes ideal <b>Sun-Earth</b> and <b>Earth-Moon synodic</b>
views. Historical trajectory points are rotated using the actual primary-secondary geometry at
each point's epoch, so the path remains coherent in the moving frame. Enable <b>L1-L5 points</b>
in Display and choose a system to show the five massless equilibrium markers; click a marker to
focus it and press F for a closer view. These markers are CR3BP reference locations, not massive
bodies, transfer targets, or operational stationkeeping predictions.</p>

<h3>Ground track — satellite vision</h3>
<p>The Track panel projects the mission onto an equirectangular map of the current central
body (your downloaded NASA texture when available): the body-fixed sub-satellite track
(solid = flown, dashed = planned), the day/night terminator computed from the real Sun
direction, the horizon-visibility footprint (the region the spacecraft can see right now),
and event markers at their ground positions. It works at any body — watch Huygens' descent
trace onto Titan, or an Apollo orbit crawl across the Moon.</p>

<h3>Live apsis monitor</h3>
<p>The HUD's <b>APSIS (OSC)</b> readout and the optional <b>apsides</b> display overlay show the
current osculating apoapsis and periapsis. Around a modeled impulse, an explicitly labeled
visual preview blends the maneuver over a short simulated interval so the ellipse stays attached
to the spacecraft while apoapsis rises or lowers from the current orbit. During that short preview,
the future trajectory and apsis overlay deliberately share the same visual conic. At escape
ignition, the finite AP marker ends immediately and reads <b>AP OPEN</b>; the exact open transfer
replaces the closed guide because apoapsis is then infinite/undefined. Apollo 11 also shows a
bounded illustrative lunar-capture ellipse lowering into orbit and lunar-departure apoapsis rising
up to the patched-conic frame handoff. Impulse segments still apply Δv instantaneously; a
Finite Burn segment instead integrates thrust, gravity, motion and mass depletion together.
Departure and trans-body Return segments propagate an explicit source-body escape hyperbola for
real simulated time, then preserve position and velocity at the same-time SOI frame handoff.</p>

<h3>Combined live mission tracker</h3>
<p><a href="live.html">Open the Mission Tracker</a> for Earth 100 and Deep 100 in one page.
Use the two scope buttons to switch between the Earth-orbit OMM SGP4/SDP4 view and the heliocentric
Horizons view; each keeps the camera scale and accuracy language appropriate to its data. Deep
missions without bounded coverage remain searchable cards and never receive invented positions.
Neither mode is telemetry or proof that a cataloged spacecraft is currently operating.</p>

<h3>Spacecraft &amp; propellant</h3>
<p>The SPACECRAFT card (left panel) holds the selected vehicle: name, notes, dry mass, propellant
load, engine Isp and the POV camera's field of view. With mass + propellant + Isp set, every
burn consumes propellant by the rocket equation m₁ = m₀·e^(−Δv/(Isp·g₀)) — the card shows
remaining propellant and total Δv capacity, and flags the moment the tanks run dry. Leave
propellant blank to turn tracking off (several presets do, since their big burns were really
performed by launch stages that a simplified vehicle history may fold together).</p>

<h3>Saving missions</h3>
<p><b>Save</b> (left panel) stores the mission — segments, spacecraft, epoch — in this
browser's library; saved missions appear under <i>My missions</i> in the mission selector,
and can be removed in the Export tab. For files that move between machines, use
<b>Export / Import mission JSON</b> in the Export tab.</p>

<h3>Planet textures</h3>
<p>Open <code>get_textures.html</code> and use its reviewed agency-image candidates to build
the local texture pack. The PowerShell helper remains an alternative for planet maps from
<a href="https://www.solarsystemscope.com/textures/"
target="_blank" rel="noreferrer">Solar System Scope</a> (CC-BY 4.0); both workflows write
<code>js/textures-data.js</code>. Planets then render as lit, rotating textured globes with
axial tilt; Saturn gets its C/B/Cassini-division/A/F ring structure either way. Without the
pack the app falls back to the original gradient look. Keeping pixels inline (base64) avoids
canvas tainting so PNG/GIF export keeps working offline.</p>

<h3>Limitations (please read)</h3>
<ul>
<li>Patched conics remain the fast default. Adaptive point-mass n-body propagation is selectable,
but it uses this app's catalog ephemerides and is not an operational navigation solution.</li>
<li>Sun-Earth and Earth-Moon CR3BP modes include L1-L5, corrected planar/halo families,
bounded linear Lissajous seeds, and ideal reference-tracking stationkeeping. CR3BP assumes circular
primaries and omits navigation covariance, maneuver errors, solar pressure and ephemeris dynamics.</li>
<li>Ordinary maneuver segments are impulsive. Finite Burn integrates thrust and mass depletion,
but engine transients, attitude dynamics and detailed propulsion constraints are not modeled.</li>
<li>The high-accuracy Planner option is a strict, release-generated 20-body Horizons table covering
only its labeled June–August 2026 interval; it does not extrapolate. Outside that bounded table,
catalog planets use JPL-style mean elements, small bodies use reviewed osculating elements, and
moon orbits remain simplified — appropriate for visualization, not navigation.</li>
<li>Departure/Return escape is continuous to the SOI, but the spherical SOI boundary and
patched-conic force switch remain idealizations.</li>
<li>Launch ascent, atmospheric entry and landings are schematic placeholders with
bookkeeping Δv estimates.</li>
<li>Historical missions are recognizable reconstructions: event sequence is right,
timings/Δv are engine-derived approximations (the Cassini preset pins the real flyby
dates; its TCM burns absorb the ephemeris differences).</li>
</ul>

<h3>Controls</h3>
<p><b>Drag</b> rotate · <b>Shift/right-drag</b> pan · <b>Wheel</b> zoom ·
<b>Double-click</b> a body to focus it · <b>Space</b> play/pause ·
click timeline ticks or event markers in the 3D view to jump to events (thick ticks hold several events — click steps through them) · double-click a body to focus it, then <b>Focus</b> (F) zooms straight to it · <b>Auto</b> cinematic camera.</p>

<div class="shortcut-card" aria-label="Keyboard shortcut reference">
  <div class="shortcut-card-head"><strong>Keyboard reference</strong><span>disabled while typing in a field</span></div>
  <div class="shortcut-grid">
    <kbd>Space</kbd><span>Play / pause</span>
    <kbd>R</kbd><span>Reset mission time and view</span>
    <kbd>A</kbd><span>Toggle Auto camera</span>
    <kbd>V</kbd><span>Toggle onboard POV</span>
    <kbd>G</kbd><span>Open / close Track map</span>
    <kbd>F</kbd><span>Zoom to current focus</span>
    <kbd>Enter</kbd><span>Activate focused timeline or plot cell</span>
  </div>
</div>

<h3>File formats</h3>
<p><b>Mission JSON</b> (Export tab): <code>{"format":"mtp-mission-2","name":…,"epoch":ISO-8601,
"segments":[{"type":"launch",…},…],"vehicles":[…]}</code>. The root spacecraft and segments
remain the primary vehicle; <code>vehicles</code> contains optional secondary branches. Older
single-vehicle mission files still load unchanged (pre-v1.1 launches retain their legacy
direct-to-circular behavior).</p>
<p><b>Body catalog JSON</b> — add asteroids, comets, extra moons:</p>
<pre>[{ "id":"halley", "name":"1P/Halley", "parent":"sun",
   "mu":1e-9, "radius":5.5, "color":"#9db4c0",
   "elements":{ "aAU":17.93, "e":0.967, "iDeg":162.2,
                "LDeg":300.0, "wbarDeg":172.0, "OmDeg":59.0 } }]</pre>
<p>Moons use <code>"aKm"</code> and optionally <code>"periodDays"</code> instead of <code>"aAU"</code>.
Mean motion follows from Kepler's third law when omitted.</p>

<p class="ver">Mission Trajectory Planner v${C.VERSION} · patched conics + bounded adaptive dynamics ·
ephemerides: strict generated Horizons table or reviewed catalog fallback · GP: SGP4/SDP4</p>`;
  }

  /* ----------------------- launch-window planner ---------------------- */
  const WINDOW_METRICS = Object.freeze({
    c3: { label: "C3", unit: "km²/s²" },
    departureVInfinity: { label: "Departure v∞", unit: "km/s" },
    arrivalVInfinity: { label: "Arrival v∞", unit: "km/s" },
    totalCharacteristicVelocity: { label: "Total characteristic Δv", unit: "km/s" },
  });
  const WIN = {
    grid: null,
    hovered: null,
    selected: null,
    targetSolution: null,
    plot: null,
    signal: null,
    runId: 0,
    initialized: false,
    themeObserver: null,
  };

  function windowPresent() {
    return !!($("windowsPane") && $("winCanvas") && $("winGenerate"));
  }

  function windowStatus(message, kind) {
    const status = $("winStatus");
    if (!status) return;
    status.textContent = message;
    status.className = "window-status" + (kind ? " " + kind : "");
  }

  function windowBusy(busy) {
    const generate = $("winGenerate"), cancel = $("winCancel");
    if (generate) generate.disabled = busy;
    if (cancel) cancel.disabled = !busy;
  }

  function windowTargetBusy(busy) {
    for (const id of ["winApplySegment", "winTargetGoal", "winTargetSeed",
      "winTargetTolerance", "winTargetSolve", "winApply"]) {
      const element = $(id);
      if (element) element.disabled = !!busy;
    }
    if (!busy) syncWindowApplySegments();
  }

  function windowBodyOptions(value) {
    const endpoints = Object.values(BODIES).filter((body) => body.id !== "sun" && body.parent);
    const groups = [
      ["Planets", endpoints.filter((body) => body.parent === "sun" && body.type === "planet")],
      ["Moons", endpoints.filter((body) => body.parent !== "sun")],
      ["Dwarf planets and small bodies", endpoints.filter((body) =>
        body.parent === "sun" && body.type !== "planet")],
    ];
    return groups.map(([label, bodies]) => {
      const options = bodies.slice().sort((a, b) => a.name.localeCompare(b.name)).map((body) =>
        `<option value="${esc(body.id)}" ${body.id === value ? "selected" : ""}>` +
        `${esc(body.name)}</option>`).join("");
      return options ? `<optgroup label="${esc(label)}">${options}</optgroup>` : "";
    }).join("");
  }

  function windowSegmentSource(index) {
    if (!S.result || !S.mission || !S.mission.segments[index]) return null;
    const first = S.result.samples.find((sample) => sample.seg === index && BODIES[sample.cen]);
    if (first && first.cen !== "sun") return first.cen;
    // A heliocentric Transfer normally follows a planetary flyby. Recover the
    // last body-local leg so the window pair is Jupiter->Saturn, not Sun->Saturn.
    for (let previous = index - 1; previous >= 0; previous--) {
      const local = S.result.samples.filter((sample) => sample.seg === previous &&
        sample.cen !== "sun" && BODIES[sample.cen] && BODIES[sample.cen].parent === "sun");
      if (local.length) return local[local.length - 1].cen;
    }
    if (first) return first.cen;
    const segment = S.mission.segments[index];
    const sample = ME.sampleAtTime(S.result, Math.max(0, +segment._t0 || 0));
    return sample && BODIES[sample.cen] ? sample.cen : null;
  }

  function windowDepartureOffset(index) {
    if (!S.result || !S.mission || !S.mission.segments[index]) return 0;
    const primary = S.result.vehicleResults && S.result.vehicleResults.primary || S.result;
    const burn = primary.events.find((event) => event.seg === index && event.kind === "burn");
    return burn ? burn.t : (+S.mission.segments[index]._t0 || 0);
  }

  function evaluatedWindowDepartureOffset(result, segment, index) {
    const primary = result && result.vehicleResults && result.vehicleResults.primary || result;
    const burn = primary && primary.events && primary.events.find((event) =>
      event.seg === index && event.kind === "burn" && !(event.patchCorrection ||
        (event._burn && event._burn.patchCorrection)));
    return burn ? burn.t : (+segment._t0 || 0);
  }

  function windowTargetFingerprint(mission, index) {
    if (!mission || !Array.isArray(mission.segments)) return "";
    const publicMission = { ...mission,
      segments: mission.segments.slice(0, index + 1).map(cleanSegment) };
    return JSON.stringify(publicMission);
  }

  /* Evaluate the exact segment configuration that Apply will commit. The
   * bounded target must come from the mission engine's real ignition wait and
   * patched-conic handoffs, rather than a detached analytic estimate. */
  function evaluateAppliedWindowTarget(index, departureJD, tofDays,
      targetAltitudeKm, fixedAimOffsetKm, baseMission, baseDepartureOffset) {
    const sourceMission = baseMission || S.mission;
    if (!sourceMission || !sourceMission.segments[index])
      return { valid: false, achieved: NaN, error: "Mission segment is unavailable." };
    const mission = JSON.parse(JSON.stringify(sourceMission));
    mission.segments = mission.segments.slice(0, index + 1);
    const segment = mission.segments[index];
    if (segment.type !== "transfer" && segment.type !== "depart")
      return { valid: false, achieved: NaN, error: "Segment is not a Transfer or Depart." };
    segment.tofDays = +tofDays;
    segment.periKm = +targetAltitudeKm;
    if (segment.type === "transfer") {
      // Keep trial residuals usable by the outer bounded solver. The final
      // Apply step enables the card's strict one-kilometre Achieve check.
      segment.targetMode = "off";
      delete segment.targetValue;
    }
    if (fixedAimOffsetKm === null || fixedAimOffsetKm === undefined)
      delete segment.aimOffsetKm;
    else segment.aimOffsetKm = +fixedAimOffsetKm;

    const initialOffset = Number.isFinite(baseDepartureOffset)
      ? baseDepartureOffset : windowDepartureOffset(index);
    let epochJD = +departureJD - initialOffset / DAY;
    let result = null;
    for (let pass = 0; pass < 3; pass++) {
      mission.epoch = A.jdToDate(epochJD).toISOString();
      result = ME.recompute(mission);
      const actualJD = result.epochJD +
        evaluatedWindowDepartureOffset(result, segment, index) / DAY;
      const errorDays = +departureJD - actualJD;
      if (Math.abs(errorDays * DAY) <= 0.5) break;
      epochJD += errorDays;
    }
    const errors = mission.segments.flatMap((entry) => (entry._warn || [])
      .filter((warning) => warning.level === "error"));
    const targetBody = BODIES[segment.target];
    const achieved = targetBody && segment._info && Number.isFinite(segment._info.rpTargeted)
      ? segment._info.rpTargeted - targetBody.radius : NaN;
    return {
      valid: Number.isFinite(achieved) && errors.length === 0,
      achieved,
      residual: achieved - +targetAltitudeKm,
      aimOffsetKm: segment._info && Number.isFinite(segment._info.aimOffsetKm)
        ? segment._info.aimOffsetKm : NaN,
      actualDepartureJD: result.epochJD +
        evaluatedWindowDepartureOffset(result, segment, index) / DAY,
      segmentType: segment.type,
      errors,
    };
  }

  function windowMissionCandidate() {
    if (!S.mission) return null;
    for (const type of ["depart", "transfer"]) {
      for (let index = 0; index < S.mission.segments.length; index++) {
        const segment = S.mission.segments[index];
        if (segment.type !== type || !BODIES[segment.target]) continue;
        const source = windowSegmentSource(index);
        const target = segment.target;
        if (source && source !== "sun" && source !== target && BODIES[source] &&
            BODIES[target] && BODIES[source].parent === BODIES[target].parent) {
          return { index, source, target,
            tofDays: +segment.tofDays || 200 };
        }
      }
    }
    return { index: -1, source: "earth", target: "mars", tofDays: 210 };
  }

  function windowDateInputValue(jd) {
    return A.jdToDate(jd).toISOString().slice(0, 10);
  }

  function clearWindowPlot(message) {
    if (WIN.signal) WIN.signal.aborted = true;
    WIN.signal = null;
    WIN.runId++;
    WIN.grid = null;
    WIN.hovered = null;
    WIN.selected = null;
    WIN.targetSolution = null;
    WIN.plot = null;
    const selection = $("winSelection"), tooltip = $("winTooltip");
    if (selection) selection.hidden = true;
    if (tooltip) tooltip.hidden = true;
    const apply = $("winApply");
    if (apply) apply.disabled = true;
    if ($("winTargetStatus")) $("winTargetStatus").textContent =
      "Uses the departure and TOF ranges above as hard bounds.";
    const progress = $("winProgressBar");
    if (progress) progress.style.width = "0%";
    windowBusy(false);
    windowTargetBusy(false);
    drawWindowPlot();
    if (message) windowStatus(message);
  }

  function configureWindowForMission() {
    if (!windowPresent() || !S.result) return;
    const candidate = windowMissionCandidate();
    const from = $("winFrom"), to = $("winTo");
    from.innerHTML = windowBodyOptions(candidate.source);
    to.innerHTML = windowBodyOptions(candidate.target);
    from.value = candidate.source;
    to.value = candidate.target;

    const departureJD = S.result.epochJD +
      (candidate.index >= 0 ? windowDepartureOffset(candidate.index) / DAY : 0);
    const spanDays = Math.min(1600, Math.max(45, Math.ceil(candidate.tofDays * 2.4)));
    const startJD = departureJD - spanDays * 0.34;
    $("winStart").value = windowDateInputValue(startJD);
    $("winEnd").value = windowDateInputValue(startJD + spanDays);
    $("winTofMin").value = Math.max(0.25, Math.round(candidate.tofDays * 0.55 * 4) / 4);
    $("winTofMax").value = Math.max(+$("winTofMin").value + 0.25,
      Math.round(candidate.tofDays * 1.65 * 4) / 4);
    $("winGrid").value = "80x60";
    $("winMetric").value = "c3";
    clearWindowPlot("Search controls matched to the current mission. Generate when ready.");
    syncWindowApplySegments();
  }

  function windowGridConfig() {
    const dimensions = String($("winGrid").value || "80x60").split("x").map(Number);
    const start = $("winStart").value;
    const end = $("winEnd").value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      throw new Error("Enter both departure dates.");
    }
    return {
      from: $("winFrom").value,
      to: $("winTo").value,
      departureStart: start + "T00:00:00Z",
      departureEnd: end + "T00:00:00Z",
      departureCount: dimensions[0],
      tofMinDays: +$("winTofMin").value,
      tofMaxDays: +$("winTofMax").value,
      tofCount: dimensions[1],
    };
  }

  function windowMetric() {
    const value = $("winMetric") ? $("winMetric").value : "c3";
    return WINDOW_METRICS[value] ? value : "c3";
  }

  function windowMetricRange(grid, metric) {
    const values = grid.cells.filter((cell) => cell && cell.valid && isFinite(cell[metric]))
      .map((cell) => cell[metric]).sort((a, b) => a - b);
    if (!values.length) return null;
    const pick = (fraction) => values[Math.min(values.length - 1,
      Math.max(0, Math.floor((values.length - 1) * fraction)))];
    const low = pick(0.02), high0 = pick(0.90);
    const high = high0 > low ? high0 : low + Math.max(Math.abs(low) * 0.01, 1e-6);
    return { low, high };
  }

  function windowBand(value, range, count) {
    const normalized = Math.max(0, Math.min(1, (value - range.low) / (range.high - range.low)));
    return Math.min(count - 1, Math.floor(Math.pow(normalized, 0.62) * count));
  }

  function windowPalette(theme) {
    return theme === "cinematic"
      ? ["#ff6a3d", "#ef6040", "#d85348", "#b84852", "#923f5c", "#6d365c",
          "#4d2d54", "#352746", "#252139", "#191a2d", "#101523", "#0b101b"]
      : ["#e5541e", "#ec6c38", "#f18453", "#f09d72", "#edb591", "#e8cbb2",
          "#ded8c9", "#c7c5bb", "#aaa9a2", "#858680", "#5d5f5c", "#333536"];
  }

  function windowFormatValue(value, metric) {
    if (!isFinite(value)) return "—";
    return value.toFixed(metric === "c3" ? 2 : 3);
  }

  function windowCellHtml(cell) {
    if (!cell || !cell.valid) return "No Lambert solution";
    const departure = A.jdToDate(cell.departureJD).toISOString().slice(0, 10);
    const arrival = A.jdToDate(cell.arrivalJD).toISOString().slice(0, 10);
    return `<strong>${departure} → ${arrival}</strong>` +
      `<span>TOF ${cell.tofDays.toFixed(2)} d</span>` +
      `<span>C3 ${cell.c3.toFixed(2)} km²/s²</span>` +
      `<span>Departure v∞ ${cell.departureVInfinity.toFixed(3)} km/s</span>` +
      `<span>Arrival v∞ ${cell.arrivalVInfinity.toFixed(3)} km/s</span>` +
      `<span>Total Δv* ${cell.totalCharacteristicVelocity.toFixed(3)} km/s</span>`;
  }

  function resizeWindowCanvas() {
    const canvas = $("winCanvas");
    if (!canvas) return;
    const box = canvas.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(box.width * dpr), height = Math.round(box.height * dpr);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    drawWindowPlot();
  }

  function drawWindowPlot() {
    const canvas = $("winCanvas");
    if (!canvas) return;
    const box = canvas.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const ctx = canvas.getContext("2d");
    const width = canvas.width / dpr, height = canvas.height / dpr;
    const cinematic = $("app") && $("app").dataset.theme === "cinematic";
    const theme = cinematic ? "cinematic" : "blueprint";
    const text = cinematic ? "rgba(226,231,241,.82)" : "rgba(28,29,32,.82)";
    const faint = cinematic ? "rgba(154,163,181,.65)" : "rgba(85,86,79,.7)";
    const line = cinematic ? "rgba(255,255,255,.16)" : "rgba(28,29,32,.25)";
    const background = cinematic ? "#090d17" : "#fbfaf6";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
    ctx.font = "10px IBM Plex Mono, JetBrains Mono, monospace";
    ctx.textBaseline = "middle";

    if (!WIN.grid) {
      ctx.strokeStyle = line;
      ctx.setLineDash([3, 4]);
      ctx.strokeRect(18.5, 18.5, Math.max(0, width - 37), Math.max(0, height - 37));
      ctx.setLineDash([]);
      ctx.fillStyle = faint;
      ctx.textAlign = "center";
      ctx.fillText("GENERATE A WINDOW GRID", width / 2, height / 2 - 5);
      ctx.font = "9px IBM Plex Mono, JetBrains Mono, monospace";
      ctx.fillText("Lambert cells are evaluated in responsive chunks", width / 2, height / 2 + 13);
      WIN.plot = null;
      return;
    }

    const grid = WIN.grid;
    const metric = windowMetric();
    const meta = WINDOW_METRICS[metric];
    const range = windowMetricRange(grid, metric);
    const plot = { left: 44, top: 31, right: 10, bottom: 30 };
    plot.width = Math.max(1, width - plot.left - plot.right);
    plot.height = Math.max(1, height - plot.top - plot.bottom);
    plot.cellW = plot.width / grid.width;
    plot.cellH = plot.height / grid.height;
    WIN.plot = plot;

    ctx.fillStyle = text;
    ctx.textAlign = "left";
    ctx.font = "600 9.5px IBM Plex Mono, JetBrains Mono, monospace";
    ctx.fillText(meta.label.toUpperCase(), plot.left, 12);
    if (range) {
      ctx.font = "9px IBM Plex Mono, JetBrains Mono, monospace";
      ctx.fillStyle = faint;
      ctx.textAlign = "right";
      ctx.fillText(`${windowFormatValue(range.low, metric)} → ` +
        `${windowFormatValue(range.high, metric)} ${meta.unit}`, width - plot.right, 12);
    }

    ctx.fillStyle = cinematic ? "#070a12" : "#f2f0e8";
    ctx.fillRect(plot.left, plot.top, plot.width, plot.height);
    if (range) {
      const palette = windowPalette(theme);
      const bands = new Array(grid.cells.length);
      ctx.imageSmoothingEnabled = false;
      for (const cell of grid.cells) {
        if (!cell || !cell.valid || !isFinite(cell[metric])) continue;
        const band = windowBand(cell[metric], range, palette.length);
        bands[cell.index] = band;
        const x = plot.left + cell.departureIndex * plot.cellW;
        const y = plot.top + (grid.height - cell.tofIndex - 1) * plot.cellH;
        ctx.fillStyle = palette[band];
        ctx.fillRect(x, y, Math.ceil(plot.cellW + 0.2), Math.ceil(plot.cellH + 0.2));
      }

      // Band boundaries provide contour-like structure without a plotting library.
      ctx.beginPath();
      for (const cell of grid.cells) {
        if (!cell || !cell.valid || bands[cell.index] === undefined) continue;
        const x = plot.left + cell.departureIndex * plot.cellW;
        const y = plot.top + (grid.height - cell.tofIndex - 1) * plot.cellH;
        if (cell.departureIndex + 1 < grid.width) {
          const next = bands[cell.index + 1];
          if (next !== undefined && next !== bands[cell.index]) {
            ctx.moveTo(x + plot.cellW, y); ctx.lineTo(x + plot.cellW, y + plot.cellH);
          }
        }
        if (cell.tofIndex + 1 < grid.height) {
          const next = bands[cell.index + grid.width];
          if (next !== undefined && next !== bands[cell.index]) {
            ctx.moveTo(x, y); ctx.lineTo(x + plot.cellW, y);
          }
        }
      }
      ctx.strokeStyle = cinematic ? "rgba(255,255,255,.16)" : "rgba(28,29,32,.22)";
      ctx.lineWidth = 0.65;
      ctx.stroke();
    }

    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    ctx.strokeRect(plot.left + 0.5, plot.top + 0.5, plot.width, plot.height);
    ctx.fillStyle = faint;
    ctx.font = "8.5px IBM Plex Mono, JetBrains Mono, monospace";
    for (let i = 0; i <= 2; i++) {
      const fraction = i / 2;
      const x = plot.left + fraction * plot.width;
      const jd = grid.departuresJD[Math.round(fraction * (grid.width - 1))];
      const date = A.jdToDate(jd);
      const label = String(date.getUTCMonth() + 1).padStart(2, "0") + "/" +
        String(date.getUTCDate()).padStart(2, "0");
      ctx.strokeStyle = line;
      ctx.beginPath(); ctx.moveTo(x, plot.top + plot.height); ctx.lineTo(x, plot.top + plot.height + 4); ctx.stroke();
      ctx.fillStyle = faint;
      ctx.textAlign = i === 0 ? "left" : (i === 2 ? "right" : "center");
      ctx.fillText(label, x, plot.top + plot.height + 14);
    }
    for (let i = 0; i <= 3; i++) {
      const fraction = i / 3;
      const y = plot.top + (1 - fraction) * plot.height;
      const tof = grid.timesOfFlightDays[Math.round(fraction * (grid.height - 1))];
      ctx.strokeStyle = line;
      ctx.beginPath(); ctx.moveTo(plot.left - 4, y); ctx.lineTo(plot.left, y); ctx.stroke();
      ctx.fillStyle = faint;
      ctx.textAlign = "right";
      ctx.fillText(tof < 10 ? tof.toFixed(1) : Math.round(tof).toString(), plot.left - 7, y);
    }

    const outlineCell = (cell, color, lineWidth) => {
      if (!cell || !cell.valid) return;
      const x = plot.left + cell.departureIndex * plot.cellW;
      const y = plot.top + (grid.height - cell.tofIndex - 1) * plot.cellH;
      ctx.strokeStyle = color; ctx.lineWidth = lineWidth;
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, plot.cellW - 1), Math.max(1, plot.cellH - 1));
    };
    const minimum = grid.minima[metric];
    if (minimum && minimum.valid) {
      const x = plot.left + (minimum.departureIndex + 0.5) * plot.cellW;
      const y = plot.top + (grid.height - minimum.tofIndex - 0.5) * plot.cellH;
      const radius = 4;
      ctx.beginPath(); ctx.moveTo(x, y - radius); ctx.lineTo(x + radius, y);
      ctx.lineTo(x, y + radius); ctx.lineTo(x - radius, y); ctx.closePath();
      ctx.fillStyle = cinematic ? "#fff" : "#fbfaf6";
      ctx.fill(); ctx.strokeStyle = cinematic ? "#ff9d7c" : "#1c1d20"; ctx.lineWidth = 1.2; ctx.stroke();
    }
    outlineCell(WIN.selected, cinematic ? "#ffffff" : "#1c1d20", 2);
    outlineCell(WIN.hovered, cinematic ? "#ffcfbf" : "#e5541e", 1.5);
  }

  function windowCellFromPointer(event) {
    if (!WIN.grid || !WIN.plot) return null;
    const canvas = $("winCanvas"), rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    const plot = WIN.plot;
    if (x < plot.left || x > plot.left + plot.width ||
        y < plot.top || y > plot.top + plot.height) return null;
    const departureIndex = Math.min(WIN.grid.width - 1,
      Math.max(0, Math.floor((x - plot.left) / plot.cellW)));
    const tofIndex = Math.min(WIN.grid.height - 1,
      Math.max(0, WIN.grid.height - 1 - Math.floor((y - plot.top) / plot.cellH)));
    return WIN.grid.cells[tofIndex * WIN.grid.width + departureIndex] || null;
  }

  function showWindowTooltip(event, cell) {
    const tooltip = $("winTooltip"), wrap = tooltip && tooltip.parentElement;
    if (!tooltip || !wrap || !cell || !cell.valid) {
      if (tooltip) tooltip.hidden = true;
      return;
    }
    tooltip.innerHTML = windowCellHtml(cell);
    tooltip.hidden = false;
    const rect = wrap.getBoundingClientRect();
    const x = event.clientX - rect.left + 12;
    const y = event.clientY - rect.top + 12;
    const maxX = Math.max(4, rect.width - tooltip.offsetWidth - 4);
    const maxY = Math.max(4, rect.height - tooltip.offsetHeight - 4);
    tooltip.style.left = Math.max(4, Math.min(maxX, x)) + "px";
    tooltip.style.top = Math.max(4, Math.min(maxY, y)) + "px";
  }

  function syncWindowApplySegments() {
    const select = $("winApplySegment"), apply = $("winApply");
    if (!select || !S.mission) return;
    const from = $("winFrom") ? $("winFrom").value : "";
    const to = $("winTo") ? $("winTo").value : "";
    const previous = select.value;
    const matches = [];
    S.mission.segments.forEach((segment, index) => {
      if ((segment.type !== "depart" && segment.type !== "transfer") ||
          segment.target !== to || windowSegmentSource(index) !== from) return;
      const sourceName = BODIES[from] ? BODIES[from].name : from;
      const targetName = BODIES[to] ? BODIES[to].name : to;
      matches.push({ index, label: `#${index + 1} ${segment.type.toUpperCase()}  ` +
        `${sourceName} → ${targetName}` });
    });
    select.innerHTML = matches.length
      ? matches.map((match) => `<option value="${match.index}">${esc(match.label)}</option>`).join("")
      : `<option value="">No matching Transfer / Depart segment</option>`;
    if (matches.some((match) => String(match.index) === previous)) select.value = previous;
    if (apply) apply.disabled = !(WIN.selected && matches.length);
    const targetSolve = $("winTargetSolve");
    const selectedIndex = select.value === "" ? -1 : +select.value;
    if (targetSolve) targetSolve.disabled = !(WIN.selected && selectedIndex >= 0 &&
      S.mission.segments[selectedIndex] &&
      (S.mission.segments[selectedIndex].type === "transfer" ||
       S.mission.segments[selectedIndex].type === "depart"));
  }

  function stageWindowCell(cell, preserveTarget) {
    if (!cell || !cell.valid) return;
    if (!preserveTarget && WIN.signal && WIN.signal.kind === "target")
      WIN.signal.aborted = true;
    WIN.selected = cell;
    if (!preserveTarget) WIN.targetSolution = null;
    const selection = $("winSelection"), readout = $("winSelectionReadout");
    if (selection) selection.hidden = false;
    if (readout) readout.innerHTML = windowCellHtml(cell);
    syncWindowApplySegments();
    const segmentSelect = $("winApplySegment");
    const segmentIndex = segmentSelect && segmentSelect.value !== ""
      ? +segmentSelect.value : -1;
    const segment = segmentIndex >= 0 && S.mission ? S.mission.segments[segmentIndex] : null;
    if (!preserveTarget && $("winTargetSeed") && segment)
      $("winTargetSeed").value = Math.max(0, isFinite(+segment.periKm) ? +segment.periKm : 1000);
    if (!preserveTarget && $("winTargetGoal") && segment)
      $("winTargetGoal").value = Math.max(0, segment.targetMode === "arrival-periapsis" &&
        isFinite(+segment.targetValue) ? +segment.targetValue :
        (isFinite(+segment.periKm) ? +segment.periKm : 300));
    if ($("winTargetStatus") && !preserveTarget) $("winTargetStatus").textContent =
      "Ready. Departure and TOF ranges above are hard solver bounds.";
    drawWindowPlot();
    const applySelect = $("winApplySegment");
    windowStatus(applySelect && applySelect.value !== ""
      ? "Solution staged. Review it, then use Apply departure epoch + TOF to confirm."
      : "Solution staged, but this mission has no matching Transfer or Depart segment.",
    applySelect && applySelect.value !== "" ? "ready" : "error");
  }

  async function solveWindowTransferTarget() {
    const cell = WIN.selected;
    const segmentSelect = $("winApplySegment");
    const index = segmentSelect && segmentSelect.value !== "" ? +segmentSelect.value : -1;
    const segment = index >= 0 && S.mission ? S.mission.segments[index] : null;
    const status = $("winTargetStatus");
    if (!cell || !segment || (segment.type !== "transfer" && segment.type !== "depart") || !MT ||
        typeof MT.solveTransferDateTofAsync !== "function") {
      if (status) status.textContent = "Select a staged Transfer or Depart solution.";
      return;
    }
    const targetBody = BODIES[$("winTo").value];
    const targetAlt = +$("winTargetGoal").value;
    const seedAlt = +$("winTargetSeed").value;
    const tolerance = +$("winTargetTolerance").value;
    const startJD = A.dateToJD($("winStart").value + "T00:00:00Z");
    const endJD = A.dateToJD($("winEnd").value + "T00:00:00Z");
    const tofMin = +$("winTofMin").value, tofMax = +$("winTofMax").value;
    if (!targetBody || ![targetAlt, seedAlt, tolerance, startJD, endJD,
      tofMin, tofMax].every(Number.isFinite) || targetAlt < 0 || seedAlt < 0 ||
      !(tolerance > 0) || !(endJD > startJD) || !(tofMax > tofMin && tofMin > 0)) {
      if (status) status.textContent = "Target, seed, tolerance, departure bounds, or TOF bounds are invalid.";
      return;
    }
    if (Number.isFinite(targetBody.soi) &&
        (targetBody.radius + targetAlt >= targetBody.soi ||
         targetBody.radius + seedAlt >= targetBody.soi)) {
      if (status) status.textContent = "Target and seed periapsis must both lie inside the target sphere of influence.";
      return;
    }
    const missionSnapshot = JSON.parse(JSON.stringify(S.mission));
    const missionFingerprint = windowTargetFingerprint(S.mission, index);
    const departureOffset = windowDepartureOffset(index);
    if (WIN.signal) WIN.signal.aborted = true;
    const signal = { aborted: false, kind: "target" };
    const runId = ++WIN.runId;
    WIN.signal = signal;
    WIN.targetSolution = null;
    windowBusy(true);
    windowTargetBusy(true);
    if (status) status.textContent = "Solving the applied mission trajectory inside the bounded departure date + TOF region…";
    try {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const seedEvaluation = evaluateAppliedWindowTarget(index, cell.departureJD,
        cell.tofDays, seedAlt, null, missionSnapshot, departureOffset);
      if (!seedEvaluation.valid || !Number.isFinite(seedEvaluation.aimOffsetKm)) {
        const detail = seedEvaluation.errors && seedEvaluation.errors[0]
          ? seedEvaluation.errors[0].msg : (seedEvaluation.error || "no valid applied trajectory");
        throw new Error("Could not derive a fixed B-plane aim from the seed: " + detail);
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const fixedAimOffsetKm = seedEvaluation.aimOffsetKm;
      const effectiveTolerance = Math.min(tolerance, 1);
      const report = await MT.solveTransferDateTofAsync({
        target: targetAlt,
        departureBoundsJD: [startJD, endJD],
        tofBoundsDays: [tofMin, tofMax],
        initialDepartureJD: cell.departureJD,
        initialTofDays: cell.tofDays,
        toleranceKm: effectiveTolerance,
        maxIterations: 24,
        maxEvaluations: 80,
        signal,
        yieldEvery: 1,
        yieldControl: () => new Promise((resolve) => requestAnimationFrame(resolve)),
        evaluate: ({ departureJD, tofDays }) => {
          const evaluated = evaluateAppliedWindowTarget(index, departureJD,
            tofDays, targetAlt, fixedAimOffsetKm, missionSnapshot, departureOffset);
          return { ...evaluated, detail: evaluated };
        },
      });
      if (runId !== WIN.runId || signal.aborted) return;
      if (windowTargetFingerprint(S.mission, index) !== missionFingerprint) {
        if (status) status.textContent =
          "Mission settings changed during the solve. The target result was discarded; solve again.";
        return;
      }
      const targetSolution = Object.freeze({ ...report,
        fixedAimOffsetKm, segmentIndex: index, targetBodyId: segment.target,
        targetAltitudeKm: targetAlt, toleranceKm: effectiveTolerance,
        missionFingerprint });
      WIN.targetSolution = targetSolution;
      if (!report.converged) {
        if (status) status.textContent = `Not converged (${report.status}) after ` +
          `${report.evaluations}/80 applied-trajectory evaluations. Best residual ` +
          `${isFinite(report.residual) ? report.residual.toFixed(3) + " km" : "unavailable"}; ` +
          `hard bounds ${$("winStart").value} to ${$("winEnd").value}, ` +
          `${tofMin.toFixed(3)} to ${tofMax.toFixed(3)} days were not exceeded.`;
        return;
      }
      const solvedCell = MW.evaluateCell({ from: $("winFrom").value,
        to: $("winTo").value, departureJD: report.departureJD,
        tofDays: report.tofDays });
      stageWindowCell(solvedCell, true);
      WIN.targetSolution = targetSolution;
      if (status) status.textContent = `Converged in ${report.iterations} iterations / ` +
        `${report.evaluations} evaluations · achieved ${report.achieved.toFixed(3)} km · ` +
        `residual ${report.residual.toFixed(3)} km · date ${report.variedDeparture ? "varied" : "at seed"}, ` +
        `TOF ${report.variedTof ? "varied" : "at seed"} · hard bounds ` +
        `${$("winStart").value} to ${$("winEnd").value}, ` +
        `${tofMin.toFixed(3)} to ${tofMax.toFixed(3)} days.`;
      windowStatus(`Joint ${segment.type === "depart" ? "Depart" : "Transfer"} target converged against the applied mission engine. Apply to commit the date, TOF, and fixed B-plane aim used by the solve.`, "ready");
    } catch (error) {
      if (runId === WIN.runId) {
        WIN.targetSolution = null;
        if (status) status.textContent = error && error.name === "AbortError"
          ? "Target solve canceled."
          : "Target solve failed: " + error.message;
      }
    } finally {
      if (runId === WIN.runId) {
        WIN.signal = null;
        windowBusy(false);
        windowTargetBusy(false);
      }
    }
  }

  async function generateWindowPlot() {
    if (!windowPresent()) return;
    if (!MW || typeof MW.iterateGrid !== "function") {
      windowStatus("Launch-window engine is unavailable. Reload the Planner.", "error");
      return;
    }
    let config;
    try { config = windowGridConfig(); }
    catch (error) { windowStatus(error.message, "error"); return; }

    if (WIN.signal) WIN.signal.aborted = true;
    const signal = { aborted: false, kind: "grid" };
    const runId = ++WIN.runId;
    WIN.signal = signal;
    WIN.grid = null;
    WIN.hovered = null;
    WIN.selected = null;
    const selection = $("winSelection"), tooltip = $("winTooltip");
    if (selection) selection.hidden = true;
    if (tooltip) tooltip.hidden = true;
    const apply = $("winApply");
    if (apply) apply.disabled = true;
    windowBusy(true);
    windowStatus("Evaluating Lambert grid…", "busy");
    const progressBar = $("winProgressBar");
    if (progressBar) progressBar.style.width = "0%";
    drawWindowPlot();

    try {
      let chunkNumber = 0;
      for await (const progress of MW.iterateGrid(config, {
        chunkSize: 96,
        signal,
        yieldControl: () => new Promise((resolve) => requestAnimationFrame(resolve)),
      })) {
        if (runId !== WIN.runId) return;
        WIN.grid = progress.grid;
        chunkNumber++;
        if (progressBar) progressBar.style.width = (progress.progress * 100).toFixed(1) + "%";
        if (progress.done || chunkNumber % 4 === 0) {
          drawWindowPlot();
          windowStatus(`Evaluating Lambert grid… ${progress.completed.toLocaleString()} / ` +
            `${progress.total.toLocaleString()} cells`, "busy");
        }
      }
      if (runId !== WIN.runId || !WIN.grid) return;
      drawWindowPlot();
      const metric = windowMetric();
      const minimum = WIN.grid.minima[metric];
      if (!minimum) {
        windowStatus("No valid Lambert cells were found. Widen the date or TOF range.", "error");
      } else {
        const meta = WINDOW_METRICS[metric];
        windowStatus(`${WIN.grid.validCells.toLocaleString()} valid cells. Minimum ${meta.label}: ` +
          `${windowFormatValue(minimum[metric], metric)} ${meta.unit}. Hover to inspect; click to stage.`, "ready");
      }
    } catch (error) {
      if (runId === WIN.runId) {
        if (error && error.name === "AbortError") windowStatus("Window search canceled.");
        else windowStatus("Window search failed: " +
          (error && error.message ? error.message : error), "error");
      }
    } finally {
      if (runId === WIN.runId) {
        WIN.signal = null;
        windowBusy(false);
      }
    }
  }

  function applyWindowSelection() {
    const cell = WIN.selected;
    const segmentSelect = $("winApplySegment");
    const index = segmentSelect && segmentSelect.value !== "" ? +segmentSelect.value : -1;
    const segment = index >= 0 && S.mission ? S.mission.segments[index] : null;
    if (!cell || !segment || (segment.type !== "depart" && segment.type !== "transfer")) {
      windowStatus("Select a valid plot cell and matching Transfer or Depart segment first.", "error");
      return;
    }

    const targetSolution = WIN.targetSolution && WIN.targetSolution.converged &&
      WIN.targetSolution.segmentIndex === index &&
      WIN.targetSolution.targetBodyId === segment.target &&
      WIN.targetSolution.missionFingerprint === windowTargetFingerprint(S.mission, index) &&
      Math.abs(WIN.targetSolution.departureJD - cell.departureJD) < 1e-10 &&
      Math.abs(WIN.targetSolution.tofDays - cell.tofDays) < 1e-8
      ? WIN.targetSolution : null;
    segment.tofDays = +cell.tofDays.toFixed(8);
    if (targetSolution) {
      if (segment.type === "transfer") {
        segment.targetMode = "arrival-periapsis";
        segment.targetValue = targetSolution.targetAltitudeKm;
      }
      segment.periKm = targetSolution.targetAltitudeKm;
      segment.aimOffsetKm = targetSolution.fixedAimOffsetKm;
    }
    S.expanded.add(index);
    // Align the actual injection event, not merely T+0, with the selected
    // porkchop departure date. A second pass removes any epoch-sensitive wait.
    let epochJD = cell.departureJD - windowDepartureOffset(index) / DAY;
    S.mission.epoch = A.jdToDate(epochJD).toISOString();
    $("epochInp").value = S.mission.epoch;
    recompute(true);
    for (let pass = 0; pass < 2; pass++) {
      const actualJD = S.result.epochJD + windowDepartureOffset(index) / DAY;
      const errorDays = cell.departureJD - actualJD;
      if (Math.abs(errorDays * DAY) <= 0.5) break;
      epochJD = S.result.epochJD + errorDays;
      S.mission.epoch = A.jdToDate(epochJD).toISOString();
      $("epochInp").value = S.mission.epoch;
      recompute(true);
    }
    const departure = A.jdToDate(cell.departureJD).toISOString().slice(0, 10);
    const errors = (segment._warn || []).filter((warning) => warning.level === "error");
    let achievedTarget = null;
    if (targetSolution) {
      const body = BODIES[segment.target];
      achievedTarget = body && segment._info && Number.isFinite(segment._info.rpTargeted)
        ? segment._info.rpTargeted - body.radius : NaN;
      if (!Number.isFinite(achievedTarget) ||
          Math.abs(achievedTarget - targetSolution.targetAltitudeKm) >
            targetSolution.toleranceKm) {
        errors.push({ level: "error", msg: Number.isFinite(achievedTarget)
          ? `Applied trajectory achieved ${achievedTarget.toFixed(3)} km, outside the solved ` +
            `${targetSolution.targetAltitudeKm.toFixed(3)} ± ${targetSolution.toleranceKm.toFixed(3)} km target.`
          : "Applied trajectory did not produce a valid target periapsis." });
      }
    }
    if (errors.length) {
      windowStatus(`Settings were applied to segment #${index + 1}, but the mission could not ` +
        `execute that solution: ${errors[0].msg}`, "error");
      banner("Window applied, but the mission segment did not solve. Review its error message.", true);
    } else {
      const targetText = targetSolution
        ? ` Arrival-periapsis Vary/Achieve achieved ${achievedTarget.toFixed(3)} km for the stored ` +
          `${targetSolution.targetAltitudeKm.toFixed(3)} km target against the applied mission trajectory.` : "";
      windowStatus(`Applied ${departure} departure and ${cell.tofDays.toFixed(2)} d TOF to ` +
        `segment #${index + 1}. Mission T+0 was shifted to keep that injection date exact.${targetText}`, "success");
      banner(`Launch window applied to segment #${index + 1}: ${departure}, ` +
        `${cell.tofDays.toFixed(2)} days.`);
    }
  }

  function initWindowPlanner() {
    if (!windowPresent() || WIN.initialized) return;
    WIN.initialized = true;
    $("winFrom").innerHTML = windowBodyOptions("earth");
    $("winTo").innerHTML = windowBodyOptions("mars");
    $("winFrom").value = "earth";
    $("winTo").value = "mars";
    $("winGenerate").addEventListener("click", generateWindowPlot);
    $("winCancel").addEventListener("click", () => {
      if (!WIN.signal) return;
      WIN.signal.aborted = true;
      windowStatus(WIN.signal.kind === "target"
        ? "Canceling after the current applied-trajectory evaluation…"
        : "Canceling after the current Lambert chunk…", "busy");
    });
    $("winApply").addEventListener("click", applyWindowSelection);
    if ($("winTargetSolve")) $("winTargetSolve").addEventListener("click", solveWindowTransferTarget);
    $("winMetric").addEventListener("change", () => {
      WIN.hovered = null;
      drawWindowPlot();
      if (WIN.grid && WIN.grid.minima[windowMetric()]) {
        const metric = windowMetric(), minimum = WIN.grid.minima[metric];
        windowStatus(`Metric changed. Minimum ${WINDOW_METRICS[metric].label}: ` +
          `${windowFormatValue(minimum[metric], metric)} ${WINDOW_METRICS[metric].unit}.`, "ready");
      }
    });
    for (const id of ["winFrom", "winTo", "winStart", "winEnd", "winTofMin", "winTofMax", "winGrid"]) {
      const element = $(id);
      if (!element) continue;
      element.addEventListener("change", () => {
        if (id === "winFrom" || id === "winTo") syncWindowApplySegments();
        clearWindowPlot("Search settings changed. Generate a new grid.");
      });
    }
    $("winApplySegment").addEventListener("change", () => {
      if (WIN.signal && WIN.signal.kind === "target") WIN.signal.aborted = true;
      WIN.targetSolution = null;
      syncWindowApplySegments();
      if (WIN.selected) stageWindowCell(WIN.selected);
    });
    for (const id of ["winTargetGoal", "winTargetSeed", "winTargetTolerance"]) {
      const element = $(id);
      if (!element) continue;
      element.addEventListener("input", () => {
        if (WIN.signal && WIN.signal.kind === "target") WIN.signal.aborted = true;
        if (!WIN.targetSolution) return;
        WIN.targetSolution = null;
        if ($("winTargetStatus")) $("winTargetStatus").textContent =
          "Target controls changed. Solve again before applying a targeted trajectory.";
      });
    }

    const canvas = $("winCanvas");
    canvas.addEventListener("pointermove", (event) => {
      const cell = windowCellFromPointer(event);
      if (cell !== WIN.hovered) { WIN.hovered = cell && cell.valid ? cell : null; drawWindowPlot(); }
      showWindowTooltip(event, cell);
    });
    canvas.addEventListener("pointerleave", () => {
      WIN.hovered = null;
      $("winTooltip").hidden = true;
      drawWindowPlot();
    });
    canvas.addEventListener("click", (event) => stageWindowCell(windowCellFromPointer(event)));
    canvas.addEventListener("keydown", (event) => {
      const keyboardCell = WIN.hovered || (WIN.grid && WIN.grid.minima[windowMetric()]);
      if ((event.key === "Enter" || event.key === " ") && keyboardCell) {
        event.preventDefault();
        stageWindowCell(keyboardCell);
      }
    });

    if (globalThis.MutationObserver && $("app")) {
      WIN.themeObserver = new MutationObserver(() => drawWindowPlot());
      WIN.themeObserver.observe($("app"), { attributes: true, attributeFilter: ["data-theme"] });
    }
    drawWindowPlot();
  }

  /* ------------------------------ canvas ------------------------------- */
  const cv = $("cv");
  const g = cv.getContext("2d");
  const PLAYBACK_DPR_CAP = 1.5;
  let canvasDpr = 0;
  const renderDpr = () => Math.min(window.devicePixelRatio || 1,
    S.playing ? PLAYBACK_DPR_CAP : 2);
  function resizeMainCanvas(force) {
    const box = $("viz").getBoundingClientRect();
    const dpr = renderDpr();
    const width = Math.round(box.width * dpr);
    const height = Math.round(box.height * dpr);
    if (force || cv.width !== width || cv.height !== height) {
      cv.width = width;
      cv.height = height;
    }
    cv.style.width = box.width + "px";
    cv.style.height = box.height + "px";
    canvasDpr = dpr;
  }
  function syncRenderResolution() {
    if (Math.abs(renderDpr() - canvasDpr) > 0.01) resizeMainCanvas(false);
  }
  function resize() {
    resizeMainCanvas(true);
    resizeWindowCanvas();
    resizeAnalysisCanvases();
  }
  window.addEventListener("resize", resize);

  function makeScene(tNow, out) {
    const jd = S.result.epochJD + tNow / DAY;
    const activeResult = activeVehicleResult();
    const nativeVehicles = S.result.vehicleResults
      ? Object.values(S.result.vehicleResults).filter((result) => result.id !== S.activeVehicleId)
        .map((result) => ({
          id: result.id,
          name: result.name,
          color: result.color,
          role: result.role,
          result,
          epochJD: result.epochJD,
          localTime: tNow,
          nativeMissionVehicle: true,
          // The renderer derives one local orbital/reference-cycle window for
          // every inactive native vehicle. A role-specific override keeps the
          // ISS rendezvous context at the reviewed two-hour span.
          pathWindowS: result.role === "rendezvous-target" ? 2 * 3600 : null,
        })) : [];
    return {
      camera: S.camera,
      jd,
      epochJD: activeResult.epochJD,
      result: activeResult,
      missionResult: S.result,
      activeVehicleId: S.activeVehicleId,
      shipName: activeResult.name,
      tNow,
      frameBody: S.frameBody,
      cr3bpSystem: activeResult.cr3bpSystem || S.cr3bpSystem,
      shipSmp: tNow === S.tNow ? currentSample() :
        (activeResult.samples.length && tNow >= activeResult.samples[0].t &&
          tNow <= activeResult.samples[activeResult.samples.length - 1].t
          ? ME.sampleAtTime(activeResult, tNow) : null),
      multiCraft: nativeVehicles.concat(AN.crafts.map((craft) => ({
        id: craft.id,
        name: craft.mission.name,
        color: craft.color,
        result: craft.result,
        epochJD: craft.result.epochJD,
        localTime: (jd - craft.result.epochJD) * DAY,
      }))),
      options: S.options,
      out,
    };
  }

  // Full Planner frames build several long canvas paths and shaded body
  // sprites. On 120/144 Hz displays, repainting a native multi-vehicle
  // mission at monitor rate can issue millions of canvas operations per
  // second. Keep simulation/camera integration on every rAF, but cap Auto
  // Time and native fleet paint work at a stable 30 Hz. Single-vehicle manual
  // playback remains smooth up to 60 Hz instead of duplicating work on high-
  // refresh monitors; direct camera input while paused retains native rate.
  const AUTO_RENDER_INTERVAL_MS = 1000 / 30;
  const MANUAL_RENDER_INTERVAL_MS = 1000 / 60;
  function hasComplexNativeScene() {
    if (!S.result || !S.result.vehicleResults) return false;
    const results = Object.values(S.result.vehicleResults);
    if (results.length > 1) return true;
    return results.reduce((sum, result) =>
      sum + (result && result.samples ? result.samples.length : 0), 0) > 8000;
  }
  let last = performance.now(), lastPaint = 0, lastHudPaint = 0;
  document.addEventListener("visibilitychange", () => { last = performance.now(); });
  function frame(now) {
    // Do not convert a suspended/background tab into one giant playback step
    // when requestAnimationFrame resumes.
    const dt = Math.min(Math.max(now - last, 0), 250) / 1000;
    last = now;
    if (S.exporting) { requestAnimationFrame(frame); return; }   // GIF export owns the renderer
    if (document.hidden) { requestAnimationFrame(frame); return; }
    if (S.playing) {
      S.tNow += advanceStep(dt);
      const playbackEnd = resultTimeBounds(activeVehicleResult()).end;
      if (S.tNow >= playbackEnd) {
        S.tNow = playbackEnd; S.playing = false; updatePlayBtn(); updateHud();
      }
      $("scrub").value = S.tNow;
      if (now - lastHudPaint >= 100) { updateHud(); lastHudPaint = now; }
    }
    const dh = $("dwellHint");
    if (dh) setText("dwellHint", S.speedMode === "auto"
      ? (S.playing ? "AUTO · " + fmtRate(lastRate) : "")
      : (S.autoCam && S.speed >= 3600 ? "EVENT DWELL ON" : "—"));
    autoCamTick(Math.min(dt, 0.1));
    povTick();
    syncVirtualFocus();
    gtTick(now);
    // Dynamic playback resolution cuts high-DPI fill work by up to 44%, then
    // restores the full 2x paused drawing immediately when playback stops.
    syncRenderResolution();
    // A settled scene and accelerated Auto Time do not need native-refresh
    // full-canvas paints. Time pacing, event guards, and camera easing above
    // still run at every requestAnimationFrame callback.
    const paintInterval = S.playing
      ? (S.speedMode === "auto" || hasComplexNativeScene()
        ? AUTO_RENDER_INTERVAL_MS : MANUAL_RENDER_INTERVAL_MS)
      : (!drag ? AUTO_RENDER_INTERVAL_MS : 0);
    if (paintInterval && now - lastPaint < paintInterval) {
      requestAnimationFrame(frame); return;
    }
    lastPaint = now;
    const dpr = canvasDpr || renderDpr();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    S.pickOut = {};
    globalThis.MTPRender.draw(g, cv.width / dpr, cv.height / dpr, makeScene(S.tNow, S.pickOut));
    requestAnimationFrame(frame);
  }

  /* camera input */
  let drag = null;
  cv.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY, moved: 0, btn: e.button,
             pan: e.button === 2 || e.shiftKey || e.button === 1 };
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    if (Math.abs(dx) + Math.abs(dy) > 2) { setAutoCam(false); setPov(false); }
    drag.x = e.clientX; drag.y = e.clientY;
    const cam = S.camera;
    if (drag.pan) {
      const b = S.pickOut.basis;
      if (b) {
        const s = cam.dist / b.f;
        cam.pan = V.add(cam.pan, V.add(V.scale(b.Rt, -dx * s), V.scale(b.Up, dy * s)));
      }
    } else {
      if (Math.abs(dx) + Math.abs(dy) > 2) cancelTopView();
      cam.yaw -= dx * 0.0055;
      cam.pitch = Math.min(1.55, Math.max(-1.55, cam.pitch + dy * 0.0055));
    }
  });
  cv.addEventListener("pointerup", (e) => {
    const wasClick = drag && drag.btn === 0 && !drag.pan && drag.moved < 6;
    drag = null;
    if (!wasClick) return;
    const rect = cv.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    /* Mission event markers retain first pick priority. */
    const evPick = S.pickOut && S.pickOut.events;
    let best = null, bd = 9;
    if (evPick) for (const ep of evPick) {
        const d = Math.hypot(ep.x - mx, ep.y - my);
        if (d < bd) { bd = d; best = ep; }
    }
    if (best) {
      const vehicleSelect = $("vehicleSel");
      if (best.vehicleId && vehicleSelect && vehicleSelect.value !== best.vehicleId &&
          Array.from(vehicleSelect.options).some((option) => option.value === best.vehicleId)) {
        vehicleSelect.value = best.vehicleId;
        vehicleSelect.onchange();
      }
      S.tNow = best.t; $("scrub").value = best.t;
      resetPace(); resetAutoCamera(true); updateHud();
      banner("Jumped to " + (best.label || "event"));
      return;
    }
    const vehicles = S.pickOut && S.pickOut.vehicles || [];
    let vehicleHit = null, vehicleDistance = Infinity;
    for (const marker of vehicles) {
      if (!marker.nativeMissionVehicle) continue;
      const distance = Math.hypot(marker.x - mx, marker.y - my);
      if (distance <= (marker.r || 10) && distance < vehicleDistance) {
        vehicleDistance = distance;
        vehicleHit = marker;
      }
    }
    if (vehicleHit) {
      const vehicleSelect = $("vehicleSel");
      if (vehicleSelect && Array.from(vehicleSelect.options)
          .some((option) => option.value === vehicleHit.id)) {
        vehicleSelect.value = vehicleHit.id;
        vehicleSelect.onchange();
        viewShip();
        banner("Selected mission vehicle: " + (vehicleHit.name || vehicleHit.id));
      }
      return;
    }
    /* Virtual L-points rank below mission markers and above body focus. */
    const points = S.pickOut && S.pickOut.librationPoints;
    best = null; bd = Infinity;
    if (points) for (const point of points) {
      const d = Math.hypot(point.x - mx, point.y - my);
      const score = d / Math.max(10, point.r || 0);
      if (score <= 1 && score < bd) { bd = score; best = point; }
    }
    if (best) focusLibrationPoint(best);
  });
  cv.addEventListener("pointercancel", () => { drag = null; });
  cv.addEventListener("lostpointercapture", () => { drag = null; });
  cv.addEventListener("contextmenu", (e) => e.preventDefault());
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    setAutoCam(false);
    setPov(false);
    S.camera.dist *= Math.pow(1.14, e.deltaY > 0 ? 1 : -1);
    // zoom floor: just above the focused body’s surface, so the camera
    // can’t end up inside the planet (which filled the screen with texture)
    const fbZ = S.camera.focusMode === "body" ? S.camera.focusBody : null;
    const minD = fbZ && BODIES[fbZ] ? BODIES[fbZ].radius * 1.12 : 3;
    S.camera.dist = Math.min(Math.max(S.camera.dist, minD), 4e10);
  }, { passive: false });
  cv.addEventListener("dblclick", (e) => {
    const rect = cv.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const points = S.pickOut.librationPoints || [];
    let marker = null, markerScore = Infinity;
    for (const point of points) {
      const score = Math.hypot(point.x - mx, point.y - my) / Math.max(10, point.r || 0);
      if (score <= 1 && score < markerScore) { markerScore = score; marker = point; }
    }
    if (marker) { focusLibrationPoint(marker); viewFocus(); return; }
    const bodies = S.pickOut.bodies || {};
    let best = null, bestScore = Infinity;
    for (const id in bodies) {
      const p = bodies[id];
      if (!p) continue;
      const d = Math.hypot(p.x - mx, p.y - my);
      const hitR = Math.max(12, Math.min(p.r || 0, 80));
      const score = d / hitR;
      if (score <= 1 && score < bestScore) { bestScore = score; best = id; }
    }
    if (best) {
      setAutoCam(false);
      setPov(false);
      clearVirtualFocus();
      S.camera.focusMode = "body";
      S.camera.focusBody = best;
      S.camera.pan = [0, 0, 0];
      setViewBtn(null);
      banner("Focus: " + BODIES[best].name + " \u2014 press F to zoom to it");
    }
  });

  /* ---------------------------- transport ------------------------------ */
  function updatePlayBtn() { $("btnPlay").textContent = S.playing ? "❚❚" : "▶\uFE0E"; }
  $("btnPlay").addEventListener("click", () => {
    const result = activeVehicleResult();
    const bounds = resultTimeBounds(result);
    if (!S.playing && S.tNow >= bounds.end) {
      S.tNow = bounds.start;
      resetPace(); resetAutoCamera(true);
    }
    S.playing = !S.playing;
    updatePlayBtn();
  });
  $("btnReset").addEventListener("click", () => {
    const result = activeVehicleResult();
    S.tNow = result && result.samples.length ? result.samples[0].t : 0;
    S.playing = false; resetPace(); resetAutoCamera(true); updatePlayBtn();
    $("scrub").value = S.tNow; updateHud();
  });
  $("scrub").addEventListener("input", () => {
    S.tNow = +$("scrub").value;
    resetPace();
    resetAutoCamera(true);
    updateHud();
  });
  $("speedSel").addEventListener("change", () => {
    const v = $("speedSel").value;
    if (v === "auto") S.speedMode = "auto";
    else { S.speedMode = "manual"; S.speed = +v; }
    resetPace();
  });
  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
    if (e.code === "Space") { e.preventDefault(); $("btnPlay").click(); }
    if (e.key === "r" || e.key === "R") $("btnReset").click();
    if (e.key === "a" || e.key === "A") $("btnAuto").click();
    if ((e.key === "v" || e.key === "V") && $("btnPov")) $("btnPov").click();
    if ((e.key === "g" || e.key === "G") && $("btnTrack")) $("btnTrack").click();
    if ((e.key === "f" || e.key === "F") && $("btnFocus")) $("btnFocus").click();
  });

  /* ----------------------- mission library (browser) -------------------- */
  function missionStore() {
    try { return JSON.parse(localStorage.getItem("mtp-missions")) || {}; }
    catch (e) { return {}; }
  }
  function writeStore(st) {
    try { localStorage.setItem("mtp-missions", JSON.stringify(st)); }
    catch (e) { banner("Could not save (browser storage unavailable): " + e.message, true); }
  }
  function missionSnapshot() {
    const snapshot = {
      format: "mtp-mission-2",
      name: S.mission.name,
      epoch: S.mission.epoch,
      description: S.mission.description || "",
      history: S.mission.history || [],
      spacecraft: S.mission.spacecraft,
      segments: S.mission.segments.map(cleanSegment),
      vehicles: (S.mission.vehicles || []).map(cleanVehicle),
    };
    for (const key of ["uncertainty", "operations", "targetingValidation"])
      if (S.mission[key] !== undefined) snapshot[key] = S.mission[key];
    return snapshot;
  }
  function saveMissionToStore() {
    const nm2 = ($("missionName").value || "Untitled mission").trim();
    S.mission.name = nm2;
    const st = missionStore();
    st[nm2] = missionSnapshot();
    writeStore(st);
    initSelectors();
    $("presetSel").value = "local:" + encodeURIComponent(nm2);
    $("frameSel").value = S.frameBody;
    banner("Saved \u201C" + nm2 + "\u201D to this browser's mission library.");
  }

  /* ------------------------------ exports ------------------------------ */
  function download(name, blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  const fileStem = () => (S.mission.name || "mission").replace(/[^\w-]+/g, "_").slice(0, 40);

  $("btnPng").addEventListener("click", () => {
    cv.toBlob((b) => download(fileStem() + "_" + Math.round(S.tNow / 3600) + "h.png", b), "image/png");
  });

  $("btnJsonExport").addEventListener("click", () => {
    const out = missionSnapshot();
    download(fileStem() + ".json", new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }));
  });

  $("jsonImportFile").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (!f) return;
    f.text().then((txt) => {
      const m = JSON.parse(txt);
      if (m.format && !["mtp-mission-1", "mtp-mission-2"].includes(m.format))
        throw new Error("unsupported mission format: " + m.format);
      if (!m.segments || !Array.isArray(m.segments)) throw new Error("no segments[]");
      if (!m.epoch || !isFinite(Date.parse(m.epoch))) throw new Error("bad epoch");
      for (const s of m.segments) {
        if (!ME.SEGMENT_TYPES[s.type]) throw new Error("unknown segment type: " + s.type);
        ME.applySegmentDefaults(s, { legacyLaunch: m.format !== "mtp-mission-2" });
      }
      const vehicles = Array.isArray(m.vehicles) ? m.vehicles : [];
      if (vehicles.length > 7) throw new Error("at most seven secondary vehicles are supported");
      const ids = new Set(["primary"]);
      for (const vehicle of vehicles) {
        const id = String(vehicle && vehicle.id || "").trim();
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id) || ids.has(id))
          throw new Error("vehicle ids must be unique identifiers and cannot be 'primary'");
        if (vehicle.color && !/^#[0-9a-f]{6}$/i.test(vehicle.color))
          throw new Error("vehicle " + id + " has an invalid #RRGGBB color");
        ids.add(id);
        if (!Array.isArray(vehicle.segments)) throw new Error("vehicle " + id + " has no segments[]");
        for (const segment of vehicle.segments) {
          if (!ME.SEGMENT_TYPES[segment.type])
            throw new Error("unknown segment type in " + id + ": " + segment.type);
          ME.applySegmentDefaults(segment, { legacyLaunch: m.format !== "mtp-mission-2" });
        }
      }
      const definitions = [{ id: "primary", segments: m.segments }].concat(vehicles);
      const byId = Object.fromEntries(definitions.map((vehicle) => [vehicle.id, vehicle]));
      for (const vehicle of definitions) for (let index = 0; index < vehicle.segments.length; index++) {
        const segment = vehicle.segments[index];
        const ref = segment.type === "separate" ? segment.fromVehicle
          : (segment.type === "rendezvous" || segment.type === "dock" ? segment.targetVehicle : null);
        if (ref && !byId[ref]) throw new Error("unknown vehicle reference '" + ref + "'");
        if (ref === vehicle.id) throw new Error("vehicle '" + vehicle.id + "' cannot target itself");
        if (segment.type === "separate") {
          if (vehicle.id === "primary" || index !== 0)
            throw new Error("Separate must be the first segment of a secondary vehicle");
          const source = byId[segment.fromVehicle];
          if (!source || +segment.afterSegment < 1 || +segment.afterSegment > source.segments.length)
            throw new Error("Separate references a missing parent segment");
        }
      }
      loadMission({
        name: m.name || "Imported mission", epoch: m.epoch,
        description: m.description || "", history: m.history || [],
        spacecraft: m.spacecraft || null,
        segments: m.segments,
        vehicles,
        uncertainty: m.uncertainty,
        operations: m.operations,
        targetingValidation: m.targetingValidation,
      });
      banner("Mission imported.");
    }).catch((err) => banner("Import failed: " + err.message, true))
      .finally(() => { e.target.value = ""; });
  });

  $("catImportFile").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (!f) return;
    f.text().then((txt) => {
      const arr = JSON.parse(txt);
      const list = Array.isArray(arr) ? arr : [arr];
      let n = 0;
      for (const def of list) { C.registerBody(def); n++; }
      A.clearEphemCaches();
      globalThis.MTPRender.invalidateCache();
      initSelectors();
      recompute(true);
      buildGuide();
      banner(`Added ${n} bod${n === 1 ? "y" : "ies"} to the catalog.`);
    }).catch((err) => banner("Catalog import failed: " + err.message, true))
      .finally(() => { e.target.value = ""; });
  });

  $("btnCopyScript").addEventListener("click", async () => {
    const text = $("scriptPre").textContent;
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(text);
    } catch (err) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand && document.execCommand("copy");
      ta.remove();
      if (!ok) { banner("Copy failed — select the script text and copy it manually.", true); return; }
    }
    banner("Script copied to clipboard.");
  });

  /* ------------------------------- GIF ---------------------------------- *
   * v1.4: streaming encoder (no raw-frame memory blowup), selectable camera
   * (current / auto / ship / POV), linear or auto-paced full-mission time
   * mapping, and an optional ground-track overlay.                          */
  const GIF_MAX_FRAMES = 1200;

  function gifTimes(result, fps, timeMode, durS) {
    const bounds = resultTimeBounds(result);
    const tStart = bounds.start, tEnd = bounds.end;
    const times = [];
    if (timeMode === "paced") {
      // simulate the Auto Time integrator at the GIF frame rate
      const dtF = 1 / fps;
      let t = tStart, sm = null, guard = 0;
      const T = S.evT || [];
      while (t < tEnd && guard++ < 200000) {
        times.push(t);
        const tg = autoRate(t, result);
        if (sm == null) sm = tg;
        const tau = tg < sm ? 2.0 : 3.0;
        const k = 1 - Math.exp(-dtF / tau);
        sm = Math.exp(Math.log(sm) + (Math.log(Math.max(tg, 1)) - Math.log(sm)) * k);
        let step = dtF * sm;
        let lo = 0, hi = T.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m + 1; else hi = m; }
        if (lo < T.length) {
          const dNext = T[lo] - t;
          const crawlR = Math.max(autoRate(Math.max(T[lo] - 1, tStart), result), 30);
          const w = Math.max(S.evW && S.evW[lo] !== undefined ? S.evW[lo] : 70,
            crawlR * 1.8);
          if (dNext > w) {
            const remain = dNext - w;
            step = Math.min(step, Math.max(dtF * crawlR * 1.15, remain * 0.30));
          } else step = Math.min(step, Math.max(dtF * crawlR * 1.15, 0.001));
        }
        t += step;
      }
      times.push(tEnd);
      if (times.length > GIF_MAX_FRAMES) {
        // even subsampling in frame space preserves the pacing profile
        const out = [];
        for (let i = 0; i < GIF_MAX_FRAMES; i++)
          out.push(times[Math.round((i * (times.length - 1)) / (GIF_MAX_FRAMES - 1))]);
        return out;
      }
      return times;
    }
    const N = Math.min(Math.round(fps * durS), GIF_MAX_FRAMES);
    for (let i = 0; i < N; i++)
      times.push(tStart + (tEnd - tStart) * i / Math.max(N - 1, 1));
    return times;
  }

  /* trimmed auto-camera for offline (GIF) rendering — same shot rules */
  function gifAutoCamStep(cam2, result, t, dtF, smp, gshot) {
    const jd = result.epochJD + t / DAY;
    if (smp.cr3bp && globalThis.CR3BP) {
      const system = globalThis.CR3BP.getSystem(smp.cr3bpSystem);
      const orbit = result.cr3bpOrbit;
      let extent = system.distanceKm * 0.04;
      if (orbit && orbit.states && orbit.states.length) {
        const equilibrium = globalThis.CR3BP.equilibriumPoint(system, orbit.point).position;
        extent = orbit.states.reduce((largest, state) => Math.max(largest,
          V.mag(V.sub(state.slice(0, 3), equilibrium)) * system.distanceKm), extent);
      }
      cam2.focusMode = "ship";
      cam2.focusBody = system.secondaryId;
      cam2.freeFocus = null;
      cam2.pan = [0, 0, 0];
      const distance = Math.max(extent * 5.5, BODIES[system.secondaryId].radius * 8);
      const blend = 1 - Math.exp(-dtF / 1.15);
      cam2.dist = Math.exp(Math.log(cam2.dist) +
        (Math.log(distance) - Math.log(cam2.dist)) * blend);
      return;
    }
    const cen = BODIES[smp.cen];
    const T = S.camEvT || [];
    let lo = 0, hi = T.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m + 1; else hi = m; }
    const dPrev = lo > 0 ? t - T[lo - 1] : Infinity;
    const dNext = lo < T.length ? T[lo] - t : Infinity;
    const rate = Math.max(autoRate(t, result), 30);
    const dNextR = dNext / rate, dPrevR = dPrev / rate;
    const nearEv = dNextR < 6 || dPrevR < 3 || (gshot.mode === "event" && dNextR < 7);
    const obsT = obsTargetAtT(t);
    let want = obsT ? "observe" : nearEv ? "event" : (smp.cen !== "sun" ? "local" : "cruise");
    if (want !== gshot.mode) {
      if (!gshot.mode || t - gshot.sinceT > rate * 6.5 ||
          (gshot.cen !== smp.cen && t - gshot.sinceT > rate * 2.2))
        Object.assign(gshot, { mode: want, sinceT: t, cen: smp.cen });
    } else gshot.cen = smp.cen;

    let dist, focusMode, focusBody = "sun";
    if (gshot.mode === "observe" && obsT) {
      const tw = A.bodyWorld(obsT, jd);
      focusMode = "body"; focusBody = obsT;
      dist = Math.max(V.mag(V.sub(smp.w, tw)) * 2.7, BODIES[obsT].radius * 5.5);
    } else if (smp.cen !== "sun") {
      const rNow = Math.max(V.mag(smp.r), cen.radius * 1.1);
      if (gshot.mode === "event") {
        focusMode = "ship";
        dist = Math.max(rNow * 2.6, cen.radius * 3.8);
        if (isFinite(cen.soi)) dist = Math.min(dist, cen.soi * 1.8);
      } else {
        const coe = A.rvToCoe(smp.r, smp.v, cen.mu);
        let extent = rNow;
        if (coe.e < 1 && isFinite(coe.ra)) {
          const cap = isFinite(cen.soi) ? cen.soi * 0.9 : coe.ra;
          extent = Math.max(rNow, Math.min(coe.ra, cap));
        }
        focusMode = "body"; focusBody = smp.cen;
        dist = Math.max(extent * 3.2, cen.radius * 7.5);
      }
    } else if (gshot.mode === "event") {
      focusMode = "ship";
      dist = Math.max(V.mag(smp.w) * 0.45, 0.6 * AU);
    } else {
      focusMode = "body"; focusBody = "sun";
      dist = Math.max(V.mag(smp.w) * 3.1, 3.5 * AU);
    }
    cam2.focusMode = focusMode;
    cam2.focusBody = focusBody;
    cam2.freeFocus = null;
    cam2.pan = [0, 0, 0];
    const k = 1 - Math.exp(-dtF / (gshot.mode === "event" ? 0.75 : 1.15));
    cam2.dist = Math.exp(Math.log(cam2.dist) + (Math.log(dist) - Math.log(cam2.dist)) * k);
  }

  function gifReferenceFrame(camMode, selectedFrame, sample) {
    if (!sample) return selectedFrame;
    // Current/Auto/Ship keep the Planner's selected reference frame just as
    // ordinary playback does. Corrected CR3BP camera modes opt into the
    // matching rotating frame, while onboard POV alone needs the local
    // central-body frame used to orient its look vector.
    if ((camMode === "auto" || camMode === "ship") && sample.cr3bp &&
        sample.cr3bpSystem) return "synodic:" + sample.cr3bpSystem;
    if (camMode === "pov") return sample.cen === "sun" ? "inertial" : sample.cen;
    return selectedFrame;
  }

  async function exportGif() {
    if (S.exporting) return;
    const exportResult = activeVehicleResult();
    const exportSpacecraft = activeSpacecraft();
    if (!exportResult || !exportResult.samples || !exportResult.samples.length) {
      banner("GIF export requires a propagated state for the selected vehicle.", true);
      return;
    }
    const W = +$("gifW").value;
    const fps = +$("gifFps").value;
    const durS = +$("gifDur").value;
    const camMode = $("gifCam") ? $("gifCam").value : "current";
    const timeMode = $("gifTime") ? $("gifTime").value : "linear";
    const withTrack = $("gifTrack") ? $("gifTrack").checked : false;
    const aspect = cv.height / cv.width;
    const H = Math.max(2, Math.round((W * aspect) / 2) * 2);

    const modal = $("gifModal");
    modal.classList.add("show");
    S.gifCancel = false;
    const bar = $("gifBar"), lbl = $("gifLbl");
    const off = document.createElement("canvas");
    off.width = W; off.height = H;
    const og = off.getContext("2d", { willReadFrequently: true });
    const gtc = withTrack ? document.createElement("canvas") : null;
    if (gtc) { gtc.width = 456; gtc.height = 228; }

    const times = gifTimes(exportResult, fps, timeMode, durS);
    const N = times.length;
    const dtF = 1 / fps;
    const cam2 = Object.assign({}, S.camera);
    cam2.pan = [0, 0, 0];
    cam2.freeFocus = S.camera.freeFocus ? V.clone(S.camera.freeFocus) : null;
    const gshot = { mode: "", sinceT: 0, cen: "" };
    const selectedFrame = S.frameBody;
    const resumePlayback = !!S.playing;
    const scFov = Math.min(140, Math.max(15,
      (exportSpacecraft && +exportSpacecraft.fovDeg) || 50)) * Math.PI / 180;
    if (camMode !== "pov" && camMode !== "current") cam2.fov = 50 * Math.PI / 180;
    if (camMode === "auto") {
      // converge onto the first shot instantly (dt≫τ) so the GIF doesn't
      // open with a slow drift in from wherever the live camera was
      const smp0 = ME.sampleAtTime(exportResult, times[0]);
      if (smp0) gifAutoCamStep(cam2, exportResult, times[0], 30, smp0, gshot);
    }
    S.playing = false;
    updatePlayBtn();
    S.exporting = true;

    try {
      const enc = globalThis.GifEnc.createEncoder({
        width: W, height: H, delayCs: Math.round(100 / fps), loop: 0, dither: true,
      });
      for (let i = 0; i < N; i++) {
        if (S.gifCancel) throw new Error("cancelled");
        const t = times[i];
        const smp = ME.sampleAtTime(exportResult, t);
        const frameB = gifReferenceFrame(camMode, selectedFrame, smp);
        if (camMode === "current" && S.virtualFocus && cam2.focusMode === "free" &&
            globalThis.MTPRender.librationPointWorld) {
          const markerWorld = globalThis.MTPRender.librationPointWorld(
            S.virtualFocus.systemId, S.virtualFocus.name,
            exportResult.epochJD + t / DAY, frameB);
          if (markerWorld) cam2.freeFocus = markerWorld;
        }
        if (smp) {
          if (camMode === "auto") gifAutoCamStep(cam2, exportResult, t, dtF, smp, gshot);
          else if (camMode === "ship") {
            cam2.focusMode = "ship";
            cam2.dist = Math.max(V.mag(smp.r) * 0.35, BODIES[smp.cen].radius * 3, 2000);
          } else if (camMode === "pov") {
            const obsT = obsTargetAtT(t);
            const jd2 = exportResult.epochJD + t / DAY;
            let vec = smp.r, look = smp.cen;
            if (obsT) { look = obsT; vec = V.sub(smp.w, A.bodyWorld(obsT, jd2)); }
            const u2 = V.norm(vec);
            cam2.fov = scFov;
            cam2.focusMode = "body";
            cam2.focusBody = look;
            cam2.dist = Math.max(V.mag(vec), BODIES[look].radius * 1.02);
            cam2.yaw = Math.atan2(u2[1], u2[0]);
            cam2.pitch = Math.asin(Math.max(-1, Math.min(1, u2[2])));
          }
        }
        const scene = makeScene(t);
        scene.camera = cam2;
        scene.frameBody = frameB;
        globalThis.MTPRender.draw(og, W, H, scene);
        if (gtc && smp) {
          const obsT = obsTargetAtT(t);
          const bodyId = obsT || (smp.cen !== "sun" ? smp.cen : null);
          if (bodyId) {
            const st = { result: exportResult, tNow: t, epochJD: exportResult.epochJD,
                         bodyId, sampleAtTime: ME.sampleAtTime };
            if (obsT) st.obsRanges = obsRangesFor(obsT);
            globalThis.MTPGroundTrack.draw(gtc, st);
            const tw2 = Math.round(W * 0.42), th2 = Math.round(tw2 / 2);
            og.globalAlpha = 0.92;
            og.drawImage(gtc, 8, H - th2 - 8, tw2, th2);
            og.globalAlpha = 1;
            og.strokeStyle = "rgba(255,255,255,0.45)";
            og.lineWidth = 1;
            og.strokeRect(8.5, H - th2 - 8.5, tw2, th2);
          }
        }
        enc.addFrame(og.getImageData(0, 0, W, H).data);
        if (i % 2 === 0) {
          bar.style.width = ((i / N) * 96).toFixed(1) + "%";
          lbl.textContent = `Frame ${i + 1}/${N} · ${(enc.bytes / 1048576).toFixed(1)} MB` +
            (timeMode === "paced" ? " · auto-paced" : "");
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      lbl.textContent = "Finalizing…";
      bar.style.width = "100%";
      await new Promise((r) => setTimeout(r, 10));
      const gif = enc.finish();
      download(fileStem() + ".gif", new Blob([gif], { type: "image/gif" }));
      lbl.textContent = `Done — ${N} frames, ${(gif.length / 1024 / 1024).toFixed(2)} MB`;
      await new Promise((r) => setTimeout(r, 700));
    } catch (err) {
      if (err.message !== "cancelled") banner("GIF export failed: " + err.message, true);
    } finally {
      S.exporting = false;
      S.playing = resumePlayback && S.tNow < resultTimeBounds(exportResult).end;
      updatePlayBtn();
      modal.classList.remove("show");
      globalThis.MTPRender.invalidateCache();
    }
  }
  $("btnGif").addEventListener("click", exportGif);
  $("gifCancel").addEventListener("click", () => { S.gifCancel = true; });

  /* ------------------------------ topbar -------------------------------- */
  $("presetSel").addEventListener("change", (e) => {
    const v = e.target.value;
    if (v === "__new") newMission();
    else if (v.startsWith("local:")) {
      const st = missionStore()[decodeURIComponent(v.slice(6))];
      if (st) { loadMission(JSON.parse(JSON.stringify(st))); banner("Loaded from the mission library."); }
    }
    else if (v) loadPreset(v);
  });
  const bSave = $("btnSaveMission");
  if (bSave) bSave.addEventListener("click", saveMissionToStore);
  const bDelSaved = $("btnDeleteSaved");
  if (bDelSaved) bDelSaved.addEventListener("click", () => {
    const sv2 = $("savedSel");
    if (!sv2 || !sv2.value) return;
    const nm2 = decodeURIComponent(sv2.value);
    const st = missionStore();
    delete st[nm2];
    writeStore(st);
    initSelectors();
    $("frameSel").value = S.frameBody;
    banner("Deleted \u201C" + nm2 + "\u201D from the library.");
  });
  $("missionName").addEventListener("change", (e) => { S.mission.name = e.target.value; updateScript(); });
  $("epochInp").addEventListener("change", (e) => {
    const v = e.target.value.trim();
    if (!isFinite(Date.parse(v))) { banner("Unparseable epoch — use ISO 8601, e.g. 1969-07-16T13:32:00Z", true); return; }
    S.mission.epoch = v;
    recompute(true);
  });
  $("btnAuto").addEventListener("click", () => {
    setAutoCam(!S.autoCam, true);
    banner(S.autoCam ? "Auto camera on — it will direct close-ups and wide shots."
                     : "Auto camera off.");
  });
  const bPov = $("btnPov");
  if (bPov) bPov.addEventListener("click", () => {
    setPov(!S.pov);
    banner(S.pov ? "Onboard camera — riding with the spacecraft. Drag or pick a view to exit."
                 : "Onboard camera off.");
  });
  const bTrack = $("btnTrack");
  if (bTrack) bTrack.addEventListener("click", () => setGt(!S.gtOpen));
  const bGtClose = $("gtClose");
  if (bGtClose) bGtClose.addEventListener("click", () => setGt(false));
  $("btnViewSolar").addEventListener("click", viewSolar);
  $("btnViewMission").addEventListener("click", viewMission);
  $("btnViewShip").addEventListener("click", viewShip);
  const bFocus = $("btnFocus");
  if (bFocus) bFocus.addEventListener("click", viewFocus);
  $("btnTop").addEventListener("click", viewTop);
  $("frameSel").addEventListener("change", (e) => {
    const previousFrame = S.frameBody;
    setAutoCam(false);
    setPov(false);
    setViewBtn(null);
    S.frameBody = e.target.value;
    const systemId = synodicSystemId(S.frameBody);
    if (systemId || synodicSystemId(previousFrame)) S.camera.pan = [0, 0, 0];
    if (systemId) {
      S.cr3bpSystem = systemId;
      const systemSelect = $("cr3bpSystemSel");
      if (systemSelect) systemSelect.value = systemId;
      if (S.virtualFocus) {
        S.virtualFocus = { systemId, name: S.virtualFocus.name };
        syncVirtualFocus();
      }
    }
    globalThis.MTPRender.invalidateCache();
  });

  for (const [id, key] of [["optOrbits", "orbits"], ["optLabels", "labels"], ["optSoi", "soi"],
                           ["optGrid", "grid"], ["optEvents", "events"], ["optApsides", "apsides"],
                           ["optEvLabels", "eventLabels"],
                           ["optMinor", "minor"], ["optTex", "textures"], ["optFlat", "flatLight"],
                           ["optLagrange", "lagrange"]]) {
    const el = $(id);
    if (!el) continue;                       // classic.html may lack newer toggles
    el.addEventListener("change", (e) => {
      S.options[key] = e.target.checked;
      if (key === "lagrange" && !e.target.checked && S.virtualFocus) {
        const system = globalThis.CR3BP && globalThis.CR3BP.getSystem(S.virtualFocus.systemId);
        clearVirtualFocus();
        S.camera.focusMode = "body";
        S.camera.focusBody = system ? system.secondaryId : "earth";
        S.camera.pan = [0, 0, 0];
      }
    });
    el.checked = S.options[key];
  }
  const cr3bpSystemSelect = $("cr3bpSystemSel");
  if (cr3bpSystemSelect) {
    cr3bpSystemSelect.value = S.cr3bpSystem;
    cr3bpSystemSelect.addEventListener("change", (e) => {
      S.cr3bpSystem = e.target.value;
      if (S.virtualFocus) {
        S.virtualFocus = { systemId: S.cr3bpSystem, name: S.virtualFocus.name };
        syncVirtualFocus();
      }
    });
  }

  /* tabs */
  const tabsEl = $("tabs");
  if (tabsEl) tabsEl.setAttribute("role", "tablist");
  document.querySelectorAll(".tabbtn").forEach((b, i) => {
    b.id = b.id || "tab_" + i;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-controls", b.dataset.pane);
    b.setAttribute("aria-selected", String(b.classList.contains("active")));
    const pane = $(b.dataset.pane);
    if (pane) {
      pane.setAttribute("role", "tabpanel");
      pane.setAttribute("aria-labelledby", b.id);
    }
    b.addEventListener("click", () => {
      document.querySelectorAll(".tabbtn").forEach((x) => {
        x.classList.remove("active"); x.setAttribute("aria-selected", "false");
      });
      document.querySelectorAll(".tabpane").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      b.setAttribute("aria-selected", "true");
      $(b.dataset.pane).classList.add("active");
      if (b.dataset.pane === "windowsPane")
        requestAnimationFrame(resizeWindowCanvas);
      if (b.dataset.pane === "dataPane")
        requestAnimationFrame(() => {
          refreshNativeFormationAnalysis(false);
          if (!AN.series && !AN.leg) refreshAnalysis();
          else resizeAnalysisCanvases();
        });
      if (globalThis.MTPThemeCtl && globalThis.MTPThemeCtl.syncPane)
        globalThis.MTPThemeCtl.syncPane(b.dataset.pane);
    });
  });

  /* add segment */
  $("btnAdd").addEventListener("click", () => {
    const type = $("addType").value;
    const segments = activeSegments();
    segments.push(ME.defaultSegment(type));
    S.expanded.add(segments.length - 1);
    recompute(true);
  });

  /* ------------------------------- init --------------------------------- */
  function initSelectors() {
    const savedStore = missionStore();
    const savedNames = Object.keys(savedStore).sort();
    $("presetSel").innerHTML =
      globalThis.Missions.PRESETS.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("") +
      (savedNames.length
        ? `<optgroup label="My missions">` + savedNames.map((nm2) =>
            `<option value="local:${encodeURIComponent(nm2)}">${esc(nm2)}</option>`).join("") + `</optgroup>`
        : "") +
      `<option value="__new">＋ New blank mission</option>`;
    const savedSel = $("savedSel");
    if (savedSel) savedSel.innerHTML = savedNames.length
      ? savedNames.map((nm2) => `<option value="${encodeURIComponent(nm2)}">${esc(nm2)}</option>`).join("")
      : `<option value="">— none saved —</option>`;
    $("addType").innerHTML = Object.entries(ME.SEGMENT_TYPES)
      .map(([k, v]) => `<option value="${esc(k)}">${esc(v.label)}</option>`).join("");
    // frame selector, grouped like the body selectors
    const fOpt = (b, indent) =>
      `<option value="${esc(b.id)}">${indent ? "&nbsp;&nbsp;↳ " : ""}${esc(b.name)}-relative</option>`;
    let fHtml = `<option value="inertial">Heliocentric inertial</option>`;
    if (globalThis.CR3BP) {
      fHtml += `<optgroup label="CR3BP rotating frames">` +
        `<option value="synodic:sun-earth">Sun-Earth synodic</option>` +
        `<option value="synodic:earth-moon">Earth-Moon synodic</option></optgroup>`;
    }
    const groups = [
      ["Planets & moons", (b) => b.type === "planet"],
      ["Dwarf planets", (b) => b.type === "dwarf"],
      ["Asteroids", (b) => b.type === "asteroid"],
      ["Custom", (b) => b.type === "custom" || b.type === "comet"],
    ];
    for (const [label, pred] of groups) {
      const tops = Object.values(BODIES).filter((b) => b.parent === "sun" && pred(b));
      if (!tops.length) continue;
      fHtml += `<optgroup label="${esc(label)}">`;
      for (const p of tops) {
        fHtml += fOpt(p, false);
        for (const m of C.childrenOf(p.id)) fHtml += fOpt(m, true);
      }
      fHtml += `</optgroup>`;
    }
    $("frameSel").innerHTML = fHtml;
    $("speedSel").innerHTML =
      `<option value="auto" ${S.speedMode === "auto" ? "selected" : ""}>AUTO · paced</option>` + [
      [1, "1 s/s"], [60, "1 min/s"], [600, "10 min/s"], [3600, "1 h/s"], [21600, "6 h/s"],
      [86400, "1 d/s"], [259200, "3 d/s"], [604800, "1 wk/s"], [2592000, "30 d/s"],
    ].map(([v, l]) => `<option value="${v}" ${S.speedMode !== "auto" && v === S.speed ? "selected" : ""}>${l}</option>`).join("");
    populateFleetSelector();
  }

  const scHead = $("scHead");
  if (scHead) scHead.addEventListener("click", () => $("scPanel").classList.toggle("open"));

  globalThis.MTPTex.init();
  initSelectors();
  initWindowPlanner();
  buildGuide();
  resize();
  loadPreset("apollo11");
  initAnalysisUI();
  $("presetSel").value = "apollo11";
  $("btnAuto").classList.toggle("active", S.autoCam);
  requestAnimationFrame((t) => { last = t; requestAnimationFrame(frame); });
})();
