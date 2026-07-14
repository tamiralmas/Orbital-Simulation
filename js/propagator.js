/* =============================================================================
 * Mission Trajectory Planner — propagator.js
 * The mission engine: executes an ordered list of segments and produces a
 * time-tagged trajectory using selectable patched-conic, adaptive n-body,
 * finite-thrust, deterministic environment forces, first-order J2, and
 * CR3BP dynamics.
 *
 * Model summary (also shown in the in-app Guide):
 *  - Two-body motion about one central body at a time.
 *  - Patched conics: when the spacecraft crosses a body's sphere of influence
 *    (r_SOI = a (m/M)^(2/5)), the state is re-expressed about the new body.
 *  - Maneuvers may be impulsive or propagated as finite-thrust arcs with
 *    mass depletion.
 *  - Transfers are solved with Lambert's problem; encounter periapsis is
 *    targeted with a 1-D aim-point offset search (a simplified B-plane
 *    targeting scheme).
 *  - Launch/landing are modeled as instantaneous state changes with
 *    bookkeeping estimates (no ascent/entry aerodynamics).
 * ========================================================================== */
"use strict";

(function () {
  const C = globalThis.AstroConst;
  const A = globalThis.Astro;
  const Targeting = globalThis.MissionTargeting;
  const ODE = globalThis.AstroODE;
  const R3 = globalThis.CR3BP;
  const LIB = globalThis.Libration;
  const FORCE = globalThis.MissionForceModels;
  const SGP4 = globalThis.MissionSGP4 || null;
  const ANALYSIS = globalThis.MissionAnalysis;
  if (!Targeting)
    throw new Error("propagator.js requires targeting.js to be loaded first.");
  if (!ODE || !R3 || !LIB || !FORCE || !ANALYSIS)
    throw new Error("propagator.js requires ode.js, cr3bp.js, libration.js, analysis.js, and force-models.js to be loaded first.");
  const { BODIES, DAY, childrenOf } = C;
  const V = A.V;

  const MAX_STEPS = 24000;
  const MAX_TRANSITIONS = 10;

  /* ======================= segment type metadata ======================= */
  const SEGMENT_TYPES = {
    launch: {
      label: "Launch → MECO / parking orbit",
      short: "LAUNCH",
      color: "#7ee787",
      doc: "With a named site, starts at the exact selected pad at T+0, then uses a one-second " +
           "schematic visual bridge to MECO (ascent aerodynamics are not " +
           "simulated; ascent Δv is bookkept with loss + Earth-rotation " +
           "estimates). Ordinary launches use a site-compatible direct-ascent " +
           "plane; Target Plane launches preserve that transfer plane and show " +
           "the required powered-ascent dogleg. 'MECO ellipse' delivers a suborbital-periapsis " +
           "transfer ellipse whose apoapsis is the target altitude — add an " +
           "Insertion (at apoapsis) to circularize, like a real OMS-2 burn. " +
           "'direct' inserts straight into the circular orbit (legacy). A blank " +
           "site with Direct insertion is an orbital-state initialization and " +
           "does not invent a surface ascent. " +
           "A launch site constrains inclination to ≥ its latitude.",
      fields: [
        { k: "body", t: "body", label: "Body", def: "earth" },
        { k: "site", t: "site", label: "Launch site (Earth)", def: "ksc" },
        { k: "ascent", t: "sel", label: "Ascent mode", def: "meco",
          opts: ["meco", "direct"] },
        { k: "altKm", t: "num", label: "Target altitude (km)", def: 200, min: 1 },
        { k: "incDeg", t: "num", label: "Inclination (°)", def: 28.5 },
        { k: "raanDeg", t: "num", label: "RAAN Ω (°)", def: 0 },
        { k: "targetPlane", t: "bodyOpt", label: "Launch window: align plane with", def: "" },
        { k: "planeTofDays", t: "num", label: "…as positioned at T+ (days)", def: 3, min: 0 },
      ],
    },
    coast: {
      label: "Coast (propagate)",
      short: "COAST",
      color: "#58a6ff",
      doc: "Propagates for a fixed duration. 'Kepler' uses the analytic " +
           "universal-variable solution; 'RK4' integrates two-body motion; " +
           "'J2 secular' applies Earth's first-order nodal/periapsis drift; " +
           "'adaptive n-body' integrates moving point-mass gravity with " +
           "error control, and 'adaptive environment' adds selectable drag, " +
           "solar-radiation pressure with eclipses, and Earth J2-J4. The " +
           "offline Horizons table is bounded and never extrapolated. SOI " +
           "crossings are detected by the patched-conic Kepler/RK4 modes.",
      fields: [
        { k: "days", t: "num", label: "Duration (days)", def: 1, min: 0 },
        { k: "mode", t: "sel", label: "Propagator", def: "kepler",
          opts: ["kepler", "rk4", "j2-secular", "adaptive-nbody",
            "adaptive-environment"] },
        { k: "ephemeris", t: "sel", label: "Adaptive ephemeris", def: "catalog",
          opts: ["catalog", "planner-horizons"], optional: true },
        { k: "drag", t: "sel", label: "Atmospheric drag", def: "off",
          opts: ["off", "on"], optional: true },
        { k: "srp", t: "sel", label: "Solar radiation pressure", def: "off",
          opts: ["off", "on"], optional: true },
        { k: "harmonics", t: "sel", label: "Earth zonal harmonics", def: "off",
          opts: ["off", "j2", "j3", "j4"], optional: true },
        { k: "massKg", t: "num", label: "Environment mass (kg)", def: "",
          min: 0.001, optional: true },
        { k: "areaM2", t: "num", label: "Reference area (m\u00b2)", def: 10,
          min: 0.001, optional: true },
        { k: "cd", t: "num", label: "Drag coefficient Cd", def: 2.2, min: 0,
          optional: true },
        { k: "cr", t: "num", label: "Reflectivity coefficient Cr", def: 1.3, min: 0,
          optional: true },
        { k: "densityScale", t: "num", label: "Atmosphere density scale", def: 1,
          min: 0, optional: true },
      ],
    },
    finite_burn: {
      label: "Finite-thrust maneuver",
      short: "FINITE BURN",
      color: "#f85149",
      doc: "Integrates gravity, thrust, and mass depletion together with " +
           "adaptive error control. Unlike an impulse preview, this is real " +
           "propagation: a prograde burn raises apoapsis continuously while " +
           "the spacecraft moves along the burn arc.",
      fields: [
        { k: "durationMin", t: "num", label: "Burn duration (min)", def: 10, min: 0.001 },
        { k: "thrustN", t: "num", label: "Thrust (N)", def: 2000, min: 0 },
        { k: "ispS", t: "num", label: "Specific impulse (s)", def: 320, min: 1 },
        { k: "direction", t: "sel", label: "Thrust direction", def: "prograde",
          opts: ["prograde", "retrograde", "inertial"] },
        { k: "dirX", t: "num", label: "Inertial x (if selected)", def: 1 },
        { k: "dirY", t: "num", label: "Inertial y (if selected)", def: 0 },
        { k: "dirZ", t: "num", label: "Inertial z (if selected)", def: 0 },
        { k: "massKg", t: "num", label: "Start mass override (kg, blank = spacecraft)", def: "", optional: true },
        { k: "gravity", t: "sel", label: "Gravity model", def: "nbody",
          opts: ["nbody", "central-relative"] },
      ],
    },
    gp_orbit: {
      label: "GP orbit (SGP4 / SDP4)",
      short: "GP ORBIT",
      color: "#2f9e5b",
      doc: "Initializes and propagates a NORAD two-line element set with the " +
           "Vallado SGP4/SDP4 model. The element epoch and TEME frame are " +
           "reported explicitly. This is a bounded orbit prediction from mean " +
           "elements, not telemetry or an operational orbit determination.",
      fields: [
        { k: "line1", t: "text", label: "TLE line 1", def: "", required: true },
        { k: "line2", t: "text", label: "TLE line 2", def: "", required: true },
        { k: "days", t: "num", label: "Duration (days)", def: 2, min: 0.001 },
        { k: "stepMin", t: "num", label: "Output cadence (minutes)", def: 10,
          min: 0.1 },
        { k: "strictChecksum", t: "sel", label: "TLE checksum", def: "strict",
          opts: ["strict", "relaxed"] },
      ],
    },
    libration: {
      label: "Lagrange-region orbit (CR3BP)",
      short: "LIBRATION",
      color: "#a371f7",
      doc: "Initializes an ideal circular restricted three-body problem state " +
           "about Sun-Earth or Earth-Moon L1/L2. Halo and planar Lyapunov " +
           "families are differentially corrected with a state-transition " +
           "matrix. Lissajous is explicitly a bounded linear seed, not a " +
           "periodic-orbit claim. This segment begins a standalone CR3BP plan.",
      fields: [
        { k: "system", t: "sel", label: "Primary-secondary system", def: "earth-moon",
          opts: ["earth-moon", "sun-earth"] },
        { k: "point", t: "sel", label: "Libration point", def: "L2",
          opts: ["L1", "L2"] },
        { k: "family", t: "sel", label: "Orbit family", def: "halo",
          opts: ["halo", "planar-lyapunov", "lissajous"] },
        { k: "size", t: "sel", label: "Validated family size", def: "small",
          opts: ["small", "medium"] },
        { k: "hemisphere", t: "sel", label: "Halo hemisphere", def: "north",
          opts: ["north", "south"] },
      ],
    },
    cr3bp_coast: {
      label: "CR3BP adaptive coast",
      short: "CR3BP",
      color: "#58a6ff",
      doc: "Propagates the full rotating-frame CR3BP equations with adaptive " +
           "Dormand-Prince 5(4) error control. Duration is measured in the " +
           "selected reference orbit's characteristic cycles.",
      fields: [
        { k: "cycles", t: "num", label: "Duration (reference cycles)", def: 2, min: 0.01 },
        { k: "tolerance", t: "sel", label: "Error tolerance", def: "high",
          opts: ["standard", "high"] },
      ],
    },
    stationkeep: {
      label: "Libration-orbit stationkeeping",
      short: "STATIONKEEP",
      color: "#3fb6b2",
      doc: "Runs deterministic ideal impulsive reference tracking in the " +
           "current CR3BP system. It is a design estimate, not flight " +
           "guidance: navigation error, maneuver execution error, covariance, " +
           "and operational constraints are not modeled.",
      fields: [
        { k: "cycles", t: "num", label: "Duration (reference cycles)", def: 2,
          min: 0.01, max: 50 },
        { k: "corrections", t: "num", label: "Checks per cycle", def: 12,
          min: 1, max: 100 },
        { k: "offsetKm", t: "num", label: "Initial radial offset (km)", def: 5, min: 0 },
        { k: "maxBurnMs", t: "num", label: "Max correction (m/s)", def: 5, min: 0.001 },
      ],
    },
    coast_to: {
      label: "Coast to event",
      short: "COAST-TO",
      color: "#58a6ff",
      doc: "Propagates until periapsis or apoapsis of the current orbit " +
           "(detected by the sign change of r·v), up to a time limit.",
      fields: [
        { k: "event", t: "sel", label: "Stop at", def: "periapsis",
          opts: ["periapsis", "apoapsis"] },
        { k: "maxDays", t: "num", label: "Time limit (days)", def: 5, min: 0 },
        { k: "mode", t: "sel", label: "Propagator", def: "kepler",
          opts: ["kepler", "rk4"] },
      ],
    },
    impulse: {
      label: "Impulsive maneuver (Δv)",
      short: "BURN",
      color: "#f85149",
      doc: "Instantaneous velocity change. VNB frame: V = along velocity " +
           "(prograde), N = orbit normal, B = V×N (outward). " +
           "Inertial frame: ecliptic XYZ components.",
      fields: [
        { k: "frame", t: "sel", label: "Frame", def: "vnb", opts: ["vnb", "inertial"] },
        { k: "dv1", t: "num", label: "Δv₁ V/x (km/s)", def: 0.1 },
        { k: "dv2", t: "num", label: "Δv₂ N/y (km/s)", def: 0 },
        { k: "dv3", t: "num", label: "Δv₃ B/z (km/s)", def: 0 },
      ],
    },
    separate: {
      label: "Separate from another vehicle",
      short: "SEPARATE",
      color: "#3fb6b2",
      doc: "Initializes this vehicle from the exact state of another mission " +
           "vehicle at the end of a selected parent segment, then applies an " +
           "optional small separation impulse. Use this as the first segment " +
           "of a branch vehicle; it does not reset an already-flying vehicle.",
      fields: [
        { k: "fromVehicle", t: "vehicle", label: "Separate from vehicle", def: "primary" },
        { k: "afterSegment", t: "num", label: "After parent segment (1-based)", def: 1, min: 1 },
        { k: "delayMin", t: "num", label: "Delay after segment (min)", def: 0, min: 0 },
        { k: "frame", t: "sel", label: "Separation frame", def: "vnb",
          opts: ["vnb", "inertial"] },
        { k: "dv1", t: "num", label: "Separation dv1 V/x (km/s)", def: 0.001 },
        { k: "dv2", t: "num", label: "Separation dv2 N/y (km/s)", def: 0 },
        { k: "dv3", t: "num", label: "Separation dv3 B/z (km/s)", def: 0 },
      ],
    },
    rendezvous: {
      label: "Rendezvous with vehicle",
      short: "RENDEZVOUS",
      color: "#ffa657",
      doc: "Targets another mission vehicle on the shared UTC timeline. Long " +
           "timelines use a passive phasing wait followed by a bounded, " +
           "single-revolution terminal Lambert leg and an ideal velocity " +
           "match. This is deterministic design guidance, " +
           "not autonomous relative-navigation or proximity-operations GNC.",
      fields: [
        { k: "targetVehicle", t: "vehicle", label: "Target vehicle", def: "primary" },
        { k: "tofHours", t: "num", label: "Time of flight (hours)", def: 6, min: 0.001 },
        { k: "direction", t: "sel", label: "Transfer direction", def: "auto",
          opts: ["auto", "prograde", "retrograde"] },
        { k: "maxDvKms", t: "num", label: "Maximum total dv (km/s)", def: 5, min: 0.001 },
        { k: "terminalRangeKm", t: "num", label: "Terminal range tolerance (km)", def: 0.001, min: 0.000001 },
      ],
    },
    dock: {
      label: "Dock / capture vehicle",
      short: "DOCK",
      color: "#7ee787",
      doc: "Joins this vehicle to a target only when the instantaneous range " +
           "and relative speed are inside explicit capture limits. A joined " +
           "vehicle follows the target's exact propagated state during later " +
           "Coast segments. Contact loads, attitude, ports, and collision " +
           "dynamics are outside this bounded mission-design model.",
      fields: [
        { k: "targetVehicle", t: "vehicle", label: "Dock with vehicle", def: "primary" },
        { k: "captureRangeKm", t: "num", label: "Capture range (km)", def: 0.00025, min: 0.000001 },
        { k: "captureRateMps", t: "num", label: "Capture relative speed (m/s)", def: 0.2, min: 0.000001 },
      ],
    },
    undock: {
      label: "Undock / depart vehicle",
      short: "UNDOCK",
      color: "#3fb6b2",
      doc: "Releases a joined vehicle from its current docking target and " +
           "applies an optional small departure impulse. The two vehicles then " +
           "continue on independent state histories.",
      fields: [
        { k: "frame", t: "sel", label: "Departure frame", def: "vnb",
          opts: ["vnb", "inertial"] },
        { k: "dv1", t: "num", label: "Departure dv1 V/x (km/s)", def: -0.001 },
        { k: "dv2", t: "num", label: "Departure dv2 N/y (km/s)", def: 0 },
        { k: "dv3", t: "num", label: "Departure dv3 B/z (km/s)", def: 0 },
      ],
    },
    hohmann: {
      label: "Hohmann transfer (about current body)",
      short: "HOHMANN",
      color: "#d2a8ff",
      doc: "Classic two-burn transfer between near-circular orbits: " +
           "Δv₁ = √(μ/r₁)(√(2r₂/(r₁+r₂))−1), coast half the transfer " +
           "ellipse, then circularize. Assumes the start orbit is circular.",
      fields: [
        { k: "rTargetKm", t: "num", label: "Target orbit radius (km)", def: 42164, min: 1 },
      ],
    },
    transfer: {
      label: "Transfer to body (Lambert)",
      short: "TRANSFER",
      color: "#ffa657",
      doc: "Solves Lambert's problem from the current position to the target " +
           "body's future position, applies the required Δv, and coasts. If a " +
           "flyby periapsis is set, the aim point is offset iteratively to hit " +
           "that periapsis (simplified B-plane targeting). Target must orbit " +
           "the current central body. The Vary/Achieve toggle exposes a bounded " +
           "arrival-periapsis target; use the Windows pane to vary departure " +
           "date and time of flight before applying that target.",
      fields: [
        { k: "target", t: "body", label: "Target body", def: "moon" },
        { k: "tofDays", t: "num", label: "Time of flight (days)", def: 3, min: 0.001 },
        { k: "periKm", t: "num", label: "Target periapsis alt (km, blank = center)",
          def: 110, optional: true },
        { k: "targetMode", t: "sel", label: "Target solver (Vary/Achieve)", def: "off",
          opts: ["off", "arrival-periapsis"] },
        { k: "targetValue", t: "num", label: "Target arrival periapsis alt (km)",
          def: 110, min: 0 },
        { k: "aimOffsetKm", t: "num",
          label: "Fixed B-plane aim offset (km; blank = solve periapsis)",
          def: "", min: 0, optional: true },
        { k: "side", t: "sel", label: "Pass side", def: "A", opts: ["A", "B"] },
        { k: "optWait", t: "sel", label: "Ignition point", def: "optimal",
          opts: ["optimal", "immediate"] },
      ],
    },
    depart: {
      label: "Interplanetary departure",
      short: "DEPART",
      color: "#ffa657",
      doc: "Patched-conic escape: solves Lambert in the parent frame (e.g. " +
           "heliocentric) to the target's future position, giving v∞ and " +
           "C3 = v∞². The applied injection vector, event Δv, and C3 come from " +
           "one explicit source-body hyperbola. The spacecraft then spends real " +
           "simulation time coasting to the source SOI before a position- and " +
           "velocity-continuous frame handoff; the date-pinned arrival epoch is " +
           "retained.",
      fields: [
        { k: "target", t: "body", label: "Target body", def: "mars" },
        { k: "tofDays", t: "num", label: "Time of flight (days)", def: 210, min: 1 },
        { k: "periKm", t: "num", label: "Arrival periapsis alt (km, blank = center)",
          def: 400, optional: true },
        { k: "aimOffsetKm", t: "num",
          label: "Fixed B-plane aim offset (km; blank = solve periapsis)",
          def: "", min: 0, optional: true },
        { k: "side", t: "sel", label: "Pass side", def: "A", opts: ["A", "B"] },
      ],
    },
    insertion: {
      label: "Orbit insertion (at apsis)",
      short: "INSERT",
      color: "#f85149",
      doc: "Coasts to the next periapsis (or apoapsis), then burns there: " +
           "circular (v = √(μ/r)) or elliptical with a chosen opposite " +
           "apsis (vis-viva). At-apoapsis + circular is the classic " +
           "launch-circularization (OMS-2) burn. Preserves the orbit plane.",
      fields: [
        { k: "at", t: "sel", label: "Burn at", def: "periapsis",
          opts: ["periapsis", "apoapsis"] },
        { k: "shape", t: "sel", label: "Final orbit", def: "circular",
          opts: ["circular", "elliptical"] },
        { k: "apoKm", t: "num", label: "Other apsis alt (km, if elliptical)", def: 10000, min: 0 },
        { k: "targetMode", t: "sel", label: "Target solver (Vary/Achieve)", def: "off",
          opts: ["off", "opposite-apsis", "period"] },
        { k: "targetValue", t: "num", label: "Target altitude (km) / period (h)", def: 35786, min: 0 },
        { k: "maxDays", t: "num", label: "Apsis wait limit (days)", def: 5, min: 0 },
      ],
    },
    flyby: {
      label: "Gravity assist (flyby)",
      short: "FLYBY",
      color: "#d2a8ff",
      doc: "Unpowered (optionally powered) swing through the current body's " +
           "sphere of influence: coasts to the encounter periapsis and back " +
           "out. The hyperbolic pass rotates the v∞ vector, changing the " +
           "orbit about the parent body for free — the physics behind " +
           "VVEJGA-style tours. Precede with a Transfer/Depart targeting a " +
           "flyby periapsis; follow with the next Transfer. Reports v∞ " +
           "in/out, turn angle δ = 2·asin(1/e), and the Δv gained.",
      fields: [
        { k: "dvKms", t: "num", label: "Periapsis burn Δv (km/s, + prograde)", def: 0 },
        { k: "maxDays", t: "num", label: "SOI transit time limit (days)", def: 40, min: 0.01 },
      ],
    },
    observe: {
      label: "Observation window",
      short: "OBSERVE",
      color: "#3fb6b2",
      doc: "Coasts while the instruments point at a target body — e.g. imaging " +
           "Io during a Jupiter flyby, or Titan on approach to Saturn. The " +
           "ground-track panel switches to a map of the observed body with the " +
           "sub-spacecraft point, its track over the window, and the visible-" +
           "disk footprint; the POV camera looks at the target. Purely an " +
           "instrument-pointing window — the trajectory is a normal coast.",
      fields: [
        { k: "target", t: "body", label: "Observe body", def: "io" },
        { k: "days", t: "num", label: "Duration (days)", def: 1.5, min: 0.001 },
        { k: "mode", t: "sel", label: "Propagator", def: "kepler",
          opts: ["kepler", "rk4"] },
      ],
    },
    return: {
      label: "Return / reentry targeting (Lambert)",
      short: "RETURN",
      color: "#ffa657",
      doc: "Targets a low pass over a body (e.g. Earth entry corridor): " +
           "Lambert transfer to an aim point at the chosen periapsis radius. " +
           "Used for trans-Earth injection and free-return corrections. " +
           "Target must be the current central body or its parent.",
      fields: [
        { k: "target", t: "body", label: "Target body", def: "earth" },
        { k: "tofDays", t: "num", label: "Time of flight (days)", def: 2.7, min: 0.01 },
        { k: "periKm", t: "num", label: "Target periapsis alt (km)", def: 40 },
        { k: "optWait", t: "sel", label: "Ignition point", def: "optimal",
          opts: ["optimal", "immediate"] },
      ],
    },
    land: {
      label: "Land / touch down",
      short: "LAND",
      color: "#7ee787",
      doc: "Idealized descent: orbital velocity is zeroed (Δv ≈ current " +
           "speed) and a schematic descent arc is drawn. No descent " +
           "guidance or terrain — a placeholder for a real landing.",
      fields: [
        { k: "descentHours", t: "num", label: "Descent duration (h)", def: 0.75, min: 0.01 },
        { k: "stayDays", t: "num", label: "Surface stay (days)", def: 0.9, min: 0 },
      ],
    },
    ascend: {
      label: "Ascend to orbit",
      short: "ASCENT",
      color: "#7ee787",
      doc: "Instantaneous insertion from the surface into a circular orbit " +
           "through the current site, in the plane of the pre-landing orbit. " +
           "Δv estimate ≈ circular speed (real ascent costs more).",
      fields: [
        { k: "altKm", t: "num", label: "Orbit altitude (km)", def: 100, min: 1 },
      ],
    },
    reentry: {
      label: "Atmospheric entry / splashdown",
      short: "REENTRY",
      color: "#e3b341",
      doc: "Coasts until the entry-interface altitude is crossed, then draws " +
           "a schematic descent to the surface. Requires the incoming " +
           "trajectory's periapsis to dip below the interface. Ends the mission.",
      fields: [
        { k: "interfaceKm", t: "num", label: "Entry interface alt (km)", def: 120, min: 0 },
        { k: "maxDays", t: "num", label: "Time limit (days)", def: 6, min: 0 },
        { k: "descentMin", t: "num", label: "Descent duration (min)", def: 20, min: 1 },
      ],
    },
  };

  /* ============================ small utils ============================ */
  const jdAt = (ctx, t) => ctx.epochJD + t / DAY;

  function relBodyState(bodyId, centralId, jd) {
    // position & velocity of bodyId relative to centralId
    const r = V.sub(A.bodyWorld(bodyId, jd), A.bodyWorld(centralId, jd));
    const v = V.sub(A.bodyWorldVel(bodyId, jd), A.bodyWorldVel(centralId, jd));
    return { r, v };
  }

  function pushSample(ctx, segIdx, interpMode, meta) {
    const s = ctx.state;
    const w = s.w ? V.clone(s.w) : (s.cen === "sun" ? V.clone(s.r)
      : V.add(A.bodyWorld(s.cen, jdAt(ctx, s.t)), s.r));
    const sample = {
      t: s.t, cen: s.cen, seg: segIdx,
      r: V.clone(s.r), v: V.clone(s.v), w,
      landed: !!s.landed,
      vehicleId: ctx.vehicleId || "primary",
      // Describes the interval from the preceding sample to this one.
      // The UI uses it to interpolate curved propagation arcs faithfully.
      _interp: interpMode || null,
    };
    if (s.cr3bp) {
      sample.cr3bp = true;
      sample.cr3bpSystem = s.cr3bpSystem;
      sample.synodic = s.synodic.slice();
    }
    if (s.worldV) sample.worldV = V.clone(s.worldV);
    if (s.dockedTo) sample.dockedTo = s.dockedTo;
    // Force integrations can use a different inertial ephemeris than the
    // renderer. Keep that physics-frame state private while w/worldV remain
    // in the catalog display frame used by every body and adjacent segment.
    if (s.forceW) sample.forceW = V.clone(s.forceW);
    if (s.forceWorldV) sample.forceWorldV = V.clone(s.forceWorldV);
    if (Number.isFinite(s.massKg)) sample.massKg = s.massKg;
    if (s.forceModel) sample.forceModel = s.forceModel;
    if (s.forceEphemeris) sample.forceEphemeris = s.forceEphemeris;
    if (meta && meta.breakBefore) sample._breakBefore = true;
    if (meta && meta.handoffFrom) sample._handoffFrom = meta.handoffFrom;
    ctx.samples.push(sample);
  }

  function addEvent(ctx, segIdx, kind, label, extra) {
    const state = ctx.state;
    const jd = state ? jdAt(ctx, state.t) : ctx.epochJD;
    const w = state ? (state.w ? V.clone(state.w)
      : (state.cen === "sun" ? V.clone(state.r)
        : V.add(A.bodyWorld(state.cen, jd), state.r))) : null;
    const ev = Object.assign({
      t: state ? state.t : 0,
      seg: segIdx,
      kind,
      label,
      vehicleId: ctx.vehicleId || "primary",
      vehicleName: ctx.vehicleName || "Spacecraft",
      w,
    }, extra || {});
    ctx.events.push(ev);
    return ev;
  }

  function vehicleResultAt(ctx, vehicleId) {
    const id = String(vehicleId || "primary");
    return ctx.vehicleResults && ctx.vehicleResults[id] || null;
  }

  function vehicleSampleAt(ctx, vehicleId, t) {
    const result = vehicleResultAt(ctx, vehicleId);
    if (!result || !result.samples || !result.samples.length) return null;
    const first = result.samples[0].t;
    const last = result.samples[result.samples.length - 1].t;
    if (t < first - 1e-6 || t > last + 1e-6) return null;
    return sampleAtTime(result, Math.min(last, Math.max(first, t)));
  }

  function stateFromVehicleSample(sample) {
    if (!sample) return null;
    const state = {
      cen: sample.cen,
      r: V.clone(sample.r),
      v: V.clone(sample.v),
      w: sample.w ? V.clone(sample.w) : null,
      worldV: sample.worldV ? V.clone(sample.worldV) : null,
      t: sample.t,
      landed: !!sample.landed,
    };
    if (sample.forceW) state.forceW = V.clone(sample.forceW);
    if (sample.forceWorldV) state.forceWorldV = V.clone(sample.forceWorldV);
    if (sample.forceModel) state.forceModel = sample.forceModel;
    if (sample.forceEphemeris) state.forceEphemeris = sample.forceEphemeris;
    if (Number.isFinite(sample.massKg)) state.massKg = sample.massKg;
    return state;
  }

  function maneuverVector(state, frame, components) {
    if (frame === "inertial") return components.slice();
    const vHat = V.norm(state.v);
    const nHat = V.norm(V.cross(state.r, state.v));
    const bHat = V.cross(vHat, nHat);
    return V.add(V.add(V.scale(vHat, components[0]),
      V.scale(nHat, components[1])), V.scale(bHat, components[2]));
  }

  function applyDv(ctx, segIdx, dvVec, label, extra) {
    const mag = V.mag(dvVec);
    const burnFrom = {
      cen: ctx.state.cen,
      r: V.clone(ctx.state.r),
      v: V.clone(ctx.state.v),
      t: ctx.state.t,
    };
    ctx.state.v = V.add(ctx.state.v, dvVec);
    // Adaptive inertial arcs cache the same velocity in the world frame.
    // Keep both representations coherent so a following n-body/finite-thrust
    // segment cannot silently restart from the pre-burn velocity.
    if (ctx.state.worldV)
      ctx.state.worldV = V.add(ctx.state.worldV, dvVec);
    if (ctx.state.forceWorldV)
      ctx.state.forceWorldV = V.add(ctx.state.forceWorldV, dvVec);
    ctx.totalDv += mag;
    if (ctx.massKg > 0 && ctx.mission && ctx.mission.spacecraft) {
      const sc = ctx.mission.spacecraft;
      const isp = +sc.isp;
      const dry = Math.max(0, +sc.dryKg || 0);
      if (isp > 0) ctx.massKg = Math.max(dry,
        ctx.massKg / Math.exp(mag / (isp * 0.00980665)));
    }
    if (Number.isFinite(ctx.massKg) && ctx.massKg > 0)
      ctx.state.massKg = ctx.massKg;
    const ev = addEvent(ctx, segIdx, "burn", label,
      Object.assign({ dv: mag, body: ctx.state.cen }, extra || {}, {
        // Private render metadata. The dynamics remain an instantaneous
        // impulse; renderer.js uses these two exact endpoint states only to
        // animate a clearly labelled visual orbit preview around the burn.
        _burn: {
          cen: burnFrom.cen,
          r: burnFrom.r,
          v0: burnFrom.v,
          v1: V.clone(ctx.state.v),
          t: burnFrom.t,
        },
      }));
    pushSample(ctx, segIdx);
    return ev;
  }

  function warn(seg, msg, level) {
    seg._warn.push({ msg, level: level || "warn" });
  }

  /* =========================== propagation ============================= */
  function advanceState(state, dt, mu, mode) {
    if (mode === "rk4") {
      let n = Math.ceil(dt / Math.max(1,
        0.015 * Math.sqrt(Math.pow(V.mag(state.r), 3) / mu)));
      n = Math.min(Math.max(n, 1), 96);
      const h = dt / n;
      let r = state.r, v = state.v;
      for (let i = 0; i < n; i++) {
        const s = A.rk4Step(r, v, h, mu);
        r = s.r; v = s.v;
      }
      return { r, v };
    }
    return A.propagateUniversal(state.r, state.v, dt, mu);
  }

  function soiChildren(cenId) {
    return childrenOf(cenId).filter((b) => b.soi > b.radius * 1.5);
  }

  function chooseDt(ctx, remaining, opts) {
    const s = ctx.state;
    const body = BODIES[s.cen];
    const mu = body.mu;
    const rm = V.mag(s.r), vm = V.mag(s.v);
    const alpha = 2 / rm - (vm * vm) / mu;
    let dt;
    if (alpha > 1e-14) {
      const a = 1 / alpha;
      dt = (2 * Math.PI * Math.sqrt(a * a * a / mu)) / 260;
    } else {
      dt = 0.02 * Math.sqrt((rm * rm * rm) / mu);
    }
    dt = Math.min(dt, s.cen === "sun" ? 2.5 * DAY : 6 * 3600);
    // refine near SOI boundaries so we cannot step across one
    const jd = jdAt(ctx, s.t);
    for (const ch of soiChildren(s.cen)) {
      const st = relBodyState(ch.id, s.cen, jd);
      const d = V.mag(V.sub(s.r, st.r)) - ch.soi;
      if (d > 0) {
        const rel = Math.max(V.mag(V.sub(s.v, st.v)), 1e-3);
        dt = Math.min(dt, Math.max(20, (0.35 * d) / rel));
      }
    }
    if (s.cen !== "sun" && isFinite(body.soi)) {
      const dExit = body.soi - rm;
      if (dExit > 0) dt = Math.min(dt, Math.max(20, (0.35 * dExit) / Math.max(vm, 1e-3)));
    }
    // Low-pass refinement: when the osculating periapsis dips near the
    // surface (or a reentry stop radius) and we are inbound, shrink the step
    // so a minutes-long atmospheric dip cannot be stepped over.
    const stopR = (opts.stop && opts.stop.type === "radius_below" && opts.stop.body === s.cen)
      ? Math.max(opts.stop.radius, body.radius) : body.radius;
    if (V.dot(s.r, s.v) < 0) {
      const hm = V.mag(V.cross(s.r, s.v));
      const En = (vm * vm) / 2 - mu / rm;
      const ecc = Math.sqrt(Math.max(0, 1 + (2 * En * hm * hm) / (mu * mu)));
      const rpOsc = (hm * hm) / mu / (1 + ecc);
      if (rpOsc < stopR * 1.03)
        dt = Math.min(dt, Math.max(2, (0.3 * Math.max(rm - stopR, 50)) / Math.max(vm, 1e-3)));
    }
    dt = Math.max(dt, remaining / 3000, 1e-3);
    return Math.min(dt, remaining);
  }

  /**
   * Propagate the current state for up to durS seconds.
   * opts: { mode, segIdx, stop: {type:'time'|'periapsis'|'apoapsis'|'soi_of'|'radius_below',
   *         target, radius}, expectImpact }
   * Returns { reason } — 'time'|'periapsis'|'apoapsis'|'soi_of'|'radius_below'|'crash'|'steps'
   */
  function propagateArc(ctx, durS, opts) {
    const mode = opts.mode === "rk4" ? "rk4" : "kepler";
    const segIdx = opts.segIdx;
    const stop = opts.stop || { type: "time" };
    let remaining = durS;
    let steps = 0, transitions = 0;
    pushSample(ctx, segIdx);

    while (remaining > 1e-6) {
      if (++steps > MAX_STEPS) return { reason: "steps" };
      const s = ctx.state;
      const body = BODIES[s.cen];
      const mu = body.mu;
      const dt = chooseDt(ctx, remaining, opts);
      const cand = advanceState(s, dt, mu, mode);
      const tNew = s.t + dt;

      /* ---- crossing detection (evaluate signed funcs before/after) ---- */
      const kids = soiChildren(s.cen);
      const evals = [];
      const f0 = {}, f1 = {};
      // crash / stop radius
      const stopR = stop.type === "radius_below" && stop.body === s.cen
        ? stop.radius : body.radius;
      f0.crash = V.mag(s.r) - stopR;
      f1.crash = V.mag(cand.r) - stopR;
      if (f0.crash > 0 && f1.crash <= 0) evals.push("crash");
      // SOI exit
      if (s.cen !== "sun" && isFinite(body.soi)) {
        f0.exit = body.soi - V.mag(s.r);
        f1.exit = body.soi - V.mag(cand.r);
        if (f0.exit > 0 && f1.exit <= 0) evals.push("exit");
      }
      // SOI entries
      for (const ch of kids) {
        const b0 = relBodyState(ch.id, s.cen, jdAt(ctx, s.t));
        const b1 = relBodyState(ch.id, s.cen, jdAt(ctx, tNew));
        f0["in_" + ch.id] = V.mag(V.sub(s.r, b0.r)) - ch.soi;
        f1["in_" + ch.id] = V.mag(V.sub(cand.r, b1.r)) - ch.soi;
        if (f0["in_" + ch.id] > 0 && f1["in_" + ch.id] <= 0) evals.push("in_" + ch.id);
      }
      // apsis stops
      if (stop.type === "periapsis" || stop.type === "apoapsis") {
        const sgn = stop.type === "periapsis" ? 1 : -1;
        f0.apsis = sgn * V.dot(s.r, s.v);
        f1.apsis = sgn * V.dot(cand.r, cand.v);
        if (f0.apsis < 0 && f1.apsis >= 0) evals.push("apsis");
      }

      if (evals.length === 0) {
        ctx.state = { cen: s.cen, r: cand.r, v: cand.v, t: tNew, landed: false };
        remaining -= dt;
        pushSample(ctx, segIdx, mode);
        continue;
      }

      /* ---- refine earliest crossing by bisection on dt ---- */
      const valAt = (name, st, tAbs) => {
        if (name === "crash") return V.mag(st.r) - stopR;
        if (name === "exit") return body.soi - V.mag(st.r);
        if (name === "apsis") {
          const sgn = stop.type === "periapsis" ? 1 : -1;
          return -sgn * V.dot(st.r, st.v); // flip so crossing is + -> -
        }
        const chId = name.slice(3);
        const bs = relBodyState(chId, s.cen, jdAt(ctx, tAbs));
        return V.mag(V.sub(st.r, bs.r)) - BODIES[chId].soi;
      };
      let bestName = null, bestDt = dt;
      for (const name of evals) {
        let lo = 0, hi = dt;
        for (let i = 0; i < 30; i++) {
          const mid = 0.5 * (lo + hi);
          const st = advanceState(s, mid, mu, mode);
          if (valAt(name, st, s.t + mid) <= 0) hi = mid; else lo = mid;
        }
        if (hi < bestDt || bestName === null) {
          if (hi <= bestDt) { bestDt = hi; bestName = name; }
        }
      }

      const stAtEv = advanceState(s, bestDt, mu, mode);
      ctx.state = { cen: s.cen, r: stAtEv.r, v: stAtEv.v, t: s.t + bestDt, landed: false };
      remaining -= bestDt;
      pushSample(ctx, segIdx, mode);

      if (bestName === "crash") {
        if (stop.type === "radius_below" && stop.body === s.cen) {
          return { reason: "radius_below" };
        }
        if (opts.expectImpact) return { reason: "crash_expected" };
        addEvent(ctx, segIdx, "impact",
          `IMPACT — ${body.name} surface`, { body: s.cen });
        ctx.crashed = true;
        return { reason: "crash" };
      }
      if (bestName === "apsis") {
        return { reason: stop.type };
      }
      if (bestName === "exit") {
        const jd = jdAt(ctx, ctx.state.t);
        const parent = body.parent;
        // Use the same world-state difference as pushSample/entry handling so
        // the two same-time samples are exactly continuous at the frame patch.
        const bs = relBodyState(s.cen, parent, jd);
        ctx.state = {
          cen: parent,
          r: V.add(ctx.state.r, bs.r),
          v: V.add(ctx.state.v, bs.v),
          t: ctx.state.t, landed: false,
        };
        // nudge outward so we don't re-trigger
        addEvent(ctx, segIdx, "soi_exit",
          `Exit ${body.name} SOI → ${BODIES[parent].name} frame`, { body: parent });
        pushSample(ctx, segIdx);
        if (++transitions > MAX_TRANSITIONS) return { reason: "transitions" };
        if (stop.type === "soi_of" && parent === stop.target) return { reason: "soi_of" };
        continue;
      }
      if (bestName && bestName.startsWith("in_")) {
        const chId = bestName.slice(3);
        const jd = jdAt(ctx, ctx.state.t);
        const bs = relBodyState(chId, s.cen, jd);
        ctx.state = {
          cen: chId,
          r: V.sub(ctx.state.r, bs.r),
          v: V.sub(ctx.state.v, bs.v),
          t: ctx.state.t, landed: false,
        };
        addEvent(ctx, segIdx, "soi_entry",
          `Enter ${BODIES[chId].name} SOI (r=${Math.round(BODIES[chId].soi).toLocaleString()} km)`,
          { body: chId });
        pushSample(ctx, segIdx);
        if (++transitions > MAX_TRANSITIONS) return { reason: "transitions" };
        if (stop.type === "soi_of" && chId === stop.target) return { reason: "soi_of" };
        continue;
      }
    }
    return { reason: "time" };
  }

  /* ================== Lambert targeting with aim offset ================= */
  /**
   * Solve a transfer from ctx.state (must be in frame `cenId`) to `targetId`
   * arriving after tofS. If periKm is a number, offsets the aim point to
   * achieve that periapsis altitude at the target (1-D search).
   * Returns { v1, aim, offsetKm, rp } or null.
   */
  function solveTransfer(ctx, cenId, targetId, tofS, periKm, side, fixedAimOffsetKm) {
    const mu = BODIES[cenId].mu;
    const tgt = BODIES[targetId];
    const t1 = ctx.state.t;
    const jd2 = jdAt(ctx, t1 + tofS);
    const r1 = ctx.state.r;
    const rT2 = relBodyState(targetId, cenId, jd2).r;
    const base = A.lambert(r1, rT2, tofS, mu, true);
    if (!base) return null;
    const hasFixedAim = fixedAimOffsetKm !== "" && fixedAimOffsetKm !== null &&
      fixedAimOffsetKm !== undefined && Number.isFinite(+fixedAimOffsetKm);
    if ((periKm === "" || periKm === null || periKm === undefined ||
        !isFinite(periKm)) && !hasFixedAim) {
      return { v1: base.v1, aim: rT2, offsetKm: 0, rp: null };
    }

    const vT2 = relBodyState(targetId, cenId, jd2).v;
    const vRel = V.sub(base.v2, vT2);
    const hArc = V.cross(r1, base.v1);
    let ohat = V.cross(vRel, hArc);
    if (V.mag(ohat) < 1e-9) ohat = V.cross(vRel, [0, 0, 1]);
    ohat = V.norm(ohat);
    if (side === "B") ohat = V.scale(ohat, -1);

    const rpTarget = periKm === "" || periKm === null || periKm === undefined ||
      !Number.isFinite(+periKm) ? null : tgt.radius + +periKm;
    if (Number.isFinite(rpTarget) && Number.isFinite(tgt.soi) && rpTarget >= tgt.soi) {
      return { v1: base.v1, aim: rT2, offsetKm: hasFixedAim
        ? Math.max(0, +fixedAimOffsetKm) : 0, rp: null,
        targetingFailed: true, fixedAim: hasFixedAim, outsideSoi: true,
        targetingConverged: false, residualKm: null };
    }

    // achieved periapsis for a given aim offset d (km)
    const rpOf = (d) => {
      const aim = V.add(rT2, V.scale(ohat, d));
      const L = A.lambert(r1, aim, tofS, mu, true);
      if (!L) return null;
      // scan the conic for first SOI entry of the target
      const N = 160;
      let inside = -1, prevD = Infinity, minD = Infinity;
      let loT = 0, hiT = tofS;
      for (let k = 1; k <= N; k++) {
        const tau = (k / N) * tofS;
        const st = A.propagateUniversal(r1, L.v1, tau, mu);
        const bT = relBodyState(targetId, cenId, jdAt(ctx, t1 + tau)).r;
        const dist = V.mag(V.sub(st.r, bT));
        minD = Math.min(minD, dist);
        if (dist < tgt.soi) { inside = tau; loT = ((k - 1) / N) * tofS; hiT = tau; break; }
        prevD = dist;
      }
      if (inside < 0) return { rp: minD, entered: false, L };
      // bisect the SOI crossing, then evaluate the hyperbolic periapsis
      for (let i = 0; i < 30; i++) {
        const mid = 0.5 * (loT + hiT);
        const st = A.propagateUniversal(r1, L.v1, mid, mu);
        const bT = relBodyState(targetId, cenId, jdAt(ctx, t1 + mid)).r;
        if (V.mag(V.sub(st.r, bT)) < tgt.soi) hiT = mid; else loT = mid;
      }
      const st = A.propagateUniversal(r1, L.v1, hiT, mu);
      const bs = relBodyState(targetId, cenId, jdAt(ctx, t1 + hiT));
      const rRel = V.sub(st.r, bs.r), vRelE = V.sub(st.v, bs.v);
      const coe = A.rvToCoe(rRel, vRelE, tgt.mu);
      return { rp: coe.rp, entered: true, L };
    };

    if (hasFixedAim) {
      const fixedOffset = Math.max(0, +fixedAimOffsetKm);
      const fixed = rpOf(fixedOffset);
      if (!fixed || !fixed.L || !fixed.entered)
        return { v1: base.v1, aim: rT2, offsetKm: fixedOffset,
          rp: null, targetingFailed: true, fixedAim: true,
          missedSoi: !!(fixed && fixed.L), targetingConverged: false,
          residualKm: null };
      return { v1: fixed.L.v1, aim: V.add(rT2, V.scale(ohat, fixedOffset)),
        offsetKm: fixedOffset, rp: fixed.rp, iterations: 0, fixedAim: true,
        residualKm: Number.isFinite(rpTarget) ? fixed.rp - rpTarget : null,
        targetingConverged: fixed.entered && Number.isFinite(rpTarget)
          ? Math.abs(fixed.rp - rpTarget) <= 1 : true };
    }

    // bracket then bisect d in [0, 0.95 SOI]
    let lo = 0, hi = 0.95 * tgt.soi;
    const fLo = rpOf(lo), fHi = rpOf(hi);
    if (!fLo || !fHi) return { v1: base.v1, aim: rT2, offsetKm: 0, rp: null, targetingFailed: true };
    if (fLo.rp > rpTarget) {
      // even a center aim passes high — accept the center solution
      return { v1: fLo.L ? fLo.L.v1 : base.v1, aim: rT2, offsetKm: 0,
               rp: fLo.rp, high: true, iterations: 0,
               residualKm: fLo.rp - rpTarget };
    }
    if (fHi.rp < rpTarget) {
      return { v1: base.v1, aim: rT2, offsetKm: 0, rp: fLo.rp,
        targetingFailed: true, iterations: 0, residualKm: fLo.rp - rpTarget };
    }
    let best = null;
    let iterations = 0;
    for (let i = 0; i < 26; i++) {
      iterations = i + 1;
      const mid = 0.5 * (lo + hi);
      const f = rpOf(mid);
      if (!f) { hi = mid; continue; }
      best = { d: mid, f };
      if (f.rp < rpTarget) lo = mid; else hi = mid;
    }
    if (!best) return { v1: base.v1, aim: rT2, offsetKm: 0, rp: null, targetingFailed: true };
    const aim = V.add(rT2, V.scale(ohat, best.d));
    return {
      v1: best.f.L.v1, aim, offsetKm: best.d, rp: best.f.rp,
      iterations, residualKm: best.f.rp - rpTarget,
      targetingConverged: best.f.entered && Math.abs(best.f.rp - rpTarget) <= 1,
    };
  }

  /* ============= burn-point (ignition-time) optimization =============== *
   * Real missions time injection burns for the point of the parking orbit
   * where the required velocity is tangent to the current motion. We scan
   * one orbital period (capped) for the wait time minimizing |Δv|.        */
  function bestBurnWait(ctx, capS, evalDv) {
    const s = ctx.state;
    const mu = BODIES[s.cen].mu;
    const coe = A.rvToCoe(s.r, s.v, mu);
    if (!(coe.e < 1) || !isFinite(coe.a) || coe.a <= 0) return 0; // hyperbolic: burn now
    const P = 2 * Math.PI * Math.sqrt(Math.pow(coe.a, 3) / mu);
    const win = Math.min(P, capS);
    const N = 180;
    let bestTau = 0, bestDv = Infinity;
    for (let k = 0; k <= N; k++) {
      const tau = (k / N) * win;
      const st = A.propagateUniversal(s.r, s.v, tau, mu);
      const dv = evalDv(st, s.t + tau);
      if (dv !== null && dv < bestDv) { bestDv = dv; bestTau = tau; }
    }
    // local refinement around the best coarse point
    let lo = Math.max(0, bestTau - win / N), hi = Math.min(win, bestTau + win / N);
    for (let i = 0; i < 18; i++) {
      const m1 = lo + (hi - lo) * 0.382, m2 = lo + (hi - lo) * 0.618;
      const d1 = evalDv(A.propagateUniversal(s.r, s.v, m1, mu), s.t + m1);
      const d2 = evalDv(A.propagateUniversal(s.r, s.v, m2, mu), s.t + m2);
      if ((d1 === null ? Infinity : d1) < (d2 === null ? Infinity : d2)) hi = m2; else lo = m1;
    }
    return 0.5 * (lo + hi);
  }

  /* Solve the local hyperbolic leg from a parking-orbit burn point to a
   * reviewed SOI boundary point.  The boundary speed is supplied by the
   * parent-frame Lambert solution; time of flight is the scalar unknown.
   * Searching both zero-revolution Lambert branches avoids assuming that the
   * parking-orbit prograde direction already lies in the departure plane. */
  function solveLocalDepartureLeg(start, exitR, exitSpeed, mu, maxTof) {
    if (!start || !(exitSpeed > 0) || !(maxTof > 2)) return null;
    const tMin = 1;
    const tMax = Math.max(tMin * 2, Math.min(maxTof, 45 * DAY));
    let best = null;
    for (const prograde of [true, false]) {
      let previous = null;
      const brackets = [];
      const N = 44;
      for (let i = 0; i <= N; i++) {
        const t = tMin * Math.pow(tMax / tMin, i / N);
        const L = A.lambert(start.r, exitR, t, mu, prograde);
        if (!L) continue;
        const f = V.mag(L.v2) - exitSpeed;
        if (previous && f * previous.f <= 0)
          brackets.push({ lo: previous.t, hi: t, flo: previous.f });
        previous = { t, f };
      }
      for (const bracket of brackets) {
        let lo = bracket.lo, hi = bracket.hi, flo = bracket.flo, L = null;
        for (let i = 0; i < 42; i++) {
          const mid = 0.5 * (lo + hi);
          L = A.lambert(start.r, exitR, mid, mu, prograde);
          if (!L) { hi = mid; continue; }
          const f = V.mag(L.v2) - exitSpeed;
          if (f * flo <= 0) hi = mid;
          else { lo = mid; flo = f; }
        }
        const tof = 0.5 * (lo + hi);
        L = A.lambert(start.r, exitR, tof, mu, prograde);
        if (!L || !(V.dot(L.v2, exitR) > 0)) continue;
        const dv = V.sub(L.v1, start.v);
        const mag = V.mag(dv);
        if (!best || mag < best.mag) best = { tof, L, dv, mag, prograde };
      }
    }
    return best;
  }

  /* Pick the parking-orbit ignition point cheaply.  A hyperbolic leg spends
   * most of its coast near v-infinity, so R_SOI/v-infinity is an effective
   * Lambert time estimate for ranking burn points; the exact time is solved
   * only for the selected point above. */
  function departureIgnitionPlan(start, exitR, exitSpeed, body, maxWait) {
    const coe = A.rvToCoe(start.r, start.v, body.mu);
    if (!(coe.e < 1) || !(coe.a > 0) || !isFinite(coe.a))
      return { wait: 0, state: { r: V.clone(start.r), v: V.clone(start.v) } };
    const period = 2 * Math.PI * Math.sqrt((coe.a * coe.a * coe.a) / body.mu);
    const window = Math.min(period, Math.max(0, maxWait));
    if (!(window > 1))
      return { wait: 0, state: { r: V.clone(start.r), v: V.clone(start.v) } };
    const rExit = V.mag(exitR);
    const vInf = Math.sqrt(Math.max(1e-8,
      exitSpeed * exitSpeed - (2 * body.mu) / rExit));
    const tofGuess = Math.min(45 * DAY, Math.max(60, rExit / vInf));
    const scoreAt = (wait) => {
      const st = A.propagateUniversal(start.r, start.v, wait, body.mu);
      let score = Infinity;
      for (const prograde of [true, false]) {
        const L = A.lambert(st.r, exitR, tofGuess, body.mu, prograde);
        if (!L || !(V.dot(L.v2, exitR) > 0)) continue;
        score = Math.min(score, V.mag(V.sub(L.v1, st.v)));
      }
      return { score, state: st };
    };
    const N = 72;
    let bestWait = 0, best = scoreAt(0);
    for (let i = 1; i <= N; i++) {
      const wait = window * i / N;
      const trial = scoreAt(wait);
      if (trial.score < best.score) { best = trial; bestWait = wait; }
    }
    let lo = Math.max(0, bestWait - window / N);
    let hi = Math.min(window, bestWait + window / N);
    for (let i = 0; i < 14; i++) {
      const m1 = lo + (hi - lo) * 0.382;
      const m2 = lo + (hi - lo) * 0.618;
      if (scoreAt(m1).score < scoreAt(m2).score) hi = m2; else lo = m1;
    }
    bestWait = 0.5 * (lo + hi);
    return { wait: bestWait,
      state: A.propagateUniversal(start.r, start.v, bestWait, body.mu) };
  }

  function solveLinear3(matrix, rhs) {
    const a = matrix.map((row, i) => row.slice().concat(rhs[i]));
    for (let col = 0; col < 3; col++) {
      let pivot = col;
      for (let row = col + 1; row < 3; row++)
        if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
      if (Math.abs(a[pivot][col]) < 1e-12) return null;
      if (pivot !== col) [a[pivot], a[col]] = [a[col], a[pivot]];
      const scale = a[col][col];
      for (let j = col; j < 4; j++) a[col][j] /= scale;
      for (let row = 0; row < 3; row++) {
        if (row === col) continue;
        const factor = a[row][col];
        for (let j = col; j < 4; j++) a[row][j] -= factor * a[col][j];
      }
    }
    return [a[0][3], a[1][3], a[2][3]];
  }

  /* Couple the local two-body escape to the dated parent-frame Lambert leg.
   * The three free boundary variables are SOI direction (two angles) and
   * boundary speed.  Fixed-point updates make the propagated local exit
   * velocity agree with the parent Lambert velocity without a position jump
   * or a fictitious large patch maneuver. */
  function continuousDeparturePlan(ctx, start, parentId, arrivalT, aim,
    seedExitV, exitRadius, parentPrograde) {
    const body = BODIES[start.cen];
    const parent = BODIES[parentId];
    if (!body || !parent || !(arrivalT > start.t + 2)) return null;
    let direction = V.norm(seedExitV);
    let speed = V.mag(seedExitV);
    let ignition = null, local = null, parentLeg = null, exitR = null;
    const converge = (iterations) => {
      for (let i = 0; i < iterations; i++) {
        exitR = V.scale(direction, exitRadius);
        if (!ignition) ignition = departureIgnitionPlan(start, exitR, speed,
          body, Math.min(arrivalT - start.t - 2, 2.5 * DAY));
        const maxLocal = arrivalT - (start.t + ignition.wait) - 1;
        local = solveLocalDepartureLeg(ignition.state, exitR, speed, body.mu, maxLocal);
        if (!local) return false;
        const exitT = start.t + ignition.wait + local.tof;
        const remaining = arrivalT - exitT;
        if (!(remaining > 1)) return false;
        const bodyState = relBodyState(start.cen, parentId, jdAt(ctx, exitT));
        const parentR = V.add(bodyState.r, exitR);
        parentLeg = A.lambert(parentR, aim, remaining, parent.mu,
          parentPrograde !== false);
        if (!parentLeg) return false;
        const requiredLocalV = V.sub(parentLeg.v1, bodyState.v);
        const mismatch = V.mag(V.sub(local.L.v2, requiredLocalV));
        if (mismatch < 1e-7) return true;
        direction = V.norm(V.add(direction,
          V.sub(V.norm(requiredLocalV), V.norm(local.L.v2))));
        speed = V.mag(requiredLocalV);
      }
      return true;
    };
    if (!converge(7)) return null;
    // Re-rank the ignition point once in the converged departure plane, then
    // close the small boundary residual again with that fixed burn epoch.
    ignition = departureIgnitionPlan(start, V.scale(direction, exitRadius), speed,
      body, Math.min(arrivalT - start.t - 2, 2.5 * DAY));
    if (!converge(7) || !local || !parentLeg) return null;

    // Fixed-point direction updates are sufficient for ordinary planetary
    // departures, but some lunar-return geometries converge slowly. Finish
    // the three boundary-velocity components with a damped numerical Newton
    // solve while keeping the selected ignition epoch fixed.
    const evaluateBoundary = (boundaryV) => {
      const boundarySpeed = V.mag(boundaryV);
      if (!(boundarySpeed > 0)) return null;
      const boundaryR = V.scale(V.norm(boundaryV), exitRadius);
      const maxLocal = arrivalT - (start.t + ignition.wait) - 1;
      const localLeg = solveLocalDepartureLeg(ignition.state, boundaryR,
        boundarySpeed, body.mu, maxLocal);
      if (!localLeg) return null;
      const boundaryT = start.t + ignition.wait + localLeg.tof;
      const remaining = arrivalT - boundaryT;
      if (!(remaining > 1)) return null;
      const bodyState = relBodyState(start.cen, parentId, jdAt(ctx, boundaryT));
      const parentR = V.add(bodyState.r, boundaryR);
      const parentSolution = A.lambert(parentR, aim, remaining, parent.mu,
        parentPrograde !== false);
      if (!parentSolution) return null;
      const required = V.sub(parentSolution.v1, bodyState.v);
      const residualV = V.sub(localLeg.L.v2, required);
      return { boundaryR, boundaryT, localLeg, parentSolution, residualV,
        residual: V.mag(residualV) };
    };
    let boundaryV = V.scale(direction, speed);
    let solvedBoundary = evaluateBoundary(boundaryV);
    for (let iteration = 0; solvedBoundary &&
      solvedBoundary.residual > 1e-7 && iteration < 6; iteration++) {
      const h = Math.max(1e-6, V.mag(boundaryV) * 2e-5);
      const jacobian = [[], [], []];
      let valid = true;
      for (let column = 0; column < 3; column++) {
        const perturbed = V.clone(boundaryV);
        perturbed[column] += h;
        const trial = evaluateBoundary(perturbed);
        if (!trial) { valid = false; break; }
        for (let row = 0; row < 3; row++)
          jacobian[row][column] =
            (trial.residualV[row] - solvedBoundary.residualV[row]) / h;
      }
      if (!valid) break;
      const delta = solveLinear3(jacobian, V.scale(solvedBoundary.residualV, -1));
      if (!delta) break;
      let improved = null, improvedV = null;
      for (const damping of [1, 0.5, 0.25, 0.125, 0.0625]) {
        const candidateV = V.add(boundaryV, V.scale(delta, damping));
        const candidate = evaluateBoundary(candidateV);
        if (candidate && candidate.residual < solvedBoundary.residual) {
          improved = candidate;
          improvedV = candidateV;
          break;
        }
      }
      if (!improved) break;
      boundaryV = improvedV;
      solvedBoundary = improved;
    }
    if (solvedBoundary) {
      exitR = solvedBoundary.boundaryR;
      local = solvedBoundary.localLeg;
      parentLeg = solvedBoundary.parentSolution;
      direction = V.norm(boundaryV);
      speed = V.mag(boundaryV);
    }
    const exitT = start.t + ignition.wait + local.tof;
    const bodyState = relBodyState(start.cen, parentId, jdAt(ctx, exitT));
    const requiredLocalV = V.sub(parentLeg.v1, bodyState.v);
    return {
      wait: ignition.wait,
      burnState: ignition.state,
      local,
      exitR,
      exitT,
      aim: V.clone(aim),
      parentPrograde: parentPrograde !== false,
      parentLeg,
      residual: V.mag(V.sub(local.L.v2, requiredLocalV)),
    };
  }

  /* Vector-consistent child-to-parent return (for example Moon to Earth).
   * A real local hyperbola is propagated to the child's SOI, its boundary
   * velocity is matched to the parent Lambert leg, and the dated parent
   * arrival is constrained to be tangent at the requested periapsis. */
  function executeContinuousChildReturn(seg, ctx, segIdx, target, tof, rpTarget) {
    const start = ctx.state;
    const child = BODIES[start.cen];
    const parent = target;
    const arrivalT = start.t + tof;
    if (!child || child.parent !== parent.id || !isFinite(child.soi)) return false;

    const seedBodyState = relBodyState(child.id, parent.id, jdAt(ctx, start.t));
    const seedParentR = V.add(seedBodyState.r, start.r);
    const seedParentV = V.add(seedBodyState.v, start.v);
    const seed = Targeting.solveLambertToPeriapsis({
      r1: seedParentR,
      vCurrent: seedParentV,
      tof,
      mu: parent.mu,
      rpTarget,
    }).best;
    if (!seed) {
      warn(seg, "No tangent parent-frame return solution was found.", "error");
      return true;
    }
    let seedExitV = V.sub(seed.v1, seedBodyState.v);
    if (!(V.mag(seedExitV) ** 2 - (2 * child.mu) / child.soi > 0)) {
      warn(seg, "The requested return does not provide a hyperbolic SOI exit.", "error");
      return true;
    }

    let plan = continuousDeparturePlan(ctx, start, parent.id, arrivalT,
      seed.r2, seedExitV, child.soi, seed.prograde);
    if (!plan) {
      warn(seg, "Could not couple the local escape to the parent return leg.", "error");
      return true;
    }

    // Re-solve the tangent endpoint from the planned SOI epoch, then close
    // the local/parent boundary against that exact branch once more.
    const plannedBodyState = relBodyState(child.id, parent.id,
      jdAt(ctx, plan.exitT));
    const plannedParentR = V.add(plannedBodyState.r, plan.exitR);
    const plannedTarget = Targeting.solveLambertToPeriapsis({
      r1: plannedParentR,
      vCurrent: plan.parentLeg.v1,
      tof: arrivalT - plan.exitT,
      mu: parent.mu,
      rpTarget,
    }).best;
    if (plannedTarget) {
      seedExitV = V.sub(plannedTarget.v1, plannedBodyState.v);
      const refined = continuousDeparturePlan(ctx, start, parent.id, arrivalT,
        plannedTarget.r2, seedExitV, child.soi, plannedTarget.prograde);
      if (refined) plan = refined;
    }
    for (let correction = 0; correction < 4; correction++) {
      const bodyAtExit = relBodyState(child.id, parent.id, jdAt(ctx, plan.exitT));
      const parentAtExit = V.add(bodyAtExit.r, plan.exitR);
      const tangent = Targeting.solveLambertToPeriapsis({
        r1: parentAtExit,
        vCurrent: plan.parentLeg.v1,
        tof: arrivalT - plan.exitT,
        mu: parent.mu,
        rpTarget,
      }).best;
      if (!tangent) break;
      const nextSeedV = V.sub(tangent.v1, bodyAtExit.v);
      const next = continuousDeparturePlan(ctx, start, parent.id, arrivalT,
        tangent.r2, nextSeedV, child.soi, tangent.prograde);
      if (!next) break;
      plan = next;
      if (plan.residual < 1e-7) break;
    }

    if (plan.wait > 1) {
      const waited = propagateArc(ctx, plan.wait, { segIdx, mode: "kepler" });
      seg._info.waitS = plan.wait;
      if (waited.reason !== "time") {
        warn(seg, "Parking-orbit wait was interrupted before return injection.", "error");
        return true;
      }
    }

    const burnDv = V.sub(plan.local.L.v1, ctx.state.v);
    const burnMag = V.mag(burnDv);
    const radius = V.mag(ctx.state.r);
    const postSpeed = V.mag(plan.local.L.v1);
    const c3 = postSpeed * postSpeed - (2 * child.mu) / radius;
    const vInf = Math.sqrt(Math.max(0, c3));
    const departureEvent = applyDv(ctx, segIdx, burnDv,
      `Trans-${parent.name} injection - delta-v ${burnMag.toFixed(3)} km/s ` +
      `(v-infinity ${vInf.toFixed(2)} km/s, periapsis target ` +
      `${(+seg.periKm || 40).toFixed(0)} km)`,
      { target: parent.id });
    departureEvent._burn.handoff = true;
    departureEvent._burn.continuousSoi = true;
    departureEvent._burn.exitR = V.clone(plan.exitR);
    departureEvent._burn.exitV = V.clone(plan.local.L.v2);
    departureEvent._burn.exitT = departureEvent.t + plan.local.tof;

    seg._info.dv = burnMag;
    seg._info.vInf = vInf;
    seg._info.c3 = c3;
    seg._info.escapeCoastS = plan.local.tof;
    addEvent(ctx, segIdx, "note",
      `Continuous patched-conic escape from ${child.name}: local SOI coast ` +
      `${(plan.local.tof / DAY).toFixed(2)} d; return arrival epoch retained.`);

    const escaped = propagateArc(ctx, Math.max(plan.local.tof * 1.02,
      plan.local.tof + 60),
    { segIdx, mode: "kepler", stop: { type: "soi_of", target: parent.id } });
    if (escaped.reason !== "soi_of" || ctx.state.cen !== parent.id) {
      warn(seg, `Did not exit ${child.name}'s SOI on the solved return hyperbola.`, "error");
      return true;
    }

    const finalSolution = Targeting.solveLambertToPeriapsis({
      r1: ctx.state.r,
      vCurrent: ctx.state.v,
      tof: arrivalT - ctx.state.t,
      mu: parent.mu,
      rpTarget,
    });
    const sameBranch = finalSolution.candidates.filter((candidate) =>
      candidate.prograde === plan.parentPrograde);
    sameBranch.sort((a, b) =>
      V.mag(V.sub(a.r2, plan.aim)) - V.mag(V.sub(b.r2, plan.aim)));
    const finalTarget = sameBranch[0] || finalSolution.best;
    if (!finalTarget) {
      warn(seg, "The tangent return solution was lost at the SOI boundary.", "error");
      return true;
    }
    const patchDv = V.sub(finalTarget.v1, ctx.state.v);
    const patchMag = V.mag(patchDv);
    seg._info.patchDv = patchMag;
    if (patchMag > 1e-10) {
      const patchEvent = applyDv(ctx, segIdx, patchDv,
        `${child.name} SOI return patch - delta-v ${patchMag.toFixed(6)} km/s`,
        { target: parent.id });
      patchEvent.patchCorrection = true;
      seg._info.dv += patchMag;
    }
    seg._info.rpTargeted = finalTarget.rpAchieved;
    seg._info.arrivalRadialSpeed = finalTarget.radialSpeed;

    // Preserve the historical correction-point epoch used by the following
    // Return segment; the local coast consumes part of this interval.
    const correctionEpoch = start.t + tof * 0.4;
    if (ctx.state.t < correctionEpoch - 1e-6)
      propagateArc(ctx, correctionEpoch - ctx.state.t,
        { segIdx, mode: "kepler" });
    seg._targetBody = parent.id;
    return true;
  }

  /* ======================== CR3BP embedding =========================== *
   * Dynamics live in canonical barycentric synodic coordinates. Rendering
   * and the rest of the Planner use inertial world kilometres, so every
   * sample is embedded through the actual primary-secondary ephemeris at its
   * own epoch. The dynamics remain the reviewed circular model; the actual
   * ephemeris supplies only origin, orientation, and display scale. */
  const librationCache = new Map();

  function cr3bpBasis(system, jd) {
    const rp = A.bodyWorld(system.primaryId, jd);
    const rs = A.bodyWorld(system.secondaryId, jd);
    const vp = A.bodyWorldVel(system.primaryId, jd);
    const vs = A.bodyWorldVel(system.secondaryId, jd);
    const relR = V.sub(rs, rp), relV = V.sub(vs, vp);
    const separationKm = V.mag(relR);
    const xAxis = V.scale(relR, 1 / separationKm);
    let zAxis = V.norm(V.cross(relR, relV));
    if (V.mag(zAxis) < 1e-10) {
      const fallback = Math.abs(xAxis[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
      zAxis = V.norm(V.cross(xAxis, fallback));
    }
    const yAxis = V.norm(V.cross(zAxis, xAxis));
    zAxis = V.norm(V.cross(xAxis, yAxis));
    const primaryWeight = system.primaryGM / system.totalGM;
    const secondaryWeight = system.secondaryGM / system.totalGM;
    const origin = V.add(V.scale(rp, primaryWeight), V.scale(rs, secondaryWeight));
    const originV = V.add(V.scale(vp, primaryWeight), V.scale(vs, secondaryWeight));
    const omega = V.scale(V.cross(relR, relV), 1 / (separationKm * separationKm));
    const separationRate = V.dot(relR, relV) / separationKm;
    return { rp, vp, origin, originV, xAxis, yAxis, zAxis, omega,
      separationKm, separationRate };
  }

  function axesVector(basis, q) {
    return V.add(V.scale(basis.xAxis, q[0]),
      V.add(V.scale(basis.yAxis, q[1]), V.scale(basis.zAxis, q[2])));
  }

  function cr3bpEmbeddedState(system, canonicalState, jd) {
    const basis = cr3bpBasis(system, jd);
    const q = canonicalState.slice(0, 3), qdot = canonicalState.slice(3, 6);
    const direction = axesVector(basis, q);
    const offset = V.scale(direction, basis.separationKm);
    const shapeVelocity = V.scale(axesVector(basis, qdot),
      basis.separationKm / system.timeUnitS);
    const scaleVelocity = V.scale(direction, basis.separationRate);
    const worldV = V.add(basis.originV,
      V.add(shapeVelocity, V.add(scaleVelocity, V.cross(basis.omega, offset))));
    const w = V.add(basis.origin, offset);
    return {
      w,
      worldV,
      r: V.sub(w, basis.rp),
      v: V.sub(worldV, basis.vp),
    };
  }

  function setCr3bpState(ctx, system, canonicalState, t) {
    const embedded = cr3bpEmbeddedState(system, canonicalState,
      ctx.epochJD + t / DAY);
    ctx.state = {
      cen: system.primaryId,
      r: embedded.r,
      v: embedded.v,
      w: embedded.w,
      t,
      landed: false,
      cr3bp: true,
      cr3bpSystem: system.id,
      synodic: canonicalState.slice(),
    };
    return ctx.state;
  }

  function cachedLibrationOrbit(seg) {
    const system = R3.getSystem(seg.system || "earth-moon");
    const point = String(seg.point || "L2").toUpperCase();
    const family = String(seg.family || "halo").toLowerCase();
    const size = String(seg.size || "small").toLowerCase();
    const hemisphere = String(seg.hemisphere || "north").toLowerCase();
    const key = [system.id, point, family, size, hemisphere].join("|");
    if (librationCache.has(key)) return librationCache.get(key);
    let orbit;
    if (family === "halo")
      orbit = LIB.generateHalo(system, point, { size, hemisphere, sampleCount: 241 });
    else if (family === "planar-lyapunov")
      orbit = LIB.generatePlanarLyapunov(system, point, { size, sampleCount: 241 });
    else if (family === "lissajous")
      orbit = LIB.generateLissajousSeed(system, point, { size, sampleCount: 721 });
    else throw new RangeError(`Unknown libration family '${seg.family}'.`);
    librationCache.set(key, orbit);
    return orbit;
  }

  function cr3bpPeriodFor(orbit) {
    if (orbit.period > 0) return orbit.period;
    return LIB.linearModes(orbit.system, orbit.point).planarPeriod;
  }

  function propagateCr3bpSamples(ctx, segIdx, durationCanonical, tolerance) {
    const system = ctx.cr3bpSystem;
    const startCanonical = ctx.cr3bpTime;
    const endCanonical = startCanonical + durationCanonical;
    const count = Math.max(81, Math.min(1801,
      Math.ceil(durationCanonical / Math.max(ctx.cr3bpPeriod / 240, 1e-4)) + 1));
    const outputTimes = Array.from({ length: count }, (_, index) =>
      startCanonical + durationCanonical * index / (count - 1));
    const high = tolerance !== "standard";
    const integrated = ODE.integrate((time, state) => R3.derivatives(system, state),
      startCanonical, ctx.state.synodic, endCanonical, {
        rtol: high ? 2e-11 : 2e-9,
        atol: high ? 2e-13 : 2e-11,
        maxStep: Math.min(0.02, durationCanonical / 120),
        maxSteps: 250000,
        maxEvaluations: 2000000,
        outputTimes,
      });
    const startT = ctx.state.t;
    for (let index = 1; index < integrated.t.length; index++) {
      const elapsed = (integrated.t[index] - startCanonical) * system.timeUnitS;
      setCr3bpState(ctx, system, integrated.y[index], startT + elapsed);
      pushSample(ctx, segIdx, "cr3bp");
    }
    ctx.cr3bpTime = endCanonical;
    ctx.cr3bpReferenceState = ctx.cr3bpOrbit && ctx.cr3bpOrbit.periodicClaim === true
      ? LIB.referenceStateAt(ctx.cr3bpOrbit, endCanonical, true)
      : ODE.integrate(
        (time, state) => R3.derivatives(system, state), startCanonical,
        ctx.cr3bpReferenceState, endCanonical, {
          rtol: 2e-11, atol: 2e-13, maxStep: Math.min(0.02, durationCanonical / 120),
          maxSteps: 250000, maxEvaluations: 2000000, outputTimes: [endCanonical],
        }).yFinal;
    return integrated;
  }

  /* ================== adaptive inertial force models ================== */
  function automaticForceBodies(centralId, nbody) {
    if (!nbody) return [centralId];
    const ids = new Set(["sun", centralId]);
    let current = BODIES[centralId];
    while (current && current.parent) {
      ids.add(current.parent);
      current = BODIES[current.parent];
    }
    if (centralId === "sun") {
      for (const body of Object.values(BODIES))
        if (body.parent === "sun" && body.type === "planet") ids.add(body.id);
    } else {
      for (const child of childrenOf(centralId))
        if (child.mu > 0) ids.add(child.id);
    }
    return Array.from(ids);
  }

  function resolveForceEphemeris(value) {
    if (value === undefined || value === null || value === "" || value === "catalog") {
      return { provider: null, fallback: "catalog", key: "catalog" };
    }
    if (value === true || value === "planner-horizons" || value === "horizons") {
      const provider = globalThis.MTPPlannerEphemeris;
      if (!provider)
        throw new Error("The generated Planner Horizons ephemeris is not loaded.");
      return { provider, fallback: "strict", key: "planner-horizons" };
    }
    if (value && typeof value === "object" && typeof value.stateAt === "function") {
      return { provider: value, fallback: "strict", key: "custom" };
    }
    if (value && typeof value === "object" && value.provider) {
      return {
        provider: value.provider,
        fallback: value.fallback || "strict",
        key: value.key || "custom",
      };
    }
    throw new Error(`Unknown adaptive ephemeris '${value}'.`);
  }

  function forceBodyState(bodyId, jd, ephemeris) {
    if (ephemeris && ephemeris.provider) {
      return FORCE.bodyStateAt(bodyId, jd, {
        provider: ephemeris.provider,
        fallback: ephemeris.fallback,
      });
    }
    return {
      r: A.bodyWorld(bodyId, jd),
      v: A.bodyWorldVel(bodyId, jd),
    };
  }

  function setForceState(ctx, centralId, sample, model, ephemeris) {
    const jd = ctx.epochJD + sample.t / DAY;
    const center = forceBodyState(centralId, jd, ephemeris);
    const displayCenterR = A.bodyWorld(centralId, jd);
    const displayCenterV = A.bodyWorldVel(centralId, jd);
    const localR = V.sub(sample.r, center.r);
    const localV = V.sub(sample.v, center.v);
    const massKg = Number.isFinite(sample.massKg) ? sample.massKg
      : (Number.isFinite(ctx.massKg) ? ctx.massKg : null);
    ctx.state = {
      cen: centralId,
      r: localR,
      v: localV,
      w: V.add(displayCenterR, localR),
      worldV: V.add(displayCenterV, localV),
      forceW: V.clone(sample.r),
      forceWorldV: V.clone(sample.v),
      t: sample.t,
      landed: false,
      massKg,
      forceModel: model,
      forceEphemeris: ephemeris ? ephemeris.key : "catalog",
    };
    return ctx.state;
  }

  function spacecraftMass(ctx, override) {
    if (+override > 0) return +override;
    if (ctx.massKg > 0) return ctx.massKg;
    const sc = ctx.mission && ctx.mission.spacecraft || {};
    const dry = Math.max(0, +sc.dryKg || 0);
    const prop = Math.max(0, +sc.propKg || 0);
    return dry + prop;
  }

  // A central-relative force model still integrates in the shared inertial
  // coordinates used by the renderer. Add the catalog center's translational
  // acceleration as a uniform indirect term; subtracting that center then
  // recovers exactly the intended local two-body + thrust equations instead
  // of leaving the spacecraft behind while the body curves around its parent.
  function forceBodyAcceleration(bodyId, jd, ephemeris) {
    if (bodyId === "sun") return [0, 0, 0];
    const halfWindowS = 30;
    const before = forceBodyState(bodyId, jd - halfWindowS / DAY, ephemeris).v;
    const after = forceBodyState(bodyId, jd + halfWindowS / DAY, ephemeris).v;
    return V.scale(V.sub(after, before), 1 / (2 * halfWindowS));
  }

  function coastEnvironment(seg, ctx) {
    if (seg.environment && typeof seg.environment === "object")
      return seg.environment;
    const environment = {};
    const massKg = spacecraftMass(ctx, seg.massKg);
    const areaM2 = +seg.areaM2 > 0 ? +seg.areaM2 : 10;
    if (seg.drag === "on" || seg.drag === true) {
      environment.drag = {
        body: "earth",
        cd: Number.isFinite(+seg.cd) ? +seg.cd : 2.2,
        areaM2,
        massKg,
        densityScale: Number.isFinite(+seg.densityScale) ? +seg.densityScale : 1,
      };
    }
    if (seg.srp === "on" || seg.srp === true) {
      environment.srp = {
        source: "sun",
        occultingBodies: ctx.state && ctx.state.cen === "earth"
          ? ["earth", "moon"] : [ctx.state.cen],
        cr: Number.isFinite(+seg.cr) ? +seg.cr : 1.3,
        areaM2,
        massKg,
        eclipse: true,
      };
    }
    const harmonic = String(seg.harmonics || "off").toLowerCase();
    if (harmonic !== "off") {
      const degree = harmonic === "j4" ? 4 : harmonic === "j3" ? 3 : 2;
      environment.harmonics = { body: "earth", degree };
    }
    return Object.keys(environment).length ? environment : null;
  }

  function propagateForceArc(ctx, durationS, segIdx, options) {
    const opts = options || {};
    const start = ctx.state;
    const centralId = start.cen;
    const jd = jdAt(ctx, start.t);
    const ephemeris = resolveForceEphemeris(opts.ephemerisProvider || opts.ephemeris);
    const center = forceBodyState(centralId, jd, ephemeris);
    const sameEphemeris = start.forceEphemeris
      ? start.forceEphemeris === ephemeris.key
      : ephemeris.key === "catalog";
    const worldR = start.forceW && sameEphemeris ? V.clone(start.forceW)
      : V.add(center.r, start.r);
    const worldV = start.forceWorldV && sameEphemeris ? V.clone(start.forceWorldV)
      : V.add(center.v, start.v);
    const centralRelative = opts.gravity === "central-only" ||
      opts.gravity === "central-relative";
    const nbody = !centralRelative;
    const bodies = automaticForceBodies(centralId, nbody);
    const localCoe = A.rvToCoe(start.r, start.v, BODIES[centralId].mu);
    const localPeriodS = localCoe.e < 1 && localCoe.a > 0 && isFinite(localCoe.a)
      ? 2 * Math.PI * Math.sqrt(localCoe.a ** 3 / BODIES[centralId].mu) : null;
    const localDynamicalPeriodS = 2 * Math.PI * Math.sqrt(
      V.mag(start.r) ** 3 / BODIES[centralId].mu);
    const samplingPeriodS = localPeriodS || localDynamicalPeriodS;
    // Dense output does not control the adaptive integrator's physics error.
    // Long finite burns previously stored 64 points per initial revolution
    // for their entire duration even after the orbit period had grown by an
    // order of magnitude. 32 points per initial revolution remains visually
    // smooth (the renderer refines curved spans) while avoiding thousands of
    // redundant state/frame conversions in electric-raise missions.
    const outputSamplesPerPeriod = opts.thrust ? 32 : 64;
    const outputStep = Math.max(1, Math.min(durationS / 180,
      samplingPeriodS / outputSamplesPerPeriod));
    const estimatedOutputPoints = Math.ceil(durationS / outputStep) + 1;
    if (estimatedOutputPoints > 5000) {
      throw new Error("Adaptive propagation spans too many local revolutions for a " +
        "faithful bounded trajectory. Split the coast, or use Kepler/J2 for long bound arcs.");
    }
    const config = {
      epochJD: ctx.epochJD,
      t0S: start.t,
      t1S: start.t + durationS,
      r0: worldR,
      v0: worldV,
      bodies,
      collisionBodies: [centralId],
      outputStep,
      // Finite-thrust direction laws are re-evaluated continuously and can
      // force thousands of sub-second-equivalent accepted steps over a
      // multi-day burn at the coast solver's tighter tolerance. The reviewed
      // standard burn tolerance remains well below display/mission accuracy
      // while avoiding intermittent main-thread stalls; callers can still
      // request tighter values explicitly for validation work.
      rtol: opts.rtol || (opts.thrust ? 1e-9 : 2e-10),
      atol: opts.atol || (opts.thrust ? 1e-11 : 2e-12),
      maxStep: Math.min(durationS / 40,
        centralId === "sun" ? 0.5 * DAY : 900),
      maxSteps: 300000,
      maxRejectedSteps: 100000,
      maxEvaluations: 2500000,
      maxOutputPoints: 5000,
    };
    if (ephemeris.provider) {
      config.ephemerisProvider = {
        provider: ephemeris.provider,
        fallback: ephemeris.fallback,
      };
    }
    if (opts.environment) config.environment = opts.environment;
    if (centralRelative)
      config.extraAccelerations = (snapshot) =>
        forceBodyAcceleration(centralId, snapshot.jd, ephemeris);
    if (+opts.massKg > 0) config.massKg = +opts.massKg;
    if (opts.thrust) {
      config.thrust = opts.thrust;
    }
    const result = opts.thrust
      ? FORCE.propagateFiniteThrust(config)
      : FORCE.propagateInertial(config);
    const forceModel = opts.thrust
      ? (centralRelative ? "finite-thrust-central-relative" : "finite-thrust-nbody")
      : (opts.environment ? "adaptive-environment"
        : (centralRelative ? "adaptive-central-relative" : "adaptive-nbody"));
    if (result.samples.length) {
      setForceState(ctx, centralId, result.samples[0], forceModel, ephemeris);
      pushSample(ctx, segIdx, opts.thrust ? "finite-thrust" : "nbody");
    }
    for (let index = 1; index < result.samples.length; index++) {
      setForceState(ctx, centralId, result.samples[index], forceModel, ephemeris);
      pushSample(ctx, segIdx, opts.thrust ? "finite-thrust" : "nbody");
    }
    if (result.status === "event") {
      const collision = result.events.find((event) => event.name.startsWith("collision:"));
      if (collision) {
        ctx.crashed = true;
        addEvent(ctx, segIdx, "impact", `Impact — ${BODIES[centralId].name}`,
          { body: centralId });
      }
    }
    return result;
  }

  /* First-order Earth J2 propagation in mean classical elements. This model
   * deliberately remains separate from patched-conic SOI switching: it is a
   * bound Earth-orbit analysis mode, not a general escape propagator. */
  function j2MeanElements(r, v, body) {
    const coe = A.rvToCoe(r, v, body.mu);
    if (!(Number.isFinite(coe.a) && coe.a > 0 && coe.e < 1))
      throw new Error("J2 secular propagation requires a bound elliptic Earth orbit.");
    const eccentricAnomaly = 2 * Math.atan2(
      Math.sqrt(Math.max(0, 1 - coe.e)) * Math.sin(coe.nu / 2),
      Math.sqrt(1 + coe.e) * Math.cos(coe.nu / 2));
    return {
      a: coe.a, e: coe.e, i: coe.i, Om: coe.Om, w: coe.w,
      M: eccentricAnomaly - coe.e * Math.sin(eccentricAnomaly),
    };
  }

  function j2StateFromElements(elements, dtS, body) {
    const evolved = ANALYSIS.applyJ2Secular(elements, dtS);
    const E = A.solveKeplerE(evolved.M, evolved.e);
    const nu = A.trueFromEccAnomaly(E, evolved.e);
    return A.coeToRV({ ...evolved, nu }, body.mu);
  }

  function propagateJ2State(r, v, dtS, body) {
    return j2StateFromElements(j2MeanElements(r, v, body), dtS, body);
  }

  function propagateJ2Arc(ctx, durationS, segIdx) {
    const start = ctx.state;
    if (start.cen !== "earth")
      throw new Error("J2 secular propagation is currently Earth-centered only.");
    const body = BODIES.earth;
    const elements = j2MeanElements(start.r, start.v, body);
    const rates = ANALYSIS.j2SecularRates(elements);
    const periodS = 2 * Math.PI * Math.sqrt(elements.a ** 3 / body.mu);
    const intervals = Math.max(30, Math.min(720,
      Math.ceil(durationS / periodS * 120)));
    const startT = start.t;
    pushSample(ctx, segIdx);

    for (let index = 1; index <= intervals; index++) {
      const dt = durationS * index / intervals;
      const state = j2StateFromElements(elements, dt, body);
      ctx.state = {
        cen: "earth", r: state.r, v: state.v,
        t: startT + dt, landed: false,
      };
      pushSample(ctx, segIdx, "j2");
      if (V.mag(state.r) <= body.radius) {
        addEvent(ctx, segIdx, "impact", "IMPACT - Earth surface", { body: "earth" });
        ctx.crashed = true;
        return { reason: "crash", rates, periodS, intervals: index };
      }
    }
    return { reason: "time", rates, periodS, intervals };
  }

  /* ===================== per-type segment executors ===================== */
  function requireState(ctx, seg) {
    if (!ctx.state) { warn(seg, "No spacecraft state — add a Launch segment first.", "error"); return false; }
    return true;
  }
  function requireFlying(ctx, seg) {
    if (!requireState(ctx, seg)) return false;
    if (ctx.state.cr3bp) {
      warn(seg, "This patched-conic segment cannot follow a CR3BP state; use CR3BP Coast or Stationkeeping.", "error");
      return false;
    }
    if (ctx.state.landed) { warn(seg, "Spacecraft is landed — add an Ascend segment first.", "error"); return false; }
    return true;
  }

  /* Launch ascent is still outside this patched-conic engine's dynamics.
   * These helpers make that instantaneous approximation visible without
   * inventing an aerodynamic solution: a one-second, non-Kepler bridge starts
   * at the selected rotating pad and ends at the solved MECO state. Keeping
   * the bridge this short preserves the date-pinned historical timelines. */
  const LAUNCH_VISUAL_SECONDS = 1;
  const LAUNCH_VISUAL_STEPS = 20;

  function bodyAxialFrame(body) {
    const tilt = (body.tiltDeg || 0) * C.DEG;
    const axis = [Math.sin(tilt), 0, Math.cos(tilt)];
    let e1 = [axis[2], 0, -axis[0]];
    e1 = V.norm(e1);
    return { axis, e1, e2: V.cross(axis, e1) };
  }

  function axialToWorld(q, frame) {
    return V.add(V.add(V.scale(frame.e1, q[0]), V.scale(frame.e2, q[1])),
      V.scale(frame.axis, q[2]));
  }

  function worldToAxial(q, frame) {
    return [V.dot(q, frame.e1), V.dot(q, frame.e2), V.dot(q, frame.axis)];
  }

  function rotatingSurfaceVelocity(body, jd, r) {
    if (!body.rotHours) return [0, 0, 0];
    const halfSpanS = 30;
    const before = A.bodyFrameAt(body, jd - halfSpanS / DAY);
    const after = A.bodyFrameAt(body, jd + halfSpanS / DAY);
    const current = A.bodyFrameAt(body, jd);
    if (!before || !after || !current) return [0, 0, 0];
    // For an orthonormal rotating triad, omega = 1/2 sum(e_i x de_i/dt).
    // Deriving it from bodyFrameAt keeps launch pads, textures, ground tracks,
    // atmosphere rotation, and IAU/legacy body conventions on one sign.
    let omega = [0, 0, 0];
    for (const axis of ["x", "y", "z"]) {
      const derivative = V.scale(V.sub(after[axis], before[axis]), 1 / (2 * halfSpanS));
      omega = V.add(omega, V.cross(current[axis], derivative));
    }
    return V.cross(V.scale(omega, 0.5), r);
  }

  function launchSiteGeometry(body, site, jd) {
    if (body.id !== "earth" || !site.id || !Number.isFinite(site.latDeg) ||
        !Number.isFinite(site.lonDeg)) return null;
    const fixed = A.bodyFrameAt(body, jd);
    const frame = { axis: fixed.z, e1: fixed.x, e2: fixed.y };
    const lat = site.latDeg * C.DEG;
    const theta = site.lonDeg * C.DEG;
    const cl = Math.cos(lat);
    const eq = [cl * Math.cos(theta), cl * Math.sin(theta), Math.sin(lat)];
    const direction = V.norm(axialToWorld(eq, frame));
    const r = V.scale(direction, body.radius);
    return {
      frame, eq, theta, direction, r,
      v: rotatingSurfaceVelocity(body, jd, r),
    };
  }

  function angleDistance(a, b) {
    return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  }

  function planeNormal(Om, inc) {
    return [Math.sin(Om) * Math.sin(inc),
      -Math.cos(Om) * Math.sin(inc), Math.cos(inc)];
  }

  /* At a fixed site and inclination there are two direct-ascent orbital
   * planes (northbound/southbound). Choose between them using the requested
   * target plane first and the entered RAAN as a deterministic tie-breaker. */
  function siteCompatibleRaan(siteEq, inc, desiredOm, targetEq) {
    const rho = Math.hypot(siteEq[0], siteEq[1]);
    const den = Math.sin(inc) * rho;
    if (Math.abs(den) < 1e-12) {
      if (Math.abs(siteEq[2]) < 1e-10) {
        const n = planeNormal(desiredOm, inc);
        return { Om: desiredOm, n, targetDot: targetEq ? Math.abs(V.dot(n, targetEq)) : 0 };
      }
      return null;
    }
    let q = -(Math.cos(inc) * siteEq[2]) / den;
    if (Math.abs(q) > 1 + 1e-9) return null;
    q = Math.max(-1, Math.min(1, q));
    const theta = Math.atan2(siteEq[1], siteEq[0]);
    const d0 = Math.asin(q);
    const candidates = [theta + d0, theta + Math.PI - d0].map((Om) => {
      const n = planeNormal(Om, inc);
      return {
        Om, n,
        targetDot: targetEq ? Math.abs(V.dot(n, targetEq)) : 0,
        raanDistance: angleDistance(Om, desiredOm),
      };
    });
    candidates.sort((a, b) => targetEq
      ? (a.targetDot - b.targetDot || a.raanDistance - b.raanDistance)
      : a.raanDistance - b.raanDistance);
    return candidates[0];
  }

  function slerpDirection(a, b, f) {
    const d = Math.max(-1, Math.min(1, V.dot(a, b)));
    if (d > 0.999999) return V.norm(V.add(V.scale(a, 1 - f), V.scale(b, f)));
    const ang = Math.acos(d), sn = Math.sin(ang);
    return V.norm(V.add(V.scale(a, Math.sin((1 - f) * ang) / sn),
      V.scale(b, Math.sin(f * ang) / sn)));
  }

  function frameVector(frame, value) {
    return V.add(V.add(V.scale(frame.x, value[0]), V.scale(frame.y, value[1])),
      V.scale(frame.z, value[2]));
  }

  /* SGP4 states are TEME. Rotate through the companion pseudo-Earth-fixed
   * frame and then through the exact Earth body frame used by textures and
   * ground tracks. A centered finite difference supplies the frame-rate term
   * so the returned velocity remains inertial in the Planner world frame. */
  function temeStateToPlanner(state) {
    if (!SGP4 || typeof SGP4.temeToEarthFixed !== "function")
      throw new Error("SGP4 coordinate transforms are not loaded.");
    const earth = BODIES.earth;
    const fixed = SGP4.temeToEarthFixed(state, state.jd);
    const frame = A.bodyFrameAt(earth, state.jd);
    const r = frameVector(frame, fixed.position);
    if (!fixed.velocity) return { r, v: [0, 0, 0] };
    const rotatingV = frameVector(frame, fixed.velocity);
    // A 30-second span avoids subtractive loss beside a 2.4-million-day JD;
    // the Earth-frame rotation is smooth over this interval.
    const halfWindowS = 30;
    const before = frameVector(A.bodyFrameAt(earth,
      state.jd - halfWindowS / DAY), fixed.position);
    const after = frameVector(A.bodyFrameAt(earth,
      state.jd + halfWindowS / DAY), fixed.position);
    const frameRate = V.scale(V.sub(after, before), 1 / (2 * halfWindowS));
    return { r, v: V.add(rotatingV, frameRate) };
  }

  function emitSchematicLaunch(ctx, segIdx, body, pad, meco) {
    const rEnd = V.mag(meco.r), d0 = V.norm(pad.r), d1 = V.norm(meco.r);
    for (let k = 0; k <= LAUNCH_VISUAL_STEPS; k++) {
      const f = k / LAUNCH_VISUAL_STEPS;
      const radialProgress = f * f * (3 - 2 * f);
      // A shared radial/angular easing made the surface-to-orbit bridge read
      // as a straight chord in close LEO views. Lead the initial vertical rise
      // before pitching through the angular gravity turn; endpoints and the
      // one-second historical timing contract remain unchanged.
      const downrangeProgress = k === 0 ? 0 : (k === LAUNCH_VISUAL_STEPS
        ? 1 : f * f);
      if (k === 0) {
        ctx.state = { cen: body.id, r: V.clone(pad.r), v: V.clone(pad.v),
          t: pad.t, landed: false };
      } else if (k === LAUNCH_VISUAL_STEPS) {
        ctx.state = { cen: body.id, r: V.clone(meco.r), v: V.clone(meco.v),
          t: meco.t, landed: false };
      } else {
        const radius = body.radius + (rEnd - body.radius) * radialProgress;
        ctx.state = {
          cen: body.id,
          r: V.scale(slerpDirection(d0, d1, downrangeProgress), radius),
          v: V.add(V.scale(pad.v, 1 - radialProgress),
            V.scale(meco.v, radialProgress)),
          t: pad.t + LAUNCH_VISUAL_SECONDS * f,
          landed: false,
        };
      }
      // Deliberately ordinary interpolation: this schematic bridge is not a
      // Kepler arc and must never be reconstructed as one by the renderer.
      pushSample(ctx, segIdx);
    }
  }

  function followDockedArc(ctx, durS, segIdx, seg) {
    const targetId = ctx.state && ctx.state.dockedTo;
    const result = vehicleResultAt(ctx, targetId);
    if (!result || !result.samples || !result.samples.length) {
      warn(seg, `Docked target '${targetId}' has no propagated state.`, "error");
      return false;
    }
    const startT = ctx.state.t;
    const availableEnd = result.samples[result.samples.length - 1].t;
    const endT = startT + durS;
    if (availableEnd < endT - 1e-6) {
      warn(seg, `Docked target '${targetId}' does not extend through the full coast.`, "error");
      return false;
    }

    const emitTargetSample = (target, meta) => {
      if (!target) return;
      ctx.state = stateFromVehicleSample(target);
      ctx.state.massKg = Number.isFinite(ctx.massKg) ? ctx.massKg : null;
      ctx.state.dockedTo = targetId;
      pushSample(ctx, segIdx, target._interp || null, meta);
    };
    emitTargetSample(vehicleSampleAt(ctx, targetId, startT));

    const inside = [];
    for (let index = 0; index < result.samples.length; index++) {
      const sample = result.samples[index];
      if (sample.t > startT + 1e-9 && sample.t < endT - 1e-9)
        inside.push({ sample, sourceIndex: index });
    }
    let selected = inside;
    if (inside.length > 2000) {
      const keep = new Set();
      const stride = Math.max(1, Math.ceil(inside.length / 1900));
      for (let index = 0; index < inside.length; index += stride) keep.add(index);
      for (let index = 0; index < inside.length; index++) {
        const sourceIndex = inside[index].sourceIndex;
        const sample = inside[index].sample;
        const before = result.samples[sourceIndex - 1];
        const after = result.samples[sourceIndex + 1];
        const discontinuity = !!sample._breakBefore || !!sample._handoffFrom ||
          (before && (before.t === sample.t || before.seg !== sample.seg)) ||
          (after && (after.t === sample.t || after.seg !== sample.seg));
        if (discontinuity) {
          keep.add(index);
          if (index > 0) keep.add(index - 1);
          if (index + 1 < inside.length) keep.add(index + 1);
        }
      }
      selected = Array.from(keep).sort((left, right) => left - right)
        .map((index) => inside[index]);
    }
    for (const entry of selected) {
      emitTargetSample(entry.sample, {
        breakBefore: !!entry.sample._breakBefore,
        handoffFrom: entry.sample._handoffFrom || null,
      });
    }
    emitTargetSample(vehicleSampleAt(ctx, targetId, endT));
    const joinedDescriptor = { targetId, startT, endT };
    // Keep the exact target propagator available to sampleAtTime without
    // making a second serialized copy of the target result. This matters for
    // analytical providers such as SGP4, whose off-grid state must be
    // evaluated by that provider rather than reconstructed with Hermite.
    Object.defineProperty(joinedDescriptor, "providerResult", {
      value: result,
      enumerable: false,
    });
    ctx.joinedSegments[segIdx] = joinedDescriptor;
    seg._targetVehicle = targetId;
    seg._info.model = `joined-state propagation with ${targetId}`;
    return true;
  }

  const SEG_EXEC = {
    gp_orbit(seg, ctx, segIdx) {
      if (!SGP4) {
        warn(seg, "SGP4/SDP4 support is not loaded.", "error");
        return;
      }
      const resetsState = !!ctx.state;
      if (resetsState)
        warn(seg, "GP Orbit initializes a new Earth-centered state and resets the preceding trajectory.");
      const days = +seg.days;
      const stepMin = +seg.stepMin;
      if (!(days > 0) || !(stepMin > 0)) {
        warn(seg, "GP Orbit duration and output cadence must be positive.", "error");
        return;
      }
      let record, metadata, states;
      try {
        record = SGP4.initializeTLE(String(seg.line1 || ""), String(seg.line2 || ""), {
          strictChecksum: seg.strictChecksum !== "relaxed",
        });
        metadata = SGP4.metadata(record);
        // Stored nodes must also be safe for secondary consumers that draw
        // their own polylines. Limit the node spacing to 1/64 of the GP mean
        // period; sampleAtTime below still evaluates SGP4 exactly off-grid.
        const effectiveStepMin = Math.min(stepMin,
          Math.max(0.1, metadata.periodMinutes / 64));
        const startT = ctx.state ? ctx.state.t : 0;
        const startMin = (jdAt(ctx, startT) - metadata.epochJD) * SGP4.MINUTES_PER_DAY;
        states = SGP4.propagateSeries(record, startMin,
          startMin + days * SGP4.MINUTES_PER_DAY, effectiveStepMin, {
            maxAbsMinutes: SGP4.ABSOLUTE_MAX_ABS_MINUTES,
            maxSamples: 10000,
          });
        const earthR0 = A.bodyWorld("earth", states[0].jd);
        const earthV0 = A.bodyWorldVel("earth", states[0].jd);
        const startMissionT = startT;
        for (let index = 0; index < states.length; index++) {
          const state = states[index];
          const local = temeStateToPlanner(state);
          const t = startMissionT + (state.jd - states[0].jd) * DAY;
          const earthR = index === 0 ? earthR0 : A.bodyWorld("earth", state.jd);
          const earthV = index === 0 ? earthV0 : A.bodyWorldVel("earth", state.jd);
          ctx.state = {
            cen: "earth",
            r: local.r,
            v: local.v,
            w: V.add(earthR, local.r),
            worldV: V.add(earthV, local.v),
            t,
            landed: false,
            massKg: Number.isFinite(ctx.massKg) ? ctx.massKg : null,
            forceModel: metadata.branch.toLowerCase(),
            forceEphemeris: "gp-elements",
          };
          pushSample(ctx, segIdx, metadata.branch.toLowerCase(), {
            breakBefore: resetsState && index === 0,
          });
        }
        ctx.gpSegments[segIdx] = { record, branch: metadata.branch,
          startT: startMissionT, endT: ctx.state.t };
        seg._info.requestedCadenceMinutes = stepMin;
        seg._info.cadenceMinutes = effectiveStepMin;
      } catch (error) {
        warn(seg, `GP propagation failed: ${error.message}`, "error");
        return;
      }
      seg._info.model = metadata.branch;
      seg._info.frame = "TEME mapped through the Planner Earth-fixed frame";
      seg._info.elementEpoch = A.jdToStr(metadata.epochJD);
      seg._info.periodMinutes = metadata.periodMinutes;
      seg._info.samples = states.length;
      seg._targetBody = "earth";
      addEvent(ctx, segIdx, "gp",
        `${metadata.branch} GP prediction — NORAD ${metadata.satelliteNumber}`, {
          body: "earth",
          branch: metadata.branch,
        });
    },

    libration(seg, ctx, segIdx) {
      if (ctx.state)
        warn(seg, "Libration initialization resets the preceding spacecraft state.");
      const startT = ctx.state ? ctx.state.t : 0;
      const orbit = cachedLibrationOrbit(seg);
      const system = orbit.system;
      const period = cr3bpPeriodFor(orbit);
      ctx.cr3bpSystem = system;
      ctx.cr3bpOrbit = orbit;
      ctx.cr3bpPeriod = period;
      ctx.cr3bpTime = 0;
      ctx.cr3bpReferenceState = orbit.initialState.slice();
      setCr3bpState(ctx, system, orbit.initialState, startT);
      pushSample(ctx, segIdx);
      addEvent(ctx, segIdx, "libration",
        `${system.name} ${orbit.point} ${orbit.family}`, {
          body: system.secondaryId,
          system: system.id,
          point: orbit.point,
          family: orbit.family,
        });
      seg._targetBody = system.secondaryId;
      seg._info.system = system.name;
      seg._info.point = orbit.point;
      seg._info.family = orbit.family;
      seg._info.periodDays = period * system.timeUnitS / DAY;
      seg._info.jacobi = R3.jacobiConstant(system, orbit.initialState);
      seg._info.periodic = orbit.periodicClaim === true;
      if (isFinite(orbit.closureError)) seg._info.closureError = orbit.closureError;
      if (isFinite(orbit.correctionResidual))
        seg._info.correctionResidual = orbit.correctionResidual;
      ctx.lastOrbitNormal = null;
    },

    cr3bp_coast(seg, ctx, segIdx) {
      if (!requireState(ctx, seg)) return;
      if (!ctx.state.cr3bp || !ctx.cr3bpSystem || !(ctx.cr3bpPeriod > 0)) {
        warn(seg, "CR3BP Coast requires a preceding Libration initialization.", "error");
        return;
      }
      const cycles = +seg.cycles;
      if (!(cycles > 0)) {
        warn(seg, "CR3BP duration must be positive.", "error");
        return;
      }
      const duration = cycles * ctx.cr3bpPeriod;
      const jacobi0 = R3.jacobiConstant(ctx.cr3bpSystem, ctx.state.synodic);
      const integrated = propagateCr3bpSamples(ctx, segIdx, duration,
        seg.tolerance || "high");
      const jacobi1 = R3.jacobiConstant(ctx.cr3bpSystem, ctx.state.synodic);
      seg._info.cycles = cycles;
      seg._info.model = "adaptive DOPRI5(4) CR3BP";
      seg._info.jacobi = jacobi1;
      seg._info.jacobiDrift = Math.abs(jacobi1 - jacobi0);
      seg._info.acceptedSteps = integrated.stats.acceptedSteps;
      seg._targetBody = ctx.cr3bpSystem.secondaryId;
      addEvent(ctx, segIdx, "cr3bp",
        `${ctx.cr3bpSystem.name} CR3BP coast complete`, {
          body: ctx.cr3bpSystem.secondaryId,
          system: ctx.cr3bpSystem.id,
        });
    },

    stationkeep(seg, ctx, segIdx) {
      if (!requireState(ctx, seg)) return;
      if (!ctx.state.cr3bp || !ctx.cr3bpSystem || !(ctx.cr3bpPeriod > 0)) {
        warn(seg, "Stationkeeping requires a preceding Libration initialization.", "error");
        return;
      }
      const cycles = +seg.cycles;
      const requestedChecks = +seg.corrections;
      const checks = Math.max(1, Math.round(requestedChecks || 12));
      const maxBurnMs = +seg.maxBurnMs;
      const offsetKm = Math.max(0, +seg.offsetKm || 0);
      if (!(cycles > 0) || !(maxBurnMs > 0) || !isFinite(requestedChecks)) {
        warn(seg, "Stationkeeping duration and maximum correction must be positive.", "error");
        return;
      }
      const correctionEpochs = Math.ceil(cycles * checks);
      if (cycles > 50 || checks > 100 || correctionEpochs > 1000) {
        warn(seg, "Stationkeeping is limited to 50 cycles, 100 checks per cycle, and 1,000 correction epochs per segment.", "error");
        return;
      }
      const system = ctx.cr3bpSystem;
      const duration = cycles * ctx.cr3bpPeriod;
      const startCanonical = ctx.cr3bpTime;
      const phaseLocked = !!(ctx.cr3bpOrbit && ctx.cr3bpOrbit.periodicClaim === true);
      const referenceState = phaseLocked
        ? LIB.referenceStateAt(ctx.cr3bpOrbit, startCanonical, true)
        : ctx.cr3bpReferenceState;
      const initialOffset = ctx.state.synodic.map((value, index) =>
        value - referenceState[index]);
      initialOffset[0] += offsetKm / system.distanceKm;
      const reference = phaseLocked ? ctx.cr3bpOrbit : {
        initialState: referenceState.slice(), period: ctx.cr3bpPeriod,
      };
      const estimate = LIB.simulateStationkeeping(system, reference, {
        initialOffset,
        duration,
        phaseLocked,
        referencePhase: startCanonical,
        correctionInterval: ctx.cr3bpPeriod / checks,
        maxBurn: (maxBurnMs / 1000) / system.velocityUnitKmS,
        maxBurns: Math.ceil(cycles * checks) + 1,
        samplesPerCorrection: 8,
        positionDeadband: 0,
        velocityDeadband: 0,
      });
      const startT = ctx.state.t;
      const initialEntry = estimate.history[0];
      setCr3bpState(ctx, system, initialEntry.trackedState, startT);
      pushSample(ctx, segIdx, "cr3bp", { breakBefore: offsetKm > 0 });
      if (offsetKm > 0)
        addEvent(ctx, segIdx, "note",
          `${system.name} stationkeeping dispersion — ${offsetKm.toFixed(3)} km radial offset`, {
            body: system.secondaryId,
            system: system.id,
          });
      for (let index = 1; index < estimate.history.length; index++) {
        const entry = estimate.history[index];
        const t = startT + entry.time * system.timeUnitS;
        const burn = entry.burnIndex === null || entry.burnIndex === undefined
          ? null : estimate.burns[entry.burnIndex];
        if (burn) {
          const pre = entry.trackedState.slice();
          pre[3] -= burn.deltaV[0];
          pre[4] -= burn.deltaV[1];
          pre[5] -= burn.deltaV[2];
          setCr3bpState(ctx, system, pre, t);
          pushSample(ctx, segIdx, "cr3bp");
          addEvent(ctx, segIdx, "stationkeep",
            `${system.name} stationkeeping correction`, {
              body: system.secondaryId,
              system: system.id,
              dv: burn.magnitudeKmS,
            });
        }
        setCr3bpState(ctx, system, entry.trackedState, t);
        pushSample(ctx, segIdx, "cr3bp");
      }
      ctx.cr3bpTime = startCanonical + duration;
      ctx.cr3bpReferenceState = estimate.finalReferenceState.slice();
      setCr3bpState(ctx, system, estimate.finalTrackedState,
        startT + duration * system.timeUnitS);
      ctx.totalDv += estimate.totalDvKmS;
      seg._info.dv = estimate.totalDvKmS;
      seg._info.burns = estimate.burnCount;
      seg._info.cycles = cycles;
      seg._info.correctionEpochs = correctionEpochs;
      seg._info.samplesPerCheck = estimate.samplesPerCorrection;
      seg._info.maxBurnMs = maxBurnMs;
      seg._info.model = phaseLocked ? "phase-locked ideal impulsive reference tracking"
        : "ideal impulsive reference tracking";
      seg._targetBody = system.secondaryId;
    },

    launch(seg, ctx, segIdx) {
      const body = BODIES[seg.body] || BODIES.earth;
      if (ctx.state) warn(seg, "Launch resets any previous trajectory state.");
      const launchT = ctx.state ? ctx.state.t : 0;
      const launchJd = jdAt(ctx, launchT);
      const altKm = +seg.altKm || 200;
      const a = body.radius + altKm;
      if (a <= body.radius) { warn(seg, "Altitude must be positive.", "error"); return; }

      /* ---- launch site: latitude constrains reachable inclination ---- */
      let incDeg = +seg.incDeg || 0;
      const site = C.launchSite(seg.site || "");
      if (site.id) {
        if (body.id !== "earth") {
          warn(seg, `${site.name} is an Earth site — ignored for a ${body.name} launch.`);
        } else {
          const lat = Math.abs(site.latDeg);
          const effInc = Math.abs(incDeg) > 90 ? 180 - Math.abs(incDeg) : Math.abs(incDeg);
          if (effInc < lat - 0.01) {
            warn(seg, `Inclination ${incDeg.toFixed(1)}° is below the latitude of ` +
              `${site.name} (${site.latDeg.toFixed(1)}°) — unreachable by direct ascent ` +
              `(a costly plane change would be needed). Clamped to ${lat.toFixed(1)}°.`);
            incDeg = lat;
            seg._info.incClamped = lat;
          }
          seg._info.site = site.name;
        }
      }
      const inc = incDeg * C.DEG;
      const siteGeom = launchSiteGeometry(body, site, launchJd);

      let Om = (+seg.raanDeg || 0) * C.DEG;
      // Launch-window plane targeting: pick RAAN so that the parking-orbit
      // plane contains the target body's direction at burn time (real
      // missions do this by choosing launch time/azimuth). Plane normal:
      // n̂(Ω) = (sinΩ sin i, −cosΩ sin i, cos i); minimize |n̂·û|.
      const hasTargetPlane = seg.targetPlane && BODIES[seg.targetPlane];
      let targetU = null, targetEq = null;
      if (hasTargetPlane) {
        const jdT = jdAt(ctx, launchT + Math.max(+seg.planeTofDays || 0, 0) * DAY);
        targetU = V.norm(relBodyState(seg.targetPlane, body.id, jdT).r);
        targetEq = siteGeom ? worldToAxial(targetU, siteGeom.frame) : targetU;
      }
      let bestDot = Infinity;
      if (siteGeom && targetEq) {
        // A target-plane launch preserves the transfer plane even when the
        // fixed pad is not in it. Scan in the body's equatorial basis (the
        // same basis used for the site and launch conic), then let the
        // schematic powered ascent bridge carry the required dogleg.
        const si = Math.sin(inc), ci = Math.cos(inc);
        const candidates = [];
        let minTargetDot = Infinity;
        for (let k = 0; k < 1440; k++) {
          const om = (k / 1440) * 2 * Math.PI;
          const d = Math.abs(Math.sin(om) * si * targetEq[0] -
            Math.cos(om) * si * targetEq[1] + ci * targetEq[2]);
          const n = planeNormal(om, inc);
          candidates.push({ om, targetDot: d, siteDot: Math.abs(V.dot(n, siteGeom.eq)) });
          if (d < minTargetDot) minTargetDot = d;
        }
        // Absolute target-plane error has two nearly equivalent RAAN
        // families. Within a quarter-degree target tolerance, prefer the one
        // passing closest to the selected pad so the visual dogleg cannot
        // resemble the former far-side/Pacific launch bug.
        const targetTolerance = Math.sin(0.25 * C.DEG);
        const chosen = candidates
          .filter((c) => c.targetDot <= minTargetDot + targetTolerance)
          .sort((a, b) => a.siteDot - b.siteDot || a.targetDot - b.targetDot)[0];
        Om = chosen.om;
        bestDot = chosen.targetDot;
        seg._info.targetRaanDeg = ((Om / C.DEG) % 360 + 360) % 360;
      } else if (siteGeom) {
        const chosen = siteCompatibleRaan(siteGeom.eq, inc, Om, null);
        if (chosen) {
          Om = chosen.Om;
          bestDot = chosen.targetDot;
          seg._info.siteRaanDeg = ((Om / C.DEG) % 360 + 360) % 360;
        } else {
          warn(seg, `No direct-ascent plane at ${incDeg.toFixed(1)}° passes through ` +
            `${site.name}; using the requested RAAN.`, "error");
        }
      } else if (targetU) {
        const si = Math.sin(inc), ci = Math.cos(inc);
        let bestOm = Om;
        for (let k = 0; k < 1440; k++) {
          const om = (k / 1440) * 2 * Math.PI;
          const d = Math.abs(Math.sin(om) * si * targetU[0] -
            Math.cos(om) * si * targetU[1] + ci * targetU[2]);
          if (d < bestDot) { bestDot = d; bestOm = om; }
        }
        Om = bestOm;
      }
      if (hasTargetPlane) {
        seg._info.raanAuto = ((Om / C.DEG) % 360 + 360) % 360;
        if (Number.isFinite(bestDot))
          seg._info.planeMissDeg = Math.asin(Math.min(1, bestDot)) / C.DEG;
        // A site-backed target-plane launch explicitly uses the schematic
        // powered-ascent dogleg below, so retain its geometry as info rather
        // than misreporting the requested inclination as invalid. The old
        // warning remains useful only for unconstrained/no-site launches.
        if (!siteGeom && bestDot > 0.05) {
          warn(seg, `Inclination ${incDeg.toFixed(1)}° is too low to place the ` +
            `orbit plane through ${BODIES[seg.targetPlane].name} (out-of-plane by ` +
            `${(Math.asin(Math.min(1, bestDot)) / C.DEG).toFixed(1)}°) — transfers will cost extra Δv.`);
        }
      }

      /* ---- ascent mode: MECO transfer ellipse vs direct circular ----
       * Imported missions without the field keep the legacy direct insert. */
      const mode = seg.ascent === "meco" ? "meco" : "direct";
      const orbitInitialization = mode === "direct" && !siteGeom;
      let rv, mecoLabel = "";
      let vBurnout, e = 0, aOrb = a, nu = 0;
      if (mode === "meco") {
        // Apoapsis at target altitude; periapsis suborbital for atmospheric
        // bodies (booster disposal), low-but-clear for airless ones (LM-style).
        const peAlt = body.atmosphereKm ? -30 : Math.max(Math.min(0.12 * altKm, 20), 5);
        const rPe = body.radius + peAlt, rAp = a;
        aOrb = 0.5 * (rPe + rAp);
        e = (rAp - rPe) / (rAp + rPe);
        // burnout point on the ascending arc
        const hBurn = peAlt > 0 ? peAlt : Math.min(0.75 * altKm, 140);
        const r0 = body.radius + hBurn;
        const p = aOrb * (1 - e * e);
        if (e > 1e-9) {
          const cosNu = Math.min(1, Math.max(-1, (p / r0 - 1) / e));
          nu = Math.acos(cosNu);            // (0, π): ascending toward apoapsis
        }
        vBurnout = A.visViva(body.mu, r0, aOrb);
        mecoLabel = `MECO ${peAlt.toFixed(0)} × ${altKm.toFixed(0)} km`;
        seg._info.meco = mecoLabel;
      } else {
        vBurnout = A.circularSpeed(body.mu, a);
      }

      let w = 0;
      if (siteGeom) {
        const pHat = [Math.cos(Om), Math.sin(Om), 0];
        const qHat = [-Math.sin(Om) * Math.cos(inc),
          Math.cos(Om) * Math.cos(inc), Math.sin(inc)];
        if (targetEq) {
          const n = planeNormal(Om, inc);
          const offPlane = V.dot(siteGeom.eq, n);
          const projected = V.norm(V.sub(siteGeom.eq, V.scale(n, offPlane)));
          const uMeco = Math.atan2(V.dot(projected, qHat), V.dot(projected, pHat));
          w = uMeco - nu;
          seg._info.doglegDeg = Math.acos(Math.max(-1,
            Math.min(1, V.dot(siteGeom.eq, projected)))) / C.DEG;
        } else {
          const uSite = Math.atan2(V.dot(siteGeom.eq, qHat), V.dot(siteGeom.eq, pHat));
          // Without a requested target plane, use the direct-ascent plane and
          // keep MECO a bounded, local prograde distance from the pad.
          const downrangeDeg = Math.min(18, Math.max(8, 4 + 0.06 * altKm));
          w = uSite + downrangeDeg * C.DEG - nu;
          seg._info.downrangeDeg = downrangeDeg;
        }
      }
      const localRv = A.coeToRV({ a: aOrb, e, i: inc, Om, w, nu }, body.mu);
      rv = siteGeom ? {
        r: axialToWorld(localRv.r, siteGeom.frame),
        v: axialToWorld(localRv.v, siteGeom.frame),
      } : localRv;
      const mecoState = {
        cen: body.id, r: rv.r, v: rv.v,
        t: launchT + LAUNCH_VISUAL_SECONDS, landed: false,
      };

      const padFrame = siteGeom ? siteGeom.frame : bodyAxialFrame(body);
      const padR = siteGeom ? siteGeom.r : V.scale(V.norm(rv.r), body.radius);
      const padState = {
        cen: body.id,
        r: padR,
        v: siteGeom ? siteGeom.v : rotatingSurfaceVelocity(body, launchJd, padR),
        t: launchT,
        landed: false,
      };

      /* ---- ascent Δv bookkeeping: target speed + losses − rotation credit */
      const vc = A.circularSpeed(body.mu, a);
      const loss = body.id === "earth" ? 1.5 : (body.atmosphereKm ? 1.2 : 0.15 * vc);
      // Surface rotation helps eastward launches: credit ≈ v_eq·cos(i)
      // (sin(azimuth) = cos(i)/cos(lat) ⇒ eastward component is cos(i)).
      const vEq = body.rotHours
        ? (2 * Math.PI * body.radius) / (Math.abs(body.rotHours) * 3600) * Math.sign(body.rotHours)
        : 0;
      const rotCredit = vEq * Math.cos(inc);
      seg._info.vCirc = vc;
      seg._info.rotCredit = rotCredit;
      seg._info.ascentDv = orbitInitialization ? 0 : vBurnout + loss - rotCredit;
      if (orbitInitialization) {
        // Validation/design presets with no launch site begin from a reviewed
        // orbit rather than an invented surface point. Keep the established
        // one-second downstream timing with two coincident orbital samples.
        seg._info.orbitInitialization = true;
        ctx.state = { ...mecoState, t: launchT };
        addEvent(ctx, segIdx, "launch",
          `Orbit initialization — ${body.name}, ` +
          `${altKm.toFixed(0)} km circular × ${incDeg.toFixed(1)}°`,
          { body: body.id, initialization: true });
        pushSample(ctx, segIdx, null, { breakBefore: true });
        ctx.state = mecoState;
        pushSample(ctx, segIdx);
      } else {
        ctx.state = padState;
        addEvent(ctx, segIdx, "launch",
          `Launch — ${body.name}${site.id && body.id === "earth" ? " (" + site.name + ")" : ""}, ` +
          `${mode === "meco" ? mecoLabel : altKm.toFixed(0) + " km circular"} × ${incDeg.toFixed(1)}° ` +
          `(ascent Δv ≈ ${seg._info.ascentDv.toFixed(1)} km/s incl. losses − rotation, bookkept)`,
          { body: body.id });
        emitSchematicLaunch(ctx, segIdx, body, padState, mecoState);
      }
      if (body.gasGiant) warn(seg, "Launching from a gas giant is… optimistic.");
      if (mode === "meco") {
        const next = ctx.mission && ctx.mission.segments[segIdx + 1];
        if (!next || next.type !== "insertion")
          warn(seg, "MECO orbit is not circular — follow with an Insertion (burn at " +
            "apoapsis) to complete the ascent, or the vehicle falls back.");
      }
    },

    coast(seg, ctx, segIdx) {
      if (!requireFlying(ctx, seg)) return;
      const dur = (+seg.days || 0) * DAY;
      if (dur <= 0) { warn(seg, "Duration must be > 0 days.", "error"); return; }
      if (ctx.state.dockedTo) {
        followDockedArc(ctx, dur, segIdx, seg);
        return;
      }
      if (seg.mode === "adaptive-nbody") {
        try {
          const result = propagateForceArc(ctx, dur, segIdx, {
            gravity: "nbody",
            ephemeris: seg.ephemeris,
          });
          seg._info.model = "adaptive inertial n-body";
          seg._info.forceBodies = result.pointMassBodies.join(", ");
          seg._info.ephemeris = result.ephemerisMetadata.source;
          seg._info.acceptedSteps = result.stats.acceptedSteps;
          if (result.status === "event")
            warn(seg, "Adaptive n-body coast ended at a physical event.", "error");
        } catch (error) {
          warn(seg, `Adaptive n-body integration failed: ${error.message}`, "error");
        }
        return;
      }
      if (seg.mode === "adaptive-environment") {
        try {
          const environment = coastEnvironment(seg, ctx);
          if (!environment)
            throw new Error("Select drag, SRP, Earth harmonics, or provide an environment object.");
          const massKg = spacecraftMass(ctx, seg.massKg);
          const result = propagateForceArc(ctx, dur, segIdx, {
            gravity: "nbody",
            ephemeris: seg.ephemeris,
            environment,
            massKg,
          });
          seg._info.model = "adaptive deterministic environment";
          seg._info.forceBodies = result.pointMassBodies.join(", ");
          seg._info.ephemeris = result.ephemerisMetadata.source;
          seg._info.environmentModels = Object.keys(result.environmentModels || {})
            .filter((key) => result.environmentModels[key]).join(", ");
          seg._info.acceptedSteps = result.stats.acceptedSteps;
          if (result.status === "event")
            warn(seg, "Environment coast ended at a physical event.", "error");
        } catch (error) {
          warn(seg, `Environment integration failed: ${error.message}`, "error");
        }
        return;
      }
      if (seg.mode === "j2-secular") {
        try {
          const result = propagateJ2Arc(ctx, dur, segIdx);
          seg._info.model = "first-order Earth J2 secular";
          seg._info.raanRateDegDay = result.rates.raanRateDegDay;
          seg._info.argPeriapsisRateDegDay = result.rates.argPeriapsisRateDegDay;
          seg._info.orbitalPeriodS = result.periodS;
          seg._info.acceptedSteps = result.intervals;
          if (result.reason === "crash")
            warn(seg, "J2 trajectory impacts the Earth surface during this coast!", "error");
        } catch (error) {
          warn(seg, error.message, "error");
        }
        return;
      }
      const res = propagateArc(ctx, dur, { mode: seg.mode, segIdx });
      if (res.reason === "crash") warn(seg, "Trajectory impacts the surface during this coast!", "error");
      if (res.reason === "transitions") warn(seg, "Too many SOI transitions — check the trajectory.", "error");
    },

    finite_burn(seg, ctx, segIdx) {
      if (!requireFlying(ctx, seg)) return;
      const duration = (+seg.durationMin || 0) * 60;
      const thrustN = +seg.thrustN;
      const ispS = +seg.ispS;
      if (!(duration > 0) || !(thrustN > 0) || !(ispS > 0)) {
        warn(seg, "Finite burn duration, thrust, and Isp must be positive.", "error");
        return;
      }
      const massKg = spacecraftMass(ctx, seg.massKg);
      const spacecraft = ctx.mission && ctx.mission.spacecraft || {};
      const dryMassKg = Math.max(0, +spacecraft.dryKg || 0);
      if (!(massKg > dryMassKg)) {
        warn(seg, "Finite burn needs propellant mass; set spacecraft propellant or a start-mass override above dry mass.", "error");
        return;
      }
      const startT = ctx.state.t;
      const centralId = ctx.state.cen;
      const startW = ctx.state.w ? V.clone(ctx.state.w)
        : (centralId === "sun" ? V.clone(ctx.state.r)
          : V.add(A.bodyWorld(centralId, jdAt(ctx, startT)), ctx.state.r));
      const startCoe = A.rvToCoe(ctx.state.r, ctx.state.v, BODIES[centralId].mu);
      const direction = String(seg.direction || "prograde");
      const thrust = {
        thrustN,
        ispS,
        dryMassKg,
        directionLaw: direction === "inertial" ? "inertial-fixed" : direction,
        relativeTo: direction === "inertial" ? undefined : centralId,
      };
      if (direction === "inertial")
        thrust.vector = [+seg.dirX || 0, +seg.dirY || 0, +seg.dirZ || 0];
      let result;
      try {
        result = propagateForceArc(ctx, duration, segIdx, {
          gravity: seg.gravity || "nbody",
          massKg,
          thrust,
        });
      } catch (error) {
        warn(seg, `Finite-thrust integration failed: ${error.message}`, "error");
        return;
      }
      const finalMass = result.massFinalKg;
      const characteristicDv = ispS * 0.00980665 * Math.log(massKg / finalMass);
      ctx.totalDv += characteristicDv;
      ctx.massKg = finalMass;
      if (ctx.state) ctx.state.massKg = finalMass;
      const endCoe = A.rvToCoe(ctx.state.r, ctx.state.v, BODIES[centralId].mu);
      seg._info.dv = characteristicDv;
      seg._info.durationS = duration;
      seg._info.thrustN = thrustN;
      seg._info.massStartKg = massKg;
      seg._info.massEndKg = finalMass;
      seg._info.propellantUsedKg = result.propellantUsedKg;
      seg._info.apoStart = startCoe.ra;
      seg._info.apoEnd = endCoe.ra;
      seg._info.model = seg.gravity === "central-only" || seg.gravity === "central-relative"
        ? "adaptive finite thrust + central-relative gravity"
        : "adaptive finite thrust + n-body gravity";
      seg._info.acceptedSteps = result.stats.acceptedSteps;
      ctx.events.push({
        t: startT,
        seg: segIdx,
        kind: "burn",
        label: `Finite burn start — ${thrustN.toFixed(0)} N ${direction}, ` +
          `${(duration / 60).toFixed(1)} min`,
        dv: characteristicDv,
        body: centralId,
        finite: true,
        vehicleId: ctx.vehicleId || "primary",
        vehicleName: ctx.vehicleName || "Spacecraft",
        w: startW,
      });
      addEvent(ctx, segIdx, "burn_end",
        `Finite burn end — Δv ${characteristicDv.toFixed(3)} km/s, ` +
        `propellant ${result.propellantUsedKg.toFixed(2)} kg`, {
          body: centralId,
          dv: characteristicDv,
          finite: true,
        });
      seg._targetBody = centralId;
    },

    coast_to(seg, ctx, segIdx) {
      if (!requireFlying(ctx, seg)) return;
      const maxS = Math.max(+seg.maxDays || 5, 0.001) * DAY;
      const res = propagateArc(ctx, maxS, {
        mode: seg.mode, segIdx, stop: { type: seg.event || "periapsis" },
      });
      if (res.reason === "time") {
        warn(seg, `${seg.event} not reached within ${seg.maxDays} days ` +
          "(hyperbolic escape or period longer than the limit?).");
      } else if (res.reason === "crash") {
        warn(seg, "Impacted the surface before reaching the apsis!", "error");
      } else {
        addEvent(ctx, segIdx, "apsis",
          `${seg.event === "apoapsis" ? "Apoapsis" : "Periapsis"} — ` +
          `${BODIES[ctx.state.cen].name}, alt ${fmtKm(V.mag(ctx.state.r) - BODIES[ctx.state.cen].radius)}`,
          { body: ctx.state.cen });
      }
    },

    separate(seg, ctx, segIdx) {
      if (ctx.state) {
        warn(seg, "Separate initializes a branch vehicle and must be its first segment.", "error");
        return;
      }
      const sourceId = String(seg.fromVehicle || "primary");
      if (sourceId === ctx.vehicleId) {
        warn(seg, "A vehicle cannot separate from itself.", "error");
        return;
      }
      const source = vehicleResultAt(ctx, sourceId);
      if (!source || !source.samples || !source.samples.length) {
        warn(seg, `Source vehicle '${sourceId}' has not been propagated.`, "error");
        return;
      }
      const segmentNumber = Math.max(1, Math.floor(+seg.afterSegment || 1));
      const times = source.segmentTimes || [];
      if (segmentNumber > times.length) {
        warn(seg, `Source vehicle '${sourceId}' has only ${times.length} segments.`, "error");
        return;
      }
      const sourceSegment = times[segmentNumber - 1];
      if (!sourceSegment || sourceSegment.ok !== true) {
        warn(seg, `Source vehicle '${sourceId}' segment ${segmentNumber} did not complete successfully.`, "error");
        return;
      }
      const separationT = sourceSegment.t1 +
        Math.max(0, +seg.delayMin || 0) * 60;
      const parentSample = vehicleSampleAt(ctx, sourceId, separationT);
      if (!parentSample) {
        warn(seg, `Source vehicle '${sourceId}' has no state at the requested separation time.`, "error");
        return;
      }
      if (parentSample.cr3bp) {
        warn(seg, "Branch separation from a CR3BP state is not supported by the two-body vehicle model.", "error");
        return;
      }
      ctx.state = stateFromVehicleSample(parentSample);
      ctx.state.massKg = Number.isFinite(ctx.massKg) ? ctx.massKg : null;
      pushSample(ctx, segIdx, null, { breakBefore: true });

      const components = [+seg.dv1 || 0, +seg.dv2 || 0, +seg.dv3 || 0];
      const dv = maneuverVector(ctx.state, seg.frame || "vnb", components);
      const mag = V.mag(dv);
      let event;
      if (mag > 0) {
        event = applyDv(ctx, segIdx, dv,
          `Separation from ${sourceId} - dv ${mag.toFixed(4)} km/s`, {
            sourceVehicle: sourceId,
          });
        event.kind = "separation";
      } else {
        event = addEvent(ctx, segIdx, "separation",
          `Separation from ${sourceId}`, { sourceVehicle: sourceId, dv: 0 });
      }
      pushSample(ctx, segIdx);
      seg._targetVehicle = sourceId;
      seg._info.sourceVehicle = sourceId;
      seg._info.sourceSegment = segmentNumber;
      seg._info.dv = mag;
    },

    rendezvous(seg, ctx, segIdx) {
      if (!requireFlying(ctx, seg)) return;
      if (ctx.state.dockedTo) {
        warn(seg, "A joined vehicle cannot start a separate rendezvous transfer.", "error");
        return;
      }
      const targetId = String(seg.targetVehicle || "primary");
      if (targetId === ctx.vehicleId) {
        warn(seg, "A vehicle cannot rendezvous with itself.", "error");
        return;
      }
      const tof = (+seg.tofHours || 0) * 3600;
      if (!(tof > 0)) {
        warn(seg, "Rendezvous time of flight must be positive.", "error");
        return;
      }
      const requestedStart = ctx.state;
      const arrivalT = requestedStart.t + tof;
      const target = vehicleSampleAt(ctx, targetId, arrivalT);
      if (!target) {
        warn(seg, `Target vehicle '${targetId}' has no state at rendezvous arrival.`, "error");
        return;
      }
      if (requestedStart.cr3bp || target.cr3bp || requestedStart.landed || target.landed) {
        warn(seg, "Rendezvous Lambert guidance requires two flying inertial/two-body states, not CR3BP or surface states.", "error");
        return;
      }
      if (target.cen !== requestedStart.cen) {
        warn(seg, `Rendezvous requires both vehicles in the same central-body frame ` +
          `(${requestedStart.cen} vs ${target.cen}).`, "error");
        return;
      }
      const mu = BODIES[requestedStart.cen] && BODIES[requestedStart.cen].mu;
      if (!(mu > 0)) {
        warn(seg, "Rendezvous central body has no gravity parameter.", "error");
        return;
      }

      // The shared Lambert solver is intentionally single-revolution. Long
      // rendezvous timelines therefore remain passive phasing coasts until a
      // final bounded transfer shorter than 0.75 of the local orbital period.
      // This preserves the requested arrival UTC without selecting the false
      // high-energy zero-revolution branch after several LEO revolutions.
      const osculating = A.rvToCoe(requestedStart.r, requestedStart.v, mu);
      const periodS = isFinite(osculating.a) && osculating.a > 0 && osculating.e < 1
        ? 2 * Math.PI * Math.sqrt(Math.pow(osculating.a, 3) / mu) : Infinity;
      const transferTof = Math.min(tof, 0.75 * periodS);
      const phasingWaitS = Math.max(0, tof - transferTof);
      const waited = phasingWaitS > 1e-6
        ? A.propagateUniversal(requestedStart.r, requestedStart.v, phasingWaitS, mu)
        : { r: requestedStart.r, v: requestedStart.v };
      if (V.mag(waited.r) <= BODIES[requestedStart.cen].radius) {
        warn(seg, "Rendezvous phasing coast intersects the central body.", "error");
        return;
      }
      const transferStart = { r: waited.r, v: waited.v };
      const initialNormal = V.cross(transferStart.r, transferStart.v);
      const requestedDirection = String(seg.direction || "auto");
      const candidates = [true, false].map((branch) => {
        const lambert = A.lambert(transferStart.r, target.r, transferTof, mu, branch);
        if (!lambert) return null;
        const solutionNormal = V.cross(transferStart.r, lambert.v1);
        const localDirection = V.dot(solutionNormal, initialNormal) >= 0
          ? "prograde" : "retrograde";
        const departure = V.sub(lambert.v1, transferStart.v);
        const match = V.sub(target.v, lambert.v2);
        return { lambert, localDirection, departure, match,
          totalDv: V.mag(departure) + V.mag(match) };
      }).filter((candidate) => candidate &&
        (requestedDirection === "auto" || candidate.localDirection === requestedDirection))
        .sort((left, right) => left.totalDv - right.totalDv);
      const chosen = candidates[0];
      const solution = chosen && chosen.lambert;
      if (!solution) {
        warn(seg, "Rendezvous Lambert solver found no single-revolution solution; adjust the time of flight.", "error");
        return;
      }
      const departureDv = chosen.departure;
      const matchDv = chosen.match;
      const totalDv = chosen.totalDv;
      const limit = +seg.maxDvKms || 5;
      if (totalDv > limit) {
        warn(seg, `Rendezvous needs ${totalDv.toFixed(3)} km/s, above the ` +
          `${limit.toFixed(3)} km/s segment limit.`, "error");
        return;
      }
      if (phasingWaitS > 1e-6) {
        addEvent(ctx, segIdx, "rendezvous_wait",
          `Rendezvous phasing coast - ${(phasingWaitS / 3600).toFixed(2)} h before terminal transfer`, {
            targetVehicle: targetId,
          });
        const waitResult = propagateArc(ctx, phasingWaitS, { mode: "kepler", segIdx });
        if (waitResult.reason !== "time" || ctx.state.cen !== target.cen) {
          warn(seg, `Rendezvous phasing coast was interrupted (${waitResult.reason}).`, "error");
          return;
        }
      }
      applyDv(ctx, segIdx, departureDv,
        `Rendezvous departure toward ${targetId} - dv ${V.mag(departureDv).toFixed(4)} km/s`,
        { targetVehicle: targetId, rendezvous: true });
      const propagation = propagateArc(ctx, transferTof, { mode: "kepler", segIdx });
      if (propagation.reason !== "time" || ctx.state.cen !== target.cen) {
        warn(seg, `Rendezvous coast was interrupted (${propagation.reason}).`, "error");
        return;
      }
      const rangeKm = V.mag(V.sub(ctx.state.r, target.r));
      const relativeRateMps = 1000 * V.mag(V.sub(ctx.state.v, target.v));
      const tolerance = Math.max(1e-6, +seg.terminalRangeKm || 1);
      if (rangeKm > tolerance) {
        warn(seg, `Terminal range ${rangeKm.toFixed(3)} km exceeds the ` +
          `${tolerance.toFixed(3)} km rendezvous tolerance.`, "error");
        return;
      }
      applyDv(ctx, segIdx, V.sub(target.v, ctx.state.v),
        `Rendezvous velocity match with ${targetId} - ` +
        `relative speed ${relativeRateMps.toFixed(2)} m/s`, {
          targetVehicle: targetId,
          rendezvous: true,
          rangeKm,
          relativeRateMps,
        });
      // Lambert and the target provider agree to numerical precision here.
      // Store the exact shared endpoint so later docking tests never depend on
      // sub-millimetre propagation roundoff.
      if (rangeKm <= 0.000001) {
        ctx.state.r = V.clone(target.r);
        ctx.state.v = V.clone(target.v);
        ctx.state.w = target.w ? V.clone(target.w) : null;
        ctx.state.worldV = target.worldV ? V.clone(target.worldV) : null;
      }
      pushSample(ctx, segIdx);
      addEvent(ctx, segIdx, "rendezvous",
        `Rendezvous complete with ${targetId} - range ${rangeKm.toFixed(3)} km`, {
          targetVehicle: targetId,
          body: target.cen,
          rangeKm,
          relativeRateMps: 0,
        });
      seg._targetVehicle = targetId;
      seg._info.targetVehicle = targetId;
      seg._info.direction = chosen.localDirection;
      seg._info.requestedTofS = tof;
      seg._info.phasingWaitS = phasingWaitS;
      seg._info.transferTofS = transferTof;
      seg._info.dv = totalDv;
      seg._info.departureDv = V.mag(departureDv);
      seg._info.matchDv = V.mag(matchDv);
      seg._info.rangeKm = rangeKm;
      seg._info.preMatchRateMps = relativeRateMps;
    },

    dock(seg, ctx, segIdx) {
      if (!requireFlying(ctx, seg)) return;
      const targetId = String(seg.targetVehicle || "primary");
      if (targetId === ctx.vehicleId) {
        warn(seg, "A vehicle cannot dock with itself.", "error");
        return;
      }
      const target = vehicleSampleAt(ctx, targetId, ctx.state.t);
      if (!target) {
        warn(seg, `Target vehicle '${targetId}' has no simultaneous state for docking.`, "error");
        return;
      }
      if (ctx.state.cr3bp || target.cr3bp || ctx.state.landed || target.landed) {
        warn(seg, "Docking capture requires two flying inertial/two-body states.", "error");
        return;
      }
      if (target.cen !== ctx.state.cen) {
        warn(seg, "Docking vehicles are not in the same central-body frame.", "error");
        return;
      }
      const rangeKm = V.mag(V.sub(ctx.state.r, target.r));
      const relativeRateMps = 1000 * V.mag(V.sub(ctx.state.v, target.v));
      const captureRange = Math.max(1e-6, +seg.captureRangeKm || 0.00025);
      const captureRate = Math.max(1e-6, +seg.captureRateMps || 0.2);
      seg._info.rangeKm = rangeKm;
      seg._info.relativeRateMps = relativeRateMps;
      if (rangeKm > captureRange || relativeRateMps > captureRate) {
        warn(seg, `Docking capture rejected: ${rangeKm.toFixed(3)} km at ` +
          `${relativeRateMps.toFixed(3)} m/s; limits are ${captureRange.toFixed(3)} km ` +
          `and ${captureRate.toFixed(3)} m/s.`, "error");
        return;
      }
      const followerMass = ctx.massKg;
      ctx.state = stateFromVehicleSample(target);
      ctx.state.massKg = Number.isFinite(followerMass) ? followerMass : null;
      ctx.state.dockedTo = targetId;
      pushSample(ctx, segIdx);
      addEvent(ctx, segIdx, "dock", `Docked with ${targetId}`, {
        targetVehicle: targetId,
        body: target.cen,
        rangeKm,
        relativeRateMps,
      });
      seg._targetVehicle = targetId;
      seg._info.targetVehicle = targetId;
      seg._info.joined = true;
    },

    undock(seg, ctx, segIdx) {
      if (!requireFlying(ctx, seg)) return;
      const targetId = ctx.state.dockedTo;
      if (!targetId) {
        warn(seg, "Undock requires a preceding successful Dock and joined-state coast.", "error");
        return;
      }
      delete ctx.state.dockedTo;
      const components = [+seg.dv1 || 0, +seg.dv2 || 0, +seg.dv3 || 0];
      const dv = maneuverVector(ctx.state, seg.frame || "vnb", components);
      const mag = V.mag(dv);
      let event;
      if (mag > 0) {
        event = applyDv(ctx, segIdx, dv,
          `Undock from ${targetId} - dv ${mag.toFixed(4)} km/s`, {
            targetVehicle: targetId,
          });
        event.kind = "undock";
      } else {
        event = addEvent(ctx, segIdx, "undock", `Undocked from ${targetId}`, {
          targetVehicle: targetId,
          dv: 0,
        });
      }
      pushSample(ctx, segIdx);
      seg._targetVehicle = targetId;
      seg._info.targetVehicle = targetId;
      seg._info.dv = mag;
    },

    impulse(seg, ctx, segIdx) {
      if (!requireFlying(ctx, seg)) return;
      const s = ctx.state;
      const d = [+seg.dv1 || 0, +seg.dv2 || 0, +seg.dv3 || 0];
      const dv = maneuverVector(s, seg.frame || "vnb", d);
      const mag = V.mag(dv);
      if (mag === 0) { warn(seg, "Zero Δv — segment has no effect."); return; }
      if (mag > 15) warn(seg, `Δv of ${mag.toFixed(1)} km/s in one impulse is beyond any chemical stage.`);
      seg._info.dv = mag;
      applyDv(ctx, segIdx, dv, `Maneuver — Δv ${mag.toFixed(3)} km/s (${seg.frame || "vnb"})`);
      const coe = A.rvToCoe(ctx.state.v ? ctx.state.r : s.r, ctx.state.v, BODIES[s.cen].mu);
      if (coe.rp < BODIES[s.cen].radius && coe.e < 1)
        warn(seg, `Resulting periapsis (${fmtKm(coe.rp - BODIES[s.cen].radius)}) is below the surface.`);
    },

    hohmann(seg, ctx, segIdx) {
      if (!requireFlying(ctx, seg)) return;
      const s = ctx.state;
      const mu = BODIES[s.cen].mu;
      const rm = V.mag(s.r);
      const rT = +seg.rTargetKm || 0;
      if (rT <= BODIES[s.cen].radius) { warn(seg, "Target radius is inside the body.", "error"); return; }
      const coe0 = A.rvToCoe(s.r, s.v, mu);
      if (coe0.e > 0.05) warn(seg, `Start orbit e=${coe0.e.toFixed(3)} — Hohmann math assumes circular.`);
      const h = A.hohmann(mu, rm, rT);
      seg._info.hohmann = h;
      // burn 1: set speed along current velocity direction to transfer speed
      const vHat = V.norm(s.v);
      const vTrans = A.visViva(mu, rm, h.aTransfer);
      const dv1 = V.sub(V.scale(vHat, vTrans), s.v);
      applyDv(ctx, segIdx, dv1, `Hohmann burn 1 — Δv ${V.mag(dv1).toFixed(3)} km/s`);
      const res = propagateArc(ctx, h.tof, { segIdx, mode: "kepler" });
      if (res.reason !== "time") { warn(seg, "Transfer interrupted (impact or SOI change)."); return; }
      // burn 2: circularize at current radius
      const s2 = ctx.state;
      const r2 = V.mag(s2.r);
      const tHat = V.norm(V.cross(V.cross(s2.r, s2.v), s2.r));
      const dv2 = V.sub(V.scale(tHat, A.circularSpeed(mu, r2)), s2.v);
      applyDv(ctx, segIdx, dv2, `Hohmann burn 2 (circularize) — Δv ${V.mag(dv2).toFixed(3)} km/s`);
      if (Math.abs(r2 - rT) / rT > 0.02)
        warn(seg, `Arrived at r=${fmtKm(r2)} vs target ${fmtKm(rT)} (perturbed by SOI events?).`);
    },

    transfer(seg, ctx, segIdx) {
      if (!requireFlying(ctx, seg)) return;
      const s = ctx.state;
      const tgt = BODIES[seg.target];
      if (!tgt) { warn(seg, "Unknown target body.", "error"); return; }
      if (tgt.parent !== s.cen) {
        warn(seg, `${tgt.name} does not orbit ${BODIES[s.cen].name} — ` +
          "use Depart for interplanetary legs.", "error");
        return;
      }
      const tof = (+seg.tofDays || 0) * DAY;
      if (tof <= 0) { warn(seg, "Time of flight must be > 0.", "error"); return; }
      const targetMode = String(seg.targetMode || "off");
      const periInput = targetMode === "arrival-periapsis"
        ? seg.targetValue : seg.periKm;
      const peri = periInput === "" || periInput === null || periInput === undefined
        ? null : +periInput;
      const mu = BODIES[s.cen].mu;

      // 1) choose the ignition point along the current orbit (min |Δv|)
      // (heliocentric legs scan further: deep-space maneuvers sit near aphelion)
      if ((seg.optWait || "optimal") === "optimal") {
        const tau = bestBurnWait(ctx, (s.cen === "sun" ? 450 : 200) * DAY, (st, tAbs) => {
          const jd2 = jdAt(ctx, tAbs + tof);
          const rT2 = relBodyState(tgt.id, s.cen, jd2).r;
          const L = A.lambert(st.r, rT2, tof, mu, true);
          return L ? V.mag(V.sub(L.v1, st.v)) : null;
        });
        if (tau > 1) {
          const res0 = propagateArc(ctx, tau, { segIdx, mode: "kepler" });
          seg._info.waitS = tau;
          if (res0.reason !== "time") warn(seg, "Wait coast interrupted before ignition point.");
        }
      }

      // 2) solve with periapsis targeting from the actual ignition state
      const sol = solveTransfer(ctx, ctx.state.cen, tgt.id, tof, peri,
        seg.side || "A", seg.aimOffsetKm);
      if (!sol) { warn(seg, "Lambert solver found no solution (try a different TOF).", "error"); return; }
      if (sol.targetingFailed && sol.fixedAim) {
        warn(seg, sol.outsideSoi
          ? "The requested periapsis lies outside the target sphere of influence."
          : "The fixed B-plane aim does not enter the target sphere of influence.", "error");
        return;
      }
      if (sol.targetingFailed) warn(seg, "Periapsis targeting failed — aiming at body center instead.");
      if (sol.high) warn(seg, `Closest approach ${fmtKm(sol.rp - tgt.radius)} — cannot get as low as requested with this TOF.`);
      const sNow = ctx.state;
      const dv = V.sub(sol.v1, sNow.v);
      const mag = V.mag(dv);
      seg._info.dv = mag;
      seg._info.c3 = A.c3FromState(mu, V.mag(sNow.r), V.mag(sol.v1));
      seg._info.rpTargeted = sol.rp;
      seg._info.aimOffsetKm = sol.offsetKm;
      seg._info.fixedAim = !!sol.fixedAim;
      if (targetMode === "arrival-periapsis") {
        seg._info.targetStatus = sol.targetingConverged ? "converged" : "failed";
        seg._info.targetIterations = sol.iterations || 0;
        seg._info.targetAchieved = isFinite(sol.rp) ? sol.rp - tgt.radius : null;
        seg._info.targetResidual = sol.residualKm;
        if (!sol.targetingConverged)
          warn(seg, "Vary/Achieve could not meet the requested arrival periapsis within 1 km; adjust the staged departure date or TOF.", "error");
      }
      if (mag > 15) warn(seg, `Δv ${mag.toFixed(1)} km/s — check TOF (too short/long makes transfers expensive).`);
      applyDv(ctx, segIdx, dv,
        `Transfer injection → ${tgt.name} — Δv ${mag.toFixed(3)} km/s, ` +
        `C3 ${seg._info.c3.toFixed(2)} km²/s²`, { target: tgt.id });

      // 3) coast until the target's SOI (following segments take over inside)
      const res = propagateArc(ctx, Math.max(tof * 1.35, tof + 0.5 * DAY),
        { segIdx, mode: "kepler", stop: { type: "soi_of", target: tgt.id } });
      if (ctx.state.cen !== tgt.id && !ctx.crashed)
        warn(seg, `Did not enter ${tgt.name}'s SOI — trajectory misses the target ` +
          `(reason: ${res.reason}).`);
      seg._targetBody = tgt.id;
    },

    depart(seg, ctx, segIdx) {
      if (!requireFlying(ctx, seg)) return;
      const start = ctx.state;
      const body = BODIES[start.cen];
      if (!body.parent) {
        warn(seg, "Already in the top-level (Sun) frame — use Transfer.", "error");
        return;
      }
      const parentId = body.parent;
      const parent = BODIES[parentId];
      const target = BODIES[seg.target];
      if (!target) { warn(seg, "Unknown target body.", "error"); return; }
      if (target.parent !== parentId) {
        warn(seg, `${target.name} does not orbit ${parent.name}.`, "error");
        return;
      }
      const tof = (+seg.tofDays || 0) * DAY;
      if (!(tof > 0)) { warn(seg, "Time of flight must be > 0.", "error"); return; }
      const arrivalT = start.t + tof;
      const peri = seg.periKm === "" || seg.periKm === null || seg.periKm === undefined
        ? null : +seg.periKm;
      const exitRadius = body.soi;
      if (!isFinite(exitRadius) || exitRadius <= V.mag(start.r)) {
        warn(seg, `${body.name} has no usable SOI for a patched-conic departure.`, "error");
        return;
      }

      /* Seed the coupled solve with the reviewed B-plane target and outgoing
       * parent-frame velocity at the original date-pinned departure epoch. */
      const savedState = ctx.state;
      const bodyState0 = relBodyState(start.cen, parentId, jdAt(ctx, start.t));
      const solveFrom = (parentR) => {
        ctx.state = {
          cen: parentId, r: parentR, v: V.clone(bodyState0.v),
          t: start.t, landed: false,
        };
        return solveTransfer(ctx, parentId, target.id, tof, peri,
          seg.side || "A", seg.aimOffsetKm);
      };
      let seed = solveFrom(V.add(bodyState0.r, start.r));
      if (!seed) {
        ctx.state = savedState;
        warn(seg, "Lambert solver found no solution (try a different TOF/epoch).", "error");
        return;
      }
      if (seed.targetingFailed && seed.fixedAim) {
        ctx.state = savedState;
        warn(seg, seed.outsideSoi
          ? "The requested arrival periapsis lies outside the target sphere of influence."
          : "The fixed B-plane aim does not enter the target sphere of influence.", "error");
        return;
      }
      let exitDirection = V.norm(V.sub(seed.v1, bodyState0.v));
      for (let i = 0; i < 5; i++) {
        seed = solveFrom(V.add(bodyState0.r, V.scale(exitDirection, exitRadius)));
        if (!seed) break;
        const next = V.norm(V.sub(seed.v1, bodyState0.v));
        const dot = Math.max(-1, Math.min(1, V.dot(exitDirection, next)));
        exitDirection = next;
        if (Math.acos(dot) < 1e-9) break;
      }
      ctx.state = savedState;
      if (!seed) {
        warn(seg, "Lambert solver could not seed the departure-SOI solution.", "error");
        return;
      }
      const seedExitV = V.sub(seed.v1, bodyState0.v);
      if (!(V.mag(seedExitV) * V.mag(seedExitV) -
          (2 * body.mu) / exitRadius > 0)) {
        warn(seg, "Departure SOI solution is not hyperbolic.", "error");
        return;
      }

      let plan = continuousDeparturePlan(ctx, start, parentId, arrivalT,
        seed.aim, seedExitV, exitRadius);
      if (!plan) {
        warn(seg, "Could not solve a continuous local escape to the departure SOI.", "error");
        return;
      }
      // Recompute the periapsis aim from the planned, dated SOI boundary, then
      // close the local/parent velocity match once more against that aim.
      const plannedBodyState = relBodyState(start.cen, parentId,
        jdAt(ctx, plan.exitT));
      ctx.state = {
        cen: parentId,
        r: V.add(plannedBodyState.r, plan.exitR),
        v: V.clone(plan.parentLeg.v1),
        t: plan.exitT,
        landed: false,
      };
      let targeted = solveTransfer(ctx, parentId, target.id,
        arrivalT - plan.exitT, peri, seg.side || "A", seg.aimOffsetKm);
      ctx.state = savedState;
      if (targeted) {
        const refined = continuousDeparturePlan(ctx, start, parentId, arrivalT,
          targeted.aim, seedExitV, exitRadius);
        if (refined) plan = refined;
      } else targeted = seed;

      if (plan.wait > 1) {
        const waited = propagateArc(ctx, plan.wait, { segIdx, mode: "kepler" });
        seg._info.waitS = plan.wait;
        if (waited.reason !== "time") {
          warn(seg, "Parking-orbit wait was interrupted before the departure burn.", "error");
          return;
        }
      }
      const burnDv = V.sub(plan.local.L.v1, ctx.state.v);
      const dvInj = V.mag(burnDv);
      const postSpeed = V.mag(plan.local.L.v1);
      const c3 = postSpeed * postSpeed - (2 * body.mu) / V.mag(ctx.state.r);
      const vInf = Math.sqrt(Math.max(0, c3));
      const vEsc = A.escapeSpeed(body.mu, V.mag(ctx.state.r));
      seg._info.c3 = c3;
      seg._info.vInf = vInf;
      seg._info.dv = dvInj;
      seg._info.vEsc = vEsc;
      seg._info.escapeCoastS = plan.local.tof;
      if (dvInj > 12)
        warn(seg, `Injection Δv ${dvInj.toFixed(1)} km/s — real missions would use gravity assists.`);

      const departureEvent = applyDv(ctx, segIdx, burnDv,
        `${body.name} departure → ${target.name} — Δv ${dvInj.toFixed(3)} km/s, ` +
        `C3 ${c3.toFixed(1)} km²/s² (v∞ ${vInf.toFixed(2)} km/s, v_esc ${vEsc.toFixed(2)} km/s)`,
        { target: target.id });
      departureEvent._burn.handoff = true;
      departureEvent._burn.continuousSoi = true;
      departureEvent._burn.exitR = V.clone(plan.exitR);
      departureEvent._burn.exitV = V.clone(plan.local.L.v2);
      departureEvent._burn.exitT = departureEvent.t + plan.local.tof;
      addEvent(ctx, segIdx, "note",
        `Continuous patched-conic escape: ${body.name}-frame hyperbolic coast to the SOI ` +
        `takes ${(plan.local.tof / DAY).toFixed(2)} d; the dated arrival epoch is retained.`);

      const escaped = propagateArc(ctx, Math.max(plan.local.tof * 1.02,
        plan.local.tof + 60),
        { segIdx, mode: "kepler", stop: { type: "soi_of", target: parentId } });
      if (escaped.reason !== "soi_of" || ctx.state.cen !== parentId) {
        warn(seg, `Did not exit ${body.name}'s SOI on the solved hyperbola ` +
          `(reason: ${escaped.reason}).`, "error");
        return;
      }

      const remainingTof = arrivalT - ctx.state.t;
      targeted = solveTransfer(ctx, parentId, target.id, remainingTof,
        peri, seg.side || "A", seg.aimOffsetKm);
      if (!targeted) {
        warn(seg, "Lambert solver lost the dated target after the SOI handoff.", "error");
        return;
      }
      if (targeted.targetingFailed)
        warn(seg, targeted.fixedAim
          ? "The fixed B-plane aim does not enter the target sphere of influence."
          : "Arrival periapsis targeting failed — aiming at body center.",
        targeted.fixedAim ? "error" : undefined);
      if (targeted.targetingFailed && targeted.fixedAim) return;
      if (targeted.high)
        warn(seg, `Closest approach ${fmtKm(targeted.rp - target.radius)} — ` +
          "cannot get as low as requested with this TOF.");
      const patchDv = V.sub(targeted.v1, ctx.state.v);
      const patchMag = V.mag(patchDv);
      if (patchMag > 1e-8) {
        ctx.state.v = V.clone(targeted.v1);
        ctx.totalDv += patchMag;
        seg._info.dv += patchMag;
        addEvent(ctx, segIdx, "burn",
          `${body.name} SOI patch correction — Δv ${patchMag.toFixed(6)} km/s`,
          { dv: patchMag, target: target.id, body: parentId,
            patchCorrection: true });
        pushSample(ctx, segIdx);
      }
      seg._info.patchDv = patchMag;
      seg._info.rpTargeted = targeted.rp;
      seg._info.aimOffsetKm = targeted.offsetKm;
      seg._info.fixedAim = !!targeted.fixedAim;
      const res = propagateArc(ctx, Math.max(remainingTof * 1.25,
        remainingTof + 2 * DAY),
        { segIdx, mode: "kepler", stop: { type: "soi_of", target: target.id } });
      if (ctx.state.cen !== target.id && !ctx.crashed)
        warn(seg, `Did not enter ${target.name}'s SOI — trajectory misses the target ` +
          `(reason: ${res.reason}).`);
      seg._targetBody = target.id;
    },

    // Retained temporarily as a readable reference for old saved-result
    // metadata. Recomputed missions use the continuous implementation above.
    insertion(seg, ctx, segIdx) {
      if (!requireFlying(ctx, seg)) return;
      const at = seg.at === "apoapsis" ? "apoapsis" : "periapsis";
      const maxS = Math.max(+seg.maxDays || 5, 0.001) * DAY;
      const res = propagateArc(ctx, maxS, { segIdx, stop: { type: at } });
      if (res.reason !== at) {
        warn(seg, res.reason === "crash"
          ? `Impacted before ${at}!`
          : `${at} not reached in the wait limit — burn skipped` +
            (at === "apoapsis" ? " (hyperbolic arrivals never reach apoapsis — burn at periapsis)." : "."),
          "error");
        return;
      }
      const s = ctx.state;
      const body = BODIES[s.cen];
      const rm = V.mag(s.r);
      if (rm < body.radius) { warn(seg, `${at} is below the surface!`, "error"); return; }
      const tHat = V.norm(V.cross(V.cross(s.r, s.v), s.r)); // horizontal, in-plane
      let vNew, label;
      const targetMode = String(seg.targetMode || "off");
      if (targetMode !== "off") {
        const rawTarget = +seg.targetValue;
        if (!(rawTarget > 0)) {
          warn(seg, "Target solver value must be positive.", "error");
          return;
        }
        const target = targetMode === "period" ? rawTarget * 3600 : body.radius + rawTarget;
        let solved;
        try {
          solved = Targeting.solveInsertionImpulse({
            r: s.r,
            v: s.v,
            mu: body.mu,
            at,
            goal: targetMode === "period" ? "period" : "opposite-apsis",
            target,
          });
        } catch (error) {
          warn(seg, `Target solver failed: ${error.message}`, "error");
          return;
        }
        if (!solved.converged) {
          warn(seg, `Target solver did not converge (${solved.report.status}).`, "error");
          return;
        }
        vNew = solved.finalV;
        label = targetMode === "period"
          ? `targeted ${(solved.achievedPeriod / 3600).toFixed(3)} h period`
          : `targeted opposite apsis ${fmtKm(solved.achievedOppositeRadius - body.radius)}`;
        seg._info.targetStatus = solved.report.status;
        seg._info.targetIterations = solved.report.iterations;
        seg._info.targetResidual = solved.report.residual;
        seg._info.targetAchieved = targetMode === "period"
          ? solved.achievedPeriod / 3600
          : solved.achievedOppositeRadius - body.radius;
      } else if ((seg.shape || "circular") === "circular") {
        vNew = V.scale(tHat, A.circularSpeed(body.mu, rm));
        label = `circular ${fmtKm(rm - body.radius)} orbit`;
      } else {
        const rOther = body.radius + Math.max(+seg.apoKm || 0, 0);
        const a = 0.5 * (rm + rOther);
        if (a <= body.radius) { warn(seg, "Target orbit is inside the body.", "error"); return; }
        vNew = V.scale(tHat, A.visViva(body.mu, rm, a));
        label = `${fmtKm(Math.min(rm, rOther) - body.radius)} × ${fmtKm(Math.max(rm, rOther) - body.radius)} orbit`;
      }
      const dv = V.sub(vNew, s.v);
      seg._info.dv = V.mag(dv);
      if (V.mag(dv) > 8) warn(seg, `Insertion Δv ${V.mag(dv).toFixed(1)} km/s is very high — arrival v∞ too large?`);
      applyDv(ctx, segIdx, dv,
        `${body.name} orbit insertion at ${at} (${label}) — Δv ${V.mag(dv).toFixed(3)} km/s`,
        { body: s.cen });
      seg._targetBody = s.cen;
    },

    flyby(seg, ctx, segIdx) {
      if (!requireFlying(ctx, seg)) return;
      const s = ctx.state;
      const body = BODIES[s.cen];
      if (!body.parent) {
        warn(seg, "In the Sun's frame — a flyby happens inside a body's SOI. " +
          "Precede this with a Transfer/Depart that targets a flyby periapsis.", "error");
        return;
      }
      const parentId = body.parent;
      const maxS = Math.max(+seg.maxDays || 40, 0.01) * DAY;

      // incoming asymptotic state (planet frame + parent frame)
      const jd0 = jdAt(ctx, s.t);
      const bs0 = A.bodyLocalState(s.cen, jd0);
      const vRelIn = V.clone(s.v);              // planet-frame velocity ≈ v∞ direction
      const vParIn = V.add(bs0.v, s.v);         // parent-frame velocity
      const E0 = (V.mag(s.v) ** 2) / 2 - body.mu / V.mag(s.r);
      if (E0 <= 0) {
        warn(seg, `The orbit about ${body.name} is bound (captured) — that is not a ` +
          "flyby. Use Insertion, or retarget the encounter periapsis.", "error");
        return;
      }
      const vInfIn = Math.sqrt(2 * E0);

      // 1) coast to the encounter periapsis (skip if already outbound)
      let spent = 0;
      if (V.dot(s.r, s.v) < 0) {
        const t0 = ctx.state.t;
        const res1 = propagateArc(ctx, maxS, { segIdx, mode: "kepler", stop: { type: "periapsis" } });
        spent = ctx.state.t - t0;
        if (res1.reason === "crash") {
          warn(seg, `Flyby impacts ${body.name} — raise the encounter periapsis ` +
            "(periKm on the preceding Transfer/Depart).", "error");
          return;
        }
        if (res1.reason === "periapsis" && ctx.state.cen === body.id) {
          const rp = V.mag(ctx.state.r);
          seg._info.rpAlt = rp - body.radius;
          addEvent(ctx, segIdx, "flyby",
            `${body.name} flyby — periapsis alt ${fmtKm(rp - body.radius)}, ` +
            `v ${V.mag(ctx.state.v).toFixed(2)} km/s`, { body: body.id });
          const dvv = +seg.dvKms || 0;
          if (dvv) {
            const dv = V.scale(V.norm(ctx.state.v), dvv);
            applyDv(ctx, segIdx, dv,
              `Powered flyby at ${body.name} periapsis — Δv ${Math.abs(dvv).toFixed(3)} km/s (Oberth)`);
          }
        }
      } else {
        warn(seg, "Already outbound (past periapsis) — coasting straight to SOI exit.");
      }

      // 2) coast out of the SOI
      if (ctx.state.cen === body.id) {
        const res2 = propagateArc(ctx, Math.max(maxS - spent, 60), {
          segIdx, mode: "kepler", stop: { type: "soi_of", target: parentId },
        });
        if (ctx.state.cen === body.id) {
          warn(seg, `Did not exit ${body.name}'s SOI within the time limit ` +
            `(reason: ${res2.reason}) — increase the limit.`, "error");
          return;
        }
        if (ctx.state.cen !== parentId) {
          warn(seg, `Exited into ${BODIES[ctx.state.cen].name}'s frame instead of ` +
            `${BODIES[parentId].name}'s — unusual geometry; check the trajectory.`);
        }
      }

      // 3) gravity-assist report (patched-conic: |v∞ out| should equal |v∞ in|
      //    for an unpowered flyby; the rotation of v∞ is the assist)
      const jd1 = jdAt(ctx, ctx.state.t);
      const bs1 = A.bodyLocalState(body.id, jd1);
      const vRelOut = V.sub(ctx.state.v, bs1.v);
      const vParOut = V.clone(ctx.state.v);
      // energy-based v∞ (speed at the SOI still contains −μ/r_SOI potential)
      const rRelOut = V.sub(ctx.state.r, bs1.r);
      const E1 = (V.mag(vRelOut) ** 2) / 2 - body.mu / Math.max(V.mag(rRelOut), 1);
      const vInfOut = E1 > 0 ? Math.sqrt(2 * E1) : V.mag(vRelOut);
      const cosT = Math.min(1, Math.max(-1,
        V.dot(V.norm(vRelIn), V.norm(vRelOut))));
      const turnDeg = Math.acos(cosT) / C.DEG;
      const assistDv = V.mag(V.sub(vParOut, vParIn));
      const speedGain = V.mag(vParOut) - V.mag(vParIn);
      seg._info.vInfIn = vInfIn;
      seg._info.vInfOut = vInfOut;
      seg._info.turnDeg = turnDeg;
      seg._info.assistDv = assistDv;
      seg._info.speedGain = speedGain;
      addEvent(ctx, segIdx, "note",
        `Gravity assist at ${body.name}: v∞ ${vInfIn.toFixed(2)} → ${vInfOut.toFixed(2)} km/s, ` +
        `bent ${turnDeg.toFixed(1)}°; ${BODIES[parentId].name}-frame speed ` +
        `${speedGain >= 0 ? "+" : ""}${speedGain.toFixed(2)} km/s (free Δv ≈ ${assistDv.toFixed(2)} km/s)`);
      seg._targetBody = body.id;
    },

    observe(seg, ctx, segIdx) {
      if (!requireFlying(ctx, seg)) return;
      const tgt = BODIES[seg.target];
      if (!tgt) { warn(seg, "Unknown target body.", "error"); return; }
      const dur = Math.max(+seg.days || 0, 0.001) * DAY;
      addEvent(ctx, segIdx, "obs", `Observation start — ${tgt.name}`, { body: seg.target });
      const res = propagateArc(ctx, dur, { mode: seg.mode, segIdx });
      if (res.reason === "crash") warn(seg, "Impacted the surface during the observation!", "error");
      if (res.reason === "transitions") warn(seg, "Too many SOI transitions during the observation.", "error");
      addEvent(ctx, segIdx, "obs", `Observation end — ${tgt.name}`, { body: seg.target });
      seg._targetBody = seg.target;
    },

    return(seg, ctx, segIdx) {
      if (!requireFlying(ctx, seg)) return;
      const s = ctx.state;
      const tgt = BODIES[seg.target];
      if (!tgt) { warn(seg, "Unknown target body.", "error"); return; }
      const tof = (+seg.tofDays || 0) * DAY;
      if (tof <= 0) { warn(seg, "Time of flight must be > 0.", "error"); return; }
      const rpTarget = tgt.radius + (+seg.periKm || 40);
      const muT = tgt.mu;

      if (tgt.id === s.cen) {
        /* ---- direct branch: correction burn in the target's own frame ---- *
         * The Lambert endpoint must be tangent to the requested periapsis
         * circle. An endpoint radius alone does not define an apsis.        */
        const solveFrom = (st) => {
          const best = Targeting.solveLambertToPeriapsis({
            r1: st.r,
            vCurrent: st.v,
            tof,
            mu: muT,
            rpTarget,
          }).best;
          return best ? Object.assign({ mag: best.dv }, best) : null;
        };
        if ((seg.optWait || "optimal") === "optimal") {
          const tau = bestBurnWait(ctx, 2.5 * DAY, (st) => {
            // Rank ignition cheaply; the exact tangent solve is reserved for
            // the final state so this 180-point scan remains interactive.
            const hHat = V.norm(V.cross(st.r, st.v));
            const uPerp = V.norm(V.cross(hHat, st.r));
            let mag = Infinity;
            for (const sign of [1, -1]) for (const prograde of [true, false]) {
              const lambert = A.lambert(st.r, V.scale(uPerp, sign * rpTarget),
                tof, muT, prograde);
              if (lambert) mag = Math.min(mag,
                V.mag(V.sub(lambert.v1, st.v)));
            }
            return isFinite(mag) ? mag : null;
          });
          if (tau > 1) { propagateArc(ctx, tau, { segIdx, mode: "kepler" }); seg._info.waitS = tau; }
        }
        const best = solveFrom(ctx.state);
        if (!best) { warn(seg, "No return solution found — try a different TOF.", "error"); return; }
        seg._info.dv = best.dv;
        seg._info.rpTargeted = best.rpAchieved;
        seg._info.arrivalRadialSpeed = best.radialSpeed;
        if (best.mag > 5) warn(seg, `Return Δv ${best.mag.toFixed(1)} km/s is high — adjust TOF.`);
        const targetingPrefix = seg.proxyStateLabel || "Return targeting";
        applyDv(ctx, segIdx, best.dvVec,
          `${targetingPrefix} → ${tgt.name} (periapsis ${(+seg.periKm || 40).toFixed(0)} km) — ` +
          `Δv ${best.mag.toFixed(3)} km/s`, { target: tgt.id });
        propagateArc(ctx, tof * 0.92, { segIdx, mode: "kepler" });

      } else if (BODIES[s.cen].parent === tgt.id) {
        if (executeContinuousChildReturn(seg, ctx, segIdx, tgt, tof, rpTarget))
          return;
        /* ---- escape branch (e.g. trans-Earth injection from lunar orbit) --
         * Patched conics: solve the parent-frame Lambert from the moon's
         * position, take v∞ = v_required − v_moon, and burn onto the escape
         * hyperbola with Δv = √(v∞² + 2μ/r) − v_orbit (periapsis-aligned
         * escape approximation, mirroring the Departure segment).           */
        const cen = BODIES[s.cen];
        const evalEsc = (st, tAbs) => {
          const bs = A.bodyLocalState(s.cen, jdAt(ctx, tAbs));
          const r1 = V.add(bs.r, st.r);
          const hHat = V.norm(V.cross(r1, V.add(bs.v, st.v)));
          const uPerp = V.norm(V.cross(hHat, r1));
          let best = null;
          for (const sgn of [1, -1]) for (const pro of [true, false]) {
            const L = A.lambert(r1, V.scale(uPerp, sgn * rpTarget), tof, muT, pro);
            if (!L) continue;
            const vInf = V.mag(V.sub(L.v1, bs.v));
            const dv = Math.sqrt(vInf * vInf + (2 * cen.mu) / V.mag(st.r)) - V.mag(st.v);
            if (!best || dv < best.dv) best = { dv, vInf, v1: L.v1, r1 };
          }
          return best;
        };
        if ((seg.optWait || "optimal") === "optimal") {
          const tau = bestBurnWait(ctx, 2.5 * DAY, (st, tAbs) => {
            const b = evalEsc(st, tAbs); return b ? Math.abs(b.dv) : null;
          });
          if (tau > 1) { propagateArc(ctx, tau, { segIdx, mode: "kepler" }); seg._info.waitS = tau; }
        }
        const st = ctx.state;
        const best = evalEsc(st, st.t);
        if (!best) { warn(seg, "No return solution found — try a different TOF.", "error"); return; }
        const dvC = Math.max(best.dv, 0);
        if (best.dv < 0)
          warn(seg, "Already faster than the required escape — burn treated as timing-only (Δv ≈ 0).");
        seg._info.dv = dvC; seg._info.vInf = best.vInf;
        if (dvC > 5) warn(seg, `Return injection Δv ${dvC.toFixed(1)} km/s is high — adjust TOF.`);
        ctx.totalDv += dvC;
        // The solver hands directly from the moon/planet frame to the parent
        // Lambert arc. Retain an equivalent local prograde escape impulse so
        // the renderer can show a labelled, gradual apoapsis-raising preview
        // without changing that instantaneous patched-conic solution.
        const previewV1 = V.scale(V.norm(st.v), V.mag(st.v) + dvC);
        addEvent(ctx, segIdx, "burn",
          `Trans-${tgt.name} injection — Δv ${dvC.toFixed(3)} km/s ` +
          `(v∞ ${best.vInf.toFixed(2)} km/s, periapsis target ${(+seg.periKm || 40).toFixed(0)} km)`,
          {
            dv: dvC, target: tgt.id, body: s.cen,
            _burn: {
              cen: st.cen,
              r: V.clone(st.r),
              v0: V.clone(st.v),
              v1: previewV1,
              t: st.t,
              handoff: true,
            },
          });
        addEvent(ctx, segIdx, "note",
          `Patched-conic escape from ${cen.name} SOI idealized as instantaneous.`);
        ctx.state = { cen: tgt.id, r: best.r1, v: best.v1, t: ctx.state.t, landed: false };
        pushSample(ctx, segIdx);
        // hand over to a correction burn / reentry for the final approach
        propagateArc(ctx, tof * 0.4, { segIdx, mode: "kepler" });

      } else {
        warn(seg, `Return targets the current central body or its parent ` +
          `(currently ${BODIES[s.cen].name}).`, "error");
        return;
      }
      seg._targetBody = tgt.id;
    },

    land(seg, ctx, segIdx) {
      if (!requireFlying(ctx, seg)) return;
      const s = ctx.state;
      const body = BODIES[s.cen];
      if (body.gasGiant) warn(seg, `${body.name} has no solid surface — 'landing' at the 1-bar level.`);
      const speed = V.mag(s.v);
      seg._info.dv = speed;
      ctx.totalDv += speed;
      ctx.lastOrbitNormal = V.norm(V.cross(s.r, s.v));
      addEvent(ctx, segIdx, "burn",
        `Deorbit & descent — Δv ≈ ${speed.toFixed(3)} km/s (idealized: full orbital velocity)`,
        { dv: speed, body: s.cen });
      // schematic descent arc: interpolate radius down to the surface
      const site = V.scale(V.norm(s.r), body.radius);
      const durDesc = Math.max(+seg.descentHours || 0.5, 0.01) * 3600;
      const n = 24;
      for (let i = 1; i <= n; i++) {
        const f = i / n;
        const rr = V.add(V.scale(s.r, 1 - f), V.scale(site, f));
        ctx.state = { cen: s.cen, r: rr, v: [0, 0, 0], t: s.t + f * durDesc, landed: i === n };
        pushSample(ctx, segIdx);
      }
      addEvent(ctx, segIdx, "landing", `Touchdown — ${body.name}`, { body: s.cen });
      const stay = Math.max(+seg.stayDays || 0, 0) * DAY;
      if (stay > 0) {
        const m = 12;
        const t0 = ctx.state.t;
        for (let i = 1; i <= m; i++) {
          ctx.state = { cen: s.cen, r: site, v: [0, 0, 0], t: t0 + (i / m) * stay, landed: true };
          pushSample(ctx, segIdx);
        }
      }
      seg._targetBody = s.cen;
      addEvent(ctx, segIdx, "note",
        `Surface stay ${(+seg.stayDays || 0).toFixed(2)} d (descent/landing dynamics not modeled)`);
    },

    ascend(seg, ctx, segIdx) {
      if (!requireState(ctx, seg)) return;
      if (!ctx.state.landed) warn(seg, "Not landed — Ascend replaces the current orbit anyway.");
      const s = ctx.state;
      const body = BODIES[s.cen];
      const a = body.radius + Math.max(+seg.altKm || 100, 1);
      const rHat = V.norm(s.r);
      let nHat = ctx.lastOrbitNormal || [0, 0, 1];
      if (Math.abs(V.dot(nHat, rHat)) > 0.98) nHat = [0, 1, 0];
      // orbit plane contains site direction; velocity ⟂ r within that plane
      const tHat = V.norm(V.cross(nHat, rHat));
      const vc = A.circularSpeed(body.mu, a);
      ctx.state = { cen: s.cen, r: V.scale(rHat, a), v: V.scale(tHat, vc), t: s.t, landed: false };
      seg._info.dv = vc * 1.1;
      ctx.totalDv += vc * 1.1;
      addEvent(ctx, segIdx, "liftoff",
        `Ascent — ${body.name} → ${fmtKm(a - body.radius)} circular orbit ` +
        `(Δv ≈ ${(vc * 1.1).toFixed(2)} km/s incl. ~10% losses)`, { dv: vc * 1.1, body: s.cen });
      pushSample(ctx, segIdx);
    },

    reentry(seg, ctx, segIdx) {
      if (!requireFlying(ctx, seg)) return;
      const s = ctx.state;
      const body = BODIES[s.cen];
      const rInterface = body.radius + (+seg.interfaceKm || 120);
      const coe = A.rvToCoe(s.r, s.v, body.mu);
      if (coe.rp > rInterface) {
        warn(seg, `Trajectory periapsis (${fmtKm(coe.rp - body.radius)}) never dips below the ` +
          `entry interface (${(+seg.interfaceKm || 120).toFixed(0)} km) — no reentry occurs.`, "error");
      }
      const res = propagateArc(ctx, Math.max(+seg.maxDays || 6, 0.01) * DAY, {
        segIdx, stop: { type: "radius_below", body: s.cen, radius: rInterface },
      });
      if (res.reason !== "radius_below") {
        if (res.reason !== "crash") warn(seg, "Entry interface not reached within the time limit.", "error");
        return;
      }
      const sv = ctx.state;
      const vEntry = V.mag(sv.v);
      addEvent(ctx, segIdx, "entry",
        `Entry interface — alt ${(+seg.interfaceKm || 120).toFixed(0)} km, v = ${vEntry.toFixed(2)} km/s`,
        { body: s.cen });
      // schematic descent
      const site = V.scale(V.norm(sv.r), body.radius);
      const durDesc = Math.max(+seg.descentMin || 20, 1) * 60;
      const n = 20;
      for (let i = 1; i <= n; i++) {
        const f = i / n;
        ctx.state = {
          cen: s.cen, r: V.add(V.scale(sv.r, 1 - f), V.scale(site, f)),
          v: V.scale(sv.v, (1 - f) * 0.2), t: sv.t + f * durDesc, landed: i === n,
        };
        pushSample(ctx, segIdx);
      }
      addEvent(ctx, segIdx, "splashdown",
        body.id === "earth" ? "Splashdown" : `Surface — ${body.name}`, { body: s.cen });
      ctx.ended = true;
      seg._targetBody = s.cen;
    },
  };

  function fmtKm(x) {
    if (!isFinite(x)) return "∞";
    if (Math.abs(x) >= 1e6) return (x / 1e6).toFixed(2) + "M km";
    if (Math.abs(x) >= 1e4) return Math.round(x).toLocaleString("en-US") + " km";
    return x.toFixed(1) + " km";
  }

  /* ============================= recompute ============================= */
  function recomputeVehicle(vehicle, mission, vehicleResults, vehicleDefs) {
    const spacecraft = vehicle.spacecraft || {};
    const wetMass = Math.max(0, +spacecraft.dryKg || 0) +
      Math.max(0, +spacecraft.propKg || 0);
    const vehicleMission = Object.assign({}, mission, {
      spacecraft,
      segments: vehicle.segments,
    });
    const ctx = {
      epochJD: A.dateToJD(mission.epoch),
      samples: [], events: [],
      state: null, crashed: false, ended: false,
      totalDv: 0, lastOrbitNormal: null,
      massKg: wetMass > 0 ? wetMass : null,
      mission: vehicleMission,
      gpSegments: Object.create(null),
      joinedSegments: Object.create(null),
      vehicleId: vehicle.id,
      vehicleName: vehicle.name,
      vehicleResults,
      vehicleDefs,
    };
    const segmentTimes = [];
    vehicle.segments.forEach((seg, idx) => {
      seg._warn = [];
      seg._info = {};
      seg._t0 = ctx.state ? ctx.state.t : 0;
      if (ctx.crashed || ctx.ended) {
        seg._warn.push({
          msg: ctx.crashed ? "Unreachable — the mission ended in an impact earlier."
                           : "Unreachable — the mission already ended.",
          level: "error",
        });
        seg._t1 = seg._t0;
        segmentTimes.push({ t0: seg._t0, t1: seg._t1, ok: false });
        return;
      }
      if (ctx.state && ctx.state.dockedTo && seg.type !== "coast" && seg.type !== "undock") {
        seg._warn.push({
          msg: `Vehicle is joined to '${ctx.state.dockedTo}'; Coast with the assembly or Undock before another maneuver.`,
          level: "error",
        });
        seg._t1 = seg._t0;
        segmentTimes.push({ t0: seg._t0, t1: seg._t1, ok: false });
        return;
      }
      const exec = SEG_EXEC[seg.type];
      if (!exec) {
        seg._warn.push({ msg: `Unknown segment type '${seg.type}'.`, level: "error" });
      } else {
        try { exec(seg, ctx, idx); }
        catch (e) {
          seg._warn.push({ msg: "Engine error: " + e.message, level: "error" });
        }
      }
      seg._t1 = ctx.state ? ctx.state.t : seg._t0;
      const ok = !(seg._warn || []).some((warning) => warning.level === "error");
      segmentTimes.push({ t0: seg._t0, t1: seg._t1, ok });
    });

    const tEnd = ctx.samples.length ? ctx.samples[ctx.samples.length - 1].t : 0;
    return {
      id: vehicle.id,
      name: vehicle.name,
      role: vehicle.role || (vehicle.id === "primary" ? "primary" : "vehicle"),
      color: vehicle.color || (vehicle.id === "primary" ? "#e95420" : "#52d4c5"),
      samples: ctx.samples,
      events: ctx.events.sort((a, b) => a.t - b.t),
      totalDv: ctx.totalDv,
      tEnd,
      epochJD: ctx.epochJD,
      crashed: ctx.crashed,
      ended: ctx.ended,
      cr3bpSystem: ctx.cr3bpSystem ? ctx.cr3bpSystem.id : null,
      cr3bpOrbit: ctx.cr3bpOrbit || null,
      gpSegments: ctx.gpSegments,
      joinedSegments: ctx.joinedSegments,
      segmentTimes,
      computeMs: 0,
    };
  }

  function recompute(mission) {
    const t0 = performance.now ? performance.now() : Date.now();
    if (!mission || !Array.isArray(mission.segments))
      throw new Error("Mission requires a segments array.");

    // JSON Schema defaults are descriptive; validators do not insert them.
    // Hydrate omitted fields here so schema-valid portable missions and UI-
    // constructed segments execute with the same deterministic defaults.
    const defaultOptions = { legacyLaunch: mission.format !== "mtp-mission-2" };
    for (const segment of mission.segments) applySegmentDefaults(segment, defaultOptions);
    for (const vehicle of Array.isArray(mission.vehicles) ? mission.vehicles : [])
      for (const segment of Array.isArray(vehicle.segments) ? vehicle.segments : [])
        applySegmentDefaults(segment, defaultOptions);

    const palette = ["#52d4c5", "#a371f7", "#e3b341", "#58a6ff", "#7ee787",
      "#f778ba", "#d2a8ff", "#ffa657"];
    const definitions = [{
      id: "primary",
      name: mission.spacecraft && mission.spacecraft.name || "Primary spacecraft",
      role: "primary",
      color: "#e95420",
      spacecraft: mission.spacecraft || {},
      segments: mission.segments,
    }];
    const usedIds = new Set(["primary"]);
    const missionWarnings = [];
    const additionalVehicles = Array.isArray(mission.vehicles) ? mission.vehicles : [];
    if (additionalVehicles.length > 7)
      missionWarnings.push("Only seven secondary vehicles are propagated; the mission limit is eight vehicles total.");
    for (let index = 0; index < Math.min(additionalVehicles.length, 7); index++) {
      const source = mission.vehicles[index] || {};
      const id = String(source.id || `vehicle${index + 1}`).trim();
      if (!id || id === "primary" || usedIds.has(id)) {
        missionWarnings.push(`Secondary vehicle #${index + 1} has a duplicate or reserved id '${id || "(blank)"}' and was skipped.`);
        continue;
      }
      usedIds.add(id);
      definitions.push({
        id,
        name: source.name || source.spacecraft && source.spacecraft.name || id,
        role: source.role || "vehicle",
        color: source.color || palette[index % palette.length],
        spacecraft: source.spacecraft || {},
        segments: Array.isArray(source.segments) ? source.segments : [],
      });
    }
    const vehicleDefs = Object.create(null);
    for (const definition of definitions) vehicleDefs[definition.id] = definition;

    const dependencies = (definition) => {
      const refs = new Set();
      for (const segment of definition.segments) {
        let ref = null;
        if (segment.type === "separate") ref = segment.fromVehicle;
        if (segment.type === "rendezvous" || segment.type === "dock")
          ref = segment.targetVehicle;
        ref = String(ref || "");
        if (ref && ref !== definition.id && vehicleDefs[ref]) refs.add(ref);
      }
      return refs;
    };

    const vehicleResults = Object.create(null);
    const pending = definitions.slice();
    while (pending.length) {
      let index = pending.findIndex((definition) =>
        Array.from(dependencies(definition)).every((id) => vehicleResults[id]));
      if (index < 0) {
        const ids = pending.map((definition) => definition.id).join(", ");
        missionWarnings.push(`Vehicle dependency cycle or unresolved target: ${ids}.`);
        for (const definition of pending.splice(0)) {
          const message = "Vehicle dependency cycle: this branch was not propagated.";
          const segmentTimes = definition.segments.map((segment) => {
            segment._warn = [{ msg: message, level: "error" }];
            segment._info = {};
            segment._t0 = 0;
            segment._t1 = 0;
            return { t0: 0, t1: 0, ok: false };
          });
          vehicleResults[definition.id] = {
            id: definition.id, name: definition.name, role: definition.role,
            color: definition.color, samples: [], events: [], totalDv: 0,
            tEnd: 0, epochJD: A.dateToJD(mission.epoch), crashed: false,
            ended: false, cr3bpSystem: null, cr3bpOrbit: null,
            gpSegments: Object.create(null), segmentTimes, computeMs: 0,
            joinedSegments: Object.create(null),
          };
        }
        break;
      }
      const definition = pending.splice(index, 1)[0];
      vehicleResults[definition.id] = recomputeVehicle(definition, mission,
        vehicleResults, vehicleDefs);
    }

    const primary = vehicleResults.primary;
    const allResults = Object.values(vehicleResults);
    const combinedEvents = allResults.flatMap((result) => result.events)
      .sort((a, b) => a.t - b.t || String(a.vehicleId).localeCompare(String(b.vehicleId)));
    const tEnd = allResults.reduce((maximum, result) => Math.max(maximum, result.tEnd), 0);
    const totalDv = allResults.reduce((sum, result) => sum + result.totalDv, 0);
    const ms = (performance.now ? performance.now() : Date.now()) - t0;
    for (const result of allResults) result.computeMs = ms;
    return Object.assign({}, primary, {
      events: combinedEvents,
      totalDv,
      primaryTotalDv: primary.totalDv,
      tEnd,
      crashed: allResults.some((result) => result.crashed),
      ended: primary.ended,
      computeMs: ms,
      vehicleResults,
      vehicleOrder: definitions.map((definition) => definition.id),
      vehicleWarnings: missionWarnings,
    });
  }

  /* ---- helpers used by the UI ---- */
  function sampleAtTime(result, t) {
    const ss = result.samples;
    if (!ss.length) return null;
    if (t <= ss[0].t) return { ...ss[0], interp: false };
    if (t >= ss[ss.length - 1].t) return { ...ss[ss.length - 1], interp: false };
    let lo = 0, hi = ss.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ss[mid].t <= t) lo = mid; else hi = mid;
    }
    const a = ss[lo], b = ss[hi];
    if (a.cen !== b.cen || b.t - a.t <= 0) return { ...b, interp: false };
    const span = b.t - a.t;
    const f = (t - a.t) / span;
    const lerp = (p, q) => [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f, p[2] + (q[2] - p[2]) * f];
    let r, v;
    const joined = a.seg === b.seg && a.dockedTo && a.dockedTo === b.dockedTo &&
      result.joinedSegments && result.joinedSegments[a.seg];
    if (joined && joined.providerResult && t >= joined.startT - 1e-9 &&
        t <= joined.endT + 1e-9) {
      const provider = sampleAtTime(joined.providerResult, t);
      if (provider) {
        const massKg = Number.isFinite(a.massKg) && Number.isFinite(b.massKg)
          ? a.massKg + (b.massKg - a.massKg) * f : null;
        return Object.assign({}, provider, {
          t,
          seg: a.seg,
          vehicleId: a.vehicleId || result.id || "primary",
          dockedTo: joined.targetId,
          massKg,
          r: V.clone(provider.r),
          v: V.clone(provider.v),
          w: provider.w ? V.clone(provider.w) : null,
          worldV: provider.worldV ? V.clone(provider.worldV) : provider.worldV,
          forceW: provider.forceW ? V.clone(provider.forceW) : provider.forceW,
          forceWorldV: provider.forceWorldV
            ? V.clone(provider.forceWorldV) : provider.forceWorldV,
          interp: true,
          joinedExact: true,
        });
      }
    }
    if (SGP4 && a.forceEphemeris === "gp-elements" &&
        b.forceEphemeris === "gp-elements" && a.seg === b.seg &&
        result.gpSegments && result.gpSegments[a.seg]) {
      const descriptor = result.gpSegments[a.seg];
      const jd = result.epochJD + t / DAY;
      const raw = SGP4.propagateDate(descriptor.record, A.jdToDate(jd), {
        maxAbsMinutes: SGP4.ABSOLUTE_MAX_ABS_MINUTES,
      });
      const local = temeStateToPlanner(raw);
      const earthR = A.bodyWorld("earth", jd);
      const earthV = A.bodyWorldVel("earth", jd);
      return {
        t, cen: "earth", seg: a.seg, landed: false,
        vehicleId: a.vehicleId || result.id || "primary",
        dockedTo: a.dockedTo && a.dockedTo === b.dockedTo ? a.dockedTo : null,
        r: local.r, v: local.v,
        w: V.add(earthR, local.r), worldV: V.add(earthV, local.v),
        massKg: Number.isFinite(a.massKg) && Number.isFinite(b.massKg)
          ? a.massKg + (b.massKg - a.massKg) * f : null,
        forceModel: descriptor.branch.toLowerCase(),
        forceEphemeris: "gp-elements", interp: true, exactModel: true,
      };
    } else if (a.forceModel && b.forceModel && a.worldV && b.worldV && a.cen === b.cen) {
      const f2 = f * f, f3 = f2 * f;
      const h00 = 2 * f3 - 3 * f2 + 1, h10 = f3 - 2 * f2 + f;
      const h01 = -2 * f3 + 3 * f2, h11 = f3 - f2;
      const dh00 = (6 * f2 - 6 * f) / span, dh10 = 3 * f2 - 4 * f + 1;
      const dh01 = (-6 * f2 + 6 * f) / span, dh11 = 3 * f2 - 2 * f;
      const aForceW = a.forceW || a.w, bForceW = b.forceW || b.w;
      const aForceV = a.forceWorldV || a.worldV;
      const bForceV = b.forceWorldV || b.worldV;
      const forceW = [0, 1, 2].map((index) => h00 * aForceW[index] +
        h10 * span * aForceV[index] + h01 * bForceW[index] +
        h11 * span * bForceV[index]);
      const forceWorldV = [0, 1, 2].map((index) => dh00 * aForceW[index] +
        dh10 * aForceV[index] + dh01 * bForceW[index] + dh11 * bForceV[index]);
      const jd = result.epochJD + t / DAY;
      const ephemeris = a.forceEphemeris === "planner-horizons"
        ? resolveForceEphemeris("planner-horizons")
        : resolveForceEphemeris("catalog");
      const center = forceBodyState(a.cen, jd, ephemeris);
      const r = V.sub(forceW, center.r);
      const v = V.sub(forceWorldV, center.v);
      const displayCenterR = A.bodyWorld(a.cen, jd);
      const displayCenterV = A.bodyWorldVel(a.cen, jd);
      const w = V.add(displayCenterR, r);
      const worldV = V.add(displayCenterV, v);
      return {
        t, cen: a.cen, seg: b.seg, landed: false,
        vehicleId: a.vehicleId || result.id || "primary",
        dockedTo: a.dockedTo && a.dockedTo === b.dockedTo ? a.dockedTo : null,
        r, v, w, worldV, forceW, forceWorldV,
        massKg: Number.isFinite(a.massKg) && Number.isFinite(b.massKg)
          ? a.massKg + (b.massKg - a.massKg) * f : null,
        forceModel: b.forceModel,
        forceEphemeris: b.forceEphemeris || "catalog",
        interp: true,
      };
    } else if (a.cr3bp && b.cr3bp && a.cr3bpSystem === b.cr3bpSystem &&
        a.synodic && b.synodic) {
      const system = R3.getSystem(a.cr3bpSystem);
      const h = span / system.timeUnitS;
      const f2 = f * f, f3 = f2 * f;
      const h00 = 2 * f3 - 3 * f2 + 1, h10 = f3 - 2 * f2 + f;
      const h01 = -2 * f3 + 3 * f2, h11 = f3 - f2;
      const dh00 = 6 * f2 - 6 * f, dh10 = 3 * f2 - 4 * f + 1;
      const dh01 = -6 * f2 + 6 * f, dh11 = 3 * f2 - 2 * f;
      const synodic = new Array(6);
      for (let index = 0; index < 3; index++) {
        synodic[index] = h00 * a.synodic[index] + h10 * h * a.synodic[index + 3] +
          h01 * b.synodic[index] + h11 * h * b.synodic[index + 3];
        synodic[index + 3] = (dh00 * a.synodic[index] +
          dh10 * h * a.synodic[index + 3] + dh01 * b.synodic[index] +
          dh11 * h * b.synodic[index + 3]) / h;
      }
      const embedded = cr3bpEmbeddedState(system, synodic, result.epochJD + t / DAY);
      return {
        t, cen: system.primaryId, seg: b.seg, landed: false,
        vehicleId: a.vehicleId || result.id || "primary",
        r: embedded.r, v: embedded.v, w: embedded.w,
        cr3bp: true, cr3bpSystem: system.id, synodic,
        interp: true,
      };
    } else if (b._interp === "kepler" && BODIES[a.cen] && !a.landed && !b.landed) {
      // Straight-line interpolation through a Kepler arc can miss the real
      // path by thousands of kilometres and corrupt osculating apsides.
      const st = A.propagateUniversal(a.r, a.v, t - a.t, BODIES[a.cen].mu);
      r = st.r; v = st.v;
    } else if (b._interp === "j2" && a.cen === "earth" &&
        !a.landed && !b.landed) {
      // J2 endpoints may be many revolutions apart on long coasts. Hermite
      // interpolation aliases those revolutions into a chord through Earth;
      // advance the same secular model analytically from the left endpoint.
      const st = propagateJ2State(a.r, a.v, t - a.t, BODIES.earth);
      r = st.r; v = st.v;
    } else if (b._interp === "rk4" && !a.landed && !b.landed) {
      // Cubic Hermite interpolation preserves both endpoint states for
      // numerically integrated arcs without rerunning the RK4 integrator.
      const f2 = f * f, f3 = f2 * f;
      const h00 = 2 * f3 - 3 * f2 + 1, h10 = f3 - 2 * f2 + f;
      const h01 = -2 * f3 + 3 * f2, h11 = f3 - f2;
      const dh00 = (6 * f2 - 6 * f) / span, dh10 = 3 * f2 - 4 * f + 1;
      const dh01 = (-6 * f2 + 6 * f) / span, dh11 = 3 * f2 - 2 * f;
      r = [0, 1, 2].map((i) => h00 * a.r[i] + h10 * span * a.v[i] +
        h01 * b.r[i] + h11 * span * b.v[i]);
      v = [0, 1, 2].map((i) => dh00 * a.r[i] + dh10 * a.v[i] +
        dh01 * b.r[i] + dh11 * b.v[i]);
    } else {
      r = lerp(a.r, b.r); v = lerp(a.v, b.v);
    }
    const w = a.cen === "sun" ? V.clone(r)
      : V.add(A.bodyWorld(a.cen, result.epochJD + t / DAY), r);
    return {
      t, cen: a.cen, seg: b.seg, landed: b.landed,
      vehicleId: a.vehicleId || result.id || "primary",
      dockedTo: a.dockedTo && a.dockedTo === b.dockedTo ? a.dockedTo : null,
      r, v, w,
      interp: true,
    };
  }

  function defaultSegment(type) {
    const spec = SEGMENT_TYPES[type];
    const seg = { type };
    for (const f of spec.fields) seg[f.k] = f.def;
    return seg;
  }

  function applySegmentDefaults(segment, options) {
    if (!segment || !SEGMENT_TYPES[segment.type]) return segment;
    for (const field of SEGMENT_TYPES[segment.type].fields || []) {
      // Before the ascent selector existed, a missing field meant the legacy
      // one-step circular insertion. Portable v2 files opt into schema defaults;
      // v1 and unversioned saved missions retain their historical meaning.
      if (options && options.legacyLaunch && segment.type === "launch" &&
          field.k === "ascent") continue;
      if (!Object.prototype.hasOwnProperty.call(segment, field.k) ||
          segment[field.k] === undefined)
        segment[field.k] = field.def;
    }
    return segment;
  }

  globalThis.MissionEngine = {
    SEGMENT_TYPES, recompute, sampleAtTime, defaultSegment, applySegmentDefaults, fmtKm,
    relBodyState, jdAt,
  };
})();
