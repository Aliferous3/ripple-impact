# Ripple — Dev Ledger Pre-Release Dogfooding Audit

- **Artifact under test:** `ripple-impact-0.1.0.tgz`, installed globally (`ripple 0.1.0`)
- **Ripple commit:** `dc16877` (Tranche 4, `main`)
- **Target:** `C:\Users\Aliferous\Desktop\Projects\Dev Ledger - Ripple Test` @ `db8bdb4` (`main`, isolated clone; original working copy untouched)
- **Environment:** Windows, Node v24.18.0, npm-installed bin
- **Method:** each experiment = clean baseline → one controlled edit → analysis → evidence inspection → restore → verify clean. Packed artifact used throughout.

## Executive summary

Ripple is genuinely useful on Dev Ledger. Changed-symbol mapping is precise, runtime and type impact propagate correctly with concrete per-hop evidence (call sites, line ranges, git hunks), the explorer's WHY panels are honest, and live mode is robust under syntax errors, rapid edits, and deletions. Three real gaps were confirmed: (1) whitespace-only changes *inside string literals* are silently classified as non-semantic — a true false negative on a real semantic change; (2) JSX element usage (`App` → `<ShareModal/>`) is recorded as a reference, not a call, so runtime impact stops one hop short in React trees; (3) all of Dev Ledger's tests are `.mjs` files outside the tsconfig `include`, so relevant-test reporting can never fire on this repo — Ripple reports 0 honestly but offers no hint that unindexed tests exist.

## Overall verdict

**READY AFTER TARGETED FIXES** — one P0 silent-FN fix (string-literal whitespace) plus public disclosure of the JSX and `.mjs` boundaries.

## Scorecard

| Axis | Score | Notes |
|---|---|---|
| Changed-symbol precision | 5 | Every reported changed symbol verified correct incl. module-scope and tombstone attribution |
| Runtime-impact precision | 4 | Only blemish: `import type` module-scope edit propagates to importer *files* (T09) |
| Runtime-impact recall | 3 | JSX boundary misses `App()` hop (T06); string-whitespace misses root (T16) |
| Type-impact precision | 5 | All 4 type-affected nodes verified against real `type_depends` evidence |
| Type-impact recall | 4 | Solid within indexed scope |
| Test-impact usefulness | 2 | Cannot fire in this repo — all tests are unindexed `.mjs` (T11/T21) |
| Evidence quality | 5 | Per-hop call sites, hunks, ranges, base-revision former callers — all verified |
| False-positive resistance | 4 | One narrow FP class (module-scope `import type`) |
| False-negative resistance | 3 | T16 string-whitespace FN; T06 JSX FN; unindexed-test blind spot |
| Explorer usability | 4 | WHY panels excellent; stale UI after server restart; same-line duplicate evidence is noisy |
| Live-analysis reliability | 4 | Syntax recovery, races, persistence, deletion all correct |
| Performance | 4 | Cold 8.5s, warm <1s, live single-file ~1–2s; deletion (base graph) slower but acceptable |
| Security/local-first | 5 | Loopback-only, allowlist path checks, traversal blocked, no telemetry |
| **Overall trustworthiness** | **4** | |

## Test matrix

