import { describe, expect, it } from 'vitest'
import { createSnapshot, diffDesign, loadSnapshots, saveSnapshot, type DesignStorage } from './designState'
import type { NetworkDesign, NetworkNode } from './model'

const node = (id: string, label: string, imported = false): NetworkNode => ({ id, type: 'azureResource', position: { x: 0, y: 0 }, data: { label, kind: 'vnet', addressSpace: '10.0.0.0/16', imported } })
const design = (nodes: NetworkNode[]): NetworkDesign => ({ name: 'test', nodes, edges: [] })

function memoryStorage(): DesignStorage {
  const values = new Map<string, string>()
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) } }
}

describe('desired-state diff', () => {
  it('classifies created, modified, deleted, and unchanged resources without treating canvas movement as infrastructure drift', () => {
    const baseline = design([node('/azure/a', 'a', true), node('/azure/b', 'b', true), node('/azure/d', 'd', true)])
    const unchanged = { ...node('/azure/a', 'a', true), position: { x: 800, y: 500 } }
    const changed = { ...node('/azure/b', 'b-renamed', true), data: { ...node('/azure/b', 'b', true).data, label: 'b-renamed' } }
    const current = design([unchanged, changed, node('new-c', 'c')])
    const result = diffDesign(baseline, current)
    expect(result.summary).toEqual({ created: 1, modified: 1, deleted: 1, unchanged: 1 })
    expect(result.byNodeId.get('/azure/a')?.status).toBe('unchanged')
    expect(result.byNodeId.get('/azure/b')?.changedFields).toContain('label')
    expect(result.deleted[0].node.id).toBe('/azure/d')
  })
})

describe('local versioned snapshots', () => {
  it('round-trips bounded snapshots and keeps newest first', () => {
    const storage = memoryStorage()
    const first = createSnapshot(design([node('a', 'a')]), 'first', new Date('2026-01-01T00:00:00Z'))
    const second = createSnapshot(design([node('b', 'b')]), 'second', new Date('2026-01-02T00:00:00Z'))
    saveSnapshot(storage, first)
    saveSnapshot(storage, second)
    expect(loadSnapshots(storage).map((item) => item.name)).toEqual(['second', 'first'])
    expect(loadSnapshots(storage)[0].schemaVersion).toBe(1)
  })

  it('rejects malformed persisted snapshot data', () => {
    const storage = memoryStorage()
    storage.setItem('azure-network-studio-snapshots', JSON.stringify([{ name: 'bad' }]))
    expect(loadSnapshots(storage)).toEqual([])
  })
})
