# Pre-Beta Targeted Fixes

Fixes for defects confirmed by the Dev Ledger dogfooding audit
(`docs/DOGFOOD-DEV-LEDGER.md`, baseline commit `19e8459`, Ripple `0.1.0`).
This tranche fixed confirmed defects only — no new features.

## FN-2 — String-literal whitespace misclassified as non-semantic (P0)

### BEFORE

`classifyHunk` stripped comments and then removed all whitespace before
comparing lines. A change like `` `$ git log` `` → `` `$  git log` `` —
a real output change — normalized to identical text and was classified
non-semantic, producing `Changed: 0` (T16 FAIL).

### AFTER

Whitespace inside string and template literals is preserved during
normalization, while whitespace/comments outside literals are still
ignored. The same edit now yields `Changed: 1`, `gitLogCommand()`
modified, with correct downstream propagation.

### IMPLEMENTATION

`src/changes/ast-defs.ts` gains `literalRanges()`: TypeScript AST ranges
for string literals, no-substitution templates, and template *text chunks*
(interior `${expr}` whitespace stays ordinary code whitespace). Escapes,
multiline templates, and string-like syntax inside comments are handled
because ranges come from the AST, not regexes. `classify.ts` `codeChars`
and `normalizeBody` skip whitespace removal inside literal ranges.
Graph fingerprint/schema unaffected — classification is per-diff, not
cached.

### TESTS

`tests/classify.test.ts` — 10 positive/negative cases: literal whitespace
(single/double-quoted, escaped, template, multiline template), comments
containing string-like syntax, comment-only edits, reflow, trailing
whitespace, missing-text fallback, and a guard that ordinary
reindentation is still non-semantic.

### REAL-REPO VALIDATION

Dev Ledger T16: `` `$ git log` `` → `` `$  git log` `` in `shareModel.ts`
now reports `gitLogCommand()` changed with 6 runtime-affected downstream.
Dev Ledger T14/T15 (comment-only, formatting-only) still report
`Changed: 0`.

### REMAINING LIMITATION

None known for line-level hunks. A hunk that changes whitespace inside
a literal *and* removes/renames surrounding code still classifies as
semantic — conservatively correct.

## FN-1 — JSX component boundary missed runtime propagation (P1)

### BEFORE

`<ShareModal ... />` was recorded as a plain `references` edge. Changing
`fmtHumanDate` reached `ShareModal` via calls but stopped there — `App`,
`Gate`, `Root`, `main.tsx` were never flagged runtime-affected even
though they render the component (T06 false negative).

### AFTER

JSX component usages produce a dedicated `jsx_uses` edge with
typescript-ast evidence, and `jsx_uses` participates in runtime impact
traversal. The Dev Ledger `fmtHumanDate` chain now reads:

```
fmtHumanDate → fmtHumanRange → {ShareCard, ShareModal} (calls)
  → App (jsx_uses @ App.tsx:182) → Gate (jsx_uses @ main.tsx:149)
  → Root (jsx_uses @ main.tsx:170) → main.tsx (jsx_uses @ main.tsx:196)
```

### IMPLEMENTATION

`EdgeKind` gains `jsx_uses` (graph schema 2 → 3; old cached graphs are
rejected and rebuilt). `call-classifier.ts` collects JSX tag ranges:
identifier tags only when capitalized, member tags (`<UI.Button/>`) by
their member name only — intrinsics (`<div>`), lowercase member tags
(`<motion.div>`), and namespaced tags (`<a:b>`) are excluded at the AST
level. An edge is created only when a SCIP occurrence resolves the tag
name to an indexed symbol — no heuristics. Enrichment cache serializes
`jsxTagRanges`. `traverse.ts` treats `jsx_uses` as runtime-impacting;
`directCallers` counts it.

### TESTS

`tests/jsx.test.ts` — 8 cases on a dedicated `fixtures/jsx` repo:
`<Foo/>` self-closing and `<Foo></Foo>` pair both edge, imported alias
resolves, `<UI.Button/>` resolves through the member name, intrinsics
produce no edges, edge kind/evidence shape verified, runtime traversal
through JSX verified.

