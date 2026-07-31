import { addressSpacesFor, cidrsOverlap, parseCidr, RESOURCE_SCHEMAS, type ExportTarget, type NetworkEdge, type NetworkNode } from './model'

const safe = (value: string) => value.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^([0-9])/, '_$1')
const q = (value?: string) => JSON.stringify(value ?? '')
const scalar = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback
const bq = (value?: string) => `'${(value ?? '').replaceAll("'", "''")}'`
const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const peerings = (edges: NetworkEdge[]) => edges.filter((edge) => edge.data?.kind === 'peering')
const stableSuffix = (value: string) => {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 0x01000193) }
  return (hash >>> 0).toString(36).padStart(7, '0').slice(-7)
}
const resourceKey = (node: NetworkNode) => `${safe(`${node.data.resourceGroup || 'rg_network'}_${node.data.label}`).slice(0, 64)}_${stableSuffix(node.id)}`
const subscriptionFor = (nodes: NetworkNode[]) => [...new Set(nodes.map((node) => node.data.subscriptionId).filter((id): id is string => Boolean(id)))][0]
const cleanComment = (value: string) => value.replace(/[\r\n]+/g, ' ')
const records = (value: unknown) => Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : []
const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const strings = (value: unknown) => Array.isArray(value) ? value.map(String) : []
const hclList = (value: unknown) => `[${strings(value).map((item) => q(item)).join(', ')}]`
const hclAssignments = (entries: Array<[string, string | undefined]>, indent = 2) => {
  const present = entries.filter((entry): entry is [string, string] => entry[1] !== undefined)
  const width = Math.max(...present.map(([key]) => key.length))
  return present.map(([key, value]) => `${' '.repeat(indent)}${key.padEnd(width)} = ${value}`).join('\n')
}
const associationEdges = (edges: NetworkEdge[]) => edges.filter((edge) => edge.data?.kind && !['peering', 'attachment'].includes(edge.data.kind))
const terraformType: Partial<Record<NetworkNode['data']['kind'], string>> = {
  vnet: 'azurerm_virtual_network', subnet: 'azurerm_subnet', natGateway: 'azurerm_nat_gateway', frontDoor: 'azurerm_cdn_frontdoor_profile',
  publicIp: 'azurerm_public_ip', networkSecurityGroup: 'azurerm_network_security_group', routeTable: 'azurerm_route_table',
  appGateway: 'azurerm_application_gateway', firewall: 'azurerm_firewall', vpnGateway: 'azurerm_virtual_network_gateway',
  loadBalancer: 'azurerm_lb', privateEndpoint: 'azurerm_private_endpoint',
}
function terraformId(value: unknown, nodes: NetworkNode[]) {
  const raw = String(value ?? '')
  const id = raw.startsWith('resource-reference://') ? raw.slice('resource-reference://'.length) : raw
  const target = nodes.find((candidate) => candidate.id === id)
  const type = target && terraformType[target.data.kind]
  return target && type ? `${type}.${resourceKey(target)}.id` : q(raw)
}
function referencedNode(value: unknown, nodes: NetworkNode[]) {
  const raw = String(value ?? '')
  const id = raw.startsWith('resource-reference://') ? raw.slice('resource-reference://'.length) : raw
  return nodes.find((candidate) => candidate.id === id)
}
function cliReference(value: unknown, nodes: NetworkNode[]) {
  const raw = String(value ?? '')
  return referencedNode(value, nodes)?.data.label ?? (raw.startsWith('resource-reference://') ? raw.slice('resource-reference://'.length) : raw)
}
const hclRefs = (value: unknown, nodes: NetworkNode[]) => `[${strings(value).map((item) => terraformId(item, nodes)).join(', ')}]`
const ends = (edge: NetworkEdge, nodes: NetworkNode[], left: NetworkNode['data']['kind'], right: NetworkNode['data']['kind']) => {
  const a = nodes.find((node) => node.id === edge.source); const b = nodes.find((node) => node.id === edge.target)
  if (a?.data.kind === left && b?.data.kind === right) return [a, b] as const
  if (b?.data.kind === left && a?.data.kind === right) return [b, a] as const
  return undefined
}

export type ExportFormat = ExportTarget
export type ExportDiagnostic = { node: NetworkNode; reason: string; field?: string }
export type ExportReport = { supported: NetworkNode[]; unsupported: ExportDiagnostic[] }

function diagnosticPropertyField(reason: string) {
  const configuredField = reason.match(/^Configured field ([A-Za-z0-9_]+)/)?.[1]
  if (configuredField) return configuredField
  const requiredBlock = reason.match(/^At least one ([A-Za-z0-9_]+) block/)?.[1]
  if (requiredBlock) return requiredBlock
  const patterns: Array<[RegExp, string]> = [
    [/Bicep export currently requires every managed resource to use one resource group/i, 'resourceGroup'],
    [/Address space is required|subnet address prefix|subnet prefix/i, 'addressSpaces'],
    [/Parent virtual network/i, 'parentVnetId'],
    [/Idle timeout/i, 'idle_timeout_in_minutes'],
    [/Front Door SKU/i, 'sku_name'],
    [/Structured SKU|SKU capacity|autoscale configuration/i, 'sku'],
    [/Application Gateway frontend/i, 'frontend_ip_configuration'],
    [/Application Gateway listener|HTTPS listeners/i, 'http_listener'],
    [/Application Gateway routing rule|PathBasedRouting/i, 'request_routing_rule'],
    [/Application Gateway WAF/i, 'waf_configuration'],
    [/firewall management configuration/i, 'management_ip_configuration'],
    [/Firewall IP configuration|Azure Firewall IP configuration|firewall export requires each VNet IP configuration|AZFW_VNet requires/i, 'ip_configuration'],
    [/gateway IP configuration|explicit Public IP|custom gateway IP configuration names|GatewaySubnet references/i, 'ip_configuration'],
    [/gateway export currently supports VPN gateways/i, 'type'],
    [/active-active mode/i, 'active_active'],
    [/PolicyBased VPN Gateway/i, 'vpn_type'],
    [/RADIUS|point-to-site authentication/i, 'vpn_client_configuration'],
    [/Load Balancer frontend|explicit frontend IP configuration/i, 'frontend_ip_configuration'],
    [/load-balancing rule|Load Balancer rules|backend pool reference|probe reference|rule idle timeout/i, 'rule'],
    [/Load Balancer SKU-tier/i, 'sku_tier'],
    [/Endpoint subnet/i, 'subnet_id'],
    [/private service connection|private-endpoint create|private endpoints require/i, 'private_service_connection'],
  ]
  return patterns.find(([pattern]) => pattern.test(reason))?.[1]
}

function attachedParent(node: NetworkNode, nodes: NetworkNode[], edges: NetworkEdge[]) {
  if (node.data.parentVnetId) return nodes.find((candidate) => candidate.id === node.data.parentVnetId && candidate.data.kind === 'vnet')
  const neighbors = edges
    .filter((edge) => edge.data?.kind === 'attachment' && (edge.source === node.id || edge.target === node.id))
    .map((edge) => nodes.find((candidate) => candidate.id === (edge.source === node.id ? edge.target : edge.source)))
    .filter((candidate): candidate is NetworkNode => candidate?.data.kind === 'vnet')
  return neighbors.length === 1 ? neighbors[0] : undefined
}

function effectiveFirewallConfigurations(node: NetworkNode, nodes: NetworkNode[], edges: NetworkEdge[]) {
  const configurations = records(node.data.ip_configuration).map((item) => ({ ...item }))
  const related = (kind: NetworkNode['data']['kind'], edgeKinds: string[]) => edges
    .filter((edge) => edgeKinds.includes(String(edge.data?.kind)) && (edge.source === node.id || edge.target === node.id))
    .map((edge) => nodes.find((candidate) => candidate.id === (edge.source === node.id ? edge.target : edge.source)))
    .filter((candidate): candidate is NetworkNode => candidate?.data.kind === kind)
  const subnets = related('subnet', ['attachment', 'firewallSubnet'])
  const publicIps = related('publicIp', ['attachment', 'firewallPublicIp'])
  for (const subnet of subnets) {
    if (configurations.some((configuration) => referencedNode(configuration.subnet_id, nodes)?.id === subnet.id)) continue
    const open = configurations.findIndex((configuration) => !configuration.subnet_id)
    const patch = { subnet_id: `resource-reference://${subnet.id}` }
    if (open >= 0) configurations[open] = { ...configurations[open], ...patch }
    else configurations.push({ name: `firewall-ip-${configurations.length + 1}`, ...patch })
  }
  for (const publicIp of publicIps) {
    if (configurations.some((configuration) => referencedNode(configuration.public_ip_address_id, nodes)?.id === publicIp.id)) continue
    const open = configurations.findIndex((configuration) => !configuration.public_ip_address_id)
    const patch = { public_ip_address_id: `resource-reference://${publicIp.id}` }
    if (open >= 0) configurations[open] = { ...configurations[open], ...patch }
    else configurations.push({ name: `firewall-ip-${configurations.length + 1}`, ...patch })
  }
  return configurations
}

const COMMON_RENDERED_KEYS = new Set(['label', 'kind', 'region', 'resourceGroup', 'subscriptionId', 'imported'])
const RENDERED_KEYS: Partial<Record<NetworkNode['data']['kind'], Set<string>>> = {
  vnet: new Set(['addressSpace', 'addressSpaces']),
  subnet: new Set(['parentVnetId', 'addressSpace', 'addressSpaces']),
  natGateway: new Set(['sku', 'sku_name', 'idleTimeoutMinutes', 'idle_timeout_in_minutes', 'zones']),
  frontDoor: new Set(['sku', 'sku_name', 'response_timeout_seconds']),
  publicIp: new Set(['allocation_method', 'sku', 'sku_tier', 'zones', 'ip_version', 'domain_name_label', 'reverse_fqdn', 'idle_timeout_in_minutes', 'edge_zone']),
  networkSecurityGroup: new Set(['security_rule']),
  routeTable: new Set(['disable_bgp_route_propagation', 'route']),
  appGateway: new Set(['sku', 'autoscale_configuration', 'http2_enabled', 'fips_enabled', 'zones', 'gateway_ip_configuration', 'frontend_ip_configuration', 'frontend_port', 'backend_address_pool', 'backend_http_settings', 'http_listener', 'request_routing_rule', 'waf_configuration']),
  firewall: new Set(['sku', 'tier', 'sku_name', 'sku_tier', 'threat_intel_mode', 'firewall_policy_id', 'dns_servers', 'dns_proxy_enabled', 'private_ip_ranges', 'zones', 'ip_configuration', 'management_ip_configuration', 'virtual_hub']),
  vpnGateway: new Set(['gatewayType', 'type', 'vpn_type', 'sku', 'generation', 'activeActive', 'active_active', 'private_ip_address_enabled', 'bgp_enabled', 'bgp_settings', 'minimum_scale_unit', 'maximum_scale_unit', 'ip_configuration', 'vpn_client_configuration']),
  loadBalancer: new Set(['sku', 'sku_tier', 'edge_zone', 'frontendType', 'frontend_ip_configuration', 'backend_address_pool', 'probe', 'rule']),
  privateEndpoint: new Set(['subnet_id', 'edge_zone', 'custom_network_interface_name', 'private_service_connection', 'private_dns_zone_group', 'ip_configuration']),
}

function firstUnrenderedConfiguredKey(node: NetworkNode) {
  const rendered = RENDERED_KEYS[node.data.kind] ?? new Set<string>()
  const defaults = RESOURCE_SCHEMAS[node.data.kind].defaults as Record<string, unknown>
  for (const [key, value] of Object.entries(node.data)) {
    if (COMMON_RENDERED_KEYS.has(key) || rendered.has(key) || value === undefined) continue
    if (JSON.stringify(value) === JSON.stringify(defaults[key])) continue
    return key
  }
  return undefined
}

