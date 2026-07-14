# AI Assistant Handoff Brief

Audience: the next AI assistant (or human) taking over development.
State as of v1.19.4 (July 2026). Read AGENTS.md first for the short rules;
this file is the deep context. The owner is Tamir.

## Non-negotiable working conventions

1. Every change is logged in CHANGELOG.md under a version heading in the
   format `## [x.y.z] - M/D/YY - <Model/Author Name>` (e.g. "7/12/26 -
   Claude Fable 5"). Write what changed and why, including root causes of
   bugs - the changelog doubles as the project's engineering notebook.
2. A version bump touches THREE places: `VERSION` in js/constants.js and
   the two badges in index.html (`v1.x.y` and `Rev 1.x.y`).
3. Two UI themes share one DOM: Blueprint Light (paper/ink, international
   orange accents, technical-drawing look) and Cinematic Overlay (dark
   glass, ember orange). Every UI change must be styled for BOTH design
   languages (css/theme.css has per-theme sections; js/theme.js holds the
   render palettes). classic.html is the legacy dark UI sharing js/ui.js
   and js/renderer.js - wire new DOM lookups defensively (`if (el)`),
   because classic.html lacks newer elements.
4. Tamir wants REAL agency imagery (NASA/USGS/ESA/JAXA) for textures -
   never procedurally generated stand-ins (this was explicitly rejected).
5. No emojis in documentation or UI.
6. Tamir ends requests with "ask me questions if it will give me a better
   result" - ask focused clarifying questions before large or ambiguous
   work; propose options with a recommendation.
7. Dependency-free, buildless, file://-safe. No frameworks, no bundler,
   no package.json. Plain ES2020 scripts loaded in order by index.html.

## Verification (run this before and after every engine change)

    node tests/run_tests.js

All 27 presets must pass with zero segment warnings. tests/harness.js
loads the engine headlessly and is also the way to script one-off physics
experiments. Keep its script order aligned with index.html as new standalone
modules are added.
Run `node tests/live_tests.js` for Earth 100 and `node tests/deep_tests.js`
for Deep 100 data contracts. Run `node tests/tracker_shell_tests.js`,
`node tests/renderer_tests.js`, and `node tests/view_tests.js` for the combined
tracker page, renderer geometry/burn preview, and camera/pacing contracts.
The v1.17 physics/analysis modules have focused suites in `ode_tests.js`,
`targeting_tests.js`, `windows_tests.js`, `analysis_tests.js`,
`multicraft_tests.js`, `force_models_tests.js`,
`ephemeris_consistency_tests.js`, `cr3bp_tests.js`, `libration_tests.js`,
`cr3bp_mission_tests.js`, `finite_burn_mission_tests.js`, and
`j2_mission_tests.js`; `windows_ui_tests.js` and `analysis_ui_tests.js` guard
the Windows/Data/Track surfaces. The v1.18 suites are
`environment_models_tests.js`, `propagator_environment_tests.js`,
`ephemeris_table_tests.js`, `planner_ephemeris_tests.js`, `sgp4_tests.js`,
`gp_orbit_tests.js`, `live_sgp4_tests.js`, `uncertainty_tests.js`,
`uncertainty_ui_tests.js`, `operations_ui_tests.js`,
  `offline_schema_tests.js`, `feature_mission_tests.js`,
  `targeting_async_tests.js`, and the extended `targeting_tests.js`/
  `windows_tests.js`. `feature_mission_tests.js` exercises
the five focused validation presets through the actual engine.
The v1.19 native-fleet contract is covered by
`multivehicle_mission_tests.js` and `multivehicle_ui_tests.js`; the general
preset sweep now applies surface, conic, SOI-departure, and return checks to
every vehicle branch.
Also syntax-check code files after editing (node --check js/<file>.js) -
but exclude js/textures-data.js, which is generated data (megabytes of
base64) and not hand-edited.

Established accuracy baselines (do not regress):
- Flyby turn angle matches the analytic 2*asin(1/e) within 0.5 deg;
  v-infinity is energy-corrected at the SOI (E = v^2/2 - mu/r), NOT the
  raw |v_rel| - raw values show false mismatches at big SOIs (Jupiter).
- Horizons spot checks: Ceres 381 km, Eris 734 km, Bennu 449 km (Bennu
  needs current-epoch elements due to Yarkovsky drift).
- Voyager 2 grand tour: Saturn date exact, Jupiter/Neptune within 1 day,
  Uranus +5 days. Cassini Earth flyby exactly 1999-08-18.
- MECO + apoapsis circularization leaves e < 1e-5.
- Every patched-conic departure propagates a real source-body hyperbola from
  the burn to the SOI. The local and parent states at the handoff share one
  epoch, position, and velocity; applied-vector/event delta-v differs by less
  than 1 m/s and dated historical arrival constraints remain unchanged.
- Child-to-parent returns target an arrival-plane tangent periapsis, not merely
  a point at the requested radius. Target radius closes within 1 km and radial
  velocity at periapsis is effectively zero.
- Catalog body positions and velocities use a single mean-motion clock; the
  cross-catalog finite-difference derivative regression remains below its
  stated relative tolerance.
- The corrected Earth-Moon halo closes in ideal CR3BP tolerance; the Sun-Earth
  Lissajous seed is deliberately non-periodic. Periodic-family stationkeeping
  is phase-locked to the corrected reference instead of freely re-integrating
  an unstable numerical reference; four-cycle same-phase drift stays below one
  metre. Events and Jacobi bookkeeping are deterministic. Every exposed Sun-Earth/Earth-Moon,
  L1/L2, planar/halo/Lissajous, and small/medium option is regression-tested;
  medium Lissajous seeds must be materially larger than small seeds.
- A 700-km, 98.19-degree Earth orbit in `j2-secular` mode precesses near the
  expected 0.9856 degrees/day. The finite-thrust preset raises osculating
  apoapsis continuously while depleting mass. Long J2 state queries use the
  analytic secular model, not endpoint Hermite interpolation, and rendered old
  history may break when the bounded dense-point budget cannot draw it safely.
- Adaptive force arcs sample bound motion by local period and unbound motion by
  local dynamical time, with at most 5,000 output points. Overlong bound arcs
  fail fast rather than aliasing revolutions; split them or select Kepler/J2.
- Standard finite-thrust arcs use 1e-9/1e-11 relative/absolute tolerances and
  store 32 display samples per initial local period; gravity-only adaptive
  arcs retain their tighter settings and 64 samples per local timescale. The
  adaptive integrator remains independent of output cadence, and callers may
  explicitly request tighter burn tolerances for validation.
- A near-zero-thrust `central-relative` Earth arc reduces to local two-body
  propagation after subtracting Earth's translating catalog state. The removed
  absolute-inertial `central-only` interpretation is not an acceptable force
  model.
- The generated Planner Horizons table contains exactly 20 bodies and 15,380
  immutable rows from 2026-06-27 through 2026-08-26 UTC. It is Sun-centered
  (`500@10`), ICRF/ecliptic J2000, generated reproducibly by
  `get_planner_ephemerides.ps1`, and returns no state outside per-body
  coverage. A configured force arc must not fall back to catalog elements when
  this provider is missing or out of bounds.
- Environment-model reference checks cover piecewise atmosphere boundaries,
  co-rotating drag direction, inverse-square cannonball SRP, finite-disk
  umbra/penumbra continuity, and Earth J2/J3/J4 accelerations. Preserve the
  0-1,000 km static-atmosphere boundary and explicit Earth-only guards. These
  models are deterministic and do not include space weather, tesseral gravity,
  attitude, or panel geometry.
- Public Vallado near-Earth and deep-space reference vectors guard SGP4/SDP4.
  TLE checksum/identity and OMM parsing remain strict. GP off-grid states must
  evaluate the model, not interpolate sparse path chords; stored cadence is at
  most one sixty-fourth of an orbit and at most 10,000 samples. TEME enters
  Planner/Track through the same GMST pseudo-Earth-fixed mapping.
- Joined native vehicles must delegate off-grid queries to the target's exact
  provider. In particular, the Dragon branch and ISS SGP4 target are identical
  throughout the joined coast, not merely at stored GP nodes.
- The LEO conjunction lab's reviewed closest approaches are 0.9204 km for the
  selectable no-burn reference and 2.3492 km after the 12 m/s avoidance burn.
  The former enters the 2 km threshold and the latter does not.
- The joint Earth-Mars validation target varies departure epoch and TOF through
  the real mission engine while retaining one B-plane aim offset. Its reviewed
  solution is 2005-08-21T15:40:35.784Z and 203.827366 days, achieving a
  299.804 km Mars periapsis for a 300 km goal. This is a bounded local,
  single-revolution solve, not a global optimizer.
- Uncertainty inputs and outputs are seeded and bounded. The library caps Monte
  Carlo at 20,000 samples, total model evaluations at 20,000, and numerical
  STM evaluations at 64; the Planner limits the form to 100-5,000 samples and
  0-8,760 hours. The disposal preset anchors to the state before its burn and
  rejects the nominal or any retained sample whose osculating periapsis crosses
  Earth. The finite-sample endpoint cloud is not reused for event products;
  access and fleet reports instead propagate the primary covariance linearly
  from the named source to nominal event epochs inside the same horizon and a
  matching uninterrupted Kepler coast. Event timing remains nominal and
  comparison-craft covariance is not modeled.
- A named-site Planner launch starts on Earth's surface over the site's exact
  latitude/longitude in the shared texture/Ground Track signed-spin and axial-
  tilt convention. The one-second, 21-sample schematic ascent ends on the exact
  requested MECO conic. Without `targetPlane`, the direct-ascent plane passes
  through the pad and ends 8–18° prograde downrange. With `targetPlane`, the
  final orbit instead uses a near-optimal target-plane family: admit candidates
  whose absolute target-normal dot is no more than `sin(0.25°)` above the
  strict minimum. Select the plane passing closest to the pad, then use target
  error as the tie-break; the powered-ascent
  visualization doglegs from the exact pad to that plane's closest point. Do
  not assert that the pad belongs to the final plane. This site-local tie-break
  prevents a geographically distant/Pacific-looking ascent while retaining the
  historical transfer scale. The bridge is a simplified-spin, non-Keplerian
  visual/finite-ascent approximation that shifts downstream epochs by only one
  second, not a launch-guidance, atmosphere, or finite-burn physics model. Its
  display shape leads the vertical rise before a squared angular gravity turn;
  coupled radial/angular easing reads as a straight chord in close LEO views.
- A blank-site Direct launch is an orbital-state initialization, not a physical
  launch claim. It starts at the requested conic with a path break and no
  invented surface-to-orbit line or ascent delta-v. Named-site launches retain
  the established schematic ascent behavior above.
- Full Cassini playback in Auto Time is ~2.3 minutes, Apollo ~1 minute.

## Engine tour (js/)

- constants.js: body catalog. Planets use JPL/Standish approximate
  elements; moons use simplified mean elements; 13 dwarfs/asteroids use
  JPL SBDB osculating elements (`smallElements`, epochs noted). Also
  LAUNCH_SITES, rotHours/tiltDeg per body, VERSION.
- kepler.js: universal-variable Kepler propagation (Stumpff functions),
  Lambert solver (bisection on z), element/state conversions, frames. Catalog
  state positions and velocities use the same reviewed mean-motion clock; do
  not restore a separate Kepler-rate velocity approximation.
- targeting.js: bounded scalar Vary/Achieve helpers, insertion period/opposite-
  apsis targeting, an arrival-plane Lambert solver that makes the requested
  return radius a tangent periapsis, and a genuine bounded joint
  departure-date/time-of-flight targeter. The Windows UI passes its visible
  bounds, evaluates both variables through `MissionEngine.recompute()`, holds
  one simplified B-plane aim offset fixed, stages the result, and requires
  explicit Apply. The cooperative async wrapper yields between mission
  evaluations, supports cancellation, and is numerically equivalent to the
  synchronous bounded solve. UI results are tied to a mission fingerprint and
  revalidated through the applied mission before success is reported.
  A point constrained only to `|r|=rp` is not a periapsis unless `dot(r,v)=0`
  also closes. The joint solver remains local, scalar-goal, and
  single-revolution.
- ode.js: bounded adaptive Dormand-Prince 5(4), per-component tolerances,
  quartic dense output, forward/backward integration, and direction-filtered
  event roots. Higher-fidelity modules share this implementation.
- environment-models.js: bounded deterministic Earth environment models. The
  atmosphere is a static piecewise-exponential table from 0 to 1,000 km and
  rigidly co-rotates; drag and SRP use cannonball mass/area coefficients; solar
  pressure is 4.56e-6 N/m2 at 1 AU; a finite solar disk attenuates SRP through
  penumbra/umbra; and gravity harmonics are axisymmetric Earth J2/J3/J4. Do not
  describe this as a weather atmosphere, full gravity field, or attitude/panel
  model.
- ephemeris-table.js + planner-ephemeris-data.js: immutable bounded
  cubic-Hermite states and the generated 20-body, 15,380-row NASA/JPL Horizons
  release table. The current table covers 2026-06-27--2026-08-26 UTC. It is
  Sun-centered, ICRF/ecliptic J2000, and stores km/km/s after source TDB-to-UTC
  conversion. No extrapolation is permitted. Run
  `get_planner_ephemerides.ps1` to reproduce it from the reviewed Deep
  reference-body source.
- sgp4.js: strict TLE/CCSDS OMM parsing and standards-compatible near-Earth
  SGP4/deep-space SDP4, derived from satellite.js 6.0.1 and the Vallado
  reference. Keep `THIRD_PARTY_NOTICES.md` with the vendored core. TEME to
  body-fixed uses a GMST-based pseudo-Earth-fixed transform and deliberately
  omits full EOP, polar motion, and high-precision precession/nutation.
- cr3bp.js: canonical barycentric/synodic Sun-Earth and Earth-Moon CR3BP
  systems, L1-L5 equilibria, equations/Jacobian, Jacobi constant, and
  dimensional frame transforms. The circular/restricted assumptions are
  explicit and the unstable collinear points carry warnings.
- libration.js: STM single-shooting for periodic Lyapunov/halo families, a
  bounded linear center-mode Lissajous seed, nonlinear CR3BP propagation, and
  deterministic ideal impulsive reference-tracking stationkeeping. Corrected
  periodic references use smooth cubic-Hermite phase sampling so instability
  in a freely propagated numerical reference cannot pull a maintained halo
  away after several cycles. Never call
  the Lissajous seed periodic or the stationkeeping an operational guidance law.
  All two systems, both L1/L2 points, three families, and small/medium sizes are
  reviewed combinations; Lissajous size must change planar/vertical amplitude.
  Stationkeeping rejects more than 1,000 correction epochs.
- force-models.js: adaptive inertial point-mass gravity evaluated against one
  explicitly selected catalog or bounded Horizons provider at every derivative
  and event epoch, optional finite thrust and mass flow, environment-model
  drag/SRP/eclipse/J2-J4 terms, dry-mass cutoff, and collision/SOI event
  surfaces. A selected provider must reach the spacecraft, center, perturbing
  bodies, and event functions together; missing/out-of-coverage Horizons state
  fails closed. It is deterministic and excludes attitude dynamics, tesseral
  harmonics, relativity, covariance transport, and stochastic maneuver error.
  Force-model samples cache inertial `worldV`;
  any intervening impulse must update both relative `v` and `worldV` while
  retaining mass, or the next adaptive arc will restart from the pre-burn
  inertial velocity and silently discard the maneuver. Planner output cadence
  is `min(duration/180, local period/64)` for bound motion and uses the local
  dynamical period for unbound motion, capped at 5,000 samples. The
  `central-relative` finite-burn option still integrates in shared inertial
  coordinates but adds the center body's translational acceleration; this is
  what makes the relative state obey local two-body plus thrust. `central-only`
  survives only as a migrated legacy spelling.
- windows.js: cached, bounded single-revolution Lambert launch-window grids
  with synchronous and browser-chunked APIs. Reports C3, both v-infinities, and
  total characteristic velocity; UI application remains an explicit user act.
- analysis.js: bounded osculating-element/altitude/speed/target-distance series
  and CSV, conical umbra/penumbra intervals, DSN/user station access, sensor
  footprints, first-order Earth J2 rates, SSO inclination, and finite-burn
  estimates.
- multicraft.js: synchronized bounded sampling of up to 128 state providers,
  relative range, closest-approach refinement, conjunction extraction, and CSV.
- uncertainty.js: positive-semidefinite 6x6 covariance validation,
  analytic/supplied or bounded finite-difference STM propagation, process
  noise, RTN maneuver execution covariance, and seeded Monte Carlo. Library
  caps are 20,000 samples, 20,000 model evaluations, and 64 numerical STM
  evaluations. The current Planner surface uses diagonal Cartesian sigmas and
  one local two-body endpoint; do not imply full-mission covariance transport
  or probabilistic access/conjunction timing. The UI may separately propagate
  the primary covariance linearly to nominal pass maximum-elevation and fleet
  closest-approach epochs inside the selected horizon and a matching
  uninterrupted same-body Kepler coast; it must not infer comparison-craft
  covariance or perturb event times. RTN covariance uses the numerical Jacobian
  of the state-dependent burn map; inertial burns retain an exact identity map.
- propagator.js: 23 SEG_EXEC segment executors - launch (blank-site Direct
  records are orbital-state initializations with a path break and no invented
  surface ascent; named Earth sites resolve
  at T+0 through the same signed-spin/axial-tilt body-fixed convention as
  textures and Ground Track; ordinary launches use a site-compatible direct-
  ascent plane and bounded 8–18° prograde endpoint, while `targetPlane`
  launches admit RAAN candidates no more than `sin(0.25°)` target-normal dot
  above the minimum, choose the one closest to the site, and use the pad's
  closest in-plane point as a schematic powered-ascent dogleg; the 21-sample,
  one-second bridge reaches the exact target MECO conic but is non-Keplerian;
  `_info.siteRaanDeg` and
  `downrangeDeg` describe ordinary launches, while `targetRaanDeg`, `raanAuto`,
  `planeMissDeg`, and `doglegDeg` describe target-plane launches; direct launch
  remains available and legacy JSON without `ascent` = direct), coast, burn,
  transfer (Lambert with bestBurnWait ignition optimization, capped 450 d
  heliocentric; `side` A/B picks the short/long-way solution and flipping
  it changes gravity-assist geometry downstream), flyby (B-plane aim
  offset periapsis targeting, unpowered bend conserves energy-corrected
  v-infinity), insertion (`at: "periapsis"|"apoapsis"`), observe (coast
  emitting "obs" events aimed at a target body), plane change, aerobrake,
  reentry/landing; adaptive n-body/J2/environment coasts; integrated finite
  burns; `gp_orbit`; libration initialization, CR3BP coasts, and
  stationkeeping. `gp_orbit` initializes from strict TLE or OMM input, replaces
  any incompatible incoming trajectory with a path break and warning, evaluates
  SGP4/SDP4 exactly for off-grid state queries, stores at most period/64 cadence,
  and caps output at 10,000 samples. Its TEME state is routed through the shared
  Earth-fixed/Planner frame conversion before Track or rendering. `depart` and
  child-to-parent return paths propagate explicit local hyperbolae to the SOI,
  then patch the same-time vector into the parent frame. Do not reintroduce an
  instant frame replacement or omit the physical transit time. SOI transitions
  are found by event bisection. `sampleAtTime()` analytically advances J2 mean
  elements between stored points; never replace this with Hermite interpolation
  across multi-revolution spans. Stationkeeping applies its configured radial
  offset to the first tracked state, marks a path break, and emits a note; do
  not connect that artificial dispersion as if it were flown motion.
  Native missions retain the root spacecraft/segments as vehicle `primary`
  and accept at most seven secondary vehicles. `separate` branches from an
  exact source segment boundary; `rendezvous` uses a bounded passive phasing
  wait plus a terminal Lambert leg selected by the local orbital normal;
  `dock` requires a close, slow capture and then follows every exact target
  state; `undock` releases the craft. Dependencies are acyclic and invalid
  references, cycles, delta-v limits and missed captures fail closed. These
  histories are synchronized test particles: no combined mass, center of
  mass, contact, attitude, flexible-body, relative-navigation, or autonomous-
  GNC model.
  Stationkeeping preserves eight integrated states inside every correction
  interval before applying the same ideal impulsive controller. Earth-Moon
  checks can be more than a day and 140,000 km apart; storing endpoints alone
  recreates visibly polygonal paths even though the off-grid ship interpolates.
- missions.js: 27 presets. Cassini/Voyager/Apollo dates are pinned to reality -
  coasts are sized from measured SOI exit transits; do not "optimize"
  them back to min-delta-v (that diverges from the historical route). The
  Earth-Moon halo, Sun-Earth Lissajous, and finite-thrust apoapsis-raise
  presets are teaching/design demonstrations, not historical reconstructions.
  The Artemis-style preset uses a highly elliptical polar-ish lunar orbit only
  as a fast patched-conic stand-in for NRHO; the separate CR3BP presets are
  ideal family demonstrations, not an Artemis ephemeris reconstruction. The
  five v1.18 validation presets are `leo_environment_lab` (Horizons + drag +
  J2-J4), `geo_srp_horizons` (Horizons + SRP/eclipse + J2-J4),
  `sdp4_validation` (public Vallado 04632 deep-space GP case),
  `leo_disposal_uncertainty` (pre-burn seeded dispersion plus operations UI),
  and `mars_joint_target_lab` (actual coupled departure/TOF solve). Keep these
  as focused validation cases rather than folding their model controls into a
  historical reconstruction.
  The ten v1.19 presets are `iss_orbital_reference`,
  `crew_dragon_iss_docking`, `apollo11_full`, `jwst_l2_operations`,
  `gateway_halo_operations`, `apophis_2029_recon`,
  `osiris_rex_sample_return`, `sso_imaging_campaign`, `electric_geo_raise`,
  and `leo_conjunction_lab`. Preserve the older simplified `apollo11` preset.
- renderer.js: painter-sorted canvas renderer. Key invariants:
  - Sphere silhouette radius is f*R/sqrt(z^2-R^2), not f*R/z (the naive
    formula drew close planets ~35% small; surface events floated).
  - Bodies with prj.z < 0.85*radius are skipped (camera inside/grazing;
    prevents a full-screen texture flash).
  - Two-pass trajectory draw: the full trajectory is painted behind bodies,
    then only physically visible pieces overlapping planet disks are redrawn.
    The foreground repair pass uses the finite camera eye and an exact
    ray/sphere test against each physical body, not point depth relative to the
    body center. A perspective far-side point near the limb can be closer than
    the center while still occulted; restoring the old center-depth shortcut
    makes paths and the ship appear to pass through planets.
  - The selected Planner ship arrow is a navigation indicator and remains
    visible above a planet with a dashed occlusion ring. Physical trajectory
    segments, L-points, and inactive spacecraft remain ray/sphere-occluded.
  - Local orbit arcs replace the 181-point global ellipse when zoomed in
    (chord sag becomes visible); trigger uses the body's own camera
    distance, not its parent's.
  - Trajectory caches include the result object identity. Recomputes can keep
    the same sample count/end time, so a numeric-only key can draw stale data.
  - Every eligible same-body Kepler span gets bounded, cached exact display
    points; the active span gets a still-finer bridge containing `tNow`. Do not
    return to drawing stored coast samples as straight endpoint chords.
  - Native inactive vehicle paths use the same bounded exact densification;
    the coarse fleet cache is only acceptable for external comparison craft.
    Joined follower path/marker history is suppressed while the target owns
    the assembly trajectory, preventing doubled coincident lines and labels.
    Inactive native paths are dashed, hidden before/after their independent
    sample coverage, and use a moving local orbital/reference-cycle window. A
    `rendezvous-target` retains its reviewed two-hour span so a multi-day ISS
    record cannot cover the globe with repeated solid revolutions.
  - Active CR3BP rendering shows one nearby reference cycle and only the event
    markers inside that canvas window. The complete multi-cycle integration,
    event list, timeline, exports, and playback remain available.
  - J2 display spans use analytic `sampleAtTime()` states and share a 12,000-
    point global addition budget. If completed old history needs more points
    than the budget can represent without surface-crossing chords, break that
    span. The active J2 bridge remains a bounded roughly two-period window
    around `tNow`, so scrubbing stays exact without materializing a year of LEO.
  - `osculatingGeometry()` applies body/frame ephemerides at each geometry
    point's own epoch. Never translate the whole ellipse at display time in an
    inertial or third-body frame.
  - Burn events may carry private `_burn` pre/post states. Renderer-only
    `burnPreviewState()` uses them for the labeled gradual apoapsis preview;
    ordinary burns and departures remain instantaneous impulses. A
    `finite_burn` segment is different: its samples come from integrated
    thrust/mass dynamics and must not be replaced by the preview mechanism.
  - Patched-conic departures and child-to-parent returns mark renderer-only
    `_burn` records with `handoff: true`, but their post-burn motion is now a
    real source-body hyperbola with physical elapsed time. The local/parent SOI
    samples are same-time, position/velocity-continuous, and have no
    `_breakBefore`. Reintroducing an instant-SOI replacement recreates the
    teleport bug; reconnecting sparse endpoints can recreate planet crossings.
  - Escape previews keep a finite, explicitly illustrative AP only before
    ignition. The bounded guide reaches at least 85% of a finite source-body
    SOI (with a 92% ceiling), so an Earth escape visibly raises AP beyond the
    Moon before opening. At ignition `apoOpen` becomes true and the renderer
    follows the exact continuous hyperbola; `burnPreviewDisplayState()` and
    Auto camera consume that same solved state. Never interpolate the
    spacecraft toward a distant SOI marker or feed illustrative preview state
    into propagation.
  - While a burn preview is active, `trajectoryBridgeForDisplay()` exposes the
    exact same `osculatingGeometry` object used by the apsis overlay. Captures
    keep that preview conic; escapes stop the closed guide at ignition because
    a finite ellipse cannot converge to a hyperbola.
  - Hyperbolic capture and escape have no real finite apoapsis. The renderer
    uses a labeled, bounded illustrative ellipse to show pre-ignition AP
    lowering/raising. Apollo lunar departure retains Moon-local `_burn`
    metadata, then follows its explicit local return hyperbola to the SOI.
  - A Sun-centered conic is stationary in the inertial display frame as well
    as the Sun frame. Keep `isStaticApsisFrame()` in both osculating sampling
    and the apsis cache key or accelerated interplanetary playback rebuilds 129
    unchanged points every paint.
  - CR3BP samples carry synodic state and system identity. Do not derive a
    false two-body apsis overlay from them. L1-L5 are epoch-correct virtual
    marker/picking records, not catalog bodies; synodic frames keep the
    corresponding primary-secondary line fixed.
  - `options.scaleBarAnchor={x,y}` is a guarded canvas-coordinate override and
    `options.scaleBar=false` suppresses the bar. Planner callers omit both and
    retain the theme palette defaults; Deep uses them beside its HTML readout.
  - Picking channel: scene.out.bodies / .events / .basis feed the UI
    (double-click focus, click-event-to-jump).
- textures.js: MTPTex sprite cache - orthographic shaded sphere sprites,
  LRU keyed by quantized (body, size, light, body-frame, camera-basis) buckets.
  Auto-camera radius changes use 3/6-pixel large-sprite buckets, an 80 ms
  per-body refresh floor, a 2 rebuild/frame budget, and at most one large
  rebuild per frame. `emissive` doubles as the "full bright"
  unlit mode (opts.flatLight). `Astro.bodyFrameAt()` supplies the same axes to
  textures and Track; mapCanvas(id) feeds the ground track.
- groundtrack.js: equirect map, body-fixed track matching the texture
  mapping exactly (IAU orientation when declared, otherwise tilt/spin), terminator,
  acos(R/r) footprint, event markers, observation mode (sub-spacecraft
  point on the observed body via obsRanges).
- ui.js: app state S, Auto Time pacing (major events only,
  per-gap cruise rate + scale-aware crawl floor + early square-root approach
  + 2 s brake/3 s acceleration log smoothing + bounded overshoot guard),
  180-second event windows for renderer-only patched handoffs (normal events
  remain 70 seconds), a 60 Hz ordinary playback paint cap, and a 30 Hz cap
  while Auto Time or a complex native fleet is playing (clock/camera
  integration still runs at native rAF),
  auto-camera exact body/ship focus with a 6.5-real-second shot latch, POV
  camera, ground-track panel driver, Windows porkchop workspace, and Data
  workspace. Mission replacement preserves active playback but clears POV,
  top view, virtual L-point focus, stale synodic-frame state and the old
  Lagrange toggle before adopting the replacement mission's frame. Data
  reports current two-body elements; bounded charts/CSV for
  altitude, speed, target distance, a/e/i/RAAN/argument of periapsis/true
  anomaly; a live cursor/hover crosshair; on-demand conical eclipse intervals
  with scrub bands; Earth-local DSN access with mask/CSV; Earth J2 rates/SSO
  reference and selected-Coast preview/apply controls; a persisted user-station
  editor (maximum 32 browser stations) plus preset-injected stations; optional
  3D umbra/penumbra cones; and an N-craft manager. The primary plus at most
  seven comparison craft render with stable colors, explicit T+0 alignment,
  range/closest-approach/conjunction reporting, timeline events, and CSV. The
  underlying multicraft analysis cap remains 128 providers. CR3BP states show
  system/Jacobi data and are excluded from false two-body, eclipse, and access
  reports. Track adds DSN/user-station markers plus spherical-body
  FOV/off-nadir swaths and width,
  spacecraft card (rocket-equation propellant tracking), mission
  save/load (localStorage "mtp-missions"), GIF export (suspends the live
  rAF loop via S.exporting; auto camera converges before frame 0),
  timeline tick clustering (0.6% of bar; click steps through a cluster).
  The guarded mission-vehicle selector switches the segment editor, spacecraft
  card, HUD, active path, Track source, camera and Auto Time event stream. It
  also lets canvas marker picking select a native vehicle. Native vehicles are
  distinct from the saved/preset comparison-craft manager. Mission JSON uses
  `mtp-mission-2` and remains backward compatible with single-vehicle files.
  The scrubber, ticks, Auto Time, Track, POV, eclipse/access reports, and GIF
  export share the selected vehicle's coverage. The Mission Vehicles readout
  lazily computes native closest approach and conjunction intervals in Data.
  Numerical SOI closure impulses stay in the event/report stream with
  `patchCorrection=true`, but `isAutoEvent()` must exclude them from both Auto
  Time pacing and Auto camera cuts; they are solver bookkeeping, not mission
  maneuvers. The uncertainty panel accepts diagonal Cartesian sigmas, optional
  RTN execution errors, a seed, 100-5,000 samples, and a bounded endpoint
  horizon. `mission.uncertainty.source.beforeSegment` must resolve from the
  recomputed mission rather than the current scrub time. Access/fleet summaries
  may propagate primary covariance to their individual event epochs inside that
  horizon only when the analyzed burn matches the flown impulse and no later
  maneuver, force-model, or frame boundary intervenes. They never perturb the
  nominal event epochs or infer comparison-craft covariance. Editing any
  uncertainty input must invalidate the endpoint and event cache immediately.
- tracker-shell.js + live.html: combined Earth 100 / Deep 100 experience.
  The hash-selected shell configures one shared DOM and loads only the chosen
  controller/data stack; `deep.html` is a compatibility redirect to
  `live.html#deep`. Do not load the large Deep current-vector bundle or its
  optional historical-path asset in Earth mode, or merge
  Earth-relative and heliocentric markers into one unusable camera scale. The
  shell also owns the shared Display/Ground Track panel state and responsive
  overlay zones; controllers must not attach competing panel-toggle handlers.
  Live uses the same expanded/collapsed Display component and sidebar edge tab
  as the Planner in each theme; POV and Deep Track are view buttons rather than
  a separate custom menu language. In Cinematic, the visualization is full
  bleed behind transparent floating chrome: a Planner-style scene title and
  telemetry HUD, transparent catalog rail with only the selected mission in
  glass, right-side Display/detail surfaces, and a floating circular-control
  transport. At desktop/tablet widths, Deep Focus/Frame occupies one guarded
  inline topbar slot in both themes; at <=720px the same DOM controls move into
  Display to protect compact layouts without cloning controls or losing state.
  Blueprint moves verbose source/accuracy status into the catalog rail so the
  topbar remains control-led. Cinematic scope controls are separate pills with
  an orange active fill, and its circular Play/Pause icon uses explicit centered
  shapes. The shared texture option is labelled `Textures` in both modes.
  Deep's `historic mission path` option is shared by both themes, selected-only,
  and off by default. `js/deep-space-archives.js` is an optional Deep-only load
  immediately before `deep.js`; a missing archive must fail closed without
  preventing the bounded current-vector controller from starting. Mode defaults
  are authoritative during shell initialization: overwrite browser-restored
  checkbox state so history is truly off after reload unless an archive-only
  selection explicitly enables it.
- live-catalog.js + live.js: Earth 100 controller. The reviewed catalog
  contains exactly 100 unique NORAD IDs;
  runtime data comes only from the small CelesTrak STATIONS, SCIENCE, and
  RESOURCE OMM JSON groups. Successful data is cached for four hours and all
  requests, including failures/manual refreshes, observe a two-hour minimum.
  Valid records propagate with `SGP4.propagateRecord()` through the near-Earth
  SGP4 or deep-space SDP4 branch. A record that cannot initialize may use the
  old first-order J2 secular path only as an explicit labelled fallback. Never
  restore OMM-as-osculating two-body propagation as the default; GP mean
  elements require the GP model. This remains prediction, not telemetry,
  certified pass prediction, conjunction screening, or verified operational
  status.
  Provider epochs older than 3.5 days or more than six hours in the future are
  surfaced as STALE/PRED rather than hidden behind a recent fetch timestamp.
  Earth Track builds a rolling, several-orbit SGP4/SDP4 window (or the labelled
  fallback) and supplies the same guarded GMST Earth-fixed mapping plus an
  equatorial Sun vector to the shared groundtrack renderer.
  All markers carry cached, physically propagated two-minute trails so 1x
  subpixel motion is legible without falsifying the current state.
  Selected spacecraft support an Earth-facing 90-degree perspective POV whose
  eye follows the propagated state; manual camera input exits the view. Earth
  orbit samples, markers, labels, hit targets, and motion trails use physical
  sphere visibility rather than center-depth sign. Keep the finite-eye ray test
  in POV and the silhouette-depth test in the normal orthographic view; tangent
  limb geometry is intentionally visible to prevent flicker.
- deep-space-catalog.js + deep-space-ephemeris.js +
  deep-space-archives.js + deep.js: Deep 100
  controller/data. The catalog has exactly 100
  unique Horizons target IDs and marks every operational state unverified.
  The generated release bundle is Sun-centered (`500@10`) and bounded, with
  15-minute lunar, 30-minute Mars, 3-hour observatory, and 6-hour default
  cadence. The current 2026-06-27--2026-08-26 UTC asset has 51 trajectories and
  leaves 49 catalog-only. Six records legitimately stop inside the requested
  release window: Chandrayaan-2 Orbiter, CAPSTONE, Mars Reconnaissance Orbiter,
  SOHO, IMAP, and DSCOVR. Horizons rejects a full request when an endpoint
  crosses the loaded SPK even if the earlier interval is valid, so Full mode
  parses the reported before/prior-to/after boundary and retries five minutes
  inside it. Keep those results bounded at their own last row; never expand a
  partial record to the global bundle stop. `stateAtTrajectory()` uses cubic
  Hermite interpolation and returns null outside coverage. Never extrapolate
  or infer activity from whether Horizons returned a vector. Source vector
  epochs are JDTDB; the
  generator converts them to true UTC instants with the leap-second table and
  TDB-TT periodic term before storage. Run `-NormalizeExistingTimeScale` once
  on any pre-v1.10 bundle; never relabel numeric JDTDB as UTC. Deep playback
  clamps and pauses at the bundle edge so every endpoint marker remains visible.
  Ulysses (`-55`) is explicitly PREDICTED from 2009-06-30; its post-mission
  SPK values are source-correct but must never be described as a live craft.
  Mars surface missions carry explicit `surfaceBody: "mars"` metadata; never
  infer this from an altitude threshold. Curiosity, InSight, Opportunity, and
  Spirit are current surface-site vectors, not orbiters: label them `SITE`, do
  not draw a selected orbital path, and make Fit selected focus Mars. Mars's
  `iauOrientation` is the NAIF IAU 2000 pole/prime-meridian model used by these
  Horizons records. `Astro.bodyFrameAt()` converts the displayed UTC Julian
  date back to TDB before evaluating it, keeping the textured globe, marker,
  and ground map fixed at the reviewed landing coordinates. Earth 100's finite
  GMST spin override intentionally retains the legacy tilt/spin frame.
  Deep view supports independent body
  focus and moving-body reference frames, body-radius-aware close zoom, and a
  bounded adapter into groundtrack.js. Its off-by-default `L1-L5 (ideal
  CR3BP)` option computes Sun-Earth or Earth-Moon equilibrium markers and adds
  matching synodic frames, paths, POV targets, picking, and focus. These ideal
  points are independent of the official bounded Horizons spacecraft vectors
  and must not be presented as mission telemetry. Focus, Frame, and canvas body picking
  share one allowlist covering the Sun, planets, moons, dwarf planets,
  asteroids, and comets; mission marker hits retain priority. The bundle also
  carries a visible-by-default `minor bodies` Display option matching Planner.
  When disabled, dwarf planets, asteroids, comets, and bodies orbiting them are
  hidden, except that the exact active Focus or Frame remains visible so a
  selected reference view cannot become blank. Deep POV applies the same rule
  and must not target a hidden minor body. The bundle also
  carries 20 bounded Horizons reference-body records so precise spacecraft
  vectors are not mixed with approximate body positions. Historical trail
  points must subtract the
  matching reference body at their own epoch before restoring Astro.bodyWorld
  at display time; a single frozen translation gives the wrong relative
  trajectory. `get_deep_ephemerides.ps1 -Mode ReferencesOnly` refreshes these
  records without replacing the current mission trajectories and must retain its
  Moon/Mars abort guard and atomic output replacement. Full mode must preserve
  valid same-window mission records on per-target failures and abort any
  same-window coverage regression. When Focus and Frame name different bodies,
  compose both reference origins; never select one and silently discard the
  other. The Deep scene injects that same bounded body source into renderer.js,
  so bodies, camera focus, markers, and parent-local osculating body-orbit paths
  share one coordinate basis in the default view as well as explicit frames.
  Close planet/moon paths and ground maps use the same bounded six-orbit cubic-
  Hermite window. Do not reconnect the raw 15/30-minute local-orbiter vectors:
  those straight chords can cross the central body and recreate the Mars
  starburst shown in the v1.10 bug report.
  Deep POV follows the selected bounded state and looks toward the nearest
  rendered planet, moon, dwarf planet, or the Sun. renderer.js exposes the
  exact camera eye and the physical spheres it actually drew; Deep mission
  paths, markers, labels, and hit targets must use those same occluders. Sparse
  path chords are adaptively refined only near a projected body disk and must
  break while occulted rather than being painted back over the planet. Body
  click focus consumes renderer `out.bodies`: mission hits win first, then the
  full visible disk selects an unobscured focusable body; retain the first body
  hit through the camera move that occurs between the two clicks of dblclick.
  Local Track windows remain bounded at roughly six orbits but advance in
  short, fixed source-anchored cadence steps. Do not restore period-derived
  `halfSpan / 2` buckets, which replace large historical sections and jitter as
  the osculating period changes. The canvas scale is anchored immediately to
  the right of the visible Camera/Focus/Frame readout in both themes. Ground
  Track draws its
  past/future split through the exact interpolated current point, so the color
  boundary follows the marker continuously rather than jumping at cached
  samples. Equirectangular paths break at dateline and large near-polar
  longitude discontinuities; filtered body legs and repeated observation
  windows are also explicitly segmented instead of being reconnected.
  `get_deep_archives.ps1` separately generates selected-only, position-only
  historical paths for Pioneer 10/11, Voyager 1/2, and Cassini at one-day
  Horizons source cadence with JDTDB-to-UTC conversion and 3D RDP display
  simplification. The 244,008-byte v1.15 asset contains 4,118 optimized
  vertices: 117 Pioneer 10, 183 Pioneer 11, 111 Voyager 1, 141 Voyager 2, and
  3,566 Cassini. The four interstellar histories end at the 2026-06-27 current-
  bundle handoff; do not extend them with predictive rows masquerading as
  history. Cassini ends at its real 2017-09-15 source boundary and is marked
  `HISTORY`, not current. Current Voyager/Pioneer paths win by default; the
  Display option replaces only the selected path, while current markers,
  numeric state, clock/playback bounds, POV, and Ground Track continue to use
  `deep-space-ephemeris.js`. Cassini auto-enables and fits its historical path
  because it has no current record, and its card must explicitly say there is
  no current position. Archive rows are never interpolated into state or used
  to widen playback. The producer declares continuous one-day source rows;
  consumers still split invalid/nonmonotonic samples and honor any explicit
  producer `maxGapMs`. Rendering is occultation-safe and capped at 4,800
  selected display points. A missing optional archive must not break Deep.
- gifenc.js: streaming GIF89a encoder (palette locks after 8 buffered
  frames). scriptgen.js: GMAT-style script text, including continuous Depart,
  targeted insertion, n-body/finite-burn, and CR3BP segment annotations.
  theme.js: palettes + theme switching (localStorage "mtp-theme", blueprint
  default).

## Textures pipeline

js/textures-data.js is GENERATED (base64 data URIs; can be ~8 MB). Never
hand-edit. Earth is the 2048x1024 NASA Visible Earth Blue Marble map; Moon is
an 8x4, 2048x1024 stitch of NASA Moon Trek LRO WAC Global Mosaic v02 tiles.
Both generators pin those same official sources. Regenerate via
`get_textures.ps1 -EarthMoonOnly` or get_textures.html (browser page: Celestia
content pack probed by direct raw.githubusercontent URLs, Wikimedia
Commons search fallback with candidate previews and manual swapping -
scripted downloads get HTTP 429 from Wikimedia, browsers do not).
get_textures.ps1 is the Windows-planets alternative (Solar System Scope
pack). Data-URI embedding avoids canvas tainting so PNG/GIF export works
from file://.

## Repository / deployment

Static GitHub Pages deployment from the repo root (.nojekyll present,
design zip gitignored). Direct `file://` remains supported. `start.bat`
launches `serve.ps1` and opens `http://localhost:5555/`; the PowerShell script
also accepts `-Port` and `-NoOpen`, installs nothing, emits no-cache headers,
and confines requests to the repository root. Use it for network-backed Live
data and service-worker testing.

`sw.js` plus `js/offline.js` register only on HTTP(S). Core files are cached
individually; large generated assets are opportunistic, and failure to cache
one must not block startup. A first online visit is required before HTTP
offline use. Do not claim service-worker caching on `file://`.

`schema.html` is the dual-theme schema reference generated from
`MissionEngine.SEGMENT_TYPES`; `node generate_mission_schema.js` writes the
23-segment `docs/mission.schema.json`. Runtime/import hydration applies its
declared field defaults before vehicle-reference validation. Keep one legacy
exception: v1 and unversioned launches without `ascent` retain their historical
direct circular insertion, while `mtp-mission-2` opts into the schema's MECO
default. Regenerate both claims after changing
the segment vocabulary. README embeds the actual `docs/blueprint.png` and
`docs/cinematic.png` captures. LICENSE is MIT with texture attribution notes;
the satellite.js/Vallado-derived GP core is additionally recorded in
`THIRD_PARTY_NOTICES.md`.

## Roadmap

plan.md records the phased feature plan and its bounded v1.19 completion
status. Porkchop plots, genuine joint transfer targeting, elements/graphs,
eclipse and sensors, a persisted user-station editor, rendered N-craft
comparisons, J2, adaptive n-body/environment propagation, finite burns,
atmosphere/drag, SRP/eclipse, Earth J2-J4, SGP4/SDP4, the bounded 20-body
  Horizons table, seeded endpoint uncertainty, bounded event-epoch primary
  covariance, offline support, schema docs, screenshots, and Guide shortcuts
  are implemented.

Remaining work is increased fidelity, not an unchecked plan item: arbitrary-
date authoritative ephemerides, measured atmospheric weather, non-zonal
gravity, attitude/panel dynamics, high-precision Earth orientation,
full-mission covariance transport, probabilistic access/conjunction epochs,
global or multiple-revolution targeting, and operational orbit determination.

## Known trouble spots

- PowerShell + raw pipe characters in URLs silently break Invoke-RestMethod
  (encode as %7C and print caught API errors).
- Wikimedia rate-limits scripts (API and full-size originals); use
  browser-context fetching or 2048px thumbnails with throttling.
- GitHub API anonymous quota is 60/hr per IP; prefer raw file probing.
- The Auto Time and auto-camera constants are the product of several
  tuning rounds driven by user feedback ("stopping at every event",
  "changing views for no reason") - treat current values as calibrated.
- Sprite cache keys must include anything that changes pixel output
  (lighting mode, spin, basis) or stale sprites flash.
- GIF export and the live render loop share caches; S.exporting guards
  reentrancy.
- Escape/return SOI samples intentionally duplicate one epoch in two central-
  body frames. They must agree in world position and velocity. Removing the
  local hyperbolic transit recreates teleportation; treating a Lambert endpoint
  radius as periapsis without the tangent condition recreates wrong return AP.
- Halo/Lyapunov families are ideal corrected CR3BP solutions, the Lissajous
  result is a bounded linear seed, and stationkeeping is deterministic
  reference tracking. None includes navigation covariance, ephemeris error,
  operational maneuver design, or full ephemeris n-body dynamics.
- `adaptive-nbody`, `finite_burn`, and `j2-secular` are opt-in Planner segment
  modes. Preserve their bounded step/output/event caps so a long mission cannot
  freeze the buildless UI. A long J2 mission may intentionally omit unsafe old
  display spans while retaining an exact active window; an overlong bound
  adaptive arc should fail and ask for a split, not relax its sampling cap.
- `adaptive-environment` is also opt-in. The 20-body Planner Horizons table is
  valid only from 2026-06-27 through 2026-08-26 and must fail closed outside
  per-body coverage. Do not silently substitute catalog state for just one
  force, center, or event participant; mixed ephemerides recreate incoherent
  relative accelerations.
- SGP4/SDP4 accepts GP mean elements, not an arbitrary osculating state.
  Preserve strict TLE checksum/identity validation, exact off-grid model
  evaluation, and the period/64/10,000-sample caps. A sparse GP polyline must
  never become the physics source, and TEME must not bypass the shared GMST
  Earth-fixed mapping.
- Earth rotation uses the dedicated Vallado-style GMST branch everywhere the
  Planner and GP layers need a body-fixed frame. UTC currently approximates
  UT1; do not claim full EOP, polar-motion, precession, or nutation support.
- `uncertainty.source.beforeSegment` exists to prevent double-applying a
  configured maneuver and to make a run independent of the scrubbed display
  state. Do not attach the Monte Carlo endpoint cloud to an event. Event rows
  use a separate time-correlated linearized primary covariance calculation
  within the configured horizon and a verified uninterrupted Kepler interval.
  The analyzed burn must match the named flown impulse and propagated nominal
  state; times stay nominal and comparison covariance remains unknown. Preserve
  the `J P J^T + Q` RTN maneuver map and label the resulting conservative bound
  as a first-order estimate because higher-order execution-error products are
  intentionally omitted.
- The operations UI renders at most seven comparison craft and persists at
  most 32 user stations even though the analysis core accepts 128 providers.
  Keep both UI caps; they protect the buildless renderer and browser storage.
- Never implement central-relative thrust by merely selecting the central body
  as the only global point mass. The shared inertial state also needs the
  center's translational acceleration as an indirect term, or the center moves
  away from its supposed local orbit.
- A configured stationkeeping `offsetKm` is an injected dispersion, not a
  coast. Preserve its first-sample `_breakBefore`, note event, and 1,000-epoch
  work cap. Periodic Lyapunov/halo maintenance must stay phase-locked to the
  authored corrected orbit; sequential free propagation of the reference
  recreates the four-cycle divergence fixed in v1.19.4.
- `patchCorrection` burn events close numerical SOI geometry. Keep them
  reportable, but do not put them back into Auto pacing/camera event lists.
- Mixed patched/force-model sequences may carry `w`, `worldV`, and `massKg`
  alongside central-body-relative state. `applyDv()` is the single supported
  impulse path because it updates every representation, including
  `forceWorldV`; changing only `v` or `worldV` recreates the stale adaptive-
  velocity burn-loss bug.
- A fixed transfer/departure aim is only an encounter if the propagated state
  enters the target SOI. Do not relabel closest distance outside the SOI as a
  periapsis or create a target-frame handoff for that miss.
- Gravity-only adaptive arcs after a finite burn must preserve `ctx.massKg`.
  Use `Number.isFinite` for mass presence checks: global `isFinite(null)` is
  true and previously turned absent sample mass into zero during interpolation.
- CelesTrak asks clients not to request the same data more often than every
  two hours. Keep the per-group request-attempt timestamps and scheduled
  four-hour refresh in live.js intact.
- Horizons vectors are generated with `get_deep_ephemerides.ps1`, not fetched
  from `live.html#deep` at runtime. Keep the catalog center and generated bundle at
  `500@10 (Sun center)`, preserve per-trajectory coverage checks, and keep the
  explicit JDTDB-to-UTC conversion on both mission and reference rows.
