/* =============================================================================
 * Mission Trajectory Planner — constants.js
 * Physical constants, the solar-system body catalog, and launch sites.
 *
 * Ephemeris model: Keplerian mean elements.
 *  - Planets: JPL "Keplerian Elements for Approximate Positions" (Standish),
 *    J2000 ecliptic frame, valid ~1800-2050. Only the mean-longitude rate is
 *    applied; secular rates of the other elements (<0.3 deg/century for most)
 *    are neglected. Positions are good to ~arcminutes/thousands of km, which
 *    is fine for mission visualization and patched-conic estimates, NOT for
 *    real navigation.
 *  - Moons: mean elements referenced (approximately) to the ecliptic.
 *    Real moon orbits precess about their planet's equator / Laplace plane;
 *    inclinations here are simplified. Mean anomalies at epoch are
 *    approximate (the Moon's is realistic; others are representative).
 *  - Dwarf planets & asteroids: osculating elements from the NASA/JPL
 *    Small-Body Database (SBDB, solution epochs noted per body), propagated
 *    as fixed two-body elements. Good to well under a degree over decades.
 *  - rotHours: sidereal rotation period (negative = retrograde spin).
 *    tiltDeg: axial tilt used for texture orientation (approximate; the
 *    node of the equator is not modeled).
 * Units: km, s, rad internally. AU and days at the UI boundary.
 * ========================================================================== */
"use strict";