function configurationProblem(node: NetworkNode, nodes: NetworkNode[], edges: NetworkEdge[], format: ExportFormat) {
  if (node.data.imported) return 'Imported resources are diagram-only until explicitly adopted for management.'
  const capability = RESOURCE_SCHEMAS[node.data.kind].export
  // The caller selects one capability before asking for field-level checks.
  if (node.data.kind === 'vnet' && addressSpacesFor(node).length === 0) return 'Address space is required.'
  if (node.data.kind === 'subnet') {
    const parent = attachedParent(node, nodes, edges)
    if (!parent) return 'Parent virtual network is required (select one or attach exactly one VNet).'
    if (parent.data.imported) return 'Parent virtual network is imported and cannot be managed.'
    const prefixes = addressSpacesFor(node)
    if (!prefixes.length) return 'At least one canonical IPv4 address prefix is required.'
    const parsedPrefixes = prefixes.map(parseCidr)
    if (parsedPrefixes.some((prefix) => !prefix)) return 'Every subnet address prefix must be canonical IPv4 CIDR.'
    if (parsedPrefixes.some((prefix) => prefix!.prefix > 29)) return 'Azure subnet prefixes must be /29 or larger.'
    const contained = parsedPrefixes.every((subnet) => addressSpacesFor(parent).some((cidr) => {
      const range = parseCidr(cidr)
      return range && range.start <= subnet!.start && range.end >= subnet!.end
    }))
    if (!contained) return 'Every subnet prefix must be contained by its parent virtual network.'
    for (let index = 0; index < prefixes.length; index++) for (let other = index + 1; other < prefixes.length; other++) if (cidrsOverlap(prefixes[index], prefixes[other])) return 'Subnet prefixes overlap each other.'
    const overlapsSibling = nodes.some((candidate) => candidate.id !== node.id && candidate.data.kind === 'subnet' && attachedParent(candidate, nodes, edges)?.id === parent.id && addressSpacesFor(candidate).some((right) => prefixes.some((left) => cidrsOverlap(left, right))))
    if (overlapsSibling) return 'Subnet prefix overlaps another subnet in the same virtual network.'
  }
  if (node.data.kind === 'natGateway') {
    const timeout = Number(node.data.idle_timeout_in_minutes ?? node.data.idleTimeoutMinutes ?? 4)
    if (!Number.isInteger(timeout) || timeout < 4 || timeout > 120) return 'Idle timeout must be an integer from 4 through 120.'
  }
  if (node.data.kind === 'frontDoor' && !['Standard_AzureFrontDoor', 'Premium_AzureFrontDoor'].includes(scalar(node.data.sku_name ?? node.data.sku))) return 'A supported Front Door SKU is required.'
  if (node.data.kind === 'appGateway') {
    const sku = record(node.data.sku)
    if (!sku) return 'Structured SKU configuration is required.'
    if (!record(node.data.autoscale_configuration) && sku.capacity === undefined) return 'SKU capacity or autoscale configuration is required.'
    for (const key of ['gateway_ip_configuration', 'frontend_ip_configuration', 'frontend_port', 'backend_address_pool', 'backend_http_settings', 'http_listener', 'request_routing_rule'] as const) {
      if (!records(node.data[key]).length) return `At least one ${key} block is required for the modeled HTTP Application Gateway path.`
    }
    const frontends = new Set(records(node.data.frontend_ip_configuration).map((item) => String(item.name ?? '')))
    const ports = new Set(records(node.data.frontend_port).map((item) => String(item.name ?? '')))
    const pools = new Set(records(node.data.backend_address_pool).map((item) => String(item.name ?? '')))
    const settings = new Set(records(node.data.backend_http_settings).map((item) => String(item.name ?? '')))
    const listeners = new Set(records(node.data.http_listener).map((item) => String(item.name ?? '')))
    if (records(node.data.frontend_ip_configuration).some((item) => Boolean(item.subnet_id) === Boolean(item.public_ip_address_id))) return 'Every Application Gateway frontend requires exactly one private subnet or Public IP reference.'
    if (records(node.data.http_listener).some((item) => !frontends.has(String(item.frontend_ip_configuration_name ?? '')) || !ports.has(String(item.frontend_port_name ?? '')))) return 'Every Application Gateway listener must reference configured frontend IP and frontend port names.'
    if (records(node.data.request_routing_rule).some((item) => !listeners.has(String(item.http_listener_name ?? '')) || (item.backend_address_pool_name && !pools.has(String(item.backend_address_pool_name))) || (item.backend_http_settings_name && !settings.has(String(item.backend_http_settings_name))))) return 'Every Application Gateway routing rule must reference configured listener, backend pool, and backend settings names.'
    if (records(node.data.request_routing_rule).some((item) => item.rule_type === 'PathBasedRouting')) return 'PathBasedRouting requires a modeled URL path map and path rules; use Basic until those child dependencies are available.'
    if (records(node.data.http_listener).some((listener) => listener.protocol === 'Https')) return 'HTTPS listeners require modeled ssl_certificate and identity blocks; use HTTP or add those dependencies before export.'
    const waf = record(node.data.waf_configuration)
    if (waf && waf.rule_set_type !== 'OWASP') return 'Inline Application Gateway WAF configuration supports the OWASP rule set; Microsoft managed rule sets require a modeled WAF Policy.'
  }
  if (node.data.kind === 'firewall' && scalar(node.data.sku_name ?? node.data.sku, 'AZFW_VNet') === 'AZFW_VNet') {
    const configurations = effectiveFirewallConfigurations(node, nodes, edges)
    if (!configurations.length) return 'AZFW_VNet requires at least one IP configuration with its dedicated firewall subnet and Public IP.'
    const subnet = referencedNode(configurations[0].subnet_id, nodes)
    if (!subnet || subnet.data.kind !== 'subnet' || subnet.data.label !== 'AzureFirewallSubnet' || !attachedParent(subnet, nodes, edges)) return 'The primary Azure Firewall IP configuration requires the managed AzureFirewallSubnet and its parent VNet.'
    if (configurations.some((configuration) => !configuration.public_ip_address_id)) return 'Every Azure Firewall IP configuration requires a Public IP reference.'
  }
  if (format === 'azureCli' && node.data.kind === 'firewall' && scalar(node.data.sku_name ?? node.data.sku, 'AZFW_VNet') === 'AZFW_VNet') {
    for (const item of effectiveFirewallConfigurations(node, nodes, edges)) {
      const subnet = referencedNode(item.subnet_id, nodes)
      if (!subnet || subnet.data.kind !== 'subnet' || subnet.data.label !== 'AzureFirewallSubnet' || !attachedParent(subnet, nodes, edges)) return 'Azure CLI firewall export requires each VNet IP configuration to reference the managed AzureFirewallSubnet and its parent VNet.'
    }
    const management = record(node.data.management_ip_configuration)
    const managementSubnet = management ? referencedNode(management.subnet_id, nodes) : undefined
    if (management && (!managementSubnet || managementSubnet.data.kind !== 'subnet' || managementSubnet.data.label !== 'AzureFirewallManagementSubnet' || !attachedParent(managementSubnet, nodes, edges))) return 'Azure CLI firewall management configuration requires the managed AzureFirewallManagementSubnet and its parent VNet.'
  }
  if (node.data.kind === 'vpnGateway') {
    if (!records(node.data.ip_configuration).length) return 'At least one gateway IP configuration is required.'
    const client = record(node.data.vpn_client_configuration)
    if (client && Boolean(client.radius_server_address) !== Boolean(client.radius_secret_required)) return 'RADIUS server address and deployment-time secret must be configured together.'
    if (format === 'azureCli') {
      const configurations = records(node.data.ip_configuration)
      if (scalar(node.data.type ?? node.data.gatewayType, 'Vpn') !== 'Vpn') return 'Azure CLI gateway export currently supports VPN gateways only; ExpressRoute requires a separate command path.'
      if (configurations.length > 2 || configurations.some((item) => !item.public_ip_address_id)) return 'Azure CLI VPN Gateway export requires one or two IP configurations, each with an explicit Public IP.'
      if (configurations.some((item) => Boolean(item.name))) return 'Azure CLI vnet-gateway create does not preserve custom gateway IP configuration names; clear those names or use Terraform.'
      const subnets = configurations.map((item) => referencedNode(item.subnet_id, nodes))
      if (subnets.some((subnet) => !subnet || subnet.data.kind !== 'subnet' || subnet.data.label !== 'GatewaySubnet' || !attachedParent(subnet, nodes, edges))) return 'Azure CLI VPN Gateway export requires managed GatewaySubnet references with a parent VNet.'
      const active = Boolean(node.data.active_active ?? node.data.activeActive)
      if (active !== (configurations.length > 1)) return 'Azure CLI active-active mode requires multiple gateway IP/Public IP configurations; active-standby requires exactly one.'
      if (node.data.vpn_type === 'PolicyBased' && node.data.sku !== 'Basic') return 'Azure CLI PolicyBased VPN Gateway export is limited to the Basic SKU.'
      const authTypes = strings(client?.vpn_auth_types)
      if (authTypes.some((value) => value === 'AAD' || value === 'Certificate')) return 'Azure CLI AAD and Certificate point-to-site authentication require dependency fields not yet modeled; use Radius or Terraform after modeling those dependencies.'
    }
  }
  if (node.data.kind === 'loadBalancer') {
    for (const frontend of records(node.data.frontend_ip_configuration)) {
      if (Boolean(frontend.subnet_id) === Boolean(frontend.public_ip_address_id)) return 'Every Load Balancer frontend requires exactly one subnet or Public IP reference.'
      if (frontend.public_ip_address_id && frontend.private_ip_address) return 'A public Load Balancer frontend cannot also configure a private IP address.'
      if (frontend.private_ip_address_allocation === 'Static' && !frontend.private_ip_address) return 'A static Load Balancer frontend requires a private IP address.'
    }
    const frontends = new Set(records(node.data.frontend_ip_configuration).map((item) => String(item.name ?? '')))
    const pools = new Set(records(node.data.backend_address_pool).map((item) => String(item.name ?? '')))
    const probes = new Set(records(node.data.probe).map((item) => String(item.name ?? '')))
    if (records(node.data.rule).some((rule) => !frontends.has(String(rule.frontend_ip_configuration_name ?? '')))) return 'Every load-balancing rule must reference a configured frontend IP name.'
    if (records(node.data.rule).some((rule) => rule.backend_address_pool_name && !pools.has(String(rule.backend_address_pool_name)))) return 'Every configured Load Balancer backend pool reference must name a modeled backend address pool.'
    if (records(node.data.rule).some((rule) => rule.probe_name && !probes.has(String(rule.probe_name)))) return 'Every configured Load Balancer probe reference must name a modeled probe.'
    if (format === 'azureCli' && !frontends.size) return 'Azure CLI Load Balancer export requires at least one explicit frontend IP configuration to avoid creating an implicit Public IP.'
    if (format === 'azureCli' && records(node.data.rule).some((rule) => !rule.backend_address_pool_name)) return 'Azure CLI Load Balancer rules require an explicit modeled backend address pool instead of a compiler-invented pool.'
    if (format === 'azureCli' && scalar(node.data.sku_tier, 'Regional') === 'Global') return 'Azure CLI 2.88.0 has no Load Balancer SKU-tier create flag; Global tier remains Terraform-only.'
    if (format === 'azureCli' && records(node.data.rule).some((rule) => Number(rule.idle_timeout_in_minutes ?? 4) > 30)) return 'Azure CLI Load Balancer rule idle timeout must be between 4 and 30 minutes.'
  }
  if (node.data.kind === 'privateEndpoint') {
    if (!node.data.subnet_id) return 'Endpoint subnet is required.'
    const connection = record(node.data.private_service_connection)
    if (!connection) return 'Exactly one private service connection is required.'
    if (Boolean(connection.private_connection_resource_id) === Boolean(connection.private_connection_resource_alias)) return 'Private service connection requires exactly one target resource ID or alias.'
    if (format === 'azureCli' && connection.private_connection_resource_alias) return 'Azure CLI private-endpoint create requires a target resource ID; resource aliases are supported by Terraform but not this CLI compiler.'
    if (format === 'bicep' && connection.private_connection_resource_alias) return 'Bicep private endpoints require a target resource ID; the ARM schema has no private-link-service alias property.'
  }
  const unrenderedKey = firstUnrenderedConfiguredKey(node)
  if (unrenderedKey) return `Configured field ${unrenderedKey} is not rendered by the ${format} exporter yet.`
  void capability
  return undefined
}

export function getExportReport(nodes: NetworkNode[], edges: NetworkEdge[], format: ExportFormat): ExportReport {
  const report: ExportReport = { supported: [], unsupported: [] }
  const bicepGroups = new Set(nodes.map((node) => node.data.kind === 'subnet' ? attachedParent(node, nodes, edges)?.data.resourceGroup : node.data.resourceGroup).filter(Boolean))
  for (const node of nodes) {
    const capability = RESOURCE_SCHEMAS[node.data.kind].export[format]
    const reason = capability.status === 'unsupported' ? capability.summary : format === 'bicep' && bicepGroups.size > 1 ? 'Bicep export currently requires every managed resource to use one resource group.' : configurationProblem(node, nodes, edges, format)
    if (reason) report.unsupported.push({ node, reason, field: diagnosticPropertyField(reason) })
    else report.supported.push(node)
  }
  return report
}

function unsupportedHeader(report: ExportReport, prefix: string) {
  if (!report.unsupported.length) return ''
  return report.unsupported.map(({ node, reason }) => `${prefix} UNSUPPORTED RESOURCE: ${cleanComment(node.data.label)} (${node.data.kind}) — ${cleanComment(reason)}`).join('\n') + '\n\n'
}

export type GeneratedLineMapping = {
  nodeId: string
  field?: string
  startLine: number
  endLine: number
  kind: 'code' | 'diagnostic'
}
export type GeneratedInfrastructureResult = { text: string; mappings: GeneratedLineMapping[] }

export function generateInfrastructure(nodes: NetworkNode[], edges: NetworkEdge[], format: ExportFormat) {
  return generateText(nodes, edges, format)
}

export function generateInfrastructureResult(nodes: NetworkNode[], edges: NetworkEdge[], format: ExportFormat): GeneratedInfrastructureResult {
  const report = getExportReport(nodes, edges, format)
  const text = generateText(nodes, edges, format, report)
  return { text, mappings: lineMappings(text, report, format) }
}

function generateText(nodes: NetworkNode[], edges: NetworkEdge[], format: ExportFormat, report = getExportReport(nodes, edges, format)) {
  if (format === 'terraform') return terraform(nodes, edges, report)
  if (format === 'bicep') return bicep(nodes, edges, report)
  return azureCli(nodes, edges, report)
}

function mappedFields(node: NetworkNode) {
  const common = ['label', 'region', 'resourceGroup']
  if (node.data.kind === 'vnet') return [...common, 'addressSpace', 'addressSpaces']
  if (node.data.kind === 'subnet') return ['label', 'resourceGroup', 'parentVnetId', 'addressSpace', 'addressSpaces']
  if (node.data.kind === 'natGateway') return [...common, 'sku', 'sku_name', 'idleTimeoutMinutes', 'idle_timeout_in_minutes']
  if (node.data.kind === 'frontDoor') return ['label', 'resourceGroup', 'sku', 'sku_name']
  if (node.data.kind === 'publicIp') return [...common, 'allocation_method', 'sku', 'sku_tier', 'zones', 'ip_version', 'domain_name_label', 'reverse_fqdn', 'idle_timeout_in_minutes', 'edge_zone']
  if (node.data.kind === 'networkSecurityGroup') return [...common, 'security_rule']
  if (node.data.kind === 'routeTable') return [...common, 'disable_bgp_route_propagation', 'route']
  if (node.data.kind === 'appGateway') return [...common, ...RENDERED_KEYS.appGateway!]
  if (node.data.kind === 'firewall') return [...common, ...RENDERED_KEYS.firewall!]
  if (node.data.kind === 'vpnGateway') return [...common, ...RENDERED_KEYS.vpnGateway!]
  if (node.data.kind === 'loadBalancer') return [...common, ...RENDERED_KEYS.loadBalancer!]
  if (node.data.kind === 'privateEndpoint') return [...common, ...RENDERED_KEYS.privateEndpoint!]
  return common
}

function diagnosticFields(node: NetworkNode) {
  return [...new Set([
    ...Object.keys(node.data),
    ...RESOURCE_SCHEMAS[node.data.kind].fields.map((field) => String(field.key)),
  ].filter((field) => !['kind', 'imported'].includes(field)))]
}

function blockEnd(lines: string[], start: number) {
  let depth = 0
  for (let index = start; index < lines.length; index++) {
    depth += (lines[index].match(/\{/g) ?? []).length
    depth -= (lines[index].match(/\}/g) ?? []).length
    if (depth === 0 && index >= start) return index
  }
  return start
}

