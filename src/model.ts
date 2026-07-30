export type ResourceKind = 'vnet' | 'subnet' | 'appGateway' | 'natGateway' | 'firewall' | 'vpnGateway' | 'loadBalancer' | 'privateEndpoint' | 'frontDoor' | 'publicIp' | 'networkSecurityGroup' | 'routeTable'
export type EdgeKind = 'peering' | 'attachment' | 'subnetNetworkSecurityGroup' | 'subnetRouteTable' | 'subnetNatGateway' | 'natGatewayPublicIp' | 'firewallSubnet' | 'firewallPublicIp' | 'appGatewayPublicIp'

export type NetworkNodeData = {
  label: string
  kind: ResourceKind
  addressSpace?: string
  addressSpaces?: string[]
  region?: string
  resourceGroup?: string
  subscriptionId?: string
  imported?: boolean
  parentVnetId?: string
  sku?: string | Record<string, unknown>
  tier?: string
  idleTimeoutMinutes?: number
  capacity?: number
  gatewayType?: string
  activeActive?: boolean
  frontendType?: string
  privateIpAddress?: string
  privateLinkResourceId?: string
  groupIds?: string[]
  [key: string]: unknown
}

export type NetworkNode = {
  id: string
  type: 'azureResource'
  position: { x: number; y: number }
  data: NetworkNodeData
}

export type NetworkEdge = {
  id: string
  source: string
  target: string
  type?: string
  animated?: boolean
  label?: string
  markerEnd?: { type: 'arrow' | 'arrowclosed' }
  data?: { kind?: EdgeKind; imported?: boolean; [key: string]: unknown }
}

export type NetworkDesign = {
  name: string
  nodes: NetworkNode[]
  edges: NetworkEdge[]
}

export const RESOURCE_LABELS: Record<ResourceKind, string> = {
  vnet: 'Virtual network', subnet: 'Subnet', appGateway: 'Application Gateway', natGateway: 'NAT Gateway',
  firewall: 'Azure Firewall', vpnGateway: 'VPN Gateway', loadBalancer: 'Load Balancer', privateEndpoint: 'Private Endpoint', frontDoor: 'Azure Front Door',
  publicIp: 'Public IP', networkSecurityGroup: 'Network Security Group', routeTable: 'Route table',
}

const ASSOCIATION_PAIRS: Array<{ kinds: [ResourceKind, ResourceKind]; kind: Exclude<EdgeKind, 'peering' | 'attachment'>; label: string }> = [
  { kinds: ['subnet', 'networkSecurityGroup'], kind: 'subnetNetworkSecurityGroup', label: 'Subnet ↔ NSG' },
  { kinds: ['subnet', 'routeTable'], kind: 'subnetRouteTable', label: 'Subnet ↔ route table' },
  { kinds: ['subnet', 'natGateway'], kind: 'subnetNatGateway', label: 'Subnet ↔ NAT Gateway' },
  { kinds: ['natGateway', 'publicIp'], kind: 'natGatewayPublicIp', label: 'NAT Gateway ↔ Public IP' },
  { kinds: ['firewall', 'subnet'], kind: 'firewallSubnet', label: 'Azure Firewall ↔ Subnet' },
  { kinds: ['firewall', 'publicIp'], kind: 'firewallPublicIp', label: 'Azure Firewall ↔ Public IP' },
  { kinds: ['appGateway', 'publicIp'], kind: 'appGatewayPublicIp', label: 'Application Gateway ↔ Public IP' },
]

export function associationKindFor(left: ResourceKind, right: ResourceKind) {
  return ASSOCIATION_PAIRS.find(({ kinds }) => kinds.includes(left) && kinds.includes(right))?.kind
}

export const ASSOCIATION_LABELS: Record<Exclude<EdgeKind, 'peering' | 'attachment'>, string> = {
  subnetNetworkSecurityGroup: 'subnet to Network Security Group association',
  subnetRouteTable: 'Subnet to route table association',
  subnetNatGateway: 'Subnet to NAT Gateway association',
  natGatewayPublicIp: 'NAT Gateway to Public IP association',
  firewallSubnet: 'Azure Firewall to subnet IP configuration',
  firewallPublicIp: 'Azure Firewall to Public IP configuration',
  appGatewayPublicIp: 'Application Gateway to Public IP frontend configuration',
}

const ATTACHABLE_CHILDREN: Partial<Record<ResourceKind, ResourceKind[]>> = {
  vnet: ['subnet'],
  subnet: ['networkSecurityGroup', 'routeTable', 'natGateway', 'firewall'],
  natGateway: ['publicIp'],
  firewall: ['publicIp'],
  appGateway: ['publicIp'],
}

export const getAttachableChildKinds = (kind: ResourceKind): ResourceKind[] => [...(ATTACHABLE_CHILDREN[kind] ?? [])]

