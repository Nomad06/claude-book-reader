#!/usr/bin/env node
// Book Reader server: serves the pdf.js viewer on 127.0.0.1, keeps the library
// and reading progress in ~/.claude/book-reader/state.json, and relays task
// events from the Claude Code mod to the open reader window (Server-Sent Events).
//
//   node server.mjs [--port 47321] [--data DIR]   run in the foreground
//   node server.mjs --daemon [--port N]           start detached, wait until healthy, exit
//   --launched-from PATH                          echoed by /api/health, so the mod can tell its own server
//   --no-launch                                   never open a browser, file dialog or notification (tests, CI)

import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  appWindow,
  cleanTarget,
  closeAppWindow,
  defaultBrowser,
  filePicker,
  focusApp,
  noPickerReason,
  notification,
} from './platform.mjs'
import { nodeVersionProblem } from './node-version.mjs'
import { clampLevels, errorLine, plainText } from './text.mjs'
import { shared, tryAgain } from './shared.mjs'
import { createPdfSource, sweepImages, withFigures } from './pdf-source.mjs'
import { calibrate, isScanned, pageBlocks } from './page-blocks.mjs'

// Before anything else: pdf.js (text mode) needs a recent node. The mod shows
// this line when the server fails to start.
const nodeProblem = nodeVersionProblem()
if (nodeProblem) {
  console.error(nodeProblem)
  process.exit(1)
}

const APP = 'book-reader'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VIEWER_DIR = path.join(ROOT, 'viewer')
const VERSION = readVersion()

const args = parseArgs(process.argv.slice(2))
const PORT = Number(args.port ?? process.env.BOOK_READER_PORT ?? 47321)
const DATA_DIR = path.resolve(args.data ?? path.join(os.homedir(), '.claude', 'book-reader'))
const STATE_FILE = path.join(DATA_DIR, 'state.json')
const LOG_FILE = path.join(DATA_DIR, 'server.log')
const IDLE_EXIT_MS = Number(args['idle-exit-ms'] ?? 6 * 3600_000)
const ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`])
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`])
const CAN_LAUNCH = !args['no-launch']
const LAUNCHED_FROM = typeof args['launched-from'] === 'string' ? args['launched-from'] : null
const PROFILE_DIR = path.join(DATA_DIR, 'reader-profile')
const PAGES_DIR = path.join(DATA_DIR, 'pages')
const PAGE_CACHE_MAX = 50

// Text mode: pdf.js in this process, pictures as raw RGB files under PAGES_DIR.
const source = createPdfSource({ vendorDir: path.join(VIEWER_DIR, 'vendor', 'pdfjs'), imagesDir: PAGES_DIR })
const pageCache = new Map() // `${bookId}:${page}` -> answer
const FIGURE_RETRIES = 2 // more tries for a page whose figure failed or ran out of time, then its answer is kept
const figureTries = new Map() // `${bookId}:${page}` -> tries so far, at most PAGE_CACHE_MAX pages

// Sent with every response: no other site may embed or sniff what this server serves.
const BASE_HEADERS = {
  'cross-origin-resource-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}
const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

// ---------------------------------------------------------------- daemon mode

async function daemonize() {
  if (await health()) {
    console.log(JSON.stringify({ ok: true, started: false, port: PORT }))
    return
  }
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  const log = fs.openSync(LOG_FILE, 'a')
  const childArgs = [fileURLToPath(import.meta.url), '--port', String(PORT), '--data', DATA_DIR]
  if (!CAN_LAUNCH) childArgs.push('--no-launch')
  if (LAUNCHED_FROM !== null) childArgs.push('--launched-from', LAUNCHED_FROM)
  const child = spawn(process.execPath, childArgs, { detached: true, windowsHide: true, stdio: ['ignore', log, log] })
  child.unref()
  for (let i = 0; i < 80; i++) {
    await sleep(100)
    if (await health()) {
      console.log(JSON.stringify({ ok: true, started: true, port: PORT, pid: child.pid }))
      return
    }
  }
  console.log(JSON.stringify({ ok: false, error: `server did not answer on port ${PORT}; see ${LOG_FILE}` }))
  process.exitCode = 1
}

function health() {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 800 }, res => {
      let body = ''
      res.on('data', chunk => (body += chunk))
      res.on('end', () => {
        try {
          resolve(JSON.parse(body).app === APP)
        } catch {
          resolve(false)
        }
      })
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

// ---------------------------------------------------------------- state

function emptyState() {
  return { version: 1, currentId: null, books: {}, settings: { theme: 'light', readSeconds: 6 } }
}

async function loadState() {
  try {
    const parsed = JSON.parse(await fsp.readFile(STATE_FILE, 'utf8'))
    const base = emptyState()
    // Titles saved by an older version were never cleaned: clean them now.
    for (const book of Object.values(parsed.books ?? {})) {
      if (typeof book?.title === 'string') book.title = plainText(book.title) || 'book'
      if (Array.isArray(book?.outline)) {
        for (const entry of book.outline) {
          if (typeof entry?.title === 'string') entry.title = plainText(entry.title) || '(untitled)'
        }
      }
    }
    return { ...base, ...parsed, settings: { ...base.settings, ...parsed.settings } }
  } catch {
    return emptyState()
  }
}

let state
let saveTimer = null

function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveNow, 400)
}

