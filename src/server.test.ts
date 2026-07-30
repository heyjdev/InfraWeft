import { afterEach, describe, expect, it } from 'vitest'
import { request, type Server } from 'node:http'
import { createServer } from 'node:net'
import { createApp, startServer } from '../server/index'

const API_TOKEN = 'test-capability-token-with-sufficient-entropy'
const TOKEN_HEADER = 'x-infraweft-token'
const servers: Server[] = []

async function freePort() {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  return port
}

async function launch() {
  const port = await freePort()
  const { server, url } = await startServer({ port, serveUi: false, apiToken: API_TOKEN })
  servers.push(server)
  return url
}

async function rawStatus(url: string, headers: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    const operation = request(url, { headers }, (response) => {
      response.resume()
      response.once('end', () => resolve(response.statusCode ?? 0))
    })
    operation.once('error', reject)
    operation.end()
  })
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })))
})

describe('local API capability authorization', () => {
  it('refuses to construct the API with a weak caller-supplied token', () => {
    expect(() => createApp({ apiToken: 'too-short' })).toThrow('A strong local API access token is required.')
  })

  it('keeps health public but rejects privileged requests without the per-launch token', async () => {
    const url = await launch()

    const health = await fetch(`${url}/api/health`)
    expect(health.status).toBe(200)

    const subscriptions = await fetch(`${url}/api/azure/subscriptions`)
    expect(subscriptions.status).toBe(401)
    await expect(subscriptions.json()).resolves.toEqual({ error: 'A valid local access token is required.' })
  })

  it('rejects wrong tokens and does not accept capability tokens from URLs', async () => {
    const url = await launch()

    const wrong = await fetch(`${url}/api/azure/subscriptions`, { headers: { [TOKEN_HEADER]: 'wrong-token' } })
    expect(wrong.status).toBe(401)

    const queryLeak = await fetch(`${url}/api/azure/subscriptions?accessToken=${encodeURIComponent(API_TOKEN)}`)
    expect(queryLeak.status).toBe(401)
  })

  it('rejects case and trailing-slash variants using the same routing semantics as Express', async () => {
    const url = await launch()
    const attempts = [
      fetch(`${url}/api/validate/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
      fetch(`${url}/API/VALIDATE`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
      fetch(`${url}/API/AZURE/TOPOLOGY?subscriptionId=invalid`),
      fetch(`${url}/api/Azure/topology/?subscriptionId=invalid`),
    ]

    const responses = await Promise.all(attempts)
    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401])
  })

  it('retains Host and Origin defenses even when the token is valid', async () => {
    const url = await launch()

    const wrongHost = await rawStatus(`${url}/api/azure/subscriptions`, { host: 'attacker.invalid', [TOKEN_HEADER]: API_TOKEN })
    expect(wrongHost).toBe(403)

    const crossSite = await fetch(`${url}/api/azure/subscriptions`, { headers: { origin: 'https://attacker.invalid', [TOKEN_HEADER]: API_TOKEN } })
    expect(crossSite.status).toBe(403)
  })

  it('accepts the token header before validating the request body', async () => {
    const url = await launch()
    const response = await fetch(`${url}/api/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: API_TOKEN },
      body: JSON.stringify({ format: 'terraform', code: '' }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Generated code is required.' })
  })
})
