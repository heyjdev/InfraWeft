# Azure Network Studio

A local-first visual prototype for designing Azure network topologies, discovering existing topology through an authenticated Azure CLI session, validating IPv4 address spaces, and exporting deterministic infrastructure code.

![Status](https://img.shields.io/badge/status-prototype-0078d4)

## What works

- Drag/move Azure-style resource nodes on a React Flow canvas.
- Add VNets, subnets, Public IPs, Network Security Groups, route tables, NAT Gateways, Application Gateways, Azure Firewalls, VPN Gateways, Load Balancers, Private Endpoints, and Azure Front Door profiles.
- Connect VNets as peerings and create typed subnet-to-NSG, subnet-to-route-table, subnet-to-NAT-Gateway, and NAT-Gateway-to-Public-IP associations.
- Edit documentation-driven AzureRM settings for every resource icon, including grouped scalar controls and reusable nested-block editors for core frontend, backend, subnet, gateway, WAF, BGP, Private Link, DNS, probe, and routing configuration.
- Choose `southcentralus` alongside the other currently curated Azure regions; Front Door is correctly fixed to global scope and subnets inherit region/resource group from their parent VNet.
- See explicit Terraform, Bicep, and Azure CLI capability status and limitations for every resource type in the inspector.
- Reject direct peering connections between overlapping VNet address spaces.
- Flag invalid/non-canonical IPv4 CIDRs and overlapping address spaces on peered VNets; disconnected VNets may intentionally overlap.
- Save versioned design snapshots to browser local storage and restore earlier snapshots.
- Replace the canvas (after explicit confirmation) with a seeded **Random showcase** hub-and-spoke design containing every resource icon, fully populated required blocks, canonical non-overlapping CIDRs, and typed associations. The generated canvas uses an edge-to-internal hierarchy: public resources, VNets, subnets directly beneath their parent VNets, then internal/private resources. Reusing its displayed seed reproduces the same design byte-for-byte.
- Preserve imported Azure state as a local baseline, explicitly adopt it for management, and display created/modified/deleted/unchanged differences.
- Import VNets, every VNet address prefix, bidirectional peering relationships, and common network appliances from an Azure subscription using read-only Azure CLI commands.
- Generate Terraform, Bicep, and Azure CLI for all currently modeled resource scopes, including Application Gateway, Azure Firewall, VPN Gateway, Load Balancer, Private Endpoint, and Front Door profile.
- Edit resources through outlined Properties cards with explicit section headings, field counts, deployment settings, and nested repeatable-block boundaries.
- List every unsupported or underconfigured node in the generated output and UI instead of silently omitting it. Copy/download remain disabled until the selected format can represent the entire design.
- Trace inspector fields to exact generated lines, click generated resource blocks to select their graph node, and map unsupported fields to exact diagnostics.
- Validate generated Terraform (`fmt`, `init -backend=false`, `validate`), Bicep (`az bicep build`), and Azure CLI scripts (`bash -n`) through the loopback-only API. Validation never applies or deploys infrastructure.
- Convert the current VNet peering graph into an Azure Virtual Network Manager deployment. Exact complete graphs infer Mesh; exact stars infer Hub-and-Spoke. Irregular graphs require an explicit topology choice and display the resulting semantic-change warning.
- Generate AVNM Network Manager, static network-group membership, connectivity configuration, and regional commit/deployment artifacts for Terraform, Bicep, and Azure CLI without also emitting competing ordinary VNet peering resources.

## Export capability matrix

| Resource | Terraform | Azure CLI | Bicep | Current scope |
| --- | --- | --- | --- | --- |
| Virtual network | Supported | Supported | Supported | Address spaces and bidirectional peerings |
| Subnet | Supported | Supported | Supported | Prefixes plus typed NSG, route-table, and NAT-Gateway associations |
| Public IP | Supported | Supported | Supported | Allocation, SKU/tier, zones, version, DNS, timeout, and edge zone |
| Network Security Group | Supported | Supported | Supported | NSG plus structured security rules |
| Route table | Supported | Supported | Supported | BGP propagation plus structured routes |
| NAT Gateway | Supported | Supported | Supported | Gateway plus typed subnet and Public-IP associations |
| Azure Front Door | Supported | Supported | Supported | Standard/Premium profile and origin response timeout; endpoints/origins/routes need future child schemas |
| Application Gateway | Supported | Supported | Supported | Core HTTP gateway with frontend/listener/backend/rule/WAF objects; HTTPS blocks until certificate/identity dependencies are modeled |
| Azure Firewall | Supported | Supported | Supported | Parent firewall with VNet/Virtual Hub IP configuration, dedicated Public-IP references, policy ID, DNS, SNAT ranges, zones, and management configuration; generated CLI checks for the `azure-firewall` extension |
| VPN Gateway | Supported | Supported | Supported | Gateway IP configurations, BGP, scaling, and point-to-site/RADIUS fields; CLI uses a runtime environment variable and Bicep uses a secure parameter for the RADIUS secret |
| Load Balancer | Supported | Supported | Supported | Parent frontend configurations, explicit backend pools, probes, and rules; backend membership, NAT and outbound resources remain future graph entities |
| Private Endpoint | Supported | Supported | Supported | Subnet, service connection, DNS-zone group, static IP configuration, and explicit managed or external resource IDs; CLI alias-only targets remain blocked |

“Supported” means the generator emits a complete resource block/command for the modeled scope. It does not imply that unmodeled child resources or attachments are invented. If a visible advanced field is configured but not yet rendered by the selected exporter, export is blocked and names that field explicitly instead of silently dropping it. This is intentional: the exporter favors explicit, reviewable output over plausible-looking but unsafe infrastructure.

## Run locally

Requirements: Node.js 20+ and npm.

```bash
npm install
npm run dev
```

Open <http://127.0.0.1:5173>. The discovery API listens only on `127.0.0.1:8787`.

### Random showcase

Use **Random showcase** in the header, review or edit the proposed seed, and confirm the replacement. A nonempty current canvas is snapshotted automatically, the imported comparison baseline is cleared, and the generated design is persisted locally. Names, CIDRs, and positions vary from safe deterministic catalogs, while the same numeric or text seed always produces the same topology.

The showcase is schema-valid and all 21 generated resource instances are accepted by the Terraform, Bicep, and Azure CLI exporters. Its generated HCL passes `terraform fmt -check` and `terraform validate` against AzureRM v4.81.0, its Bicep passes `az bicep build`, and its Azure CLI output passes `bash -n`. External service dependencies remain conspicuous `{…}` placeholders. Secret references become deployment-time secure parameters or environment variables rather than being serialized into generated Bicep or Bash.

### Azure import

Install the Azure CLI, authenticate, and select an account with **Reader** access:

```bash
az login
az account set --subscription '<subscription-id>'
```

Then use **Import Azure** in the UI. The API executes fixed `az` argument arrays; it does not accept arbitrary commands, store tokens, or send credentials to the browser. Azure CLI's existing local token cache remains the source of authentication. Imported resources remain diagram-only until the user explicitly selects **Adopt for management**; the original imported state remains local as the comparison baseline.

### Azure Virtual Network Manager conversion

Open **Generate**, select **AVNM**, and review the conversion preview before downloading an artifact. AVNM export intentionally targets an **existing** Network Manager rather than creating or updating one: this prevents a name collision from silently replacing its scopes or `Connectivity`, `SecurityAdmin`, or `Routing` access. The manager must be dedicated to this one generated AVNM deployment, include every target VNet subscription in its subscription scope, and have `Connectivity` access. The UI blocks export until that dedicated-manager prerequisite is explicitly acknowledged and until the user either confirms an initial deployment or supplies every previously committed region. This is required because an AVNM regional commit is complete connectivity goal state—not an additive update—and can deactivate configuration IDs omitted from the commit. The AVNM model includes:

- the existing Network Manager name, resource group, and subscription;
- one fingerprinted static-membership network group;
- Mesh or Hub-and-Spoke connectivity, including optional direct spoke connectivity, global mesh, and hub-gateway propagation;
- an explicit choice to retain or delete existing peerings; and
- every target region used by the connectivity deployment/commit; and
- previously committed regions that need an explicit empty commit when removed.

Auto-detection only succeeds when the canvas can be represented exactly as one AVNM connectivity configuration. Self-loops and duplicate peering pairs are rejected. A partial, disconnected, or irregular graph is blocked until Mesh or Hub-and-Spoke is selected explicitly; blocked plans render diagnostics instead of runnable fallback code. An explicit override warns that connectivity will change.

AVNM ConnectedGroup connectivity preserves adjacency intent, not VNet-peering resource identity or unmodeled peering flags such as gateway transit and forwarded traffic. Generated output deliberately disables connected-group address overlap, high-scale private endpoints, and enforced peerings. Existing peer deletion remains off unless selected explicitly.

Terraform references the existing manager through a data source and requires `confirm_dedicated_network_manager=true`. Deployment resources use stable region-keyed Terraform addresses, while static members use stable VNet-identity addresses. Network-group and connectivity-configuration names carry the design fingerprint and use create-before-destroy replacement, so a commit caused by member removal targets a newly reconciled group that cannot still contain the removed VNet. A deterministic fingerprint in `azurerm_network_manager_deployment.triggers` forces the required regional recommit. Stateful Terraform removal of a deployment resource submits the provider's empty regional goal state; stateless Terraform output is blocked when **Previously committed regions** contains a removed region. Use the generated CLI/Bicep workflow for that explicit removal instead.

Bicep and Azure CLI use fingerprinted network-group and connectivity-configuration names so a removed VNet cannot survive in the newly committed group. Their activation workflows query every affected region and refuse a commit if any active connectivity configuration lacks this deployment's stable ownership prefix. Removed regions receive a separate commit with no configuration IDs. Older generated groups/configurations are inert cleanup candidates only after the replacement and removed-region commits succeed. Static-member names include a stable VNet-identity hash to avoid collisions across resource groups and subscriptions.

Azure CLI requires the tested `virtual-network-manager` extension version `3.0.2`; generated scripts check it but never install mutable workstation code. Set `CONFIRM_DEDICATED_NETWORK_MANAGER=true` and `CONFIRM_AVNM_REGION_HISTORY_COMPLETE=true` only after verifying those prerequisites. Fingerprinted CLI objects carry an artifact ownership description, and reruns refuse to overwrite a same-named object without that marker. Bicep requires `confirmDedicatedNetworkManager=true` and `confirmRegionHistoryComplete=true`, references the existing manager, and conditionally creates nothing when the deployment subscription/resource group does not match the configured manager scope. Deploy the Bicep file to the manager's exact subscription and resource group. All formats omit ordinary VNet peering resources and require VNets to exist before AVNM membership is applied.

## Verify

```bash
npm test
npm run lint
npm run build
```

Use **Validate** in the Generate view for local Terraform, Bicep, or Bash validation. Azure deployment validation/what-if still requires credentials and a target subscription and is intentionally not performed by the app.

## Prototype boundaries

This is deliberately not a production deployment portal yet.

- The schema describes expected configuration and honest exporter support; unsupported resource types are visible in generated comments and export diagnostics.
- Generic attachment edges remain informational except that a subnet attached to exactly one VNet can use that VNet as its parent. Supported NSG, route-table, NAT-Gateway, and Public-IP relationships use typed edges and deterministic associations.
- Standard Bicep output targets one resource group. Designs spanning multiple resource groups are blocked for Bicep with an exact diagnostic rather than emitting invalid cross-scope resources. AVNM Bicep treats VNet resource IDs as existing deployment targets and only creates AVNM configuration in the manager resource group.
- AVNM manager bootstrap/adoption, shared-manager goal-state merging, management-group scope, dynamic Policy membership, and automatic cleanup of older fingerprinted configurations are out of scope. The current export requires an existing manager dedicated to one generated deployment, with direct subscription scopes.
- Terraform and Azure CLI output require an explicit subscription ID; imported designs carry it forward automatically.
- Azure import discovers topology; it does not modify the subscription.
- The loopback API validates Host/Origin headers, rate-limits discovery and validation, coalesces concurrent discovery requests, caches topology briefly, caps validation payloads, executes fixed binaries/arguments, uses isolated temporary directories, and never executes generated deployment commands.
- Persisted topology is bounded and validated before use. Generator identifiers are deterministic, HCL strings are JSON-escaped, shell arguments are single-quote escaped, and generated diagnostics are sanitized as comments.
- IPv4 CIDR validation is implemented. IPv6 and Azure-specific subnet reservations are future work.
- Generated output must be reviewed and run through `terraform validate`, `az bicep build`, CLI help/version checks, or a deployment what-if before use.
- LLM-driven design should be added through a provider-neutral tool schema that produces proposed graph mutations; the deterministic validator must remain the final authority.

## Suggested next milestone

Add AVNM dynamic Azure Policy membership, multiple network groups/configurations, routing and security-admin configurations, deployment what-if, and lifecycle-aware removal. Separately, add first-class Load Balancer backend/NAT/outbound resources, Firewall Policy and rule collections, VPN connections and Local Network Gateways, Application Gateway TLS identity/certificate resources, Private DNS zones/links, and the full Front Door hierarchy.
