import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

type Call = { method: string; path: string; body: Record<string, unknown> | undefined }

const BOOK = { id: 'abc123abc123', path: '/books/dune.pdf', title: 'Dune', page: 42, pages: 300, readCount: 37, openedAt: 1 }

const MANIFEST = '/.claude-plugin/plugin.json'

type Reader = {
  viewers: number
  hasBook: boolean
  isUp?: boolean
  version?: string
  launchedFrom?: string
  /** Linux with no xdg-open and no Chromium browser. */
  hasNoBrowser?: boolean
}

type Host = {
  /** The OS the session runs on, as the mod tells it: Windows sets OS=Windows_NT. */
  os?: 'unix' | 'windows'
  cwd?: string
  /** What `where.exe node` prints on Windows; absent, it finds nothing. */
  whereNode?: string
  /** Files that exist, for the mod's fallback search on Windows. */
  files?: string[]
}

const ok = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// A stand-in for the machine and for server/server.mjs: answers the module's
// process, file and HTTP calls, and records them.
function world(on: On, reader: Reader, hostOptions: Host = {}) {
  const host = { os: 'unix', cwd: '/home/me/project', files: [], ...hostOptions }
  const calls: Call[] = []
  const runs: string[][] = []
  const task = { state: 'idle', seq: 0, acked: true }
  let pluginRoot = ''
  mock.env(on, host.os === 'windows' ? { OS: 'Windows_NT', ProgramFiles: 'C:\\Program Files' } : {})
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
  on('ui.status', () => ({ value: undefined }))
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
      case '/api/state':
        return json({ current: reader.hasBook ? BOOK : null, books: [BOOK], viewers: reader.viewers, task })
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
      default:
        return json({})
    }
  })
  const posted = (path: string) => calls.filter(c => c.method === 'POST' && c.path === path)
  const daemon = () => runs.find(argv => argv.includes('--daemon'))
  return { calls, runs, clock, posted, daemon, root: () => pluginRoot }
}

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 6 },
  view: {},
}

