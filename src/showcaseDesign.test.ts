import { describe, expect, it } from 'vitest'
import { generateInfrastructure, generateInfrastructureResult, getExportReport } from './generators'
import { isNetworkDesign, RESOURCE_SCHEMAS, validateDesign, type NetworkNode, type ResourceField } from './model'
import { createShowcaseDesign } from './showcaseDesign'

const present = (value: unknown) => value !== undefined && value !== null && value !== ''

function expectRequiredFields(values: Record<string, unknown>, fields: ResourceField[], path = '') {
  for (const field of fields) {
    const key = String(field.key)
    const value = values[key]
    const fieldPath = path ? `${path}.${key}` : key
    if (field.required) {
      expect(present(value), `${fieldPath} should be populated`).toBe(true)
      if ((field.type === 'cidrList' || field.type === 'stringList' || (field.type === 'block' && field.repeatable))) {
        expect(Array.isArray(value), `${fieldPath} should be an array`).toBe(true)
        expect((value as unknown[]).length, `${fieldPath} should not be empty`).toBeGreaterThan(0)
      }
    }
    if (Array.isArray(value) && field.minItems !== undefined) expect(value.length, `${fieldPath} cardinality`).toBeGreaterThanOrEqual(field.minItems)
    if (field.type === 'block' && value) {
      const records = field.repeatable ? value as Array<Record<string, unknown>> : [value as Record<string, unknown>]
      records.forEach((record, index) => expectRequiredFields(record, field.fields ?? [], `${fieldPath}.${index}`))
    }
  }
}

