# v0.2.0-beta.1 — Python dogfood corpus

Real public repositories run through the beta adapter on Windows/Node 24.
Method per repo: clean clone → record commit → baseline index → small
behavior-preserving edit to a callee with in-repo callers →
`ripple impact --base HEAD` → inspect changed/runtime/type/tests/warnings
→ cold + warm timing → FP sample (every `calls` edge evidence position
verified against `python/enrich.py` syntactic callee ranges) → restore.

## Results

| Repo | Type | Commit | Nodes / Edges | Cold | Warm | Changed → Impact | Warn | FP | Notes |
|---|---|---|---|---|---|---|---|---|---|
| requests | HTTP library | `611c616` | 505 / 1,755 | 7.9 s | 0.43 s | `default_user_agent()` → `default_headers()` → `Session#__init__()` | `TEST_FILES_OUTSIDE_INDEX_SCOPE` | 0 / 526 sampled | clean |
| flask | Web framework | release clone | — / 1,475 | 10.3 s | — | `get_load_dotenv()` → `Flask#run()` + `ScriptInfo#__init__()` | none | 0 / 369 | clean |
| httpie | CLI application | `5b604c3` | 1,921 / 6,039 | 12.2 s | 0.77 s | `repr_dict()` → `Environment#__str__()` + `PluginManager#__str__()` | `TEST_FILES_OUTSIDE_INDEX_SCOPE` | 0 / 1,206 | exact callers |
| starlette | Web/ASGI | `96d5023` | 2,812 / 10,760 | 15.2 s | 0.82 s | `is_async_callable()` → 16 call-site callers incl. `BackgroundTask#__init__()`, `HTTPEndpoint#dispatch()`, `request_response()` + tests; module-scope mark for overload block | none | 0 / 1,922 | large fan-out handled correctly |
| attrs | Data/model library | `644b4e1` | 2,907 / 5,119 | 12.3 s | 0.82 s | `has()` → `asdict()`, `astuple()` direct; `_asdict_anything()`, `VersionInfo#__eq__`/`__lt__` transitive | none | 0 / 581 | clean |
| rich | Utility library | `9d8f9a3` | 3,648 / 14,048 | 24.8 s | 0.95 s | `measure_renderables()` → `Group#__rich_measure__()`, `Panel#__rich_measure__()` + 3 direct tests + 2 transitive | none | 0 / 2,670 | clean |
| pydantic | Typed Python | `68a839f` | — | — | — | **INDEXER CRASH** | — | — | scip-python 0.6.6 pyright SourceMapper defect — issue #2 |

## False-positive audit

**6,979 `calls` edges sampled across 5 successfully indexed repos —
0 suspects.** Every sampled edge's evidence position coincides with a
syntactic callee range from the stdlib `ast` classifier. ~3,000+
`references` edges remained references (no reference→call contamination).

## False-negative observations (bounded, expected)

- Starlette: `is_async_callable` has typing-overload declarations; the
  implementation edit also produced a correct module-scope mark.
- `functools.partial`-wrapped callables are resolvable only when
  SCIP identifies the target — dynamic partial application stays a miss.
- No new unexpected static-call misses observed beyond the documented
  honest-miss list (dynamic receivers, `getattr`, metaclasses, etc.).

## Performance

Cold indexing scales with repo size (7.9 s for 505-node requests →
24.8 s for 3,648-node rich); dominated by scip-python, not graph work.
Warm runs are ~1 s at every size (content-addressed cache).
No pathological behavior observed.

## Known failure

**pydantic does not index** — upstream `scip-python` 0.6.6 crashes in
`SourceMapper._getBoundSourceFilesFromStubFile` while resolving a type
alias's docstring through a stub file. Deterministic; isolated to the
`pydantic/` package (still fails with tests/, v1/, pydantic-core/, docs/
removed). Ripple degrades honestly to `PYTHON_INDEXER_FAILED` — no
partial graph, no fabricated edges. Tracked: issue #2.
