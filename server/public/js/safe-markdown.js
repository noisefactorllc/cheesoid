const SANITIZE_OPTIONS = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: [
    'base', 'button', 'embed', 'form', 'frame', 'frameset', 'iframe',
    'input', 'link', 'meta', 'object', 'option', 'select', 'style',
    'template', 'textarea',
  ],
  FORBID_ATTR: ['class', 'id', 'name', 'slot', 'srcdoc', 'style'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
}

let hookInstalled = false

function escapeHtml(text) {
  const div = document.createElement('div')
  div.textContent = String(text ?? '')
  return div.innerHTML
}

/**
 * The only supported Markdown-to-HTML boundary. Marked is a parser, not a
 * sanitizer; every result is passed through DOMPurify before entering the DOM.
 */
export function renderSafeMarkdown(text) {
  const source = String(text ?? '')
  const parser = globalThis.marked
  const purifier = globalThis.DOMPurify
  if (!parser?.parse || !purifier?.sanitize) return escapeHtml(source)

  if (!hookInstalled) {
    purifier.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') {
        node.setAttribute('rel', 'nofollow noopener noreferrer')
      }
    })
    hookInstalled = true
  }

  return purifier.sanitize(parser.parse(source), SANITIZE_OPTIONS)
}
