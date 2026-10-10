import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, TurnCompleteInput } from 'claude-code'

import type { BookDetail, BookSummary, DockSnapshot, DoneBand, OutlineEntry, ReaderMode, ReaderPage, ReaderState } from '../types'
import { badge, newTask, readClock, withBaseline } from './dock-logic.ts'
import { registerDock } from './dock.tsx'
import { isGraphicsTerminal, parseGoto, readerMode as modeFrom } from './reader-logic.ts'
import { registerReader } from './reader.tsx'

// The reader itself is a local web page (pdf.js) served by server/server.mjs on
// 127.0.0.1. This module starts that server on demand, opens the book when a
// task has run for a while, and tells the reader when the task ends.

const band = atom({ plugin: 'book-reader', key: 'band' } as const, null)

// The Reading Dock's state: dock.tsx draws from it, this module keeps it current.
const DOCK = 'book-dock'
const dock = atom({ plugin: 'book-reader', key: 'dock' } as const, null)
const dockTask = atom({ plugin: 'book-reader', key: 'dockTask' } as const, null)
const blink = atom({ plugin: 'book-reader', key: 'blink' } as const, false)
const dockView = atom({ plugin: 'book-reader', key: 'dockView' } as const, 'main')
// The dock's reader view (text mode): the page shown, when it landed, one line of news.
const readerPage = atom({ plugin: 'book-reader', key: 'readerPage' } as const, null)
const readerShownAt = atom({ plugin: 'book-reader', key: 'readerShownAt' } as const, null)
const readerNote = atom({ plugin: 'book-reader', key: 'readerNote' } as const, null)
const graphics = atom({ plugin: 'book-reader', key: 'graphics' } as const, false)
// The mode as last seen, for the dock's `r` read here (text mode only).
const readerMode = atom({ plugin: 'book-reader', key: 'readerMode' } as const, 'browser')

const HELP = [
  '/book                 open the current book now (or pick one)',
  '/book help            this list (also --help, -h)',
  '/book choose          pick a PDF with the system file dialog',
  '/book <file.pdf>      read that PDF (absolute, ~/ or relative to this project)',
  '/book list            your books with progress; /book <n> switches to one',
  '/book close           close the reader window (your place is kept)',
  '/book dock            show the Reading Dock beside the transcript, or fold it to the status line',
  '/book mode text|browser  read in the dock pane as text, or in the browser window',
  '/book open browser    open the browser window at the current page, whatever the mode',
  '/book auto on|off     open the book by itself while a task runs',
  '/book delay <sec>     how long a task must run before the book opens',
  '/book status          what is set up',
  '/book restart         restart the reader server (your books and places are kept)',
].join('\n')

type Config = {
  port: number
  base: string
  window: 'app' | 'browser'
  mode: ReaderMode
  notify: boolean
  autoOpen: boolean
  openDelaySeconds: number
  nodePath: string
}