describe('book-reader', () => {
  test('a long task opens the book after the delay and the end of the task offers to close it', async ($, on) => {
    const reader = { viewers: 0, hasBook: true }
    const { clock, posted } = world(on, reader)

    await $.turn.start({ text: 'refactor auth', turnId: 't1' })
    expect(posted('/api/show')).toHaveLength(0)

    await clock.advance(5_000)
    expect(posted('/api/show')).toHaveLength(1)

    await $.turn.complete({ answer: 'All done.', durationMs: 90_000, isAborted: false, turnId: 't1', reason: 'answer' })
    const ended = posted('/api/task').at(-1)
    expect(ended?.body).toEqual({ state: 'done', durationMs: 90_000, summary: 'All done.', notify: true })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'book-reader', surface, component: 'AbovePrompt', props: BAND_PROPS })
      expect(await ui.find({ type: 'Text', text: /Task finished/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Dune/ })).toBeDefined()
      await ui.unmount()
    }

    const ui = await $.ui.mount({ plugin: 'book-reader', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    await ui.press({ key: 'keep' })
    expect(posted('/api/task').at(-1)?.body).toEqual({ state: 'ack' })
    expect(await ui.find({ type: 'Text', text: /Task finished/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a short task never opens the book', async ($, on) => {
    const { clock, posted } = world(on, { viewers: 0, hasBook: true })

    await $.turn.start({ text: 'hi', turnId: 't2' })
    await clock.advance(2_000)
    await $.turn.complete({ answer: 'Hello!', durationMs: 2_000, isAborted: false, turnId: 't2', reason: 'answer' })
    await clock.advance(10_000)

    expect(posted('/api/show')).toHaveLength(0)
    const ended = posted('/api/task').at(-1)
    expect(ended?.body?.notify).toBe(false)
  })

  test('Close book on the band closes the reader window', async ($, on) => {
    const reader = { viewers: 1, hasBook: true }
    const { posted } = world(on, reader)

    await $.turn.start({ text: 'build', turnId: 't3' })
    await $.turn.complete({ answer: 'Built.', durationMs: 40_000, isAborted: false, turnId: 't3', reason: 'answer' })

    const ui = await $.ui.mount({ plugin: 'book-reader', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    await ui.press({ key: 'close' })
    expect(posted('/api/close')).toHaveLength(1)
    expect(reader.viewers).toBe(0)
    await ui.unmount()
  })

  test('/book list and /book auto off', async ($, on) => {
    const { clock, posted } = world(on, { viewers: 0, hasBook: true })

    const listed = await $.command.run({ ...RUN, command: 'book', args: 'list' })
    expect(listed.text).toContain('1. Dune · p. 42/300 · 12% read  ← current')

    const off = await $.command.run({ ...RUN, command: 'book', args: 'auto off' })
    expect(off.text).toContain('Auto-open off')

    await $.turn.start({ text: 'long one', turnId: 't4' })
    await clock.advance(60_000)
    expect(posted('/api/show')).toHaveLength(0)
  })

  test('a reader server left over from another version is replaced', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true, version: '0.0.9' }
    const { runs, posted } = world(on, reader)

    const listed = await $.command.run({ ...RUN, command: 'book', args: 'list' })
    expect(listed.text).toContain('Dune')
    expect(posted('/api/shutdown')).toHaveLength(1)
    expect(runs.some(argv => argv.includes('--daemon'))).toBe(true)
    expect(reader.version).toBe('1.2.3')
  })

  test('a reader server of this version is reused', async ($, on) => {
    const { runs, posted } = world(on, { viewers: 0, hasBook: true })

    await $.command.run({ ...RUN, command: 'book', args: 'list' })
    expect(posted('/api/shutdown')).toHaveLength(0)
    expect(runs).toHaveLength(0)
  })

  test('a server from another install of the same version is shared, not restarted', async ($, on) => {
    const { posted, runs } = world(on, { viewers: 1, hasBook: true, launchedFrom: '/elsewhere/book-reader' })

    await $.command.run({ ...RUN, command: 'book', args: 'list' })
    expect(posted('/api/shutdown')).toHaveLength(0)
    expect(runs).toHaveLength(0)
  })

  test('a newer server is kept for an older install', async ($, on) => {
    const { posted } = world(on, { viewers: 1, hasBook: true, version: '1.10.0' })

    await $.command.run({ ...RUN, command: 'book', args: 'list' })
    expect(posted('/api/shutdown')).toHaveLength(0)
  })

  test('a server that reports no version is replaced', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true, version: '' }
    const { posted } = world(on, reader)

    await $.command.run({ ...RUN, command: 'book', args: 'list' })
    expect(posted('/api/shutdown')).toHaveLength(1)
  })

  test('the server is started with node and told which install started it', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true, isUp: false }
    const { daemon, root } = world(on, reader)

    await $.command.run({ ...RUN, command: 'book', args: 'list' })
    const argv = daemon()
    expect(argv?.[0]).toBe('/usr/local/bin/node')
    expect(argv?.[1]).toBe(`${root()}/server/server.mjs`)
    expect(argv?.slice(-2)).toEqual(['--launched-from', root()])
  })

  test('paths on macOS and Linux: relative to the project, ~, escaped spaces, file URLs', async ($, on) => {
    const { posted } = world(on, { viewers: 0, hasBook: true })
    const add = async (args: string) => {
      await $.command.run({ ...RUN, command: 'book', args })
      return posted('/api/books').at(-1)?.body?.path
    }

    expect(await add('books/dune.pdf')).toBe('/home/me/project/books/dune.pdf')
    expect(await add('./dune.pdf')).toBe('/home/me/project/dune.pdf')
    expect(await add('My\\ Book.pdf')).toBe('/home/me/project/My Book.pdf')
    expect(await add('"/srv/books/My Book.pdf"')).toBe('/srv/books/My Book.pdf')
    expect(await add('~/books/dune.pdf')).toBe('~/books/dune.pdf')
    expect(await add('file:///srv/books/My%20Book.pdf')).toBe('/srv/books/My Book.pdf')
  })

  test('paths on Windows: drive letters, UNC shares, backslashes, file URLs', async ($, on) => {
    const { posted } = world(on, { viewers: 0, hasBook: true }, { os: 'windows', cwd: 'C:\\Users\\me\\project' })
    const add = async (args: string) => {
      await $.command.run({ ...RUN, command: 'book', args })
      return posted('/api/books').at(-1)?.body?.path
    }

    expect(await add('C:\\Books\\dune.pdf')).toBe('C:\\Books\\dune.pdf')
    expect(await add('D:/Books/dune.pdf')).toBe('D:/Books/dune.pdf')
    expect(await add('\\\\nas\\books\\dune.pdf')).toBe('\\\\nas\\books\\dune.pdf')
    expect(await add('books\\dune.pdf')).toBe('C:\\Users\\me\\project\\books\\dune.pdf')
    expect(await add('.\\dune.pdf')).toBe('C:\\Users\\me\\project\\dune.pdf')
    expect(await add('"C:\\My Books\\dune.pdf"')).toBe('C:\\My Books\\dune.pdf')
    expect(await add('file:///C:/My%20Books/dune.pdf')).toBe('C:/My Books/dune.pdf')
  })

  test('on Windows node is found with where.exe', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true, isUp: false }
    const { daemon, runs } = world(on, reader, {
      os: 'windows',
      whereNode: 'C:\\Users\\me\\AppData\\Roaming\\npm\\node.cmd\r\nC:\\Program Files\\nodejs\\node.exe\r\n',
    })

    await $.command.run({ ...RUN, command: 'book', args: 'list' })
    expect(runs.some(argv => argv[0] === '/bin/sh')).toBe(false)
    expect(daemon()?.[0]).toBe('C:\\Program Files\\nodejs\\node.exe')
  })

  test('on Windows without node on PATH, the usual install folder is tried', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true, isUp: false }
    const { daemon } = world(on, reader, { os: 'windows', files: ['C:\\Program Files\\nodejs\\node.exe'] })

    await $.command.run({ ...RUN, command: 'book', args: 'list' })
    expect(daemon()?.[0]).toBe('C:\\Program Files\\nodejs\\node.exe')
  })

  test('no node anywhere: /book says how to fix it', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true, isUp: false }
    world(on, reader, { os: 'windows' })

    const listed = await $.command.run({ ...RUN, command: 'book', args: 'list' })
    expect(listed.text).toContain('node was not found')
  })

  test('no browser to open: /book gives the address to open by hand', async ($, on) => {
    world(on, { viewers: 0, hasBook: true, hasNoBrowser: true })

    const opened = await $.command.run({ ...RUN, command: 'book', args: '' })
    expect(opened.text).toContain('open http://127.0.0.1:47321/ yourself')
  })

  test('no book chosen: the task runs without opening anything', async ($, on) => {
    const { clock, posted } = world(on, { viewers: 0, hasBook: false })

    await $.turn.start({ text: 'long one', turnId: 't5' })
    await clock.advance(5_000)
    expect(posted('/api/show')).toHaveLength(0)
  })
})
