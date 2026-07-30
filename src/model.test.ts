import { describe, expect, it } from 'vitest'
import { associationKindFor, attachSubnetToVnet, AZURE_REGIONS, cidrsOverlap, createAttachedResource, defaultNodeData, getAttachableChildKinds, isNetworkDesign, parseCidr, RESOURCE_SCHEMAS, starterDesign, validateDesign, type NetworkEdge, type NetworkNode } from './model'
import { generateInfrastructure, generateInfrastructureResult, getExportReport } from './generators'

describe('CIDR validation', () => {
  it('offers South Central US as an Azure deployment region', () => {
    expect(AZURE_REGIONS).toContain('southcentralus')
  })
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
    const injected = structuredClone(starterDesign)
    injected.nodes[0].data.label = 'safe\n# injected output'
    expect(isNetworkDesign(injected)).toBe(false)
  })
  it('accepts Azure Front Door nodes in persisted designs', () => {
    const design = structuredClone(starterDesign)
    design.nodes.push({ id: 'front-door', type: 'azureResource', position: { x: 0, y: 0 }, data: { label: 'afd-prod', kind: 'frontDoor', region: 'global', resourceGroup: 'rg-edge' } })
    expect(isNetworkDesign(design)).toBe(true)
  })
  it('keeps imported VNets diagram-only until adoption is explicit', () => {
    const nodes = structuredClone(starterDesign.nodes)
    nodes[0].data.imported = true
    expect(validateDesign(nodes, starterDesign.edges)).toContain('Imported resources are diagram-only until explicitly adopted for management')
  })
})