### REAL-REPO VALIDATION

- **Dev Ledger:** `fmtHumanDate` → 7 runtime-affected including `App()`
  with `jsx_uses @ App.tsx:182` evidence (`<ShareModal record={...}>`).
- **sonner** (`emilkowalski/sonner`): exactly 2 `jsx_uses` edges —
  `Toast→Loader` (cross-file, `index.tsx:262`) and `index.tsx→Toast`
  (`index.tsx:862`). Editing `Loader` propagates to `Toast` then
  `index.tsx`. Zero intrinsic edges.
- **vaul** (`emilkowalski/vaul`): exactly 1 `jsx_uses` edge —
  `NestedRoot()→Root()` (`index.tsx:1105`). External member JSX
  (`<DialogPrimitive.Root/Overlay/Content/Portal>`) and
  `<DrawerContext.Provider>` produced no edges — SCIP does not resolve
  them to local component symbols, so nothing is guessed. Editing `Root`
  propagates to `NestedRoot`.

No false positives observed in either external repo; edge counts are
minimal rather than explosive.

### REMAINING LIMITATION

JSX inside `React.forwardRef`/`memo` callbacks can attribute to the
enclosing module/file node rather than the named component (sonner's
`Toaster`) — the file node still propagates correctly, but the reported
hop is coarser. Member JSX (`<Ctx.Provider>`, `<DialogPrimitive.X>`)
produces an edge only where SCIP resolves the member — otherwise none.
Both are conservative boundaries, not heuristics.

## FN-3 — Test files outside index scope reported silently (P1)

### BEFORE

All 35 Dev Ledger tests live in `test/*.test.mjs`, outside tsconfig
`include`. The graph contained zero test nodes, so `Relevant tests: 0`
was printed with no hint that tests exist (T11 blind spot).

### AFTER

```
TEST_FILES_OUTSIDE_INDEX_SCOPE — 35 test file(s) exist outside the
indexed scope — relevant-test analysis may be incomplete:
test/account-model.test.mjs, test/analytics.test.mjs,
test/api-guard.test.mjs, test/auth-login.test.mjs,
test/coverage.test.mjs, +30 more
```

Emitted in CLI output and the `/api/analysis` JSON `warnings` array as
`{code: "TEST_FILES_OUTSIDE_INDEX_SCOPE", message, files}`.

### IMPLEMENTATION

`fingerprint.ts` exposes its repo walk; `pipeline.ts`
`testFilesOutsideIndex()` recognizes `test/`, `tests/`, `__tests__/`,
`*.test.*`, `*.spec.*` and reports candidates not present in the SCIP
index. Relevant-test claims remain evidence-only — the warning never
asserts relevance. No tsconfig mutation.

### TESTS

`tests/changes.test.ts` — an untracked `test/outside.test.mjs` in the
git fixture surfaces the warning with the file listed, while indexed
`tests/app.test.ts` is not reported.

### REAL-REPO VALIDATION

Dev Ledger reports 35 `.mjs` candidates with representative paths;
sonner/vaul runs also surface their out-of-scope `test/` trees.

### REMAINING LIMITATION

`.js`/`.mjs` files remain unindexed — scip-typescript indexes only the
tsconfig include set. Indexing them independently would need a second
index pass with its own compiler config; warning-first is the shipped
boundary.

## FP-1 — `import type` caused runtime propagation (P2)

### BEFORE

Adding an unused `import type { X }` produced a module-scope hunk that
marked the file runtime-changed, propagating to every importer file
(`ShareModal.tsx`, `App.tsx`, `main.tsx`) — a provably-erasable
statement causing runtime impact (T09 PARTIAL).

### AFTER

The same edit reports `Changed: 1` (module-scope, `typeOnly: true`),
`Runtime affected: 0`, `Type affected: 0` — importers appear only under
"Referencing only". A *used* type import still yields type impact via
`type_depends`; an unused one yields nothing.

