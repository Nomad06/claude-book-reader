// Tests of server/server.mjs over HTTP: a real server on a free port, a temporary
// data folder, and --no-launch so nothing opens a browser, dialog or notification.
//
//   node --test test/server.test.mjs

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDrawingPdf, buildPdf, buildScannedPdf, TEXT } from './pdf-fixture.mjs'
import { loadCanvas } from '../server/pdf-source.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = path.join(ROOT, 'server', 'server.mjs')
const MANIFEST = JSON.parse(await fs.readFile(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'))

let port
let dataDir
let fixtures
let child

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** One HTTP request with full control of the headers (fetch fixes Host and Origin). */
function request(method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: urlPath,
        headers: {
          host: `127.0.0.1:${port}`,
          ...(data === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }),
          ...headers,
        },
      },
      res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          const raw = Buffer.concat(chunks)
          let json
          try {
            json = JSON.parse(raw.toString('utf8'))
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, raw, json })
        })
      },
    )
    req.on('error', reject)
    if (data !== undefined) req.write(data)
    req.end()
  })
}

/** Opens the event stream and collects its messages until `close()`. */
function events() {
  const messages = []
  const waiters = []
  const req = http.get({ host: '127.0.0.1', port, path: '/api/events?vid=test', headers: { host: `127.0.0.1:${port}` } }, res => {
    let buffer = ''
    res.setEncoding('utf8')
    res.on('data', chunk => {
      buffer += chunk
      let cut
      while ((cut = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        const line = block.split('\n').find(l => l.startsWith('data: '))
        if (!line) continue
        messages.push(JSON.parse(line.slice(6)))
        for (const w of waiters.splice(0)) w()
      }
    })
  })
  return {
    messages,
    async next(type, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = messages.find(m => m.type === type && !m.seen)
        if (found) {
          found.seen = true
          return found
        }
        if (Date.now() > deadline) throw new Error(`no "${type}" event`)
        await new Promise(resolve => {
          waiters.push(resolve)
          setTimeout(resolve, 50)
        })
      }
    },
    close: () => req.destroy(),
  }
}

/** The smallest file the server takes for a PDF: it checks for the %PDF- header. */
async function writePdf(name) {
  const file = path.join(fixtures, name)
  await fs.writeFile(file, '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n')
  return file
}

async function waitForHealth() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await request('GET', '/api/health')
      if (res.json?.app === 'book-reader') return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('server did not start')
}

before(async () => {
  port = await freePort()
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'book-reader-data-'))
  fixtures = await fs.mkdtemp(path.join(os.tmpdir(), 'book-reader-books-'))
  await fs.mkdir(path.join(dataDir, 'pages'), { recursive: true })
  await fs.writeFile(path.join(dataDir, 'pages', 'left-over.rgb'), 'x')
  child = spawn(process.execPath, [SERVER, '--port', String(port), '--data', dataDir, '--no-launch', '--launched-from', 'test install'], {
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  await waitForHealth()
})

after(async () => {
  // Wait for the server to exit: a save it had scheduled must not land while the folder goes.
  if (child && child.exitCode === null) await new Promise(resolve => child.once('exit', resolve).kill())
  await fs.rm(dataDir, { recursive: true, force: true })
  await fs.rm(fixtures, { recursive: true, force: true })
})

describe('health', () => {
  test('names the app, its version, its folder and the install that started it', async () => {
    const res = await request('GET', '/api/health')
    assert.equal(res.status, 200)
    assert.equal(res.json.app, 'book-reader')
    assert.equal(res.json.version, MANIFEST.version)
    assert.equal(res.json.root, ROOT)
    assert.equal(res.json.launchedFrom, 'test install')
  })
})

describe('start', () => {
  test('sweeps the pages folder at start', async () => {
    assert.equal(await fs.stat(path.join(dataDir, 'pages', 'left-over.rgb')).catch(() => null), null)
  })
})

