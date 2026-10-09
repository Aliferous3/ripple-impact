# Design #33 — the Ripple specimen interface

Design #33 is the production explorer. It replaces Cascade (see
[CASCADE-FRONTEND.md](CASCADE-FRONTEND.md), retained as historical context)
with a forensic, one-plate-at-a-time presentation: a left specimen rail, a
single full-size plate per symbol, and an expandable WHY surface backed by
real evidence.

The approved reference is the motion prototype at
`tmp/design33-motion-preview` (not shipped). The production engine
(`AnalysisResult`) is the semantic authority; the prototype is the visual
authority.

## 1. Why Design #33 replaced Cascade

Cascade presented impact as a long causal document. On real analyses that
document could run hundreds of rows and buried the question Ripple exists
to answer — *what changed, what does it reach, why* — inside scrolling
volume. Design #33 keeps the graph internal and makes the user-facing
product a specimen system: one symbol, one full-size plate, one forensic
view at a time. Navigation is explicit (rail, prev/next, keyboard) rather
than scroll depth.

## 2. Plate information architecture

```
┌────────────┬──────────────────────────────────────────────────┐
│ SPECIMEN   │  PLATE                                           │
│ RAIL       │                                                  │
│            │  ◆ CATEGORY                                      │
│ 01 name()  │  symbolName()      — giant display title         │
│    CHANGED │  L-range · file · depth                          │
│ 02 name()  │  deterministic description                       │
│    DIRECT  │  [ OPEN WHY ]  note                              │
│ …          │                                                  │
│            │  metadata grid (real cells only)                 │
│ warnings   │  ┌ EVIDENCE PATH ──────┬ SOURCE ──────────────┐  │
│  chips     │  │ numbered hops       │ line-numbered preview │  │
│            │  │ rel · file:line     │ changed lines marked  │  │
│            │  └─────────────────────┴───────────────────────┘  │
│            │  PREVIOUS PLATE   NEXT PLATE                      │
└────────────┴──────────────────────────────────────────────────┘
```

The rail lists every plate as `NN · name · CATEGORY`. The selected plate
fills the main pane. A warnings shelf sits at the rail foot whenever the
engine emitted structured warnings.

## 3. `AnalysisResult → SpecimenViewModel`

`explorer/src/specimen/model.ts` is a pure adapter:
`buildSpecimen(analysis) → SpecimenModel` containing `plates`, `byId`,
`warnings`, `impactRows`, optional `clusters`, and `meta`. It performs data
organization only — ordering, labels, grouping, formatting. It never
invents edges, callers, roots, confidence, or dependency types; every
plate field traces to a field on `AnalysisResult`.

## 4. Semantic category mapping and ordering

| Plate category | Source |
|---|---|
| `CHANGED` | `changed` (non-deleted, runtime-relevant) |
| `CHANGED TYPE` | `changed` with `typeOnly` — compile-time root |
| `DELETED` | `deleted` + `changed` entries with `changeKind: "deleted"` |
| `DIRECT` | `direct` runtime impact |
| `TRANSITIVE` | `transitive` runtime impact |
| `TYPE` | `typeImpact.direct` + `typeImpact.transitive` |
| `TEST` | `tests` (grouped per test file, `via` preserved) |
| `REFERENCE` | `referencing` — related, impact not proven |

Plate order: changed roots → deleted → direct → transitive → type →
tests → references. Within a category: depth, then label. A symbol that
is both runtime-affected and type-affected appears once — runtime
membership wins — because its proven path already demonstrates the
stronger claim.

## 5. WHY behavior

`OPEN WHY` expands a category-aware forensic block:

- **CHANGED / CHANGED TYPE** — mapped evidence ranges, source ranges,
  and the git hunks that produced them (`SOURCE DIFF`).
- **DIRECT / TRANSITIVE** — "WHY IS X AFFECTED": every causal root gets
  its own chain (`WHY · CAUSAL CHAIN`), then incoming-edge evidence
  grouped by relation.
- **TYPE** — "WHY IS X TYPE-AFFECTED": the changed type/member, the
  `type_depends` evidence, and the consuming symbol.
- **DELETED** — "WHY WAS X DELETED": former callers reconstructed from
  the base revision plus the removal diff.
- **TEST** — the deterministic `via` links to changed/affected symbols.
- **REFERENCE** — "WHY IS THIS SHOWN": related by `<rel>` to `<symbol>`
  — impact is not proven.
- Warnings attached to the plate render as structured warning cards.

## 6. Evidence handling

Every hop in a path shows the engine's relationship label verbatim —
`calls`, `jsx_uses`, `type_depends`, `imports`, `references`,
`implements`, `former-caller` — plus a `file:line` site. Evidence sites
at the same `file:line` are grouped in presentation only
("N call sites" expands to all sites); no record is discarded.

