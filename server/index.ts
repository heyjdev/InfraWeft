import express from 'express'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { validateGeneratedCode, validateRequest } from './validation.js'

const app = express()
const exec = promisify(execFile)
const port = Number(process.env.API_PORT || 8787)
const allowedOrigins = new Set(['http://127.0.0.1:5173', 'http://localhost:5173'])
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
const discoveryCache = new Map<string, { expires: number; value: unknown }>()
const discoveryInFlight = new Map<string, Promise<unknown>>()
let discoveryRequests: number[] = []

app.disable('x-powered-by')
app.use((req, res, next) => {
  const origin = req.get('origin')
  const host = req.get('host')
  const fetchSite = req.get('sec-fetch-site')
  if (!host || !allowedHosts.has(host) || (origin && !allowedOrigins.has(origin)) || fetchSite === 'cross-site') return res.status(403).json({ error: 'Cross-site requests are not allowed.' })
  if (req.path.startsWith('/api/azure/') || req.path === '/api/validate') {
    const now = Date.now()
    discoveryRequests = discoveryRequests.filter((timestamp) => timestamp > now - 60_000)
    if (discoveryRequests.length >= 30) return res.status(429).json({ error: 'Too many Azure discovery requests. Retry in one minute.' })
    discoveryRequests.push(now)
  }
  next()
})
app.use(express.json({ limit: '1mb' }))

async function az(args: string[]) {
  const { stdout } = await exec('az', [...args, '--only-show-errors', '-o', 'json'], { timeout: 60_000, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, AZURE_CORE_COLLECT_TELEMETRY: '0' } })
  return JSON.parse(stdout)
}

function publicAzureError(error: unknown) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return 'Azure CLI is not installed or not available on PATH.'
  const message = error instanceof Error ? error.message : ''
  if (/login|logged in|authentication|subscription/i.test(message)) return 'Azure CLI is not signed in or the subscription is not accessible.'
  return 'Azure discovery failed. Check the local API logs for details.'
}

async function discoverTopology(subscriptionId: string) {
  const vnets = await az(['network', 'vnet', 'list', '--subscription', subscriptionId]) as any[]
  const resourceTypes = ['applicationGateways', 'azureFirewalls', 'natGateways', 'virtualNetworkGateways', 'loadBalancers', 'privateEndpoints']
  const settled = await Promise.allSettled(resourceTypes.map((type) => az(['resource', 'list', '--subscription', subscriptionId, '--resource-type', `Microsoft.Network/${type}`])))
  const warnings: string[] = []
  const resources: any[] = []
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled' && Array.isArray(result.value)) resources.push(...result.value)
    else warnings.push(`Could not read Microsoft.Network/${resourceTypes[index]}`)
  })
  const kindByType: Record<string, string> = { applicationgateways: 'appGateway', azurefirewalls: 'firewall', natgateways: 'natGateway', virtualnetworkgateways: 'vpnGateway', loadbalancers: 'loadBalancer', privateendpoints: 'privateEndpoint' }
  const nodes: any[] = vnets.map((vnet, index) => ({ id: vnet.id, type: 'azureResource', position: { x: 120 + (index % 3) * 330, y: 100 + Math.floor(index / 3) * 230 }, data: { label: vnet.name, kind: 'vnet', addressSpace: vnet.addressSpace?.addressPrefixes?.[0] || '', addressSpaces: vnet.addressSpace?.addressPrefixes || [], region: vnet.location, resourceGroup: vnet.resourceGroup, subscriptionId, imported: true } }))
  resources.forEach((resource, index) => {
    const segment = String(resource.type).split('/').at(-1)?.toLowerCase() || ''
    const kind = kindByType[segment]
    if (!kind) { warnings.push(`Unsupported resource type omitted from canvas: ${resource.type}`); return }
    nodes.push({ id: resource.id, type: 'azureResource', position: { x: 170 + (index % 3) * 330, y: 250 + Math.floor(index / 3) * 230 }, data: { label: resource.name, kind, region: resource.location, resourceGroup: resource.resourceGroup, subscriptionId, imported: true } })
  })
  const edges: any[] = []
  for (const vnet of vnets) for (const peering of vnet.virtualNetworkPeerings || []) {
    const remoteId = peering.remoteVirtualNetwork?.id
    const remoteNode = remoteId && nodes.find((node) => node.id.toLowerCase() === remoteId.toLowerCase())
    if (remoteNode) edges.push({ id: peering.id, source: vnet.id, target: remoteNode.id, type: 'smoothstep', animated: true, label: peering.name, data: { kind: 'peering', imported: true } })
  }
  const uniqueEdges = edges.filter((edge, index) => edges.findIndex((candidate) => [candidate.source.toLowerCase(), candidate.target.toLowerCase()].sort().join('|') === [edge.source.toLowerCase(), edge.target.toLowerCase()].sort().join('|')) === index)
  return { name: 'Imported Azure topology', nodes, edges: uniqueEdges, warnings }
}

app.get('/api/health', (_req, res) => res.json({ ok: true }))

app.post('/api/validate', async (req, res) => {
  const request = validateRequest(req.body)
  if (!request.ok) return res.status(400).json({ error: request.error })
  try {
    const result = await validateGeneratedCode(request.format, request.code)
    res.status(result.ok ? 200 : 422).json(result)
  } catch {
    res.status(503).json({ error: 'Local validation could not be started.' })
  }
})

app.get('/api/azure/subscriptions', async (_req, res) => {
  try {
    const subscriptions = await az(['account', 'list', '--query', '[].{id:id,name:name,isDefault:isDefault}'])
    res.json({ subscriptions })
  } catch (error) {
    res.status(503).json({ error: publicAzureError(error) })
  }
})

app.get('/api/azure/topology', async (req, res) => {
  const subscriptionId = String(req.query.subscriptionId || '')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subscriptionId)) return res.status(400).json({ error: 'A valid subscriptionId is required.' })
  try {
    const cached = discoveryCache.get(subscriptionId)
    if (cached && cached.expires > Date.now()) return res.json(cached.value)
    let pending = discoveryInFlight.get(subscriptionId)
    if (!pending) {
      pending = discoverTopology(subscriptionId)
      discoveryInFlight.set(subscriptionId, pending)
    }
    const value = await pending
    discoveryCache.set(subscriptionId, { expires: Date.now() + 15_000, value })
    res.json(value)
  } catch (error) {
    res.status(503).json({ error: publicAzureError(error) })
  } finally {
    discoveryInFlight.delete(subscriptionId)
  }
})

app.listen(port, '127.0.0.1', () => console.log(`Azure discovery API listening on http://127.0.0.1:${port}`))
