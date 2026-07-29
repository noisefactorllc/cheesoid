import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as securityHeaders from '../server/lib/security-headers.js'
import { UI_CONTENT_SECURITY_POLICY } from '../server/lib/security-headers.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('renderSafeMarkdown strips active and embed-capable content', async () => {
  const app = express()
  app.use(express.static(join(root, 'server', 'public')))
  app.get('/test', (_req, res) => {
    res.type('html').send(`<!doctype html>
      <div id="target"></div>
      <script src="/js/vendor/marked.min.js"></script>
      <script src="/js/vendor/purify.min.js"></script>
      <script type="module">
        import { renderSafeMarkdown } from '/js/safe-markdown.js'
        window.rendered = renderSafeMarkdown([
          '# Safe heading',
          '<img src=x onerror="window.__xss = true">',
          '<script>window.__xss = true<\\/script>',
          '[bad](javascript:window.__xss=true)',
          '<svg><a href="javascript:window.__xss=true">x</a></svg>',
          '<form action="/steal"><input name="secret"></form>',
          '<iframe srcdoc="<script>parent.__xss=true<\\/script>"></iframe>',
          '<style>body{display:none}</style>',
        ].join('\\n'))
        document.querySelector('#target').innerHTML = window.rendered
      </script>`)
  })
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

  let browser = null
  try {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}/test`)
    await page.waitForFunction(() => typeof window.rendered === 'string')
    await page.waitForTimeout(50)
    const result = await page.evaluate(() => ({
      xss: Boolean(window.__xss),
      html: document.querySelector('#target').innerHTML,
      heading: document.querySelector('#target h1')?.textContent,
      dangerousHref: Boolean(document.querySelector('#target [href^="javascript:"]')),
    }))
    assert.equal(result.xss, false)
    assert.equal(result.heading, 'Safe heading', result.html)
    assert.equal(result.dangerousHref, false)
    assert.doesNotMatch(result.html, /onerror|<script|<svg|<form|<iframe|<style/i)
  } finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
  }
})

test('UI CSP blocks inline event handlers, objects, base rewriting, and hostile framing', () => {
  assert.match(UI_CONTENT_SECURITY_POLICY, /script-src-attr 'none'/)
  assert.match(UI_CONTENT_SECURITY_POLICY, /object-src 'none'/)
  assert.match(UI_CONTENT_SECURITY_POLICY, /base-uri 'none'/)
  assert.match(UI_CONTENT_SECURITY_POLICY, /frame-ancestors 'self'/)
})

// Finding 6 — script-src drops 'unsafe-inline' in favor of a SHA-256 hash of
// index.html's importmap (the sole inline script). The hash is recomputed from
// the live file so this test also guards against a stale hash if the importmap
// ever changes.
test('finding 6: script-src uses the importmap hash instead of unsafe-inline', async () => {
  const html = await readFile(join(root, 'server', 'public', 'index.html'), 'utf8')
  const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)
  assert.ok(m, 'importmap <script> not found in index.html')
  const hash = createHash('sha256').update(m[1], 'utf8').digest('base64')

  const scriptSrc = UI_CONTENT_SECURITY_POLICY
    .split(';').map((d) => d.trim())
    .find((d) => d.startsWith('script-src ') && !d.startsWith('script-src-attr'))
  assert.ok(scriptSrc, 'no script-src directive in UI CSP')
  assert.doesNotMatch(scriptSrc, /'unsafe-inline'/, `script-src still allows unsafe-inline: ${scriptSrc}`)
  assert.ok(scriptSrc.includes(`'sha256-${hash}'`),
    `script-src missing importmap hash 'sha256-${hash}': ${scriptSrc}`)
})

// Finding 7 — the UI CSP must be applied to static HTML responses too, but only
// to HTML (never to JS/CSS/etc.). index.js wires this helper into
// express.static's setHeaders, so unit-testing the helper covers the real path.
test('finding 7: applyStaticUiHeaders sets the UI CSP for .html responses only', () => {
  assert.equal(typeof securityHeaders.applyStaticUiHeaders, 'function',
    'applyStaticUiHeaders is not exported from security-headers.js')
  const fakeRes = () => {
    const headers = {}
    return { headers, setHeader: (k, v) => { headers[k] = v } }
  }
  const htmlRes = fakeRes()
  securityHeaders.applyStaticUiHeaders(htmlRes, '/srv/public/index.html')
  assert.equal(htmlRes.headers['Content-Security-Policy'], UI_CONTENT_SECURITY_POLICY)

  const jsRes = fakeRes()
  securityHeaders.applyStaticUiHeaders(jsRes, '/srv/public/js/chat.js')
  assert.equal(jsRes.headers['Content-Security-Policy'], undefined,
    'CSP must not be applied to non-HTML static assets')
})
