# AGENTS.md - nuxeo-labs-workflow-graph

Notes for coding agents. This file is committed to the public repository: keep it free of secrets, personal data
and machine-specific paths.

## Project

Nuxeo LTS 2025 Web UI plugin, **front end only**: a simple, read-only replacement of the "View Graph" dialog of
Web UI (the `nuxeo-workflow-graph` element, jsPlumb). It patches `nuxeo-workflow-graph.show()` once the element is
defined (`lwg-override.js`); the default `show()` is kept as a fallback (plugin disabled, layout failure).
Data: `GET /api/v1/workflow/{id}/graph` (required) and `GET /api/v1/workflow/{id}` (title and model name,
optional), requested in parallel; the graph is drawn once both have answered.

It is the simple sibling of `nuxeo-labs-custom-workflow-graph` (interactive version: details panel, Studio layout,
legend...). The two packages conflict (`package.xml`). Names never overlap: namespace `NuxeoLabs.WorkflowGraph`
(`LWG`), files and CSS classes `lwg-*`, i18n keys `labsWorkflowGraph.*`, property
`org.nuxeo.web.ui.labsWorkflowGraph.enabled`, elements `nuxeo-labs-workflow-graph-*`.

### Scope (decided with the user, keep it)

- The graph is **read-only**: steps and labels are not clickable nor focusable, no hover effect, no selection,
  no dimming, no details panel, no legend.
- **No animation** of any kind (no pulse, no animated dashes, no animated zoom/pan, no CSS transition).
- Highlighted: the current step(s) (state `suspended`: border, ring, "Current" badge) and their **outgoing**
  transitions (thicker, labels emphasized, drawn on top). The ring keeps a minimum screen size at low zoom
  (`--_lwg-inv-scale`) so current steps stay visible when the graph is fitted.
- Transition colors, as in Web UI's default graph: the transitions of a step with **2 or more** outgoing
  transitions get a palette color from their rank in the step (definition order, `edge.colorIndex` in
  `LWG.buildModel`): `--lwg-transition-1` to `-5` (`LWG.TRANSITION_COLOR_COUNT`), reused in turn (7 transitions:
  1, 2, 3, 4, 5, 1, 2). A single transition is neutral (`--lwg-edge`), or the highlight color when it leaves a
  current step. Next transitions keep their palette color (no halo). Labels: border + light tint of the color,
  text keeps the text color; the label border width never changes (sizes are computed in core). Classes:
  `is-next`, `lwg-tc lwg-tc-N`, color in `--_lwg-tc`. The graph endpoint has no transition id: colors cannot
  depend on the meaning of a transition.
- Only layout: dagre, top to bottom (default) or left to right. No Studio layout.
- Direction: two toolbar buttons (`↓` `→`, the active one has `aria-pressed="true"`), **no keyboard shortcut, no
  configuration property**. The user's choice is kept in `localStorage` per workflow model
  (`workflowModelName`, instance id when the workflow cannot be read), see `LWG.directionStorageKey`; TB is never
  stored (the entry is removed). Switching resets the view as at opening. The renderer only calls
  `onDirectionChange`; the dialog (and the demo) do the storage.
- View controls only: zoom (`+`/`=`, `-`, toolbar, pinch, Ctrl/Cmd + wheel, Safari gesture events), fit (`f`,
  toolbar), center on the current step (`c`, toolbar, cycles through parallel current steps), pan (drag, wheel).
  Zoom range 5%-250%, step 1.25. No arrow keys, no double-click zoom.
- Opening (and direction switch): fit; if the fitted zoom is under 50% and a step is current, zoom to 80%
  centered on it.

## Layout of the sources

- Maven modules: `nuxeo-labs-workflow-graph-web` (JAR: web resources, OSGI-INF, i18n) and
  `nuxeo-labs-workflow-graph-package` (marketplace package). Version `2025.1.0-SNAPSHOT`, parent
  `org.nuxeo:nuxeo-parent:2025.24`.
- Web files: `nuxeo-labs-workflow-graph-web/src/main/resources/web/nuxeo.war/ui/nuxeo-labs-workflow-graph/`,
  script order in `nuxeo-labs-workflow-graph-bundle.html`: `lwg-core.js`, `vendor/dagre.min.js`, `lwg-layout.js`,
  `lwg-icons.js`, `lwg-styles.js`, `lwg-renderer.js`, the Polymer dialog, `lwg-override.js`.
- Plain JavaScript + HTML imports, **no JS build**: Maven only packages the files. Files must run as classic
  scripts (IIFE on `window`/`globalThis`), no ES modules, no npm dependency at runtime.
- `lwg-core.js` and `lwg-layout.js` have no DOM dependency (unit tested in a Node VM). Sizes in `LWG.METRICS`
  (core) must match `lwg-styles.js`.
- CSS variables: public overrides `--lwg-*` are only read through internal `--_lwg-*` variables defined on
  `.lwg-root`/`.lwg-theme`, so a value set on `html` is never shadowed. Use `var(--_lwg-...)` in the CSS. The
  graph lives in shadow DOM (Web UI's `nuxeo-workflow-graph`, then the dialog): CSS variables are the only
  supported customization; any new public variable must be listed in the README "Colors" table.

## Conventions

- Apache 2.0 header `(C) Copyright 2026 Hyland (http://hyland.com/) and others.` with
  `Contributors: Thibaud Arguillere (with the help of opencode/Claude Opus 5.5)` on every new file (JS, HTML, MJS).
- `@since 2025.1` on new files / public API.
- JavaScript comments: `//` for 1 to 3 lines, `/* ... */` for 4+ lines or for section separators such as
  `/* ==================== Layout ==================== */`.
- ~120 characters per line, 2-space indentation in JS/HTML, single quotes, trailing commas.
- Never use `innerHTML` with data coming from the server (titles, labels): `textContent` only.
- `MANIFEST.MF`: one `Nuxeo-Component` entry per line, single leading space on continuation lines, newline at EOF.
- No Nuxeo or Web UI source file is modified; their sources are read-only references.
- Third-party code: unmodified files in `vendor/` with their license, listed in the README.
- When a change only touches README / AGENTS.md / .gitignore, do not run the build.

## Tests and tools

`dev/` is not packaged. Nothing is installed by the project. Do NOT use a local Nuxeo server unless asked.

```bash
# unit tests (Node 20+, no dependency)
node --test dev/test

# screenshots (dev/out/demo/*.png) + interaction checks in headless Chrome; fails on console errors/warnings
export LWG_NODE_MODULES=/path/to/node_modules        # must contain puppeteer-core
export CHROME_PATH=/path/to/chrome-headless-shell    # optional, defaults to Google Chrome on macOS
node dev/tools/screenshots.mjs [filter]              # filter "checks": interaction checks only

# build (Java 21, Maven 3.8+)
mvn clean install
```

Demo: `python3 -m http.server 8765` at the project root, then
`http://localhost:8765/dev/demo/index.html?wf=large&theme=dark` (`&dir=LR` forces the direction).

Fixtures: `dev/demo/samples.js` (Serial/Parallel Document Review and MainWF rebuilt from the Nuxeo sources,
synthetic "contract" and "large" workflows). Anonymise any real graph before adding it.