function fieldLine(lines: string[], start: number, end: number, field: string, format: ExportFormat) {
  const needles: Record<string, string[]> = format === 'terraform' ? {
    label: ['name '], region: ['location '], resourceGroup: ['resource_group_name'],
    addressSpace: ['address_space', 'address_prefixes'], addressSpaces: ['address_space', 'address_prefixes'],
    parentVnetId: ['virtual_network_name'], sku: ['sku_name', 'sku {', 'sku '], sku_name: ['sku_name'],
    idleTimeoutMinutes: ['idle_timeout_in_minutes'], idle_timeout_in_minutes: ['idle_timeout_in_minutes'], allocation_method: ['allocation_method'], sku_tier: ['sku_tier'], zones: ['zones'], ip_version: ['ip_version'], domain_name_label: ['domain_name_label'], reverse_fqdn: ['reverse_fqdn'], edge_zone: ['edge_zone'], security_rule: ['security_rule {'], disable_bgp_route_propagation: ['bgp_route_propagation_enabled'], route: ['route {'],
    autoscale_configuration: ['autoscale_configuration {'], http2_enabled: ['http2_enabled'], fips_enabled: ['fips_enabled'], gateway_ip_configuration: ['gateway_ip_configuration {'], frontend_ip_configuration: ['frontend_ip_configuration {'], frontend_port: ['frontend_port {'], backend_address_pool: ['backend_address_pool {'], backend_http_settings: ['backend_http_settings {'], http_listener: ['http_listener {'], request_routing_rule: ['request_routing_rule {'], waf_configuration: ['waf_configuration {'],
    tier: ['sku_tier'], threat_intel_mode: ['threat_intel_mode'], firewall_policy_id: ['firewall_policy_id'], dns_servers: ['dns_servers'], dns_proxy_enabled: ['dns_proxy_enabled'], private_ip_ranges: ['private_ip_ranges'], ip_configuration: ['ip_configuration {'], management_ip_configuration: ['management_ip_configuration {'], virtual_hub: ['virtual_hub {'],
    gatewayType: ['type '], type: ['type '], vpn_type: ['vpn_type'], generation: ['generation'], activeActive: ['active_active'], active_active: ['active_active'], private_ip_address_enabled: ['private_ip_address_enabled'], bgp_enabled: ['bgp_enabled'], bgp_settings: ['bgp_settings {'], minimum_scale_unit: ['minimum_scale_unit'], maximum_scale_unit: ['maximum_scale_unit'], vpn_client_configuration: ['vpn_client_configuration {'], frontendType: ['frontend_ip_configuration {'], probe: ['azurerm_lb_probe'], rule: ['azurerm_lb_rule'], subnet_id: ['subnet_id'], custom_network_interface_name: ['custom_network_interface_name'], private_service_connection: ['private_service_connection {'], private_dns_zone_group: ['private_dns_zone_group {'],
  } : {
    label: ['name:'], region: ['location:'], resourceGroup: ['scope:'],
    addressSpace: ['addressSpace:'], addressSpaces: ['addressSpace:'], parentVnetId: ['parent:'],
    sku: ['sku:'], sku_name: ['sku:'], idleTimeoutMinutes: ['idleTimeout'], idle_timeout_in_minutes: ['idleTimeout'], allocation_method: ['publicIPAllocationMethod:'], sku_tier: ['tier:'], zones: ['zones:'], ip_version: ['publicIPAddressVersion:'], domain_name_label: ['domainNameLabel:'], reverse_fqdn: ['reverseFqdn:'], edge_zone: ['extendedLocation:'], security_rule: ['securityRules:'], disable_bgp_route_propagation: ['disableBgpRoutePropagation:'], route: ['routes:'],
  }
  const candidates = needles[field] ?? []
  const offset = lines.slice(start, end + 1).findIndex((line) => candidates.some((needle) => line.includes(needle)))
  return offset < 0 ? undefined : start + offset
}

function cliCommandPrefix(node: NetworkNode) {
  if (node.data.kind === 'vnet') return 'az network vnet create '
  if (node.data.kind === 'subnet') return 'az network vnet subnet create '
  if (node.data.kind === 'natGateway') return 'az network nat gateway create '
  if (node.data.kind === 'frontDoor') return 'az afd profile create '
  if (node.data.kind === 'publicIp') return 'az network public-ip create '
  if (node.data.kind === 'networkSecurityGroup') return 'az network nsg create '
  if (node.data.kind === 'routeTable') return 'az network route-table create '
  if (node.data.kind === 'appGateway') return 'az rest '
  if (node.data.kind === 'firewall') return 'az network firewall create '
  if (node.data.kind === 'vpnGateway') return 'az network vnet-gateway create '
  if (node.data.kind === 'loadBalancer') return 'az network lb create '
  if (node.data.kind === 'privateEndpoint') return 'az network private-endpoint create '
  return ''
}

function lineMappings(text: string, report: ExportReport, format: ExportFormat): GeneratedLineMapping[] {
  const lines = text.split('\n')
  const mappings: GeneratedLineMapping[] = []
  for (const { node } of report.unsupported) {
    const index = lines.findIndex((line) => line.includes(`UNSUPPORTED RESOURCE: ${cleanComment(node.data.label)} (${node.data.kind})`))
    if (index < 0) continue
    const range = { nodeId: node.id, startLine: index + 1, endLine: index + 1, kind: 'diagnostic' as const }
    mappings.push(range)
    for (const field of diagnosticFields(node)) mappings.push({ ...range, field })
  }
  for (const node of report.supported) {
    if (format === 'azureCli') {
      const prefix = cliCommandPrefix(node)
      const identifier = node.data.kind === 'frontDoor' ? `--profile-name ${shell(node.data.label)}` : node.data.kind === 'appGateway' ? `/applicationGateways/${encodeURIComponent(node.data.label)}?` : `--name ${shell(node.data.label)}`
      const index = lines.findIndex((line) => prefix && line.startsWith(prefix) && line.includes(identifier))
      if (index < 0) continue
      const range = { nodeId: node.id, startLine: index + 1, endLine: index + 1, kind: 'code' as const }
      mappings.push(range)
      for (const field of mappedFields(node)) mappings.push({ ...range, field })
      continue
    }
    const key = resourceKey(node)
    const index = lines.findIndex((line) => format === 'terraform' ? line.startsWith('resource "') && line.includes(`"${key}" {`) : line.startsWith(`resource ${key} `))
    if (index < 0) continue
    let end = blockEnd(lines, index)
    if (format === 'terraform' && node.data.kind === 'loadBalancer') {
      const nextOtherResource = lines.findIndex((line, lineIndex) => lineIndex > end && line.startsWith('resource "') && !line.includes(`"${key}_`))
      end = nextOtherResource < 0 ? lines.length - 1 : nextOtherResource - 1
    }
    mappings.push({ nodeId: node.id, startLine: index + 1, endLine: end + 1, kind: 'code' })
    for (const field of mappedFields(node)) {
      const line = fieldLine(lines, index, end, field, format)
      if (line !== undefined) mappings.push({ nodeId: node.id, field, startLine: line + 1, endLine: line + 1, kind: 'code' })
    }
  }
  return mappings
}

function terraformApplicationGateway(node: NetworkNode, nodes: NetworkNode[]) {
  const sku = record(node.data.sku) ?? {}
  const autoscale = record(node.data.autoscale_configuration)
  const skuCapacity = !autoscale && sku.capacity !== undefined ? String(Number(sku.capacity)) : undefined
  const nested = [
    `  sku {\n${hclAssignments([['name', q(String(sku.name ?? 'WAF_v2'))], ['tier', q(String(sku.tier ?? sku.name ?? 'WAF_v2'))], ['capacity', skuCapacity]], 4)}\n  }`,
    autoscale ? `  autoscale_configuration {\n    min_capacity = ${Number(autoscale.min_capacity ?? 0)}${autoscale.max_capacity !== undefined ? `\n    max_capacity = ${Number(autoscale.max_capacity)}` : ''}\n  }` : '',
    ...records(node.data.gateway_ip_configuration).map((item) => `  gateway_ip_configuration {\n    name      = ${q(String(item.name ?? 'gateway-ip'))}\n    subnet_id = ${terraformId(item.subnet_id, nodes)}\n  }`),
    ...records(node.data.frontend_ip_configuration).map((item) => `  frontend_ip_configuration {\n    name                          = ${q(String(item.name ?? 'frontend'))}${item.subnet_id ? `\n    subnet_id                     = ${terraformId(item.subnet_id, nodes)}` : ''}${item.public_ip_address_id ? `\n    public_ip_address_id          = ${terraformId(item.public_ip_address_id, nodes)}` : ''}${item.private_ip_address_allocation ? `\n    private_ip_address_allocation = ${q(String(item.private_ip_address_allocation))}` : ''}${item.private_ip_address ? `\n    private_ip_address            = ${q(String(item.private_ip_address))}` : ''}\n  }`),
    ...records(node.data.frontend_port).map((item) => `  frontend_port {\n    name = ${q(String(item.name ?? 'frontend-port'))}\n    port = ${Number(item.port)}\n  }`),
    ...records(node.data.backend_address_pool).map((item) => `  backend_address_pool {\n${hclAssignments([['name', q(String(item.name ?? 'backend-pool'))], ['fqdns', strings(item.fqdns).length ? hclList(item.fqdns) : undefined], ['ip_addresses', strings(item.ip_addresses).length ? hclList(item.ip_addresses) : undefined]], 4)}\n  }`),
    ...records(node.data.backend_http_settings).map((item) => `  backend_http_settings {\n    name                  = ${q(String(item.name ?? 'backend-settings'))}\n    cookie_based_affinity = ${q(String(item.cookie_based_affinity ?? 'Disabled'))}\n    port                  = ${Number(item.port)}\n    protocol              = ${q(String(item.protocol ?? 'Http'))}${item.request_timeout !== undefined ? `\n    request_timeout       = ${Number(item.request_timeout)}` : ''}\n  }`),
    ...records(node.data.http_listener).map((item) => `  http_listener {\n    name                           = ${q(String(item.name ?? 'listener'))}\n    frontend_ip_configuration_name = ${q(String(item.frontend_ip_configuration_name ?? ''))}\n    frontend_port_name             = ${q(String(item.frontend_port_name ?? ''))}\n    protocol                       = ${q(String(item.protocol ?? 'Http'))}${item.ssl_certificate_name ? `\n    ssl_certificate_name           = ${q(String(item.ssl_certificate_name))}` : ''}\n  }`),
    ...records(node.data.request_routing_rule).map((item) => `  request_routing_rule {\n    name                       = ${q(String(item.name ?? 'routing-rule'))}\n    rule_type                  = ${q(String(item.rule_type ?? 'Basic'))}\n    http_listener_name         = ${q(String(item.http_listener_name ?? ''))}\n    priority                   = ${Number(item.priority)}${item.backend_address_pool_name ? `\n    backend_address_pool_name  = ${q(String(item.backend_address_pool_name))}` : ''}${item.backend_http_settings_name ? `\n    backend_http_settings_name = ${q(String(item.backend_http_settings_name))}` : ''}\n  }`),
  ]
  const waf = record(node.data.waf_configuration)
  if (waf) nested.push(`  waf_configuration {\n    enabled          = ${Boolean(waf.enabled)}\n    firewall_mode    = ${q(String(waf.firewall_mode ?? 'Detection'))}\n    rule_set_type    = ${q(String(waf.rule_set_type ?? 'OWASP'))}\n    rule_set_version = ${q(String(waf.rule_set_version ?? '3.2'))}\n  }`)
  return `resource "azurerm_application_gateway" "${resourceKey(node)}" {\n  name                = ${q(node.data.label)}\n  location            = ${q(node.data.region || 'eastus')}\n  resource_group_name = ${q(node.data.resourceGroup || 'rg-network')}\n  http2_enabled       = ${Boolean(node.data.http2_enabled)}\n  fips_enabled        = ${Boolean(node.data.fips_enabled)}${strings(node.data.zones).length ? `\n  zones               = ${hclList(node.data.zones)}` : ''}\n${nested.filter(Boolean).join('\n')}\n}`
}

function terraformFirewall(node: NetworkNode, nodes: NetworkNode[], edges: NetworkEdge[]) {
  const nested = effectiveFirewallConfigurations(node, nodes, edges).map((item) => `  ip_configuration {\n    name                 = ${q(String(item.name ?? 'configuration'))}${item.subnet_id ? `\n    subnet_id            = ${terraformId(item.subnet_id, nodes)}` : ''}${item.public_ip_address_id ? `\n    public_ip_address_id = ${terraformId(item.public_ip_address_id, nodes)}` : ''}\n  }`)
  const management = record(node.data.management_ip_configuration)
  if (management) nested.push(`  management_ip_configuration {\n    name                 = ${q(String(management.name ?? 'management'))}\n    subnet_id            = ${terraformId(management.subnet_id, nodes)}\n    public_ip_address_id = ${terraformId(management.public_ip_address_id, nodes)}\n  }`)
  const hub = record(node.data.virtual_hub)
  if (hub) nested.push(`  virtual_hub {\n    virtual_hub_id  = ${terraformId(hub.virtual_hub_id, nodes)}${hub.public_ip_count !== undefined ? `\n    public_ip_count = ${Number(hub.public_ip_count)}` : ''}\n  }`)
  return `resource "azurerm_firewall" "${resourceKey(node)}" {\n  name                = ${q(node.data.label)}\n  location            = ${q(node.data.region || 'eastus')}\n  resource_group_name = ${q(node.data.resourceGroup || 'rg-network')}\n  sku_name            = ${q(scalar(node.data.sku_name ?? node.data.sku, 'AZFW_VNet'))}\n  sku_tier            = ${q(scalar(node.data.sku_tier ?? node.data.tier, 'Standard'))}\n  threat_intel_mode   = ${q(scalar(node.data.threat_intel_mode, 'Alert'))}${node.data.firewall_policy_id ? `\n  firewall_policy_id  = ${terraformId(node.data.firewall_policy_id, nodes)}` : ''}${strings(node.data.dns_servers).length ? `\n  dns_servers         = ${hclList(node.data.dns_servers)}` : ''}${node.data.dns_proxy_enabled !== undefined ? `\n  dns_proxy_enabled   = ${Boolean(node.data.dns_proxy_enabled)}` : ''}${strings(node.data.private_ip_ranges).length ? `\n  private_ip_ranges   = ${hclList(node.data.private_ip_ranges)}` : ''}${strings(node.data.zones).length ? `\n  zones               = ${hclList(node.data.zones)}` : ''}\n${nested.join('\n')}\n}`
}

