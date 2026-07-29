import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
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
