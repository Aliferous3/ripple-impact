# Tranche 1 — Production Local Analysis Core

## Goal

Turn the Tranche 0/0.5 prototype into a persistent, reusable local analysis
layer: deterministic content-addressed caching, a versioned normalized-graph
artifact, automatic base-graph handling for deletions, structured warnings,
a stable CLI, and machine-readable output — with no loss of the
evidence guarantees.

Final pipeline:

```text
Repository
  → repository fingerprint (content hash)
  → .ripple/cache/<key>/ { index.scip, graph.json, metadata.json }
  → normalized Ripple graph (schemaVersion 1)
  → git diff → changed ranges → changed symbols
  → automatic base graph (commit-SHA key) when deletions need it
  → impact engine → evidence-backed affected-symbol paths
  → analyzeRepository() → AnalysisResult (CLI text or --json)
```

## Cache design

Repository-local, content-addressed:

```text
<repo>/.ripple/cache/<fingerprint>/
  index.scip      raw SCIP index artifact
  graph.json      normalized Ripple graph, schemaVersion 1
  metadata.json   fingerprint, schemaVersion, scip-typescript version,
                  repo root, file count, createdAt, revision provenance
```

All writes are temp-file + `renameSync` — a killed or concurrent writer can
never leave a torn entry (no lock manager; last writer wins atomically).
Reads validate metadata fingerprint, schemaVersion, `index.scip` presence,
and `graph.json` integrity; any failure is a **miss → rebuild**, never a
crash and never trusted data.

`.ripple/` is Ripple-owned state. `mapDiffToChangedSymbols` skips `.ripple/`
paths outright so cache writes can never feed back into a diff. The CLI
warns `consider adding .ripple/ to .gitignore` when it isn't ignored;
Ripple never edits `.gitignore` itself. `ripple cache clear` removes only
`<repo>/.ripple`.

### Cache-key inputs

`repoFingerprint(root)` = sha256 over:

| input | why |
|---|---|
| every indexable source file's path + content hash (.ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs, excluding node_modules/.git/.ripple/dist/out/coverage/build/.next/.turbo/.cache) | source content is what the index/graph describe — uncommitted edits must invalidate |
| `tsconfig*`/`jsconfig*`/`package.json`/lockfiles (npm/pnpm/yarn/bun) at any depth | compiler config and dependency resolution change symbol binding |
| installed scip-typescript version | different indexer, different graph |
| `GRAPH_SCHEMA_VERSION` | artifacts from an incompatible schema are never read |

Content hashing — not `git HEAD`, not mtimes: dirty worktrees, partial
staging and non-git directories all work, while checkouts of identical
content reuse the cache. A README edit does **not** invalidate (verified).

`commitFingerprint(sha)` = sha256 over schema version + scip-typescript
version + commit SHA. Commit objects are immutable, so a base graph is
computed at most once per commit, ever.

## Normalized graph artifact

`graph.json` = `{ schemaVersion: 1, root, nodes[], edges[] }` — every node
carries id/kind/name/file/range/extent; every edge carries
from/to/kind/confidence/`evidence[]` (file, range, source, detail).
`validateGraphArtifact()` enforces the shape; `graphFromData` rebuilds
indexes. Roundtrip test proves a deserialized graph yields byte-identical
impact results (same direct/transitive node-id sets).

## Automatic base graph

Trigger condition: the change set contains at least one `deleted`-kind
tombstone (a top-level def that existed at `oldRev` and is gone now).
Then `getGraphForRevision(repo, diff.oldRev)`:

1. resolves `oldRev` → SHA, computes `commitFingerprint(sha)`;
2. cache hit → deserialize and return (typically ~40–60 ms);
3. miss → `git worktree add --detach <tmpdir> <sha>`, run scip-typescript
   there, store under the commit key, leave the worktree for the caller
   to clean up.

