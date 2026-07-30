import { describe, expect, it } from 'vitest'
import { generateInfrastructure, generateInfrastructureResult, getExportReport } from './generators'
import { isNetworkDesign, RESOURCE_SCHEMAS, validateDesign, type NetworkNode, type ResourceField } from './model'
import { createShowcaseDesign, getShowcaseLayoutProfile, getShowcaseMinimums, getShowcaseRequirements, normalizeShowcaseSelection, randomizeShowcaseSelection, SHOWCASE_PRESETS } from './showcaseDesign'
import { validateRequest } from '../server/validation'

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

  it('derives and enforces dependency minimums from the selected resource types', () => {
    const requested = { appGateway: 2, firewall: 1, vpnGateway: 1, privateEndpoint: 1, natGateway: 1 }
    const minimums = getShowcaseMinimums(requested)
    expect(minimums.vnet).toBe(1)
    expect(minimums.subnet).toBe(5)
    expect(minimums.publicIp).toBe(3)

    const normalized = normalizeShowcaseSelection({ ...requested, vnet: 0, subnet: 1, publicIp: 1 })
    expect(normalized.vnet).toBe(1)
    expect(normalized.subnet).toBe(5)
    expect(normalized.publicIp).toBe(3)
  })

  it('explains Azure-aware dependency minimums from declarative resource rules', () => {
    const requirements = getShowcaseRequirements({ firewall: 2, vpnGateway: 2, appGateway: 1, natGateway: 1 })
    expect(requirements.vnet.minimum).toBe(2)
    expect(requirements.subnet.minimum).toBe(6)
    expect(requirements.publicIp.minimum).toBe(5)
    expect(requirements.subnet.reasons.join(' ')).toContain('AzureFirewallSubnet')
    expect(requirements.subnet.reasons.join(' ')).toContain('GatewaySubnet')
    expect(requirements.publicIp.reasons.join(' ')).toContain('dedicated')
  })

  it('offers valid named presets and preserves their exact explicit selections', () => {
    expect(SHOWCASE_PRESETS.map((preset) => preset.id)).toEqual(['minimal-hub-spoke', 'secure-egress', 'private-application', 'hybrid-vpn', 'full-showcase'])
    for (const preset of SHOWCASE_PRESETS) {
      expect(preset.label).toBeTruthy()
      expect(preset.description).toBeTruthy()
      const normalized = normalizeShowcaseSelection(preset.selection)
      expect(Object.values(normalized).some((count) => count > 0)).toBe(true)
      expect(validateDesign(createShowcaseDesign(`preset-${preset.id}`, normalized).design.nodes, createShowcaseDesign(`preset-${preset.id}`, normalized).design.edges)).toEqual([])
    }
  })

  it('randomizes only included resource types within each complexity range', () => {
    const selected = { vnet: 1, subnet: 1, firewall: 1, frontDoor: 0 }
    expect(randomizeShowcaseSelection(selected, 'small', () => 0)).toMatchObject({ vnet: 1, subnet: 1, firewall: 1, frontDoor: 0 })
    expect(randomizeShowcaseSelection(selected, 'small', () => 0.999)).toMatchObject({ vnet: 2, subnet: 2, firewall: 2, frontDoor: 0 })
    expect(randomizeShowcaseSelection(selected, 'medium', () => 0.999)).toMatchObject({ vnet: 5, subnet: 5, firewall: 5, frontDoor: 0 })
    expect(randomizeShowcaseSelection(selected, 'absurd', () => 0)).toMatchObject({ vnet: 5, subnet: 5, firewall: 5, frontDoor: 0 })
    expect(randomizeShowcaseSelection(selected, 'absurd', () => 0.999)).toMatchObject({ vnet: 20, subnet: 20, firewall: 20, frontDoor: 0 })
  })

  it('adapts spacing to topology size and switches to compact mode above 50 resources', () => {
    const roomy = getShowcaseLayoutProfile(20)
    const balanced = getShowcaseLayoutProfile(40)
    const compact = getShowcaseLayoutProfile(51)

    expect(roomy.mode).toBe('standard')
    expect(balanced.mode).toBe('standard')
    expect(compact.mode).toBe('compact')
    expect(roomy.columnGap).toBeGreaterThan(balanced.columnGap)
    expect(balanced.columnGap).toBeGreaterThan(compact.columnGap)
    expect(roomy.rowGap).toBeGreaterThan(compact.rowGap)
    expect(compact.warning).toContain('51')
  })

  it('wraps very large selections into bounded-width hierarchy bands without overlaps', () => {
    const selection = Object.fromEntries(Object.keys(SHOWCASE_PRESETS[4].selection).map((kind) => [kind, 20]))
    const { design } = createShowcaseDesign('large-layout', selection)
    const xs = design.nodes.map((node) => node.position.x)
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(2100)
    expect(new Set(design.nodes.map((node) => `${node.position.x}:${node.position.y}`)).size).toBe(design.nodes.length)
    const minimumY = (kinds: string[]) => Math.min(...design.nodes.filter((node) => kinds.includes(node.data.kind)).map((node) => node.position.y))
    const maximumY = (kinds: string[]) => Math.max(...design.nodes.filter((node) => kinds.includes(node.data.kind)).map((node) => node.position.y))
    expect(maximumY(['frontDoor', 'publicIp'])).toBeLessThan(minimumY(['vnet']))
    expect(maximumY(['vnet'])).toBeLessThan(minimumY(['subnet']))
    expect(maximumY(['subnet'])).toBeLessThan(minimumY(['appGateway', 'natGateway', 'firewall', 'vpnGateway', 'loadBalancer', 'privateEndpoint', 'networkSecurityGroup', 'routeTable']))
  })

  it('keeps subnet and resource groups contiguous beneath their parent VNet cluster', () => {
    const { design } = createShowcaseDesign('clustered-layout', {
      vnet: 6, subnet: 18, appGateway: 6, natGateway: 6, firewall: 3, vpnGateway: 3,
      loadBalancer: 6, privateEndpoint: 6, publicIp: 12, networkSecurityGroup: 6, routeTable: 6,
    })
    const byId = new Map(design.nodes.map((node) => [node.id, node]))
    const parentByNode = new Map<string, string>()
    for (const subnet of design.nodes.filter((node) => node.data.kind === 'subnet')) parentByNode.set(subnet.id, String(subnet.data.parentVnetId))
    let changed = true
    while (changed) {
      changed = false
      for (const edge of design.edges.filter((candidate) => candidate.data?.kind !== 'peering')) {
        const sourceParent = byId.get(edge.source)?.data.kind === 'vnet' ? edge.source : parentByNode.get(edge.source)
        const targetParent = byId.get(edge.target)?.data.kind === 'vnet' ? edge.target : parentByNode.get(edge.target)
        if (sourceParent && !parentByNode.has(edge.target)) { parentByNode.set(edge.target, sourceParent); changed = true }
        if (targetParent && !parentByNode.has(edge.source)) { parentByNode.set(edge.source, targetParent); changed = true }
      }
    }
    const assertContiguousParents = (items: NetworkNode[]) => {
      const orderedParents = [...items].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x).map((node) => parentByNode.get(node.id)).filter(Boolean)
      const completed = new Set<string>()
      let active: string | undefined
      for (const parent of orderedParents) {
        if (parent !== active) {
          if (active) completed.add(active)
          expect(completed.has(parent!), `${parent} should occupy one contiguous layout cluster`).toBe(false)
          active = parent
        }
      }
    }
    assertContiguousParents(design.nodes.filter((node) => node.data.kind === 'subnet'))
    assertContiguousParents(design.nodes.filter((node) => !['frontDoor', 'publicIp', 'vnet', 'subnet'].includes(node.data.kind)))
  })

  it('assigns exact service subnet roles and never reuses Public IPs across owners', () => {
    const selection = normalizeShowcaseSelection({ firewall: 2, vpnGateway: 2, appGateway: 2, privateEndpoint: 1, natGateway: 2 })
    const { design } = createShowcaseDesign('azure-aware', selection)
    const byId = new Map(design.nodes.map((node) => [node.id, node]))
    const referenceId = (value: unknown) => String(value ?? '').replace('resource-reference://', '')
    const ownedPublicIps: string[] = []

    for (const firewall of design.nodes.filter((node) => node.data.kind === 'firewall')) {
      const configuration = (firewall.data.ip_configuration as Array<Record<string, unknown>>)[0]
      const subnet = byId.get(referenceId(configuration.subnet_id))
      expect(subnet?.data.label).toBe('AzureFirewallSubnet')
      expect(subnet?.data.addressSpace?.endsWith('/26')).toBe(true)
      ownedPublicIps.push(referenceId(configuration.public_ip_address_id))
      expect(design.edges.some((edge) => edge.source === subnet?.id && edge.target === firewall.id)).toBe(true)
    }
    for (const gateway of design.nodes.filter((node) => node.data.kind === 'vpnGateway')) {
      const configuration = (gateway.data.ip_configuration as Array<Record<string, unknown>>)[0]
      const subnet = byId.get(referenceId(configuration.subnet_id))
      expect(subnet?.data.label).toBe('GatewaySubnet')
      ownedPublicIps.push(referenceId(configuration.public_ip_address_id))
      expect(design.edges.some((edge) => edge.source === subnet?.id && edge.target === gateway.id)).toBe(true)
    }
    for (const edge of design.edges.filter((edge) => edge.data?.kind === 'natGatewayPublicIp')) ownedPublicIps.push(edge.target)

    expect(new Set(ownedPublicIps).size).toBe(ownedPublicIps.length)
    expect(ownedPublicIps.every((id) => byId.get(id)?.data.kind === 'publicIp')).toBe(true)
    expect(validateDesign(design.nodes, design.edges)).toEqual([])

    const terraform = generateInfrastructure(design.nodes, design.edges, 'terraform')
    const subnetSymbols = [...terraform.matchAll(/resource "azurerm_subnet" "([^"]+)"/g)].map((match) => match[1])
    expect(subnetSymbols).toHaveLength(selection.subnet)
    expect(new Set(subnetSymbols).size).toBe(subnetSymbols.length)
  })

  it('generates exactly the normalized resource counts and keeps the custom design valid', () => {
    const requested = { vnet: 1, subnet: 1, appGateway: 2, networkSecurityGroup: 1, routeTable: 1, frontDoor: 0 }
    const selection = normalizeShowcaseSelection(requested)
    const { design } = createShowcaseDesign('custom-counts', selection)
    const counts = design.nodes.reduce<Record<string, number>>((result, node) => {
      result[node.data.kind] = (result[node.data.kind] ?? 0) + 1
      return result
    }, {})

    for (const kind of Object.keys(RESOURCE_SCHEMAS)) expect(counts[kind] ?? 0).toBe(selection[kind as keyof typeof selection])
    expect(validateDesign(design.nodes, design.edges)).toEqual([])
    expect(isNetworkDesign(JSON.parse(JSON.stringify(design)))).toBe(true)
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
    expect(terraform).toContain('sensitive   = true')
    expect(terraform).toMatch(/radius_server_secret\s+= var\./)
    expect(validateRequest({ format: 'terraform', code: terraform }).ok).toBe(true)

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
    expect(bicep).not.toContain('secret-reference://')
    expect(validateRequest({ format: 'bicep', code: bicep }).ok).toBe(true)

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
    expect(cli).not.toContain('secret-reference://')
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

  it('stores only deployment-time secret intent, never secret values or references', () => {
    const serialized = JSON.stringify(createShowcaseDesign('secrets').design)
    expect(serialized).toContain('"radius_secret_required":true')
    expect(serialized).not.toContain('radius_server_secret')
    expect(serialized).not.toContain('secret-reference://')
  })
})