describe('request guards', () => {
  test('refuses a foreign Host (DNS rebinding)', async () => {
    const res = await request('GET', '/api/state', { headers: { host: `evil.example:${port}` } })
    assert.equal(res.status, 403)
  })

  test('refuses API calls from another origin, reads included', async () => {
    const evil = { origin: 'https://evil.example' }
    assert.equal((await request('POST', '/api/books', { body: { path: '/x.pdf' }, headers: evil })).status, 403)
    assert.equal((await request('GET', '/api/state', { headers: evil })).status, 403)
    assert.equal((await request('GET', '/api/events', { headers: evil })).status, 403)
    assert.equal((await request('POST', '/api/shutdown', { headers: evil })).status, 403)
  })

  test('refuses cross-site requests that carry no Origin (embeds)', async () => {
    const res = await request('GET', '/api/state', { headers: { 'sec-fetch-site': 'cross-site' } })
    assert.equal(res.status, 403)
  })

  test("lets the reader's own page and the mod in", async () => {
    const page = { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' }
    assert.equal((await request('GET', '/api/state', { headers: page })).status, 200)
    assert.equal((await request('GET', '/api/state')).status, 200)
  })

  test('every response forbids embedding and sniffing; the page carries a CSP', async () => {
    const page = await request('GET', '/')
    assert.equal(page.status, 200)
    assert.equal(page.headers['cross-origin-resource-policy'], 'same-origin')
    assert.equal(page.headers['x-content-type-options'], 'nosniff')
    assert.match(page.headers['content-security-policy'], /default-src 'none'/)
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/)
    const api = await request('GET', '/api/state')
    assert.equal(api.headers['cross-origin-resource-policy'], 'same-origin')
  })

  test('serves nothing outside the viewer folder', async () => {
    for (const p of ['/../server/server.mjs', '/%2e%2e/server/server.mjs', '/..%2fserver/server.mjs']) {
      const res = await request('GET', p)
      assert.ok(res.status === 403 || res.status === 404, `${p} -> ${res.status}`)
      assert.ok(!res.raw.toString().includes('createServer'), `${p} leaked the server source`)
    }
  })
})

describe('library', () => {
  test('adds a PDF, makes it current and keeps one record per file', async () => {
    const file = await writePdf('dune.pdf')
    const first = await request('POST', '/api/books', { body: { path: file } })
    assert.equal(first.status, 200)
    assert.equal(first.json.book.title, 'dune')
    assert.equal(first.json.book.page, 1)
    const again = await request('POST', '/api/books', { body: { path: file } })
    assert.equal(again.json.book.id, first.json.book.id)
    const state = await request('GET', '/api/state')
    assert.equal(state.json.current.id, first.json.book.id)
    assert.equal(state.json.books.filter(b => b.id === first.json.book.id).length, 1)
  })

  test('refuses what is not a readable PDF', async () => {
    const text = path.join(fixtures, 'notes.pdf')
    await fs.writeFile(text, 'just text')
    assert.equal((await request('POST', '/api/books', { body: { path: text } })).status, 400)
    assert.equal((await request('POST', '/api/books', { body: { path: path.join(fixtures, 'missing.pdf') } })).status, 404)
    assert.equal((await request('POST', '/api/books', { body: { path: 'relative/book.pdf' } })).status, 400)
    assert.equal((await request('POST', '/api/books', { body: { path: fixtures } })).status, 400)
    assert.equal((await request('POST', '/api/books', { body: {} })).status, 400)
  })

  test('serves the PDF whole and by byte range', async () => {
    const file = await writePdf('range.pdf')
    const { json } = await request('POST', '/api/books', { body: { path: file } })
    const size = (await fs.stat(file)).size
    const whole = await request('GET', `/api/books/${json.book.id}/pdf`)
    assert.equal(whole.status, 200)
    assert.equal(whole.headers['content-type'], 'application/pdf')
    assert.equal(whole.raw.length, size)
    const part = await request('GET', `/api/books/${json.book.id}/pdf`, { headers: { range: 'bytes=0-4' } })
    assert.equal(part.status, 206)
    assert.equal(part.raw.toString(), '%PDF-')
    assert.equal(part.headers['content-range'], `bytes 0-4/${size}`)
    const bad = await request('GET', `/api/books/${json.book.id}/pdf`, { headers: { range: `bytes=${size + 10}-` } })
    assert.equal(bad.status, 416)
  })

  test('unknown book ids are 404', async () => {
    assert.equal((await request('GET', '/api/books/000000000000')).status, 404)
    assert.equal((await request('GET', '/api/books/000000000000/pdf')).status, 404)
  })
})

