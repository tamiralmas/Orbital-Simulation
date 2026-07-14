# Development Plan

Goal: evolve the Mission Trajectory Planner into a lightweight, browser-based
alternative to NASA GMAT and Ansys STK for mission sketching, teaching, and
visualization - while staying dependency-free, offline-capable (file://), and
verifiable headlessly under Node.

Every feature below must respect the project's standing constraints:

- Plain ES2020 scripts, no build step, and no runtime dependencies. Vendored
  numerical code must retain its license and attribution.
- Works from file:// and from GitHub Pages unchanged.
- Both UI themes (Blueprint Light, Cinematic Overlay) get first-class styling.
- Engine changes ship with headless verification (tests in the same style as
  the existing preset/flyby/Horizons checks).
- Every change is logged in CHANGELOG.md with date and author.

## Implementation status - v1.19.0

The recommended native multi-vehicle foundation is complete. It extends the
v1.18 comparison manager without replacing it:

- One mission may now contain its root primary vehicle plus seven dependency-
  ordered secondary vehicles. Each vehicle has its own spacecraft properties,
  segments, samples, events, mass state, color, editor selection, trajectory,
  HUD, camera, Track view and script-export section.
- The selected vehicle also owns scrub/playback/GIF coverage, timeline ticks,
  eclipse/access/J2/uncertainty analysis, and lazy native closest-approach plus
  conjunction-threshold reports in Data.
- Four explicit operations define vehicle relationships: Separate branches at
  an exact source-segment boundary; Rendezvous performs a bounded passive
  phasing wait plus terminal Lambert transfer; Dock requires a tight range and
  closing-rate capture and then follows the target state exactly; Undock breaks
  that relationship with an optional impulse. Invalid references, dependency
  cycles, excessive delta-v and missed captures fail closed.
- This is deliberately a synchronized test-particle model. It does not combine
  assembly mass or propellant, solve contact/attitude/flexible-body dynamics,
  or provide autonomous relative navigation and guidance.
- Ten inspectable presets exercise the expanded feature set: an ISS SGP4
  reference, Crew Dragon rendezvous and docking, full two-vehicle Apollo 11,
  JWST L2 operations, Lunar Gateway halo operations, Apophis 2029
  reconnaissance, OSIRIS-REx sample return, a sun-synchronous imaging
  campaign, electric supersynchronous raising, and a LEO conjunction lab. The full sweep is
  now 27/27 presets with zero warnings.
- The portable mission format is `mtp-mission-2`; older single-vehicle files
  remain compatible. The generated reference now covers 23 segment types.

## Previous implementation status - v1.18.0

All nine scoped feature items and the housekeeping list are implemented. The
new fidelity layers remain deliberately bounded so the static browser app stays
reviewable and responsive:

- The original Windows/Data/Track plan is complete in both design languages:
  porkchop plots, explicit-Apply targeting, orbital series/CSV, conical eclipse
  analysis and 3D cones, user-edited stations and access windows, sensor swaths,
  Earth J2 analysis, and a rendered N-craft comparison manager.
- The transfer targeter now genuinely varies departure epoch and time of flight
  through the mission engine against a fixed B-plane aim offset and one
  periapsis goal. It is a bounded local, single-revolution solve rather than a
  global optimizer. Its cooperative async path yields between evaluations,
  supports cancellation, snapshots the mission, and verifies the applied result.
- The deterministic force stack includes adaptive point masses, finite thrust,
  a static 0-1,000 km Earth atmosphere and drag, cannonball SRP with finite-disk
  eclipse attenuation, and axisymmetric Earth J2/J3/J4. It does not include
  measured space weather, tesseral gravity, attitude, or panel geometry.
- A reproducible 20-body, 15,380-row NASA/JPL Horizons table covers
  2026-06-27--2026-08-26 UTC and fails closed outside per-body bounds. This is
  a high-accuracy release window, not arbitrary-date ephemeris support.
- Standards-compatible near-Earth SGP4 and deep-space SDP4 now propagate TLE
  and CCSDS OMM records. Earth Live uses them by default; a labelled first-order
  J2 fallback is retained only for a record that cannot initialize. The
  GMST-based TEME conversion omits full precision Earth-orientation terms.
- Seeded uncertainty supports 6x6 covariance validation, optional RTN maneuver
  execution error, STM/process-noise APIs, and Monte Carlo. The Planner UI
  intentionally limits input to diagonal Cartesian sigmas and reports one
  local two-body endpoint. Separately, access and fleet reports can propagate
  linearized primary covariance to nominal maximum-elevation and closest-
  approach epochs inside the selected horizon and a matching uninterrupted
  Kepler coast. It does not propagate probability through the full mission,
  alter event times, cross a later maneuver/model/frame boundary, or model
  comparison-craft covariance.
- The UI persists up to 32 user stations and renders a primary plus up to seven
  comparison craft; the bounded analysis engine accepts up to 128 providers.
- Five feature-validation presets make the new behavior inspectable: LEO
  Environment Lab, GEO SRP + Horizons, SDP4 Deep-Space Validation, LEO Disposal
  + Uncertainty, and Mars Joint-Target Lab. The full regression covers 17/17
  presets with zero warnings.
- Housekeeping is complete: actual theme screenshots, optional HTTP(S) offline
  caching, a generated 19-segment schema/reference page, local server scripts,
  and the Guide keyboard card are present.

Future work is greater model depth, not an unfinished checkbox here:
arbitrary-date authoritative ephemerides, weather-driven atmosphere,
non-zonal gravity, attitude/panel dynamics, full EOP transforms, full-mission
covariance transport, probabilistic event intervals, global/multi-revolution
targeting, and operational orbit determination.

## Phase 1 - Mission design tools

### 1. Porkchop plots (launch-window search)

**Status v1.18.0: implemented.** The cached engine supports synchronous and
chunked evaluation; the dual-theme Windows pane provides progress/cancel,
metric selection, hover details, staging, and explicit application.

The signature interplanetary design tool: a departure-date x time-of-flight
grid colored by C3 (or total delta-v), with contour bands and a click-to-apply
action that writes the chosen epoch and TOF into the current mission.
- Engine: reuse the existing Lambert solver; evaluate a date grid (e.g. 80 x 60
  points) in a chunked loop to keep the UI responsive. Cache per body pair.
- UI: new "Windows" tab in the right panel; canvas heatmap with axes in both
  themes (paper/ink contours vs glassy gradient); tooltip readout of C3,
  v-infinity, arrival v-infinity, total delta-v; click sets mission epoch/TOF.
- Verify: reproduce the classic 2005 Earth-Mars window (min C3 around 16
  km^2/s^2) and the Cassini 1997 VVEJGA departure C3 (about 16.6).
- Size: medium (one new module, one right-panel tab).

### 2. Maneuver targeting (GMAT-style Vary/Achieve)

**Status v1.18.0: implemented for the bounded scope.** Transfer cards can
Achieve an arrival-periapsis goal; the Windows pane genuinely varies departure
date and time of flight through the current mission engine within explicit
visible bounds, holds one B-plane aim offset fixed, and stages the converged
result for explicit Apply. Evaluation is cooperative and cancelable; Apply
rejects stale mission fingerprints and verifies the achieved result through the
mission engine. Arrival-plane returns enforce a tangent periapsis;
Insertion can vary the impulse to achieve opposite apsis altitude or orbital
period. Each segment reports the achieved value, residual, and convergence.
The Mars Joint-Target Lab verifies that both variables materially affect the
applied mission. This is not a global or multiple-revolution optimizer.

Solve a burn so downstream conditions hit user goals, instead of hand-tuning.
- Scope v1: two solvers - (a) vary transfer TOF and departure date to achieve
  a target periapsis altitude at arrival; (b) vary insertion delta-v to achieve
  a target orbital period or apoapsis.
- Engine: secant/bisection wrappers around the existing propagation chain
  (bounded iterations, verbose convergence report in the segment card).
- UI: "Target" toggle inside Transfer/Insertion segment cards exposing goal
  fields; convergence status line; failure explains which bound was hit.
- Verify: targeted arrival periapsis within 1 km of goal across presets.
- Size: medium.

## Phase 2 - Analysis and reporting

### 3. Orbital elements panel and time-series graphs

**Status v1.18.0: implemented.** Series extraction is bounded/decimated; the
Data pane charts altitude, speed, target distance, a/e/i/RAAN/argument of
periapsis/true anomaly with a live cursor and hover crosshair; and the reviewed
columns export as CSV. CR3BP states show system/Jacobi data and skip false
two-body elements.

Live osculating elements (a, e, i, RAAN, argument of periapsis, true anomaly)
for the current segment plus plots of altitude, speed, and distance-to-target
versus time.
- Engine: elements already derivable from state vectors (kepler.js); add a
  sampled series extractor with adaptive decimation for long missions.
- UI: "Data" tab in the right panel; canvas line charts (no libraries), hover
  crosshair readout, export series as CSV.
- Verify: elements round-trip against propagator state within tolerance.
- Size: medium.

### 4. Ground-station access windows

**Status v1.18.0: implemented for Earth-centered local legs.** The UI reports
Goldstone DSS-14, Canberra DSS-43, and Madrid DSS-63 rise/set, duration, and
maximum elevation with a configurable mask and CSV. A dual-theme editor
persists up to 32 user stations in the browser; presets may inject stations
without persisting them, and Track can show station markers. The geometric
access intervals remain nominal; after an uncertainty run, the report can
linearly propagate primary position covariance to each maximum-elevation epoch
inside the selected horizon and verified uninterrupted Kepler coast. It does
not produce probabilistic rise/set times.

Line-of-sight contact intervals between the spacecraft and a station catalog
(DSN Canberra/Goldstone/Madrid plus user-defined sites), with an elevation
mask.
- Engine: station position from body rotation model (already exists for the
  ground track); visibility = elevation above mask with occlusion by the
  central body; interval bisection for rise/set times.
- UI: stations table in the Track panel; access report (start, end, duration,
  max elevation) with CSV export; optional station markers on the ground map.
- Verify: hand-checked geometry cases (equatorial LEO vs polar station, etc.).
- Size: medium-large.

### 5. Eclipse and lighting analysis

**Status v1.18.0: implemented with conical umbra/penumbra geometry.** On-demand
local two-body intervals drive timeline bands, summary totals, and an optional
3D shadow-cone display; CR3BP states are excluded. The deterministic force
stack can use the same finite-disk lighting fraction to attenuate SRP, but the
report remains nominal geometry without probabilistic timing.

Umbra/penumbra intervals along the trajectory relative to the current central
body - drives power and thermal thinking, and it is geometrically cheap.
- Engine: cylindrical shadow (v1) upgraded to conical umbra/penumbra (v2);
  intervals via the same event-bisection machinery used for SOI crossings.
- UI: shaded bands on the timeline scrub bar; eclipse totals in mission stats;
  optional in-3D shadow cone toggle.
- Verify: ISS-like LEO yields about 35 percent shadow per orbit.
- Size: small-medium.

## Phase 3 - Sensors and multiple spacecraft

### 6. Sensor swath on the ground track

**Status v1.18.0: implemented.** Bounded spherical-body nadir/off-nadir
FOV-cone intersections map onto the Track panel with a width readout in both
themes while preserving the horizon footprint.

Project the spacecraft camera field of view as a swath over the ground-track
map (extends the existing nadir footprint circle), honoring the POV camera
FOV from the spacecraft card and an off-nadir pointing angle.
- Engine: FOV cone / body intersection ellipse mapped into the equirect chart.
- UI: swath fill + edge lines in theme colors; toggle in the Track panel.
- Verify: nadir swath width equals 2 h tan(FOV/2) for small angles.
- Size: small.

### 7. Multi-spacecraft missions

**Status v1.19.0: native mission vehicles plus synchronized comparison are
implemented.** One mission can propagate a primary plus seven secondary
vehicles through explicit separation, rendezvous, docking and undocking, while
the existing manager can still overlay preset/saved comparison missions.
Relative range, closest-approach refinement, conjunction threshold/timeline
events, colors and CSV remain available. Neither layer models coupled
formation-flight/contact dynamics, shared estimation, autonomous GNC, or
probabilistic conjunction intervals.

Render two or more missions simultaneously (constellation or rendezvous
sketching) with a relative-range plot and closest-approach report.
- Engine: propagate N missions against the same epoch; closest-approach via
  golden-section on sampled range.
- UI: mission manager list with per-craft color; relative-distance chart in
  the Data tab; conjunction events on the timeline.
- Verify: two-craft co-orbital case has analytic relative motion to compare.
- Size: large (touches state, renderer, timeline, exports).

## Phase 4 - Engine fidelity

### Accuracy priorities from the July 2026 audit

1. **Make departures vector-consistent - complete in v1.17.** `depart` now
   propagates an explicit planet-frame departure hyperbola. Applied vector,
   event delta-v, propellant use, and C3 come from the same state transition;
   the dated historical arrival remains the constraint rather than a minimum-
   delta-v re-optimization.
2. **Make body positions and velocities one coherent ephemeris - bounded
   release table complete in v1.18.** `bodyWorld()` and `bodyWorldVel()` share
   one reviewed mean-motion clock. A generated 20-body NASA/JPL Horizons table
   adds 15,380 Sun-centered ICRF/ecliptic J2000 rows for
   2026-06-27--2026-08-26 UTC, and one selected provider now reaches the center,
   perturbing bodies, and event functions together. The table fails closed
   outside per-body coverage; arbitrary historical/future high-accuracy dates
   remain out of scope.
3. **Add an adaptive n-body propagation mode - complete in v1.17.** Patched
   conics remain the fast default; the selectable adaptive integrator includes
   configured Sun/planet/moon point masses, dense output, collision/SOI event
   location, and bounded error/work limits. Output cadence follows the local
   orbital period or unbound dynamical time; the 5,000-point cap fails fast on
   overlong bound arcs instead of silently undersampling. This is not a full
   operational force model.
4. **Integrate finite thrust and mass depletion - complete in v1.17.** Thrust
   magnitude/direction, Isp, changing mass, point-mass gravity, and spacecraft
   state advance together. Osculating apoapsis therefore rises continuously in
   the finite-burn demonstration. A translating `central-relative` option
   correctly reduces to local two-body-plus-thrust motion; the former absolute-
   inertial `central-only` meaning was physically misleading. The renderer's
   gradual guides around ordinary impulsive burns remain explicitly cosmetic.
5. **Build the Earth-orbit perturbation stack deliberately - bounded stack
   complete in v1.18.** Selectable models now include first-order secular J2;
   a static, rigidly co-rotating 0-1,000 km atmosphere with cannonball drag;
   cannonball SRP with finite-disk eclipse attenuation; and axisymmetric Earth
   J2/J3/J4 in adaptive propagation. CelesTrak GP records use SGP4/SDP4, with
   first-order J2 only as a labelled failed-record fallback. Weather-driven
   density, tesseral gravity, attitude/panel dynamics, and full Earth
   orientation are not implemented.
6. **Add uncertainty after deterministic fidelity - bounded study complete in
   v1.18.** The core validates full 6x6 covariance, supports STM and process-
   noise APIs, RTN execution error, and seeded Monte Carlo. The UI exposes
   diagonal state sigmas and one local two-body endpoint. A separate linearized
   propagation gives conservative first-order primary-position confidence
   context at nominal access and fleet event epochs within the selected horizon
   and matching uninterrupted Kepler coast. It does not carry covariance
   through the full mission, cross later maneuvers/model/frame boundaries,
   model comparison-craft covariance, or compute probabilistic event intervals.

### 8. J2 perturbation option for Earth orbits

**Status v1.18.0: implemented.** The selectable `j2-secular` coast advances
the node, argument of periapsis, and mean anomaly with first-order secular
rates; Data provides rates/SSO reference, an opt-in selected-Coast preview, and
explicit Use J2/Use Kepler controls. It is Earth-only and off for
interplanetary legs. Off-grid interpolation advances the secular elements
analytically; completed display history is densified within a global point
budget and broken when it cannot be drawn safely, while the active window
remains bounded and exact.

Secular RAAN/argument-of-periapsis drift so sun-synchronous and frozen orbits
behave correctly in LEO.
- Engine: first-order secular rates applied on top of the two-body propagation
  (flagged per mission; off for interplanetary legs).
- Verify: SSO at 700 km should precess about 0.9856 deg/day.
- Size: small.

### 9. Finite burn durations

**Status v1.18.0: integrated.** A finite-burn segment advances point-mass
gravity, thrust direction/magnitude, state, propellant mass, and dry-mass
cutoff together. The teaching preset demonstrates a continuously rising
osculating apoapsis followed by an adaptive n-body coast. `central-relative`
uses a translating-center indirect acceleration rather than leaving the
spacecraft behind in a false absolute-inertial central-only model.

Report, propagate, and visualize burn arcs using the existing mass/thrust/Isp
data, with dry-mass termination and bounded adaptive output.
- Delivered size: large (integrated thrust arcs and shared force model).

## Implemented order

1 (porkchop) -> 3 (elements/graphs) -> 5 (eclipse) -> 2 (targeting) ->
6 (swath) -> 4 (access windows) -> 8 (J2) -> 7 (multi-craft) -> 9 (finite burns).

The implementation followed this dependency shape while prioritizing the
departure/return continuity and shared adaptive dynamics foundation before the
v1.17 UI audit. The v1.18 fidelity pass then followed: bounded Horizons table
and shared-provider plumbing -> environment forces -> SGP4/SDP4 -> seeded
uncertainty -> station/N-craft UI completion -> five validation missions ->
offline/schema/documentation verification.

## Housekeeping status - complete in v1.18

- README embeds actual Planner captures from `docs/blueprint.png` and
  `docs/cinematic.png`.
- `sw.js` and `js/offline.js` provide optional HTTP(S)/GitHub Pages caching
  after a first online visit. Direct `file://` operation remains supported,
  but service workers do not run there.
- `schema.html` and generated `docs/mission.schema.json` document all 19
  segment types. Regenerate the JSON with `node generate_mission_schema.js`.
- The Guide contains a keyboard shortcut reference card.
- `serve.ps1` and `start.bat` provide a zero-install local server at
  `http://localhost:5555/` for Live data and offline-cache testing.