const cfg: Config = {
  port: 47321,
  base: 'http://127.0.0.1:47321',
  window: 'app',
  mode: 'browser',
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
  dockPoll: Timer | null
  dockDismissed: boolean
  isFolded: boolean
  /** The mode the server last reported, for when it does not answer. */
  mode: ReaderMode | null
  /** Counts page fetches: only the latest one's answer is shown. */
  pageRequest: number
  /** Why the reader server last failed to start, for /book status. */
  startFailure: string | null
} = {
  turnId: null,
  pendingOpen: null,
  poll: null,
  nodePath: null,
  version: null,
  isWindows: null,
  returnTo: null,
  hasWarnedNoBook: false,
  dockPoll: null,
  dockDismissed: false,
  isFolded: false,
  mode: null,
  pageRequest: 0,
  startFailure: null,
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
  if (!found) throw new Error('node was not found; install Node.js 22.13 or newer, or set "Path to node" for book-reader in /config')
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
  try {
    const node = await findNode($)
    const started = await $.process.run(
      [node, `${$.plugin.root}/server/server.mjs`, '--daemon', '--port', String(cfg.port), '--launched-from', $.plugin.root],
      { timeoutMs: 20_000 },
    )
    if (started.exitCode !== 0) {
      throw new Error(`the reader server did not start: ${(started.stdout + started.stderr).trim().slice(0, 300)}`)
    }
    live.startFailure = null
  } catch (error) {
    live.startFailure = messageOf(error)
    throw error
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

// The server's setting wins over the config; with the server down, the last one it reported.
function modeOf(state: ReaderState | null): ReaderMode {
  if (state) live.mode = modeFrom(state.settings?.mode, cfg.mode)
  return live.mode ?? cfg.mode
}

async function currentMode($: EngineInterface): Promise<ReaderMode> {
  return modeOf(await readerState($))
}

// ------------------------------------------------------------ the book

function where(book: BookSummary): string {
  return book.pages ? `p. ${book.page}/${book.pages}` : `p. ${book.page}`
}

// Opens the reader window, or brings the open one forward (at `page`, when
// given); false when there is no book. `raise` only from a person's own action
// (never the auto-open): the server then also raises the window of the reader
// that is already open, which a page cannot do for itself.
async function show($: EngineInterface, page?: number, raise = false): Promise<boolean> {
  const shown = await api<{ shown: boolean; reason?: string; url?: string }>($, 'POST', '/api/show', {
    window: cfg.window,
    page,
    ...(raise ? { raise: true } : {}),
  })
  if (shown.reason === 'no-browser') throw new Error(`no browser could be opened; open ${shown.url} yourself`)
  return shown.shown
}

// Shows the book where the mode says: the browser window, or the dock's reader
// view at `page` (else the saved page). Null when there is no book. `asked` is
// false from the auto-open timer: then a dock the person put away stays away.
// `isCommand`: a command never awaits its own pane, so there the dock opens and
// the page loads once the answer is out.
async function present($: EngineInterface, page?: number, asked = true, isCommand = false): Promise<BookSummary | null> {
  await ensureServer($)
  const state = await readerState($)
  if (modeOf(state) === 'browser') {
    if (!(await show($, page, asked))) return null
    return (await readerState($))?.current ?? null
  }
  const book = state?.current ?? null
  if (!book) return null
  if (asked) {
    live.dockDismissed = false
    live.isFolded = false
  } else if (live.dockDismissed || live.isFolded) {
    return book // the status line alone says where the book is
  }
  const showPage = async () => {
    await openDock($)
    // Unfolded: the badge leaves the status line, as with /book dock.
    if (asked && live.turnId === null) await restStatus($)
    await update($, dockView, () => 'reader')
    await loadPage($, book, page ?? book.page)
  }
  if (isCommand) void showPage().catch(error => $.ui.toast(`book-reader: ${messageOf(error)}`, { timeoutMs: 7000 }))
  else await showPage()
  return book
}

// ------------------------------------------------------------ the dock

async function refreshDock($: EngineInterface): Promise<DockSnapshot> {
  const state = await readerState($)
  let current: BookDetail | null = null
  if (state?.current) {
    const detail = await api<{ read?: number[]; outline?: OutlineEntry[] | null }>($, 'GET', `/api/books/${state.current.id}`).catch(
      () => ({}) as { read?: number[]; outline?: OutlineEntry[] | null },
    )
    current = { ...state.current, read: detail.read ?? [], outline: detail.outline ?? null }
  }
  const snapshot: DockSnapshot = state
    ? { isServerUp: true, current, books: state.books, viewers: state.viewers, readSeconds: state.settings?.readSeconds }
    : { isServerUp: false, current: null, books: [], viewers: 0 }
  await update($, dock, () => snapshot)
  await update($, dockTask, task => withBaseline(task, snapshot))
  const mode = modeOf(state)
  await update($, readerMode, () => mode)
  return snapshot
}

async function hasDock($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === DOCK)
}

async function isDockPlaced($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === DOCK && pane.isPlaced)
}

/** The person can see page text right now: the dock is drawn, in front, and on the reader view. */
async function readerShown($: EngineInterface): Promise<boolean> {
  const pane = (await $.ui.panes()).find(p => p.id === DOCK)
  return !!pane && pane.isPlaced && pane.isShown && (await read($, dockView)) === 'reader'
}