describe('seeded Random showcase design', () => {
  it('includes every resource kind and recursively fills required schema fields and cardinalities', () => {
    const { design } = createShowcaseDesign('schema-coverage')
    expect(new Set(design.nodes.map((node) => node.data.kind))).toEqual(new Set(Object.keys(RESOURCE_SCHEMAS)))
    for (const node of design.nodes) expectRequiredFields(node.data, RESOURCE_SCHEMAS[node.data.kind].fields, node.data.label)
  })

  it('is byte-identical for the same seed and varies for different seeds', () => {
    expect(JSON.stringify(createShowcaseDesign('repeatable'))).toBe(JSON.stringify(createShowcaseDesign('repeatable')))
    expect(JSON.stringify(createShowcaseDesign('repeatable').design)).not.toBe(JSON.stringify(createShowcaseDesign('different').design))
    expect(createShowcaseDesign(42).seed).toBe('42')
  })

  it('contains the supported typed topology associations', () => {
    const kinds = new Set(createShowcaseDesign('associations').design.edges.map((edge) => edge.data?.kind))
    for (const kind of ['peering', 'subnetNetworkSecurityGroup', 'subnetRouteTable', 'subnetNatGateway', 'natGatewayPublicIp']) expect(kinds.has(kind as never)).toBe(true)
  })

  it('lays resources out from public edge to VNets, child subnets, and internal resources', () => {
    const { design } = createShowcaseDesign('hierarchy')
    const nodes: NetworkNode[] = design.nodes
    const publicEdge = nodes.filter((node) => ['frontDoor', 'publicIp'].includes(node.data.kind))
    const vnets = nodes.filter((node) => node.data.kind === 'vnet')
    const subnets = nodes.filter((node) => node.data.kind === 'subnet')
    const internal = nodes.filter((node) => !['frontDoor', 'publicIp', 'vnet', 'subnet'].includes(node.data.kind))
    const ys = (items: NetworkNode[]) => items.map((node) => node.position.y)

    expect(subnets).toHaveLength(6)
    expect(Math.max(...ys(publicEdge))).toBeLessThan(Math.min(...ys(vnets)))
    expect(Math.max(...ys(vnets))).toBeLessThan(Math.min(...ys(subnets)))
    expect(Math.max(...ys(subnets))).toBeLessThan(Math.min(...ys(internal)))
    for (const subnet of subnets) {
      const parent = vnets.find((vnet) => vnet.id === subnet.data.parentVnetId)
      expect(parent, `${subnet.data.label} should have a VNet parent`).toBeDefined()
      expect(Math.abs(subnet.position.x - parent!.position.x), `${subnet.data.label} should sit below ${parent!.data.label}`).toBeLessThanOrEqual(240)
    }
  })

  it('does not configure unrendered fields on resource kinds in formats that support them', () => {
    const { design } = createShowcaseDesign('supported-exports')
    const kinds = ['vnet', 'subnet', 'publicIp', 'networkSecurityGroup', 'routeTable', 'natGateway', 'frontDoor'] as const
    for (const kind of kinds) for (const format of ['terraform', 'bicep', 'azureCli'] as const) {
      if (RESOURCE_SCHEMAS[kind].export[format].status !== 'supported') continue
      const configuredFieldDiagnostics = getExportReport(design.nodes, design.edges, format).unsupported
        .filter(({ node, reason }) => node.data.kind === kind && reason.startsWith('Configured field '))
      expect(configuredFieldDiagnostics, `${kind} should not have configured-field blockers in ${format}`).toEqual([])
    }
  })

  it('passes local design validation and persisted-design guards', () => {
    const { design } = createShowcaseDesign('valid-persisted')
    expect(validateDesign(design.nodes, design.edges)).toEqual([])
    expect(isNetworkDesign(JSON.parse(JSON.stringify(design)))).toBe(true)
  })

  it('exports every showcase resource to Terraform, Bicep, and Azure CLI', () => {
    const { design } = createShowcaseDesign('honest-export')
    const terraformReport = getExportReport(design.nodes, design.edges, 'terraform')
    expect(terraformReport.unsupported).toEqual([])
    const terraform = generateInfrastructure(design.nodes, design.edges, 'terraform')
    for (const resourceType of [
      'azurerm_application_gateway',
      'azurerm_firewall',
      'azurerm_virtual_network_gateway',
      'azurerm_lb',
      'azurerm_lb_probe',
      'azurerm_lb_rule',
      'azurerm_private_endpoint',
    ]) expect(terraform).toContain(`resource "${resourceType}"`)

    const bicepReport = getExportReport(design.nodes, design.edges, 'bicep')
    expect(bicepReport.unsupported).toEqual([])
    const bicep = generateInfrastructure(design.nodes, design.edges, 'bicep')
    for (const resourceType of [
      'Microsoft.Network/applicationGateways@',
      'Microsoft.Network/azureFirewalls@',
      'Microsoft.Network/virtualNetworkGateways@',
      'Microsoft.Network/loadBalancers@',
      'Microsoft.Network/privateEndpoints@',
      'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@',
      'Microsoft.Cdn/profiles@',
    ]) expect(bicep).toContain(resourceType)
    expect(bicep).toContain('@secure()')
    expect(bicep).not.toContain('secret-reference://key-vault/vpn-radius-shared-secret')

    const cliReport = getExportReport(design.nodes, design.edges, 'azureCli')
    expect(cliReport.unsupported).toEqual([])
    const cli = generateInfrastructure(design.nodes, design.edges, 'azureCli')
    for (const command of [
      'az rest',
      'az network firewall create',
      'az network vnet-gateway create',
      'az network lb create',
      'az network lb address-pool create',
      'az network lb probe create',
      'az network lb rule create',
      'az network private-endpoint create',
      'az network private-endpoint dns-zone-group create',
      'az network private-endpoint ip-config add',
    ]) expect(cli).toContain(command)
    expect(cli).toContain('VPN_RADIUS_SECRET_')
    expect(cli).not.toContain('secret-reference://key-vault/vpn-radius-shared-secret')
  })

  it('maps complex Terraform resources and modeled child fields back to the canvas', () => {
    const { design } = createShowcaseDesign('terraform-traceability')
    const result = generateInfrastructureResult(design.nodes, design.edges, 'terraform')
    for (const kind of ['appGateway', 'firewall', 'vpnGateway', 'loadBalancer', 'privateEndpoint'] as const) {
      const node = design.nodes.find((candidate: NetworkNode) => candidate.data.kind === kind)!
      expect(result.mappings.some((mapping) => mapping.nodeId === node.id && mapping.kind === 'code')).toBe(true)
    }
    const loadBalancer = design.nodes.find((node: NetworkNode) => node.data.kind === 'loadBalancer')!
    expect(result.mappings.some((mapping) => mapping.nodeId === loadBalancer.id && mapping.field === 'probe')).toBe(true)
    expect(result.mappings.some((mapping) => mapping.nodeId === loadBalancer.id && mapping.field === 'rule')).toBe(true)
  })

  it('embeds an exact structured Application Gateway ARM body in Azure CLI output', () => {
    const { design } = createShowcaseDesign('application-gateway-cli')
    const cli = generateInfrastructure(design.nodes, design.edges, 'azureCli')
    const encoded = cli.match(/APPGW_BODY_[A-Z0-9_]+=\$\(printf %s '([^']+)' \| base64 --decode\)/)?.[1]
    expect(encoded).toBeDefined()
    const bytes = Uint8Array.from(atob(encoded!), (character) => character.charCodeAt(0))
    const body = JSON.parse(new TextDecoder().decode(bytes))
    expect(body.properties.gatewayIPConfigurations).toHaveLength(1)
    expect(body.properties.frontendIPConfigurations[0].name).toBe('frontend-private')
    expect(body.properties.httpListeners[0].name).toBe('http-listener')
    expect(body.properties.requestRoutingRules[0].name).toBe('route-web')
    expect(JSON.stringify(body)).toContain('__SUBSCRIPTION_ID__')
  })

  it('uses obvious references rather than plausible secrets', () => {
    const serialized = JSON.stringify(createShowcaseDesign('secrets').design)
    expect(serialized).toContain('secret-reference://')
    expect(serialized).not.toMatch(/"radius_server_secret":"(?!secret-reference:\/\/)/)
  })
})