async function saveNow() {
  clearTimeout(saveTimer)
  saveTimer = null
  await fsp.mkdir(DATA_DIR, { recursive: true, mode: 0o700 })
  const tmp = `${STATE_FILE}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2))
  await fsp.rename(tmp, STATE_FILE)
}

function bookId(realPath) {
  return crypto.createHash('sha1').update(realPath).digest('hex').slice(0, 12)
}

function summary(book) {
  if (!book) return null
  return {
    id: book.id,
    path: book.path,
    title: book.title,
    page: book.page ?? 1,
    pages: book.pages ?? null,
    readCount: book.read?.length ?? 0,
    openedAt: book.openedAt ?? 0,
  }
}

function publicState() {
  const current = state.books[state.currentId] ?? null
  return {
    app: APP,
    current: summary(current),
    books: Object.values(state.books)
      .sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0))
      .map(summary),
    viewers: clients.size,
    task,
    settings: state.settings,
  }
}

async function addBook(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') throw httpError(400, 'path is required')
  let p = rawPath.trim()
  if (p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(2))
  if (!path.isAbsolute(p)) throw httpError(400, 'path must be absolute')
  let real
  try {
    real = await fsp.realpath(p)
  } catch {
    throw httpError(404, `no such file: ${p}`)
  }
  const st = await fsp.stat(real)
  if (!st.isFile()) throw httpError(400, `not a file: ${real}`)
  if (!(await isPdf(real))) throw httpError(400, `not a PDF: ${real}`)
  const id = bookId(real)
  const now = Date.now()
  const existing = state.books[id]
  state.books[id] = existing
    ? { ...existing, openedAt: now }
    : {
        id,
        path: real,
        title: plainText(path.basename(real).replace(/\.pdf$/i, '')) || 'book',
        pages: null,
        page: 1,
        location: null,
        read: [],
        addedAt: now,
        openedAt: now,
        updatedAt: now,
      }
  state.currentId = id
  scheduleSave()
  broadcast({ type: 'book', id })
  return state.books[id]
}

async function isPdf(file) {
  const fh = await fsp.open(file, 'r')
  try {
    const buf = Buffer.alloc(1024)
    const { bytesRead } = await fh.read(buf, 0, 1024, 0)
    return buf.subarray(0, bytesRead).includes('%PDF-')
  } finally {
    await fh.close()
  }
}

// ---------------------------------------------------------------- task + viewers

let task = { state: 'idle', seq: 0, acked: true, canReturn: false, startedAt: null, endedAt: null, durationMs: null, summary: '' }
// Where the Claude Code session runs (an app, a window, a process), as the mod last said.
let returnTo = null
const clients = new Map() // id -> res
let lastActivity = Date.now()
let lastLaunchAt = 0

function broadcast(message) {
  const data = `data: ${JSON.stringify(message)}\n\n`
  for (const res of clients.values()) res.write(data)
}

function setTask(next) {
  task = { ...task, ...next, seq: task.seq + 1 }
  broadcast({ type: 'task', task })
}

// ---------------------------------------------------------------- the desktop

const host = {
  platform: process.platform,
  has: command => onPath(command) !== null,
  exists: file => fs.existsSync(file),
  env: process.env,
  homedir: os.homedir(),
}

/** Runs a plan to completion: { code, stdout, stderr }. */
function runPlan(plan, timeoutMs) {
  return new Promise(resolve => {
    execFile(
      plan.command,
      plan.args,
      { timeout: timeoutMs, windowsHide: Boolean(plan.hidden), env: { ...process.env, ...plan.env }, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? (error ? error.message : '') })
      },
    )
  })
}

/** Starts a plan and lets it run on its own (a browser outlives this server). */
function launchPlan(plan) {
  try {
    const child = spawn(plan.command, plan.args, {
      detached: Boolean(plan.detached),
      stdio: 'ignore',
      windowsHide: Boolean(plan.hidden),
      env: { ...process.env, ...plan.env },
    })
    child.on('error', error => console.error(`[book-reader] ${plan.command}: ${error.message}`))
    child.unref()
    return true
  } catch (error) {
    console.error(`[book-reader] ${plan.command}: ${error.message}`)
    return false
  }
}

/** The full path of an executable on PATH, or null. */
function onPath(command) {
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')] : ['']
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const file = path.join(dir, command + ext)
      try {
        if (fs.statSync(file).isFile()) {
          fs.accessSync(file, fs.constants.X_OK)
          return file
        }
      } catch {}
    }
  }
  return null
}

/** One line of plain text for a notification: no control characters. */
function oneLine(text) {
  return String(text).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
}

function notify(title, subtitle, message) {
  if (!CAN_LAUNCH) return
  const plan = notification({ ...host, title: oneLine(title), subtitle: oneLine(subtitle), message: oneLine(message) })
  if (plan) launchPlan(plan)
}

async function chooseFile() {
  if (!CAN_LAUNCH) throw httpError(501, 'The file picker is off (--no-launch).')
  const plan = filePicker(host)
  if (!plan) throw httpError(501, noPickerReason(process.platform))
  const { code, stdout, stderr } = await runPlan(plan, 10 * 60_000)
  const chosen = stdout.trim().split(/\r?\n/).pop() ?? ''
  if (code === 0 && chosen) return chosen
  // A cancel: osascript says -128; zenity, kdialog and the Windows dialog exit 1 quietly.
  if (/-128|cancel/i.test(stderr) || (code === 1 && !stderr.trim())) return null
  throw httpError(500, stderr.trim() || `the file dialog failed (exit ${code})`)
}

/** Brings the app that runs the Claude Code session to the front. */
async function focusClaude() {
  if (!CAN_LAUNCH) return { focused: false, reason: 'off' }
  const plan = focusApp({ ...host, target: returnTo })
  if (!plan) return { focused: false, reason: 'unknown-app' }
  const { code, stderr } = await runPlan(plan, 10_000)
  if (code !== 0) console.error(`[book-reader] could not switch to Claude: ${stderr.trim() || `exit ${code}`}`)
  return { focused: code === 0 }
}

/** Closes the reader's own browser instance, if it runs. */
function closeReaderWindow() {
  if (!CAN_LAUNCH) return
  const plan = closeAppWindow({ ...host, profileDir: PROFILE_DIR })
  if (plan) runPlan(plan, 10_000)
}

function canReturn() {
  return CAN_LAUNCH && focusApp({ ...host, target: returnTo }) !== null
}

function launchViewer(mode) {
  const url = `http://127.0.0.1:${PORT}/`
  lastLaunchAt = Date.now()
  if (!CAN_LAUNCH) return 'none'
  const app = mode === 'app' ? appWindow({ ...host, url, profileDir: PROFILE_DIR }) : null
  if (app && launchPlan(app)) return 'app'
  const browser = defaultBrowser({ ...host, url })
  const isBare = !/[\\/]/.test(browser.command)
  if (isBare && onPath(browser.command) === null) return null
  return launchPlan(browser) ? 'browser' : null
}

