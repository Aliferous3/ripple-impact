# Ripple — Tranche 0 Findings

Technical spike: can a deterministic, evidence-bearing change-impact engine for
TypeScript/JavaScript be built on `scip-typescript` + SCIP?

Environment: Windows, Node.js v24.18.0 (project targets >=22; 24 was the
installed LTS — no Node-22-specific features are used), TypeScript 5.9,
`@sourcegraph/scip-typescript` 0.4.0, vitest.

## Goal

Prove or disprove the pipeline:

```
TS repo → scip-typescript → SCIP index → Ripple adapter → Ripple graph
       → changed symbol → reverse impact traversal → affected symbols + evidence
```

and answer whether SCIP alone provides function-level **CALLS** edges or whether
deterministic enrichment is required.

## What was built

```
src/
  indexers/
    indexer.ts                   Indexer interface (root/indexPath -> RippleGraph)
    scip/symbol.ts               SCIP symbol-string parser (kind/name/filePath)
    scip/scip-indexer.ts         index.scip -> RippleGraph (defs, refs, imports,
                                 contains, implements)
    enrich/call-classifier.ts    syntactic AST pass: is a reference a call callee?
  graph/types.ts, graph.ts       Ripple-owned node/edge model + adjacency indexes
  impact/traverse.ts             reverse BFS over calls/implements (cycle-safe,
                                 interface-dispatch widening)
  impact/explain.ts              human-readable evidence-path rendering
  cli/index.ts                   ripple index|impact|inspect|dump
fixtures/                        12 fixture projects (see tests)
tests/                           38 assertions: positive + negative + evidence
docs/TRANCHE-0-FINDINGS.md
```

Every edge carries `evidence[]` entries `{file, range, source, detail}` where
`source` = which subsystem asserted the edge (`scip` or `typescript-ast`).

## SCIP findings (empirical, from generated indexes)

A real `index.scip` was generated for every fixture and for fast-glob and was
decoded with the protobuf bindings vendored inside `scip-typescript`
(`dist/src/scip.js`, protoc-gen-ts/google-protobuf).

What scip-typescript 0.4.0 actually emits:

| Capability | Present? | Notes |
|---|---|---|
| Symbol strings | yes | `scip-typescript npm <pkg> <ver> <path>/<desc>` — stable, package-qualified |
| Definitions | yes | `symbol_roles & Definition`; range = name identifier |
| Full decl extent | yes | `enclosing_range` on **definition** occurrences = whole declaration incl. body |
| References | yes | occurrences with **no** role bits; symbols fully resolved incl. aliases |
| Enclosing symbol | derivable | `enclosing_symbol` field exists but is NOT populated; attribution must be computed by `enclosing_range` containment |
| Source ranges | yes | 0-based `[line, char, endLine?, endChar]` |
| Symbol kind | partial | `SymbolInformation.kind` is always `UnspecifiedKind`; `documentation` carries TS hover text (`"function f(...)"`, `"interface X"`) usable as a kind signal; otherwise parse the descriptor suffix |
| display_name | no | empty; derive from symbol string |
| Implementations | yes | `SymbolInformation.relationships` with `is_implementation` for classes vs superclasses/interfaces and methods vs overridden members |
| Module/file symbols | yes | every doc emits a `...`file.ts`/` definition + references to it at each import-string literal |
| Alias/re-export/barrel de-resolution | yes | use-site occurrences resolve to the *underlying* definition symbol through `import {x as y}`, `export {x} from`, and `export *` barrels |
| Occurrence roles beyond Definition | **no** | `Import`, `ReadAccess`, `WriteAccess`, `Test`, `ForwardDefinition` are never set by the indexer |
| syntax_kind | no | never emitted |
| "A calls B" | **no** | call sites are plain unmarked references — indistinguishable from type refs, import specifiers, or function-as-value |

Also observed: `local N` symbols for locals (we skip them — calls inside
anonymous closures attribute to the enclosing named symbol), and occurrences to
external package symbols (e.g. `typescript 5.9.3 lib/`lib.es5.d.ts`/...`) which
we drop because they are outside the indexed package.

## Call-graph findings

**SCIP alone cannot produce `calls` edges.** A call `f()`, a type annotation
`: F`, an import specifier `{ f }`, and `run(f)` all produce identical
`roles=(none)` occurrences. Verified by reading the index and by reading
`FileIndexer.ts` (only `SymbolRole.Definition` is ever set).

