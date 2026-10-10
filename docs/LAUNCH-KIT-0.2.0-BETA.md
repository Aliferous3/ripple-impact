# Ripple v0.2.0-beta.1 — launch kit (prerelease)

Ready-to-copy announcement text. **Do not post automatically** — pick
the channels, adjust voice to fit, and post manually.

Lead claim for every channel:

> Ripple now understands Python — experimentally.

Technical differentiator:

> A reference is not a call.

Install line (beta — do not replace the stable line in v0.1.0 docs):

```sh
npm install -g https://github.com/Aliferous3/ripple-impact/releases/download/v0.2.0-beta.1/ripple-impact-0.2.0-beta.1.tgz
```

---

## GitHub release notes (also used for the prerelease body)

### Ripple v0.2.0-beta.1 — Python joins the graph

Ripple still answers one question: *"I changed this code. What else
could be affected, and why?"* Now that question can be asked of
TypeScript, JavaScript, and — experimentally — Python.

This is a **prerelease**. TypeScript/JavaScript remains the stable,
proven language family: identical semantics to v0.1.0, verified 20/20
on a parity harness. Python is **experimental** — real semantic
indexing, honest edges, bounded coverage.

**How it works.** Python projects get the same two-layer treatment as
TypeScript: scip-python (Pyright-derived SCIP indexers) provides
semantic symbol identity, and a local Python `ast` pass classifies
syntax. A `calls` edge exists only where both agree — a resolved
occurrence *and* a syntactic call position. A reference is not a call;
nothing is inferred from names.

**What it does:** definitions, references, calls, type dependencies,
inheritance, relevant tests, deleted-symbol tombstones with former
callers, and live watch — all with evidence-backed WHY chains.

**Mixed repositories.** A repo can contain a TypeScript frontend and a
Python backend; Ripple analyzes both in one result, with provenance on
every symbol. Ripple does **not** invent frontend→backend dependencies:
there are no cross-language edges in this release.

**Honest misses.** Dynamic calls (`getattr`, `globals()`), unresolved
receivers, monkey-patching, metaclass members, `exec`/`eval`, and
dynamic imports may be missed. Misses are never replaced with guesses.

**Requirements:** Node ≥ 22, git, and Python ≥ 3.10 on PATH for Python
projects. On Windows, scip-python 0.6.6 has two upstream defects;
Ripple contains both inside the spawned child process (launcher shim +
path normalization). The shim is version-coupled — upgrades require
requalification.

Full docs: `docs/PYTHON-EXPERIMENTAL.md`. Known issues, limitations,
and the Windows details live there.

---

## Reddit (r/typescript, r/python, r/programmingtools)

Title: Ripple v0.2.0-beta.1 — Python joins a deterministic
change-impact engine ("a reference is not a call")

Body:

Ripple answers "I changed this code — what else could be affected, and
why?" Last release it did that for TypeScript/JavaScript. This beta
adds Python, experimentally.

The interesting bit: Python `calls` edges are not name-matching. Ripple
intersects scip-python's semantic resolution (Pyright-derived) with a
local `ast` pass that proves the occurrence is in call position. Both
must agree — a plain reference stays a reference. Dynamic things Python
can't statically prove (`getattr`, monkey-patching, metaclass members)
are honest misses, never fabricated edges.

Mixed TS+Python repos analyze both families in one result, but there
are deliberately no cross-language edges yet — Ripple doesn't pretend
your React component calls a Flask route.

Local-first, no telemetry, no source upload, evidence chain for every
affected symbol. Python ≥ 3.10 needed; Windows supported.

## Show HN

Title: Show HN: Ripple adds experimental Python to its deterministic
change-impact engine

Body:

A reference is not a call. Ripple's Python support intersects semantic
symbol resolution (SCIP via scip-python) with stdlib `ast` call-site
classification — both must agree before a runtime edge exists. Dynamic
misses stay misses. TypeScript/JavaScript is unchanged from stable.
All local, evidence chains for every claim.

## LinkedIn

Ripple v0.2.0-beta.1 is out — Python joins the graph, experimentally.

Ripple answers "I changed this code — what else could be affected?"
with evidence, not guesses. The new Python adapter intersects
scip-python semantic indexing with a local `ast` classification pass:
a `calls` edge exists only where a resolved symbol sits in a proven
call position. Dynamic constructs Python can't statically prove are
honest misses. TypeScript/JavaScript stays stable — parity-verified
against v0.1.0. Local-first, no telemetry.

## X / Twitter

Ripple v0.2.0-beta.1: Python joins the graph — experimentally.

A reference is not a call: Python `calls` edges need scip-python
resolution *and* `ast`-proven call position. Dynamic misses stay
misses. Local, deterministic, evidence chains. TS/JS unchanged.

## Discord / Slack

shipped Ripple v0.2.0-beta.1 — Python joins the change-impact engine
(experimental). `calls` edges = scip-python semantic resolution ∩ `ast`
call-position proof. no name-matching, no invented edges, dynamic stuff
stays a miss. mixed TS+Py repos work but no cross-language edges yet.
install:

    npm install -g https://github.com/Aliferous3/ripple-impact/releases/download/v0.2.0-beta.1/ripple-impact-0.2.0-beta.1.tgz

---

## What NOT to say

- "full multi-language support" — Python is experimental, two language
  families are not "full"
- "production-ready Python" — it is a beta
- "supports every Python project" — dynamic patterns are bounded
- any frontend→backend linkage — there are no cross-language edges
