import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { _rescueNarratedToolCall } from '../server/lib/agent.js'

const TOOL_DEFS = [
  { name: 'bash', description: 'Run a shell command' },
  { name: 'read_file', description: 'Read a file' },
  { name: 'list_memory', description: 'List memory files' },
]

describe('_rescueNarratedToolCall', () => {
  it('rescues clean JSON tool call', () => {
    const result = _rescueNarratedToolCall(
      '{"name":"bash","arguments":{"command":"ls"}}',
      TOOL_DEFS,
    )
    assert.equal(result.type, 'tool_use')
    assert.equal(result.name, 'bash')
    assert.deepEqual(result.input, { command: 'ls' })
    assert.ok(result.id.startsWith('toolu_rescued_'))
  })

  it('rescues tool call embedded in text', () => {
    const result = _rescueNarratedToolCall(
      'Let me check that. {"name":"list_memory","arguments":{}} I will look now.',
      TOOL_DEFS,
    )
    assert.equal(result.name, 'list_memory')
    assert.deepEqual(result.input, {})
  })

  it('rescues tool call with nested JSON in arguments', () => {
    const result = _rescueNarratedToolCall(
      '{"name":"bash","arguments":{"command":"echo {\\"key\\":\\"val\\"}"}}',
      TOOL_DEFS,
    )
    assert.equal(result.name, 'bash')
    assert.ok(result.input.command)
  })

  it('rescues XML-wrapped JSON tool call (haiku fallback)', () => {
    const TOOLS = [{ name: 'internal', description: 'inside voice' }]
    const result = _rescueNarratedToolCall(
      '<internal>{"backchannel":"all agents respond","trigger":true}</internal>\n\nHi.',
      TOOLS,
    )
    assert.equal(result.type, 'tool_use')
    assert.equal(result.name, 'internal')
    assert.deepEqual(result.input, { backchannel: 'all agents respond', trigger: true })
  })

  it('rescues XML-parameter tool call (Claude XML-tool-use fallback)', () => {
    const TOOLS = [{ name: 'internal', description: 'inside voice' }]
    const input = `<internal>
<parameter name="thought">
Let me think about this.
</parameter>
<parameter name="trigger">true</parameter>
</internal>

Noted.`
    const result = _rescueNarratedToolCall(input, TOOLS)
    assert.equal(result.type, 'tool_use')
    assert.equal(result.name, 'internal')
    assert.equal(result.input.trigger, true)
    assert.ok(result.input.thought.includes('Let me think about this.'))
  })

  it('coerces XML-parameter booleans and numbers', () => {
    const TOOLS = [{ name: 'x', description: '' }]
    const result = _rescueNarratedToolCall(
      '<x><parameter name="flag">true</parameter><parameter name="n">42</parameter><parameter name="s">hello</parameter></x>',
      TOOLS,
    )
    assert.deepEqual(result.input, { flag: true, n: 42, s: 'hello' })
  })

  it('returns null for unknown tool name', () => {
    const result = _rescueNarratedToolCall(
      '{"name":"delete_everything","arguments":{}}',
      TOOL_DEFS,
    )
    assert.equal(result, null)
  })

  it('returns null for empty string', () => {
    assert.equal(_rescueNarratedToolCall('', TOOL_DEFS), null)
  })

  it('returns null for whitespace only', () => {
    assert.equal(_rescueNarratedToolCall('   \n  ', TOOL_DEFS), null)
  })

  it('returns null for plain conversational text', () => {
    assert.equal(
      _rescueNarratedToolCall('Sure, I can help with that!', TOOL_DEFS),
      null,
    )
  })

  it('returns null for JSON without name field', () => {
    assert.equal(
      _rescueNarratedToolCall('{"action":"tool","arguments":{}}', TOOL_DEFS),
      null,
    )
  })

  it('returns null for JSON without arguments field', () => {
    assert.equal(
      _rescueNarratedToolCall('{"name":"bash"}', TOOL_DEFS),
      null,
    )
  })

  it('returns null for arguments that is not an object', () => {
    assert.equal(
      _rescueNarratedToolCall('{"name":"bash","arguments":"ls"}', TOOL_DEFS),
      null,
    )
  })

  it('returns null for malformed JSON', () => {
    assert.equal(
      _rescueNarratedToolCall('{"name":"bash","arguments":{broken', TOOL_DEFS),
      null,
    )
  })

  it('matches first valid JSON object when multiple are present', () => {
    const result = _rescueNarratedToolCall(
      'Here: {"name":"bash","arguments":{"cmd":"ls"}} and also {"name":"read_file","arguments":{"path":"/tmp"}}',
      TOOL_DEFS,
    )
    // Should match the first one
    assert.equal(result.name, 'bash')
    assert.deepEqual(result.input, { cmd: 'ls' })
  })

  it('returns null for empty tool definitions', () => {
    assert.equal(
      _rescueNarratedToolCall('{"name":"bash","arguments":{}}', []),
      null,
    )
  })

  it('handles whitespace in JSON', () => {
    const result = _rescueNarratedToolCall(
      '{ "name" : "bash" , "arguments" : { "command" : "ls" } }',
      TOOL_DEFS,
    )
    assert.equal(result.name, 'bash')
    assert.deepEqual(result.input, { command: 'ls' })
  })
})
