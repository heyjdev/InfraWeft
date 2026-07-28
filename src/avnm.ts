import type { ExportFormat } from './generators'
import { addressSpacesFor, nodesOverlap, parseCidr, type NetworkDesign, type NetworkEdge, type NetworkNode } from './model'

export type AvnmTopologyChoice = 'auto' | 'Mesh' | 'HubAndSpoke'
export type AvnmTopology = Exclude<AvnmTopologyChoice, 'auto'>
export type AvnmSettings = {
  networkManagerName: string
  managerResourceGroup: string
  managerLocation: string
  managerSubscriptionId: string
  networkGroupName: string
  connectivityConfigurationName: string
  deploymentRegions: string[]
  previousDeploymentRegions: string[]
  topology: AvnmTopologyChoice
  hubVnetId: string
  directSpokeConnectivity: boolean
  globalMesh: boolean
  useHubGateway: boolean
  deleteExistingPeerings: boolean
  confirmDedicatedManager: boolean
  confirmInitialDeployment: boolean
}

export type AvnmPlan = {
  settings: AvnmSettings
  topology?: AvnmTopology
  vnets: NetworkNode[]
  members: NetworkNode[]
  hub?: NetworkNode
  subscriptionIds: string[]
  deploymentRegions: string[]
  removedDeploymentRegions: string[]
  warnings: string[]
  errors: string[]
}

export function defaultAvnmSettings(): AvnmSettings {
  return {
    networkManagerName: 'avnm-network-studio',
    managerResourceGroup: 'rg-avnm',
    managerLocation: 'eastus',
    managerSubscriptionId: '',
    networkGroupName: 'ng-managed-vnets',
    connectivityConfigurationName: 'cc-network-studio',
    deploymentRegions: [],
    previousDeploymentRegions: [],
    topology: 'auto',
    hubVnetId: '',
    directSpokeConnectivity: false,
    globalMesh: false,
    useHubGateway: false,
    deleteExistingPeerings: false,
    confirmDedicatedManager: false,
    confirmInitialDeployment: false,
  }
}

const unique = <T,>(values: T[]) => [...new Set(values)]
const hcl = (value: string) => JSON.stringify(value)
const bicep = (value: string) => `'${value.replaceAll("'", "''")}'`
const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const tfName = (value: string) => value.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^([0-9])/, '_$1').slice(0, 70) || 'resource'
const bool = (value: boolean) => value ? 'true' : 'false'
const armBool = (value: boolean) => value ? 'True' : 'False'
const guidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const resourceIdSubscriptionFromNode = (node: NetworkNode) => node.id.match(/^\/subscriptions\/([^/]+)/i)?.[1] || ''
const subscriptionFromNode = (node: NetworkNode) => resourceIdSubscriptionFromNode(node) || String(node.data.subscriptionId || '')
const stableHash = (value: string) => {
  const hashWithSeed = (seed: number) => {
    let hash = seed
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(36).padStart(7, '0')
  }
  return `${hashWithSeed(0x811c9dc5)}${hashWithSeed(0x9e3779b9)}`.slice(0, 12)
}
const vnetIdentity = (node: NetworkNode) => node.id.toLowerCase().startsWith('/subscriptions/')
  ? node.id.toLowerCase()
  : `/subscriptions/${subscriptionFromNode(node)}/resourcegroups/${String(node.data.resourceGroup || 'rg-network').toLowerCase()}/providers/microsoft.network/virtualnetworks/${node.data.label.toLowerCase()}`
const staticMemberName = (node: NetworkNode) => {
  const slug = node.data.label.toLowerCase().replace(/[^0-9a-z_.-]/g, '-').slice(0, 58) || 'vnet'
  return `sm-${slug}-${stableHash(vnetIdentity(node))}`.slice(0, 80)
}
const planFingerprint = (plan: AvnmPlan) => stableHash(JSON.stringify({
  topology: plan.topology,
  members: plan.members.map(vnetIdentity).sort(),
  hub: plan.hub ? vnetIdentity(plan.hub) : '',
  directSpokeConnectivity: plan.settings.directSpokeConnectivity,
  globalMesh: plan.settings.globalMesh,
  useHubGateway: plan.settings.useHubGateway,
  deleteExistingPeerings: plan.settings.deleteExistingPeerings,
  deploymentRegions: [...plan.deploymentRegions].sort(),
}))
const versionedName = (base: string, plan: AvnmPlan) => `${base.slice(0, 67)}-${planFingerprint(plan)}`
const ownershipPrefix = (plan: AvnmPlan) => `Azure Network Studio owner ${stableHash(JSON.stringify({
  managerSubscriptionId: plan.settings.managerSubscriptionId.toLowerCase(),
  managerResourceGroup: plan.settings.managerResourceGroup.toLowerCase(),
  networkManagerName: plan.settings.networkManagerName.toLowerCase(),
  networkGroupName: plan.settings.networkGroupName.toLowerCase(),
  connectivityConfigurationName: plan.settings.connectivityConfigurationName.toLowerCase(),
}))}`
const artifactDescription = (plan: AvnmPlan) => `${ownershipPrefix(plan)} artifact ${planFingerprint(plan)}`
const peeringEdges = (edges: NetworkEdge[], vnetIds: Set<string>) => edges.filter((edge) => edge.data?.kind === 'peering' && vnetIds.has(edge.source) && vnetIds.has(edge.target))

