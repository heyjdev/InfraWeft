import { ASSOCIATION_LABELS, type EdgeKind, type NetworkDesign, type NetworkEdge, type NetworkNode, type NetworkNodeData, type ResourceKind } from './model'

export type ShowcaseSeed = string | number
export type ShowcaseDesignResult = { design: NetworkDesign; seed: string }
export type ShowcaseSelection = Record<ResourceKind, number>
export type ShowcaseSelectionInput = Partial<Record<ResourceKind, number>>

export const DEFAULT_SHOWCASE_SELECTION: ShowcaseSelection = {
  vnet: 3, subnet: 6, appGateway: 1, natGateway: 1, firewall: 1, vpnGateway: 1,
  loadBalancer: 1, privateEndpoint: 1, frontDoor: 1, publicIp: 3,
  networkSecurityGroup: 1, routeTable: 1,
}

export type ShowcaseComplexity = 'small' | 'medium' | 'absurd'
export type ShowcasePreset = { id: string; label: string; description: string; selection: ShowcaseSelection }
const emptySelection = (): ShowcaseSelection => Object.fromEntries((Object.keys(DEFAULT_SHOWCASE_SELECTION) as ResourceKind[]).map((kind) => [kind, 0])) as ShowcaseSelection
const presetSelection = (selection: ShowcaseSelectionInput): ShowcaseSelection => ({ ...emptySelection(), ...selection })

export const SHOWCASE_PRESETS: ShowcasePreset[] = [
  { id: 'minimal-hub-spoke', label: 'Minimal hub-and-spoke', description: 'Three VNets with baseline subnet routing and security.', selection: presetSelection({ vnet: 3, subnet: 3, networkSecurityGroup: 1, routeTable: 1 }) },
  { id: 'secure-egress', label: 'Secure egress', description: 'Firewall, NAT, routes, and subnet security for controlled outbound traffic.', selection: presetSelection({ vnet: 2, firewall: 1, natGateway: 1, networkSecurityGroup: 1, routeTable: 1 }) },
  { id: 'private-application', label: 'Private application', description: 'Front Door and Application Gateway over private application services.', selection: presetSelection({ vnet: 2, appGateway: 1, loadBalancer: 1, privateEndpoint: 2, frontDoor: 1, networkSecurityGroup: 1 }) },
  { id: 'hybrid-vpn', label: 'Hybrid VPN', description: 'VPN gateway, firewall, routes, and security for hybrid connectivity.', selection: presetSelection({ vnet: 2, vpnGateway: 1, firewall: 1, networkSecurityGroup: 1, routeTable: 1 }) },
  { id: 'full-showcase', label: 'Full showcase', description: 'Every modeled resource type using the default balanced quantities.', selection: { ...DEFAULT_SHOWCASE_SELECTION } },
]

export function randomizeShowcaseSelection(input: ShowcaseSelectionInput, complexity: ShowcaseComplexity, random: () => number = Math.random): ShowcaseSelection {
  const ranges: Record<ShowcaseComplexity, readonly [number, number]> = { small: [1, 2], medium: [1, 5], absurd: [5, 20] }
  const [minimum, maximum] = ranges[complexity]
  return Object.fromEntries((Object.keys(DEFAULT_SHOWCASE_SELECTION) as ResourceKind[]).map((kind) => {
    if (boundedCount(input[kind]) === 0) return [kind, 0]
    const roll = Math.max(0, Math.min(0.999999999, Number(random()) || 0))
    return [kind, minimum + Math.floor(roll * (maximum - minimum + 1))]
  })) as ShowcaseSelection
}

const SHOWCASE_RESOURCE_KINDS = Object.keys(DEFAULT_SHOWCASE_SELECTION) as ResourceKind[]
const boundedCount = (value: unknown) => Math.max(0, Math.min(20, Number.isFinite(Number(value)) ? Math.floor(Number(value)) : 0))

export type ShowcaseLayoutMode = 'standard' | 'compact'
export type ShowcaseLayoutProfile = {
  mode: ShowcaseLayoutMode
  columnGap: number
  rowGap: number
  bandGap: number
  maxColumns: number
  warning?: string
}

/** Keeps large canvases bounded while preserving enough room for 222px-wide nodes. */
export function getShowcaseLayoutProfile(resourceCount: number): ShowcaseLayoutProfile {
  const count = Math.max(0, Math.floor(resourceCount))
  if (count > 50) return {
    mode: 'compact', columnGap: 250, rowGap: 92, bandGap: 96, maxColumns: 8,
    warning: `${count} resources will use compact layout with tighter spacing and wrapped rows.`,
  }
  if (count > 24) return { mode: 'standard', columnGap: 285, rowGap: 108, bandGap: 110, maxColumns: 7 }
  return { mode: 'standard', columnGap: 320, rowGap: 128, bandGap: 128, maxColumns: 6 }
}

export type ShowcaseRequirement = { minimum: number; reasons: string[] }
export type ShowcaseRequirements = Record<ResourceKind, ShowcaseRequirement>
type DependencyRule = {
  source: ResourceKind
  target: ResourceKind
  bucket: string
  combine: 'sum' | 'max'
  amount: (count: number) => number
  reason: (count: number) => string
}

