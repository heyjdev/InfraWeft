# Contributing

The project is preparing for public preview. Keep changes narrow, deterministic, and honest about exporter coverage.

## Development setup

Requirements: Node.js 20+ and npm.

```bash
npm ci
npm run dev
```

Optional tools enable local artifact validation:

- Terraform CLI for Terraform validation
- Azure CLI for Azure discovery and Bicep validation
- Bash for generated Azure CLI script syntax validation

Check capabilities with:

```bash
npm run build
node bin/infraweft.mjs doctor
```

## Required checks

Before submitting a change:

```bash
npm test
npm run lint
npm run build
npm run test:package
npm audit
```

Add regression tests for behavior changes. Exporters must block unsupported or incomplete configurations rather than inventing plausible infrastructure. Never add deployment execution to the validation path.

## Pull requests

Create a focused branch and keep commits reviewable. Describe the behavior, security impact, test evidence, documentation impact, and any generated-artifact or persisted-design compatibility change. Pull requests should pass the repository CI matrix before merge; the repository uses squash merges and signed-off web commits.

Do not commit cloud credentials, real subscription topology, `.env` files, Terraform state, provider binaries, generated package archives, or browser-profile data. Sanitize screenshots and fixtures.

For user-facing changes, update the relevant page under `docs/` and include a screenshot when the workflow is visual. See [Exporters and validation](docs/exporters-and-validation.md) before changing capability claims.

Contributions are accepted under the Apache License 2.0.
