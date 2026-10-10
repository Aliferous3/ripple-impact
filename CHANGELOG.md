# Changelog

## 0.1.0-beta.1 — public beta

First public release of Ripple, distributed as a GitHub prerelease.

Install:

```sh
npm install -g https://github.com/Aliferous3/ripple-impact/releases/download/v0.1.0-beta.1/ripple-impact-0.1.0-beta.1.tgz
```

### What ships

- Deterministic git-diff → changed-symbol mapping.
- Runtime impact propagation over `calls`, `jsx_uses`, and `implements`
  edges, with direct vs transitive depth.
- Type impact propagation over `type_depends` edges — deliberately
  separate from runtime impact; `import type` never produces runtime
  propagation.
- Evidence paths: every affected symbol carries a WHY chain of concrete
  edges back to the change.
- Deleted-symbol reconstruction: tombstones plus former callers
  recovered from the base revision.
- Relevant tests within indexed scope; test files outside the index are
  surfaced as warnings, not silently dropped.
- References as a weaker, non-propagating category — related symbols
  that do not imply proven impact.
- Warnings for unmapped diff regions, unindexed files, and conservative
  boundaries.
- Live explorer: the Design #33 specimen interface — per-symbol plates,
  searchable rail, expandable WHY evidence chains, source/diff context,
  live watch mode over SSE, `ANALYSIS INTERRUPTED` failure state that
  preserves the last valid result, and reload-free recovery.
- CLI: `impact`, `explore`, `changed`, `analyze`, `inspect`, `cache`,
  `demo` — see `ripple --help` or the README.
- Local-first privacy: loopback-only explorer, no telemetry, no source
  upload, self-hosted fonts/assets.

### Known limitations

- TypeScript and JavaScript only (where scip-typescript can index);
  other languages are unsupported.
- `.js`/`.mjs` test files outside the SCIP index scope may be
  warning-only.
- Indexing is not incremental — every content change re-runs
  scip-typescript (~15–25s on ~500 files, ~1–3s on small projects).
- Dynamic calls (`obj[key]()`) and some class-member changes are
  under-reported; Ripple prefers missing a true edge over inventing a
  false one.
- References do not imply proven impact.
- Deleted symbols' former callers are reconstructed/inferred and may be
  approximate (surfaced as `inferred` evidence).
- For very large surfaces, rail clustering is deterministic
  path-prefixing, not semantic AI clustering.
- Desktop-first explorer; macOS is expected to work but is not yet
  verified (Windows and Linux are CI-tested).
- Beta software: the CLI surface may still evolve.