## 7. Runtime/type distinction

`direct`/`transitive` and `typeImpact.*` map to disjoint categories with
separate plates. Dedup never crosses the runtime/type boundary, and a
`typeOnly` changed root is labeled `CHANGED TYPE` so compile-time-only
changes are never presented as runtime propagation.

## 8. Deleted symbols

Deleted symbols produce tombstone plates (`DELETED`), including fully
removed definitions that contained local declarations (the Tranche-4.9
engine fix). The plate carries the removal diff, base-revision former
callers, the note "present at base, absent in the working tree", and
`inferred` evidence state — reconstructed callers will not resolve to
live call sites.

## 9. References

`referencing` nodes become `REFERENCE` plates, ordered last and visually
subordinate in the rail. WHY states plainly that impact is unproven.
They are never merged into proven categories.

## 10. Warnings

All structured `AnalysisResult.warnings` render as chips in the rail
foot — `TEST_FILES_OUTSIDE_INDEX_SCOPE`, `NOT_INDEXED`,
`DELETED_SYMBOL_APPROXIMATED`, `AMBIGUOUS_SYMBOL`, `BINARY_SKIPPED`,
`BASE_GRAPH_UNAVAILABLE`, and anything else the pipeline emits. Clicking
a chip expands the engine's message, the implicated file/symbol, and the
affected file list. Warnings also mark the rail rows they touch.

## 11. Test-scope limitation

When `TEST_FILES_OUTSIDE_INDEX_SCOPE` fires, the warnings shelf explains
that relevant-test analysis may be incomplete — so an empty TEST list is
never presented as "no tests exist".

## 12. Large surface

Above 120 affected plates (`ROLLUP_THRESHOLD`), the rail inserts
deterministic cluster headers — first two path segments, same rule as
Cascade's rollup — grouping plates by subsystem bucket with counts.
Only the selected plate mounts a full DOM tree; rail rows are cheap. No
AI clustering, no dropped plates.

## 13. Live states

- **Analyzing** — the topbar action reads ANALYZING; the previous plate
  stays mounted.
- **Result** — rail updates, plate transitions replay, a propagation
  sweep runs once down the rail, then everything settles.
- **Failure** — an amber `ANALYSIS INTERRUPTED · showing previous valid
  result` strip appears above the plate; the action reads
  `REFRESH · LAST FAILED`; prior data remains.
- **Recovery** — the next authoritative result removes the strip and
  transitions to current data; no reload needed.
- **Fresh load after failure** — `hello.error` (the `lastError` field)
  flags the stale state immediately.

## 14. Motion rules

Motion uses transform/opacity/clip-path only: plate cross-fade with
directional offset, per-character title mask, evidence-hop cascade,
source-line wash, rail pop with a vermilion rule, class-mark draw. No
continuous filters, particles, or physics; the idle interface is still.

## 15. Preloader truthfulness

The preloader (INDEX → GRAPH → DIFF → IMPACT → EVIDENCE) is entrance
choreography only. It reports no real percentages and no engine progress;
its stages complete on a fixed short timeline and it exits only after the
first real `AnalysisResult` has mounted — a live error during boot can
never leave it stuck.

## 16. Reduced motion

`prefers-reduced-motion` collapses all animation to ~1ms and transitions
to ≤130ms, disables the background drift, signal rings, shimmers, and
per-character reveals, and shortens the preloader to a quick fade. The
`usePrefersReducedMotion` hook mirrors the media query in component logic
(delays set to 0 rather than skipped renders).

## 17. Security/privacy

- The server binds `127.0.0.1` only — unchanged.
- Source comes exclusively from `/api/source` with the existing
  repository-path allowlist; `.env`, `.git/config`, `..`, absolute-path
  escapes, and unindexed files remain blocked.
- The background's ambient code ghosts are static generic fragments —
  no repository source feeds decoration.
- No telemetry, no network calls beyond localhost endpoints, no CDN —
  fonts are self-hosted (`@fontsource`).

## 18. Responsive desktop behavior

Desktop-first, verified at 1280×800, 1440×900, 1920×1080, and 3440×1440.
The plate column caps at 1320px and centers on ultrawide; the class mark
hides below 1024px, the right-edge readout below 1280px; the category
tabs scroll horizontally rather than clip key controls.

## 19. Remaining limitations

- No phone-class tuning (desktop-first by design).
- Cluster buckets are path prefixes, not semantic modules.
- Deleted former callers reconstructed from the base graph can be
  approximate (`DELETED_SYMBOL_APPROXIMATED` communicates this).
- References are shown as a flat tail list, not per-symbol threading.
- `import type` consumption produces no runtime plates (by design —
  honest, but a narrow diff can look deceptively quiet).
