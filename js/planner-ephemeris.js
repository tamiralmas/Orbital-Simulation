/* Bind the generated NASA/JPL Horizons Planner table to the bounded provider. */
"use strict";

(function () {
  const factory = globalThis.MissionEphemerisTable;
  const data = globalThis.MTP_PLANNER_EPHEMERIS;
  if (!factory || !data) {
    globalThis.MTPPlannerEphemeris = null;
    return;
  }
  try {
    globalThis.MTPPlannerEphemeris = factory.createProvider(data);
  } catch (error) {
    globalThis.MTPPlannerEphemeris = null;
    console.warn("Planner high-accuracy ephemeris table unavailable:", error.message);
  }
})();
