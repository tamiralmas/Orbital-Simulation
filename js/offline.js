/* Mission Trajectory Planner - optional offline service-worker registration.
 * The application remains fully usable from file://; registration is attempted
 * only for HTTP(S) origins where service workers are available. */
"use strict";

(function () {
  if (!("serviceWorker" in navigator) || !/^https?:$/.test(location.protocol)) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js", { scope: "./" }).then((registration) => {
      globalThis.MTPOffline = Object.freeze({ registration, supported: true });
      window.dispatchEvent(new CustomEvent("mtp-offline-ready", { detail: { registration } }));
    }).catch((error) => {
      globalThis.MTPOffline = Object.freeze({ supported: false, error });
      /* Offline caching is optional. A registration failure must never prevent
       * the buildless application from starting. */
      console.warn("Mission Trajectory Planner offline cache unavailable:", error.message);
    });
  }, { once: true });
})();