describe('progress', () => {
  test('merges place, page count, title and read pages, and resets', async () => {
    const file = await writePdf('progress.pdf')
    const { json } = await request('POST', '/api/books', { body: { path: file } })
    const id = json.book.id
    await request('POST', `/api/books/${id}/progress`, {
      body: { page: 7, pages: 120, location: '#page=7&zoom=auto,-13,792', title: 'Progress', read: [1, 2, 3, 7] },
    })
    const saved = await request('POST', `/api/books/${id}/progress`, { body: { read: [8], unread: [2] } })
    assert.equal(saved.json.readCount, 4)
    const book = (await request('GET', `/api/books/${id}`)).json
    assert.deepEqual(book.read, [1, 3, 7, 8])
    assert.equal(book.page, 7)
    assert.equal(book.pages, 120)
    assert.equal(book.title, 'Progress')
    assert.equal(book.location, '#page=7&zoom=auto,-13,792')

    await request('POST', `/api/books/${id}/reset`)
    const reset = (await request('GET', `/api/books/${id}`)).json
    assert.deepEqual(reset.read, [])
    assert.equal(reset.page, 1)
    assert.equal(reset.location, null)
  })

  test('ignores values of the wrong shape', async () => {
    const file = await writePdf('shapes.pdf')
    const { json } = await request('POST', '/api/books', { body: { path: file } })
    await request('POST', `/api/books/${json.book.id}/progress`, {
      body: { page: -3, pages: 'many', read: [0, -1, 2.5, 'x', 4], location: 'x'.repeat(500) },
    })
    const book = (await request('GET', `/api/books/${json.book.id}`)).json
    assert.equal(book.page, 1)
    assert.equal(book.pages, null)
    assert.deepEqual(book.read, [4])
    assert.equal(book.location, null)
  })

  test('is written to state.json', async () => {
    const file = await writePdf('persist.pdf')
    const { json } = await request('POST', '/api/books', { body: { path: file } })
    await request('POST', `/api/books/${json.book.id}/progress`, { body: { page: 3, read: [1, 2] } })
    await new Promise(resolve => setTimeout(resolve, 700))
    const state = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'))
    assert.equal(state.books[json.book.id].page, 3)
    assert.deepEqual(state.books[json.book.id].read, [1, 2])
  })
})

describe('task events', () => {
  test('relay running, done, ack and close to an open reader', async () => {
    const stream = events()
    const hello = await stream.next('hello')
    assert.equal(hello.state.app, 'book-reader')
    assert.equal((await request('GET', '/api/state')).json.viewers, 1)

    await request('POST', '/api/task', { body: { state: 'running' } })
    assert.equal((await stream.next('task')).task.state, 'running')

    await request('POST', '/api/task', { body: { state: 'done', durationMs: 5000, summary: 'Done.', notify: true } })
    const done = (await stream.next('task')).task
    assert.equal(done.state, 'done')
    assert.equal(done.acked, false)
    assert.equal(done.summary, 'Done.')

    await request('POST', '/api/task', { body: { state: 'ack' } })
    assert.equal((await stream.next('task')).task.acked, true)

    const show = await request('POST', '/api/show', { body: { window: 'app' } })
    assert.deepEqual(show.json, { shown: true, launched: false })
    await stream.next('attention')

    await request('POST', '/api/close')
    await stream.next('close')

    stream.close()
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal((await request('GET', '/api/state')).json.viewers, 0)
  })

  test('without a known app (or under --no-launch) there is no switching back', async () => {
    const running = await request('POST', '/api/task', { body: { state: 'running', returnTo: { bundleId: 'com.apple.Terminal' } } })
    assert.equal(running.json.task.canReturn, false)
    const focus = await request('POST', '/api/focus')
    assert.deepEqual(focus.json, { focused: false, reason: 'off' })
    assert.equal(focus.json.focused, false)
    const close = await request('POST', '/api/close', { body: { focus: true } })
    assert.equal(close.json.focused, false)
  })

  test('refuses an unknown task state', async () => {
    assert.equal((await request('POST', '/api/task', { body: { state: 'party' } })).status, 400)
  })

  test('with no reader open, show launches nothing under --no-launch', async () => {
    const res = await request('POST', '/api/show', { body: { window: 'browser' } })
    assert.equal(res.json.shown, true)
    assert.equal(res.json.how, 'none')
  })
})

