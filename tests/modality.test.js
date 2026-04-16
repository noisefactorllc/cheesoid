import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Modality } from '../server/lib/modality.js'

const threeTier = {
  attention: ['claude-haiku-3-5:anthropic'],
  cognition: ['claude-sonnet-4-5:anthropic'],
  reasoner: ['claude-opus-4-6:anthropic'],
}

const twoTier = {
  attention: ['claude-haiku-3-5:anthropic'],
  cognition: ['claude-sonnet-4-5:anthropic'],
}

describe('Modality', () => {
  it('starts in attention mode', () => {
    const m = new Modality(threeTier)
    assert.equal(m.mode, 'attention')
    assert.equal(m.model, 'claude-haiku-3-5:anthropic')
  })

  it('stepUp advances attention → cognition', () => {
    const m = new Modality(threeTier)
    const r = m.stepUp('user addressed me')
    assert.equal(m.mode, 'cognition')
    assert.equal(r.previous, 'attention')
    assert.equal(r.current, 'cognition')
    assert.equal(r.changed, true)
  })

  it('default stepUp from cognition is a no-op (does not auto-escalate to reasoner)', () => {
    const m = new Modality(threeTier)
    m.stepUp('engaging') // → cognition
    const r = m.stepUp('more engagement') // default target='cognition' → no-op
    assert.equal(m.mode, 'cognition')
    assert.equal(r.changed, false)
  })

  it('explicit stepUp to reasoner from cognition works', () => {
    const m = new Modality(threeTier)
    m.stepUp('engaging')
    const r = m.stepUp('hard problem', 'reasoner')
    assert.equal(m.mode, 'reasoner')
    assert.equal(r.previous, 'cognition')
    assert.equal(r.current, 'reasoner')
    assert.equal(r.changed, true)
    assert.equal(m.model, 'claude-opus-4-6:anthropic')
  })

  it('stepUp to reasoner when no reasoner configured is a no-op', () => {
    const m = new Modality(twoTier)
    m.stepUp('engaging')
    const r = m.stepUp('hard problem', 'reasoner')
    assert.equal(m.mode, 'cognition')
    assert.equal(r.changed, false)
  })

  it('stepUp from reasoner is terminal', () => {
    const m = new Modality(threeTier)
    m.stepUp('x'); m.stepUp('y', 'reasoner')
    const r = m.stepUp('more', 'reasoner')
    assert.equal(m.mode, 'reasoner')
    assert.equal(r.changed, false)
  })

  it('stepDown defaults to attention from cognition', () => {
    const m = new Modality(threeTier)
    m.stepUp('x')
    const r = m.stepDown('quiet')
    assert.equal(m.mode, 'attention')
    assert.equal(r.previous, 'cognition')
    assert.equal(r.current, 'attention')
  })

  it('stepDown defaults to attention from reasoner', () => {
    const m = new Modality(threeTier)
    m.stepUp('x'); m.stepUp('y', 'reasoner')
    const r = m.stepDown('done reasoning')
    assert.equal(m.mode, 'attention')
    assert.equal(r.current, 'attention')
  })

  it('stepDown with target=cognition partially drops from reasoner', () => {
    const m = new Modality(threeTier)
    m.stepUp('x'); m.stepUp('y', 'reasoner')
    const r = m.stepDown('hold voice', 'cognition')
    assert.equal(m.mode, 'cognition')
    assert.equal(r.previous, 'reasoner')
    assert.equal(r.current, 'cognition')
  })

  it('stepDown from attention is a no-op', () => {
    const m = new Modality(threeTier)
    const r = m.stepDown('nothing')
    assert.equal(m.mode, 'attention')
    assert.equal(r.changed, false)
  })

  it('stepDown with invalid (higher or equal) target is a no-op', () => {
    const m = new Modality(threeTier)
    m.stepUp('x') // cognition
    const higher = m.stepDown('bad', 'reasoner')
    assert.equal(higher.changed, false)
    const same = m.stepDown('bad', 'cognition')
    assert.equal(same.changed, false)
    assert.equal(m.mode, 'cognition')
  })

  it('model reflects current tier; fallbackModels returns the rest of that tier', () => {
    const m = new Modality({
      attention: ['a1', 'a2'],
      cognition: ['c1', 'c2', 'c3'],
      reasoner: ['r1', 'r2'],
    })
    assert.equal(m.model, 'a1')
    assert.deepEqual(m.fallbackModels, ['a2'])
    m.stepUp('x')
    assert.equal(m.model, 'c1')
    assert.deepEqual(m.fallbackModels, ['c2', 'c3'])
    m.stepUp('y', 'reasoner')
    assert.equal(m.model, 'r1')
    assert.deepEqual(m.fallbackModels, ['r2'])
  })

  it('exposes only step_up in attention mode', () => {
    const m = new Modality(threeTier)
    const tools = m.toolDefinitions()
    assert.equal(tools.length, 1)
    assert.equal(tools[0].name, 'step_up')
  })

  it('exposes step_up AND step_down in cognition when reasoner configured', () => {
    const m = new Modality(threeTier)
    m.stepUp('engaging')
    const names = m.toolDefinitions().map(t => t.name).sort()
    assert.deepEqual(names, ['step_down', 'step_up'])
  })

  it('exposes only step_down in cognition when no reasoner configured', () => {
    const m = new Modality(twoTier)
    m.stepUp('engaging')
    const tools = m.toolDefinitions()
    assert.equal(tools.length, 1)
    assert.equal(tools[0].name, 'step_down')
  })

  it('exposes only step_down in reasoner mode', () => {
    const m = new Modality(threeTier)
    m.stepUp('x'); m.stepUp('y', 'reasoner')
    const tools = m.toolDefinitions()
    assert.equal(tools.length, 1)
    assert.equal(tools[0].name, 'step_down')
  })

  it('step_down tool in reasoner mode accepts cognition or attention', () => {
    const m = new Modality(threeTier)
    m.stepUp('x'); m.stepUp('y', 'reasoner')
    const tool = m.toolDefinitions().find(t => t.name === 'step_down')
    assert.deepEqual(
      tool.input_schema.properties.target_layer.enum.sort(),
      ['attention', 'cognition']
    )
  })

  it('step_down tool in cognition mode only accepts attention', () => {
    const m = new Modality(threeTier)
    m.stepUp('x')
    const tool = m.toolDefinitions().find(t => t.name === 'step_down')
    assert.deepEqual(tool.input_schema.properties.target_layer.enum, ['attention'])
  })

  it('executeTool step_up advances exactly one gear', () => {
    const m = new Modality(threeTier)
    let r = m.executeTool('step_up', { reason: 'user talking' })
    assert.equal(m.mode, 'cognition')
    assert.equal(r._stepUp, true)
    r = m.executeTool('step_up', { reason: 'hard problem' })
    assert.equal(m.mode, 'reasoner')
    assert.equal(r._stepUp, true)
    r = m.executeTool('step_up', { reason: 'already top' })
    assert.equal(r._stepUp, false)
  })

  it('executeTool step_down defaults to attention', () => {
    const m = new Modality(threeTier)
    m.stepUp('x'); m.stepUp('y', 'reasoner')
    const r = m.executeTool('step_down', { reason: 'quiet' })
    assert.equal(m.mode, 'attention')
    assert.ok(r.output.includes('attention'))
    assert.equal('_stepUp' in r, false)
  })

  it('executeTool step_down honors target_layer', () => {
    const m = new Modality(threeTier)
    m.stepUp('x'); m.stepUp('y', 'reasoner')
    m.executeTool('step_down', { reason: 'hold voice', target_layer: 'cognition' })
    assert.equal(m.mode, 'cognition')
  })

  it('returns null for unknown tool', () => {
    const m = new Modality(threeTier)
    assert.equal(m.executeTool('nope', {}), null)
  })

  it('isModal false when attention or cognition missing', () => {
    assert.equal(new Modality(null).isModal, false)
    assert.equal(new Modality({}).isModal, false)
    assert.equal(new Modality({ attention: ['x'] }).isModal, false)
    assert.equal(new Modality({ cognition: ['x'] }).isModal, false)
  })

  it('hasReasoner reflects config presence', () => {
    assert.equal(new Modality(threeTier).hasReasoner(), true)
    assert.equal(new Modality(twoTier).hasReasoner(), false)
  })
})