function terraformVpnGateway(node: NetworkNode, nodes: NetworkNode[]) {
  const key = resourceKey(node)
  const nested = records(node.data.ip_configuration).map((item) => `  ip_configuration {\n    name                          = ${q(String(item.name ?? 'vnetGatewayConfig'))}\n    private_ip_address_allocation = ${q(String(item.private_ip_address_allocation ?? 'Dynamic'))}\n    subnet_id                     = ${terraformId(item.subnet_id, nodes)}${item.public_ip_address_id ? `\n    public_ip_address_id          = ${terraformId(item.public_ip_address_id, nodes)}` : ''}\n  }`)
  const bgp = record(node.data.bgp_settings)
  if (bgp) nested.push(`  bgp_settings {${bgp.asn !== undefined ? `\n    asn         = ${Number(bgp.asn)}` : ''}${bgp.peer_weight !== undefined ? `\n    peer_weight = ${Number(bgp.peer_weight)}` : ''}\n  }`)
  const client = record(node.data.vpn_client_configuration)
  if (client) nested.push(`  vpn_client_configuration {\n${hclAssignments([
    ['address_space', hclList(client.address_space)],
    ['vpn_client_protocols', strings(client.vpn_client_protocols).length ? hclList(client.vpn_client_protocols) : undefined],
    ['vpn_auth_types', strings(client.vpn_auth_types).length ? hclList(client.vpn_auth_types) : undefined],
    ['radius_server_address', client.radius_server_address ? q(String(client.radius_server_address)) : undefined],
    ['radius_server_secret', client.radius_secret_required ? `var.${key}_radius_server_secret` : undefined],
  ], 4)}\n  }`)
  const top = hclAssignments([
    ['name', q(node.data.label)], ['location', q(node.data.region || 'eastus')], ['resource_group_name', q(node.data.resourceGroup || 'rg-network')],
    ['type', q(scalar(node.data.type ?? node.data.gatewayType, 'Vpn'))], ['vpn_type', q(scalar(node.data.vpn_type, 'RouteBased'))], ['sku', q(scalar(node.data.sku, 'VpnGw1'))],
    ['active_active', String(Boolean(node.data.active_active ?? node.data.activeActive))], ['bgp_enabled', String(Boolean(node.data.bgp_enabled))],
    ['generation', node.data.generation ? q(String(node.data.generation)) : undefined],
    ['private_ip_address_enabled', node.data.private_ip_address_enabled !== undefined ? String(Boolean(node.data.private_ip_address_enabled)) : undefined],
    ['minimum_scale_unit', node.data.minimum_scale_unit !== undefined ? String(Number(node.data.minimum_scale_unit)) : undefined],
    ['maximum_scale_unit', node.data.maximum_scale_unit !== undefined ? String(Number(node.data.maximum_scale_unit)) : undefined],
  ])
  const secretVariable = client?.radius_secret_required ? `variable "${key}_radius_server_secret" {\n  description = "RADIUS shared secret for ${cleanComment(node.data.label)}"\n  type        = string\n  sensitive   = true\n}\n\n` : ''
  return `${secretVariable}resource "azurerm_virtual_network_gateway" "${key}" {\n${top}\n${nested.join('\n')}\n}`
}

function terraformLoadBalancer(node: NetworkNode, nodes: NetworkNode[]) {
  const frontends = records(node.data.frontend_ip_configuration).map((item) => `  frontend_ip_configuration {\n    name                          = ${q(String(item.name ?? 'frontend'))}${item.subnet_id ? `\n    subnet_id                     = ${terraformId(item.subnet_id, nodes)}` : ''}${item.public_ip_address_id ? `\n    public_ip_address_id          = ${terraformId(item.public_ip_address_id, nodes)}` : ''}${item.private_ip_address_allocation ? `\n    private_ip_address_allocation = ${q(String(item.private_ip_address_allocation))}` : ''}${item.private_ip_address ? `\n    private_ip_address            = ${q(String(item.private_ip_address))}` : ''}${item.private_ip_address_version ? `\n    private_ip_address_version    = ${q(String(item.private_ip_address_version))}` : ''}${strings(item.zones).length ? `\n    zones                         = ${hclList(item.zones)}` : ''}\n  }`)
  const key = resourceKey(node)
  const children = [
    ...records(node.data.backend_address_pool).map((item) => `resource "azurerm_lb_backend_address_pool" "${safe(`${key}_${String(item.name ?? 'backend')}`)}" {\n  name            = ${q(String(item.name ?? 'backend'))}\n  loadbalancer_id = azurerm_lb.${key}.id\n}`),
    ...records(node.data.probe).map((item) => `resource "azurerm_lb_probe" "${safe(`${key}_${String(item.name ?? 'probe')}`)}" {\n  name                = ${q(String(item.name ?? 'probe'))}\n  loadbalancer_id     = azurerm_lb.${key}.id\n  port                = ${Number(item.port)}\n  protocol            = ${q(String(item.protocol ?? 'Tcp'))}${item.request_path ? `\n  request_path        = ${q(String(item.request_path))}` : ''}${item.interval_in_seconds !== undefined ? `\n  interval_in_seconds = ${Number(item.interval_in_seconds)}` : ''}${item.probe_threshold !== undefined ? `\n  probe_threshold     = ${Number(item.probe_threshold)}` : ''}\n}`),
    ...records(node.data.rule).map((item) => `resource "azurerm_lb_rule" "${safe(`${key}_${String(item.name ?? 'rule')}`)}" {\n  name                           = ${q(String(item.name ?? 'rule'))}\n  loadbalancer_id                = azurerm_lb.${key}.id\n  frontend_ip_configuration_name = ${q(String(item.frontend_ip_configuration_name ?? ''))}\n  protocol                       = ${q(String(item.protocol ?? 'Tcp'))}\n  frontend_port                  = ${Number(item.frontend_port)}\n  backend_port                   = ${Number(item.backend_port)}${item.backend_address_pool_name ? `\n  backend_address_pool_ids       = [azurerm_lb_backend_address_pool.${safe(`${key}_${String(item.backend_address_pool_name)}`)}.id]` : ''}${item.probe_name ? `\n  probe_id                       = azurerm_lb_probe.${safe(`${key}_${String(item.probe_name)}`)}.id` : ''}${item.idle_timeout_in_minutes !== undefined ? `\n  idle_timeout_in_minutes        = ${Number(item.idle_timeout_in_minutes)}` : ''}\n}`),
  ]
  return [`resource "azurerm_lb" "${key}" {\n  name                = ${q(node.data.label)}\n  location            = ${q(node.data.region || 'eastus')}\n  resource_group_name = ${q(node.data.resourceGroup || 'rg-network')}\n  sku                 = ${q(scalar(node.data.sku, 'Standard'))}\n  sku_tier            = ${q(scalar(node.data.sku_tier, 'Regional'))}${node.data.edge_zone ? `\n  edge_zone           = ${q(String(node.data.edge_zone))}` : ''}\n${frontends.join('\n')}\n}`, ...children].join('\n\n')
}

function terraformPrivateEndpoint(node: NetworkNode, nodes: NetworkNode[]) {
  const connection = record(node.data.private_service_connection) ?? {}
  const dns = record(node.data.private_dns_zone_group)
  const nested = [`  private_service_connection {\n${hclAssignments([
    ['name', q(String(connection.name ?? 'connection'))],
    ['is_manual_connection', String(Boolean(connection.is_manual_connection))],
    ['private_connection_resource_id', connection.private_connection_resource_id ? terraformId(connection.private_connection_resource_id, nodes) : undefined],
    ['private_connection_resource_alias', connection.private_connection_resource_alias ? q(String(connection.private_connection_resource_alias)) : undefined],
    ['subresource_names', strings(connection.subresource_names).length ? hclList(connection.subresource_names) : undefined],
    ['request_message', connection.request_message ? q(String(connection.request_message)) : undefined],
  ], 4)}\n  }`]
  if (dns) nested.push(`  private_dns_zone_group {\n    name                 = ${q(String(dns.name ?? 'default'))}\n    private_dns_zone_ids = ${hclRefs(dns.private_dns_zone_ids, nodes)}\n  }`)
  nested.push(...records(node.data.ip_configuration).map((item) => `  ip_configuration {\n    name               = ${q(String(item.name ?? 'configuration'))}\n    private_ip_address = ${q(String(item.private_ip_address ?? ''))}${item.subresource_name ? `\n    subresource_name   = ${q(String(item.subresource_name))}` : ''}${item.member_name ? `\n    member_name        = ${q(String(item.member_name))}` : ''}\n  }`))
  return `resource "azurerm_private_endpoint" "${resourceKey(node)}" {\n  name                          = ${q(node.data.label)}\n  location                      = ${q(node.data.region || 'eastus')}\n  resource_group_name           = ${q(node.data.resourceGroup || 'rg-network')}\n  subnet_id                     = ${terraformId(node.data.subnet_id, nodes)}${node.data.edge_zone ? `\n  edge_zone                     = ${q(String(node.data.edge_zone))}` : ''}${node.data.custom_network_interface_name ? `\n  custom_network_interface_name = ${q(String(node.data.custom_network_interface_name))}` : ''}\n${nested.join('\n')}\n}`
}