function graphShape(vnets: NetworkNode[], edges: NetworkEdge[]) {
  const ids = new Set(vnets.map((node) => node.id))
  const pairs = new Map<string, [string, string]>()
  const selfLoops: NetworkEdge[] = []
  const duplicates: NetworkEdge[] = []
  for (const edge of peeringEdges(edges, ids)) {
    if (edge.source === edge.target) { selfLoops.push(edge); continue }
    const pair = [edge.source, edge.target].sort() as [string, string]
    const key = JSON.stringify(pair)
    if (pairs.has(key)) duplicates.push(edge)
    else pairs.set(key, pair)
  }
  const degree = new Map(vnets.map((node) => [node.id, 0]))
  for (const [left, right] of pairs.values()) {
    degree.set(left, (degree.get(left) ?? 0) + 1)
    degree.set(right, (degree.get(right) ?? 0) + 1)
  }
  const complete = vnets.length >= 2 && pairs.size === (vnets.length * (vnets.length - 1)) / 2
  const hubs = vnets.filter((node) => degree.get(node.id) === vnets.length - 1)
  const exactStar = vnets.length >= 3 && pairs.size === vnets.length - 1 && hubs.length === 1 && vnets.filter((node) => node.id !== hubs[0].id).every((node) => degree.get(node.id) === 1)
  return { pairs, degree, complete, exactStar, inferredHub: exactStar ? hubs[0] : undefined, selfLoops, duplicates }
}

