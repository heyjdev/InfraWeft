import { useCallback, useEffect, useMemo, useState } from 'react'
import { addEdge, Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow, type Connection, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Boxes, CircleDot, CloudDownload, Code2, Copy, DoorOpen, Download, Flame, PanelsTopLeft, GitBranch, Globe2, History, Layers3, Menu, Network, Play, Plus, RotateCcw, Router, Save, Search, ShieldCheck, Trash2, WandSparkles, X, Zap } from 'lucide-react'
import './App.css'
import { buildAvnmPlan, defaultAvnmSettings, generateAvnm, type AvnmSettings, type AvnmTopologyChoice } from './avnm'
import { createSnapshot, diffDesign, loadSnapshots, saveSnapshot, type DesignSnapshot } from './designState'
import { generateInfrastructureResult, getExportReport, type ExportFormat } from './generators'
import { ASSOCIATION_LABELS, AZURE_REGIONS, associationKindFor, defaultNodeData, isNetworkDesign, nodesOverlap, RESOURCE_LABELS, RESOURCE_SCHEMAS, starterDesign, validateDesign, type NetworkEdge, type NetworkNode, type NetworkNodeData, type ResourceField, type ResourceKind } from './model'
import { createShowcaseDesign } from './showcaseDesign'

const iconMap: Record<ResourceKind, typeof Network> = { vnet: Network, subnet: Boxes, appGateway: PanelsTopLeft, natGateway: Router, firewall: Flame, vpnGateway: ShieldCheck, loadBalancer: GitBranch, privateEndpoint: CircleDot, frontDoor: DoorOpen, publicIp: CircleDot, networkSecurityGroup: ShieldCheck, routeTable: GitBranch }
const colors: Record<ResourceKind, string> = { vnet: '#0078d4', subnet: '#6b69d6', appGateway: '#8b5cf6', natGateway: '#00a4ef', firewall: '#e15241', vpnGateway: '#107c10', loadBalancer: '#008272', privateEndpoint: '#c239b3', frontDoor: '#0072c6', publicIp: '#1498a4', networkSecurityGroup: '#5c2d91', routeTable: '#ca5010' }
const palette: ResourceKind[] = ['vnet', 'subnet', 'publicIp', 'networkSecurityGroup', 'routeTable', 'natGateway', 'appGateway', 'firewall', 'vpnGateway', 'loadBalancer', 'privateEndpoint', 'frontDoor']
const exportFormatLabels: Record<ExportFormat, string> = { terraform: 'Terraform', bicep: 'Bicep', azureCli: 'Azure CLI' }

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
    const parsed: unknown = JSON.parse(saved)
    return isNetworkDesign(parsed) ? parsed : starterDesign
  } catch { return starterDesign }
}

function loadImportedBaseline() {
  try {
    const saved = localStorage.getItem('azure-network-studio-imported-baseline')
    if (!saved) return null
    const parsed: unknown = JSON.parse(saved)
    return isNetworkDesign(parsed) ? parsed : null
  } catch { return null }
}