describe('removing', () => {
  test('a removed book leaves the library and is no longer current', async () => {
    const file = await writePdf('remove.pdf')
    const { json } = await request('POST', '/api/books', { body: { path: file } })
    assert.equal((await request('DELETE', `/api/books/${json.book.id}`)).status, 200)
    const state = (await request('GET', '/api/state')).json
    assert.equal(state.current, null)
    assert.ok(!state.books.some(b => b.id === json.book.id))
    await fs.access(file) // the file itself stays
  })
})

describe('dock', () => {
  async function addBook(name, pages) {
    const file = await writePdf(name)
    const { json } = await request('POST', '/api/books', { body: { path: file } })
    if (pages) await request('POST', `/api/books/${json.book.id}/progress`, { body: { pages } })
    return json.book.id
  }

  test('stores the contents the reader reports and returns them with the book', async () => {
    const id = await addBook('outline.pdf', 50)
    assert.equal((await request('GET', `/api/books/${id}`)).json.outline, null)
    const outline = [
      { title: 'One', page: 1, level: 0 },
      { title: '  Two  ', page: 20, level: 1 },
    ]
    const saved = await request('POST', `/api/books/${id}/outline`, { body: { outline } })
    assert.equal(saved.status, 200)
    assert.deepEqual(saved.json, { ok: true, entries: 2 })
    assert.deepEqual((await request('GET', `/api/books/${id}`)).json.outline, [
      { title: 'One', page: 1, level: 0 },
      { title: 'Two', page: 20, level: 1 },
    ])
  })

  test('keeps an empty outline: a book without contents', async () => {
    const id = await addBook('no-outline.pdf', 5)
    await request('POST', `/api/books/${id}/outline`, { body: { outline: [] } })
    assert.deepEqual((await request('GET', `/api/books/${id}`)).json.outline, [])
  })

  test('cuts long titles and names untitled entries', async () => {
    const id = await addBook('titles.pdf', 5)
    const outline = [
      { title: 'x'.repeat(500), page: 1, level: 0 },
      { title: '   ', page: 2, level: 0 },
    ]
    await request('POST', `/api/books/${id}/outline`, { body: { outline } })
    const saved = (await request('GET', `/api/books/${id}`)).json.outline
    assert.equal(saved[0].title.length, 200)
    assert.equal(saved[1].title, '(untitled)')
  })

  test('refuses contents of the wrong shape', async () => {
    const id = await addBook('bad-outline.pdf', 10)
    const bad = [
      'nope',
      [{ title: 'A', page: 0, level: 0 }],
      [{ title: 'A', page: 11, level: 0 }],
      [{ title: 'A', page: 1.5, level: 0 }],
      [{ title: 'A', page: 1, level: 10 }],
      [{ title: 7, page: 1, level: 0 }],
      [null],
      Array.from({ length: 2001 }, () => ({ title: 'A', page: 1, level: 0 })),
    ]
    for (const outline of bad) {
      const res = await request('POST', `/api/books/${id}/outline`, { body: { outline } })
      assert.equal(res.status, 400, JSON.stringify(outline).slice(0, 60))
    }
    assert.equal((await request('GET', `/api/books/${id}`)).json.outline, null)
  })

  test('show with a page moves an open reader there', async () => {
    const id = await addBook('jump.pdf', 100)
    await request('POST', `/api/books/${id}/progress`, { body: { page: 3, location: '#page=3&zoom=auto' } })
    const stream = events()
    await stream.next('hello')
    const shown = await request('POST', '/api/show', { body: { window: 'app', page: 40 } })
    assert.deepEqual(shown.json, { shown: true, launched: false })
    const goto = await stream.next('goto')
    assert.equal(goto.id, id)
    assert.equal(goto.page, 40)
    const book = (await request('GET', `/api/books/${id}`)).json
    assert.equal(book.page, 40)
    assert.equal(book.location, null)
    stream.close()
    await new Promise(resolve => setTimeout(resolve, 100))
  })

  test('show with a page and no reader saves the place, clamped to the book', async () => {
    const id = await addBook('clamp.pdf', 100)
    const res = await request('POST', '/api/show', { body: { window: 'app', page: 500 } })
    // An earlier test launched within 8 s, so this one may answer launched: false.
    assert.equal(res.json.shown, true)
    const book = (await request('GET', `/api/books/${id}`)).json
    assert.equal(book.page, 100)
    assert.equal(book.location, null)
  })
})

