/**
 * Recognizing "this account is out of money" wherever it surfaces.
 *
 * Providers signal credit exhaustion with the same HTTP status they use for
 * ordinary rate limiting — 429 — but the two need opposite handling. A rate
 * limit clears on its own and is worth backing off for. Depleted credits do
 * not clear until somebody pays, so every retry is a request that cannot
 * succeed, spent against an endpoint already saying no.
 *
 * The distinction lives only in the response body, which is why this predicate
 * exists at the provider layer and not just at the agent layer: by the time an
 * error reaches the agent, whatever the body said has usually been discarded.
 * Gemini's credit-depletion notice was lost exactly that way and surfaced as
 * the uninformative `Gemini API error 429: ` for two days.
 */

const QUOTA_EXHAUSTED_PATTERNS = /insufficient_quota|RESOURCE_EXHAUSTED|credits?\s+(are\s+)?depleted|no credits remaining|exceeded your.*quota|quota.*exceeded/i

/**
 * Does this error (or response body) say the account is out of quota/credits?
 *
 * Accepts anything with a `message`, so a raw body string can be tested as
 * `isQuotaExhaustedError({ message: bodyText })` rather than growing a second
 * near-identical predicate for text.
 */
export function isQuotaExhaustedError(err) {
  if (!err?.message) return false
  return QUOTA_EXHAUSTED_PATTERNS.test(err.message)
}
