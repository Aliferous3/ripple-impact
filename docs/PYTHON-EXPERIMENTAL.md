# Python support (experimental)

Ripple's second language adapter. **Experimental** — TypeScript/JavaScript
remains the only stable language contract. Everything below is verified on
Windows (the primary test target for this tranche); other platforms run the
same code paths but are not yet part of the release matrix.

## Requirements

| Piece | Requirement |
|---|---|
| Indexer | `@sourcegraph/scip-python` **0.6.6** (pinned runtime dependency, MIT) |
| Python | **≥ 3.10** on PATH — used for the stdlib `ast`/`tokenize` enrichment pass |
| Node | `>=22` (same as v0.1.0) |

Interpreter discovery is deterministic — first usable `>=3.10` wins:

```
python  →  py -3  →  python3
```

If no interpreter qualifies, analysis declines with a structured
`PYTHON_INTERPRETER_UNAVAILABLE` / `PYTHON_VERSION_UNSUPPORTED` error —
never a degraded silent attempt. `scip-python` itself resolves the project
environment on its own; our interpreter is only for the local
`ast`/`tokenize` classification pass.

## How it works

```
scip-python (Pyright)          Python stdlib ast/tokenize
semantic symbol facts    +     syntax position classification
            ↓                        ↓
        resolved occurrences   calls / annotations / bases /
                               decorators / comments / literals
            └──────────┬───────────────┘
                       ∩   (intersection only — never name matching)
              normalized Ripple graph
```

The trust rule is the same one Ripple enforces for TypeScript:
**a reference is not a call.** SCIP resolves *what* an occurrence means;
the Python AST pass proves *where* it syntactically sits. An edge becomes
`calls` only when a resolved SCIP occurrence lands inside an AST call
callee position; `type_depends` only inside annotation/base-class
positions. Nothing else is invented.

## Project detection

A directory becomes a Python `DetectedProject` when it has config evidence
AND `.py` sources:

- anchors: `pyproject.toml`, `setup.py`, `setup.cfg`, `Pipfile`,
  `pyrightconfig.json`, `tox.ini`, `requirements*.txt`
- root-anchored first, then config-anchored subdirectory projects
  (`api/`, `backend/`, …) for monorepos
- bare top-level `*.py` files claim the root only when the repo does not
  look primarily TS/JS (no `package.json`/`tsconfig.json`/`jsconfig.json`)
- `node_modules`, `.venv`, `site-packages`, build/cache dirs are skipped —
  a stray script in vendored output never becomes a project

## Verified semantics

| Construct | Result |
|---|---|
| `foo()` / `module.foo()` / `alias()` | `calls` when SCIP resolves the callee |
| `obj.method()` | `calls` when the receiver type resolves (annotated, inferred, `self`) |
| `await obj.m()` | same rule — `calls` when resolvable |
| `ClassName()` | `calls` to the class symbol |
| `x: T` / `-> T` / `list[T]` / `T \| None` / `Optional/Callable/Generic` | `type_depends` |
| `from __future__ import annotations`, `"T"` string annotations | `type_depends` when SCIP resolves them |
| `class C(Base)` | `implements` + `type_depends` on `Base` |
| `if TYPE_CHECKING:` block edits | module-scope `typeOnly` — never runtime impact |
| `test_*.py`, `*_test.py`, `tests/` | test files/symbols for relevant-test reporting |
| nested `def` | graph symbols (`outer().inner()`), innermost attribution |
| deleted defs | tombstones + former callers from the base graph |
| comments / whitespace-only edits | non-semantic (no changed symbol) |
| string-literal whitespace edits | semantic (changed symbol) |

## Honest limitations

These are missed or degraded *by design* — Ripple never fabricates
certainty:

- `getattr(obj, name)()` / `globals()[n]()` — no edge (dynamic lookup)
- calls through unresolvable receivers (`def f(svc): svc.m()` with no
  annotation) — no edge
- decorator heads stay `references` (`@app.get("/x")` does not become a
  call to `app.get`); decorator *arguments* that are calls still count
- metaclass-generated members, monkey-patching, `exec`/`eval`, dynamic
  imports — no edges
- external packages (`python-stdlib`, site-packages) live in SCIP
  `external_symbols` only — never repository graph nodes
- docstring edits count as semantic changes (docstrings are runtime
  `__doc__` objects, unlike comments)

## Windows notes

`scip-python` 0.6.6 has two upstream Windows hazards, both worked around
inside the child process only:

1. `new RegExp(path.sep, "g")` crashes at module load (`\` is an invalid
   regex tail). `python/scip-python-launcher.cjs` neutralizes `path.sep`
   for the child before loading the CLI.
2. With the separator neutralized, backslash `--cwd`/`--output` arguments
   make every project file look "outside the project" and emit an empty
   index. The adapter normalizes all path arguments to forward slashes.

Verified on Windows: full pipeline, paths with spaces
(`tmp/py spaces/repo with spaces/`), base-revision worktrees, watcher,
graceful shutdown.

## Cache & fingerprints

Adapter id/version join the fingerprint key — Python cache entries can
never collide with TypeScript ones or with a different adapter version.
The Python AST enrichment cache lives under `.ripple/enrich/python`.
Observed: cold → warm is ~17× on a 19-file repo (9.6s → 0.57s).

## Mixed repositories

`frontend/` TS + `backend/` Python in one repo produce one merged graph
with per-node provenance (`{"adapter": ..., "project": ...}`). There are
**no cross-language edges** — identically named TS and Python symbols do
not bridge. A future tranche may add explicit bridge edges with authored
evidence; nothing is inferred today.

## Performance snapshot (Windows, Node 24)

| Scenario | Cold | Warm |
|---|---|---|
| small fixture (10 files) | ~3.8 s | ~0.13 s |
| requests (~19 indexed files) | ~9.7 s | ~0.57 s |
| flask (83 enriched files) | ~12.1 s | — |
| mixed TS+Py fixture | ~4.4 s | ~0.20 s |

Cold time is dominated by the `scip-python` subprocess (Pyright analysis),
not by graph construction.
