# Contributing

Ripple is a deterministic, local-first change-impact engine. The core
contract is simple: **every reported relationship is backed by indexed
evidence. No invented edges.**

## Setup

```sh
git clone https://github.com/Aliferous3/ripple-impact.git
cd ripple-impact
npm install
npm run index:fixtures                 # builds test fixtures under tmp/
npx tsx scripts/setup-git-fixture.ts   # builds the git-scenarios fixture
npm run typecheck   # tsc --noEmit (root + explorer)
npm run build       # dist/ — required before npm test (package/server
                    # tests exercise the built bundle)
npm test            # unit/model tests
npm run test:e2e    # Playwright explorer suite
```

Requires **Node.js ≥ 22** and git. The Python adapter tests additionally
need **Python ≥ 3.10** on PATH (`python`, `py -3`, or `python3`).

Use `tmp/` inside this repo for scratch fixtures, validation clones, and
local experiments — it is gitignored. Never commit private repositories,
screenshots containing personal paths, credentials, `.env` files, or
`.ripple` caches.

## Architecture

- `src/indexers/` — language adapters. Each adapter owns detection,
  file rules, indexing, capabilities, and source semantics, and emits a
  provenance-stamped graph fragment. `docs/MULTI-LANGUAGE-ARCHITECTURE.md`
  describes the contract; `docs/PYTHON-EXPERIMENTAL.md` covers Python.
- `src/changes/` — git-diff → changed-symbol mapping.
- `src/impact/` — graph traversal (runtime vs type are separate worlds).
- `src/server/` + `explorer/` — the loopback-only specimen explorer.
- `python/enrich.py` — stdlib `ast`/`tokenize` classification for Python.

**Adapter principles**

- A reference is not a call. `calls` edges require semantic resolution
  *and* a syntactically proven call position.
- Runtime and type impact never cross.
- Honest misses over fabricated certainty — degraded results must say so.
- No telemetry, no source upload, no network at analysis time. Child
  processes (scip-typescript, scip-python, the Python interpreter) are
  local only.
- Nothing bridges language graphs unless a future adapter emits
  authored-evidence edges.

## Tests

Semantic changes need regression coverage — a minimal fixture and a
failing test before the fix is the preferred shape. The suites are:

- `tests/` — unit/model (vitest), including adapter and Python-adapter
  coverage
- `e2e/` — Playwright explorer tests
- `tmp/multilang-parity/` — TS/JS parity harness vs released v0.1.0

`docs/RELEASING.md` covers the release process. For bug reports use the
issue templates — Python reports should include the interpreter version
and whether the call receiver was statically typed.
