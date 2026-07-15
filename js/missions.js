/* =============================================================================
 * Mission Trajectory Planner — missions.js
 * Preset missions. IMPORTANT: these are *simplified reconstructions*.
 * Trajectories are recomputed live by the engine (Lambert-targeted patched
 * conics with this app's approximate ephemerides), so timings and Δv values
 * are engine results, not flight data. Historical timelines are listed for
 * comparison and marked as approximate.
 *
 * Launch model: every preset launches to a MECO transfer ellipse and
 * circularizes with an Insertion burn at apoapsis (like a real OMS-2 /
 * second-stage circularization) — see the Launch segment docs.
 * ========================================================================== */
"use strict";

(function () {
  const PRESETS = [
    {
      id: "apollo11",
      name: "Apollo 11 (simplified)",
      epoch: "1969-07-16T13:32:00Z",
      spacecraft: { name: "Apollo stack (S-IVB + CSM/LM)", dryKg: 15000, propKg: 120000,
        isp: 421, fovDeg: 60,
        notes: "Stack-level budget: the S-IVB flew TLI; SPS/DPS/APS did the rest. " +
               "Capacity ≈ 9.1 km/s covers the engine's ~8.6 km/s of burns." },
      description:
        "Historical reconstruction of the first crewed lunar landing: launch " +
        "from KSC, ~2.6 h parking orbit, translunar injection, lunar orbit " +
        "insertion, landing at Tranquility Base, ~21.6 h surface stay, ascent, " +
        "trans-Earth injection and Pacific splashdown. Timing here is " +
        "approximate — the engine re-derives the transfer from this app's " +
        "simplified lunar ephemeris.",
      history: [
        "GET 000:00 — Launch (1969-07-16 13:32 UTC)",
        "GET 000:12 — Parking orbit insertion (185 km)",
        "GET 002:44 — Translunar injection (S-IVB), Δv ≈ 3.05 km/s",
        "GET 075:50 — Lunar orbit insertion, Δv ≈ 0.89 km/s",
        "GET 102:45 — Eagle lands at Tranquility Base (Jul 20 20:17 UTC)",
        "GET 124:22 — Lunar ascent after 21.6 h on the surface",
        "GET 135:24 — Trans-Earth injection, Δv ≈ 1.0 km/s",
        "GET 195:18 — Splashdown, Pacific Ocean (Jul 24 16:50 UTC)",
      ],
      segments: [
        { type: "launch", body: "earth", site: "ksc", ascent: "meco",
          altKm: 185, incDeg: 32.5, raanDeg: 0,
          targetPlane: "moon", planeTofDays: 3.15 },
        { type: "insertion", at: "apoapsis", shape: "circular", maxDays: 0.5 },
        { type: "coast", days: 0.1, mode: "kepler" },
        { type: "transfer", target: "moon", tofDays: 3.05, periKm: 110, side: "B" },
        { type: "insertion", shape: "circular", apoKm: 300, maxDays: 2 },
        { type: "coast", days: 1.0, mode: "kepler" },
        { type: "land", descentHours: 0.75, stayDays: 0.9 },
        { type: "ascend", altKm: 110 },
        { type: "coast", days: 0.05, mode: "kepler" },
        { type: "return", target: "earth", tofDays: 2.55, periKm: 40 },
        { type: "return", target: "earth", tofDays: 1.5, periKm: 40 },
        { type: "reentry", interfaceKm: 120, maxDays: 3, descentMin: 15 },
      ],
    },

    {
      id: "apollo13",
      name: "Apollo 13 free-return (simplified)",
      epoch: "1970-04-11T19:13:00Z",
      spacecraft: { name: "Apollo stack (S-IVB + CSM/LM)", dryKg: 15000, propKg: 120000,
        isp: 421, fovDeg: 60, notes: "Stack-level budget (see Apollo 11)." },
      description:
        "“Houston, we've had a problem.” After the SM oxygen tank ruptured " +
        "~56 h out, Apollo 13 skipped lunar orbit insertion, swung around the " +
        "Moon and used the LM descent engine (the PC+2 burn) to speed the trip " +
        "home. Here: TLI targets a lunar flyby (no insertion); after the SOI " +
        "exit a small return burn stands in for the free-return correction / " +
        "PC+2. Simplified — the real free-return used three-body dynamics that " +
        "patched conics only approximate.",
      history: [
        "GET 000:00 — Launch (1970-04-11 19:13 UTC)",
        "GET 002:35 — Translunar injection",
        "GET 055:55 — O₂ tank 2 explosion; mission aborted",
        "GET 061:30 — DPS burn to restore free-return, Δv ≈ 0.011 km/s",
        "GET 077:08 — Perilune ≈ 254 km; farthest crewed flight from Earth",
        "GET 079:28 — PC+2 speed-up burn, Δv ≈ 0.262 km/s",
        "GET 142:54 — Splashdown (1970-04-17 18:07 UTC)",
      ],
      segments: [
        { type: "launch", body: "earth", site: "ksc", ascent: "meco",
          altKm: 185, incDeg: 32.5, raanDeg: 0,
          targetPlane: "moon", planeTofDays: 3.1 },
        { type: "insertion", at: "apoapsis", shape: "circular", maxDays: 0.5 },
        { type: "coast", days: 0.1, mode: "kepler" },
        { type: "transfer", target: "moon", tofDays: 3.0, periKm: 254, side: "B" },
        { type: "flyby", dvKms: 0, maxDays: 4 },
        { type: "return", target: "earth", tofDays: 2.0, periKm: 40 },
        { type: "reentry", interfaceKm: 120, maxDays: 4, descentMin: 15 },
      ],
    },

    {
      id: "artemis2",
      name: "Artemis II (2026)",
      epoch: "2026-04-01T22:35:00Z",
      spacecraft: { name: "Orion Integrity + ESM", dryKg: 15300, propKg: "",
        isp: 316, fovDeg: 70,
        notes: "Propellant tracking is off: the SLS/ICPS and Orion propulsion " +
               "events are represented at stack level, not as a stage-resolved mass model." },
      description:
        "Date-pinned historical reconstruction of the completed first crewed " +
        "Artemis flight. Orion launched from Pad 39B, spent about a day in a " +
        "high Earth checkout orbit, flew an unpowered lunar swingby 6,545 km " +
        "above the surface, and splashed down off California after 9 days, " +
        "1 hour, and 32 minutes. The 46,000-mile-class checkout orbit is " +
        "represented as a two-apsis Earth conic; the lunar and return legs use " +
        "this app's Lambert/patched-conic model rather than NASA navigation " +
        "ephemerides or a stage-resolved SLS/Orion simulation.",
      history: [
        "2026-04-01 22:35 UTC — SLS launch from Kennedy Space Center Pad 39B",
        "T+00:49 — ICPS burn begins the roughly 46,000-mile-high checkout orbit",
        "2026-04-02 — Orion completes a 43-second perigee-raise burn",
        "2026-04-02 23:49 UTC — 5 min 49 s translunar injection; Δv about 0.388 km/s",
        "2026-04-06 04:37 UTC — Orion enters the Moon's sphere of influence",
        "2026-04-06 23:00 UTC — Closest approach: about 6,545 km above the Moon",
        "2026-04-06 23:02 UTC — Maximum Earth distance: 252,756 miles",
        "2026-04-07 17:25 UTC — Orion exits the Moon's sphere of influence",
        "2026-04-11 00:07 UTC — Pacific splashdown off San Diego",
      ],
      segments: [
        { type: "launch", body: "earth", site: "ksc", ascent: "meco",
          altKm: 185, incDeg: 28.5, raanDeg: 0,
          targetPlane: "moon", planeTofDays: 5.02 },
        { type: "insertion", at: "apoapsis", shape: "elliptical",
          apoKm: 74030, maxDays: 0.5 },
        { type: "coast", days: 1.036, mode: "kepler" },
        { type: "transfer", target: "moon", tofDays: 4.0245,
          periKm: 6545, side: "B", optWait: "immediate" },
        { type: "coast", days: 0.6365, mode: "kepler" },
        { type: "observe", target: "moon", days: 0.1764, mode: "kepler" },
        { type: "flyby", dvKms: 0, maxDays: 4 },
        { type: "return", target: "earth", tofDays: 3.216,
          periKm: 40, optWait: "immediate" },
        { type: "reentry", interfaceKm: 120, maxDays: 4, descentMin: 20 },
      ],
    },

    {
      id: "cassini",
      name: "Cassini–Huygens VVEJGA (1997)",
      epoch: "1997-10-15T08:43:00Z",
      spacecraft: { name: "Cassini–Huygens", dryKg: 2523, propKg: "", isp: 308, fovDeg: 60,
        notes: "5,655 kg at launch (3,132 kg bipropellant). Propellant tracking off: " +
               "the big burns here (injection, ephemeris-absorbing TCMs, idealized " +
               "Huygens descent) belong to the launcher/lander in this single-craft model." },
      description:
        "The real route to Saturn: launched with only C3 ≈ 17 km²/s² — far " +
        "too little to reach Saturn directly — Cassini borrowed the rest from " +
        "four gravity assists: Venus (284 km), Venus again (603 km) after a " +
        "deep-space maneuver, Earth (1171 km), and distant Jupiter " +
        "(9.7 million km). Saturn orbit insertion came 6.7 years after " +
        "launch; the Huygens probe then descended 2 h 27 min through Titan's " +
        "atmosphere — the most distant landing in history. Engine-recomputed " +
        "reconstruction: every flyby lands on (or within days of) the real " +
        "date and altitude, and each FLYBY card reports the v∞ rotation and " +
        "free Δv gained. The engine's TCM burns absorb the difference " +
        "between its simplified ephemerides and reality (the real mission " +
        "needed far smaller corrections), and the probe descends at the " +
        "*first* Titan encounter — the real tour phased through three " +
        "encounters before releasing Huygens.",
      history: [
        "1997-10-15 — Launch, Titan IVB/Centaur from Cape Canaveral",
        "1998-04-26 — Venus flyby #1, 284 km",
        "1998-12-03 — Deep Space Maneuver, Δv ≈ 0.45 km/s (near aphelion)",
        "1999-06-24 — Venus flyby #2, 603 km",
        "1999-08-18 — Earth flyby, 1171 km (+5.5 km/s heliocentric)",
        "2000-12-30 — Jupiter flyby, 9.7M km",
        "2004-07-01 — Saturn orbit insertion: 96 min burn, Δv ≈ 0.63 km/s",
        "2004-10-26 — Titan-A: first Titan encounter (1174 km)",
        "2004-12-25 — Huygens probe released (3rd Titan encounter)",
        "2005-01-14 — Huygens enters Titan's atmosphere (1270 km), lands 2h27m later",
        "(Orbiter continued 13 more years — 294 orbits, Grand Finale 2017-09-15)",
      ],
      segments: [
        { type: "launch", body: "earth", site: "ksc", ascent: "meco",
          altKm: 185, incDeg: 28.6, raanDeg: 0 },
        { type: "insertion", at: "apoapsis", shape: "circular", maxDays: 0.5 },
        { type: "coast", days: 0.08, mode: "kepler" },
        // Venus 1: real flyby 1998-04-26 @ 284 km (engine hits the exact date)
        { type: "depart", target: "venus", tofDays: 193, periKm: 284, side: "A" },
        { type: "flyby", dvKms: 0, maxDays: 30 },
        // cruise to the Deep Space Maneuver (real: 1998-12-03, near aphelion)
        { type: "coast", days: 219, mode: "kepler" },
        // DSM + Venus 2 leg: real flyby 1999-06-24 @ 603 km
        { type: "transfer", target: "venus", tofDays: 203, periKm: 603, side: "B",
          optWait: "immediate" },
        { type: "flyby", dvKms: 0, maxDays: 30 },
        // Earth: real flyby 1999-08-18 @ 1171 km, v∞ ≈ 16 km/s
        { type: "transfer", target: "earth", tofDays: 55, periKm: 1171, side: "A",
          optWait: "immediate" },
        { type: "flyby", dvKms: 0, maxDays: 30 },
        // Jupiter: real flyby 2000-12-30 @ 9.7M km
        { type: "transfer", target: "jupiter", tofDays: 500, periKm: 9700000, side: "A",
          optWait: "immediate" },
        { type: "flyby", dvKms: 0, maxDays: 220 },
        // Saturn arrival: real SOI 2004-07-01, rp ≈ 20,000 km above cloud tops
        { type: "transfer", target: "saturn", tofDays: 1228, periKm: 22000, side: "A",
          optWait: "immediate" },
        { type: "insertion", at: "periapsis", shape: "elliptical",
          apoKm: 9000000, maxDays: 130 },
        { type: "coast", days: 2, mode: "kepler" },
        // Titan descent at the first encounter (real Titan-A: 2004-10-26)
        { type: "transfer", target: "titan", tofDays: 70, periKm: 1200, side: "A",
          optWait: "optimal" },
        { type: "coast_to", event: "periapsis", maxDays: 20, mode: "kepler" },
        { type: "land", descentHours: 2.45, stayDays: 0.1 },
      ],
    },

    {
      id: "voyager1",
      name: "Voyager 1 grand tour (1977)",
      epoch: "1977-09-05T12:56:00Z",
      spacecraft: { name: "Voyager 1", dryKg: 722, propKg: "", isp: 230, fovDeg: 45,
        notes: "825.5 kg at launch (~104 kg hydrazine). Tracking off — the engine's " +
               "correction burns absorb its simplified-ephemeris error; the real " +
               "spacecraft flew this tour on tiny TCMs." },
      description:
        "The fastest launch of its era (C3 ≈ 106 km²/s², Titan IIIE/Centaur): " +
        "16 months to Jupiter, then a gravity assist to Saturn — including the " +
        "close Titan pass that bent Voyager 1 up out of the ecliptic and ended " +
        "its planetary tour. Engine-recomputed: both flybys land within days " +
        "of the real dates at the real altitudes. After Saturn the preset " +
        "coasts outbound for four years — the start of the road to " +
        "interstellar space (crossed 2012, still transmitting).",
      history: [
        "1977-09-05 — Launch, Titan IIIE/Centaur (16 days after Voyager 2)",
        "1979-03-05 — Jupiter flyby, 348,890 km from center (~278,979 km alt)",
        "1980-11-12 — Saturn flyby, 184,300 km from center; Titan pass ends the tour",
        "1990-02-14 — 'Pale Blue Dot' image from 6 billion km",
        "2012-08-25 — Crosses the heliopause: interstellar space",
      ],
      segments: [
        { type: "launch", body: "earth", site: "ksc", ascent: "meco",
          altKm: 185, incDeg: 28.5, raanDeg: 0 },
        { type: "insertion", at: "apoapsis", shape: "circular", maxDays: 0.5 },
        { type: "coast", days: 0.08, mode: "kepler" },
        // Jupiter: real flyby 1979-03-05 (engine hits the exact date)
        { type: "depart", target: "jupiter", tofDays: 549, periKm: 278979, side: "A" },
        { type: "coast", days: 46.8, mode: "kepler" },
        { type: "observe", target: "io", days: 1.5, mode: "kepler" },
        { type: "flyby", dvKms: 0, maxDays: 220 },
        // Saturn: real flyby 1980-11-12 — with the Titan observation that
        // bent Voyager 1 out of the ecliptic and ended its planetary tour
        { type: "transfer", target: "saturn", tofDays: 573, periKm: 126068, side: "A",
          optWait: "immediate" },
        { type: "coast", days: 39.5, mode: "kepler" },
        { type: "observe", target: "titan", days: 1.5, mode: "kepler" },
        { type: "flyby", dvKms: 0, maxDays: 220 },
        { type: "coast", days: 1500, mode: "kepler" },
      ],
    },

    {
      id: "voyager2",
      name: "Voyager 2 grand tour (1977)",
      epoch: "1977-08-20T14:29:00Z",
      spacecraft: { name: "Voyager 2", dryKg: 722, propKg: "", isp: 230, fovDeg: 45,
        notes: "The only spacecraft to visit all four giant planets. Tracking off — " +
               "the engine's correction burns absorb its simplified-ephemeris error." },
      description:
        "The once-in-176-years planetary alignment: Jupiter → Saturn → Uranus " +
        "→ Neptune in a single 12-year chain of gravity assists. " +
        "Engine-recomputed reconstruction: Saturn lands on the exact real " +
        "date, Jupiter and Neptune within a day, Uranus within five — and " +
        "the Neptune pass skims 4,600 km over the cloud tops, the closest " +
        "flyby of the whole tour, exactly as flown. Each FLYBY card shows " +
        "the v∞ rotation that made the next leg possible.",
      history: [
        "1977-08-20 — Launch, Titan IIIE/Centaur",
        "1979-07-09 — Jupiter flyby, 721,670 km from center",
        "1981-08-25 — Saturn flyby, 161,000 km from center",
        "1986-01-24 — Uranus flyby, 107,000 km from center (only visit ever)",
        "1989-08-25 — Neptune flyby, 4,950 km above the clouds; Triton follows",
        "2018-11-05 — Crosses the heliopause: interstellar space",
      ],
      segments: [
        { type: "launch", body: "earth", site: "ksc", ascent: "meco",
          altKm: 185, incDeg: 28.5, raanDeg: 0 },
        { type: "insertion", at: "apoapsis", shape: "circular", maxDays: 0.5 },
        { type: "coast", days: 0.08, mode: "kepler" },
        // Jupiter: real flyby 1979-07-09
        { type: "depart", target: "jupiter", tofDays: 693, periKm: 651759, side: "A" },
        { type: "coast", days: 64, mode: "kepler" },
        { type: "observe", target: "io", days: 1.5, mode: "kepler" },
        { type: "flyby", dvKms: 0, maxDays: 220 },
        // Saturn: real flyby 1981-08-25 (engine hits the exact date)
        { type: "transfer", target: "saturn", tofDays: 714, periKm: 102768, side: "A",
          optWait: "immediate" },
        { type: "flyby", dvKms: 0, maxDays: 200 },
        // Uranus: real flyby 1986-01-24
        { type: "transfer", target: "uranus", tofDays: 1561, periKm: 81638, side: "A",
          optWait: "immediate" },
        { type: "flyby", dvKms: 0, maxDays: 160 },
        // Neptune: real flyby 1989-08-25, 4,950 km over the cloud tops
        { type: "transfer", target: "neptune", tofDays: 1262, periKm: 4618, side: "A",
          optWait: "immediate" },
        // Triton observation around the Neptune pass (real: ~5 h after CA)
        { type: "coast", days: 57.8, mode: "kepler" },
        { type: "observe", target: "triton", days: 1.5, mode: "kepler" },
        { type: "flyby", dvKms: 0, maxDays: 140 },
        { type: "coast", days: 1500, mode: "kepler" },
      ],
    },

    {
      id: "mars2026",
      name: "Earth → Mars transfer (2026 window)",
      epoch: "2026-11-15T00:00:00Z",
      spacecraft: { name: "Mars orbiter (generic)", dryKg: 1200, propKg: 9000,
        isp: 320, fovDeg: 50,
        notes: "Propellant tracking ON — watch the budget: capacity ≈ 6.7 km/s vs " +
               "~6.4 km/s needed. Shrink the capture orbit or botch the window and you run dry." },
      description:
        "A near-Hohmann interplanetary transfer in the late-2026 launch " +
        "window: depart a 300 km LEO with C3 ≈ 15 km²/s², cruise ~7 months, " +
        "and capture into an elliptical Mars orbit. The heliocentric leg is a " +
        "Lambert solution between the real (approximate) positions of Earth " +
        "and Mars at the chosen dates — change the epoch or TOF and watch the " +
        "required C3 change.",
      history: [
        "Type-I conjunction transfers: ~180–260 days",
        "Typical C3 in a good window: 10–17 km²/s²",
        "Arrival v∞ ≈ 2.5–3.5 km/s; capture Δv ~0.8–2 km/s",
      ],
      segments: [
        { type: "launch", body: "earth", site: "ksc", ascent: "meco",
          altKm: 300, incDeg: 28.5, raanDeg: 0 },
        { type: "insertion", at: "apoapsis", shape: "circular", maxDays: 0.5 },
        { type: "coast", days: 0.08, mode: "kepler" },
        { type: "depart", target: "mars", tofDays: 210, periKm: 400, side: "A" },
        { type: "insertion", shape: "elliptical", apoKm: 33000, maxDays: 6 },
        { type: "coast", days: 4, mode: "kepler" },
      ],
    },

    {
      id: "artemis",
      name: "Artemis-style Moon mission",
      epoch: "2026-09-05T12:00:00Z",
      spacecraft: { name: "Orion (approx.)", dryKg: 15300, propKg: "", isp: 316, fovDeg: 70,
        notes: "Tracking off — trans-lunar injection was the ICPS's job." },
      description:
        "A crewed lunar mission in the Artemis mold: slow translunar " +
        "coast, insertion into a highly elliptical polar-ish lunar orbit " +
        "(standing in for the Near-Rectilinear Halo Orbit in this preset's " +
        "fast patched-conic sequence; the separate ideal CR3BP examples can " +
        "represent halo families, but are not an Artemis ephemeris reconstruction), a " +
        "week of operations, then trans-Earth injection and reentry.",
      history: [
        "Artemis I flew Nov–Dec 2022 (uncrewed, distant retrograde orbit)",
        "NRHO: ~1,500 × 70,000 km polar halo orbit near the Moon",
        "Orion reenters at ~11 km/s — fastest crewed reentry velocities",
      ],
      segments: [
        { type: "launch", body: "earth", site: "ksc", ascent: "meco",
          altKm: 185, incDeg: 28.5, raanDeg: 0,
          targetPlane: "moon", planeTofDays: 4.6 },
        { type: "insertion", at: "apoapsis", shape: "circular", maxDays: 0.5 },
        { type: "coast", days: 0.1, mode: "kepler" },
        { type: "transfer", target: "moon", tofDays: 4.5, periKm: 1600, side: "B" },
        { type: "insertion", shape: "elliptical", apoKm: 55000, maxDays: 3 },
        { type: "coast", days: 5.0, mode: "kepler" },
        { type: "coast_to", event: "periapsis", maxDays: 7, mode: "kepler" },
        { type: "return", target: "earth", tofDays: 4.2, periKm: 40 },
        { type: "return", target: "earth", tofDays: 2.5, periKm: 40 },
        { type: "reentry", interfaceKm: 120, maxDays: 4, descentMin: 20 },
      ],
    },

    {
      id: "europa",
      name: "Jupiter / Europa orbiter (direct)",
      epoch: "2029-01-15T00:00:00Z",
      spacecraft: { name: "Europa orbiter (hypothetical)", dryKg: 2500, propKg: "",
        isp: 320, fovDeg: 50, notes: "Tracking off — a direct shot's injection belongs to the launcher." },
      description:
        "A direct ballistic shot to Jupiter (real missions like Europa " +
        "Clipper use Mars/Earth gravity assists to cut the C3 roughly in " +
        "half — expect a bruising injection Δv here; compare with the " +
        "Cassini–Huygens preset to see what assists buy you). Capture into " +
        "a long elliptical Jovian orbit near Europa's orbital radius, then " +
        "a Lambert hop down to Europa and a low science orbit. Radiation, " +
        "third-body effects and moon flyby tours are not modeled.",
      history: [
        "Europa Clipper (2024): Mars + Earth gravity assists, arrival 2030",
        "Direct Earth→Jupiter C3: ~80 km²/s² vs ~30 with assists",
        "Galileo used a 6-year VEEGA trajectory to reach Jupiter",
      ],
      segments: [
        { type: "launch", body: "earth", site: "ksc", ascent: "meco",
          altKm: 300, incDeg: 28.5, raanDeg: 0 },
        { type: "insertion", at: "apoapsis", shape: "circular", maxDays: 0.5 },
        { type: "coast", days: 0.08, mode: "kepler" },
        { type: "depart", target: "jupiter", tofDays: 1100, periKm: 620000, side: "A" },
        { type: "insertion", shape: "elliptical", apoKm: 11500000, maxDays: 110 },
        { type: "coast", days: 2, mode: "kepler" },
        { type: "transfer", target: "europa", tofDays: 3.6, periKm: 100, side: "A" },
        { type: "insertion", shape: "circular", apoKm: 100, maxDays: 2 },
        { type: "coast", days: 3.55, mode: "kepler" },
      ],
    },

    {
      id: "titan",
      name: "Saturn / Titan lander (direct)",
      epoch: "2027-06-10T00:00:00Z",
      spacecraft: { name: "Titan lander (hypothetical)", dryKg: 1800, propKg: "",
        isp: 320, fovDeg: 55, notes: "Tracking off — see the Cassini preset for the real route." },
      description:
        "A hypothetical *direct* (therefore expensive) cruise to Saturn, " +
        "capture into an elliptical orbit reaching down to Titan's orbital " +
        "radius, a Lambert transfer to Titan and a descent to the surface. " +
        "For the way it was actually done — with four gravity assists — " +
        "load the Cassini–Huygens VVEJGA preset and compare the departure " +
        "C3 and injection Δv.",
      history: [
        "Cassini–Huygens launched 1997, arrived at Saturn 2004 (VVEJGA)",
        "Huygens landed on Titan 2005-01-14 — descent took 2 h 27 min",
        "Titan: thick N₂ atmosphere (1.5 bar), methane lakes",
      ],
      segments: [
        { type: "launch", body: "earth", site: "ksc", ascent: "meco",
          altKm: 300, incDeg: 28.5, raanDeg: 0 },
        { type: "insertion", at: "apoapsis", shape: "circular", maxDays: 0.5 },
        { type: "coast", days: 0.08, mode: "kepler" },
        { type: "depart", target: "saturn", tofDays: 2200, periKm: 1160000, side: "A" },
        { type: "insertion", shape: "elliptical", apoKm: 8000000, maxDays: 170 },
        { type: "coast", days: 2, mode: "kepler" },
        { type: "transfer", target: "titan", tofDays: 6, periKm: 1500, side: "A" },
        { type: "insertion", shape: "elliptical", apoKm: 15000, maxDays: 2 },
        { type: "coast", days: 1.2, mode: "kepler" },
        { type: "land", descentHours: 2.5, stayDays: 1 },
      ],
    },

    {
      id: "earth_moon_l2_halo",
      name: "Earth-Moon L2 halo (CR3BP)",
      epoch: "2026-07-13T00:00:00Z",
      spacecraft: { name: "L2 halo demonstrator", dryKg: 1200, propKg: 180,
        isp: 320, fovDeg: 50,
        notes: "Ideal CR3BP design study. Injection into the family is outside this standalone preset; stationkeeping is deterministic reference tracking." },
      description:
        "A differentially corrected northern Earth-Moon L2 halo orbit in the " +
        "circular restricted three-body problem. The first coast demonstrates " +
        "the natural unstable periodic family; the next segment adds a small " +
        "radial dispersion and estimates ideal impulsive stationkeeping. Use " +
        "the Earth-Moon synodic frame and L1-L5 Display option to inspect it.",
      history: [
        "Model: ideal Earth-Moon CR3BP, not an operational ephemeris",
        "Family: L2 northern halo, differentially corrected with STM shooting",
        "Stationkeeping: deterministic ideal impulses; no navigation covariance",
      ],
      segments: [
        { type: "libration", system: "earth-moon", point: "L2", family: "halo",
          size: "small", hemisphere: "north" },
        { type: "cr3bp_coast", cycles: 1, tolerance: "high" },
        { type: "stationkeep", cycles: 1, corrections: 12, offsetKm: 5, maxBurnMs: 5 },
      ],
    },

    {
      id: "finite_burn_demo",
      name: "Continuous apoapsis raise (finite thrust)",
      epoch: "2026-07-13T00:00:00Z",
      spacecraft: { name: "Finite-thrust demonstrator", dryKg: 1000, propKg: 500,
        isp: 320, fovDeg: 50,
        notes: "A deliberately high-thrust teaching case that makes the continuously rising osculating apoapsis easy to see." },
      description:
        "A 300-km Earth parking orbit followed by a ten-minute prograde burn. " +
        "Gravity, thrust, spacecraft motion, and mass depletion are integrated " +
        "together, so the apoapsis marker grows continuously instead of " +
        "appearing at an impulsive endpoint. The following adaptive n-body " +
        "coast includes Earth, Moon, and Sun point-mass gravity.",
      history: [
        "Teaching mission: not a historical flight",
        "Finite burn: 2,000 N for 10 min, Isp 320 s",
        "Force model: adaptive inertial point masses with mass depletion",
      ],
      segments: [
        { type: "launch", body: "earth", site: "ksc", ascent: "direct",
          altKm: 300, incDeg: 28.5, raanDeg: 0 },
        { type: "finite_burn", durationMin: 10, thrustN: 2000, ispS: 320,
          direction: "prograde", dirX: 1, dirY: 0, dirZ: 0,
          massKg: "", gravity: "nbody" },
        { type: "coast", days: 0.2, mode: "adaptive-nbody" },
      ],
    },

    {
      id: "sun_earth_l1_lissajous",
      name: "Sun-Earth L1 Lissajous seed (CR3BP)",
      epoch: "2026-07-13T00:00:00Z",
      spacecraft: { name: "Solar observatory demonstrator", dryKg: 650, propKg: 80,
        isp: 220, fovDeg: 35,
        notes: "Linear Lissajous seed propagated in the nonlinear CR3BP. This is deliberately not labelled as a corrected periodic orbit." },
      description:
        "A bounded linear center-mode seed about Sun-Earth L1, followed by " +
        "nonlinear adaptive CR3BP propagation and ideal reference-tracking " +
        "stationkeeping. The seed is quasi-periodic and may drift; the UI " +
        "does not make a false closed-orbit claim. Use the Sun-Earth synodic " +
        "frame to hold the geometry stationary.",
      history: [
        "Model: ideal Sun-Earth CR3BP, not an operational ephemeris",
        "Family: bounded linear Lissajous seed, explicitly non-periodic",
        "Propagation: adaptive Dormand-Prince 5(4)",
      ],
      segments: [
        { type: "libration", system: "sun-earth", point: "L1", family: "lissajous",
          size: "small", hemisphere: "north" },
        { type: "cr3bp_coast", cycles: 2, tolerance: "high" },
        { type: "stationkeep", cycles: 1, corrections: 12, offsetKm: 50, maxBurnMs: 2 },
      ],
    },

    {
      id: "leo_environment_lab",
      name: "LEO environment fidelity lab",
      epoch: "2026-07-13T00:00:00Z",
      spacecraft: { name: "Environment demonstrator", dryKg: 700, propKg: 100,
        isp: 300, fovDeg: 40,
        notes: "A deliberately drag-sensitive geometry used to compare the bounded atmosphere and Earth J2-J4 force selection." },
      description:
        "A 350 km near-polar orbit propagated against the generated offline " +
        "NASA/JPL Horizons reference-body tables. The adaptive force arc adds " +
        "a bounded atmosphere/cannonball drag model and Earth J2, J3 and J4, " +
        "making the altitude decay and non-Keplerian plane evolution visible. " +
        "This is a deterministic fidelity test, not an operational density forecast.",
      history: [
        "Validation mission: not a historical flight",
        "Ephemeris: release-generated NASA/JPL Horizons vectors; no extrapolation",
        "Environment: bounded atmosphere + Cd 2.2 drag + Earth J2-J4",
      ],
      segments: [
        { type: "launch", body: "earth", site: "vafb", ascent: "direct",
          altKm: 350, incDeg: 97.6, raanDeg: 15 },
        { type: "coast", days: 0.75, mode: "adaptive-environment",
          ephemeris: "planner-horizons", drag: "on", srp: "off",
          harmonics: "j4", massKg: 800, areaM2: 20, cd: 2.2,
          cr: 1.3, densityScale: 1 },
      ],
    },

    {
      id: "geo_srp_horizons",
      name: "GEO SRP and eclipse lab",
      epoch: "2026-07-13T00:00:00Z",
      spacecraft: { name: "High area-to-mass GEO demonstrator", dryKg: 450,
        propKg: 50, isp: 320, fovDeg: 25,
        notes: "The exaggerated area-to-mass ratio makes the selected cannonball SRP model and eclipse gating easier to inspect." },
      description:
        "A near-geostationary spacecraft propagated for two days with the " +
        "offline Horizons body states, Earth J2-J4, and cannonball solar-" +
        "radiation pressure. Earth and Moon occultation continuously suppress " +
        "SRP through penumbra/umbra instead of applying sunlight through a body.",
      history: [
        "Validation mission: not a historical flight",
        "SRP: Cr 1.6, 80 m\u00b2 reference area, 500 kg mass",
        "Lighting: finite solar disk with Earth/Moon eclipse suppression",
      ],
      segments: [
        { type: "launch", body: "earth", site: "", ascent: "direct",
          altKm: 35786, incDeg: 0.1, raanDeg: 0 },
        { type: "coast", days: 2, mode: "adaptive-environment",
          ephemeris: "planner-horizons", drag: "off", srp: "on",
          harmonics: "j4", massKg: 500, areaM2: 80, cd: 2.2,
          cr: 1.6, densityScale: 1 },
      ],
    },

    {
      id: "sdp4_validation",
      name: "SDP4 deep-space validation object",
      epoch: "2004-01-31T21:51:25Z",
      spacecraft: { name: "NORAD 04632 validation object", dryKg: 100,
        propKg: 0, isp: 1, fovDeg: 30,
        notes: "Public Vallado verification element set. The identity is a numerical regression fixture, not an operational-status claim." },
      description:
        "A four-day propagation of the public Vallado deep-space verification " +
        "TLE. Its roughly 19.96 hour period selects the full SDP4 branch, " +
        "including lunar/solar periodic terms and resonance integration. TEME " +
        "is mapped through the same Earth-fixed frame used by textures and the " +
        "ground track; the result is a GP prediction, not telemetry.",
      history: [
        "Verification source: Vallado/CelesTrak SGP4 test case, NORAD 04632",
        "Element epoch: 2004-01-31 21:51:25 UTC",
        "Model/frame: SDP4 mean-element prediction in TEME",
      ],
      segments: [
        { type: "gp_orbit",
          line1: "1 04632U 70093B   04031.91070959 -.00000084  00000-0  10000-3 0  9955",
          line2: "2 04632  11.4628 273.1101 1450506 207.6000 143.9350  1.20231981 44145",
          days: 4, stepMin: 20, strictChecksum: "strict" },
      ],
    },

    {
      id: "leo_disposal_uncertainty",
      name: "LEO disposal uncertainty and operations lab",
      epoch: "2026-07-13T00:00:00Z",
      spacecraft: { name: "Disposal and operations demonstrator", dryKg: 450,
        propKg: 50, isp: 220, fovDeg: 35,
        notes: "A compact scenario for covariance, execution error, Monte Carlo, ground-station access, sensor swath, eclipses and multi-craft comparison." },
      description:
        "A 700 km near-polar spacecraft executes a 10 m/s retrograde disposal " +
        "burn and coasts under the same local two-body model used by its bounded " +
        "event-confidence study. The Data uncertainty card starts " +
        "with a deterministic covariance and seeded 1,000-case maneuver " +
        "dispersion. Track/Data defaults exercise a user station, sensor swath, " +
        "3D eclipse cones, and a comparison against the environment lab.",
      history: [
        "Validation mission: not a historical flight",
        "Uncertainty: 100 m position, 0.1 m/s velocity 1-sigma; seed 1170",
        "Execution: 0.5% magnitude, 0.15 degree pointing, 0.5 s timing 1-sigma",
      ],
      uncertainty: {
        source: { beforeSegment: 1, label: "pre-disposal burn state" },
        positionSigmaKm: 0.1,
        velocitySigmaKmS: 0.0001,
        samples: 1000,
        seed: 1170,
        propagationHours: 6,
        maneuver: {
          dv: [0, -0.01, 0],
          frame: "RTN",
          execution: {
            magnitudeSigmaFraction: 0.005,
            pointingSigmaRad: 0.002618,
            timingSigmaS: 0.5,
          },
        },
      },
      operations: {
        sensorFovDeg: 35,
        sensorOffNadirDeg: 12,
        sensorSwath: true,
        stationMarkers: true,
        eclipse3d: true,
        conjunctionThresholdKm: 250,
        comparisonPreset: "leo_environment_lab",
        stations: [
          { id: "preset-svalbard", name: "Svalbard teaching site", bodyId: "earth",
            latDeg: 78.2298, lonDeg: 15.4078, altKm: 0.46,
            elevationMaskDeg: 8, complex: null },
        ],
      },
      segments: [
        { type: "launch", body: "earth", site: "vafb", ascent: "direct",
          altKm: 700, incDeg: 98.2, raanDeg: 20 },
        { type: "impulse", frame: "vnb", dv1: -0.01, dv2: 0, dv3: 0 },
        { type: "coast", days: 1, mode: "kepler" },
      ],
    },

    {
      id: "mars_joint_target_lab",
      name: "Earth-Mars joint targeting lab",
      epoch: "2005-08-21T15:40:35.784Z",
      spacecraft: { name: "Joint-target demonstrator", dryKg: 1000,
        propKg: "", isp: 320, fovDeg: 40,
        notes: "The staged date/TOF came from the bounded two-variable Windows Vary/Achieve solution; propulsion tracking is disabled for this solver fixture." },
      description:
        "An Earth-Mars mission initialized from the Windows pane's bounded " +
        "joint departure-date/time-of-flight solve. Both variables moved from " +
        "the seed while holding one applied B-plane aim fixed, achieving a 300 km " +
        "Mars periapsis within one kilometre; the " +
        "Planner then flies the explicit Earth escape, Mars targeting, capture, " +
        "and a one-day local coast.",
      history: [
        "Validation mission: not a historical flight",
        "Seed: 2005-08-10 mission epoch, 196.000 d TOF, 1,000 km Mars periapsis",
        "Applied solution: 2005-08-21T15:40:35.784Z mission epoch, 203.827366 d TOF",
        "Fixed B-plane aim 7,598.957 km; achieved 299.804 km Mars periapsis (-0.196 km residual)",
      ],
      targetingValidation: {
        mode: "joint-date-tof",
        from: "earth",
        to: "mars",
        targetPeriapsisKm: 300,
        achievedPeriapsisKm: 299.80419458444067,
        toleranceKm: 1,
        fixedAimOffsetKm: 7598.957093215446,
        seedEpoch: "2005-08-10T00:00:00.000Z",
        seedTofDays: 196,
        seedPeriapsisKm: 1000,
        solvedEpoch: "2005-08-21T15:40:35.784Z",
        solvedTofDays: 203.82736638715954,
        variedDeparture: true,
        variedTof: true,
      },
      segments: [
        { type: "launch", body: "earth", site: "", ascent: "direct",
          altKm: 300, incDeg: 0, raanDeg: 0,
          targetPlane: "mars", planeTofDays: 203.82736638715954 },
        { type: "depart", target: "mars", tofDays: 203.82736638715954,
          periKm: 300, aimOffsetKm: 7598.957093215446, side: "A" },
        { type: "insertion", at: "periapsis", shape: "elliptical",
          apoKm: 10000, maxDays: 15 },
        { type: "coast", days: 1, mode: "kepler" },
      ],
    },

    {
      id: "iss_orbital_reference",
      name: "ISS orbital reference (SGP4)",
      epoch: "2026-07-13T07:33:22.422Z",
      spacecraft: { name: "International Space Station orbital reference",
        dryKg: 420000, propKg: 0, isp: 1, fovDeg: 90,
        notes: "Release-pinned public GP element set. This is an SGP4 prediction, " +
               "not telemetry; operational status is not asserted." },
      description:
        "A two-day SGP4 propagation of an ISS public element set at its element " +
        "epoch. It is a clean reference for GP propagation, exact off-grid " +
        "sampling, Earth ground tracks and the TEME-to-Planner frame mapping. " +
        "The element set is frozen for repeatable validation rather than updated live.",
      history: [
        "Validation reference: not a live operational feed",
        "Element epoch: 2026-07-13 07:33:22 UTC",
        "Expected mean period in this SGP4 implementation: 92.974 min",
      ],
      segments: [
        { type: "gp_orbit",
          line1: "1 25544U 98067A   26194.31484285  .00004029  00000+0  81266-4 0  9998",
          line2: "2 25544  51.6305 170.7871 0006687 290.3592  69.6678 15.48997295575806",
          days: 2, stepMin: 2, strictChecksum: "strict" },
      ],
    },

    {
      id: "crew_dragon_iss_docking",
      name: "Crew Dragon-ISS rendezvous and docking",
      epoch: "2026-07-14T07:22:52.422Z",
      spacecraft: { name: "Crew Dragon high-delta-v intercept demonstrator",
        dryKg: 9500, propKg: 1400, isp: 300, fovDeg: 80,
        notes: "A compressed deterministic rendezvous design. The direct orbit " +
               "initializer and Lambert terminal transfer are not a reconstruction " +
               "of a specific Crew Dragon flight or proximity-operations GNC." },
      description:
        "A repeatable multi-vehicle intercept exercise against an ISS SGP4 track. " +
        "At this fixed guided-ascent launch window, a KSC launch remains close to the " +
        "station plane, so the compressed Lambert intercept and velocity match cost " +
        "about 0.402 km/s; this is deliberately not a realistic terminal approach. " +
        "Dragon then docks, follows the exact joined ISS state for three hours and " +
        "undocks with a two metre-per-second departure.",
      history: [
        "Validation mission: compressed design exercise, not a historical flight",
        "ISS target: release-pinned public TLE with SGP4 propagation",
        "Post-MECO intercept: 1.25 h and about 0.403 km/s; joined coast: 3.00 h",
      ],
      segments: [
        { type: "launch", body: "earth", site: "ksc", ascent: "direct",
          altKm: 410, incDeg: 51.63, raanDeg: 90 },
        { type: "rendezvous", targetVehicle: "iss", tofHours: 1.25,
          direction: "auto", maxDvKms: 0.5, terminalRangeKm: 0.001 },
        { type: "dock", targetVehicle: "iss", captureRangeKm: 0.001,
          captureRateMps: 0.2 },
        { type: "coast", days: 0.125, mode: "kepler" },
        { type: "undock", frame: "vnb", dv1: 0.002, dv2: 0, dv3: 0 },
        { type: "coast", days: 0.05, mode: "kepler" },
      ],
      vehicles: [
        {
          id: "iss",
          name: "International Space Station",
          role: "rendezvous-target",
          color: "#52d4c5",
          spacecraft: { name: "International Space Station", dryKg: 420000,
            propKg: 0, isp: 1, fovDeg: 90,
            notes: "Release-pinned SGP4 target track; not telemetry." },
          segments: [
            { type: "gp_orbit",
              line1: "1 25544U 98067A   26194.31484285  .00004029  00000+0  81266-4 0  9998",
              line2: "2 25544  51.6305 170.7871 0006687 290.3592  69.6678 15.48997295575806",
              days: 2, stepMin: 2, strictChecksum: "strict" },
          ],
        },
      ],
    },

    {
      id: "apollo11_full",
      name: "Apollo 11 - full two-vehicle timeline",
      epoch: "1969-07-16T13:32:00Z",
      spacecraft: { name: "Columbia CSM / launch stack", dryKg: 15000,
        propKg: 120000, isp: 421, fovDeg: 60,
        notes: "Stack-level teaching budget. The S-IVB supplies TLI; the CSM and " +
               "LM use different engines. The vehicle branches model mission " +
               "geometry, not coupled staging mass accounting." },
      description:
        "A two-vehicle Apollo 11 reconstruction that preserves the original " +
        "simplified preset while adding Eagle as a real branch. Columbia remains " +
        "in lunar orbit; Eagle separates, coasts to powered descent initiation, " +
        "lands, stays on the Moon, ascends, rendezvous and docks, then is jettisoned " +
        "before trans-Earth injection. Dates are pinned to history, while the " +
        "patched-conic trajectory remains an educational approximation. The Moon " +
        "landing is not site-targeted in an authoritative Moon-fixed frame, and the " +
        "second Earth-return segment is a large schematic ephemeris-absorbing " +
        "correction rather than Apollo 11's small historical midcourse correction.",
      history: [
        "GET 000:00 - Launch from Kennedy Space Center",
        "GET 002:44 - Translunar injection",
        "GET 075:50 - Lunar orbit insertion (engine result is approximate)",
        "GET 100:12 - Eagle separates from Columbia",
        "GET 102:33 - Powered descent initiation",
        "GET 102:45 - Historical Tranquility Base milestone; simulated touchdown is not site-accurate",
        "GET 124:22 - Lunar liftoff",
        "GET 128:03 - Eagle docks with Columbia",
        "GET 130:09 - Lunar module jettison",
        "GET 135:24 - Trans-Earth injection",
        "GET 195:18 - Pacific splashdown",
      ],
      segments: [
        { type: "launch", body: "earth", site: "ksc", ascent: "meco",
          altKm: 185, incDeg: 32.5, raanDeg: 0,
          targetPlane: "moon", planeTofDays: 3.15 },
        { type: "insertion", at: "apoapsis", shape: "circular", maxDays: 0.5 },
        { type: "coast", days: 0.1, mode: "kepler" },
        { type: "transfer", target: "moon", tofDays: 3.05, periKm: 110, side: "B" },
        { type: "insertion", shape: "circular", apoKm: 300, maxDays: 2 },
        { type: "coast", days: 1.0817993789, mode: "kepler" },
        { type: "coast", days: 1.1604166667, mode: "kepler" },
        { type: "coast", days: 0.2936608796407, mode: "kepler" },
        { type: "return", target: "earth", tofDays: 2.55, periKm: 40,
          optWait: "immediate" },
        { type: "return", target: "earth", tofDays: 1.4799095721822, periKm: 40,
          optWait: "immediate",
          proxyStateLabel: "Schematic ephemeris-absorbing return correction" },
        { type: "reentry", interfaceKm: 120, maxDays: 3, descentMin: 15 },
      ],
      vehicles: [
        {
          id: "eagle",
          name: "Eagle lunar module",
          role: "lunar-lander",
          color: "#e3b341",
          spacecraft: { name: "Eagle LM", dryKg: 4500, propKg: 10500,
            isp: 311, fovDeg: 60,
            notes: "Combined descent/ascent-stage teaching budget. Descent and " +
                   "ascent are schematic full-velocity events." },
          segments: [
            { type: "separate", fromVehicle: "primary", afterSegment: 6,
              delayMin: 0, frame: "vnb", dv1: 0.0003, dv2: 0, dv3: 0 },
            { type: "coast", days: 0.0979166667, mode: "kepler" },
            { type: "land", descentHours: 0.2, stayDays: 0.9006944444 },
            { type: "ascend", altKm: 110 },
            { type: "coast", days: 0.0888888889, mode: "kepler" },
            { type: "rendezvous", targetVehicle: "primary", tofHours: 1.55,
              direction: "auto", maxDvKms: 0.5, terminalRangeKm: 0.001 },
            { type: "dock", targetVehicle: "primary", captureRangeKm: 0.001,
              captureRateMps: 0.2 },
            { type: "coast", days: 0.0878611111, mode: "kepler" },
            { type: "undock", frame: "vnb", dv1: 0.002, dv2: 0, dv3: 0 },
            { type: "coast", days: 0.2, mode: "kepler" },
          ],
        },
      ],
    },

    {
      id: "jwst_l2_operations",
      name: "JWST Sun-Earth L2 halo operations",
      epoch: "2022-01-24T19:00:00Z",
      spacecraft: { name: "James Webb Space Telescope", dryKg: 5920,
        propKg: 241, isp: 300, fovDeg: 90,
        notes: "Approximate mass budget. The halo and stationkeeping are ideal " +
               "CR3BP design states, not reconstructed JWST navigation data." },
      description:
        "An ideal Sun-Earth L2 medium northern halo initialized on the date of " +
        "JWST's final insertion correction. One corrected halo cycle is followed " +
        "by one cycle of deterministic twelve-check stationkeeping, demonstrating " +
        "periodic-orbit closure, Jacobi monitoring and bounded correction burns.",
      history: [
        "2021-12-25 - JWST launch",
        "2022-01-24 - Final L2 insertion correction",
        "Model: ideal circular restricted three-body problem",
        "The roughly six-month halo is a design analogue, not flight ephemeris",
      ],
      segments: [
        { type: "libration", system: "sun-earth", point: "L2", family: "halo",
          size: "medium", hemisphere: "north" },
        { type: "cr3bp_coast", cycles: 1, tolerance: "high" },
        { type: "stationkeep", cycles: 1, corrections: 12,
          offsetKm: 50, maxBurnMs: 2 },
      ],
    },

    {
      id: "gateway_halo_operations",
      name: "Lunar Gateway halo operations",
      epoch: "2028-01-01T00:00:00Z",
      spacecraft: { name: "Gateway reference element", dryKg: 40000,
        propKg: 5000, isp: 320, fovDeg: 90,
        notes: "Concept-level mass budget. This generic L2 halo is not an " +
               "operational Gateway NRHO or a program schedule assertion." },
      description:
        "A concept mission with Gateway and an Orion visiting vehicle on distinct " +
        "ideal Earth-Moon L2 halo families. Both tracks use corrected CR3BP states " +
        "and deterministic stationkeeping. Their independent paths intentionally " +
        "exercise simultaneous libration-region rendering; CR3BP proximity docking " +
        "and coupled navigation are outside this bounded model.",
      history: [
        "Validation mission: concept geometry, not an approved flight timeline",
        "Gateway reference: medium northern Earth-Moon L2 halo",
        "Orion reference: small northern Earth-Moon L2 halo",
        "Both vehicles use ideal circular restricted three-body dynamics",
      ],
      segments: [
        { type: "libration", system: "earth-moon", point: "L2", family: "halo",
          size: "medium", hemisphere: "north" },
        { type: "cr3bp_coast", cycles: 2, tolerance: "high" },
        { type: "stationkeep", cycles: 1, corrections: 12,
          offsetKm: 5, maxBurnMs: 5 },
      ],
      vehicles: [
        {
          id: "orion",
          name: "Orion visiting vehicle",
          role: "visiting-vehicle",
          color: "#52d4c5",
          spacecraft: { name: "Orion", dryKg: 15000, propKg: 8000,
            isp: 316, fovDeg: 70,
            notes: "Concept-level co-orbital visitor; no CR3BP docking claim." },
          segments: [
            { type: "libration", system: "earth-moon", point: "L2", family: "halo",
              size: "small", hemisphere: "north" },
            { type: "cr3bp_coast", cycles: 1, tolerance: "high" },
            { type: "stationkeep", cycles: 1, corrections: 12,
              offsetKm: 20, maxBurnMs: 10 },
          ],
        },
      ],
    },

    {
      id: "apophis_2029_recon",
      name: "Apophis 2029 reconnaissance",
      epoch: "2029-04-13T12:00:00Z",
      spacecraft: { name: "Apophis observer A", dryKg: 350,
        propKg: 40, isp: 220, fovDeg: 15,
        notes: "Fictional parallax observer. The Apophis catalog elements are " +
               "approximate and must not be used for close-approach prediction." },
      description:
        "Three fictional medium-Earth-orbit observers watch 99942 Apophis through " +
        "the 2029 encounter. Two small normal separation impulses create a " +
        "parallax baseline while every craft retains an independent observation " +
        "track. The app's compact catalog reproduces the encounter qualitatively; " +
        "authoritative planetary-defense ephemerides are required for real analysis.",
      history: [
        "2029-04-13 - Apophis is predicted to pass Earth safely",
        "Catalog-model closest approach: about 32,204 km geocentric near Apr 14 00:55 UTC",
        "Observer constellation: fictional validation design",
      ],
      segments: [
        { type: "launch", body: "earth", site: "", ascent: "direct",
          altKm: 20000, incDeg: 40, raanDeg: 0 },
        { type: "observe", target: "apophis", days: 1.2, mode: "kepler" },
      ],
      vehicles: [
        {
          id: "observer_b",
          name: "Apophis observer B",
          role: "observer",
          color: "#52d4c5",
          spacecraft: { name: "Apophis observer B", dryKg: 350,
            propKg: 40, isp: 220, fovDeg: 15 },
          segments: [
            { type: "separate", fromVehicle: "primary", afterSegment: 1,
              delayMin: 0, frame: "vnb", dv1: 0, dv2: 0.005, dv3: 0 },
            { type: "observe", target: "apophis", days: 1.2, mode: "kepler" },
          ],
        },
        {
          id: "observer_c",
          name: "Apophis observer C",
          role: "observer",
          color: "#a371f7",
          spacecraft: { name: "Apophis observer C", dryKg: 350,
            propKg: 40, isp: 220, fovDeg: 15 },
          segments: [
            { type: "separate", fromVehicle: "primary", afterSegment: 1,
              delayMin: 0, frame: "vnb", dv1: 0, dv2: -0.005, dv3: 0 },
            { type: "observe", target: "apophis", days: 1.2, mode: "kepler" },
          ],
        },
      ],
    },

    {
      id: "osiris_rex_sample_return",
      name: "OSIRIS-REx Bennu sample return",
      epoch: "2023-09-24T10:42:00Z",
      spacecraft: { name: "OSIRIS-REx / OSIRIS-APEX bus", dryKg: 1600,
        propKg: 200, isp: 220, fovDeg: 30,
        notes: "The 50,000 km circular initializer is a schematic inbound-state " +
               "proxy, not a reconstructed OSIRIS-REx trajectory." },
      description:
        "A two-vehicle return-capsule demonstration anchored to the real sample " +
        "release UTC. The bus and Sample Return Capsule separate from a clearly " +
        "labelled schematic Earth-centered proxy state; the capsule targets the " +
        "entry corridor and lands about 4.21 hours later while the bus remains " +
        "aloft. This preset validates branching, independent endings and reentry.",
      history: [
        "2016-09-08 - OSIRIS-REx launch",
        "2020-10-20 - Sample collected at Bennu",
        "2023-09-24 10:42 UTC - Sample Return Capsule released",
        "State initializer: schematic 50,000 km circular proxy, not flight ephemeris",
      ],
      segments: [
        { type: "launch", body: "earth", site: "", ascent: "direct",
          altKm: 50000, incDeg: 30, raanDeg: 0 },
        { type: "observe", target: "earth", days: 0.3, mode: "kepler" },
      ],
      vehicles: [
        {
          id: "src",
          name: "Sample Return Capsule",
          role: "return-capsule",
          color: "#e3b341",
          spacecraft: { name: "OSIRIS-REx Sample Return Capsule", dryKg: 46,
            propKg: 0, isp: 1, fovDeg: 80,
            notes: "Ballistic capsule; the targeting impulse belongs to the " +
                   "schematic state proxy rather than capsule propulsion." },
          segments: [
            { type: "separate", fromVehicle: "primary", afterSegment: 1,
              delayMin: 0, frame: "vnb", dv1: 0, dv2: 0, dv3: 0 },
            { type: "return", target: "earth", tofDays: 0.17, periKm: 40,
              optWait: "immediate",
              proxyStateLabel: "Schematic proxy-state retarget (not capsule propulsion)" },
            { type: "reentry", interfaceKm: 120, maxDays: 1, descentMin: 10 },
          ],
        },
      ],
    },

    {
      id: "sso_imaging_campaign",
      name: "Sun-synchronous Earth imaging campaign",
      epoch: "2026-07-13T00:00:00Z",
      spacecraft: { name: "Imager A", dryKg: 600, propKg: 40,
        isp: 220, fovDeg: 25,
        notes: "A design constellation initialized directly in the equatorial " +
               "J2 frame. No launch-site ascent is claimed." },
      description:
        "A three-spacecraft 600 km imaging campaign using first-order Earth J2 " +
        "secular propagation. The 97.75966 degree inclination produces about " +
        "+0.98565 degrees per day of nodal drift in this model. Small deployment " +
        "impulses separate the followers while sensor swaths, eclipse geometry " +
        "and a Svalbard teaching station exercise the operations displays.",
      history: [
        "Validation mission: not a historical constellation",
        "Reference orbit: 600 km, 97.75966 deg, first-order J2 secular",
        "Expected nodal drift: about +0.98565 deg/day",
      ],
      operations: {
        sensorFovDeg: 25,
        sensorOffNadirDeg: 5,
        sensorSwath: true,
        stationMarkers: true,
        eclipse3d: true,
        stations: [
          { id: "svalbard-sso", name: "Svalbard teaching site", bodyId: "earth",
            latDeg: 78.2298, lonDeg: 15.4078, altKm: 0.46,
            elevationMaskDeg: 5, complex: null },
        ],
      },
      segments: [
        { type: "launch", body: "earth", site: "", ascent: "direct",
          altKm: 600, incDeg: 97.75966, raanDeg: 15 },
        { type: "coast", days: 3, mode: "j2-secular" },
      ],
      vehicles: [
        {
          id: "imager_b",
          name: "Imager B",
          role: "imager",
          color: "#52d4c5",
          spacecraft: { name: "Imager B", dryKg: 600, propKg: 40,
            isp: 220, fovDeg: 25 },
          segments: [
            { type: "separate", fromVehicle: "primary", afterSegment: 1,
              delayMin: 0, frame: "vnb", dv1: -0.005, dv2: 0, dv3: 0 },
            { type: "coast", days: 3, mode: "j2-secular" },
          ],
        },
        {
          id: "imager_c",
          name: "Imager C",
          role: "imager",
          color: "#a371f7",
          spacecraft: { name: "Imager C", dryKg: 600, propKg: 40,
            isp: 220, fovDeg: 25 },
          segments: [
            { type: "separate", fromVehicle: "primary", afterSegment: 1,
              delayMin: 0, frame: "vnb", dv1: 0.005, dv2: 0, dv3: 0 },
            { type: "coast", days: 3, mode: "j2-secular" },
          ],
        },
      ],
    },

    {
      id: "electric_geo_raise",
      name: "Electric supersynchronous orbit-raising campaign",
      epoch: "2026-07-13T00:00:00Z",
      spacecraft: { name: "High-power electric orbit-raising tug", dryKg: 600,
        propKg: 500, isp: 2000, fovDeg: 50,
        notes: "A deliberately accelerated five-newton teaching case. Real " +
               "commercial electric orbit raising commonly takes much longer." },
      description:
        "A high-power electric tug raises apoapsis continuously during two five-day " +
        "finite burns, with a short coast between them. The accelerated campaign " +
        "finishes in a supersynchronous high orbit, deploys a payload and then shows two " +
        "independent high-orbit tracks. It is tuned for interactive finite-thrust " +
        "visualization rather than an operational propulsion timeline.",
      history: [
        "Validation mission: accelerated finite-thrust teaching design",
        "Two 5 d burns at 5 N and 2,000 s specific impulse",
        "Expected final tug orbit: roughly 36,300 x 41,400 km altitude",
      ],
      segments: [
        { type: "launch", body: "earth", site: "kourou", ascent: "direct",
          altKm: 1000, incDeg: 5.2, raanDeg: 0 },
        { type: "finite_burn", durationMin: 7200, thrustN: 5, ispS: 2000,
          direction: "prograde", gravity: "central-relative" },
        { type: "coast", days: 0.2, mode: "kepler" },
        { type: "finite_burn", durationMin: 7200, thrustN: 5, ispS: 2000,
          direction: "prograde", gravity: "central-relative" },
        { type: "coast", days: 2, mode: "kepler" },
      ],
      vehicles: [
        {
          id: "payload",
          name: "Delivered supersynchronous payload",
          role: "payload",
          color: "#52d4c5",
          spacecraft: { name: "Delivered supersynchronous payload", dryKg: 300,
            propKg: 10, isp: 220, fovDeg: 45 },
          segments: [
            { type: "separate", fromVehicle: "primary", afterSegment: 4,
              delayMin: 0, frame: "vnb", dv1: 0.001, dv2: 0, dv3: 0 },
            { type: "coast", days: 2, mode: "kepler" },
          ],
        },
      ],
    },

    {
      id: "leo_conjunction_lab",
      name: "LEO conjunction avoidance and uncertainty lab",
      epoch: "2026-07-13T00:00:00Z",
      spacecraft: { name: "Protected Earth-observation satellite", dryKg: 500,
        propKg: 50, isp: 220, fovDeg: 35,
        notes: "Deterministic teaching geometry with a seeded, bounded local " +
               "uncertainty study. It is not a conjunction data message." },
      description:
        "Two nearly co-planar LEO tracks create a close approach. The protected " +
        "satellite performs a twelve metre-per-second normal avoidance burn about " +
        "8.6 minutes after initialization. In the deterministic model the maneuver " +
        "moves closest approach from about 0.92 km to 2.35 km. A seeded 1,000-case " +
        "execution-dispersion study and two-kilometre conjunction threshold expose " +
        "the distinction between nominal miss distance and bounded confidence. " +
        "Select the no-burn reference vehicle in Data to reproduce the baseline " +
        "closest approach against the debris object.",
      history: [
        "Validation mission: synthetic conjunction, not operational tracking data",
        "No-burn deterministic closest approach: about 0.920 km at T+24.3 min",
        "Nominal 12 m/s normal-burn closest approach: about 2.349 km",
        "Uncertainty: 100 m position, 0.1 m/s velocity 1-sigma; seed 1919",
      ],
      uncertainty: {
        source: { beforeSegment: 2, label: "pre-avoidance state" },
        positionSigmaKm: 0.1,
        velocitySigmaKmS: 0.0001,
        samples: 1000,
        seed: 1919,
        propagationHours: 6,
        maneuver: {
          dv: [0, 0, 0.012],
          frame: "RTN",
          execution: {
            magnitudeSigmaFraction: 0.005,
            pointingSigmaRad: 0.002618,
            timingSigmaS: 0.5,
          },
        },
      },
      operations: {
        conjunctionThresholdKm: 2,
        stationMarkers: true,
        eclipse3d: true,
      },
      segments: [
        { type: "launch", body: "earth", site: "", ascent: "direct",
          altKm: 700, incDeg: 98.2, raanDeg: 20 },
        { type: "coast", days: 0.006, mode: "kepler" },
        { type: "impulse", frame: "vnb", dv1: 0, dv2: 0.012, dv3: 0 },
        { type: "coast", days: 0.994, mode: "kepler" },
      ],
      vehicles: [
        {
          id: "debris",
          name: "Tracked debris object",
          role: "debris",
          color: "#a371f7",
          spacecraft: { name: "Tracked debris object", dryKg: 50,
            propKg: 0, isp: 1, fovDeg: 10,
            notes: "Synthetic state used only for deterministic conjunction validation." },
          segments: [
            { type: "launch", body: "earth", site: "", ascent: "direct",
              altKm: 699.4, incDeg: 98.2, raanDeg: 20.04 },
            { type: "coast", days: 1, mode: "kepler" },
          ],
        },
        {
          id: "no_burn_reference",
          name: "No-burn protected-satellite reference",
          role: "validation-reference",
          color: "#e3b341",
          spacecraft: { name: "No-burn protected-satellite reference", dryKg: 500,
            propKg: 50, isp: 220, fovDeg: 35,
            notes: "Synthetic counterfactual branch used to reproduce the no-burn miss distance." },
          segments: [
            { type: "launch", body: "earth", site: "", ascent: "direct",
              altKm: 700, incDeg: 98.2, raanDeg: 20 },
            { type: "coast", days: 1, mode: "kepler" },
          ],
        },
      ],
    },

    {
      id: "europa_clipper_mega",
      name: "Europa Clipper MEGA trajectory (2024)",
      epoch: "2024-10-14T16:06:00Z",
      spacecraft: { name: "Europa Clipper", dryKg: 6000, propKg: "",
        isp: 315, fovDeg: 50,
        notes: "Historical route reconstruction with propellant tracking off. " +
               "The patched-conic TCMs absorb simplified catalog-ephemeris error; " +
               "they are not the mission's flown maneuver budget." },
      description:
        "A sourced reconstruction of Europa Clipper's Mars-Earth Gravity " +
        "Assist route: launch from Kennedy on 14 October 2024, the 884 km " +
        "Mars pass on 1 March 2025, the planned December 2026 Earth assist, " +
        "and planned April 2030 Jupiter arrival. A representative Jovian " +
        "phasing coast and Europa flyby follow. The real arrival uses a close " +
        "Ganymede braking assist and a roughly year-long pump-down tour; those " +
        "multi-moon details are outside this bounded patched-conic preset.",
      history: [
        "2024-10-14 16:06 UTC — Falcon Heavy launch from Kennedy LC-39A",
        "2025-03-01 17:57 UTC — Mars gravity assist, 884 km altitude",
        "December 2026 — planned Earth gravity assist, about 3,200 km altitude",
        "2030-04-11 — planned Jupiter orbit insertion after Ganymede assist",
        "Prime tour: dozens of Europa flybys while orbiting Jupiter, not Europa",
      ],
      segments: [
        { type: "launch", body: "earth", site: "ksc", ascent: "meco",
          altKm: 185, incDeg: 28.5, raanDeg: 0 },
        { type: "insertion", at: "apoapsis", shape: "circular", maxDays: 0.5 },
        { type: "coast", days: 0.08, mode: "kepler" },
        { type: "depart", target: "mars", tofDays: 138, periKm: 884, side: "A" },
        { type: "flyby", dvKms: 0, maxDays: 30 },
        { type: "transfer", target: "earth", tofDays: 641, periKm: 3200,
          side: "A", optWait: "immediate" },
        { type: "flyby", dvKms: 0, maxDays: 30 },
        { type: "transfer", target: "jupiter", tofDays: 1236, periKm: 200000,
          side: "A", optWait: "immediate" },
        { type: "insertion", at: "periapsis", shape: "elliptical",
          apoKm: 12000000, maxDays: 130 },
        { type: "coast", days: 270, mode: "kepler" },
        { type: "transfer", target: "europa", tofDays: 5, periKm: 50,
          side: "A", optWait: "optimal" },
        { type: "flyby", dvKms: 0, maxDays: 20 },
        { type: "coast", days: 30, mode: "kepler" },
      ],
    },

    {
      id: "parker_early_venus_tour",
      name: "Parker Solar Probe — early Venus tour (2018)",
      epoch: "2018-08-12T07:31:00Z",
      spacecraft: { name: "Parker Solar Probe", dryKg: 685, propKg: "",
        isp: 220, fovDeg: 50,
        notes: "Historical early-tour reconstruction with propellant tracking " +
               "off. The app's single-revolution Lambert solver cannot reproduce " +
               "the complete seven-assist resonant sequence without false burns." },
      description:
        "The first two Venus gravity assists of Parker Solar Probe's " +
        "perihelion-lowering campaign. The 3 October 2018 and 26 December " +
        "2019 encounters show Venus removing heliocentric energy and lowering " +
        "solar perihelion. The flown mission used seven Venus assists and 24 " +
        "planned close-Sun orbits; this preset intentionally stops before the " +
        "multi-revolution same-body legs that the current Lambert solver cannot " +
        "represent faithfully.",
      history: [
        "2018-08-12 — Delta IV Heavy launch from Cape Canaveral",
        "2018-10-03 — Venus gravity assist 1, about 2,415 km altitude",
        "2019-12-26 — Venus gravity assist 2, about 3,009 km altitude",
        "Complete mission design: seven Venus assists and 24 close-Sun orbits",
      ],
      segments: [
        { type: "launch", body: "earth", site: "ksc", ascent: "meco",
          altKm: 185, incDeg: 28.5, raanDeg: 0 },
        { type: "insertion", at: "apoapsis", shape: "circular", maxDays: 0.5 },
        { type: "coast", days: 0.08, mode: "kepler" },
        { type: "depart", target: "venus", tofDays: 52, periKm: 2415, side: "B" },
        { type: "flyby", dvKms: 0, maxDays: 30 },
        { type: "transfer", target: "venus", tofDays: 449, periKm: 3009,
          side: "B", optWait: "immediate" },
        { type: "flyby", dvKms: 0, maxDays: 30 },
        { type: "coast", days: 180, mode: "kepler" },
      ],
    },
  ];

  const CATALOG_GROUPS = Object.freeze([
    "Featured",
    "Historical",
    "Design Studies",
    "Operations",
    "Engineering / Validation",
    "Quick Start / Legacy",
    "Archive",
  ]);

  // Catalog metadata is kept separate from the physical mission definitions:
  // moving a preset between product groups must never alter its date-pinned
  // trajectory. Sources describe the intended reconstruction, not telemetry.
  const CATALOG_META = Object.freeze({
    apollo11: { category: "Quick Start / Legacy", fidelity: "simplified-historical",
      status: "legacy", runtime: "medium", featureTags: ["lunar", "tutorial", "return"] },
    apollo13: { category: "Featured", fidelity: "simplified-historical",
      status: "active", runtime: "medium", featured: true,
      featureTags: ["lunar", "free-return", "flyby"] },
    artemis2: { category: "Featured", fidelity: "date-pinned-historical",
      status: "active", runtime: "medium", featured: true,
      sources: [
        "https://www.nasa.gov/news-release/nasas-artemis-ii-mission-leaves-earth-orbit-for-flight-around-moon/",
        "https://www.nasa.gov/blogs/missions/2026/04/06/artemis-ii-flight-day-6-lunar-flyby-updates/",
        "https://www.nasa.gov/news-release/nasa-welcomes-record-setting-artemis-ii-moonfarers-back-to-earth/",
      ],
      featureTags: ["lunar", "crewed", "flyby", "free-return", "reentry"] },
    cassini: { category: "Featured", fidelity: "date-pinned-historical",
      status: "active", runtime: "long", featured: true,
      featureTags: ["gravity-assist", "outer-planets", "observation"] },
    voyager1: { category: "Featured", fidelity: "date-pinned-historical",
      status: "active", runtime: "long", featured: true,
      featureTags: ["gravity-assist", "outer-planets", "interstellar"] },
    voyager2: { category: "Featured", fidelity: "date-pinned-historical",
      status: "active", runtime: "long", featured: true,
      featureTags: ["grand-tour", "gravity-assist", "interstellar"] },
    mars2026: { category: "Design Studies", fidelity: "design-study",
      status: "active", runtime: "medium", featureTags: ["lambert", "mars", "capture"] },
    artemis: { category: "Design Studies", fidelity: "concept-study",
      status: "active", runtime: "medium", featureTags: ["lunar", "return", "reentry"] },
    europa: { category: "Archive", fidelity: "hypothetical-direct",
      status: "archived", runtime: "long", featureTags: ["jupiter", "europa", "legacy"] },
    titan: { category: "Archive", fidelity: "hypothetical-direct",
      status: "archived", runtime: "long", featureTags: ["saturn", "titan", "legacy"] },
    earth_moon_l2_halo: { category: "Design Studies", fidelity: "ideal-cr3bp",
      status: "active", runtime: "short", featureTags: ["cr3bp", "halo", "stationkeeping"] },
    finite_burn_demo: { category: "Design Studies", fidelity: "teaching-model",
      status: "active", runtime: "short", featureTags: ["finite-thrust", "apoapsis"] },
    sun_earth_l1_lissajous: { category: "Design Studies", fidelity: "ideal-cr3bp",
      status: "active", runtime: "short", featureTags: ["cr3bp", "lissajous", "stationkeeping"] },
    leo_environment_lab: { category: "Engineering / Validation", fidelity: "validation",
      status: "active", runtime: "short", featureTags: ["drag", "harmonics", "horizons"] },
    geo_srp_horizons: { category: "Engineering / Validation", fidelity: "validation",
      status: "active", runtime: "short", featureTags: ["srp", "eclipse", "horizons"] },
    sdp4_validation: { category: "Engineering / Validation", fidelity: "validation",
      status: "active", runtime: "short", featureTags: ["sdp4", "teme", "reference"] },
    leo_disposal_uncertainty: { category: "Engineering / Validation", fidelity: "validation",
      status: "active", runtime: "short", featureTags: ["uncertainty", "operations", "disposal"] },
    mars_joint_target_lab: { category: "Engineering / Validation", fidelity: "validation",
      status: "active", runtime: "medium", featureTags: ["targeting", "mars", "b-plane"] },
    iss_orbital_reference: { category: "Engineering / Validation", fidelity: "gp-reference",
      status: "active", runtime: "short", featureTags: ["sgp4", "iss", "reference"] },
    crew_dragon_iss_docking: { category: "Featured", fidelity: "teaching-reconstruction",
      status: "active", runtime: "short", featured: true,
      featureTags: ["rendezvous", "docking", "multi-vehicle"] },
    apollo11_full: { category: "Featured", fidelity: "teaching-reconstruction",
      status: "active", runtime: "long", featured: true,
      featureTags: ["lunar", "multi-vehicle", "landing"] },
    jwst_l2_operations: { category: "Featured", fidelity: "ideal-cr3bp-operations",
      status: "active", runtime: "short", featured: true,
      featureTags: ["l2", "halo", "stationkeeping"] },
    gateway_halo_operations: { category: "Operations", fidelity: "ideal-cr3bp-operations",
      status: "active", runtime: "short", featureTags: ["lunar", "halo", "stationkeeping"] },
    apophis_2029_recon: { category: "Operations", fidelity: "concept-study",
      status: "active", runtime: "short", featureTags: ["small-body", "formation", "flyby"] },
    osiris_rex_sample_return: { category: "Featured", fidelity: "teaching-reconstruction",
      status: "active", runtime: "short", featured: true,
      featureTags: ["sample-return", "separation", "earth"] },
    sso_imaging_campaign: { category: "Operations", fidelity: "operations-study",
      status: "active", runtime: "short", featureTags: ["access", "imaging", "j2"] },
    electric_geo_raise: { category: "Featured", fidelity: "teaching-model",
      status: "active", runtime: "long", featured: true,
      featureTags: ["finite-thrust", "multi-vehicle", "orbit-raise"] },
    leo_conjunction_lab: { category: "Operations", fidelity: "validation-study",
      status: "active", runtime: "short", featureTags: ["conjunction", "uncertainty", "avoidance"] },
    europa_clipper_mega: { category: "Featured", fidelity: "date-pinned-historical",
      status: "active", runtime: "long", featured: true,
      sources: [
        "https://science.nasa.gov/mission/europa-clipper/mission-timeline/",
        "https://www.jpl.nasa.gov/press-kits/europa-clipper/mission/",
      ],
      featureTags: ["gravity-assist", "jupiter", "europa"] },
    parker_early_venus_tour: { category: "Historical", fidelity: "date-pinned-historical-subset",
      status: "active", runtime: "medium",
      sources: [
        "https://www.nasa.gov/solar-system/parker-solar-probe-changed-the-game-before-it-even-launched/",
        "https://parker.gsfc.nasa.gov/overview.html",
      ],
      featureTags: ["gravity-assist", "venus", "solar"] },
  });

  for (const preset of PRESETS) {
    const meta = CATALOG_META[preset.id] || {};
    Object.assign(preset, {
      category: meta.category || "Design Studies",
      fidelity: meta.fidelity || "simplified",
      status: meta.status || "active",
      sources: Array.isArray(meta.sources) ? meta.sources.slice() : [],
      featureTags: Array.isArray(meta.featureTags) ? meta.featureTags.slice() : [],
      featured: !!meta.featured,
      expectedRuntime: meta.runtime || "medium",
    });
  }

  function getPreset(id) {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return null;
    // deep copy so edits never touch the template
    const { id: presetId, ...mission } = p;
    return JSON.parse(JSON.stringify(mission));
  }

  globalThis.Missions = { PRESETS, CATALOG_GROUPS, getPreset };
})();
