import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const temporary = await mkdtemp(join(tmpdir(), 'infraweft-package-smoke-'))
let child

function runNpm(args, options = {}) {
  const npmCli = process.env.npm_execpath
  if (npmCli) return spawnSync(process.execPath, [npmCli, ...args], options)
  return spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { ...options, shell: process.platform === 'win32' })
}

async function stopChild() {
  if (!child || child.exitCode !== null) return
  const processToStop = child
  const closed = new Promise((resolve) => processToStop.once('close', resolve))
  if (process.platform === 'win32' && processToStop.pid) {
    spawnSync('taskkill', ['/pid', String(processToStop.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    processToStop.kill('SIGTERM')
  }
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5_000))])
  if (processToStop.exitCode === null) {
    if (process.platform === 'win32' && processToStop.pid) {
      spawnSync('taskkill', ['/pid', String(processToStop.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      processToStop.kill('SIGKILL')
    }
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5_000))])
  }
  child = undefined
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function waitFor(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return response
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) { lastError = error }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`)
}

try {
  const packed = runNpm(['pack', '--silent', '--json', '--pack-destination', temporary], { cwd: root, encoding: 'utf8', timeout: 180_000 })
  if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout || 'npm pack failed')
  const archives = (await readdir(temporary)).filter((name) => name.endsWith('.tgz'))
  if (archives.length !== 1) throw new Error(`Expected one package archive, found ${archives.length}`)
  const archive = join(temporary, archives[0])
  const installDirectory = join(temporary, 'consumer')
  await writeFile(join(temporary, 'package.json'), '{}')
  const installed = runNpm(['install', '--prefix', installDirectory, '--ignore-scripts', archive], { encoding: 'utf8', timeout: 180_000 })
  if (installed.status !== 0) throw new Error(installed.stderr || installed.stdout || 'package install failed')
  const packageDirectory = join(installDirectory, 'node_modules', 'infraweft')
  const packageJson = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'))
  if (!packageJson.bin?.infraweft) throw new Error('Packed package has no CLI bin entry')
  const port = await freePort()
  const executable = join(installDirectory, 'node_modules', '.bin', process.platform === 'win32' ? 'infraweft.cmd' : 'infraweft')
  child = spawn(executable, ['--no-open', '--port', String(port)], { cwd: installDirectory, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const health = await waitFor(`http://127.0.0.1:${port}/api/health`)
  const body = await health.json()
  if (body.ok !== true) throw new Error('Packaged health endpoint returned an unexpected body')
  const page = await (await waitFor(`http://127.0.0.1:${port}/`)).text()
  if (!page.includes('<div id="root"></div>')) throw new Error('Packaged UI was not served')
  await stopChild()
  console.log(`Package smoke test passed at http://127.0.0.1:${port}`)
} catch (error) {
  await stopChild()
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await stopChild()
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