function terraform(nodes: NetworkNode[], edges: NetworkEdge[], report: ExportReport) {
  const allowed = new Set(report.supported.map((node) => node.id))
  const blocks: string[] = []
  for (const node of report.supported) {
    const common = `\n  name                = ${q(node.data.label)}\n  location            = ${q(node.data.region || 'eastus')}\n  resource_group_name = ${q(node.data.resourceGroup || 'rg-network')}`
    if (node.data.kind === 'vnet') blocks.push(`resource "azurerm_virtual_network" "${resourceKey(node)}" {${common}\n  address_space       = ${hclList(addressSpacesFor(node))}\n}`)
    if (node.data.kind === 'subnet') {
      const parent = attachedParent(node, nodes, edges)!
      blocks.push(`resource "azurerm_subnet" "${resourceKey(node)}" {\n  name                 = ${q(node.data.label)}\n  resource_group_name  = azurerm_virtual_network.${resourceKey(parent)}.resource_group_name\n  virtual_network_name = azurerm_virtual_network.${resourceKey(parent)}.name\n  address_prefixes     = ${hclList(addressSpacesFor(node))}\n}`)
    }
    if (node.data.kind === 'natGateway') blocks.push(`resource "azurerm_nat_gateway" "${resourceKey(node)}" {\n  name                    = ${q(node.data.label)}\n  location                = ${q(node.data.region || 'eastus')}\n  resource_group_name     = ${q(node.data.resourceGroup || 'rg-network')}\n  sku_name                = ${q(scalar(node.data.sku_name ?? node.data.sku, 'Standard'))}\n  idle_timeout_in_minutes = ${Number(node.data.idle_timeout_in_minutes ?? node.data.idleTimeoutMinutes ?? 4)}${strings(node.data.zones).length ? `\n  zones                   = ${hclList(node.data.zones)}` : ''}\n}`)
    if (node.data.kind === 'frontDoor') blocks.push(`resource "azurerm_cdn_frontdoor_profile" "${resourceKey(node)}" {\n  name                     = ${q(node.data.label)}\n  resource_group_name      = ${q(node.data.resourceGroup || 'rg-network')}\n  sku_name                 = ${q(scalar(node.data.sku_name ?? node.data.sku, 'Standard_AzureFrontDoor'))}\n  response_timeout_seconds = ${Number(node.data.response_timeout_seconds ?? 120)}\n}`)
    if (node.data.kind === 'publicIp') {
      const optional = [
        strings(node.data.zones).length ? `  zones                   = ${hclList(node.data.zones)}` : '',
        node.data.domain_name_label ? `  domain_name_label       = ${q(String(node.data.domain_name_label))}` : '',
        node.data.reverse_fqdn ? `  reverse_fqdn            = ${q(String(node.data.reverse_fqdn))}` : '',
        node.data.edge_zone ? `  edge_zone               = ${q(String(node.data.edge_zone))}` : '',
      ].filter(Boolean).join('\n')
      blocks.push(`resource "azurerm_public_ip" "${resourceKey(node)}" {\n  name                    = ${q(node.data.label)}\n  location                = ${q(node.data.region || 'eastus')}\n  resource_group_name     = ${q(node.data.resourceGroup || 'rg-network')}\n  allocation_method       = ${q(scalar(node.data.allocation_method, 'Static'))}\n  sku                     = ${q(scalar(node.data.sku, 'Standard'))}\n  sku_tier                = ${q(scalar(node.data.sku_tier, 'Regional'))}\n  ip_version              = ${q(scalar(node.data.ip_version, 'IPv4'))}\n  idle_timeout_in_minutes = ${Number(node.data.idle_timeout_in_minutes ?? 4)}${optional ? `\n${optional}` : ''}\n}`)
    }
    if (node.data.kind === 'networkSecurityGroup') {
      const rules = records(node.data.security_rule).map((rule) => `  security_rule {\n    name                         = ${q(String(rule.name ?? ''))}\n    priority                     = ${Number(rule.priority)}\n    direction                    = ${q(String(rule.direction ?? 'Inbound'))}\n    access                       = ${q(String(rule.access ?? 'Allow'))}\n    protocol                     = ${q(String(rule.protocol ?? '*'))}\n    source_port_ranges           = ${hclList(rule.source_port_ranges)}\n    destination_port_ranges      = ${hclList(rule.destination_port_ranges)}\n    source_address_prefixes      = ${hclList(rule.source_address_prefixes)}\n    destination_address_prefixes = ${hclList(rule.destination_address_prefixes)}\n  }`).join('\n')
      blocks.push(`resource "azurerm_network_security_group" "${resourceKey(node)}" {${common}${rules ? `\n${rules}` : ''}\n}`)
    }
    if (node.data.kind === 'routeTable') {
      const routes = records(node.data.route).map((route) => `  route {\n    name                   = ${q(String(route.name ?? ''))}\n    address_prefix         = ${q(String(route.address_prefix ?? ''))}\n    next_hop_type          = ${q(String(route.next_hop_type ?? 'None'))}${route.next_hop_type === 'VirtualAppliance' ? `\n    next_hop_in_ip_address = ${q(String(route.next_hop_in_ip_address ?? ''))}` : ''}\n  }`).join('\n')
      blocks.push(`resource "azurerm_route_table" "${resourceKey(node)}" {\n  name                          = ${q(node.data.label)}\n  location                      = ${q(node.data.region || 'eastus')}\n  resource_group_name           = ${q(node.data.resourceGroup || 'rg-network')}\n  bgp_route_propagation_enabled = ${!node.data.disable_bgp_route_propagation}${routes ? `\n${routes}` : ''}\n}`)
    }
    if (node.data.kind === 'appGateway') blocks.push(terraformApplicationGateway(node, nodes))
    if (node.data.kind === 'firewall') blocks.push(terraformFirewall(node, nodes, edges))
    if (node.data.kind === 'vpnGateway') blocks.push(terraformVpnGateway(node, nodes))
    if (node.data.kind === 'loadBalancer') blocks.push(terraformLoadBalancer(node, nodes))
    if (node.data.kind === 'privateEndpoint') blocks.push(terraformPrivateEndpoint(node, nodes))
  }
  for (const edge of peerings(edges)) {
    const a = nodes.find((node) => node.id === edge.source); const b = nodes.find((node) => node.id === edge.target)
    if (!a || !b || !allowed.has(a.id) || !allowed.has(b.id) || a.data.kind !== 'vnet' || b.data.kind !== 'vnet') continue
    const an = resourceKey(a); const bn = resourceKey(b)
    blocks.push(`resource "azurerm_virtual_network_peering" "${an}_to_${bn}" {\n  name                      = ${q(`${a.data.label}-to-${b.data.label}`)}\n  resource_group_name       = azurerm_virtual_network.${an}.resource_group_name\n  virtual_network_name      = azurerm_virtual_network.${an}.name\n  remote_virtual_network_id = azurerm_virtual_network.${bn}.id\n}\n\nresource "azurerm_virtual_network_peering" "${bn}_to_${an}" {\n  name                      = ${q(`${b.data.label}-to-${a.data.label}`)}\n  resource_group_name       = azurerm_virtual_network.${bn}.resource_group_name\n  virtual_network_name      = azurerm_virtual_network.${bn}.name\n  remote_virtual_network_id = azurerm_virtual_network.${an}.id\n}`)
  }
  for (const edge of associationEdges(edges)) {
    if (!allowed.has(edge.source) || !allowed.has(edge.target)) continue
    const association = edge.data?.kind === 'subnetNetworkSecurityGroup' ? ends(edge, nodes, 'subnet', 'networkSecurityGroup')
      : edge.data?.kind === 'subnetRouteTable' ? ends(edge, nodes, 'subnet', 'routeTable')
      : edge.data?.kind === 'subnetNatGateway' ? ends(edge, nodes, 'subnet', 'natGateway')
      : edge.data?.kind === 'natGatewayPublicIp' ? ends(edge, nodes, 'natGateway', 'publicIp') : undefined
    if (!association) continue
    const [left, right] = association; const name = `${resourceKey(left)}_${resourceKey(right)}`
    if (edge.data?.kind === 'subnetNetworkSecurityGroup') blocks.push(`resource "azurerm_subnet_network_security_group_association" "${name}" {\n  subnet_id                 = azurerm_subnet.${resourceKey(left)}.id\n  network_security_group_id = azurerm_network_security_group.${resourceKey(right)}.id\n}`)
    if (edge.data?.kind === 'subnetRouteTable') blocks.push(`resource "azurerm_subnet_route_table_association" "${name}" {\n  subnet_id      = azurerm_subnet.${resourceKey(left)}.id\n  route_table_id = azurerm_route_table.${resourceKey(right)}.id\n}`)
    if (edge.data?.kind === 'subnetNatGateway') blocks.push(`resource "azurerm_subnet_nat_gateway_association" "${name}" {\n  subnet_id      = azurerm_subnet.${resourceKey(left)}.id\n  nat_gateway_id = azurerm_nat_gateway.${resourceKey(right)}.id\n}`)
    if (edge.data?.kind === 'natGatewayPublicIp') blocks.push(`resource "azurerm_nat_gateway_public_ip_association" "${name}" {\n  nat_gateway_id       = azurerm_nat_gateway.${resourceKey(left)}.id\n  public_ip_address_id = azurerm_public_ip.${resourceKey(right)}.id\n}`)
  }
  return `${unsupportedHeader(report, '#')}terraform {\n  required_providers { azurerm = { source = "hashicorp/azurerm", version = "4.81.0" } }\n}\n\nprovider "azurerm" {\n  features {}\n  subscription_id = var.subscription_id\n}\n\nvariable "subscription_id" {\n  description = "Target Azure subscription ID"\n  type        = string\n${subscriptionFor(nodes) ? `  default     = ${q(subscriptionFor(nodes))}\n` : ''}}\n\n${blocks.join('\n\n')}\n`
}

function bicepId(value: unknown, nodes: NetworkNode[]) {
  const target = referencedNode(value, nodes)
  return target ? `${resourceKey(target)}.id` : bq(String(value ?? ''))
}

function bicepAppGateway(node: NetworkNode, nodes: NetworkNode[]) {
  const key = resourceKey(node); const sku = record(node.data.sku)!; const autoscale = record(node.data.autoscale_configuration); const waf = record(node.data.waf_configuration)
  const childId = (type: string, name: unknown) => `resourceId('Microsoft.Network/applicationGateways/${type}', ${bq(node.data.label)}, ${bq(String(name ?? ''))})`
  const gateways = records(node.data.gateway_ip_configuration).map((item) => `      {\n        name: ${bq(String(item.name))}\n        properties: { subnet: { id: ${bicepId(item.subnet_id, nodes)} } }\n      }`).join('\n')
  const frontends = records(node.data.frontend_ip_configuration).map((item) => `      {\n        name: ${bq(String(item.name))}\n        properties: {${item.subnet_id ? `\n          subnet: { id: ${bicepId(item.subnet_id, nodes)} }` : ''}${item.public_ip_address_id ? `\n          publicIPAddress: { id: ${bicepId(item.public_ip_address_id, nodes)} }` : ''}${item.private_ip_address_allocation ? `\n          privateIPAllocationMethod: ${bq(String(item.private_ip_address_allocation))}` : ''}${item.private_ip_address ? `\n          privateIPAddress: ${bq(String(item.private_ip_address))}` : ''}\n        }\n      }`).join('\n')
  const ports = records(node.data.frontend_port).map((item) => `      { name: ${bq(String(item.name))}, properties: { port: ${Number(item.port)} } }`).join('\n')
  const pools = records(node.data.backend_address_pool).map((item) => `      {\n        name: ${bq(String(item.name))}\n        properties: { backendAddresses: [${[...strings(item.fqdns).map((value) => `{ fqdn: ${bq(value)} }`), ...strings(item.ip_addresses).map((value) => `{ ipAddress: ${bq(value)} }`)].join(', ')}] }\n      }`).join('\n')
  const settings = records(node.data.backend_http_settings).map((item) => `      {\n        name: ${bq(String(item.name))}\n        properties: { cookieBasedAffinity: ${bq(String(item.cookie_based_affinity))}, port: ${Number(item.port)}, protocol: ${bq(String(item.protocol))}, requestTimeout: ${Number(item.request_timeout ?? 20)} }\n      }`).join('\n')
  const listeners = records(node.data.http_listener).map((item) => `      {\n        name: ${bq(String(item.name))}\n        properties: { frontendIPConfiguration: { id: ${childId('frontendIPConfigurations', item.frontend_ip_configuration_name)} }, frontendPort: { id: ${childId('frontendPorts', item.frontend_port_name)} }, protocol: ${bq(String(item.protocol))} }\n      }`).join('\n')
  const rules = records(node.data.request_routing_rule).map((item) => `      {\n        name: ${bq(String(item.name))}\n        properties: { ruleType: ${bq(String(item.rule_type))}, priority: ${Number(item.priority)}, httpListener: { id: ${childId('httpListeners', item.http_listener_name)} }${item.backend_address_pool_name ? `, backendAddressPool: { id: ${childId('backendAddressPools', item.backend_address_pool_name)} }` : ''}${item.backend_http_settings_name ? `, backendHttpSettings: { id: ${childId('backendHttpSettingsCollection', item.backend_http_settings_name)} }` : ''} }\n      }`).join('\n')
  return `resource ${key} 'Microsoft.Network/applicationGateways@2024-05-01' = {\n  name: ${bq(node.data.label)}\n  location: ${bq(node.data.region || 'eastus')}${strings(node.data.zones).length ? `\n  zones: [${strings(node.data.zones).map(bq).join(', ')}]` : ''}\n  properties: {\n    sku: { name: ${bq(String(sku.name))}, tier: ${bq(String(sku.tier))}${autoscale ? '' : `, capacity: ${Number(sku.capacity)}`} }\n    enableHttp2: ${Boolean(node.data.http2_enabled)}\n    enableFips: ${Boolean(node.data.fips_enabled)}${autoscale ? `\n    autoscaleConfiguration: { minCapacity: ${Number(autoscale.min_capacity)}, maxCapacity: ${Number(autoscale.max_capacity)} }` : ''}\n    gatewayIPConfigurations: [\n${gateways}\n    ]\n    frontendIPConfigurations: [\n${frontends}\n    ]\n    frontendPorts: [\n${ports}\n    ]\n    backendAddressPools: [\n${pools}\n    ]\n    backendHttpSettingsCollection: [\n${settings}\n    ]\n    httpListeners: [\n${listeners}\n    ]\n    requestRoutingRules: [\n${rules}\n    ]${waf ? `\n    webApplicationFirewallConfiguration: { enabled: ${Boolean(waf.enabled)}, firewallMode: ${bq(String(waf.firewall_mode))}, ruleSetType: ${bq(String(waf.rule_set_type))}, ruleSetVersion: ${bq(String(waf.rule_set_version))} }` : ''}\n  }\n}`
}

function bicepFirewall(node: NetworkNode, nodes: NetworkNode[], edges: NetworkEdge[]) {
  const key = resourceKey(node); const management = record(node.data.management_ip_configuration); const hub = record(node.data.virtual_hub)
  const ips = effectiveFirewallConfigurations(node, nodes, edges).map((item) => `      {\n        name: ${bq(String(item.name))}\n        properties: {${item.subnet_id ? `\n          subnet: { id: ${bicepId(item.subnet_id, nodes)} }` : ''}${item.public_ip_address_id ? `\n          publicIPAddress: { id: ${bicepId(item.public_ip_address_id, nodes)} }` : ''}\n        }\n      }`).join('\n')
  const additional = [
    strings(node.data.dns_servers).length ? `      'Network.DNS.Servers': ${bq(strings(node.data.dns_servers).join(','))}` : '',
    node.data.dns_proxy_enabled !== undefined ? `      'Network.DNS.EnableProxy': ${bq(String(Boolean(node.data.dns_proxy_enabled)))}` : '',
    strings(node.data.private_ip_ranges).length ? `      'Network.SNAT.PrivateRanges': ${bq(strings(node.data.private_ip_ranges).join(','))}` : '',
  ].filter(Boolean).join('\n')
  return `resource ${key} 'Microsoft.Network/azureFirewalls@2024-05-01' = {\n  name: ${bq(node.data.label)}\n  location: ${bq(node.data.region || 'eastus')}${strings(node.data.zones).length ? `\n  zones: [${strings(node.data.zones).map(bq).join(', ')}]` : ''}\n  properties: {\n    sku: { name: ${bq(scalar(node.data.sku_name ?? node.data.sku, 'AZFW_VNet'))}, tier: ${bq(scalar(node.data.sku_tier ?? node.data.tier, 'Standard'))} }\n    threatIntelMode: ${bq(scalar(node.data.threat_intel_mode, 'Alert'))}${node.data.firewall_policy_id ? `\n    firewallPolicy: { id: ${bicepId(node.data.firewall_policy_id, nodes)} }` : ''}${additional ? `\n    additionalProperties: {\n${additional}\n    }` : ''}${ips ? `\n    ipConfigurations: [\n${ips}\n    ]` : ''}${management ? `\n    managementIpConfiguration: { name: ${bq(String(management.name))}, properties: { subnet: { id: ${bicepId(management.subnet_id, nodes)} }, publicIPAddress: { id: ${bicepId(management.public_ip_address_id, nodes)} } } }` : ''}${hub ? `\n    virtualHub: { id: ${bicepId(hub.virtual_hub_id, nodes)} }\n    hubIPAddresses: { publicIPs: { count: ${Number(hub.public_ip_count ?? 1)} } }` : ''}\n  }\n}`
}

