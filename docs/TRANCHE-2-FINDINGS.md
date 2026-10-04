# Tranche 2 — Local Visual Change-Impact Explorer

**Verdict: GO**

Continues from Tranche 1 (`17a56f0`). Goal: prove that the deterministic
engine's `AnalysisResult` is sufficient to drive a real comprehension-first
product surface — changed → direct → downstream → tests → warnings →
evidence — without duplicating analysis logic in the frontend.

## What the explorer needed to prove

- The Tranche 1 schema can render every state the engine reports
  (changed/deleted/direct/transitive/test/referencing) distinctly.
- "Why did this change / why is this affected" can be built entirely from
  serialized evidence paths — no second analysis, no AI summaries.
- The UI stays responsive at zod-scale impact surfaces (1.4k affected nodes).
- Local-first: loopback binding, path-checked source previews, nothing
  leaves the machine.

## Graph library choice

**React Flow (@xyflow/react) + dagre** — chosen over Cytoscape and Sigma.js.

- React Flow: React-native node components (evidence chips, tag badges,
  status styling are plain DOM — no canvas re-implementation), built-in
  pan/zoom/fitView/minimap/controls, good performance to several hundred
  nodes, huge ecosystem. Weakness: DOM nodes cost more than WebGL at 5k+,
  which is why the render guard exists.
- Cytoscape: stronger layout algorithms and 10k+ node performance, but
  canvas-rendered nodes make rich custom content (diff previews, chips)
  painful and styling is its own system.
- Sigma.js: WebGL, fastest for raw scatter, but minimal interaction model —
  wrong tool for labeled evidence graphs.

The impact subset (not the whole repo graph) is rendered, so React Flow's
ceiling is comfortably above what the product shows.

## Architecture

```
engine (src/)          analyzeRepository() / analyzeSymbol() — unchanged, authoritative
       ↓
server (src/server/explorer.ts)
  loopback-only node:http server
  GET /api/analysis        → AnalysisResult (schemaVersion 1, incl. parsed diff)
  GET /api/node?id=…       → node + in/out edges + downstream reach
                             (reach computed by impactNodes() — the engine)
  GET /api/source?file=…   → path-gated line-range preview
  /*                       → prebuilt Vite bundle (dist/explorer), SPA fallback
       ↓
explorer/ (React + Vite)
  viewmodel.ts   — the ONLY AnalysisResult→canvas adapter
  GraphCanvas    — React Flow + dagre, depth-staggered reveal, focus dimming
  DetailsPanel   — WHY CHANGED / WHY AFFECTED / edges / diff+source preview
  Sidebar        — search, depth, category filters, tests, warnings
```

The frontend never imports indexing/graph code; the engine never imports
React. `/api/node` reuses `impactNodes()` for downstream reach rather than
reimplementing traversal.

## Explorer semantics

Category → visual encoding (color AND shape/tag — not color alone):

| state        | tag chip | style                        |
|--------------|----------|------------------------------|
| changed      | ADD/MOD/REN | amber border              |
| deleted      | DEL      | red dashed border            |
| direct       | D1       | blue border                  |
| transitive   | D+       | gray border                  |
| test         | TEST     | green, pill shape            |
| referencing  | REF      | dashed gray (never "affected") |

Edges: solid = calls (impact-propagating), dashed = references/former-caller
(coupling only). Deleted symbols are synthetic `deleted:file:name` nodes
whose former callers resolve through the Tranche 1 base graph.

## Evidence UX

- **WHY CHANGED** — change kind, moved-from provenance, per-hunk
  old/new ranges, and the exact diff hunks intersecting the symbol's
  evidence ranges (from `AnalysisResult.diffFiles`, added in this tranche).
- **WHY AFFECTED** — one card per reaching changed root: ordered path nodes
  with per-edge `kind · file:line · evidence-source · confidence`.
  Multi-root provenance is never collapsed (e2e-verified with a two-root
  node).
- **Former callers** — deleted nodes list base-graph callers as a clickable
  evidence path.
- **Downstream reach** — factual `N symbols · M files · T tests` per node,
  from `/api/node` (engine traversal server-side).

## Local security (tested — tests/explorer-server.test.ts)

- Binds `127.0.0.1` only; test proves `::1`/wildcard unreachable.
- `/api/source` rejects `..`, absolute paths, NUL, `.git/`, `.env`,
  `node_modules/`, and any file not present in the graph or diff — verified
  for 7 attack patterns; `package.json` itself is refused because it isn't
  a graph node.
- Static serving confined to `dist/explorer`; traversal returns 403 or the
  SPA shell, never file contents.