const intToIpv4 = (value: number) => [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.')

function nextSubnetCidr(vnet: NetworkNode, nodes: NetworkNode[]) {
  const parentRange = addressSpacesFor(vnet).map(parseCidr).find((range): range is NonNullable<ReturnType<typeof parseCidr>> => Boolean(range))
  if (!parentRange) return '10.0.1.0/24'
  const prefix = Math.min(29, Math.max(24, parentRange.prefix))
  const blockSize = 2 ** (32 - prefix)
  const used = nodes.filter((node) => node.data.kind === 'subnet' && node.data.parentVnetId === vnet.id).flatMap((node) => addressSpacesFor(node))
  for (let start = parentRange.start + blockSize; start + blockSize - 1 <= parentRange.end; start += blockSize) {
    const candidate = `${intToIpv4(start)}/${prefix}`
    if (!used.some((cidr) => cidrsOverlap(candidate, cidr))) return candidate
  }
  return `${intToIpv4(parentRange.start)}/${prefix}`
}

export function attachSubnetToVnet(subnet: NetworkNode, vnet: NetworkNode, nodes: NetworkNode[], edgeId: string): { node: NetworkNode; edge: NetworkEdge; cidrAdjusted: boolean } {
  if (subnet.data.kind !== 'subnet' || vnet.data.kind !== 'vnet') throw new Error('Only a subnet can be attached to a virtual network')
  const currentCidrs = addressSpacesFor(subnet)
  const parentRanges = addressSpacesFor(vnet).map(parseCidr).filter((range): range is NonNullable<ReturnType<typeof parseCidr>> => Boolean(range))
  const siblings = nodes.filter((node) => node.id !== subnet.id && node.data.kind === 'subnet' && node.data.parentVnetId === vnet.id)
  const currentFits = currentCidrs.length > 0 && currentCidrs.every((cidr) => {
    const range = parseCidr(cidr)
    return Boolean(range && parentRanges.some((parentRange) => parentRange.start <= range.start && parentRange.end >= range.end) && !siblings.some((sibling) => addressSpacesFor(sibling).some((siblingCidr) => cidrsOverlap(cidr, siblingCidr))))
  })
  const cidrs = currentFits ? currentCidrs : [nextSubnetCidr(vnet, nodes.filter((node) => node.id !== subnet.id))]
  const position = { x: vnet.position.x, y: vnet.position.y + 150 }
  while (nodes.some((node) => node.id !== subnet.id && Math.abs(node.position.x - position.x) < 235 && Math.abs(node.position.y - position.y) < 95)) position.y += 120
  return {
    node: { ...subnet, position, data: { ...subnet.data, parentVnetId: vnet.id, region: vnet.data.region, resourceGroup: vnet.data.resourceGroup, addressSpace: cidrs[0], addressSpaces: cidrs } },
    edge: { id: edgeId, source: vnet.id, target: subnet.id, type: 'smoothstep', label: 'Contains', markerEnd: { type: 'arrowclosed' }, data: { kind: 'attachment' } },
    cidrAdjusted: !currentFits,
  }
}

export function createAttachedResource(parent: NetworkNode, childKind: ResourceKind, nodes: NetworkNode[], nodeId: string, edgeId: string): { node: NetworkNode; edge: NetworkEdge; parentPatch?: Partial<NetworkNodeData> } {
  if (!getAttachableChildKinds(parent.data.kind).includes(childKind)) throw new Error(`${RESOURCE_LABELS[childKind]} cannot be attached directly to ${RESOURCE_LABELS[parent.data.kind]}`)
  const ordinal = nodes.filter((node) => node.data.kind === childKind).length + 1
  const childKinds = getAttachableChildKinds(parent.data.kind)
  const childIndex = childKinds.indexOf(childKind)
  const horizontalOffset = childKinds.length > 1 ? (childIndex - (childKinds.length - 1) / 2) * 250 : 0
  const parentVnet = parent.data.kind === 'subnet' ? nodes.find((node) => node.id === parent.data.parentVnetId && node.data.kind === 'vnet') : parent.data.kind === 'vnet' ? parent : undefined
  if (parent.data.kind === 'subnet' && childKind === 'firewall' && !parentVnet) throw new Error('Attach the subnet to a parent virtual network before adding an Azure Firewall')
  const data = defaultNodeData(childKind, ordinal)
  data.region = parentVnet?.data.region ?? parent.data.region ?? data.region
  data.resourceGroup = parentVnet?.data.resourceGroup ?? parent.data.resourceGroup ?? data.resourceGroup
  if (childKind === 'subnet') {
    const cidr = nextSubnetCidr(parent, nodes)
    data.parentVnetId = parent.id
    data.addressSpace = cidr
    data.addressSpaces = [cidr]
  }
  let parentPatch: Partial<NetworkNodeData> | undefined
  if (parent.data.kind === 'subnet' && childKind === 'firewall') {
    data.ip_configuration = [{ name: 'firewall-ip-1', subnet_id: parent.id }]
    parentPatch = { label: 'AzureFirewallSubnet' }
  }
  if (parent.data.kind === 'firewall' && childKind === 'publicIp') {
    const configurations = Array.isArray(parent.data.ip_configuration) ? structuredClone(parent.data.ip_configuration as Array<Record<string, unknown>>) : []
    const openIndex = configurations.findIndex((configuration) => !configuration.public_ip_address_id)
    const reference = `resource-reference://${nodeId}`
    if (openIndex >= 0) configurations[openIndex] = { ...configurations[openIndex], public_ip_address_id: reference }
    else configurations.push({ name: `firewall-ip-${configurations.length + 1}`, public_ip_address_id: reference })
    parentPatch = { ip_configuration: configurations }
  }
  if (parent.data.kind === 'appGateway' && childKind === 'publicIp') {
    const configurations = Array.isArray(parent.data.frontend_ip_configuration) ? structuredClone(parent.data.frontend_ip_configuration as Array<Record<string, unknown>>) : []
    const openIndex = configurations.findIndex((configuration) => !configuration.public_ip_address_id)
    const reference = `resource-reference://${nodeId}`
    if (openIndex >= 0) configurations[openIndex] = { ...configurations[openIndex], public_ip_address_id: reference }
    else configurations.push({ name: `public-frontend-${configurations.length + 1}`, public_ip_address_id: reference })
    parentPatch = { frontend_ip_configuration: configurations }
  }
  const edgeKind = associationKindFor(parent.data.kind, childKind) ?? 'attachment'
  const position = { x: parent.position.x + horizontalOffset, y: parent.position.y + 150 }
  while (nodes.some((node) => Math.abs(node.position.x - position.x) < 235 && Math.abs(node.position.y - position.y) < 95)) position.y += 120
  return {
    node: { id: nodeId, type: 'azureResource', position, data },
    edge: { id: edgeId, source: parent.id, target: nodeId, type: 'smoothstep', label: edgeKind === 'attachment' ? 'Contains' : ASSOCIATION_LABELS[edgeKind], markerEnd: { type: 'arrowclosed' }, data: { kind: edgeKind } },
    parentPatch,
  }
}

export const AZURE_REGIONS = ['eastus', 'eastus2', 'westus2', 'centralus', 'southcentralus', 'westeurope'] as const

export type ExportTarget = 'terraform' | 'bicep' | 'azureCli'
export type FieldCondition = { key: string; equals?: unknown; notEquals?: unknown; includes?: unknown }
export type ResourceField = {
  /** Exact AzureRM argument name unless this is an established graph relationship. */
  key: keyof NetworkNodeData
  label: string
  type: 'text' | 'password' | 'number' | 'boolean' | 'select' | 'cidrList' | 'resourceRef' | 'stringList' | 'block'
  section?: string
  help?: string
  options?: string[]
  resourceKind?: ResourceKind
  required?: boolean
  readOnly?: boolean
  min?: number
  max?: number
  step?: number
  minItems?: number
  maxItems?: number
  repeatable?: boolean
  fields?: ResourceField[]
  visibleWhen?: FieldCondition
  documentationUrl?: string
}
type Capability = { status: 'supported' | 'unsupported'; summary: string }
export type ResourceSchema = {
  kind: ResourceKind
  description: string
  fields: ResourceField[]
  defaults: Partial<NetworkNodeData>
  export: Record<ExportTarget, Capability>
}

const supported = (summary: string): Capability => ({ status: 'supported', summary })
const allExportersSupportedComplex = {
  terraform: supported('AzureRM v4.81.0 resource and currently modeled nested blocks are rendered deterministically.'),
  bicep: supported('Bicep resource and currently modeled child configuration are rendered deterministically.'),
  azureCli: supported('Azure CLI commands render the currently modeled resource and child configuration deterministically.'),
}

/** Single source of truth for palette help, property editors, validation metadata, and honest exporter capabilities. */
export const RESOURCE_SCHEMAS: Record<ResourceKind, ResourceSchema> = {
  vnet: {
    kind: 'vnet', description: 'Private Azure address space and peering boundary.',
    fields: [
      { key: 'addressSpaces', label: 'Address spaces (address_space)', type: 'cidrList', section: 'Addressing', required: true, minItems: 1, help: 'Canonical IPv4 CIDRs. AzureRM also accepts IPv6; IPv6 diagram validation is pending.' },
      { key: 'dns_servers', label: 'Custom DNS servers', type: 'stringList', section: 'DNS and routing', help: 'IPv4 or IPv6 DNS server addresses.' },
      { key: 'bgp_community', label: 'BGP community', type: 'text', section: 'DNS and routing', help: 'Microsoft ASN notation, for example 12076:20000.' },
      { key: 'flow_timeout_in_minutes', label: 'Flow timeout (minutes)', type: 'number', section: 'DNS and routing', min: 4, max: 30, step: 1 },
      { key: 'private_endpoint_vnet_policies', label: 'Private endpoint VNet policies', type: 'select', section: 'Security', options: ['Disabled', 'Basic'], help: 'AzureRM default: Disabled.' },
      { key: 'ddos_protection_plan', label: 'DDoS protection plan', type: 'block', section: 'Security', fields: [
        { key: 'id', label: 'Plan resource ID', type: 'text', required: true }, { key: 'enable', label: 'Enable plan', type: 'boolean', required: true },
      ] },
      { key: 'encryption', label: 'Virtual network encryption', type: 'block', section: 'Security', fields: [{ key: 'enforcement', label: 'Enforcement', type: 'select', required: true, options: ['AllowUnencrypted'], help: 'DropUnencrypted is not generally deployable.' }] },
      { key: 'edge_zone', label: 'Edge zone', type: 'text', section: 'Advanced' },
    ],
    defaults: { addressSpace: '10.30.0.0/16', addressSpaces: ['10.30.0.0/16'], private_endpoint_vnet_policies: 'Disabled' },
    export: { terraform: supported('Virtual network and bidirectional peerings; only address spaces are currently rendered.'), bicep: supported('Virtual network and bidirectional peerings; only address spaces are currently rendered.'), azureCli: supported('Virtual network and bidirectional peerings; only address spaces are currently rendered.') },
  },
  subnet: {
    kind: 'subnet', description: 'Address ranges contained by one virtual network; region and resource group inherit from its parent.',
    fields: [
      { key: 'parentVnetId', label: 'Parent virtual network', type: 'resourceRef', resourceKind: 'vnet', section: 'Parent', required: true },
      { key: 'addressSpaces', label: 'Address prefixes (address_prefixes)', type: 'cidrList', section: 'Addressing', required: true, minItems: 1, help: 'One or more non-overlapping prefixes contained by the parent VNet.' },
      { key: 'default_outbound_access_enabled', label: 'Enable default outbound access', type: 'boolean', section: 'Network policy', help: 'AzureRM default: true. Disable for explicit private subnet egress.' },
      { key: 'private_endpoint_network_policies', label: 'Private endpoint network policies', type: 'select', section: 'Network policy', options: ['Disabled', 'Enabled', 'NetworkSecurityGroupEnabled', 'RouteTableEnabled'] },
      { key: 'private_link_service_network_policies_enabled', label: 'Private Link service network policies', type: 'boolean', section: 'Network policy', help: 'Must be disabled when hosting a Private Link Service.' },
      { key: 'service_endpoints', label: 'Service endpoints', type: 'stringList', section: 'Service integration', help: 'Examples: Microsoft.Storage, Microsoft.Sql, Microsoft.KeyVault.' },
      { key: 'service_endpoint_policy_ids', label: 'Service endpoint policy IDs', type: 'stringList', section: 'Service integration' },
      { key: 'delegation', label: 'Delegations', type: 'block', section: 'Service integration', repeatable: true, fields: [
        { key: 'name', label: 'Delegation name', type: 'text', required: true },
        { key: 'service_name', label: 'Service delegation name', type: 'text', required: true, help: 'Terraform: service_delegation.name' },
        { key: 'actions', label: 'Allowed actions', type: 'stringList' },
      ] },
      { key: 'sharing_scope', label: 'Sharing scope (preview)', type: 'select', section: 'Advanced', options: ['', 'Tenant'] },
    ],
    defaults: { addressSpace: '10.30.1.0/24', addressSpaces: ['10.30.1.0/24'], default_outbound_access_enabled: true, private_endpoint_network_policies: 'Disabled', private_link_service_network_policies_enabled: true },
    export: { terraform: supported('Subnet prefixes and typed associations in its selected parent VNet.'), bicep: supported('Subnet prefixes and typed associations in its selected parent VNet.'), azureCli: supported('Subnet prefixes and typed associations in its selected parent VNet.') },
  },
  natGateway: {
    kind: 'natGateway', description: 'Managed outbound connectivity gateway. Public IP and subnet associations are separate graph resources.',
    fields: [
      { key: 'sku_name', label: 'SKU', type: 'select', section: 'SKU and availability', options: ['Standard', 'StandardV2'], required: true },
      { key: 'zones', label: 'Availability zones', type: 'stringList', section: 'SKU and availability', maxItems: 1, visibleWhen: { key: 'sku_name', equals: 'Standard' }, help: 'Standard accepts zero or one zone; StandardV2 forbids zones.' },
      { key: 'idle_timeout_in_minutes', label: 'TCP idle timeout (minutes)', type: 'number', section: 'Connection settings', min: 4, max: 120, step: 1 },
    ],
    defaults: { sku: 'Standard', sku_name: 'Standard', idleTimeoutMinutes: 4, idle_timeout_in_minutes: 4, zones: [] },
    export: { terraform: supported('NAT Gateway resource and typed subnet/Public IP associations.'), bicep: supported('NAT Gateway resource and typed subnet/Public IP associations.'), azureCli: supported('NAT Gateway resource and typed subnet/Public IP associations.') },
  },
  frontDoor: {
    kind: 'frontDoor', description: 'Global Azure Front Door Standard/Premium profile. Endpoints, origins, and routes are not generated yet.',
    fields: [
      { key: 'sku_name', label: 'SKU', type: 'select', section: 'Profile', options: ['Standard_AzureFrontDoor', 'Premium_AzureFrontDoor'], required: true },
      { key: 'response_timeout_seconds', label: 'Origin response timeout (seconds)', type: 'number', section: 'Profile', min: 16, max: 240, step: 1 },
      { key: 'identity', label: 'Managed identity', type: 'block', section: 'Identity', fields: [
        { key: 'type', label: 'Identity type', type: 'select', required: true, options: ['SystemAssigned', 'UserAssigned', 'SystemAssigned, UserAssigned'] },
        { key: 'identity_ids', label: 'User-assigned identity IDs', type: 'stringList', visibleWhen: { key: 'type', includes: 'UserAssigned' } },
      ] },
      { key: 'log_scrubbing_rule', label: 'Log scrubbing rules', type: 'block', section: 'Logging', repeatable: true, maxItems: 3, fields: [{ key: 'match_variable', label: 'Match variable', type: 'select', required: true, options: ['QueryStringArgNames', 'RequestIPAddress', 'RequestUri'] }] },
    ],
    defaults: { region: 'global', sku: 'Standard_AzureFrontDoor', sku_name: 'Standard_AzureFrontDoor', response_timeout_seconds: 120 },
    export: { terraform: supported('Front Door profile only; nested profile options and delivery child resources are not yet rendered.'), bicep: supported('Front Door profile only; delivery child resources remain separate future graph entities.'), azureCli: supported('Front Door profile only; nested profile options and delivery child resources are not yet rendered.') },
  },
  appGateway: {
    kind: 'appGateway', description: 'Layer 7 gateway with explicit core AzureRM deployment blocks.',
    fields: [
      { key: 'sku', label: 'SKU', type: 'block', section: 'SKU and scaling', required: true, fields: [
        { key: 'name', label: 'Name', type: 'select', required: true, options: ['Basic', 'Standard_v2', 'WAF_v2'] },
        { key: 'tier', label: 'Tier', type: 'select', required: true, options: ['Basic', 'Standard_v2', 'WAF_v2'] },
        { key: 'capacity', label: 'Fixed capacity', type: 'number', min: 1, max: 125, step: 1 },
      ] },
      { key: 'autoscale_configuration', label: 'Autoscale configuration', type: 'block', section: 'SKU and scaling', fields: [
        { key: 'min_capacity', label: 'Minimum instances', type: 'number', required: true, min: 0, max: 100, step: 1 },
        { key: 'max_capacity', label: 'Maximum instances', type: 'number', min: 2, max: 125, step: 1 },
      ] },
      { key: 'http2_enabled', label: 'Enable HTTP/2', type: 'boolean', section: 'Protocol and security' },
      { key: 'fips_enabled', label: 'Enable FIPS', type: 'boolean', section: 'Protocol and security' },
      { key: 'zones', label: 'Availability zones', type: 'stringList', section: 'Availability' },
      { key: 'gateway_ip_configuration', label: 'Gateway subnet attachments', type: 'block', section: 'Core deployment', required: true, repeatable: true, minItems: 1, maxItems: 2, fields: [{ key: 'name', label: 'Configuration name', type: 'text', required: true }, { key: 'subnet_id', label: 'Application Gateway subnet', type: 'resourceRef', resourceKind: 'subnet', required: true }] },
      { key: 'frontend_ip_configuration', label: 'Frontend IP configurations', type: 'block', section: 'Core deployment', required: true, repeatable: true, minItems: 1, fields: [
        { key: 'name', label: 'Name', type: 'text', required: true }, { key: 'subnet_id', label: 'Private frontend subnet', type: 'resourceRef', resourceKind: 'subnet' },
        { key: 'public_ip_address_id', label: 'Public IP', type: 'resourceRef', resourceKind: 'publicIp' }, { key: 'private_ip_address_allocation', label: 'Private allocation', type: 'select', options: ['Dynamic', 'Static'] },
        { key: 'private_ip_address', label: 'Static private IP', type: 'text', visibleWhen: { key: 'private_ip_address_allocation', equals: 'Static' } },
      ] },
      { key: 'frontend_port', label: 'Frontend ports', type: 'block', section: 'Core deployment', required: true, repeatable: true, minItems: 1, fields: [{ key: 'name', label: 'Name', type: 'text', required: true }, { key: 'port', label: 'Port', type: 'number', required: true, min: 1, max: 65535, step: 1 }] },
      { key: 'backend_address_pool', label: 'Backend pools', type: 'block', section: 'Core deployment', required: true, repeatable: true, minItems: 1, fields: [{ key: 'name', label: 'Name', type: 'text', required: true }, { key: 'fqdns', label: 'FQDNs', type: 'stringList' }, { key: 'ip_addresses', label: 'IP addresses', type: 'stringList' }] },
      { key: 'backend_http_settings', label: 'Backend HTTP settings', type: 'block', section: 'Core deployment', repeatable: true, minItems: 1, fields: [
        { key: 'name', label: 'Name', type: 'text', required: true }, { key: 'cookie_based_affinity', label: 'Cookie affinity', type: 'select', required: true, options: ['Disabled', 'Enabled'] },
        { key: 'port', label: 'Port', type: 'number', required: true, min: 1, max: 65535, step: 1 }, { key: 'protocol', label: 'Protocol', type: 'select', required: true, options: ['Http', 'Https'] },
        { key: 'request_timeout', label: 'Request timeout', type: 'number', min: 1, max: 86400, step: 1 },
      ] },
      { key: 'http_listener', label: 'HTTP listeners', type: 'block', section: 'Core deployment', repeatable: true, minItems: 1, fields: [
        { key: 'name', label: 'Name', type: 'text', required: true }, { key: 'frontend_ip_configuration_name', label: 'Frontend IP name', type: 'text', required: true },
        { key: 'frontend_port_name', label: 'Frontend port name', type: 'text', required: true }, { key: 'protocol', label: 'Protocol', type: 'select', required: true, options: ['Http', 'Https'] },
        { key: 'ssl_certificate_name', label: 'TLS certificate name', type: 'text', visibleWhen: { key: 'protocol', equals: 'Https' } },
      ] },
      { key: 'request_routing_rule', label: 'Request routing rules', type: 'block', section: 'Core deployment', repeatable: true, minItems: 1, fields: [
        { key: 'name', label: 'Name', type: 'text', required: true }, { key: 'rule_type', label: 'Rule type', type: 'select', required: true, options: ['Basic', 'PathBasedRouting'] },
        { key: 'http_listener_name', label: 'Listener name', type: 'text', required: true }, { key: 'priority', label: 'Priority', type: 'number', required: true, min: 1, max: 20000, step: 1 },
        { key: 'backend_address_pool_name', label: 'Backend pool name', type: 'text' }, { key: 'backend_http_settings_name', label: 'Backend settings name', type: 'text' },
      ] },
      { key: 'waf_configuration', label: 'Inline WAF', type: 'block', section: 'WAF', fields: [
        { key: 'enabled', label: 'Enabled', type: 'boolean', required: true }, { key: 'firewall_mode', label: 'Mode', type: 'select', required: true, options: ['Detection', 'Prevention'] },
        { key: 'rule_set_type', label: 'Rule set type', type: 'select', options: ['OWASP', 'Microsoft_BotManagerRuleSet', 'Microsoft_DefaultRuleSet'] }, { key: 'rule_set_version', label: 'Rule set version', type: 'select', required: true, options: ['0.1', '1.0', '1.1', '2.1', '2.2', '2.2.9', '3.0', '3.1', '3.2'] },
      ] },
    ],
    defaults: { sku: { name: 'WAF_v2', tier: 'WAF_v2', capacity: 2 }, http2_enabled: false, fips_enabled: false, gateway_ip_configuration: [], frontend_ip_configuration: [], frontend_port: [], backend_address_pool: [], backend_http_settings: [], http_listener: [], request_routing_rule: [] }, export: allExportersSupportedComplex,
  },
  firewall: {
    kind: 'firewall', description: 'Managed firewall with VNet or Virtual Hub deployment configuration.',
    fields: [
      { key: 'sku_name', label: 'SKU name', type: 'select', section: 'SKU', options: ['AZFW_VNet', 'AZFW_Hub'], required: true },
      { key: 'sku_tier', label: 'SKU tier', type: 'select', section: 'SKU', options: ['Basic', 'Standard', 'Premium'], required: true },
      { key: 'threat_intel_mode', label: 'Threat intelligence mode', type: 'select', section: 'Security', options: ['Off', 'Alert', 'Deny'] },
      { key: 'firewall_policy_id', label: 'Firewall policy resource ID', type: 'text', section: 'Security' },
      { key: 'dns_servers', label: 'Custom DNS servers', type: 'stringList', section: 'DNS' },
      { key: 'dns_proxy_enabled', label: 'Enable DNS proxy', type: 'boolean', section: 'DNS' },
      { key: 'private_ip_ranges', label: 'Private ranges excluded from SNAT', type: 'stringList', section: 'SNAT' },
      { key: 'zones', label: 'Availability zones', type: 'stringList', section: 'Availability' },
      { key: 'ip_configuration', label: 'IP configurations', type: 'block', section: 'VNet deployment', repeatable: true, visibleWhen: { key: 'sku_name', equals: 'AZFW_VNet' }, fields: [
        { key: 'name', label: 'Name', type: 'text', required: true }, { key: 'subnet_id', label: 'AzureFirewallSubnet', type: 'resourceRef', resourceKind: 'subnet' }, { key: 'public_ip_address_id', label: 'Standard static public IP ID', type: 'text' },
      ] },
      { key: 'management_ip_configuration', label: 'Forced tunneling management interface', type: 'block', section: 'VNet deployment', visibleWhen: { key: 'sku_name', equals: 'AZFW_VNet' }, fields: [
        { key: 'name', label: 'Name', type: 'text', required: true }, { key: 'subnet_id', label: 'AzureFirewallManagementSubnet', type: 'resourceRef', resourceKind: 'subnet', required: true }, { key: 'public_ip_address_id', label: 'Standard static public IP ID', type: 'text', required: true },
      ] },
      { key: 'virtual_hub', label: 'Virtual Hub deployment', type: 'block', section: 'Virtual Hub deployment', visibleWhen: { key: 'sku_name', equals: 'AZFW_Hub' }, fields: [{ key: 'virtual_hub_id', label: 'Virtual Hub resource ID', type: 'text', required: true }, { key: 'public_ip_count', label: 'Public IP count', type: 'number', min: 1, step: 1 }] },
    ],
    defaults: { sku: 'AZFW_VNet', tier: 'Standard', sku_name: 'AZFW_VNet', sku_tier: 'Standard', threat_intel_mode: 'Alert', ip_configuration: [] }, export: allExportersSupportedComplex,
  },
  vpnGateway: {
    kind: 'vpnGateway', description: 'Virtual network gateway with explicit IP, BGP, and point-to-site settings.',
    fields: [
      { key: 'type', label: 'Gateway type', type: 'select', section: 'Gateway', options: ['Vpn', 'ExpressRoute'], required: true },
      { key: 'vpn_type', label: 'VPN routing type', type: 'select', section: 'Gateway', options: ['RouteBased', 'PolicyBased'], visibleWhen: { key: 'type', equals: 'Vpn' } },
      { key: 'sku', label: 'SKU', type: 'select', section: 'Gateway', options: ['Basic', 'Standard', 'HighPerformance', 'UltraPerformance', 'ErGwScale', 'ErGw1AZ', 'ErGw2AZ', 'ErGw3AZ', 'VpnGw1', 'VpnGw2', 'VpnGw3', 'VpnGw4', 'VpnGw5', 'VpnGw1AZ', 'VpnGw2AZ', 'VpnGw3AZ', 'VpnGw4AZ', 'VpnGw5AZ'], required: true },
      { key: 'generation', label: 'Generation', type: 'select', section: 'Gateway', options: ['Generation1', 'Generation2', 'None'] },
      { key: 'active_active', label: 'Active-active', type: 'boolean', section: 'Availability' },
      { key: 'private_ip_address_enabled', label: 'Enable private connection IP', type: 'boolean', section: 'Availability' },
      { key: 'bgp_enabled', label: 'Enable BGP', type: 'boolean', section: 'BGP' },
      { key: 'bgp_settings', label: 'BGP settings', type: 'block', section: 'BGP', visibleWhen: { key: 'bgp_enabled', equals: true }, fields: [{ key: 'asn', label: 'ASN', type: 'number', min: 1, max: 4294967295, step: 1 }, { key: 'peer_weight', label: 'Peer weight', type: 'number', min: 0, max: 100, step: 1 }] },
      { key: 'minimum_scale_unit', label: 'Minimum scale units', type: 'number', section: 'Autoscaling', min: 1, max: 40, step: 1, visibleWhen: { key: 'sku', equals: 'ErGwScale' } },
      { key: 'maximum_scale_unit', label: 'Maximum scale units', type: 'number', section: 'Autoscaling', min: 1, max: 40, step: 1, visibleWhen: { key: 'sku', equals: 'ErGwScale' } },
      { key: 'ip_configuration', label: 'Gateway IP configurations', type: 'block', section: 'Core deployment', required: true, repeatable: true, minItems: 1, maxItems: 3, fields: [
        { key: 'name', label: 'Name', type: 'text', help: 'AzureRM default: vnetGatewayConfig.' }, { key: 'private_ip_address_allocation', label: 'Private allocation', type: 'select', options: ['Dynamic'] },
        { key: 'subnet_id', label: 'GatewaySubnet', type: 'resourceRef', resourceKind: 'subnet', required: true }, { key: 'public_ip_address_id', label: 'Public IP resource ID', type: 'text', visibleWhen: { key: 'type', notEquals: 'ExpressRoute' } },
      ] },
      { key: 'vpn_client_configuration', label: 'Point-to-site VPN', type: 'block', section: 'Point-to-site', visibleWhen: { key: 'type', equals: 'Vpn' }, fields: [
        { key: 'address_space', label: 'Client address spaces', type: 'cidrList', required: true, minItems: 1 }, { key: 'vpn_client_protocols', label: 'Client protocols', type: 'stringList', help: 'SSTP, IkeV2, OpenVPN' },
        { key: 'vpn_auth_types', label: 'Authentication types', type: 'stringList', help: 'AAD, Radius, Certificate' }, { key: 'radius_server_address', label: 'RADIUS server address', type: 'text', help: 'Required when a deployment-time RADIUS secret is enabled.' }, { key: 'radius_secret_required', label: 'Require RADIUS secret at deployment', type: 'boolean', help: 'The secret value is supplied through a sensitive Terraform/Bicep input or an environment variable and is never stored in the design.' },
      ] },
    ],
    defaults: { gatewayType: 'Vpn', type: 'Vpn', vpn_type: 'RouteBased', sku: 'VpnGw1', activeActive: false, active_active: false, bgp_enabled: false, ip_configuration: [] }, export: allExportersSupportedComplex,
  },
  loadBalancer: {
    kind: 'loadBalancer', description: 'Layer 4 load balancer with repeatable frontend IP configurations.',
    fields: [
      { key: 'sku', label: 'SKU', type: 'select', section: 'SKU', options: ['Basic', 'Standard', 'Gateway'], required: true, help: 'Basic is retained for legacy/import scenarios; new Basic deployments are retired.' },
      { key: 'sku_tier', label: 'Tier', type: 'select', section: 'SKU', options: ['Regional', 'Global'], required: true },
      { key: 'edge_zone', label: 'Edge zone', type: 'text', section: 'Availability' },
      { key: 'frontend_ip_configuration', label: 'Frontend IP configurations', type: 'block', section: 'Frontends', repeatable: true, minItems: 1, fields: [
        { key: 'name', label: 'Name', type: 'text', required: true }, { key: 'zones', label: 'Zones', type: 'stringList' },
        { key: 'subnet_id', label: 'Private frontend subnet', type: 'resourceRef', resourceKind: 'subnet' }, { key: 'private_ip_address_allocation', label: 'Private allocation', type: 'select', options: ['Dynamic', 'Static'] },
        { key: 'private_ip_address', label: 'Static private IP', type: 'text', visibleWhen: { key: 'private_ip_address_allocation', equals: 'Static' } },
        { key: 'private_ip_address_version', label: 'IP version', type: 'select', options: ['IPv4', 'IPv6'] }, { key: 'public_ip_address_id', label: 'Public IP resource ID', type: 'text' },
      ] },
      { key: 'backend_address_pool', label: 'Backend address pools', type: 'block', section: 'Backends', repeatable: true, fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
      ] },
      { key: 'probe', label: 'Health probes', type: 'block', section: 'Health and rules', repeatable: true, fields: [
        { key: 'name', label: 'Name', type: 'text', required: true }, { key: 'protocol', label: 'Protocol', type: 'select', options: ['Http', 'Https', 'Tcp'] },
        { key: 'port', label: 'Port', type: 'number', required: true, min: 1, max: 65535, step: 1 }, { key: 'request_path', label: 'Request path', type: 'text', visibleWhen: { key: 'protocol', notEquals: 'Tcp' } },
        { key: 'interval_in_seconds', label: 'Interval (seconds)', type: 'number', min: 5, step: 1 }, { key: 'probe_threshold', label: 'Threshold', type: 'number', min: 1, max: 100, step: 1 },
      ] },
      { key: 'rule', label: 'Load balancing rules', type: 'block', section: 'Health and rules', repeatable: true, fields: [
        { key: 'name', label: 'Name', type: 'text', required: true }, { key: 'frontend_ip_configuration_name', label: 'Frontend name', type: 'text', required: true },
        { key: 'protocol', label: 'Protocol', type: 'select', required: true, options: ['Tcp', 'Udp', 'All'] }, { key: 'frontend_port', label: 'Frontend port', type: 'number', required: true, min: 0, max: 65534, step: 1 },
        { key: 'backend_port', label: 'Backend port', type: 'number', required: true, min: 0, max: 65535, step: 1 }, { key: 'idle_timeout_in_minutes', label: 'Idle timeout', type: 'number', min: 4, max: 30, step: 1 },
        { key: 'backend_address_pool_name', label: 'Backend pool name', type: 'text' }, { key: 'probe_name', label: 'Probe name', type: 'text' },
      ] },
    ],
    defaults: { sku: 'Standard', sku_tier: 'Regional', frontend_ip_configuration: [], backend_address_pool: [], frontendType: 'Public' }, export: allExportersSupportedComplex,
  },
  privateEndpoint: {
    kind: 'privateEndpoint', description: 'Private Link endpoint attached to a subnet with exactly one service connection.',
    fields: [
      { key: 'subnet_id', label: 'Endpoint subnet', type: 'resourceRef', resourceKind: 'subnet', section: 'Placement', required: true },
      { key: 'edge_zone', label: 'Edge zone', type: 'text', section: 'Placement' },
      { key: 'custom_network_interface_name', label: 'Network interface name', type: 'text', section: 'Placement' },
      { key: 'private_service_connection', label: 'Private service connection', type: 'block', section: 'Connection', required: true, fields: [
        { key: 'name', label: 'Connection name', type: 'text', required: true }, { key: 'is_manual_connection', label: 'Manual approval', type: 'boolean', required: true },
        { key: 'private_connection_resource_id', label: 'Target resource ID', type: 'text', help: 'Exactly one target resource ID or alias is required.' },
        { key: 'private_connection_resource_alias', label: 'Target resource alias', type: 'text', help: 'Exactly one target resource ID or alias is required.' },
        { key: 'subresource_names', label: 'Subresource names', type: 'stringList' },
        { key: 'request_message', label: 'Request message', type: 'text', min: 1, max: 140, visibleWhen: { key: 'is_manual_connection', equals: true } },
      ] },
      { key: 'private_dns_zone_group', label: 'Private DNS zone group', type: 'block', section: 'DNS', fields: [{ key: 'name', label: 'Group name', type: 'text', required: true }, { key: 'private_dns_zone_ids', label: 'Private DNS zone IDs', type: 'stringList', required: true, minItems: 1 }] },
      { key: 'ip_configuration', label: 'Static IP configurations', type: 'block', section: 'Addressing', repeatable: true, fields: [{ key: 'name', label: 'Name', type: 'text', required: true }, { key: 'private_ip_address', label: 'Private IP address', type: 'text', required: true }, { key: 'subresource_name', label: 'Subresource name', type: 'text' }, { key: 'member_name', label: 'Member name', type: 'text' }] },
    ],
    defaults: { private_service_connection: { name: 'connection', is_manual_connection: false, subresource_names: [] }, ip_configuration: [] }, export: allExportersSupportedComplex,
  },
  publicIp: {
    kind: 'publicIp', description: 'Azure Public IP address for NAT Gateway and other network frontends.',
    fields: [
      { key: 'allocation_method', label: 'Allocation method', type: 'select', section: 'Addressing', options: ['Static', 'Dynamic'], required: true },
      { key: 'sku', label: 'SKU', type: 'select', section: 'SKU', options: ['Basic', 'Standard'], required: true },
      { key: 'sku_tier', label: 'SKU tier', type: 'select', section: 'SKU', options: ['Regional', 'Global'], required: true },
      { key: 'zones', label: 'Availability zones', type: 'stringList', section: 'Availability' },
      { key: 'ip_version', label: 'IP version', type: 'select', section: 'Addressing', options: ['IPv4', 'IPv6'], required: true },
      { key: 'domain_name_label', label: 'Domain name label', type: 'text', section: 'DNS' },
      { key: 'reverse_fqdn', label: 'Reverse FQDN', type: 'text', section: 'DNS' },
      { key: 'idle_timeout_in_minutes', label: 'Idle timeout (minutes)', type: 'number', section: 'Connection settings', min: 4, max: 30, step: 1 },
      { key: 'edge_zone', label: 'Edge zone', type: 'text', section: 'Availability' },
    ],
    defaults: { allocation_method: 'Static', sku: 'Standard', sku_tier: 'Regional', zones: [], ip_version: 'IPv4', idle_timeout_in_minutes: 4 },
    export: { terraform: supported('Complete Public IP resource and NAT Gateway association.'), bicep: supported('Complete Public IP resource and NAT Gateway association.'), azureCli: supported('Complete Public IP resource and NAT Gateway association.') },
  },
  networkSecurityGroup: {
    kind: 'networkSecurityGroup', description: 'Stateful packet filtering rules associated with one or more subnets.',
    fields: [{ key: 'security_rule', label: 'Security rules', type: 'block', section: 'Rules', repeatable: true, fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'priority', label: 'Priority', type: 'number', required: true, min: 100, max: 4096, step: 1 },
      { key: 'direction', label: 'Direction', type: 'select', required: true, options: ['Inbound', 'Outbound'] },
      { key: 'access', label: 'Access', type: 'select', required: true, options: ['Allow', 'Deny'] },
      { key: 'protocol', label: 'Protocol', type: 'select', required: true, options: ['Tcp', 'Udp', 'Icmp', 'Esp', 'Ah', '*'] },
      { key: 'source_port_ranges', label: 'Source port ranges', type: 'stringList', required: true, minItems: 1 },
      { key: 'destination_port_ranges', label: 'Destination port ranges', type: 'stringList', required: true, minItems: 1 },
      { key: 'source_address_prefixes', label: 'Source address prefixes', type: 'stringList', required: true, minItems: 1 },
      { key: 'destination_address_prefixes', label: 'Destination address prefixes', type: 'stringList', required: true, minItems: 1 },
    ] }],
    defaults: { security_rule: [] },
    export: { terraform: supported('NSG with normalized repeatable security rules and subnet associations.'), bicep: supported('NSG with repeatable security rules and subnet associations.'), azureCli: supported('NSG with repeatable security rules and subnet associations.') },
  },
  routeTable: {
    kind: 'routeTable', description: 'User-defined routes associated with one or more subnets.',
    fields: [
      { key: 'disable_bgp_route_propagation', label: 'Disable BGP route propagation', type: 'boolean', section: 'Routing' },
      { key: 'route', label: 'Routes', type: 'block', section: 'Routes', repeatable: true, fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
        { key: 'address_prefix', label: 'Address prefix', type: 'text', required: true },
        { key: 'next_hop_type', label: 'Next hop type', type: 'select', required: true, options: ['VirtualNetworkGateway', 'VnetLocal', 'Internet', 'VirtualAppliance', 'None'] },
        { key: 'next_hop_in_ip_address', label: 'Next hop IP address', type: 'text', visibleWhen: { key: 'next_hop_type', equals: 'VirtualAppliance' } },
      ] },
    ],
    defaults: { disable_bgp_route_propagation: false, route: [] },
    export: { terraform: supported('Route table with repeatable routes and subnet associations.'), bicep: supported('Route table with repeatable routes and subnet associations.'), azureCli: supported('Route table with repeatable routes and subnet associations.') },
  },
}

