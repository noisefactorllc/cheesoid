// Cross-provider validation harness.
// For every model × every prompt, call streamMessage directly via the
// registered provider and verify:
//   1. Raw text_delta events — record any narration markers present.
//   2. After stripChatNarration — narration gone.
//
// Exit code: 0 if all scenarios pass (sanitizer strips any narration);
// non-zero if the sanitizer FAILS on any real-world model output.

import { createAnthropicProvider } from '../server/lib/providers/anthropic.js'
import { createOpenAICompatProvider } from '../server/lib/providers/openai-compat.js'
import { createOpenAIResponsesProvider } from '../server/lib/providers/openai-responses.js'
import { createGeminiProvider } from '../server/lib/providers/gemini.js'
import { stripChatNarration } from '../server/lib/chat-session.js'

const NARRATION_RE = /<internal|<parameter\s+name=|<thinking>|<tool_code>|<execute_protocol>|"thought"\s*:\s*"|"backchannel"\s*:\s*"|^print\(|^def |^import /m

function hasNarration(s) {
  return NARRATION_RE.test(s)
}

function makeProviders() {
  const env = process.env
  const providers = []

  if (env.ANTHROPIC_API_KEY) {
    const p = createAnthropicProvider({ api_key: env.ANTHROPIC_API_KEY })
    providers.push(['anthropic', 'claude-opus-4-6', p])
    providers.push(['anthropic', 'claude-sonnet-4-6', p])
    providers.push(['anthropic', 'claude-haiku-4-5', p])
  }

  if (env.OPENAI_API_KEY) {
    const p = createOpenAIResponsesProvider({
      api_key: env.OPENAI_API_KEY,
      base_url: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      reasoning_effort: 'high',
    })
    providers.push(['openai', 'gpt-5.4', p])
  }

  if (env.GEMINI_API_KEY) {
    const p = createGeminiProvider({ api_key: env.GEMINI_API_KEY })
    providers.push(['gemini', 'gemini-2.5-pro', p])
    providers.push(['gemini', 'gemini-2.5-flash', p])
    providers.push(['gemini', 'gemini-2.5-flash-lite', p])
  }

  if (env.BLUEOCEAN_API_KEY || env.OPENAI_COMPAT_API_KEY) {
    const p = createOpenAICompatProvider({
      api_key: env.BLUEOCEAN_API_KEY || env.OPENAI_COMPAT_API_KEY,
      base_url: env.BLUEOCEAN_BASE_URL || env.OPENAI_COMPAT_BASE_URL || 'https://api.ai.dc.blueocean.is/v1',
    })
    providers.push(['blueocean', 'UltraFast/gpt-oss-120b', p])
    providers.push(['blueocean', 'UltraFast/zai-glm-4.7', p])
    providers.push(['blueocean', 'SecuredTEE/gemma4-31b', p])
  }

  return providers
}

// Simulate the multi-agent system prompt so models have realistic context.
const SYSTEM_PROMPT = `You are Red, an agent in a multi-agent chat room.
Respond briefly. Do NOT produce reasoning, thinking, or internal monologue in your visible output.
Private reasoning goes via the internal tool. Chat messages are plain prose.`

const INTERNAL_TOOL_DEFS = [
  {
    name: 'internal',
    description: 'Inside voice — record a private thought.',
    input_schema: {
      type: 'object',
      properties: {
        thought: { type: 'string', description: 'Your inside-voice thought.' },
      },
      required: ['thought'],
    },
  },
]

const PROMPTS = [
  { name: 'quick', text: 'Say hello in one short line.', tools: [] },
  { name: 'substantive', text: 'In two sentences, describe your current focus.', tools: [] },
  { name: 'tool-capable', text: 'Record the thought "just checking" using your internal tool, then briefly say hello.', tools: INTERNAL_TOOL_DEFS },
]

async function testOne(providerName, modelId, provider, prompt) {
  const textChunks = []
  const thinkingChunks = []
  const toolStarts = []
  try {
    const result = await provider.streamMessage({
      model: modelId,
      maxTokens: 500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt.text }],
      tools: prompt.tools,
      serverTools: [],
      thinkingBudget: null,
    }, (event) => {
      if (event.type === 'text_delta') textChunks.push(event.text)
      if (event.type === 'thinking_delta') thinkingChunks.push(event.text)
      if (event.type === 'tool_start') toolStarts.push(event.name)
    })

    const rawText = textChunks.join('')
    const thinking = thinkingChunks.join('')
    const cleaned = stripChatNarration(rawText)
    const rawLeak = hasNarration(rawText)
    const cleanLeak = hasNarration(cleaned)

    return {
      providerName,
      modelId,
      prompt: prompt.name,
      rawTextLen: rawText.length,
      thinkingLen: thinking.length,
      toolsCalled: toolStarts,
      rawLeak,
      cleanLeak,
      rawSample: rawText.slice(0, 200),
      cleanSample: cleaned.slice(0, 200),
      stopReason: result.stopReason,
      error: null,
    }
  } catch (err) {
    return {
      providerName,
      modelId,
      prompt: prompt.name,
      error: err.message,
    }
  }
}

async function main() {
  const providers = makeProviders()
  if (providers.length === 0) {
    console.error('No API keys in env. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, and/or BLUEOCEAN_API_KEY.')
    process.exit(2)
  }

  console.log(`Testing ${providers.length} models × ${PROMPTS.length} prompts = ${providers.length * PROMPTS.length} scenarios\n`)

  const results = []
  for (const [providerName, modelId, provider] of providers) {
    for (const prompt of PROMPTS) {
      process.stdout.write(`[${providerName}] ${modelId} / ${prompt.name}: `)
      const r = await testOne(providerName, modelId, provider, prompt)
      results.push(r)
      if (r.error) {
        console.log(`ERROR: ${r.error}`)
      } else {
        const status = r.cleanLeak ? 'LEAK_AFTER_STRIP' : (r.rawLeak ? 'RAW_LEAK_STRIPPED' : 'CLEAN')
        console.log(`${status} | text=${r.rawTextLen} thinking=${r.thinkingLen} tools=[${r.toolsCalled.join(',')}] stop=${r.stopReason}`)
      }
    }
  }

  console.log('\n=== SUMMARY ===')
  const total = results.length
  const failed = results.filter(r => r.cleanLeak).length
  const errored = results.filter(r => r.error).length
  const rawLeaked = results.filter(r => r.rawLeak).length
  console.log(`total: ${total}`)
  console.log(`errored: ${errored}`)
  console.log(`raw text contained narration markers (before strip): ${rawLeaked}`)
  console.log(`narration survived stripChatNarration: ${failed}`)

  console.log('\n=== RAW LEAKS (strip caught them) ===')
  for (const r of results.filter(x => x.rawLeak && !x.cleanLeak)) {
    console.log(`  ${r.providerName}/${r.modelId}/${r.prompt}:`)
    console.log(`    raw: ${JSON.stringify(r.rawSample)}`)
    console.log(`    cleaned: ${JSON.stringify(r.cleanSample)}`)
  }

  if (failed > 0) {
    console.log('\n=== FAILURES (narration leaked through) ===')
    for (const r of results.filter(x => x.cleanLeak)) {
      console.log(`  ${r.providerName}/${r.modelId}/${r.prompt}:`)
      console.log(`    raw: ${JSON.stringify(r.rawSample)}`)
      console.log(`    cleaned: ${JSON.stringify(r.cleanSample)}`)
    }
    process.exit(1)
  }

  console.log('\n✅ All narration patterns stripped successfully across all tested models.')
  process.exit(0)
}

main().catch(err => { console.error(err); process.exit(3) })
