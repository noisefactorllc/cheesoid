// SHA-256 of the exact text content of index.html's sole inline script — the
// <script type="importmap"> block. Allow-listing that one hash lets us drop
// 'unsafe-inline' from script-src (which otherwise permits ANY inline script,
// defeating most reflected/stored-XSS defenses). If the importmap's bytes ever
// change, this hash must be recomputed; tests/safe-markdown-browser.test.js
// recomputes it from the live file and fails if this drifts.
const IMPORTMAP_SCRIPT_HASH = "'sha256-C1cWV/doD9shS4IXKMw9glusJ5brYE4Uh3Mq9boi1Po='"

export const UI_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' ${IMPORTMAP_SCRIPT_HASH} https://handfish.noisefactor.io`,
  "script-src-attr 'none'",
  // NOTE: style-src still allows 'unsafe-inline'. The app renders inline
  // style="..." (e.g. per-agent accent colors) from JS, so tightening this
  // needs a dedicated inline-style audit / nonce plumbing; left as-is for now.
  "style-src 'self' 'unsafe-inline' https://handfish.noisefactor.io https://fonts.noisefactor.io",
  "font-src https://fonts.noisefactor.io",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ')

export function setUiSecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', UI_CONTENT_SECURITY_POLICY)
  res.setHeader('Referrer-Policy', 'same-origin')
  res.setHeader('X-Content-Type-Options', 'nosniff')
}

// For express.static's `setHeaders` hook: apply the full UI security header set
// to static HTML responses only. Non-HTML assets (JS, CSS, fonts, images) do
// not establish a browsing context and must not carry the page CSP. Media /
// download routes set their own hardened, sandboxed CSP elsewhere and are not
// served through express.static, so this never touches them.
export function applyStaticUiHeaders(res, filePath) {
  if (typeof filePath === 'string' && filePath.endsWith('.html')) {
    setUiSecurityHeaders(res)
  }
}