/** AzureRM 4.81.0 golden-path dependencies used by the showcase planner. */
export const SHOWCASE_DEPENDENCY_RULES: DependencyRule[] = [
  { source: 'subnet', target: 'vnet', bucket: 'network-boundary', combine: 'max', amount: () => 1, reason: () => 'Subnets require a parent virtual network.' },
  { source: 'appGateway', target: 'vnet', bucket: 'network-boundary', combine: 'max', amount: () => 1, reason: () => 'Application Gateway requires a virtual network for its gateway subnet.' },
  { source: 'appGateway', target: 'subnet', bucket: 'application-gateway', combine: 'max', amount: () => 1, reason: (count) => `${count} Application Gateway${count === 1 ? ' requires' : 's share'} one dedicated gateway subnet.` },
  { source: 'firewall', target: 'vnet', bucket: 'network-boundary', combine: 'max', amount: (count) => count, reason: (count) => `${count} Azure Firewall${count === 1 ? ' requires' : 's require'} ${count} virtual network ${count === 1 ? 'boundary' : 'boundaries'}.` },
  { source: 'firewall', target: 'subnet', bucket: 'azure-firewall', combine: 'sum', amount: (count) => count, reason: (count) => `${count} Azure Firewall${count === 1 ? ' requires' : 's require'} ${count} dedicated AzureFirewallSubnet /26 subnet${count === 1 ? '' : 's'}.` },
  { source: 'firewall', target: 'publicIp', bucket: 'dedicated-public-ip', combine: 'sum', amount: (count) => count, reason: (count) => `${count} VNet Azure Firewall${count === 1 ? ' requires' : 's require'} ${count} dedicated Static Standard Public IP${count === 1 ? '' : 's'}.` },
  { source: 'vpnGateway', target: 'vnet', bucket: 'network-boundary', combine: 'max', amount: (count) => count, reason: (count) => `${count} VPN Gateway${count === 1 ? ' requires' : 's require'} ${count} virtual network ${count === 1 ? 'boundary' : 'boundaries'} because each VNet has one GatewaySubnet.` },
  { source: 'vpnGateway', target: 'subnet', bucket: 'vpn-gateway', combine: 'sum', amount: (count) => count, reason: (count) => `${count} VPN Gateway${count === 1 ? ' requires' : 's require'} ${count} exactly named GatewaySubnet subnet${count === 1 ? '' : 's'}.` },
  { source: 'vpnGateway', target: 'publicIp', bucket: 'dedicated-public-ip', combine: 'sum', amount: (count) => count, reason: (count) => `${count} active-standby VPN Gateway${count === 1 ? ' requires' : 's require'} ${count} dedicated Public IP${count === 1 ? '' : 's'}.` },
  { source: 'privateEndpoint', target: 'vnet', bucket: 'network-boundary', combine: 'max', amount: () => 1, reason: () => 'Private Endpoints require a subnet in a virtual network.' },
  { source: 'privateEndpoint', target: 'subnet', bucket: 'private-endpoint', combine: 'max', amount: () => 1, reason: (count) => `${count} Private Endpoint${count === 1 ? ' receives' : 's share'} one isolated endpoint subnet in the showcase.` },
  ...(['natGateway', 'loadBalancer', 'networkSecurityGroup', 'routeTable'] as ResourceKind[]).map((source): DependencyRule => ({ source, target: 'vnet', bucket: 'network-boundary', combine: 'max', amount: () => 1, reason: () => `${({ natGateway: 'NAT Gateway', loadBalancer: 'Load Balancer', networkSecurityGroup: 'Network Security Group', routeTable: 'Route table' } as Partial<Record<ResourceKind, string>>)[source]} requires a subnet in a virtual network.` })),
  ...(['natGateway', 'loadBalancer', 'networkSecurityGroup', 'routeTable'] as ResourceKind[]).map((source): DependencyRule => ({ source, target: 'subnet', bucket: 'shared-services', combine: 'max', amount: () => 1, reason: () => 'Selected subnet-associated services share one general-purpose subnet.' })),
  { source: 'natGateway', target: 'publicIp', bucket: 'dedicated-public-ip', combine: 'sum', amount: (count) => count, reason: (count) => `${count} NAT Gateway${count === 1 ? ' requires' : 's require'} ${count} dedicated Public IP association${count === 1 ? '' : 's'}.` },
]

export function getShowcaseRequirements(input: ShowcaseSelectionInput): ShowcaseRequirements {
  const selected = Object.fromEntries(SHOWCASE_RESOURCE_KINDS.map((kind) => [kind, boundedCount(input[kind])])) as ShowcaseSelection
  const requirements = Object.fromEntries(SHOWCASE_RESOURCE_KINDS.map((kind) => [kind, { minimum: 0, reasons: [] as string[] }])) as unknown as ShowcaseRequirements
  const buckets = new Map<ResourceKind, Map<string, number>>()
  for (const rule of SHOWCASE_DEPENDENCY_RULES) {
    const count = selected[rule.source]
    if (count === 0) continue
    const amount = rule.amount(count)
    const targetBuckets = buckets.get(rule.target) ?? new Map<string, number>()
    const current = targetBuckets.get(rule.bucket) ?? 0
    targetBuckets.set(rule.bucket, rule.combine === 'sum' ? current + amount : Math.max(current, amount))
    buckets.set(rule.target, targetBuckets)
    if (!requirements[rule.target].reasons.includes(rule.reason(count))) requirements[rule.target].reasons.push(rule.reason(count))
  }
  for (const kind of SHOWCASE_RESOURCE_KINDS) requirements[kind].minimum = [...(buckets.get(kind)?.values() ?? [])].reduce((sum, value) => sum + value, 0)
  return requirements
}

