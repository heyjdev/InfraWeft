# Support

InfraWeft is preparing for public preview. Support is currently provided through GitHub issues on a best-effort basis.

## Before opening an issue

1. Use Node.js 20 or newer.
2. Run `node bin/infraweft.mjs doctor` from a source checkout.
3. Run `npm ci`, `npm test`, `npm run lint`, and `npm run build`.
4. Check [Getting started](docs/getting-started.md) and the [User guide](docs/user-guide.md).
5. Remove credentials, tokens, subscription IDs, resource IDs, Terraform state, and private topology from logs and screenshots.

Use the bug-report template for reproducible defects. Feature requests should describe the user workflow and acceptance criteria.

## Security reports

Do not open a public issue for a suspected vulnerability. Follow [SECURITY.md](SECURITY.md).

## Boundaries

InfraWeft generates and validates deployment artifacts; it does not deploy them. Cloud-provider support, workstation setup, and generated infrastructure remain the operator's responsibility.