/** No page is on screen: the read clock waits until one is again. */
async function stopReadClock($: EngineInterface): Promise<void> {
  if ((await read($, readerShownAt)) !== null) await update($, readerShownAt, () => null)
}

async function openDock($: EngineInterface): Promise<void> {
  await $.ui.open({ id: DOCK, title: 'Book Reader', columns: 72 })
  await refreshDock($)
  startDockPoll($)
}

// While the dock is open: every 2 s, fetch what it shows (when it is drawn),
// blink its ● READING and run the read clock. Stops after three ticks with no
// task, no reader window (a reader just launched takes a moment to connect) and
// the dock not on the reader view (a page there, even behind another pane, starts
// its clock again when it comes to the front).
function startDockPoll($: EngineInterface): void {
  if (live.dockPoll) return
  let idleTicks = 0
  live.dockPoll = $.clock.every(2000, async () => {
    const task = await read($, dockTask)
    const isWorking = task !== null && task.endedAt === null
    if (!(await isDockPlaced($))) {
      await stopReadClock($)
      if (!isWorking || !(await hasDock($))) stopDockPoll()
      return
    }
    try {
      const snapshot = await refreshDock($)
      const isReaderView = (await read($, dockView)) === 'reader'
      idleTicks = !isWorking && snapshot.viewers === 0 && !isReaderView ? idleTicks + 1 : 0
      if (idleTicks >= 3) return stopDockPoll()
      await update($, blink, on => !on)
      await tickReadClock($, snapshot)
    } catch (error) {
      $.ui.log(`book-reader: ${messageOf(error)}`, { to: 'debug' })
    }
  })
}

function stopDockPoll(): void {
  live.dockPoll?.cancel()
  live.dockPoll = null
}

// Marks the page read once it has been on screen for readSeconds. The clock
// starts over whenever the page is not on screen (another pane or the dock's
// library in front, the pane folded or waiting undrawn).
async function tickReadClock($: EngineInterface, snapshot: DockSnapshot): Promise<void> {
  const book = snapshot.current
  const page = book ? await shownPageOf($, book) : null
  if (!book || !page) return
  if (!(await readerShown($))) return stopReadClock($)
  const now = await $.clock.now()
  const shownAt = await read($, readerShownAt)
  const verdict = readClock(page, shownAt, now, snapshot.readSeconds ?? 6, book.read.includes(page.page))
  if (verdict === 'start') {
    await update($, readerShownAt, () => now)
    return
  }
  if (verdict !== 'mark') return
  await api($, 'POST', `/api/books/${book.id}/progress`, { read: [page.page] })
  await refreshDock($)
}

// ------------------------------------------------------------ the reader view

// Fetches one page into the reader view. A newer request wins over a late answer:
// every write checks, at the moment it is made, that no newer request began (a
// write the engine retries runs its check again), and an older request never
// posts its page as the place. The server may have gone since the last page
// (n/p retry): it is started again first, and a failure to start is the note.
async function loadPage($: EngineInterface, book: { id: string }, page: number): Promise<void> {
  const request = ++live.pageRequest
  const isLatest = () => request === live.pageRequest
  await update($, readerNote, note => (isLatest() ? `Loading page ${page}…` : note))
  try {
    await ensureServer($)
    if (!isLatest()) return
    const answer = await api<Omit<ReaderPage, 'bookId' | 'fetchedAt'>>($, 'GET', `/api/books/${book.id}/page/${page}`)
    if (!isLatest()) return
    const now = await $.clock.now()
    // The start time goes in before the page: a read-clock tick between the two
    // writes then sees the old page with a fresh clock, never the new page with
    // the old page's start (which would mark it read at once).
    await update($, readerShownAt, at => (isLatest() ? now : at))
    await update($, readerPage, held => (isLatest() ? { ...answer, bookId: book.id, fetchedAt: now } : held))
    await update($, readerNote, note => (isLatest() ? (answer.error ?? null) : note))
    if (!isLatest()) return
    await api($, 'POST', `/api/books/${book.id}/progress`, { page })
    if (!isLatest()) return
    // The new page starts at its top; a pane that cannot scroll still shows the page.
    await $.ui.scroll({ to: 'start', in: DOCK }).catch(error => $.ui.log(`book-reader: ${messageOf(error)}`, { to: 'debug' }))
    await refreshDock($)
  } catch (error) {
    await update($, readerNote, note => (isLatest() ? `Could not load page ${page}: ${messageOf(error)}` : note))
  }
}

