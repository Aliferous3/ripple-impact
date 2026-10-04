# Ripple

See what your code change touches before you ship it.

Ripple is a deterministic change-impact engine for TypeScript and
JavaScript. Point it at a git diff and it answers: **which symbols could
be affected, why, and which tests cover them** — with a concrete
evidence path for every claim. It does not guess; every reported
relationship is backed by an indexed symbol reference or a parsed
type-position usage.

## Quick start

```sh
# inside any TypeScript/JavaScript git repository
npx ripple-impact impact --base main
```

That's it. Ripple indexes the repository with
[scip-typescript](https://www.npmjs.com/package/@sourcegraph/scip-typescript),
classifies call sites and type positions with the TypeScript compiler
API, builds a local dependency graph, and reports the blast radius of
your change:

```text
  Comparing main → working tree

  Changed           2
  Runtime affected  2
  Type affected     2
  Relevant tests    1
  Warnings          0
```

Every affected symbol comes with a **WHY** — the evidence chain of
calls/type dependencies that connects your change to it.

First analysis on a large project can take a while (a full
scip-typescript index — roughly 20s for ~500 source files). Results are
cached content-addressably under `.ripple/`, so repeat runs are fast.
Add `.ripple/` to your `.gitignore`.

Want a sandbox first? `npx ripple-impact demo` materializes a tiny git
repo exercising every category (runtime impact, type impact, tests,
evidence paths) and prints the commands to run against it.

## Visual explorer

```sh
npx ripple-impact explore --base main
```

Opens a local web UI: the impact graph (changed → affected nodes with
edge kinds), a filterable sidebar, and a details panel showing full
WHY CHANGED / WHY AFFECTED / WHY TYPE-AFFECTED evidence chains.

The explorer watches the working tree by default — save a file and the
graph re-analyzes and updates live over server-sent events. Use
`--no-watch` to disable, `--no-open` to skip the browser launch, and
`--port n` to pick a port.

## What Ripple reports

| Category          | Meaning                                                          |
| ----------------- | ---------------------------------------------------------------- |
| Changed           | Symbols whose own source the diff modified/added/removed         |
| Runtime affected  | Reachable through `calls`/`implements` edges from changed code    |
| Type affected     | Reachable through `type_depends` edges (type positions only)      |
| Relevant tests    | Test files that call into the affected set                        |
| Referencing       | Symbols referencing changed symbols (non-propagating context)     |
| Deleted           | Historical callers of symbols the diff removed                    |
| Warnings          | Unmapped diff regions, unindexed files, conservative boundaries   |

**Runtime vs type impact is deliberately separate.** A function whose
*body* calls your changed code is runtime-affected; a function that
merely *annotates a parameter* with your changed type is type-affected.
Type-only changes (e.g. adding a field to an interface) produce type
impact without claiming runtime callers are affected.

## Commands

```text
ripple impact   [symbol] [--root dir] [--base ref] [--in file] [--json]
ripple explore  [symbol] [--root dir] [--base ref] [--port n]
                [--no-open] [--no-watch]
ripple changed  [--root dir] [--base ref] [--json]
ripple analyze  [--root dir]
ripple inspect  <symbol|file::symbol> [--root dir]
ripple cache    status|clear [--root dir]
ripple demo
```

`--json` emits the full `AnalysisResult` (schema version 2) on stdout —
piping-safe, since progress and human output go to stderr. `--quiet`
suppresses human output. `--verbose` adds index/cache details.

Default comparison is `HEAD` vs the working tree; `--base <ref>`
compares the merge-base of `<ref>` with the working tree. Exit codes:
`0` success, `1` analysis failed, `2` invalid usage — finding a large
blast radius is **not** an error.

## How it works

```text
git diff → changed ranges → changed symbols
        → reverse BFS over the Ripple graph
        → runtime impact / type impact / tests / evidence paths
```

The graph is built from a SCIP index (canonical symbol identity:
definitions, references, re-exports, implementations) enriched by a
deterministic AST pass that classifies call sites and type positions
(annotations, generics, heritage clauses, `typeof`, `import type`).
SCIP alone can't distinguish a call from a type mention — that
distinction is what makes the runtime/type split sound.

Requires Node.js ≥ 22, git, and a TypeScript/JavaScript project
(`tsconfig.json` or `jsconfig.json`). No build step, daemon, or account
needed.

## Privacy

Ripple runs entirely on your machine. Source code is never uploaded —
indexing is a local scip-typescript subprocess, the explorer binds to
`127.0.0.1`, and the cache lives in `<repo>/.ripple/`. There is no
telemetry, no account, and no network access beyond the initial `npx`
download of the package itself.

## Supported languages and limitations

- **TypeScript** fully; **JavaScript** where scip-typescript can index
  it. Other languages are not supported.
- Indexing is not incremental: every content change re-runs
  scip-typescript for the whole project (the per-file AST enrichment and
  unchanged-fingerprint saves are cached). Expect ~15–25s on a ~500-file
  project, ~1–3s on small ones.
- Conservative boundary: a function that merely *calls* a type-affected
  function is not flagged type-affected — it needs its own type-position
  usage. Dynamic calls (`obj[key]()`) and some class-member changes are
  under-reported; Ripple prefers missing a true edge over inventing a
  false one, and reports warnings when it can't map a diff region.
- Windows is the development platform and is CI-tested; Linux is
  CI-tested. macOS is expected to work but is not yet verified.

## Cache

Analysis artifacts live under `<repo>/.ripple/cache/<fingerprint>/`.
The fingerprint hashes every indexable source file plus
`tsconfig*`/`jsconfig*`/`package.json`/lockfiles and the
scip-typescript + graph schema versions — uncommitted edits, config
changes, and dependency changes all invalidate. Base graphs for
committed revisions are keyed by commit SHA and reused forever.
Per-file AST enrichment is additionally cached by content hash under
`.ripple/cache/enrich/`, so a fingerprint miss only re-classifies the
files that actually changed.

## Development

```sh
npm install
npm run ripple -- impact --root <git-repo> --base main   # run from source (tsx)
npm test          # unit/integration tests (vitest)
npm run test:e2e  # explorer browser tests (playwright)
npm run typecheck
npm run build     # compiled CLI + explorer bundle → dist/
npm pack          # produces the distributable tarball
```

Architecture and per-tranche evidence: `docs/TRANCHE-0-FINDINGS.md`
through `docs/TRANCHE-4-FINDINGS.md`.

## License

Apache-2.0 — see `LICENSE`.
