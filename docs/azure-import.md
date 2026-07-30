# Azure import

InfraWeft can discover a topology baseline from the Azure subscription selected in the locally installed Azure CLI. Discovery is read-only and never modifies Azure.

## Prerequisites

1. Install Azure CLI.
2. Authenticate locally with `az login`.
3. Select or provide a subscription on which the current identity has at least **Reader** access.
4. Start InfraWeft and select **Import Azure**.

InfraWeft uses the Azure CLI's existing local session. It does not receive, copy, or store Azure credentials.

## Exact discovery scope

The current importer retrieves:

- Virtual networks, including every VNet address prefix.
- VNet peering relationships when both endpoints are present in the imported subscription result.
- Summary records for Application Gateways, Azure Firewalls, NAT Gateways, Virtual Network Gateways, Load Balancers, and Private Endpoints.

The summary records preserve identity, Azure resource ID, resource group, subscription, location, resource kind, and imported/reference status. They do **not** reconstruct complete appliance configuration, nested child resources, subnet or Public-IP associations, NSGs, route tables, backend membership, listeners, probes, rules, policies, or other provider fields.

Accordingly, import is a **topology baseline**, not a complete round-trip representation of the subscription.

## Import and adoption are different

Imported resources begin as local references and remain diagram-only. InfraWeft stores the imported topology as a comparison baseline and can show created, modified, deleted, and unchanged resources as the design changes.

Selecting **Adopt for management** changes local design intent; it does not import Terraform state, modify Azure, or prove that generated code can safely assume ownership of existing resources. Review identifiers, dependencies, lifecycle, and provider-native import/adoption requirements before managing an existing resource.

## Partial discovery

Appliance queries are isolated. If one Azure resource-type query fails, InfraWeft returns the available topology and displays a warning naming the unavailable type. Unsupported Azure resource kinds are omitted with a warning rather than converted into a misleading generic node.

## Privacy

Imported metadata can expose subscription IDs, resource IDs, names, regions, CIDRs, and network relationships. Treat designs, browser profiles, screenshots, logs, and issue attachments as sensitive infrastructure metadata.

## Troubleshooting

- Run `az account show` to verify authentication and the selected account.
- Run `az account list` to confirm the subscription is visible.
- Verify Reader access at the required scope.
- Restart InfraWeft after installing Azure CLI or changing `PATH`.
- Review warnings for resource types that could not be queried.

InfraWeft intentionally does not repair Azure authentication, elevate access, or retry with broader permissions.
