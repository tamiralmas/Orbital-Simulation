# Agent instructions

Mission Trajectory Planner: dependency-free, buildless, browser-based
orbital mechanics simulator (GMAT/STK-lite). Plain ES2020, canvas 2D,
loads straight from file:// or GitHub Pages.

Read HANDOFF.md for the full technical brief before non-trivial work.

Rules:

1. Log every change in CHANGELOG.md: `## [x.y.z] - M/D/YY - <Your Name>`,
   with root causes for bug fixes. Bump VERSION in js/constants.js AND
   the two version badges in index.html.
2. Test: `node tests/run_tests.js` (9/9 presets, zero warnings) before
   and after engine changes. `node --check` changed js files, but skip
   js/textures-data.js (generated data - never hand-edit it).
3. Style every UI change for BOTH themes in css/theme.css (blueprint =
   paper/ink/orange technical drawing; cinematic = dark glass/ember).
   Guard new DOM wiring with `if (el)` - classic.html shares the JS but
   lacks newer elements.
4. No frameworks, no build step, no package.json, no emojis.
5. Textures must be real agency imagery (regenerate via
   get_textures.html); never procedural substitutes.
6. Historical presets (Cassini, Voyagers, Apollo) are date-pinned to
   reality - do not re-optimize their trajectories for delta-v.
7. Ask the owner focused clarifying questions before large or ambiguous
   changes; offer options with a recommendation.

## Imported Claude Cowork project instructions