function bicepVpnGateway(node: NetworkNode, nodes: NetworkNode[], secureParameters: string[]) {
  const key = resourceKey(node); const bgp = record(node.data.bgp_settings); const client = record(node.data.vpn_client_configuration)
  const gatewayType = scalar(node.data.type ?? node.data.gatewayType, 'Vpn')
  const ips = records(node.data.ip_configuration).map((item, index) => `      {\n        name: ${bq(String(item.name ?? `vnetGatewayConfig${index || ''}`))}\n        properties: {\n          privateIPAllocationMethod: ${bq(String(item.private_ip_address_allocation ?? 'Dynamic'))}\n          subnet: { id: ${bicepId(item.subnet_id, nodes)} }${item.public_ip_address_id ? `\n          publicIPAddress: { id: ${bicepId(item.public_ip_address_id, nodes)} }` : ''}${item.private_ip_address ? `\n          privateIPAddress: ${bq(String(item.private_ip_address))}` : ''}\n        }\n      }`).join('\n')
  let radiusSecret = ''
  if (client?.radius_secret_required) { const parameter = safe(`${key}_radius_server_secret`); secureParameters.push(`@secure()\nparam ${parameter} string`); radiusSecret = `\n      radiusServerSecret: ${parameter}` }
  const scale = node.data.minimum_scale_unit !== undefined || node.data.maximum_scale_unit !== undefined ? `\n    autoScaleConfiguration: { bounds: { min: ${Number(node.data.minimum_scale_unit ?? 1)}, max: ${Number(node.data.maximum_scale_unit ?? node.data.minimum_scale_unit ?? 1)} } }` : ''
  return `resource ${key} 'Microsoft.Network/virtualNetworkGateways@2024-05-01' = {\n  name: ${bq(node.data.label)}\n  location: ${bq(node.data.region || 'eastus')}\n  properties: {\n    gatewayType: ${bq(gatewayType)}${gatewayType === 'Vpn' ? `\n    vpnType: ${bq(scalar(node.data.vpn_type, 'RouteBased'))}` : ''}\n    activeActive: ${Boolean(node.data.active_active ?? node.data.activeActive)}\n    enableBgp: ${Boolean(node.data.bgp_enabled)}\n    enablePrivateIpAddress: ${Boolean(node.data.private_ip_address_enabled)}${node.data.generation && node.data.generation !== 'None' ? `\n    vpnGatewayGeneration: ${bq(String(node.data.generation))}` : ''}\n    sku: { name: ${bq(scalar(node.data.sku, 'VpnGw1'))}, tier: ${bq(scalar(node.data.sku, 'VpnGw1'))} }${scale}\n    ipConfigurations: [\n${ips}\n    ]${bgp ? `\n    bgpSettings: { asn: ${Number(bgp.asn)}, peerWeight: ${Number(bgp.peer_weight ?? 0)} }` : ''}${client ? `\n    vpnClientConfiguration: {\n      vpnClientAddressPool: { addressPrefixes: [${strings(client.address_space).map(bq).join(', ')}] }\n      vpnClientProtocols: [${strings(client.vpn_client_protocols).map(bq).join(', ')}]\n      vpnAuthenticationTypes: [${strings(client.vpn_auth_types).map(bq).join(', ')}]${client.radius_server_address ? `\n      radiusServerAddress: ${bq(String(client.radius_server_address))}` : ''}${radiusSecret}\n    }` : ''}\n  }\n}`
}

function bicepLoadBalancer(node: NetworkNode, nodes: NetworkNode[]) {
  const key = resourceKey(node); const childId = (type: string, name: unknown) => `resourceId('Microsoft.Network/loadBalancers/${type}', ${bq(node.data.label)}, ${bq(String(name ?? ''))})`
  const frontends = records(node.data.frontend_ip_configuration).map((item) => `      {\n        name: ${bq(String(item.name))}${strings(item.zones).length ? `\n        zones: [${strings(item.zones).map(bq).join(', ')}]` : ''}\n        properties: {${item.subnet_id ? `\n          subnet: { id: ${bicepId(item.subnet_id, nodes)} }` : ''}${item.public_ip_address_id ? `\n          publicIPAddress: { id: ${bicepId(item.public_ip_address_id, nodes)} }` : ''}${item.private_ip_address_allocation ? `\n          privateIPAllocationMethod: ${bq(String(item.private_ip_address_allocation))}` : ''}${item.private_ip_address ? `\n          privateIPAddress: ${bq(String(item.private_ip_address))}` : ''}${item.private_ip_address_version ? `\n          privateIPAddressVersion: ${bq(String(item.private_ip_address_version))}` : ''}\n        }\n      }`).join('\n')
  const pools = records(node.data.backend_address_pool).map((item) => `      { name: ${bq(String(item.name))} }`).join('\n')
  const probes = records(node.data.probe).map((item) => `      { name: ${bq(String(item.name))}, properties: { protocol: ${bq(String(item.protocol ?? 'Tcp'))}, port: ${Number(item.port)}${item.request_path ? `, requestPath: ${bq(String(item.request_path))}` : ''}${item.interval_in_seconds !== undefined ? `, intervalInSeconds: ${Number(item.interval_in_seconds)}` : ''}${item.probe_threshold !== undefined ? `, numberOfProbes: ${Number(item.probe_threshold)}` : ''} } }`).join('\n')
  const rules = records(node.data.rule).map((item) => `      { name: ${bq(String(item.name))}, properties: { frontendIPConfiguration: { id: ${childId('frontendIPConfigurations', item.frontend_ip_configuration_name)} }, backendAddressPools: [{ id: ${childId('backendAddressPools', item.backend_address_pool_name)} }]${item.probe_name ? `, probe: { id: ${childId('probes', item.probe_name)} }` : ''}, protocol: ${bq(String(item.protocol ?? 'Tcp'))}, frontendPort: ${Number(item.frontend_port)}, backendPort: ${Number(item.backend_port)}${item.idle_timeout_in_minutes !== undefined ? `, idleTimeoutInMinutes: ${Number(item.idle_timeout_in_minutes)}` : ''} } }`).join('\n')
  return `resource ${key} 'Microsoft.Network/loadBalancers@2024-05-01' = {\n  name: ${bq(node.data.label)}\n  location: ${bq(node.data.region || 'eastus')}\n  sku: { name: ${bq(scalar(node.data.sku, 'Standard'))}, tier: ${bq(scalar(node.data.sku_tier, 'Regional'))} }${node.data.edge_zone ? `\n  extendedLocation: { name: ${bq(String(node.data.edge_zone))}, type: 'EdgeZone' }` : ''}\n  properties: {\n    frontendIPConfigurations: [\n${frontends}\n    ]\n    backendAddressPools: [\n${pools}\n    ]\n    probes: [\n${probes}\n    ]\n    loadBalancingRules: [\n${rules}\n    ]\n  }\n}`
}

function bicepPrivateEndpoint(node: NetworkNode, nodes: NetworkNode[]) {
  const key = resourceKey(node); const connection = record(node.data.private_service_connection)!; const manual = Boolean(connection.is_manual_connection); const dns = record(node.data.private_dns_zone_group)
  const ips = records(node.data.ip_configuration).map((item) => `      { name: ${bq(String(item.name))}, properties: { privateIPAddress: ${bq(String(item.private_ip_address))}${item.subresource_name ? `, groupId: ${bq(String(item.subresource_name))}` : ''}${item.member_name ? `, memberName: ${bq(String(item.member_name))}` : ''} } }`).join('\n')
  const parent = `resource ${key} 'Microsoft.Network/privateEndpoints@2024-05-01' = {\n  name: ${bq(node.data.label)}\n  location: ${bq(node.data.region || 'eastus')}${node.data.edge_zone ? `\n  extendedLocation: { name: ${bq(String(node.data.edge_zone))}, type: 'EdgeZone' }` : ''}\n  properties: {\n    subnet: { id: ${bicepId(node.data.subnet_id, nodes)} }${node.data.custom_network_interface_name ? `\n    customNetworkInterfaceName: ${bq(String(node.data.custom_network_interface_name))}` : ''}\n    ${manual ? 'manualPrivateLinkServiceConnections' : 'privateLinkServiceConnections'}: [\n      { name: ${bq(String(connection.name))}, properties: { privateLinkServiceId: ${bicepId(connection.private_connection_resource_id, nodes)}, groupIds: [${strings(connection.subresource_names).map(bq).join(', ')}]${connection.request_message ? `, requestMessage: ${bq(String(connection.request_message))}` : ''} } }\n    ]${ips ? `\n    ipConfigurations: [\n${ips}\n    ]` : ''}\n  }\n}`
  if (!dns) return parent
  const configs = strings(dns.private_dns_zone_ids).map((zone, index) => `      {\n        name: ${bq(`zone-${index + 1}`)}\n        properties: {\n          #disable-next-line no-hardcoded-env-urls\n          privateDnsZoneId: ${bicepId(zone, nodes)}\n        }\n      }`).join('\n')
  return `${parent}\n\nresource ${key}_dns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {\n  parent: ${key}\n  name: ${bq(String(dns.name))}\n  properties: { privateDnsZoneConfigs: [\n${configs}\n  ] }\n}`
}

function bicep(nodes: NetworkNode[], edges: NetworkEdge[], report: ExportReport) {
  const allowed = new Set(report.supported.map((node) => node.id))
  const resources: string[] = []
  const secureParameters: string[] = []
  for (const node of report.supported) {
    const key = resourceKey(node)
    if (node.data.kind === 'vnet') resources.push(`resource ${key} 'Microsoft.Network/virtualNetworks@2024-05-01' = {\n  name: ${bq(node.data.label)}\n  location: ${bq(node.data.region || 'eastus')}\n  properties: {\n    addressSpace: { addressPrefixes: [${addressSpacesFor(node).map(bq).join(', ')}] }\n  }\n}`)
    if (node.data.kind === 'subnet') {
      const parent = attachedParent(node, nodes, edges)!
      const nsg = associationEdges(edges).map((edge) => edge.data?.kind === 'subnetNetworkSecurityGroup' ? ends(edge, nodes, 'subnet', 'networkSecurityGroup') : undefined).find((pair) => pair?.[0].id === node.id)?.[1]
      const routeTable = associationEdges(edges).map((edge) => edge.data?.kind === 'subnetRouteTable' ? ends(edge, nodes, 'subnet', 'routeTable') : undefined).find((pair) => pair?.[0].id === node.id)?.[1]
      const nat = associationEdges(edges).map((edge) => edge.data?.kind === 'subnetNatGateway' ? ends(edge, nodes, 'subnet', 'natGateway') : undefined).find((pair) => pair?.[0].id === node.id)?.[1]
      resources.push(`resource ${key} 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {\n  parent: ${resourceKey(parent)}\n  name: ${bq(node.data.label)}\n  properties: {\n    addressPrefixes: [${addressSpacesFor(node).map(bq).join(', ')}]${nsg && allowed.has(nsg.id) ? `\n    networkSecurityGroup: { id: ${resourceKey(nsg)}.id }` : ''}${routeTable && allowed.has(routeTable.id) ? `\n    routeTable: { id: ${resourceKey(routeTable)}.id }` : ''}${nat && allowed.has(nat.id) ? `\n    natGateway: { id: ${resourceKey(nat)}.id }` : ''}\n  }\n}`)
    }
    if (node.data.kind === 'natGateway') {
      const pips = associationEdges(edges).map((edge) => edge.data?.kind === 'natGatewayPublicIp' ? ends(edge, nodes, 'natGateway', 'publicIp') : undefined).filter((pair) => pair?.[0].id === node.id && allowed.has(pair[1].id)).map((pair) => pair![1])
      resources.push(`resource ${key} 'Microsoft.Network/natGateways@2024-05-01' = {\n  name: ${bq(node.data.label)}\n  location: ${bq(node.data.region || 'eastus')}\n  sku: { name: ${bq(scalar(node.data.sku_name ?? node.data.sku, 'Standard'))} }${strings(node.data.zones).length ? `\n  zones: [${strings(node.data.zones).map(bq).join(', ')}]` : ''}\n  properties: {\n    idleTimeoutInMinutes: ${Number(node.data.idle_timeout_in_minutes ?? node.data.idleTimeoutMinutes ?? 4)}${pips.length ? `\n    publicIpAddresses: [\n${pips.map((pip) => `      { id: ${resourceKey(pip)}.id }`).join('\n')}\n    ]` : ''}\n  }\n}`)
    }
    if (node.data.kind === 'publicIp') {
      const dns = node.data.domain_name_label || node.data.reverse_fqdn ? `\n    dnsSettings: {${node.data.domain_name_label ? `\n      domainNameLabel: ${bq(String(node.data.domain_name_label))}` : ''}${node.data.reverse_fqdn ? `\n      reverseFqdn: ${bq(String(node.data.reverse_fqdn))}` : ''}\n    }` : ''
      resources.push(`resource ${key} 'Microsoft.Network/publicIPAddresses@2024-05-01' = {\n  name: ${bq(node.data.label)}\n  location: ${bq(node.data.region || 'eastus')}\n  sku: { name: ${bq(scalar(node.data.sku, 'Standard'))}\n    tier: ${bq(scalar(node.data.sku_tier, 'Regional'))}\n  }${strings(node.data.zones).length ? `\n  zones: [${strings(node.data.zones).map(bq).join(', ')}]` : ''}${node.data.edge_zone ? `\n  extendedLocation: { name: ${bq(String(node.data.edge_zone))}\n    type: 'EdgeZone'\n  }` : ''}\n  properties: {\n    publicIPAllocationMethod: ${bq(scalar(node.data.allocation_method, 'Static'))}\n    publicIPAddressVersion: ${bq(scalar(node.data.ip_version, 'IPv4'))}\n    idleTimeoutInMinutes: ${Number(node.data.idle_timeout_in_minutes ?? 4)}${dns}\n  }\n}`)
    }
    if (node.data.kind === 'networkSecurityGroup') {
      const rules = records(node.data.security_rule).map((rule) => `      {\n        name: ${bq(String(rule.name ?? ''))}\n        properties: {\n          priority: ${Number(rule.priority)}\n          direction: ${bq(String(rule.direction ?? 'Inbound'))}\n          access: ${bq(String(rule.access ?? 'Allow'))}\n          protocol: ${bq(String(rule.protocol ?? '*'))}\n          sourcePortRanges: [${strings(rule.source_port_ranges).map(bq).join(', ')}]\n          destinationPortRanges: [${strings(rule.destination_port_ranges).map(bq).join(', ')}]\n          sourceAddressPrefixes: [${strings(rule.source_address_prefixes).map(bq).join(', ')}]\n          destinationAddressPrefixes: [${strings(rule.destination_address_prefixes).map(bq).join(', ')}]\n        }\n      }`).join('\n')
      resources.push(`resource ${key} 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {\n  name: ${bq(node.data.label)}\n  location: ${bq(node.data.region || 'eastus')}\n  properties: {\n    securityRules: [\n${rules}\n    ]\n  }\n}`)
    }
    if (node.data.kind === 'routeTable') {
      const routes = records(node.data.route).map((route) => `      {\n        name: ${bq(String(route.name ?? ''))}\n        properties: {\n          addressPrefix: ${bq(String(route.address_prefix ?? ''))}\n          nextHopType: ${bq(String(route.next_hop_type ?? 'None'))}${route.next_hop_type === 'VirtualAppliance' ? `\n          nextHopIpAddress: ${bq(String(route.next_hop_in_ip_address ?? ''))}` : ''}\n        }\n      }`).join('\n')
      resources.push(`resource ${key} 'Microsoft.Network/routeTables@2024-05-01' = {\n  name: ${bq(node.data.label)}\n  location: ${bq(node.data.region || 'eastus')}\n  properties: {\n    disableBgpRoutePropagation: ${Boolean(node.data.disable_bgp_route_propagation)}\n    routes: [\n${routes}\n    ]\n  }\n}`)
    }
    if (node.data.kind === 'frontDoor') resources.push(`resource ${key} 'Microsoft.Cdn/profiles@2024-09-01' = {\n  name: ${bq(node.data.label)}\n  location: 'global'\n  sku: { name: ${bq(scalar(node.data.sku_name ?? node.data.sku, 'Standard_AzureFrontDoor'))} }\n  properties: { originResponseTimeoutSeconds: ${Number(node.data.response_timeout_seconds ?? 120)} }\n}`)
    if (node.data.kind === 'appGateway') resources.push(bicepAppGateway(node, nodes))
    if (node.data.kind === 'firewall') resources.push(bicepFirewall(node, nodes, edges))
    if (node.data.kind === 'vpnGateway') resources.push(bicepVpnGateway(node, nodes, secureParameters))
    if (node.data.kind === 'loadBalancer') resources.push(bicepLoadBalancer(node, nodes))
    if (node.data.kind === 'privateEndpoint') resources.push(bicepPrivateEndpoint(node, nodes))
  }
  const peeringResources: string[] = []
  for (const edge of peerings(edges)) {
    const a = nodes.find((node) => node.id === edge.source); const b = nodes.find((node) => node.id === edge.target)
    if (!a || !b || !allowed.has(a.id) || !allowed.has(b.id)) continue
    for (const [local, remote] of [[a, b], [b, a]] as const) peeringResources.push(`resource ${resourceKey(local)}_to_${resourceKey(remote)} 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2024-05-01' = {\n  parent: ${resourceKey(local)}\n  name: ${bq(`to-${remote.data.label}`)}\n  properties: {\n    remoteVirtualNetwork: { id: ${resourceKey(remote)}.id }\n    allowVirtualNetworkAccess: true\n  }\n}`)
  }
  const targetSubscription = subscriptionFor(nodes) || '<AZURE_SUBSCRIPTION_ID>'
  const targetGroup = report.supported.find((node) => node.data.kind !== 'subnet')?.data.resourceGroup || 'rg-network'
  return `targetScope = 'resourceGroup'\n\n// Deploy: az deployment group create --subscription ${targetSubscription} --resource-group ${targetGroup} --template-file network.bicep\n${unsupportedHeader(report, '//')}${secureParameters.length ? `${secureParameters.join('\n\n')}\n\n` : ''}${resources.join('\n\n')}\n\n${peeringResources.join('\n\n')}\n`
}

