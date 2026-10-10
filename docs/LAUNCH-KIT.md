# Ripple v0.1.0 — launch kit

Ready-to-copy announcement text. **Do not post automatically** — pick
the channels, adjust voice to fit, and post manually.

Lead claim for every channel:

> "I changed this code. What else could be affected, and why?"

Suggested screenshot per channel:

- **GitHub release / README:** `docs/screenshots/02-why-causal-chain.png`
  (shows the evidence chain — the core idea in one image)
- **Reddit:** `02-why-causal-chain.png` or `01-runtime-impact.png`
- **LinkedIn:** `01-runtime-impact.png` (clean overview plate)
- **X:** `04-deleted.png` (tombstone + former callers — most
  differentiating feature)
- **Show HN:** no image needed; if adding one, `02-why-causal-chain.png`

Install line (works in every post):

```sh
npm install -g https://github.com/Aliferous3/ripple-impact/releases/download/v0.1.0/ripple-impact-0.1.0.tgz
```

---

## GitHub discussion / repo announcement

Ripple v0.1.0 is out — first stable release.

Ripple answers "I changed this code. What else could be affected, and
why?" for TypeScript/JavaScript repos. It indexes your repo
(scip-typescript + a deterministic AST pass), maps your git diff to
changed symbols, and walks the graph backwards to show what calls,
implements, JSX-renders, or type-references them — with an evidence
chain for every claim.

No AI guesses, no risk scores, no telemetry. Everything runs locally;
the explorer binds to 127.0.0.1 only.

Install:

    npm install -g https://github.com/Aliferous3/ripple-impact/releases/download/v0.1.0/ripple-impact-0.1.0.tgz

Then `ripple impact --base main` or `ripple explore --base main` in any
TS/JS git repo. Requires Node ≥ 22.

## Reddit (r/typescript, r/programmingtools)

Title: Ripple — deterministic change-impact analysis for TypeScript
("I changed this. What else could be affected, and why?")

Body:

I built Ripple to answer a question I kept asking during reviews: "I
changed this function — what could actually be affected?"

It indexes your repo with scip-typescript, adds a deterministic AST
pass to tell call sites apart from type mentions, then maps your git
diff to changed symbols and walks the graph backwards. Every affected
symbol comes with a WHY chain: which `calls`, `jsx_uses`,
`implements`, or `type_depends` edge connects it to your change.

It deliberately separates runtime impact from type impact, shows
deleted symbols' former callers reconstructed from the base revision,
and keeps references as a weaker category instead of inflating the
blast radius. It doesn't predict bugs or score risk — it shows
evidence.

Fully local: no account, no telemetry, explorer binds to localhost
only. Open source (Apache-2.0). Node ≥ 22.

Install + docs: https://github.com/Aliferous3/ripple-impact

Known limits: TS/JS only, non-incremental indexing (~20s on ~500
files), dynamic calls can be under-reported. Honest list in the README.

## LinkedIn

Ever asked "I changed this code — what else could be affected, and
why?"

Ripple v0.1.0 is a deterministic change-impact explorer for
TypeScript/JavaScript. Give it a git diff and it shows which symbols
are affected — runtime vs type-level, direct vs transitive — with a
verifiable evidence chain for every claim.

- Local-first: no uploads, no telemetry, localhost-only explorer
- Evidence-backed: every impact claim traces to a call, JSX usage, or
  type dependency
- Honest about uncertainty: deleted-symbol callers are reconstructed
  from the base revision and marked inferred

Open source (Apache-2.0):
https://github.com/Aliferous3/ripple-impact

## X / Twitter

Ripple v0.1.0 — deterministic change-impact analysis for TS/JS.

"I changed this. What else could be affected, and why?"

git diff → changed symbols → evidence-backed blast radius. Runtime vs
type impact, deleted-symbol tombstones, live explorer. No telemetry, no
AI guesses.

https://github.com/Aliferous3/ripple-impact

## Show HN

Title: Show HN: Ripple – deterministic change-impact explorer for
TypeScript/JavaScript

Ripple answers "I changed this code. What else could be affected, and
why?"

It indexes a repo with scip-typescript plus a deterministic AST pass
(SCIP alone can't distinguish a call from a type mention — that
distinction makes the runtime/type split sound), maps a git diff to
changed symbols, and reverse-traverses the graph for impact.

Design choices:

- every impact claim carries an evidence chain (calls / jsx_uses /
  implements / type_depends edges with file:line)
- runtime impact and type impact are deliberately separate
- deleted symbols get tombstones; former callers are reconstructed from
  the base revision and marked inferred
- references are shown as weaker context, not proven impact
- local-first: loopback-only explorer, no telemetry, no source upload

Under-reports rather than invents: dynamic calls and some class-member
changes can be missed, and it says so via warnings instead of claiming
coverage.

Apache-2.0, Node ≥ 22: https://github.com/Aliferous3/ripple-impact

## Developer Discord / Slack

Heads up — shipped Ripple v0.1.0, an open-source tool that answers "I
changed this code, what else could be affected?" for TS/JS repos.

`ripple impact --base main` → changed symbols + runtime/type impact
with evidence chains. `ripple explore --base main` → live visual
explorer on localhost. No account, no telemetry.

https://github.com/Aliferous3/ripple-impact — feedback welcome.