// ---------------------------------------------------------------- http

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.icc': 'application/vnd.iccprofile',
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

async function readBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1_000_000) throw httpError(413, 'body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw httpError(400, 'invalid JSON')
  }
}

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.slice(1))
  const file = path.resolve(VIEWER_DIR, rel)
  if (!file.startsWith(VIEWER_DIR + path.sep)) throw httpError(403, 'forbidden')
  let st
  try {
    st = await fsp.stat(file)
  } catch {
    throw httpError(404, 'not found')
  }
  if (!st.isFile()) throw httpError(404, 'not found')
  const isVendor = rel.startsWith('vendor/')
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(200, {
    ...BASE_HEADERS,
    ...(type.startsWith('text/html') ? { 'content-security-policy': PAGE_CSP } : {}),
    'content-type': type,
    'content-length': st.size,
    'cache-control': isVendor ? 'public, max-age=86400' : 'no-cache',
  })
  if (req.method === 'HEAD') return res.end()
  fs.createReadStream(file).pipe(res)
}

async function servePdf(req, res, book) {
  let st
  try {
    st = await fsp.stat(book.path)
  } catch {
    throw httpError(404, `the book file is gone: ${book.path}`)
  }
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`
  const headers = {
    ...BASE_HEADERS,
    'content-type': 'application/pdf',
    'accept-ranges': 'bytes',
    etag,
    'cache-control': 'no-cache',
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  if (range && (range[1] !== '' || range[2] !== '')) {
    let start = range[1] === '' ? st.size - Number(range[2]) : Number(range[1])
    let end = range[1] === '' || range[2] === '' ? st.size - 1 : Number(range[2])
    start = Math.max(0, start)
    end = Math.min(st.size - 1, end)
    if (start > end) {
      res.writeHead(416, { ...BASE_HEADERS, 'content-range': `bytes */${st.size}` })
      return res.end()
    }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 })
    if (req.method === 'HEAD') return res.end()
    fs.createReadStream(book.path, { start, end }).pipe(res)
    return
  }
  res.writeHead(200, { ...headers, 'content-length': st.size })
  if (req.method === 'HEAD') return res.end()
  fs.createReadStream(book.path).pipe(res)
}

function openEvents(req, res, url) {
  const id = url.searchParams.get('vid') || crypto.randomUUID()
  res.writeHead(200, {
    ...BASE_HEADERS,
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  })
  res.write('retry: 1500\n\n')
  clients.get(id)?.end()
  clients.set(id, res)
  res.write(`data: ${JSON.stringify({ type: 'hello', state: publicState() })}\n\n`)
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000)
  req.on('close', () => {
    clearInterval(ping)
    if (clients.get(id) === res) clients.delete(id)
    lastActivity = Date.now()
  })
}

function requireBook(id) {
  const book = state.books[id]
  if (!book) throw httpError(404, 'no such book')
  return book
}

// No real PDF comes near this; a larger page count from the reader is refused.
const MAX_PAGES = 100_000

function mergeProgress(book, body) {
  if (typeof body.location === 'string' && body.location.length < 200) book.location = body.location
  if (Number.isInteger(body.page) && body.page > 0) book.page = body.page
  if (Number.isInteger(body.pages) && body.pages > 0 && body.pages <= MAX_PAGES) book.pages = body.pages
  if (typeof body.title === 'string' && plainText(body.title) && body.title.length < 300) book.title = plainText(body.title)
  const read = new Set(book.read ?? [])
  const lastPage = book.pages ?? MAX_PAGES
  for (const p of Array.isArray(body.read) ? body.read : []) if (Number.isInteger(p) && p > 0 && p <= lastPage) read.add(p)
  for (const p of Array.isArray(body.unread) ? body.unread : []) read.delete(p)
  book.read = [...read].sort((a, b) => a - b)
  book.updatedAt = Date.now()
  scheduleSave()
}

// The contents the reader found in the PDF, for the dock in Claude Code.
function cleanOutline(body, pages) {
  const list = body?.outline
  if (!Array.isArray(list) || list.length > 2000) throw httpError(400, 'outline must be an array of at most 2000 entries')
  return list.map(entry => {
    const isEntry =
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry.title === 'string' &&
      Number.isInteger(entry.page) &&
      entry.page > 0 &&
      (!pages || entry.page <= pages) &&
      Number.isInteger(entry.level) &&
      entry.level >= 0 &&
      entry.level <= 9
    if (!isEntry) throw httpError(400, 'each outline entry is { title, page, level }')
    return { title: plainText(entry.title).slice(0, 200) || '(untitled)', page: entry.page, level: entry.level }
  })
}

// ---------------------------------------------------------------- text mode

// One page as blocks. The first page of a book also fills what the browser
// viewer would have reported (page count, contents) and calibrates the book.
// Work for one book or page runs once at a time: concurrent requests share it.
const filling = new Map() // bookId -> Promise
const extracting = new Map() // `${bookId}:${page}` -> Promise

async function pageOf(book, n) {
  if (!fs.existsSync(book.path)) throw httpError(404, 'file missing')
  let doc
  try {
    doc = await source.open(book)
  } catch (error) {
    throw httpError(422, `cannot open the PDF: ${errorLine(error)}`)
  }
  if (!Number.isInteger(n) || n < 1 || n > doc.pages) throw httpError(404, `no page ${n}; the book has ${doc.pages}`)
  await shared(filling, book.id, () => fillBook(book, doc))

  const key = `${book.id}:${n}`
  const cached = pageCache.get(key)
  // pdf.js's image sweep may have removed a cached page's pictures; such an answer is extracted again.
  if (cached && cached.blocks.every(block => block.kind !== 'image' || fs.existsSync(block.file))) return cached
  return shared(extracting, key, async () => {
    let answer
    let retry = false
    try {
      const { items, images, drawings, width, height, top, bottom } = await doc.pageContent(n)
      // Figures drawn with paths are rendered into pictures where the canvas is installed, else shown as a line.
      const figured = await withFigures(doc, n, pageBlocks(items, images, book.textProfile, { top, bottom, pageNumber: n, drawings }))
      answer = { page: n, pages: doc.pages, blocks: figured.blocks, scanned: isScanned(items, images, width, height) }
      retry = figured.retry
    } catch (error) {
      answer = { page: n, pages: doc.pages, blocks: [], scanned: false, error: errorLine(error) }
    }
    // A failure may pass (a full disk, a folder gone): the next request tries again. So may a figure that rendered
    // too slowly, but rendering costs seconds of CPU: after FIGURE_RETRIES more tries that answer is kept.
    if (answer.error || (retry && tryAgain(figureTries, key, FIGURE_RETRIES, PAGE_CACHE_MAX))) return answer
    figureTries.delete(key)
    pageCache.set(key, answer)
    if (pageCache.size > PAGE_CACHE_MAX) pageCache.delete(pageCache.keys().next().value)
    return answer
  })
}

// Each part is tried once per book: a failure stores the empty answer instead of retrying on every request.
async function fillBook(book, doc) {
  let changed = false
  if (!book.pages) {
    book.pages = doc.pages
    changed = true
  }
  if (!book.outline) {
    try {
      book.outline = cleanOutline({ outline: clampLevels(await doc.outline()) }, book.pages)
    } catch {
      book.outline = []
    }
    changed = true
  }
  // A profile saved before the folio offset existed is calibrated again: without it no running head is dropped.
  if (typeof book.textProfile !== 'object' || book.textProfile === null || !('folioOffset' in book.textProfile)) {
    let profile
    try {
      profile = calibrate(await doc.samples(12))
    } catch {
      profile = calibrate([])
    }
    // Header lines come from the PDF's text: plain, short.
    book.textProfile = { ...profile, headers: profile.headers.map(h => ({ ...h, text: plainText(h.text).slice(0, 200) })) }
    changed = true
  }
  if (changed) scheduleSave()
}

async function route(req, res) {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const p = url.pathname
  const m = req.method ?? 'GET'

  // A Host other than ours is a DNS-rebinding attempt.
  if (!HOSTS.has(req.headers.host ?? '')) throw httpError(403, 'bad host')
  const isApi = p.startsWith('/api/')
  if (isApi || (m !== 'GET' && m !== 'HEAD')) {
    // Browsers name the page a request comes from; only the reader's own page may call the API.
    // The mod's own requests come from no page and carry neither header.
    const origin = req.headers.origin
    if (origin !== undefined && !ORIGINS.has(origin)) throw httpError(403, 'cross-origin request refused')
    const site = req.headers['sec-fetch-site']
    if (site !== undefined && site !== 'same-origin' && site !== 'none') throw httpError(403, 'cross-site request refused')
  }
  lastActivity = Date.now()

  if (!isApi) return serveStatic(req, res, p)

  if (p === '/api/health') {
    return sendJson(res, 200, { app: APP, version: VERSION, root: ROOT, launchedFrom: LAUNCHED_FROM, pid: process.pid, port: PORT })
  }
  if (p === '/api/state' && m === 'GET') return sendJson(res, 200, publicState())
  if (p === '/api/events' && m === 'GET') return openEvents(req, res, url)

  if (p === '/api/books' && m === 'POST') {
    const body = await readBody(req)
    return sendJson(res, 200, { book: summary(await addBook(body.path)) })
  }
  if (p === '/api/choose' && m === 'POST') {
    const chosen = await chooseFile()
    if (chosen === null) return sendJson(res, 200, { cancelled: true })
    return sendJson(res, 200, { book: summary(await addBook(chosen)) })
  }

  const pageMatch = /^\/api\/books\/([0-9a-f]{12})\/page\/([^/]{1,12})$/.exec(p)
  if (pageMatch && m === 'GET') {
    const n = /^\d{1,6}$/.test(pageMatch[2]) ? Number(pageMatch[2]) : NaN
    return sendJson(res, 200, await pageOf(requireBook(pageMatch[1]), n))
  }

  const bookMatch = /^\/api\/books\/([0-9a-f]{12})(\/[a-z]+)?$/.exec(p)
  if (bookMatch) {
    const book = requireBook(bookMatch[1])
    const action = bookMatch[2] ?? ''
    if (action === '' && m === 'GET') return sendJson(res, 200, { ...book, outline: book.outline ?? null })
    if (action === '' && m === 'DELETE') {
      delete state.books[book.id]
      if (state.currentId === book.id) state.currentId = null
      scheduleSave()
      broadcast({ type: 'library' })
      return sendJson(res, 200, { ok: true })
    }
    if (action === '/pdf' && (m === 'GET' || m === 'HEAD')) return servePdf(req, res, book)
    if (action === '/select' && m === 'POST') {
      state.currentId = book.id
      book.openedAt = Date.now()
      scheduleSave()
      broadcast({ type: 'book', id: book.id })
      return sendJson(res, 200, { book: summary(book) })
    }
    if (action === '/progress' && m === 'POST') {
      mergeProgress(book, await readBody(req))
      return sendJson(res, 200, { ok: true, readCount: book.read.length })
    }
    if (action === '/outline' && m === 'POST') {
      book.outline = cleanOutline(await readBody(req), book.pages)
      scheduleSave()
      return sendJson(res, 200, { ok: true, entries: book.outline.length })
    }
    if (action === '/reset' && m === 'POST') {
      book.read = []
      book.page = 1
      book.location = null
      scheduleSave()
      broadcast({ type: 'book', id: book.id, reset: true })
      return sendJson(res, 200, { ok: true })
    }
  }

  if (p === '/api/settings' && m === 'POST') {
    const body = await readBody(req)
    if (['light', 'sepia', 'dark'].includes(body.theme)) state.settings.theme = body.theme
    if (Number.isFinite(body.readSeconds)) state.settings.readSeconds = Math.min(120, Math.max(1, body.readSeconds))
    if (body.mode === 'browser' || body.mode === 'text') state.settings.mode = body.mode
    scheduleSave()
    return sendJson(res, 200, { settings: state.settings })
  }

  if (p === '/api/show' && m === 'POST') {
    const body = await readBody(req)
    const book = state.books[state.currentId]
    if (!book) return sendJson(res, 200, { shown: false, reason: 'no-book' })
    // A page: the dock's chapter jump. The open reader goes there; a reader
    // opened now starts there.
    const page = Number.isInteger(body.page) && body.page > 0 ? Math.min(body.page, book.pages ?? body.page) : null
    if (page !== null) {
      book.page = page
      book.location = null
      scheduleSave()
    }
    if (clients.size > 0) {
      broadcast(page === null ? { type: 'attention' } : { type: 'goto', id: book.id, page })
      return sendJson(res, 200, { shown: true, launched: false })
    }
    if (Date.now() - lastLaunchAt < 8000) return sendJson(res, 200, { shown: true, launched: false })
    const how = launchViewer(body.window === 'browser' ? 'browser' : 'app')
    if (how === null) return sendJson(res, 200, { shown: false, reason: 'no-browser', url: `http://127.0.0.1:${PORT}/` })
    return sendJson(res, 200, { shown: true, launched: true, how })
  }

  if (p === '/api/task' && m === 'POST') {
    const body = await readBody(req)
    const now = Date.now()
    if (body.returnTo !== undefined) returnTo = cleanTarget(body.returnTo) ?? returnTo
    if (body.state === 'running') {
      setTask({ state: 'running', acked: false, canReturn: canReturn(), startedAt: now, endedAt: null, durationMs: null, summary: '' })
    } else if (['done', 'aborted', 'error'].includes(body.state)) {
      setTask({
        state: body.state,
        acked: false,
        canReturn: canReturn(),
        endedAt: now,
        durationMs: Number.isFinite(body.durationMs) ? body.durationMs : null,
        summary: typeof body.summary === 'string' ? body.summary.slice(0, 600) : '',
      })
      if (body.notify) {
        const book = state.books[state.currentId]
        const headline = body.state === 'done' ? 'Claude finished the task' : 'Claude stopped'
        notify('Claude Code', headline, book ? `📖 ${book.title} — close the book or keep reading?` : 'Back to work?')
      }
    } else if (body.state === 'ack') {
      task = { ...task, acked: true }
      broadcast({ type: 'task', task })
    } else {
      throw httpError(400, 'state must be running, done, aborted, error or ack')
    }
    return sendJson(res, 200, { task, viewers: clients.size })
  }

  if (p === '/api/focus' && m === 'POST') {
    const focused = await focusClaude()
    task = { ...task, acked: true }
    broadcast({ type: 'task', task })
    return sendJson(res, 200, focused)
  }

  if (p === '/api/close' && m === 'POST') {
    const body = await readBody(req)
    // From the reader: back to Claude first, so the person lands there.
    const focused = body.focus === true ? await focusClaude() : { focused: false }
    task = { ...task, acked: true }
    const open = clients.size
    broadcast({ type: 'close' })
    // The page saves its place and tries to close itself; then the window goes.
    setTimeout(closeReaderWindow, 800)
    return sendJson(res, 200, { closed: open, ...focused })
  }

  if (p === '/api/shutdown' && m === 'POST') {
    sendJson(res, 200, { ok: true })
    await Promise.race([source.closeAll(), sleep(2000)])
    await saveNow()
    setTimeout(() => process.exit(0), 50)
    return
  }

  throw httpError(404, 'no such endpoint')
}