export function buildAvnmPlan(design: NetworkDesign, settings: AvnmSettings): AvnmPlan {
  const vnets = design.nodes.filter((node) => node.data.kind === 'vnet')
  const warnings: string[] = []
  const errors: string[] = []
  const shape = graphShape(vnets, design.edges)
  if (shape.selfLoops.length) errors.push('AVNM conversion rejects self-loop peering edges.')
  if (shape.duplicates.length) errors.push('AVNM conversion rejects duplicate peering pairs.')
  if (vnets.length < 2) errors.push('AVNM connectivity requires at least two virtual networks.')
  if (!/^[0-9A-Za-z](?:[0-9A-Za-z_.-]{0,62}[0-9A-Za-z_])?$/.test(settings.networkManagerName)) errors.push('Network Manager name is invalid or longer than 64 characters.')
  if (!/^[0-9A-Za-z_.()-]{1,90}$/.test(settings.managerResourceGroup) || settings.managerResourceGroup.endsWith('.')) errors.push('The existing Network Manager resource-group name is invalid.')
  if (!/^[0-9A-Za-z_.-]{1,67}$/.test(settings.networkGroupName)) errors.push('Network-group name prefix is invalid or longer than 67 characters.')
  if (!/^[0-9A-Za-z_.-]{1,67}$/.test(settings.connectivityConfigurationName)) errors.push('Connectivity-configuration name prefix is invalid or longer than 67 characters.')
  if (settings.managerSubscriptionId && !guidPattern.test(settings.managerSubscriptionId)) errors.push('Manager subscription ID must be a GUID.')
  if (!settings.confirmDedicatedManager) errors.push('Confirm that this Network Manager is dedicated to this generated AVNM deployment. AVNM regional commits replace the complete connectivity goal state.')
  let topology: AvnmTopology | undefined
  let hub: NetworkNode | undefined
  if (settings.topology === 'auto') {
    if (shape.complete) topology = 'Mesh'
    else if (shape.exactStar) { topology = 'HubAndSpoke'; hub = shape.inferredHub }
    else if (vnets.length >= 2) errors.push('The peering graph cannot be represented exactly as one AVNM Mesh or HubAndSpoke configuration. Select a topology explicitly to acknowledge the connectivity change.')
  } else topology = settings.topology
  if (topology === 'Mesh' && !shape.complete) warnings.push('The selected Mesh topology adds connectivity between VNet pairs that are not directly peered in the canvas.')
  const vnetRegions = unique(vnets.map((node) => String(node.data.region || settings.managerLocation)).filter(Boolean))
  if (topology === 'Mesh' && vnetRegions.length > 1 && !settings.globalMesh) errors.push('Enable global mesh to preserve Mesh adjacency across multiple VNet regions.')
  if (topology === 'HubAndSpoke') {
    hub = vnets.find((node) => node.id === settings.hubVnetId) ?? hub ?? shape.inferredHub
    if (!hub) errors.push('Select a hub virtual network for HubAndSpoke connectivity.')
    else if (!shape.exactStar || shape.inferredHub?.id !== hub.id) warnings.push('The selected HubAndSpoke topology does not exactly match the current peering graph and will change connectivity when committed.')
    if (settings.directSpokeConnectivity) warnings.push('Direct spoke connectivity creates a connected group between spokes in addition to hub peerings.')
    if (settings.useHubGateway) warnings.push('Hub gateway propagation requires a compatible gateway in the selected hub VNet.')
  }
  warnings.push('AVNM preserves adjacency intent with ConnectedGroup connectivity; it does not preserve VNet peering resource identity or unmodeled peering flags.')
  if (settings.deleteExistingPeerings) warnings.push('Existing VNet peerings in the affected scope may be removed during AVNM deployment.')
  else warnings.push('Existing peerings are retained where Azure permits; review for conflicts before committing AVNM connectivity.')
  if (settings.useHubGateway && topology !== 'HubAndSpoke') warnings.push('Use hub gateway is ignored unless the topology is HubAndSpoke.')
  const identities = new Set<string>()
  for (const node of vnets) {
    const identity = vnetIdentity(node)
    if (identities.has(identity)) errors.push(`${node.data.label}: duplicate VNet deployment identity.`)
    identities.add(identity)
    if (!/^[0-9A-Za-z](?:[0-9A-Za-z_.-]{0,62}[0-9A-Za-z_])?$/.test(node.data.label)) errors.push(`${node.data.label || node.id}: VNet name is invalid or longer than 64 characters.`)
    const resourceGroup = String(node.data.resourceGroup || 'rg-network')
    if (!/^[0-9A-Za-z_.()-]{1,90}$/.test(resourceGroup) || resourceGroup.endsWith('.')) errors.push(`${node.data.label}: resource-group name is invalid.`)
    const embeddedSubscriptionId = resourceIdSubscriptionFromNode(node)
    const metadataSubscriptionId = String(node.data.subscriptionId || '')
    if (embeddedSubscriptionId && metadataSubscriptionId && embeddedSubscriptionId.toLowerCase() !== metadataSubscriptionId.toLowerCase()) errors.push(`${node.data.label}: subscription metadata does not match its resource ID.`)
    const subscriptionId = subscriptionFromNode(node)
    if (subscriptionId && !guidPattern.test(subscriptionId)) errors.push(`${node.data.label}: subscription ID must be a GUID.`)
    const prefixes = addressSpacesFor(node)
    if (!prefixes.length) errors.push(`${node.data.label}: at least one IPv4 address prefix is required.`)
    for (const prefix of prefixes) {
      const parsed = parseCidr(prefix)
      if (!parsed || parsed.prefix < 2 || parsed.prefix > 29) errors.push(`${node.data.label}: ${prefix} is not a deployable Azure VNet prefix (/2 through /29).`)
    }
  }
  const connectedPairs: Array<[NetworkNode, NetworkNode]> = []
  if (topology === 'Mesh') {
    for (let left = 0; left < vnets.length; left++) for (let right = left + 1; right < vnets.length; right++) connectedPairs.push([vnets[left], vnets[right]])
  } else if (topology === 'HubAndSpoke' && hub) {
    const spokes = vnets.filter((node) => node.id !== hub!.id)
    for (const spoke of spokes) connectedPairs.push([hub, spoke])
    if (settings.directSpokeConnectivity) for (let left = 0; left < spokes.length; left++) for (let right = left + 1; right < spokes.length; right++) connectedPairs.push([spokes[left], spokes[right]])
  }
  for (const [left, right] of connectedPairs) if (nodesOverlap(left, right)) errors.push(`${left.data.label} overlaps ${right.data.label}; AVNM address-overlap support is deliberately disabled in generated configurations.`)
  const subscriptionIds = unique(vnets.map(subscriptionFromNode).filter(Boolean))
  if (subscriptionIds.length) warnings.push(`Existing Network Manager prerequisite: Connectivity access and direct subscription scope for ${subscriptionIds.join(', ')}.`)
  else warnings.push('Existing Network Manager prerequisite: Connectivity access and subscription scope for every target VNet; IDs will be supplied at deployment.')
  const deploymentRegions = unique((settings.deploymentRegions.length ? settings.deploymentRegions : vnets.map((node) => String(node.data.region || settings.managerLocation))).filter(Boolean))
  const previousDeploymentRegions = unique(settings.previousDeploymentRegions.filter(Boolean))
  const removedDeploymentRegions = previousDeploymentRegions.filter((region) => !deploymentRegions.includes(region))
  if (!previousDeploymentRegions.length && !settings.confirmInitialDeployment) errors.push('Confirm this is the initial deployment, or provide every previously committed region so removed regions can be cleared.')
  if (previousDeploymentRegions.length && settings.confirmInitialDeployment) errors.push('Initial-deployment confirmation cannot be combined with previously committed regions.')
  if (!/^[a-z0-9]+$/.test(settings.managerLocation)) errors.push('Manager location must be an Azure region slug.')
  if (!deploymentRegions.length) errors.push('At least one deployment region is required.')
  for (const region of [...deploymentRegions, ...previousDeploymentRegions]) if (!/^[a-z0-9]+$/.test(region)) errors.push(`${region}: deployment region must be an Azure region slug.`)
  if (removedDeploymentRegions.length) warnings.push(`Removed deployment regions require an explicit empty connectivity commit: ${removedDeploymentRegions.join(', ')}.`)
  const members = topology === 'HubAndSpoke' && hub ? vnets.filter((node) => node.id !== hub!.id) : vnets
  if (topology === 'HubAndSpoke' && !members.length) errors.push('HubAndSpoke requires at least one spoke VNet.')
  return { settings, topology, vnets, members, hub, subscriptionIds, deploymentRegions, removedDeploymentRegions, warnings: unique(warnings), errors: unique(errors) }
}

function terraformSubscriptionExpression(id: string) {
  return id ? hcl(`/subscriptions/${id}`) : 'format("/subscriptions/%s", var.manager_subscription_id)'
}
function terraformVnetId(node: NetworkNode) {
  if (node.id.toLowerCase().startsWith('/subscriptions/')) return hcl(node.id)
  const subscriptionId = subscriptionFromNode(node)
  const subscription = subscriptionId ? hcl(subscriptionId) : 'var.manager_subscription_id'
  return `format("/subscriptions/%s/resourceGroups/%s/providers/Microsoft.Network/virtualNetworks/%s", ${subscription}, ${hcl(String(node.data.resourceGroup || 'rg-network'))}, ${hcl(node.data.label)})`
}
function bicepVnetId(node: NetworkNode) {
  if (node.id.toLowerCase().startsWith('/subscriptions/')) return bicep(node.id)
  const subscription = subscriptionFromNode(node) ? bicep(subscriptionFromNode(node)) : 'managerSubscriptionId'
  return `resourceId(${subscription}, ${bicep(String(node.data.resourceGroup || 'rg-network'))}, 'Microsoft.Network/virtualNetworks', ${bicep(node.data.label)})`
}
const terraformStaticMemberLabel = (node: NetworkNode) => `member_${tfName(node.data.label)}_${stableHash(vnetIdentity(node))}`

