import { describe, expect, it } from 'vitest'
import { cidrsOverlap, isNetworkDesign, parseCidr, starterDesign, validateDesign } from './model'
import { generateInfrastructure } from './generators'

describe('CIDR validation', () => {
  it('parses valid ranges and rejects invalid ranges', () => {
    expect(parseCidr('10.0.0.0/16')).toMatchObject({ prefix: 16 })
    expect(parseCidr('10.0.999.0/24')).toBeNull()
    expect(parseCidr('10.0.0.0/33')).toBeNull()
    expect(parseCidr('10..0.0/16')).toBeNull()
    expect(parseCidr('10.0.0.1/24')).toBeNull()
    expect(parseCidr(' 10.0.0.0/16')).toBeNull()
  })
  it('detects overlapping ranges', () => {
    expect(cidrsOverlap('10.0.0.0/16', '10.0.8.0/24')).toBe(true)
    expect(cidrsOverlap('10.0.0.0/16', '10.1.0.0/16')).toBe(false)
  })
  it('allows disconnected overlaps but rejects overlapping peerings', () => {
    const duplicate = { ...starterDesign.nodes[0], id: 'duplicate', data: { ...starterDesign.nodes[0].data, label: 'duplicate' } }
    expect(validateDesign([...starterDesign.nodes, duplicate], starterDesign.edges)).toEqual([])
    const peering = { id: 'bad-peer', source: 'hub', target: 'duplicate', data: { kind: 'peering' as const } }
    expect(validateDesign([...starterDesign.nodes, duplicate], [...starterDesign.edges, peering])).toContain('Cannot peer overlapping networks: vnet-hub-prod and duplicate')
  })
  it('enforces Azure prefix bounds and detects duplicate peerings', () => {
    const nodes = structuredClone(starterDesign.nodes)
    nodes[0].data.addressSpace = '0.0.0.0/0'
    expect(validateDesign(nodes, starterDesign.edges)).toContain('vnet-hub-prod: Azure VNet IPv4 prefixes must be /2 through /29')
    expect(validateDesign(starterDesign.nodes, [...starterDesign.edges, { ...starterDesign.edges[0], id: 'duplicate-edge' }])).toContain('Duplicate VNet peering connection')
  })
  it('rejects malformed persisted graph data', () => {
    expect(isNetworkDesign(starterDesign)).toBe(true)
    expect(isNetworkDesign({ ...starterDesign, nodes: [...starterDesign.nodes, { ...starterDesign.nodes[0] }] })).toBe(false)
    expect(isNetworkDesign({ ...starterDesign, edges: [{ id: 'dangling', source: 'missing', target: 'hub' }] })).toBe(false)
  })
  it('keeps imported VNets diagram-only until adoption is explicit', () => {
    const nodes = structuredClone(starterDesign.nodes)
    nodes[0].data.imported = true
    expect(validateDesign(nodes, starterDesign.edges)).toContain('Imported VNets are diagram-only until explicitly adopted for management')
  })
})

describe('code generation', () => {
  for (const format of ['terraform', 'bicep', 'azureCli'] as const) it(`generates ${format}`, () => {
    const output = generateInfrastructure(starterDesign.nodes, starterDesign.edges, format)
    expect(output).toContain('vnet-hub-prod')
    expect(output).toContain('vnet-app-prod')
  })
  it('preserves multiple prefixes and emits target subscription controls', () => {
    const nodes = structuredClone(starterDesign.nodes)
    nodes[0].data.addressSpaces = ['10.0.0.0/16', '10.50.0.0/16']
    nodes.forEach((node) => { node.data.subscriptionId = '11111111-1111-1111-1111-111111111111' })
    expect(generateInfrastructure(nodes, starterDesign.edges, 'terraform')).toContain('["10.0.0.0/16","10.50.0.0/16"]')
    const bicep = generateInfrastructure(nodes, starterDesign.edges, 'bicep')
    expect(bicep).toContain("addressPrefixes: ['10.0.0.0/16', '10.50.0.0/16']")
    expect(bicep).not.toMatch(/name: "/)
    const cli = generateInfrastructure(nodes, starterDesign.edges, 'azureCli')
    expect(cli).toContain('--subscription "$SUBSCRIPTION_ID"')
    expect(cli).toContain("'10.0.0.0/16' '10.50.0.0/16'")
  })
  it('uses collision-resistant deterministic symbols', () => {
    const nodes = structuredClone(starterDesign.nodes)
    nodes[2].data.label = 'vnet_hub_prod'
    nodes[2].data.resourceGroup = nodes[0].data.resourceGroup
    const terraform = generateInfrastructure(nodes, starterDesign.edges, 'terraform')
    const symbols = [...terraform.matchAll(/resource "azurerm_virtual_network" "([^"]+)"/g)].map((match) => match[1])
    expect(new Set(symbols).size).toBe(symbols.length)
  })
})
