# Public repository cutover

InfraWeft stays private until an owner explicitly authorizes the cutover. The repository cannot enable private vulnerability reporting, public branch rules, CodeQL default setup, secret scanning, or push protection on the current private personal plan.

## Prepared controls

The repository already has:

- a clean Git history with the maintainer's GitHub noreply address;
- Apache-2.0 licensing, NOTICE, dependency attribution, and privacy/security/support policies;
- SHA-pinned GitHub Actions with read-only token permissions;
- Dependabot updates, vulnerability alerts, and automated security fixes;
- green Linux, macOS, and Windows CI;
- per-launch authorization for privileged loopback APIs;
- isolated Terraform and Bicep validation;
- a dependency-review workflow that stays skipped while the repository is private.

## Cutover sequence

Run this as one controlled operation. Do not announce the repository between steps.

1. Confirm `main` is clean, synchronized, and green at its current head.
2. Confirm the npm package name and release plan before exposing package metadata.
3. Change repository visibility to public.
4. Run `scripts/public-repo-cutover.sh --apply`.
5. Verify the private-report form opens at <https://github.com/heyjdev/InfraWeft/security/advisories/new>.
6. Verify secret scanning, push protection, CodeQL default setup, and the `Public main protection` ruleset through the GitHub API.
7. Open a harmless draft pull request and confirm all required checks and dependency review run before merging.
8. Re-run the reachable-history scan for personal email and secrets against every public ref.
9. Review the public README, screenshots, topics, issue forms, and package metadata from a signed-out browser.
10. Only then announce the repository or publish the npm package.

The script pins GitHub REST API version `2026-03-10`, creates or updates the named ruleset, and fails unless every requested control is verified after application.

## Controls applied by the script

- GitHub private vulnerability reporting
- Secret scanning
- Secret-scanning push protection
- CodeQL default setup with the default query suite
- GitHub Actions restricted to GitHub-owned actions with full-SHA pinning enforced
- An active `main` ruleset requiring:
  - pull requests;
  - all nine CI matrix checks;
  - dependency review;
  - resolved review conversations;
  - linear history;
  - protection from force pushes and deletion.

The ruleset requires no approving review because this is currently a single-maintainer repository. Pull requests and successful checks are still mandatory.

## Rollback

Visibility can be changed back to private, but publication cannot make disclosed Git objects private again. If any secret or private infrastructure data is found after cutover, rotate it first; changing visibility or deleting a commit is not remediation.

<!-- Public cutover verification: harmless draft PR; do not merge. -->