function terraform(plan: AvnmPlan) {
  const { settings, topology, members, hub, deploymentRegions, subscriptionIds } = plan
  const networkGroupName = versionedName(settings.networkGroupName, plan)
  const connectivityConfigurationName = versionedName(settings.connectivityConfigurationName, plan)
  const sortedDeploymentRegions = [...deploymentRegions].sort()
  const sortedMembers = [...members].sort((left, right) => vnetIdentity(left).localeCompare(vnetIdentity(right)))
  const memberBlocks = sortedMembers.map((node) => `resource "azurerm_network_manager_static_member" "${terraformStaticMemberLabel(node)}" {
  name                      = ${hcl(staticMemberName(node))}
  network_group_id          = azurerm_network_manager_network_group.managed.id
  target_virtual_network_id = ${terraformVnetId(node)}
}`).join('\n\n')
  const groupConnectivity = topology === 'Mesh' || settings.directSpokeConnectivity ? 'DirectlyConnected' : 'None'
  const groupGlobalMesh = settings.globalMesh && groupConnectivity === 'DirectlyConnected'
  const groupUseHubGateway = topology === 'HubAndSpoke' && settings.useHubGateway
  const requiredSubscriptionExpressions = (subscriptionIds.length ? subscriptionIds.map(terraformSubscriptionExpression) : [terraformSubscriptionExpression('')]).join(', ')
  const targetExpressions = sortedMembers.map(terraformVnetId).join(', ')
  const commitFingerprint = `sha256(jsonencode({ topology = ${hcl(topology || '')}, group_connectivity = ${hcl(groupConnectivity)}, global_mesh = ${bool(settings.globalMesh)}, group_global_mesh = ${bool(groupGlobalMesh)}, use_hub_gateway = ${bool(groupUseHubGateway)}, delete_existing_peerings = ${bool(settings.deleteExistingPeerings)}, hub_id = ${hub ? terraformVnetId(hub) : 'null'}, target_virtual_network_ids = [${targetExpressions}], deployment_regions = [${sortedDeploymentRegions.map(hcl).join(', ')}] }))`
  const hubBlock = topology === 'HubAndSpoke' && hub ? `
  hub {
    resource_id   = ${terraformVnetId(hub)}
    resource_type = "Microsoft.Network/virtualNetworks"
  }` : ''
  const deployments = sortedDeploymentRegions.map((region) => `resource "azurerm_network_manager_deployment" "connectivity_${tfName(region)}" {
  network_manager_id = data.azurerm_network_manager.main.id
  location           = ${hcl(region)}
  scope_access       = "Connectivity"
  configuration_ids  = [azurerm_network_manager_connectivity_configuration.main.id]
  triggers = {
    configuration = local.avnm_commit_fingerprint
  }
  depends_on = [${sortedMembers.map((node) => `azurerm_network_manager_static_member.${terraformStaticMemberLabel(node)}`).join(', ')}]
}`).join('\n\n')
  return `# Azure Virtual Network Manager connectivity deployment generated by Azure Network Studio.
# Deploy the VNets first. Do not manage the same connectivity with azurerm_virtual_network_peering.
# WARNING: an AVNM connectivity deployment may modify existing VNet peerings.
# SAFETY: each regional AVNM commit is complete goal state, not an additive update.
# Use only a manager dedicated to this generated AVNM deployment.
terraform {
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.81" }
  }
}

variable "manager_subscription_id" {
  description = "Subscription that contains Azure Virtual Network Manager"
  type        = string${settings.managerSubscriptionId ? `\n  default     = ${hcl(settings.managerSubscriptionId)}` : ''}
}

variable "confirm_dedicated_network_manager" {
  description = "Explicit confirmation that this manager has no connectivity deployments unrelated to this generated artifact"
  type        = bool

  validation {
    condition     = var.confirm_dedicated_network_manager
    error_message = "AVNM commits replace complete regional connectivity goal state. Confirm a dedicated Network Manager with -var='confirm_dedicated_network_manager=true'."
  }
}

variable "confirm_region_history_complete" {
  description = "Confirms this is the initial deployment or every previously committed region was supplied"
  type        = bool

  validation {
    condition     = var.confirm_region_history_complete
    error_message = "Confirm complete AVNM region history with -var='confirm_region_history_complete=true'."
  }
}

provider "azurerm" {
  features {}
  subscription_id = var.manager_subscription_id
}

data "azurerm_network_manager" "main" {
  name                = ${hcl(settings.networkManagerName)}
  resource_group_name = ${hcl(settings.managerResourceGroup)}
}

locals {
  required_subscription_ids = [${requiredSubscriptionExpressions}]
  avnm_commit_fingerprint   = ${commitFingerprint}
}

resource "azurerm_network_manager_network_group" "managed" {
  name               = ${hcl(networkGroupName)}
  network_manager_id = data.azurerm_network_manager.main.id
  member_type        = "VirtualNetwork"
  description        = "Static VNet membership generated from the visual design"

  lifecycle {
    create_before_destroy = true

    precondition {
      condition     = contains(data.azurerm_network_manager.main.scope_accesses, "Connectivity")
      error_message = "The existing Network Manager must have Connectivity scope access."
    }
    precondition {
      condition     = alltrue([for subscription_id in local.required_subscription_ids : contains(one(data.azurerm_network_manager.main.scope).subscription_ids, subscription_id)])
      error_message = "The existing Network Manager subscription scope does not include every target VNet subscription."
    }
  }
}

${memberBlocks}

resource "azurerm_network_manager_connectivity_configuration" "main" {
  name                                    = ${hcl(connectivityConfigurationName)}
  network_manager_id                      = data.azurerm_network_manager.main.id
  description                             = ${hcl(artifactDescription(plan))}
  connectivity_topology                   = ${hcl(topology || 'Mesh')}
  delete_existing_peering_enabled         = ${bool(settings.deleteExistingPeerings)}
  global_mesh_enabled                     = ${bool(settings.globalMesh)}
  connected_group_address_overlap_enabled = false
  connected_group_private_endpoints_scale = "Standard"
  peering_enforcement_enabled             = false
  applies_to_group {
    group_connectivity  = ${hcl(groupConnectivity)}
    network_group_id    = azurerm_network_manager_network_group.managed.id
    global_mesh_enabled = ${bool(groupGlobalMesh)}
    use_hub_gateway     = ${bool(groupUseHubGateway)}
  }${hubBlock}

  lifecycle {
    create_before_destroy = true
  }
}

${deployments}
`
}

