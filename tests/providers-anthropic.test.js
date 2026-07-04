import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAnthropicProvider, toAnthropicToolChoice, _buildParams } from '../server/lib/providers/anthropic.js'

describe('toAnthropicToolChoice', () => {
  // Cheesoid's canonical toolChoice value meaning "must call a tool" is
  // 'required' (OpenAI/Vertex convention). Anthropic's API only accepts
  // 'auto' | 'any' | 'tool' | 'none', and 'any' is the equivalent of
  // 'required'. Other providers (gemini, openai-*) handle this mapping
  // already; this function is the Anthropic side.
  it("maps 'required' to 'any'", () => {
    assert.equal(toAnthropicToolChoice('required'), 'any')
  })

  it("passes 'auto' through unchanged", () => {
    assert.equal(toAnthropicToolChoice('auto'), 'auto')
  })

  it("passes 'none' through unchanged", () => {
    assert.equal(toAnthropicToolChoice('none'), 'none')
  })

  it("passes 'tool' through unchanged", () => {
    assert.equal(toAnthropicToolChoice('tool'), 'tool')
  })

  it('passes undefined through unchanged', () => {
    assert.equal(toAnthropicToolChoice(undefined), undefined)
  })
})

describe('createAnthropicProvider', () => {
  it('throws when ANTHROPIC_API_KEY is not set on first streamMessage call', async () => {
    const original = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const provider = createAnthropicProvider({})
      // Creation succeeds (lazy) — but streaming throws
      assert.equal(typeof provider.streamMessage, 'function')
      await assert.rejects(
        () => provider.streamMessage({ model: 'test', maxTokens: 1, system: '', messages: [], tools: [] }, () => {}),
        /ANTHROPIC_API_KEY/,
      )
    } finally {
      if (original) process.env.ANTHROPIC_API_KEY = original
    }
  })

  it('returns an object with streamMessage method', () => {
    const original = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'test-key'
    try {
      const provider = createAnthropicProvider({})
      assert.equal(typeof provider.streamMessage, 'function')
    } finally {
      if (original) {
        process.env.ANTHROPIC_API_KEY = original
      } else {
        delete process.env.ANTHROPIC_API_KEY
      }
    }
  })
})

describe('_buildParams — extended thinking', () => {
  const base = { system: 'sys', messages: [], tools: [{ name: 'bash' }] }

  it('enables thinking for a Sonnet model and raises max_tokens to budget + 4096', () => {
    const params = _buildParams({ ...base, model: 'claude-sonnet-4-6', maxTokens: 16384, thinkingBudget: 16000 })
    assert.deepEqual(params.thinking, { type: 'enabled', budget_tokens: 16000 })
    assert.equal(params.max_tokens, 20096) // Math.max(16384, 16000 + 4096)
  })

  it('enables thinking for a Haiku model too (no Opus-only gate)', () => {
    const params = _buildParams({ ...base, model: 'claude-haiku-4-5', maxTokens: 16384, thinkingBudget: 8000 })
    assert.deepEqual(params.thinking, { type: 'enabled', budget_tokens: 8000 })
  })

  it('does not lower max_tokens when it already exceeds budget + 4096', () => {
    const params = _buildParams({ ...base, model: 'claude-opus-4-6', maxTokens: 40000, thinkingBudget: 16000 })
    assert.equal(params.max_tokens, 40000)
  })

  it('sets no thinking and leaves max_tokens when thinkingBudget is falsy', () => {
    const params = _buildParams({ ...base, model: 'claude-opus-4-6', maxTokens: 16384, thinkingBudget: null })
    assert.equal(params.thinking, undefined)
    assert.equal(params.max_tokens, 16384)
  })

  it("drops a forced tool_choice ('required' -> 'any') when thinking is enabled, keeping thinking", () => {
    const params = _buildParams({ ...base, model: 'claude-opus-4-6', maxTokens: 16384, thinkingBudget: 16000, toolChoice: 'required' })
    assert.equal(params.tool_choice, undefined)
    assert.deepEqual(params.thinking, { type: 'enabled', budget_tokens: 16000 })
  })

  it("drops tool_choice 'tool' when thinking is enabled", () => {
    const params = _buildParams({ ...base, model: 'claude-opus-4-6', maxTokens: 16384, thinkingBudget: 16000, toolChoice: 'tool' })
    assert.equal(params.tool_choice, undefined)
    assert.ok(params.thinking)
  })

  it("keeps tool_choice 'auto' alongside thinking", () => {
    const params = _buildParams({ ...base, model: 'claude-opus-4-6', maxTokens: 16384, thinkingBudget: 16000, toolChoice: 'auto' })
    assert.deepEqual(params.tool_choice, { type: 'auto' })
    assert.ok(params.thinking)
  })

  it("keeps a forced tool_choice ('any') when thinking is NOT enabled", () => {
    const params = _buildParams({ ...base, model: 'claude-sonnet-4-6', maxTokens: 16384, toolChoice: 'required' })
    assert.deepEqual(params.tool_choice, { type: 'any' })
    assert.equal(params.thinking, undefined)
  })
})

