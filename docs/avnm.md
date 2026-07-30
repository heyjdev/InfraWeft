# Azure Virtual Network Manager conversion

InfraWeft can convert a VNet peering graph into Azure Virtual Network Manager (AVNM) connectivity artifacts for Terraform, Bicep, or Azure CLI. AVNM connectivity commits are stateful control-plane operations; review this guide before using the generated output.

## Supported topology inference

- An exact complete graph infers **Mesh**.
- An exact star infers **Hub-and-Spoke**.
- Irregular, partial, duplicate, disconnected, or self-looped graphs are blocked until corrected or explicitly resolved.

An explicit override can change connectivity semantics. InfraWeft displays that change before export.

## Dedicated manager prerequisite

The current exporter targets an **existing Network Manager** rather than creating or updating one. The manager must:

- be dedicated to this generated deployment;
- include every target VNet subscription in its scope; and
- have `Connectivity` access.

This boundary prevents a same-name collision from silently replacing scopes or `Connectivity`, `SecurityAdmin`, or `Routing` access. Export is blocked until the dedicated-manager prerequisite is acknowledged.

## Regional goal state

An AVNM regional connectivity commit is complete goal state, not an additive update. The design therefore records every target region and any previously committed region that must receive an explicit empty commit when removed.

InfraWeft blocks output until the operator confirms an initial deployment or supplies complete regional history. Incomplete history can leave stale connectivity active.

## Generated identity and replacement behavior

Generated artifacts use fingerprinted network-group and connectivity-configuration names plus stable VNet-identity membership names. When membership changes, the new configuration points at a reconciled group that cannot retain removed VNets.

- Terraform uses stable region-keyed deployment resources and activation triggers. Stateful removal submits empty regional goal state; stateless output is blocked when removed-region history requires an explicit workflow.
- Bicep and Azure CLI query affected regions before activation and refuse to commit if unrelated active connectivity configuration would be displaced.
- Removed regions receive a separate commit with no configuration IDs.

Older fingerprinted groups and configurations are cleanup candidates only after replacement and removed-region commits succeed.

## Format-specific requirements

### Terraform

- References the existing manager through a data source.
- Requires `confirm_dedicated_network_manager=true`.
- Uses the pinned AzureRM provider supported by InfraWeft.

### Bicep

- Requires `confirmDedicatedNetworkManager=true` and `confirmRegionHistoryComplete=true`.
- Must be deployed to the manager's exact subscription and resource group.
- Creates nothing when deployment scope does not match the configured manager scope.

### Azure CLI

- Requires tested `virtual-network-manager` extension version `3.0.2`.
- Checks the extension but never installs mutable workstation code.
- Requires `CONFIRM_DEDICATED_NETWORK_MANAGER=true` and `CONFIRM_AVNM_REGION_HISTORY_COMPLETE=true` after manual verification.
- Refuses to overwrite same-named objects without the generated ownership marker.

## Current boundaries

The exporter does not currently provide manager bootstrap/adoption, shared-manager goal-state merging, management-group scope, dynamic Azure Policy membership, routing or security-admin configurations, or automatic cleanup of older fingerprinted objects.

ConnectedGroup connectivity preserves adjacency intent, not VNet-peering resource identity or every peering flag. Existing peering deletion remains disabled unless selected explicitly.

Before deployment, inspect every target subscription, region, manager scope, active connectivity configuration, and generated removal action. Use provider-native plan or what-if tooling in the target environment.
