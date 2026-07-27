# Azure Network Studio

A local-first visual prototype for designing Azure network topologies, discovering existing topology through an authenticated Azure CLI session, validating IPv4 address spaces, and exporting infrastructure code.

![Status](https://img.shields.io/badge/status-prototype-0078d4)

## What works

- Drag/move Azure-style resource nodes on a React Flow canvas.
- Add VNets, subnets, Application Gateways, NAT Gateways, Azure Firewalls, VPN Gateways, Load Balancers, and Private Endpoints.
- Connect VNets as peerings and attach other resources.
- Edit names, regions, resource groups, and VNet IPv4 CIDRs.
- Reject direct peering connections between overlapping VNet address spaces.
- Flag invalid/non-canonical IPv4 CIDRs and overlapping address spaces on peered VNets; disconnected VNets may intentionally overlap.
- Save designs to browser local storage.
- Import VNets, bidirectional peering relationships, and common network appliances from an Azure subscription using read-only Azure CLI commands.
- Export the deployable VNet/peering layer as Terraform, Bicep, or an Azure CLI Bash script.

## Run locally

Requirements: Node.js 20+ and npm.

```bash
npm install
npm run dev
```

Open <http://127.0.0.1:5173>. The discovery API listens only on `127.0.0.1:8787`.

### Azure import

Install the Azure CLI, authenticate, and select an account with **Reader** access:

```bash
az login
az account set --subscription '<subscription-id>'
```

Then use **Import Azure** in the UI. The API executes fixed `az` argument arrays; it does not accept arbitrary commands, store tokens, or send credentials to the browser. Azure CLI's existing local token cache remains the source of authentication.

## Verify

```bash
npm test
npm run lint
npm run build
```

## Prototype boundaries

This is deliberately not a production deployment portal yet.

- Generated code currently deploys VNets and bidirectional VNet peerings. Appliance nodes are represented in the graph and discovered from Azure, but need subnet/public-IP/routing schemas before their deployment blocks can be generated safely.
- Bicep output targets the subscription scope and supports existing resource groups in that subscription. Mixed-subscription export is blocked.
- Terraform and Azure CLI output require an explicit subscription ID; imported designs carry it forward automatically.
- Azure import discovers topology; it does not modify the subscription.
- IPv4 CIDR validation is implemented. IPv6 and Azure-specific subnet reservations are future work.
- Generated output must be reviewed and run through `terraform validate`, `az bicep build`, or a deployment what-if before use.
- LLM-driven design should be added through a provider-neutral tool schema that produces proposed graph mutations; the deterministic validator must remain the final authority.

## Suggested next milestone

Add first-class subnet nodes and attachment constraints, then generate complete deployment blocks for NAT Gateway, Azure Firewall, and Application Gateway. After that, add a backend what-if/plan runner and a provider-neutral LLM adapter.
