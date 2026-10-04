# Tranche 4 — Distribution, Packaging, First-Run UX, External Dogfooding

Branch: `main` · parent: `30cc999` (Tranche 3 GO)

Tranche 4 makes Ripple distributable: a real npm artifact a stranger can
`npx` on their own repository without cloning this repo or building
anything. The packed tarball — not `npm link`, not the source tree — is
the artifact under test.

## Package name

| Candidate        | Status                                                        |
| ---------------- | ------------------------------------------------------------- |
| `ripple`         | Taken (crypto/blockchain-adjacent packages + squatter noise)   |
| `ripple-code`    | Available but collides visually with unrelated "ripple" tools  |
| `ripple-cli`     | Taken; its bin is `ripple-cli` so it would not collide, but the name implies a thin wrapper |
| `ripple-impact`  | **Available — chosen**                                          |

**Decision:** package `ripple-impact`, bin `ripple`, product name stays
"Ripple". `npx ripple-impact impact --base main` works immediately; the
bin name keeps the documented CLI `ripple …` after install.

## Package contents & size

`npm pack` inventory — audited by `tests/package.test.ts` (allowlist +
denylist assertions):

```text
36 files total
LICENSE, README.md, package.json
dist/**/*.js          compiled CLI + engine + server (no source maps)
dist/explorer/        prebuilt vite bundle (index.html + hashed css/js)
```

| Measure | Value |
| --- | --- |
| tarball (gzip) | ~176 kB |
| unpacked | ~570 kB |
| largest payload | explorer JS bundle 379 kB (React + React Flow + dagre) |
| scip-typescript | declared dependency, not vendored |

Nothing else ships — no `src/`, tests, fixtures, tmp/, screenshots,
`.env`, `.ripple`, or dev config. `files` allowlist, not a blacklist.

## Runtime dependencies

```text
@sourcegraph/scip-typescript  ^0.4.0   Apache-2.0  (indexer + typescript)
chokidar                      ^4.0.3   MIT          (watch mode)
typescript                    ^5.9.0   Apache-2.0   (AST enrichment — direct
                                                    import, no longer relies on
                                                    scip's transitive hoist)
```

Transitive (≈16 packages): commander, progress, google-protobuf +
protobufjs chain (BSD-3), long, @types/node, undici-types, readdirp.
**All permissive** — Apache-2.0 / MIT / BSD-3-Clause. Nothing flagged.

