# Getting started

This guide runs InfraWeft entirely on your workstation. The application serves both its UI and API on the loopback interface; it is not intended to be exposed to a LAN or the internet.

## 1. Install the required tools

Required:

- Node.js 20 or newer
- npm

Optional:

| Tool | Enables |
| --- | --- |
| Terraform CLI | `terraform fmt` and `terraform validate` for generated Terraform |
| Azure CLI | Read-only Azure import and Bicep compilation |
| Bash | Syntax validation for generated Azure CLI scripts |

InfraWeft can design and generate artifacts without the optional tools. The **Validate** and **Import Azure** controls explain missing capabilities when a tool is unavailable.

## 2. Run a production-style source checkout

```bash
git clone https://github.com/heyjdev/InfraWeft.git
cd InfraWeft
npm ci
npm run build
npm start
```

Open <http://127.0.0.1:8787>. The launcher accepts:

```bash
npm start -- --no-open
npm start -- --port 9000
```

Only use a loopback port. Do not reverse-proxy InfraWeft to a network-accessible interface.

## 3. Check workstation capabilities

```bash
node bin/infraweft.mjs doctor
```

The doctor reports Node.js, Terraform, Azure CLI, Bicep, and Bash availability. A missing optional tool is not a startup failure.

## 4. Create the first design

A new browser profile starts with an empty design.

- Drag resources from **Components** onto the canvas.
- Connect compatible handles to create typed relationships.
- Select a node to edit its properties and review exporter capability.
- Use **Random showcase** for a deterministic sample topology.
- Use **Save** to create a named local snapshot.

Designs, imported comparison baselines, showcase preferences, and up to 20 snapshots are stored in browser local storage for the loopback origin.

## Development mode

```bash
npm ci
npm run dev
```

Open <http://127.0.0.1:5173>. Vite proxies `/api` to `127.0.0.1:8787`.

## Azure import prerequisites

Install Azure CLI, authenticate, and choose an account with **Reader** access:

```bash
az login
az account set --subscription '<subscription-id>'
```

Then select **Import Azure**. InfraWeft uses the existing Azure CLI session; it does not receive or store your credentials. Imported cloud metadata can be sensitive. Sanitize screenshots and issue reports.

## Troubleshooting

### The UI opens but validation is unavailable

Run the doctor and install the relevant optional CLI. Restart InfraWeft after changing the workstation `PATH`.

### Port 8787 is already in use

Choose another loopback port:

```bash
npm start -- --port 9000
```

### Azure import fails

Check `az account show`, confirm the selected subscription, and verify Reader access. InfraWeft intentionally cannot repair Azure authentication or elevate permissions.

### A generated artifact cannot be copied or downloaded

The selected exporter found a blocking resource, field, dependency, or cross-scope condition. Open the listed diagnostic and correct the design; InfraWeft does not silently discard unsupported configuration.
