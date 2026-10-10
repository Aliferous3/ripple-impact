# Ripple Multi-Language Architecture

Status: foundation landed in Tranche 6A (internal). TypeScript/JavaScript
remains the only production language. No second language ships yet.

## 1. v0.1 indexing path (pre-refactor)

`getRippleGraph` / `getGraphForRevision` in `src/cache/graph.ts` called the
SCIP indexer directly: `scip-typescript index` produced `index.scip`, a
converter normalized it into a `RippleGraph`, and a TypeScript compiler-API
pass enriched it (call-site classification, `jsx_uses`, `type_depends`).
File extensions, `tsconfig.json` discovery, and test-file rules were
hardcoded in `src/cli/preflight.ts`, `src/server/watch.ts`, and
`src/changes/pipeline.ts`.

## 2. Adapter boundary

`src/indexers/adapter.ts` evolves the existing `Indexer` interface into
`LanguageAdapter`:

```ts
interface LanguageAdapter {
  readonly id: string;                    // e.g. "typescript-javascript"
  readonly languages: readonly string[];  // e.g. ["typescript","javascript"]
  readonly capabilities: LanguageCapabilities;
  matchesSourceFile(repoRelPath): boolean;
  isTestFile(repoRelPath): boolean;
  index(options: IndexOptions): Promise<RippleGraph>;
}
```

Detection is a separate pure function (`detectTypescript` etc.) returning
`DetectedProject[]`, so adapters never scan the repo themselves.

## 3. Adapter detection

`detectProjects(repoRoot)` in `src/indexers/registry.ts` walks the registry
and collects every adapter hit. A repository may yield zero, one, or many
projects. Detection is evidence-based: today, a `tsconfig.json` /
`jsconfig.json` at the root (or TS/JS sources under `src/`).

## 4. DetectedProject

```ts
interface DetectedProject {
  adapterId: string;
  root: string;              // repo-relative project root ("" today)
  languages: readonly string[];
  configEvidence: string[];  // e.g. ["tsconfig.json"]
  capabilities: LanguageCapabilities;
}
```

Multi-project monorepos are representable now; only the TS/JS adapter
actually detects and runs.

## 5. Capability model

`LanguageCapabilities` declares which normalized edge kinds an adapter can
prove: `definitions`, `references`, `calls`, `types`, `inheritance`,
`implementations`, `tests`, `jsx`. Adapters must not emit edge kinds they
cannot back with evidence; consumers treat absent capabilities as "not
proven", never as "proven absent" where the indexer cannot see.

## 6. Normalized graph contract

`RippleGraph` is the semantic boundary. Impact traversal, changed-symbol
mapping, deleted-symbol tombstones, and `AnalysisResult` consume only
normalized nodes/edges/evidence — they do not know which language produced
them. Language-specific facts live in node provenance and evidence
`detail` strings, not in new edge semantics.

## 7. Symbol identity / provenance

`GraphNode.provenance` (`src/graph/types.ts`) records `{ adapterId, root,
languages }` at index time. SCIP symbol IDs remain the canonical identity
and are globally unique per index root; provenance makes collisions
impossible even if two future indexers coin similar readable names
(`User.save` in TS vs Python stays two distinct nodes).

## 8. Graph-fragment merging

`mergeGraphs(fragments)` in `src/graph/merge.ts` deterministically unions
node maps and dedupes edges by
`kind|from|to|file|range|source|detail`. Merge order is sorted by project
root then adapter id, so output is independent of detection order. Edges
never cross fragments unless an explicit bridge edge was authored into a
fragment — merging does not synthesize edges.

## 9. Cache isolation

`src/cache/fingerprint.ts` hashes: adapter plan (adapter ids, roots,
languages, per-adapter config evidence), adapter/indexer versions, graph
schema version, and the adapter-relevant source/config file set.
`src/graph/serialize.ts` bumped `GRAPH_SCHEMA_VERSION` to `4`; persisted
schema-3 caches miss cleanly and rebuild. Two adapters can never share a
cache entry because the plan is part of the fingerprint.

## 10. Watcher invalidation

`src/server/watch.ts` asks the detected plan for `matchesSourceFile` /
config filenames instead of hardcoding `.ts/.tsx/.js/...`. For TS/JS the
predicate is equivalent to the old list; future adapters expose their own
source patterns, config files, and ignore rules.

## 11. Evidence invariants

Every edge keeps repo-relative file + range + `source`
(`"scip" | "typescript-ast"`) + `detail`. Merging preserves evidence
verbatim. A future adapter must supply the same evidence shape; textual or
regex-derived edges are not admissible as semantic edges.

## 12. Universal vs language-specific edges

Universal: `calls`, `type_depends`, `implements`, `references` (weak,
non-propagating). Family-specific: `jsx_uses` (TS/JS adapter only).
Traversal treats all propagating kinds uniformly; adapters opt in via
capabilities.

## 13. Unsupported-language behavior

`detectProjects` returning `[]` fails honestly in preflight
("no supported sources found") — the same user-facing error as v0.1 for a
repo with no TS/JS sources. A pure-Python repo is declined, never
regex-analyzed.

## 14. Cross-language bridges

Deliberately out of scope. Future bridges (OpenAPI, GraphQL, protobuf,
generated SDKs) must provide explicit evidence edges authored by a bridge
adapter. No edge is inferred from name similarity. `NO EDGE > INVENTED
EDGE` — validated by the fake-adapter bridge test: cross-language
propagation occurs only through an explicit authored edge.

## 15. Why regex inference is rejected

Ripple's trust model requires proof per edge. Regex matching emits edges
without call-site/type/semantic evidence, which would silently contaminate
runtime impact — exactly the failure class the tool exists to prevent.

## 16. Public AnalysisResult compatibility

Unchanged. `changed`, `runtime` (direct/transitive), `type`, `tests`,
`references`, `deleted`, `warnings` are byte-for-byte identical for TS/JS
repos versus released v0.1.0 — verified by the parity harness.

## 17. TypeScript adapter parity

`tmp/multilang-parity/run-parity.cjs` ran the released `0.1.0` tarball
(oracle) and this branch over 20 fixtures: all 17 git-scenario pairs,
JSX/type/delete, JS-only project, and outside-index-scope tests. 20/20
semantically identical (timings, cache metadata, and per-run temp-worktree
paths in deleted-symbol ids normalized).

## 18. Tranche 6B — Python adapter acceptance criteria

A Python adapter must:

- implement `LanguageAdapter` against `src/indexers/adapter.ts` unchanged;
- use a verified semantic indexer (scip-python or equivalent) — never
  regex;
- return a `DetectedProject` from a registered `detect` function
  (pyproject.toml / setup.cfg / requirements.txt evidence);
- emit provenance-stamped `RippleGraph` fragments that merge through
  `mergeGraphs` without core changes;
- declare honest capabilities (no `jsx`, no `types` if unprovable);
- supply Python test-file rules for `isTestFile`;
- produce `calls`/`references` edges with file+range evidence;
- reuse base-graph/tombstone machinery for deletions unmodified;
- add watcher patterns through the adapter predicates;
- pass a stable-parity harness equivalent (Python fixture analyzed by the
  Python adapter twice must be deterministic; TS fixtures must remain
  untouched).

Impact traversal, Design #33, the Git diff engine, and the deleted-symbol
model must not be modified to land Python.
