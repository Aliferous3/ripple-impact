# Tranche 3 — Type-Dependency Impact + Live Analysis

**Verdict: GO**

Continues from Tranche 2 (`e75a0e9`). Two scoped items, done in order:

1. **Type-dependency impact** — `type_depends` edges derived from
   deterministic TypeScript AST type-position classification over SCIP
   occurrences, propagated by a separate type BFS, reported as a distinct
   affected set (never mixed into runtime impact).
2. **Live analysis / watch mode** — chokidar watcher + debounced,
   revision-guarded re-analysis streamed to the explorer over SSE.

## Type-edge model

New `EdgeKind`: **`type_depends`** — deliberately the only type edge kind.
Finer categories (`ACCEPTS_TYPE`, `RETURNS_TYPE`, …) were not manufactured:
the evidence detail field already records *why* the usage is a type
position (`type-reference` | `heritage-clause` | `type-query`) without
claiming semantic roles the analysis can't verify.

Every `type_depends` edge carries:
- `from` — consuming symbol (innermost enclosing definition; the file
  node when SCIP's `enclosing_range` doesn't cover the usage — honest
  module-level attribution, e.g. some `satisfies` clauses)
- `to` — the type/interface/alias symbol
- `file` + `range` of the type usage
- `source: "typescript-ast"`, `detail`, `confidence: "certain"`

Graph schema bumped to `GRAPH_SCHEMA_VERSION = 2`; API schema to 2 —
old artifacts invalidate rather than reinterpret.

## How type edges are derived

Two deterministic AST enrichments now run per source file:

1. call-site classification (Tranche 0),
2. **type-position classification** (`src/indexers/enrich/type-positions.ts`):
   annotations, heritage clauses, `satisfies`/`as` expressions, `typeof`
   queries, generic type arguments — recorded as range→hit plus a
   `import type` / inline-`type` alias table.

At index build (`scip-indexer.ts` pass 2), each SCIP reference occurrence
is intersected with the classified ranges:

- occurrence **at a type-position range** → `type_depends`
- `local N` occurrences at type positions (SCIP binds `import type`
  aliases as locals with no SymbolInformation) → resolved through the
  file's alias table: alias → module specifier → target file → exported
  symbol. Unresolvable locals produce no edge — never a guess.
- occurrence at a call-callee range → `calls`
- everything else → `references`

**The negative space is the point**: `import type { User }` alone binds an
alias but creates zero edges — an edge only appears when the alias is
actually consumed at a type position. Bare imports, plain identifier
reads, and module specifiers can never become `type_depends`.

## Runtime vs type vs reference

Traversal is one BFS parameterized by edge kinds:

- **Runtime impact** (direct + transitive): `calls`, `implements`,
  `contains` seeds. `references`, `imports`, `type_depends` never enter.
- **Type impact** (typeDirect + typeTransitive): `type_depends` only,
  plus `contains` hops for provenance.
- Changed **interface members** seed their containing interface into the
  type BFS (adding `User#email` is a `User` shape change) — deliberately
  *not* into the runtime BFS. Class members don't seed (conservative).
- **Conservative boundary**: a caller of a type-affected function is not
  itself marked type-affected unless it has its own `type_depends` path.
  This is an accepted, documented false-negative class — the alternative
  (treating every caller of a typed function as type-affected) inflates
  reach without evidence.

Type-affected nodes join `relevant` for report/referencing/test purposes
but are serialized as their own `typeImpact.direct/transitive` sets.

## Zod before/after — the mandatory validation