/** The book the reader view turns: its id, saved place and length. */
type ReaderBook = Pick<BookDetail, 'id' | 'page' | 'pages'>

// The dock's current book; with the server gone, the book of the page the
// reader still shows (spec: the reader keeps the last page, n/p retry).
async function currentReaderBook($: EngineInterface): Promise<ReaderBook | null> {
  const snapshot = await read($, dock)
  if (snapshot?.isServerUp) return snapshot.current
  const held = await read($, readerPage)
  return held && { id: held.bookId, page: held.page, pages: held.pages }
}

// The page the reader shows of `book`; a page left from another book is none.
async function shownPageOf($: EngineInterface, book: { id: string }): Promise<ReaderPage | null> {
  const shown = await read($, readerPage)
  return shown && shown.bookId === book.id ? shown : null
}

async function turnPage($: EngineInterface, delta: number): Promise<void> {
  const book = await currentReaderBook($)
  if (!book) return
  // Nothing of this book shown yet (its page failed): turn from its saved place.
  const shown = await shownPageOf($, book)
  const pages = shown?.pages ?? book.pages
  const page = (shown?.page ?? book.page) + delta
  if (page < 1 || (pages !== null && page > pages)) return
  await loadPage($, book, page)
}

async function gotoPage($: EngineInterface, input: string): Promise<void> {
  const book = await currentReaderBook($)
  if (!book) return
  const shown = await shownPageOf($, book)
  const pages = shown?.pages ?? book.pages
  const page = parseGoto(input, pages)
  if (page === null) {
    await update($, readerNote, () => `No page ${input.trim()}${pages !== null ? `; the book has ${pages}` : ''}`)
    return
  }
  await loadPage($, book, page)
}

// Marks the page shown read, or unread again; nothing when no page of this book is shown.
// With the server gone, m starts it again first (as n/p do): which pages are read is its to say.
async function markRead($: EngineInterface): Promise<void> {
  if (!(await read($, dock))?.isServerUp) {
    await ensureServer($)
    await refreshDock($)
  }
  const book = (await read($, dock))?.current
  if (!book) return
  const shown = await shownPageOf($, book)
  if (!shown) return
  const isRead = book.read.includes(shown.page)
  await api($, 'POST', `/api/books/${book.id}/progress`, isRead ? { unread: [shown.page] } : { read: [shown.page] })
  await refreshDock($)
}

// The status line between tasks: the badge while the dock is folded, else nothing.
async function restStatus($: EngineInterface): Promise<void> {
  const current = live.isFolded ? (await read($, dock))?.current : null
  $.ui.status(current ? badge(current) : undefined)
}

async function closeDock($: EngineInterface): Promise<void> {
  live.isFolded = true
  stopDockPoll()
  await $.ui.close({ id: DOCK })
  await refreshDock($)
  await restStatus($)
}

/** The dock asked for by the person: placed at any width, and it may open by itself again. */
async function openDockAsked($: EngineInterface): Promise<void> {
  live.isFolded = false
  live.dockDismissed = false
  await ensureServer($)
  await openDock($)
  if (live.turnId === null) await restStatus($)
}

