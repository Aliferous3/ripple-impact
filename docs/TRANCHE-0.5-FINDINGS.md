# Ripple — Tranche 0.5 Findings

Git diff → changed symbols → impact analysis.

## Goal

Prove or disprove that a Git diff can be deterministically mapped to the
*smallest defensible* set of changed program symbols, and that those symbols
can feed the Tranche-0 impact engine without inventing attribution.

## Git architecture

`src/git/` is fully isolated from the graph and impact layers.

- `GitDiffProvider.getDiff({repo, base?})` runs **one** shell command:
  `git diff --no-color -U0 <oldRev>` plus `git ls-files --others
  --exclude-standard` for untracked files.
- `-U0` emits zero context lines, so every hunk range is exactly the changed
  line range — no approximation, no context-line leakage into symbol
  attribution.
- Semantics:
  - `ripple impact`            → `HEAD` vs working tree (staged + unstaged
                                 tracked changes, plus untracked files as
                                 whole-file additions)
  - `ripple impact --base R`   → `merge-base(R, HEAD)` vs working tree —
                                 i.e. "what this branch changed, plus any
                                 uncommitted edits". This is PR-diff
                                 semantics, not `R..HEAD`.
- Rename detection uses git's own (`diff.renames`, default on): `rename
  from`/`rename to` headers are parsed; a pure rename produces no hunks and
  therefore no changed symbols.
- Binary files are skipped via the `Binary files … differ` marker.
- `git show <oldRev>:<path>` supplies old-revision file text on demand.

## Changed-symbol algorithm

`src/changes/map.ts` → `mapDiffToChangedSymbols(graph, diff, provider)`.

1. **Classify every hunk** (`classify.ts`): reduce each side's changed lines
   to their non-comment, non-whitespace characters (comment regions come
   from the real file's TypeScript AST). If old-side == new-side, the hunk
   is `non-semantic` and produces **no** symbol attribution.
2. **New side**: each code hunk's new line range is intersected with node
   *extents* (full declaration span, added to `GraphNode` this tranche).
   The **innermost** intersecting symbol wins — a change inside a method
   marks the method, not its class. Lines outside every extent attribute to
   the file node as `module-scope` — never to a sibling function.
3. **Old side**: for pure deletions, `extractDefs` (a light AST walk,
   `ast-defs.ts`) recovers symbol extents from the **old** file text.
   - innermost old def fully covered by removed lines → `deleted` tombstone
   - partially covered → the surviving same-named symbol → `modified`
   - a fully-removed local def also marks its smallest surviving enclosing
     def `modified` (deleting a `const` inside `foo` modifies `foo`)
4. **Added**: a marked symbol upgrades to `added` when its name line is in
   added lines *and* no same-named def existed in the old file.
5. **Renamed/moved**: a deleted tombstone + an `added` symbol whose
   comment-and-whitespace-normalized bodies are byte-identical → `renamed`
   with `renamedFrom` provenance. This is evidence, not a guess.
6. A local/old-def that still exists in the new file but is not a graph
   node (function-local variables are SCIP `local` symbols) is *not*
   reported as deleted — caught on real data (`esbuildPlugins` in tsup).

`module-scope` uses the file node; file nodes propagate impact over `imports`
in-edges, so a changed import/top-level statement can flag importers.

## Deleted-symbol findings — the tranche research question

| Option | Implemented | Result |
|--------|-------------|--------|
| A — index base revision, traverse base graph | yes, `--base-graph` (git worktree → scip-typescript → second graph) | `legacyToken` deleted → `mintLegacy()` correctly reported as former caller. Works, costs +1 index run |
| B — old-file AST extraction | yes, always on | Tombstone with old-range evidence; no caller info |
| C — hybrid | **recommended** | B for detection (free), A only for caller impact on deleted symbols |

Option B alone cannot name a deleted function's callers — that information
lives only in the base graph. Option A delivers it deterministically for one
extra index run (~0.8–2s measured). Recommendation: default to B (deleted
symbols listed with evidence, callers marked unknown), enable A on demand or
when deleted symbols are present. A full dual-index diff is *not* required.

## Rename findings

- **File rename**: git reports it; zero hunks → zero changed symbols. Symbol
  ids are path-keyed so the graph sees new ids, but nothing is falsely
  reported as changed.
- **Function rename/move**: provable only when normalized bodies match
  exactly (verified: `beta` moved `extra.ts`→`moved.ts` reported
  `renamed from src/extra.ts:beta`). A rename that *also* edits the body is
  reported honestly as delete+add — we do not invent identity.

## Comment/formatting behavior

Comment edits, comment add/remove on code lines, whitespace, reindentation
and reflows are all classified `non-semantic` and produce zero changed
symbols — verified by fixture commits (s9/s10) **and** real data
(tsup `rollup.ts` reflow; fast-glob doc-comment removal). Documented
limitation: whitespace inside string literals is not semantically parsed;
a `a b` → `a  b` string change classifies as non-semantic.

## Accuracy

- **Fixture repo** (`tmp/git-scenarios`): real git, 16 tagged scenario
  commits, 16 tests — all pass. Covers: single-function body, sibling
  isolation, two functions, added, deleted (+base-graph callers), signature,
  file rename, moved function, comment-only, formatting-only, disconnected
  module, multi-downstream, zero-downstream, multi-root provenance,
  import-only → module-scope, working-tree diff.
- **fast-glob** @ `9358371` (parent `99db093`, "feat: add errorFilter
  option"): Ripple found the two refactored private methods, the added
  `Settings#errorFilter` + `Options` member, the modified constructor, the
  changed import lines (module-scope), added spec-file symbols — and
  filtered the doc-comment hunk. Commit `7d65909` (deletes `suppressErrors`)
  correctly tombstoned `Settings#suppressErrors` and marked its enclosing
  class modified.
