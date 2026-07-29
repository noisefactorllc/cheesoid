import { test } from 'node:test'
import assert from 'node:assert'
import { applyModelPolicy, TIER_DEFAULTS, tierChain, shouldEnableSleep, validateRunnableModel } from '../server/lib/model-policy.js'

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
  assert.strictEqual(config.reflection, undefined)
  assert.strictEqual(config.transcription, undefined)
  assert.strictEqual(config.subagent, undefined)
})

test('model_policy default explicitly opts a configured persona into all defaults', () => {
  const config = { name: 'opted-in', model: ['legacy:anthropic'], model_policy: 'default' }
  applyModelPolicy(config, { hasOpenRouter: true })
  assert.deepStrictEqual(config.model, ['legacy:anthropic'])
  assert.deepStrictEqual(config.reflection, TIER_DEFAULTS.reflection)
  assert.deepStrictEqual(config.subagent, TIER_DEFAULTS.subagent)
})

test('an allow-list-only model_policy object does not opt a legacy persona into paid defaults', () => {
  const config = {
    name: 'legacy-policy',
    model: ['legacy:anthropic'],
    model_policy: { allow: ['legacy:anthropic'] },
  }
  const filled = applyModelPolicy(config, { hasOpenRouter: true })
  assert.deepStrictEqual(filled, [])
  assert.strictEqual(config.reflection, undefined)
  assert.strictEqual(config.transcription, undefined)
  assert.strictEqual(config.subagent, undefined)
  assert.equal(shouldEnableSleep(config), false)
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

test('sleep defaults only for policy-default personas or explicit sleep config', () => {
  assert.equal(shouldEnableSleep({ model: ['legacy'] }), false)
  assert.equal(shouldEnableSleep({ model: ['legacy'], sleep: false }), false)
  assert.equal(shouldEnableSleep({ model: ['legacy'], sleep: { schedule: '0 4 * * *' } }), true)
  assert.equal(shouldEnableSleep({ _modelPolicy: { defaultsEnabled: true } }), true)
})

// Capture console.log for warning-assertion tests.
function captureLogs() {
  const original = console.log
  const messages = []
  console.log = (...args) => { messages.push(args.map(String).join(' ')) }
  return {
    messages,
    find: (re) => messages.find(m => re.test(m)),
    restore: () => { console.log = original },
  }
}

// Finding 4: model_policy: 'default' with every extended tier set by hand fills
// nothing, so the old code never wrote the defaultsEnabled marker and sleep was
// silently disabled — contradicting the documented default schedule.
test('model_policy default keeps sleep enabled even when all extended tiers are explicit', () => {
  const config = {
    name: 'fully-explicit',
    model: ['legacy:anthropic'],
    model_policy: 'default',
    reflection: ['r:openrouter'],
    transcription: ['t:openrouter'],
    subagent: ['s:openrouter'],
  }
  const filled = applyModelPolicy(config, { hasOpenRouter: true })
  assert.deepStrictEqual(filled, [], 'nothing needed filling')
  assert.ok(config._modelPolicy, 'the policy marker is written anyway')
  assert.strictEqual(config._modelPolicy.defaultsEnabled, true)
  assert.equal(shouldEnableSleep(config), true)
})

// A zero-config persona still writes the marker (regression guard for finding 4).
test('zero-config persona records defaultsEnabled', () => {
  const config = { name: 'bare' }
  applyModelPolicy(config, { hasOpenRouter: true })
  assert.strictEqual(config._modelPolicy.defaultsEnabled, true)
  assert.equal(shouldEnableSleep(config), true)
})

// Finding 5: a per-tier model_policy override of an explicit top-level tier is
// still honored, but now logs a conflict warning so the clobber isn't silent.
test('model_policy override of an explicit top-level tier logs a conflict warning', () => {
  const logs = captureLogs()
  let config
  try {
    config = {
      name: 'conflict',
      cognition: ['explicit/cog:openrouter'],
      model_policy: { cognition: ['policy/cog:openrouter'] },
    }
    applyModelPolicy(config, { hasOpenRouter: true })
  } finally {
    logs.restore()
  }
  // Override still wins — behavior preserved.
  assert.deepStrictEqual(config.cognition, ['policy/cog:openrouter'])
  assert.ok(
    logs.find(/model_policy\.cognition overrides the explicit top-level cognition tier/i),
    'a conflict warning is logged',
  )
})

// executor override of an explicit top-level execution (model) tier also warns.
test('model_policy.executor override of an explicit execution tier warns', () => {
  const logs = captureLogs()
  let config
  try {
    config = {
      name: 'exec-conflict',
      model: ['explicit/exec:openrouter'],
      model_policy: { executor: ['policy/exec:openrouter'] },
    }
    applyModelPolicy(config, { hasOpenRouter: true })
  } finally {
    logs.restore()
  }
  assert.deepStrictEqual(config.model, ['policy/exec:openrouter'])
  assert.ok(
    logs.find(/model_policy\.executor overrides the explicit top-level execution tier/i),
    'a conflict warning is logged for the execution tier',
  )
})

// Finding 5: an unrecognized key inside a model_policy object silently no-ops
// today; warn so a typo'd tier name is visible.
test('an unrecognized model_policy key is warned about (typo protection)', () => {
  const logs = captureLogs()
  let config
  try {
    config = {
      name: 'typo',
      model: ['m:openrouter'],
      model_policy: { congition: ['x:openrouter'] }, // misspelled "cognition"
    }
    applyModelPolicy(config, { hasOpenRouter: true })
  } finally {
    logs.restore()
  }
  assert.strictEqual(config.cognition, undefined, 'the typo does nothing to cognition')
  assert.ok(logs.find(/unrecognized model_policy key "congition"/i), 'the typo is flagged')
})

// A recognized key (allow, a valid tier) must NOT trip the typo warning.
test('recognized model_policy keys do not trigger the typo warning', () => {
  const logs = captureLogs()
  try {
    applyModelPolicy(
      { name: 'ok', model: ['m:anthropic'], model_policy: { allow: ['m:anthropic'], subagent: ['s:openrouter'] } },
      { hasOpenRouter: true },
    )
  } finally {
    logs.restore()
  }
  assert.strictEqual(logs.find(/unrecognized model_policy key/i), undefined)
})

// Finding 7: a zero-config persona with no OPENROUTER key fills no model, then
// the first turn throws `config.model[0]` inside the swallowing turn-catch —
// the agent looks alive but never answers. validateRunnableModel makes that
// state detectable up front.
test('validateRunnableModel accepts any persona with a runnable tier', () => {
  assert.equal(validateRunnableModel({ model: ['m:openrouter'] }).ok, true)
  assert.equal(validateRunnableModel({ cognition: ['c:openrouter'] }).ok, true)
  assert.equal(validateRunnableModel({ orchestrator: 'gpt:openai' }).ok, true)
  assert.equal(validateRunnableModel({ reasoner: ['r:openrouter'] }).ok, true)
})

test('validateRunnableModel flags a persona with no runnable model tier', () => {
  const result = validateRunnableModel({ name: 'empty' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /OPENROUTER_API_KEY|model|tier/i)
})

test('a zero-config persona with no OPENROUTER key is detectably non-runnable', () => {
  const config = { name: 'stranded' }
  const filled = applyModelPolicy(config, { hasOpenRouter: false })
  assert.deepStrictEqual(filled, [])
  // The exact state that later dereferences an undefined config.model[0].
  assert.equal(validateRunnableModel(config).ok, false)
})

test('the same persona becomes runnable once the policy can fill from defaults', () => {
  const config = { name: 'rescued' }
  applyModelPolicy(config, { hasOpenRouter: true })
  assert.equal(validateRunnableModel(config).ok, true)
})
