import { ASSOCIATION_LABELS, type EdgeKind, type NetworkDesign, type NetworkEdge, type NetworkNode, type NetworkNodeData, type ResourceKind } from './model'

export type ShowcaseSeed = string | number
export type ShowcaseDesignResult = { design: NetworkDesign; seed: string }

const DEFAULT_SHOWCASE_SEED = 'azure-network-studio'
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
export function createShowcaseDesign(inputSeed?: ShowcaseSeed): ShowcaseDesignResult {
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
      vpn_client_configuration: { address_space: [`172.${16 + (hash % 8)}.0.0/24`], vpn_client_protocols: ['OpenVPN'], vpn_auth_types: ['Radius'], radius_server_address: '10.0.0.4', radius_server_secret: 'secret-reference://key-vault/vpn-radius-shared-secret' },
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

  return { seed, design: { name: `Random showcase · ${seed}`, nodes, edges } }
}
