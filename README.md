# ripple — Tranche 0 technical spike

Deterministic change-impact engine for TypeScript/JavaScript.
See `docs/TRANCHE-0-FINDINGS.md` for what this spike proved.

## Usage

```sh
npm install

# index a project (writes <dir>/index.scip via scip-typescript)
npm run ripple -- index <dir>

# reverse impact analysis
npm run ripple -- impact <symbol> --root <dir> [--in <file-substring>]

# inspect a node's edges + evidence
npm run ripple -- inspect <symbol> --root <dir>

# graph stats
npm run ripple -- dump --root <dir>

# e.g. against the bundled fixture
npm run ripple -- impact refreshSession            # defaults to fixtures/basic

# (re)generate fixture indexes, then run tests
npm run index:fixtures
npm test
```
