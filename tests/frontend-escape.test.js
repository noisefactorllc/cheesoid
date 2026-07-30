// Frontend escaping / injection regression tests. Real headless-browser
// (Playwright) tests that load the actual browser modules from server/public
// and drive them the way the app does, then assert the security-relevant DOM
// outcome. Each test stands up a throwaway express origin that serves the real
// /js assets plus a few stubbed JSON/SSE endpoints.
//
// Covers verified findings:
//   1 escapeHtml must escape quotes (attribute-context XSS)
//   2 assistant tool summary must escape tool names
//   3 linkifyWikiRefs must not break out of attributes (post-sanitize)
//   4 add-on modules must fail CLOSED when window.cheesoidChat is absent
//   5 CSS-selector ids must be CSS.escape()d (a '"' must not throw)

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC = join(root, 'server', 'public')

// Probe for a usable chromium once at load. When the browser binary is absent
// (e.g. CI without `npx playwright install`), SKIP these tests rather than
// throw in a before-hook — an unhandled launch rejection there aborts this file
// and cascades ("event loop already resolved") into other files sharing the
// same `npm test` process.
let browser = null
try { browser = await chromium.launch({ headless: true }) } catch { /* no chromium binary */ }
const noBrowser = browser ? false : 'chromium unavailable (run `npx playwright install chromium`)'
after(async () => { await browser?.close() })

// Serve the real public dir plus caller-supplied routes (added first so they
// win over static). Returns { origin, close }.
async function startServer(routes = () => {}) {
  const app = express()
  routes(app)
  app.use(express.static(PUBLIC, { index: false }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }),
  }
}

async function withPage(srv, fn) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  try {
    return await fn(page, errors)
  } finally {
    await context.close()
    await srv.close()
  }
}

// The DOM skeleton chat.js queries at module load (every getElementById target),
// plus marked/purify and chat.js itself — mirrors index.html closely enough for
// the module to boot and expose window.cheesoidChat.
const CHAT_SKELETON = `
<div id="name-prompt" class="hidden"><input id="name-input"><button id="name-btn">Join</button></div>
<div id="chat" class="hidden">
  <aside id="sidebar">
    <div id="sidebar-rooms" class="hidden"><ul id="rooms-list"></ul></div>
    <ul id="participants"></ul>
    <button id="sidebar-toggle">t</button>
  </aside>
  <main>
    <h1 id="persona-name"></h1>
    <span id="presence-status"></span>
    <div id="connection-status" class="hidden"></div>
    <div id="messages"></div>
    <div id="input-area">
      <button id="sidebar-open" class="hidden">o</button>
      <span id="channel-name"></span>
      <textarea id="input"></textarea>
      <button id="send-btn">Send</button>
    </div>
  </main>
</div>`