describe('_buildParams — prompt caching', () => {
  const M = { model: 'claude-sonnet-4-6', maxTokens: 1024 }

  it('passes a native {type:text} content-block system array through unchanged (cache_control preserved)', () => {
    const system = [
      { type: 'text', text: 'STATIC CORPUS', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'DYNAMIC TAIL' },
    ]
    const params = _buildParams({ ...M, system, messages: [], tools: [] })
    // Same reference — the block array (and its ephemeral breakpoint) is not flattened.
    assert.equal(params.system, system)
    assert.deepEqual(params.system[0].cache_control, { type: 'ephemeral' })
  })

  it('flattens a {role,content}[] hierarchy system to a single joined string', () => {
    const system = [{ role: 'system', content: 'A' }, { role: 'system', content: 'B' }]
    const params = _buildParams({ ...M, system, messages: [], tools: [] })
    assert.equal(params.system, 'A\n\n---\n\nB')
  })

  it('keeps a plain string system as-is', () => {
    const params = _buildParams({ ...M, system: 'plain', messages: [], tools: [] })
    assert.equal(params.system, 'plain')
  })

  it('marks the last tool with cache_control without mutating the caller array (copy-on-write)', () => {
    const tools = [{ name: 'a' }, { name: 'b' }]
    const params = _buildParams({ ...M, system: 'sys', messages: [], tools })
    assert.deepEqual(params.tools[1].cache_control, { type: 'ephemeral' })
    assert.equal(params.tools[0].cache_control, undefined)
    // caller's array + element untouched
    assert.equal(tools[1].cache_control, undefined)
    assert.notEqual(params.tools[1], tools[1])
  })

  it('places the tool marker on the last tool including serverTools', () => {
    const tools = [{ name: 'a' }]
    const serverTools = [{ type: 'web_search_20250305', name: 'web_search' }]
    const params = _buildParams({ ...M, system: 'sys', messages: [], tools, serverTools })
    assert.equal(params.tools.length, 2)
    assert.deepEqual(params.tools[1].cache_control, { type: 'ephemeral' })
    assert.equal(params.tools[0].cache_control, undefined)
  })

  it('promotes a trailing string message to a cached text block (copy-on-write)', () => {
    const messages = [{ role: 'user', content: 'hello' }]
    const params = _buildParams({ ...M, system: 'sys', messages, tools: [] })
    assert.deepEqual(params.messages[0].content, [
      { type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } },
    ])
    // caller's message untouched — still a bare string
    assert.equal(messages[0].content, 'hello')
  })

  it('marks the last block of the last message, strips stale markers off older messages, keeps a single marker', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'old', cache_control: { type: 'ephemeral' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'mid' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }] },
    ]
    const params = _buildParams({ ...M, system: 'sys', messages, tools: [{ name: 'x' }] })
    // last message's last block carries the marker
    assert.deepEqual(params.messages[2].content[0].cache_control, { type: 'ephemeral' })
    // the stale marker on the older (first) message is stripped
    assert.equal('cache_control' in params.messages[0].content[0], false)
    // exactly one message carries a marker (max 4 breakpoints; system+tools+messages = 3)
    const marked = params.messages.filter(
      m => Array.isArray(m.content) && m.content.some(b => b && b.cache_control),
    )
    assert.equal(marked.length, 1)
    // caller inputs untouched (copy-on-write)
    assert.deepEqual(messages[0].content[0].cache_control, { type: 'ephemeral' })
    assert.equal(messages[2].content[0].cache_control, undefined)
  })

  it('leaves an empty messages array empty (no marker)', () => {
    const params = _buildParams({ ...M, system: 'sys', messages: [], tools: [] })
    assert.deepEqual(params.messages, [])
  })
})
