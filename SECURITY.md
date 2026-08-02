# Security policy

## Supported versions

Until the project reaches 1.0, security fixes are provided only for the latest published 0.x release.

## Reporting a vulnerability

Do not open an issue for a suspected vulnerability.

- **While the repository is private:** authorized collaborators should contact a maintainer directly through the existing private channel by which repository access was granted.
- **When the repository is public:** use GitHub's confidential [Report a vulnerability](https://github.com/heyjdev/InfraWeft/security/advisories/new) form. The form becomes active during the controlled public cutover; if GitHub does not show it, do not substitute a public issue.

Include affected versions, reproduction steps, impact, and any suggested mitigation. Do not include real cloud credentials, subscription data, topology, or secrets. If sensitive material was exposed, revoke or rotate it before reporting; deleting a message or commit is not sufficient.

## Security boundaries

- The application binds to `127.0.0.1` and is not intended to be exposed to a LAN or the internet.
- Azure discovery and local validation require a cryptographically random per-launch capability token. The launcher transfers it through a private temporary bootstrap file or, with `--no-open`, prints a private URL to the local terminal. The browser removes the token fragment from the address bar and keeps it in tab-scoped session storage.
- Azure discovery uses fixed read-only Azure CLI argument arrays and the current user's existing Azure CLI session.
- The application generates and validates artifacts; it does not run Terraform apply, Bicep deployments, or generated Azure CLI deployment scripts.
- Terraform validation accepts only the pinned `hashicorp/azurerm` provider, rejects modules and provisioners, disables backend/module initialization, uses a restricted provider-installation configuration, and runs with a reduced environment.
- Bicep validation rejects modules, test declarations, extensions/providers, imports, and compile-time file reads; uses `--no-restore`; and isolates home, Azure CLI configuration, extensions, caches, and Bicep configuration in the temporary validation directory.
- Designs and snapshots are stored in browser local storage. Secret values are not part of the design model and are supplied only at deployment time.

A process running as the same operating-system user can generally access that user's files, browser profile, terminal output, and CLI credentials. The capability token prevents unrelated local users and unauthenticated local processes from invoking privileged routes, but it does not defend a compromised account or a process that can read the owning user's browser/session data.
