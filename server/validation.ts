import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
export type ValidationFormat = 'terraform' | 'bicep' | 'azureCli'
export type ValidationStep = { name: string; command: string; args: string[] }
export type ValidationPlan = { fileName: string; steps: ValidationStep[] }
export type ValidationResult = { name: string; status: 'passed' | 'failed'; output: string }
const MAX_CODE_BYTES = 500_000
const TERRAFORM_PROVIDER_ERROR = 'Terraform validation allows only hashicorp/azurerm 4.81.0.'
const BICEP_EXTERNAL_ERROR = 'Bicep modules, test declarations, extensions, providers, imports, and compile-time file reads are not allowed in local validation.'

function stripBicepComments(code: string) {
  let result = ''
  let index = 0
  let quote: "'" | "'''" | undefined
  while (index < code.length) {
    if (quote) {
      if (quote === "'''" && code.startsWith("'''", index)) {
        result += "'''"
        index += 3
        quote = undefined
        continue
      }
      const current = code[index]
      result += current
      if (quote === "'" && current === '\\' && code[index + 1]) {
        result += code[index + 1]
        index += 2
        continue
      }
      if (quote === "'" && current === "'") quote = undefined
      index += 1
      continue
    }
    if (code.startsWith("'''", index)) {
      quote = "'''"
      result += "'''"
      index += 3
      continue
    }
    const current = code[index]
    const next = code[index + 1]
    if (current === "'") {
      quote = "'"
      result += current
      index += 1
      continue
    }
    if (current === '/' && next === '/') {
      while (index < code.length && code[index] !== '\n') index += 1
      result += '\n'
      continue
    }
    if (current === '/' && next === '*') {
      index += 2
      while (index < code.length && !(code[index] === '*' && code[index + 1] === '/')) index += 1
      index += 2
      result += ' '
      continue
    }
    result += current
    index += 1
  }
  return result
}

function stripBicepStrings(code: string) {
  let result = ''
  let index = 0
  while (index < code.length) {
    if (code.startsWith("'''", index)) {
      index += 3
      while (index < code.length && !code.startsWith("'''", index)) index += 1
      index += 3
      result += ' '
      continue
    }
    if (code[index] === "'") {
      index += 1
      while (index < code.length) {
        if (code[index] === '\\' && code[index + 1]) index += 2
        else if (code[index] === "'") {
          index += 1
          break
        } else index += 1
      }
      result += ' '
      continue
    }
    result += code[index]
    index += 1
  }
  return result
}

function bicepExecutableCode(code: string) {
  function scanString(start: number): { text: string; index: number } {
    let text = ''
    let index = start + 1
    while (index < code.length) {
      if (code[index] === '\\' && code[index + 1]) {
        index += 2
        continue
      }
      if (code[index] === "'") return { text, index: index + 1 }
      if (code[index] === '$' && code[index + 1] === '{') {
        const interpolation = scanCode(index + 2, true)
        text += ` ${interpolation.text} `
        index = interpolation.index
        continue
      }
      index += 1
    }
    return { text, index }
  }

  function scanCode(start: number, stopAtClosingBrace: boolean): { text: string; index: number } {
    let text = ''
    let index = start
    let nestedBraces = 0
    while (index < code.length) {
      if (code.startsWith("'''", index)) {
        index += 3
        while (index < code.length && !code.startsWith("'''", index)) index += 1
        index += 3
        text += ' '
        continue
      }
      if (code[index] === "'") {
        const quoted = scanString(index)
        text += ` ${quoted.text} `
        index = quoted.index
        continue
      }
      if (code[index] === '/' && code[index + 1] === '/') {
        while (index < code.length && code[index] !== '\n') index += 1
        text += '\n'
        continue
      }
      if (code[index] === '/' && code[index + 1] === '*') {
        index += 2
        while (index < code.length && !(code[index] === '*' && code[index + 1] === '/')) index += 1
        index += 2
        text += ' '
        continue
      }
      if (stopAtClosingBrace && code[index] === '{') nestedBraces += 1
      else if (stopAtClosingBrace && code[index] === '}') {
        if (nestedBraces === 0) return { text, index: index + 1 }
        nestedBraces -= 1
      }
      text += code[index]
      index += 1
    }
    return { text, index }
  }

  return scanCode(0, false).text
}

