import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, TurnCompleteInput } from 'claude-code'

import type { BookSummary, DoneBand, ReaderState } from '../types'

// The reader itself is a local web page (pdf.js) served by server/server.mjs on
// 127.0.0.1. This module starts that server on demand, opens the book when a
// task has run for a while, and tells the reader when the task ends.

const band = atom({ plugin: 'book-reader', key: 'band' } as const, null)

const HELP = [
  '/book                 open the current book now (or pick one)',
  '/book choose          pick a PDF with the system file dialog',
  '/book <file.pdf>      read that PDF (absolute, ~/ or relative to this project)',
  '/book list            your books with progress; /book <n> switches to one',
  '/book close           close the reader window (your place is kept)',
  '/book auto on|off     open the book by itself while a task runs',
  '/book delay <sec>     how long a task must run before the book opens',
  '/book status          what is set up',
  '/book restart         restart the reader server (your books and places are kept)',
].join('\n')

type Config = {
  port: number
  base: string
  window: 'app' | 'browser'
  notify: boolean
  autoOpen: boolean
  openDelaySeconds: number
  nodePath: string
}

const cfg: Config = {
  port: 47321,
  base: 'http://127.0.0.1:47321',
  window: 'app',
  notify: true,
  autoOpen: true,
  openDelaySeconds: 5,
  nodePath: '',
}

// What this load of the module tracks; a reload starts it over.
const live: {
  turnId: string | null
  pendingOpen: Timer | null
  poll: Timer | null
  nodePath: string | null
  version: string | null
  isWindows: boolean | null
  returnTo: ReturnTo | null
  hasWarnedNoBook: boolean
} = {
  turnId: null,
  pendingOpen: null,
  poll: null,
  nodePath: null,
  version: null,
  isWindows: null,
  returnTo: null,
  hasWarnedNoBook: false,
}

/** Where this session runs, so the reader can bring it to the front. */
type ReturnTo = { bundleId?: string; windowId?: string; pid?: number }

// Windows: walks up from this PowerShell to the first process that owns a
// window (Windows Terminal, the console, VS Code) and prints its id.
const WINDOWS_HOST_PID = `
$ErrorActionPreference = 'SilentlyContinue'
$id = $PID
for ($i = 0; $i -lt 12 -and $id; $i++) {
  $process = Get-Process -Id $id
  if ($process -and $process.MainWindowHandle -ne [IntPtr]::Zero) { [Console]::Out.Write($id); exit 0 }
  $id = (Get-CimInstance Win32_Process -Filter "ProcessId=$id").ParentProcessId
}
exit 1
`

type Health = { app?: string; version?: string; launchedFrom?: string | null }

// Finds node on macOS and Linux: PATH plus the usual install folders, then the
// person's login shell, then the newest nvm or fnm install. Prints one path.
const NODE_SEARCH = `
for d in /opt/homebrew/bin /usr/local/bin /home/linuxbrew/.linuxbrew/bin /snap/bin "$HOME/.volta/bin" "$HOME/.local/bin" "$HOME/.asdf/shims" "$HOME/.local/share/mise/shims" "$HOME/.nodenv/shims" "$HOME/n/bin"; do PATH="$PATH:$d"; done
command -v node && exit 0
for sh in "$SHELL" /bin/zsh /bin/bash; do
  if [ -n "$sh" ] && [ -x "$sh" ]; then
    found=$("$sh" -lc 'command -v node' 2>/dev/null) && case "$found" in /*) echo "$found"; exit 0;; esac
  fi
done
ls -d "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node "$HOME"/.fnm/node-versions/*/installation/bin/node 2>/dev/null | sort -V | tail -n 1
`

// ------------------------------------------------------------ server