// Presses on the dock that reach the reader server; dock.tsx and reader.tsx draw the Buttons.
async function dockPress($: EngineInterface, element: string): Promise<void> {
  if (element === 'dock-close' || element === 'dock-keep') {
    if ((await read($, readerMode)) === 'text') {
      // No window to close: c goes back to the dashboard, k stays on the page.
      // Both answer the task, so a browser opened later does not ask again.
      await keepReading($)
      if (element === 'dock-close') await update($, dockView, () => 'main')
      return
    }
    if (element === 'dock-close') await closeBook($)
    else await keepReading($)
    await update($, dockTask, () => null)
    return
  }
  if (element === 'reader-next') return turnPage($, 1)
  if (element === 'reader-prev') return turnPage($, -1)
  if (element === 'reader-mark') return markRead($)
  if (element === 'reader-read') {
    // The dashboard's `r` read here: the reader view, at the saved page.
    await update($, dockView, () => 'reader')
    const book = await currentReaderBook($)
    if (book) await loadPage($, book, book.page)
    // The poll may have gone idle on the dashboard: the read clock needs it.
    startDockPoll($)
    return
  }
  if (element === 'reader-open') {
    // The escape hatch: the browser at the page shown, whatever the mode.
    const book = await currentReaderBook($)
    const shown = book ? await shownPageOf($, book) : null
    await ensureServer($)
    await show($, shown?.page, true)
    startDockPoll($)
    return
  }
  const chapter = /^ch-(\d+)-\d+$/.exec(element)
  const book = /^book-([0-9a-f]{12})$/.exec(element)
  if (element === 'dock-open') {
    await present($)
  } else if (chapter) {
    await present($, Number(chapter[1]))
  } else if (book) {
    await ensureServer($)
    await api($, 'POST', `/api/books/${book[1]}/select`)
    await update($, dockView, () => 'main')
    await present($)
    await refreshDock($)
  } else {
    return
  }
  // A reader opened from the dock: follow it again.
  startDockPoll($)
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
    // In text mode present() opens the dock itself, unless it was put away.
    const isBrowser = modeOf(state) === 'browser'
    await present($, undefined, false)
    if (live.turnId !== id) return
    $.ui.status(`📖 ${state.current.title} · ${where(state.current)}`)
    if (isBrowser && !live.dockDismissed && !live.isFolded) await openDock($)
  } catch (error) {
    $.ui.toast(`book-reader: ${messageOf(error)}`, { timeoutMs: 7000 })
  }
}

async function finishTurn($: EngineInterface, e: TurnCompleteInput): Promise<void> {
  const state = await readerState($)
  // Text mode reads in the dock: reading means the reader view is on screen,
  // even with the server gone (the reader keeps its last page; the done box
  // still answers the task).
  const isText = modeOf(state) === 'text'
  const isReading = isText
    ? (state === null || state.current !== null) && (await readerShown($))
    : state !== null && state.current !== null && state.viewers > 0
  // The dock shows the done view only to someone reading through the task.
  const endedAt = await $.clock.now()
  await update($, dockTask, task =>
    task && isReading ? { ...task, endedAt, durationMs: e.durationMs, reason: e.reason } : null,
  )
  if (!state) return
  if (await isDockPlaced($)) await refreshDock($)
  await api($, 'POST', '/api/task', {
    state: e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'aborted' : 'error',
    returnTo: await returnTarget($),
    durationMs: e.durationMs,
    summary: e.answer.slice(0, 600),
    notify: isReading && !isText && cfg.notify && e.reason !== 'aborted',
  })
  if (!isReading || !state.current) return
  // The reader view's done box is the whole answer: no band (the dock is drawn), no window to follow.
  if (isText) return
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
      // Only a finished task: a new one may have started while this tick awaited.
      await update($, dockTask, task => (task && task.endedAt === null ? task : null))
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
  // The dock's done view answers the same question as the band.
  await update($, dockTask, () => null)
}