| ID | Result | Evidence |
|---|---|---|
| T01 clean baseline | PASS | `impact --base main` on clean tree → Changed 0 / Runtime 0 / Type 0 / Tests 0; explorer quiescent |
| T02 precise mapping | PASS | `fmtHumanDate` body edit → only `fmtHumanDate()` changed; `fmtHumanRange`/`gitLogCommand`/`fmtInt` clean |
| T03 direct runtime | PASS | `fmtHumanRange()` direct via call-site evidence `shareModel.ts:110` |
| T04 transitive | PASS | `ShareCard()`, `ShareModal()` with complete per-hop paths |
| T05 depth stability | PASS | depth≤2 ≡ all-downstream; no hidden nodes beyond ShareModal |
| T06 JSX boundary | PASS (documents FN) | `App()` is REF only; JSX element usage has no `calls` edge — see FN-1 |
| T07 type-only prop add | PASS | `_rippleTest?: string` on `ShareRecordData` → 0 runtime, type impact on real consumers |
| T08 type evidence | PASS | `ShareCard`/`buildShareRecord`/`shareFileName`/`ShareModal` each show `type_depends` at real source ranges |
| T09 unused type import | PARTIAL | No type impact (correct) — but module-scope hunk propagates to importer files as runtime-affected (FP-1) |
| T10 narrow runtime dep | PASS | `gitLogCommand` edit → Direct `ShareCard()` only; unrelated code excluded (Finding D reproduced) |
| T11 `.mjs` test gap | PASS (documents FN) | `test/share.test.mjs:163` calls `gitLogCommand`; zero `test/` nodes in graph — outside tsconfig `include` (FN-3) |
| T12 deleted function | PASS | `DEL gitLogCommand` tombstone, old L112–116, removal hunk, FORMER CALLERS (BASE REVISION) → `ShareCard()` |
| T13 deleted local | PASS | temp-commit `const sep` inside `fmtHumanRange` → removed → attributed to enclosing `fmtHumanRange()` |
| T14 comment-only | PASS | classified non-semantic, Changed 0 |
| T15 formatting-only | PASS | reflow → no meaningful changed symbol |
| T16 string-whitespace | **FAIL** | `'$ git log'` → `'$  git log'` (real output change) classified non-semantic, Changed 0 (FN-2) |
| T17 new unused fn | PASS | Added 1, runtime affected 0 |
| T18 new fn + caller | PASS | `fmtInt → rippleTemporaryTest` edge appears; `ShareCard` flagged via `fmtInt` |
| T19 multi-root | PASS | both roots listed, chains separate, dedup correct |
| T20 shared downstream | PASS | `fmtInt` + `gitLogCommand` converge on `ShareCard` — reported once, both roots visible |
| T21 positive test mapping | N/A | no indexed tests exist in Dev Ledger (all `.mjs`); documented rather than manufactured |
| T22 syntax-error recovery | PASS | error banner "Analysis failed — showing previous result", graph intact, auto-recovered on fix |
| T23 rapid-save race | PASS | two rapid semantic edits both reflected; no stale overwrite |
| T24 selection persistence | PASS | selection survives re-analysis; on deletion it retargets to the tombstone node cleanly |
| T25 filter/depth persistence | PASS | depth=1 + referencing-off survive live refresh; URL hash stable |
| T26 search | PASS | `fmtHuman` → both symbols with file disambiguation; selection/centering works |
| T27 WHY CHANGED | PASS | git hunk + mapped symbol extent + source preview all correspond to reality |
| T28 WHY AFFECTED | PASS | every edge verified against real call sites (dup entries = 2 real calls on one line — UX-1) |
| T29 WHY TYPE-AFFECTED | PASS | `type_depends @ shareModel.ts:59` = real `ShareRecordData \| null` return type |
| T30 reference segregation | PASS | REF nodes (`App.tsx`, file nodes, `App()`) never appear as impact |
| T31 binary warning | PASS | staged `test/fixture.bin` → `BINARY_SKIPPED` warning |
| T32 JSON output | PASS | stdout parses clean (schemaVersion 2); progress on stderr; counts match CLI |
| T33 CLI/UI parity | PASS | CLI = JSON = explorer counts across 3+ modifications |
| T34 cache cold/warm | PASS | cold analyze 8.5s; warm impact ≈0.75s (index+graph hit) |
| T35 cache invalidation | PASS | source edits invalidate fingerprint correctly; enrichment cache reused |
| T36 README-only | PASS | no reindex (784ms, cache hit); honest `NOT_INDEXED` warning |
| T37 `.ripple` feedback loop | PASS | cache writes under `.ripple/` do not trigger re-analysis |
| T38 local security | PASS | binds 127.0.0.1; `../`, absolute, NUL, non-allowlisted paths → 403 |
| T39 `.env` protection | PASS | `.env` blocked by allowlist (not graph/diff file) → 403 |
| T40 watcher ignores | PASS | touches in `.ripple/`, `node_modules/`, `dist/` produced zero re-analysis |
| T41 SIGINT cleanup | PASS | listener closed, watcher stopped, port freed, no temp/worktree orphans |
| T42 final cleanliness | PASS | `git status` → only untracked `.ripple/` |

**Totals: 36 PASS · 1 PARTIAL · 1 FAIL · 4 N/A (T05 folded into T03/T04 depth comparison; T21 N/A as designed)**

## Confirmed strengths

- Precise hunk→symbol attribution, including module-scope and deleted-local (enclosing-function) cases.
- Deleted symbols get real tombstones with base-revision former-caller evidence.
- Type impact is separate, evidence-backed, and does not contaminate runtime counts.
- WHY panels show verifiable artifacts (hunks, ranges, call sites) — no unsupported claims.
- Honest degradation: `NOT_INDEXED`, `BINARY_SKIPPED`, zero-test results all surfaced, never silently implied.
- Live mode is resilient: syntax errors, rapid edits, deletions, cache writes — all handled without restart or feedback loops.
- Security posture verified end-to-end: loopback bind + allowlist-based source preview.

## False positives

- **FP-1 (MEDIUM):** a module-scope hunk such as an added `import type` line marks the file "module-scope changed" and propagates runtime-affected status to importer *files* (`ShareModal.tsx`, `App.tsx`, `main.tsx`). Conservative and file-level (not symbol-level), but `import type` is provably erasable — the propagation should distinguish type-only imports. (T09)