Dev-only: vitest, vite, @vitejs/plugin-react, react, react-dom,
@xyflow/react, @dagrejs/dagre, @playwright/test, tsx, @types/*.
Consumers never install these — verified by clean-room install and by
the package test asserting `dependencies` contains exactly the three
runtime deps.

## Node version contract

`"engines": { "node": ">=22" }`. Verified locally on Node 24.18
(Windows); Node 22+24 are in the CI matrix (ubuntu + windows). No APIs
newer than Node 22 are used (`closeAllConnections` is 18.2+).

## CLI UX

New output model: progress phases on **stderr** with real elapsed
timings (`Indexing TypeScript… 4.3s — first run indexes every source
file; the cache makes repeat runs faster`), results on **stdout**.
`--json` emits only the `AnalysisResult` (schema 2) — verified by
parsing piped stdout in the clean room. `--quiet` suppresses progress,
`--verbose` adds cache/fingerprint detail. `NO_COLOR` honored. No
banner, no fake percentages.

Commands: `impact [symbol]`, `explore [symbol]`, `changed`, `analyze`,
`inspect`, `cache status|clear`, `dump`, `demo`. Per-command `--help`.
`--version` reads package.json via `import.meta.url` (no hardcoded
string).

**Exit codes:** `0` success · `1` analysis/operational failure · `2`
invalid usage. Large blast radius is not an error; warnings don't fail.

**Errors observed (clean room):** non-git dir → "not a Git repository"
+ hint, exit 1 · no sources → "could not find a TypeScript or
JavaScript project", exit 1 · bad `--root` → "not a directory", exit 1
· unknown command → usage + help, exit 2 · bad `--base` → git stderr
surfaced, exit 1 · scip failure → real diagnostic tail (yup's missing
`@4c/tsconfig` printed `error TS6053` verbatim — this required capturing
**stdout** since scip writes diagnostics there; fixed during this
tranche).

**Preflight:** git repo? / git available? / sources present? / root
exists? — all fail with one-line messages before any indexing.

**`.gitignore`:** non-mutating hint — prints "add `.ripple/` to
.gitignore"; never edits the file.

## Explorer packaging

`prepack` runs `npm run build` → `tsc -p tsconfig.build.json` +
`vite build` → `dist/explorer/` ships inside the tarball. The server
resolves `../../dist/explorer` via `import.meta.url`, identical in
`src/` and `dist/` layouts. Clean-room `explore --no-open` served
index.html, the hashed JS bundle, `/api/analysis`, and the SSE stream —
all 200/valid from `node_modules/ripple-impact/`.

## Clean-room test

```text
mkdir %TEMP%/ripple-cleanroom && cd … && npm init -y
npm install C:/…/ripple-impact-0.1.0.tgz
npx ripple --version            → 0.1.0
npx ripple --help               → full command help
npx ripple demo                 → scratch repo
npx ripple impact --root <demo> → Changed 2 / Runtime 2 / Type 2 / Tests 1
npx ripple impact … --json      → parses, schemaVersion 2, stdout clean
npx ripple changed / inspect / cache status / dump   → all correct
npx ripple explore --no-open    → serves bundled assets, API, SSE live
```

Windows bin shims present: `ripple`, `ripple.cmd`, `ripple.ps1`.
Paths with spaces verified (`--root "…\my project dir\demo copy"`).
Zero orphan temp dirs or git worktrees after runs (`worktree prune`
added to cleanup). Server terminates cleanly on kill; SIGINT/SIGTERM
handlers close watcher → live → HTTP server in order (the same `close()`
the 30 e2e teardowns exercise).

## CI

`.github/workflows/ci.yml`:
- **test** — ubuntu+windows × Node 22+24: install, typecheck, fixture
  index, vitest
- **pack-smoke** — ubuntu+windows+macos: `npm pack` → clean-dir install
  → `--version`/`--help`/`demo`/`impact --json` asserting schema 2
- **e2e** — ubuntu: playwright chromium, 30 tests

`.github/workflows/release.yml` — tag-triggered verify + pack + clean
-room smoke; the `npm publish --provenance` step exists but is
**commented out** — no credentials in the repo, no publishing this
tranche.

## Dogfooding (packed tarball, clean-room install)

| repo | shape | files | cold analyze | warm impact | notes |
| --- | --- | --- | --- | --- | --- |
| fast-glob | npm, `src/` lib | 86 | 5.7s | 0.8s | `generate()` body edit → 44 runtime-affected: `generateTasks`→`glob`/`globSync`/`globStream`, 18 tests, 0 warnings |
| tsup | npm, `src/` CLI | 45 | 4.3s | 0.7s | `handleError()` edit → 7 real callers (`runRollup`, `build()`, …); `package-lock.json` honestly surfaced as not-indexed |
| pino | npm, **pure JS** | 17 | 1.7s | — | finding below |
| yup | **yarn berry**, src/ | 49 | 2.3s | — | `SchemaSpec`/`*Description` member adds → **141 type-affected**, 0 runtime — correct separation; `.yarn/install-state.gz` flagged as changed binary |
| zod | **pnpm/nub workspace**, packages/ | 511 | 21.3s | 2.2s | reproduces T3 exactly via tarball: `--base HEAD~1` → **301 type-affected**, 0 runtime, 107 tests |

**pino finding (real, honest):** its `tsconfig.json` has no `allowJs`
and *excludes* `*.d.ts` — nothing real indexes. Ripple degrades
correctly: `NOT_INDEXED` warnings per file, no invented edges. With
`"allowJs": true` added, the same repo indexes 4,119 nodes / 200 call
edges and `noop()` maps to real referencers (`child()`, `setLevel()`…)
listed under "referencing only" — JS symbol identity + conservative
propagation work; call-edge density on plain JS is simply thinner.
Documented boundary: *JavaScript only where the project's TS/JS config
covers it* — matches the README claim.

**false positives:** none found across all five repos (evidence paths
spot-checked: `generate()<-getTasks()<-glob()` etc., all real call
sites). **false negatives:** none new — the known T3 conservative
boundaries (callback callers, class members) unchanged.

## Security & audit

- `npm audit --omit=dev` → **0 vulnerabilities**.
- Full audit → 2 moderate, dev-only (`@vitest/mocker` via vitest 3;
  fix requires vitest 5 major — deferred, devDep only). vite/playwright
  advisories cleared by `npm audit fix` (vite 6.4.3, playwright 1.63.0).
- No telemetry, no network access beyond npm install itself.
  Explorer still binds `127.0.0.1` only; SSE is read-only; source
  previews path-gated.
- `exports` map exposes only `./package.json` — CLI-only surface, no
  accidental deep imports.

## Known limitations (unchanged or new)

- Live re-analysis still re-runs full scip-typescript (~21s zod); the
  fingerprint dedup + per-file enrich cache help but don't eliminate it.
- JS needs `allowJs`/`jsconfig` coverage — pino finding above.
- Repos whose package manager isn't npm need their own `install`
  (yarn/pnpm) before scip can resolve a tsconfig that `extends` an
  installed package — scip's hard error surfaces correctly now.
- macOS: CI smoke only, not yet manually verified.
- vitest 5 upgrade deferred (dev-only, moderate-severity fix).

## Release readiness

Remaining before a public `npm publish`:
- choose real repository URL once remote exists (package.json has no
  fabricated repo/homepage — add when the repo is pushed)
- enable the commented publish step with npm provenance/trusted
  publishing
- tag `v0.1.0`

## Verdict: **GO**

The packed tarball is installable, self-contained, honest about its
boundaries, and produces the same verified results as the source tree
on five real repositories.

## Recommended Tranche 5

Public beta release: push the repo, wire npm provenance, tag `v0.1.0`,
publish `ripple-impact`, then validate install-from-registry end-to-end.
A `uses:` GitHub Action is the strongest adoption lever after that —
`ripple impact --base origin/main --json` already emits the shape a
pull-request comment needs.
