import { useCallback, useEffect, useMemo, useState } from 'react'
import { addEdge, Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, type Connection, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Boxes, CircleDot, CloudDownload, Code2, Copy, Download, Flame, PanelsTopLeft, GitBranch, Globe2, Menu, Network, Plus, Router, Save, Search, ShieldCheck, Trash2, WandSparkles, X, Zap } from 'lucide-react'
import './App.css'
import { generateInfrastructure, type ExportFormat } from './generators'
import { addressSpacesFor, nodesOverlap, RESOURCE_LABELS, starterDesign, validateDesign, type NetworkEdge, type NetworkNode, type NetworkNodeData, type ResourceKind } from './model'

const iconMap: Record<ResourceKind, typeof Network> = { vnet: Network, subnet: Boxes, appGateway: PanelsTopLeft, natGateway: Router, firewall: Flame, vpnGateway: ShieldCheck, loadBalancer: GitBranch, privateEndpoint: CircleDot }
const colors: Record<ResourceKind, string> = { vnet: '#0078d4', subnet: '#6b69d6', appGateway: '#8b5cf6', natGateway: '#00a4ef', firewall: '#e15241', vpnGateway: '#107c10', loadBalancer: '#008272', privateEndpoint: '#c239b3' }
const palette: ResourceKind[] = ['vnet', 'subnet', 'appGateway', 'natGateway', 'firewall', 'vpnGateway', 'loadBalancer', 'privateEndpoint']

function AzureNode({ data, selected }: NodeProps) {
  const value = data as NetworkNodeData
  const Icon = iconMap[value.kind]
  const ranges = value.addressSpaces?.length ? value.addressSpaces : value.addressSpace ? [value.addressSpace] : []
  return <div className={`azure-node ${selected ? 'selected' : ''}`} style={{ '--node-color': colors[value.kind] } as React.CSSProperties}>
    <Handle type="target" position={Position.Left} />
    <div className="azure-icon"><Icon size={22} strokeWidth={1.8} /></div>
    <div className="node-copy"><strong>{value.label}</strong><span>{RESOURCE_LABELS[value.kind]}</span>{value.kind === 'vnet' && ranges.length > 0 && <code>{ranges.join(', ')}</code>}</div>
    {value.imported && <span className="imported-dot" title="Imported from Azure" />}
    <Handle type="source" position={Position.Right} />
  </div>
}

const nodeTypes = { azureResource: AzureNode }

function loadInitialDesign() {
  try {
    const saved = localStorage.getItem('azure-network-studio-design')
    if (!saved) return starterDesign
    const parsed = JSON.parse(saved)
    return Array.isArray(parsed?.nodes) && Array.isArray(parsed?.edges) ? parsed : starterDesign
  } catch { return starterDesign }
}