**The smallest sufficient enrichment is a syntactic pass, not a type-checker
pass.** SCIP has already solved symbol identity (the hard part: aliases,
re-exports, barrels, method targets). What remains is purely positional: is the
identifier at this range the *callee* of a `CallExpression`/`NewExpression`/
`TaggedTemplateExpression`? We walk each file with `ts.createSourceFile`
(parser only — no `ts.Program`, no checker), collect callee-name ranges
(identifier / `PropertyAccessExpression.name` / literal element access), and
upgrade matching SCIP reference occurrences to `calls` edges. Everything else
stays `references`. This preserves the trust rule that different relationships
stay different — `run(loadSession)` produces a `references` edge, never `calls`.

Interface dispatch is handled in traversal, not indexing: SCIP resolves
`refresher.refresh()` (typed `Refresher`) to `Refresher#refresh`, so callers
would be missed when the *implementer* `Session#refresh` changes. Since we have
`implements` edges, the traversal deterministically widens: predecessors of X
include callers of every symbol X implements. Verified by fixture.

## Accuracy findings (all asserted in tests — 38 pass)

Worked:
- linear chain A→B→C; direct vs transitive tiers; depth + path evidence
- disconnected graphs — **no leakage** (explicit negative assertions)
- cycles A→B→C→A — terminate, no duplicates
- aliased import `import { foo as bar }` — resolves to `foo`
- re-export `export { foo } from` — resolves to the underlying symbol
- barrel `index.ts` — resolves to the real file's symbol
- class method call `session.refresh()` — resolves to `Session#refresh()`
- `new C()` — `calls` edge to `C#<constructor>()` (or `C#` when no ctor declared)
- `await f()` — normal `calls` edge
- `obj.method()` / `ns.x.y()` / `obj["m"]()` / tagged templates
- interface `implements` relationships and interface-dispatch impact
- `.js` files calling `.ts` functions (via `allowJs` — same pipeline)
- tests: spec/test files that call or reference affected symbols are listed,
  labeled as *reachability*, not coverage

## Limitations (verified or structural)

1. **Function-as-value**: `run(loadSession)` → `references` only. Correct by
   design — we do not claim a call we cannot prove. Reported under a separate
   "referencing" tier. (If `run`'s implementation is also indexed, the chain
   `run` → `fn()` is an indirect call that static analysis cannot attribute —
   documented, not hidden.)
2. **Getters/setters**: `obj.prop` invokes code without call syntax → stays
   `references`. A known false-negative class for property-access side effects.
3. **Value aliases**: `const escape = cond ? a : b` → `references`, not `calls`
   to both. Dynamic dispatch by assignment is out of scope for calls edges.
4. **External symbols**: calls into `node_modules`/lib.d.ts are not graphed —
   edges only exist to symbols defined in the indexed package.
5. **Anonymous closures**: calls inside `map(x => f(x))` attribute to the
   enclosing named function (or file for module-top-level callbacks). Real
   calls, coarser attribution.
6. **tsconfig drives coverage**: scip-typescript only indexes files in the
   project's tsconfig. execa's root tsconfig is `files: [index.d.ts]` → a
   3.6 KB index covering almost nothing. Repos need a source-covering tsconfig
   (or `--infer-tsconfig`).
7. **No cross-repo/package graph**: package-qualified symbols make this
   feasible later, but this tranche intentionally scopes to one package.
8. `Occurrence.symbol_roles` ignores `Test`/`Import` — test detection is a
   path-convention in Ripple (`*.test.*`, `*.spec.*`, `tests/`, `__tests__/`),
   not SCIP-derived.

## False positives

None observed. Manual audit: 11/11 sampled `calls` edges on fast-glob were
genuine call sites at the exact cited range (constructors, private `#method()`
calls, namespace-alias calls, calls inside arrow callbacks). On fixtures, the
adversarial cases produce *no* calls edges where none exist (callback, unused
import, disconnected components).

Note: `references` edges are emitted freely and are honest — they claim only
"this code mentions that symbol at this range". They are excluded from impact
traversal and reported in a separate tier.

## False negatives

