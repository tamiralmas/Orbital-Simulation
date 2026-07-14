/* =============================================================================
 * Mission Trajectory Planner - curated live Earth-orbit catalog.
 *
 * This fallback catalog is a stable UI/data index, not an orbital snapshot.
 * Current OMM mean elements are loaded at runtime from the three small,
 * purpose-specific CelesTrak groups below.  Inclusion means that an orbiting
 * spacecraft is cataloged in one of those groups; it does not assert that the
 * mission is still operational.
 *
 * Catalog review date: 2026-07-12.  Exactly 100 unique NORAD catalog IDs.
 * ========================================================================== */
"use strict";

(function () {
  const WIKI = "https://en.wikipedia.org/wiki/";
  const GROUP_LABELS = Object.freeze({
    STATIONS: "Stations and visiting vehicles",
    SCIENCE: "Space and Earth science",
    RESOURCE: "Earth observation",
  });

  const GROUP_SUMMARIES = Object.freeze({
    STATIONS: "Crewed station, station module, or visiting vehicle tracked in the CelesTrak STATIONS group.",
    SCIENCE: "Science spacecraft tracked in the CelesTrak SCIENCE group.",
    RESOURCE: "Earth-observation spacecraft tracked in the CelesTrak RESOURCE group.",
  });

  function mission(norad, name, group, agency, kind, wikiSlug) {
    return Object.freeze({
      norad,
      name,
      group,
      groupLabel: GROUP_LABELS[group],
      agency,
      kind,
      summary: GROUP_SUMMARIES[group],
      wiki: wikiSlug ? WIKI + wikiSlug : "",
    });
  }

  const missions = [
    /* --------------------- STATIONS: 10 entries --------------------- */
    mission(25544, "ISS (Zarya)", "STATIONS", "International partnership", "Crewed space station", "International_Space_Station"),
    mission(48274, "CSS (Tianhe)", "STATIONS", "China Manned Space Agency", "Crewed space station", "Tiangong_space_station"),
    mission(49044, "ISS (Nauka)", "STATIONS", "Roscosmos", "Station module", "Nauka_(ISS_module)"),
    mission(53239, "CSS (Wentian)", "STATIONS", "China Manned Space Agency", "Station module", "Wentian_module"),
    mission(67796, "Crew Dragon 12", "STATIONS", "NASA / SpaceX", "Crew visiting vehicle", ""),
    mission(68319, "Progress-MS 33", "STATIONS", "Roscosmos", "Cargo visiting vehicle", ""),
    mission(68689, "Cygnus NG-24", "STATIONS", "NASA / Northrop Grumman", "Cargo visiting vehicle", "Cygnus_(spacecraft)"),
    mission(68837, "Progress-MS 34", "STATIONS", "Roscosmos", "Cargo visiting vehicle", ""),
    mission(69049, "Tianzhou-10", "STATIONS", "China Manned Space Agency", "Cargo visiting vehicle", "Tianzhou_(spacecraft)"),
    mission(69180, "Shenzhou-23", "STATIONS", "China Manned Space Agency", "Crew visiting vehicle", "Shenzhou_(spacecraft)"),

    /* ---------------------- SCIENCE: 40 entries --------------------- */
    mission(20580, "Hubble Space Telescope", "SCIENCE", "NASA / ESA", "Space telescope", "Hubble_Space_Telescope"),
    mission(23802, "Polar", "SCIENCE", "NASA", "Magnetosphere observatory", "Polar_(satellite)"),
    mission(25867, "Chandra X-ray Observatory", "SCIENCE", "NASA", "X-ray observatory", "Chandra_X-ray_Observatory"),
    mission(25989, "XMM-Newton", "SCIENCE", "ESA", "X-ray observatory", "XMM-Newton"),
    mission(25994, "Terra", "SCIENCE", "NASA", "Earth science observatory", "Terra_(satellite)"),
    mission(26410, "Cluster II - Samba", "SCIENCE", "ESA", "Magnetosphere observatory", "Cluster_II_(spacecraft)"),
    mission(26464, "Cluster II - Tango", "SCIENCE", "ESA", "Magnetosphere observatory", "Cluster_II_(spacecraft)"),
    mission(26702, "Odin", "SCIENCE", "Swedish National Space Agency", "Astronomy and aeronomy observatory", "Odin_(satellite)"),
    mission(26998, "TIMED", "SCIENCE", "NASA", "Upper-atmosphere observatory", "TIMED"),
    mission(27640, "Coriolis", "SCIENCE", "US Navy / US Air Force", "Atmospheric science spacecraft", "Coriolis_(satellite)"),
    mission(27651, "SORCE", "SCIENCE", "NASA", "Solar irradiance observatory", "Solar_Radiation_and_Climate_Experiment"),
    mission(27843, "MOST", "SCIENCE", "Canadian Space Agency", "Space telescope", "MOST_(satellite)"),
    mission(27858, "SCISAT-1", "SCIENCE", "Canadian Space Agency", "Atmospheric science spacecraft", "SCISAT-1"),
    mission(28485, "Swift Observatory", "SCIENCE", "NASA", "Gamma-ray observatory", "Neil_Gehrels_Swift_Observatory"),
    mission(29479, "Hinode", "SCIENCE", "JAXA / NASA / UKSA", "Solar observatory", "Hinode_(satellite)"),
    mission(33053, "Fermi Gamma-ray Space Telescope", "SCIENCE", "NASA / US DOE", "Gamma-ray observatory", "Fermi_Gamma-ray_Space_Telescope"),
    mission(36395, "Solar Dynamics Observatory", "SCIENCE", "NASA", "Solar observatory", "Solar_Dynamics_Observatory"),
    mission(36508, "CryoSat-2", "SCIENCE", "ESA", "Cryosphere observatory", "CryoSat-2"),
    mission(38337, "GCOM-W1 (Shizuku)", "SCIENCE", "JAXA", "Water-cycle observatory", "GCOM-W"),
    mission(38358, "NuSTAR", "SCIENCE", "NASA / Caltech", "X-ray observatory", "NuSTAR"),
    mission(39089, "NEOSSat", "SCIENCE", "Canadian Space Agency", "Space surveillance telescope", "NEOSSat"),
    mission(39091, "BRITE-Austria", "SCIENCE", "BRITE Consortium", "Stellar photometry telescope", "BRITE-Constellation"),
    mission(39197, "IRIS", "SCIENCE", "NASA", "Solar observatory", "Interface_Region_Imaging_Spectrograph"),
    mission(39253, "Hisaki", "SCIENCE", "JAXA", "Ultraviolet observatory", "Hisaki_(satellite)"),
    mission(39265, "CASSIOPE", "SCIENCE", "Canadian Space Agency", "Ionosphere observatory", "CASSIOPE"),
    mission(39451, "Swarm B", "SCIENCE", "ESA", "Geomagnetic observatory", "Swarm_(spacecraft)"),
    mission(39452, "Swarm A", "SCIENCE", "ESA", "Geomagnetic observatory", "Swarm_(spacecraft)"),
    mission(39453, "Swarm C", "SCIENCE", "ESA", "Geomagnetic observatory", "Swarm_(spacecraft)"),
    mission(40020, "BRITE-Toronto", "SCIENCE", "BRITE Consortium", "Stellar photometry telescope", "BRITE-Constellation"),
    mission(40059, "OCO-2", "SCIENCE", "NASA", "Carbon observatory", "Orbiting_Carbon_Observatory_2"),
    mission(40119, "BRITE-Heweliusz", "SCIENCE", "BRITE Consortium", "Stellar photometry telescope", "BRITE-Constellation"),
    mission(40482, "MMS 1", "SCIENCE", "NASA", "Magnetosphere observatory", "Magnetospheric_Multiscale_Mission"),
    mission(40483, "MMS 2", "SCIENCE", "NASA", "Magnetosphere observatory", "Magnetospheric_Multiscale_Mission"),
    mission(40484, "MMS 3", "SCIENCE", "NASA", "Magnetosphere observatory", "Magnetospheric_Multiscale_Mission"),
    mission(40485, "MMS 4", "SCIENCE", "NASA", "Magnetosphere observatory", "Magnetospheric_Multiscale_Mission"),
    mission(40930, "AstroSat", "SCIENCE", "ISRO", "Multi-wavelength observatory", "AstroSat"),
    mission(41173, "DAMPE", "SCIENCE", "Chinese Academy of Sciences", "Particle observatory", "DArk_Matter_Particle_Explorer"),
    mission(42758, "Insight-HXMT", "SCIENCE", "CNSA / Chinese Academy of Sciences", "X-ray observatory", "Hard_X-ray_Modulation_Telescope"),
    mission(43194, "CSES-1 (Zhangheng-1)", "SCIENCE", "China / Italy", "Geophysics observatory", "China_Seismo-Electromagnetic_Satellite"),
    mission(49954, "IXPE", "SCIENCE", "NASA / Italian Space Agency", "X-ray polarimetry observatory", "Imaging_X-ray_Polarimetry_Explorer"),

    /* --------------------- RESOURCE: 50 entries --------------------- */
    mission(27424, "Aqua", "RESOURCE", "NASA", "Earth science observatory", "Aqua_(satellite)"),
    mission(28376, "Aura", "RESOURCE", "NASA", "Atmosphere observatory", "Aura_(satellite)"),
    mission(28649, "Cartosat-1", "RESOURCE", "ISRO", "Mapping spacecraft", "Cartosat-1"),
    mission(29228, "Resurs-DK No.1", "RESOURCE", "Roscosmos", "Earth-imaging spacecraft", "Resurs-DK_No.1"),
    mission(29268, "KOMPSAT-2", "RESOURCE", "KARI", "Earth-imaging spacecraft", "KOMPSAT-2"),
    mission(31598, "COSMO-SkyMed 1", "RESOURCE", "Italian Space Agency", "Radar-imaging spacecraft", "COSMO-SkyMed"),
    mission(31698, "TerraSAR-X", "RESOURCE", "DLR / Airbus", "Radar-imaging spacecraft", "TerraSAR-X"),
    mission(32060, "WorldView-1", "RESOURCE", "Maxar", "Earth-imaging spacecraft", "WorldView-1"),
    mission(32376, "COSMO-SkyMed 2", "RESOURCE", "Italian Space Agency", "Radar-imaging spacecraft", "COSMO-SkyMed"),
    mission(32382, "RADARSAT-2", "RESOURCE", "Canadian Space Agency / MDA", "Radar-imaging spacecraft", "RADARSAT-2"),
    mission(33331, "GeoEye-1", "RESOURCE", "Maxar", "Earth-imaging spacecraft", "GeoEye-1"),
    mission(33412, "COSMO-SkyMed 3", "RESOURCE", "Italian Space Agency", "Radar-imaging spacecraft", "COSMO-SkyMed"),
    mission(33492, "GOSAT (Ibuki)", "RESOURCE", "JAXA / NIES / Japan MOE", "Greenhouse-gas observatory", "Greenhouse_Gases_Observing_Satellite"),
    mission(35931, "Oceansat-2", "RESOURCE", "ISRO", "Ocean observatory", "Oceansat-2"),
    mission(35946, "WorldView-2", "RESOURCE", "Maxar", "Earth-imaging spacecraft", "WorldView-2"),
    mission(36036, "SMOS", "RESOURCE", "ESA", "Soil-moisture and ocean-salinity observatory", "Soil_Moisture_and_Ocean_Salinity"),
    mission(36605, "TanDEM-X", "RESOURCE", "DLR", "Radar topography spacecraft", "TanDEM-X"),
    mission(37216, "COSMO-SkyMed 4", "RESOURCE", "Italian Space Agency", "Radar-imaging spacecraft", "COSMO-SkyMed"),
    mission(37387, "Resourcesat-2", "RESOURCE", "ISRO", "Earth-resources spacecraft", "Resourcesat-2"),
    mission(37781, "Haiyang-2A", "RESOURCE", "CNSA", "Ocean-dynamics observatory", "Haiyang_(satellite)"),
    mission(38012, "Pleiades 1A", "RESOURCE", "CNES / Airbus", "Earth-imaging spacecraft", "Pl%C3%A9iades_(satellite)"),
    mission(38338, "KOMPSAT-3", "RESOURCE", "KARI", "Earth-imaging spacecraft", "KOMPSAT-3"),
    mission(38755, "SPOT 6", "RESOURCE", "Airbus / CNES", "Earth-imaging spacecraft", "SPOT_(satellite)"),
    mission(39019, "Pleiades 1B", "RESOURCE", "CNES / Airbus", "Earth-imaging spacecraft", "Pl%C3%A9iades_(satellite)"),
    mission(39084, "Landsat 8", "RESOURCE", "NASA / USGS", "Land-imaging spacecraft", "Landsat_8"),
    mission(39086, "SARAL", "RESOURCE", "ISRO / CNES", "Ocean-altimetry spacecraft", "SARAL"),
    mission(39574, "GPM Core Observatory", "RESOURCE", "NASA / JAXA", "Precipitation observatory", "Global_Precipitation_Measurement"),
    mission(39634, "Sentinel-1A", "RESOURCE", "ESA / European Union", "Radar-imaging spacecraft", "Sentinel-1"),
    mission(39766, "ALOS-2 (Daichi-2)", "RESOURCE", "JAXA", "Radar-imaging spacecraft", "Advanced_Land_Observing_Satellite"),
    mission(40053, "SPOT 7", "RESOURCE", "Airbus / CNES", "Earth-imaging spacecraft", "SPOT_(satellite)"),
    mission(40115, "WorldView-3", "RESOURCE", "Maxar", "Earth-imaging spacecraft", "WorldView-3"),
    mission(40336, "CBERS-4", "RESOURCE", "China / Brazil", "Earth-resources spacecraft", "China%E2%80%93Brazil_Earth_Resources_Satellite_program"),
    mission(40376, "SMAP", "RESOURCE", "NASA", "Soil-moisture observatory", "Soil_Moisture_Active_Passive"),
    mission(40697, "Sentinel-2A", "RESOURCE", "ESA / European Union", "Multispectral-imaging spacecraft", "Sentinel-2"),
    mission(41240, "Jason-3", "RESOURCE", "NOAA / EUMETSAT / CNES / NASA", "Ocean-altimetry spacecraft", "Jason-3"),
    mission(41335, "Sentinel-3A", "RESOURCE", "ESA / European Union", "Ocean and land observatory", "Sentinel-3"),
    mission(41727, "Gaofen-3", "RESOURCE", "CNSA", "Radar-imaging spacecraft", "Gaofen"),
    mission(41877, "Resourcesat-2A", "RESOURCE", "ISRO", "Earth-resources spacecraft", "Resourcesat-2A"),
    mission(42063, "Sentinel-2B", "RESOURCE", "ESA / European Union", "Multispectral-imaging spacecraft", "Sentinel-2"),
    mission(42920, "FORMOSAT-5", "RESOURCE", "Taiwan Space Agency", "Earth-imaging spacecraft", "FORMOSAT-5"),
    mission(42969, "Sentinel-5 Precursor", "RESOURCE", "ESA / European Union", "Atmosphere observatory", "Sentinel-5_Precursor"),
    mission(43437, "Sentinel-3B", "RESOURCE", "ESA / European Union", "Ocean and land observatory", "Sentinel-3"),
    mission(43613, "ICESat-2", "RESOURCE", "NASA", "Ice-elevation observatory", "ICESat-2"),
    mission(46984, "Sentinel-6 Michael Freilich", "RESOURCE", "ESA / EU / NASA / NOAA", "Ocean-altimetry spacecraft", "Sentinel-6_Michael_Freilich"),
    mission(49260, "Landsat 9", "RESOURCE", "NASA / USGS", "Land-imaging spacecraft", "Landsat_9"),
    mission(51444, "COSMO-SkyMed Second Generation 2", "RESOURCE", "Italian Space Agency", "Radar-imaging spacecraft", "COSMO-SkyMed"),
    mission(54754, "SWOT", "RESOURCE", "NASA / CNES", "Surface-water and ocean-topography observatory", "Surface_Water_and_Ocean_Topography"),
    mission(60182, "ALOS-4 (Daichi-4)", "RESOURCE", "JAXA", "Radar-imaging spacecraft", "ALOS-4"),
    mission(60989, "Sentinel-2C", "RESOURCE", "ESA / European Union", "Multispectral-imaging spacecraft", "Sentinel-2"),
    mission(63772, "Biomass", "RESOURCE", "ESA", "Forest-biomass observatory", "Biomass_(satellite)"),
  ];

  globalThis.MTPLiveCatalog = Object.freeze({
    asOf: "2026-07-12",
    cacheKey: "mtp-live-omm-v1",
    cacheMaxAgeMs: 4 * 60 * 60 * 1000,
    refreshMinAgeMs: 2 * 60 * 60 * 1000,
    sources: Object.freeze({
      STATIONS: "https://celestrak.org/NORAD/elements/gp.php?GROUP=STATIONS&FORMAT=JSON",
      SCIENCE: "https://celestrak.org/NORAD/elements/gp.php?GROUP=SCIENCE&FORMAT=JSON",
      RESOURCE: "https://celestrak.org/NORAD/elements/gp.php?GROUP=RESOURCE&FORMAT=JSON",
    }),
    groupLabels: GROUP_LABELS,
    missions: Object.freeze(missions),
  });
})();