export function defaultNodeData(kind: ResourceKind, ordinal = 1): NetworkNodeData {
  const baseName = kind === 'vnet' ? 'vnet' : kind === 'frontDoor' ? 'front-door' : kind === 'publicIp' ? 'pip' : kind === 'networkSecurityGroup' ? 'nsg' : kind === 'routeTable' ? 'rt' : kind
  const defaults = structuredClone(RESOURCE_SCHEMAS[kind].defaults)
  if (kind === 'vnet') {
    const cidr = `10.${30 + ordinal}.0.0/16`
    defaults.addressSpace = cidr
    defaults.addressSpaces = [cidr]
  }
  return { label: `${baseName}-${ordinal}`, kind, region: kind === 'frontDoor' ? 'global' : 'eastus', resourceGroup: 'rg-network', ...defaults }
}

const RESOURCE_KINDS = new Set<ResourceKind>(Object.keys(RESOURCE_LABELS) as ResourceKind[])
const hasControlCharacter = (value: string) => [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
const boundedString = (value: unknown, max = 512): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !hasControlCharacter(value)

const safeConfigurationValue = (value: unknown, depth = 0): boolean => {
  if (depth > 5) return false
  if (value === undefined || value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return value.length <= 4096 && !hasControlCharacter(value)
  if (Array.isArray(value)) return value.length <= 128 && value.every((item) => safeConfigurationValue(item, depth + 1))
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return entries.length <= 128 && entries.every(([key, item]) => boundedString(key, 128) && safeConfigurationValue(item, depth + 1))
  }
  return false
}

export function isNetworkDesign(value: unknown): value is NetworkDesign {
  if (!value || typeof value !== 'object') return false
  const design = value as Partial<NetworkDesign>
  if (!boundedString(design.name, 200) || !Array.isArray(design.nodes) || !Array.isArray(design.edges) || design.nodes.length > 5000 || design.edges.length > 10000) return false
  const ids = new Set<string>()
  for (const candidate of design.nodes) {
    const node = candidate as Partial<NetworkNode>
    const data = node.data as Partial<NetworkNodeData> | undefined
    if (!boundedString(node.id) || ids.has(node.id) || node.type !== 'azureResource' || !node.position || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y) || !data || !boundedString(data.label, 256) || !RESOURCE_KINDS.has(data.kind as ResourceKind)) return false
    for (const [key, item] of Object.entries(data)) if (!['label', 'kind'].includes(key) && !safeConfigurationValue(item)) return false
    ids.add(node.id)
  }
  for (const candidate of design.nodes) {
    const node = candidate as NetworkNode
    if (node.data.parentVnetId && !ids.has(node.data.parentVnetId)) return false
  }
  const edgeIds = new Set<string>()
  for (const candidate of design.edges) {
    const edge = candidate as Partial<NetworkEdge>
    if (!boundedString(edge.id) || edgeIds.has(edge.id) || !boundedString(edge.source) || !boundedString(edge.target) || !ids.has(edge.source) || !ids.has(edge.target)) return false
    if (edge.data?.kind && !['peering', 'attachment', 'subnetNetworkSecurityGroup', 'subnetRouteTable', 'subnetNatGateway', 'natGatewayPublicIp', 'firewallSubnet', 'firewallPublicIp', 'appGatewayPublicIp'].includes(edge.data.kind)) return false
    edgeIds.add(edge.id)
  }
  return true
}

