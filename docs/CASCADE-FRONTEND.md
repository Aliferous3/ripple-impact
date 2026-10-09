# Cascade — the Ripple explorer interface

> **Superseded.** Cascade was replaced by the Design #33 specimen interface
> in `feat(explorer): adopt Design 33 specimen interface`. This document is
> retained as historical design context; see
> [DESIGN-33-FRONTEND.md](DESIGN-33-FRONTEND.md) for the canonical explorer.

Cascade is the explorer's document-style impact view. It replaces the
spatial graph canvas with an ordered, evidence-backed cascade: what you
changed, what it reaches, and why — top to bottom.

## 1. Why Cascade

The graph explorer answered "what is connected" but forced the user to
reconstruct *why* from a node-link diagram. On real changes the answer is
almost always an ordered narrative: the symbol you touched, its direct
callers, their callers, the type consumers, the tests that cover the
path, and everything else that merely references the changed code.
Cascade renders that narrative directly. The canonical design reference
is `C05Cascade` from the concept explorations; this implementation
translates that design onto the production `AnalysisResult` contract
without altering engine semantics.

## 2. Information architecture

```
┌────────────┬───────────────────────────────────────────────┐
│ TIER RAIL  │  C A S C A D E  (document)                    │
│            │                                               │
│ CHANGED    │  CHANGED ── what you actually modified        │
│ DELETED    │    row ── WHY CHANGED (diff + source)         │
│ DIRECT     │        ↓                                      │
│ TRANSITIVE │  DIRECT ── depends on changed runtime code    │
│ TYPE-AFF.  │    row ── WHY AFFECTED (evidence path)        │
│ TESTS      │        ↓                                      │
│ REFERENCES │  TRANSITIVE ── reached through one or more    │
│            │    hops                                       │
│ UNFOLD     │        ↓                                      │
│ DEPTH      │  TYPE-AFFECTED ── compile-time contract       │
│            │    consumers                                  │
│ WARNINGS   │  TESTS ── deterministically connected         │
│            │  REFERENCES ── mention the change, no proven  │
│            │    dependency                                 │
└────────────┴───────────────────────────────────────────────┘
                              ┌──────────────┐
                              │ FOCUS PANEL  │ (≥1536px)
                              │ selected row │
                              └──────────────┘
```

The rail is an index and live count board; the document is the answer.
A right-side focus panel appears on wide screens when a row is selected.

## 3. Tier semantics

Tiers are rendered in a fixed order:

| Tier | Meaning | Source |
|---|---|---|
| CHANGED | Symbols the diff mapped to | `changed` entries (minus deletions) |
| DELETED | Present at base, absent in working tree | `deleted` tombstones |
| DIRECT | Depth-1 runtime dependents | `impacted` with `depth === 1` |
| TRANSITIVE | Depth ≥2 runtime dependents | `impacted` with `depth > 1` |
| TYPE-AFFECTED | Compile-time contract consumers | `typeImpacted` |
| TESTS | Tests deterministically connected to changed code | `relevantTests` |
| REFERENCES | Mention the change; no proven dependency | `referencing`, deduplicated |

Every tier shows its engine count. Empty tiers are omitted except TESTS
when the scope warning forces it (see §8).

## 4. `AnalysisResult` → Cascade mapping

`explorer/src/cascade/model.ts` is a pure function
`buildCascade(analysis) → CascadeModel`. It performs data organization
only — it never invents edges, confidence, or causality:

- `changed` rows keep `changeKind`, file, line, diff hunks, and source
  ranges verbatim.
- `deleted` entries produce tombstone rows (`removed` flag) with former
  callers reconstructed by the engine from the base graph.
- `impacted` rows carry their engine `path` (root-first: seed → callers)
  and every evidence edge along that path.
- `typeImpacted` rows are never merged into runtime tiers.
- `referencing` ids already present in a stronger tier are deduplicated;
  the remainder form REFERENCES.
- `warnings`, `multiRoot` provenance, and `files` metadata pass through.

## 5. Runtime vs type distinction

Runtime (DIRECT/TRANSITIVE, blue) and compile-time (TYPE-AFFECTED,
purple) are visually and semantically separated. A symbol can appear in
both — deduplication never crosses the runtime/type boundary, since the
two answer different questions. Relationship names render verbatim from
evidence (`calls`, `jsx_uses`, `type_depends`, `references`, `contains`)
so `import type` fallout never masquerades as a runtime edge.

