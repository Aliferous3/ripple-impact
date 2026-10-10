# Releasing Ripple

## Stable release checklist (GitHub Releases)

1. Clean baseline: `npm test`, `npm run typecheck`, `npm run build`,
   `npm run test:e2e`, `npm audit`, `npm audit --omit=dev`,
   `npm pack --dry-run`.
2. Bump `version` in `package.json`; keep `package-lock.json` in sync.
3. Update `CHANGELOG.md` and `README.md` (install URL must match the
   tag and asset filename exactly).
4. Commit: `chore(release): prepare v<version>`.
5. `npm pack` → clean-room install the tarball → smoke test
   (`ripple impact`, `ripple explore`, watcher, Ctrl+C cleanup,
   path-with-spaces).
6. Tag the release-prep commit: `git tag v<version>` — verify
   `git rev-parse HEAD` and `git rev-parse v<version>` match →
   `git push origin main v<version>`.
7. Create the GitHub release for the tag and attach the exact
   validated `.tgz` — do not rebuild or repack after validation.
   Stable releases must not be marked prerelease; betas must be.
8. Verify installation from the release asset URL in a fresh
   directory.

npm registry publication is a future distribution channel, not a
release requirement.

## Rollback / remediation

Do **not** delete a published GitHub release asset casually. Prefer
these remediations for a defective release, in order:

```sh
# 1. Publish a corrected release — the normal fix path: bump version,
#    tag, and create a new release with the new validated tarball.

# 2. Mark the defective release as a draft or add a warning to its
#    notes (gh):
gh release edit v<bad-version> --draft
gh release edit v<bad-version> --notes "<warning + pointer to fixed release>"

# 3. Last resort — delete the release (the git tag can stay):
gh release delete v<bad-version> --yes
```

If the package is ever published to npm, prefer `npm deprecate` /
`npm dist-tag` fixes over `npm unpublish` — see npm's publish policy.

## Post-launch issue triage

Severity guide for incoming reports — triage labels, not SLAs:

- **P0 — security/privacy/data exposure.** Telemetry found, source
  exfiltration, path-traversal escape, credential/private-path leaks in
  artifacts. Drop everything; if a release is affected, apply the
  rollback path above.
- **P1 — broken for everyone.** Crashes, install failures, corrupt or
  fabricated impact results, analyzer can't run on a supported repo.
  Target the next patch release.
- **P2 — bounded correctness.** A false positive or false negative with
  a reproducible sample. Fix in normal order; each fix needs a
  regression test.
- **P3 — everything else.** UX polish, docs gaps, feature requests.
  Discuss before implementing; no roadmap promises in issue replies.