function Studio() {
  const initial = loadInitialDesign()
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes as NetworkNode[])
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges as NetworkEdge[])
  const [selectedId, setSelectedId] = useState<string | null>('hub')
  const [format, setFormat] = useState<ExportFormat>('terraform')
  const [mode, setMode] = useState<'design' | 'code'>('design')
  const [notice, setNotice] = useState('Ready')
  const [importOpen, setImportOpen] = useState(false)
  const [subscriptions, setSubscriptions] = useState<Array<{ id: string; name: string; isDefault: boolean }>>([])
  const [subscriptionId, setSubscriptionId] = useState('')
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const selected = nodes.find((node) => node.id === selectedId)
  const issues = useMemo(() => validateDesign(nodes as NetworkNode[], edges as NetworkEdge[]), [nodes, edges])
  const generated = useMemo(() => generateInfrastructure(nodes as NetworkNode[], edges as NetworkEdge[], format), [nodes, edges, format])

  useEffect(() => { if (!notice || notice === 'Ready') return; const timer = setTimeout(() => setNotice('Ready'), 4000); return () => clearTimeout(timer) }, [notice])

  const onConnect = useCallback((connection: Connection) => {
    const source = nodes.find((node) => node.id === connection.source); const target = nodes.find((node) => node.id === connection.target)
    if (!source || !target || source.id === target.id) return
    const peering = source.data.kind === 'vnet' && target.data.kind === 'vnet'
    const duplicatePeering = peering && edges.some((edge) => edge.data?.kind === 'peering' && [edge.source, edge.target].sort().join('|') === [source.id, target.id].sort().join('|'))
    if (duplicatePeering) { setNotice('Blocked: these VNets are already peered'); return }
    if (peering && nodesOverlap(source as NetworkNode, target as NetworkNode)) { setNotice(`Blocked: ${source.data.label} overlaps ${target.data.label}`); return }
    setEdges((current) => addEdge({ ...connection, id: crypto.randomUUID(), type: 'smoothstep', animated: peering, label: peering ? 'VNet peering' : undefined, markerEnd: { type: MarkerType.ArrowClosed }, data: { kind: peering ? 'peering' : 'attachment' } }, current))
    setNotice(peering ? 'Peering created' : 'Resource attached')
  }, [nodes, edges, setEdges])

  function addResource(kind: ResourceKind) {
    const count = nodes.filter((node) => node.data.kind === kind).length + 1
    const node: NetworkNode = { id: crypto.randomUUID(), type: 'azureResource', position: { x: 180 + (nodes.length % 4) * 160, y: 130 + (nodes.length % 3) * 150 }, data: { label: `${kind === 'vnet' ? 'vnet' : kind}-${count}`, kind, addressSpace: kind === 'vnet' ? `10.${30 + count}.0.0/16` : undefined, addressSpaces: kind === 'vnet' ? [`10.${30 + count}.0.0/16`] : undefined, region: 'eastus', resourceGroup: 'rg-network' } }
    setNodes((current) => [...current, node]); setSelectedId(node.id); setNotice(`${RESOURCE_LABELS[kind]} added`)
  }

  function updateSelected(patch: Partial<NetworkNodeData>) { setNodes((current) => current.map((node) => node.id === selectedId ? { ...node, data: { ...node.data, ...patch } } : node)) }
  function removeSelected() { if (!selectedId) return; setNodes((current) => current.filter((node) => node.id !== selectedId)); setEdges((current) => current.filter((edge) => edge.source !== selectedId && edge.target !== selectedId)); setSelectedId(null); setNotice('Resource removed') }
  function save() { localStorage.setItem('azure-network-studio-design', JSON.stringify({ name: 'Saved design', nodes, edges })); setNotice('Saved locally in this browser') }
  function download() { const blob = new Blob([generated], { type: 'text/plain' }); const href = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = href; a.download = `network.${format === 'terraform' ? 'tf' : format === 'bicep' ? 'bicep' : 'sh'}`; a.click(); URL.revokeObjectURL(href) }
  async function copyCode() { await navigator.clipboard.writeText(generated); setNotice('Code copied') }

  async function openImport() {
    setImportOpen(true); setLoading(true)
    try { const response = await fetch('/api/azure/subscriptions'); const body = await response.json(); if (!response.ok) throw new Error(body.error); setSubscriptions(body.subscriptions); setSubscriptionId(body.subscriptions.find((item: any) => item.isDefault)?.id || body.subscriptions[0]?.id || '') }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Azure discovery unavailable') } finally { setLoading(false) }
  }
  async function importTopology() {
    if (!subscriptionId) return; setLoading(true)
    try { const response = await fetch(`/api/azure/topology?subscriptionId=${encodeURIComponent(subscriptionId)}`); const body = await response.json(); if (!response.ok) throw new Error(body.error); setNodes(body.nodes); setEdges(body.edges); setImportOpen(false); setNotice(`Imported ${body.nodes.length} Azure resources`) }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Import failed') } finally { setLoading(false) }
  }

  const visiblePalette = palette.filter((kind) => RESOURCE_LABELS[kind].toLowerCase().includes(query.toLowerCase()))

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><Network size={21} /></div><div><strong>Azure Network Studio</strong><span>Visual infrastructure designer</span></div></div>
      <nav><button className={mode === 'design' ? 'active' : ''} onClick={() => setMode('design')}><WandSparkles size={15}/> Design</button><button className={mode === 'code' ? 'active' : ''} onClick={() => setMode('code')}><Code2 size={15}/> Generate</button></nav>
      <div className="top-actions"><span className={`status ${issues.length ? 'warning' : ''}`}>{issues.length ? `${issues.length} issue${issues.length > 1 ? 's' : ''}` : notice}</span><button className="ghost" onClick={save}><Save size={16}/> Save</button><button className="primary" onClick={openImport}><CloudDownload size={16}/> Import Azure</button></div>
    </header>
    <main>
      <aside className="palette-panel">
        <div className="panel-title"><span>Components</span><button title="Collapse"><Menu size={16}/></button></div>
        <label className="search"><Search size={15}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a resource"/></label>
        <div className="palette-list">{visiblePalette.map((kind) => { const Icon = iconMap[kind]; return <button key={kind} onClick={() => addResource(kind)}><span className="palette-icon" style={{ color: colors[kind], background: `${colors[kind]}15` }}><Icon size={20}/></span><span><strong>{RESOURCE_LABELS[kind]}</strong><small>{kind === 'vnet' ? 'Address space & peerings' : 'Azure network resource'}</small></span><Plus size={15} className="add-icon"/></button> })}</div>
        <div className="hint"><Zap size={16}/><div><strong>Quick connect</strong><p>Drag between node handles. Overlapping VNets are blocked.</p></div></div>
      </aside>
      <section className="workspace">
        <div className="workspace-bar"><div><Globe2 size={15}/><strong>Hub and spoke prototype</strong><span>eastus</span></div><div className="legend"><span><i className="dot imported"/> Imported</span><span><i className="line"/> Peering</span></div></div>
        {mode === 'design' ? <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} nodeTypes={nodeTypes} onNodeClick={(_, node) => setSelectedId(node.id)} onPaneClick={() => setSelectedId(null)} fitView minZoom={0.25} maxZoom={1.8} deleteKeyCode={null}>
          <Background color="#dce6f1" gap={24}/><MiniMap nodeColor={(node) => colors[(node.data as NetworkNodeData).kind]} maskColor="rgba(241,246,251,.72)"/><Controls position="bottom-center" />
        </ReactFlow> : <div className="code-workspace"><div className="code-toolbar"><div className="segment">{(['terraform','bicep','azureCli'] as ExportFormat[]).map((item) => <button key={item} className={format === item ? 'active' : ''} onClick={() => setFormat(item)}>{item === 'azureCli' ? 'Azure CLI' : item[0].toUpperCase() + item.slice(1)}</button>)}</div><div><button disabled={issues.length > 0} onClick={copyCode}><Copy size={15}/> Copy</button><button disabled={issues.length > 0} className="primary" onClick={download}><Download size={15}/> Download</button></div></div>{issues.length > 0 && <div className="validation-banner"><ShieldCheck size={17}/><div><strong>Generation blocked by design issues</strong>{issues.map((issue) => <span key={issue}>{issue}</span>)}</div></div>}<pre><code>{generated}</code></pre></div>}
      </section>
      <aside className="inspector-panel">
        <div className="panel-title"><span>Properties</span>{selected && <button onClick={() => setSelectedId(null)}><X size={16}/></button>}</div>
        {selected ? <div className="properties"><div className="resource-heading"><span className="palette-icon" style={{ color: colors[selected.data.kind as ResourceKind], background: `${colors[selected.data.kind as ResourceKind]}15` }}>{(() => { const Icon = iconMap[selected.data.kind as ResourceKind]; return <Icon size={22}/> })()}</span><div><strong>{selected.data.label as string}</strong><small>{RESOURCE_LABELS[selected.data.kind as ResourceKind]}</small></div></div>
          <label>Name<input value={selected.data.label as string} onChange={(e) => updateSelected({ label: e.target.value })}/></label>
          {selected.data.kind === 'vnet' && <label>Address spaces<input className={issues.some((issue) => issue.includes(selected.data.label as string)) ? 'invalid' : ''} value={addressSpacesFor(selected as NetworkNode).join(', ')} onChange={(e) => { const ranges = e.target.value.split(',').map((value) => value.trim()).filter(Boolean); updateSelected({ addressSpace: ranges[0] || '', addressSpaces: ranges }) }}/><small>Comma-separated IPv4 CIDRs, e.g. 10.40.0.0/16</small></label>}
          <label>Region<select value={(selected.data.region as string) || 'eastus'} onChange={(e) => updateSelected({ region: e.target.value })}><option>eastus</option><option>eastus2</option><option>westus2</option><option>centralus</option><option>westeurope</option></select></label>
          <label>Resource group<input value={(selected.data.resourceGroup as string) || ''} onChange={(e) => updateSelected({ resourceGroup: e.target.value })}/></label>
          <div className="meta-row"><span>Source</span><strong>{selected.data.imported ? 'Azure subscription' : 'Prototype'}</strong></div>
          <button className="danger" onClick={removeSelected}><Trash2 size={15}/> Remove resource</button>
        </div> : <div className="empty"><Network size={34}/><strong>Select a resource</strong><p>Choose a node to edit its network settings.</p></div>}
        <div className="validation"><div className="validation-title"><ShieldCheck size={16}/><strong>Design validation</strong><span>{issues.length || '✓'}</span></div>{issues.length ? issues.map((issue) => <p key={issue}>{issue}</p>) : <p className="valid">No CIDR conflicts. Topology is exportable.</p>}</div>
      </aside>
    </main>
    {importOpen && <div className="modal-backdrop"><div className="modal"><button className="modal-close" onClick={() => setImportOpen(false)}><X size={18}/></button><div className="modal-icon"><CloudDownload size={24}/></div><h2>Import from Azure</h2><p>Uses your local Azure CLI session with read-only list/show operations. No credentials are stored by this app.</p>{loading && !subscriptions.length ? <div className="loading">Checking Azure CLI session…</div> : subscriptions.length ? <><label>Subscription<select value={subscriptionId} onChange={(e) => setSubscriptionId(e.target.value)}>{subscriptions.map((subscription) => <option key={subscription.id} value={subscription.id}>{subscription.name}{subscription.isDefault ? ' (default)' : ''}</option>)}</select></label><button className="primary wide" disabled={loading} onClick={importTopology}>{loading ? 'Discovering…' : 'Import network topology'}</button></> : <div className="import-error"><strong>Azure CLI is not ready</strong><p>Install <code>az</code> and run <code>az login</code>, then retry. The account needs Reader access.</p><button onClick={openImport}>Retry</button></div>}</div></div>}
  </div>
}

export default function App() { return <ReactFlowProvider><Studio/></ReactFlowProvider> }
