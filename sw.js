/* Mission Trajectory Planner - optional GitHub Pages / localhost offline cache. */
"use strict";

const CACHE_PREFIX = "mtp-offline-";
const CACHE_NAME = CACHE_PREFIX + "1.19.4-r1";

const CORE_ASSETS = [
  "./", "./index.html", "./classic.html", "./live.html", "./deep.html",
  "./schema.html", "./css/theme.css", "./css/style.css",
  "./js/constants.js", "./js/kepler.js", "./js/targeting.js", "./js/ode.js",
  "./js/cr3bp.js", "./js/libration.js", "./js/windows.js", "./js/analysis.js",
  "./js/environment-models.js", "./js/ephemeris-table.js", "./js/planner-ephemeris.js", "./js/force-models.js",
  "./js/sgp4.js", "./js/uncertainty.js", "./js/propagator.js", "./js/missions.js",
  "./js/multicraft.js", "./js/renderer.js", "./js/groundtrack.js",
  "./js/textures.js", "./js/theme.js", "./js/ui.js", "./js/scriptgen.js",
  "./js/gifenc.js", "./js/tracker-shell.js", "./js/live-catalog.js",
  "./js/live.js", "./js/deep-space-catalog.js", "./js/deep.js",
  "./js/mission-schema.js", "./js/schema-doc.js", "./js/offline.js"
];

/* Large/generated assets are cached opportunistically so a missing optional
 * archive cannot abort installation of the core offline shell. */
const OPTIONAL_ASSETS = [
  "./js/textures-data.js", "./js/planner-ephemeris-data.js", "./js/deep-space-ephemeris.js",
  "./js/deep-space-archives.js", "./docs/mission.schema.json",
  "./docs/blueprint.png", "./docs/cinematic.png"
];

async function cacheIndividually(cache, urls) {
  await Promise.all(urls.map(async (url) => {
    try { await cache.add(new Request(url, { cache: "reload" })); }
    catch (_error) { /* optional or development-time file not present yet */ }
  }));
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cacheIndividually(cache, CORE_ASSETS);
    await cacheIndividually(cache, OPTIONAL_ASSETS);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) &&
      name !== CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

function cacheable(response) {
  return response && (response.ok || response.type === "opaque");
}

async function navigationResponse(request) {
  try {
    const response = await fetch(request);
    if (cacheable(response)) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (_error) {
    return (await caches.match(request)) || (await caches.match("./index.html"));
  }
}

async function assetResponse(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (cacheable(response)) {
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (request.mode === "navigate") event.respondWith(navigationResponse(request));
  else event.respondWith(assetResponse(request));
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});
