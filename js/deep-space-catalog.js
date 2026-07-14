/* =============================================================================
 * Mission Trajectory Planner - curated Deep 100 mission atlas.
 *
 * This is a metadata catalog, not an ephemeris and not an operational-status
 * feed.  It deliberately combines ongoing and historical mission assets.  A
 * renderer must only draw a position when a separately generated ephemeris
 * bundle covers the requested UTC; Horizons target registration does not mean
 * that a mission is active or that a current trajectory is available.
 *
 * Target IDs were reviewed against the NASA/JPL Horizons major-body spacecraft
 * index on 2026-07-12.  Horizons documentation reports 239 spacecraft targets,
 * but spacecraft trajectories can be predictive, reconstructed, historical,
 * delayed, or absent at the requested time.  Direct browser requests are not
 * part of this contract: release tooling should generate static data so the app
 * remains usable from file:// and GitHub Pages.
 * ========================================================================== */
"use strict";

(function () {
  const WIKI = "https://en.wikipedia.org/wiki/";

  const GROUP_LABELS = Object.freeze({
    LUNAR: "Moon and cislunar space",
    MARS: "Mars system",
    INNER_HELIO: "Inner planets and solar exploration",
    OUTER: "Outer planets and interstellar space",
    SMALL_BODY: "Asteroids, comets, and sample return",
    OBSERVATORY: "Heliophysics and deep-space observatories",
  });

  const GROUP_SUMMARIES = Object.freeze({
    LUNAR: "Lunar orbiters, landers, impactors, and cislunar technology missions.",
    MARS: "Mars orbiters, landers, rovers, flyby craft, and interplanetary relays.",
    INNER_HELIO: "Venus, Mercury, and solar-orbit missions operating inside or across Earth's orbit.",
    OUTER: "Jupiter, Saturn, Pluto, heliopause, and interstellar-bound missions.",
    SMALL_BODY: "Asteroid and comet rendezvous, impact, flyby, and sample-return missions.",
    OBSERVATORY: "Sun-Earth Lagrange-point, heliospheric, and heliocentric astronomy missions.",
  });

  /* Ephemeris availability is separate from agency-reported mission status. */
  const EPHEMERIS_STATUS_LABELS = Object.freeze({
    CURRENT: "Current-date bundled trajectory",
    PREDICTED: "Bundled predictive trajectory",
    ARCHIVE: "Archived mission-era trajectory",
    SURFACE: "Surface or impact-site record",
    CATALOG: "Catalog only - no reliable position",
  });

  function mission(horizonsId, name, group, agency, destination, wikiSlug, surfaceBody) {
    const record = {
      id: "horizons:" + horizonsId,
      horizonsId: String(horizonsId),
      name,
      group,
      groupLabel: GROUP_LABELS[group],
      agency,
      destination,
      summary: GROUP_SUMMARIES[group],
      /* Never infer operational state from Horizons coverage. */
      operationalStatus: "UNVERIFIED",
      wiki: wikiSlug ? WIKI + wikiSlug : "",
    };
    if (surfaceBody) record.surfaceBody = surfaceBody;
    return Object.freeze(record);
  }

  const missions = [
    /* ----------------------- LUNAR: 20 entries ----------------------- */
    mission(-12, "LADEE", "LUNAR", "NASA", "Moon", "LADEE"),
    mission(-18, "LCROSS Shepherding Spacecraft", "LUNAR", "NASA", "Moon", "LCROSS"),
    mission(-25, "Lunar Prospector", "LUNAR", "NASA", "Moon", "Lunar_Prospector"),
    mission(-40, "Clementine", "LUNAR", "BMDO / NASA", "Moon", "Clementine_(spacecraft)"),
    mission(-75, "OMOTENASHI", "LUNAR", "JAXA", "Moon", "OMOTENASHI"),
    mission(-85, "Lunar Reconnaissance Orbiter", "LUNAR", "NASA", "Moon", "Lunar_Reconnaissance_Orbiter"),
    mission(-86, "Chandrayaan-1", "LUNAR", "ISRO", "Moon", "Chandrayaan-1"),
    mission(-101, "EQUULEUS", "LUNAR", "JAXA / University of Tokyo", "Earth-Moon region", "EQUULEUS"),
    mission(-152, "Chandrayaan-2 Orbiter", "LUNAR", "ISRO", "Moon", "Chandrayaan-2"),
    mission(-153, "Chandrayaan-2 Vikram Lander", "LUNAR", "ISRO", "Moon", "Chandrayaan-2"),
    mission(-155, "Danuri", "LUNAR", "KARI", "Moon", "Danuri"),
    mission(-158, "Chandrayaan-3 Vikram Lander", "LUNAR", "ISRO", "Moon", "Chandrayaan-3"),
    mission(-164, "Lunar Flashlight", "LUNAR", "NASA / JPL", "Moon", "Lunar_Flashlight"),
    mission(-169, "Chandrayaan-3 Propulsion Module", "LUNAR", "ISRO", "Earth-Moon region", "Chandrayaan-3"),
    mission(-177, "GRAIL-A (Ebb)", "LUNAR", "NASA / JPL", "Moon", "GRAIL"),
    mission(-181, "GRAIL-B (Flow)", "LUNAR", "NASA / JPL", "Moon", "GRAIL"),
    mission(-240, "SLIM", "LUNAR", "JAXA", "Moon", "Smart_Lander_for_Investigating_Moon"),
    mission(-242, "Lunar Trailblazer", "LUNAR", "NASA / JPL", "Moon", "Lunar_Trailblazer"),
    mission(-1023, "Artemis I Orion", "LUNAR", "NASA", "Moon", "Artemis_1"),
    mission(-1176, "CAPSTONE", "LUNAR", "NASA / Advanced Space", "Near-rectilinear lunar halo orbit", "CAPSTONE_(spacecraft)"),

    /* ------------------------ MARS: 20 entries ----------------------- */
    mission(-3, "Mars Orbiter Mission (Mangalyaan)", "MARS", "ISRO", "Mars", "Mars_Orbiter_Mission"),
    mission(-9, "ESCAPADE Blue", "MARS", "NASA / Rocket Lab", "Mars", "EscaPADE"),
    mission(-10, "ESCAPADE Gold", "MARS", "NASA / Rocket Lab", "Mars", "EscaPADE"),
    mission(-41, "Mars Express", "MARS", "ESA", "Mars", "Mars_Express"),
    mission(-53, "2001 Mars Odyssey", "MARS", "NASA / JPL", "Mars", "2001_Mars_Odyssey"),
    mission(-62, "Emirates Mars Mission (Hope)", "MARS", "UAE Space Agency", "Mars", "Emirates_Mars_Mission"),
    mission(-65, "MarCO-A (WALL-E)", "MARS", "NASA / JPL", "Mars flyby", "Mars_Cube_One"),
    mission(-66, "MarCO-B (EVE)", "MARS", "NASA / JPL", "Mars flyby", "Mars_Cube_One"),
    mission(-74, "Mars Reconnaissance Orbiter", "MARS", "NASA / JPL", "Mars", "Mars_Reconnaissance_Orbiter"),
    mission(-76, "Curiosity (Mars Science Laboratory)", "MARS", "NASA / JPL", "Mars surface", "Curiosity_(rover)", "mars"),
    mission(-84, "Phoenix", "MARS", "NASA / JPL", "Mars surface", "Phoenix_(spacecraft)", "mars"),
    mission(-143, "ExoMars Trace Gas Orbiter", "MARS", "ESA / Roscosmos", "Mars", "ExoMars_Trace_Gas_Orbiter"),
    mission(-168, "Mars 2020 (Perseverance)", "MARS", "NASA / JPL", "Mars surface", "Mars_2020", "mars"),
    mission(-178, "Nozomi", "MARS", "JAXA / ISAS", "Mars flyby", "Nozomi_(spacecraft)"),
    mission(-189, "InSight", "MARS", "NASA / JPL", "Mars surface", "InSight", "mars"),
    mission(-202, "MAVEN", "MARS", "NASA", "Mars", "MAVEN"),
    mission(-253, "Opportunity", "MARS", "NASA / JPL", "Mars surface", "Opportunity_(rover)", "mars"),
    mission(-254, "Spirit", "MARS", "NASA / JPL", "Mars surface", "Spirit_(rover)", "mars"),
    mission(-530, "Mars Pathfinder", "MARS", "NASA / JPL", "Mars surface", "Mars_Pathfinder", "mars"),
    mission(-9901491, "Tianwen-1", "MARS", "CNSA", "Mars", "Tianwen-1"),

    /* ------------ INNER PLANETS + SOLAR: 10 entries ---------------- */
    mission(-2, "Mariner 2", "INNER_HELIO", "NASA / JPL", "Venus flyby", "Mariner_2"),
    mission(-5, "Akatsuki", "INNER_HELIO", "JAXA / ISAS", "Venus", "Akatsuki_(spacecraft)"),
    mission(-6, "Pioneer 6", "INNER_HELIO", "NASA", "Heliocentric orbit", "Pioneer_6,_7,_8,_and_9"),
    mission(-20, "Pioneer 8", "INNER_HELIO", "NASA", "Heliocentric orbit", "Pioneer_6,_7,_8,_and_9"),
    mission(-55, "Ulysses", "INNER_HELIO", "ESA / NASA", "Solar polar orbit", "Ulysses_(spacecraft)"),
    mission(-96, "Parker Solar Probe", "INNER_HELIO", "NASA", "Sun", "Parker_Solar_Probe"),
    mission(-121, "BepiColombo", "INNER_HELIO", "ESA / JAXA", "Mercury", "BepiColombo"),
    mission(-144, "Solar Orbiter", "INNER_HELIO", "ESA / NASA", "Sun", "Solar_Orbiter"),
    mission(-236, "MESSENGER", "INNER_HELIO", "NASA / APL", "Mercury", "MESSENGER"),
    mission(-248, "Venus Express", "INNER_HELIO", "ESA", "Venus", "Venus_Express"),

    /* ------------------------ OUTER: 12 entries ---------------------- */
    mission(-23, "Pioneer 10", "OUTER", "NASA", "Interstellar-bound", "Pioneer_10"),
    mission(-24, "Pioneer 11", "OUTER", "NASA", "Interstellar-bound", "Pioneer_11"),
    mission(-28, "JUICE", "OUTER", "ESA", "Jupiter system", "Jupiter_Icy_Moons_Explorer"),
    mission(-31, "Voyager 1", "OUTER", "NASA / JPL", "Interstellar space", "Voyager_1"),
    mission(-32, "Voyager 2", "OUTER", "NASA / JPL", "Interstellar space", "Voyager_2"),
    mission(-61, "Juno", "OUTER", "NASA / JPL", "Jupiter", "Juno_(spacecraft)"),
    mission(-77, "Galileo Orbiter", "OUTER", "NASA / JPL", "Jupiter system", "Galileo_(spacecraft)"),
    mission(-82, "Cassini", "OUTER", "NASA / ESA / ASI", "Saturn system", "Cassini%E2%80%93Huygens"),
    mission(-98, "New Horizons", "OUTER", "NASA / APL", "Kuiper belt", "New_Horizons"),
    mission(-150, "Huygens", "OUTER", "ESA / NASA / ASI", "Titan surface", "Huygens_(spacecraft)"),
    mission(-159, "Europa Clipper", "OUTER", "NASA / JPL", "Jupiter system", "Europa_Clipper"),
    mission(-344, "Galileo Atmospheric Probe", "OUTER", "NASA / JPL", "Jupiter atmosphere", "Galileo_Probe"),

    /* --------------------- SMALL BODY: 20 entries -------------------- */
    mission(-29, "Stardust", "SMALL_BODY", "NASA / JPL", "Comet Wild 2", "Stardust_(spacecraft)"),
    mission(-30, "Deep Space 1", "SMALL_BODY", "NASA / JPL", "Comet Borrelly", "Deep_Space_1"),
    mission(-37, "Hayabusa2", "SMALL_BODY", "JAXA", "Asteroid 1998 KY26", "Hayabusa2"),
    mission(-47, "Genesis", "SMALL_BODY", "NASA / JPL", "Sun-Earth L1 / sample return", "Genesis_(spacecraft)"),
    mission(-49, "Lucy", "SMALL_BODY", "NASA / SwRI", "Jupiter Trojans", "Lucy_(spacecraft)"),
    mission(-64, "OSIRIS-APEX", "SMALL_BODY", "NASA / University of Arizona", "Asteroid Apophis", "OSIRIS-REx"),
    mission(-70, "Deep Impact Impactor", "SMALL_BODY", "NASA / JPL", "Comet Tempel 1", "Deep_Impact_(spacecraft)"),
    mission(-91, "Hera", "SMALL_BODY", "ESA", "Didymos system", "Hera_(space_mission)"),
    mission(-93, "NEAR Shoemaker", "SMALL_BODY", "NASA / APL", "Asteroid Eros", "NEAR_Shoemaker"),
    mission(-111, "ICE (ISEE-3)", "SMALL_BODY", "NASA / ESA", "Comet Giacobini-Zinner", "International_Cometary_Explorer"),
    mission(-130, "Hayabusa", "SMALL_BODY", "JAXA", "Asteroid Itokawa", "Hayabusa"),
    mission(-135, "DART", "SMALL_BODY", "NASA / APL", "Dimorphos", "Double_Asteroid_Redirection_Test"),
    mission(-140, "EPOXI", "SMALL_BODY", "NASA / JPL", "Comet Hartley 2", "EPOXI"),
    mission(-182, "NEA Scout", "SMALL_BODY", "NASA", "Near-Earth asteroid mission", "NEA_Scout"),
    mission(-203, "Dawn", "SMALL_BODY", "NASA / JPL", "Vesta and Ceres", "Dawn_(spacecraft)"),
    mission(-210, "LICIACube", "SMALL_BODY", "Italian Space Agency", "Didymos system", "LICIACube"),
    mission(-226, "Rosetta", "SMALL_BODY", "ESA", "Comet 67P", "Rosetta_(spacecraft)"),
    mission(-255, "Psyche", "SMALL_BODY", "NASA / JPL", "Asteroid Psyche", "Psyche_(spacecraft)"),
    mission(-29900, "Stardust Sample Return Capsule", "SMALL_BODY", "NASA / JPL", "Earth return", "Stardust_(spacecraft)"),
    mission(-47900, "Genesis Sample Return Capsule", "SMALL_BODY", "NASA / JPL", "Earth return", "Genesis_(spacecraft)"),

    /* ------------------- OBSERVATORY: 18 entries --------------------- */
    mission(-8, "Wind", "OBSERVATORY", "NASA", "Sun-Earth L1 region", "Wind_(spacecraft)"),
    mission(-21, "SOHO", "OBSERVATORY", "ESA / NASA", "Sun-Earth L1", "Solar_and_Heliospheric_Observatory"),
    mission(-43, "IMAP", "OBSERVATORY", "NASA", "Sun-Earth L1", "Interstellar_Mapping_and_Acceleration_Probe"),
    mission(-78, "DSCOVR", "OBSERVATORY", "NOAA / NASA", "Sun-Earth L1", "Deep_Space_Climate_Observatory"),
    mission(-79, "Spitzer Space Telescope", "OBSERVATORY", "NASA / JPL", "Earth-trailing heliocentric orbit", "Spitzer_Space_Telescope"),
    mission(-92, "ACE", "OBSERVATORY", "NASA", "Sun-Earth L1", "Advanced_Composition_Explorer"),
    mission(-95, "TESS", "OBSERVATORY", "NASA / MIT", "High Earth orbit", "Transiting_Exoplanet_Survey_Satellite"),
    mission(-156, "Aditya-L1", "OBSERVATORY", "ISRO", "Sun-Earth L1", "Aditya-L1"),
    mission(-165, "WMAP", "OBSERVATORY", "NASA", "Heliocentric disposal orbit", "Wilkinson_Microwave_Anisotropy_Probe"),
    mission(-170, "James Webb Space Telescope", "OBSERVATORY", "NASA / ESA / CSA", "Sun-Earth L2", "James_Webb_Space_Telescope"),
    mission(-171, "Carruthers Geocorona Observatory", "OBSERVATORY", "NASA", "Sun-Earth L1", "Carruthers_Geocorona_Observatory"),
    mission(-227, "Kepler", "OBSERVATORY", "NASA", "Earth-trailing heliocentric orbit", "Kepler_space_telescope"),
    mission(-231, "SWFO-L1", "OBSERVATORY", "NOAA", "Sun-Earth L1", "Space_Weather_Follow_On-Lagrange_1"),
    mission(-234, "STEREO-A", "OBSERVATORY", "NASA", "Heliocentric orbit", "STEREO"),
    mission(-235, "STEREO-B", "OBSERVATORY", "NASA", "Heliocentric orbit", "STEREO"),
    mission(-486, "Herschel Space Observatory", "OBSERVATORY", "ESA", "Heliocentric disposal orbit", "Herschel_Space_Observatory"),
    mission(-489, "Planck", "OBSERVATORY", "ESA", "Heliocentric disposal orbit", "Planck_(spacecraft)"),
    mission(-680, "Euclid", "OBSERVATORY", "ESA / NASA", "Sun-Earth L2", "Euclid_(spacecraft)"),
  ];

  if (missions.length !== 100) throw new Error("Deep-space catalog must contain exactly 100 entries.");
  if (new Set(missions.map((item) => item.horizonsId)).size !== missions.length) {
    throw new Error("Deep-space Horizons target IDs must be unique.");
  }

  globalThis.MTPDeepSpaceCatalog = Object.freeze({
    asOf: "2026-07-12",
    title: "Deep 100 active + historical mission atlas",
    truthLabel: "Mission metadata is not telemetry or proof of current operation.",
    sources: Object.freeze({
      horizonsManual: "https://ssd.jpl.nasa.gov/horizons/manual.html",
      horizonsApi: "https://ssd-api.jpl.nasa.gov/doc/horizons.html",
      horizonsLookup: "https://ssd-api.jpl.nasa.gov/doc/horizons_lookup.html",
      naifData: "https://naif.jpl.nasa.gov/naif/data.html",
      nasaMissions: "https://www.nasa.gov/missions/",
    }),
    ephemerisContract: Object.freeze({
      source: "NASA/JPL Horizons release-generated vector tables",
      center: "500@10 (Sun center)",
      frame: "ICRF",
      referencePlane: "ECLIPTIC",
      units: "KM-S",
      delivery: "Static generated JavaScript; no runtime Horizons requests",
      interpolation: "Cubic Hermite between bundled position/velocity samples",
      outOfCoverage: "Do not extrapolate or draw a live marker",
      requiredMetadata: Object.freeze(["generatedAt", "startMs", "stopMs", "stepSeconds", "trajectoryClass"]),
    }),
    ephemerisStatusLabels: EPHEMERIS_STATUS_LABELS,
    groupLabels: GROUP_LABELS,
    missions: Object.freeze(missions),
  });
})();