describe('attached resource creation', () => {
  it('offers only modeled direct children for each parent kind', () => {
    expect(getAttachableChildKinds('vnet')).toEqual(['subnet'])
    expect(getAttachableChildKinds('subnet')).toEqual(['networkSecurityGroup', 'routeTable', 'natGateway', 'firewall'])
    expect(getAttachableChildKinds('natGateway')).toEqual(['publicIp'])
    expect(getAttachableChildKinds('firewall')).toEqual(['publicIp'])
    expect(getAttachableChildKinds('appGateway')).toEqual(['publicIp'])
  })

  it('creates a subnet inside its VNet with inherited scope and a containment edge', () => {
    const vnet = structuredClone(starterDesign.nodes[0])
    const result = createAttachedResource(vnet, 'subnet', [vnet], 'child-subnet', 'child-edge')
    expect(result.node.data).toMatchObject({ kind: 'subnet', parentVnetId: vnet.id, region: vnet.data.region, resourceGroup: vnet.data.resourceGroup, addressSpace: '10.0.1.0/24' })
    expect(result.node.position.y).toBeGreaterThan(vnet.position.y)
    expect(result.edge).toMatchObject({ id: 'child-edge', source: vnet.id, target: 'child-subnet', data: { kind: 'attachment' } })
    expect(validateDesign([vnet, result.node], [result.edge])).toEqual([])
  })

  it('moves a new child down until it no longer overlaps an existing resource', () => {
    const vnet = structuredClone(starterDesign.nodes[0])
    const blocker = { ...structuredClone(starterDesign.nodes[1]), position: { x: vnet.position.x, y: vnet.position.y + 150 } }
    const result = createAttachedResource(vnet, 'subnet', [vnet, blocker], 'subnet', 'edge')
    expect(result.node.position.y).toBeGreaterThan(blocker.position.y + 90)
  })

  it('attaches an NSG to a subnet with the typed association and inherited VNet scope', () => {
    const vnet = structuredClone(starterDesign.nodes[0])
    const subnet = createAttachedResource(vnet, 'subnet', [vnet], 'subnet', 'subnet-edge').node
    const result = createAttachedResource(subnet, 'networkSecurityGroup', [vnet, subnet], 'nsg', 'nsg-edge')
    expect(result.node.data).toMatchObject({ kind: 'networkSecurityGroup', region: vnet.data.region, resourceGroup: vnet.data.resourceGroup })
    expect(result.edge).toMatchObject({ source: subnet.id, target: 'nsg', data: { kind: 'subnetNetworkSecurityGroup' } })
  })

  it('reparents a standalone subnet, fixes an out-of-range default prefix, and adds containment', () => {
    const vnet = structuredClone(starterDesign.nodes[0])
    const subnet: NetworkNode = { id: 'standalone-subnet', type: 'azureResource', position: { x: 900, y: 900 }, data: { ...defaultNodeData('subnet'), label: 'subnet-1', addressSpace: '10.30.1.0/24', addressSpaces: ['10.30.1.0/24'] } }
    const result = attachSubnetToVnet(subnet, vnet, [vnet, subnet], 'containment-edge')
    expect(result.node.data).toMatchObject({ parentVnetId: vnet.id, addressSpace: '10.0.1.0/24', addressSpaces: ['10.0.1.0/24'], region: vnet.data.region, resourceGroup: vnet.data.resourceGroup })
    expect(result.edge).toMatchObject({ source: vnet.id, target: subnet.id, data: { kind: 'attachment' } })
    expect(getExportReport([vnet, result.node], [result.edge], 'terraform').unsupported).toEqual([])
  })

  it('preserves a valid subnet prefix when selecting its parent VNet', () => {
    const vnet = structuredClone(starterDesign.nodes[0])
    const subnet: NetworkNode = { id: 'standalone-subnet', type: 'azureResource', position: { x: 900, y: 900 }, data: { ...defaultNodeData('subnet'), label: 'subnet-1', addressSpace: '10.0.9.0/24', addressSpaces: ['10.0.9.0/24'] } }
    const result = attachSubnetToVnet(subnet, vnet, [vnet, subnet], 'containment-edge')
    expect(result.node.data.addressSpaces).toEqual(['10.0.9.0/24'])
  })

  it('creates and references a dedicated Public IP from an Azure Firewall configuration', () => {
    const firewall = { ...structuredClone(starterDesign.nodes[1]), data: { ...defaultNodeData('firewall'), label: 'firewall', ip_configuration: [{ name: 'primary', subnet_id: 'subnet' }] } }
    const result = createAttachedResource(firewall, 'publicIp', [firewall], 'firewall-pip', 'firewall-pip-edge')
    expect(result.edge).toMatchObject({ source: firewall.id, target: 'firewall-pip', data: { kind: 'firewallPublicIp' } })
    expect(result.parentPatch).toEqual({ ip_configuration: [{ name: 'primary', subnet_id: 'subnet', public_ip_address_id: 'resource-reference://firewall-pip' }] })
    expect(result.node.data).toMatchObject({ kind: 'publicIp', allocation_method: 'Static', sku: 'Standard' })
  })

  it('creates and references a Public IP from an Application Gateway frontend configuration', () => {
    const appGateway: NetworkNode = { id: 'appgw', type: 'azureResource', position: { x: 200, y: 180 }, data: { ...defaultNodeData('appGateway'), label: 'agw-app', frontend_ip_configuration: [{ name: 'public-frontend' }] } }
    const result = createAttachedResource(appGateway, 'publicIp', [appGateway], 'appgw-pip', 'appgw-pip-edge')
    expect(result.edge).toMatchObject({ source: appGateway.id, target: 'appgw-pip', data: { kind: 'appGatewayPublicIp' } })
    expect(result.parentPatch).toEqual({ frontend_ip_configuration: [{ name: 'public-frontend', public_ip_address_id: 'resource-reference://appgw-pip' }] })
    expect(result.node.data).toMatchObject({ kind: 'publicIp', allocation_method: 'Static', sku: 'Standard' })
  })

  it('creates an Azure Firewall directly from a parented subnet and configures the subnet reference', () => {
    const vnet = structuredClone(starterDesign.nodes[0])
    const subnet: NetworkNode = { id: 'firewall-subnet', type: 'azureResource', position: { x: 120, y: 220 }, data: { ...defaultNodeData('subnet'), label: 'snet-firewall', parentVnetId: vnet.id, addressSpace: '10.0.1.0/24', addressSpaces: ['10.0.1.0/24'] } }
    const created = createAttachedResource(subnet, 'firewall', [vnet, subnet], 'firewall-child', 'firewall-edge')
    expect(created.node.data.kind).toBe('firewall')
    expect(created.node.data.ip_configuration).toEqual([{ name: 'firewall-ip-1', subnet_id: 'firewall-subnet' }])
    expect(created.edge).toMatchObject({ source: subnet.id, target: 'firewall-child', data: { kind: 'firewallSubnet' } })
    expect(created.parentPatch).toEqual({ label: 'AzureFirewallSubnet' })
    expect(created.node.data).toMatchObject({ region: vnet.data.region, resourceGroup: vnet.data.resourceGroup })
  })

  it('requires a subnet to have a parent VNet before adding an Azure Firewall', () => {
    const subnet: NetworkNode = { id: 'orphan-subnet', type: 'azureResource', position: { x: 0, y: 0 }, data: { ...defaultNodeData('subnet'), label: 'orphan' } }
    expect(() => createAttachedResource(subnet, 'firewall', [subnet], 'firewall-child', 'firewall-edge')).toThrow('parent virtual network')
  })

  it('rejects child kinds that do not have a modeled parent relationship', () => {
    expect(() => createAttachedResource(starterDesign.nodes[0], 'networkSecurityGroup', starterDesign.nodes, 'bad', 'bad-edge')).toThrow('cannot be attached directly')
  })
})