const ipv4ToInt = (ip: string) => ip.split('.').reduce((acc, octet) => (acc * 256) + Number(octet), 0) >>> 0

export function parseCidr(cidr?: string): { start: number; end: number; prefix: number } | null {
  if (!cidr || cidr !== cidr.trim()) return null
  const [ip, prefixText, ...extra] = cidr.split('/')
  const rawOctets = ip?.split('.')
  if (!rawOctets || rawOctets.length !== 4 || rawOctets.some((octet) => !/^\d{1,3}$/.test(octet))) return null
  const octets = rawOctets.map(Number)
  const prefix = Number(prefixText)
  if (extra.length || octets.some((n) => n < 0 || n > 255) || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null
  const value = ipv4ToInt(ip)
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  const start = (value & mask) >>> 0
  if (value !== start) return null
  const size = 2 ** (32 - prefix)
  return { start, end: start + size - 1, prefix }
}

export const cidrsOverlap = (a?: string, b?: string) => {
  const left = parseCidr(a); const right = parseCidr(b)
  return Boolean(left && right && left.start <= right.end && right.start <= left.end)
}

export const addressSpacesFor = (node: NetworkNode) => {
  const list = node.data.addressSpaces
  // Older persisted designs and callers may update the legacy singular field only.
  if (node.data.addressSpace && list?.length && node.data.addressSpace !== list[0]) return [node.data.addressSpace]
  return list?.length ? list : node.data.addressSpace ? [node.data.addressSpace] : []
}
export const nodesOverlap = (a: NetworkNode, b: NetworkNode) => addressSpacesFor(a).some((left) => addressSpacesFor(b).some((right) => cidrsOverlap(left, right)))

export function validateDesign(nodes: NetworkNode[], edges: NetworkEdge[]) {
  const issues: string[] = []
  const vnets = nodes.filter((node) => node.data.kind === 'vnet')
  for (const node of vnets) for (const cidr of addressSpacesFor(node)) {
    const parsed = parseCidr(cidr)
    if (!parsed) issues.push(`${node.data.label}: invalid or non-canonical IPv4 CIDR`)
    else if (parsed.prefix < 2 || parsed.prefix > 29) issues.push(`${node.data.label}: Azure VNet IPv4 prefixes must be /2 through /29`)
  }
  for (const node of vnets) if (addressSpacesFor(node).length === 0) issues.push(`${node.data.label}: address space is required`)
  for (const node of vnets) {
    const ranges = addressSpacesFor(node)
    for (let i = 0; i < ranges.length; i++) for (let j = i + 1; j < ranges.length; j++) if (cidrsOverlap(ranges[i], ranges[j])) issues.push(`${node.data.label}: address spaces overlap each other`)
  }
  for (const node of nodes) {
    const data = node.data as Record<string, unknown>
    const schema = RESOURCE_SCHEMAS[node.data.kind]
    for (const field of schema.fields) {
      const value = data[String(field.key)]
      if (typeof value === 'number') {
        if (!Number.isFinite(value) || (field.step === 1 && !Number.isInteger(value))) issues.push(`${node.data.label}: ${field.label} must be an integer`)
        if (field.min !== undefined && value < field.min) issues.push(`${node.data.label}: ${field.label} must be at least ${field.min}`)
        if (field.max !== undefined && value > field.max) issues.push(`${node.data.label}: ${field.label} must be at most ${field.max}`)
      }
      if (Array.isArray(value)) {
        if (field.minItems !== undefined && value.length < field.minItems) issues.push(`${node.data.label}: ${field.label} requires at least ${field.minItems} item${field.minItems === 1 ? '' : 's'}`)
        if (field.maxItems !== undefined && value.length > field.maxItems) issues.push(`${node.data.label}: ${field.label} allows at most ${field.maxItems} item${field.maxItems === 1 ? '' : 's'}`)
      }
    }
    if (node.data.kind === 'frontDoor' && node.data.region !== 'global') issues.push(`${node.data.label}: Azure Front Door profiles are global and cannot have a regional location`)
    if (node.data.kind === 'natGateway') {
      const sku = String(data.sku_name ?? data.sku ?? 'Standard')
      const zones = Array.isArray(data.zones) ? data.zones : []
      if (sku === 'StandardV2' && zones.length) issues.push(`${node.data.label}: StandardV2 NAT Gateway does not support availability zones`)
      if (sku === 'Standard' && zones.length > 1) issues.push(`${node.data.label}: Standard NAT Gateway supports at most one availability zone`)
    }
    if (node.data.kind === 'publicIp') {
      const sku = String(data.sku ?? 'Standard'); const tier = String(data.sku_tier ?? 'Regional'); const allocation = String(data.allocation_method ?? 'Static')
      const zones = Array.isArray(data.zones) ? data.zones : []
      if (sku === 'Standard' && allocation !== 'Static') issues.push(`${node.data.label}: Standard Public IP requires Static allocation`)
      if (tier === 'Global' && sku !== 'Standard') issues.push(`${node.data.label}: Global Public IP tier requires Standard SKU`)
      if (tier === 'Global' && zones.length) issues.push(`${node.data.label}: Global Public IP tier cannot use availability zones`)
      if (data.edge_zone && zones.length) issues.push(`${node.data.label}: edge_zone cannot be combined with availability zones`)
    }
    if (node.data.kind === 'networkSecurityGroup') {
      const rules = Array.isArray(data.security_rule) ? data.security_rule as Array<Record<string, unknown>> : []
      const names = new Set<string>(); const priorities = new Set<number>()
      for (const rule of rules) {
        const name = String(rule.name ?? '').trim(); const priority = Number(rule.priority)
        if (!name) issues.push(`${node.data.label}: every security rule requires a name`)
        else if (names.has(name.toLowerCase())) issues.push(`${node.data.label}: duplicate security rule name ${name}`)
        names.add(name.toLowerCase())
        if (!Number.isInteger(priority) || priority < 100 || priority > 4096) issues.push(`${node.data.label}: security rule ${name || '(unnamed)'} priority must be 100 through 4096`)
        else if (priorities.has(priority)) issues.push(`${node.data.label}: duplicate security rule priority ${priority}`)
        priorities.add(priority)
        for (const key of ['source_port_ranges', 'destination_port_ranges', 'source_address_prefixes', 'destination_address_prefixes']) if (!Array.isArray(rule[key]) || !(rule[key] as unknown[]).length) issues.push(`${node.data.label}: security rule ${name || '(unnamed)'} requires ${key}`)
      }
    }
    if (node.data.kind === 'routeTable') {
      const routes = Array.isArray(data.route) ? data.route as Array<Record<string, unknown>> : []
      const names = new Set<string>()
      for (const route of routes) {
        const name = String(route.name ?? '').trim()
        if (!name) issues.push(`${node.data.label}: every route requires a name`)
        else if (names.has(name.toLowerCase())) issues.push(`${node.data.label}: duplicate route name ${name}`)
        names.add(name.toLowerCase())
        if (!String(route.address_prefix ?? '').trim()) issues.push(`${node.data.label}: route ${name || '(unnamed)'} requires address_prefix`)
        if (route.next_hop_type === 'VirtualAppliance' && !String(route.next_hop_in_ip_address ?? '').trim()) issues.push(`${node.data.label}: route ${name || '(unnamed)'} requires next_hop_in_ip_address for VirtualAppliance`)
        if (route.next_hop_type !== 'VirtualAppliance' && route.next_hop_in_ip_address) issues.push(`${node.data.label}: route ${name || '(unnamed)'} can set next_hop_in_ip_address only for VirtualAppliance`)
      }
    }
    if (node.data.kind === 'loadBalancer' && data.sku_tier === 'Global' && data.sku !== 'Standard') issues.push(`${node.data.label}: Global Load Balancer tier requires Standard SKU`)
    if (node.data.kind === 'vpnGateway') {
      const gatewayType = String(data.type ?? data.gatewayType ?? 'Vpn')
      if (data.vpn_type === 'PolicyBased' && data.sku !== 'Basic') issues.push(`${node.data.label}: PolicyBased VPN gateways support only the Basic SKU`)
      if (['UltraPerformance', 'ErGwScale'].includes(String(data.sku)) && gatewayType !== 'ExpressRoute') issues.push(`${node.data.label}: ${String(data.sku)} is supported only for ExpressRoute gateways`)
      if (data.sku !== 'ErGwScale' && (data.minimum_scale_unit !== undefined || data.maximum_scale_unit !== undefined)) issues.push(`${node.data.label}: scale units are supported only by ErGwScale`)
      const configurations = Array.isArray(data.ip_configuration) ? data.ip_configuration as Array<Record<string, unknown>> : []
      if (configurations.length) {
        const expected = data.active_active ? 2 : 1
        if (configurations.length !== expected) issues.push(`${node.data.label}: ${data.active_active ? 'active-active' : 'active-standby'} gateway requires ${expected} IP configuration${expected === 1 ? '' : 's'}`)
        if (gatewayType === 'ExpressRoute' && configurations.some((item) => item.public_ip_address_id)) issues.push(`${node.data.label}: ExpressRoute gateway IP configurations cannot set public_ip_address_id`)
      }
    }
    if (node.data.kind === 'privateEndpoint') {
      if (!data.subnet_id) issues.push(`${node.data.label}: endpoint subnet is required`)
      const connection = data.private_service_connection as Record<string, unknown> | undefined
      if (!connection) issues.push(`${node.data.label}: exactly one private service connection is required`)
      else {
        const hasId = Boolean(connection.private_connection_resource_id); const hasAlias = Boolean(connection.private_connection_resource_alias)
        if (hasId === hasAlias) issues.push(`${node.data.label}: private service connection requires exactly one target resource ID or alias`)
        if (connection.is_manual_connection && !String(connection.request_message ?? '').trim()) issues.push(`${node.data.label}: manual private service connection requires a request message`)
        if (!connection.is_manual_connection && connection.request_message) issues.push(`${node.data.label}: automatic private service connection cannot include a request message`)
      }
    }
    if (node.data.kind === 'appGateway') {
      const autoscale = data.autoscale_configuration as Record<string, unknown> | undefined
      const sku = data.sku as Record<string, unknown> | undefined
      if (autoscale && Number(autoscale.max_capacity) < Number(autoscale.min_capacity)) issues.push(`${node.data.label}: autoscale maximum capacity must be greater than or equal to minimum capacity`)
      if (autoscale && sku && sku.capacity !== undefined) issues.push(`${node.data.label}: fixed SKU capacity cannot be combined with autoscale configuration`)
      if (sku && sku.name !== sku.tier) issues.push(`${node.data.label}: Application Gateway SKU name and tier must match for supported new deployments`)
    }
  }
  if (nodes.some((node) => node.data.imported)) issues.push('Imported resources are diagram-only until explicitly adopted for management')
  const subscriptions = new Set(nodes.map((node) => node.data.subscriptionId).filter(Boolean))
  if (subscriptions.size > 1) issues.push('Mixed-subscription export is not supported')
  const resourceNames = new Set<string>()
  for (const node of nodes) {
    const scope = node.data.kind === 'subnet' ? `${node.data.resourceGroup || 'rg-network'}/${node.data.parentVnetId || '(missing-vnet)'}` : node.data.resourceGroup || 'rg-network'
    const key = `${scope}/${node.data.label}`.toLowerCase()
    if (resourceNames.has(key)) issues.push(`Duplicate resource name in ${node.data.kind === 'subnet' ? 'virtual network' : 'resource group'}: ${node.data.label}`)
    resourceNames.add(key)
  }
  const peeringPairs = new Set<string>()
  for (const edge of edges.filter((item) => item.data?.kind === 'peering')) {
    const pair = [edge.source, edge.target].sort().join('|')
    if (peeringPairs.has(pair)) issues.push('Duplicate VNet peering connection')
    peeringPairs.add(pair)
    const source = nodes.find((node) => node.id === edge.source); const target = nodes.find((node) => node.id === edge.target)
    if (source?.data.kind !== 'vnet' || target?.data.kind !== 'vnet') issues.push('Peerings can only connect virtual networks')
    else if (nodesOverlap(source, target)) issues.push(`Cannot peer overlapping networks: ${source.data.label} and ${target.data.label}`)
  }
  const associationPairs = new Set<string>()
  for (const edge of edges.filter((item) => item.data?.kind && item.data.kind !== 'peering' && item.data.kind !== 'attachment')) {
    const kind = edge.data!.kind as Exclude<EdgeKind, 'peering' | 'attachment'>
    const source = nodes.find((node) => node.id === edge.source); const target = nodes.find((node) => node.id === edge.target)
    const expected = source && target ? associationKindFor(source.data.kind, target.data.kind) : undefined
    const label = ASSOCIATION_LABELS[kind]
    if (expected !== kind) issues.push(`Invalid ${label}`)
    const pair = `${kind}|${[edge.source, edge.target].sort().join('|')}`
    if (associationPairs.has(pair)) issues.push(`Duplicate ${label}`)
    associationPairs.add(pair)
  }
  return [...new Set(issues)]
}

export const starterDesign: NetworkDesign = {
  name: 'Hub and spoke prototype',
  nodes: [
    { id: 'hub', type: 'azureResource', position: { x: 360, y: 210 }, data: { label: 'vnet-hub-prod', kind: 'vnet', addressSpace: '10.0.0.0/16', region: 'eastus', resourceGroup: 'rg-network-prod' } },
    { id: 'firewall', type: 'azureResource', position: { x: 405, y: 390 }, data: { label: 'afw-hub-prod', kind: 'firewall', region: 'eastus', resourceGroup: 'rg-network-prod', sku: 'AZFW_VNet' } },
    { id: 'spoke-app', type: 'azureResource', position: { x: 70, y: 70 }, data: { label: 'vnet-app-prod', kind: 'vnet', addressSpace: '10.10.0.0/16', region: 'eastus', resourceGroup: 'rg-app-prod' } },
    { id: 'spoke-data', type: 'azureResource', position: { x: 690, y: 70 }, data: { label: 'vnet-data-prod', kind: 'vnet', addressSpace: '10.20.0.0/16', region: 'eastus', resourceGroup: 'rg-data-prod' } },
    { id: 'appgw', type: 'azureResource', position: { x: 70, y: 280 }, data: { label: 'agw-app-prod', kind: 'appGateway', region: 'eastus', resourceGroup: 'rg-app-prod', sku: 'WAF_v2' } },
    { id: 'nat', type: 'azureResource', position: { x: 690, y: 280 }, data: { label: 'nat-data-prod', kind: 'natGateway', region: 'eastus', resourceGroup: 'rg-data-prod', sku: 'Standard' } },
  ],
  edges: [
    { id: 'hub-app', source: 'hub', target: 'spoke-app', type: 'smoothstep', animated: true, label: 'VNet peering', data: { kind: 'peering' } },
    { id: 'hub-data', source: 'hub', target: 'spoke-data', type: 'smoothstep', animated: true, label: 'VNet peering', data: { kind: 'peering' } },
    { id: 'hub-fw', source: 'hub', target: 'firewall', type: 'smoothstep', data: { kind: 'attachment' } },
    { id: 'app-agw', source: 'spoke-app', target: 'appgw', type: 'smoothstep', data: { kind: 'attachment' } },
    { id: 'data-nat', source: 'spoke-data', target: 'nat', type: 'smoothstep', data: { kind: 'attachment' } },
  ],
}
