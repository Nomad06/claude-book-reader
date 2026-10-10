import { describe, expect, test } from 'claude-code/testing'

import { BAND_PROPS, BOOK, RUN, mountDock, world } from './test-world.ts'
import type { Reader } from './test-world.ts'

const OTHER = 'b0b0b0b0b0b0'

describe('book-reader', () => {
  test('a long task opens the book after the delay and the end of the task offers to close it', async ($, on) => {
    const reader = { viewers: 0, hasBook: true }
    const { clock, posted } = world(on, reader)

    await $.turn.start({ text: 'refactor auth', turnId: 't1' })
    expect(posted('/api/show')).toHaveLength(0)

    await clock.advance(5_000)
    expect(posted('/api/show')).toHaveLength(1)
    // The auto-open never steals focus while Claude works.
    expect(posted('/api/show')[0]?.body?.raise).toBeUndefined()

    await $.turn.complete({ answer: 'All done.', durationMs: 90_000, isAborted: false, turnId: 't1', reason: 'answer' })
    const ended = posted('/api/task').at(-1)
    expect(ended?.body).toEqual({ state: 'done', returnTo: {}, durationMs: 90_000, summary: 'All done.', notify: true })

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

  test('/book in browser mode asks to raise the window; the auto-open does not', async ($, on) => {
    const reader: Reader = { viewers: 1, hasBook: true, mode: 'browser' }
    const { posted } = world(on, reader)
    await $.command.run({ ...RUN, command: 'book', args: '' })
    expect(posted('/api/show').at(-1)?.body).toMatchObject({ raise: true })
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

  test('an update from 0.1.1 to 0.2.0 replaces the 0.1.1 server, which has no text mode', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true, version: '0.1.1' }
    const { posted, daemon } = world(on, reader, { manifestVersion: '0.2.0' })

    await $.command.run({ ...RUN, command: 'book', args: 'list' })
    expect(posted('/api/shutdown')).toHaveLength(1)
    expect(daemon()).toBeDefined()
    expect(reader.version).toBe('0.2.0')
  })

  test('/book help, --help and -h print the help, in any case', async ($, on) => {
    const { posted } = world(on, { viewers: 0, hasBook: true })

    for (const args of ['help', 'HELP', '?', '--help', '--HELP', '-h', '-H', ' --help ']) {
      const answer = await $.command.run({ ...RUN, command: 'book', args })
      expect(answer.text).toContain('/book choose          pick a PDF with the system file dialog')
    }
    expect(posted('/api/books')).toHaveLength(0)
  })

  test('/book choose keeps waiting while the file dialog stays open past one request', async ($, on) => {
    // The engine gives one request 30 s; the server answers "still open" before that.
    const reader: Reader = { viewers: 0, hasBook: true, choosePending: 3, choosesBook: true }
    const { posted } = world(on, reader)

    const chosen = await $.command.run({ ...RUN, command: 'book', args: 'choose' })
    expect(chosen.text).toContain('Now reading “Dune”')
    const asks = posted('/api/choose')
    expect(asks).toHaveLength(4)
    for (const ask of asks) {
      expect(typeof ask.body?.waitMs).toBe('number')
      expect(ask.body?.waitMs as number).toBeLessThan(30_000)
    }
  })

  test('/book choose: a dialog cancelled after a while is no book', async ($, on) => {
    const { posted } = world(on, { viewers: 0, hasBook: true, choosePending: 2 })

    const chosen = await $.command.run({ ...RUN, command: 'book', args: 'choose' })
    expect(chosen.text).toBe('No book chosen.')
    expect(posted('/api/choose')).toHaveLength(3)
  })

  test('/book choose stops waiting once the dialog has had its ten minutes', async ($, on) => {
    const { posted } = world(on, { viewers: 0, hasBook: true, choosePending: 1_000 })

    const chosen = await $.command.run({ ...RUN, command: 'book', args: 'choose' })
    expect(chosen.text).toContain('the file dialog is still open')
    // Twenty-second waits: about ten minutes of them, then it stops.
    expect(posted('/api/choose').length).toBeLessThan(40)
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

  test('tells the reader which app to bring back: the macOS app of the session', async ($, on) => {
    const { clock, posted } = world(on, { viewers: 0, hasBook: true }, { env: { __CFBundleIdentifier: 'com.googlecode.iterm2' } })

    await $.turn.start({ text: 'refactor', turnId: 't7' })
    await clock.advance(5_000)
    expect(posted('/api/task').at(-1)?.body?.returnTo).toEqual({ bundleId: 'com.googlecode.iterm2' })
    await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: 't7', reason: 'answer' })
    expect(posted('/api/task').at(-1)?.body?.returnTo).toEqual({ bundleId: 'com.googlecode.iterm2' })
  })

  test('tells the reader which window to bring back: X11 and Windows', async ($, on) => {
    const { clock, posted, runs } = world(on, { viewers: 0, hasBook: true }, { os: 'windows', windowPid: '4242', env: { WINDOWID: '71303175' } })

    await $.turn.start({ text: 'build', turnId: 't8' })
    await clock.advance(5_000)
    expect(posted('/api/task').at(-1)?.body?.returnTo).toEqual({ windowId: '71303175', pid: 4242 })
    const search = runs.find(argv => argv[0] === 'powershell.exe')
    expect(search?.includes('-EncodedCommand')).toBe(true)
  })

  test('Close book on the band only closes the reader: Claude is already in front', async ($, on) => {
    const { posted } = world(on, { viewers: 1, hasBook: true })

    await $.turn.start({ text: 'build', turnId: 't9' })
    await $.turn.complete({ answer: 'Built.', durationMs: 40_000, isAborted: false, turnId: 't9', reason: 'answer' })
    const ui = await $.ui.mount({ plugin: 'book-reader', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    await ui.press({ key: 'close' })
    expect(posted('/api/close').at(-1)?.body).toEqual({ focus: false })
    await ui.unmount()
  })

  test('no book chosen: the task runs without opening anything', async ($, on) => {
    const { clock, posted } = world(on, { viewers: 0, hasBook: false })

    await $.turn.start({ text: 'long one', turnId: 't5' })
    await clock.advance(5_000)
    expect(posted('/api/show')).toHaveLength(0)
  })

  test('/book mode reports and sets the mode', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true }
    const { posted } = world(on, reader)
    const shown = await $.command.run({ ...RUN, command: 'book', args: 'mode' })
    expect(shown.text).toContain('Reading mode: browser')
    const set = await $.command.run({ ...RUN, command: 'book', args: 'mode text' })
    expect(set.text).toContain('text')
    expect(posted('/api/settings').at(-1)?.body).toEqual({ mode: 'text' })
    expect(reader.mode).toBe('text')
    const bad = await $.command.run({ ...RUN, command: 'book', args: 'mode pigeon' })
    expect(bad.text).toContain('Use /book mode text|browser')
    const status = await $.command.run({ ...RUN, command: 'book', args: 'status' })
    expect(status.text).toContain('Reading mode: text')
  })

  test('in text mode a long task opens the dock on the saved page, not the browser', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true, mode: 'text' }
    const { clock, posted, opens, state } = world(on, reader, { placesPanes: true })
    await $.turn.start({ text: 'refactor auth', turnId: 't1' })
    await clock.advance(5_000)
    expect(posted('/api/show')).toHaveLength(0)
    expect(opens).toEqual([{ id: 'book-dock', columns: 72 }])
    expect(posted(`/api/books/${BOOK.id}/progress`).at(-1)?.body).toEqual({ page: 42 })
    // The kit cannot resolve a mod's `$.ui.scroll` to a window: when the page landed stands in for it.
    expect(state('readerShownAt')).toBe(6_000)
    expect(state('readerPage')).toMatchObject({ bookId: BOOK.id, page: 42, pages: 300 })
  })

  test('/book mode text with no book, and with the server down', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: false, mode: 'text' }
    const { opens } = world(on, reader)
    const answer = await $.command.run({ ...RUN, command: 'book', args: 'mode text' })
    expect(answer.text).toContain('text')
    const open = await $.command.run({ ...RUN, command: 'book', args: 'open' })
    expect(open.text).toContain('No book chosen')
    expect(opens).toHaveLength(0)
    reader.isUp = false
    const down = await $.command.run({ ...RUN, command: 'book', args: 'mode' })
    expect(down.text).toContain('Reading mode: text')
  })

  test('/book open in text mode answers at once, then opens the dock on the saved page', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true, mode: 'text' }
    const { posted, opens, state } = world(on, reader)
    const open = await $.command.run({ ...RUN, command: 'book', args: 'open' })
    expect(open.text).toContain('Dune · p. 42/300')
    // The pane's work starts once the answer is out; wait (real time) for its page.
    for (let i = 0; i < 40 && state('readerPage') === undefined; i++) await new Promise(resolve => setTimeout(resolve, 25))
    expect(posted('/api/show')).toHaveLength(0)
    expect(opens).toEqual([{ id: 'book-dock', columns: 72 }])
    expect(state('dockView')).toBe('reader')
    expect(state('readerPage')).toMatchObject({ bookId: BOOK.id, page: 42 })
  })

  test('next, previous, go to and mark read reach the server, in text mode', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true, mode: 'text' }
    const { clock, posted, state } = world(on, reader, { placesPanes: true })
    await $.turn.start({ text: 'build', turnId: 't1' })
    await clock.advance(5_000)
    const ui = await mountDock($, 'terminal')
    await clock.advance(1_000)
    await ui.press({ key: 'reader-next' })
    expect(state('readerPage')?.page).toBe(43)
    expect(state('readerShownAt')).toBe(7_000)
    expect(posted(`/api/books/${BOOK.id}/progress`).at(-1)?.body).toEqual({ page: 43 })
    await ui.press({ key: 'reader-prev' })
    expect(state('readerPage')?.page).toBe(42)
    await $.ui.input({ plugin: 'book-reader', key: 'reader-goto', text: '7' })
    expect(state('readerPage')?.page).toBe(7)
    await $.ui.input({ plugin: 'book-reader', key: 'reader-goto', text: '999' })
    expect(state('readerPage')?.page).toBe(7)
    expect(state('readerNote')).toContain('No page 999')
    await ui.press({ key: 'reader-mark' })
    expect(posted(`/api/books/${BOOK.id}/progress`).at(-1)?.body).toEqual({ read: [7] })
    await ui.press({ key: 'reader-mark' })
    expect(posted(`/api/books/${BOOK.id}/progress`).at(-1)?.body).toEqual({ unread: [7] })
    await ui.unmount()
  })

  test('a late answer for an earlier page is dropped', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true, mode: 'text', holdPages: [43] }
    const { clock, release, state } = world(on, reader, { placesPanes: true })
    await $.turn.start({ text: 'build', turnId: 't1' })
    await clock.advance(5_000)
    const ui = await mountDock($, 'terminal')
    const slow = ui.press({ key: 'reader-next' }) // page 43: the world holds its answer
    await $.ui.input({ plugin: 'book-reader', key: 'reader-goto', text: '10' }) // page 10 answers at once
    expect(state('readerPage')?.page).toBe(10)
    release(43)
    await slow
    expect(state('readerPage')?.page).toBe(10)
    await ui.unmount()
  })

  test('o in the reader opens the browser at the current page even in text mode', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true, mode: 'text' }
    const { clock, posted } = world(on, reader, { placesPanes: true })
    await $.turn.start({ text: 'build', turnId: 't1' })
    await clock.advance(5_000)
    const ui = await mountDock($, 'terminal')
    await ui.press({ key: 'reader-open' })
    expect(posted('/api/show').at(-1)?.body).toEqual({ window: 'app', page: 42, raise: true })
    await ui.unmount()
  })

  test('graphics is detected from the environment once per session', async ($, on) => {
    const { state } = world(on, { viewers: 0, hasBook: true }, { env: { TERM_PROGRAM: 'ghostty' } })
    await $.session.start({ cwd: '/home/me/project' })
    expect(state('graphics')).toBe(true)
  })

  test('a node too old to start the server: /book says so and /book status repeats it', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true, isUp: false }
    world(on, reader, { daemonFails: 'book-reader needs Node 22.13 or newer; found v20.11.1' })
    const listed = await $.command.run({ ...RUN, command: 'book', args: 'list' })
    expect(listed.text).toContain('book-reader needs Node 22.13 or newer; found v20.11.1')
    const status = await $.command.run({ ...RUN, command: 'book', args: 'status' })
    expect(status.text).toContain('book-reader needs Node 22.13 or newer; found v20.11.1')
  })

  test('a page left from another book does not move this book: /book open browser', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true, mode: 'text' }
    const { clock, posted, state } = world(on, reader, { placesPanes: true })
    await $.turn.start({ text: 'build', turnId: 't1' })
    await clock.advance(5_000)
    expect(state('readerPage')).toMatchObject({ bookId: BOOK.id, page: 42 })
    await $.command.run({ ...RUN, command: 'book', args: 'mode browser' })
    reader.book = { id: OTHER, title: 'Emma', page: 9, pages: 50 }
    const opened = await $.command.run({ ...RUN, command: 'book', args: 'open browser' })
    expect(opened.text).toContain('Emma')
    expect(posted('/api/show').at(-1)?.body).toEqual({ window: 'app', raise: true })
  })

  test('a page left from another book: m, o, go to and n start from this book', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true, mode: 'text', failPages: [9] }
    const { clock, posted, state } = world(on, reader, { placesPanes: true })
    await $.turn.start({ text: 'build', turnId: 't1' })
    await clock.advance(5_000)
    const ui = await mountDock($, 'terminal')
    reader.book = { id: OTHER, title: 'Emma', page: 9, pages: 50 }
    await $.command.run({ ...RUN, command: 'book', args: '1' })
    // The pane's work starts once the answer is out; wait (real time) for its failed page.
    for (let i = 0; i < 40 && !String(state('readerNote')).includes('Could not load page 9'); i++) await new Promise(resolve => setTimeout(resolve, 25))
    expect(state('readerNote')).toContain('Could not load page 9')
    expect(state('readerPage')?.bookId).toBe(BOOK.id)
    await ui.press({ key: 'reader-mark' })
    expect(posted(`/api/books/${OTHER}/progress`)).toHaveLength(0)
    await ui.press({ key: 'reader-open' })
    expect(posted('/api/show').at(-1)?.body).toEqual({ window: 'app', raise: true })
    await $.ui.input({ plugin: 'book-reader', key: 'reader-goto', text: '60' })
    expect(state('readerNote')).toContain('No page 60; the book has 50')
    await ui.press({ key: 'reader-next' })
    expect(posted(`/api/books/${OTHER}/progress`).at(-1)?.body).toEqual({ page: 10 })
    expect(state('readerPage')).toMatchObject({ bookId: OTHER, page: 10 })
    await ui.unmount()
  })

  test('an older answer that lands while a newer page is written is dropped', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true, mode: 'text' }
    // Holds the write of page 43 until the newer page 10 is in.
    let openGate = () => {}
    const gate = new Promise<void>(resolve => (openGate = resolve))
    let isGated = false
    on('state.set', { key: 'readerPage' }, async ($, e, next) => {
      if (!isGated && e.key === 'readerPage' && (e.value as { page?: number } | null)?.page === 43) {
        isGated = true
        await gate
      }
      return next(e)
    })
    const { clock, posted, state } = world(on, reader, { placesPanes: true })
    await $.turn.start({ text: 'build', turnId: 't1' })
    await clock.advance(5_000)
    const ui = await mountDock($, 'terminal')
    const slow = ui.press({ key: 'reader-next' })
    for (let i = 0; i < 40 && !isGated; i++) await new Promise(resolve => setTimeout(resolve, 10))
    expect(isGated).toBe(true)
    await $.ui.input({ plugin: 'book-reader', key: 'reader-goto', text: '10' })
    expect(state('readerPage')?.page).toBe(10)
    openGate()
    await slow
    expect(state('readerPage')?.page).toBe(10)
    expect(posted(`/api/books/${BOOK.id}/progress`).at(-1)?.body).toEqual({ page: 10 })
    expect(reader.book?.page).toBe(10)
    await ui.unmount()
  })

  test('graphics detection that fails reads as no graphics, and the session still starts', async ($, on) => {
    on('env.get', { name: 'TERM_PROGRAM' }, () => ({ deny: 'not in this test' }))
    const { state } = world(on, { viewers: 0, hasBook: true }, { env: { TERM: 'xterm-kitty' } })
    const started = await $.session.start({ cwd: '/home/me/project' })
    expect(started).toEqual({ cwd: '/home/me/project' })
    expect(state('graphics')).toBe(false)
  })
})