The user's working tree is **never** touched — no checkout, stash, or
write. A test hashes every tracked file and snapshots `git status` before
and after a deletion-analysis run on a dirty worktree: byte-identical.
If the base build fails, `BASE_GRAPH_UNAVAILABLE` warnings are emitted and
the tombstones are reported with `resolved: false` — honest degradation,
not silent guessing. When the base graph loads but the symbol can't be
found in it, `DELETED_SYMBOL_APPROXIMATED` is emitted.

## Deleted-local attribution

Rule (deterministic, AST-verified on the old file text):

- A def nested inside a function/method/arrow body (`topLevel === false`)
  is **never** a tombstone — locals aren't graph-addressable. Its removal
  marks the smallest surviving enclosing def `modified` (old-side extent
  analysis), or falls back to module scope if nothing survives.
- A top-level def whose enclosing def is also deleted collapses into the
  parent's tombstone (no double-reporting).
- Remaining top-level defs keep real tombstones (`changeKind: "deleted"`,
  node absent) and participate in automatic base-graph caller resolution.

Symmetrically on the new side: scip-typescript encodes block-scoped and
destructured locals as `name:` descriptors (`variable` kind). They are now
excluded from innermost-extent attribution and from added-file marking —
a new 134-line test file yields `test/shims.test.ts (module scope) added`,
not two dozen `index0:`/`name0:` pseudo-symbols.

## Application-level API

`src/api/analyze.ts` — presentation-free:

- `analyzeRepository({ repo, base? }) → AnalysisResult`
- `analyzeSymbol({ repo, symbol })` — resolves `name` or `file::name`;
  ambiguous names return `{ ok: false, candidates[] }` with
  `file::symbol()` selectors instead of silently picking one.

## CLI

```text
ripple analyze  [--root d]               build/reuse cached graph + cache status
ripple impact   [--root d] [--base ref] [--json]
ripple impact   <symbol> [--root d] [--in f] [--json]
ripple changed  [--root d] [--base ref] [--json]
ripple inspect  <symbol|file::symbol> [--root d]
ripple cache status|clear [--root d]
ripple dump     [--root d]
```

`--base-graph` is gone — base graphs are automatic. `index` remains as a
back-compat alias for `analyze`.

## JSON schema (schemaVersion 1)

`AnalysisResult`:

```text
schemaVersion: 1
repo:    { root, fingerprint }
comparison: { oldRev, newRev, base? }
changed: [{ id?, name, kind, file, changeKind, renamedFrom?, evidence[] }]
direct / transitive: [{ id, name, kind, file, range, depth,
                       roots[], paths[{ root, nodes[], edges[{from,to,kind,evidence[]}] }] }]
deleted: [{ name, file, formerCallers[], resolved }]
referencing: [{ name, kind, file, edgeKind }]     # references-only, not affected
tests:  [{ file, via[{ symbol, edgeKind }] }]
nonSemantic / unmappedFiles / renamedFiles
warnings: [{ code, message, file?, symbol? }]
timings: { gitDiffMs, fingerprintMs, indexMs, mapMs, traverseMs, baseIndexMs?, totalMs }
cache:  { index: hit|miss, graph: hit|miss,
          baseGraph: hit|miss|not-required, enrichedFiles, missReason? }
```

## Warning types

`NOT_INDEXED` (changed file outside the graph), `BINARY_SKIPPED`,
`BASE_GRAPH_UNAVAILABLE`, `DELETED_SYMBOL_APPROXIMATED`,
`AMBIGUOUS_SYMBOL` (reserved — ambiguity currently returns a candidate
list rather than a warning). All structured `{code,message,file?,symbol?}`,
present in both CLI output and JSON.

## Performance (measured, this machine)

