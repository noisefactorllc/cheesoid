// Routes model output into two visible lanes: chat and thought.
//
// Bans enforced by this module:
//   - No dropped messages. Every byte of input appears in exactly one lane.
//   - No thought in chat. Narration-tag content never appears in the chat lane.
//   - No chat in thought. Explicit <chat> escape inside a narration block
//     promotes its inner content to the chat lane.
//
// Narration tags: <thinking>, <internal>, <execute_protocol>, <inner_voice>,
// <reasoning>, <thought>.
//
// Unbalanced tags are tolerated. An open tag with no matching close closes at
// end-of-input. An orphan close is treated as literal text (which means the
// preceding content was chat, since there was no open to begin thought).
//
// <chat>...</chat> inside a narration block escapes back to chat. Orphan
// <chat> open tags are treated as literal text to avoid accidental promotion.

const NARRATION_TAGS = ['thinking', 'internal', 'execute_protocol', 'inner_voice', 'reasoning', 'thought', 'tool_code', 'parameter']
const CHAT_ESCAPE_TAG = 'chat'

/**
 * Split complete text into chat and thought segments preserving temporal order.
 * Before running the tag-based router, preprocess forms of narration that
 * don't use tags — leading JSON reasoning blobs and code fences carrying
 * model-emitted pseudo-tool-calls — by wrapping them in <thought> so the
 * router routes them to the thought lane. Content is preserved, never
 * stripped; ban #9 (hiding text) forbids dropping any of this silently.
 * @param {string} text
 * @returns {{ chat: string, thought: string, segments: Array<{lane: 'chat'|'thought', text: string}> }}
 */
export function splitChatAndThought(text) {
  if (!text) return { chat: '', thought: '', segments: [] }
  const prepared = _wrapNonTagNarration(text)
  const router = new LaneRouter()
  const segs = router.push(prepared)
  const finalSegs = router.flush()
  const all = [...segs, ...finalSegs]
  let chat = ''
  let thought = ''
  for (const s of all) {
    if (s.lane === 'chat') chat += s.text
    else thought += s.text
  }
  return { chat, thought, segments: all }
}

/**
 * Wrap non-tag narration forms in <thought>...</thought> so the LaneRouter
 * routes them to the thought lane:
 *  - Leading JSON reasoning blobs like {"thought":"..."} or {"reasoning":"..."}
 *  - Code fences carrying pseudo-tool-calls (```tool_code / ```python with
 *    print/def/import patterns)
 *
 * Models frequently emit these as private reasoning. Pre-wrap router input
 * is simpler than extending the tag parser.
 */
