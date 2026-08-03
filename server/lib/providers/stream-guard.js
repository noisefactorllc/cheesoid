/**
 * One rule, shared by every streaming provider: a response stream that ends
 * without a terminal signal did not complete, and must not be reported as if
 * it had.
 *
 * A truncated stream is otherwise indistinguishable from a finished one. The
 * accumulator has content blocks, no exception was raised, and the only tell is
 * a stop reason that never arrived. Returning that as a success is what took
 * Brad silent on 2026-08-01: the orchestrator got `stopReason: null` with one
 * tool_use block, skipped tool execution because the stop reason was not
 * 'tool_use', found no text to emit, and ended the turn having said nothing and
 * logged nothing. Nothing retried, because nothing had failed.
 *
 * Failing loud here puts the condition back on the path that already exists for
 * provider failures — in-provider retry, then the orchestrator fallback chain,
 * then a visible error in the room. No provider gets its own recovery
 * behavior, and no provider gets to invent a stop reason it was never sent.
 */

export class TruncatedStreamError extends Error {
  constructor(provider) {
    super(`${provider} stream ended without a terminal event (no stop reason) — response truncated`)
    this.name = 'TruncatedStreamError'
    this.provider = provider
    this.isTruncatedStream = true
    // Transport-level truncation, not a rejected payload: the same request may
    // well succeed on a retry or a fallback model, so this must not be mistaken
    // for a malformed request (which no provider can ever accept).
    this.status = 503
  }
}

export class StreamStallError extends Error {
  constructor(provider, stallMs) {
    super(`${provider} stream delivered no data for ${Math.round(stallMs / 1000)}s — treating as stalled`)
    this.name = 'StreamStallError'
    this.provider = provider
    this.isStreamStall = true
    this.status = 504
  }
}

/**
 * Assert a stream produced a terminal stop reason, and return it.
 *
 * Providers call this immediately before returning their accumulated result,
 * so the check sits on the one path every stream exits through.
 */
export function assertStreamComplete(stopReason, provider) {
  if (!stopReason) throw new TruncatedStreamError(provider)
  return stopReason
}

/**
 * Await `promise`, rejecting with StreamStallError if it does not settle within
 * `stallMs`.
 *
 * Deliberately a gap-between-reads budget rather than a total-duration cap. A
 * long generation is not a broken one, and a total cap would sever legitimately
 * slow turns — Brad has been measured at a 93-second prefill on a 100K-token
 * prompt before the first byte arrives. What is never legitimate is a stream
 * that goes quiet indefinitely, which is the failure this bounds.
 */
export function withStallTimeout(promise, stallMs, provider) {
  let timer
  const stall = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new StreamStallError(provider, stallMs)), stallMs)
  })
  // The timer is deliberately NOT unref'd. It is the only thing keeping the
  // process alive while a read is outstanding, and a watchdog that lets the
  // event loop drain is a watchdog that never fires: the await it guards is
  // then stranded forever instead of rejecting. clearTimeout runs on every
  // settle path below, so holding the loop costs nothing and leaks nothing.
  return Promise.race([promise, stall]).finally(() => clearTimeout(timer))
}

/**
 * Default gap-between-reads budget. Generous on purpose: it exists to bound a
 * dead socket, not to police slow models, and cutting off a turn that was still
 * coming is a worse failure than the one being prevented.
 *
 * Sized against measurements rather than taste. The longest silence a healthy
 * turn is known to produce is prefill on a large prompt — Brad has been clocked
 * at 93 seconds before the first byte on a 100K-token context. Backends that
 * emit SSE keepalive comments during prefill reset this budget on every one, so
 * that number is the pessimistic case, not the typical one. The failure being
 * bounded sat silent for 387 seconds. 240s clears the worst measured prefill by
 * more than 2.5x while still recovering the turn well inside the observed hang.
 */
export const STREAM_STALL_MS = 240_000
