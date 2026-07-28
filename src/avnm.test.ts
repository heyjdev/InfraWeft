import { describe, expect, it } from 'vitest'
import { buildAvnmPlan, defaultAvnmSettings, generateAvnm } from './avnm'
import type { NetworkDesign, NetworkEdge, NetworkNode } from './model'

const vnet = (id: string, label: string, subscriptionId = '11111111-1111-1111-1111-111111111111'): NetworkNode => ({
  id,
  type: 'azureResource',
  position: { x: 0, y: 0 },
  data: { label, kind: 'vnet', addressSpaces: [`10.${id.charCodeAt(0) % 200}.0.0/16`], region: 'eastus', resourceGroup: 'rg-network', subscriptionId },
})
const peer = (source: string, target: string): NetworkEdge => ({ id: `${source}-${target}`, source, target, data: { kind: 'peering' } })
const design = (nodes: NetworkNode[], edges: NetworkEdge[]): NetworkDesign => ({ name: 'test', nodes, edges })

function settings() {
  return { ...defaultAvnmSettings(), managerSubscriptionId: '11111111-1111-1111-1111-111111111111', confirmDedicatedManager: true, confirmInitialDeployment: true }
}

describe('AVNM conversion', () => {
  it('blocks deployment until the manager is explicitly confirmed as dedicated', () => {
    const nodes = [vnet('a', 'a'), vnet('b', 'b')]
    const plan = buildAvnmPlan(design(nodes, [peer('a', 'b')]), { ...settings(), confirmDedicatedManager: false })
    expect(plan.errors.join(' ')).toContain('dedicated to this generated AVNM deployment')
  })
  it('blocks deployment when regional commit history is ambiguous', () => {
    const nodes = [vnet('a', 'a'), vnet('b', 'b')]
    const plan = buildAvnmPlan(design(nodes, [peer('a', 'b')]), { ...settings(), confirmInitialDeployment: false })
    expect(plan.errors.join(' ')).toContain('every previously committed region')
  })

  it('infers a complete peering graph as Mesh', () => {
    const nodes = [vnet('a', 'a'), vnet('b', 'b'), vnet('c', 'c')]
    const plan = buildAvnmPlan(design(nodes, [peer('a', 'b'), peer('a', 'c'), peer('b', 'c')]), settings())
    expect(plan.topology).toBe('Mesh')
    expect(plan.errors).toEqual([])
    expect(plan.members).toHaveLength(3)
  })

  it('infers an exact star as HubAndSpoke and excludes the hub from membership', () => {
    const nodes = [vnet('hub', 'hub'), vnet('a', 'a'), vnet('b', 'b'), vnet('c', 'c')]
    const plan = buildAvnmPlan(design(nodes, [peer('hub', 'a'), peer('hub', 'b'), peer('hub', 'c')]), settings())
    expect(plan.topology).toBe('HubAndSpoke')
    expect(plan.hub?.id).toBe('hub')
    expect(plan.members.map((node) => node.id)).toEqual(['a', 'b', 'c'])
  })

  it('blocks automatic conversion of an irregular graph', () => {
    const nodes = [vnet('a', 'a'), vnet('b', 'b'), vnet('c', 'c'), vnet('d', 'd')]
    const plan = buildAvnmPlan(design(nodes, [peer('a', 'b'), peer('b', 'c')]), settings())
    expect(plan.errors.join(' ')).toContain('cannot be represented')
  })

  it('allows an explicit topology but warns when it changes connectivity semantics', () => {
    const nodes = [vnet('a', 'a'), vnet('b', 'b'), vnet('c', 'c')]
    const plan = buildAvnmPlan(design(nodes, [peer('a', 'b')]), { ...settings(), topology: 'Mesh' })
    expect(plan.errors).toEqual([])
    expect(plan.warnings.join(' ')).toContain('adds connectivity')
  })

  it('requires global mesh for a multi-region complete graph', () => {
    const nodes = [vnet('a', 'a'), vnet('b', 'b')]
    nodes[1].data.region = 'westus2'
    const plan = buildAvnmPlan(design(nodes, [peer('a', 'b')]), settings())
    expect(plan.errors.join(' ')).toContain('Enable global mesh')
    expect(buildAvnmPlan(design(nodes, [peer('a', 'b')]), { ...settings(), globalMesh: true }).errors).toEqual([])
  })

  it('blocks connected VNets with overlapping prefixes because overlap support is disabled', () => {
    const nodes = [vnet('a', 'a'), vnet('b', 'b')]
    nodes[0].data.addressSpaces = ['10.0.0.0/16']
    nodes[1].data.addressSpaces = ['10.0.1.0/24']
    const plan = buildAvnmPlan(design(nodes, [peer('a', 'b')]), settings())
    expect(plan.errors.join(' ')).toContain('address-overlap support is deliberately disabled')
  })

  it('derives cross-subscription scope from imported resource IDs', () => {
    const subscription = '22222222-2222-2222-2222-222222222222'
    const nodes = [vnet('a', 'a'), vnet('b', 'b')]
    nodes[1].id = `/subscriptions/${subscription}/resourceGroups/rg-test/providers/Microsoft.Network/virtualNetworks/b`
    nodes[1].data.subscriptionId = undefined
    const plan = buildAvnmPlan(design(nodes, [peer('a', nodes[1].id)]), settings())
    expect(plan.errors).toEqual([])
    expect(plan.subscriptionIds).toContain(subscription)
    expect(generateAvnm(plan, 'azureCli')).toContain(nodes[1].id)
  })

  it('blocks unsafe Azure names before generation', () => {
    const nodes = [vnet('a', 'bad name;$(id)'), vnet('b', 'b')]
    const plan = buildAvnmPlan(design(nodes, [peer('a', 'b')]), settings())
    expect(plan.errors.some((error: string) => error.includes('VNet name is invalid'))).toBe(true)
  })

  it('rejects self-loop peerings instead of inferring Mesh', () => {
    const nodes = [vnet('a', 'a'), vnet('b', 'b')]
    const plan = buildAvnmPlan(design(nodes, [peer('a', 'a')]), settings())
    expect(plan.topology).toBeUndefined()
    expect(plan.errors.join(' ')).toContain('self-loop')
  })

  it('renders diagnostics rather than runnable artifacts for an unresolved plan', () => {
    const nodes = [vnet('a', 'a'), vnet('b', 'b'), vnet('c', 'c')]
    const plan = buildAvnmPlan(design(nodes, [peer('a', 'b')]), settings())
    const output = generateAvnm(plan, 'terraform')
    expect(output).toContain('AVNM EXPORT BLOCKED')
    expect(output).not.toContain('resource "azurerm_network_manager')
  })

  it('rejects subscription metadata that disagrees with an imported resource ID', () => {
    const embedded = '22222222-2222-2222-2222-222222222222'
    const nodes = [vnet('a', 'a'), vnet('b', 'b')]
    nodes[1].id = `/subscriptions/${embedded}/resourceGroups/rg-test/providers/Microsoft.Network/virtualNetworks/b`
    const plan = buildAvnmPlan(design(nodes, [peer('a', nodes[1].id)]), settings())
    expect(plan.errors.join(' ')).toContain('does not match its resource ID')
  })

  it('keeps manager placement separate from managed subscription scope', () => {
    const target = '22222222-2222-2222-2222-222222222222'
    const nodes = [vnet('a', 'a', target), vnet('b', 'b', target)]
    const plan = buildAvnmPlan(design(nodes, [peer('a', 'b')]), settings())
    expect(plan.subscriptionIds).toEqual([target])
  })

  it('blocks duplicate deployment identities', () => {
    const nodes = [vnet('a', 'shared'), vnet('b', 'shared')]
    const plan = buildAvnmPlan(design(nodes, [peer('a', 'b')]), settings())
    expect(plan.errors.join(' ')).toContain('duplicate VNet deployment identity')
  })

  it('generates collision-resistant static-member names', () => {
    const nodes = [vnet('a', 'shared'), vnet('b', 'shared')]
    nodes[0].data.resourceGroup = 'rg-a'
    nodes[1].data.resourceGroup = 'rg-b'
    const output = generateAvnm(buildAvnmPlan(design(nodes, [peer('a', 'b')]), settings()), 'terraform')
    const names = [...output.matchAll(/name\s+= "(sm-[^"]+)"/g)].map((match) => match[1])
    expect(names).toHaveLength(2)
    expect(new Set(names).size).toBe(2)
  })

  it('changes deployment reconciliation fingerprints when membership changes', () => {
    const nodes = [vnet('a', 'a'), vnet('b', 'b')]
    const firstPlan = buildAvnmPlan(design(nodes, [peer('a', 'b')]), settings())
    const movedNodes = [nodes[0], { ...nodes[1], data: { ...nodes[1].data, resourceGroup: 'rg-moved' } }]
    const secondPlan = buildAvnmPlan(design(movedNodes, [peer('a', 'b')]), settings())
    const firstTerraform = generateAvnm(firstPlan, 'terraform').match(/avnm_commit_fingerprint.*$/m)?.[0]
    const secondTerraform = generateAvnm(secondPlan, 'terraform').match(/avnm_commit_fingerprint.*$/m)?.[0]
    expect(firstTerraform).not.toBe(secondTerraform)
    const firstCliGroup = generateAvnm(firstPlan, 'azureCli').match(/^NETWORK_GROUP_NAME=.*$/m)?.[0]
    const secondCliGroup = generateAvnm(secondPlan, 'azureCli').match(/^NETWORK_GROUP_NAME=.*$/m)?.[0]
    expect(firstCliGroup).not.toBe(secondCliGroup)
  })

  it('generates AVNM resources and a regional deployment in all three formats without ordinary peering resources', () => {
    const nodes = [vnet('hub', 'hub'), vnet('a', 'a'), vnet('b', 'b')]
    const plan = buildAvnmPlan(design(nodes, [peer('hub', 'a'), peer('hub', 'b')]), settings())
    const terraform = generateAvnm(plan, 'terraform')
    expect(terraform).toContain('variable "confirm_dedicated_network_manager"')
    expect(terraform).toContain('variable "confirm_region_history_complete"')
    expect(terraform).toContain('AVNM commits replace complete regional connectivity goal state')
    expect(terraform).toContain('azurerm_network_manager_deployment')
    expect(terraform).toContain('triggers = {')
    expect(terraform).toContain('data "azurerm_network_manager" "main"')
    expect(terraform).not.toContain('resource "azurerm_network_manager" "main"')
    expect(terraform).toContain('azurerm_network_manager_static_member')
    expect(terraform).toMatch(/connected_group_address_overlap_enabled\s*= false/)
    expect(terraform).not.toMatch(/resource "azurerm_virtual_network_peering"/)
    const bicep = generateAvnm(plan, 'bicep')
    expect(bicep).toContain("resource networkManager 'Microsoft.Network/networkManagers@2025-01-01' existing")
    expect(bicep).toContain('Microsoft.Network/networkManagers/connectivityConfigurations@2025-01-01')
    expect(bicep).toContain("connectedGroupAddressOverlap: 'Disallowed'")
    expect(bicep).toContain('param confirmDedicatedNetworkManager bool')
    expect(bicep).toContain('param confirmRegionHistoryComplete bool')
    expect(bicep).toContain("targetScope = 'resourceGroup'")
    expect(bicep).toContain('managerDeploymentScopeMatches')
    expect(bicep).toContain('list-active-connectivity-config')
    expect(bicep).toContain('az network manager post-commit')
    const cli = generateAvnm(plan, 'azureCli')
    expect(cli).toContain("REQUIRED_AVNM_EXTENSION_VERSION='3.0.2'")
    expect(cli).toContain('MANAGED_OWNER_PREFIX=')
    expect(cli).toContain('MANAGED_DESCRIPTION="$MANAGED_OWNER_PREFIX artifact $ARTIFACT_FINGERPRINT"')
    expect(cli).toContain('CONFIRM_DEDICATED_NETWORK_MANAGER')
    expect(cli).toContain('CONFIRM_AVNM_REGION_HISTORY_COMPLETE')
    expect(cli).toContain('list-active-connectivity-config')
    expect(cli).toContain('value[?description != null && starts_with(description,')
    expect(cli).toContain('Refusing to overwrite an AVNM network group not owned')
    expect(cli).toContain('az network manager show')
    expect(cli).not.toContain('az network manager create')
    expect(cli).not.toMatch(/^az extension add/m)
    expect(cli.match(/az network manager connect-config create/g)).toHaveLength(1)
    expect(cli).toContain('az network manager post-commit')
    expect(cli).toContain('--commit-type Connectivity')
  })

  it('keeps Terraform resource addresses stable when regions and members are reordered', () => {
    const nodes = [vnet('a', 'a'), vnet('b', 'b'), vnet('c', 'c')]
    const edges = [peer('a', 'b'), peer('a', 'c'), peer('b', 'c')]
    const first = buildAvnmPlan(design(nodes, edges), { ...settings(), deploymentRegions: ['westus', 'eastus'] })
    const reordered = buildAvnmPlan(design([...nodes].reverse(), [...edges].reverse()), { ...settings(), deploymentRegions: ['eastus', 'westus'] })
    expect(generateAvnm(first, 'terraform')).toBe(generateAvnm(reordered, 'terraform'))
    expect(generateAvnm(first, 'terraform')).toContain('"connectivity_eastus"')
    expect(generateAvnm(first, 'terraform')).toContain('"connectivity_westus"')
  })

  it('replaces Terraform groups before committing a member removal', () => {
    const threeNodes = [vnet('a', 'a'), vnet('b', 'b'), vnet('c', 'c')]
    const before = buildAvnmPlan(design(threeNodes, [peer('a', 'b'), peer('a', 'c'), peer('b', 'c')]), settings())
    const after = buildAvnmPlan(design(threeNodes.slice(0, 2), [peer('a', 'b')]), settings())
    const beforeTerraform = generateAvnm(before, 'terraform')
    const afterTerraform = generateAvnm(after, 'terraform')
    const groupName = (output: string) => output.match(/resource "azurerm_network_manager_network_group" "managed" \{[\s\S]*?name\s+=\s+"([^"]+)"/)?.[1]
    const configurationName = (output: string) => output.match(/resource "azurerm_network_manager_connectivity_configuration" "main" \{[\s\S]*?name\s+=\s+"([^"]+)"/)?.[1]
    expect(groupName(beforeTerraform)).not.toBe(groupName(afterTerraform))
    expect(configurationName(beforeTerraform)).not.toBe(configurationName(afterTerraform))
    expect(afterTerraform.match(/create_before_destroy = true/g)).toHaveLength(2)
    expect(afterTerraform).not.toContain('member_c_')
  })

  it('emits deliberate empty commits for removed regions and blocks stateless Terraform output', () => {
    const nodes = [vnet('a', 'a'), vnet('b', 'b')]
    const plan = buildAvnmPlan(design(nodes, [peer('a', 'b')]), {
      ...settings(),
      deploymentRegions: ['eastus'],
      previousDeploymentRegions: ['eastus', 'westus'],
      confirmInitialDeployment: false,
    })
    expect(plan.removedDeploymentRegions).toEqual(['westus'])
    expect(generateAvnm(plan, 'terraform')).toContain('AVNM EXPORT BLOCKED')
    const cli = generateAvnm(plan, 'azureCli')
    expect(cli).toContain("--commit-type Connectivity --target-locations 'westus'")
    expect(generateAvnm(plan, 'bicep')).toContain("--commit-type Connectivity --target-locations 'westus'")
  })
})