| repo | files | cold total | warm total | index cold→warm | base cold→warm |
|---|---|---|---|---|---|
| git-scenarios | 12 | 2,441 ms | 595 ms | 882→2 ms | 1,044→41 ms |
| fast-glob | 86 | 4,683 ms | 581 ms | 2,062→15 ms | 2,164→57 ms |
| tsup | 46 | 2,164 ms | 318 ms | 1,803→5 ms | n/a |
| zod | 477 | 35,521 ms | 754 ms | 34,982→271 ms | n/a |

Fingerprint: 5–61 ms. Mapping: ~180–390 ms. Traversal: 0–24 ms.
RSS 158–535 MB (scip dominates on cold runs). Warm analysis is
**~5–47× faster** end-to-end; the remaining warm cost is git diff +
fingerprint + AST re-parse during mapping, all sub-second.

vs Tranche 0.5 baseline: SCIP indexing still dominates cold runs
(~85–99%); caching removes it entirely on warm runs, which is exactly
what T0.5's incremental-indexing research predicted (artifact caching
keyed by content/commit hash beats per-file SCIP incrementalism, which
scip-typescript does not support).

## Corruption / concurrency behavior

Tested: truncated `graph.json`, invalid JSON, wrong `schemaVersion`
in metadata, missing `metadata.json`, missing `index.scip` — all detected
as a miss (with reason), rebuilt, and the next run hits cleanly. Two
parallel cold `getGraphForRepo` calls both complete; the surviving entry
is complete and valid; no temp files remain.

## Real-repository findings

- **fast-glob** `9358371..7d65909` (suppressErrors→errorFilter deletion
  commit): `Settings#suppressErrors` tombstone + enclosing class +
  constructor marked; former callers resolved automatically through the
  base graph (`getEntryFilterInstance`, `glob`, e2e suites). Dirty-tree
  probe edit → cache miss → `rippleProbe` detected as `added`, everything
  else reused.
- **tsup** `c654e5f..769aa49`: `runEsbuild()` → sole caller `build()`;
  `rollup.ts` reformat filtered as non-semantic; new `shims.test.ts` is
  now a single module-scope addition (locals suppressed);
  `assets/esm_shims.js` honestly `NOT_INDEXED`.
- **zod** `004d800c..0b216ef` (477 files): `json()` record fix mapped to
  `$ZodRecordInternals` modified + `#input`/`#output` members added —
  exactly the PR's change. No `calls` edges downstream → impact empty and
  the three referencing interfaces (`$ZodRecord`, `ZodRecord`,
  `ZodMiniRecord`) shown as references-only, not affected. Correct.

## Known limitations

- Type-level changes (interfaces, type aliases) have no `calls` edges —
  they surface as `referencing` nodes, not impacted nodes. Type-dependents
  would need type-graph edges (Tranche 2+ decision).
- Module-scope unexported `const` whose SCIP id uses the `:` local
  descriptor attributes at module scope rather than itself.
- A deleted local whose enclosing def is also deleted produces no visible
  attribution beyond the parent's tombstone (by design).
- Cold-run SCIP indexing is still the dominant cost; per-commit base
  graphs amortize it forever, but the first look at any revision is cold.
- Whitespace inside string literals can still evade the comment/format
  filter (carried from T0.5).

## Recommended Tranche 2

The visual explorer should consume `analyzeRepository()`/`analyzeSymbol()`
directly — no CLI parsing. It gets: stable node ids, per-root provenance
paths with edge evidence, structured warnings, cache state, and timings.
Suggested additions: (a) emit the full graph as data for the canvas;
(b) type-dependency edges if "my interface changed" queries matter;
(c) watch mode = fingerprint polling → invalidate → re-diff.

## Verdict

**GO.** All acceptance criteria met: deterministic content-addressed
caching with documented key inputs, versioned persistable graph with
safe corruption handling, automatic isolated base graphs, more precise
deleted-local attribution, app-level API + stable JSON contract, CLI
contract with ambiguity refusal, structured warnings, observable cache
behavior, safe concurrent writes, all 58 prior tests green + 18 new
Tranche 1 tests, cold/warm measured on three real repositories.
