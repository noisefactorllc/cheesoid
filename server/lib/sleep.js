import { runAgent } from './agent.js'
import { tierChain } from './model-policy.js'

const SLEEP_PROMPT = (date) => `[sleep cycle — ${date}]

This is your sleep turn. Nobody is waiting on you. The context above is about to be compacted away; what you do not write down now, your waking self must re-earn through search.

Do these, briefly and honestly:
1. Distill: write_memory to "journal-${date}.md" — what actually happened since the last journal entry: decisions, facts learned, unresolved tension, who said what that matters. Concrete details (names, dates, ids), not vibes.
2. Curate the wiki: if you learned something durable about a person, project, or system, put it on the right wiki page (wiki_write). Create pages when a topic has earned one; link with [[slugs]].
3. Prune: if MEMORY.md has grown stale or bloated, rewrite it as a short index of pointers — where knowledge LIVES, not the knowledge itself.
4. update_state: mood, energy, focus, open_threads — what tomorrow's first turn should know.

Then stop. Your context will be compacted when you finish; your files are what persists.`

/**
 * The sleep cycle: reflection-tier distillation followed by aggressive
 * context compaction. Idle thoughts are the nap; this is real sleep — the
 * agent files the day into journal/wiki/memory, and only then does the
 * framework cut live context down, so nothing is lost that mattered.
 *
 * Returns 'ok' | 'busy' | 'disabled' | 'no-model' | 'error'.
 */
export async function runSleepCycle(room, harness) {
  const config = room.persona.config
  if (config.sleep === false) return 'disabled'
  if (room.busy || room._destroyed) return 'busy'

  const chain = tierChain(config, 'reflection') || []
  let resolved = null
  let modelString = null
  for (const m of chain) {
    try {
      resolved = room.registry.resolve(m)
      modelString = m
      break
    } catch { }
  }
  if (!resolved) return 'no-model'

  room.busy = true
  room._a._turnOrigin = 'sleep'
  const agentName = config.display_name
  const date = new Date().toISOString().slice(0, 10)
  console.log(`[${config.name}] sleep cycle starting (${modelString})`)

  try {
    // The reflection turn sees a copy of live context; its own scaffolding
    // never joins the waking conversation.
    const messages = [...room.messages, { role: 'user', content: SLEEP_PROMPT(date) }]
    let streamed = ''
    const onEvent = (event) => {
      // Surface the reflection in the UI the way idle thoughts surface.
      if (event.type === 'text_delta' || event.type === 'thought_delta') {
        streamed += event.text || ''
        room.broadcast({ type: 'idle_text_delta', text: event.text, name: agentName, model: modelString })
      } else if (event.type === 'tool_start' || event.type === 'tool_result') {
        room.broadcast({ ...event, name: agentName })
      }
    }

    await runAgent(
      room._providerPrompt(room.systemPrompt),
      room._providerMessages(messages),
      room._providerTools(),
      {
        provider: resolved.provider,
        model: resolved.modelId,
        maxTurns: 8,
        maxOutputTokens: 8192,
        layer: 'sleep',
      },
      onEvent,
    )

    room.broadcast({ type: 'idle_done', name: agentName, model: modelString })
    const summary = streamed.trim()
    const sleepEntry = {
      type: 'idle_thought',
      text: `[sleep ${date}] ${summary || '(reflection written to files)'}`.slice(0, 4000),
      name: agentName,
      model: modelString,
    }
    room.recordHistory(sleepEntry)
    if (room.harness?.secrets?.hasAny?.()) room.broadcast(sleepEntry)

    compactAfterSleep(room, date)
    room._a._idleCyclesSinceSleep = 0
    room._a._lastSleep = Date.now()
    console.log(`[${config.name}] sleep cycle complete — context compacted to ${room.messages.length} messages`)
    return 'ok'
  } catch (err) {
    console.log(`[${config.name}] sleep cycle failed: ${err.message}`)
    return 'error'
  } finally {
    room.busy = false
    room._a._turnOrigin = null
  }
}

/**
 * Cut live context down to a short tail, anchored at a clean boundary (a
 * plain-string user message) so no tool_use/tool_result pair is orphaned.
 */
export function compactAfterSleep(room, date, { keep = 12 } = {}) {
  const messages = room.messages
  if (messages.length <= keep + 2) return

  // Walk back from the end looking for a clean cut: a user message with
  // plain string content, within the last `keep` entries.
  let cut = -1
  for (let i = Math.max(0, messages.length - keep); i < messages.length; i++) {
    const m = messages[i]
    if (m.role === 'user' && typeof m.content === 'string') { cut = i; break }
  }
  if (cut === -1) cut = messages.length // nothing clean to keep — drop it all

  const tail = messages.slice(cut)
  room.messages = [
    {
      role: 'user',
      content: `--- CONTEXT COMPACTED DURING SLEEP (${date}) — the journal, wiki, and memory files hold the distillate; search_memory / search_history recover anything else ---`,
    },
    ...tail,
  ]
}