Commit `0b216ef6` ("fix(types): declare record output and input as
members", a type-only diff touching `$ZodRecordInternals`):

| | changed | direct | downstream | type-affected |
|---|---|---|---|---|
| Tranche 2 engine | 3 | 0 | 0 | — |
| Tranche 3 engine | 3 | 0 | 0 | **301** (3 depth-1 + 298 transitive, depths 2–11) |

Runtime sets correctly stay at zero — type impact does not contaminate
runtime impact.

**Manual audit** (the part that matters more than reach):

- Every one of the 301 has a traversable path where each hop is a real
  `type_depends` edge with `file:line` evidence. Spot-checked chains:
  `$ZodRecordInternals → $ZodRecord → _record()`,
  `→ ZodRecord → _ZodJSONSchema → _ZodJSONSchemaInternals`,
  `→ $ZodTypes → JSONSchemaGeneratorParams → ToJSONSchemaParams →
  createToJSONSchemaMethod` — all verified against source, including
  qualified names (`schemas.$ZodRecord`) and generic arguments.
- Distribution is plausible: 187 land in `v4/classic/schemas.ts` (the
  file that actually consumes these internals), the rest across the
  schemas/core/api/test surface.
- Negative space clean: no regex/version/error-utility files implicated;
  only 1 locale test (with a genuine `ZodType` annotation) appears.
- ~50 type-affected entries are file/test nodes — module-scope type
  usages attributed to their file node when no enclosing definition
  covers the occurrence. Evidence retained; nothing fabricated.

**False positives found: 0.** **False negatives (accepted, documented)**:
callers of type-affected functions (conservative boundary), class-member
changes (no seeding), `local` aliases SCIP can't link to a real symbol.

## Explorer: type impact is a first-class category

- `TYPE` node tag + purple accent; `type_depends` edges drawn dashed.
- Sidebar: `Type affected` filter + `TYPE` header stat.
- DetailsPanel: `WHY IS X TYPE-AFFECTED?` — per-root provenance chains
  showing `contains` hops and `type_depends` edges with
  `kind · file:line · evidence-source · confidence` per hop.
- Depth control applies to type-affected nodes; the 250-node render guard
  counts them.

## Live analysis

```
chokidar watch (repo root, filtered)
  → 300ms debounce (save burst = 1 run)
  → serialized analysis runs (mid-run change → one queued follow-up)
  → revision-guarded adoption
  → SSE /api/events → explorer
```

**Watcher** (`src/server/watch.ts`): chokidar 4.x, `add`/`change`/`unlink`.
Ignored dirs (regex): `node_modules .git .ripple dist build coverage
.next .turbo out .cache`. File filter: `.ts/.tsx/.mts/.cts/.js/.jsx/
.mjs/.cjs/.d.ts` + `tsconfig*`/`package.json`/lockfiles (the fingerprint
inputs). `awaitWriteFinish` 60ms.

**Windows fix**: `fs.watch` kills the process (libuv `fs-event.c` assert)
when the watched root contains an 8.3 alias (`ALIFER~1`) — event filenames
arrive in long form and fail a prefix check. `toLongPath()` resolves the
root via `realpathSync.native` before watching. This is why the watcher
works on Windows at all.

**Debounce**: `LiveAnalysis.request()` collapses events inside 300ms into
one run. Runs are serialized (`running` flag); a change mid-run sets
`pending` → exactly one follow-up run, not a queue.

**SSE transport** (`/api/events`): one-way server→browser, no library —
`text/event-stream`, `retry: 2000`. Events: `hello` (revision, watching,
running), `analysis-started`, `analysis-result{revision,result}`,
`analysis-error{revision,message}`. WebSockets rejected as
supererogatory.

**Stale-race protection** (the "rev 11 must never overwrite rev 12"
requirement): server side, a result is only adopted as `latest` when
`rev === this.revision`; client side, `appliedRev` drops any event older
than the newest applied generation. Belt and suspenders by design.

**Invalid source**: a failed run emits `analysis-error`, `latest` is
untouched, the explorer keeps the previous valid graph + shows a warning;
the next successful run recovers automatically. Tested end-to-end.

**State preservation** (all React state survives the result swap):
selection persists when the node still exists (verified live — `Profile`
stayed selected through an update), clears cleanly when it disappears;
filters, depth, search query, focus root all preserved.

## Cache reuse in watch mode (the "no cold SCIP per save" requirement)

scip-typescript **has no incremental mode** — it always re-indexes whole
tsconfig projects, so a content-changing save necessarily re-indexes
(~17.5s on zod for the SCIP binary alone). Within that constraint:

- **Fingerprint dedup**: a save that leaves file contents identical
  (no-op write, touch) returns the last result without running the
  pipeline — near-instant.
- **Per-file enrichment cache** (`src/cache/enrich.ts`, new): call-site +
  type-position classification is a pure function of file content, now
  content-addressed under `.ripple/cache/enrich/`. A fingerprint miss
  re-classifies only files that actually changed — saves ~4s of 22s on
  zod, ~30% on the fixture. Also shared by base-graph (worktree) runs.
- **Whole-graph hits**: revisiting any previously-seen tree state (undo)
  is an instant cache hit; base graphs are SHA-keyed as before.
- **Debounce + serialization** means one save burst = one index run.

What is *not* done (documented limitation): no partial/graph-fragment
reuse — cross-file edges make fragments non-composable, and reusing a
stale-range graph would misreport diff mapping. Full re-index on real
edits is the correctness-preserving floor.

## Live update timings (Windows, comment-append edit → SSE result)

| repo | files | first edit | second edit |
|---|---|---|---|
| type-fixture | 5 | 2.4s | 1.9s |
| fast-glob | 86 | 3.5s | 3.1s |
| tsup | 46 | 2.6s | 2.5s |
| zod | 471 | 19.0s | 18.3s |

(zod baseline before the enrichment cache: 23.3s. `analysisMs` ≈ SCIP +
graph build; write→start is dominated by debounce + awaitWriteFinish.)

## Security

- Watcher + SSE add no new attack surface: `/api/events` is read-only
  GET, same loopback binding, same `handleApi` gate.
- Live runs can't tear the cache — atomic temp-write→rename unchanged.
- Watcher `error` events are swallowed (a watcher hiccup can't kill the
  explorer); watcher `close()` is awaited before test temp-dir deletion.
- All 11 explorer-server security tests still green.

## Known limitations

- Large-repo live latency: ~18–19s on zod per content-changing save
  (inherent — no incremental SCIP). The `Re-analyzing…` badge + preserved
  graph keep this honest rather than broken.
- `satisfies` and other module-scope type usages attribute to the file
  node (SCIP `enclosing_range` gap) — honest, evidence kept.
- Conservative boundary under-reports: callers of type-affected functions
  aren't marked without their own `type_depends` path.
- Class-member changes don't seed type impact (deliberately conservative).
- Watch mode covers the working tree only; a `git checkout` mid-run is
  just another (big) change event — handled, but the result is only as
  fresh as the last settled run.

## Test totals

- `vitest` (backend): **8 files, 109 tests** — all green
  - `type-impact.test.ts` (10): hand-built + real-SCIP propagation,
    transitive chains, interface-member seeding, `import type` negatives
    (unused import / unrelated consumer NOT implicated), `satisfies`
    module-level attribution, runtime/type/reference separation
  - `live.test.ts` (9): debounce burst-collapse, mid-run queueing,
    stale-revision protection, failure-keeps-last-valid, watcher
    filtering, SSE hello/result, burst→single cycle, invalid-source
    error + automatic recovery
  - `tranche1.test.ts` +3: enrichment cache persistence/identical-output,
    corrupt-artifact fallback, content-keyed entries
- `playwright` (browser): **30 tests** (15 × 2 viewports) — all green
- `tsc --noEmit` root + explorer — clean
- Prior regression: all T0–T2 assertions unchanged and green

## Verdict: GO

Type impact is evidence-backed, negative-space-clean, and separated from
runtime impact by construction. Live mode is correct under races and
failures, and usable on small/medium repos today; large-repo latency is
an understood, documented constraint — not a correctness gap.

## Recommended Tranche 4

Distribution, not more analysis: make Ripple installable and usable
outside this repo — `npm` packaging (`npx ripple …`), bundled explorer
assets, first-run docs, `.gitignore` handling, `--version`, and a
dogfood pass on a real consumer repo. Candidate engine follow-ups (defer
unless demanded): per-project cached SCIP for monorepos to cut large-repo
live latency; `ACCEPTS_TYPE`/`RETURNS_TYPE` refinement *only if* a real
consumer asks for the distinction.