function Studio() {
  const { fitView } = useReactFlow()
  const initial = loadInitialDesign()
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes as NetworkNode[])
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges as NetworkEdge[])
  const [designName, setDesignName] = useState(initial.name)
  const [selectedId, setSelectedId] = useState<string | null>('hub')
  const [format, setFormat] = useState<ExportFormat>('terraform')
  const [deploymentModel, setDeploymentModel] = useState<'resources' | 'avnm'>('resources')
  const [avnmSettings, setAvnmSettings] = useState<AvnmSettings>(defaultAvnmSettings)
  const [mode, setMode] = useState<'design' | 'code'>('design')
  const [notice, setNotice] = useState('Ready')
  const [importOpen, setImportOpen] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  const [showcaseOpen, setShowcaseOpen] = useState(false)
  const [showcaseSeed, setShowcaseSeed] = useState('')
  const [subscriptions, setSubscriptions] = useState<Array<{ id: string; name: string; isDefault: boolean }>>([])
  const [subscriptionId, setSubscriptionId] = useState('')
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedField, setSelectedField] = useState<string | null>(null)
  const [baseline, setBaseline] = useState(loadImportedBaseline)
  const [snapshots, setSnapshots] = useState<DesignSnapshot[]>(() => loadSnapshots(localStorage))
  const [historyOpen, setHistoryOpen] = useState(false)
  const [validating, setValidating] = useState(false)
  const [validationResults, setValidationResults] = useState<Array<{ name: string; status: 'passed' | 'failed'; output: string }>>([])
  const selected = nodes.find((node) => node.id === selectedId)
  const selectedParent = selected?.data.kind === 'subnet' ? nodes.find((node) => node.id === selected.data.parentVnetId && node.data.kind === 'vnet') : undefined
  const currentDesign = useMemo(() => ({ name: designName, nodes: nodes as NetworkNode[], edges: edges as NetworkEdge[] }), [designName, nodes, edges])
  const issues = useMemo(() => validateDesign(nodes as NetworkNode[], edges as NetworkEdge[]), [nodes, edges])
  const discoveredSubscription = useMemo(() => [...new Set(nodes.map((node) => String(node.data.subscriptionId || node.id.match(/^\/subscriptions\/([^/]+)/i)?.[1] || '')).filter(Boolean))][0] || '', [nodes])
  const effectiveAvnmSettings = useMemo(() => ({ ...avnmSettings, managerSubscriptionId: avnmSettings.managerSubscriptionId || discoveredSubscription }), [avnmSettings, discoveredSubscription])
  const avnmPlan = useMemo(() => buildAvnmPlan(currentDesign, effectiveAvnmSettings), [currentDesign, effectiveAvnmSettings])
  const exportReport = useMemo(() => getExportReport(nodes as NetworkNode[], edges as NetworkEdge[], format), [nodes, edges, format])
  const exporterBlockerGroups = useMemo(() => {
    const groups = new Map<string, typeof exportReport.unsupported>()
    for (const diagnostic of exportReport.unsupported) groups.set(diagnostic.reason, [...(groups.get(diagnostic.reason) ?? []), diagnostic])
    return [...groups.entries()]
  }, [exportReport.unsupported])
  const standardGeneratedResult = useMemo(() => generateInfrastructureResult(nodes as NetworkNode[], edges as NetworkEdge[], format), [nodes, edges, format])
  const generatedResult = useMemo(() => deploymentModel === 'avnm' ? { text: generateAvnm(avnmPlan, format), mappings: [] } : standardGeneratedResult, [deploymentModel, avnmPlan, format, standardGeneratedResult])
  const generated = generatedResult.text
  const deploymentIssues = deploymentModel === 'avnm'
    ? [...avnmPlan.errors, ...(format === 'terraform' && avnmPlan.removedDeploymentRegions.length ? [`Terraform cannot safely clear removed AVNM regions without the prior deployment resources in state. Use Azure CLI output for: ${avnmPlan.removedDeploymentRegions.join(', ')}.`] : [])]
    : issues
  const unsupportedCount = deploymentModel === 'avnm' ? 0 : exportReport.unsupported.length
  const canExport = deploymentIssues.length === 0 && unsupportedCount === 0
  const designDiff = useMemo(() => diffDesign(baseline, currentDesign), [baseline, currentDesign])
  const displayedNodes = useMemo(() => nodes.map((node) => ({ ...node, className: baseline ? `diff-${designDiff.byNodeId.get(node.id)?.status ?? 'created'}` : '' })), [nodes, baseline, designDiff])
  const activeMapping = useMemo(() => {
    if (!selectedId) return undefined
    return generatedResult.mappings.find((mapping) => mapping.nodeId === selectedId && mapping.field === selectedField)
      ?? generatedResult.mappings.find((mapping) => mapping.nodeId === selectedId && !mapping.field)
  }, [generatedResult, selectedId, selectedField])
  const targetSubscription = deploymentModel === 'avnm' ? effectiveAvnmSettings.managerSubscriptionId || 'Set manager subscription at deployment' : [...new Set(nodes.map((node) => node.data.subscriptionId).filter(Boolean))].join(', ') || 'Set explicitly at deployment'

  useEffect(() => { if (!notice || notice === 'Ready') return; const timer = setTimeout(() => setNotice('Ready'), 4000); return () => clearTimeout(timer) }, [notice])
  useEffect(() => {
    if (mode !== 'code' || !activeMapping) return
    document.getElementById(`code-line-${activeMapping.startLine}`)?.scrollIntoView({ block: 'center' })
  }, [mode, format, activeMapping])

  const selectTrace = (nodeId: string, field: string | null = null) => { setSelectedId(nodeId); setSelectedField(field) }
  const focusField = (path: string) => setSelectedField(path.split('.')[0])
  const updateAvnm = (patch: Partial<AvnmSettings>) => { setAvnmSettings((current) => ({ ...current, ...patch })); setValidationResults([]) }

  const onConnect = useCallback((connection: Connection) => {
    const source = nodes.find((node) => node.id === connection.source); const target = nodes.find((node) => node.id === connection.target)
    if (!source || !target || source.id === target.id) return
    const peering = source.data.kind === 'vnet' && target.data.kind === 'vnet'
    const association = associationKindFor(source.data.kind, target.data.kind)
    const duplicatePeering = peering && edges.some((edge) => edge.data?.kind === 'peering' && [edge.source, edge.target].sort().join('|') === [source.id, target.id].sort().join('|'))
    if (duplicatePeering) { setNotice('Blocked: these VNets are already peered'); return }
    if (peering && nodesOverlap(source as NetworkNode, target as NetworkNode)) { setNotice(`Blocked: ${source.data.label} overlaps ${target.data.label}`); return }
    if (association && edges.some((edge) => edge.data?.kind === association && [edge.source, edge.target].sort().join('|') === [source.id, target.id].sort().join('|'))) { setNotice(`Blocked: ${ASSOCIATION_LABELS[association]} already exists`); return }
    const guardedKinds: ResourceKind[] = ['publicIp', 'networkSecurityGroup', 'routeTable']
    if (!peering && !association && (guardedKinds.includes(source.data.kind) || guardedKinds.includes(target.data.kind))) { setNotice(`Blocked: no typed association is modeled for ${RESOURCE_LABELS[source.data.kind]} and ${RESOURCE_LABELS[target.data.kind]}`); return }
    const kind = peering ? 'peering' : association ?? 'attachment'
    setEdges((current) => addEdge({ ...connection, id: crypto.randomUUID(), type: 'smoothstep', animated: peering, label: peering ? 'VNet peering' : association ? ASSOCIATION_LABELS[association] : undefined, markerEnd: { type: MarkerType.ArrowClosed }, data: { kind } }, current))
    setNotice(peering ? 'Peering created' : association ? `${ASSOCIATION_LABELS[association]} created` : 'Resource attached')
  }, [nodes, edges, setEdges])

  function addResource(kind: ResourceKind) {
    const count = nodes.filter((node) => node.data.kind === kind).length + 1
    const node: NetworkNode = { id: crypto.randomUUID(), type: 'azureResource', position: { x: 180 + (nodes.length % 4) * 160, y: 130 + (nodes.length % 3) * 150 }, data: defaultNodeData(kind, count) }
    setNodes((current) => [...current, node]); setSelectedId(node.id); setNotice(`${RESOURCE_LABELS[kind]} added`)
  }

  function updateSelected(patch: Partial<NetworkNodeData>) { setNodes((current) => current.map((node) => node.id === selectedId ? { ...node, data: { ...node.data, ...patch } } : node)) }
  function removeSelected() { if (!selectedId) return; setNodes((current) => current.filter((node) => node.id !== selectedId)); setEdges((current) => current.filter((edge) => edge.source !== selectedId && edge.target !== selectedId)); setSelectedId(null); setNotice('Resource removed') }
  function save() {
    localStorage.setItem('azure-network-studio-design', JSON.stringify(currentDesign))
    const snapshot = createSnapshot(currentDesign, `Snapshot ${new Date().toLocaleString()}`)
    saveSnapshot(localStorage, snapshot)
    setSnapshots(loadSnapshots(localStorage))
    setNotice('Design snapshot saved locally')
  }
  function restoreSnapshot(snapshot: DesignSnapshot) {
    setNodes(snapshot.design.nodes); setEdges(snapshot.design.edges); setDesignName(snapshot.design.name); setSelectedId(null)
    localStorage.setItem('azure-network-studio-design', JSON.stringify(snapshot.design))
    setHistoryOpen(false); setNotice(`Restored ${snapshot.name}`)
  }
  function adoptImportedDesign() {
    setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, imported: false } })))
    setNotice('Imported baseline retained; desired resources are now manageable')
  }
  function clearDesign() {
    setNodes([]); setEdges([]); setDesignName('Cleared design'); setSelectedId(null); setBaseline(null)
    localStorage.setItem('azure-network-studio-design', JSON.stringify({ name: 'Cleared design', nodes: [], edges: [] }))
    localStorage.removeItem('azure-network-studio-imported-baseline')
    setClearOpen(false); setNotice('Design cleared')
  }
  function openShowcase() {
    setShowcaseSeed(crypto.randomUUID().slice(0, 8))
    setShowcaseOpen(true)
  }
  function replaceWithShowcase() {
    const result = createShowcaseDesign(showcaseSeed.trim() || undefined)
    if (currentDesign.nodes.length > 0 || currentDesign.edges.length > 0) {
      saveSnapshot(localStorage, createSnapshot(currentDesign, `Before Random showcase · ${result.seed}`))
      setSnapshots(loadSnapshots(localStorage))
    }
    setNodes(result.design.nodes); setEdges(result.design.edges); setDesignName(result.design.name)
    setSelectedId(result.design.nodes.find((node) => node.data.kind === 'vnet')?.id ?? result.design.nodes[0]?.id ?? null)
    setSelectedField(null); setBaseline(null); setMode('design')
    localStorage.removeItem('azure-network-studio-imported-baseline')
    localStorage.setItem('azure-network-studio-design', JSON.stringify(result.design))
    setShowcaseOpen(false); setNotice(`Random showcase ready · seed ${result.seed}`)
    requestAnimationFrame(() => requestAnimationFrame(() => void fitView({ padding: 0.12, duration: 350, maxZoom: 0.85 })))
  }
  function download() { const blob = new Blob([generated], { type: 'text/plain' }); const href = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = href; a.download = `${deploymentModel === 'avnm' ? 'avnm-connectivity' : 'network'}.${format === 'terraform' ? 'tf' : format === 'bicep' ? 'bicep' : 'sh'}`; a.click(); URL.revokeObjectURL(href) }
  async function copyCode() { await navigator.clipboard.writeText(generated); setNotice('Code copied') }
  async function validateGenerated() {
    if (!canExport) return
    setValidating(true); setValidationResults([])
    try {
      const response = await fetch('/api/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ format, code: generated }) })
      const body: unknown = await response.json()
      if (body && typeof body === 'object' && 'results' in body && Array.isArray(body.results)) setValidationResults(body.results as Array<{ name: string; status: 'passed' | 'failed'; output: string }>)
      else throw new Error(body && typeof body === 'object' && 'error' in body ? String(body.error) : 'Local validation failed')
      setNotice(response.ok ? 'Generated artifact validated locally' : 'Validation found an error')
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Local validation unavailable') }
    finally { setValidating(false) }
  }

  const fieldVisible = (field: ResourceField, values: Record<string, unknown>) => {
    const condition = field.visibleWhen
    if (!condition) return true
    const actual = values[condition.key]
    if ('equals' in condition && actual !== condition.equals) return false
    if ('notEquals' in condition && actual === condition.notEquals) return false
    if ('includes' in condition && !String(actual ?? '').includes(String(condition.includes))) return false
    return true
  }

  const emptyBlock = (fields: ResourceField[]) => fields.reduce<Record<string, unknown>>((result, field) => {
    if (field.type === 'boolean') result[String(field.key)] = false
    else if (field.type === 'stringList' || field.type === 'cidrList' || (field.type === 'block' && field.repeatable)) result[String(field.key)] = []
    else if (field.type === 'select' && field.options?.length) result[String(field.key)] = field.options[0]
    return result
  }, {})

  function renderField(field: ResourceField, values: Record<string, unknown> = selected?.data as Record<string, unknown>, setValues: (next: Record<string, unknown>) => void = (next) => updateSelected(next), path = String(field.key)): React.ReactNode {
    if (!selected || !fieldVisible(field, values)) return null
    const key = String(field.key)
    const raw = values[key]
    const change = (value: unknown) => setValues({ [key]: value })
    if (field.type === 'block') {
      const childFields = field.fields ?? []
      const legacySingleton = key === 'sku' && typeof raw === 'string' ? { name: raw, tier: raw, ...(selected.data.capacity !== undefined ? { capacity: selected.data.capacity } : {}) } : undefined
      const records = field.repeatable ? (Array.isArray(raw) ? raw as Record<string, unknown>[] : []) : (raw && typeof raw === 'object' && !Array.isArray(raw) ? [raw as Record<string, unknown>] : legacySingleton ? [legacySingleton] : [])
      const add = () => change(field.repeatable ? [...records, emptyBlock(childFields)] : emptyBlock(childFields))
      const remove = (index: number) => change(field.repeatable ? records.filter((_, itemIndex) => itemIndex !== index) : undefined)
      const atLimit = field.maxItems !== undefined && records.length >= field.maxItems
      return <div className="block-editor" key={path} onFocusCapture={() => focusField(path)}>
        <div className="block-heading"><div><strong>{field.label}{field.required && ' *'}</strong>{field.help && <small>{field.help}</small>}</div><button type="button" aria-label={field.repeatable ? `Add another ${field.label}` : records.length ? `Reset ${field.label}` : `Configure ${field.label}`} disabled={atLimit} onClick={add}><Plus size={13} aria-hidden="true"/>{field.repeatable ? 'Add' : records.length ? 'Reset' : 'Configure'}</button></div>
        {records.map((record, index) => <article className="block-card" key={`${path}-${index}`} aria-labelledby={`${path}-${index}-title`}><div className="block-card-title"><span id={`${path}-${index}-title`}>{field.repeatable ? `${field.label} ${index + 1}` : field.label}</span><button type="button" aria-label={`Remove ${field.label} ${index + 1}`} onClick={() => remove(index)}><X size={13} aria-hidden="true"/></button></div>{childFields.map((child) => renderField(child, record, (patch) => {
          const next = { ...record, ...patch }
          if (field.repeatable) change(records.map((item, itemIndex) => itemIndex === index ? next : item))
          else change(next)
        }, `${path}.${index}.${String(child.key)}`))}</article>)}
        {field.minItems !== undefined && <small>Terraform cardinality: {field.minItems}–{field.maxItems ?? 'many'} block(s).</small>}
      </div>
    }
    if (field.type === 'resourceRef') {
      const options = nodes.filter((node) => node.data.kind === field.resourceKind && node.id !== selected.id)
      return <label key={path} onFocus={() => focusField(path)}>{field.label}{field.required && ' *'}<select disabled={field.readOnly} value={String(raw || '')} onChange={(event) => change(event.target.value)}><option value="">Select…</option>{options.map((node) => <option key={node.id} value={node.id}>{node.data.label as string}</option>)}</select>{field.help && <small>{field.help}</small>}</label>
    }
    if (field.type === 'select') return <label key={path} onFocus={() => focusField(path)}>{field.label}{field.required && ' *'}<select disabled={field.readOnly} value={String(raw ?? '')} onChange={(event) => change(event.target.value)}>{field.options?.map((option) => <option key={option} value={option}>{option || 'Not set'}</option>)}</select>{field.help && <small>{field.help}</small>}</label>
    if (field.type === 'boolean') return <label key={path} className="check-field" onFocus={() => focusField(path)}><input disabled={field.readOnly} type="checkbox" checked={Boolean(raw)} onChange={(event) => change(event.target.checked)}/><span>{field.label}</span>{field.help && <small>{field.help}</small>}</label>
    const textValue = field.type === 'cidrList' || field.type === 'stringList' ? (Array.isArray(raw) ? raw : []).join(', ') : String(raw ?? '')
    return <label key={path} onFocus={() => focusField(path)}>{field.label}{field.required && ' *'}<input disabled={field.readOnly} min={field.min} max={field.max} step={field.step} type={field.type === 'number' ? 'number' : field.type === 'password' ? 'password' : 'text'} value={textValue} onChange={(event) => {
      if (field.type === 'cidrList' || field.type === 'stringList') {
        const items = event.target.value.split(',').map((value) => value.trim()).filter(Boolean)
        setValues({ [key]: items, ...(key === 'addressSpaces' ? { addressSpace: items[0] || '' } : {}) }); return
      }
      if (field.type === 'number') { change(event.target.value === '' ? undefined : Number(event.target.value)); return }
      change(event.target.value)
    }}/>{field.help && <small>{field.help}</small>}{(field.min !== undefined || field.max !== undefined) && <small>Allowed: {field.min ?? 'unbounded'}–{field.max ?? 'unbounded'}{field.step === 1 ? ', whole numbers' : ''}.</small>}</label>
  }

  async function openImport() {
    setImportOpen(true); setLoading(true)
    try { const response = await fetch('/api/azure/subscriptions'); const body = await response.json(); if (!response.ok) throw new Error(body.error); setSubscriptions(body.subscriptions); setSubscriptionId(body.subscriptions.find((item: any) => item.isDefault)?.id || body.subscriptions[0]?.id || '') }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Azure discovery unavailable') } finally { setLoading(false) }
  }
  async function importTopology() {
    if (!subscriptionId) return; setLoading(true)
    try { const response = await fetch(`/api/azure/topology?subscriptionId=${encodeURIComponent(subscriptionId)}`); const body: unknown = await response.json(); if (!response.ok) throw new Error((body as { error?: string }).error); const warningCount = body && typeof body === 'object' && 'warnings' in body && Array.isArray(body.warnings) ? body.warnings.length : 0; if (!isNetworkDesign(body)) throw new Error('Azure discovery returned an invalid topology.'); setNodes(body.nodes); setEdges(body.edges); setDesignName(body.name); setBaseline(body); localStorage.setItem('azure-network-studio-imported-baseline', JSON.stringify(body)); localStorage.setItem('azure-network-studio-design', JSON.stringify(body)); setSelectedId(null); setImportOpen(false); setNotice(`Imported ${body.nodes.length} Azure resources${warningCount ? ` with ${warningCount} warning${warningCount > 1 ? 's' : ''}` : ''}`) }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Import failed') } finally { setLoading(false) }
  }

  const visiblePalette = palette.filter((kind) => RESOURCE_LABELS[kind].toLowerCase().includes(query.toLowerCase()))

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><Network size={21} /></div><div><strong>Azure Network Studio</strong><span>Visual infrastructure designer</span></div></div>
      <nav><button className={mode === 'design' ? 'active' : ''} onClick={() => setMode('design')}><WandSparkles size={15}/> Design</button><button className={mode === 'code' ? 'active' : ''} onClick={() => setMode('code')}><Code2 size={15}/> Generate</button></nav>
      <div className="top-actions"><span className={`status ${issues.length ? 'warning' : ''}`}>{issues.length ? `${issues.length} issue${issues.length > 1 ? 's' : ''}` : notice}</span><button className="showcase-action" onClick={openShowcase}><WandSparkles size={16}/> Random showcase</button><button className="ghost clear-action" onClick={() => setClearOpen(true)} disabled={!nodes.length && !edges.length}><Trash2 size={16}/> Clear</button><button className="ghost" onClick={() => setHistoryOpen(true)}><History size={16}/> History</button><button className="ghost" onClick={save}><Save size={16}/> Snapshot</button><button className="primary" onClick={openImport}><CloudDownload size={16}/> Import Azure</button></div>
    </header>
    <main>
      <aside className="palette-panel">
        <div className="panel-title"><span>Components</span><button title="Collapse"><Menu size={16}/></button></div>
        <label className="search"><Search size={15}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a resource"/></label>
        <div className="palette-list">{visiblePalette.map((kind) => { const Icon = iconMap[kind]; const supportedCount = Object.values(RESOURCE_SCHEMAS[kind].export).filter((item) => item.status === 'supported').length; return <button key={kind} onClick={() => addResource(kind)} title={RESOURCE_SCHEMAS[kind].description}><span className="palette-icon" style={{ color: colors[kind], background: `${colors[kind]}15` }}><Icon size={20}/></span><span><strong>{RESOURCE_LABELS[kind]}</strong><small>{supportedCount}/3 exporters supported</small></span><Plus size={15} className="add-icon"/></button> })}</div>
        <div className="hint"><Zap size={16}/><div><strong>Quick connect</strong><p>Drag between node handles. Overlapping VNets are blocked.</p></div></div>
      </aside>
      <section className="workspace">
        <div className="workspace-bar"><div><Globe2 size={15}/><strong>{currentDesign.name}</strong><span>eastus</span></div>{baseline && <div className="diff-summary" title="Changes from imported Azure baseline"><span className="created">+{designDiff.summary.created}</span><span className="modified">~{designDiff.summary.modified}</span><span className="deleted">−{designDiff.summary.deleted}</span><span>{designDiff.summary.unchanged} unchanged</span>{nodes.some((node) => node.data.imported) && <button onClick={adoptImportedDesign}>Adopt for management</button>}</div>}<div className="legend"><span><i className="dot imported"/> Imported</span><span><i className="line"/> Peering</span></div></div>
        {mode === 'design' ? <ReactFlow nodes={displayedNodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} nodeTypes={nodeTypes} onNodeClick={(_, node) => setSelectedId(node.id)} onPaneClick={() => setSelectedId(null)} fitView minZoom={0.25} maxZoom={1.8} deleteKeyCode={null}>
          <Background color="#dce6f1" gap={24}/><MiniMap nodeColor={(node) => colors[(node.data as NetworkNodeData).kind]} maskColor="rgba(241,246,251,.72)"/><Controls position="bottom-center" />
        </ReactFlow> : <div className="code-workspace">
          <div className="code-toolbar"><div className="code-toolbar-modes"><div className="segment deployment-segment"><button className={deploymentModel === 'resources' ? 'active' : ''} onClick={() => { setDeploymentModel('resources'); setValidationResults([]) }}><Boxes size={14}/> Resources</button><button className={deploymentModel === 'avnm' ? 'active' : ''} onClick={() => { setDeploymentModel('avnm'); setValidationResults([]) }}><Layers3 size={14}/> AVNM</button></div><div className="segment">{(['terraform','bicep','azureCli'] as ExportFormat[]).map((item) => <button key={item} className={format === item ? 'active' : ''} onClick={() => { setFormat(item); setValidationResults([]) }}>{item === 'azureCli' ? 'Azure CLI' : item[0].toUpperCase() + item.slice(1)}</button>)}</div></div><div><button disabled={validating || !canExport} onClick={validateGenerated}><Play size={15}/> {validating ? 'Validating…' : 'Validate'}</button><button disabled={!canExport} onClick={copyCode}><Copy size={15}/> Copy</button><button disabled={!canExport} className="primary" onClick={download}><Download size={15}/> Download</button></div></div>
          <div className="code-target"><span>{deploymentModel === 'avnm' ? 'AVNM manager subscription' : 'Target subscription'}</span><strong>{targetSubscription}</strong><span className="export-count">{deploymentModel === 'avnm' ? `${avnmPlan.members.length} static member${avnmPlan.members.length === 1 ? '' : 's'} · ${avnmPlan.topology || 'conversion required'}` : `${exportReport.supported.length}/${nodes.length} resources supported`}</span></div>
          {deploymentModel === 'avnm' && <section className="avnm-config-panel"><div className="avnm-config-heading"><span><Layers3 size={18}/><span><strong>Azure Virtual Network Manager conversion</strong><small>Manager dedicated to this deployment required · static VNet membership · complete regional goal-state commit</small></span></span><b className={avnmPlan.errors.length ? 'warning' : 'ready'}>{avnmPlan.errors.length ? 'Needs input' : `${avnmPlan.topology} ready`}</b></div><div className="avnm-config-grid"><label>Topology<select value={avnmSettings.topology} onChange={(event) => updateAvnm({ topology: event.target.value as AvnmTopologyChoice })}><option value="auto">Auto-detect exact topology</option><option value="Mesh">Mesh</option><option value="HubAndSpoke">Hub and spoke</option></select></label>{avnmPlan.topology === 'HubAndSpoke' && <label>Hub VNet<select value={avnmPlan.hub?.id || ''} onChange={(event) => updateAvnm({ topology: 'HubAndSpoke', hubVnetId: event.target.value })}><option value="">Select a hub</option>{avnmPlan.vnets.map((node) => <option key={node.id} value={node.id}>{node.data.label}</option>)}</select></label>}<label>Existing Network Manager name<input value={avnmSettings.networkManagerName} onChange={(event) => updateAvnm({ networkManagerName: event.target.value })}/></label><label>Existing manager resource group<input value={avnmSettings.managerResourceGroup} onChange={(event) => updateAvnm({ managerResourceGroup: event.target.value })}/></label><label>Fallback deployment region<select value={avnmSettings.managerLocation} onChange={(event) => updateAvnm({ managerLocation: event.target.value })}>{AZURE_REGIONS.map((region) => <option key={region}>{region}</option>)}</select></label><label>Manager subscription ID<input placeholder="Inferred from design when available" value={avnmSettings.managerSubscriptionId} onChange={(event) => updateAvnm({ managerSubscriptionId: event.target.value.trim() })}/></label><label>Network group prefix<input value={avnmSettings.networkGroupName} onChange={(event) => updateAvnm({ networkGroupName: event.target.value })}/></label><label>Connectivity configuration prefix<input value={avnmSettings.connectivityConfigurationName} onChange={(event) => updateAvnm({ connectivityConfigurationName: event.target.value })}/></label><label className="wide">Deployment regions<input placeholder="Auto from VNet regions" value={avnmSettings.deploymentRegions.join(', ')} onChange={(event) => updateAvnm({ deploymentRegions: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) })}/><small>Comma-separated. Blank uses every VNet region.</small></label><label className="wide">Previously committed regions<input placeholder="Only needed when removing a region" value={avnmSettings.previousDeploymentRegions.join(', ')} onChange={(event) => { const previousDeploymentRegions = event.target.value.split(',').map((value) => value.trim()).filter(Boolean); updateAvnm({ previousDeploymentRegions, confirmInitialDeployment: previousDeploymentRegions.length ? false : avnmSettings.confirmInitialDeployment }) }}/><small>Regions present in the previous commit. Removed entries receive an explicit empty commit.</small></label></div><div className="avnm-option-row">{avnmPlan.topology === 'HubAndSpoke' && <label><input type="checkbox" checked={avnmSettings.directSpokeConnectivity} onChange={(event) => updateAvnm({ directSpokeConnectivity: event.target.checked })}/> Direct spoke connectivity</label>}<label><input type="checkbox" checked={avnmSettings.globalMesh} onChange={(event) => updateAvnm({ globalMesh: event.target.checked })}/> Global mesh</label>{avnmPlan.topology === 'HubAndSpoke' && <label><input type="checkbox" checked={avnmSettings.useHubGateway} onChange={(event) => updateAvnm({ useHubGateway: event.target.checked })}/> Use hub gateway</label>}<label className="danger-option"><input type="checkbox" checked={avnmSettings.deleteExistingPeerings} onChange={(event) => updateAvnm({ deleteExistingPeerings: event.target.checked })}/> Delete existing peerings during commit</label><label className="dedicated-option"><input type="checkbox" checked={avnmSettings.confirmDedicatedManager} onChange={(event) => updateAvnm({ confirmDedicatedManager: event.target.checked })}/> I confirm this manager is dedicated to this generated AVNM deployment</label><label className="dedicated-option"><input type="checkbox" disabled={avnmSettings.previousDeploymentRegions.length > 0} checked={avnmSettings.confirmInitialDeployment} onChange={(event) => updateAvnm({ confirmInitialDeployment: event.target.checked })}/> I confirm this is the initial deployment with no previously committed regions</label></div>{avnmPlan.warnings.length > 0 && <div className="avnm-warnings">{avnmPlan.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div>}</section>}
          {!canExport && <div className="validation-banner"><ShieldCheck size={17} aria-hidden="true"/><div><strong>{deploymentModel === 'avnm' ? 'AVNM conversion needs input — validate/copy/download disabled' : 'Export is incomplete — validate/copy/download disabled'}</strong>{deploymentIssues.length > 0 && <div className="design-issue-list" aria-label="Deployment validation issues">{deploymentIssues.map((issue) => <span key={issue}>{issue}</span>)}</div>}{deploymentModel === 'resources' && exportReport.unsupported.length > 0 && <details key={format} className="export-blockers"><summary><span>{exportReport.unsupported.length} resource{exportReport.unsupported.length === 1 ? '' : 's'} block {exportFormatLabels[format]} export</span><small>View diagnostics</small></summary><div className="export-blocker-groups">{exporterBlockerGroups.map(([reason, diagnostics]) => <section key={reason}><h3>{reason}</h3>{diagnostics.map(({ node }) => <button type="button" key={node.id} aria-label={`${node.data.label as string}: ${reason}`} onClick={() => selectTrace(node.id)}><b>{node.data.label as string}</b><span>{RESOURCE_LABELS[node.data.kind]}</span></button>)}</section>)}</div></details>}</div></div>}
          {validationResults.length > 0 && <div className="local-validation-results"><strong>Local validation</strong>{validationResults.map((result) => <div key={result.name} className={result.status}><span>{result.status === 'passed' ? '✓' : '×'} {result.name}</span><code>{result.output}</code></div>)}</div>}
          <div className="code-list" role="code" aria-label={`${format} generated code`}>{generated.split('\n').map((line, index) => {
            const lineNumber = index + 1
            const owner = generatedResult.mappings.find((mapping) => !mapping.field && lineNumber >= mapping.startLine && lineNumber <= mapping.endLine)
            const highlighted = activeMapping && lineNumber >= activeMapping.startLine && lineNumber <= activeMapping.endLine
            return <div id={`code-line-${lineNumber}`} key={lineNumber} className={`code-line${highlighted ? ` highlighted ${activeMapping.kind}` : ''}${owner ? ' mapped' : ''}`} onClick={() => owner && selectTrace(owner.nodeId)}>
              <span className="line-number" aria-hidden="true">{lineNumber}</span><code>{line || ' '}</code>
            </div>
          })}</div>
        </div>}
      </section>
      <aside className="inspector-panel">
        <div className="panel-title"><span>Properties</span>{selected && <button onClick={() => setSelectedId(null)}><X size={16}/></button>}</div>
        {selected ? <div className="properties"><section className="property-overview"><div className="resource-heading"><span className="palette-icon" style={{ color: colors[selected.data.kind as ResourceKind], background: `${colors[selected.data.kind as ResourceKind]}15` }}>{(() => { const Icon = iconMap[selected.data.kind as ResourceKind]; return <Icon size={22}/> })()}</span><div><strong>{selected.data.label as string}</strong><small>{RESOURCE_LABELS[selected.data.kind as ResourceKind]}</small></div></div>
          {activeMapping && <button type="button" className={`trace-link ${activeMapping.kind}`} onClick={() => setMode('code')}><Code2 size={13}/>{activeMapping.kind === 'diagnostic' ? 'View export diagnostic' : `View generated line${activeMapping.startLine === activeMapping.endLine ? '' : 's'} ${activeMapping.startLine}${activeMapping.startLine === activeMapping.endLine ? '' : `–${activeMapping.endLine}`}`}</button>}
          <label onFocus={() => focusField('label')}>Name<input value={selected.data.label as string} onChange={(e) => updateSelected({ label: e.target.value })}/></label>
          <p className="schema-description">{RESOURCE_SCHEMAS[selected.data.kind as ResourceKind].description}</p></section>
          {[...new Set(RESOURCE_SCHEMAS[selected.data.kind as ResourceKind].fields.map((field) => field.section || 'Configuration'))].map((section) => <section className="property-section" key={section}><div className="property-section-heading"><h3>{section}</h3><span>{RESOURCE_SCHEMAS[selected.data.kind as ResourceKind].fields.filter((field) => (field.section || 'Configuration') === section).length} field{RESOURCE_SCHEMAS[selected.data.kind as ResourceKind].fields.filter((field) => (field.section || 'Configuration') === section).length === 1 ? '' : 's'}</span></div><div className="property-section-fields">{RESOURCE_SCHEMAS[selected.data.kind as ResourceKind].fields.filter((field) => (field.section || 'Configuration') === section).map((field) => renderField(field))}</div></section>)}
          <section className="property-section"><div className="property-section-heading"><h3>Deployment</h3><span>2 fields</span></div><div className="property-section-fields">
          {selected.data.kind === 'frontDoor' ? <label onFocus={() => focusField('region')}>Scope<input value="global" disabled/><small>AzureRM Front Door profiles do not have a location argument.</small></label> : selected.data.kind === 'subnet' ? <label onFocus={() => focusField('region')}>Region (inherited)<input value={String(selectedParent?.data.region || 'Select a parent VNet')} disabled/></label> : <label onFocus={() => focusField('region')}>Region<select value={(selected.data.region as string) || 'eastus'} onChange={(e) => updateSelected({ region: e.target.value })}>{AZURE_REGIONS.map((region) => <option key={region}>{region}</option>)}</select></label>}
          {selected.data.kind === 'subnet' ? <label onFocus={() => focusField('resourceGroup')}>Resource group (inherited)<input value={String(selectedParent?.data.resourceGroup || 'Select a parent VNet')} disabled/></label> : <label onFocus={() => focusField('resourceGroup')}>Resource group<input value={(selected.data.resourceGroup as string) || ''} onChange={(e) => updateSelected({ resourceGroup: e.target.value })}/></label>}</div></section>
          <div className="capability-list"><strong>Export capability</strong>{(['terraform', 'bicep', 'azureCli'] as ExportFormat[]).map((target) => { const capability = RESOURCE_SCHEMAS[selected.data.kind as ResourceKind].export[target]; return <div key={target} className={capability.status}><span>{target === 'azureCli' ? 'Azure CLI' : target}</span><b>{capability.status}</b><small>{capability.summary}</small></div> })}<div className="meta-row"><span>Source</span><strong>{selected.data.imported ? 'Azure subscription' : 'Prototype'}</strong></div></div>
          <button className="danger" onClick={removeSelected}><Trash2 size={15}/> Remove resource</button>
        </div> : <div className="empty"><Network size={34}/><strong>Select a resource</strong><p>Choose a node to edit its network settings.</p></div>}
        <div className="validation"><div className="validation-title"><ShieldCheck size={16}/><strong>Design validation</strong><span>{issues.length || '✓'}</span></div>{issues.length ? issues.map((issue) => <p key={issue}>{issue}</p>) : <p className="valid">No invalid or overlapping peering relationships. Topology is exportable.</p>}</div>
      </aside>
    </main>
    {importOpen && <div className="modal-backdrop"><div className="modal"><button className="modal-close" onClick={() => setImportOpen(false)}><X size={18}/></button><div className="modal-icon"><CloudDownload size={24}/></div><h2>Import from Azure</h2><p>Uses your local Azure CLI session with read-only list/show operations. No credentials are stored by this app.</p>{loading && !subscriptions.length ? <div className="loading">Checking Azure CLI session…</div> : subscriptions.length ? <><label>Subscription<select value={subscriptionId} onChange={(e) => setSubscriptionId(e.target.value)}>{subscriptions.map((subscription) => <option key={subscription.id} value={subscription.id}>{subscription.name}{subscription.isDefault ? ' (default)' : ''}</option>)}</select></label><button className="primary wide" disabled={loading} onClick={importTopology}>{loading ? 'Discovering…' : 'Import network topology'}</button></> : <div className="import-error"><strong>Azure CLI is not ready</strong><p>Install <code>az</code> and run <code>az login</code>, then retry. The account needs Reader access.</p><button onClick={openImport}>Retry</button></div>}</div></div>}
    {historyOpen && <div className="modal-backdrop"><div className="modal history-modal"><button className="modal-close" aria-label="Close" onClick={() => setHistoryOpen(false)}><X size={18}/></button><div className="modal-icon"><History size={24}/></div><h2>Local design history</h2><p>Snapshots stay in this browser. Restoring one changes the editable design but never deploys infrastructure.</p>{baseline && <div className="baseline-summary"><strong>Imported Azure baseline</strong><span>{designDiff.summary.created} created · {designDiff.summary.modified} modified · {designDiff.summary.deleted} deleted</span>{designDiff.deleted.map((item) => <small key={item.node.id}>Deleted: {item.node.data.label}</small>)}</div>}<div className="snapshot-list">{snapshots.length ? snapshots.map((snapshot) => <div key={snapshot.id}><span><strong>{snapshot.name}</strong><small>{new Date(snapshot.createdAt).toLocaleString()} · AzureRM {snapshot.azureRmVersion} · {snapshot.design.nodes.length} resources</small></span><button onClick={() => restoreSnapshot(snapshot)}><RotateCcw size={14}/> Restore</button></div>) : <p>No snapshots yet. Use Snapshot in the header.</p>}</div></div></div>}
    {clearOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setClearOpen(false) }}><div className="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="clear-title"><button className="modal-close" aria-label="Close" onClick={() => setClearOpen(false)}><X size={18}/></button><div className="modal-icon danger-icon"><Trash2 size={24}/></div><h2 id="clear-title">Are you sure?</h2><p>This will remove every resource and connection from the page. This cannot be undone.</p><div className="modal-actions"><button onClick={() => setClearOpen(false)}>Cancel</button><button className="confirm-danger" onClick={clearDesign}>Clear page</button></div></div></div>}
    {showcaseOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowcaseOpen(false) }}><div className="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="showcase-title"><button className="modal-close" aria-label="Close" onClick={() => setShowcaseOpen(false)}><X size={18}/></button><div className="modal-icon"><WandSparkles size={24}/></div><h2 id="showcase-title">Replace with Random showcase?</h2><p>This replaces the canvas with a validated hub-and-spoke example containing every resource icon. A nonempty current design is snapshotted first. Unsupported resource exporters will remain blocked.</p><label>Reproducible seed<input value={showcaseSeed} onChange={(event) => setShowcaseSeed(event.target.value)} autoFocus/><small>Reuse this seed to generate the exact same design.</small></label><div className="modal-actions"><button onClick={() => setShowcaseOpen(false)}>Cancel</button><button className="primary" onClick={replaceWithShowcase}>Replace canvas</button></div></div></div>}
  </div>
}

export default function App() { return <ReactFlowProvider><Studio/></ReactFlowProvider> }