describe('text mode', () => {
  async function addRealPdf(name, bytes) {
    const file = path.join(fixtures, name)
    await fs.writeFile(file, bytes)
    const { json } = await request('POST', '/api/books', { body: { path: file } })
    return json.book.id
  }

  test('mode is a setting, absent until set, browser or text only', async () => {
    assert.equal((await request('GET', '/api/state')).json.settings.mode, undefined)
    const bad = await request('POST', '/api/settings', { body: { mode: 'carrier-pigeon' } })
    assert.equal(bad.json.settings.mode, undefined)
    const set = await request('POST', '/api/settings', { body: { mode: 'text' } })
    assert.equal(set.json.settings.mode, 'text')
    assert.equal((await request('GET', '/api/state')).json.settings.mode, 'text')
    await request('POST', '/api/settings', { body: { mode: 'browser' } })
    assert.equal((await request('GET', '/api/state')).json.settings.mode, 'browser')
  })

  test('a page comes back as blocks; the first call fills pages, outline and profile', async () => {
    const id = await addRealPdf('real.pdf', buildPdf(TEXT))
    assert.equal((await request('GET', `/api/books/${id}`)).json.pages, null)
    const res = await request('GET', `/api/books/${id}/page/1`)
    assert.equal(res.status, 200)
    assert.equal(res.json.page, 1)
    assert.equal(res.json.pages, 2)
    assert.equal(res.json.scanned, false)
    assert.equal(res.json.blocks[0].kind, 'heading')
    // Standard (non-embedded) fonts carry no name in Node, so no bold flag here; embedded fonts do.
    assert.deepEqual(res.json.blocks[0].runs, [{ text: 'Chapter One' }])
    assert.equal(res.json.blocks[1].kind, 'para')
    assert.equal(res.json.blocks[1].runs[0].text, 'Hello world, this is body text. Second line of the paragraph continues here.')
    const book = (await request('GET', `/api/books/${id}`)).json
    assert.equal(book.pages, 2)
    assert.deepEqual(book.outline, [
      { title: 'Chapter One', page: 1, level: 0 },
      { title: 'Chapter Two', page: 2, level: 0 },
    ])
    assert.equal(book.textProfile.bodySize, 10)
    assert.equal(book.textProfile.folioOffset, null) // the fixture prints no page numbers
  })

  test('a text page is never reported as scanned, and code is a code block', async () => {
    const id = await addRealPdf('code.pdf', buildPdf(TEXT))
    const res = await request('GET', `/api/books/${id}/page/2`)
    assert.equal(res.json.scanned, false)
    assert.deepEqual(res.json.blocks[0], { kind: 'code', text: 'const x = 1\n  return x' })
  })

  test('a scanned page is one image block, its file under the data folder', async () => {
    const id = await addRealPdf('scan.pdf', buildScannedPdf())
    const res = await request('GET', `/api/books/${id}/page/1`)
    assert.equal(res.json.scanned, true)
    assert.equal(res.json.blocks.length, 1)
    assert.equal(res.json.blocks[0].kind, 'image')
    assert.ok(res.json.blocks[0].file.startsWith(path.join(dataDir, 'pages')))
    assert.equal(res.json.blocks[0].alt, 'Image 32×32')
  })

  test('a figure drawn with paths is a picture with the canvas, a drawing line without it; never a bare mark', async () => {
    const id = await addRealPdf('drawing.pdf', buildDrawingPdf())
    const res = await request('GET', `/api/books/${id}/page/1`)
    const kinds = res.json.blocks.map(b => b.kind)
    const canvas = await loadCanvas()
    assert.deepEqual(kinds, ['para', canvas ? 'image' : 'drawing', 'caption', 'para'])
    assert.equal(res.json.blocks[1].alt, 'Figure 1. A box.')
    if (canvas) assert.ok(res.json.blocks[1].file.startsWith(path.join(dataDir, 'pages')))
    else assert.deepEqual(Object.keys(res.json.blocks[1]).sort(), ['alt', 'kind'])
  })

  test('a cached page whose picture file was swept is extracted again', async () => {
    const id = await addRealPdf('swept.pdf', buildScannedPdf())
    const first = await request('GET', `/api/books/${id}/page/1`)
    const file = first.json.blocks[0].file
    await fs.rm(file)
    const second = await request('GET', `/api/books/${id}/page/1`)
    assert.equal(second.json.blocks[0].kind, 'image')
    assert.ok(await fs.stat(second.json.blocks[0].file).catch(() => null))
  })

  test('a page that failed to extract is not cached: the next request tries again', async () => {
    const id = await addRealPdf('transient.pdf', buildScannedPdf())
    const pages = path.join(dataDir, 'pages')
    // A file where the pictures folder goes: writing the page's picture fails.
    await fs.rm(pages, { recursive: true, force: true })
    await fs.writeFile(pages, 'not a folder')
    try {
      const failed = await request('GET', `/api/books/${id}/page/1`)
      assert.equal(failed.status, 200)
      assert.ok(failed.json.error)
      assert.deepEqual(failed.json.blocks, [])
    } finally {
      await fs.rm(pages, { force: true })
      await fs.mkdir(pages, { recursive: true })
    }
    const retried = await request('GET', `/api/books/${id}/page/1`)
    assert.equal(retried.json.error, undefined)
    assert.equal(retried.json.scanned, true)
    assert.equal(retried.json.blocks[0].kind, 'image')
  })

  test('many requests at once for one page all get the same answer', async () => {
    const id = await addRealPdf('burst.pdf', buildPdf(TEXT))
    const all = await Promise.all(Array.from({ length: 12 }, () => request('GET', `/api/books/${id}/page/1`)))
    assert.ok(all.every(r => r.status === 200))
    assert.ok(all.every(r => JSON.stringify(r.json) === JSON.stringify(all[0].json)))
  })

  test('an outline title from the PDF loses its control characters', async () => {
    const id = await addRealPdf('esc-outline.pdf', buildPdf([{ outline: 'Red\u001b[31m Chapter', lines: [{ text: 'Body text here.' }] }]))
    assert.equal((await request('GET', `/api/books/${id}/page/1`)).status, 200)
    const book = (await request('GET', `/api/books/${id}`)).json
    assert.equal(book.outline.length, 1)
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(book.outline[0].title))
  })

  test('pages outside the book, a missing file and a broken PDF', async () => {
    const id = await addRealPdf('range.pdf', buildPdf(TEXT))
    assert.equal((await request('GET', `/api/books/${id}/page/3`)).status, 404)
    assert.equal((await request('GET', `/api/books/${id}/page/0`)).status, 404)
    assert.equal((await request('GET', `/api/books/${id}/page/x`)).status, 404)
    assert.equal((await request('GET', `/api/books/000000000000/page/1`)).status, 404)
    const broken = await addRealPdf('broken.pdf', Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n'))
    const res = await request('GET', `/api/books/${broken}/page/1`)
    assert.equal(res.status, 422)
    assert.match(res.json.error, /cannot open the PDF/)
    await fs.rm(path.join(fixtures, 'range.pdf'))
    const gone = await request('GET', `/api/books/${id}/page/1`)
    assert.equal(gone.status, 404)
    assert.equal(gone.json.error, 'file missing')
  })
})

