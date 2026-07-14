/* =============================================================================
 * Mission Trajectory Planner - scriptgen.js
 * Renders the mission plan as a GMAT-inspired mission sequence script.
 * NOT valid GMAT syntax - a readable operations view with the engine's
 * computed numbers (delta-v, C3, v-infinity, event times) folded in as comments.
 * ========================================================================== */
"use strict";

(function () {
  const C = globalThis.AstroConst;
  const A = globalThis.Astro;
  const { BODIES, DAY } = C;

  const pad = (n, w) => String(n).padStart(w, "0");
  const f3 = (x) => (isFinite(x) ? (+x).toFixed(3) : "n/a");
  const f1 = (x) => (isFinite(x) ? (+x).toFixed(1) : "n/a");
  const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;

  function met(t) {
    const neg = t < 0 ? "-" : "+";
    t = Math.abs(t);
    const d = Math.floor(t / DAY);
    const hh = Math.floor((t % DAY) / 3600);
    const mm = Math.floor((t % 3600) / 60);
    return "T" + neg + pad(d, 2) + ":" + pad(hh, 2) + ":" + pad(mm, 2);
  }

  function scriptId(value, fallback) {
    let id = String(value || fallback || "VEHICLE").toUpperCase()
      .replace(/[^A-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
    if (!id) id = String(fallback || "VEHICLE").toUpperCase();
    if (/^[0-9]/.test(id)) id = "V_" + id;
    return id;
  }

  function quoted(value) {
    return String(value || "").replace(/'/g, "''");
  }

  function vehicleDependencies(plan, knownIds) {
    const refs = new Set();
    for (const segment of plan.segments) {
      let id = "";
      if (segment.type === "separate") id = segment.fromVehicle;
      if (segment.type === "rendezvous" || segment.type === "dock")
        id = segment.targetVehicle;
      id = String(id || "");
      if (id && id !== plan.id && knownIds.has(id)) refs.add(id);
    }
    return refs;
  }

  function dependencyOrder(plans) {
    const knownIds = new Set(plans.map((plan) => plan.id));
    const pending = plans.slice();
    const complete = new Set();
    const ordered = [];
    while (pending.length) {
      let index = pending.findIndex((plan) =>
        Array.from(vehicleDependencies(plan, knownIds)).every((id) => complete.has(id)));
      if (index < 0) index = 0;
      const plan = pending.splice(index, 1)[0];
      ordered.push(plan);
      complete.add(plan.id);
    }
    return ordered;
  }

  function vehiclePlans(mission, aggregateResult) {
    const raw = [{
      id: "primary",
      name: mission.spacecraft && mission.spacecraft.name || "Primary spacecraft",
      color: "#e95420",
      spacecraft: mission.spacecraft || {},
      segments: Array.isArray(mission.segments) ? mission.segments : [],
    }];
    const usedIds = new Set(["primary"]);
    const secondary = Array.isArray(mission.vehicles) ? mission.vehicles.slice(0, 7) : [];
    secondary.forEach((vehicle, index) => {
      vehicle = vehicle || {};
      const id = String(vehicle.id || "vehicle" + (index + 1)).trim();
      if (!id || id === "primary" || usedIds.has(id)) return;
      usedIds.add(id);
      raw.push({
        id,
        name: vehicle.name || vehicle.spacecraft && vehicle.spacecraft.name || id,
        color: vehicle.color || "",
        spacecraft: vehicle.spacecraft || {},
        segments: Array.isArray(vehicle.segments) ? vehicle.segments : [],
      });
    });

    const multiple = raw.length > 1;
    const usedTokens = new Set();
    const results = aggregateResult && aggregateResult.vehicleResults;
    const plans = raw.map((vehicle) => {
      const base = scriptId(vehicle.id, "VEHICLE");
      let token = base;
      let suffix = 2;
      while (usedTokens.has(token)) token = base + "_" + suffix++;
      usedTokens.add(token);
      const childResult = results && results[vehicle.id]
        ? results[vehicle.id] : (vehicle.id === "primary" ? aggregateResult : null);
      return Object.assign({}, vehicle, {
        token,
        scVar: multiple ? "SC_" + token : "SC",
        multiple,
        result: childResult,
      });
    });
    return dependencyOrder(plans);
  }

  function segmentBurnNames(plan, segment, index) {
    const number = index + 1;
    const named = (base, part, omitSingleNumber) => {
      if (plan.multiple)
        return base + "_" + plan.token + "_" + number + (part ? "_" + part : "");
      return base + (omitSingleNumber ? "" : number) + (part ? "_" + part : "");
    };
    const impulseMagnitude = Math.hypot(+segment.dv1 || 0, +segment.dv2 || 0,
      +segment.dv3 || 0);
    switch (segment.type) {
      case "separate": return impulseMagnitude > 0 ? [named("SEP")] : [];
      case "rendezvous": return [named("RVD"), named("RVM")];
      case "dock": return [];
      case "undock": return impulseMagnitude > 0 ? [named("UDK")] : [];
      case "impulse": return [named("MNV")];
      case "hohmann": return [named("HOH", "1"), named("HOH", "2")];
      case "transfer":
        return [named(segment.target === "moon" ? "TLI" : "TIB", "",
          segment.target === "moon")];
      case "depart": return [named("INJ")];
      case "insertion": return [named("OI")];
      case "flyby": return segment.dvKms ? [named("PFB")] : [];
      case "return": return [named("RTB")];
      case "land": return [named("DSC")];
      case "ascend": return [named("ASC")];
      default: return [];
    }
  }

  function burnDv(segment, burnIndex) {
    const info = segment._info || {};
    if (segment.type === "hohmann" && info.hohmann)
      return burnIndex === 0 ? info.hohmann.dv1 : info.hohmann.dv2;
    if (segment.type === "rendezvous")
      return burnIndex === 0 ? info.departureDv : info.matchDv;
    return isFinite(info.dv) ? info.dv : null;
  }

  function resultEvents(plan, aggregateResult) {
    if (plan.result && plan.result !== aggregateResult &&
      Array.isArray(plan.result.events)) return plan.result.events;
    return (aggregateResult && aggregateResult.events || []).filter((event) =>
      String(event.vehicleId || "primary") === plan.id);
  }

  function generate(mission, result) {
    const L = [];
    const plans = vehiclePlans(mission, result);
    const planById = Object.create(null);
    plans.forEach((plan) => { planById[plan.id] = plan; });
    const allSegments = plans.flatMap((plan) => plan.segments);
    const allResults = plans.map((plan) => plan.result).filter(Boolean);
    const epochJD = result && isFinite(result.epochJD)
      ? result.epochJD : A.dateToJD(mission.epoch);
    const epochStr = A.jdToStr(epochJD);
    const hasForceModel = allSegments.some((segment) =>
      segment.type === "finite_burn" || segment.mode === "adaptive-nbody" ||
      segment.mode === "adaptive-environment");
    const hasEnvironment = allSegments.some((segment) =>
      segment.mode === "adaptive-environment");
    const hasGP = allSegments.some((segment) => segment.type === "gp_orbit");
    const hasJ2 = allSegments.some((segment) => segment.mode === "j2-secular");
    const hasCentralRelative = allSegments.some((segment) =>
      segment.type === "finite_burn" &&
      (segment.gravity === "central-relative" || segment.gravity === "central-only"));
    const hasCR3BP = allResults.some((child) => child.cr3bpSystem);
    const totalDv = result && isFinite(result.totalDv) ? result.totalDv
      : allResults.reduce((sum, child) => sum + (+child.totalDv || 0), 0);
    const tEnd = result && isFinite(result.tEnd) ? result.tEnd
      : allResults.reduce((maximum, child) => Math.max(maximum, +child.tEnd || 0), 0);
    const crashed = allResults.some((child) => child.crashed);

    L.push("%" + "-".repeat(68));
    L.push("%  MISSION TRAJECTORY PLANNER - mission sequence (GMAT-inspired)");
    L.push("%  Mission : " + (mission.name || "Untitled"));
    L.push("%  Epoch   : " + epochStr + "  (JD " + epochJD.toFixed(4) + ")");
    L.push("%  Engine  : " + (hasCR3BP
      ? "ideal CR3BP | adaptive Dormand-Prince 5(4) | ideal stationkeeping"
      : (hasForceModel
        ? "patched conics + adaptive inertial n-body/finite thrust" +
          (hasEnvironment ? " + drag/SRP/Earth J2-J4" : "") +
          (hasGP ? " + SGP4/SDP4" : "") + (hasJ2 ? " + Earth J2" : "")
        : "patched-conic two-body | Kepler(universal) + RK4" +
          (hasJ2 ? " + Earth J2 secular" : ""))));
    L.push("%  Result  : " + (tEnd / DAY).toFixed(2) + " d, " +
      (plans.length > 1 ? "sum of vehicle maneuver magnitudes = " :
        "total maneuver dv = ") + f3(totalDv) + " km/s" +
      (crashed ? "  ** UNPLANNED IMPACT **" : ""));
    if (plans.length > 1) {
      L.push("%  Branches: dependency-ordered vehicle sequences sharing one UTC timeline");
      plans.forEach((plan) => L.push("%    " + plan.id + " (" + plan.name + "): " +
        (plan.result && isFinite(plan.result.totalDv) ? f3(plan.result.totalDv) : "n/a") +
        " km/s"));
    }
    L.push("%  NOTE    : simplified model - not flight software, not GMAT syntax");
    if (mission.uncertainty)
      L.push("%  UNCERT. : seeded " + (mission.uncertainty.samples || "bounded") +
        "-case state/maneuver dispersion defaults are attached to this mission");
    L.push("%" + "-".repeat(68));
    L.push("");

    const centrals = new Set();
    allResults.forEach((child) => {
      if (child.samples) child.samples.forEach((sample) => centrals.add(sample.cen));
    });
    plans.forEach((plan) => {
      const sc = plan.spacecraft || {};
      L.push("Create Spacecraft " + plan.scVar + ";");
      if (sc.name) L.push("GMAT " + plan.scVar + ".Name = '" + quoted(sc.name) + "';");
      if (+sc.dryKg > 0)
        L.push("GMAT " + plan.scVar + ".DryMass = " + (+sc.dryKg).toFixed(0) + ";   % kg");
      if (+sc.propKg > 0 && +sc.isp > 0 && +sc.dryKg > 0) {
        const capacity = +sc.isp * 0.00980665 *
          Math.log((+sc.dryKg + +sc.propKg) / +sc.dryKg);
        L.push("GMAT " + plan.scVar + ".FuelMass = " + (+sc.propKg).toFixed(0) +
          ";  GMAT " + plan.scVar + ".Isp = " + (+sc.isp).toFixed(0) +
          ";   % dv capacity " + capacity.toFixed(2) + " km/s");
      }
      const first = plan.segments.find((segment) => segment.type === "launch");
      if (first && BODIES[first.body]) {
        const body = BODIES[first.body];
        L.push("GMAT " + plan.scVar + ".CoordinateSystem = " + body.name + "MJ2000Ec;");
        L.push("GMAT " + plan.scVar + ".Epoch = '" + epochStr + "';");
        L.push("GMAT " + plan.scVar + ".SMA  = " +
          f1(body.radius + (+first.altKm || 0)) + ";   % km");
        L.push("GMAT " + plan.scVar + ".ECC  = 0.0;  GMAT " + plan.scVar +
          ".INC = " + f1(+first.incDeg || 0) + ";   % deg");
        if (first._info && first._info.raanAuto !== undefined)
          L.push("GMAT " + plan.scVar + ".RAAN = " +
            f1(first._info.raanAuto) + ";   % deg (launch-window plane targeting)");
      } else if (plan.segments[0] && plan.segments[0].type === "separate") {
        L.push("% " + plan.scVar + " receives its initial state during branch separation.");
      }
      L.push("");
    });

    for (const central of centrals) {
      const name = BODIES[central] ? BODIES[central].name : central;
      const forceId = "FM_" + scriptId(name, central);
      L.push("Create ForceModel " + forceId + ";  GMAT " + forceId +
        ".CentralBody = " + name + "; GMAT " + forceId +
        ".PointMasses = {" + name + "};   % two-body");
    }
    L.push("Create Propagator KeplerProp;   % analytic universal-variable Kepler");
    L.push("Create Propagator RK4Prop;      % numerical RK4 of r'' = -mu r/|r|^3");
    if (hasJ2)
      L.push("Create Propagator J2SecularProp;   % first-order Earth J2 mean-element drift");
    if (hasCR3BP)
      L.push("Create Propagator CR3BPProp;   % adaptive ideal circular restricted three-body dynamics");
    if (hasForceModel)
      L.push("Create Propagator AdaptiveNBody;   % moving point masses, adaptive DOPRI5(4)");
    if (hasEnvironment)
      L.push("Create Propagator AdaptiveEnvironment;   % bounded drag/SRP/eclipse/Earth J2-J4 selection");
    if (hasGP)
      L.push("Create Propagator SGP4Prop;   % Vallado SGP4/SDP4 mean-element prediction in TEME");
    if (hasCentralRelative)
      L.push("Create Propagator CentralRelative;   % translating central-body frame + adaptive DOPRI5(4)");
    L.push("");

    const burns = Object.create(null);
    let burnCount = 0;
    plans.forEach((plan) => {
      burns[plan.id] = [];
      plan.segments.forEach((segment, index) => {
        const names = segmentBurnNames(plan, segment, index);
        burns[plan.id][index] = names;
        names.forEach((name, burnIndex) => {
          const dv = burnDv(segment, burnIndex);
          const axes = segment.frame === "inertial" ? "MJ2000Ec" : "VNB";
          L.push("Create ImpulsiveBurn " + name + ";  GMAT " + name +
            ".Axes = " + axes + ";" +
            (dv !== null ? "   % |dv| = " + f3(dv) + " km/s" : ""));
          burnCount++;
        });
      });
    });
    if (burnCount) L.push("");

    L.push("BeginMissionSequence;");
    L.push("");

    plans.forEach((plan) => {
      const evBySeg = Object.create(null);
      resultEvents(plan, result).forEach((event) => {
        (evBySeg[event.seg] = evBySeg[event.seg] || []).push(event);
      });
      L.push("%" + "=".repeat(68));
      L.push("%  VEHICLE " + plan.id + " - " + plan.name + " [" + plan.scVar + "]");
      const refs = Array.from(vehicleDependencies(plan, new Set(plans.map((p) => p.id))));
      if (refs.length) L.push("%  Depends on: " + refs.join(", "));
      L.push("%" + "=".repeat(68));
      L.push("");

      plan.segments.forEach((segment, index) => {
        renderSegment(L, plan, segment, index, burns[plan.id][index] || [], planById);
        const events = evBySeg[index] || [];
        events.forEach((event) => {
          if (event.kind === "note") L.push("%   [note] " + event.label);
          else L.push("%   " + met(event.t) + "  " + event.label);
        });
        (segment._warn || []).forEach((warning) => {
          L.push("%   !! " + (warning.level === "error" ? "ERROR" : "WARN") +
            ": " + warning.msg);
        });
        L.push("");
      });
    });

    L.push("% ===== End of sequence - " +
      (plans.length > 1 ? "sum of vehicle maneuver magnitudes " :
        "total maneuver dv ") + f3(totalDv) + " km/s =====");
    return L.join("\n");
  }

  function renderSegment(L, plan, seg, index, burnNames, planById) {
    const spec = globalThis.MissionEngine.SEGMENT_TYPES[seg.type];
    const shortName = spec ? spec.short : String(seg.type || "UNKNOWN").toUpperCase();
    const sc = plan.scVar;
    const info = seg._info || {};
    L.push("% ===== " + plan.id + " segment " + (index + 1) + ": " +
      shortName + " - " + (spec ? spec.label : "") + " =====");
    switch (seg.type) {
      case "launch": {
        const body = BODIES[seg.body] || {};
        L.push("% " + (body.name || seg.body) + (info.site ? " - " + info.site : "") +
          ": " + (seg.ascent === "meco" ? (info.meco || "MECO ellipse") :
            f1(+seg.altKm) + " km circular") + ", i=" + f1(+seg.incDeg) + " deg" +
          (info.raanAuto !== undefined ? ", RAAN=" + f1(info.raanAuto) + " deg (auto)" : ""));
        L.push("% ascent dv ~ " + f1(info.ascentDv) +
          " km/s (bookkept; incl. losses - rotation credit " +
          (info.rotCredit !== undefined ? f3(info.rotCredit) : "n/a") + " km/s)");
        break;
      }
      case "separate": {
        const sourceId = String(seg.fromVehicle || "primary");
        const source = planById[sourceId];
        const delay = Math.max(0, +seg.delayMin || 0);
        L.push("Separate " + sc + " from " + (source ? source.scVar : sourceId) +
          " after source segment " + Math.max(1, Math.floor(+seg.afterSegment || 1)) +
          " + " + f3(delay) + " min;");
        if (burnNames[0])
          L.push("Maneuver " + burnNames[0] + "(" + sc + ");   % " +
            (seg.frame || "vnb") + " separation [" + f3(+seg.dv1) + ", " +
            f3(+seg.dv2) + ", " + f3(+seg.dv3) + "] km/s");
        else L.push("% Zero-relative-dv separation; child inherits the exact source state.");
        break;
      }
      case "rendezvous": {
        const targetId = String(seg.targetVehicle || "primary");
        const target = planById[targetId];
        L.push("% Passive phasing + single-revolution terminal Lambert rendezvous to " +
          (target ? target.scVar : targetId) + ", requested TOF " +
          f3(+seg.tofHours) + " h, " + (seg.direction || "prograde") + ".");
        if (info.phasingWaitS > 0)
          L.push("Propagate KeplerProp(" + sc + ") {" + sc + ".ElapsedSecs = " +
            Math.round(info.phasingWaitS) + "};   % passive phasing coast");
        L.push("Maneuver " + burnNames[0] + "(" + sc +
          ");   % Lambert departure dv " + f3(info.departureDv) + " km/s");
        L.push("Propagate KeplerProp(" + sc + ") {" + sc + ".ElapsedSecs = " +
          Math.round(info.transferTofS || (+seg.tofHours || 0) * 3600) +
          "};   % terminal transfer");
        L.push("Maneuver " + burnNames[1] + "(" + sc +
          ");   % ideal terminal velocity match dv " + f3(info.matchDv) + " km/s");
        L.push("% Target " + targetId + "; achieved range " + f3(info.rangeKm) +
          " km; pre-match relative speed " + f3(info.preMatchRateMps) +
          " m/s; segment dv " + f3(info.dv) + " km/s (limit " +
          f3(+seg.maxDvKms) + " km/s); terminal tolerance " +
          f3(+seg.terminalRangeKm) + " km.");
        break;
      }
      case "dock": {
        const targetId = String(seg.targetVehicle || "primary");
        const target = planById[targetId];
        L.push("Dock " + sc + " to " + (target ? target.scVar : targetId) +
          " {Range <= " + f3(+seg.captureRangeKm) +
          " km; RelativeSpeed <= " + f3(+seg.captureRateMps) + " m/s};");
        L.push("% Capture gate result: range " + f3(info.rangeKm) +
          " km, relative speed " + f3(info.relativeRateMps) + " m/s" +
          (info.joined ? "; joined state follows target." : "."));
        break;
      }
      case "undock": {
        const targetId = info.targetVehicle || seg._targetVehicle || "joined target";
        L.push("Undock " + sc + " from " +
          (planById[targetId] ? planById[targetId].scVar : targetId) + ";");
        if (burnNames[0])
          L.push("Maneuver " + burnNames[0] + "(" + sc + ");   % " +
            (seg.frame || "vnb") + " departure [" + f3(+seg.dv1) + ", " +
            f3(+seg.dv2) + ", " + f3(+seg.dv3) + "] km/s");
        else L.push("% Zero-relative-dv release.");
        break;
      }
      case "coast":
        L.push("Propagate " + (seg.mode === "adaptive-environment" ? "AdaptiveEnvironment" :
          (seg.mode === "adaptive-nbody" ? "AdaptiveNBody" :
            (seg.mode === "j2-secular" ? "J2SecularProp" :
              (seg.mode === "rk4" ? "RK4Prop" : "KeplerProp")))) +
          "(" + sc + ") {" + sc + ".ElapsedDays = " + (+seg.days).toFixed(3) + "};");
        if (seg.mode === "j2-secular" && isFinite(info.raanRateDegDay))
          L.push("% Earth J2 drift: RAAN " + f3(info.raanRateDegDay) +
            " deg/day, argument of periapsis " + f3(info.argPeriapsisRateDegDay) + " deg/day.");
        if (seg.mode === "adaptive-environment")
          L.push("% Environment: " + (info.environmentModels || "configured selection") +
            "; ephemeris: " + (info.ephemeris || seg.ephemeris || "catalog") + ".");
        break;
      case "gp_orbit":
        L.push("Propagate SGP4Prop(" + sc + ") {" + sc + ".ElapsedDays = " +
          (+seg.days).toFixed(3) + "};");
        L.push("% " + (info.model || "SGP4/SDP4") + "; element epoch " +
          (info.elementEpoch || "n/a") + "; period " + f3(info.periodMinutes) +
          " min; TEME mapped through Planner Earth-fixed frame.");
        L.push("% GP elements are predictions, not telemetry or an operational orbit determination.");
        break;
      case "finite_burn":
        L.push("BeginFiniteBurn " + sc + ";   % " + f1(+seg.thrustN) + " N " +
          seg.direction + ", Isp " + f1(+seg.ispS) + " s");
        L.push("Propagate " +
          ((seg.gravity === "central-relative" || seg.gravity === "central-only")
            ? "CentralRelative" : "AdaptiveNBody") + "(" + sc + ") {" +
          sc + ".ElapsedSecs = " + Math.round(info.durationS || 0) + "};");
        L.push("EndFiniteBurn " + sc + ";   % characteristic dv " +
          f3(info.dv) + " km/s, propellant " + f3(info.propellantUsedKg) + " kg");
        if (isFinite(info.apoStart) && isFinite(info.apoEnd))
          L.push("% Apoapsis rises continuously " + f1(info.apoStart) +
            " -> " + f1(info.apoEnd) + " km radius.");
        break;
      case "libration":
        L.push("% Initialize " + (info.system || seg.system) + " " +
          (info.point || seg.point) + " " + (info.family || seg.family) +
          " in canonical barycentric synodic coordinates.");
        L.push("% Reference period = " + f3(info.periodDays) + " d; Jacobi C = " +
          (isFinite(info.jacobi) ? info.jacobi.toFixed(9) : "n/a") + ".");
        L.push("% " + (info.periodic ? "Differentially corrected periodic family." :
          "Bounded linear seed; no periodic-orbit claim."));
        break;
      case "cr3bp_coast":
        L.push("Propagate CR3BPProp(" + sc + ") {ReferenceCycles = " +
          f3(+seg.cycles) + "};");
        L.push("% Adaptive Jacobi drift = " +
          (isFinite(info.jacobiDrift) ? info.jacobiDrift.toExponential(3) : "n/a") + ".");
        break;
      case "stationkeep":
        L.push("% Ideal CR3BP reference tracking for " + f3(+seg.cycles) +
          " cycles, " + Math.round(+seg.corrections || 0) + " checks/cycle.");
        L.push("% " + Math.round(info.burns || 0) +
          " corrections; total dv = " + f3(info.dv) + " km/s.");
        break;
      case "coast_to":
        L.push("Propagate KeplerProp(" + sc + ") {" + sc + "." +
          cap(seg.event) + "};   % limit " + f1(+seg.maxDays) + " d");
        break;
      case "impulse":
        L.push("Maneuver " + burnNames[0] + "(" + sc + ");   % " +
          seg.frame + " [" + f3(+seg.dv1) + ", " + f3(+seg.dv2) + ", " +
          f3(+seg.dv3) + "] km/s");
        break;
      case "hohmann": {
        const transfer = info.hohmann;
        L.push("Maneuver " + burnNames[0] + "(" + sc + ");   % dv1 = " +
          (transfer ? f3(transfer.dv1) : "?") + " km/s");
        L.push("Propagate KeplerProp(" + sc + ") {" + sc + ".ElapsedSecs = " +
          (transfer ? Math.round(transfer.tof) : "?") + "};   % half transfer ellipse");
        L.push("Maneuver " + burnNames[1] + "(" + sc +
          ");   % dv2 = circularize @ r = " + f1(+seg.rTargetKm) + " km");
        break;
      }
      case "transfer": {
        const target = BODIES[seg.target] || {};
        const targetPeri = seg.targetMode === "arrival-periapsis"
          ? seg.targetValue : seg.periKm;
        L.push("% Lambert solution to " + target.name + ", TOF = " +
          (+seg.tofDays).toFixed(2) + " d" +
          (targetPeri !== "" && targetPeri != null
            ? ", target periapsis " + f1(+targetPeri) + " km (bounded aim-offset search)"
            : ", aim at center"));
        if (info.waitS)
          L.push("Propagate KeplerProp(" + sc + ") {" + sc + ".ElapsedSecs = " +
            Math.round(info.waitS) + "};   % coast to ignition point (min-dv)");
        L.push("Maneuver " + burnNames[0] + "(" + sc + ");   % dv = " +
          f3(info.dv) + " km/s, C3 = " + f3(info.c3) + " km^2/s^2");
        if (seg.targetMode === "arrival-periapsis")
          L.push("% Vary/Achieve " + (info.targetStatus || "not run") +
            ": achieved " + f3(info.targetAchieved) + " km, residual " +
            f3(info.targetResidual) + " km, " +
            Math.round(info.targetIterations || 0) + " iterations.");
        L.push("Propagate KeplerProp(" + sc + ") {" + sc + "." +
          target.name + ".SOI};");
        break;
      }
      case "depart": {
        const target = BODIES[seg.target] || {};
        L.push("% Patched-conic escape; heliocentric Lambert to " + target.name +
          ", TOF = " + (+seg.tofDays).toFixed(0) + " d");
        L.push("Maneuver " + burnNames[0] + "(" + sc +
          ");   % injection dv = " + f3(info.dv) + " km/s (C3 = " +
          f1(info.c3) + " km^2/s^2, v_inf = " + f3(info.vInf) +
          " km/s, v_esc = " + f3(info.vEsc) + " km/s)");
        L.push("Propagate KeplerProp(" + sc + ") {" + sc +
          ".SOI.Exit};   % explicit local escape hyperbola");
        L.push("Propagate KeplerProp(" + sc + ") {" + sc + "." +
          target.name + ".SOI};");
        break;
      }
      case "insertion":
        L.push("Propagate KeplerProp(" + sc + ") {" + sc + "." +
          (seg.at === "apoapsis" ? "Apoapsis" : "Periapsis") + "};");
        L.push("Maneuver " + burnNames[0] + "(" + sc +
          ");   % capture dv = " + f3(info.dv) + " km/s -> " +
          (seg.targetMode && seg.targetMode !== "off"
            ? "Vary/Achieve " + seg.targetMode + " " + f3(info.targetAchieved)
            : (seg.shape === "circular" ? "circular orbit" :
              f1(+seg.apoKm) + " km other apsis")));
        break;
      case "flyby":
        L.push("% Gravity assist: coast through SOI periapsis and out " +
          (seg.dvKms ? "with " + f3(+seg.dvKms) + " km/s powered-flyby burn" :
            "(unpowered)"));
        if (isFinite(info.vInfIn))
          L.push("% v_inf " + f3(info.vInfIn) + " -> " + f3(info.vInfOut) +
            " km/s, turned " + f1(info.turnDeg) + " deg, free dv ~ " +
            f3(info.assistDv) + " km/s (parent-frame speed " +
            (info.speedGain >= 0 ? "+" : "") + f3(info.speedGain) + " km/s)");
        if (seg.dvKms)
          L.push("Maneuver " + burnNames[0] + "(" + sc + ");   % periapsis (Oberth) burn");
        L.push("Propagate KeplerProp(" + sc + ") {" + sc + ".SOI.Exit};");
        break;
      case "observe": {
        const target = BODIES[seg.target] || {};
        L.push("% Point instruments at " + (target.name || seg.target) + " for " +
          (+seg.days).toFixed(2) + " d (trajectory: coast)");
        L.push("Propagate " + (seg.mode === "rk4" ? "RK4Prop" : "KeplerProp") +
          "(" + sc + ") {" + sc + ".ElapsedDays = " +
          (+seg.days).toFixed(3) + "};");
        break;
      }
      case "return": {
        const target = BODIES[seg.target] || {};
        if (info.waitS)
          L.push("Propagate KeplerProp(" + sc + ") {" + sc + ".ElapsedSecs = " +
            Math.round(info.waitS) + "};   % coast to ignition point");
        L.push("Maneuver " + burnNames[0] + "(" + sc + ");   % return dv = " +
          f3(info.dv) + " km/s" + (info.vInf ? " (v_inf = " +
            f3(info.vInf) + " km/s)" : "") + " -> " + target.name +
          " periapsis " + f1(+seg.periKm) + " km");
        L.push("Propagate KeplerProp(" + sc + ") {" + sc +
          ".ElapsedDays = " + (+seg.tofDays * 0.92).toFixed(2) + "};");
        break;
      }
      case "land":
        L.push("Maneuver " + burnNames[0] + "(" + sc +
          ");   % deorbit/descent dv ~ " + f3(info.dv) + " km/s (idealized)");
        L.push("% surface stay " + (+seg.stayDays).toFixed(2) + " d");
        break;
      case "ascend":
        L.push("Maneuver " + burnNames[0] + "(" + sc + ");   % ascent to " +
          f1(+seg.altKm) + " km, dv ~ " + f3(info.dv) + " km/s");
        break;
      case "reentry":
        L.push("Propagate KeplerProp(" + sc + ") {" + sc + ".Altitude = " +
          f1(+seg.interfaceKm) + "};   % entry interface");
        L.push("% ballistic descent ~" + f1(+seg.descentMin) +
          " min (entry aerodynamics not modeled)");
        break;
    }
  }

  globalThis.ScriptGen = Object.freeze({ generate, vehiclePlans });
})();