async function closeBook($: EngineInterface): Promise<void> {
  await clearBand($)
  await restStatus($)
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

  if (verb === 'help' || verb === '--help' || verb === '-h' || verb === '?') return HELP

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

  if (verb === 'mode') {
    const value = rest[0]?.toLowerCase()
    if (value === undefined) return `Reading mode: ${await currentMode($)}. Use /book mode text|browser.`
    if (value !== 'text' && value !== 'browser') return 'Use /book mode text|browser.'
    await ensureServer($)
    await api($, 'POST', '/api/settings', { mode: value })
    live.mode = value
    await update($, readerMode, () => value)
    if (value === 'browser') {
      await update($, dockView, view => (view === 'reader' ? 'main' : view))
      await stopReadClock($)
    }
    return value === 'text'
      ? '📖 Reading mode text: the book opens in the Reading Dock as text; o opens the browser.'
      : '📖 Reading mode browser: the book opens in its own window.'
  }

  if (verb === 'status') {
    const state = await readerState($)
    const lines = [
      `Auto-open: ${(await isAutoOpen($)) ? 'on' : 'off'}, after ${await delaySeconds($)}s of a task`,
      `Reading mode: ${modeOf(state)}`,
      `Reader server: ${state ? `running on ${cfg.base}` : 'not running (starts when needed)'}`,
    ]
    if (!state && live.startFailure) lines.push(`Last start failed: ${live.startFailure}`)
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

  if (verb === 'dock') {
    const isOpen = await hasDock($)
    // Never await our own pane in a command: open or fold it once the answer is out.
    void (async () => {
      try {
        if (isOpen) await closeDock($)
        else await openDockAsked($)
      } catch (error) {
        $.ui.toast(`book-reader: ${messageOf(error)}`, { timeoutMs: 7000 })
      }
    })()
    return isOpen ? '📖 Reading Dock folded: your place stays in the status line.' : '📖 Reading Dock opened.'
  }

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
    const shown = await present($, undefined, true, true)
    return `📖 Now reading “${book.title}” · ${where(shown ?? book)}`
  }

  if (verb === 'choose' || verb === 'pick') {
    const chosen = await chooseBook($)
    if (chosen.cancelled || !chosen.book) return 'No book chosen.'
    const shown = await present($, undefined, true, true)
    return `📖 Now reading “${chosen.book.title}” · ${where(shown ?? chosen.book)}\n${await autoLine($)}`
  }

  if (verb === 'open' && rest[0]?.toLowerCase() === 'browser') {
    const state = await api<ReaderState>($, 'GET', '/api/state')
    if (!state.current) return 'No book chosen: /book choose'
    await show($, (await shownPageOf($, state.current))?.page, true)
    return `📖 ${state.current.title} · ${where(state.current)} · in the browser`
  }

  if (args === '' || verb === 'open') {
    const state = await api<ReaderState>($, 'GET', '/api/state')
    if (!state.current) return runBook($, 'choose')
    const shown = await present($, undefined, true, true)
    // In text mode present() opens the dock already.
    if (modeOf(state) === 'browser') void openDockAsked($).catch(error => $.ui.log(`book-reader: ${messageOf(error)}`, { to: 'debug' }))
    return `📖 ${state.current.title} · ${where(shown ?? state.current)}`
  }

  const path = await resolvePath($, args)
  const added = await api<{ book: BookSummary }>($, 'POST', '/api/books', { path })
  const shown = await present($, undefined, true, true)
  return `📖 Now reading “${added.book.title}” · ${where(shown ?? added.book)}\n${await autoLine($)}`
}

// The engine gives one request 30 s; the server keeps its file dialog open up
// to ten minutes, then closes it and says so. Each request waits CHOOSE_WAIT_MS
// at most and the next one names the dialog the server answered with. The mod
// stops asking one request after the server's limit: only a server that never
// settles the dialog gets that far.
const CHOOSE_WAIT_MS = 20_000
const CHOOSE_LIMIT_MS = 10 * 60_000 + CHOOSE_WAIT_MS

type ChooseAnswer = { pending?: boolean; id?: string; gone?: boolean; cancelled?: boolean; book?: BookSummary }