function bicepPolicyError(code: string) {
  const uncommented = stripBicepComments(code)
  const structure = stripBicepStrings(uncommented)
  const executable = bicepExecutableCode(uncommented)
  if (/\b(?:module|extension|provider|import|test)\b/i.test(structure)) return BICEP_EXTERNAL_ERROR
  if (/\b(?:loadTextContent|loadFileAsBase64|loadJsonContent|loadYamlContent|loadDirectoryFileInfo)\s*\(/i.test(executable)) return BICEP_EXTERNAL_ERROR
  return undefined
}

function stripTerraformComments(code: string) {
  let result = ''
  let index = 0
  let quoted = false
  while (index < code.length) {
    const current = code[index]
    const next = code[index + 1]
    if (quoted) {
      result += current
      if (current === '\\' && next) {
        result += next
        index += 2
        continue
      }
      if (current === '"') quoted = false
      index += 1
      continue
    }
    if (current === '"') {
      quoted = true
      result += current
      index += 1
      continue
    }
    if (current === '#' || (current === '/' && next === '/')) {
      while (index < code.length && code[index] !== '\n') index += 1
      result += '\n'
      index += 1
      continue
    }
    if (current === '/' && next === '*') {
      index += 2
      while (index < code.length && !(code[index] === '*' && code[index + 1] === '/')) index += 1
      index += 2
      result += ' '
      continue
    }
    result += current
    index += 1
  }
  return result
}

function terraformBlocks(code: string, name: string) {
  const blocks: string[] = []
  let cursor = 0
  let outerDepth = 0
  while (cursor < code.length) {
    if (code[cursor] === '"') {
      cursor += 1
      while (cursor < code.length && code[cursor] !== '"') {
        if (code[cursor] === '\\') cursor += 1
        cursor += 1
      }
      cursor += 1
      continue
    }
    if (code[cursor] === '{') {
      outerDepth += 1
      cursor += 1
      continue
    }
    if (code[cursor] === '}') {
      outerDepth = Math.max(0, outerDepth - 1)
      cursor += 1
      continue
    }
    const previous = code[cursor - 1]
    const afterName = code[cursor + name.length]
    if (outerDepth === 0 && code.startsWith(name, cursor) && !/[\w-]/.test(previous ?? '') && !/[\w-]/.test(afterName ?? '')) {
      let openingBrace = cursor + name.length
      while (/\s/.test(code[openingBrace] ?? '')) openingBrace += 1
      if (code[openingBrace] === '{') {
        let depth = 1
        let quoted = false
        let index = openingBrace + 1
        for (; index < code.length && depth; index += 1) {
          const current = code[index]
          if (quoted) {
            if (current === '\\') index += 1
            else if (current === '"') quoted = false
          } else if (current === '"') quoted = true
          else if (current === '{') depth += 1
          else if (current === '}') depth -= 1
        }
        if (depth) return []
        blocks.push(code.slice(openingBrace + 1, index - 1))
        cursor = index
        continue
      }
    }
    cursor += 1
  }
  return blocks
}

function terraformPolicyError(code: string) {
  const uncommented = stripTerraformComments(code)
  if (/\b(?:module|provisioner)\s+"/m.test(uncommented)) return 'Terraform modules and provisioners are not allowed in local validation.'
  if (/<<-?[A-Za-z_]/.test(uncommented)) return TERRAFORM_PROVIDER_ERROR
  const terraformConfig = terraformBlocks(uncommented, 'terraform')
  if (terraformConfig.length !== 1 || terraformConfig[0].replace(/[\s,]+/g, '') !== 'required_providers{azurerm={source="hashicorp/azurerm"version="4.81.0"}}') return TERRAFORM_PROVIDER_ERROR
  const providers = [...uncommented.matchAll(/\bprovider\s+"([^"]+)"/g)].map((match) => match[1])
  if (providers.some((provider) => provider !== 'azurerm')) return TERRAFORM_PROVIDER_ERROR
  return undefined
}

export function validateRequest(value: unknown): { ok: true; format: ValidationFormat; code: string } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') return { ok: false, error: 'A JSON validation request is required.' }
  const { format, code } = value as { format?: unknown; code?: unknown }
  if (!['terraform', 'bicep', 'azureCli'].includes(String(format))) return { ok: false, error: 'Unsupported validation format.' }
  if (typeof code !== 'string' || !code.length) return { ok: false, error: 'Generated code is required.' }
  if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) return { ok: false, error: 'Generated code exceeds the 500 KB validation limit.' }
  if (code.includes('\0')) return { ok: false, error: 'Generated code contains a null byte.' }
  if (format === 'terraform') {
    const error = terraformPolicyError(code)
    if (error) return { ok: false, error }
  } else if (format === 'bicep') {
    const error = bicepPolicyError(code)
    if (error) return { ok: false, error }
  }
  return { ok: true, format: format as ValidationFormat, code }
}

