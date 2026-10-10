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

## Reddit — r/python

Title: Ripple — deterministic change-impact analysis for Python
("I changed this. What else could be affected, and why?")

Body:

Ripple answers a question I kept asking in review: "I changed this
function — what could actually be affected?"

The beta adds experimental Python support with an unusual rule: a
reference is not a call. Python `calls` edges only exist where
scip-python's semantic resolution (Pyright-derived) *and* a local
stdlib `ast` pass agree the occurrence is in call position. `getattr`,
unresolved receivers, monkey-patching, metaclass members: honest
misses, never guessed edges. Type annotations land in a separate
type-impact world, so editing a type never claims runtime callers.

Dogfooded on requests, flask, httpie, starlette, attrs, rich — ~7k
call-site edges audited, zero false positives. (pydantic currently
crashes upstream scip-python — tracked, honest failure.)

Local-first, no telemetry, no upload. Python ≥3.10, Node ≥22, Windows
+ Linux verified.

## Reddit — r/typescript

Title: Ripple v0.2.0-beta.1 — change-impact explorer, unchanged TS/JS
semantics + experimental Python

Body:

Ripple answers "I changed this code — what else could be affected, and
why?" for TypeScript/JavaScript repos: deterministic evidence chains,
not guesses. This beta's headline is Python, but the TS/JS story is
boring in the right way — identical semantics to v0.1.0, parity-verified
on a 20-scenario harness.

The architecture is now per-language adapters producing
provenance-stamped graphs that merge deterministically, which is how
mixed repos analyze TS+Python in one result — with deliberately zero
cross-language edges.

## Reddit — r/programmingtools / r/programming

Title: Ripple — see what a code change could affect, with evidence
(TS/JS stable + experimental Python)

Body:

Change-impact analysis usually means "grep for callers" or an AI
summary. Ripple is neither: it indexes your repo semantically (SCIP),
classifies call sites vs references vs type positions with the language's
own parser, and walks the graph backwards from your git diff. Every
affected symbol shows the edge chain that got it there. Deleted-symbol
tombstones reconstruct former callers from the base revision.

Local-first, loopback explorer, no telemetry. TS/JS stable; Python
experimental in this beta.

## Show HN

Title: Show HN: Ripple — see what a code change could affect, with
evidence (now with experimental Python)

Body:

I built Ripple to answer "I changed this code — what else could be
affected, and why?" deterministically. It indexes your repo (SCIP via
scip-typescript/scip-python), adds a parser-level pass that proves
which occurrences are call sites, and walks the graph backwards from
your git diff. Every affected symbol comes with an evidence chain;
references that aren't calls never propagate.

v0.2.0-beta.1 adds experimental Python. The core rule: a reference is
not a call — a Python `calls` edge requires semantic resolution *and*
syntactic call position to agree. Dynamic misses (getattr, metaclasses)
stay misses. TypeScript/JavaScript is identical to stable v0.1.0.

Local-only, no telemetry, no upload; loopback web explorer with live
re-analysis. Windows + Linux verified (CI). Honest limits: dynamic
Python patterns, no cross-language edges yet, pydantic hits an upstream
indexer crash.

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

Single post:

Ripple v0.2.0-beta.1: Python joins the graph — experimentally.

A reference is not a call: Python `calls` edges need scip-python
resolution *and* `ast`-proven call position. Dynamic misses stay
misses. Local, deterministic, evidence chains. TS/JS unchanged.

Short thread (3 posts):

1. Ripple answers "I changed this code — what else could be affected,
   and why?" — deterministically, with an evidence chain for every
   claim. v0.2.0-beta.1 adds experimental Python. TS/JS unchanged.

2. The rule that makes it work: a reference is not a call. Python
   `calls` edges need scip-python semantic resolution *and* stdlib
   `ast`-proven call position. getattr/metaclasses/dynamic receivers
   stay honest misses — never fabricated edges.

3. Local-first everything: no telemetry, no upload, loopback explorer
   with live re-analysis. Mixed TS+Python repos analyze in one result —
   deliberately zero cross-language edges. TypeScript/JavaScript
   stable; Python experimental.

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
