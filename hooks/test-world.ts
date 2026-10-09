import { mock } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On, UiScrollArgs } from 'claude-code'

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
}

const ok = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// A stand-in for the machine and for server/server.mjs: answers the module's
// process, file and HTTP calls, and records them.
export function world(on: On, reader: Reader, hostOptions: Host = {}) {
  const host = { os: 'unix', cwd: '/home/me/project', files: [], ...hostOptions }
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
  const baseEnv = host.os === 'windows' ? { OS: 'Windows_NT', ProgramFiles: 'C:\\Program Files' } : {}
  mock.env(on, { ...baseEnv, ...host.env })
  on('fs.read', ($, e) => {
    // On Windows the engine hands the path over with backslashes.
    if (!e.path.replaceAll('\\', '/').endsWith(MANIFEST)) return { deny: 'not in this test' }
    pluginRoot = e.path.slice(0, -MANIFEST.length)
    return { value: JSON.stringify({ version: '1.2.3' }) }
  })
  // The test runs on this machine, whose engine resolves a Windows path against its own cwd.
  on('fs.exists', ($, e) => ({ value: host.files.some(file => e.path === file || e.path.endsWith(`/${file}`)) }))
  on('session.cwd', () => ({ value: host.cwd }))
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000 })
  on('ui.toast', () => ({ value: undefined }))
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
    // The test engine raises the event with the arguments of `$.ui.scroll` as given
    // (`to`, `in`, `block`); it resolves no window, so `requestId` and `offset` are absent.
    scrolls.push({ ...(e as unknown as UiScrollArgs) })
    return {}
  })
  on('ui.close', ($, e) => {
    const at = panes.findIndex(pane => pane.id === e.id)
    if (at >= 0) panes.splice(at, 1)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
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
      const launchedFrom = e.argv[e.argv.indexOf('--launched-from') + 1]
      Object.assign(reader, { isUp: true, version: '1.2.3', launchedFrom })
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
    switch (url.pathname) {
      case '/api/health':
        return json({ app: 'book-reader', version: reader.version ?? '1.2.3', launchedFrom: reader.launchedFrom ?? pluginRoot })
      case '/api/shutdown':
        reader.isUp = false
        return json({ ok: true })
      case '/api/state': {
        const current = { ...BOOK, ...reader.book }
        const settings = { theme: 'light', readSeconds: 6, ...(reader.mode ? { mode: reader.mode } : {}) }
        return json({ current: reader.hasBook ? current : null, books: [current], viewers: reader.viewers, task, settings })
      }
      case '/api/settings':
        if (body?.mode === 'text' || body?.mode === 'browser') reader.mode = body.mode
        return json({ settings: { theme: 'light', readSeconds: 6, mode: reader.mode } })
      case `/api/books/${BOOK.id}/progress`: {
        if (Array.isArray(body?.read)) reader.readPages = [...new Set([...(reader.readPages ?? []), ...(body.read as number[])])]
        if (Array.isArray(body?.unread)) reader.readPages = (reader.readPages ?? []).filter(p => !(body.unread as number[]).includes(p))
        if (typeof body?.page === 'number') reader.book = { ...reader.book, page: body.page }
        return json({ ok: true, readCount: reader.readPages?.length ?? 0 })
      }
      case `/api/books/${BOOK.id}/select`:
        return json({ book: { ...BOOK, ...reader.book } })
      case `/api/books/${BOOK.id}`:
        return json({ ...BOOK, ...reader.book, read: reader.readPages ?? reader.read ?? [], outline: reader.outline ?? null })
      case '/api/books':
        return json({ book: { ...BOOK, path: body?.path } })
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
        const page = new RegExp(`^/api/books/${BOOK.id}/page/(\\d+)$`).exec(url.pathname)
        if (page) {
          const n = Number(page[1])
          const given = reader.pages?.[n] ?? {}
          const answer = json({ page: n, pages: BOOK.pages, blocks: [{ kind: 'para', runs: [{ text: `Page ${n} text.` }] }], scanned: false, ...given })
          if (reader.holdPages?.includes(n)) return new Promise<typeof answer>(resolve => held.set(n, () => resolve(answer)))
          return answer
        }
        return json({})
      }
    }
  })
  const posted = (path: string) => calls.filter(c => c.method === 'POST' && c.path === path)
  const daemon = () => runs.find(argv => argv.includes('--daemon'))
  return { calls, runs, clock, posted, daemon, root: () => pluginRoot, opens, panes, statuses, scrolls, release }
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
export function mountDock($: TestDollar, surface: 'terminal' | 'desktop', columns = 72) {
  return $.ui.mount({
    plugin: 'book-reader',
    surface,
    component: 'Pane',
    requestId: 'book-dock',
    props: { ...PANE_PROPS, bodyColumns: columns },
  })
}