function _wrapNonTagNarration(text) {
  let out = text
  // Leading JSON reasoning blobs — capture all consecutive ones at the start
  const jsonBlobRe = /^\s*\{\s*"(?:thought|backchannel|reasoning|inner_voice|analysis|inside_voice)"\s*:[\s\S]*?\}\s*(?=(?:\{\s*"|[^{]|$))/
  let leadingBlobs = ''
  while (true) {
    const m = out.match(jsonBlobRe)
    if (!m) break
    leadingBlobs += m[0]
    out = out.slice(m[0].length)
  }
  if (leadingBlobs) {
    out = `<thought>${leadingBlobs}</thought>${out}`
  }
  // Code fences containing pseudo-tool-calls
  out = out.replace(/```(?:tool_code|python)?\s*(?:print|def |import )[\s\S]*?```/g, m => `<thought>${m}</thought>`)
  return out
}

/**
 * Streaming splitter. Accepts deltas and emits lane-tagged segments as soon as
 * they can be safely resolved. Content that straddles a tag boundary is held
 * until the boundary is known.
 *
 * Emission guarantee: for each push(), returns an array of already-safe
 * segments since the last push. Remaining held content is emitted by flush()
 * (call at end-of-turn). No content is ever lost.
 */
export class LaneRouter {
  constructor() {
    this._buffer = ''              // unrouted raw input
    this._currentLane = 'chat'      // which narration depth we're in (chat if none)
    this._narrationStack = []       // stack of open narration tag names
    this._inChatEscape = false      // true when inside <chat> inside narration
  }

  /**
   * Accept a chunk of input. Returns lane-tagged segments that can be safely
   * emitted now. Anything ambiguous stays in the internal buffer.
   */
  push(chunk) {
    if (!chunk) return []
    this._buffer += chunk
    return this._drain(false)
  }

  /**
   * Final flush at end-of-turn. Emits any remaining buffered content under the
   * current lane — unclosed narration is still preserved as thought; a dangling
   * literal '<' is treated as chat text.
   */
  flush() {
    return this._drain(true)
  }

  /**
   * Drain what we can from the buffer. In streaming mode (final=false), holds
   * anything after an unmatched '<' to wait for the closing '>'. In final mode,
   * commits whatever's left under the current lane.
   */
  _drain(final) {
    const out = []
    while (this._buffer.length > 0) {
      const nextLt = this._buffer.indexOf('<')
      if (nextLt === -1) {
        // No more tags — emit the whole buffer under the current lane.
        out.push(this._emit(this._buffer))
        this._buffer = ''
        break
      }
      if (nextLt > 0) {
        // Flush plain text up to the next '<'.
        out.push(this._emit(this._buffer.slice(0, nextLt)))
        this._buffer = this._buffer.slice(nextLt)
        continue
      }
      // Buffer starts with '<'. Try to parse a tag.
      const gtIdx = this._buffer.indexOf('>')
      if (gtIdx === -1) {
        if (final) {
          // Stray '<' at end of stream — emit as literal.
          out.push(this._emit(this._buffer))
          this._buffer = ''
        }
        // Not final: hold — a closing '>' may arrive in a later chunk.
        break
      }
      const tagText = this._buffer.slice(0, gtIdx + 1)
      const parsed = parseTag(tagText)
      this._buffer = this._buffer.slice(gtIdx + 1)

      if (!parsed) {
        // Not a recognized tag (e.g. `<!--` or random `<x>` we don't handle).
        // Emit the whole `<...>` sequence as literal content under current lane.
        out.push(this._emit(tagText))
        continue
      }

      const { name, close } = parsed
      const nameLower = name.toLowerCase()

      if (nameLower === CHAT_ESCAPE_TAG) {
        // <chat> is only meaningful inside narration. Outside, it's literal.
        if (!close && this._narrationStack.length > 0 && !this._inChatEscape) {
          this._inChatEscape = true
          this._currentLane = 'chat'
        } else if (close && this._inChatEscape) {
          this._inChatEscape = false
          this._currentLane = 'thought'
        } else {
          out.push(this._emit(tagText))
        }
        continue
      }

      if (NARRATION_TAGS.includes(nameLower)) {
        if (!close) {
          // Opening a narration tag.
          if (this._inChatEscape) {
            // Nested narration inside a chat escape — treat as literal.
            out.push(this._emit(tagText))
            continue
          }
          this._narrationStack.push(nameLower)
          this._currentLane = 'thought'
        } else {
          // Closing a narration tag. Pop if on top; otherwise orphan close.
          const topIdx = this._narrationStack.lastIndexOf(nameLower)
          if (topIdx === -1) {
            // Orphan close — tag markup itself is not content, so consume it
            // silently (the surrounding text is already emitted under the
            // correct lane). No content is lost; only the malformed markup is.
          } else {
            // Pop stack down to and including the matching open.
            this._narrationStack.length = topIdx
            if (this._narrationStack.length === 0) {
              this._currentLane = 'chat'
              this._inChatEscape = false
            } else {
              this._currentLane = 'thought'
            }
          }
        }
        continue
      }

      // Unknown tag — emit as literal so we never drop content.
      out.push(this._emit(tagText))
    }
    // Collapse adjacent segments on the same lane.
    return collapseSegments(out.filter(s => s.text.length > 0))
  }

  _emit(text) {
    return { lane: this._currentLane, text }
  }
}

function parseTag(tagText) {
  // Matches <name>, </name>, <name attr=value>, <name/>, etc.
  // Returns { name, close } or null if not a recognizable tag.
  const m = tagText.match(/^<\s*(\/?)\s*([a-zA-Z_][\w-]*)\b[^>]*>$/)
  if (!m) return null
  return { close: m[1] === '/', name: m[2] }
}

function collapseSegments(segs) {
  const out = []
  for (const s of segs) {
    if (out.length > 0 && out[out.length - 1].lane === s.lane) {
      out[out.length - 1].text += s.text
    } else {
      out.push({ ...s })
    }
  }
  return out
}
