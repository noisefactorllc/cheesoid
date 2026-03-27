/**
 * Parse a model string into modelId and providerName.
 *
 * Resolution rules (in order):
 * 1. Explicit suffix: "model:provider" — split on last colon, but only if the
 *    suffix is a known provider name (when knownProviders is given) or looks
 *    like a provider name (no slashes, no dots, no digits-only)
 * 2. Auto-detect: model starts with "claude" → anthropic
 * 3. Default: providerName = null (caller uses default provider)
 *
 * @param {string} modelString
 * @param {Set<string>} [knownProviders] — if provided, suffix must match a known provider
 */
export function resolveModel(modelString, knownProviders) {
  const lastColon = modelString.lastIndexOf(':')

  if (lastColon > 0) {
    const suffix = modelString.slice(lastColon + 1)
    if (suffix) {
      // If we know the valid provider names, use that as the authority
      if (knownProviders) {
        if (knownProviders.has(suffix)) {
          return {
            modelId: modelString.slice(0, lastColon),
            providerName: suffix,
          }
        }
      } else if (!suffix.includes('/') && !suffix.includes('.') && !/^\d+\w*$/.test(suffix)) {
        // Fallback heuristic: reject suffixes that look like version tags (e.g. "35b", "70b")
        return {
          modelId: modelString.slice(0, lastColon),
          providerName: suffix,
        }
      }
    }
  }

  if (modelString.startsWith('claude')) {
    return { modelId: modelString, providerName: 'anthropic' }
  }

  return { modelId: modelString, providerName: null }
}