## 6. Reference semantics

REFERENCES is collapsed by default (`N references` → expand on click).
A reference asserts proximity, not dependence: the row's WHY block says
"WHY IS X ONLY A REFERENCE" and explains that no path back to a changed
root exists in the indexed graph.

## 7. Deleted-symbol treatment

Deletions get a first-class DELETED tier (red), sorted above DIRECT
because a missing symbol is a harder break than a modified one. The WHY
block — "WHY WAS X DELETED — AND WHAT USED TO DEPEND ON IT" — lists
former callers recovered from the base-revision graph, with the honest
note that these call sites will not resolve.

## 8. Warning treatment

`warnings[]` render as amber chips in the rail. The
`TEST_FILES_OUTSIDE_INDEX_SCOPE` warning additionally forces the TESTS
tier to render at zero rows with an inline scope note, so "no relevant
tests" is never silently confused with "we didn't look."

## 9. Multi-root provenance

When a row is reachable from several changed roots, its WHY block lists
every contributing root ("reached from N changed roots") rather than
arbitrarily picking one path. The first path is shown as primary
evidence; the rest are provenance.

## 10. Evidence grouping

Duplicate evidence along a path is grouped in the WHY block rather than
repeated — e.g. ten `calls` edges from the same caller collapse into one
evidence card with a count. Edge lines under each row show the deepest
incoming evidence (`fmtHumanDate() → calls · L109`).

## 11. Large-impact rollup

Above `ROLLUP_THRESHOLD = 120` impact rows, DIRECT/TRANSITIVE/REFERENCES
rows are deterministically grouped into subsystem clusters keyed by the
first two path segments (e.g. `src/auth`). Each cluster shows a count
bar scaled to the largest cluster and expands to its member rows. The
cluster key is display-only grouping — membership is computed from the
same rows the flat view would render.

## 12. Animation rules

Rows arrive with a single 480 ms `ease-out` rise (`rp-arrive`), tier by
tier. WHY expansion uses a fade/reveal. Under
`prefers-reduced-motion: reduce` all animations and transitions are
disabled and scrolling is instant. No animation ever gates content — an
interrupted render is still complete.

## 13. Live-analysis states

The explorer header is a state machine:

- **idle/result** — cascade for the latest revision.
- **analyzing** — chip while a re-analysis runs; the previous result
  stays visible.
- **analysis failed** — the previous valid result stays visible with an
  amber chip. The SSE `hello` event carries `lastError`, so a client
  connecting *after* a failure learns the state immediately instead of
  seeing a silent stale cascade.
- **reconnect** — the `hello` event carries a server `instance` id; a
  change (server restart) or a newer `revision` triggers refetch, closing
  the stale-state gap on reconnect.

## 14. Responsive behavior

- ≥1536 px: focus panel docked right.
- ≤1180 px: WHY grid collapses to one column (evidence above previews).
- ≤900 px: rail stacks above the document; depth control wraps.
- Cascade is a document, so narrow widths degrade to a single column
  with no loss of information.

## 15. Accessibility

- Rows are `<button>`s; WHY blocks toggle with `aria-expanded`.
- `/` focuses the filter; `Escape` clears selection/open state; the row
  surface is fully keyboard-operable.
- Tier colors are paired with text labels — no information is carried by
  color alone.
- `#n=<symbol-id>` deep links survive reload and are shareable.
- `prefers-reduced-motion` is honored globally (§12).

## 16. Remaining UI limitations

- The explorer is desktop-first; the rail stacks below ~900 px but the
  layout is not tuned for phones.
- Rollup clusters group by path prefix — a pragmatic partition, not a
  semantic module boundary.
- Evidence previews show at most the hunk/range the engine indexed;
  very large diffs are truncated to their relevant hunks.
- REFERENCES expansion is per-tier, not per-symbol provenance — a
  reference row does not claim *why* it mentioned the symbol beyond the
  evidence the indexer recorded.
- Deleted symbols whose former callers are unresolvable (e.g. callers
  outside the indexed scope) show an empty caller list rather than
  inferred consumers.