## False negatives

- **FN-1 (HIGH for React users, classified EXPECTED CONSERVATISM):** JSX element usage yields only a `references` edge — `App()` renders `<ShareModal/>` but is not runtime-affected. The chain still surfaces ShareModal, so users see the component-level impact; they lose the parent-component hop. scip-typescript/AST enrichment treats JSX usage as reference, not call. (Finding B, T06)
- **FN-2 (HIGH):** whitespace-only changes *inside string literals* are normalized away — `'$ git log'` → `'$  git log'` produced Changed 0. Non-whitespace string changes flag correctly. The non-semantic classifier's line normalization is string-context-blind. (T16)
- **FN-3 (MEDIUM, configuration limitation):** `test/share.test.mjs` directly calls `gitLogCommand()` (`:163`) but lives outside tsconfig `include` → scip never indexes it → relevant-tests can never report it. Ripple sees nothing; the repo contains a real test. Not a mapping defect — a coverage boundary Ripple should surface as a warning. (Finding E, T11/T21)

## UX issues

- **UX-1 (LOW):** two call sites on one line (`fmtHumanRange` calling `fmtHumanDate` twice) render as two near-identical evidence rows — accurate but visually repetitive.
- **UX-2 (MEDIUM):** after the explorer server restarts on the same port, the browser SSE reconnects but does not re-fetch state — the UI keeps the last pre-restart analysis until manual reload. The `hello` event carries `revision`; client should resync on reconnect.
- **UX-3 (LOW):** REF file-level nodes (`ShareCard.tsx`, `App.tsx`) add mild visual noise on small graphs; defensible as context.

## Known conservative boundaries

- Runtime impact does not cross plain references — includes JSX usage (FN-1) and any non-call relationship.
- Module-scope changes propagate to importer files only (FP-1 is the coarse end of this).
- Type-member additions flag *all* consumers of the parent interface — verified deliberate and evidence-backed (Finding #4).
- Relevant-tests only covers indexed files (FN-3).
- Ripple's `.ripple/` cache isn't gitignored in the target repo — Ripple itself warns the user about this (good UX).

## Security findings

None. Bind = `127.0.0.1` only; `/api/source` rejects `..`, absolute paths, NUL, `.env`, binaries, and any file not in the graph/diff allowlist (all probes → 403; legitimate file → 200). No telemetry. SIGINT frees the port and leaves no worktree/temp orphans.

## Performance (Dev Ledger @ db8bdb4, Windows/Node 24)

| Scenario | Time |
|---|---|
| Cold `analyze` (cache cleared) | ~8.5s |
| Warm `impact` (cache hit) | ~0.75s total (diff ~0.6s, index/graph hit, traverse <1ms) |
| Live single-file edit → updated UI | ~1–2s |
| Deletion requiring base graph | ~8–10s first time (worktree + base index), warm thereafter |
| README-only edit | ~0.8s (no reindex) |

## Release blockers

None — no unsafe, broken, or insecure behavior. FN-2 is the closest; classified HIGH rather than blocker because it is narrow (whitespace-only-in-string) and documented, but it is the top fix.

## Pre-beta recommended fixes

- **P0** — Make the non-semantic classifier string-literal-aware: whitespace changes inside string literals must not be normalized to "no change". (FN-2)
- **P1** — Emit a warning when tracked files matching common test globs exist outside the indexed scope (e.g. `test/*.mjs`): "N test-like files not indexed — relevant-tests may under-report". (FN-3)
- **P1** — Decide and document the JSX boundary: either propagate runtime impact through JSX element usage (treat as construction call) or disclose the one-hop-short behavior prominently. (FN-1)
- **P2** — Skip module-scope runtime propagation for `import type`/`export type` lines. (FP-1)
- **P2** — Explorer: re-fetch `/api/analysis` on SSE reconnect when revision differs. (UX-2)

## Public-beta limitations text (draft)

> Ripple is conservative: it reports impact only where it has concrete evidence.
> - React JSX: `Parent` rendering `<Child/>` is recorded as a reference, so runtime impact may stop at the child component rather than continuing to the parent.
> - Relevant tests only cover files your TypeScript project indexes. Test files outside `tsconfig` `include` (e.g. plain `.mjs` suites) are not analyzed — check that your tests are within the indexed scope.
> - Whitespace-only edits inside string literals are currently treated as non-semantic; edits that change string content beyond whitespace are detected normally.
> - Edits to a module's top level (e.g. adding imports) conservatively flag files that import it.

## Recommendation

Fix the P0 string-literal normalization before public beta; land the P1 test-scope warning and disclose the JSX boundary in the README. The audit found no reason to delay beyond those items — the engine's evidence discipline held up across all 42 probes on a real codebase.
