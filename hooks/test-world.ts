import { mock } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On, PluginState, UiScrollArgs } from 'claude-code'

import type { BookSummary, OutlineEntry, ReaderPage } from '../types'

/** The `$` and `on` a test body receives. */
export type TestDollar = Parameters<TestBody>[0]
export type TestOn = Parameters<TestBody>[1]

type Call = { method: string; path: string; body: Record<string, unknown> | undefined }

export const BOOK = { id: 'abc123abc123', path: '/books/dune.pdf', title: 'Dune', page: 42, pages: 300, readCount: 37, openedAt: 1 }

const MANIFEST = '/.claude-plugin/plugin.json'

export type Reader = {
  viewers: number
  hasBook: boolean
  isUp?: boolean
  version?: string
  launchedFrom?: string
  /** Linux with no xdg-open and no Chromium browser. */
  hasNoBrowser?: boolean
  /** The current book's fields that differ from BOOK (reading moves page and readCount). */
  book?: Partial<BookSummary>
  /** The current book's read pages and contents, as GET /api/books/:id answers. */
  read?: number[]
  outline?: OutlineEntry[] | null
  /** The server's stored mode; absent until set. */
  mode?: 'browser' | 'text'
  /** Page answers by number; a page not listed answers one paragraph "Page N text." */
  pages?: Record<number, Partial<Pick<ReaderPage, 'blocks' | 'scanned' | 'error' | 'pages'>>>
  /** Pages the current book has marked read (progress posts land here). */
  readPages?: number[]
  /** Pages whose answer waits until the test calls `release(n)` (for racing tests). */
  holdPages?: number[]
  /** Pages whose fetch fails, as the server answers a book whose file is gone. */
  failPages?: number[]
  /** How many /api/choose requests answer "still open" before the dialog's outcome. */
  choosePending?: number
  /** The dialog's outcome: the current book picked, else (default) a cancel. */
  choosesBook?: boolean
  /** The dialog is gone after its first "still open" (a server restart, another dialog since). */
  chooseGone?: boolean
}

export type Host = {
  /** The OS the session runs on, as the mod tells it: Windows sets OS=Windows_NT. */
  os?: 'unix' | 'windows'
  cwd?: string
  /** What `where.exe node` prints on Windows; absent, it finds nothing. */
  whereNode?: string
  /** Files that exist, for the mod's fallback search on Windows. */
  files?: string[]
  /** More environment variables of the session. */
  env?: Record<string, string>
  /** What the Windows window-owner search prints. */
  windowPid?: string
  /** Whether a pane the mod opens is drawn (a fullscreen terminal wide enough). */
  placesPanes?: boolean
  /** Whether the dock pane is the one in front (default true). */
  shownPane?: boolean
  /** What the server prints when it refuses to start (exit 1), e.g. node too old. */
  daemonFails?: string
  /** The version in this install's manifest (default 1.2.3); a server it starts reports it. */
  manifestVersion?: string
}

// The test runner has timers; the mod's own environment (and so its types) has none.
const runnerTimers = globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => unknown }

/**
 * Waits `ms` of real time (not the mocked clock): for work a command starts
 * once its answer is out, which no promise of the test's own settles.
 */
export function realDelay(ms: number): Promise<void> {
  return new Promise(resolve => {
    runnerTimers.setTimeout(resolve, ms)
  })
}

