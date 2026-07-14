/* Static layout contracts for the Live Cinematic composition.
 *
 * These checks intentionally inspect only the Live selectors. They protect the
 * full-bleed/floating-overlay design without depending on a browser's font or
 * canvas implementation, and without accidentally satisfying a Live contract
 * from an unrelated Planner rule.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "live.html"), "utf8");
const css = fs.readFileSync(path.join(root, "css", "theme.css"), "utf8");

function matchingBrace(source, open) {
  let depth = 0;
  let quote = "";
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === quote && source[i - 1] !== "\\") quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "{") depth++;
    if (ch === "}" && --depth === 0) return i;
  }
  throw new Error("Unbalanced CSS block at offset " + open);
}

function withoutMedia(source) {
  let result = source.replace(/\/\*[\s\S]*?\*\//g, "");
  for (;;) {
    const start = result.search(/@media\b/);
    if (start < 0) return result;
    const open = result.indexOf("{", start);
    const close = matchingBrace(result, open);
    result = result.slice(0, start) + result.slice(close + 1);
  }
}

function mediaBodies(source, prelude) {
  const bodies = [];
  let from = 0;
  while (from < source.length) {
    const start = source.indexOf(prelude, from);
    if (start < 0) break;
    const open = source.indexOf("{", start + prelude.length);
    const close = matchingBrace(source, open);
    bodies.push(source.slice(open + 1, close));
    from = close + 1;
  }
  return bodies.join("\n");
}

function selectorBodies(source, selector) {
  const cleaned = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const bodies = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = rule.exec(cleaned))) {
    const selectors = match[1].split(",").map((part) => part.trim());
    if (selectors.includes(selector)) bodies.push(match[2]);
  }
  return bodies.join("\n");
}

function styles(source, selectors) {
  return selectors.map((selector) => selectorBodies(source, selector)).filter(Boolean).join("\n");
}

function liveCinematic(source, suffix) {
  return styles(source, [
    `[data-theme="cinematic"] ${suffix}`,
    `#app[data-theme="cinematic"] ${suffix}`,
    `#app.live-app[data-theme="cinematic"] ${suffix}`,
  ]);
}

function declaration(body, property) {
  const values = [];
  const pattern = new RegExp("(?:^|;)\\s*" + property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
    "\\s*:\\s*([^;}]*)", "gi");
  let match;
  while ((match = pattern.exec(body))) values.push(match[1].trim());
  return values.length ? values[values.length - 1] : "";
}

function px(body, property) {
  const value = declaration(body, property);
  if (/^[+-]?0(?:\.0+)?$/.test(value)) return 0;
  const match = value.match(/(-?\d+(?:\.\d+)?)px/);
  return match ? Number(match[1]) : NaN;
}

function boxPx(body, property) {
  const values = declaration(body, property).trim().split(/\s+/).map((value) =>
    value === "0" ? 0 : (/^-?\d+(?:\.\d+)?px$/.test(value) ? parseFloat(value) : NaN));
  if (!values.length || values.some((value) => !Number.isFinite(value))) return null;
  const expanded = values.length === 1 ? [values[0], values[0], values[0], values[0]] :
    values.length === 2 ? [values[0], values[1], values[0], values[1]] :
    values.length === 3 ? [values[0], values[1], values[2], values[1]] : values.slice(0, 4);
  return { top: expanded[0], right: expanded[1], bottom: expanded[2], left: expanded[3] };
}

function z(body) {
  const value = declaration(body, "z-index");
  return /^-?\d+$/.test(value) ? Number(value) : NaN;
}

function expectDecl(body, property, expected, message) {
  const value = declaration(body, property);
  assert(expected.test(value), message + ` (got ${property}: ${value || "<missing>"})`);
}

const desktop = withoutMedia(css);

assert(/family=IBM\+Plex\+Mono(?::wght@[^&"]+)?(?:&amp;|&)/.test(html),
  "Live must load IBM Plex Mono, the mono face declared by the Cinematic theme");

assert(/class="live-brand"[\s\S]*?id="liveSceneTitle"/.test(html),
  "Live header should expose the Planner-like scene title hierarchy");
assert(/class="live-top-actions"[\s\S]*?class="live-viewbtns"[\s\S]*?class="live-scopebtns"[\s\S]*?id="liveTopFrameSlot"[\s\S]*?id="liveDeepViewControls"[\s\S]*?class="live-auxbtns"/.test(html),
  "Live controls should place the guarded Focus/Frame group inline between scope and auxiliary actions");
assert(/id="liveDisplayPanel"[\s\S]*?id="liveDeepDisplaySlot"/.test(html),
  "Deep focus/frame controls need a compact Display fallback slot");
assert(/id="liveHud"[\s\S]*?class="live-hud-kicker"[\s\S]*?id="liveUtc"[\s\S]*?class="live-hud-grid"[\s\S]*?class="live-hud-cell live-hud-state"[\s\S]*?id="liveMode"[\s\S]*?class="live-hud-cell live-hud-model"[\s\S]*?id="liveHudModel"/.test(html),
  "Live should expose Planner-like primary UTC and secondary state/model HUD levels");

const layout = liveCinematic(desktop, "#liveLayout");
const viz = liveCinematic(desktop, "#liveViz");
const topbar = liveCinematic(desktop, "#liveTopbar");
const topbarChildren = liveCinematic(desktop, "#liveTopbar > *");
const transport = liveCinematic(desktop, "#liveTransport");

expectDecl(layout, "position", /^absolute$/i, "Cinematic Live layout must cover the viewport behind its overlays");
expectDecl(layout, "inset", /^0(?:px)?$/i, "Cinematic Live layout must be full bleed");
expectDecl(viz, "position", /^absolute$/i, "Cinematic Live visualization must be an absolute stage");
expectDecl(viz, "inset", /^0(?:px)?$/i, "Cinematic Live visualization must touch all stage edges");
expectDecl(topbar, "position", /^absolute$/i, "Cinematic Live header must float over the stage");
assert(px(topbar, "top") === 0 && px(topbar, "left") === 0 && px(topbar, "right") === 0,
  "Cinematic Live header must span the top overlay lane");
expectDecl(topbar, "background", /^transparent$/i, "Cinematic Live must not restore an opaque header band");
expectDecl(topbar, "border", /^(?:0|none)$/i, "Cinematic Live header must not draw a full-width rule");
expectDecl(topbar, "pointer-events", /^none$/i, "Transparent header space must not block canvas interaction");
expectDecl(topbarChildren, "pointer-events", /^auto$/i, "Actual header controls must remain interactive");
const scopeGroup = styles(desktop, [".live-scopebtns"]);
const scopeButton = styles(desktop, [".live-scopebtns .tracker-scope"]);
expectDecl(scopeGroup, "flex", /^0\s+0\s+auto$/i,
  "Earth/Deep scope controls must stay intrinsic instead of stretching across the topbar");
expectDecl(scopeGroup, "width", /^max-content$/i,
  "Earth/Deep scope capsule must remain content-sized");
expectDecl(scopeButton, "width", /^auto$/i,
  "Individual Earth/Deep buttons must remain content-sized");
assert(!/#liveTopFrameSlot[^{}]*\{[^}]*flex\s*:\s*1\s+0\s+100%/s.test(desktop),
  "Focus/Frame topbar slot must not force itself onto a full-width second row");

expectDecl(transport, "position", /^absolute$/i, "Cinematic Live transport must float over the stage");
assert(px(transport, "left") === 30 && px(transport, "right") === 30 && px(transport, "bottom") === 20,
  "Desktop Live transport should use the Planner's 30/30/20 floating inset");
expectDecl(transport, "background", /^transparent$/i, "Cinematic Live must not restore an opaque footer dock");
expectDecl(transport, "border", /^(?:0|none)$/i, "Cinematic Live transport must not draw a full-width rule");

const sceneTitle = liveCinematic(desktop, "#liveSceneTitle");
assert(px(sceneTitle, "font-size") >= 28,
  "Cinematic scene title should retain the Planner's approximately 30px primary hierarchy");
expectDecl(sceneTitle, "color", /#fff(?:fff)?|white/i, "Cinematic scene title should be the primary white label");

const sidebar = liveCinematic(desktop, "#liveSidebar");
expectDecl(sidebar, "position", /^absolute$/i, "Cinematic catalog should be a floating rail");
assert(px(sidebar, "left") === 30 && px(sidebar, "top") >= 140 && px(sidebar, "top") <= 200 &&
  px(sidebar, "bottom") >= 100 && px(sidebar, "bottom") <= 220 && px(sidebar, "width") === 296,
  "Cinematic catalog rail should match the Planner's left overlay geometry");
expectDecl(sidebar, "background", /^transparent$/i, "Cinematic catalog rail must not be one large dashboard card");
expectDecl(sidebar, "border", /^(?:0|none)$/i, "Cinematic catalog rail must not have an outer panel border");
expectDecl(sidebar, "box-shadow", /^(?:0|none)$/i, "Cinematic catalog rail must not cast an outer panel shadow");

const selectedRow = styles(desktop, [
  '#app.live-app[data-theme="cinematic"] .live-mission-row[aria-pressed="true"]',
  '#app.live-app[data-theme="cinematic"] #liveMissionList .live-mission-row[aria-pressed="true"]',
  '[data-theme="cinematic"] .live-mission-row[aria-pressed="true"]',
]);
expectDecl(selectedRow, "background", /var\(--panel\)|rgba?\(/i,
  "Only the selected mission should become a Cinematic glass surface");
assert(px(selectedRow, "border-radius") >= 12,
  "Selected Cinematic mission should use the Planner's rounded active-card language");
expectDecl(selectedRow, "backdrop-filter", /blur\(/i,
  "Selected Cinematic mission should use the Planner's glass blur");
expectDecl(selectedRow, "border", /(?:accent|255\s*,\s*106\s*,\s*61)/i,
  "Selected Cinematic mission should have an ember focus border");
expectDecl(liveCinematic(desktop, "#liveMissionList .live-mission-row"), "grid-template-columns",
  /minmax\(0\s*,\s*1fr\)\s+auto/i,
  "Cinematic mission text should occupy the flexible column after its marker leaves grid flow");
const missionListBox = boxPx(liveCinematic(desktop, "#liveMissionList"), "padding");
const selectedRowMargin = boxPx(selectedRow, "margin");
const selectedDot = liveCinematic(desktop,
  '#liveMissionList .live-mission-row[aria-pressed="true"] .live-row-dot');
assert(missionListBox && selectedRowMargin &&
  missionListBox.left + selectedRowMargin.left + px(selectedDot, "left") >= 0,
  "Selected mission marker must stay inside the horizontally clipped scroll rail");

const play = liveCinematic(desktop, "#btnLivePlay");
const now = liveCinematic(desktop, "#btnLiveNow");
assert(px(play, "width") === 42 && px(play, "height") === 42,
  "Live Play should match the Planner's 42px primary transport control");
expectDecl(play, "border-radius", /^50%$/, "Live Play should be circular");
expectDecl(play, "background", /var\(--accent\)/, "Live Play should use the ember accent fill");
expectDecl(play, "display", /^(?:inline-)?flex$/i, "Live Play should center its state icon like the Planner control");
const pauseIcon = liveCinematic(desktop, '#btnLivePlay[aria-pressed="true"]::before');
expectDecl(pauseIcon, "background", /linear-gradient/i,
  "The running state should draw two stable pause bars instead of relying on button-border geometry");
assert(px(now, "width") === 34 && px(now, "height") === 34,
  "Live Now should match the Planner's 34px secondary transport control");
expectDecl(now, "border-radius", /^50%$/, "Live Now should be circular");

const cinematicScopeGroup = liveCinematic(desktop, ".live-scopebtns");
const cinematicScopeButton = liveCinematic(desktop, ".live-scopebtns button");
const activeScope = liveCinematic(desktop, '.live-scopebtns .tracker-scope[aria-pressed="true"]');
expectDecl(cinematicScopeGroup, "background", /^transparent$/i,
  "Cinematic scope choices should not be fused into one segmented capsule");
assert(px(cinematicScopeButton, "border-radius") >= 20,
  "Each Cinematic Earth/Deep scope should be its own Planner-style pill");
expectDecl(activeScope, "background", /var\(--accent\)/i,
  "The selected Cinematic scope should use the Planner's orange fill");

const display = liveCinematic(desktop, "#liveDisplayPanel");
const hud = liveCinematic(desktop, "#liveHud");
const card = liveCinematic(desktop, "#liveCard");
const ground = liveCinematic(desktop, "#liveGroundPanel");
const legend = liveCinematic(desktop, "#liveLegend");
const scale = liveCinematic(desktop, "#liveScaleReadout");
const deepLegend = styles(desktop, [
  '#app.live-app[data-theme="cinematic"].deep-app #liveLegend',
]);
const deepScale = styles(desktop, [
  '#app.live-app[data-theme="cinematic"].deep-app #liveScaleReadout',
]);
const splitDisplay = styles(desktop, [
  '#app.live-app[data-theme="cinematic"].display-open.card-open #liveDisplayPanel',
]);
const splitCard = styles(desktop, [
  '#app.live-app[data-theme="cinematic"].display-open.card-open #liveCard',
]);
assert(px(display, "top") === 205 && px(display, "right") === 30,
  "Live Display should occupy the same right-side lane as Planner Display");
assert(px(hud, "top") >= 70 && px(hud, "top") <= 120 && px(hud, "right") === 30,
  "Live HUD should use the Planner's upper-right telemetry zone");
assert(px(card, "right") === 30 && px(card, "top") >= 140 && px(card, "top") <= 200 &&
  px(card, "bottom") >= 100 && px(card, "width") === 340,
  "Live detail card should stay between the header and floating transport lanes");
assert(px(ground, "bottom") >= 100,
  "Live Track must sit above the floating transport controls");
assert(px(legend, "bottom") >= 90 && px(scale, "bottom") >= 70,
  "Live legend and scale must stay above the floating transport lane");
assert(px(deepLegend, "bottom") === 98 && px(deepScale, "bottom") === 70,
  "Desktop Deep legend and camera/scale cluster should sit close to transport with a clear internal gap");
expectDecl(splitDisplay, "max-height", /calc\(50%\s*-\s*207px\)/i,
  "Expanded Display must use the upper half of the right lane when mission details are open");
expectDecl(splitCard, "top", /calc\(50%\s*\+\s*10px\)/i,
  "Mission details must move into the lower half of the right lane when Display is expanded");
const cardDisplayPill = styles(desktop, [
  '#app.live-app[data-theme="cinematic"].card-open #liveDisplayPanel.collapsed',
]);
assert(px(cardDisplayPill, "top") < px(card, "top") &&
  z(cardDisplayPill) > z(styles(desktop, ["#liveCard"])),
  "Collapsed Display must remain visible and clickable above an open desktop mission card");
expectDecl(styles(desktop, [
  '#app.live-app[data-theme="cinematic"].card-open #liveHud',
]), "display", /^none$/i,
  "The telemetry HUD should yield its right-side lane while mission details are open");

const compact = mediaBodies(css, "@media (max-width: 720px)");
assert(compact, "Live theme must retain a <=720px compact layout contract");
const tablet = mediaBodies(css, "@media (min-width: 721px) and (max-width: 1240px)");
const tabletDeepLegend = styles(tablet, [
  '#app.live-app[data-theme="cinematic"].deep-app #liveLegend',
]);
const tabletDeepScale = styles(tablet, [
  '#app.live-app[data-theme="cinematic"].deep-app #liveScaleReadout',
]);
assert(px(tabletDeepLegend, "bottom") === 92 && px(tabletDeepScale, "bottom") === 64,
  "Tablet Deep legend and camera/scale cluster should retain transport clearance after tightening");
const compactTopbar = liveCinematic(compact, "#liveTopbar");
const compactTransport = liveCinematic(compact, "#liveTransport");
const compactTitle = liveCinematic(compact, "#liveSceneTitle");
const compactHud = liveCinematic(compact, "#liveHud");
const compactSidebar = liveCinematic(compact, "#liveSidebar");
const compactDisplay = liveCinematic(compact, "#liveDisplayPanel");
const compactCard = liveCinematic(compact, "#liveCard");
const compactGround = liveCinematic(compact, "#liveGroundPanel");
const compactCardDisplayPill = styles(compact, [
  '#app.live-app[data-theme="cinematic"].card-open #liveDisplayPanel.collapsed',
]);
const compactSplitDisplay = styles(compact, [
  '#app.live-app[data-theme="cinematic"].display-open.card-open #liveDisplayPanel',
]);
assert(declaration(compactTopbar, "padding"),
  "Compact Cinematic header needs an explicit reduced inset");
assert(/none/i.test(declaration(compactTitle, "display")) ||
  (px(compactTitle, "font-size") > 0 && px(compactTitle, "font-size") <= 22),
  "Compact Cinematic scene title should be hidden or reduced from the 30px desktop scale");
assert(/none|contents/i.test(declaration(compactHud, "display")) || px(compactHud, "font-size") <= 22,
  "Compact Cinematic HUD must collapse into transport contents, hide, or explicitly reduce");
assert(px(compactTransport, "left") <= 8 && px(compactTransport, "right") <= 8 &&
  px(compactTransport, "bottom") <= 8,
  "Compact Cinematic transport should use at most an 8px viewport inset");
assert(px(styles(compact, [
  '#app.live-app[data-theme="cinematic"].deep-app #liveLegend',
]), "bottom") === 70 && /^none$/i.test(declaration(liveCinematic(compact, "#liveScaleReadout"), "display")),
  "Compact Deep should retain its existing legend lane and hidden camera/scale readout");
assert(px(compactSidebar, "top") >= 60 && px(compactSidebar, "bottom") >= 55,
  "Compact catalog must stay clear of header and transport lanes");
assert(px(compactDisplay, "top") >= 55 && px(compactCard, "bottom") >= 55 && px(compactGround, "bottom") >= 55,
  "Compact Display, card, and Track overlays must stay out of persistent chrome");
expectDecl(compactCardDisplayPill, "visibility", /^hidden$/i,
  "Compact mission details should own the overlay lane until their explicit close action");
assert(px(compactSplitDisplay, "top") === 66 &&
  /calc\(100%\s*-\s*136px\)/i.test(declaration(compactSplitDisplay, "max-height")),
  "Opening compact Display should reclaim the full safe overlay lane while details are hidden");

const tiny = mediaBodies(css, "@media (max-width: 390px)");
expectDecl(liveCinematic(tiny, "#liveTopbar"), "grid-template-columns", /minmax\(0\s*,\s*1fr\)/i,
  "Very small Cinematic headers must not reserve an empty hidden-brand column");
assert(px(liveCinematic(tiny, "#liveSidebar"), "top") === 88 &&
  px(liveCinematic(tiny, "#liveCard"), "top") === 88,
  "Very small overlays must clear the intentionally wrapped action header");

const blueprintTopbar = styles(desktop, ['[data-theme="blueprint"] #liveTopbar']);
const blueprintLayout = styles(desktop, ['[data-theme="blueprint"] #liveLayout']);
const blueprintSidebar = styles(desktop, ['[data-theme="blueprint"] #liveSidebar']);
const blueprintTransport = styles(desktop, ['[data-theme="blueprint"] #liveTransport']);
const blueprintStatusSlot = styles(desktop, ['[data-theme="blueprint"] #liveSidebarStatusSlot']);
const blueprintDeepScale = styles(desktop, ['[data-theme="blueprint"].deep-app #liveScaleReadout']);
expectDecl(blueprintTopbar, "background", /var\(--panel\)/,
  "Blueprint header surface must remain intact");
expectDecl(blueprintLayout, "display", /^grid$/,
  "Blueprint must retain its split catalog/visualization layout");
expectDecl(blueprintSidebar, "background", /var\(--panel\)/,
  "Blueprint catalog panel must remain intact");
expectDecl(blueprintTransport, "background", /var\(--panel\)/,
  "Blueprint transport dock must remain intact");
expectDecl(blueprintStatusSlot, "display", /^block$/i,
  "Blueprint should keep detailed source status in its catalog rail instead of its control bar");
assert(px(blueprintDeepScale, "bottom") === 8,
  "Blueprint Deep should lower its camera/scale tag enough to clear the legend");

const layers = {
  legend: z(styles(desktop, ["#liveLegend"])),
  display: z(styles(desktop, ["#liveDisplayPanel"])),
  sidebar: z(styles(desktop, ["#liveSidebar"])),
  card: z(styles(desktop, ["#liveCard"])),
  ground: z(styles(desktop, ["#liveGroundPanel"])),
  topbar: z(styles(desktop, ["#liveTopbar"])),
  transport: z(styles(desktop, ["#liveTransport"])),
};
assert(Object.values(layers).every(Number.isFinite),
  "Every Live overlay layer should declare a deterministic numeric z-index");
assert(layers.legend < layers.display && layers.display < layers.sidebar &&
  layers.sidebar < layers.card && layers.card < layers.ground &&
  layers.ground < layers.topbar && layers.ground < layers.transport,
  "Live overlay z-order must be legend < Display < catalog < card < Track < persistent chrome");

console.log("Live Cinematic layout checks passed: full-bleed stage, Planner hierarchy, safe overlay zones, and intact Blueprint.");
