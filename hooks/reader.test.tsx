import { describe, expect, test } from 'claude-code/testing'

import type { Block, ReaderPage } from '../types'
import { BAND_PROPS, BOOK, mountDock, RUN, world } from './test-world.ts'
import type { Reader } from './test-world.ts'

const OTHER = 'b0b0b0b0b0b0'

const PAGE: { blocks: Block[] } = {
  blocks: [
    { kind: 'heading', level: 1, runs: [{ text: 'Cost and Latency', bold: true }] },
    { kind: 'para', runs: [{ text: 'A model that is ' }, { text: 'slow', italic: true }, { text: ' and ' }, { text: 'costly', bold: true }, { text: ' calls ' }, { text: 'run()', mono: true }] },
    { kind: 'code', text: 'def f(x):\n    return x' },
    { kind: 'list', runs: [{ text: '• First item' }] },
    { kind: 'caption', runs: [{ text: 'Figure 4-3. The thing.' }] },
    { kind: 'image', file: '/data/pages/abc-42-0.rgb', width: 1318, height: 556, alt: 'Figure 4-3. The thing.' },
  ],
}

describe('reader view', () => {
  test('draws the page: heading, styled runs, code, list, caption, picture line', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true, mode: 'text', pages: { 42: PAGE } }
    const { clock } = world(on, reader, { placesPanes: true })
    await $.turn.start({ text: 'build', turnId: 't1' })
    await clock.advance(5_000)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await mountDock($, surface)
      expect(await ui.find({ type: 'Text', text: /C O S T {3}A N D {3}L A T E N C Y/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /p\. 42 \/ 300/ })).toBeDefined()
      expect((await ui.find({ type: 'Text', text: /^slow$/ }))?.props.italic).toBe(true)
      expect((await ui.find({ type: 'Text', text: /^costly$/ }))?.props.bold).toBe(true)
      expect(await ui.find({ type: 'Text', text: /run\(\)/ })).toBeDefined()
      expect((await ui.find({ type: 'Code' }))?.props.source).toBe('def f(x):\n    return x')
      expect(await ui.find({ type: 'Text', text: /• First item/ })).toBeDefined()
      expect((await ui.find({ type: 'Text', text: /^Figure 4-3\. The thing\.$/ }))?.props).toMatchObject({ italic: true, dimColor: true })
      expect(await ui.find({ type: 'Text', text: /▣ Figure 4-3\. The thing\. · 1318×556 · o opens in browser/ })).toBeDefined()
      expect(await ui.find({ type: 'Image' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('on a graphics terminal the picture is an Image sized to the pane', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true, mode: 'text', pages: { 42: PAGE } }
    const { clock } = world(on, reader, { placesPanes: true, env: { TERM_PROGRAM: 'ghostty' } })
    await $.session.start({ cwd: '/home/me/project', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'build', turnId: 't1' })
    await clock.advance(5_000)
    const ui = await mountDock($, 'terminal')
    const image = await ui.find({ type: 'Image' })
    expect(image).toBeDefined()
    expect(image?.props).toMatchObject({ columns: 60, rows: 12, alt: 'Figure 4-3. The thing.', source: { file: '/data/pages/abc-42-0.rgb', format: 'rgb', width: 1318, height: 556 } })
    expect(await ui.find({ type: 'Text', text: /▣ Figure/ })).toBeUndefined()
    await ui.unmount()
    const desktop = await mountDock($, 'desktop')
    expect(await desktop.find({ type: 'Image' })).toBeUndefined()
    expect(await desktop.find({ type: 'Text', text: /▣ Figure 4-3/ })).toBeDefined()
    await desktop.unmount()
  })

  test('a scanned page says so without graphics', async ($, on) => {
    const scanned: Partial<Pick<ReaderPage, 'blocks' | 'scanned'>> = {
      scanned: true,
      blocks: [{ kind: 'image', file: '/data/pages/abc-42-0.rgb', width: 800, height: 1100, alt: 'Image 800×1100' }],
    }
    const reader: Reader = { viewers: 0, hasBook: true, mode: 'text', pages: { 42: scanned } }
    const { clock } = world(on, reader, { placesPanes: true })
    await $.turn.start({ text: 'build', turnId: 't1' })
    await clock.advance(5_000)
    const ui = await mountDock($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /No text on this page · o opens in browser/ })).toBeDefined()
    await ui.unmount()
  })

  test('the note shows while loading and after an error; empty page without blocks', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true, mode: 'text', pages: { 42: { blocks: [], error: 'boom' } }, holdPages: [43] }
    const { clock, release } = world(on, reader, { placesPanes: true })
    await $.turn.start({ text: 'build', turnId: 't1' })
    await clock.advance(5_000)
    const ui = await mountDock($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /boom/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Nothing to show on this page/ })).toBeDefined()
    const turning = ui.press({ key: 'reader-next' }) // page 43: the world holds its answer
    expect(await ui.find({ type: 'Text', text: /^Loading page 43…$/ })).toBeDefined()
    release(43)
    await turning
    expect(await ui.find({ type: 'Text', text: /Loading page/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^Page 43 text\.$/ })).toBeDefined()
    await ui.unmount()
  })

  test('a page left from another book is not drawn under this book', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true, mode: 'text', failPages: [9] }
    const { clock, state } = world(on, reader, { placesPanes: true })
    await $.turn.start({ text: 'build', turnId: 't1' })
    await clock.advance(5_000)
    const ui = await mountDock($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /^Page 42 text\.$/ })).toBeDefined()
    reader.book = { id: OTHER, title: 'Emma', page: 9, pages: 50 }
    await clock.advance(2_000) // the dock's poll: the library lists Emma
    await ui.press({ key: 'reader-library' })
    await ui.press({ key: `book-${OTHER}` })
    expect(state('readerPage')?.bookId).toBe(BOOK.id)
    expect(await ui.find({ type: 'Text', text: /^Page 42 text\.$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Could not load page 9/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Emma/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /p\. 9 \/ 50/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'reader-next' })).toBeDefined()
    await ui.unmount()
  })

  test('footer keys and the way back to the dashboard and library', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true, mode: 'text', pages: { 42: PAGE } }
    const { calls, clock } = world(on, reader, { placesPanes: true })
    await $.turn.start({ text: 'build', turnId: 't1' })
    await clock.advance(5_000)
    const ui = await mountDock($, 'terminal')
    for (const [key, hotkey] of [['reader-prev', 'p'], ['reader-next', 'n'], ['reader-go', 'g'], ['reader-mark', 'm'], ['reader-open', 'o'], ['reader-dash', 'd'], ['reader-library', 'l']] as const) {
      expect((await ui.find({ type: 'Button', key }))?.props.hotkey).toBe(hotkey)
    }
    expect(await ui.find({ type: 'Input', key: 'reader-goto' })).toBeDefined()
    await ui.press({ key: 'reader-dash' })
    expect(await ui.find({ type: 'Text', text: /Contents|No table of contents|Contents appear/ })).toBeDefined()
    expect((await ui.find({ type: 'Button', key: 'reader-read' }))?.props.hotkey).toBe('r')
    const fetches = () => calls.filter(c => c.path === `/api/books/${BOOK.id}/page/42`).length
    const before = fetches()
    await ui.press({ key: 'reader-read' })
    expect(fetches()).toBe(before + 1)
    expect(await ui.find({ type: 'Text', text: /C O S T {3}A N D {3}L A T E N C Y/ })).toBeDefined()
    await ui.press({ key: 'reader-library' })
    expect(await ui.find({ type: 'Text', text: /L I B R A R Y/ })).toBeDefined()
    await ui.unmount()
  })

  // The kit has no implementation for the mod's `$.ui.focus`: it rejects "no
  // implementation for ui.focus" before any hook runs (a test's own `ui.focus`
  // hook never sees it), so where the ring lands cannot be seen here. The test
  // holds that g asks for the move, and that a refused move stays a debug line.
  test('g asks for the focus on the go-to field', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true, mode: 'text' }
    const { clock, logs } = world(on, reader, { placesPanes: true })
    await $.turn.start({ text: 'build', turnId: 't1' })
    await clock.advance(5_000)
    const ui = await mountDock($, 'terminal')
    const goTo = () => logs.filter(line => line.includes('go to'))
    expect(goTo()).toEqual([])
    expect(await ui.press({ key: 'reader-go' })).toEqual({ element: 'reader-go' })
    expect(goTo()).toEqual(['book-reader: go to: no implementation for ui.focus'])
    expect(await ui.find({ type: 'Input', key: 'reader-goto' })).toBeDefined()
    await ui.unmount()
  })

  test('the dashboard offers r read here only in text mode', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true }
    const { clock } = world(on, reader, { placesPanes: true })
    await $.turn.start({ text: 'build', turnId: 't1' })
    await clock.advance(5_000)
    const ui = await mountDock($, 'terminal')
    expect(await ui.find({ type: 'Button', key: 'dock-open' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'reader-read' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'reader-next' })).toBeUndefined()
    expect(await ui.find({ type: 'Input', key: 'reader-goto' })).toBeUndefined()
    await ui.unmount()
  })

  test('too narrow to read', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true, mode: 'text', pages: { 42: PAGE } }
    const { clock } = world(on, reader, { placesPanes: true })
    await $.turn.start({ text: 'build', turnId: 't1' })
    await clock.advance(5_000)
    const ui = await mountDock($, 'terminal', 36)
    expect(await ui.find({ type: 'Text', text: /Widen the terminal to read here · o opens in browser/ })).toBeDefined()
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('reading through a task', () => {
  test('a page on screen for readSeconds is marked read; a turned page restarts the clock', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true, mode: 'text' }
    const { clock, posted } = world(on, reader, { placesPanes: true })
    await $.turn.start({ text: 'build', turnId: 't1' })
    await clock.advance(5_000)
    const progress = () => posted(`/api/books/${BOOK.id}/progress`).map(c => c.body)
    await clock.advance(4_000)
    expect(progress()).not.toContainEqual({ read: [42] })
    await clock.advance(2_000)
    expect(progress()).toContainEqual({ read: [42] })
    const ui = await mountDock($, 'terminal')
    await ui.press({ key: 'reader-next' })
    await clock.advance(4_000)
    expect(progress()).not.toContainEqual({ read: [43] })
    await clock.advance(2_000)
    expect(progress()).toContainEqual({ read: [43] })
    expect(progress().filter(b => JSON.stringify(b) === '{"read":[43]}')).toHaveLength(1)
    await ui.unmount()
  })

  // Review Focus: the dock is placed, but another pane is the one in front.
  test('nothing is marked read while the pane is not shown', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true, mode: 'text' }
    const { clock, posted, state } = world(on, reader, { placesPanes: true, shownPane: false })
    await $.turn.start({ text: 'build', turnId: 't1' })
    await clock.advance(5_000)
    await clock.advance(20_000)
    expect(posted(`/api/books/${BOOK.id}/progress`).map(c => c.body)).not.toContainEqual({ read: [42] })
    expect(state('readerShownAt')).toBeNull()
  })

  // Review Focus: the pane is in front, but on the library tab.
  test('nothing is marked read while the library is in front', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true, mode: 'text' }
    const { clock, posted, state } = world(on, reader, { placesPanes: true })
    await $.turn.start({ text: 'build', turnId: 't1' })
    await clock.advance(5_000)
    const ui = await mountDock($, 'terminal')
    await ui.press({ key: 'reader-library' })
    expect(state('readerShownAt')).toBeNull()
    await clock.advance(20_000)
    expect(posted(`/api/books/${BOOK.id}/progress`).map(c => c.body)).not.toContainEqual({ read: [42] })
    expect(state('readerShownAt')).toBeNull()
    await ui.unmount()
  })

  test('the task ends inside the reader: done box, no notification, c returns to the dashboard', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true, mode: 'text' }
    const { clock, posted, state } = world(on, reader, { placesPanes: true })
    await $.turn.start({ text: 'build', turnId: 't1' })
    await clock.advance(5_000)
    await $.turn.complete({ answer: 'ok', durationMs: 9_000, isAborted: false, turnId: 't1', reason: 'answer' })
    expect(posted('/api/task').at(-1)?.body).toMatchObject({ state: 'done', notify: false })
    expect(posted('/api/close')).toHaveLength(0)
    const ui = await mountDock($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /Task finished in 9s/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Page 42 text\./ })).toBeDefined()
    await ui.press({ key: 'dock-close' })
    expect(posted('/api/close')).toHaveLength(0)
    // A browser opened later must not ask again.
    expect(posted('/api/task').at(-1)?.body).toEqual({ state: 'ack' })
    expect(state('dockView')).toBe('main')
    expect(state('readerShownAt')).toBeNull()
    expect(await ui.find({ type: 'Text', text: /Task finished/ })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'reader-read' })).toBeDefined()
    await ui.unmount()
  })

  test('k keeps reading on the same page', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true, mode: 'text' }
    const { clock, posted, state } = world(on, reader, { placesPanes: true })
    await $.turn.start({ text: 'build', turnId: 't1' })
    await clock.advance(5_000)
    await $.turn.complete({ answer: 'ok', durationMs: 9_000, isAborted: false, turnId: 't1', reason: 'answer' })
    const ui = await mountDock($, 'terminal')
    await ui.press({ key: 'dock-keep' })
    expect(posted('/api/task').at(-1)?.body).toEqual({ state: 'ack' })
    expect(posted('/api/close')).toHaveLength(0)
    expect(state('dockView')).toBe('reader')
    expect(await ui.find({ type: 'Text', text: /Task finished/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Page 42 text\./ })).toBeDefined()
    await ui.unmount()
  })

  test('with the reader not shown when the task ends, there is no done box and no band', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true, mode: 'text' }
    const { clock, posted, state } = world(on, reader, { placesPanes: false })
    await $.turn.start({ text: 'build', turnId: 't1' })
    await clock.advance(5_000)
    await $.turn.complete({ answer: 'ok', durationMs: 9_000, isAborted: false, turnId: 't1', reason: 'answer' })
    expect(posted('/api/task').at(-1)?.body).toMatchObject({ state: 'done', notify: false })
    expect(state('dockTask')).toBeNull()
    const band = await $.ui.mount({ plugin: 'book-reader', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await band.find({ type: 'Text', text: /Task finished/ })).toBeUndefined()
    await band.unmount()
  })

  // Text mode keys on the reader being shown, not on browser windows (spec, turn complete).
  test('in text mode an open browser window alone is not reading: no done box, band or notification', async ($, on) => {
    const reader: Reader = { viewers: 1, hasBook: true, mode: 'text' }
    const { clock, posted, state } = world(on, reader, { placesPanes: false })
    await $.turn.start({ text: 'build', turnId: 't1' })
    await clock.advance(5_000)
    await $.turn.complete({ answer: 'ok', durationMs: 9_000, isAborted: false, turnId: 't1', reason: 'answer' })
    expect(posted('/api/task').at(-1)?.body).toMatchObject({ state: 'done', notify: false })
    expect(state('dockTask')).toBeNull()
    const band = await $.ui.mount({ plugin: 'book-reader', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await band.find({ type: 'Text', text: /Task finished/ })).toBeUndefined()
    await band.unmount()
  })

  // The test's `$.ui` has no `close` (render, scroll, focus, press, input, select,
  // mount), so the person's close mark cannot be raised here. `/book dock` folds
  // the pane through the mod's `$.ui.close`, which raises the same `ui.close`
  // hook (origin plugin); the hook stops the clock whatever the origin.
  test('closing the pane stops the read clock', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true, mode: 'text' }
    const { clock, posted, state, panes } = world(on, reader, { placesPanes: true })
    await $.turn.start({ text: 'build', turnId: 't1' })
    await clock.advance(5_000)
    expect(state('readerShownAt')).toBe(6_000)
    await $.command.run({ ...RUN, command: 'book', args: 'dock' })
    // `$.command.run` answers before the command's unawaited fold settles.
    for (let i = 0; i < 2; i++) await new Promise(resolve => setTimeout(resolve, 50))
    expect(panes).toHaveLength(0)
    expect(state('readerShownAt')).toBeNull()
    await clock.advance(20_000)
    expect(posted(`/api/books/${BOOK.id}/progress`).map(c => c.body)).not.toContainEqual({ read: [42] })
  })

  test('/book mode browser while reading goes back to the dashboard', async ($, on) => {
    const reader: Reader = { viewers: 0, hasBook: true, mode: 'text' }
    const { clock, posted, state } = world(on, reader, { placesPanes: true })
    await $.turn.start({ text: 'build', turnId: 't1' })
    await clock.advance(5_000)
    await $.command.run({ ...RUN, command: 'book', args: 'mode browser' })
    expect(state('dockView')).toBe('main')
    expect(state('readerShownAt')).toBeNull()
    const ui = await mountDock($, 'terminal')
    // Browser mode now: the dashboard offers the window, not r read here.
    expect(await ui.find({ type: 'Button', key: 'dock-open' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'reader-next' })).toBeUndefined()
    await clock.advance(20_000)
    expect(posted(`/api/books/${BOOK.id}/progress`).map(c => c.body)).not.toContainEqual({ read: [42] })
    await ui.unmount()
  })
})