describe('outline levels', () => {
  test('levels are clamped to 9 so a deep outline never fails the page route', async () => {
    const { clampLevels } = await import('../server/text.mjs')
    assert.deepEqual(
      clampLevels([{ title: 'a', page: 1, level: 14 }, { title: 'b', page: 2, level: 3 }]),
      [{ title: 'a', page: 1, level: 9 }, { title: 'b', page: 2, level: 3 }],
    )
  })
})

describe('untrusted titles', () => {
  test('control characters (terminal escapes) never reach a stored title', async () => {
    const file = await writePdf('escapes.pdf')
    const { json } = await request('POST', '/api/books', { body: { path: file } })
    const id = json.book.id
    await request('POST', `/api/books/${id}/progress`, { body: { pages: 5, title: 'Evil\u001b[2J\u001b]0;pwned\u0007 Book\u009b' } })
    await request('POST', `/api/books/${id}/outline`, { body: { outline: [{ title: '\u001b[31mRed\u001b[0m\r\nChapter', page: 1, level: 0 }] } })
    const book = (await request('GET', `/api/books/${id}`)).json
    assert.equal(book.title, 'Evil[2J]0;pwned Book')
    assert.equal(book.outline[0].title, '[31mRed[0m Chapter')
  })

  test('a file name with control characters gives a plain title', async () => {
    const file = await writePdf('esc\u001b[2Jname.pdf')
    const { json } = await request('POST', '/api/books', { body: { path: file } })
    assert.equal(json.book.title, 'esc[2Jname')
  })
})