Confirmed/known: getters/setters invoked as property access; functions reached
only through being passed as values (by design); calls to external symbols;
call sites whose callee is a non-named expression (`(getFn())()` — the *outer*
call has no stable callee symbol; inner refs still exist); `obj[dynamicKey]()`.

One found-then-fixed during the spike: interface-typed callers missed on
implementer changes — fixed via the `implements`-widening traversal described
above (covered by a fixture test).

## Performance

| Step | fixtures (each, ~2–8 files) | fast-glob (86 TS files) |
|---|---|---|
| scip-typescript index | ~0.8 s | ~1.2–1.8 s (subprocess incl. node boot) |
| index size | ~3–12 KB | 1.4 MB |
| Ripple graph build | <10 ms | ~190 ms |
| graph size | ~20 nodes / ~50 edges | 1,748 nodes / 3,715 edges (contains 1,662, references 1,169, calls 571, imports 273, implements 40) |
| memory | — | indexer RSS ≈130 MB; graph build heap ≈50 MB |
| impact query | <1 ms | <10 ms |

Bottleneck is index generation (full type-check); everything downstream is
trivially cheap at this scale.

## Real-repository validation

- **Repo**: `mrmlnc/fast-glob` @ `2e04f6e` (cloned shallow, deps installed)
- **Indexed**: 86 `src/**/*.ts` documents (includes real `*.spec.ts`/`*.e2e.ts`
  tests — exercised the test-mapping path on real tests)
- Spot checks:
  - `isDynamicPattern` change → correctly fans out to `isStaticPattern`,
    `Matcher#getPatternSegments`, task generation, the public `glob*` wrappers,
    spec files, e2e runners and benchmarks. That is a true reflection of
    fast-glob's coupling, not over-reporting.
  - `Provider#read` (abstract) → all 3 implementers + `TestProvider` flagged
    via `implements`; their callers flagged transitively.
  - `escapePosixPath` → 2 real callers; `src/index.ts`'s
    `withPatternsInputAssert(utils.path.escapePosixPath)` (function-as-value)
    and `const escape = … : escapePosixPath` correctly classified as
    `references`, not `calls`.
  - Grep-vs-graph recall spot check on `convertToPositivePattern`: exactly the
    two real call sites, no more.

## Recommended architecture for Ripple v0.1

**SCIP + a thin syntactic AST enrichment — not SCIP-only, not AST-only.**

```
scip-typescript (or lsif.coverage of other languages later)
      │  symbols, definitions, enclosing extents, resolved references,
      │  module refs, implements relationships — all canonical SCIP symbols
      ▼
Ripple SCIP adapter ──► nodes, contains, references, imports, implements
      │
      ▼
per-file syntactic pass (ts.createSourceFile, no checker)
      └─► upgrades callee-range occurrences to `calls` edges
      ▼
RippleGraph ──► impact traversal (calls + implements, dispatch-widened)
```

Reasons:
- SCIP is doing real work we should not reimplement: canonical symbol identity,
  alias/re-export/barrel resolution, implements extraction, `enclosing_range`
  extents. An AST-only checker approach would rebuild all of that.
- The missing piece (call-vs-reference) is *syntactic*, so the enrichment stays
  tiny, deterministic, fast, and testable in isolation.
- SCIP stays behind the adapter: no SCIP types leak into `graph/`, `impact/`,
  or the CLI — the engine sees only `RippleGraph`. A future non-SCIP indexer
  (tree-sitter, go-to-…) can feed the same graph.
- For other languages later, each language needs its own small "what is a call
  site" classifier — the SCIP layer stays shared.

## Go / No-Go

**GO — with a documented architectural decision** (between GO and
GO-WITH-ARCHITECTURAL-CHANGE): the approach is trustworthy for
function/method-level change impact on TypeScript/JavaScript, but the pipeline
is necessarily **SCIP + syntactic enrichment**, not SCIP alone. That decision
was the core question of this tranche and is now settled empirically.

## Suggested Tranche 0.5 scope (not started)

- Diff-to-symbol mapping: turn a git diff into a set of changed symbols (edge
  case: added/removed symbols, renamed functions).
- Optional type-checker enrichment behind a flag for getter/setter invocation
  and function-value flow (`run(loadSession)` → indirect call).
- Index caching/incremental re-index by file mtime.
- Fixture coverage for `.tsx`/decorators/overloads; a second, messier real repo
  (one with heavier inheritance or barrels).
