/* Mission Trajectory Planner - generated mission JSON schema reference. */
"use strict";

(function () {
  const app = document.getElementById("schemaApp");
  const rootHost = document.getElementById("schemaRoot");
  const segmentHost = document.getElementById("schemaSegments");
  const nav = document.getElementById("schemaNav");
  const download = document.getElementById("schemaDownload");
  const themeButton = document.getElementById("schemaTheme");
  const engine = globalThis.MissionEngine;
  const constants = globalThis.AstroConst;
  const schemaFactory = globalThis.MissionSchema;
  if (!app || !rootHost || !segmentHost || !nav || !engine || !constants || !schemaFactory) return;
  const missionSchema = schemaFactory.build(engine.SEGMENT_TYPES, constants);
  const segmentCount = Object.keys(engine.SEGMENT_TYPES).length;

  const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
  const valueText = (value) => value === "" ? "empty string" : JSON.stringify(value);

  document.getElementById("schemaVersion").textContent = "Engine v" + constants.VERSION +
    " / " + segmentCount + " segment types";
  rootHost.innerHTML = '<table><thead><tr><th>Property</th><th>Type</th><th>Required</th><th>Meaning</th></tr></thead><tbody>' +
    '<tr><td><code>format</code></td><td><code>mtp-mission-1</code> or <code>mtp-mission-2</code></td><td>no</td><td>Portable format marker; v2 adds native vehicles</td></tr>' +
    '<tr><td><code>name</code></td><td>string</td><td>yes</td><td>Mission display name</td></tr>' +
    '<tr><td><code>epoch</code></td><td>UTC date-time</td><td>yes</td><td>Absolute T+0 epoch</td></tr>' +
    '<tr><td><code>spacecraft</code></td><td>object</td><td>no</td><td>Mass, propulsion, and sensor properties</td></tr>' +
    '<tr><td><code>uncertainty</code></td><td>object</td><td>no</td><td>Covariance, execution-error, and Monte Carlo defaults</td></tr>' +
    '<tr><td><code>operations</code></td><td>object</td><td>no</td><td>Track/Data station, sensor, eclipse, and fleet defaults</td></tr>' +
    '<tr><td><code>segments</code></td><td>array</td><td>yes</td><td>Ordered segments for the reserved <code>primary</code> vehicle</td></tr>' +
    '<tr><td><code>vehicles</code></td><td>array (maximum 7)</td><td>no</td><td>Dependency-ordered secondary vehicle branches</td></tr>' +
    '</tbody></table>' +
    '<article class="schema-card"><header><span>VEHICLES</span><h2>Secondary vehicle branches</h2></header>' +
    '<p>The root <code>spacecraft</code> and <code>segments</code> remain the primary vehicle with the reserved id ' +
    '<code>primary</code>. Each object in <code>vehicles</code> owns an independent spacecraft definition and ordered ' +
    'segment list on the same UTC timeline. Up to seven secondary vehicles are supported.</p>' +
    '<table><thead><tr><th>JSON key</th><th>Type</th><th>Required</th><th>Meaning</th></tr></thead><tbody>' +
    '<tr><td><code>id</code></td><td>string</td><td>yes</td><td>Unique mission-local id; <code>primary</code> is reserved</td></tr>' +
    '<tr><td><code>name</code></td><td>string</td><td>yes</td><td>Vehicle display name</td></tr>' +
    '<tr><td><code>color</code></td><td>#RRGGBB</td><td>no</td><td>Preferred trajectory color</td></tr>' +
    '<tr><td><code>spacecraft</code></td><td>object</td><td>no</td><td>Mass, propulsion, and sensor properties for this vehicle</td></tr>' +
    '<tr><td><code>segments</code></td><td>array</td><td>yes</td><td>Independent branch segments; a separated branch begins with <code>separate</code></td></tr>' +
    '</tbody></table><p>Fields shown as <em>mission vehicle id</em> reference either <code>primary</code> or another ' +
    'declared vehicle. Mission loaders must check unique ids, reject self-references, and resolve branch dependencies.</p></article>';

  nav.innerHTML = Object.entries(engine.SEGMENT_TYPES).map(([type, definition]) =>
    '<a href="#segment-' + esc(type) + '">' + esc(definition.short || type) + '</a>').join("");
  segmentHost.innerHTML = Object.entries(engine.SEGMENT_TYPES).map(([type, definition]) => {
    const rows = definition.fields.map((field) => '<tr><td><code>' + esc(field.k) + '</code></td><td>' +
      esc(schemaFactory.fieldType(field)) + '</td><td>' + (field.required ? "yes" : "no") + '</td><td>' +
      esc(valueText(field.def)) + '</td><td>' + esc(field.opts ? field.opts.join(", ") :
        (field.t === "body" || field.t === "bodyOpt" ? "body id" :
          (field.t === "vehicle" ? "mission vehicle id" : field.label))) + '</td></tr>').join("");
    return '<article id="segment-' + esc(type) + '" class="schema-card"><header><span>' +
      esc(definition.short || type) + '</span><h2>' + esc(definition.label) + '</h2></header><p>' +
      esc(definition.doc || "") + '</p><table><thead><tr><th>JSON key</th><th>Type</th><th>Required</th>' +
      '<th>Default</th><th>Values / meaning</th></tr></thead><tbody>' + rows + '</tbody></table></article>';
  }).join("");

  const applyTheme = (theme, persist) => {
    app.dataset.theme = theme;
    themeButton.textContent = theme === "blueprint" ? "Cinematic UI" : "Blueprint UI";
    if (persist) { try { localStorage.setItem("mtp-theme", theme); } catch (_error) {} }
  };
  let initial = "blueprint";
  try { if (localStorage.getItem("mtp-theme") === "cinematic") initial = "cinematic"; } catch (_error) {}
  applyTheme(initial, false);
  themeButton.addEventListener("click", () => applyTheme(app.dataset.theme === "blueprint"
    ? "cinematic" : "blueprint", true));

  download.disabled = false;
  download.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(missionSchema, null, 2) + "\n"], { type: "application/schema+json" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = "mission.schema.json";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 0);
  });

  globalThis.MTPSchema = Object.freeze({ schema: missionSchema });
})();