function chatPage(extraModules = '') {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
${CHAT_SKELETON}
<script src="/js/vendor/marked.min.js"></script>
<script src="/js/vendor/purify.min.js"></script>
<script type="module" src="/js/chat.js"></script>
${extraModules}
</body></html>`
}

// Wire up the endpoints chat.js hits on boot. `scrollback`, when provided, is
// pushed as the initial SSE frame.
function chatRoutes({ presence, scrollback, extra } = {}) {
  return (app) => {
    app.get('/chatpage', (_req, res) => res.type('html').send(chatPage(extra)))
    app.get('/api/presence', (_req, res) => res.json(presence || { persona: 'Test', state: { mood: 'neutral' } }))
    app.get('/api/chat/stream', (_req, res) => {
      res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      res.flushHeaders?.()
      if (scrollback) res.write('data: ' + JSON.stringify({ type: 'scrollback', messages: scrollback }) + '\n\n')
      else res.write(': open\n\n')
    })
  }
}

async function bootChat(page, origin) {
  await page.addInitScript(() => localStorage.setItem('cheesoid-name', 'tester'))
  await page.goto(`${origin}/chatpage`)
  await page.waitForFunction(
    () => window.cheesoidChat && typeof window.cheesoidChat.escapeHtml === 'function',
    null, { timeout: 5000 })
}

// ---------------------------------------------------------------------------
// Finding 1 — escapeHtml must escape quotes, closing attribute-context XSS.
// ---------------------------------------------------------------------------
test('finding 1: escapeHtml escapes quotes so attribute interpolation cannot break out', { skip: noBrowser }, async () => {
  const srv = await startServer(chatRoutes())
  await withPage(srv, async (page) => {
    await bootChat(page, srv.origin)
    const r = await page.evaluate(() => {
      const esc = window.cheesoidChat.escapeHtml('bob" onmouseover="alert(1)')
      const div = document.createElement('div')
      div.innerHTML = `<span data-title="${esc}">x</span>`
      const span = div.querySelector('span')
      return {
        esc,
        hasQuoteEntity: esc.includes('&quot;'),
        hasRawQuote: esc.includes('"'),
        onmouseover: span ? span.getAttribute('onmouseover') : 'no-span',
        single: window.cheesoidChat.escapeHtml("a'b"),
      }
    })
    assert.equal(r.hasQuoteEntity, true, `expected &quot; in: ${r.esc}`)
    assert.equal(r.hasRawQuote, false, `raw quote survived: ${r.esc}`)
    assert.equal(r.onmouseover, null, 'attribute breakout produced an onmouseover handler')
    assert.match(r.single, /&#39;/, `single quote not escaped: ${r.single}`)
  })
})

// ---------------------------------------------------------------------------
// Finding 2 — assistant tool summary must escape tool names.
// ---------------------------------------------------------------------------
test('finding 2: assistant tool summary escapes tool names (no markup injection)', { skip: noBrowser }, async () => {
  const scrollback = [{
    type: 'assistant_message', name: 'evilbot', id: 'a1', timestamp: Date.now(),
    text: 'hello', tools: ['<img src=x onerror="window.__toolsXss=1">'],
  }]
  const srv = await startServer(chatRoutes({ scrollback }))
  await withPage(srv, async (page) => {
    await bootChat(page, srv.origin)
    await page.waitForSelector('.visitor-tools-summary', { timeout: 5000 })
    await page.waitForTimeout(60)
    const r = await page.evaluate(() => ({
      xss: Boolean(window.__toolsXss),
      hasImg: !!document.querySelector('.visitor-tools-summary img'),
      text: document.querySelector('.visitor-tools-summary')?.textContent || '',
    }))
    assert.equal(r.xss, false, 'tool string executed as live HTML')
    assert.equal(r.hasImg, false, 'tool string produced a real <img> element')
    assert.match(r.text, /<img/, `escaped tool text should appear literally: ${r.text}`)
  })
})

// ---------------------------------------------------------------------------
// Finding 5 — a '"' in a message id must be CSS.escape()d, not thrown on.
// A poisoned reaction must not abort reaction replay for later messages.
// ---------------------------------------------------------------------------
test('finding 5: poisoned reaction id does not throw and does not break replay', { skip: noBrowser }, async () => {
  const scrollback = [
    { type: 'user_message', name: 'alice', text: 'poisoned', id: 'p"q', timestamp: Date.now() },
    { type: 'user_message', name: 'bob', text: 'normal', id: 'normal-1', timestamp: Date.now() },
    { type: 'reaction', messageId: 'p"q', emoji: '👍', name: 'carol', action: 'add' },
    { type: 'reaction', messageId: 'normal-1', emoji: '🎉', name: 'dave', action: 'add' },
  ]
  const srv = await startServer(chatRoutes({ scrollback }))
  await withPage(srv, async (page, errors) => {
    await bootChat(page, srv.origin)
    await page.waitForSelector('[data-message-id="normal-1"]', { timeout: 5000 })
    await page.waitForTimeout(80)
    const r = await page.evaluate(() => {
      const poisoned = [...document.querySelectorAll('[data-message-id]')]
        .find((el) => el.dataset.messageId === 'p"q')
      return {
        normalPill: !!document.querySelector('[data-message-id="normal-1"] .reaction-pill'),
        poisonedPill: poisoned ? !!poisoned.querySelector('.reaction-pill') : false,
      }
    })
    assert.deepEqual(errors, [], `poisoned id threw: ${errors.join('; ')}`)
    assert.equal(r.normalPill, true, 'reaction replay aborted before reaching the normal message')
    assert.equal(r.poisonedPill, true, 'poisoned message did not receive its reaction')
  })
})

// ---------------------------------------------------------------------------
// Finding 3 — linkifyWikiRefs must rewrite text nodes only. A [[ref]] inside
// an attribute (title="[[a]]") must not break out, and the sanitizer's rel
// hook output must survive. Loads chat.js too so renderMarkdown is the real
// sanitizing renderer (with the rel hook) even before the fix.
// ---------------------------------------------------------------------------
test('finding 3: linkifyWikiRefs rewrites text nodes only (no attribute breakout, rel preserved)', { skip: noBrowser }, async () => {
  const content = 'Intro [[realpage]] and [[memory:notes.md]].\n\n<a href="https://evil" title="[[a]]">x</a>'
  const srv = await startServer((app) => {
    chatRoutes({ extra: '<script type="module" src="/js/harness-panels.js"></script>' })(app)
    app.get('/api/peers', (_req, res) => res.json({ peers: [] }))
    app.get('/api/wiki', (_req, res) => res.json({ pages: [{ slug: 'home', title: 'Home' }] }))
    app.get('/api/wiki/:slug', (_req, res) => res.json({ content }))
  })
  await withPage(srv, async (page) => {
    await bootChat(page, srv.origin)
    await page.waitForSelector('#harness-section-wiki .harness-section-header', { timeout: 5000 })
    await page.click('#harness-section-wiki .harness-section-header')
    await page.waitForSelector('.harness-wiki-item', { timeout: 5000 })
    await page.click('.harness-wiki-item')
    await page.waitForSelector('#harness-wiki-overlay .harness-overlay-body a', { timeout: 5000 })
    await page.waitForTimeout(60)
    const r = await page.evaluate(() => {
      const body = document.querySelector('#harness-wiki-overlay .harness-overlay-body')
      const evil = body.querySelector('a[href="https://evil"]')
      const wikiLinks = [...body.querySelectorAll('a.harness-wiki-link')].map((a) => ({
        wiki: a.dataset.wiki || null, memory: a.dataset.memory || null, text: a.textContent,
      }))
      return {
        html: body.innerHTML,
        evilRel: evil ? evil.getAttribute('rel') : null,
        evilTitle: evil ? evil.getAttribute('title') : null,
        evilInnerAnchors: evil ? evil.querySelectorAll('a').length : -1,
        wikiLinks,
      }
    })
    assert.equal(r.evilRel, 'nofollow noopener noreferrer', `rel hook output not preserved: ${r.html}`)
    assert.equal(r.evilTitle, '[[a]]', `title attribute was mutated (breakout): ${r.html}`)
    assert.equal(r.evilInnerAnchors, 0, `wiki link injected inside the anchor (breakout): ${r.html}`)
    assert.ok(r.wikiLinks.some((l) => l.wiki === 'realpage'), `text [[realpage]] not linkified: ${r.html}`)
    assert.ok(r.wikiLinks.some((l) => l.memory === 'notes.md'), `text [[memory:notes.md]] not linkified: ${r.html}`)
  })
})

// ---------------------------------------------------------------------------
// Finding 4 — thread-ui.js must fail CLOSED: with window.cheesoidChat absent,
// its escaper still escapes (it must not fall back to an identity function).
// ---------------------------------------------------------------------------
const THREAD_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="messages"></div>
<script src="/js/vendor/marked.min.js"></script>
<script src="/js/vendor/purify.min.js"></script>
<script type="module" src="/js/thread-ui.js"></script>
</body></html>`

test('finding 4: thread-ui escapes even without window.cheesoidChat (fail-closed)', { skip: noBrowser }, async () => {
  const srv = await startServer((app) => {
    app.get('/threadpage', (_req, res) => res.type('html').send(THREAD_PAGE))
    app.get('/api/chat/thread', (_req, res) => res.json({
      threadId: 't1',
      messages: [{
        id: 'm1',
        name: '<img src=x onerror="window.__threadXss=1">',
        text: '<img src=y onerror="window.__threadXss=1">',
        timestamp: Date.now(),
      }],
    }))
  })
  await withPage(srv, async (page) => {
    await page.goto(`${srv.origin}/threadpage`)
    await page.waitForFunction(
      () => window.cheesoidThreads && typeof window.cheesoidThreads.show === 'function',
      null, { timeout: 5000 })
    assert.equal(await page.evaluate(() => typeof window.cheesoidChat === 'undefined'), true,
      'test precondition: window.cheesoidChat must be absent')
    await page.evaluate(() => window.cheesoidThreads.show('m1'))
    await page.waitForSelector('.thread-overlay .thread-entry', { timeout: 5000 })
    await page.waitForTimeout(50)
    const r = await page.evaluate(() => ({
      xss: Boolean(window.__threadXss),
      // esc() output (the sender name) must be inert text, not a real element.
      nameImg: !!document.querySelector('.thread-entry-meta img'),
      // md() output is sanitized markdown — an <img> may survive, but MUST have
      // been stripped of its onerror; no live event handler may remain anywhere.
      liveHandlers: document.querySelectorAll('.thread-overlay [onerror]').length,
      name: document.querySelector('.thread-entry-meta strong')?.textContent || '',
    }))
    assert.equal(r.xss, false, 'thread content executed as live HTML (fail-open escaper)')
    assert.equal(r.nameImg, false, 'escaped sender name became a real element (fail-open escaper)')
    assert.equal(r.liveHandlers, 0, 'a live onerror handler survived sanitization')
    assert.match(r.name, /<img/, `sender name should be escaped literal text: ${r.name}`)
  })
})

// ---------------------------------------------------------------------------
// Finding 4 — search-ui.js must fail CLOSED the same way.
// ---------------------------------------------------------------------------
const SEARCH_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="input-area"><button id="send-btn">Send</button></div>
<script type="module" src="/js/search-ui.js"></script>
</body></html>`

test('finding 4: search-ui escapes results even without window.cheesoidChat (fail-closed)', { skip: noBrowser }, async () => {
  const srv = await startServer((app) => {
    app.get('/searchpage', (_req, res) => res.type('html').send(SEARCH_PAGE))
    app.get('/api/chat/search', (_req, res) => res.json({
      results: [{
        id: 'r1', type: 'user_message',
        name: '<img src=x onerror="window.__searchXss=1">',
        text: 'hello world', room: '<b>rm</b>', timestamp: Date.now(),
      }],
    }))
  })
  await withPage(srv, async (page) => {
    await page.goto(`${srv.origin}/searchpage`)
    await page.waitForSelector('#history-search-btn', { timeout: 5000 })
    assert.equal(await page.evaluate(() => typeof window.cheesoidChat === 'undefined'), true,
      'test precondition: window.cheesoidChat must be absent')
    await page.click('#history-search-btn')
    await page.waitForSelector('.search-input', { timeout: 5000 })
    await page.evaluate(() => {
      const i = document.querySelector('.search-input')
      i.value = 'hello'
      i.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await page.waitForSelector('.search-hit', { timeout: 5000 })
    await page.waitForTimeout(50)
    const r = await page.evaluate(() => ({
      xss: Boolean(window.__searchXss),
      hasImg: !!document.querySelector('.search-results img'),
      name: document.querySelector('.search-hit-meta strong')?.textContent || '',
    }))
    assert.equal(r.xss, false, 'search result executed as live HTML (fail-open escaper)')
    assert.equal(r.hasImg, false, 'search result produced a real <img> element')
    assert.match(r.name, /<img/, `hit name should be escaped literal text: ${r.name}`)
  })
})
