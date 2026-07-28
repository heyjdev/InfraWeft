import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
export type ValidationFormat = 'terraform' | 'bicep' | 'azureCli'
export type ValidationStep = { name: string; command: string; args: string[] }
export type ValidationPlan = { fileName: string; steps: ValidationStep[] }
export type ValidationResult = { name: string; status: 'passed' | 'failed'; output: string }
const MAX_CODE_BYTES = 500_000

export function validateRequest(value: unknown): { ok: true; format: ValidationFormat; code: string } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') return { ok: false, error: 'A JSON validation request is required.' }
  const { format, code } = value as { format?: unknown; code?: unknown }
  if (!['terraform', 'bicep', 'azureCli'].includes(String(format))) return { ok: false, error: 'Unsupported validation format.' }
  if (typeof code !== 'string' || !code.length) return { ok: false, error: 'Generated code is required.' }
  if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) return { ok: false, error: 'Generated code exceeds the 500 KB validation limit.' }
  if (code.includes('\0')) return { ok: false, error: 'Generated code contains a null byte.' }
  return { ok: true, format: format as ValidationFormat, code }
}

export function validationPlan(format: ValidationFormat, directory: string): ValidationPlan {
  if (format === 'terraform') return {
    fileName: 'main.tf',
    steps: [
      { name: 'Terraform format', command: 'terraform', args: [`-chdir=${directory}`, 'fmt', '-check', '-no-color', 'main.tf'] },
      { name: 'Terraform initialize', command: 'terraform', args: [`-chdir=${directory}`, 'init', '-backend=false', '-input=false', '-no-color'] },
      { name: 'Terraform validate', command: 'terraform', args: [`-chdir=${directory}`, 'validate', '-no-color'] },
    ],
  }
  if (format === 'bicep') return {
    fileName: 'network.bicep',
    steps: [{ name: 'Bicep build', command: 'az', args: ['bicep', 'build', '--file', join(directory, 'network.bicep'), '--outfile', join(directory, 'network.json'), '--only-show-errors'] }],
  }
  return { fileName: 'network.sh', steps: [{ name: 'Bash syntax', command: 'bash', args: ['-n', join(directory, 'network.sh')] }] }
}

const publicOutput = (value: string, directory: string) => value.replaceAll(directory, '<temporary-directory>').slice(0, 12_000).trim()

export async function validateGeneratedCode(format: ValidationFormat, code: string): Promise<{ ok: boolean; results: ValidationResult[] }> {
  const directory = await mkdtemp(join(tmpdir(), 'azure-network-studio-validation-'))
  const plan = validationPlan(format, directory)
  const results: ValidationResult[] = []
  try {
    await writeFile(join(directory, plan.fileName), code, { encoding: 'utf8', mode: 0o600 })
    for (const step of plan.steps) {
      try {
        const { stdout, stderr } = await exec(step.command, step.args, {
          timeout: format === 'terraform' ? 180_000 : 60_000,
          maxBuffer: 2 * 1024 * 1024,
          env: { ...process.env, AZURE_CORE_COLLECT_TELEMETRY: '0', TF_IN_AUTOMATION: '1' },
        })
        results.push({ name: step.name, status: 'passed', output: publicOutput(`${stdout}${stderr}`, directory) || 'Passed.' })
      } catch (error) {
        const item = error as { code?: string; stdout?: string; stderr?: string; message?: string }
        const missing = item.code === 'ENOENT' ? `${step.command} is not installed or not available on PATH.` : ''
        results.push({ name: step.name, status: 'failed', output: publicOutput(missing || `${item.stdout ?? ''}${item.stderr ?? ''}` || item.message || 'Validation failed.', directory) })
        break
      }
    }
    return { ok: results.length === plan.steps.length && results.every((item) => item.status === 'passed'), results }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