async function chooseBook($: EngineInterface): Promise<{ cancelled?: boolean; book?: BookSummary }> {
  const until = (await $.clock.now()) + CHOOSE_LIMIT_MS
  let id: string | undefined
  // A server that answered at once each time would loop: count the requests too.
  for (let asked = 0; asked * CHOOSE_WAIT_MS < CHOOSE_LIMIT_MS; asked++) {
    const answer = await api<ChooseAnswer>($, 'POST', '/api/choose', { waitMs: CHOOSE_WAIT_MS, ...(id ? { id } : {}) })
    if (answer.gone) throw new Error('the file dialog is gone (the reader server restarted?); run /book choose again')
    if (!answer.pending) return answer
    // Still open: the dialog may be behind the terminal.
    if (id === undefined) $.ui.toast('📖 Choose a PDF in the file dialog (it may be behind this window)', { timeoutMs: 8000 })
    id = answer.id
    if ((await $.clock.now()) >= until) break
  }
  throw new Error('no answer from the file dialog; run /book choose again')
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
    mode: options.mode === 'text' ? 'text' : 'browser',
    notify: options.notify !== false,
    autoOpen: options.autoOpen !== false,
    openDelaySeconds: Number.isFinite(delay) && delay >= 0 ? delay : 5,
    nodePath: String(options.nodePath ?? '').trim(),
  })

  // The dock's drawing lives in dock.tsx; its lifecycle stays here.
  registerDock(on)
  registerReader(on)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'book',
      description: 'Book reader: pick a PDF, open or close it, list books, auto-open on/off',
      argumentHint: '[choose | <file.pdf> | list | <n> | close | dock | mode text|browser | auto on|off | delay <s> | status | restart | help]',
      immediate: true,
    })
    // Pictures in the reader view: drawn where the terminal speaks kitty graphics.
    // A failed look reads as none: the reader then draws a line for each picture.
    try {
      const env = {
        TERM_PROGRAM: await $.env.get('TERM_PROGRAM'),
        TERM: await $.env.get('TERM'),
        KITTY_WINDOW_ID: await $.env.get('KITTY_WINDOW_ID'),
        GHOSTTY_RESOURCES_DIR: await $.env.get('GHOSTTY_RESOURCES_DIR'),
      }
      await update($, graphics, () => isGraphicsTerminal(env))
    } catch (error) {
      $.ui.log(`book-reader: graphics detection: ${messageOf(error)}`, { to: 'debug' })
      await update($, graphics, () => false).catch(() => {})
    }
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
    const startedAt = await $.clock.now()
    const started = await next(e)
    live.turnId = e.turnId
    live.pendingOpen?.cancel()
    live.pendingOpen = null
    await clearBand($)
    const isServerUp = await isUp($)
    const snapshot = isServerUp ? await refreshDock($).catch(() => null) : null
    await update($, dockTask, () => newTask(e.text, startedAt, snapshot))
    if (await hasDock($)) startDockPoll($)
    if (isServerUp) {
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
    await restStatus($)
    await finishTurn($, e).catch(error => $.ui.log(`book-reader: ${messageOf(error)}`, { to: 'debug' }))
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const done = await read($, band)
    if (done === null || e.props.hasSurvey || e.props.isWorking) return next(e)
    // The dock shows the same choice while it is drawn.
    if (await isDockPlaced($)) return next(e)
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

  on('ui.press', { requestId: DOCK }, async ($, e, next) => {
    const result = await next(e)
    await dockPress($, e.element).catch(error => $.ui.toast(`book-reader: ${messageOf(error)}`, { timeoutMs: 7000 }))
    // A press that left the reader view (d, l, c, a library row) leaves no page on screen.
    // On it, the read clock needs the poll, which stops while the pane waits undrawn
    // with no task: a press on a pane drawn again starts it (no-op when running).
    if ((await read($, dockView)) !== 'reader') await stopReadClock($)
    else startDockPoll($)
    return result
  })

  on('ui.input', { requestId: DOCK, element: 'reader-goto' }, async ($, e, next) => {
    const result = await next(e)
    if (e.kind === 'submit') {
      await gotoPage($, e.value).catch(error => $.ui.toast(`book-reader: ${messageOf(error)}`, { timeoutMs: 7000 }))
      // As for a press on the reader view: the read clock needs the poll.
      startDockPoll($)
    }
    return result
  })

  on('ui.close', { id: DOCK }, async ($, e, next) => {
    const result = await next(e)
    if (e.origin.kind === 'person') live.dockDismissed = true
    stopDockPoll()
    await stopReadClock($)
    // The band waits while the dock is drawn: draw it again now that the dock is gone.
    await update($, band, held => held && { ...held })
    return result
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
