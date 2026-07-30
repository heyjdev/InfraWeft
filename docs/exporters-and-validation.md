# Exporters and validation

InfraWeft generates reviewable infrastructure artifacts. It never applies, deploys, or executes those artifacts.

## Capability semantics

“Supported” means the exporter emits a complete resource block or command for InfraWeft's **modeled scope**. It does not imply every upstream provider field or dependent Azure child resource exists in the model.

Every configured resource and field must be emitted, represented as an explicit external/runtime input, or reported as blocking. Copy and download remain disabled when topology completeness fails.

## Current capability matrix

| Resource | Terraform | Azure CLI | Bicep | Current modeled scope |
| --- | --- | --- | --- | --- |
| Virtual network | Supported | Supported | Supported | Address spaces and bidirectional peerings |
| Subnet | Supported | Supported | Supported | Prefixes plus typed NSG, route-table, and NAT-Gateway associations |
| Public IP | Supported | Supported | Supported | Allocation, SKU/tier, zones, version, DNS, timeout, and edge zone |
| Network Security Group | Supported | Supported | Supported | NSG plus structured security rules |
| Route table | Supported | Supported | Supported | BGP propagation plus structured routes |
| NAT Gateway | Supported | Supported | Supported | Gateway plus typed subnet and Public-IP associations |
| Azure Front Door | Supported | Supported | Supported | Standard/Premium profile and origin response timeout; endpoint/origin/route children are future schemas |
| Application Gateway | Supported | Supported | Supported | Core HTTP gateway objects; HTTPS blocks until certificate and identity dependencies are modeled |
| Azure Firewall | Supported | Supported | Supported | VNet/Virtual Hub IP configuration, Public-IP references, policy ID, DNS, SNAT ranges, zones, and management configuration |
| VPN Gateway | Supported | Supported | Supported | IP configurations, BGP, scaling, and P2S/RADIUS deployment-time inputs |
| Load Balancer | Supported | Supported | Supported | Frontends, backend pools, probes, and rules; membership, NAT, and outbound children remain future graph entities |
| Private Endpoint | Supported | Supported | Supported | Subnet, service connection, DNS-zone group, static IP configuration, and managed/external resource IDs |

## Local validation

| Format | Local check | Important boundary |
| --- | --- | --- |
| Terraform | `terraform fmt`, isolated `terraform init -backend=false`, and `terraform validate` against pinned AzureRM 4.81.0 | No plan or apply; modules, provisioners, other providers, and backends are rejected |
| Bicep | `az bicep build` | No Azure deployment or what-if |
| Azure CLI | `bash -n` plus selected CLI/extension availability checks | Generated deployment commands are never executed |

Validation runs in isolated temporary directories with bounded input and reduced environments. Tool installation can make its own network requests as documented in [PRIVACY.md](../PRIVACY.md).

## Bicep scope

Standard Bicep output targets one resource group. A design spanning multiple resource groups is blocked rather than emitting invalid cross-scope resources. Azure Virtual Network Manager conversion has its own explicit manager scope and guards.

## Azure Virtual Network Manager conversion

Open **Generate**, select **AVNM**, and review the conversion preview. Exact complete peering graphs infer Mesh; exact stars infer Hub-and-Spoke. Irregular, partial, duplicate, or self-looped graphs require correction or an explicit topology decision.

The exporter targets an **existing, dedicated** Network Manager. It does not create or silently alter a same-named manager, its scopes, or access configuration. Export remains blocked until the user acknowledges the dedicated-manager prerequisite and provides complete regional commit history.

Generated Terraform, Bicep, and Azure CLI artifacts use fingerprinted network-group and connectivity-configuration identities, stable member identities, and explicit regional activation. Removed regions require an empty commit because AVNM regional connectivity commits are complete goal state, not additive updates.

The current AVNM scope excludes manager bootstrap/adoption, shared-manager goal-state merging, management-group scope, dynamic Azure Policy membership, routing/security-admin configuration, and automatic cleanup of older fingerprinted configurations.

## External deployment review

Before deployment, run the appropriate native workflow in the target environment:

- Terraform: `terraform plan`
- Bicep: Azure deployment what-if at the exact target scope
- Azure CLI: review the script, runtime inputs, selected account, and extension versions

InfraWeft cannot prove cloud quotas, permissions, policy compliance, external resource existence, service health, or the safety of changes to an already managed environment.
