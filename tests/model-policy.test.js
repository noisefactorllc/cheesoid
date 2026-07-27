import { test } from 'node:test'
import assert from 'node:assert'
import { applyModelPolicy, TIER_DEFAULTS, tierChain } from '../server/lib/model-policy.js'

test('fills all tiers for a zero-config persona when openrouter is available', () => {
  const config = { name: 'bare' }
  const filled = applyModelPolicy(config, { hasOpenRouter: true })
  assert.ok(filled.includes('cognition'))
  assert.ok(filled.includes('attention'))
  assert.ok(filled.includes('executor'))
  assert.ok(filled.includes('reflection'))
  assert.ok(filled.includes('transcription'))
  assert.ok(filled.includes('subagent'))
  assert.deepStrictEqual(config.cognition, TIER_DEFAULTS.cognition)
  assert.deepStrictEqual(config.model, TIER_DEFAULTS.model)
  assert.strictEqual(config._modelPolicy.source, 'eval-2026-07-27')
})

test('never touches core tiers when the persona configured any model', () => {
  const config = { name: 'brad', model: ['google/gemma-4-31b-it:openrouter'] }
  applyModelPolicy(config, { hasOpenRouter: true })
  assert.deepStrictEqual(config.model, ['google/gemma-4-31b-it:openrouter'])
  assert.strictEqual(config.cognition, undefined)
  assert.strictEqual(config.attention, undefined)
  // Extended tiers still fill — they are new features with no legacy behavior.
  assert.deepStrictEqual(config.reflection, TIER_DEFAULTS.reflection)
  assert.deepStrictEqual(config.subagent, TIER_DEFAULTS.subagent)
})

test('orchestrator counts as configured — no core fill', () => {
  const config = { name: 'legacy', orchestrator: 'gpt-5.4:openai' }
  applyModelPolicy(config, { hasOpenRouter: true })
  assert.strictEqual(config.cognition, undefined)
  assert.strictEqual(config.model, undefined)
})

test('model_policy none disables everything', () => {
  const config = { name: 'off', model_policy: 'none' }
  const filled = applyModelPolicy(config, { hasOpenRouter: true })
  assert.deepStrictEqual(filled, [])
  assert.strictEqual(config.reflection, undefined)
})

test('no openrouter key means no filling', () => {
  const config = { name: 'nokey' }
  const filled = applyModelPolicy(config, { hasOpenRouter: false })
  assert.deepStrictEqual(filled, [])
  assert.strictEqual(config.cognition, undefined)
  assert.strictEqual(config.transcription, undefined)
})

test('model_policy per-tier overrides win over defaults and count as explicit', () => {
  const config = {
    name: 'custom',
    model_policy: { transcription: 'mistralai/voxtral-small-24b-2507:openrouter', cognition: ['a:openrouter', 'b:openrouter'] },
  }
  applyModelPolicy(config, { hasOpenRouter: true })
  assert.deepStrictEqual(config.transcription, ['mistralai/voxtral-small-24b-2507:openrouter'])
  assert.deepStrictEqual(config.cognition, ['a:openrouter', 'b:openrouter'])
  // Overriding one tier through model_policy still fills the rest from
  // defaults — the override adjusts the policy, it doesn't disable it.
  assert.deepStrictEqual(config.attention, TIER_DEFAULTS.attention)
  assert.deepStrictEqual(config.model, TIER_DEFAULTS.model)
})

test('tierChain falls back through sensible tiers', () => {
  assert.deepStrictEqual(tierChain({ reflection: ['r'] }, 'reflection'), ['r'])
  assert.deepStrictEqual(tierChain({ attention: ['a'] }, 'reflection'), ['a'])
  assert.deepStrictEqual(tierChain({ model: ['m'] }, 'reflection'), ['m'])
  assert.deepStrictEqual(tierChain({ model: ['m'] }, 'subagent'), ['m'])
  assert.strictEqual(tierChain({}, 'transcription'), null)
  assert.strictEqual(tierChain({ model: ['m'] }, 'transcription'), null)
})
