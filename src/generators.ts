import { addressSpacesFor, type NetworkEdge, type NetworkNode } from './model'

const safe = (value: string) => value.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^([0-9])/, '_$1')
const q = (value?: string) => JSON.stringify(value ?? '')
const bq = (value?: string) => `'${(value ?? '').replaceAll("'", "''")}'`
const vnets = (nodes: NetworkNode[]) => nodes.filter((node) => node.data.kind === 'vnet')
const peerings = (edges: NetworkEdge[]) => edges.filter((edge) => edge.data?.kind === 'peering')
const stableSuffix = (value: string) => {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 0x01000193) }
  return (hash >>> 0).toString(36).padStart(7, '0').slice(-7)
}
const resourceKey = (node: NetworkNode) => `${safe(`${node.data.resourceGroup || 'rg_network'}_${node.data.label}`).slice(0, 64)}_${stableSuffix(node.id)}`
const omittedKinds = (nodes: NetworkNode[]) => [...new Set(nodes.filter((node) => node.data.kind !== 'vnet').map((node) => node.data.kind))]
const subscriptionFor = (nodes: NetworkNode[]) => [...new Set(nodes.map((node) => node.data.subscriptionId).filter((id): id is string => Boolean(id)))][0]

export type ExportFormat = 'terraform' | 'bicep' | 'azureCli'

export function generateInfrastructure(nodes: NetworkNode[], edges: NetworkEdge[], format: ExportFormat) {
  if (format === 'terraform') return terraform(nodes, edges)
  if (format === 'bicep') return bicep(nodes, edges)
  return azureCli(nodes, edges)
}

function scopeNote(nodes: NetworkNode[], prefix: string) {
  const omitted = omittedKinds(nodes)
  return omitted.length ? `${prefix} Network-layer export only. Visual appliance nodes not emitted yet: ${omitted.join(', ')}.\n` : ''
}

function terraform(nodes: NetworkNode[], edges: NetworkEdge[]) {
  const blocks = vnets(nodes).map((node) => `resource "azurerm_virtual_network" "${resourceKey(node)}" {
  name                = ${q(node.data.label)}
  location            = ${q(node.data.region || 'eastus')}
  resource_group_name = ${q(node.data.resourceGroup || 'rg-network')}
  address_space       = ${JSON.stringify(addressSpacesFor(node))}
}`)
  for (const edge of peerings(edges)) {
    const a = nodes.find((node) => node.id === edge.source); const b = nodes.find((node) => node.id === edge.target)
    if (!a || !b) continue
    const an = resourceKey(a); const bn = resourceKey(b)
    blocks.push(`resource "azurerm_virtual_network_peering" "${an}_to_${bn}" {
  name                      = ${q(`${a.data.label}-to-${b.data.label}`)}
  resource_group_name       = azurerm_virtual_network.${an}.resource_group_name
  virtual_network_name      = azurerm_virtual_network.${an}.name
  remote_virtual_network_id = azurerm_virtual_network.${bn}.id
}

resource "azurerm_virtual_network_peering" "${bn}_to_${an}" {
  name                      = ${q(`${b.data.label}-to-${a.data.label}`)}
  resource_group_name       = azurerm_virtual_network.${bn}.resource_group_name
  virtual_network_name      = azurerm_virtual_network.${bn}.name
  remote_virtual_network_id = azurerm_virtual_network.${an}.id
}`)
  }
  return `${scopeNote(nodes, '#')}terraform {
  required_providers { azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" } }
}

provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
}

variable "subscription_id" {
  description = "Target Azure subscription ID"
  type        = string
${subscriptionFor(nodes) ? `  default     = ${q(subscriptionFor(nodes))}\n` : ''}}

${blocks.join('\n\n')}
`
}