describe('AzureRM configuration catalog', () => {
  const fieldsFor = (kind: keyof typeof RESOURCE_SCHEMAS) => {
    const visit = (fields: typeof RESOURCE_SCHEMAS[typeof kind]['fields']): string[] => fields.flatMap((field) => [String(field.key), ...visit(field.fields ?? [])])
    return visit(RESOURCE_SCHEMAS[kind].fields)
  }

  it('covers the high-value Terraform arguments for every resource icon', () => {
    expect(Object.keys(RESOURCE_SCHEMAS)).toHaveLength(12)
    expect(fieldsFor('vnet')).toEqual(expect.arrayContaining(['dns_servers', 'bgp_community', 'flow_timeout_in_minutes', 'private_endpoint_vnet_policies']))
    expect(fieldsFor('subnet')).toEqual(expect.arrayContaining(['addressSpaces', 'default_outbound_access_enabled', 'private_endpoint_network_policies', 'delegation']))
    expect(fieldsFor('natGateway')).toEqual(expect.arrayContaining(['sku_name', 'zones', 'idle_timeout_in_minutes']))
    expect(fieldsFor('appGateway')).toEqual(expect.arrayContaining(['gateway_ip_configuration', 'frontend_ip_configuration', 'frontend_port', 'backend_address_pool', 'backend_http_settings', 'http_listener', 'request_routing_rule', 'waf_configuration']))
    expect(fieldsFor('firewall')).toEqual(expect.arrayContaining(['sku_name', 'sku_tier', 'ip_configuration', 'management_ip_configuration', 'virtual_hub']))
    expect(fieldsFor('vpnGateway')).toEqual(expect.arrayContaining(['type', 'vpn_type', 'ip_configuration', 'bgp_settings', 'vpn_client_configuration']))
    expect(fieldsFor('loadBalancer')).toEqual(expect.arrayContaining(['sku_tier', 'edge_zone', 'frontend_ip_configuration', 'probe', 'rule']))
    expect(fieldsFor('privateEndpoint')).toEqual(expect.arrayContaining(['subnet_id', 'private_service_connection', 'private_dns_zone_group', 'ip_configuration']))
    expect(fieldsFor('frontDoor')).toEqual(expect.arrayContaining(['sku_name', 'response_timeout_seconds', 'identity', 'log_scrubbing_rule']))
  })

  it('publishes provider defaults, enums, cardinality, and numeric constraints', () => {
    expect(RESOURCE_SCHEMAS.natGateway.defaults).toMatchObject({ sku_name: 'Standard', idle_timeout_in_minutes: 4 })
    expect(RESOURCE_SCHEMAS.natGateway.fields.find((field) => field.key === 'idle_timeout_in_minutes')).toMatchObject({ min: 4, max: 120, step: 1 })
    expect(RESOURCE_SCHEMAS.natGateway.fields.find((field) => field.key === 'sku_name')?.options).toContain('StandardV2')
    expect(RESOURCE_SCHEMAS.vpnGateway.fields.find((field) => field.key === 'sku')?.options).toEqual(expect.arrayContaining(['Basic', 'UltraPerformance', 'ErGwScale', 'VpnGw5AZ']))
    expect(RESOURCE_SCHEMAS.appGateway.fields.find((field) => field.key === 'gateway_ip_configuration')).toMatchObject({ repeatable: true, minItems: 1, maxItems: 2 })
    expect(defaultNodeData('frontDoor').region).toBe('global')
  })

  it('validates critical conditional provider rules', () => {
    const nat = { id: 'nat-v2', type: 'azureResource' as const, position: { x: 0, y: 0 }, data: { ...defaultNodeData('natGateway'), label: 'nat-v2', sku_name: 'StandardV2', zones: ['1'] } }
    expect(validateDesign([nat], [])).toContain('nat-v2: StandardV2 NAT Gateway does not support availability zones')
    const lb = { id: 'lb', type: 'azureResource' as const, position: { x: 0, y: 0 }, data: { ...defaultNodeData('loadBalancer'), label: 'lb-global', sku: 'Gateway', sku_tier: 'Global' } }
    expect(validateDesign([lb], [])).toContain('lb-global: Global Load Balancer tier requires Standard SKU')
    const vpn = { id: 'vpn', type: 'azureResource' as const, position: { x: 0, y: 0 }, data: { ...defaultNodeData('vpnGateway'), label: 'vpn-policy', vpn_type: 'PolicyBased', sku: 'VpnGw1' } }
    expect(validateDesign([vpn], [])).toContain('vpn-policy: PolicyBased VPN gateways support only the Basic SKU')
    const endpoint = { id: 'pe', type: 'azureResource' as const, position: { x: 0, y: 0 }, data: { ...defaultNodeData('privateEndpoint'), label: 'pe-manual', subnet_id: 'subnet', private_service_connection: { name: 'connection', is_manual_connection: true, private_connection_resource_id: '/subscriptions/example/resource' } } }
    expect(validateDesign([endpoint], [])).toContain('pe-manual: manual private service connection requires a request message')
    const frontDoor = { id: 'afd', type: 'azureResource' as const, position: { x: 0, y: 0 }, data: { ...defaultNodeData('frontDoor'), label: 'afd', region: 'eastus' } }
    expect(validateDesign([frontDoor], [])).toContain('afd: Azure Front Door profiles are global and cannot have a regional location')
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
    nodes.forEach((node) => { node.data.subscriptionId = '11111111-1111-1111-1111-111111111111'; node.data.resourceGroup = 'rg-network-prod' })
    expect(generateInfrastructure(nodes, starterDesign.edges, 'terraform')).toContain('["10.0.0.0/16", "10.50.0.0/16"]')
    const bicep = generateInfrastructure(nodes, starterDesign.edges, 'bicep')
    expect(bicep).toContain("addressPrefixes: ['10.0.0.0/16', '10.50.0.0/16']")
    expect(bicep).not.toMatch(/name: "/)
    const cli = generateInfrastructure(nodes, starterDesign.edges, 'azureCli')
    expect(cli).toContain('--subscription "$SUBSCRIPTION_ID"')
    expect(cli).toContain("'10.0.0.0/16' '10.50.0.0/16'")
  })
  it('blocks cross-resource-group Bicep instead of emitting invalid cross-scope resources', () => {
    const nodes = structuredClone(starterDesign.nodes.filter((node) => node.data.kind === 'vnet'))
    const report = getExportReport(nodes, [], 'bicep')
    expect(report.supported).toEqual([])
    expect(report.unsupported.every(({ reason }) => reason.includes('one resource group'))).toBe(true)
  })
  it('uses collision-resistant deterministic symbols', () => {
    const nodes = structuredClone(starterDesign.nodes)
    nodes[2].data.label = 'vnet_hub_prod'
    nodes[2].data.resourceGroup = nodes[0].data.resourceGroup
    const terraform = generateInfrastructure(nodes, starterDesign.edges, 'terraform')
    const symbols = [...terraform.matchAll(/resource "azurerm_virtual_network" "([^"]+)"/g)].map((match) => match[1])
    expect(new Set(symbols).size).toBe(symbols.length)
  })
  it('defines editor fields and explicit per-format capabilities for every resource kind', () => {
    for (const schema of Object.values(RESOURCE_SCHEMAS)) {
      expect(schema.fields.length).toBeGreaterThan(0)
      expect(schema.export.terraform.status).toMatch(/supported|unsupported/)
      expect(schema.export.azureCli.status).toMatch(/supported|unsupported/)
      expect(defaultNodeData(schema.kind).kind).toBe(schema.kind)
    }
  })
  it('generates complete supported Terraform and CLI resources without silently dropping nodes', () => {
    const nodes = [
      { ...starterDesign.nodes[0], data: { ...starterDesign.nodes[0].data, addressSpaces: ['10.0.0.0/16'] } },
      { id: 'subnet', type: 'azureResource' as const, position: { x: 0, y: 0 }, data: { ...defaultNodeData('subnet'), label: 'snet-app', addressSpace: '10.0.1.0/24', parentVnetId: 'hub' } },
      { id: 'nat-only', type: 'azureResource' as const, position: { x: 0, y: 0 }, data: { ...defaultNodeData('natGateway'), label: 'nat-egress' } },
      { id: 'front-door', type: 'azureResource' as const, position: { x: 0, y: 0 }, data: { ...defaultNodeData('frontDoor'), label: 'afd-edge' } },
    ]
    const terraform = generateInfrastructure(nodes, [], 'terraform')
    expect(terraform).toContain('resource "azurerm_subnet"')
    expect(terraform).toContain('resource "azurerm_nat_gateway"')
    expect(terraform).toContain('resource "azurerm_cdn_frontdoor_profile"')
    const cli = generateInfrastructure(nodes, [], 'azureCli')
    expect(cli).toContain('az network vnet subnet create')
    expect(cli).toContain('az network nat gateway create')
    expect(cli).toContain('az afd profile create')
    expect(getExportReport(nodes, [], 'terraform').unsupported).toEqual([])
  })
  it('infers an Azure Firewall IP configuration from attached subnet and Public IP edges', () => {
    const vnet = structuredClone(starterDesign.nodes[0])
    const subnet: NetworkNode = { id: 'firewall-subnet', type: 'azureResource', position: { x: 0, y: 0 }, data: { ...defaultNodeData('subnet'), label: 'AzureFirewallSubnet', parentVnetId: vnet.id, addressSpace: '10.0.1.0/24', addressSpaces: ['10.0.1.0/24'] } }
    const firewall: NetworkNode = { id: 'firewall-test', type: 'azureResource', position: { x: 0, y: 0 }, data: { ...defaultNodeData('firewall'), label: 'afw-test' } }
    const publicIp: NetworkNode = { id: 'firewall-pip', type: 'azureResource', position: { x: 0, y: 0 }, data: { ...defaultNodeData('publicIp'), label: 'pip-firewall' } }
    const edges: NetworkEdge[] = [
      { id: 'subnet-parent', source: vnet.id, target: subnet.id, data: { kind: 'attachment' } },
      { id: 'firewall-subnet', source: firewall.id, target: subnet.id, data: { kind: 'attachment' } },
      { id: 'firewall-pip', source: firewall.id, target: publicIp.id, data: { kind: 'firewallPublicIp' } },
    ]
    const nodes = [vnet, subnet, firewall, publicIp]
    expect(getExportReport(nodes, edges, 'terraform').unsupported).toEqual([])
    const terraform = generateInfrastructure(nodes, edges, 'terraform')
    expect(terraform).toContain('subnet_id            = azurerm_subnet.')
    expect(terraform).toContain('public_ip_address_id = azurerm_public_ip.')
  })

  it('reports only the missing Public IP when an Azure Firewall subnet is already attached', () => {
    const vnet = structuredClone(starterDesign.nodes[0])
    const subnet: NetworkNode = { id: 'firewall-subnet', type: 'azureResource', position: { x: 0, y: 0 }, data: { ...defaultNodeData('subnet'), label: 'AzureFirewallSubnet', parentVnetId: vnet.id, addressSpace: '10.0.1.0/24', addressSpaces: ['10.0.1.0/24'] } }
    const firewall: NetworkNode = { id: 'firewall-test', type: 'azureResource', position: { x: 0, y: 0 }, data: { ...defaultNodeData('firewall'), label: 'afw-test' } }
    const edges: NetworkEdge[] = [{ id: 'firewall-subnet', source: firewall.id, target: subnet.id, data: { kind: 'attachment' } }]
    expect(getExportReport([vnet, subnet, firewall], edges, 'terraform').unsupported.find(({ node }) => node.id === firewall.id)?.reason).toBe('Every Azure Firewall IP configuration requires a Public IP reference.')
  })

  it('reports every unsupported or underconfigured node in output and export metadata', () => {
    const nodes = structuredClone(starterDesign.nodes)
    const report = getExportReport(nodes, starterDesign.edges, 'terraform')
    expect(report.unsupported.map((item) => item.node.data.kind)).toEqual(expect.arrayContaining(['firewall', 'appGateway']))
    const output = generateInfrastructure(nodes, starterDesign.edges, 'terraform')
    expect(output).toContain('UNSUPPORTED RESOURCE: afw-hub-prod')
    expect(output).toContain('UNSUPPORTED RESOURCE: agw-app-prod')
    const subnet = { id: 'orphan', type: 'azureResource' as const, position: { x: 0, y: 0 }, data: { ...defaultNodeData('subnet'), label: 'snet-orphan' } }
    expect(getExportReport([subnet], [], 'azureCli').unsupported[0].reason).toContain('Parent virtual network')
  })
  it('blocks export instead of silently dropping configured catalog fields', () => {
    const vnet = structuredClone(starterDesign.nodes[0])
    vnet.data.dns_servers = ['10.0.0.4']
    expect(getExportReport([vnet], [], 'terraform').unsupported[0].reason).toContain('dns_servers')

    const nat = { id: 'nat-zone', type: 'azureResource' as const, position: { x: 0, y: 0 }, data: { ...defaultNodeData('natGateway'), label: 'nat-zone', zones: ['1'] } }
    expect(getExportReport([nat], [], 'azureCli').unsupported).toEqual([])
    expect(generateInfrastructure([nat], [], 'azureCli')).toContain("--zone '1'")

    const frontDoor = { id: 'afd-timeout', type: 'azureResource' as const, position: { x: 0, y: 0 }, data: { ...defaultNodeData('frontDoor'), label: 'afd-timeout', response_timeout_seconds: 180 } }
    for (const format of ['terraform', 'bicep', 'azureCli'] as const) expect(getExportReport([frontDoor], [], format).unsupported).toEqual([])
    expect(generateInfrastructure([frontDoor], [], 'terraform')).toContain('response_timeout_seconds = 180')
    expect(generateInfrastructure([frontDoor], [], 'bicep')).toContain('originResponseTimeoutSeconds: 180')
    expect(generateInfrastructure([frontDoor], [], 'azureCli')).toContain('--origin-response-timeout-seconds 180')
  })
  it('blocks every imported resource kind rather than only imported VNets', () => {
    const node = { id: 'imported-nat', type: 'azureResource' as const, position: { x: 0, y: 0 }, data: { ...defaultNodeData('natGateway'), label: 'existing-nat', imported: true } }
    expect(validateDesign([node], [])).toContain('Imported resources are diagram-only until explicitly adopted for management')
    expect(getExportReport([node], [], 'terraform').unsupported[0].reason).toContain('Imported')
  })
  it('is deterministic and escapes Terraform and shell string values', () => {
    const nodes = structuredClone(starterDesign.nodes.slice(0, 1))
    nodes[0].data.label = `edge's "network"`
    const first = generateInfrastructure(nodes, [], 'terraform')
    expect(first).toBe(generateInfrastructure(nodes, [], 'terraform'))
    expect(first).toContain(`name                = "edge's \\"network\\""`)
    expect(generateInfrastructure(nodes, [], 'azureCli')).toContain(`--name 'edge'\\''s "network"'`)
  })
  it('can infer a subnet parent from exactly one attachment edge', () => {
    const vnet = structuredClone(starterDesign.nodes[0])
    const subnet = { id: 'attached-subnet', type: 'azureResource' as const, position: { x: 0, y: 0 }, data: { ...defaultNodeData('subnet'), label: 'snet-attached', addressSpace: '10.0.2.0/24', parentVnetId: undefined } }
    const edges = [{ id: 'attachment', source: vnet.id, target: subnet.id, data: { kind: 'attachment' as const } }]
    expect(getExportReport([vnet, subnet], edges, 'terraform').unsupported).toEqual([])
    expect(generateInfrastructure([vnet, subnet], edges, 'terraform')).toContain('resource "azurerm_subnet"')
  })
  it('returns stable, line-addressable node and field mappings for every format', () => {
    const nodes = [
      { ...structuredClone(starterDesign.nodes[0]), data: { ...structuredClone(starterDesign.nodes[0].data), addressSpaces: ['10.0.0.0/16'] } },
      { id: 'nat-trace', type: 'azureResource' as const, position: { x: 0, y: 0 }, data: { ...defaultNodeData('natGateway'), label: 'nat-trace', idle_timeout_in_minutes: 10 } },
    ]
    for (const format of ['terraform', 'bicep', 'azureCli'] as const) {
      const first = generateInfrastructureResult(nodes, [], format)
      expect(first).toEqual(generateInfrastructureResult(nodes, [], format))
      expect(first.text).toBe(generateInfrastructure(nodes, [], format))
      for (const mapping of first.mappings) {
        expect(mapping.startLine).toBeGreaterThan(0)
        expect(mapping.endLine).toBeGreaterThanOrEqual(mapping.startLine)
        expect(mapping.endLine).toBeLessThanOrEqual(first.text.split('\n').length)
      }
      const vnetName = first.mappings.find((mapping) => mapping.nodeId === 'hub' && mapping.field === 'label')
      expect(vnetName).toBeDefined()
      expect(first.text.split('\n')[vnetName!.startLine - 1]).toContain('vnet-hub-prod')
    }
  })
  it('maps configured unsupported fields to their generated diagnostic line', () => {
    const vnet = structuredClone(starterDesign.nodes[0])
    vnet.data.dns_servers = ['10.0.0.4']
    const result = generateInfrastructureResult([vnet], [], 'terraform')
    const diagnostic = result.mappings.find((mapping) => mapping.nodeId === vnet.id && mapping.field === 'dns_servers')
    expect(diagnostic).toMatchObject({ kind: 'diagnostic', startLine: 1, endLine: 1 })
    expect(result.text.split('\n')[diagnostic!.startLine - 1]).toContain('Configured field dns_servers')
    expect(result.mappings.find((mapping) => mapping.nodeId === vnet.id && !mapping.field)).toMatchObject({ kind: 'diagnostic', startLine: 1, endLine: 1 })
  })
  it('rejects Azure-invalid or overlapping subnet prefixes before export', () => {
    const vnet = structuredClone(starterDesign.nodes[0])
    const first = { id: 'subnet-a', type: 'azureResource' as const, position: { x: 0, y: 0 }, data: { ...defaultNodeData('subnet'), label: 'snet-a', addressSpace: '10.0.1.0/30', parentVnetId: vnet.id } }
    expect(getExportReport([vnet, first], [], 'terraform').unsupported[0].reason).toContain('/29 or larger')
    first.data.addressSpace = '10.0.1.0/24'
    const second = { ...structuredClone(first), id: 'subnet-b', data: { ...first.data, label: 'snet-b', addressSpace: '10.0.1.128/25' } }
    expect(getExportReport([vnet, first, second], [], 'terraform').unsupported.map(({ node }) => node.id)).toEqual(expect.arrayContaining(['subnet-a', 'subnet-b']))
  })
})

describe('first-class network primitives and typed associations', () => {
  it('publishes schemas and validates conditional rules', () => {
    expect(Object.keys(RESOURCE_SCHEMAS)).toHaveLength(12)
    expect(RESOURCE_SCHEMAS.publicIp.fields.map((field) => field.key)).toEqual(expect.arrayContaining(['allocation_method', 'sku', 'sku_tier', 'zones', 'ip_version', 'domain_name_label', 'reverse_fqdn', 'idle_timeout_in_minutes', 'edge_zone']))
    expect(RESOURCE_SCHEMAS.networkSecurityGroup.fields.map((field) => field.key)).toContain('security_rule')
    expect(RESOURCE_SCHEMAS.routeTable.fields.map((field) => field.key)).toEqual(expect.arrayContaining(['disable_bgp_route_propagation', 'route']))
    const pip = { id: 'pip', type: 'azureResource' as const, position: { x: 0, y: 0 }, data: { ...defaultNodeData('publicIp'), label: 'pip', sku: 'Standard', allocation_method: 'Dynamic' } }
    expect(validateDesign([pip], [])).toContain('pip: Standard Public IP requires Static allocation')
    const routeTable = { id: 'rt', type: 'azureResource' as const, position: { x: 0, y: 0 }, data: { ...defaultNodeData('routeTable'), label: 'rt', route: [{ name: 'default', address_prefix: '0.0.0.0/0', next_hop_type: 'VirtualAppliance' }] } }
    expect(validateDesign([routeTable], [])).toContain('rt: route default requires next_hop_in_ip_address for VirtualAppliance')
  })

  it('infers and validates typed associations', () => {
    expect(associationKindFor('subnet', 'networkSecurityGroup')).toBe('subnetNetworkSecurityGroup')
    expect(associationKindFor('routeTable', 'subnet')).toBe('subnetRouteTable')
    expect(associationKindFor('subnet', 'natGateway')).toBe('subnetNatGateway')
    expect(associationKindFor('publicIp', 'natGateway')).toBe('natGatewayPublicIp')
    const subnet = { id: 'subnet', type: 'azureResource' as const, position: { x: 0, y: 0 }, data: { ...defaultNodeData('subnet'), label: 'subnet' } }
    const nsg = { id: 'nsg', type: 'azureResource' as const, position: { x: 0, y: 0 }, data: { ...defaultNodeData('networkSecurityGroup'), label: 'nsg' } }
    const edge = { id: 'nsg-association', source: subnet.id, target: nsg.id, data: { kind: 'subnetNetworkSecurityGroup' as const } }
    expect(validateDesign([subnet, nsg], [edge, { ...edge, id: 'duplicate' }])).toContain('Duplicate subnet to Network Security Group association')
    expect(validateDesign([subnet, nsg], [{ ...edge, data: { kind: 'natGatewayPublicIp' as const } }])).toContain('Invalid NAT Gateway to Public IP association')
  })

  it('emits complete resources, associations, and mappings in all exporters', () => {
    const vnet = { ...structuredClone(starterDesign.nodes[0]), data: { ...structuredClone(starterDesign.nodes[0].data), addressSpaces: ['10.0.0.0/16'] } }
    const subnet = { id: 'subnet-new', type: 'azureResource' as const, position: { x: 0, y: 0 }, data: { ...defaultNodeData('subnet'), label: 'snet-app', addressSpace: '10.0.1.0/24', addressSpaces: ['10.0.1.0/24'], parentVnetId: vnet.id, resourceGroup: 'rg-network-prod' } }
    const pip = { id: 'pip-new', type: 'azureResource' as const, position: { x: 0, y: 0 }, data: { ...defaultNodeData('publicIp'), label: 'pip-egress', domain_name_label: 'pip-egress', reverse_fqdn: 'egress.example.com', zones: ['1'], resourceGroup: 'rg-network-prod' } }
    const nat = { id: 'nat-new', type: 'azureResource' as const, position: { x: 0, y: 0 }, data: { ...defaultNodeData('natGateway'), label: 'nat-egress', resourceGroup: 'rg-network-prod' } }
    const nsg = { id: 'nsg-new', type: 'azureResource' as const, position: { x: 0, y: 0 }, data: { ...defaultNodeData('networkSecurityGroup'), label: 'nsg-app', resourceGroup: 'rg-network-prod', security_rule: [{ name: 'https', priority: 100, direction: 'Inbound', access: 'Allow', protocol: 'Tcp', source_port_ranges: ['*'], destination_port_ranges: ['443', '8443'], source_address_prefixes: ['Internet'], destination_address_prefixes: ['*'] }] } }
    const routeTable = { id: 'rt-new', type: 'azureResource' as const, position: { x: 0, y: 0 }, data: { ...defaultNodeData('routeTable'), label: 'rt-app', resourceGroup: 'rg-network-prod', disable_bgp_route_propagation: true, route: [{ name: 'default', address_prefix: '0.0.0.0/0', next_hop_type: 'VirtualAppliance', next_hop_in_ip_address: '10.0.0.4' }] } }
    const nodes = [vnet, subnet, pip, nat, nsg, routeTable]
    const edges = [
      { id: 'subnet-nsg', source: subnet.id, target: nsg.id, data: { kind: 'subnetNetworkSecurityGroup' as const } },
      { id: 'subnet-rt', source: routeTable.id, target: subnet.id, data: { kind: 'subnetRouteTable' as const } },
      { id: 'subnet-nat', source: subnet.id, target: nat.id, data: { kind: 'subnetNatGateway' as const } },
      { id: 'nat-pip', source: pip.id, target: nat.id, data: { kind: 'natGatewayPublicIp' as const } },
    ]
    expect(validateDesign(nodes, edges)).toEqual([])
    expect(getExportReport(nodes, edges, 'terraform').unsupported).toEqual([])
    const terraform = generateInfrastructure(nodes, edges, 'terraform')
    for (const resource of ['azurerm_public_ip', 'azurerm_network_security_group', 'azurerm_route_table', 'azurerm_subnet_network_security_group_association', 'azurerm_subnet_route_table_association', 'azurerm_subnet_nat_gateway_association', 'azurerm_nat_gateway_public_ip_association']) expect(terraform).toContain(`resource "${resource}"`)
    expect(terraform).toContain('source_port_ranges')
    expect(terraform).toContain('next_hop_in_ip_address')
    const bicep = generateInfrastructure(nodes, edges, 'bicep')
    expect(bicep).toContain('Microsoft.Network/publicIPAddresses@')
    expect(bicep).toContain('Microsoft.Network/networkSecurityGroups@')
    expect(bicep).toContain('Microsoft.Network/routeTables@')
    expect(bicep).toContain('networkSecurityGroup: { id:')
    expect(bicep).toContain('publicIpAddresses: [')
    const cli = generateInfrastructure(nodes, edges, 'azureCli')
    expect(cli).toContain('az network public-ip create')
    expect(cli).toContain('az network nsg rule create')
    expect(cli).toContain('az network route-table route create')
    expect(cli).toContain('az network vnet subnet update')
    expect(cli).toContain('az network nat gateway update')
    for (const format of ['terraform', 'bicep', 'azureCli'] as const) expect(generateInfrastructureResult(nodes, edges, format).mappings.find((mapping) => mapping.nodeId === pip.id && mapping.field === 'allocation_method')).toBeDefined()
  })
})