function utf8Base64(value: string) {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function managedArmId(value: unknown, nodes: NetworkNode[], edges: NetworkEdge[]) {
  const target = referencedNode(value, nodes)
  if (!target) return cliReference(value, nodes)
  const group = target.data.kind === 'subnet' ? attachedParent(target, nodes, edges)?.data.resourceGroup : target.data.resourceGroup
  const prefix = `/subscriptions/__SUBSCRIPTION_ID__/resourceGroups/${group || 'rg-network'}/providers/Microsoft.Network`
  if (target.data.kind === 'subnet') {
    const parent = attachedParent(target, nodes, edges)!
    return `${prefix}/virtualNetworks/${parent.data.label}/subnets/${target.data.label}`
  }
  const types: Partial<Record<NetworkNode['data']['kind'], string>> = { vnet: 'virtualNetworks', publicIp: 'publicIPAddresses', appGateway: 'applicationGateways', firewall: 'azureFirewalls', vpnGateway: 'virtualNetworkGateways', loadBalancer: 'loadBalancers', privateEndpoint: 'privateEndpoints' }
  return `${prefix}/${types[target.data.kind] ?? target.data.kind}/${target.data.label}`
}

function cliApplicationGateway(node: NetworkNode, nodes: NetworkNode[], edges: NetworkEdge[], scope: string) {
  const gatewayId = `/subscriptions/__SUBSCRIPTION_ID__/resourceGroups/${node.data.resourceGroup || 'rg-network'}/providers/Microsoft.Network/applicationGateways/${node.data.label}`
  const sku = record(node.data.sku)!
  const autoscale = record(node.data.autoscale_configuration)
  const body = {
    location: node.data.region || 'eastus',
    zones: strings(node.data.zones).length ? strings(node.data.zones) : undefined,
    properties: {
      sku: { name: sku.name, tier: sku.tier, capacity: autoscale ? undefined : sku.capacity },
      enableHttp2: Boolean(node.data.http2_enabled),
      enableFips: Boolean(node.data.fips_enabled),
      autoscaleConfiguration: autoscale ? { minCapacity: autoscale.min_capacity, maxCapacity: autoscale.max_capacity } : undefined,
      gatewayIPConfigurations: records(node.data.gateway_ip_configuration).map((item) => ({ name: item.name, properties: { subnet: { id: managedArmId(item.subnet_id, nodes, edges) } } })),
      frontendIPConfigurations: records(node.data.frontend_ip_configuration).map((item) => ({ name: item.name, properties: {
        subnet: item.subnet_id ? { id: managedArmId(item.subnet_id, nodes, edges) } : undefined,
        publicIPAddress: item.public_ip_address_id ? { id: managedArmId(item.public_ip_address_id, nodes, edges) } : undefined,
        privateIPAllocationMethod: item.private_ip_address_allocation,
        privateIPAddress: item.private_ip_address,
      } })),
      frontendPorts: records(node.data.frontend_port).map((item) => ({ name: item.name, properties: { port: item.port } })),
      backendAddressPools: records(node.data.backend_address_pool).map((item) => ({ name: item.name, properties: { backendAddresses: [
        ...strings(item.fqdns).map((fqdn) => ({ fqdn })), ...strings(item.ip_addresses).map((ipAddress) => ({ ipAddress })),
      ] } })),
      backendHttpSettingsCollection: records(node.data.backend_http_settings).map((item) => ({ name: item.name, properties: { cookieBasedAffinity: item.cookie_based_affinity, port: item.port, protocol: item.protocol, requestTimeout: item.request_timeout } })),
      httpListeners: records(node.data.http_listener).map((item) => ({ name: item.name, properties: {
        frontendIPConfiguration: { id: `${gatewayId}/frontendIPConfigurations/${item.frontend_ip_configuration_name}` },
        frontendPort: { id: `${gatewayId}/frontendPorts/${item.frontend_port_name}` }, protocol: item.protocol,
      } })),
      requestRoutingRules: records(node.data.request_routing_rule).map((item) => ({ name: item.name, properties: {
        ruleType: item.rule_type, priority: item.priority, httpListener: { id: `${gatewayId}/httpListeners/${item.http_listener_name}` },
        backendAddressPool: item.backend_address_pool_name ? { id: `${gatewayId}/backendAddressPools/${item.backend_address_pool_name}` } : undefined,
        backendHttpSettings: item.backend_http_settings_name ? { id: `${gatewayId}/backendHttpSettingsCollection/${item.backend_http_settings_name}` } : undefined,
      } })),
      webApplicationFirewallConfiguration: record(node.data.waf_configuration) ? {
        enabled: Boolean(record(node.data.waf_configuration)!.enabled), firewallMode: record(node.data.waf_configuration)!.firewall_mode,
        ruleSetType: record(node.data.waf_configuration)!.rule_set_type, ruleSetVersion: record(node.data.waf_configuration)!.rule_set_version,
      } : undefined,
    },
  }
  const variable = `APPGW_BODY_${safe(node.id).toUpperCase()}`
  const url = `https://management.azure.com/subscriptions/$SUBSCRIPTION_ID/resourceGroups/${encodeURIComponent(node.data.resourceGroup || 'rg-network')}/providers/Microsoft.Network/applicationGateways/${encodeURIComponent(node.data.label)}?api-version=2024-05-01`
  void scope
  return [
    `${variable}=$(printf %s ${shell(utf8Base64(JSON.stringify(body)))} | base64 --decode)`,
    `${variable}=\${${variable}//__SUBSCRIPTION_ID__/$SUBSCRIPTION_ID}`,
    `az rest --subscription "$SUBSCRIPTION_ID" --method put --url "${url}" --body "$${variable}"`,
  ]
}

function cliFirewall(node: NetworkNode, nodes: NetworkNode[], edges: NetworkEdge[], scope: string) {
  const configurations = effectiveFirewallConfigurations(node, nodes, edges)
  const create = [`az network firewall create ${scope}`, `--name ${shell(node.data.label)}`, `--location ${shell(node.data.region || 'eastus')}`, `--sku ${shell(scalar(node.data.sku_name ?? node.data.sku, 'AZFW_VNet'))}`, `--tier ${shell(scalar(node.data.sku_tier ?? node.data.tier, 'Standard'))}`]
  if (node.data.threat_intel_mode) create.push(`--threat-intel-mode ${shell(String(node.data.threat_intel_mode))}`)
  if (node.data.firewall_policy_id) create.push(`--firewall-policy ${shell(cliReference(node.data.firewall_policy_id, nodes))}`)
  if (strings(node.data.dns_servers).length) create.push(`--dns-servers ${strings(node.data.dns_servers).map(shell).join(' ')}`)
  if (node.data.dns_proxy_enabled !== undefined) create.push(`--enable-dns-proxy ${Boolean(node.data.dns_proxy_enabled)}`)
  if (strings(node.data.private_ip_ranges).length) create.push(`--private-ranges ${strings(node.data.private_ip_ranges).map(shell).join(' ')}`)
  if (strings(node.data.zones).length) create.push(`--zones ${strings(node.data.zones).map(shell).join(' ')}`)
  const first = configurations[0]
  if (first) {
    const subnet = referencedNode(first.subnet_id, nodes)!
    const vnet = attachedParent(subnet, nodes, edges)!
    create.push(`--vnet-name ${shell(vnet.data.label)}`, `--conf-name ${shell(String(first.name ?? 'firewall-ip-configuration'))}`)
    if (first.public_ip_address_id) create.push(`--public-ip ${shell(cliReference(first.public_ip_address_id, nodes))}`)
  }
  const management = record(node.data.management_ip_configuration)
  if (management) create.push(`--m-conf-name ${shell(String(management.name ?? 'management'))}`, `--m-public-ip ${shell(cliReference(management.public_ip_address_id, nodes))}`)
  const hub = record(node.data.virtual_hub)
  if (hub) create.push(`--virtual-hub ${shell(cliReference(hub.virtual_hub_id, nodes))}`, `--public-ip-count ${Number(hub.public_ip_count ?? 1)}`)
  const commands = [create.join(' ')]
  for (const item of configurations.slice(1)) {
    const subnet = referencedNode(item.subnet_id, nodes)!
    const vnet = attachedParent(subnet, nodes, edges)!
    commands.push(`az network firewall ip-config create ${scope} --firewall-name ${shell(node.data.label)} --name ${shell(String(item.name ?? 'firewall-ip-configuration'))} --vnet-name ${shell(vnet.data.label)}${item.public_ip_address_id ? ` --public-ip-address ${shell(cliReference(item.public_ip_address_id, nodes))}` : ''}`)
  }
  return commands
}

function cliVpnGateway(node: NetworkNode, nodes: NetworkNode[], edges: NetworkEdge[], scope: string) {
  const configurations = records(node.data.ip_configuration)
  const subnet = referencedNode(configurations[0].subnet_id, nodes)!
  const vnet = attachedParent(subnet, nodes, edges)!
  const create = [`az network vnet-gateway create ${scope}`, `--name ${shell(node.data.label)}`, `--location ${shell(node.data.region || 'eastus')}`, `--vnet ${shell(vnet.data.label)}`, `--public-ip-addresses ${configurations.map((item) => shell(cliReference(item.public_ip_address_id, nodes))).join(' ')}`, `--gateway-type ${shell(scalar(node.data.type ?? node.data.gatewayType, 'Vpn'))}`, `--sku ${shell(scalar(node.data.sku, 'VpnGw1'))}`]
  if (node.data.vpn_type) create.push(`--vpn-type ${shell(String(node.data.vpn_type))}`)
  if (node.data.generation && node.data.generation !== 'None') create.push(`--vpn-gateway-generation ${shell(String(node.data.generation))}`)
  if (node.data.private_ip_address_enabled !== undefined) create.push(`--enable-private-ip ${Boolean(node.data.private_ip_address_enabled)}`)
  const bgp = record(node.data.bgp_settings)
  if (bgp?.asn !== undefined) create.push(`--asn ${Number(bgp.asn)}`)
  if (bgp?.peer_weight !== undefined) create.push(`--peer-weight ${Number(bgp.peer_weight)}`)
  if (node.data.minimum_scale_unit !== undefined) create.push(`--min-scale-unit ${Number(node.data.minimum_scale_unit)}`)
  if (node.data.maximum_scale_unit !== undefined) create.push(`--max-scale-unit ${Number(node.data.maximum_scale_unit)}`)
  const client = record(node.data.vpn_client_configuration)
  const preflight: string[] = []
  if (client) {
    if (strings(client.address_space).length) create.push(`--address-prefixes ${strings(client.address_space).map(shell).join(' ')}`)
    if (strings(client.vpn_client_protocols).length) create.push(`--client-protocol ${strings(client.vpn_client_protocols).map(shell).join(' ')}`)
    if (strings(client.vpn_auth_types).length) create.push(`--vpn-auth-type ${strings(client.vpn_auth_types).map(shell).join(' ')}`)
    if (client.radius_server_address) create.push(`--radius-server ${shell(String(client.radius_server_address))}`)
    if (client.radius_secret_required) {
      const variable = `VPN_RADIUS_SECRET_${safe(node.id).toUpperCase()}`
      preflight.push(`${variable}="\${${variable}:?Set ${variable} to the RADIUS shared secret}"`)
      create.push(`--radius-secret "$${variable}"`)
    }
  }
  return [...preflight, create.join(' '), `az network vnet-gateway update ${scope} --name ${shell(node.data.label)} --enable-bgp ${Boolean(node.data.bgp_enabled)}`]
}

function cliLoadBalancer(node: NetworkNode, nodes: NetworkNode[], edges: NetworkEdge[], scope: string) {
  const frontendArguments = (frontend: Record<string, unknown>) => {
    const args = [`--name ${shell(String(frontend.name))}`]
    if (frontend.public_ip_address_id) args.push(`--public-ip-address ${shell(cliReference(frontend.public_ip_address_id, nodes))}`)
    if (frontend.subnet_id) {
      const subnet = referencedNode(frontend.subnet_id, nodes)!
      const vnet = attachedParent(subnet, nodes, edges)!
      args.push(`--vnet-name ${shell(vnet.data.label)}`, `--subnet ${shell(subnet.data.label)}`)
    }
    if (frontend.private_ip_address) args.push(`--private-ip-address ${shell(String(frontend.private_ip_address))}`)
    if (frontend.private_ip_address_version) args.push(`--private-ip-address-version ${shell(String(frontend.private_ip_address_version))}`)
    const zones = strings(frontend.zones)
    if (zones.length) args.push(`--zones ${zones.map(shell).join(' ')}`)
    return args.join(' ')
  }
  const commands = [`az network lb create ${scope} --name ${shell(node.data.label)} --location ${shell(node.data.region || 'eastus')} --sku ${shell(scalar(node.data.sku, 'Standard'))} --public-ip-address ''${node.data.edge_zone ? ` --edge-zone ${shell(String(node.data.edge_zone))}` : ''}`]
  for (const frontend of records(node.data.frontend_ip_configuration)) commands.push(`az network lb frontend-ip create ${scope} --lb-name ${shell(node.data.label)} ${frontendArguments(frontend)}`)
  for (const pool of records(node.data.backend_address_pool)) commands.push(`az network lb address-pool create ${scope} --lb-name ${shell(node.data.label)} --name ${shell(String(pool.name))}`)
  for (const probe of records(node.data.probe)) commands.push(`az network lb probe create ${scope} --lb-name ${shell(node.data.label)} --name ${shell(String(probe.name))} --protocol ${shell(String(probe.protocol ?? 'Tcp'))} --port ${Number(probe.port)}${probe.request_path ? ` --request-path ${shell(String(probe.request_path))}` : ''}${probe.interval_in_seconds !== undefined ? ` --interval-in-seconds ${Number(probe.interval_in_seconds)}` : ''}${probe.probe_threshold !== undefined ? ` --probe-threshold ${Number(probe.probe_threshold)}` : ''}`)
  for (const rule of records(node.data.rule)) commands.push(`az network lb rule create ${scope} --lb-name ${shell(node.data.label)} --name ${shell(String(rule.name))} --frontend-ip-name ${shell(String(rule.frontend_ip_configuration_name))} --backend-pool-name ${shell(String(rule.backend_address_pool_name))}${rule.probe_name ? ` --probe-name ${shell(String(rule.probe_name))}` : ''} --protocol ${shell(String(rule.protocol ?? 'Tcp'))} --frontend-port ${Number(rule.frontend_port)} --backend-port ${Number(rule.backend_port)}${rule.idle_timeout_in_minutes !== undefined ? ` --idle-timeout-in-minutes ${Number(rule.idle_timeout_in_minutes)}` : ''}`)
  return commands
}

function cliPrivateEndpoint(node: NetworkNode, nodes: NetworkNode[], edges: NetworkEdge[], scope: string) {
  const subnet = referencedNode(node.data.subnet_id, nodes)!
  const vnet = attachedParent(subnet, nodes, edges)!
  const connection = record(node.data.private_service_connection)!
  const create = [`az network private-endpoint create ${scope}`, `--name ${shell(node.data.label)}`, `--location ${shell(node.data.region || 'eastus')}`, `--vnet-name ${shell(vnet.data.label)}`, `--subnet ${shell(subnet.data.label)}`, `--connection-name ${shell(String(connection.name))}`, `--private-connection-resource-id ${shell(cliReference(connection.private_connection_resource_id, nodes))}`]
  if (strings(connection.subresource_names).length) create.push(`--group-ids ${strings(connection.subresource_names).map(shell).join(' ')}`)
  if (connection.is_manual_connection) create.push('--manual-request true')
  if (connection.request_message) create.push(`--request-message ${shell(String(connection.request_message))}`)
  if (node.data.custom_network_interface_name) create.push(`--nic-name ${shell(String(node.data.custom_network_interface_name))}`)
  if (node.data.edge_zone) create.push(`--edge-zone ${shell(String(node.data.edge_zone))}`)
  const commands = [create.join(' ')]
  for (const item of records(node.data.ip_configuration)) commands.push(`az network private-endpoint ip-config add ${scope} --endpoint-name ${shell(node.data.label)} --name ${shell(String(item.name))} --private-ip-address ${shell(String(item.private_ip_address))}${item.subresource_name ? ` --group-id ${shell(String(item.subresource_name))}` : ''}${item.member_name ? ` --member-name ${shell(String(item.member_name))}` : ''}`)
  const dns = record(node.data.private_dns_zone_group)
  if (dns) strings(dns.private_dns_zone_ids).forEach((zone, index) => commands.push(`az network private-endpoint dns-zone-group ${index ? 'add' : 'create'} ${scope} --endpoint-name ${shell(node.data.label)} --name ${shell(String(dns.name))} --zone-name ${shell(`zone-${index + 1}`)} --private-dns-zone ${shell(cliReference(zone, nodes))}`))
  return commands
}

function azureCli(nodes: NetworkNode[], edges: NetworkEdge[], report: ExportReport) {
  const subscription = subscriptionFor(nodes)
  const subscriptionValue = subscription ? shell(subscription) : '"${AZURE_SUBSCRIPTION_ID:?Set AZURE_SUBSCRIPTION_ID}"'
  const commands = ['#!/usr/bin/env bash', 'set -euo pipefail', '', '# Generated by InfraWeft. Review before running.', unsupportedHeader(report, '#').trimEnd(), `SUBSCRIPTION_ID=${subscriptionValue}`, ''].filter((line, index, all) => line || all[index - 1] !== '')
  const allowed = new Set(report.supported.map((node) => node.id))
  const scopeFor = (node: NetworkNode) => `--subscription "$SUBSCRIPTION_ID" --resource-group ${shell(node.data.resourceGroup || 'rg-network')}`
  if (report.supported.some((node) => node.data.kind === 'appGateway')) commands.push(`command -v base64 >/dev/null 2>&1 || { echo 'base64 is required to decode the embedded Application Gateway request body.' >&2; exit 1; }`, '')
  if (report.supported.some((node) => node.data.kind === 'firewall')) commands.push(`az extension show --name azure-firewall >/dev/null 2>&1 || { echo 'Azure CLI extension azure-firewall is required. Install it with: az extension add --name azure-firewall' >&2; exit 1; }`, '')
  for (const node of report.supported) {
    const scope = scopeFor(node)
    if (node.data.kind === 'vnet') commands.push(`az network vnet create ${scope} --name ${shell(node.data.label)} --location ${shell(node.data.region || 'eastus')} --address-prefixes ${addressSpacesFor(node).map(shell).join(' ')}`)
    if (node.data.kind === 'subnet') {
      const parent = attachedParent(node, nodes, edges)!
      commands.push(`az network vnet subnet create ${scopeFor(parent)} --vnet-name ${shell(parent.data.label)} --name ${shell(node.data.label)} --address-prefixes ${addressSpacesFor(node).map(shell).join(' ')}`)
    }
    if (node.data.kind === 'natGateway') {
      const zones = strings(node.data.zones)
      commands.push(`az network nat gateway create ${scope} --name ${shell(node.data.label)} --location ${shell(node.data.region || 'eastus')} --sku ${shell(scalar(node.data.sku_name ?? node.data.sku, 'Standard'))} --idle-timeout ${Number(node.data.idle_timeout_in_minutes ?? node.data.idleTimeoutMinutes ?? 4)}${zones.length ? ` --zone ${zones.map(shell).join(' ')}` : ''}`)
    }
    if (node.data.kind === 'frontDoor') commands.push(`az afd profile create ${scope} --profile-name ${shell(node.data.label)} --sku ${shell(scalar(node.data.sku_name ?? node.data.sku, 'Standard_AzureFrontDoor'))} --origin-response-timeout-seconds ${Number(node.data.response_timeout_seconds ?? 120)}`)
    if (node.data.kind === 'publicIp') {
      const zones = strings(node.data.zones)
      commands.push(`az network public-ip create ${scope} --name ${shell(node.data.label)} --location ${shell(node.data.region || 'eastus')} --allocation-method ${shell(scalar(node.data.allocation_method, 'Static'))} --sku ${shell(scalar(node.data.sku, 'Standard'))} --tier ${shell(scalar(node.data.sku_tier, 'Regional'))} --version ${shell(scalar(node.data.ip_version, 'IPv4'))} --idle-timeout ${Number(node.data.idle_timeout_in_minutes ?? 4)}${zones.length ? ` --zone ${zones.map(shell).join(' ')}` : ''}${node.data.domain_name_label ? ` --dns-name ${shell(String(node.data.domain_name_label))}` : ''}${node.data.reverse_fqdn ? ` --reverse-fqdn ${shell(String(node.data.reverse_fqdn))}` : ''}${node.data.edge_zone ? ` --edge-zone ${shell(String(node.data.edge_zone))}` : ''}`)
    }
    if (node.data.kind === 'networkSecurityGroup') {
      commands.push(`az network nsg create ${scope} --name ${shell(node.data.label)} --location ${shell(node.data.region || 'eastus')}`)
      for (const rule of records(node.data.security_rule)) commands.push(`az network nsg rule create ${scope} --nsg-name ${shell(node.data.label)} --name ${shell(String(rule.name ?? ''))} --priority ${Number(rule.priority)} --direction ${shell(String(rule.direction ?? 'Inbound'))} --access ${shell(String(rule.access ?? 'Allow'))} --protocol ${shell(String(rule.protocol ?? '*'))} --source-port-ranges ${strings(rule.source_port_ranges).map(shell).join(' ')} --destination-port-ranges ${strings(rule.destination_port_ranges).map(shell).join(' ')} --source-address-prefixes ${strings(rule.source_address_prefixes).map(shell).join(' ')} --destination-address-prefixes ${strings(rule.destination_address_prefixes).map(shell).join(' ')}`)
    }
    if (node.data.kind === 'routeTable') {
      commands.push(`az network route-table create ${scope} --name ${shell(node.data.label)} --location ${shell(node.data.region || 'eastus')} --disable-bgp-route-propagation ${Boolean(node.data.disable_bgp_route_propagation)}`)
      for (const route of records(node.data.route)) commands.push(`az network route-table route create ${scope} --route-table-name ${shell(node.data.label)} --name ${shell(String(route.name ?? ''))} --address-prefix ${shell(String(route.address_prefix ?? ''))} --next-hop-type ${shell(String(route.next_hop_type ?? 'None'))}${route.next_hop_type === 'VirtualAppliance' ? ` --next-hop-ip-address ${shell(String(route.next_hop_in_ip_address ?? ''))}` : ''}`)
    }
    if (node.data.kind === 'appGateway') commands.push(...cliApplicationGateway(node, nodes, edges, scope))
    if (node.data.kind === 'firewall') commands.push(...cliFirewall(node, nodes, edges, scope))
    if (node.data.kind === 'vpnGateway') commands.push(...cliVpnGateway(node, nodes, edges, scope))
    if (node.data.kind === 'loadBalancer') commands.push(...cliLoadBalancer(node, nodes, edges, scope))
    if (node.data.kind === 'privateEndpoint') commands.push(...cliPrivateEndpoint(node, nodes, edges, scope))
  }
  for (const edge of associationEdges(edges)) {
    if (!allowed.has(edge.source) || !allowed.has(edge.target)) continue
    const subnetNsg = edge.data?.kind === 'subnetNetworkSecurityGroup' ? ends(edge, nodes, 'subnet', 'networkSecurityGroup') : undefined
    const subnetRoute = edge.data?.kind === 'subnetRouteTable' ? ends(edge, nodes, 'subnet', 'routeTable') : undefined
    const subnetNat = edge.data?.kind === 'subnetNatGateway' ? ends(edge, nodes, 'subnet', 'natGateway') : undefined
    for (const [pair, flag] of [[subnetNsg, '--network-security-group'], [subnetRoute, '--route-table'], [subnetNat, '--nat-gateway']] as const) if (pair) {
      const [subnet, associated] = pair; const parent = attachedParent(subnet, nodes, edges)!
      commands.push(`az network vnet subnet update ${scopeFor(parent)} --vnet-name ${shell(parent.data.label)} --name ${shell(subnet.data.label)} ${flag} ${shell(associated.data.label)}`)
    }
  }
  for (const nat of report.supported.filter((node) => node.data.kind === 'natGateway')) {
    const publicIps = associationEdges(edges).map((edge) => edge.data?.kind === 'natGatewayPublicIp' ? ends(edge, nodes, 'natGateway', 'publicIp') : undefined).filter((pair) => pair?.[0].id === nat.id && allowed.has(pair[1].id)).map((pair) => pair![1])
    if (publicIps.length) commands.push(`az network nat gateway update ${scopeFor(nat)} --name ${shell(nat.data.label)} --public-ip-addresses ${publicIps.map((node) => shell(node.data.label)).join(' ')}`)
  }
  for (const edge of peerings(edges)) {
    const a = nodes.find((node) => node.id === edge.source); const b = nodes.find((node) => node.id === edge.target)
    if (!a || !b || !allowed.has(a.id) || !allowed.has(b.id) || a.data.kind !== 'vnet' || b.data.kind !== 'vnet') continue
    commands.push('', `A_ID=$(az network vnet show --subscription "$SUBSCRIPTION_ID" -g ${shell(a.data.resourceGroup || 'rg-network')} -n ${shell(a.data.label)} --query id -o tsv)`, `B_ID=$(az network vnet show --subscription "$SUBSCRIPTION_ID" -g ${shell(b.data.resourceGroup || 'rg-network')} -n ${shell(b.data.label)} --query id -o tsv)`, `az network vnet peering create --subscription "$SUBSCRIPTION_ID" -g ${shell(a.data.resourceGroup || 'rg-network')} --vnet-name ${shell(a.data.label)} -n ${shell(`to-${b.data.label}`)} --remote-vnet "$B_ID" --allow-vnet-access`, `az network vnet peering create --subscription "$SUBSCRIPTION_ID" -g ${shell(b.data.resourceGroup || 'rg-network')} --vnet-name ${shell(b.data.label)} -n ${shell(`to-${a.data.label}`)} --remote-vnet "$A_ID" --allow-vnet-access`)
  }
  return commands.join('\n') + '\n'
}
