import { describe, expect, it } from 'vitest'
import { cidrsOverlap, parseCidr, starterDesign, validateDesign } from './model'
import { generateInfrastructure } from './generators'

describe('CIDR validation', () => {
  it('parses valid ranges and rejects invalid ranges', () => {
    expect(parseCidr('10.0.0.0/16')).toMatchObject({ prefix: 16 })
    expect(parseCidr('10.0.999.0/24')).toBeNull()
    expect(parseCidr('10.0.0.0/33')).toBeNull()
    expect(parseCidr('10..0.0/16')).toBeNull()
    expect(parseCidr('10.0.0.1/24')).toBeNull()
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
})
