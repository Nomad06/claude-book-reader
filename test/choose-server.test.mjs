// /api/choose over HTTP, with a stand-in file dialog: the server runs
// `node <script>` (--picker-script) in place of the system's dialog.
//
//   node --test test/choose-server.test.mjs

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPdf, TEXT } from './pdf-fixture.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = path.join(ROOT, 'server', 'server.mjs')

let dir
let book

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Waits until `check()` is true (it may be async), asking every 25 ms; fails after `ms` (slow CI runners get room). */
async function until(check, what, ms = 15_000) {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting: ${what}`)
    await sleep(25)
  }
}

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

/** A dialog that writes its pid to `pidFile`, waits `delayMs`, then prints `pick` (a path) or exits 1 (a cancel). */
async function pickerScript(name, { delayMs, pick = null, pidFile = null }) {
  const file = path.join(dir, `${name}.mjs`)
  await fs.writeFile(
    file,
    [
      'import fs from "node:fs"',
      pidFile ? `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))` : '',
      `setTimeout(() => { ${pick ? `process.stdout.write(${JSON.stringify(pick)})` : 'process.exitCode = 1'} }, ${delayMs})`,
    ].join('\n'),
  )
  return file
}

/** A server of its own, whose file dialog is `script`. */
async function startServer(script) {
  const port = await freePort()
  const data = await fs.mkdtemp(path.join(dir, 'data-'))
  const child = spawn(process.execPath, [SERVER, '--port', String(port), '--data', data, '--no-launch', '--picker-script', script], {
    stdio: 'ignore',
  })
  const post = async (urlPath, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, json: await res.json() }
  }
  await until(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok
    } catch {
      return false
    }
  }, 'the server to answer')
  const exited = new Promise(resolve => child.once('exit', resolve))
  const stop = async () => {
    if (child.exitCode === null) child.kill()
    await exited
  }
  return { post, stop, exited }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

before(async () => {
  // The library keeps a book's real path (macOS's tmpdir is a link).
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'book-reader-choose-')))
  book = path.join(dir, 'dune.pdf')
  await fs.writeFile(book, buildPdf(TEXT))
})

after(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('choosing a book with the file dialog', () => {
  test('a dialog open longer than one request: "still open" with its id, then the pick by that id', async () => {
    const server = await startServer(await pickerScript('slow-pick', { delayMs: 500, pick: book }))
    try {
      const first = await server.post('/api/choose', { waitMs: 50 })
      assert.equal(first.status, 200)
      assert.equal(first.json.pending, true)
      assert.equal(typeof first.json.id, 'string')
      const second = await server.post('/api/choose', { waitMs: 20_000, id: first.json.id })
      assert.equal(second.json.book.path, book)
    } finally {
      await server.stop()
    }
  })

  test('a new request never collects an earlier dialog it did not ask for: it opens its own', async () => {
    const server = await startServer(await pickerScript('quick-cancel', { delayMs: 100 }))
    try {
      const abandoned = await server.post('/api/choose', { waitMs: 10 })
      assert.equal(abandoned.json.pending, true)
      // Its dialog is cancelled meanwhile: wait until the server has its outcome.
      await until(async () => !(await server.post('/api/choose', { waitMs: 10, id: abandoned.json.id })).json.pending, 'the first dialog to settle')
      const fresh = await server.post('/api/choose', { waitMs: 10 })
      assert.equal(fresh.json.pending, true)
      assert.notEqual(fresh.json.id, abandoned.json.id)
      assert.deepEqual((await server.post('/api/choose', { waitMs: 10, id: 'not-a-dialog-of-this-server' })).json, { gone: true })
    } finally {
      await server.stop()
    }
  })

  test("an older mod's request (no waitMs) waits for the pick itself", async () => {
    const server = await startServer(await pickerScript('pick', { delayMs: 100, pick: book }))
    try {
      const { json } = await server.post('/api/choose')
      assert.equal(json.book.path, book)
    } finally {
      await server.stop()
    }
  })

  test('stopping the server ends a dialog that is still open', async () => {
    const pidFile = path.join(dir, 'picker.pid')
    const server = await startServer(await pickerScript('forever', { delayMs: 60_000, pidFile }))
    try {
      assert.equal((await server.post('/api/choose', { waitMs: 10 })).json.pending, true)
      let pid = 0
      await until(async () => (pid = Number(await fs.readFile(pidFile, 'utf8').catch(() => '0'))) > 0, 'the dialog to start')
      assert.ok(isRunning(pid))
      await server.post('/api/shutdown')
      await server.exited
      await until(() => !isRunning(pid), 'the dialog to end')
    } finally {
      await server.stop()
    }
  })
})