const ok = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// A stand-in for the machine and for server/server.mjs: answers the module's
// process, file and HTTP calls, and records them.
export function world(on: On, reader: Reader, hostOptions: Host = {}) {
  const host = { os: 'unix', cwd: '/home/me/project', files: [], manifestVersion: '1.2.3', ...hostOptions }
  const calls: Call[] = []
  const runs: string[][] = []
  const scrolls: UiScrollArgs[] = []
  const held = new Map<number, () => void>()
  const release = (n: number) => {
    held.get(n)?.()
    held.delete(n)
  }
  const task = { state: 'idle', seq: 0, acked: true }
  let pluginRoot = ''
  const baseEnv: Record<string, string> = host.os === 'windows' ? { OS: 'Windows_NT', ProgramFiles: 'C:\\Program Files' } : {}
  mock.env(on, { ...baseEnv, ...host.env })
  on('fs.read', ($, e) => {
    // On Windows the engine hands the path over with backslashes.
    if (!e.path.replaceAll('\\', '/').endsWith(MANIFEST)) return { deny: 'not in this test' }
    pluginRoot = e.path.slice(0, -MANIFEST.length)
    return { value: JSON.stringify({ version: host.manifestVersion }) }
  })
  // The test runs on this machine, whose engine resolves a Windows path against its own cwd.
  on('fs.exists', ($, e) => ({ value: host.files.some(file => e.path === file || e.path.endsWith(`/${file}`)) }))
  on('session.cwd', () => ({ value: host.cwd }))
  mock.store(on)
  // The test's `$` has no `state` noun: keep the mod's last write of each value.
  const stateValues = new Map<string, unknown>()
  on('state.set', async ($, e, next) => {
    const result = await next(e)
    // Beneath the mod, `next` resolves the bottom's answer, `{ value: { isSet, version } }`.
    const isSet = (result as unknown as { value?: { isSet?: boolean } }).value?.isSet === true
    if (e.plugin === 'book-reader' && isSet) stateValues.set(e.key, e.value)
    return result
  })
  const state = <K extends keyof PluginState['book-reader']>(key: K) => stateValues.get(key) as PluginState['book-reader'][K] | undefined
  const clock = mock.clock(on, { now: 1_000 })
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const statuses: (string | undefined)[] = []
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  const panes: { id: string; isPlaced: boolean }[] = []
  const opens: { id: string; columns?: number }[] = []
  on('ui.open', ($, e) => {
    opens.push({ id: e.id, columns: e.columns })
    const isPlaced = host.placesPanes === true
    if (!panes.some(pane => pane.id === e.id)) panes.push({ id: e.id, isPlaced })
    return { value: isPlaced ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'narrow' } }
  })
  on('ui.panes', () => ({
    value: panes.map(pane => ({ ...pane, title: 'Book Reader', isShown: host.shownPane !== false, isFocused: false })),
  }))
  on('ui.scroll', ($, e) => {
    // Only the test's own `$.ui.scroll` reaches here, with its arguments as given
    // (`to`, `in`, `block`). The kit resolves no window for the mod's `$.ui.scroll`,
    // which rejects ("no implementation for ui.scroll") before any hook runs.
    scrolls.push({ ...(e as unknown as UiScrollArgs) })
    return {}
  })
  on('ui.close', ($, e) => {
    const at = panes.findIndex(pane => pane.id === e.id)
    if (at >= 0) panes.splice(at, 1)
    return { value: undefined }
  })
  // What the mod logs (debug lines included), e.g. a refused focus move.
  const logs: string[] = []
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.render', ($, e) => $.ui.resolve(e).Box({}))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    if (e.argv[0] === '/bin/sh') return ok('/usr/local/bin/node\n')
    if (e.argv[0] === 'where.exe') return host.whereNode ? ok(host.whereNode) : ok('', 1)
    if (e.argv[0] === 'powershell.exe') return host.windowPid ? ok(host.windowPid) : ok('', 1)
    if (e.argv.includes('--daemon')) {
      if (host.daemonFails) return { value: { exitCode: 1, stdout: '', stderr: `${host.daemonFails}\n`, isStdoutTruncated: false, isStderrTruncated: false } }
      const launchedFrom = e.argv[e.argv.indexOf('--launched-from') + 1]
      Object.assign(reader, { isUp: true, version: host.manifestVersion, launchedFrom })
    }
    return ok('{"ok":true}')
  })
  on('http.fetch', ($, e) => {
    const url = new URL(e.url)
    const method = e.init?.method ?? 'GET'
    const body = e.init?.body ? (JSON.parse(e.init.body) as Record<string, unknown>) : undefined
    calls.push({ method, path: url.pathname, body })
    const json = (value: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(value) } })
    if (reader.isUp === false) return { deny: 'connection refused' }
    // The book routes answer for the current book (BOOK, or the one `reader.book` switched to).
    const book = { ...BOOK, ...reader.book }
    switch (url.pathname) {
      case '/api/health':
        return json({ app: 'book-reader', version: reader.version ?? '1.2.3', launchedFrom: reader.launchedFrom ?? pluginRoot })
      case '/api/shutdown':
        reader.isUp = false
        return json({ ok: true })
      case '/api/state': {
        const settings = { theme: 'light', readSeconds: 6, ...(reader.mode ? { mode: reader.mode } : {}) }
        return json({ current: reader.hasBook ? book : null, books: [book], viewers: reader.viewers, task, settings })
      }
      case '/api/settings':
        if (body?.mode === 'text' || body?.mode === 'browser') reader.mode = body.mode
        return json({ settings: { theme: 'light', readSeconds: 6, mode: reader.mode } })
      case `/api/books/${book.id}/progress`: {
        if (Array.isArray(body?.read)) reader.readPages = [...new Set([...(reader.readPages ?? []), ...(body.read as number[])])]
        if (Array.isArray(body?.unread)) reader.readPages = (reader.readPages ?? []).filter(p => !(body.unread as number[]).includes(p))
        if (typeof body?.page === 'number') reader.book = { ...reader.book, page: body.page }
        return json({ ok: true, readCount: reader.readPages?.length ?? 0 })
      }
      case `/api/books/${book.id}/select`:
        return json({ book })
      case `/api/books/${book.id}`:
        return json({ ...book, read: reader.readPages ?? reader.read ?? [], outline: reader.outline ?? null })
      case '/api/books':
        return json({ book: { ...BOOK, path: body?.path } })
      case '/api/choose':
        // The server answers "still open" while the dialog is (each request within its
        // waitMs), naming the dialog; a request that names another one finds it gone.
        if (body?.id !== undefined && body.id !== 'dialog-1') return json({ gone: true })
        if (body?.id !== undefined && reader.chooseGone) return json({ gone: true })
        if ((reader.choosePending ?? 0) > 0) {
          reader.choosePending = (reader.choosePending ?? 0) - 1
          return json({ pending: true, id: 'dialog-1' })
        }
        return json(reader.choosesBook ? { book } : { cancelled: true })
      case '/api/show':
        if (reader.hasNoBrowser) return json({ shown: false, reason: 'no-browser', url: 'http://127.0.0.1:47321/' })
        reader.viewers = 1
        return json({ shown: true, launched: true })
      case '/api/task':
        if (body?.state === 'ack') task.acked = true
        else if (typeof body?.state === 'string') Object.assign(task, { state: body.state, acked: false })
        return json({ task, viewers: reader.viewers })
      case '/api/close':
        reader.viewers = 0
        return json({ closed: 1 })
      default: {
        const page = new RegExp(`^/api/books/${book.id}/page/(\\d+)$`).exec(url.pathname)
        if (page) {
          const n = Number(page[1])
          if (reader.failPages?.includes(n)) return { value: { status: 404, ok: false, headers: {}, text: JSON.stringify({ error: 'file missing' }) } }
          const given = reader.pages?.[n] ?? {}
          const answer = json({ page: n, pages: book.pages ?? BOOK.pages, blocks: [{ kind: 'para', runs: [{ text: `Page ${n} text.` }] }], scanned: false, ...given })
          if (reader.holdPages?.includes(n)) return new Promise<typeof answer>(resolve => held.set(n, () => resolve(answer)))
          return answer
        }
        return json({})
      }
    }
  })
  const posted = (path: string) => calls.filter(c => c.method === 'POST' && c.path === path)
  const daemon = () => runs.find(argv => argv.includes('--daemon'))
  return { calls, runs, clock, posted, daemon, root: () => pluginRoot, opens, panes, statuses, scrolls, release, state, logs, toasts }
}

export const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

export const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 6 },
  view: {},
}

export const PANE_PROPS = {
  title: 'Book Reader',
  isFocused: true,
  bodyColumns: 72,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

/** Draws the Reading Dock through the mod, `columns` wide. */
export function mountDock($: TestDollar, surface: 'terminal' | 'desktop' | 'mobile', columns = 72) {
  return $.ui.mount({
    plugin: 'book-reader',
    surface,
    component: 'Pane',
    requestId: 'book-dock',
    props: { ...PANE_PROPS, bodyColumns: columns },
  })
}
