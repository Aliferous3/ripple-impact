# Security policy

## Supported versions

| Version | Status |
|---|---|
| v0.1.0 | Stable — receives security fixes |
| v0.2.0-beta.1 | Prerelease — best-effort fixes land in the next beta |

## Reporting

Ripple is local-first: no telemetry, no accounts, no source upload, and
the explorer binds to 127.0.0.1 only. A regression that sends source or
analysis data off the machine — or that opens the explorer beyond
loopback — is treated as **high severity**.

Please report security/privacy issues **privately first** using GitHub's
[private vulnerability reporting](https://github.com/Aliferous3/ripple-impact/security/advisories/new)
for this repository. Do not post exploit details in a public issue
before the report has been acknowledged.

If private reporting is unavailable to you, open a minimal issue noting
that you have a security report and asking for a private channel — do
not include the details.

## Scope notes

- Ripple indexes your own repository locally with scip-typescript /
  scip-python and a Python `ast` pass. Third-party indexer defects are
  tracked and contained where possible, but report them upstream too.
- Cache data under `.ripple/` is local; it is never transmitted.
