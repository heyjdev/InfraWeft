#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { startServer } from '../dist-server/index.mjs'

const args = process.argv.slice(2)

function toolVersion(command, versionArgs, parse = (output) => output.split('\n')[0].trim()) {
  const result = spawnSync(command, versionArgs, { encoding: 'utf8', timeout: 10_000, windowsHide: true, env: { ...process.env, AZURE_CORE_COLLECT_TELEMETRY: '0' } })
  if (result.error?.code === 'ENOENT') return { ready: false, detail: 'not found on PATH' }
  if (result.error) return { ready: false, detail: result.error.message }
  if (result.status !== 0) return { ready: false, detail: (result.stderr || result.stdout || `exit ${result.status}`).trim().split('\n')[0] }
  return { ready: true, detail: parse(result.stdout) }
}

function doctor() {
  const tools = [
    { capability: 'Core application', required: true, result: { ready: Number(process.versions.node.split('.')[0]) >= 20, detail: `Node.js ${process.version}` } },
    { capability: 'Terraform validation', required: false, result: toolVersion('terraform', ['version', '-json'], (output) => `Terraform ${JSON.parse(output).terraform_version}`) },
    { capability: 'Azure import / Bicep', required: false, result: toolVersion('az', ['version', '--output', 'json'], (output) => `Azure CLI ${JSON.parse(output)['azure-cli']}`) },
    { capability: 'Azure CLI script validation', required: false, result: toolVersion('bash', ['--version'], (output) => output.split('\n')[0].trim()) },
  ]
  for (const item of tools) console.log(`${item.capability.padEnd(30)} ${item.result.ready ? 'ready' : item.required ? 'blocked' : 'unavailable'} — ${item.result.detail}`)
  if (tools.some((item) => item.required && !item.result.ready)) process.exitCode = 1
}

function parsePort() {
  const index = args.indexOf('--port')
  const raw = index >= 0 ? args[index + 1] : process.env.API_PORT || '8787'
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${raw}`)
  return port
}

async function openBrowser(url) {
  const launcherDirectory = await mkdtemp(join(tmpdir(), 'infraweft-launch-'))
  const launcherPath = join(launcherDirectory, 'open.html')
  const document = `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Opening InfraWeft</title><script>location.replace(${JSON.stringify(url)})</script>`
  await writeFile(launcherPath, document, { encoding: 'utf8', mode: 0o600 })
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const launcherUrl = pathToFileURL(launcherPath).href
  const openArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'start', '', launcherUrl] : [launcherUrl]
  let child
  try {
    child = spawn(command, openArgs, { detached: true, stdio: 'ignore', windowsHide: true })
  } catch {
    await rm(launcherDirectory, { recursive: true, force: true })
    return false
  }
  const opened = await new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => finish(true), 2_000)
    child.once('error', () => finish(false))
    child.once('exit', (code) => finish(code === 0))
  })
  child.unref()
  if (!opened) await rm(launcherDirectory, { recursive: true, force: true })
  else setTimeout(() => void rm(launcherDirectory, { recursive: true, force: true }), 60_000).unref()
  return opened
}

if (args[0] === 'doctor' || args.includes('--doctor')) {
  doctor()
} else {
  const allowed = new Set(['--no-open', '--port'])
  const unknown = args.filter((arg, index) => !allowed.has(arg) && args[index - 1] !== '--port')
  if (unknown.length) {
    console.error(`Unknown argument: ${unknown[0]}`)
    process.exit(1)
  }
  try {
    const port = parsePort()
    const { server, url, accessUrl } = await startServer({ port, serveUi: true })
    console.log(`InfraWeft is running at ${url}`)
    console.log('Designs stay in this browser profile. Press Ctrl+C to stop.')
    if (args.includes('--no-open') || process.env.CI) console.log(`Private access URL: ${accessUrl}`)
    else if (!await openBrowser(accessUrl)) {
      console.error('InfraWeft could not open a browser automatically. Open the private access URL below:')
      console.log(`Private access URL: ${accessUrl}`)
    }
    const stop = () => server.close(() => process.exit(0))
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