async function api<T>($: EngineInterface, method: string, path: string, body?: unknown): Promise<T> {
  const res = await $.http.fetch(`${cfg.base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = res.text ? JSON.parse(res.text) : {}
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data as T
}

async function health($: EngineInterface): Promise<Health | null> {
  try {
    const res = await $.http.fetch(`${cfg.base}/api/health`)
    return res.ok ? (JSON.parse(res.text) as Health) : { app: 'unknown' }
  } catch {
    return null
  }
}

async function isUp($: EngineInterface): Promise<boolean> {
  return (await health($))?.app === 'book-reader'
}

// The version in this plugin's manifest: a server that reports an older one is
// left over from before an update.
async function pluginVersion($: EngineInterface): Promise<string> {
  if (live.version) return live.version
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: string }
    live.version = manifest.version ?? '0.0.0'
  } catch {
    live.version = '0.0.0'
  }
  return live.version
}

async function stopServer($: EngineInterface): Promise<void> {
  try {
    await api($, 'POST', '/api/shutdown')
  } catch {}
  for (let i = 0; i < 30 && (await health($)) !== null; i++) await $.clock.sleep(100)
}

// The app or window this session runs in: macOS names the app in
// __CFBundleIdentifier (Terminal, iTerm, VS Code, the Claude app), X11 terminals
// set WINDOWID, and on Windows the window's process is found by walking up.
async function returnTarget($: EngineInterface): Promise<ReturnTo> {
  if (live.returnTo) return live.returnTo
  const target: ReturnTo = {}
  const bundleId = await $.env.get('__CFBundleIdentifier')
  if (bundleId) target.bundleId = bundleId
  const windowId = await $.env.get('WINDOWID')
  if (windowId) target.windowId = windowId
  if (await isWindows($)) {
    try {
      const found = await $.process.run(
        ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(WINDOWS_HOST_PID)],
        { timeoutMs: 15_000 },
      )
      const pid = Number.parseInt(found.stdout.trim(), 10)
      if (found.exitCode === 0 && pid > 0) target.pid = pid
    } catch {}
  }
  live.returnTo = target
  return target
}

async function isWindows($: EngineInterface): Promise<boolean> {
  if (live.isWindows === null) live.isWindows = (await $.env.get('OS')) === 'Windows_NT'
  return live.isWindows
}

async function findNode($: EngineInterface): Promise<string> {
  if (cfg.nodePath) return cfg.nodePath
  if (live.nodePath) return live.nodePath
  const found = (await isWindows($)) ? await findNodeOnWindows($) : await findNodeOnUnix($)
  if (!found) throw new Error('node was not found; install Node.js 18 or newer, or set "Path to node" for book-reader in /config')
  live.nodePath = found
  return found
}

async function findNodeOnUnix($: EngineInterface): Promise<string | null> {
  const run = await $.process.run(['/bin/sh', '-c', NODE_SEARCH])
  const lines = run.stdout.split('\n').map(line => line.trim())
  return lines.filter(line => line.startsWith('/')).pop() ?? null
}

async function findNodeOnWindows($: EngineInterface): Promise<string | null> {
  try {
    const run = await $.process.run(['where.exe', 'node'])
    const exe = run.stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(line => /\.exe$/i.test(line))
    if (run.exitCode === 0 && exe) return exe
  } catch {}
  const candidates: [string | undefined, string][] = [
    [await $.env.get('NVM_SYMLINK'), 'node.exe'],
    [await $.env.get('ProgramFiles'), 'nodejs\\node.exe'],
    [await $.env.get('ProgramFiles'), 'Volta\\node.exe'],
    [await $.env.get('LOCALAPPDATA'), 'Programs\\nodejs\\node.exe'],
  ]
  for (const [base, rest] of candidates) {
    if (!base) continue
    const file = `${base.replace(/[\\/]+$/, '')}\\${rest}`
    if (await $.fs.exists(file)) return file
  }
  return null
}

async function ensureServer($: EngineInterface): Promise<void> {
  const version = await pluginVersion($)
  const running = await health($)
  if (running !== null && running.app !== 'book-reader') {
    throw new Error(`port ${cfg.port} is taken by another program; pick another "Reader server port" in /config`)
  }
  if (running !== null) {
    // Several installs can share one server (two sessions, an update mid-session):
    // the newest version serves them all, so only an older one is replaced.
    if (!isOlderVersion(running.version, version)) return
    await stopServer($)
  }
  const node = await findNode($)
  const started = await $.process.run(
    [node, `${$.plugin.root}/server/server.mjs`, '--daemon', '--port', String(cfg.port), '--launched-from', $.plugin.root],
    { timeoutMs: 20_000 },
  )
  if (started.exitCode !== 0) {
    throw new Error(`the reader server did not start: ${(started.stdout + started.stderr).trim().slice(0, 300)}`)
  }
}

async function readerState($: EngineInterface): Promise<ReaderState | null> {
  try {
    return await api<ReaderState>($, 'GET', '/api/state')
  } catch {
    return null
  }
}

// ------------------------------------------------------------ settings

async function isAutoOpen($: EngineInterface): Promise<boolean> {
  const stored = await $.store.get('autoOpen')
  return typeof stored === 'boolean' ? stored : cfg.autoOpen
}

async function delaySeconds($: EngineInterface): Promise<number> {
  const stored = await $.store.get('delaySeconds')
  const value = typeof stored === 'number' ? stored : cfg.openDelaySeconds
  return Number.isFinite(value) && value >= 0 ? value : 5
}

// ------------------------------------------------------------ the book

function where(book: BookSummary): string {
  return book.pages ? `p. ${book.page}/${book.pages}` : `p. ${book.page}`
}

// Opens the reader window, or brings the open one forward; false when there is no book.
async function show($: EngineInterface): Promise<boolean> {
  const shown = await api<{ shown: boolean; reason?: string; url?: string }>($, 'POST', '/api/show', { window: cfg.window })
  if (shown.reason === 'no-browser') throw new Error(`no browser could be opened; open ${shown.url} yourself`)
  return shown.shown
}

async function showBook($: EngineInterface): Promise<BookSummary | null> {
  await ensureServer($)
  if (!(await show($))) return null
  return (await readerState($))?.current ?? null
}

async function openForTurn($: EngineInterface, id: string): Promise<void> {
  if (live.turnId !== id) return
  try {
    await ensureServer($)
    const state = await api<ReaderState>($, 'GET', '/api/state')
    if (!state.current) {
      if (!live.hasWarnedNoBook) {
        live.hasWarnedNoBook = true
        $.ui.toast('📖 No book yet: run /book to pick a PDF to read while Claude works', { timeoutMs: 7000 })
      }
      return
    }
    await api($, 'POST', '/api/task', { state: 'running', returnTo: await returnTarget($) })
    await show($)
    if (live.turnId === id) $.ui.status(`📖 ${state.current.title} · ${where(state.current)}`)
  } catch (error) {
    $.ui.toast(`book-reader: ${messageOf(error)}`, { timeoutMs: 7000 })
  }
}

async function finishTurn($: EngineInterface, e: TurnCompleteInput): Promise<void> {
  const state = await readerState($)
  if (!state) return
  const isReading = state.viewers > 0 && state.current !== null
  await api($, 'POST', '/api/task', {
    state: e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'aborted' : 'error',
    returnTo: await returnTarget($),
    durationMs: e.durationMs,
    summary: e.answer.slice(0, 600),
    notify: isReading && cfg.notify && e.reason !== 'aborted',
  })
  if (!isReading || !state.current) return
  const book = state.current
  const done: DoneBand = {
    title: book.title,
    page: book.page,
    pages: book.pages,
    readCount: book.readCount,
    durationMs: e.durationMs,
    reason: e.reason,
  }
  await update($, band, () => done)
  $.ui.toast(
    e.reason === 'answer'
      ? `✓ Task finished: close “${book.title}” or keep reading?`
      : `Task ended (${e.reason}): close “${book.title}” or keep reading?`,
    { timeoutMs: 6000 },
  )
  watchReader($)
}

// While the band shows, follow the reader: closing the window or choosing
// "Keep reading" there takes the band down here too.
function watchReader($: EngineInterface): void {
  live.poll?.cancel()
  live.poll = $.clock.every(4000, async () => {
    const state = await readerState($)
    if (!state || state.viewers === 0 || state.task.acked || !state.current) {
      live.poll?.cancel()
      live.poll = null
      await update($, band, () => null)
      return
    }
    const book = state.current
    await update($, band, held =>
      held && (held.page !== book.page || held.readCount !== book.readCount)
        ? { ...held, page: book.page, pages: book.pages, readCount: book.readCount }
        : held,
    )
  })
}

async function clearBand($: EngineInterface): Promise<void> {
  live.poll?.cancel()
  live.poll = null
  await update($, band, () => null)
}

async function closeBook($: EngineInterface): Promise<void> {
  await clearBand($)
  $.ui.status(undefined)
  try {
    // Claude is already in front here: only the reader closes.
    await api($, 'POST', '/api/close', { focus: false })
  } catch {}
}

async function keepReading($: EngineInterface): Promise<void> {
  await clearBand($)
  try {
    await api($, 'POST', '/api/task', { state: 'ack' })
  } catch {}
}

// ------------------------------------------------------------ /book

async function runBook($: EngineInterface, raw: string): Promise<string> {
  const args = raw.trim()
  const [word = '', ...rest] = args.split(/\s+/)
  const verb = word.toLowerCase()

  if (verb === 'help' || verb === '?') return HELP

  if (verb === 'auto') {
    const value = rest[0]?.toLowerCase()
    if (value !== 'on' && value !== 'off') return `Auto-open is ${(await isAutoOpen($)) ? 'on' : 'off'}. Use /book auto on|off.`
    await $.store.set('autoOpen', value === 'on')
    return value === 'on'
      ? `📖 Auto-open on: the book opens once a task has run ${await delaySeconds($)}s.`
      : '📖 Auto-open off: open the book yourself with /book.'
  }

  if (verb === 'delay') {
    const seconds = Number(rest[0])
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) return 'Usage: /book delay <seconds>, 0 to 3600.'
    await $.store.set('delaySeconds', seconds)
    return seconds === 0 ? '📖 The book opens as soon as a task starts.' : `📖 The book opens once a task has run ${seconds}s.`
  }

  if (verb === 'status') {
    const state = await readerState($)
    const lines = [
      `Auto-open: ${(await isAutoOpen($)) ? 'on' : 'off'}, after ${await delaySeconds($)}s of a task`,
      `Reader server: ${state ? `running on ${cfg.base}` : 'not running (starts when needed)'}`,
    ]
    if (state?.current) {
      const b = state.current
      lines.unshift(`📖 ${b.title} · ${where(b)} · ${b.readCount} pages read`, `   ${b.path}`)
    } else if (state) {
      lines.unshift('No book chosen: /book choose')
    }
    if (state) lines.push(`Reader windows open: ${state.viewers}`)
    return lines.join('\n')
  }

  if (verb === 'restart') {
    if (await isUp($)) await stopServer($)
    await ensureServer($)
    return `Reader server restarted on ${cfg.base}.`
  }

  if (verb === 'close') {
    const state = await readerState($)
    await closeBook($)
    return state && state.viewers > 0 ? '🔖 Book closed; your place is kept.' : 'No book is open.'
  }

  await ensureServer($)

  if (verb === 'list' || verb === 'ls') {
    const state = await api<ReaderState>($, 'GET', '/api/state')
    if (state.books.length === 0) return 'No books yet: /book choose'
    return state.books
      .map((b, i) => {
        const pct = b.pages ? ` · ${Math.round((100 * b.readCount) / b.pages)}% read` : ''
        const mark = b.id === state.current?.id ? '  ← current' : ''
        return `${i + 1}. ${b.title} · ${where(b)}${pct}${mark}`
      })
      .concat('', 'Switch with /book <n>.')
      .join('\n')
  }

  if (/^\d+$/.test(verb)) {
    const state = await api<ReaderState>($, 'GET', '/api/state')
    const book = state.books[Number(verb) - 1]
    if (!book) return `No book number ${verb}; see /book list.`
    await api($, 'POST', `/api/books/${book.id}/select`)
    const shown = await showBook($)
    return `📖 Now reading “${book.title}” · ${where(shown ?? book)}`
  }

  if (verb === 'choose' || verb === 'pick') {
    const chosen = await api<{ cancelled?: boolean; book?: BookSummary }>($, 'POST', '/api/choose')
    if (chosen.cancelled || !chosen.book) return 'No book chosen.'
    const shown = await showBook($)
    return `📖 Now reading “${chosen.book.title}” · ${where(shown ?? chosen.book)}\n${await autoLine($)}`
  }

  if (args === '' || verb === 'open') {
    const state = await api<ReaderState>($, 'GET', '/api/state')
    if (!state.current) return runBook($, 'choose')
    const shown = await showBook($)
    return `📖 ${state.current.title} · ${where(shown ?? state.current)}`
  }

  const path = await resolvePath($, args)
  const added = await api<{ book: BookSummary }>($, 'POST', '/api/books', { path })
  const shown = await showBook($)
  return `📖 Now reading “${added.book.title}” · ${where(shown ?? added.book)}\n${await autoLine($)}`
}

async function autoLine($: EngineInterface): Promise<string> {
  return (await isAutoOpen($))
    ? `It opens by itself once a task has run ${await delaySeconds($)}s, at the page where you stop.`
    : 'Auto-open is off: /book auto on to open it while tasks run.'
}

async function resolvePath($: EngineInterface, raw: string): Promise<string> {
  const windows = await isWindows($)
  let path = raw.replace(/^(["'])(.*)\1$/, '$2')
  if (path.startsWith('file://')) {
    path = decodeURIComponent(path.slice('file://'.length))
    if (windows) path = path.replace(/^\/([a-zA-Z]:)/, '$1')
  }
  if (!windows) path = path.replace(/\\ /g, ' ')
  if (path.startsWith('~/') || path.startsWith('~\\') || isAbsolutePath(path, windows)) return path
  const cwd = (await $.session.cwd()).replace(/[\\/]+$/, '')
  const separator = windows ? '\\' : '/'
  return `${cwd}${separator}${path.replace(/^\.[\\/]/, '')}`
}

/** PowerShell's -EncodedCommand: the script as UTF-16LE, in base64. */
function encodePowerShell(script: string): string {
  const bytes: number[] = []
  for (let i = 0; i < script.length; i++) {
    const code = script.charCodeAt(i)
    bytes.push(code & 0xff, code >> 8)
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]]
    const n = (a << 16) | (b << 8) | c
    out += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? alphabet[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? alphabet[n & 63]! : '='
  }
  return out
}

function isOlderVersion(running: string | undefined, mine: string): boolean {
  const parts = (version: string) => version.split(/[.+-]/).slice(0, 3).map(part => Number.parseInt(part, 10) || 0)
  if (!running) return true
  const [a, b] = [parts(running), parts(mine)]
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0)
  }
  return false
}

function isAbsolutePath(path: string, windows: boolean): boolean {
  return windows ? /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(path) : path.startsWith('/')
}

export const register: Register = (on, options) => {
  const port = Number(options.port) > 0 ? Number(options.port) : 47321
  const delay = Number(options.openDelaySeconds)
  Object.assign(cfg, {
    port,
    base: `http://127.0.0.1:${port}`,
    window: options.window === 'browser' ? 'browser' : 'app',
    notify: options.notify !== false,
    autoOpen: options.autoOpen !== false,
    openDelaySeconds: Number.isFinite(delay) && delay >= 0 ? delay : 5,
    nodePath: String(options.nodePath ?? '').trim(),
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'book',
      description: 'Book reader: pick a PDF, open or close it, list books, auto-open on/off',
      argumentHint: '[choose | <file.pdf> | list | <n> | close | auto on|off | delay <s> | status | restart]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'book' }, async ($, e) => {
    try {
      return { text: await runBook($, e.args) }
    } catch (error) {
      return { text: `book-reader: ${messageOf(error)}` }
    }
  })

  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    live.turnId = e.turnId
    live.pendingOpen?.cancel()
    live.pendingOpen = null
    await clearBand($)
    if (await isUp($)) {
      // A reader window may already be open: show it that a task runs.
      await api($, 'POST', '/api/task', { state: 'running', returnTo: await returnTarget($) }).catch(() => {})
    }
    if (await isAutoOpen($)) {
      const id = e.turnId
      const delayMs = (await delaySeconds($)) * 1000
      if (delayMs === 0) void openForTurn($, id)
      else live.pendingOpen = $.clock.after(delayMs, () => openForTurn($, id))
    }
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    live.pendingOpen?.cancel()
    live.pendingOpen = null
    live.turnId = null
    $.ui.status(undefined)
    await finishTurn($, e).catch(error => $.ui.log(`book-reader: ${messageOf(error)}`, { to: 'debug' }))
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const done = await read($, band)
    if (done === null || e.props.hasSurvey || e.props.isWorking) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const headline =
      done.reason === 'answer' ? '✓ Task finished' : done.reason === 'aborted' ? '■ Task stopped' : '⚠ Task ended with an error'
    const place = done.pages ? `p. ${done.page}/${done.pages}` : `p. ${done.page}`

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">
        <Text color={done.reason === 'answer' ? 'green' : 'yellow'} bold>
          {headline}
        </Text>
        <Text dimColor wrap="truncate-end">
          📖 {done.title} · {place} · {done.readCount} read
        </Text>
        <Button key="close" label="Close book" hotkey="c" variant="primary" onPress={() => closeBook($)} />
        <Button key="keep" label="Keep reading" hotkey="k" onPress={() => keepReading($)} />
      </Box>
    )
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
