import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Modality } from '../server/lib/modality.js'

const config = {
  attention: 'claude-haiku-3-5:anthropic',
  cognition: 'claude-sonnet-4-5:anthropic',
}

describe('Modality', () => {
  it('starts in attention mode', () => {
    const m = new Modality(config)
    assert.equal(m.mode, 'attention')
  })

  it('steps up to cognition', () => {
    const m = new Modality(config)
    const result = m.stepUp('user addressed me directly')
    assert.equal(m.mode, 'cognition')
    assert.equal(result.previous, 'attention')
    assert.equal(result.current, 'cognition')
  })

  it('steps down to attention', () => {
    const m = new Modality(config)
    m.stepUp('engaging')
    const result = m.stepDown('conversation went quiet')
    assert.equal(m.mode, 'attention')
    assert.equal(result.previous, 'cognition')
    assert.equal(result.current, 'attention')
  })

  it('step_up from cognition is a no-op', () => {
    const m = new Modality(config)
    m.stepUp('first up')
    const result = m.stepUp('already in cognition')
    assert.equal(m.mode, 'cognition')
    assert.equal(result.previous, 'cognition')
    assert.equal(result.current, 'cognition')
  })

  it('step_down from attention is a no-op', () => {
    const m = new Modality(config)
    const result = m.stepDown('already in attention')
    assert.equal(m.mode, 'attention')
    assert.equal(result.previous, 'attention')
    assert.equal(result.current, 'attention')
  })

  it('provides tool definitions (2 tools)', () => {
    const m = new Modality(config)
    const tools = m.toolDefinitions()
    assert.equal(tools.length, 2)
    const names = tools.map(t => t.name)
    assert.ok(names.includes('step_up'))
    assert.ok(names.includes('step_down'))
  })

  it('executes step_up tool with _stepUp flag', () => {
    const m = new Modality(config)
    const result = m.executeTool('step_up', { reason: 'user is talking to me' })
    assert.ok(result.output.includes('attention'))
    assert.ok(result.output.includes('cognition'))
    assert.ok(result.output.includes('user is talking to me'))
    assert.equal(result._stepUp, true)
  })

  it('executes step_down tool', () => {
    const m = new Modality(config)
    m.stepUp('first engage')
    const result = m.executeTool('step_down', { reason: 'going quiet' })
    assert.ok(result.output.includes('cognition'))
    assert.ok(result.output.includes('attention'))
    assert.ok(result.output.includes('going quiet'))
    assert.equal('_stepUp' in result, false)
  })

  it('returns null for unknown tool', () => {
    const m = new Modality(config)
    const result = m.executeTool('nonexistent_tool', {})
    assert.equal(result, null)
  })

  it('isModal true when both fields set', () => {
    const m = new Modality(config)
    assert.equal(m.isModal, true)
  })

  it('isModal false when constructed with null config', () => {
    const m = new Modality(null)
    assert.equal(m.isModal, false)
    assert.equal(m.mode, null)
  })
})
