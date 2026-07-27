import express from 'express'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const app = express()
const exec = promisify(execFile)
const port = Number(process.env.API_PORT || 8787)

app.disable('x-powered-by')
app.use((req, res, next) => {
  const origin = req.get('origin')
  const fetchSite = req.get('sec-fetch-site')
  const allowedOrigins = new Set(['http://127.0.0.1:5173', 'http://localhost:5173'])
  if ((origin && !allowedOrigins.has(origin)) || fetchSite === 'cross-site') return res.status(403).json({ error: 'Cross-site requests are not allowed.' })
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

app.get('/api/health', (_req, res) => res.json({ ok: true }))

app.get('/api/azure/subscriptions', async (_req, res) => {
  try {
    const subscriptions = await az(['account', 'list', '--query', '[].{id:id,name:name,isDefault:isDefault,tenantId:tenantId}'])
    res.json({ subscriptions })
  } catch (error) {
    res.status(503).json({ error: publicAzureError(error) })
  }
})

app.get('/api/azure/topology', async (req, res) => {
  const subscriptionId = String(req.query.subscriptionId || '')
  if (!/^[0-9a-f-]{36}$/i.test(subscriptionId)) return res.status(400).json({ error: 'A valid subscriptionId is required.' })
  try {
    const [vnets, resources] = await Promise.all([
      az(['network', 'vnet', 'list', '--subscription', subscriptionId]),
      az(['resource', 'list', '--subscription', subscriptionId, '--resource-type', 'Microsoft.Network/applicationGateways']),
    ])
    const extraTypes = ['azureFirewalls', 'natGateways', 'virtualNetworkGateways', 'loadBalancers', 'privateEndpoints']
    const extras = await Promise.all(extraTypes.map((type) => az(['resource', 'list', '--subscription', subscriptionId, '--resource-type', `Microsoft.Network/${type}`])))
    const kindByType: Record<string, string> = { applicationGateways: 'appGateway', azureFirewalls: 'firewall', natGateways: 'natGateway', virtualNetworkGateways: 'vpnGateway', loadBalancers: 'loadBalancer', privateEndpoints: 'privateEndpoint' }
    const nodes: any[] = vnets.map((vnet: any, index: number) => ({ id: vnet.id, type: 'azureResource', position: { x: 120 + (index % 3) * 330, y: 100 + Math.floor(index / 3) * 230 }, data: { label: vnet.name, kind: 'vnet', addressSpace: vnet.addressSpace?.addressPrefixes?.[0] || '', addressSpaces: vnet.addressSpace?.addressPrefixes || [], region: vnet.location, resourceGroup: vnet.resourceGroup, subscriptionId, imported: true } }))
    const allResources = [resources, ...extras].flat()
    allResources.forEach((resource: any, index: number) => {
      const segment = String(resource.type).split('/').at(-1) || ''
      nodes.push({ id: resource.id, type: 'azureResource', position: { x: 170 + (index % 3) * 330, y: 250 + Math.floor(index / 3) * 230 }, data: { label: resource.name, kind: kindByType[segment] || 'privateEndpoint', region: resource.location, resourceGroup: resource.resourceGroup, subscriptionId, imported: true } })
    })
    const edges: any[] = []
    for (const vnet of vnets) for (const peering of vnet.virtualNetworkPeerings || []) {
      const remoteId = peering.remoteVirtualNetwork?.id
      const remoteNode = remoteId && nodes.find((node) => node.id.toLowerCase() === remoteId.toLowerCase())
      if (remoteNode) edges.push({ id: peering.id, source: vnet.id, target: remoteNode.id, type: 'smoothstep', animated: true, label: peering.name, data: { kind: 'peering', imported: true } })
    }
    const uniqueEdges = edges.filter((edge, index) => edges.findIndex((candidate) => [candidate.source.toLowerCase(), candidate.target.toLowerCase()].sort().join('|') === [edge.source.toLowerCase(), edge.target.toLowerCase()].sort().join('|')) === index)
    res.json({ name: 'Imported Azure topology', nodes, edges: uniqueEdges })
  } catch (error) {
    res.status(503).json({ error: publicAzureError(error) })
  }
})

app.listen(port, '127.0.0.1', () => console.log(`Azure discovery API listening on http://127.0.0.1:${port}`))