### IMPLEMENTATION

`ast-defs.ts` `typeOnlyModuleRanges()` returns line ranges of provably
erasable top-level statements: `import type`, `import { type A, ... }`
when every specifier is type-only, `import type = require`, `export
type ...`/`export type { ... }` re-exports, and top-level
type-alias/interface declarations. Mixed imports (`import { type A,
B }`), default+named mixes, and side-effect imports are excluded. Hunks
landing entirely inside such ranges mark the file module-scope change
`typeOnly`; `traverse.ts` seeds type-only marks into the type BFS only.
`AnalysisResult.changed[].typeOnly` exposes the flag.

### TESTS

- `tests/changes.test.ts` — `s16-import-type` git fixture: module-scope
  change detected, `typeOnly` true, zero runtime propagation.
- `tests/classify.test.ts` — `typeOnlyModuleRanges` unit matrix:
  type-only imports/aliases/all-type named imports/type re-exports
  covered; mixed, default+named, side-effect, and runtime imports
  excluded.
- Existing runtime-import scenarios (s15) unchanged.

### REAL-REPO VALIDATION

Dev Ledger T09: editing `import type { Period }` to add `DayData`
→ 0 runtime, 0 type, importers under "Referencing only" only.

### REMAINING LIMITATION

`typeOnly` is file/granular at module scope — a hunk mixing type-only
and runtime statements in one edit still propagates runtime
(conservative). Ambient `declare module` blocks are not classified
type-only (conservative exclusion).

## SSE reconnect resynchronization (P2)

### BEFORE

After an explorer server restart, the SSE stream reset `revision` to 0/1
while the browser held a higher `appliedRev`; every subsequent `result`
event was discarded as stale, and `hello` was ignored — the UI stayed
stale until manual reload.

### AFTER

Each `hello` carries a per-process `instance` id (`randomUUID`). On
reconnect the client compares it: a new instance (or a missed/reset
revision) triggers a refetch of `/api/analysis` — the authoritative
snapshot. Revision ordering still guards stale events; the fetch is
deduplicated so no refresh loop occurs; filters and selection persist.

### IMPLEMENTATION

`live.ts` stamps `hello` with `instance`. `explorer/src/api.ts` exposes
the hello event to the app; `App.tsx` resyncs on instance change or
revision regression instead of applying stale stream data.

### TESTS

- `tests/explorer-server.test.ts` — restart produces a new instance id
  and replays the latest result (contract test).
- `tests/live.test.ts` — revision ordering, disconnect/reconnect
  sequence covered.

### REAL-REPO VALIDATION

Dev Ledger: restarted `explore` emitted `instance:
37087f6f-…` vs prior `f592266f-…`; the previous instance's retained
state was confirmed stale-proof by the restart test.

### REMAINING LIMITATION

A browser tab open during server downtime sees a brief stale view until
SSE reconnect fires; resync then converges without manual reload.

## Process-cleanup safety

### BEFORE

Dogfood cleanup used a blanket `taskkill /IM node.exe`, terminating
unrelated Node processes on the machine.

### AFTER

Ripple source contains no process-termination calls at all — child
processes are synchronous `execFileSync` (git, scip) that complete
naturally, plus one detached fire-and-forget browser `spawn`. Explorer
shutdown closes its own server/watcher handles; test cleanup uses
explicit `.close()`/PID-targeted kills of self-created processes only.

### IMPLEMENTATION

No code change required — a static guard prevents regression.

### TESTS

`tests/package.test.ts` — scans `src/` for `taskkill`, `pkill`,
`killall`, `process.kill(` and fails if any appear.

### REAL-REPO VALIDATION

Dev Ledger explorer SIGINT cleanup already verified in baseline audit
(no worktree/temp orphans); this tranche's server restarts were killed
by explicit PID only.

### REMAINING LIMITATION

None — the guarantee is source-level absence of blanket termination.