- GET-only API; unknown routes 404; no writes, no telemetry, no network out.
- OS-assigned port by default (`listen(port=0)`) — no collisions with
  dev tooling; `--port` overrides explicitly.

## Performance (measured, Windows, warm caches)

| repo       | impact surface                | payload | first render | select→details |
|------------|-------------------------------|---------|--------------|----------------|
| fixture    | 15ch 3d 2t 1test              | 21 KB   | ~1.6 s       | <100 ms        |
| fast-glob  | 21ch 87d 65t 37tests 33ref    | 315 KB  | ~2.3 s       | <150 ms        |
| tsup       | 4ch 2d 0t 0tests 4warn        | ~30 KB  | ~2.1 s       | <100 ms        |
| zod        | 1ch 61d **1336t** 133tests    | 6.3 MB  | ~2.3 s       | ~170 ms        |

First render includes `/api/analysis` fetch + dagre layout + reveal.

## Large-graph handling

`MAX_RENDERED_NODES = 250`. When the filtered node set exceeds it, the guard
keeps changed + direct + tests + nearest-depth transitive and shows a banner
("Large impact surface — showing changed + direct + nearest downstream").
250 is where dagre layout + DOM mount stays ≲1 s in practice; React Flow
handles it without virtualization pressure. Depth select (Direct only /
≤2 / ≤3 / all) and category filters expand or narrow from there.

Also: when `fitView` would zoom below 0.4 (illegible), the canvas instead
centers on the changed roots at 0.85 zoom — introduced after fast-glob's
206-node surface rendered as an unreadable strip.

## Engine fix found via e2e

`BINARY_SKIPPED` was unreachable: `parseGitDiff` silently dropped files git
reported as `Binary files … differ`, and untracked binaries were skipped in
the provider. Now binary `ChangedFile`s are kept (flagged, no hunks) and map
to `unmappedFiles` with reason `binary` → real BINARY_SKIPPED warnings,
verified on tsup's diff. An untracked `*.ts` file continues to map to
NOT_INDEXED.

## Browser verification

Playwright, two projects: desktop 1440×900 and laptop 1280×800.
30 tests (15 specs × 2 viewports), all passing, including:

- header counts identical to `/api/analysis`
- category visibility + distinct tags
- WHY AFFECTED path with `file:line · source` evidence lines
- WHY CHANGED with diff-preview hunks
- deleted node → DELETED chip + "no longer exists" + former callers
- focus mode dims others and restores
- filters and depth control alter presentation only
- search select → details; `/`, Escape, F keys; `#n=` deep-link survives reload
- warnings render from real engine output (BINARY_SKIPPED fixture)
- multi-root node shows both root paths
- source preview shows real file lines

Harness: `scripts/e2e-server.ts` pins `tmp/git-scenarios` at
`s15-import-only`, dirties `session.ts` (multi-root) and adds an untracked
binary (warning), then `startExplorer()`. `playwright.config.ts` builds the
bundle and waits on `/api/analysis`.

## Screenshots (committed artifacts)

- `docs/screenshots/explorer-overview.png` — full impact surface
- `docs/screenshots/why-changed.png` — diff evidence + source + reach
- `docs/screenshots/why-affected.png` — evidence path panel
- `docs/screenshots/focus-mode.png` — unrelated nodes dimmed

## Known UX limitations

- Node-local descriptors (`string0:` etc.) appear in a node's Edges list —
  they exist in the graph; cosmetic noise only.
- The `.dim` reveal-animation interaction needed `animation-fill-mode`
  removal — focus dimming previously couldn't override `forwards` fill.
- No file-view grouping (Phase 15 deferred — symbol view suffices at these
  sizes; revisit if grouping aids zod-scale navigation).
- Minimap is informational at guard-capped sizes; no clustering.
- Type-level changes still surface as referencing-only (engine limitation
  carried from Tranche 1 — visible in zod's HEAD~3 diff: 3 changed,
  0 downstream).
- Mobile/tablet is untested by design (desktop dev tool).

## Recommended Tranche 3

Not GitHub integration — the evidence says the highest-value next step is
**correctness breadth in the engine before distribution**:

1. Type-dependency edges (referenced types impact) — the zod run shows
   type-only changes currently under-report; a "type-impact" edge kind
   would close the largest remaining false-negative class.
2. Watch mode / incremental re-analysis for `explore` (fingerprint poll,
   re-serve) — turns the explorer into a live companion instead of a
   snapshot.
3. Only then distribution: GitHub Action or `npx` packaging.

## Test totals

- Backend/unit (vitest): **87** — 76 T0/T0.5/T1 unchanged + 11 new
  server/security tests.
- Browser (playwright): **30** — 15 specs × {1440×900, 1280×800}.
- `npm run typecheck`: root + explorer both clean.