function bicep(nodes: NetworkNode[], edges: NetworkEdge[]) {
  const groups = [...new Set(vnets(nodes).map((node) => node.data.resourceGroup || 'rg-network'))]
  const groupDeclarations = groups.map((group) => `resource ${safe(`group_${group}`)} 'Microsoft.Resources/resourceGroups@2024-03-01' existing = {
  name: ${bq(group)}
}`).join('\n\n')
  const resources = vnets(nodes).map((node) => `resource ${resourceKey(node)} 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  scope: ${safe(`group_${node.data.resourceGroup || 'rg-network'}`)}
  name: ${bq(node.data.label)}
  location: ${bq(node.data.region || 'eastus')}
  properties: {
    addressSpace: { addressPrefixes: [${addressSpacesFor(node).map(bq).join(', ')}] }
  }
}`)
  const peeringResources: string[] = []
  for (const edge of peerings(edges)) {
    const a = nodes.find((node) => node.id === edge.source); const b = nodes.find((node) => node.id === edge.target)
    if (!a || !b) continue
    for (const [local, remote] of [[a, b], [b, a]] as const) peeringResources.push(`resource ${resourceKey(local)}_to_${resourceKey(remote)} 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2024-05-01' = {
  parent: ${resourceKey(local)}
  name: ${bq(`to-${remote.data.label}`)}
  properties: {
    remoteVirtualNetwork: { id: ${resourceKey(remote)}.id }
    allowVirtualNetworkAccess: true
  }
}`)
  }
  const targetSubscription = subscriptionFor(nodes) || '<AZURE_SUBSCRIPTION_ID>'
  const deploymentLocation = vnets(nodes)[0]?.data.region || 'eastus'
  return `targetScope = 'subscription'\n\n// Deploy: az deployment sub create --subscription ${targetSubscription} --location ${deploymentLocation} --template-file network.bicep\n${scopeNote(nodes, '//')}${groupDeclarations}\n\n${resources.join('\n\n')}\n\n${peeringResources.join('\n\n')}\n`
}

function azureCli(nodes: NetworkNode[], edges: NetworkEdge[]) {
  const subscription = subscriptionFor(nodes)
  const subscriptionValue = subscription ? shell(subscription) : '"${AZURE_SUBSCRIPTION_ID:?Set AZURE_SUBSCRIPTION_ID}"'
  const commands = ['#!/usr/bin/env bash', 'set -euo pipefail', '', '# Generated by Azure Network Studio. Review before running.', scopeNote(nodes, '#').trimEnd(), `SUBSCRIPTION_ID=${subscriptionValue}`, ''].filter((line, index, all) => line || all[index - 1] !== '')
  for (const node of vnets(nodes)) commands.push(`az network vnet create --subscription "$SUBSCRIPTION_ID" --resource-group ${shell(node.data.resourceGroup || 'rg-network')} --name ${shell(node.data.label)} --location ${shell(node.data.region || 'eastus')} --address-prefixes ${addressSpacesFor(node).map(shell).join(' ')}`)
  for (const edge of peerings(edges)) {
    const a = nodes.find((node) => node.id === edge.source); const b = nodes.find((node) => node.id === edge.target)
    if (!a || !b) continue
    commands.push('', `A_ID=$(az network vnet show --subscription "$SUBSCRIPTION_ID" -g ${shell(a.data.resourceGroup || 'rg-network')} -n ${shell(a.data.label)} --query id -o tsv)`, `B_ID=$(az network vnet show --subscription "$SUBSCRIPTION_ID" -g ${shell(b.data.resourceGroup || 'rg-network')} -n ${shell(b.data.label)} --query id -o tsv)`, `az network vnet peering create --subscription "$SUBSCRIPTION_ID" -g ${shell(a.data.resourceGroup || 'rg-network')} --vnet-name ${shell(a.data.label)} -n ${shell(`to-${b.data.label}`)} --remote-vnet "$B_ID" --allow-vnet-access`, `az network vnet peering create --subscription "$SUBSCRIPTION_ID" -g ${shell(b.data.resourceGroup || 'rg-network')} --vnet-name ${shell(b.data.label)} -n ${shell(`to-${a.data.label}`)} --remote-vnet "$A_ID" --allow-vnet-access`)
  }
  return commands.join('\n') + '\n'
}

function shell(value: string) { return `'${value.replaceAll("'", "'\\''")}'` }
