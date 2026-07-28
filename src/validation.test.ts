import { describe, expect, it } from 'vitest'
import { validationPlan, validateRequest } from '../server/validation'

describe('generated artifact validation planning', () => {
  it('uses fixed executable arguments and never executes generated Azure CLI content', () => {
    const plan = validationPlan('azureCli', '/tmp/safe')
    expect(plan.fileName).toBe('network.sh')
    expect(plan.steps).toEqual([{ name: 'Bash syntax', command: 'bash', args: ['-n', '/tmp/safe/network.sh'] }])
  })

  it('uses backend-free noninteractive Terraform initialization before validation', () => {
    const plan = validationPlan('terraform', '/tmp/safe')
    expect(plan.steps.map((step) => step.command)).toEqual(['terraform', 'terraform', 'terraform'])
    expect(plan.steps[1].args).toContain('-backend=false')
    expect(plan.steps[1].args).toContain('-input=false')
    expect(plan.steps[2].args).toContain('validate')
  })

  it('rejects malformed and oversized requests', () => {
    expect(validateRequest({ format: 'nope', code: 'x' })).toEqual({ ok: false, error: 'Unsupported validation format.' })
    expect(validateRequest({ format: 'terraform', code: '' })).toEqual({ ok: false, error: 'Generated code is required.' })
    expect(validateRequest({ format: 'terraform', code: 'x'.repeat(500_001) })).toEqual({ ok: false, error: 'Generated code exceeds the 500 KB validation limit.' })
    expect(validateRequest({ format: 'bicep', code: 'targetScope = \'subscription\'' }).ok).toBe(true)
  })
})
