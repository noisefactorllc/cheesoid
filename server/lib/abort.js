import { setTimeout as delay } from 'node:timers/promises'

export async function abortableDelay(ms, signal) {
  signal?.throwIfAborted()
  await delay(ms, undefined, signal ? { signal } : undefined)
}
