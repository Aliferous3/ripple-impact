# ripple — deterministic change-impact engine (spike)

See what your code change touches before you ship it.

SCIP index + deterministic TypeScript AST call-site enrichment → normalized
Ripple graph → reverse impact traversal with evidence. Tranche 0.5 added
Git-diff → changed-symbol mapping; Tranche 1 adds a persistent local
analysis core: content-addressed `.ripple/` cache, versioned graph
artifacts, automatic base-graph handling, structured warnings, and stable
`--json` output. Tranche 2 adds a local visual explorer on top of the same
engine (`ripple explore`) — the engine stays authoritative; the UI only
renders what it reports.
See `docs/TRANCHE-0-FINDINGS.md`, `docs/TRANCHE-0.5-FINDINGS.md`,
`docs/TRANCHE-1-FINDINGS.md`, `docs/TRANCHE-2-FINDINGS.md`.

## Usage

```sh
npm install

# the simplest journey — see what a change touches
npm run ripple -- impact --root <git-repo> --base main
npm run ripple -- explore --root <git-repo> --base main   # local visual explorer

# build/reuse the cached analysis graph
npm run ripple -- analyze --root <dir>

# diff-driven impact analysis
npm run ripple -- impact --root <git-repo>                 # HEAD vs working tree
npm run ripple -- impact --root <git-repo> --base main     # merge-base vs worktree
npm run ripple -- impact --root <git-repo> --base <ref> --json
        # machine-readable AnalysisResult (schemaVersion 1)

# changed-symbol mapping only, with "why changed" evidence
npm run ripple -- changed --root <git-repo> [--base <ref>] [--json]

# reverse impact analysis for a single symbol (Tranche 0 mode)
# ambiguous names return candidates; disambiguate with file::name
npm run ripple -- impact <symbol> --root <dir> [--in <file>]
npm run ripple -- impact src/auth.ts::refreshSession --root <dir>

# inspect a node's edges + evidence
npm run ripple -- inspect <symbol|file::symbol> --root <dir>

# explorer: local-only server (127.0.0.1, OS-assigned port), prebuilt bundle
npm run build:explorer
npm run ripple -- explore --root <git-repo> [--base <ref>] [--port n] [--no-open]
npm run ripple -- explore <symbol> --root <git-repo>       # symbol-centered view

# cache observability
npm run ripple -- cache status --root <dir>
npm run ripple -- cache clear  --root <dir>   # deletes <dir>/.ripple only

# graph stats
npm run ripple -- dump --root <dir>

# (re)generate fixture indexes + the real-git scenario repo, then run tests
npm run index:fixtures
npx tsx scripts/setup-git-fixture.ts
npm test          # unit/integration (vitest)
npm run test:e2e  # browser tests (playwright; builds the explorer bundle)
```

The explorer is local-first: it binds to 127.0.0.1, serves only the
prebuilt bundle plus the analysis JSON and path-checked source previews,
and never sends code off the machine.

## Cache

Analysis artifacts live under `<repo>/.ripple/cache/<fingerprint>/`
(`index.scip`, `graph.json`, `metadata.json`). The fingerprint hashes every
indexable source file plus `tsconfig*`/`jsconfig*`/`package.json`/lockfiles
and the scip-typescript + graph schema versions — uncommitted edits,
config changes, and dependency changes all invalidate. Base graphs for
committed revisions are keyed by commit SHA and reused forever. Add
`.ripple/` to `.gitignore` (Ripple warns when it isn't).