export function validationPlan(format: ValidationFormat, directory: string): ValidationPlan {
  if (format === 'terraform') return {
    fileName: 'main.tf',
    steps: [
      { name: 'Terraform format', command: 'terraform', args: [`-chdir=${directory}`, 'fmt', '-check', '-no-color', 'main.tf'] },
      { name: 'Terraform initialize', command: 'terraform', args: [`-chdir=${directory}`, 'init', '-backend=false', '-get=false', '-input=false', '-no-color'] },
      { name: 'Terraform validate', command: 'terraform', args: [`-chdir=${directory}`, 'validate', '-no-color'] },
    ],
  }
  if (format === 'bicep') return {
    fileName: 'network.bicep',
    steps: [{ name: 'Bicep build', command: 'az', args: ['bicep', 'build', '--file', join(directory, 'network.bicep'), '--outfile', join(directory, 'network.json'), '--no-restore', '--only-show-errors'] }],
  }
  return { fileName: 'network.sh', steps: [{ name: 'Bash syntax', command: 'bash', args: ['-n', join(directory, 'network.sh')] }] }
}

const publicOutput = (value: string, directory: string) => value.replaceAll(directory, '<temporary-directory>').slice(0, 12_000).trim()

export function validationEnvironment(format: ValidationFormat, directory: string) {
  const environment: NodeJS.ProcessEnv = {
    TF_IN_AUTOMATION: '1',
    AZURE_CORE_COLLECT_TELEMETRY: '0',
  }
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR']) if (process.env[key]) environment[key] = process.env[key]
  if (format === 'terraform') {
    environment.HOME = directory
    environment.USERPROFILE = directory
    environment.TF_CLI_CONFIG_FILE = join(directory, 'terraform.rc')
  } else if (format === 'bicep') {
    const sourceAzureConfig = process.env.AZURE_CONFIG_DIR || join(homedir(), '.azure')
    const executablePath = environment.PATH || environment.Path || ''
    environment.PATH = [executablePath, join(sourceAzureConfig, 'bin')].filter(Boolean).join(delimiter)
    delete environment.Path
    environment.HOME = directory
    environment.USERPROFILE = directory
    environment.XDG_CACHE_HOME = join(directory, '.cache')
    environment.XDG_CONFIG_HOME = join(directory, '.config')
    environment.AZURE_CONFIG_DIR = join(directory, 'azure')
    environment.AZURE_EXTENSION_DIR = join(directory, 'azure', 'extensions')
    environment.AZURE_BICEP_USE_BINARY_FROM_PATH = 'true'
    environment.DOTNET_CLI_HOME = directory
  } else {
    for (const key of ['HOME', 'USERPROFILE', 'AZURE_CONFIG_DIR']) if (process.env[key]) environment[key] = process.env[key]
  }
  return environment
}

export async function validateGeneratedCode(format: ValidationFormat, code: string): Promise<{ ok: boolean; results: ValidationResult[] }> {
  const directory = await mkdtemp(join(tmpdir(), 'infraweft-validation-'))
  const plan = validationPlan(format, directory)
  const results: ValidationResult[] = []
  try {
    await writeFile(join(directory, plan.fileName), code, { encoding: 'utf8', mode: 0o600 })
    if (format === 'terraform') await writeFile(join(directory, 'terraform.rc'), 'provider_installation {\n  direct {\n    include = ["registry.terraform.io/hashicorp/azurerm"]\n  }\n}\n', { encoding: 'utf8', mode: 0o600 })
    if (format === 'bicep') await writeFile(join(directory, 'bicepconfig.json'), '{\n  "experimentalFeaturesEnabled": {}\n}\n', { encoding: 'utf8', mode: 0o600 })
    for (const step of plan.steps) {
      try {
        const { stdout, stderr } = await exec(step.command, step.args, {
          timeout: format === 'terraform' ? 180_000 : 60_000,
          maxBuffer: 2 * 1024 * 1024,
          cwd: directory,
          env: validationEnvironment(format, directory),
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