export function getShowcaseMinimums(input: ShowcaseSelectionInput): ShowcaseSelection {
  const requirements = getShowcaseRequirements(input)
  return Object.fromEntries(SHOWCASE_RESOURCE_KINDS.map((kind) => [kind, requirements[kind].minimum])) as ShowcaseSelection
}

export function normalizeShowcaseSelection(input: ShowcaseSelectionInput): ShowcaseSelection {
  const minimums = getShowcaseMinimums(input)
  return Object.fromEntries(SHOWCASE_RESOURCE_KINDS.map((kind) => [kind, Math.max(boundedCount(input[kind]), minimums[kind])])) as ShowcaseSelection
}

const DEFAULT_SHOWCASE_SEED = 'infraweft'
const regions = ['eastus', 'eastus2', 'westus2', 'centralus', 'southcentralus', 'westeurope'] as const
const adjectives = ['arc', 'beacon', 'cobalt', 'delta', 'ember', 'fathom', 'harbor', 'indigo'] as const

const SHOWCASE_LAYOUT = {
  layers: { edge: 40, vnet: 230, subnet: 440, internal: 680 },
  edge: { frontDoor: 100, publicIp: 500, firewallPublicIp: 1100, vpnPublicIp: 1500 },
  vnet: { app: 300, hub: 1100, data: 1900 },
  subnet: { appGateway: 100, app: 500, firewall: 900, gateway: 1300, data: 1700, privateEndpoint: 2100 },
  internal: { appGateway: 100, nat: 380, nsg: 660, routeTable: 940, firewall: 1220, vpn: 1500, loadBalancer: 1780, privateEndpoint: 2060 },
} as const

const SHOWCASE_JITTER = 12

