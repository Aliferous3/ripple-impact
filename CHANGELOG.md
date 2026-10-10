# Changelog

## 0.2.0-beta.1 — Python joins the graph (experimental)

First multi-language public prerelease. TypeScript/JavaScript remains the
stable, proven language family — its semantics are unchanged and
parity-verified against `v0.1.0` (20/20 scenarios). Python is
**experimental**.

Install:

```sh
npm install -g https://github.com/Aliferous3/ripple-impact/releases/download/v0.2.0-beta.1/ripple-impact-0.2.0-beta.1.tgz
```

### What ships

- **Language adapter architecture** — indexing is now per-project
  `LanguageAdapter`s producing provenance-stamped graph fragments that
  merge deterministically. One repository can host several detected
  language projects; `AnalysisResult` is unchanged.
- **Python adapter (experimental)** — semantic indexing via
  `scip-python` (Pyright-based, pinned `0.6.6`, MIT) plus a local Python
  `ast`/`tokenize` classification pass. The trust rule is unchanged:
  a SCIP reference is not a runtime call — `calls` edges exist only
  where a resolved symbol occurrence also sits in a syntactic call
  position. No regex or name-matching inference.
- **Python runtime calls** — direct, aliased, module-qualified, method,
  constructor, nested-function, and `await` calls where the receiver
  resolves; unresolvable/dynamic calls are honest misses.
- **Python type dependencies** — annotations, generics, base classes,
  `from __future__ import annotations`, and string annotations map to
  `type_depends`; `if TYPE_CHECKING:` edits are type-only and never
  propagate runtime impact.
- **Python inheritance** — `class C(Base)` becomes an `implements`
  edge with SCIP evidence.
- **Deletions & base graphs** — Python tombstones with former callers
  reconstructed from the base revision.
- **Relevant tests** — `test_*.py` / `*_test.py` / `tests/` conventions
  feed the existing relevant-test reporting.
- **Mixed TS/JS + Python repositories** — both language families
  analyze in one result with per-node provenance. There are **no
  cross-language edges**: identical names across languages do not
  bridge, and nothing is inferred between frontend and backend graphs.
- **Cache isolation** — adapter identity/version joins the fingerprint;
  Python artifacts live under `.ripple/enrich/python`.
- **Live watching** — Python source/config edits trigger re-analysis in
  the explorer.
- **Windows compatibility** — scip-python `0.6.6` has two upstream
  Windows defects (a `path.sep` RegExp crash at module load, and empty
  indexes when backslash paths are passed via `--cwd`/`--output`).
  Ripple contains both inside the spawned child process: a launcher
  shim plus forward-slash argument normalization. The shim is coupled
  to `0.6.6` — future scip-python upgrades require requalification.

### Requirements

- Node.js ≥ 22, git — unchanged.
- Python projects additionally need **Python ≥ 3.10** on PATH
  (`python` → `py -3` → `python3`) for the local AST pass. scip-python
  itself is bundled; no global tooling install is required.

### Known Python limitations

- Dynamic calls (`getattr(obj, name)()`, `globals()[n]()`) are not
  resolved — honest misses, never fabricated edges.
- Methods on unresolvable receivers (untyped parameters, reflection,
  metaclasses, monkey-patching, `exec`/`eval`, dynamic imports) may be
  missed.
- Decorator heads remain conservative `references`.
- External packages are not Ripple-owned graph nodes.
- Test files outside scip-python's project scope may warn
  (`TEST_FILES_OUTSIDE_INDEX_SCOPE`).
- Docstring edits are semantic — docstrings are runtime `__doc__`.
- Python support depends on scip-python `0.6.6`; upgrade = requalify.

## 0.1.0 — first stable public release

Promotes `0.1.0-beta.1` to stable. **No code or semantics changed** —
the stable artifact is built from the same source that passed the full
beta validation matrix, with version and documentation updates only.

Install:

```sh
npm install -g https://github.com/Aliferous3/ripple-impact/releases/download/v0.1.0/ripple-impact-0.1.0.tgz
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
- Requires Node.js ≥ 22 and git.

### Known limitations

- TypeScript and JavaScript only (where scip-typescript can index);
  other languages are unsupported.
- Indexing is not incremental — every content change re-runs
  scip-typescript (~15–25s on ~500 files, ~1–3s on small projects).
- Dynamic calls (`obj[key]()`) and some class-member changes are
  under-reported; Ripple prefers missing a true edge over inventing a
  false one.
- `.js`/`.mjs` test files outside the SCIP index scope may be
  warning-only.
- References do not imply proven impact.
- Deleted symbols' former callers are reconstructed/inferred and may be
  approximate (surfaced as `inferred` evidence).
- For very large surfaces, rail clustering is deterministic
  path-prefixing, not semantic AI clustering.
- macOS is expected to work but is not yet verified (Windows and Linux
  are CI-tested).

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
