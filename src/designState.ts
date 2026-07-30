import { isNetworkDesign, type NetworkDesign, type NetworkNode } from './model'

export type ResourceDiffStatus = 'created' | 'modified' | 'deleted' | 'unchanged'
export type ResourceDiff = { status: ResourceDiffStatus; node: NetworkNode; baseline?: NetworkNode; changedFields: string[] }
export type DesignDiff = {
  byNodeId: Map<string, ResourceDiff>
  deleted: ResourceDiff[]
  summary: Record<ResourceDiffStatus, number>
}

export type DesignSnapshot = {
  id: string
  name: string
  createdAt: string
  schemaVersion: 1
  azureRmVersion: '4.81.0'
  generatorVersion: '0.1.0'
  design: NetworkDesign
}

export type DesignStorage = Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>
export const BLANK_DESIGN: NetworkDesign = { name: 'Untitled design', nodes: [], edges: [] }
export const SNAPSHOT_STORAGE_KEY = 'infraweft-snapshots'
export const CURRENT_DESIGN_STORAGE_KEY = 'infraweft-design'
export const LEGACY_SNAPSHOT_STORAGE_KEY = 'azure-network-studio-snapshots'
export const LEGACY_CURRENT_DESIGN_STORAGE_KEY = 'azure-network-studio-design'
const MAX_SNAPSHOTS = 20
const SENSITIVE_KEY = /(?:password|secret|token|api[_-]?key|credential)/i

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue)
  if (!value || typeof value !== 'object') return value
  const sanitized: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'radius_server_secret') {
      if (item) sanitized.radius_secret_required = true
      continue
    }
    if (SENSITIVE_KEY.test(key)) continue
    sanitized[key] = sanitizeValue(item)
  }
  return sanitized
}

export function sanitizeDesign(design: NetworkDesign): NetworkDesign {
  return sanitizeValue(design) as NetworkDesign
}

export function loadCurrentDesign(storage: DesignStorage): NetworkDesign {
  try {
    const current = storage.getItem(CURRENT_DESIGN_STORAGE_KEY)
    const saved = current ?? storage.getItem(LEGACY_CURRENT_DESIGN_STORAGE_KEY)
    if (!saved) return BLANK_DESIGN
    const parsed: unknown = JSON.parse(saved)
    if (!isNetworkDesign(parsed)) return BLANK_DESIGN
    const safeDesign = sanitizeDesign(parsed)
    if (!current) saveCurrentDesign(storage, safeDesign)
    storage.removeItem?.(LEGACY_CURRENT_DESIGN_STORAGE_KEY)
    return safeDesign
  } catch {
    return BLANK_DESIGN
  }
}

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
  return JSON.stringify(value)
}

function changedFields(baseline: NetworkNode, desired: NetworkNode) {
  const keys = new Set([...Object.keys(baseline.data), ...Object.keys(desired.data)])
  return [...keys].filter((key) => key !== 'imported' && stable(baseline.data[key]) !== stable(desired.data[key])).sort()
}

export function diffDesign(baseline: NetworkDesign | null | undefined, desired: NetworkDesign): DesignDiff {
  const byNodeId = new Map<string, ResourceDiff>()
  const deleted: ResourceDiff[] = []
  const summary: DesignDiff['summary'] = { created: 0, modified: 0, deleted: 0, unchanged: 0 }
  const baselineById = new Map((baseline?.nodes ?? []).map((node) => [node.id, node]))
  for (const node of desired.nodes) {
    const original = baselineById.get(node.id)
    const fields = original ? changedFields(original, node) : []
    const status: ResourceDiffStatus = !original ? 'created' : fields.length ? 'modified' : 'unchanged'
    const item = { status, node, baseline: original, changedFields: fields }
    byNodeId.set(node.id, item)
    summary[status] += 1
  }
  const desiredIds = new Set(desired.nodes.map((node) => node.id))
  for (const node of baseline?.nodes ?? []) if (!desiredIds.has(node.id)) {
    const item: ResourceDiff = { status: 'deleted', node, baseline: node, changedFields: [] }
    byNodeId.set(node.id, item)
    deleted.push(item)
    summary.deleted += 1
  }
  return { byNodeId, deleted, summary }
}

export function createSnapshot(design: NetworkDesign, name: string, now = new Date()): DesignSnapshot {
  const normalizedName = name.trim().slice(0, 120) || `Snapshot ${now.toLocaleString()}`
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${now.getTime()}-${Math.random().toString(36).slice(2)}`,
    name: normalizedName,
    createdAt: now.toISOString(),
    schemaVersion: 1,
    azureRmVersion: '4.81.0',
    generatorVersion: '0.1.0',
    design: sanitizeDesign(design),
  }
}

function isSnapshot(value: unknown): value is DesignSnapshot {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<DesignSnapshot>
  return typeof item.id === 'string' && item.id.length <= 200 && typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 120 && typeof item.createdAt === 'string' && !Number.isNaN(Date.parse(item.createdAt)) && item.schemaVersion === 1 && item.azureRmVersion === '4.81.0' && item.generatorVersion === '0.1.0' && isNetworkDesign(item.design)
}

export function loadSnapshots(storage: DesignStorage): DesignSnapshot[] {
  try {
    const current = storage.getItem(SNAPSHOT_STORAGE_KEY)
    const parsed: unknown = JSON.parse(current ?? storage.getItem(LEGACY_SNAPSHOT_STORAGE_KEY) ?? '[]')
    if (!Array.isArray(parsed) || parsed.length > MAX_SNAPSHOTS || !parsed.every(isSnapshot)) return []
    const sanitized = parsed.map((snapshot) => ({ ...snapshot, design: sanitizeDesign(snapshot.design) }))
    if (!current && sanitized.length) {
      storage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(sanitized))
    }
    storage.removeItem?.(LEGACY_SNAPSHOT_STORAGE_KEY)
    return sanitized
  } catch { return [] }
}

export function saveSnapshot(storage: DesignStorage, snapshot: DesignSnapshot) {
  const safeSnapshot = { ...snapshot, design: sanitizeDesign(snapshot.design) }
  const snapshots = [safeSnapshot, ...loadSnapshots(storage).filter((item) => item.id !== snapshot.id)].slice(0, MAX_SNAPSHOTS)
  storage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshots))
}

export function saveCurrentDesign(storage: DesignStorage, design: NetworkDesign) {
  storage.setItem(CURRENT_DESIGN_STORAGE_KEY, JSON.stringify(sanitizeDesign(design)))
}
