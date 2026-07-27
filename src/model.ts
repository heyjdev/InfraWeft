export type ResourceKind = 'vnet' | 'subnet' | 'appGateway' | 'natGateway' | 'firewall' | 'vpnGateway' | 'loadBalancer' | 'privateEndpoint'

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
  sku?: string
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
  data?: { kind?: 'peering' | 'attachment'; imported?: boolean; [key: string]: unknown }
}

export type NetworkDesign = {
  name: string
  nodes: NetworkNode[]
  edges: NetworkEdge[]
}

export const RESOURCE_LABELS: Record<ResourceKind, string> = {
  vnet: 'Virtual network', subnet: 'Subnet', appGateway: 'Application Gateway', natGateway: 'NAT Gateway',
  firewall: 'Azure Firewall', vpnGateway: 'VPN Gateway', loadBalancer: 'Load Balancer', privateEndpoint: 'Private Endpoint',
}

const ipv4ToInt = (ip: string) => ip.split('.').reduce((acc, octet) => (acc * 256) + Number(octet), 0) >>> 0

export function parseCidr(cidr?: string): { start: number; end: number; prefix: number } | null {
  if (!cidr) return null
  const [ip, prefixText, ...extra] = cidr.trim().split('/')
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

export const addressSpacesFor = (node: NetworkNode) => node.data.addressSpaces?.length ? node.data.addressSpaces : node.data.addressSpace ? [node.data.addressSpace] : []
export const nodesOverlap = (a: NetworkNode, b: NetworkNode) => addressSpacesFor(a).some((left) => addressSpacesFor(b).some((right) => cidrsOverlap(left, right)))

export function validateDesign(nodes: NetworkNode[], edges: NetworkEdge[]) {
  const issues: string[] = []
  const vnets = nodes.filter((node) => node.data.kind === 'vnet')
  for (const node of vnets) for (const cidr of addressSpacesFor(node)) if (!parseCidr(cidr)) issues.push(`${node.data.label}: invalid or non-canonical IPv4 CIDR`)
  for (const node of vnets) if (addressSpacesFor(node).length === 0) issues.push(`${node.data.label}: address space is required`)
  const subscriptions = new Set(nodes.map((node) => node.data.subscriptionId).filter(Boolean))
  if (subscriptions.size > 1) issues.push('Mixed-subscription export is not supported')
  const resourceNames = new Set<string>()
  for (const node of nodes) {
    const key = `${node.data.resourceGroup || 'rg-network'}/${node.data.label}`.toLowerCase()
    if (resourceNames.has(key)) issues.push(`Duplicate resource name in resource group: ${node.data.label}`)
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
