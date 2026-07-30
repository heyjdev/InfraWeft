# Privacy and local data

This application is local-first. It has no application telemetry, advertising, or hosted account service.

## Data stored locally

The browser stores the current design, imported comparison baseline, showcase settings, and up to 20 snapshots in local storage for the application's loopback origin. These records may contain cloud subscription IDs, resource IDs, resource names, network ranges, and topology. Treat exported browser profiles and backups as sensitive infrastructure metadata.

Secret values are not stored in designs or snapshots. RADIUS secrets are represented only as deployment-time intent; generated Terraform and Bicep use sensitive inputs, and generated Azure CLI scripts require an environment variable. The per-launch local API token is kept in tab-scoped browser session storage and is not included in designs, snapshots, or application telemetry.

Clearing the design removes the current design and imported baseline. Browser site-data controls can remove all application data, including snapshots and preferences.

## External network activity

The application itself does not send design data to a hosted service. User-invoked tools can make their own network requests:

- Azure import calls the locally installed Azure CLI, which communicates with Microsoft Azure using the user's existing session.
- `terraform init` may contact the Terraform Registry to download the pinned `hashicorp/azurerm` provider.
- Bicep validation uses the existing local Bicep binary through Azure CLI with isolated configuration and `--no-restore`. It rejects external modules, test declarations, extensions/providers, imports, and compile-time file reads; if Bicep is unavailable, validation fails rather than installing it.
- Package installation and update checks contact the configured npm registry.

Generated deployment artifacts may contact cloud services when the user runs them outside this application.