function bicepOutput(plan: AvnmPlan) {
  const { settings, topology, members, hub, deploymentRegions, removedDeploymentRegions, subscriptionIds } = plan
  const requiredSubscriptionScopes = subscriptionIds.length ? subscriptionIds.map((id) => bicep(`/subscriptions/${id}`)) : ["'/subscriptions/${managerSubscriptionId}'"]
  const networkGroupName = versionedName(settings.networkGroupName, plan)
  const connectivityConfigurationName = versionedName(settings.connectivityConfigurationName, plan)
  const memberBlocks = members.map((node, index) => `resource staticMember${index} 'Microsoft.Network/networkManagers/networkGroups/staticMembers@2025-01-01' = if (managerDeploymentScopeMatches) {
  parent: networkGroup
  name: ${bicep(staticMemberName(node))}
  properties: {
    resourceId: ${bicepVnetId(node)}
  }
}`).join('\n\n')
  const groupConnectivity = topology === 'Mesh' || settings.directSpokeConnectivity ? 'DirectlyConnected' : 'None'
  const groupGlobalMesh = settings.globalMesh && groupConnectivity === 'DirectlyConnected'
  const groupUseHubGateway = topology === 'HubAndSpoke' && settings.useHubGateway
  const hubProperty = topology === 'HubAndSpoke' && hub ? `
    hubs: [
      {
        resourceId: ${bicepVnetId(hub)}
        resourceType: 'Microsoft.Network/virtualNetworks'
      }
    ]` : '\n    hubs: []'
  const defaultSubscription = settings.managerSubscriptionId ? ` = ${bicep(settings.managerSubscriptionId)}` : ''
  const affectedDeploymentRegions = unique([...deploymentRegions, ...removedDeploymentRegions])
  const removedRegionCommit = removedDeploymentRegions.length ? `
// Clear connectivity goal state from regions removed since the previous deployment:
// az network manager post-commit --subscription "$MANAGER_SUBSCRIPTION_ID" --resource-group ${shell(settings.managerResourceGroup)} --name ${shell(settings.networkManagerName)} --commit-type Connectivity --target-locations ${removedDeploymentRegions.map(shell).join(' ')}` : ''
  return `targetScope = 'resourceGroup'

// Azure Virtual Network Manager configuration generated by Azure Network Studio.
// Deploy the VNets first. This template intentionally emits no ordinary VNet peering resources.
// This artifact requires an existing Network Manager. It never updates manager scopes or access types.
// SAFETY: AVNM commits replace complete regional connectivity goal state; use a manager dedicated to this generated deployment only.
// Group and configuration names include a design fingerprint so removed members cannot remain active after recommit.
// Deploy with: az deployment group create --subscription "$MANAGER_SUBSCRIPTION_ID" --resource-group ${shell(settings.managerResourceGroup)} --template-file avnm.bicep --parameters confirmDedicatedNetworkManager=true confirmRegionHistoryComplete=true
param managerSubscriptionId string${defaultSubscription}
@allowed([true])
@description('Confirms this manager has no connectivity deployments unrelated to this generated artifact')
param confirmDedicatedNetworkManager bool
@allowed([true])
@description('Confirms this is the initial deployment or every previously committed region was supplied')
param confirmRegionHistoryComplete bool
param deploymentRegions array = [${deploymentRegions.map((region) => `\n  ${bicep(region)}`).join('')}\n]
var managerDeploymentScopeMatches = subscription().subscriptionId == managerSubscriptionId && toLower(resourceGroup().name) == toLower(${bicep(settings.managerResourceGroup)})

resource networkManager 'Microsoft.Network/networkManagers@2025-01-01' existing = {
  name: ${bicep(settings.networkManagerName)}
}

resource networkGroup 'Microsoft.Network/networkManagers/networkGroups@2025-01-01' = if (managerDeploymentScopeMatches) {
  parent: networkManager
  name: ${bicep(networkGroupName)}
  properties: {
    description: 'Static VNet membership generated from the visual design'
    memberType: 'VirtualNetwork'
  }
}

${memberBlocks}

resource connectivityConfiguration 'Microsoft.Network/networkManagers/connectivityConfigurations@2025-01-01' = if (managerDeploymentScopeMatches) {
  parent: networkManager
  name: ${bicep(connectivityConfigurationName)}
  properties: {
    description: ${bicep(artifactDescription(plan))}
    connectivityCapabilities: {
      connectedGroupAddressOverlap: 'Disallowed'
      connectedGroupPrivateEndpointsScale: 'Standard'
      peeringEnforcement: 'Unenforced'
    }
    connectivityTopology: ${bicep(topology || 'Mesh')}
    deleteExistingPeering: ${bicep(armBool(settings.deleteExistingPeerings))}
    isGlobal: ${bicep(armBool(settings.globalMesh))}
    appliesToGroups: [
      {
        networkGroupId: networkGroup.id
        groupConnectivity: ${bicep(groupConnectivity)}
        isGlobal: ${bicep(armBool(groupGlobalMesh))}
        useHubGateway: ${bicep(armBool(groupUseHubGateway))}
      }
    ]${hubProperty}
  }
}

output connectivityConfigurationId string = managerDeploymentScopeMatches ? connectivityConfiguration.id : ''
output managerDeploymentScopeValid bool = managerDeploymentScopeMatches
output dedicatedManagerConfirmed bool = confirmDedicatedNetworkManager
output regionHistoryConfirmed bool = confirmRegionHistoryComplete
output deploymentRegionsToCommit array = deploymentRegions
output removedDeploymentRegionsToClear array = [${removedDeploymentRegions.map((region) => `\n  ${bicep(region)}`).join('')}\n]
output existingManagerSubscriptionScope string = '/subscriptions/\${managerSubscriptionId}'
output requiredManagerSubscriptionScopes array = [${requiredSubscriptionScopes.map((scope) => `\n  ${scope}`).join('')}\n]

// Activation is an explicit operation, not a declarative Bicep resource:
// ACTIVE_COUNT=$(az network manager list-active-connectivity-config --subscription "$MANAGER_SUBSCRIPTION_ID" --resource-group ${shell(settings.managerResourceGroup)} --network-manager-name ${shell(settings.networkManagerName)} --regions ${affectedDeploymentRegions.map(shell).join(' ')} --query 'length(value)' -o tsv)
// OWNED_COUNT=$(az network manager list-active-connectivity-config --subscription "$MANAGER_SUBSCRIPTION_ID" --resource-group ${shell(settings.managerResourceGroup)} --network-manager-name ${shell(settings.networkManagerName)} --regions ${affectedDeploymentRegions.map(shell).join(' ')} --query "length(value[?description != null && starts_with(description, '${ownershipPrefix(plan)}')])" -o tsv)
// test "$ACTIVE_COUNT" = "$OWNED_COUNT" || { echo 'Refusing complete goal-state commit: unrelated active connectivity configuration detected.' >&2; exit 1; }
// CONFIG_ID=$(az network manager connect-config show --subscription "$MANAGER_SUBSCRIPTION_ID" --resource-group ${shell(settings.managerResourceGroup)} --network-manager-name ${shell(settings.networkManagerName)} --configuration-name ${shell(connectivityConfigurationName)} --query id -o tsv)
// az network manager post-commit --subscription "$MANAGER_SUBSCRIPTION_ID" --resource-group ${shell(settings.managerResourceGroup)} --name ${shell(settings.networkManagerName)} --commit-type Connectivity --configuration-ids "$CONFIG_ID" --target-locations ${deploymentRegions.map(shell).join(' ')}${removedRegionCommit}
// After a successful commit, older fingerprinted groups/configurations from this generator may be deleted deliberately.
`
}

