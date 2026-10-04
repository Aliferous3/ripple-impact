# ripple — deterministic change-impact engine (spike)

SCIP index + deterministic TypeScript AST call-site enrichment → normalized
Ripple graph → reverse impact traversal with evidence. Tranche 0.5 adds
Git-diff → changed-symbol mapping on the input side.
See `docs/TRANCHE-0-FINDINGS.md` and `docs/TRANCHE-0.5-FINDINGS.md`.

## Usage

```sh
npm install

# index a project (writes <dir>/index.scip via scip-typescript)
npm run ripple -- index <dir>

# diff-driven impact analysis (the primary UX)
npm run ripple -- impact --root <git-repo>                 # HEAD vs working tree
npm run ripple -- impact --root <git-repo> --base main     # merge-base vs worktree
npm run ripple -- impact --root <git-repo> --base <ref> --base-graph
        # also resolves deleted symbols' former callers via a base index

# changed-symbol mapping only, with "why changed" evidence
npm run ripple -- changed --root <git-repo> [--base <ref>]

# reverse impact analysis for a single symbol (Tranche 0 mode)
npm run ripple -- impact <symbol> --root <dir> [--in <file-substring>]

# inspect a node's edges + evidence
npm run ripple -- inspect <symbol> --root <dir>

# graph stats
npm run ripple -- dump --root <dir>

# (re)generate fixture indexes + the real-git scenario repo, then run tests
npm run index:fixtures
npx tsx scripts/setup-git-fixture.ts
npm test
```
