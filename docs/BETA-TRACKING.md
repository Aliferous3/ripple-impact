# v0.2.0-beta.1 — beta tracking

Public/voluntary signals only. Ripple ships **no telemetry** — everything
here comes from public GitHub data or issue reports users chose to file.

## PRE-LAUNCH BASELINE (2026-10-10)

| Signal | Value |
|---|---|
| Stars | 0 |
| Forks | 0 |
| Open issues | 2 (pinned feedback #1 + upstream pydantic crash #2) |
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

## LAUNCH CHECKPOINTS

T0 = the moment the first public post goes live. Record each checkpoint
with one command (run from the repo root, `gh` authenticated):

```sh
gh api repos/Aliferous3/ripple-impact --jq '{stars:.stargazers_count,forks:.forks_count,issues:.open_issues_count}' && \
gh api repos/Aliferous3/ripple-impact/releases --jq '.[]|{tag:.tag_name,dl:[.assets[].download_count]|add}'
```

| Checkpoint | Time | Stars | Forks | Issues | beta.1 dl | v0.1.0 dl | New reports | Notes |
|---|---|---|---|---|---|---|---|---|
| T0 (launch) | — pending first post — | | | | | | | |
| T+6h | | | | | | | | |
| T+24h | | | | | | | | |
| T+48h | | | | | | | | |
| T+72h | | | | | | | | |

Downloads include qualification pulls until organic adoption starts —
note which deltas are ours.

### Post-launch posts log

| Channel | Posted? | URL | Time |
|---|---|---|---|
| Hacker News (Show HN) | no | | |
| Reddit r/python | no | | |
| Reddit r/typescript | no | | |
| Reddit r/programmingtools | no | | |
| LinkedIn | no | | |
| X (post + thread) | no | | |
| Discord/Slack | no | | |

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
