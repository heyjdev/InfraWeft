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

export type DesignStorage = Pick<Storage, 'getItem' | 'setItem'>
export const SNAPSHOT_STORAGE_KEY = 'azure-network-studio-snapshots'
const MAX_SNAPSHOTS = 20

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
    design: structuredClone(design),
  }
}

function isSnapshot(value: unknown): value is DesignSnapshot {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<DesignSnapshot>
  return typeof item.id === 'string' && item.id.length <= 200 && typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 120 && typeof item.createdAt === 'string' && !Number.isNaN(Date.parse(item.createdAt)) && item.schemaVersion === 1 && item.azureRmVersion === '4.81.0' && item.generatorVersion === '0.1.0' && isNetworkDesign(item.design)
}

export function loadSnapshots(storage: DesignStorage): DesignSnapshot[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(SNAPSHOT_STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) && parsed.length <= MAX_SNAPSHOTS && parsed.every(isSnapshot) ? parsed : []
  } catch { return [] }
}

export function saveSnapshot(storage: DesignStorage, snapshot: DesignSnapshot) {
  const snapshots = [snapshot, ...loadSnapshots(storage).filter((item) => item.id !== snapshot.id)].slice(0, MAX_SNAPSHOTS)
  storage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshots))
}