function seedHash(seed: string) {
  let hash = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function seededRandom(initial: number) {
  let state = initial
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const resourceReference = (id: string) => `resource-reference://${id}`
const azureReference = (path: string) => `/subscriptions/{subscription-id}/resourceGroups/{resource-group}/${path}`

/**
 * Builds a deterministic, local-only reference topology. Export support remains format-specific;
 * external Azure dependencies are conspicuous placeholders rather than invented resources.
 */
export function createShowcaseDesign(inputSeed?: ShowcaseSeed, inputSelection?: ShowcaseSelectionInput): ShowcaseDesignResult {
  const seed = String(inputSeed ?? DEFAULT_SHOWCASE_SEED)
  const hash = seedHash(seed)
  const random = seededRandom(hash)
  const token = hash.toString(36).padStart(7, '0').slice(0, 7)
  const adjective = adjectives[Math.floor(random() * adjectives.length)]
  const region = regions[Math.floor(random() * regions.length)]
  const baseOctet = 20 + Math.floor(random() * 120)
  const resourceGroup = `rg-${adjective}-network-${token}`
  const name = (prefix: string) => `${prefix}-${adjective}-${token}`
  const id = (key: string) => `${key}-${token}`
  const position = (x: number, y: number) => ({
    x: x + Math.floor(random() * (SHOWCASE_JITTER * 2 + 1)) - SHOWCASE_JITTER,
    y: y + Math.floor(random() * (SHOWCASE_JITTER * 2 + 1)) - SHOWCASE_JITTER,
  })
  const vnetCidr = (offset: number) => `10.${baseOctet + offset}.0.0/16`
  const subnetCidr = (vnetOffset: number, subnetOffset: number) => `10.${baseOctet + vnetOffset}.${subnetOffset}.0/24`

  const ids = {
    hub: id('vnet-hub'), app: id('vnet-app'), data: id('vnet-data'),
    firewallSubnet: id('snet-firewall'), gatewaySubnet: id('snet-gateway'), appGatewaySubnet: id('snet-appgw'),
    appSubnet: id('snet-app'), dataSubnet: id('snet-data'), privateEndpointSubnet: id('snet-private-endpoints'),
    publicIp: id('pip-egress'), firewallPublicIp: id('pip-firewall'), vpnPublicIp: id('pip-vpn'), nsg: id('nsg-app'), routeTable: id('rt-app'), nat: id('nat-egress'),
    appGateway: id('appgw'), firewall: id('firewall'), vpn: id('vpn'), loadBalancer: id('load-balancer'),
    privateEndpoint: id('private-endpoint'), frontDoor: id('front-door'),
  }

  const node = (nodeId: string, kind: ResourceKind, x: number, y: number, data: Omit<NetworkNodeData, 'kind'>): NetworkNode => ({
    id: nodeId, type: 'azureResource', position: position(x, y), data: { ...data, kind, region: kind === 'frontDoor' ? 'global' : region, resourceGroup } as NetworkNodeData,
  })

  const nodes: NetworkNode[] = [
    node(ids.hub, 'vnet', SHOWCASE_LAYOUT.vnet.hub, SHOWCASE_LAYOUT.layers.vnet, {
      label: name('vnet-hub'), addressSpace: vnetCidr(0), addressSpaces: [vnetCidr(0)],
    }),
    node(ids.app, 'vnet', SHOWCASE_LAYOUT.vnet.app, SHOWCASE_LAYOUT.layers.vnet, {
      label: name('vnet-app'), addressSpace: vnetCidr(1), addressSpaces: [vnetCidr(1)],
    }),
    node(ids.data, 'vnet', SHOWCASE_LAYOUT.vnet.data, SHOWCASE_LAYOUT.layers.vnet, {
      label: name('vnet-data'), addressSpace: vnetCidr(2), addressSpaces: [vnetCidr(2)],
    }),
    node(ids.firewallSubnet, 'subnet', SHOWCASE_LAYOUT.subnet.firewall, SHOWCASE_LAYOUT.layers.subnet, {
      label: 'AzureFirewallSubnet', parentVnetId: ids.hub, addressSpace: subnetCidr(0, 1), addressSpaces: [subnetCidr(0, 1)],
    }),
    node(ids.gatewaySubnet, 'subnet', SHOWCASE_LAYOUT.subnet.gateway, SHOWCASE_LAYOUT.layers.subnet, {
      label: 'GatewaySubnet', parentVnetId: ids.hub, addressSpace: subnetCidr(0, 2), addressSpaces: [subnetCidr(0, 2)],
    }),
    node(ids.appGatewaySubnet, 'subnet', SHOWCASE_LAYOUT.subnet.appGateway, SHOWCASE_LAYOUT.layers.subnet, {
      label: name('snet-appgw'), parentVnetId: ids.app, addressSpace: subnetCidr(1, 1), addressSpaces: [subnetCidr(1, 1)],
    }),
    node(ids.appSubnet, 'subnet', SHOWCASE_LAYOUT.subnet.app, SHOWCASE_LAYOUT.layers.subnet, {
      label: name('snet-app'), parentVnetId: ids.app, addressSpace: subnetCidr(1, 2), addressSpaces: [subnetCidr(1, 2)],
    }),
    node(ids.dataSubnet, 'subnet', SHOWCASE_LAYOUT.subnet.data, SHOWCASE_LAYOUT.layers.subnet, {
      label: name('snet-data'), parentVnetId: ids.data, addressSpace: subnetCidr(2, 1), addressSpaces: [subnetCidr(2, 1)],
    }),
    node(ids.privateEndpointSubnet, 'subnet', SHOWCASE_LAYOUT.subnet.privateEndpoint, SHOWCASE_LAYOUT.layers.subnet, {
      label: name('snet-private-endpoints'), parentVnetId: ids.data, addressSpace: subnetCidr(2, 2), addressSpaces: [subnetCidr(2, 2)],
    }),
    node(ids.publicIp, 'publicIp', SHOWCASE_LAYOUT.edge.publicIp, SHOWCASE_LAYOUT.layers.edge, {
      label: name('pip-egress'), allocation_method: 'Static', sku: 'Standard', sku_tier: 'Regional', zones: ['1'], ip_version: 'IPv4',
      domain_name_label: name('egress'), reverse_fqdn: `${name('egress')}.example.invalid`, idle_timeout_in_minutes: 10,
    }),
    node(ids.firewallPublicIp, 'publicIp', SHOWCASE_LAYOUT.edge.firewallPublicIp, SHOWCASE_LAYOUT.layers.edge, {
      label: name('pip-firewall'), allocation_method: 'Static', sku: 'Standard', sku_tier: 'Regional', zones: ['1'], ip_version: 'IPv4', idle_timeout_in_minutes: 4,
    }),
    node(ids.vpnPublicIp, 'publicIp', SHOWCASE_LAYOUT.edge.vpnPublicIp, SHOWCASE_LAYOUT.layers.edge, {
      label: name('pip-vpn'), allocation_method: 'Static', sku: 'Standard', sku_tier: 'Regional', zones: ['1'], ip_version: 'IPv4', idle_timeout_in_minutes: 4,
    }),
    node(ids.nat, 'natGateway', SHOWCASE_LAYOUT.internal.nat, SHOWCASE_LAYOUT.layers.internal, {
      label: name('nat-egress'), sku: 'Standard', sku_name: 'Standard', zones: ['1'], idle_timeout_in_minutes: 10, idleTimeoutMinutes: 10,
    }),
    node(ids.nsg, 'networkSecurityGroup', SHOWCASE_LAYOUT.internal.nsg, SHOWCASE_LAYOUT.layers.internal, {
      label: name('nsg-app'), security_rule: [
        { name: 'allow-https', priority: 100, direction: 'Inbound', access: 'Allow', protocol: 'Tcp', source_port_ranges: ['*'], destination_port_ranges: ['443'], source_address_prefixes: ['Internet'], destination_address_prefixes: ['*'] },
        { name: 'deny-inbound', priority: 4096, direction: 'Inbound', access: 'Deny', protocol: '*', source_port_ranges: ['*'], destination_port_ranges: ['*'], source_address_prefixes: ['*'], destination_address_prefixes: ['*'] },
      ],
    }),
    node(ids.routeTable, 'routeTable', SHOWCASE_LAYOUT.internal.routeTable, SHOWCASE_LAYOUT.layers.internal, {
      label: name('rt-app'), disable_bgp_route_propagation: false, route: [
        { name: 'default-via-firewall', address_prefix: '0.0.0.0/0', next_hop_type: 'VirtualAppliance', next_hop_in_ip_address: `10.${baseOctet}.1.4` },
      ],
    }),
    node(ids.appGateway, 'appGateway', SHOWCASE_LAYOUT.internal.appGateway, SHOWCASE_LAYOUT.layers.internal, {
      label: name('appgw'), sku: { name: 'WAF_v2', tier: 'WAF_v2' }, autoscale_configuration: { min_capacity: 2, max_capacity: 5 }, http2_enabled: true, fips_enabled: false, zones: ['1', '2'],
      gateway_ip_configuration: [{ name: 'gateway-ip', subnet_id: ids.appGatewaySubnet }],
      frontend_ip_configuration: [{ name: 'frontend-private', subnet_id: ids.appGatewaySubnet, private_ip_address_allocation: 'Static', private_ip_address: `10.${baseOctet + 1}.1.10` }],
      frontend_port: [{ name: 'http', port: 80 }], backend_address_pool: [{ name: 'web-backends', fqdns: [`api.${token}.example.invalid`], ip_addresses: [] }],
      backend_http_settings: [{ name: 'http-settings', cookie_based_affinity: 'Disabled', port: 80, protocol: 'Http', request_timeout: 30 }],
      http_listener: [{ name: 'http-listener', frontend_ip_configuration_name: 'frontend-private', frontend_port_name: 'http', protocol: 'Http' }],
      request_routing_rule: [{ name: 'route-web', rule_type: 'Basic', http_listener_name: 'http-listener', priority: 100, backend_address_pool_name: 'web-backends', backend_http_settings_name: 'http-settings' }],
      waf_configuration: { enabled: true, firewall_mode: 'Prevention', rule_set_type: 'OWASP', rule_set_version: '3.2' },
    }),
    node(ids.firewall, 'firewall', SHOWCASE_LAYOUT.internal.firewall, SHOWCASE_LAYOUT.layers.internal, {
      label: name('afw-hub'), sku: 'AZFW_VNet', tier: 'Premium', sku_name: 'AZFW_VNet', sku_tier: 'Premium', threat_intel_mode: 'Deny',
      dns_servers: ['168.63.129.16'], dns_proxy_enabled: true,
      private_ip_ranges: ['IANAPrivateRanges'], zones: ['1', '2', '3'],
      ip_configuration: [{ name: 'firewall-ip', subnet_id: ids.firewallSubnet, public_ip_address_id: resourceReference(ids.firewallPublicIp) }],
    }),
    node(ids.vpn, 'vpnGateway', SHOWCASE_LAYOUT.internal.vpn, SHOWCASE_LAYOUT.layers.internal, {
      label: name('vpngw'), gatewayType: 'Vpn', type: 'Vpn', vpn_type: 'RouteBased', sku: 'VpnGw2AZ', generation: 'Generation2', activeActive: false, active_active: false,
      private_ip_address_enabled: false, bgp_enabled: true, bgp_settings: { asn: 65515, peer_weight: 0 },
      ip_configuration: [{ private_ip_address_allocation: 'Dynamic', subnet_id: resourceReference(ids.gatewaySubnet), public_ip_address_id: resourceReference(ids.vpnPublicIp) }],
      vpn_client_configuration: { address_space: [`172.${16 + (hash % 8)}.0.0/24`], vpn_client_protocols: ['OpenVPN'], vpn_auth_types: ['Radius'], radius_server_address: '10.0.0.4', radius_secret_required: true },
    }),
    node(ids.loadBalancer, 'loadBalancer', SHOWCASE_LAYOUT.internal.loadBalancer, SHOWCASE_LAYOUT.layers.internal, {
      label: name('lb-internal'), sku: 'Standard', sku_tier: 'Regional', frontendType: 'Private',
      frontend_ip_configuration: [{ name: 'frontend-private', zones: ['1'], subnet_id: ids.appSubnet, private_ip_address_allocation: 'Static', private_ip_address: `10.${baseOctet + 1}.2.20`, private_ip_address_version: 'IPv4' }],
      backend_address_pool: [{ name: 'app-backends' }],
      probe: [{ name: 'https-health', protocol: 'Https', port: 443, request_path: '/health', interval_in_seconds: 15, probe_threshold: 2 }],
      rule: [{ name: 'https', frontend_ip_configuration_name: 'frontend-private', backend_address_pool_name: 'app-backends', probe_name: 'https-health', protocol: 'Tcp', frontend_port: 443, backend_port: 443, idle_timeout_in_minutes: 10 }],
    }),
    node(ids.privateEndpoint, 'privateEndpoint', SHOWCASE_LAYOUT.internal.privateEndpoint, SHOWCASE_LAYOUT.layers.internal, {
      label: name('pep-storage'), subnet_id: ids.privateEndpointSubnet, custom_network_interface_name: name('nic-pep-storage'),
      private_service_connection: { name: 'storage-connection', is_manual_connection: false, private_connection_resource_id: azureReference('providers/Microsoft.Storage/storageAccounts/{storage-account-name}'), subresource_names: ['blob'] },
      private_dns_zone_group: { name: 'storage-dns', private_dns_zone_ids: [azureReference('providers/Microsoft.Network/privateDnsZones/privatelink.blob.core.windows.net')] },
      ip_configuration: [{ name: 'blob-ip', private_ip_address: `10.${baseOctet + 2}.2.10`, subresource_name: 'blob', member_name: 'blob' }],
    }),
    node(ids.frontDoor, 'frontDoor', SHOWCASE_LAYOUT.edge.frontDoor, SHOWCASE_LAYOUT.layers.edge, {
      label: name('afd-edge'), sku: 'Premium_AzureFrontDoor', sku_name: 'Premium_AzureFrontDoor',
    }),
  ]

  const edge = (edgeId: string, source: string, target: string, kind: EdgeKind): NetworkEdge => ({
    id: `${edgeId}-${token}`, source, target, type: 'smoothstep', animated: kind === 'peering',
    label: kind === 'peering' ? 'VNet peering' : kind === 'attachment' ? undefined : ASSOCIATION_LABELS[kind],
    data: { kind },
  })
  const edges: NetworkEdge[] = [
    edge('peer-hub-app', ids.hub, ids.app, 'peering'), edge('peer-hub-data', ids.hub, ids.data, 'peering'),
    edge('attach-hub-firewall-subnet', ids.hub, ids.firewallSubnet, 'attachment'), edge('attach-hub-gateway-subnet', ids.hub, ids.gatewaySubnet, 'attachment'),
    edge('attach-app-appgw-subnet', ids.app, ids.appGatewaySubnet, 'attachment'), edge('attach-app-subnet', ids.app, ids.appSubnet, 'attachment'),
    edge('attach-data-subnet', ids.data, ids.dataSubnet, 'attachment'), edge('attach-data-pe-subnet', ids.data, ids.privateEndpointSubnet, 'attachment'),
    edge('associate-app-nsg', ids.appSubnet, ids.nsg, 'subnetNetworkSecurityGroup'), edge('associate-app-routes', ids.appSubnet, ids.routeTable, 'subnetRouteTable'),
    edge('associate-app-nat', ids.appSubnet, ids.nat, 'subnetNatGateway'), edge('associate-nat-pip', ids.nat, ids.publicIp, 'natGatewayPublicIp'),
    edge('attach-appgw', ids.appGatewaySubnet, ids.appGateway, 'attachment'), edge('attach-firewall', ids.firewallSubnet, ids.firewall, 'attachment'),
    edge('attach-vpn', ids.gatewaySubnet, ids.vpn, 'attachment'), edge('attach-lb', ids.appSubnet, ids.loadBalancer, 'attachment'),
    edge('attach-private-endpoint', ids.privateEndpointSubnet, ids.privateEndpoint, 'attachment'), edge('attach-front-door', ids.frontDoor, ids.appGateway, 'attachment'),
  ]

  const baseDesign = { name: `Random showcase · ${seed}`, nodes, edges }
  if (!inputSelection) return { seed, design: baseDesign }

  const selection = normalizeShowcaseSelection(inputSelection)
  const byKind = new Map<ResourceKind, NetworkNode[]>()
  for (const kind of SHOWCASE_RESOURCE_KINDS) {
    const templates = nodes.filter((candidate) => candidate.data.kind === kind)
    const selectedNodes = Array.from({ length: selection[kind] }, (_, index) => {
      const template = templates[index % templates.length]
      const clone = structuredClone(template)
      if (index >= templates.length) {
        clone.id = `${template.id}-copy-${index + 1}`
        clone.data.label = `${template.data.label}-${index + 1}`
      }
      return clone
    })
    byKind.set(kind, selectedNodes)
  }

  const selectedNodes = SHOWCASE_RESOURCE_KINDS.flatMap((kind) => byKind.get(kind) ?? [])
  const vnets = byKind.get('vnet') ?? []
  const subnets = byKind.get('subnet') ?? []
  const publicIps = byKind.get('publicIp') ?? []
  const pick = (items: NetworkNode[], index: number) => items.length ? items[index % items.length] : undefined

  type SubnetRole = { kind: 'appGateway' | 'firewall' | 'vpnGateway' | 'privateEndpoint' | 'shared' | 'general'; ownerIndex: number }
  const subnetRoles: SubnetRole[] = [
    ...Array.from({ length: selection.appGateway > 0 ? 1 : 0 }, (_, ownerIndex): SubnetRole => ({ kind: 'appGateway', ownerIndex })),
    ...Array.from({ length: selection.firewall }, (_, ownerIndex): SubnetRole => ({ kind: 'firewall', ownerIndex })),
    ...Array.from({ length: selection.vpnGateway }, (_, ownerIndex): SubnetRole => ({ kind: 'vpnGateway', ownerIndex })),
    ...Array.from({ length: selection.privateEndpoint > 0 ? 1 : 0 }, (_, ownerIndex): SubnetRole => ({ kind: 'privateEndpoint', ownerIndex })),
  ]
  if (['natGateway', 'loadBalancer', 'networkSecurityGroup', 'routeTable'].some((kind) => selection[kind as ResourceKind] > 0)) subnetRoles.push({ kind: 'shared', ownerIndex: 0 })
  while (subnetRoles.length < selection.subnet) subnetRoles.push({ kind: 'general', ownerIndex: subnetRoles.length })

  vnets.forEach((vnet, index) => {
    const cidr = `10.${baseOctet + index}.0.0/16`
    vnet.data.addressSpace = cidr
    vnet.data.addressSpaces = [cidr]
  })
  const subnetOrdinals = new Map<string, number>()
  subnets.forEach((subnet, index) => {
    const role = subnetRoles[index]
    const vnetIndex = role.kind === 'firewall' || role.kind === 'vpnGateway' ? role.ownerIndex : index
    const parent = pick(vnets, vnetIndex)!
    const ordinal = (subnetOrdinals.get(parent.id) ?? 0) + 1
    subnetOrdinals.set(parent.id, ordinal)
    const parentCidr = String(parent.data.addressSpace).split('.')
    const prefix = role.kind === 'firewall' ? 26 : 24
    const cidr = `${parentCidr[0]}.${parentCidr[1]}.${ordinal}.0/${prefix}`
    const roleLabels: Record<SubnetRole['kind'], string> = {
      appGateway: `snet-appgw-${role.ownerIndex + 1}`,
      firewall: 'AzureFirewallSubnet',
      vpnGateway: 'GatewaySubnet',
      privateEndpoint: `snet-private-endpoints-${role.ownerIndex + 1}`,
      shared: 'snet-shared-services',
      general: `snet-general-${role.ownerIndex + 1}`,
    }
    subnet.data.label = roleLabels[role.kind]
    subnet.data.parentVnetId = parent.id
    subnet.data.addressSpace = cidr
    subnet.data.addressSpaces = [cidr]
    if (role.kind === 'privateEndpoint') subnet.data.private_endpoint_network_policies = 'Disabled'
  })

  const subnetsFor = (kind: SubnetRole['kind']) => subnets.filter((_, index) => subnetRoles[index]?.kind === kind)
  const appGatewaySubnets = subnetsFor('appGateway')
  const firewallSubnets = subnetsFor('firewall')
  const vpnGatewaySubnets = subnetsFor('vpnGateway')
  const privateEndpointSubnets = subnetsFor('privateEndpoint')
  const sharedSubnet = subnetsFor('shared')[0] ?? subnets[0]
  const natPublicIps = publicIps.slice(0, selection.natGateway)
  const firewallPublicIps = publicIps.slice(selection.natGateway, selection.natGateway + selection.firewall)
  const vpnPublicIps = publicIps.slice(selection.natGateway + selection.firewall, selection.natGateway + selection.firewall + selection.vpnGateway)
  const reference = (target?: NetworkNode) => target ? resourceReference(target.id) : undefined

  ;(byKind.get('appGateway') ?? []).forEach((item, index) => {
    const subnet = pick(appGatewaySubnets, index)!
    const data = item.data as Record<string, unknown>
    data.gateway_ip_configuration = [{ ...(Array.isArray(data.gateway_ip_configuration) ? data.gateway_ip_configuration[0] as object : {}), name: `gateway-ip-${index + 1}`, subnet_id: subnet.id }]
    const frontends = Array.isArray(data.frontend_ip_configuration) ? data.frontend_ip_configuration as Array<Record<string, unknown>> : []
    data.frontend_ip_configuration = frontends.map((frontend) => ({ ...frontend, subnet_id: subnet.id }))
  })
  ;(byKind.get('firewall') ?? []).forEach((item, index) => {
    const data = item.data as Record<string, unknown>
    data.ip_configuration = [{ name: `firewall-ip-${index + 1}`, subnet_id: firewallSubnets[index].id, public_ip_address_id: reference(firewallPublicIps[index]) }]
  })
  ;(byKind.get('vpnGateway') ?? []).forEach((item, index) => {
    const data = item.data as Record<string, unknown>
    data.ip_configuration = [{ name: `gateway-ip-${index + 1}`, private_ip_address_allocation: 'Dynamic', subnet_id: reference(vpnGatewaySubnets[index]), public_ip_address_id: reference(vpnPublicIps[index]) }]
  })
  ;(byKind.get('privateEndpoint') ?? []).forEach((item, index) => { item.data.subnet_id = pick(privateEndpointSubnets, index)!.id })
  ;(byKind.get('loadBalancer') ?? []).forEach((item) => {
    const data = item.data as Record<string, unknown>
    const frontends = Array.isArray(data.frontend_ip_configuration) ? data.frontend_ip_configuration as Array<Record<string, unknown>> : []
    data.frontend_ip_configuration = frontends.map((frontend) => ({ ...frontend, subnet_id: sharedSubnet.id }))
  })

  let edgeOrdinal = 0
  const customEdges: NetworkEdge[] = []
  const connect = (source: NetworkNode | undefined, target: NetworkNode | undefined, kind: EdgeKind) => {
    if (!source || !target) return
    customEdges.push(edge(`custom-${++edgeOrdinal}`, source.id, target.id, kind))
  }
  vnets.slice(1).forEach((vnet) => connect(vnets[0], vnet, 'peering'))
  subnets.forEach((subnet) => connect(vnets.find((vnet) => vnet.id === subnet.data.parentVnetId), subnet, 'attachment'))
  ;(byKind.get('appGateway') ?? []).forEach((item, index) => connect(pick(appGatewaySubnets, index), item, 'attachment'))
  ;(byKind.get('firewall') ?? []).forEach((item, index) => connect(firewallSubnets[index], item, 'attachment'))
  ;(byKind.get('vpnGateway') ?? []).forEach((item, index) => connect(vpnGatewaySubnets[index], item, 'attachment'))
  ;(byKind.get('privateEndpoint') ?? []).forEach((item, index) => connect(pick(privateEndpointSubnets, index), item, 'attachment'))
  ;(byKind.get('loadBalancer') ?? []).forEach((item) => connect(sharedSubnet, item, 'attachment'))
  ;(byKind.get('networkSecurityGroup') ?? []).forEach((item) => connect(sharedSubnet, item, 'subnetNetworkSecurityGroup'))
  ;(byKind.get('routeTable') ?? []).forEach((item) => connect(sharedSubnet, item, 'subnetRouteTable'))
  ;(byKind.get('natGateway') ?? []).forEach((item, index) => { connect(sharedSubnet, item, 'subnetNatGateway'); connect(item, natPublicIps[index], 'natGatewayPublicIp') })
  ;(byKind.get('frontDoor') ?? []).forEach((item, index) => connect(item, pick(byKind.get('appGateway') ?? [], index), 'attachment'))

  const nodeById = new Map(selectedNodes.map((item) => [item.id, item]))
  const vnetOrder = new Map(vnets.map((item, index) => [item.id, index]))
  const parentVnetByNode = new Map<string, string>()
  for (const subnet of subnets) parentVnetByNode.set(subnet.id, String(subnet.data.parentVnetId))
  let discoveredParent = true
  while (discoveredParent) {
    discoveredParent = false
    for (const candidate of customEdges.filter((item) => item.data?.kind !== 'peering')) {
      const sourceParent = nodeById.get(candidate.source)?.data.kind === 'vnet' ? candidate.source : parentVnetByNode.get(candidate.source)
      const targetParent = nodeById.get(candidate.target)?.data.kind === 'vnet' ? candidate.target : parentVnetByNode.get(candidate.target)
      if (sourceParent && !parentVnetByNode.has(candidate.target)) { parentVnetByNode.set(candidate.target, sourceParent); discoveredParent = true }
      if (targetParent && !parentVnetByNode.has(candidate.source)) { parentVnetByNode.set(candidate.source, targetParent); discoveredParent = true }
    }
  }

  const layoutProfile = getShowcaseLayoutProfile(selectedNodes.length)
  const layoutBands: ResourceKind[][] = [
    ['frontDoor', 'publicIp'],
    ['vnet'],
    ['subnet'],
    ['appGateway', 'natGateway', 'firewall', 'vpnGateway', 'loadBalancer', 'privateEndpoint', 'networkSecurityGroup', 'routeTable'],
  ]
  const kindOrder = new Map(SHOWCASE_RESOURCE_KINDS.map((kind, index) => [kind, index]))
  const clusterOrder = (item: NetworkNode) => vnetOrder.get(parentVnetByNode.get(item.id) ?? item.id) ?? Number.MAX_SAFE_INTEGER
  let bandY = 40
  for (const kinds of layoutBands) {
    const items = selectedNodes.filter((item) => kinds.includes(item.data.kind)).sort((left, right) =>
      clusterOrder(left) - clusterOrder(right)
      || (kindOrder.get(left.data.kind) ?? 0) - (kindOrder.get(right.data.kind) ?? 0)
      || left.id.localeCompare(right.id),
    )
    if (!items.length) continue
    const naturalColumns = Math.max(1, Math.ceil(Math.sqrt(items.length * 1.6)))
    const columns = Math.min(layoutProfile.maxColumns, naturalColumns)
    items.forEach((item, index) => {
      item.position = { x: 100 + (index % columns) * layoutProfile.columnGap, y: bandY + Math.floor(index / columns) * layoutProfile.rowGap }
    })
    bandY += Math.ceil(items.length / columns) * layoutProfile.rowGap + layoutProfile.bandGap
  }

  return { seed, design: { name: `${baseDesign.name} · custom selection`, nodes: selectedNodes, edges: customEdges } }
}
