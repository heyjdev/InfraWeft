import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validationEnvironment, validationPlan, validateRequest } from '../server/validation'

describe('generated artifact validation planning', () => {
  it('uses fixed executable arguments and never executes generated Azure CLI content', () => {
    const plan = validationPlan('azureCli', '/tmp/safe')
    expect(plan.fileName).toBe('network.sh')
    expect(plan.steps).toEqual([{ name: 'Bash syntax', command: 'bash', args: ['-n', join('/tmp/safe', 'network.sh')] }])
  })

  it('uses backend-free noninteractive Terraform initialization before validation', () => {
    const plan = validationPlan('terraform', '/tmp/safe')
    expect(plan.steps.map((step) => step.command)).toEqual(['terraform', 'terraform', 'terraform'])
    expect(plan.steps[1].args).toContain('-backend=false')
    expect(plan.steps[1].args).toContain('-input=false')
    expect(plan.steps[1].args).toContain('-get=false')
    expect(plan.steps[2].args).toContain('validate')
  })

  it('builds Bicep without restoring external artifacts and isolates Azure state', () => {
    const directory = '/tmp/safe'
    const plan = validationPlan('bicep', directory)
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].args).toContain('--no-restore')

    const environment = validationEnvironment('bicep', directory)
    expect(environment.HOME).toBe(directory)
    expect(environment.USERPROFILE).toBe(directory)
    expect(environment.AZURE_CONFIG_DIR).toBe(join(directory, 'azure'))
    expect(environment.AZURE_EXTENSION_DIR).toBe(join(directory, 'azure', 'extensions'))
    expect(environment.AZURE_BICEP_USE_BINARY_FROM_PATH).toBe('true')
    for (const credential of ['AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_TENANT_ID', 'AZURE_SUBSCRIPTION_ID', 'ARM_CLIENT_ID', 'ARM_CLIENT_SECRET']) {
      expect(environment[credential]).toBeUndefined()
    }
  })
  it('rejects Bicep modules, tests, extensions, providers, imports, and compile-time file reads', () => {
    const fileFunctions = ['loadTextContent', 'loadFileAsBase64', 'loadJsonContent', 'loadYamlContent', 'loadDirectoryFileInfo']
    const rejected = [
      "module remote 'br/public:avm/res/network/virtual-network:0.1.0' = {}",
      "module local '../outside.bicep' = {}",
      'extension microsoftGraphV1_0',
      'extension kubernetes with {}',
      "provider 'br:example.azurecr.io/providers/demo:1.0.0'",
      "import { helper } from 'br:example.azurecr.io/lib:1.0.0'",
      "test external '../outside.bicep' = {}",
      ...fileFunctions.flatMap((name) => [
        `var content = ${name}('../secret')`,
        `var content = ${name}/* split call */('../secret')`,
        "var content = '${true ? '${" + name + "('../secret')}' : 'safe'}'",
      ]),
    ]
    for (const code of rejected) {
      const result = validateRequest({ format: 'bicep', code })
      expect(result.ok, code).toBe(false)
    }
  })

  it('does not treat Bicep policy words in comments or strings as declarations', () => {
    const fileFunctionText = ['loadTextContent', 'loadFileAsBase64', 'loadJsonContent', 'loadYamlContent', 'loadDirectoryFileInfo']
      .map((name) => `${name}(ignored)`)
      .join(' ')
    const code = `// module fake 'br:example/repo:1.0.0' = {}
      // loadTextContent('../ignored.txt')
      /* provider fake */
      var description = 'module test provider extension import ${fileFunctionText}'
      var multiline = '''${fileFunctionText}'''`
    expect(validateRequest({ format: 'bicep', code }).ok).toBe(true)
  })

  it('rejects malformed and oversized requests', () => {
    expect(validateRequest({ format: 'nope', code: 'x' })).toEqual({ ok: false, error: 'Unsupported validation format.' })
    expect(validateRequest({ format: 'terraform', code: '' })).toEqual({ ok: false, error: 'Generated code is required.' })
    expect(validateRequest({ format: 'terraform', code: 'x'.repeat(500_001) })).toEqual({ ok: false, error: 'Generated code exceeds the 500 KB validation limit.' })
    expect(validateRequest({ format: 'bicep', code: 'targetScope = \'subscription\'' }).ok).toBe(true)
  })

  it('allows only the generated AzureRM provider and rejects modules or provisioners', () => {
    const generated = `terraform {\n  required_providers { azurerm = { source = "hashicorp/azurerm", version = "4.81.0" } }\n}\nprovider "azurerm" { features {} }`
    expect(validateRequest({ format: 'terraform', code: generated }).ok).toBe(true)
    expect(validateRequest({ format: 'terraform', code: generated.replace('hashicorp/azurerm', 'attacker/provider') })).toEqual({ ok: false, error: 'Terraform validation allows only hashicorp/azurerm 4.81.0.' })
    expect(validateRequest({ format: 'terraform', code: `${generated}\nmodule "remote" { source = "attacker.example/module" }` })).toEqual({ ok: false, error: 'Terraform modules and provisioners are not allowed in local validation.' })
    expect(validateRequest({ format: 'terraform', code: `${generated}\nresource "null_resource" "x" { provisioner "local-exec" { command = "id" } }` })).toEqual({ ok: false, error: 'Terraform modules and provisioners are not allowed in local validation.' })
  })

  it('does not accept provider pins supplied only in comments', () => {
    const bypass = `terraform {
      required_providers { azurerm = "1.0.0" }
    }
    # source = "hashicorp/azurerm"
    # version = "4.81.0"
    provider "azurerm" { features {} }`
    expect(validateRequest({ format: 'terraform', code: bypass })).toEqual({
      ok: false,
      error: 'Terraform validation allows only hashicorp/azurerm 4.81.0.',
    })
  })

  it('does not accept a fake required-providers block inside a string', () => {
    const bypass = `locals {
      decoy = "required_providers { azurerm = { source = \\"hashicorp/azurerm\\" version = \\"4.81.0\\" } }"
    }
    provider "azurerm" { features {} }
    resource "azurerm_resource_group" "example" { name = "example" location = "eastus" }`
    expect(validateRequest({ format: 'terraform', code: bypass })).toEqual({
      ok: false,
      error: 'Terraform validation allows only hashicorp/azurerm 4.81.0.',
    })
  })

  it('requires the pinned provider declaration in a top-level terraform block', () => {
    const bypass = `resource "azurerm_resource_group" "example" {
      name = "example"
      location = "eastus"
      terraform { required_providers { azurerm = { source = "hashicorp/azurerm" version = "4.81.0" } } }
    }
    provider "azurerm" { features {} }`
    expect(validateRequest({ format: 'terraform', code: bypass })).toEqual({
      ok: false,
      error: 'Terraform validation allows only hashicorp/azurerm 4.81.0.',
    })
  })
})