function cliOutput(plan: AvnmPlan) {
  const { settings, topology, members, hub, deploymentRegions, removedDeploymentRegions, subscriptionIds } = plan
  const subscription = settings.managerSubscriptionId || subscriptionIds[0]
  const networkGroupName = versionedName(settings.networkGroupName, plan)
  const connectivityConfigurationName = versionedName(settings.connectivityConfigurationName, plan)
  const requiredScopeIds = unique(subscriptionIds.length ? subscriptionIds : subscription ? [subscription] : []).map((id) => `/subscriptions/${id}`)
  const managerSubscription = subscription ? shell(subscription) : '"${AZURE_SUBSCRIPTION_ID:?Set AZURE_SUBSCRIPTION_ID}"'
  const vnetLines: string[] = []
  members.forEach((node, index) => {
    if (node.id.toLowerCase().startsWith('/subscriptions/')) vnetLines.push(`VNET_ID_${index}=${shell(node.id)}`)
    else {
      const nodeSubscription = subscriptionFromNode(node) ? shell(subscriptionFromNode(node)) : '"$SUBSCRIPTION_ID"'
      vnetLines.push(`VNET_ID_${index}=$(az network vnet show --subscription ${nodeSubscription} --resource-group ${shell(String(node.data.resourceGroup || 'rg-network'))} --name ${shell(node.data.label)} --query id -o tsv --only-show-errors)`)
    }
  })
  const memberCommands = members.map((node, index) => `az network manager group static-member create --subscription "$SUBSCRIPTION_ID" --resource-group "$NETWORK_MANAGER_RG" --network-manager-name "$NETWORK_MANAGER_NAME" --network-group-name "$NETWORK_GROUP_NAME" --static-member-name ${shell(staticMemberName(node))} --resource-id "$VNET_ID_${index}" --only-show-errors`).join('\n')
  const groupConnectivity = topology === 'Mesh' || settings.directSpokeConnectivity ? 'DirectlyConnected' : 'None'
  const groupGlobalMesh = settings.globalMesh && groupConnectivity === 'DirectlyConnected'
  const groupUseHubGateway = topology === 'HubAndSpoke' && settings.useHubGateway
  const hubLookup = topology === 'HubAndSpoke' && hub ? hub.id.toLowerCase().startsWith('/subscriptions/') ? `HUB_ID=${shell(hub.id)}` : `HUB_ID=$(az network vnet show --subscription ${subscriptionFromNode(hub) ? shell(subscriptionFromNode(hub)) : '"$SUBSCRIPTION_ID"'} --resource-group ${shell(String(hub.data.resourceGroup || 'rg-network'))} --name ${shell(hub.data.label)} --query id -o tsv --only-show-errors)` : ''
  const hubArg = topology === 'HubAndSpoke' ? ` --hubs "[{\\"resourceId\\":\\"$HUB_ID\\",\\"resourceType\\":\\"Microsoft.Network/virtualNetworks\\"}]"` : ''
  const appliesJson = `[{\\"networkGroupId\\":\\"$NETWORK_GROUP_ID\\",\\"groupConnectivity\\":\\"${groupConnectivity}\\",\\"isGlobal\\":\\"${armBool(groupGlobalMesh)}\\",\\"useHubGateway\\":\\"${armBool(groupUseHubGateway)}\\"}]`
  const scopeChecks = requiredScopeIds.map((scopeId) => `if [[ "$(az network manager show --subscription "$SUBSCRIPTION_ID" --resource-group "$NETWORK_MANAGER_RG" --name "$NETWORK_MANAGER_NAME" --query "contains(networkManagerScopes.subscriptions, '${scopeId}')" -o tsv --only-show-errors | tr '[:upper:]' '[:lower:]')" != "true" ]]; then echo ${shell(`Existing Network Manager scope does not include ${scopeId}.`)} >&2; exit 1; fi`).join('\n')
  const affectedDeploymentRegions = unique([...deploymentRegions, ...removedDeploymentRegions])
  const removedRegionCommit = removedDeploymentRegions.length ? `
az network manager post-commit --subscription "$SUBSCRIPTION_ID" --resource-group "$NETWORK_MANAGER_RG" --name "$NETWORK_MANAGER_NAME" --commit-type Connectivity --target-locations ${removedDeploymentRegions.map(shell).join(' ')} --only-show-errors
printf '%s\\n' 'Removed-region empty commit submitted.'` : ''
  return `#!/usr/bin/env bash
set -euo pipefail

# Azure Virtual Network Manager connectivity deployment generated by Azure Network Studio.
# This script requires an existing manager and never changes its scopes or access types.
# AVNM commits replace complete regional connectivity goal state. This script refuses unrelated active configurations.
# Fingerprinted group/configuration names prevent removed members from remaining active after recommit.
# It intentionally creates no ordinary VNet peering resources.
SUBSCRIPTION_ID=${managerSubscription}
NETWORK_MANAGER_RG=${shell(settings.managerResourceGroup)}
NETWORK_MANAGER_NAME=${shell(settings.networkManagerName)}
NETWORK_GROUP_NAME=${shell(networkGroupName)}
CONNECTIVITY_CONFIG_NAME=${shell(connectivityConfigurationName)}
MANAGED_OWNER_PREFIX=${shell(ownershipPrefix(plan))}
ARTIFACT_FINGERPRINT=${shell(planFingerprint(plan))}
MANAGED_DESCRIPTION="$MANAGED_OWNER_PREFIX artifact $ARTIFACT_FINGERPRINT"
REQUIRED_AVNM_EXTENSION_VERSION='3.0.2'

if [[ "$(printenv CONFIRM_DEDICATED_NETWORK_MANAGER || true)" != "true" ]]; then
  echo 'Set CONFIRM_DEDICATED_NETWORK_MANAGER=true only after verifying this manager has no unrelated connectivity deployments.' >&2
  exit 1
fi
if [[ "$(printenv CONFIRM_AVNM_REGION_HISTORY_COMPLETE || true)" != "true" ]]; then
  echo 'Set CONFIRM_AVNM_REGION_HISTORY_COMPLETE=true only after confirming an initial deployment or supplying every previously committed region.' >&2
  exit 1
fi

ACTUAL_AVNM_EXTENSION_VERSION=$(az extension show --name virtual-network-manager --query version -o tsv 2>/dev/null || true)
if [[ "$ACTUAL_AVNM_EXTENSION_VERSION" != "$REQUIRED_AVNM_EXTENSION_VERSION" ]]; then
  echo "Install the tested Azure CLI extension first: az extension add --name virtual-network-manager --version $REQUIRED_AVNM_EXTENSION_VERSION" >&2
  exit 1
fi
az group show --subscription "$SUBSCRIPTION_ID" --name "$NETWORK_MANAGER_RG" --only-show-errors >/dev/null
az network manager show --subscription "$SUBSCRIPTION_ID" --resource-group "$NETWORK_MANAGER_RG" --name "$NETWORK_MANAGER_NAME" --only-show-errors >/dev/null
if [[ "$(az network manager show --subscription "$SUBSCRIPTION_ID" --resource-group "$NETWORK_MANAGER_RG" --name "$NETWORK_MANAGER_NAME" --query "contains(networkManagerScopeAccesses, 'Connectivity')" -o tsv --only-show-errors | tr '[:upper:]' '[:lower:]')" != "true" ]]; then
  echo 'Existing Network Manager does not have Connectivity scope access.' >&2
  exit 1
fi
${scopeChecks}

ACTIVE_CONNECTIVITY_COUNT=$(az network manager list-active-connectivity-config --subscription "$SUBSCRIPTION_ID" --resource-group "$NETWORK_MANAGER_RG" --network-manager-name "$NETWORK_MANAGER_NAME" --regions ${affectedDeploymentRegions.map(shell).join(' ')} --query 'length(value)' -o tsv --only-show-errors)
OWNED_ACTIVE_CONNECTIVITY_COUNT=$(az network manager list-active-connectivity-config --subscription "$SUBSCRIPTION_ID" --resource-group "$NETWORK_MANAGER_RG" --network-manager-name "$NETWORK_MANAGER_NAME" --regions ${affectedDeploymentRegions.map(shell).join(' ')} --query "length(value[?description != null && starts_with(description, '${ownershipPrefix(plan)}')])" -o tsv --only-show-errors)
if [[ "$ACTIVE_CONNECTIVITY_COUNT" != "$OWNED_ACTIVE_CONNECTIVITY_COUNT" ]]; then
  echo 'Refusing complete goal-state commit: at least one target region has an active connectivity configuration not owned by Azure Network Studio.' >&2
  exit 1
fi

if EXISTING_GROUP_DESCRIPTION=$(az network manager group show --subscription "$SUBSCRIPTION_ID" --resource-group "$NETWORK_MANAGER_RG" --network-manager-name "$NETWORK_MANAGER_NAME" --name "$NETWORK_GROUP_NAME" --query description -o tsv --only-show-errors 2>/dev/null); then
  if [[ "$EXISTING_GROUP_DESCRIPTION" != "$MANAGED_DESCRIPTION" ]]; then echo 'Refusing to overwrite an AVNM network group not owned by this generated artifact.' >&2; exit 1; fi
fi
if EXISTING_CONFIG_DESCRIPTION=$(az network manager connect-config show --subscription "$SUBSCRIPTION_ID" --resource-group "$NETWORK_MANAGER_RG" --network-manager-name "$NETWORK_MANAGER_NAME" --configuration-name "$CONNECTIVITY_CONFIG_NAME" --query description -o tsv --only-show-errors 2>/dev/null); then
  if [[ "$EXISTING_CONFIG_DESCRIPTION" != "$MANAGED_DESCRIPTION" ]]; then echo 'Refusing to overwrite an AVNM connectivity configuration not owned by this generated artifact.' >&2; exit 1; fi
fi

az network manager group create --subscription "$SUBSCRIPTION_ID" --resource-group "$NETWORK_MANAGER_RG" --network-manager-name "$NETWORK_MANAGER_NAME" --name "$NETWORK_GROUP_NAME" --member-type VirtualNetwork --description "$MANAGED_DESCRIPTION" --only-show-errors

${vnetLines.join('\n')}
${memberCommands}
${hubLookup}
NETWORK_GROUP_ID=$(az network manager group show --subscription "$SUBSCRIPTION_ID" --resource-group "$NETWORK_MANAGER_RG" --network-manager-name "$NETWORK_MANAGER_NAME" --network-group-name "$NETWORK_GROUP_NAME" --query id -o tsv --only-show-errors)

az network manager connect-config create --subscription "$SUBSCRIPTION_ID" --resource-group "$NETWORK_MANAGER_RG" --network-manager-name "$NETWORK_MANAGER_NAME" --configuration-name "$CONNECTIVITY_CONFIG_NAME" --connectivity-topology ${topology || 'Mesh'} --delete-existing-peering ${armBool(settings.deleteExistingPeerings)} --is-global ${armBool(settings.globalMesh)} --connect-capabilities '{"connectedGroupAddressOverlap":"Disallowed","connectedGroupPrivateEndpointsScale":"Standard","peeringEnforcement":"Unenforced"}' --applies-to-groups "${appliesJson}"${hubArg} --description "$MANAGED_DESCRIPTION" --only-show-errors

CONFIGURATION_ID=$(az network manager connect-config show --subscription "$SUBSCRIPTION_ID" --resource-group "$NETWORK_MANAGER_RG" --network-manager-name "$NETWORK_MANAGER_NAME" --configuration-name "$CONNECTIVITY_CONFIG_NAME" --query id -o tsv --only-show-errors)
az network manager post-commit --subscription "$SUBSCRIPTION_ID" --resource-group "$NETWORK_MANAGER_RG" --name "$NETWORK_MANAGER_NAME" --commit-type Connectivity --configuration-ids "$CONFIGURATION_ID" --target-locations ${deploymentRegions.map(shell).join(' ')} --only-show-errors${removedRegionCommit}
printf '%s\\n' 'Commit submitted. After verification, remove older fingerprinted groups/configurations deliberately; this script never deletes them.'
`
}

export function generateAvnm(plan: AvnmPlan, format: ExportFormat) {
  if (plan.errors.length || !plan.topology) {
    const marker = format === 'bicep' ? '//' : '#'
    return [`${marker} AVNM EXPORT BLOCKED`, ...plan.errors.map((error) => `${marker} ${error.replace(/[\r\n]+/g, ' ')}`)].join('\n')
  }
  if (format === 'terraform' && plan.removedDeploymentRegions.length) {
    return ['# AVNM EXPORT BLOCKED', '# Terraform cannot safely clear regions removed from a previously committed deployment without the prior deployment resources in state.', `# Use the prior Terraform state or Azure CLI output to submit an explicit empty commit for: ${plan.removedDeploymentRegions.join(', ')}`].join('\n')
  }
  if (format === 'terraform') return terraform(plan)
  if (format === 'bicep') return bicepOutput(plan)
  return cliOutput(plan)
}