async function serve() {
  state = await loadState()
  fs.mkdirSync(PAGES_DIR, { recursive: true, mode: 0o700 })
  await sweepImages(PAGES_DIR, 0)
  const server = http.createServer((req, res) => {
    route(req, res).catch(error => {
      if (res.headersSent) return res.end()
      sendJson(res, error.status ?? 500, { error: error.message })
    })
  })
  server.on('error', async error => {
    if (error.code === 'EADDRINUSE') {
      console.error(`[book-reader] port ${PORT} is in use${(await health()) ? ' by another book-reader' : ''}`)
      process.exit(0)
    }
    throw error
  })
  server.listen(PORT, '127.0.0.1', () => {
    console.error(`[book-reader] ${new Date().toISOString()} listening on http://127.0.0.1:${PORT} (data ${DATA_DIR})`)
  })
  setInterval(() => {
    if (clients.size === 0 && Date.now() - lastActivity > IDLE_EXIT_MS) {
      console.error('[book-reader] idle, exiting')
      Promise.race([source.closeAll(), sleep(2000)]).then(saveNow).finally(() => process.exit(0))
    }
  }, 60_000).unref()
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => saveNow().finally(() => process.exit(0)))
  }
  process.on('SIGHUP', () => {})
}

// ---------------------------------------------------------------- utils

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) out[key] = true
    else {
      out[key] = value
      i++
    }
  }
  return out
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------- start

if (args.daemon) {
  await daemonize()
} else {
  await serve()
}