- **tsup** @ `769aa49` (parent `c654e5f`, "fix: removeNodeProtocol with
  shims"): `runEsbuild()` modified → `build()` flagged as sole downstream;
  the `rollup.ts` reflow classified non-semantic; the 134-line new test
  file → added; `assets/esm_shims.js` honestly reported "not-indexed"
  rather than silently dropped or misattributed.

## False positives (found → fixed)

1. Outer containers (`Reader`, `ErrorFilter` classes) were marked alongside
   the innermost modified method — an inverted innermost filter on both
   mapping paths. Fixed and covered by real-data output above.
2. `esbuildPlugins` (a function-local `const`) reported "deleted" because it
   isn't a graph node — fixed by checking the new file's extracted defs.

Remaining honesty notes: deleted *local* variables inside removed test cases
surface as `deleted` tombstones (accurate but noisy); added object-literal
properties in test data appear as added symbols. Neither is wrong — both are
labeled with evidence.

## False negatives

- Interface/type-literal *member* deletions are not tombstoned (extractDefs
  covers functions/classes/methods/variables); the enclosing type marks
  `modified` instead — correct direction, coarser granularity.
- Local-variable changes are attributed to the enclosing graph symbol, as
  designed.
- Inherited from T0: getter invocations, call-through-callback, external
  calls — unchanged.

## Performance

Measured end-to-end (`ripple impact --base`):

| stage | fixture repo | fast-glob (86 files) | tsup (750 nodes) |
|-------|--------------|----------------------|------------------|
| git diff | ~125 ms | ~173 ms | ~127 ms |
| SCIP index | ~840 ms | ~1.85 s | ~1.7 s |
| range→symbol map | ~90 ms | ~281 ms | ~188 ms |
| impact traverse | <1 ms | ~2 ms | <1 ms |
| base-graph (opt) | ~830 ms | — | — |

SCIP indexing remains ~85% of wall time — unchanged bottleneck from T0.
Mapping is comfortably cheap even on real repos.

## Incremental-indexing findings

- scip-typescript has **no incremental mode**: it builds a full TS program
  per project, so per-file re-indexing is not available. A `--no-global-caches`
  flag exists for multi-project dedup only.
- What *is* incrementally available:
  - **Index artifact caching** keyed by content: a committed base revision
    needs indexing once per commit SHA (immutable cache key); the worktree
    index can be keyed by a hash of tracked source contents.
  - **Changed-file gating**: the diff already tells us which files changed;
    if none are indexed code files, the cached graph can be reused as-is
    (index.scip is a per-document format — documents could in principle be
    spliced, but symbol resolution still needs a full typecheck, so splicing
    buys little).
  - **AST enrichment** is per-file and embarrassingly incremental once the
    graph is persisted.
- Recommended for a later tranche: content-hash index cache +
  diff-gated reuse. Do not build document-level index splicing.

## Recommended Tranche 1 architecture

1. Persist the graph + index keyed by content hash (cheap cache layer);
   gate re-indexing on "did any indexed file change".
2. Materialize `--base-graph` automatically when deleted symbols exist
   (it's the only way to give them downstream impact).
3. Multi-root provenance is in place — surface per-root paths in any UI.
4. Suppress or group `deleted`-local tombstones under their enclosing
   function for readability.
5. Optionally upgrade `references`-tier reporting for module-scope changes
   (importers currently propagate via `imports` — correct but wide).

## Verdict

**GO**

Diff → changed symbols → impact works end-to-end on real git history and
two real repositories, with per-symbol granularity, sibling isolation,
honest tombstones, comment/formatting filtering, multi-root provenance, and
inspectable evidence at both layers (WHY CHANGED + WHY AFFECTED). The
architecture needed no redesign — the additions (git adapter, mapper,
provenance) sit cleanly beside the T0 pipeline. The dominant cost is still
SCIP indexing, which is exactly what the incremental-caching recommendation
addresses next.
