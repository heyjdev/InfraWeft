import { describe, expect, it } from 'vitest'
import { BLANK_DESIGN, CURRENT_DESIGN_STORAGE_KEY, createSnapshot, diffDesign, LEGACY_SNAPSHOT_STORAGE_KEY, loadCurrentDesign, loadSnapshots, sanitizeDesign, saveCurrentDesign, saveSnapshot, SNAPSHOT_STORAGE_KEY, type DesignStorage } from './designState'
import type { NetworkDesign, NetworkNode } from './model'

const node = (id: string, label: string, imported = false): NetworkNode => ({ id, type: 'azureResource', position: { x: 0, y: 0 }, data: { label, kind: 'vnet', addressSpace: '10.0.0.0/16', imported } })
const design = (nodes: NetworkNode[]): NetworkDesign => ({ name: 'test', nodes, edges: [] })

function memoryStorage(): DesignStorage {
  const values = new Map<string, string>()
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: (key) => { values.delete(key) } }
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
  it('starts a first-time user with a blank canvas', () => {
    expect(BLANK_DESIGN).toEqual({ name: 'Untitled design', nodes: [], edges: [] })
    expect(loadCurrentDesign(memoryStorage())).toEqual(BLANK_DESIGN)
  })

  it('removes legacy secret values and retains only deployment-time secret intent', () => {
    const unsafe = design([{
      ...node('vpn', 'vpn'),
      data: {
        ...node('vpn', 'vpn').data,
        kind: 'vpnGateway',
        vpn_client_configuration: {
          radius_server_address: '10.0.0.4',
          radius_server_secret: 'do-not-persist-this',
        },
      },
    }])
    const safe = sanitizeDesign(unsafe)
    const client = safe.nodes[0].data.vpn_client_configuration as Record<string, unknown>
    expect(client.radius_server_secret).toBeUndefined()
    expect(client.radius_secret_required).toBe(true)
    expect(JSON.stringify(safe)).not.toContain('do-not-persist-this')
  })

  it('sanitizes the current design and snapshots before writing browser storage', () => {
    const storage = memoryStorage()
    const unsafe = design([{
      ...node('vpn', 'vpn'),
      data: { ...node('vpn', 'vpn').data, api_token: 'token-value', nested: { password: 'password-value' } },
    }])
    saveCurrentDesign(storage, unsafe)
    saveSnapshot(storage, createSnapshot(unsafe, 'safe snapshot'))
    const serialized = `${storage.getItem(CURRENT_DESIGN_STORAGE_KEY)}${storage.getItem(SNAPSHOT_STORAGE_KEY)}`
    expect(serialized).not.toContain('token-value')
    expect(serialized).not.toContain('password-value')
  })

  it('persists the current editable design independently of snapshots', () => {
    const storage = memoryStorage()
    const current = design([node('current', 'current')])
    saveCurrentDesign(storage, current)
    expect(JSON.parse(storage.getItem(CURRENT_DESIGN_STORAGE_KEY) ?? 'null')).toEqual(current)
    expect(loadSnapshots(storage)).toEqual([])
  })

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
    storage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify([{ name: 'bad' }]))
    expect(loadSnapshots(storage)).toEqual([])
  })

  it('migrates valid snapshots from the legacy product storage key', () => {
    const storage = memoryStorage()
    const snapshot = createSnapshot(design([node('legacy', 'legacy')]), 'legacy')
    storage.setItem(LEGACY_SNAPSHOT_STORAGE_KEY, JSON.stringify([snapshot]))
    expect(loadSnapshots(storage)[0].name).toBe('legacy')
    expect(storage.getItem(SNAPSHOT_STORAGE_KEY)).not.toBeNull()
    expect(storage.getItem(LEGACY_SNAPSHOT_STORAGE_KEY)).toBeNull()
  })
})
