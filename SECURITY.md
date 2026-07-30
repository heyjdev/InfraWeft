# Security policy

## Supported versions

Until the project reaches 1.0, security fixes are provided only for the latest published 0.x release.

## Reporting a vulnerability

Do not open an issue for a suspected vulnerability.

- **While the repository is private:** authorized collaborators should contact a maintainer directly through the existing private channel by which repository access was granted.
- **Before public release:** repository maintainers will enable GitHub private vulnerability reporting and update this policy with the active reporting path.

Include affected versions, reproduction steps, impact, and any suggested mitigation. Do not include real cloud credentials, subscription data, topology, or secrets. If sensitive material was exposed, revoke or rotate it before reporting; deleting a message or commit is not sufficient.

## Security boundaries

- The application binds to `127.0.0.1` and is not intended to be exposed to a LAN or the internet.
- Azure discovery uses fixed read-only Azure CLI argument arrays and the current user's existing Azure CLI session.
- The application generates and validates artifacts; it does not run Terraform apply, Bicep deployments, or generated Azure CLI deployment scripts.
- Terraform validation accepts only the pinned `hashicorp/azurerm` provider, rejects modules and provisioners, disables backend/module initialization, uses a restricted provider-installation configuration, and runs with a reduced environment.
- Designs and snapshots are stored in browser local storage. Secret values are not part of the design model and are supplied only at deployment time.

A process already running as the same operating-system user can generally access that user's files, browser profile, and CLI credentials. Loopback restrictions do not defend against a fully compromised local account.
