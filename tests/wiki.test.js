import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createWiki, WIKI_SLUG_RE, WIKI_CONTENT_CAP_BYTES } from '../server/lib/wiki.js'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('Wiki', () => {
  async function makeWiki() {
    const personaDir = await mkdtemp(join(tmpdir(), 'cheesoid-wiki-'))
    return createWiki(personaDir)
  }

  it('round-trips a page through write and read', async () => {
    const wiki = await makeWiki()
    await wiki.write('foo', '# Foo\n\nSome body text.')
    assert.equal(await wiki.read('foo'), '# Foo\n\nSome body text.')
  })

  it('returns null when reading a page that does not exist', async () => {
    const wiki = await makeWiki()
    assert.equal(await wiki.read('nope'), null)
  })

  it('auto-creates index.md listing the page with its title', async () => {
    const wiki = await makeWiki()
    await wiki.write('foo', '# Foo Title\n\nBody.')
    const index = await wiki.readIndex()
    assert.match(index, /^# Wiki Index/)
    assert.match(index, /\[\[foo\]\] — Foo Title/)
    assert.match(index, /_1 pages, updated \d{4}-\d{2}-\d{2}_/)
  })

  it('updates the index on a second write and on remove', async () => {
    const wiki = await makeWiki()
    await wiki.write('alpha', '# Alpha\n\nOne.')
    await wiki.write('beta', '# Beta\n\nTwo.')

    let index = await wiki.readIndex()
    assert.match(index, /\[\[alpha\]\] — Alpha/)
    assert.match(index, /\[\[beta\]\] — Beta/)
    assert.match(index, /_2 pages, updated/)

    const removed = await wiki.remove('alpha')
    assert.equal(removed, true)

    index = await wiki.readIndex()
    assert.doesNotMatch(index, /\[\[alpha\]\]/)
    assert.match(index, /\[\[beta\]\] — Beta/)
    assert.match(index, /_1 pages, updated/)
  })

  it('returns false when removing a page that does not exist', async () => {
    const wiki = await makeWiki()
    assert.equal(await wiki.remove('nope'), false)
  })

  it('excludes index.md from list() and rejects writing it directly', async () => {
    const wiki = await makeWiki()
    await wiki.write('foo', '# Foo\n\nBody.')
    const pages = await wiki.list()
    assert.ok(!pages.some(p => p.slug === 'index'), 'index is not listed among pages')
    await assert.rejects(() => wiki.write('index', 'hijack'), /index\.md is generated/)
  })

  it('rejects invalid slugs (traversal chars, uppercase, dots)', async () => {
    const wiki = await makeWiki()
    const badSlugs = ['../escape', '..', 'Foo', 'foo.bar', 'foo/bar', '', '-leading-hyphen', 'a'.repeat(81)]
    for (const slug of badSlugs) {
      await assert.rejects(() => wiki.write(slug, 'x'), /invalid wiki slug/, `write should reject "${slug}"`)
      await assert.rejects(() => wiki.read(slug), /invalid wiki slug/, `read should reject "${slug}"`)
    }
  })

  it('rejects content over the 256KB cap', async () => {
    const wiki = await makeWiki()
    const big = 'x'.repeat(WIKI_CONTENT_CAP_BYTES + 1)
    await assert.rejects(() => wiki.write('big', big), /too large/)
  })

  it('accepts content exactly at the 256KB cap', async () => {
    const wiki = await makeWiki()
    const exact = 'x'.repeat(WIKI_CONTENT_CAP_BYTES)
    await wiki.write('exact', exact)
    assert.equal(await wiki.read('exact'), exact)
  })

  it('readIndex returns a default placeholder before any page exists', async () => {
    const wiki = await makeWiki()
    assert.equal(await wiki.readIndex(), '# Wiki Index\n\n_empty_')
  })

  it('exposes the slug validation regex', () => {
    assert.ok(WIKI_SLUG_RE.test('valid-slug-123'))
    assert.ok(!WIKI_SLUG_RE.test('Invalid'))
  })

  describe('list', () => {
    it('falls back to the first non-empty line when there is no heading', async () => {
      const wiki = await makeWiki()
      const content = '\n  \nJust a plain first line.\nMore text.'
      await wiki.write('nohead', content)
      const page = (await wiki.list()).find(p => p.slug === 'nohead')
      assert.ok(page)
      assert.equal(page.title, 'Just a plain first line.')
      assert.equal(page.bytes, Buffer.byteLength(content, 'utf8'))
    })

    it('uses the first # heading as the title', async () => {
      const wiki = await makeWiki()
      await wiki.write('headed', 'intro line\n# The Real Title\nmore')
      const page = (await wiki.list()).find(p => p.slug === 'headed')
      assert.equal(page.title, 'The Real Title')
    })
  })

  describe('search', () => {
    it('finds matching lines case-insensitively with correct line numbers', async () => {
      const wiki = await makeWiki()
      await wiki.write('doc', '# Doc\nLine one has a Needle in it.\nLine two does not.\nAnother needle here.')
      const results = await wiki.search('needle')
      assert.equal(results.length, 2)
      assert.equal(results[0].slug, 'doc')
      assert.equal(results[0].lineNumber, 2)
      assert.equal(results[0].title, 'Doc')
      assert.equal(results[1].lineNumber, 4)
    })

    it('respects the limit option across pages', async () => {
      const wiki = await makeWiki()
      await wiki.write('a', 'match one\nmatch two\nmatch three')
      await wiki.write('b', 'match four\nmatch five')
      const results = await wiki.search('match', { limit: 3 })
      assert.equal(results.length, 3)
    })

    it('returns an empty array for an empty or whitespace query', async () => {
      const wiki = await makeWiki()
      await wiki.write('doc', 'some content')
      assert.deepEqual(await wiki.search(''), [])
      assert.deepEqual(await wiki.search('   '), [])
    })
  })

  describe('links', () => {
    it('reports a broken link until the target page is created', async () => {
      const wiki = await makeWiki()
      await wiki.write('a', 'See [[b]] for more.')

      let result = await wiki.links('a')
      assert.deepEqual(result.outgoing, ['b'])
      assert.deepEqual(result.broken, ['b'])

      await wiki.write('b', '# B\n\nNow exists.')
      result = await wiki.links('a')
      assert.deepEqual(result.outgoing, ['b'])
      assert.deepEqual(result.broken, [])
    })

    it('dedupes repeated links and excludes self-links', async () => {
      const wiki = await makeWiki()
      await wiki.write('a', 'Link to [[b]], again [[b]], and [[a]] itself.')
      const result = await wiki.links('a')
      assert.deepEqual(result.outgoing, ['b'])
      assert.deepEqual(result.broken, ['b'])
    })

    it('returns empty outgoing/broken for a page with no links', async () => {
      const wiki = await makeWiki()
      await wiki.write('lonely', 'No links here.')
      assert.deepEqual(await wiki.links('lonely'), { outgoing: [], broken: [] })
    })
  })
})
