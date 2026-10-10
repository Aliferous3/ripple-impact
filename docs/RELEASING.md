# Releasing Ripple

## Beta release checklist (GitHub Releases)

1. Clean baseline: `npm test`, `npm run typecheck`, `npm run build`,
   `npm run test:e2e`, `npm audit`, `npm pack --dry-run`.
2. Bump `version` in `package.json` (prerelease form `0.1.0-beta.N`).
3. Update `CHANGELOG.md` and `README.md` as needed.
4. Commit: `chore(release): prepare <version>`.
5. `npm pack` → clean-room install the tarball → smoke test
   (`ripple impact`, `ripple explore`).
6. Tag the release-prep commit: `git tag v<version>` → `git push origin
   main v<version>`.
7. Create a GitHub **prerelease** for the tag and attach the exact
   validated `.tgz` — do not rebuild or repack after validation.
8. Verify installation from the release asset URL in a fresh directory.

npm registry publication is a future distribution channel, not a beta
requirement.

## Rollback / remediation

Do **not** delete a published GitHub release asset casually. Prefer
these remediations for a defective beta, in order:

```sh
# 1. Publish a corrected beta — the normal fix path: bump version,
#    tag, and create a new prerelease with the new validated tarball.

# 2. Mark the defective release as a draft or add a warning to its
#    notes (gh):
gh release edit v<bad-version> --draft
gh release edit v<bad-version> --notes "<warning + pointer to fixed release>"

# 3. Last resort — delete the release (the git tag can stay):
gh release delete v<bad-version> --yes
```

If the package is ever published to npm, prefer `npm deprecate` /
`npm dist-tag` fixes over `npm unpublish` — see npm's publish policy.