(function () {
  const AU = 1.495978707e8;      // km
  const DAY = 86400;             // s
  const J2000_JD = 2451545.0;    // Julian date of J2000.0 epoch
  const DEG = Math.PI / 180;

  /* ---------------------------------------------------------------------------
   * Body catalog.
   * elements for planets: { aAU, e, iDeg, LDeg, LdotDegCy, wbarDeg, OmDeg }
   *   L = mean longitude, wbar = longitude of perihelion, Om = ascending node.
   *   M = L - wbar, argument of perihelion w = wbar - Om.
   * elements for moons:  { aKm, e, iDeg, OmDeg, wDeg, M0Deg, periodDays }
   *   (mean motion derived from the period; i referenced to ecliptic, approx.)
   * elements for small bodies (smallElements, JPL SBDB osculating):
   *   { aAU, e, iDeg, OmDeg, wDeg, M0Deg, epochJD, periodDays }
   * mu: GM (km^3/s^2), radius: mean radius (km).
   * ------------------------------------------------------------------------ */
  const BODIES = {
    sun: {
      id: "sun", name: "Sun", parent: null, mu: 1.32712440018e11,
      radius: 695700, color: "#ffd76e", glow: "#ffb52e", type: "star",
      rotHours: 609.12, tiltDeg: 7.25,
    },

    mercury: {
      id: "mercury", name: "Mercury", parent: "sun", mu: 22031.86855,
      radius: 2439.7, color: "#9c8d7f", type: "planet",
      rotHours: 1407.5, tiltDeg: 0.03,
      planetElements: { aAU: 0.38709927, e: 0.20563593, iDeg: 7.00497902,
        LDeg: 252.25032350, LdotDegCy: 149472.67411175,
        wbarDeg: 77.45779628, OmDeg: 48.33076593 },
    },
    venus: {
      id: "venus", name: "Venus", parent: "sun", mu: 324858.592,
      radius: 6051.8, color: "#e8c383", type: "planet",
      rotHours: -5832.4, tiltDeg: 2.64,
      planetElements: { aAU: 0.72333566, e: 0.00677672, iDeg: 3.39467605,
        LDeg: 181.97909950, LdotDegCy: 58517.81538729,
        wbarDeg: 131.60246718, OmDeg: 76.67984255 },
    },
    earth: {
      id: "earth", name: "Earth", parent: "sun", mu: 398600.4418,
      radius: 6371.0, color: "#4f8fd9", type: "planet",
      rotHours: 23.9345, tiltDeg: 23.44,
      /* Identifies the Earth-fixed pole/prime-meridian model. bodyFrameAt uses
       * its dedicated Vallado GMST branch (UTC approximates UT1; no EOP/polar
       * motion) rather than evaluating these generic TDB W coefficients. */
      iauOrientation: {
        poleRaDeg: [0, 0, 0],
        poleDecDeg: [90, 0, 0],
        primeMeridianDeg: [190.147, 360.9856235, 0],
      },
      atmosphereKm: 100, // Karman line, used for reentry interface default
      planetElements: { aAU: 1.00000261, e: 0.01671123, iDeg: -0.00001531,
        LDeg: 100.46457166, LdotDegCy: 35999.37244981,
        wbarDeg: 102.93768193, OmDeg: 0.0 },
    },
    moon: {
      id: "moon", name: "Moon", parent: "earth", mu: 4902.800066,
      radius: 1737.4, color: "#b8b8b8", type: "moon",
      rotHours: 655.72, tiltDeg: 6.68,
      moonElements: { aKm: 384400, e: 0.0549, iDeg: 5.145,
        OmDeg: 125.08, wDeg: 318.15, M0Deg: 134.96, periodDays: 27.321661 },
    },

    mars: {
      id: "mars", name: "Mars", parent: "sun", mu: 42828.375214,
      radius: 3389.5, color: "#d1683f", type: "planet",
      rotHours: 24.62296216, tiltDeg: 25.19,
      /* IAU 2000 body-fixed orientation used by the Horizons Mars surface
       * site records. Coefficients are RA/DEC per Julian century and prime
       * meridian W per ephemeris day from J2000 (NAIF mars_iau2000_v1.tpc). */
      iauOrientation: {
        poleRaDeg: [317.68143, -0.1061, 0],
        poleDecDeg: [52.88650, -0.0609, 0],
        primeMeridianDeg: [176.630, 350.89198226, 0],
      },
      planetElements: { aAU: 1.52371034, e: 0.09339410, iDeg: 1.84969142,
        LDeg: -4.55343205, LdotDegCy: 19140.30268499,
        wbarDeg: -23.94362959, OmDeg: 49.55953891 },
    },
    phobos: {
      id: "phobos", name: "Phobos", parent: "mars", mu: 7.087e-4,
      radius: 11.1, color: "#8a7a6c", type: "moon", rotHours: 7.6533,
      moonElements: { aKm: 9376, e: 0.0151, iDeg: 1.08,
        OmDeg: 0, wDeg: 0, M0Deg: 0, periodDays: 0.31891 },
    },
    deimos: {
      id: "deimos", name: "Deimos", parent: "mars", mu: 9.62e-5,
      radius: 6.2, color: "#93857a", type: "moon", rotHours: 30.312,
      moonElements: { aKm: 23463.2, e: 0.00033, iDeg: 1.79,
        OmDeg: 0, wDeg: 0, M0Deg: 130, periodDays: 1.263 },
    },

    jupiter: {
      id: "jupiter", name: "Jupiter", parent: "sun", mu: 1.26686534e8,
      radius: 69911, color: "#d8a56c", type: "planet", gasGiant: true,
      rotHours: 9.925, tiltDeg: 3.13,
      planetElements: { aAU: 5.20288700, e: 0.04838624, iDeg: 1.30439695,
        LDeg: 34.39644051, LdotDegCy: 3034.74612775,
        wbarDeg: 14.72847983, OmDeg: 100.47390909 },
    },
    io: {
      id: "io", name: "Io", parent: "jupiter", mu: 5959.916,
      radius: 1821.6, color: "#e8d167", type: "moon", rotHours: 42.459,
      moonElements: { aKm: 421800, e: 0.0041, iDeg: 0.05,
        OmDeg: 0, wDeg: 0, M0Deg: 0, periodDays: 1.769138 },
    },
    europa: {
      id: "europa", name: "Europa", parent: "jupiter", mu: 3202.739,
      radius: 1560.8, color: "#cbb9a0", type: "moon", rotHours: 85.228,
      moonElements: { aKm: 671100, e: 0.009, iDeg: 0.47,
        OmDeg: 0, wDeg: 0, M0Deg: 120, periodDays: 3.551181 },
    },
    ganymede: {
      id: "ganymede", name: "Ganymede", parent: "jupiter", mu: 9887.834,
      radius: 2634.1, color: "#9d9385", type: "moon", rotHours: 171.709,
      moonElements: { aKm: 1070400, e: 0.0013, iDeg: 0.20,
        OmDeg: 0, wDeg: 0, M0Deg: 240, periodDays: 7.154553 },
    },
    callisto: {
      id: "callisto", name: "Callisto", parent: "jupiter", mu: 7179.289,
      radius: 2410.3, color: "#7d7268", type: "moon", rotHours: 400.536,
      moonElements: { aKm: 1882700, e: 0.0074, iDeg: 0.19,
        OmDeg: 0, wDeg: 0, M0Deg: 60, periodDays: 16.689017 },
    },

    saturn: {
      id: "saturn", name: "Saturn", parent: "sun", mu: 3.7931187e7,
      radius: 58232, color: "#e3ce9e", type: "planet", gasGiant: true, rings: true,
      rotHours: 10.656, tiltDeg: 26.73,
      planetElements: { aAU: 9.53667594, e: 0.05386179, iDeg: 2.48599187,
        LDeg: 49.95424423, LdotDegCy: 1222.49362201,
        wbarDeg: 92.59887831, OmDeg: 113.66242448 },
    },
    enceladus: {
      id: "enceladus", name: "Enceladus", parent: "saturn", mu: 7.211,
      radius: 252.1, color: "#e8f0f2", type: "moon", rotHours: 32.885,
      moonElements: { aKm: 238040, e: 0.0047, iDeg: 0.01,
        OmDeg: 0, wDeg: 0, M0Deg: 0, periodDays: 1.370218 },
    },
    titan: {
      id: "titan", name: "Titan", parent: "saturn", mu: 8978.1382,
      radius: 2574.7, color: "#d6a44a", type: "moon", rotHours: 382.68,
      atmosphereKm: 600,
      moonElements: { aKm: 1221870, e: 0.0288, iDeg: 0.28,
        OmDeg: 0, wDeg: 0, M0Deg: 200, periodDays: 15.945421 },
    },

    uranus: {
      id: "uranus", name: "Uranus", parent: "sun", mu: 5.793939e6,
      radius: 25362, color: "#9fd6d9", type: "planet", gasGiant: true,
      rotHours: -17.24, tiltDeg: 97.77,
      planetElements: { aAU: 19.18916464, e: 0.04725744, iDeg: 0.77263783,
        LDeg: 313.23810451, LdotDegCy: 428.48202785,
        wbarDeg: 170.95427630, OmDeg: 74.01692503 },
    },
    neptune: {
      id: "neptune", name: "Neptune", parent: "sun", mu: 6.836529e6,
      radius: 24622, color: "#5f7fd9", type: "planet", gasGiant: true,
      rotHours: 16.11, tiltDeg: 28.32,
      planetElements: { aAU: 30.06992276, e: 0.00859048, iDeg: 1.77004347,
        LDeg: -55.12002969, LdotDegCy: 218.45945325,
        wbarDeg: 44.96476227, OmDeg: 131.78422574 },
    },
    triton: {
      id: "triton", name: "Triton", parent: "neptune", mu: 1427.598,
      radius: 1353.4, color: "#cfc4d6", type: "moon", rotHours: -141.044,
      // retrograde: inclination > 90 deg
      moonElements: { aKm: 354760, e: 0.000016, iDeg: 157.3,
        OmDeg: 0, wDeg: 0, M0Deg: 0, periodDays: 5.876854 },
    },

    /* --------------------- dwarf planets (IAU class) --------------------- */
    pluto: {
      id: "pluto", name: "Pluto", parent: "sun", mu: 869.61,
      radius: 1188.3, color: "#c9ab90", type: "dwarf",
      rotHours: -153.2928, tiltDeg: 119.6,
      planetElements: { aAU: 39.48211675, e: 0.24882730, iDeg: 17.14001206,
        LDeg: 238.92903833, LdotDegCy: 145.20780515,
        wbarDeg: 224.06891629, OmDeg: 110.30393684 },
    },
    charon: {
      id: "charon", name: "Charon", parent: "pluto", mu: 105.88,
      radius: 606, color: "#a29a94", type: "moon", rotHours: 153.2928,
      moonElements: { aKm: 19591, e: 0.0002, iDeg: 0.08,
        OmDeg: 0, wDeg: 0, M0Deg: 0, periodDays: 6.387221 },
    },
    ceres: {
      // JPL SBDB orbit 48 (epoch JD 2461200.5); GM/radius: Dawn (Park 2016)
      id: "ceres", name: "Ceres", parent: "sun", mu: 62.6284,
      radius: 469.7, color: "#9e948a", type: "dwarf", rotHours: 9.07417,
      smallElements: { aAU: 2.765552595, e: 0.079692295, iDeg: 10.58802780,
        OmDeg: 80.24862682, wDeg: 73.29421453, M0Deg: 274.41934638,
        epochJD: 2461200.5, periodDays: 1679.8531198 },
    },
    eris: {
      // JPL SBDB orbit 103 (epoch JD 2461200.5); mass from Dysnomia orbit
      id: "eris", name: "Eris", parent: "sun", mu: 1108.0,
      radius: 1163, color: "#e8e4dd", type: "dwarf", rotHours: 378.86,
      smallElements: { aAU: 67.93394688, e: 0.438238535, iDeg: 43.92582795,
        OmDeg: 36.00477044, wDeg: 150.79492358, M0Deg: 211.77443428,
        epochJD: 2461200.5, periodDays: 204516.663 },
    },
    haumea: {
      // JPL SBDB orbit 132 (epoch JD 2461200.5); triaxial ~2100x1680x1074 km
      id: "haumea", name: "Haumea", parent: "sun", mu: 267.4,
      radius: 780, color: "#d9d3cc", type: "dwarf", rotHours: 3.9155,
      smallElements: { aAU: 43.06029024, e: 0.194443015, iDeg: 28.20847393,
        OmDeg: 121.78605613, wDeg: 240.69054725, M0Deg: 223.21041188,
        epochJD: 2461200.5, periodDays: 103208.117 },
    },
    makemake: {
      // JPL SBDB orbit 130 (epoch JD 2461200.5)
      id: "makemake", name: "Makemake", parent: "sun", mu: 207.0,
      radius: 715, color: "#d9c0a8", type: "dwarf", rotHours: 22.827,
      smallElements: { aAU: 45.57093317, e: 0.158888995, iDeg: 29.02785604,
        OmDeg: 79.29483382, wDeg: 297.09227334, M0Deg: 169.93799620,
        epochJD: 2461200.5, periodDays: 112364.807 },
    },

    /* ------------------------ main-belt asteroids ------------------------ */
    vesta: {
      // JPL SBDB orbit 36; GM/shape: Dawn (Park 2025)
      id: "vesta", name: "4 Vesta", parent: "sun", mu: 17.2882844,
      radius: 261.4, color: "#b8ad9d", type: "asteroid", rotHours: 5.3421276,
      smallElements: { aAU: 2.361365965, e: 0.090203744, iDeg: 7.14392555,
        OmDeg: 103.70129327, wDeg: 151.46864782, M0Deg: 81.19015608,
        epochJD: 2461200.5, periodDays: 1325.3890429 },
    },
    pallas: {
      // JPL SBDB orbit 74; GM: Vernazza 2021
      id: "pallas", name: "2 Pallas", parent: "sun", mu: 13.63,
      radius: 256.5, color: "#8f9299", type: "asteroid", rotHours: 7.8132214,
      smallElements: { aAU: 2.769559011, e: 0.230700100, iDeg: 34.93279322,
        OmDeg: 172.88661934, wDeg: 310.96991617, M0Deg: 254.24965217,
        epochJD: 2461200.5, periodDays: 1683.5048096 },
    },
    hygiea: {
      // JPL SBDB orbit 129
      id: "hygiea", name: "10 Hygiea", parent: "sun", mu: 7.0,
      radius: 203.6, color: "#6f6a66", type: "asteroid", rotHours: 13.828,
      smallElements: { aAU: 3.150974034, e: 0.106709274, iDeg: 3.82952995,
        OmDeg: 283.11989275, wDeg: 312.42423873, M0Deg: 252.03442424,
        epochJD: 2461200.5, periodDays: 2042.9872833 },
    },
    psyche: {
      // JPL SBDB orbit 92; GM: Farnocchia 2024. NASA Psyche mission target.
      id: "psyche", name: "16 Psyche", parent: "sun", mu: 1.601,
      radius: 111, color: "#a8a29b", type: "asteroid", rotHours: 4.196,
      smallElements: { aAU: 2.925720466, e: 0.134932474, iDeg: 3.09874912,
        OmDeg: 149.97538593, wDeg: 230.03267827, M0Deg: 79.76939505,
        epochJD: 2461200.5, periodDays: 1827.8799602 },
    },

    /* ---------------------- near-Earth mission targets -------------------- */
    eros: {
      // JPL SBDB orbit 659; GM: NEAR Shoemaker (Yeomans 2000)
      id: "eros", name: "433 Eros", parent: "sun", mu: 4.463e-4,
      radius: 8.42, color: "#b09a80", type: "asteroid", rotHours: 5.27,
      smallElements: { aAU: 1.458243717, e: 0.222877963, iDeg: 10.82854410,
        OmDeg: 304.26797134, wDeg: 178.91813191, M0Deg: 62.51145502,
        epochJD: 2461200.5, periodDays: 643.1963891 },
    },
    bennu: {
      // JPL Horizons osculating elements at JD 2461200.5 (2026-06-09 TDB),
      // from the OSIRIS-REx-fitted trajectory (Yarkovsky drift makes the
      // older SBDB 2011-epoch solution ~0.05 AU off by the mid-2020s).
      id: "bennu", name: "101955 Bennu", parent: "sun", mu: 4.89e-9,
      radius: 0.245, color: "#4a4a4a", type: "asteroid", rotHours: 4.296,
      smallElements: { aAU: 1.125950726, e: 0.203682144, iDeg: 6.03296627,
        OmDeg: 1.96657404, wDeg: 66.41055452, M0Deg: 72.45176655,
        epochJD: 2461200.5, periodDays: 436.3927281 },
    },
    ryugu: {
      // JPL SBDB orbit 268; Hayabusa2 target
      id: "ryugu", name: "162173 Ryugu", parent: "sun", mu: 3.0e-8,
      radius: 0.448, color: "#3f3f3f", type: "asteroid", rotHours: 7.63,
      smallElements: { aAU: 1.190918932, e: 0.191073005, iDeg: 5.86644250,
        OmDeg: 251.28971244, wDeg: 211.60899395, M0Deg: 62.34067434,
        epochJD: 2461200.5, periodDays: 474.7027264 },
    },
    apophis: {
      // JPL SBDB orbit 220; close Earth approach 2029-04-13
      id: "apophis", name: "99942 Apophis", parent: "sun", mu: 4.4e-9,
      radius: 0.17, color: "#8a8378", type: "asteroid", rotHours: 30.6,
      smallElements: { aAU: 0.922359221, e: 0.191149228, iDeg: 3.34099688,
        OmDeg: 203.89365142, wDeg: 126.67957069, M0Deg: 175.33040266,
        epochJD: 2461200.5, periodDays: 323.5553367 },
    },
    didymos: {
      // JPL SBDB orbit 240; DART impact target system (with Dimorphos)
      id: "didymos", name: "65803 Didymos", parent: "sun", mu: 3.52e-8,
      radius: 0.3825, color: "#7a7268", type: "asteroid", rotHours: 2.26,
      smallElements: { aAU: 1.642709609, e: 0.383123324, iDeg: 3.41387652,
        OmDeg: 72.98582362, wDeg: 319.58070013, M0Deg: 260.86128863,
        epochJD: 2461200.5, periodDays: 769.0235208 },
    },
  };

  /* ---------------------------------------------------------------------------
   * Launch sites (Earth). minIncDeg is the physical floor (= |latitude|);
   * real ranges add azimuth (range-safety) limits which are noted only.
   * vRot credit is computed from latitude at runtime.
   * ------------------------------------------------------------------------ */
  const LAUNCH_SITES = [
    { id: "",           name: "— none (any inclination) —", latDeg: null },
    { id: "ksc",        name: "Kennedy Space Center / Cape Canaveral (FL)", latDeg: 28.5,  lonDeg: -80.6 },
    { id: "starbase",   name: "Starbase, Boca Chica (TX)",                  latDeg: 26.0,  lonDeg: -97.2 },
    { id: "vandenberg", name: "Vandenberg SFB (CA)",                        latDeg: 34.7,  lonDeg: -120.6 },
    { id: "wallops",    name: "Wallops / MARS (VA)",                        latDeg: 37.9,  lonDeg: -75.5 },
    { id: "baikonur",   name: "Baikonur Cosmodrome (Kazakhstan)",           latDeg: 46.0,  lonDeg: 63.3 },
    { id: "kourou",     name: "Guiana Space Centre, Kourou",                latDeg: 5.2,   lonDeg: -52.8 },
    { id: "tanegashima",name: "Tanegashima (Japan)",                        latDeg: 30.4,  lonDeg: 131.0 },
    { id: "satish",     name: "Satish Dhawan, Sriharikota (India)",         latDeg: 13.7,  lonDeg: 80.2 },
    { id: "jiuquan",    name: "Jiuquan (China)",                            latDeg: 41.0,  lonDeg: 100.3 },
  ];
  function launchSite(id) {
    return LAUNCH_SITES.find((s) => s.id === id) || LAUNCH_SITES[0];
  }

  /* Derived quantities: mean motion (rad/s), semi-major axis in km,
   * sphere of influence r_SOI = a * (mu_body / mu_parent)^(2/5). */
  function finalizeBody(b) {
    if (!b.parent) { b.aKm = 0; b.soi = Infinity; return; }
    const parent = BODIES[b.parent];
    if (b.planetElements) {
      const el = b.planetElements;
      b.aKm = el.aAU * AU;
      b.e = el.e;
      // mean motion from the tabulated mean-longitude rate (deg/century)
      b.nRadS = (el.LdotDegCy * DEG) / (36525 * DAY);
      b.periodS = (2 * Math.PI) / Math.abs(b.nRadS);
    } else if (b.smallElements) {
      const el = b.smallElements;
      b.aKm = el.aAU * AU;
      b.e = el.e;
      b.periodS = el.periodDays * DAY;
      b.nRadS = (2 * Math.PI) / b.periodS;
    } else if (b.moonElements) {
      const el = b.moonElements;
      b.aKm = el.aKm;
      b.e = el.e;
      b.periodS = el.periodDays * DAY;
      b.nRadS = (2 * Math.PI) / b.periodS;
    }
    b.soi = b.aKm * Math.pow(b.mu / parent.mu, 0.4);
  }
  for (const id in BODIES) finalizeBody(BODIES[id]);

  /* Registration hook for JSON catalog expansion (see ui.js). */
  function registerBody(def) {
    if (!def.id || !def.parent || !BODIES[def.parent]) {
      throw new Error("Body needs an 'id' and an existing 'parent'.");
    }
    const b = {
      id: def.id, name: def.name || def.id, parent: def.parent,
      mu: +def.mu || 1e-6, radius: +def.radius || 100,
      color: def.color || "#cccccc", type: def.type || "custom",
      custom: true,
    };
    const el = def.elements || {};
    if (el.aAU !== undefined && BODIES[def.parent].id === "sun") {
      b.planetElements = {
        aAU: +el.aAU, e: +el.e || 0, iDeg: +el.iDeg || 0,
        LDeg: +el.LDeg || 0,
        LdotDegCy: +el.LdotDegCy ||
          // Kepler's third law fallback around the Sun
          (36525 * DAY) * Math.sqrt(BODIES.sun.mu / Math.pow(el.aAU * AU, 3)) / DEG,
        wbarDeg: +el.wbarDeg || 0, OmDeg: +el.OmDeg || 0,
      };
    } else {
      const aKm = +el.aKm || (+el.aAU * AU);
      if (!(aKm > 0)) throw new Error("Body elements need aKm (or aAU).");
      b.moonElements = {
        aKm: aKm, e: +el.e || 0, iDeg: +el.iDeg || 0,
        OmDeg: +el.OmDeg || 0, wDeg: +el.wDeg || 0, M0Deg: +el.M0Deg || 0,
        periodDays: +el.periodDays ||
          (2 * Math.PI * Math.sqrt(Math.pow(aKm, 3) / BODIES[def.parent].mu)) / DAY,
      };
    }
    finalizeBody(b);
    BODIES[def.id] = b;
    return b;
  }

  function childrenOf(id) {
    const out = [];
    for (const k in BODIES) if (BODIES[k].parent === id) out.push(BODIES[k]);
    return out;
  }

  /** true for dwarf planets / asteroids / comets (declutter + UI grouping) */
  function isMinor(b) {
    return b.type === "dwarf" || b.type === "asteroid" || b.type === "comet";
  }

  globalThis.AstroConst = {
    AU, DAY, J2000_JD, DEG, BODIES, registerBody, childrenOf, isMinor,
    LAUNCH_SITES, launchSite,
    VERSION: "1.25.1",
  };
})();
