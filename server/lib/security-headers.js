export const UI_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://handfish.noisefactor.io",
  "script-src-attr 'none'",
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
