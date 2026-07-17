/* =============================================================================
 * Mission Trajectory Planner - live Earth-orbit tracker controller.
 *
 * Physics scope: CelesTrak OMM general-perturbations element sets are
 * propagated by the bundled Vallado SGP4/SDP4 implementation. TEME output is
 * rotated through pseudo-Earth-fixed coordinates into the Planner's shared
 * ecliptic/body frame, keeping spacecraft, agency imagery, and Track longitude
 * on one convention. A first-order J2 model is retained only as an explicitly
 * labelled fallback for a record the SGP4 core cannot initialize/propagate.
 * All output is public prediction data, not telemetry, operational status,
 * pass assurance, conjunction assessment, or navigation data.
 * ========================================================================== */
"use strict";

(function () {
  const C = globalThis.AstroConst;
  const Astro = globalThis.Astro;
  const SGP4 = globalThis.MissionSGP4;
  const catalog = globalThis.MTPLiveCatalog;
  const $ = (id) => document.getElementById(id);

  const DAY_MS = 86400000;
  const DAY_S = C && C.DAY;
  const TWO_PI = 2 * Math.PI;
  const EARTH = C && C.BODIES && C.BODIES.earth;
  /* IAU-style Earth orientation for the TEME/PEF adapter. Its pole is the
     mean equator and its sidereal prime-meridian rate matches the GMST-only
     transform bundled with SGP4. The Planner body-frame code then expresses
     those axes in ecliptic J2000. UT1/EOP and polar motion remain outside the
     visualization-grade scope stated in the UI. */
  const LIVE_EARTH = Object.freeze(Object.assign({}, EARTH || {}, {
    iauOrientation: Object.freeze({
      poleRaDeg: Object.freeze([0, 0, 0]),
      poleDecDeg: Object.freeze([90, 0, 0]),
      primeMeridianDeg: Object.freeze([190.147, 360.9856235, 0]),
    }),
  }));
  const MU = EARTH && EARTH.mu;
  const R_EQUATOR = 6378.137;
  const J2 = 1.08262668e-3;
  const EARTH_ROTATION_RAD_S = 7.29211514670698e-5;
  const POV_FOV = 90 * (C ? C.DEG : Math.PI / 180);
  const GROUND_FRAME_MS = 100;
  const GROUND_MAX_SAMPLES = 1200;
  const MOTION_TRAIL_MS = 120000;
  const ELEMENT_STALE_MS = 3.5 * DAY_MS;
  const ELEMENT_FUTURE_MS = 6 * 3600000;

  function validPovState(state) {
    return !!(state && Array.isArray(state.r) && state.r.length === 3 &&
      state.r.every(Number.isFinite) && Astro && Astro.V &&
      Astro.V.mag(state.r) > R_EQUATOR + 1);
  }

  function groundWindowSpec(periodMin, atMs) {
    const periodS = Number.isFinite(periodMin) && periodMin > 0 ? periodMin * 60 : 5400;
    const halfWindowS = Math.max(5400, Math.min(43200, periodS * 1.25));
    const totalS = halfWindowS * 2;
    const targetStepS = Math.max(15, Math.min(120, periodS / 120));
    const count = Math.max(3, Math.min(GROUND_MAX_SAMPLES, Math.ceil(totalS / targetStepS) + 1));
    const stepS = totalS / (count - 1);
    const bucketMs = Math.max(60000, Math.min(300000, periodS * 1000 / 12));
    const centerMs = Math.floor(atMs / bucketMs) * bucketMs;
    return {
      firstMs: centerMs - halfWindowS * 1000,
      lastMs: centerMs + halfWindowS * 1000,
      count,
      stepS,
      bucketMs,
    };
  }

  function gmstRadians(jd) {
    if (SGP4 && typeof SGP4.gstime === "function") return SGP4.gstime(jd);
    const deg = 280.46061837 + 360.98564736629 * (jd - (C ? C.J2000_JD : 2451545));
    return ((deg % 360) + 360) % 360 * (C ? C.DEG : Math.PI / 180);
  }

  function temeToEarthFixedState(teme) {
    if (SGP4 && typeof SGP4.temeToEarthFixed === "function") {
      return SGP4.temeToEarthFixed(teme, teme.jd);
    }
    const theta = gmstRadians(teme.jd);
    const c = Math.cos(theta), s = Math.sin(theta);
    const r = teme.position;
    const fixedPosition = [c * r[0] + s * r[1], -s * r[0] + c * r[1], r[2]];
    let fixedVelocity = null;
    if (teme.velocity) {
      const v = teme.velocity;
      const rotating = [v[0] + EARTH_ROTATION_RAD_S * r[1],
        v[1] - EARTH_ROTATION_RAD_S * r[0], v[2]];
      fixedVelocity = [c * rotating[0] + s * rotating[1],
        -s * rotating[0] + c * rotating[1], rotating[2]];
    }
    return { jd: teme.jd, frame: "pseudo-Earth-fixed",
      position: fixedPosition, velocity: fixedVelocity };
  }

  function bodyFixedVectorToPlanner(vector, frame) {
    return [
      vector[0] * frame.x[0] + vector[1] * frame.y[0] + vector[2] * frame.z[0],
      vector[0] * frame.x[1] + vector[1] * frame.y[1] + vector[2] * frame.z[1],
      vector[0] * frame.x[2] + vector[1] * frame.y[2] + vector[2] * frame.z[2],
    ];
  }

  /* Embed pseudo-Earth-fixed coordinates in the same time-dependent body
     axes used by textures.js and groundtrack.js. The derivative term keeps
     the returned velocity inertial in the Planner world rather than merely
     rotating its components. */
  function earthFixedStateToPlanner(fixed) {
    if (!Astro || !Astro.bodyFrameAt || !EARTH || !fixed ||
        !Array.isArray(fixed.position) || !Number.isFinite(fixed.jd)) return null;
    const frame = Astro.bodyFrameAt(LIVE_EARTH, fixed.jd);
    if (!frame) return null;
    const position = bodyFixedVectorToPlanner(fixed.position, frame);
    let velocity = null;
    if (Array.isArray(fixed.velocity)) {
      velocity = bodyFixedVectorToPlanner(fixed.velocity, frame);
      /* A 30-second symmetric span avoids subtractive loss from representing
         sub-second offsets beside a 2.4-million-day Julian date. The rotation
         is smooth enough that its centered derivative remains far below the
         visualization error budget. */
      const halfSpanS = 30;
      const halfSpanJD = halfSpanS / DAY_S;
      const before = Astro.bodyFrameAt(LIVE_EARTH, fixed.jd - halfSpanJD);
      const after = Astro.bodyFrameAt(LIVE_EARTH, fixed.jd + halfSpanJD);
      if (before && after) {
        const axes = ["x", "y", "z"];
        const frameMotion = [0, 0, 0];
        for (let axis = 0; axis < 3; axis++) {
          for (let component = 0; component < 3; component++) {
            frameMotion[component] += fixed.position[axis] *
              (after[axes[axis]][component] - before[axes[axis]][component]) /
              (2 * halfSpanS);
          }
        }
        velocity = [velocity[0] + frameMotion[0], velocity[1] + frameMotion[1],
          velocity[2] + frameMotion[2]];
      }
    }
    return { jd: fixed.jd, frame: "ecliptic-J2000/planner-body",
      position, velocity, earthFixed: fixed };
  }

  function temeStateToPlanner(teme) {
    return earthFixedStateToPlanner(temeToEarthFixedState(teme));
  }

  function sunDirectionPlanner(jd) {
    if (!Astro || !Astro.bodyWorld || !Astro.V) return [1, 0, 0];
    return Astro.V.norm(Astro.V.scale(Astro.bodyWorld("earth", jd), -1));
  }

  /* Perspective camera equivalent to renderer.js's orbit camera: Earth is
     the focus, the spacecraft is the eye, and F points from the eye to Earth.
     The exact silhouette is intentionally allowed to extend beyond the
     viewport at low altitude, as it does from a real exterior camera. */
  function povCameraForState(state, viewportHeight) {
    if (!validPovState(state) || !(viewportHeight > 0)) return null;
    const dist = Astro.V.mag(state.r);
    const D = Astro.V.norm(state.r);
    const F = Astro.V.scale(D, -1);
    let Rt = Astro.V.norm(Astro.V.cross(F, [0, 0, 1]));
    if (Astro.V.mag(Rt) < 1e-6) Rt = [1, 0, 0];
    const Up = Astro.V.norm(Astro.V.cross(Rt, F));
    const f = (viewportHeight / 2) / Math.tan(POV_FOV / 2);
    const silhouetteDistance = Math.sqrt(dist * dist - R_EQUATOR * R_EQUATOR);
    return {
      pov: true, D, F, Rt, Up, dist, f,
      near: Math.max(1e-3, dist * 1e-4),
      // Exact perspective silhouette of a sphere viewed from an exterior eye.
      earthPx: f * R_EQUATOR / silhouetteDistance,
    };
  }

  function projectPov(point, basis, cx, cy) {
    const ex = Astro.V.dot(point, basis.Rt);
    const ey = Astro.V.dot(point, basis.Up);
    const ez = Astro.V.dot(point, basis.F) + basis.dist;
    const depth = Astro.V.dot(point, basis.D);
    if (!(ez > basis.near) || !Number.isFinite(ez))
      return { x: NaN, y: NaN, depth, visible: false };
    const x = cx + basis.f * ex / ez;
    const y = cy - basis.f * ey / ez;
    return { x, y, depth, visible: Number.isFinite(x) && Number.isFinite(y) };
  }

  function earthOccludes(point, basis) {
    if (!point || !basis) return false;
    if (basis.pov) {
      const eye = Astro.V.scale(basis.D, basis.dist);
      return Astro.pointOccludedBySphere(point, eye, [0, 0, 0], R_EQUATOR);
    }
    return Astro.pointOccludedBySphereOrthographic(point, basis.D, [0, 0, 0], R_EQUATOR);
  }

  function midpoint(a, b) {
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  }

  function occlusionBoundary(visiblePoint, hiddenPoint, basis) {
    let visible = visiblePoint.slice(), hidden = hiddenPoint.slice();
    for (let i = 0; i < 14; i++) {
      const mid = midpoint(visible, hidden);
      if (earthOccludes(mid, basis)) hidden = mid;
      else visible = mid;
    }
    return visible;
  }

  function visibleTrailStart(head, tail, basis) {
    if (!head || !tail || earthOccludes(head, basis)) return null;
    if (earthOccludes(tail, basis)) return occlusionBoundary(head, tail, basis);
    return earthOccludes(midpoint(head, tail), basis) ? null : tail;
  }

  if (globalThis.__MTP_TEST__) {
    globalThis.MTPLivePovTest = Object.freeze({
      validPovState, povCameraForState, projectPov, earthOccludes,
      visibleTrailStart, groundWindowSpec,
      gmstRadians, temeToEarthFixedState, earthFixedStateToPlanner,
      temeStateToPlanner, sunDirectionPlanner, earthBody: LIVE_EARTH,
      POV_FOV, R_EQUATOR,
    });
  }

  const app = $("app");
  const canvas = $("liveCanvas");
  const list = $("liveMissionList");
  if (!C || !Astro || !EARTH || !catalog || !app || !canvas || !list) return;

  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return;

  const trackerDisplay = globalThis.MTPTrackerDisplay;
  const displayState = trackerDisplay && trackerDisplay.state ? trackerDisplay.state : {
    paths: true, markers: true, labels: true, grid: true, textures: true, orbits: true,
    soi: false, flat: false,
  };

  const GROUPS = Object.freeze(["STATIONS", "SCIENCE", "RESOURCE"]);
  const GROUP_SHORT = Object.freeze({ STATIONS: "Station", SCIENCE: "Science", RESOURCE: "Earth obs" });

  const dom = {
    search: $("liveSearch"), group: $("liveGroup"), empty: $("liveEmpty"),
    catalogMeta: $("liveCatalogMeta"), topStatus: $("liveTopStatus"),
    source: $("liveSource"), refresh: $("btnLiveRefresh"),
    hudModel: $("liveHudModel"),
    catalogToggle: $("btnCatalogToggle"), play: $("btnLivePlay"),
    now: $("btnLiveNow"), speed: $("liveSpeed"), utc: $("liveUtc"),
    mode: $("liveMode"), fitAll: $("btnLiveFitAll"), pov: $("btnLivePov"),
    resetView: $("btnLiveResetView"), scale: $("liveScaleReadout"),
    card: $("liveCard"), cardClose: $("liveCardClose"),
    cardGroup: $("liveCardGroup"), cardTitle: $("liveCardTitle"),
    cardMeta: $("liveCardMeta"), cardSummary: $("liveCardSummary"),
    detailNorad: $("liveDetailNorad"), detailEpoch: $("liveDetailEpoch"),
    detailAltitude: $("liveDetailAltitude"), detailSpeed: $("liveDetailSpeed"),
    detailApsides: $("liveDetailApsides"), detailPlane: $("liveDetailPlane"),
    elementNote: $("liveCardElementNote"), wiki: $("liveWiki"),
    fitSelected: $("btnLiveFitSelected"),
    ground: $("btnLiveGround"), groundPanel: $("liveGroundPanel"),
    groundCanvas: $("liveGroundCanvas"), groundStatus: $("liveGroundStatus"),
  };

  /* -------------------------- catalog integrity -------------------------- */
  const missionById = new Map();
  const wantedByGroup = { STATIONS: new Set(), SCIENCE: new Set(), RESOURCE: new Set() };
  let catalogError = "";
  if (catalog.missions.length !== 100) catalogError = "Catalog integrity error: expected exactly 100 entries.";
  for (const m of catalog.missions) {
    if (missionById.has(m.norad)) catalogError = "Catalog integrity error: duplicate NORAD ID " + m.norad + ".";
    if (!wantedByGroup[m.group]) catalogError = "Catalog integrity error: unsupported group " + m.group + ".";
    missionById.set(m.norad, m);
    if (wantedByGroup[m.group]) wantedByGroup[m.group].add(m.norad);
  }

  function setSource(state, text) {
    if (dom.topStatus) dom.topStatus.dataset.state = state;
    if (dom.source) dom.source.textContent = text;
  }

  if (catalogError) setSource("offline", catalogError);

  /* -------------------------- mission list UI --------------------------- */
  const rows = new Map();
  let visibleMissions = catalog.missions.slice();
  let selectedId = null;
  let hoveredId = null;

  function syncRowTabStops(preferredId) {
    const visibleIds = new Set(visibleMissions.map((mission) => mission.norad));
    const activeId = visibleIds.has(preferredId) ? preferredId :
      (visibleIds.has(selectedId) ? selectedId : (visibleMissions[0] && visibleMissions[0].norad));
    for (const [id, entry] of rows) entry.row.tabIndex = id === activeId ? 0 : -1;
  }

  function moveRowFocus(norad, command) {
    if (!visibleMissions.length) return;
    let index = visibleMissions.findIndex((mission) => mission.norad === norad);
    if (command === "home") index = 0;
    else if (command === "end") index = visibleMissions.length - 1;
    else index = (Math.max(index, 0) + command + visibleMissions.length) % visibleMissions.length;
    const next = rows.get(visibleMissions[index].norad);
    if (next) {
      syncRowTabStops(visibleMissions[index].norad);
      next.row.focus();
    }
  }

  function buildList() {
    const frag = document.createDocumentFragment();
    for (const mission of catalog.missions) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "live-mission-row";
      row.dataset.norad = String(mission.norad);
      row.setAttribute("aria-pressed", "false");
      row.tabIndex = -1;
      row.title = mission.name + " - NORAD " + mission.norad;

      const dot = document.createElement("span");
      dot.className = "live-row-dot group-" + mission.group;
      dot.setAttribute("aria-hidden", "true");

      const copy = document.createElement("span");
      copy.className = "live-row-copy";
      const name = document.createElement("span");
      name.className = "live-row-name";
      name.textContent = mission.name;
      const meta = document.createElement("span");
      meta.className = "live-row-meta";
      meta.textContent = GROUP_SHORT[mission.group] + " / " + mission.agency + " / " + mission.norad;
      copy.append(name, meta);

      const state = document.createElement("span");
      state.className = "live-row-state";
      state.textContent = "CATALOG";
      row.append(dot, copy, state);
      row.addEventListener("click", () => selectMission(mission.norad, true));
      row.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown") { moveRowFocus(mission.norad, 1); event.preventDefault(); }
        else if (event.key === "ArrowUp") { moveRowFocus(mission.norad, -1); event.preventDefault(); }
        else if (event.key === "Home") { moveRowFocus(mission.norad, "home"); event.preventDefault(); }
        else if (event.key === "End") { moveRowFocus(mission.norad, "end"); event.preventDefault(); }
      });
      rows.set(mission.norad, { row, state });
      frag.appendChild(row);
    }
    list.replaceChildren(frag);
    syncRowTabStops(null);
  }

  function applyFilters() {
    const query = dom.search ? dom.search.value.trim().toLowerCase() : "";
    const group = dom.group ? dom.group.value : "ALL";
    visibleMissions = [];
    for (const mission of catalog.missions) {
      const haystack = (mission.name + " " + mission.agency + " " + mission.kind + " " + mission.norad).toLowerCase();
      const visible = (group === "ALL" || mission.group === group) && (!query || haystack.includes(query));
      const entry = rows.get(mission.norad);
      if (entry) entry.row.hidden = !visible;
      if (visible) visibleMissions.push(mission);
    }
    if (dom.empty) dom.empty.hidden = visibleMissions.length !== 0;
    if (selectedId && !visibleMissions.some((mission) => mission.norad === selectedId)) clearSelection();
    syncRowTabStops(selectedId);
    updateCatalogMeta();
  }

  function updateCatalogMeta() {
    if (!dom.catalogMeta) return;
    const withElements = elementById.size;
    dom.catalogMeta.textContent = catalog.missions.length + " catalog entries / " +
      withElements + " with elements / " + visibleMissions.length + " shown";
  }

  function elementEpochAudit(referenceMs) {
    let stale = 0, future = 0;
    for (const model of elementById.values()) {
      const ageMs = referenceMs - model.epochMs;
      if (ageMs > ELEMENT_STALE_MS) stale++;
      else if (ageMs < -ELEMENT_FUTURE_MS) future++;
    }
    return { stale, future, hasConcern: stale > 0 || future > 0 };
  }

  function elementEpochSuffix(referenceMs) {
    const audit = elementEpochAudit(referenceMs);
    const parts = [];
    if (audit.stale) parts.push(audit.stale + " stale epoch" + (audit.stale === 1 ? "" : "s"));
    if (audit.future) parts.push(audit.future + " future/predictive epoch" + (audit.future === 1 ? "" : "s"));
    return parts.length ? " / " + parts.join(" / ") : " / epochs current";
  }

  function updateRowStates() {
    const nowMs = Date.now();
    let sgp4Count = 0, sdp4Count = 0, fallbackCount = 0;
    for (const mission of catalog.missions) {
      const entry = rows.get(mission.norad);
      if (!entry) continue;
      const model = elementById.get(mission.norad);
      const hasElements = Boolean(model);
      const ageMs = model ? nowMs - model.epochMs : NaN;
      const stale = hasElements && ageMs > ELEMENT_STALE_MS;
      const future = hasElements && ageMs < -ELEMENT_FUTURE_MS;
      if (model) {
        if (model.sgp4Branch === "SDP4") sdp4Count++;
        else if (model.sgp4Branch === "SGP4") sgp4Count++;
        else fallbackCount++;
      }
      entry.row.classList.toggle("has-elements", hasElements);
      entry.row.classList.toggle("stale-elements", stale);
      entry.row.classList.toggle("predictive-elements", future);
      entry.state.textContent = stale ? "STALE" : (future ? "PRED" :
        (hasElements ? (model.sgp4Branch || "FALLBACK") : "CATALOG"));
      entry.state.title = stale ? "OMM element epoch is more than 3.5 days old" :
        (future ? "OMM carries a future/predictive epoch" :
          (hasElements ? (model.sgp4Branch
            ? "Current or cached OMM propagated with " + model.sgp4Branch
            : "Current or cached OMM using the labeled J2 fallback") : "Catalog metadata only"));
    }
    if (dom.hudModel) {
      dom.hudModel.textContent = elementById.size && fallbackCount === elementById.size
        ? "J2 FALLBACK" : "SGP4 / SDP4";
      dom.hudModel.title = sgp4Count + " SGP4 / " + sdp4Count + " SDP4 / " +
        fallbackCount + " J2 fallback";
    }
    updateCatalogMeta();
  }

  /* ------------------- OMM parsing + SGP4/SDP4 model -------------------- */
  const elementById = new Map();
  let stateById = new Map();

  function parseEpoch(value) {
    let text = String(value || "").trim();
    if (!text) return NaN;
    if (!/(?:Z|[+-]\d\d:?\d\d)$/i.test(text)) text += "Z";
    return Date.parse(text);
  }

  function finiteNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }

  function sanitizeRecord(record, group) {
    if (!record || typeof record !== "object") return null;
    const norad = Math.trunc(finiteNumber(record.NORAD_CAT_ID));
    if (!wantedByGroup[group] || !wantedByGroup[group].has(norad)) return null;
    const epochMs = parseEpoch(record.EPOCH);
    const meanMotion = finiteNumber(record.MEAN_MOTION);
    const eccentricity = finiteNumber(record.ECCENTRICITY);
    const inclination = finiteNumber(record.INCLINATION);
    const raan = finiteNumber(record.RA_OF_ASC_NODE);
    const argPerigee = finiteNumber(record.ARG_OF_PERICENTER);
    const meanAnomaly = finiteNumber(record.MEAN_ANOMALY);
    if (!Number.isFinite(epochMs) || !(meanMotion > 0) || !(eccentricity >= 0 && eccentricity < 1) ||
        !Number.isFinite(inclination) || !Number.isFinite(raan) ||
        !Number.isFinite(argPerigee) || !Number.isFinite(meanAnomaly)) return null;
    return {
      OBJECT_NAME: String(record.OBJECT_NAME || missionById.get(norad).name),
      OBJECT_ID: String(record.OBJECT_ID || ""),
      EPOCH: String(record.EPOCH),
      MEAN_MOTION: meanMotion,
      ECCENTRICITY: eccentricity,
      INCLINATION: inclination,
      RA_OF_ASC_NODE: raan,
      ARG_OF_PERICENTER: argPerigee,
      MEAN_ANOMALY: meanAnomaly,
      NORAD_CAT_ID: norad,
      MEAN_MOTION_DOT: Number.isFinite(finiteNumber(record.MEAN_MOTION_DOT)) ? finiteNumber(record.MEAN_MOTION_DOT) : 0,
      MEAN_MOTION_DDOT: Number.isFinite(finiteNumber(record.MEAN_MOTION_DDOT)) ? finiteNumber(record.MEAN_MOTION_DDOT) : 0,
      BSTAR: Number.isFinite(finiteNumber(record.BSTAR)) ? finiteNumber(record.BSTAR) : 0,
      REV_AT_EPOCH: Number.isFinite(finiteNumber(record.REV_AT_EPOCH)) ? finiteNumber(record.REV_AT_EPOCH) : 0,
    };
  }

  function buildModel(record) {
    const epochMs = parseEpoch(record.EPOCH);
    const meanMotionRevDay = finiteNumber(record.MEAN_MOTION);
    const n = meanMotionRevDay * TWO_PI / DAY_S;
    const a = Math.cbrt(MU / (n * n));
    const e = finiteNumber(record.ECCENTRICITY);
    const i = finiteNumber(record.INCLINATION) * C.DEG;
    const p = a * (1 - e * e);
    if (!Number.isFinite(epochMs) || !(a > R_EQUATOR) || !(p > 0)) return null;
    const cosI = Math.cos(i);
    const j2Scale = J2 * Math.pow(R_EQUATOR / p, 2);
    let sgp4Record = null;
    let sgp4Branch = null;
    let sgp4PeriodMin = NaN;
    let fallbackReason = "Bundled SGP4 core unavailable";
    if (SGP4 && typeof SGP4.initializeOMM === "function") {
      try {
        sgp4Record = SGP4.initializeOMM(record, { operationMode: "i" });
        const metadata = SGP4.metadata(sgp4Record);
        sgp4Branch = metadata.branch;
        sgp4PeriodMin = metadata.periodMinutes;
        fallbackReason = "";
      } catch (error) {
        fallbackReason = error && error.message ? error.message : "SGP4 initialization failed";
      }
    }
    return Object.freeze({
      record,
      sgp4Record,
      sgp4Branch,
      fallbackReason,
      epochMs,
      a,
      e,
      i,
      Om0: finiteNumber(record.RA_OF_ASC_NODE) * C.DEG,
      w0: finiteNumber(record.ARG_OF_PERICENTER) * C.DEG,
      M0: finiteNumber(record.MEAN_ANOMALY) * C.DEG,
      n,
      meanMotionRevDay,
      meanMotionDotRevDay2: finiteNumber(record.MEAN_MOTION_DOT) || 0,
      OmDot: -1.5 * n * j2Scale * cosI,
      wDot: 0.75 * n * j2Scale * (5 * cosI * cosI - 1),
      mJ2Dot: 0.75 * n * j2Scale * Math.sqrt(1 - e * e) * (3 * cosI * cosI - 1),
      rpAlt: a * (1 - e) - R_EQUATOR,
      raAlt: a * (1 + e) - R_EQUATOR,
      periodMin: Number.isFinite(sgp4PeriodMin) ? sgp4PeriodMin : 1440 / meanMotionRevDay,
    });
  }

  function secularElementsAt(model, atMs) {
    const dt = (atMs - model.epochMs) / 1000;
    const dtDays = dt / DAY_S;
    const dragPhase = Math.PI * model.meanMotionDotRevDay2 * dtDays * dtDays;
    return {
      a: model.a,
      e: model.e,
      i: model.i,
      Om: model.Om0 + model.OmDot * dt,
      w: model.w0 + model.wDot * dt,
      M: model.M0 + (model.n + model.mJ2Dot) * dt + dragPhase,
    };
  }

  function propagateLegacyJ2(model, atMs, fallbackReason) {
    const el = secularElementsAt(model, atMs);
    const E = Astro.solveKeplerE(el.M, el.e);
    const nu = Astro.trueFromEccAnomaly(E, el.e);
    const rv = Astro.coeToRV({ a: el.a, e: el.e, i: el.i, Om: el.Om, w: el.w, nu }, MU);
    const jd = 2440587.5 + atMs / DAY_MS;
    const planner = temeStateToPlanner({ jd, position: rv.r, velocity: rv.v });
    const r = planner ? planner.position : rv.r;
    const v = planner && planner.velocity ? planner.velocity : rv.v;
    const radius = Astro.V.mag(r);
    return {
      r,
      v,
      altitude: radius - R_EQUATOR,
      speed: Astro.V.mag(rv.v),
      radius,
      model,
      propagator: "J2 fallback",
      fallbackReason: fallbackReason || model.fallbackReason || "SGP4 propagation unavailable",
      sourceFrame: "mean-equator approximation",
    };
  }

  function propagateOMM(model, atMs) {
    if (model && model.sgp4Record && SGP4 && typeof SGP4.propagateDate === "function") {
      try {
        const teme = SGP4.propagateDate(model.sgp4Record, atMs);
        const planner = temeStateToPlanner(teme);
        if (!planner || !planner.position || !planner.velocity) {
          throw new Error("TEME-to-Planner frame conversion failed");
        }
        const radius = Astro.V.mag(planner.position);
        return {
          r: planner.position,
          v: planner.velocity,
          altitude: radius - R_EQUATOR,
          speed: Astro.V.mag(teme.velocity),
          radius,
          model,
          propagator: teme.branch,
          sourceFrame: "TEME",
          teme,
          earthFixed: planner.earthFixed,
        };
      } catch (error) {
        return propagateLegacyJ2(model, atMs,
          error && error.message ? error.message : "SGP4 propagation failed");
      }
    }
    return propagateLegacyJ2(model, atMs, model && model.fallbackReason);
  }

  function ingestRecords(group, records) {
    for (const raw of records) {
      const record = sanitizeRecord(raw, group);
      if (!record) continue;
      const model = buildModel(record);
      if (model) elementById.set(record.NORAD_CAT_ID, model);
    }
  }

  function replaceGroupRecords(group, records) {
    for (const norad of wantedByGroup[group]) elementById.delete(norad);
    ingestRecords(group, records);
  }

  /* ----------------------- bounded local data cache ---------------------- */
  function emptyCache() { return { version: 1, groups: {}, attempted: {} }; }

  function readCache() {
    try {
      const parsed = JSON.parse(localStorage.getItem(catalog.cacheKey) || "null");
      if (!parsed || parsed.version !== 1 || !parsed.groups || typeof parsed.groups !== "object") return emptyCache();
      if (!parsed.attempted || typeof parsed.attempted !== "object") parsed.attempted = {};
      return parsed;
    } catch (error) {
      return emptyCache();
    }
  }

  function writeCache(cache) {
    try { localStorage.setItem(catalog.cacheKey, JSON.stringify(cache)); } catch (error) {}
  }

  let cache = readCache();

  function cacheGroupValid(group) {
    const entry = cache.groups[group];
    return !!(entry && Number.isFinite(entry.fetchedAt) && Array.isArray(entry.records));
  }

  function cacheGroupFresh(group, nowMs) {
    return cacheGroupValid(group) && nowMs - cache.groups[group].fetchedAt < catalog.cacheMaxAgeMs;
  }

  function groupRecentlyRequested(group, nowMs) {
    const attemptedAt = Number(cache.attempted && cache.attempted[group]) || 0;
    const fetchedAt = cacheGroupValid(group) ? cache.groups[group].fetchedAt : 0;
    return nowMs - Math.max(attemptedAt, fetchedAt) < catalog.refreshMinAgeMs;
  }

  function loadCachedElements() {
    let newest = 0;
    let anyStale = false;
    const now = Date.now();
    for (const group of GROUPS) {
      if (!cacheGroupValid(group)) continue;
      ingestRecords(group, cache.groups[group].records);
      newest = Math.max(newest, cache.groups[group].fetchedAt);
      if (!cacheGroupFresh(group, now)) anyStale = true;
    }
    updateRowStates();
    if (elementById.size) {
      setSource("cached", (anyStale ? "Stale cached OMM" : "Cached CelesTrak OMM") +
        " / " + elementById.size + "/100" + elementEpochSuffix(now) + " / fetched " + formatShortUtc(newest));
    }
  }

  async function fetchGroup(group) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 15000) : null;
    try {
      const response = await fetch(catalog.sources[group], {
        cache: "no-store",
        signal: controller ? controller.signal : undefined,
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const payload = await response.json();
      if (!Array.isArray(payload)) throw new Error("Unexpected OMM response");
      const records = payload.map((record) => sanitizeRecord(record, group)).filter(Boolean);
      if (!records.length) throw new Error("No matching records in " + group);
      return records;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  let refreshPromise = null;
  let refreshTimer = null;

  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    const now = Date.now();
    let nextAt = Infinity;
    for (const group of GROUPS) {
      const attemptedAt = Number(cache.attempted && cache.attempted[group]) || 0;
      const fetchedAt = cacheGroupValid(group) ? cache.groups[group].fetchedAt : 0;
      const staleAt = fetchedAt ? fetchedAt + catalog.cacheMaxAgeMs : now;
      const allowedAt = attemptedAt ? attemptedAt + catalog.refreshMinAgeMs : now;
      nextAt = Math.min(nextAt, Math.max(staleAt, allowedAt));
    }
    const delay = Math.max(60000, Math.min(catalog.cacheMaxAgeMs, nextAt - now));
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refreshData(false);
    }, delay);
  }

  function refreshData(force) {
    if (refreshPromise) return refreshPromise;
    const now = Date.now();
    const targets = GROUPS.filter((group) => {
      if (groupRecentlyRequested(group, now)) return false;
      return force || !cacheGroupFresh(group, now);
    });
    if (!targets.length) {
      const newest = Math.max(...GROUPS.map((group) => cacheGroupValid(group) ? cache.groups[group].fetchedAt : 0));
      setSource(elementById.size ? "cached" : "offline",
        (elementById.size ? "Cached CelesTrak OMM / " + elementById.size + "/100 / " + formatShortUtc(newest) :
          "Offline catalog mode / no orbital elements") + " / refresh interval 2 h");
      scheduleRefresh();
      return Promise.resolve();
    }

    if (dom.refresh) dom.refresh.disabled = true;
    setSource(elementById.size ? "cached" : "cached",
      (elementById.size ? elementById.size + "/100 cached; " : "Catalog only; ") + "requesting CelesTrak OMM");

    for (const group of targets) cache.attempted[group] = Date.now();
    writeCache(cache);
    refreshPromise = Promise.all(targets.map(async (group) => {
      try {
        const records = await fetchGroup(group);
        cache.groups[group] = { fetchedAt: Date.now(), records };
        replaceGroupRecords(group, records);
        return { group, ok: true, count: records.length };
      } catch (error) {
        return { group, ok: false, count: 0 };
      }
    })).then((results) => {
      writeCache(cache);
      updateRowStates();
      updateStates(currentClockMs(performance.now()), true);
      updateSelectedCard(true);
      const successes = results.filter((result) => result.ok).length;
      const failed = results.length - successes;
      const newest = Math.max(...GROUPS.map((group) => cacheGroupValid(group) ? cache.groups[group].fetchedAt : 0));
      if (successes && !failed) {
        const audit = elementEpochAudit(Date.now());
        setSource(audit.hasConcern ? "cached" : "fresh", "CelesTrak OMM / " + elementById.size +
          "/100" + elementEpochSuffix(Date.now()) + " / fetched " + formatShortUtc(newest));
      } else if (elementById.size) {
        setSource("cached", "Partial/offline data / " + elementById.size + "/100 cached" +
          elementEpochSuffix(Date.now()) + " / " + failed + " group" + (failed === 1 ? "" : "s") + " unavailable");
      } else {
        setSource("offline", "Offline catalog mode / 0/100 orbital elements / retry when connected");
      }
    }).finally(() => {
      if (dom.refresh) dom.refresh.disabled = false;
      refreshPromise = null;
      scheduleRefresh();
    });
    return refreshPromise;
  }

  /* ----------------------------- clock ---------------------------------- */
  let playing = true;
  let speed = 1;
  let simMs = Date.now();
  let anchorSimMs = simMs;
  let anchorPerfMs = performance.now();
  let lastClockSecond = -1;

  function currentClockMs(perfMs) {
    if (playing) simMs = anchorSimMs + (perfMs - anchorPerfMs) * speed;
    return simMs;
  }

  function reanchorClock(nextMs) {
    simMs = nextMs;
    anchorSimMs = simMs;
    anchorPerfMs = performance.now();
  }

  function setPlaying(next) {
    if (playing === next) return;
    const now = currentClockMs(performance.now());
    playing = next;
    reanchorClock(now);
    updateClockControls(true);
  }

  function togglePlay() { setPlaying(!playing); }

  function returnToNow() {
    speed = 1;
    if (dom.speed) dom.speed.value = "1";
    playing = true;
    reanchorClock(Date.now());
    updateStates(simMs, true);
    updateClockControls(true);
  }

  function updateClockControls(force) {
    const wholeSecond = Math.floor(simMs / 1000);
    if (force || wholeSecond !== lastClockSecond) {
      lastClockSecond = wholeSecond;
      const date = new Date(simMs);
      if (dom.utc) {
        const iso = date.toISOString();
        dom.utc.dateTime = iso;
        dom.utc.textContent = iso.slice(0, 10) + " " + iso.slice(11, 19) + " UTC";
      }
    }
    // This runs every animation frame: only touch the DOM on real changes so
    // identical text/class assignments cannot dirty style at monitor rate.
    if (dom.play) {
      const playLabel = playing ? "Pause" : "Play";
      if (dom.play.textContent !== playLabel) {
        dom.play.textContent = playLabel;
        dom.play.setAttribute("aria-pressed", playing ? "true" : "false");
      }
    }
    if (dom.mode) {
      const atNow = playing && speed === 1 && Math.abs(simMs - Date.now()) < 5000;
      const modeClass = atNow ? "is-live" : (playing ? "is-sim" : "is-paused");
      const modeText = atNow ? "NOW" : (playing ? "SIM" : "PAUSED");
      if (dom.mode.className !== modeClass) dom.mode.className = modeClass;
      if (dom.mode.textContent !== modeText) dom.mode.textContent = modeText;
    }
  }

  /* ------------------------ propagation caching ------------------------- */
  let lastStatePerf = -Infinity;
  let lastStateSimMs = NaN;
  let selectedOrbit = [];
  let orbitForId = null;
  let orbitBuiltAt = NaN;
  let orbitBuiltPerf = -Infinity;
  let lastCardPerf = -Infinity;

  function updateStates(atMs, force, perfMs) {
    const nowPerf = Number.isFinite(perfMs) ? perfMs : performance.now();
    if (!force && atMs === lastStateSimMs) return;
    if (!force && nowPerf - lastStatePerf < 50) return;
    lastStatePerf = nowPerf;
    lastStateSimMs = atMs;
    const next = new Map();
    for (const [norad, model] of elementById) {
      const state = propagateOMM(model, atMs);
      /* Compute the honest two-minute motion cue at the existing 20 Hz state
         cadence, not again for every marker on every paint. */
      if (displayState.paths) state.trailR = propagateOMM(model, atMs - MOTION_TRAIL_MS).r;
      next.set(norad, state);
    }
    stateById = next;

    if (selectedId && elementById.has(selectedId) &&
        (orbitForId !== selectedId || !Number.isFinite(orbitBuiltAt) || nowPerf - orbitBuiltPerf > 2000)) {
      selectedOrbit = buildOrbitPath(elementById.get(selectedId), atMs, 241);
      orbitForId = selectedId;
      orbitBuiltAt = atMs;
      orbitBuiltPerf = nowPerf;
    } else if (!selectedId || !elementById.has(selectedId)) {
      selectedOrbit = [];
      orbitForId = selectedId;
      orbitBuiltAt = atMs;
      orbitBuiltPerf = nowPerf;
    }
    syncPovControl();
  }

  function buildOrbitPath(model, atMs, count) {
    const points = [];
    const periodMs = model.periodMin * 60000;
    for (let k = 0; k < count; k++) {
      const sampleMs = atMs + (k / (count - 1) - 0.5) * periodMs;
      points.push(propagateOMM(model, sampleMs).r);
    }
    return points;
  }

  /* ----------------------------- camera --------------------------------- */
  const view = { width: 1, height: 1, dpr: 1, cx: 0.5, cy: 0.5 };
  let yaw = -0.78;
  let pitch = 0.34;
  let earthPx = 92;
  let renderedEarthPx = earthPx;
  let povActive = false;
  let initializedView = false;
  let screenMarkers = [];
  let lastScaleText = "";

  function clamp(value, lo, hi) { return Math.max(lo, Math.min(hi, value)); }

  function cameraBasis() {
    if (povActive) {
      const pov = povCameraForState(selectedId ? stateById.get(selectedId) : null, view.height);
      if (pov) return pov;
    }
    const cp = Math.cos(pitch);
    const D = [cp * Math.cos(yaw), cp * Math.sin(yaw), Math.sin(pitch)];
    let Rt = Astro.V.norm(Astro.V.cross([0, 0, 1], D));
    if (Astro.V.mag(Rt) < 1e-6) Rt = [1, 0, 0];
    const Up = Astro.V.norm(Astro.V.cross(D, Rt));
    return { pov: false, D, Rt, Up, F: Astro.V.scale(D, -1) };
  }

  function syncPovControl() {
    const available = Boolean(selectedId && validPovState(stateById.get(selectedId)));
    if (povActive && !available) povActive = false;
    if (dom.pov) {
      dom.pov.disabled = !available;
      dom.pov.setAttribute("aria-pressed", povActive ? "true" : "false");
      dom.pov.classList.toggle("active", povActive);
      dom.pov.title = available
        ? "View from the selected spacecraft toward Earth (V)"
        : "Select a mission with orbital elements to enable spacecraft POV";
    }
    app.classList.toggle("pov-active", povActive);
  }

  function adoptPovAsOrbitView() {
    const pov = povCameraForState(selectedId ? stateById.get(selectedId) : null, view.height);
    if (!pov) return;
    yaw = Math.atan2(pov.D[1], pov.D[0]);
    pitch = Math.asin(clamp(pov.D[2], -1, 1));
    // Retain the on-screen scale when a manual gesture takes ownership.
    earthPx = clamp(pov.earthPx, 2, 320);
  }

  function setPovActive(next, preserveView) {
    const activate = Boolean(next);
    if (activate && !validPovState(selectedId ? stateById.get(selectedId) : null)) {
      syncPovControl();
      return false;
    }
    if (povActive && !activate && preserveView) adoptPovAsOrbitView();
    povActive = activate;
    syncPovControl();
    return povActive;
  }

  function togglePov() {
    setPovActive(!povActive, true);
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    view.width = width;
    view.height = height;
    view.dpr = dpr;
    view.cx = width / 2;
    view.cy = height / 2;
    if (!initializedView) {
      earthPx = clamp(Math.min(width, height) * 0.15, 58, 116);
      initializedView = true;
    }
  }

  function resetView() {
    setPovActive(false, false);
    yaw = -0.78;
    pitch = 0.34;
    earthPx = clamp(Math.min(view.width, view.height) * 0.15, 58, 116);
  }

  function fitAll() {
    setPovActive(false, true);
    let maxRadius = displayState.soi && Number.isFinite(EARTH.soi)
      ? EARTH.soi * 1.04 : R_EQUATOR * 1.1;
    for (const mission of visibleMissions) {
      const state = stateById.get(mission.norad);
      if (state) maxRadius = Math.max(maxRadius, state.radius);
    }
    earthPx = clamp(Math.min(view.width, view.height) * 0.43 * R_EQUATOR / maxRadius, 2, 260);
  }

  function fitSelected() {
    setPovActive(false, true);
    const model = selectedId ? elementById.get(selectedId) : null;
    if (!model) return;
    const apoapsisRadius = model.a * (1 + model.e);
    earthPx = clamp(Math.min(view.width, view.height) * 0.38 * R_EQUATOR / apoapsisRadius, 3, 260);
  }

  function project(point, basis) {
    if (basis.pov) return projectPov(point, basis, view.cx, view.cy);
    const scale = renderedEarthPx / R_EQUATOR;
    return {
      x: view.cx + Astro.V.dot(point, basis.Rt) * scale,
      y: view.cy - Astro.V.dot(point, basis.Up) * scale,
      depth: Astro.V.dot(point, basis.D),
      visible: true,
    };
  }

  /* ------------------------------ drawing -------------------------------- */
  const stars = [];
  let starSeed = 246813579;
  for (let i = 0; i < 220; i++) {
    starSeed = (1664525 * starSeed + 1013904223) >>> 0;
    const x = starSeed / 4294967296;
    starSeed = (1664525 * starSeed + 1013904223) >>> 0;
    const y = starSeed / 4294967296;
    starSeed = (1664525 * starSeed + 1013904223) >>> 0;
    stars.push([x, y, 0.25 + 0.75 * (starSeed / 4294967296)]);
  }

  /* Earth imagery, graticule, Track, and transformed SGP4 states all use the
     same Planner Astro.bodyFrameAt() axes. */
  const liveEarthBody = LIVE_EARTH;

  function initEarthTexture() {
    const data = globalThis.MTP_TEXTURE_DATA;
    const textures = globalThis.MTPTex;
    if (!data || !data.earth || !textures || typeof textures.init !== "function") return;
    const allData = data;
    try {
      globalThis.MTP_TEXTURE_DATA = { earth: allData.earth };
      textures.init();
    } finally {
      globalThis.MTP_TEXTURE_DATA = allData;
    }
  }

  function groupColors(cinematic) {
    return cinematic
      ? { STATIONS: "#ff6a3d", SCIENCE: "#58a6ff", RESOURCE: "#45c4b0", orbit: "#ff8f69" }
      : { STATIONS: "#e5541e", SCIENCE: "#1d4ed8", RESOURCE: "#0e7e74", orbit: "#c84618" };
  }

  function drawBackground(cinematic) {
    if (cinematic) {
      const gradient = ctx.createRadialGradient(view.cx, view.cy, 0, view.cx, view.cy, Math.max(view.width, view.height) * 0.72);
      gradient.addColorStop(0, "#101725");
      gradient.addColorStop(1, "#05070d");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, view.width, view.height);
      for (const star of stars) {
        ctx.globalAlpha = star[2] * 0.58;
        ctx.fillStyle = "#d7e2f5";
        ctx.fillRect(star[0] * view.width, star[1] * view.height, star[2] > 0.72 ? 1.4 : 0.8, star[2] > 0.72 ? 1.4 : 0.8);
      }
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = "#f7f6f1";
      ctx.fillRect(0, 0, view.width, view.height);
    }
    if (displayState.grid) {
      ctx.strokeStyle = cinematic ? "rgba(166,190,223,.055)" : "rgba(28,29,32,.065)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = (view.cx % 32); x < view.width; x += 32) { ctx.moveTo(x, 0); ctx.lineTo(x, view.height); }
      for (let y = (view.cy % 32); y < view.height; y += 32) { ctx.moveTo(0, y); ctx.lineTo(view.width, y); }
      ctx.stroke();
      ctx.strokeStyle = cinematic ? "rgba(166,190,223,.12)" : "rgba(28,29,32,.15)";
      ctx.beginPath();
      ctx.moveTo(view.cx, 0); ctx.lineTo(view.cx, view.height);
      ctx.moveTo(0, view.cy); ctx.lineTo(view.width, view.cy);
      ctx.stroke();
    }
  }

  function drawOrbitPass(front, basis, cinematic, color) {
    if (!selectedOrbit.length) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = front ? 0.9 : (cinematic ? 0.24 : 0.34);
    ctx.lineWidth = front ? 1.6 : 1;
    if (!front) ctx.setLineDash([4, 5]);
    if (cinematic && front) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
    }
    ctx.beginPath();
    let pen = false;
    let previousPoint = null;
    for (const point of selectedOrbit) {
      const p = project(point, basis);
      if (!p.visible || earthOccludes(point, basis)) { pen = false; previousPoint = null; continue; }
      const onPass = (p.depth >= 0) === front;
      if (!onPass) { pen = false; previousPoint = null; continue; }
      if (!pen) { ctx.moveTo(p.x, p.y); pen = true; }
      else if (previousPoint && earthOccludes(midpoint(previousPoint, point), basis)) {
        ctx.moveTo(p.x, p.y);
      } else ctx.lineTo(p.x, p.y);
      previousPoint = point;
    }
    ctx.stroke();
    ctx.restore();
  }

  /* -------------------------- Earth ground track ----------------------- */
  let groundOpen = false;
  let lastGroundPerf = -Infinity;
  let groundAdapterCache = { model: null, bucket: NaN, value: null };

  function resizeGroundCanvas() {
    if (!dom.groundCanvas) return false;
    const rect = dom.groundCanvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width || dom.groundCanvas.clientWidth || 1));
    const height = Math.max(1, Math.round(rect.height || dom.groundCanvas.clientHeight || 1));
    if (dom.groundCanvas.width === width && dom.groundCanvas.height === height) return false;
    dom.groundCanvas.width = width;
    dom.groundCanvas.height = height;
    return true;
  }

  function clearGroundCanvas() {
    if (!dom.groundCanvas) return;
    const groundContext = dom.groundCanvas.getContext("2d");
    if (groundContext) groundContext.clearRect(0, 0,
      dom.groundCanvas.width, dom.groundCanvas.height);
  }

  function setGroundStatus(text, state) {
    if (!dom.groundStatus) return;
    dom.groundStatus.textContent = text;
    if (state) dom.groundStatus.dataset.state = state;
    else delete dom.groundStatus.dataset.state;
  }

  function invalidateGroundTrack() { lastGroundPerf = -Infinity; }

  function earthGroundAdapter(model, atMs) {
    if (!model) return null;
    const spec = groundWindowSpec(model.periodMin, atMs);
    const bucket = Math.floor(atMs / spec.bucketMs);
    if (groundAdapterCache.model === model && groundAdapterCache.bucket === bucket) {
      return groundAdapterCache.value;
    }
    const samples = [];
    for (let i = 0; i < spec.count; i++) {
      const sampleMs = i === spec.count - 1 ? spec.lastMs : spec.firstMs + i * spec.stepS * 1000;
      const state = propagateOMM(model, sampleMs);
      samples.push({
        t: (sampleMs - spec.firstMs) / 1000,
        r: state.r.slice(), v: state.v.slice(), w: state.r.slice(), cen: "earth",
      });
    }
    const tEnd = (spec.lastMs - spec.firstMs) / 1000;
    const result = { samples, events: [], tEnd };
    const sampleAtTime = (_result, t) => {
      if (!Number.isFinite(t) || t < 0 || t > tEnd) return null;
      const state = propagateOMM(model, spec.firstMs + t * 1000);
      return { t, r: state.r.slice(), v: state.v.slice(), w: state.r.slice(), cen: "earth" };
    };
    const value = { result, sampleAtTime, firstMs: spec.firstMs,
      lastMs: spec.lastMs, epochJD: 2440587.5 + spec.firstMs / DAY_MS };
    groundAdapterCache = { model, bucket, value };
    return value;
  }

  function updateGroundTrack(nowPerf, force) {
    if (dom.groundPanel) groundOpen = !dom.groundPanel.hidden;
    if (!groundOpen || !dom.groundCanvas) return;
    if (!force && nowPerf - lastGroundPerf < GROUND_FRAME_MS) return;
    lastGroundPerf = nowPerf;
    resizeGroundCanvas();
    const groundTrack = globalThis.MTPGroundTrack;
    if (!groundTrack || typeof groundTrack.draw !== "function") {
      clearGroundCanvas();
      setGroundStatus("Ground-track renderer unavailable.", "unavailable");
      return;
    }
    const model = selectedId ? elementById.get(selectedId) : null;
    if (!model) {
      clearGroundCanvas();
      setGroundStatus("Select an Earth mission with current orbital elements.", "waiting");
      return;
    }
    const adapter = earthGroundAdapter(model, simMs);
    const details = groundTrack.draw(dom.groundCanvas, {
      result: adapter.result,
      tNow: (simMs - adapter.firstMs) / 1000,
      epochJD: adapter.epochJD,
      bodyId: "earth",
      body: liveEarthBody,
      sampleAtTime: adapter.sampleAtTime,
      bodyWorldAt: () => [0, 0, 0],
      sunDirectionAt: sunDirectionPlanner,
      fullBright: Boolean(displayState.flat),
    });
    if (details) {
      const currentState = stateById.get(selectedId);
      const propagation = currentState && currentState.propagator ||
        model.sgp4Branch || "J2 fallback";
      setGroundStatus("Earth / " + details.latDeg.toFixed(2) + " deg lat / " +
        details.lonDeg.toFixed(2) + " deg lon / " + Math.round(details.altKm).toLocaleString("en-US") +
        " km altitude / CelesTrak OMM + " + propagation + " prediction, not telemetry/operations", "ready");
    } else {
      setGroundStatus("Earth ground point unavailable at the displayed UTC.", "unavailable");
    }
  }

  const surfaceLines = [];
  for (const latDeg of [-60, -30, 0, 30, 60]) {
    const lat = latDeg * C.DEG;
    const points = [];
    for (let k = 0; k <= 96; k++) {
      const lon = k / 96 * TWO_PI;
      points.push([
        R_EQUATOR * Math.cos(lat) * Math.cos(lon),
        R_EQUATOR * Math.cos(lat) * Math.sin(lon),
        R_EQUATOR * Math.sin(lat),
      ]);
    }
    surfaceLines.push(points);
  }
  for (let m = 0; m < 6; m++) {
    const lon = m / 6 * Math.PI;
    const points = [];
    for (let k = 0; k <= 96; k++) {
      const lat = -Math.PI / 2 + k / 96 * Math.PI;
      points.push([
        R_EQUATOR * Math.cos(lat) * Math.cos(lon),
        R_EQUATOR * Math.cos(lat) * Math.sin(lon),
        R_EQUATOR * Math.sin(lat),
      ]);
    }
    surfaceLines.push(points);
  }

  function drawSurfaceLine(points, basis, frame) {
    ctx.beginPath();
    let pen = false;
    for (const point of points) {
      const p = project(bodyFixedVectorToPlanner(point, frame), basis);
      const horizonDepth = basis.pov ? R_EQUATOR * R_EQUATOR / basis.dist : 0;
      if (p.depth < horizonDepth || !p.visible) { pen = false; continue; }
      if (!pen) { ctx.moveTo(p.x, p.y); pen = true; }
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }

  function drawGraticule(basis, jd, cinematic) {
    const frame = Astro.bodyFrameAt(liveEarthBody, jd);
    if (!frame) return;
    ctx.save();
    ctx.strokeStyle = cinematic ? "rgba(210,225,245,.18)" : "rgba(28,29,32,.28)";
    ctx.lineWidth = 0.75;
    for (const points of surfaceLines) drawSurfaceLine(points, basis, frame);
    ctx.restore();
  }

  function drawEarth(basis, atMs, cinematic) {
    const jd = 2440587.5 + atMs / DAY_MS;
    ctx.save();
    if (cinematic) {
      ctx.beginPath();
      ctx.arc(view.cx, view.cy, renderedEarthPx + 7, 0, TWO_PI);
      ctx.fillStyle = "rgba(64,139,222,.12)";
      ctx.shadowColor = "rgba(64,139,222,.65)";
      ctx.shadowBlur = 24;
      ctx.fill();
    }

    let textured = false;
    const textures = globalThis.MTPTex;
    if (displayState.textures && renderedEarthPx >= 4 && textures && textures.has("earth")) {
      textures.beginFrame();
      const sprite = textures.spriteFor(liveEarthBody, renderedEarthPx,
        sunDirectionPlanner(jd), jd, basis, Boolean(displayState.flat));
      if (sprite) {
        /* Blueprint is an opaque technical globe. Its former 56% alpha made
           the graph paper show through land and ocean pixels. */
        ctx.globalAlpha = 1;
        /* textures.js bounds its generated sprite radius to control cost.
           Scale that bounded sprite back to the exact apparent silhouette so
           close spacecraft POV does not leave an unpainted annulus. */
        ctx.drawImage(sprite, view.cx - renderedEarthPx, view.cy - renderedEarthPx,
          renderedEarthPx * 2, renderedEarthPx * 2);
        ctx.globalAlpha = 1;
        textured = true;
      }
    }

    if (!textured) {
      const gradient = ctx.createRadialGradient(
        view.cx - renderedEarthPx * 0.34, view.cy - renderedEarthPx * 0.34,
        renderedEarthPx * 0.08, view.cx, view.cy, renderedEarthPx);
      if (displayState.flat) {
        gradient.addColorStop(0, cinematic ? "#5f94be" : "#e4edf0");
        gradient.addColorStop(1, cinematic ? "#35698f" : "#b8cbd3");
      } else if (cinematic) {
        gradient.addColorStop(0, "#63a5df");
        gradient.addColorStop(0.62, "#214f83");
        gradient.addColorStop(1, "#07111f");
      } else {
        gradient.addColorStop(0, "#fdfcf7");
        gradient.addColorStop(0.7, "#d8e2e7");
        gradient.addColorStop(1, "#aebdc4");
      }
      ctx.beginPath();
      ctx.arc(view.cx, view.cy, renderedEarthPx, 0, TWO_PI);
      ctx.fillStyle = gradient;
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(view.cx, view.cy, renderedEarthPx, 0, TWO_PI);
    ctx.strokeStyle = cinematic ? "rgba(147,196,235,.68)" : "#1c1d20";
    ctx.lineWidth = cinematic ? 1.1 : 1.3;
    ctx.stroke();
    ctx.restore();
    if (displayState.grid && renderedEarthPx >= 16) drawGraticule(basis, jd, cinematic);
  }

  function drawEarthSoi(basis, cinematic) {
    if (!displayState.soi || !Number.isFinite(EARTH.soi)) return;
    const soiPx = basis.pov ? Infinity : earthPx * EARTH.soi / R_EQUATOR;
    const limit = Math.max(view.width, view.height) * 4;
    ctx.save();
    ctx.strokeStyle = cinematic ? "rgba(210,180,255,.42)" : "rgba(96,72,126,.52)";
    ctx.fillStyle = cinematic ? "rgba(210,180,255,.72)" : "rgba(73,52,98,.75)";
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 7]);
    if (Number.isFinite(soiPx) && soiPx <= limit) {
      ctx.beginPath();
      ctx.arc(view.cx, view.cy, soiPx, 0, TWO_PI);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = "9px 'JetBrains Mono', Consolas, monospace";
      ctx.fillText("EARTH SOI", view.cx + Math.min(soiPx + 6, view.width / 2 - 70), view.cy - 5);
    } else {
      ctx.setLineDash([]);
      ctx.font = "9px 'JetBrains Mono', Consolas, monospace";
      ctx.fillText("EARTH SOI 924,649 KM / OUTSIDE CURRENT VIEW", 14, 20);
    }
    ctx.restore();
  }

  function markerData(basis) {
    const markers = [];
    for (const mission of visibleMissions) {
      const state = stateById.get(mission.norad);
      if (!state) continue;
      const p = project(state.r, basis);
      if (!p.visible || earthOccludes(state.r, basis)) continue;
      const tailPoint = displayState.paths && state.trailR
        ? visibleTrailStart(state.r, state.trailR, basis) : null;
      const tail = tailPoint ? project(tailPoint, basis) : null;
      markers.push({ mission, state, x: p.x, y: p.y, depth: p.depth,
        tail: tail && tail.visible ? tail : null });
    }
    markers.sort((a, b) => a.depth - b.depth);
    return markers;
  }

  function drawMarker(marker, colors, cinematic) {
    const selected = marker.mission.norad === selectedId;
    const hovered = marker.mission.norad === hoveredId;
    const radius = selected ? 5.8 : (hovered ? 4.7 : 3.2);
    const color = colors[marker.mission.group];
    ctx.save();
    if (marker.tail) {
      ctx.strokeStyle = color;
      ctx.globalAlpha = selected || hovered ? 0.72 : (cinematic ? 0.28 : 0.22);
      ctx.lineWidth = selected ? 1.6 : 1;
      ctx.beginPath();
      ctx.moveTo(marker.tail.x, marker.tail.y);
      ctx.lineTo(marker.x, marker.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (cinematic) {
      ctx.shadowColor = color;
      ctx.shadowBlur = selected || hovered ? 13 : 5;
    }
    ctx.beginPath();
    ctx.arc(marker.x, marker.y, radius, 0, TWO_PI);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = cinematic ? "rgba(255,255,255,.88)" : "#fff";
    ctx.lineWidth = selected ? 1.8 : 0.9;
    ctx.stroke();
    if (displayState.labels && (selected || hovered)) {
      const label = marker.mission.name;
      ctx.font = (cinematic ? "500 11px Archivo, sans-serif" : "600 10px Archivo, sans-serif");
      const textWidth = ctx.measureText(label).width;
      const left = clamp(marker.x + 10, 5, view.width - textWidth - 17);
      const top = clamp(marker.y - 20, 5, view.height - 23);
      ctx.fillStyle = cinematic ? "rgba(7,10,18,.88)" : "rgba(251,250,246,.94)";
      ctx.strokeStyle = selected ? color : (cinematic ? "rgba(255,255,255,.22)" : "rgba(28,29,32,.35)");
      ctx.lineWidth = 1;
      ctx.fillRect(left, top, textWidth + 12, 18);
      ctx.strokeRect(left, top, textWidth + 12, 18);
      ctx.fillStyle = cinematic ? "#f4f7fb" : "#1c1d20";
      ctx.fillText(label, left + 6, top + 12.5);
    }
    ctx.restore();
  }

  function drawMarkersPass(front, markers, colors, cinematic) {
    for (const marker of markers) {
      if ((marker.depth >= 0) !== front) continue;
      if (marker.x < -20 || marker.x > view.width + 20 || marker.y < -20 || marker.y > view.height + 20) continue;
      drawMarker(marker, colors, cinematic);
    }
  }

  function draw(atMs) {
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    const cinematic = app.dataset.theme === "cinematic";
    const colors = groupColors(cinematic);
    const basis = cameraBasis();
    renderedEarthPx = basis.pov ? basis.earthPx : earthPx;
    drawBackground(cinematic);
    drawEarthSoi(basis, cinematic);
    screenMarkers = displayState.markers ? markerData(basis) : [];
    if (displayState.paths) drawOrbitPass(false, basis, cinematic, colors.orbit);
    if (displayState.markers) drawMarkersPass(false, screenMarkers, colors, cinematic);
    drawEarth(basis, atMs, cinematic);
    if (displayState.paths) drawOrbitPass(true, basis, cinematic, colors.orbit);
    if (displayState.markers) drawMarkersPass(true, screenMarkers, colors, cinematic);
    if (dom.scale) {
      const povState = basis.pov && selectedId ? stateById.get(selectedId) : null;
      const scaleText = povState
        ? "Spacecraft POV: " + Math.round(povState.altitude).toLocaleString("en-US") +
          " km altitude / 90 deg FOV"
        : "Earth radius: " + renderedEarthPx.toFixed(renderedEarthPx < 10 ? 1 : 0) + " px";
      if (scaleText !== lastScaleText) {
        lastScaleText = scaleText;
        dom.scale.textContent = scaleText;
      }
    }
  }

  /* --------------------------- detail card ------------------------------ */
  function safeWikipediaUrl(mission) {
    if (/^https:\/\/en\.wikipedia\.org\/wiki\/[^\s]+$/i.test(mission.wiki || "")) return mission.wiki;
    return "https://en.wikipedia.org/wiki/Special:Search?search=" + encodeURIComponent(mission.name);
  }

  function formatShortUtc(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return "unknown UTC";
    const iso = new Date(ms).toISOString();
    return iso.slice(0, 10) + " " + iso.slice(11, 16) + " UTC";
  }

  function formatKm(value) {
    if (!Number.isFinite(value)) return "--";
    const digits = Math.abs(value) < 1000 ? 0 : (Math.abs(value) < 10000 ? 1 : 0);
    return value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits }) + " km";
  }

  function formatElementAge(epochMs, referenceMs) {
    const days = (referenceMs - epochMs) / DAY_MS;
    if (!Number.isFinite(days)) return "an unknown interval from the displayed time";
    const distance = Math.abs(days) < 1
      ? Math.abs(days * 24).toFixed(1) + " h"
      : Math.abs(days).toFixed(1) + " d";
    return distance + (days >= 0 ? " before the displayed time" : " after the displayed time");
  }

  function selectMission(norad, autoFit) {
    if (!missionById.has(norad)) return;
    if (selectedId !== norad) setPovActive(false, true);
    selectedId = norad;
    for (const [id, entry] of rows) entry.row.setAttribute("aria-pressed", id === selectedId ? "true" : "false");
    syncRowTabStops(selectedId);
    const selectedRow = rows.get(selectedId);
    if (selectedRow) selectedRow.row.scrollIntoView({ block: "nearest" });
    orbitForId = null;
    orbitBuiltPerf = -Infinity;
    updateStates(lastStateSimMs || currentClockMs(performance.now()), true);
    updateSelectedCard(true);
    syncPovControl();
    invalidateGroundTrack();
    if (dom.card) dom.card.hidden = false;
    app.classList.toggle("card-open", Boolean(dom.card));
    if (autoFit && elementById.has(norad)) fitSelected();
  }

  function clearSelection() {
    setPovActive(false, true);
    selectedId = null;
    selectedOrbit = [];
    orbitForId = null;
    orbitBuiltPerf = -Infinity;
    for (const entry of rows.values()) entry.row.setAttribute("aria-pressed", "false");
    syncRowTabStops(null);
    if (dom.card) dom.card.hidden = true;
    app.classList.toggle("card-open", false);
    syncPovControl();
    invalidateGroundTrack();
  }

  function updateSelectedCard(force, perfMs) {
    if (!selectedId || !dom.card) return;
    const nowPerf = Number.isFinite(perfMs) ? perfMs : performance.now();
    if (!force && nowPerf - lastCardPerf < 250) return;
    lastCardPerf = nowPerf;
    const mission = missionById.get(selectedId);
    const model = elementById.get(selectedId);
    const state = stateById.get(selectedId);
    if (!mission) return;

    if (dom.cardGroup) dom.cardGroup.textContent = mission.groupLabel;
    if (dom.cardTitle) dom.cardTitle.textContent = mission.name;
    if (dom.cardMeta) dom.cardMeta.textContent = mission.agency + " / " + mission.kind;
    if (dom.cardSummary) dom.cardSummary.textContent = mission.summary +
      " Inclusion is an orbit-catalog classification, not a claim of current operational status.";
    if (dom.detailNorad) dom.detailNorad.textContent = String(mission.norad);
    if (dom.wiki) dom.wiki.href = safeWikipediaUrl(mission);
    if (dom.fitSelected) dom.fitSelected.disabled = !model;

    if (model && state) {
      if (dom.detailEpoch) dom.detailEpoch.textContent = formatShortUtc(model.epochMs);
      if (dom.detailAltitude) dom.detailAltitude.textContent = formatKm(state.altitude);
      if (dom.detailSpeed) dom.detailSpeed.textContent = state.speed.toFixed(3) + " km/s";
      if (dom.detailApsides) dom.detailApsides.textContent = formatKm(model.rpAlt) + " / " + formatKm(model.raAlt);
      if (dom.detailPlane) dom.detailPlane.textContent = (model.i / C.DEG).toFixed(2) + " deg / " + model.periodMin.toFixed(1) + " min";
      if (dom.elementNote) {
        const age = formatElementAge(model.epochMs, lastStateSimMs);
        if (state.propagator === "J2 fallback") {
          dom.elementNote.textContent = "CelesTrak OMM mean-element epoch is " + age +
            ". SGP4/SDP4 was unavailable for this displayed state, so the labeled first-order J2 fallback is active (" +
            (state.fallbackReason || model.fallbackReason || "unknown reason") + "). Prediction only; not telemetry or operations.";
        } else {
          dom.elementNote.textContent = "CelesTrak OMM mean-element epoch is " + age +
            ". Display propagation uses the bundled Vallado " + state.propagator +
            " branch in TEME, transformed through Earth-fixed coordinates into the Planner frame. Prediction only; not telemetry, maneuver reconstruction, or operations.";
        }
      }
    } else {
      if (dom.detailEpoch) dom.detailEpoch.textContent = "Unavailable";
      if (dom.detailAltitude) dom.detailAltitude.textContent = "--";
      if (dom.detailSpeed) dom.detailSpeed.textContent = "--";
      if (dom.detailApsides) dom.detailApsides.textContent = "--";
      if (dom.detailPlane) dom.detailPlane.textContent = "--";
      if (dom.elementNote) dom.elementNote.textContent = "No current or cached OMM elements are available for this catalog entry. Connect and use Refresh data to request them.";
    }
  }

  /* ---------------------------- interaction ----------------------------- */
  let drag = null;

  function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function nearestMarker(point, radius) {
    let best = null;
    let bestD2 = radius * radius;
    for (const marker of screenMarkers) {
      const dx = marker.x - point.x, dy = marker.y - point.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD2) { best = marker; bestD2 = d2; }
    }
    return best;
  }

  canvas.addEventListener("pointerdown", (event) => {
    const point = canvasPoint(event);
    let dragYaw = yaw, dragPitch = pitch;
    if (povActive) {
      const pov = povCameraForState(selectedId ? stateById.get(selectedId) : null, view.height);
      if (pov) {
        dragYaw = Math.atan2(pov.D[1], pov.D[0]);
        dragPitch = Math.asin(clamp(pov.D[2], -1, 1));
      }
    }
    drag = {
      pointerId: event.pointerId, x: point.x, y: point.y,
      yaw: dragYaw, pitch: dragPitch, moved: false,
    };
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener("pointermove", (event) => {
    const point = canvasPoint(event);
    if (drag && drag.pointerId === event.pointerId) {
      const dx = point.x - drag.x, dy = point.y - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 3) {
        drag.moved = true;
        setPovActive(false, true);
      }
      yaw = drag.yaw - dx * 0.006;
      pitch = clamp(drag.pitch + dy * 0.006, -Math.PI * 0.49, Math.PI * 0.49);
      hoveredId = null;
      return;
    }
    const marker = nearestMarker(point, 10);
    hoveredId = marker ? marker.mission.norad : null;
    canvas.style.cursor = marker ? "pointer" : "grab";
  });

  canvas.addEventListener("pointerup", (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = canvasPoint(event);
    const wasMoved = drag.moved;
    drag = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (!wasMoved) {
      const marker = nearestMarker(point, 12);
      if (marker) selectMission(marker.mission.norad, false);
    }
  });

  canvas.addEventListener("pointercancel", () => { drag = null; });
  canvas.addEventListener("lostpointercapture", () => { drag = null; });
  canvas.addEventListener("pointerleave", () => { if (!drag) hoveredId = null; });
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    setPovActive(false, true);
    earthPx = clamp(earthPx * Math.exp(-event.deltaY * 0.0012), 2, 320);
  }, { passive: false });
  canvas.addEventListener("dblclick", () => { if (selectedId) fitSelected(); else fitAll(); });
  canvas.addEventListener("keydown", (event) => {
    if (event.key === "+" || event.key === "=") { setPovActive(false, true); earthPx = clamp(earthPx * 1.18, 2, 320); event.preventDefault(); }
    else if (event.key === "-") { setPovActive(false, true); earthPx = clamp(earthPx / 1.18, 2, 320); event.preventDefault(); }
    else if (event.key.toLowerCase() === "r") { resetView(); event.preventDefault(); }
    else if (event.key.toLowerCase() === "f") { if (selectedId) fitSelected(); else fitAll(); event.preventDefault(); }
    else if (event.key.toLowerCase() === "v") { togglePov(); event.preventDefault(); }
    else if (event.key === "Escape") { clearSelection(); event.preventDefault(); }
    else if (event.key === " ") { togglePlay(); event.preventDefault(); }
  });

  if (dom.search) dom.search.addEventListener("input", applyFilters);
  if (dom.group) dom.group.addEventListener("change", applyFilters);
  if (dom.cardClose) dom.cardClose.addEventListener("click", clearSelection);
  if (dom.fitSelected) dom.fitSelected.addEventListener("click", fitSelected);
  if (dom.fitAll) dom.fitAll.addEventListener("click", fitAll);
  if (dom.pov) dom.pov.addEventListener("click", togglePov);
  if (dom.resetView) dom.resetView.addEventListener("click", resetView);
  if (dom.play) dom.play.addEventListener("click", togglePlay);
  if (dom.now) dom.now.addEventListener("click", returnToNow);
  if (dom.refresh) dom.refresh.addEventListener("click", () => refreshData(true));
  if (dom.speed) dom.speed.addEventListener("change", () => {
    const now = currentClockMs(performance.now());
    speed = Math.max(0.01, finiteNumber(dom.speed.value) || 1);
    reanchorClock(now);
    updateClockControls(true);
  });
  if (dom.catalogToggle) dom.catalogToggle.addEventListener("click", () => {
    const collapsed = app.classList.toggle("catalog-collapsed");
    dom.catalogToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    requestAnimationFrame(resizeCanvas);
  });
  window.addEventListener("resize", () => {
    resizeCanvas();
    if (groundOpen) { resizeGroundCanvas(); invalidateGroundTrack(); }
  });
  if (typeof ResizeObserver === "function") {
    const resizeObserver = new ResizeObserver(resizeCanvas);
    const viz = $("liveViz");
    if (viz) resizeObserver.observe(viz);
  }
  window.addEventListener("online", () => { if (!elementById.size) refreshData(true); });

  /* ------------------------------- boot --------------------------------- */
  let lastDrawPerf = -Infinity;
  function frame(perfMs) {
    if (document.hidden) {
      requestAnimationFrame(frame);
      return;
    }
    const atMs = currentClockMs(perfMs);
    updateStates(atMs, false, perfMs);
    updateClockControls(false);
    updateSelectedCard(false, perfMs);
    updateGroundTrack(perfMs, false);
    if (playing || perfMs - lastDrawPerf >= 66) {
      draw(atMs);
      lastDrawPerf = perfMs;
    }
    requestAnimationFrame(frame);
  }

  buildList();
  applyFilters();
  initEarthTexture();
  resizeCanvas();
  loadCachedElements();
  updateStates(simMs, true);
  updateClockControls(true);
  if (!catalogError) refreshData(false);
  requestAnimationFrame(frame);

  globalThis.MTPLive = Object.freeze({
    propagateOMM,
    refresh: () => refreshData(true),
    get selectedNorad() { return selectedId; },
    get elementCount() { return elementById.size; },
  });
})();