describe('untrusted page numbers', () => {
  test('a page count over 100000 and read pages past the end are refused', async () => {
    const file = await writePdf('huge.pdf')
    const { json } = await request('POST', '/api/books', { body: { path: file } })
    const id = json.book.id
    await request('POST', `/api/books/${id}/progress`, { body: { pages: 10_000_000_000 } })
    assert.equal((await request('GET', `/api/books/${id}`)).json.pages, null)
    await request('POST', `/api/books/${id}/progress`, { body: { pages: 10, read: [5, 11, 1_000_000_000] } })
    const book = (await request('GET', `/api/books/${id}`)).json
    assert.equal(book.pages, 10)
    assert.deepEqual(book.read, [5])
  })
})

describe('titles saved by an older version', () => {
  test('lose their control characters when the server loads them', async () => {
    const oldData = await fs.mkdtemp(path.join(os.tmpdir(), 'book-reader-old-'))
    const id = 'aaaaaaaaaaaa'
    const saved = {
      version: 1,
      currentId: id,
      books: {
        [id]: {
          id,
          path: '/books/old.pdf',
          title: 'Old\u001b[2J Book',
          page: 1,
          pages: 10,
          read: [],
          outline: [{ title: 'Ch\u001b]0;x\u0007 One', page: 1, level: 0 }],
        },
      },
      settings: {},
    }
    await fs.writeFile(path.join(oldData, 'state.json'), JSON.stringify(saved))
    const oldPort = await freePort()
    const old = spawn(process.execPath, [SERVER, '--port', String(oldPort), '--data', oldData, '--no-launch'], { stdio: 'ignore' })
    try {
      const get = async urlPath => {
        for (let i = 0; i < 100; i++) {
          try {
            const res = await fetch(`http://127.0.0.1:${oldPort}${urlPath}`)
            if (res.ok) return await res.json()
          } catch {}
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        throw new Error('old-state server did not start')
      }
      assert.equal((await get('/api/state')).current.title, 'Old[2J Book')
      assert.equal((await get(`/api/books/${id}`)).outline[0].title, 'Ch]0;x One')
    } finally {
      await new Promise(resolve => old.once('exit', resolve).kill())
      await fs.rm(oldData, { recursive: true, force: true })
    }
  })

  test('a text profile saved without a folio offset is calibrated again', async () => {
    const oldData = await fs.mkdtemp(path.join(os.tmpdir(), 'book-reader-old-'))
    const pdf = path.join(oldData, 'book.pdf')
    await fs.writeFile(pdf, buildPdf(TEXT))
    const id = 'bbbbbbbbbbbb'
    const odd = 'cccccccccccc' // a state file edited by hand: not even an object
    const saved = {
      version: 1,
      currentId: id,
      books: {
        [id]: { id, path: pdf, title: 'Book', page: 1, pages: 2, read: [], outline: [], textProfile: { bodySize: 7, headers: [] } },
        [odd]: { id: odd, path: pdf, title: 'Odd', page: 1, pages: 2, read: [], outline: [], textProfile: 'x' },
      },
      settings: {},
    }
    await fs.writeFile(path.join(oldData, 'state.json'), JSON.stringify(saved))
    const oldPort = await freePort()
    const old = spawn(process.execPath, [SERVER, '--port', String(oldPort), '--data', oldData, '--no-launch'], { stdio: 'ignore' })
    try {
      const get = async urlPath => {
        for (let i = 0; i < 100; i++) {
          try {
            const res = await fetch(`http://127.0.0.1:${oldPort}${urlPath}`)
            if (res.ok) return await res.json()
          } catch {}
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        throw new Error('old-state server did not start')
      }
      assert.equal((await get(`/api/books/${id}/page/1`)).page, 1)
      const { textProfile } = await get(`/api/books/${id}`)
      assert.equal(textProfile.folioOffset, null)
      assert.equal(textProfile.bodySize, 10)
      assert.equal((await get(`/api/books/${odd}/page/1`)).page, 1)
      assert.equal((await get(`/api/books/${odd}`)).textProfile.bodySize, 10)
    } finally {
      await new Promise(resolve => old.once('exit', resolve).kill())
      await fs.rm(oldData, { recursive: true, force: true })
    }
  })
})
