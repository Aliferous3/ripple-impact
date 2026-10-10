# v0.2.0-beta.1 — beta tracking

Public/voluntary signals only. Ripple ships **no telemetry** — everything
here comes from public GitHub data or issue reports users chose to file.

## PRE-LAUNCH BASELINE (2026-10-10)

| Signal | Value |
|---|---|
| Stars | 0 |
| Forks | 0 |
| Open issues | 1 (the pinned feedback issue itself) |
| v0.1.0 release downloads | 1 |
| v0.2.0-beta.1 release downloads | 2 (both were release qualification — GH asset byte-check + clean-room install, not organic) |

## Quality signals to watch

- **False-positive reports** — "Ripple claimed impact that was not real."
  Highest-signal defect class; each one gets a repro + label
  `false-positive` + P1 triage.
- **False-negative reports** — real static calls Ripple missed beyond
  the documented dynamic-miss list. Label `false-negative`, P2 unless
  systematic.
- **Installation failures** — platform/Node/Python-version matrix gaps.
  Label `installation`.
- **Confirmed bugs** — reproduced defects. Label `confirmed`.
- **Real repositories verified** — repos a human actually ran Ripple
  on (dogfood list in `docs/BETA-DOGFOOD-0.2.md` + user reports).
- **Operating systems verified** — Windows qualified; Linux/macOS
  currently unverified for Python.
- Release downloads (organic deltas only — qualification downloads are
  discounted), stars, issue volume.

## Triage priorities

| Priority | Meaning |
|---|---|
| P0 | Security/privacy — source exposure, non-loopback binding, upload |
| P1 | False runtime claim, corrupt analysis, crash/install blocker, systematic indexing failure |
| P2 | Bounded false negative, unsupported construct, perf issue, wrong warning |
| P3 | UX, docs, feature requests, presentation |

## Repro policy

Semantic bugs become: minimal fixture → failing test → fix → regression
test. No semantic patching from anecdotes — reduce real-user reports to
a repro before touching graph logic.
