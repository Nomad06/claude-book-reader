import { describe, expect, test } from 'claude-code/testing'

import { BAND_PROPS, mountDock, world } from './test-world.ts'
import type { Reader, TestDollar, TestOn } from './test-world.ts'

const SURFACES = ['terminal', 'desktop'] as const

describe('reading dock', () => {
  test('a long task opens the dock beside the transcript and ends on the summary', async ($, on) => {
    const reader = { viewers: 0, hasBook: true }
    const { clock, opens } = world(on, reader, { placesPanes: true })

    await $.turn.start({ text: 'Refactor auth middleware. Then run the tests', turnId: 't1' })
    expect(opens).toHaveLength(0)
    await clock.advance(5_000)
    expect(opens).toEqual([{ id: 'book-dock', columns: 72 }])

    for (const surface of SURFACES) {
      const ui = await mountDock($, surface)
      expect(await ui.find({ type: 'Text', text: /R E A D I N G/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Refactor auth middleware/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Dune/ })).toBeDefined()
      await ui.unmount()
    }

    Object.assign(reader, { book: { page: 48, readCount: 43 } })
    await clock.advance(2_000)
    await $.turn.complete({ answer: 'Done.', durationMs: 134_000, isAborted: false, turnId: 't1', reason: 'answer' })

    for (const surface of SURFACES) {
      const ui = await mountDock($, surface)
      expect(await ui.find({ type: 'Text', text: /C O M P L E T E/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Task finished in 2m 14s · you read 6 pages \(p\. 42 → 48\)/ })).toBeDefined()
      await ui.unmount()
    }
  })

  // One world per test: the test's own hooks may not be registered twice.
  for (const [key, path] of [['dock-close', '/api/close'], ['dock-keep', '/api/task']] as const) {
    test(`${key} in the dock does what the band's button does`, async ($, on) => {
      const reader = { viewers: 0, hasBook: true }
      const { clock, posted } = world(on, reader, { placesPanes: true })
      await $.turn.start({ text: 'build', turnId: 't1' })
      await clock.advance(5_000)
      await $.turn.complete({ answer: 'ok', durationMs: 9_000, isAborted: false, turnId: 't1', reason: 'answer' })
      const before = posted(path).length
      const ui = await mountDock($, 'terminal')
      await ui.press({ key })
      expect(posted(path).length).toBe(before + 1)
      expect(await ui.find({ type: 'Text', text: /S T A N D I N G/ })).toBeDefined()
      await ui.unmount()
    })
  }

  for (const placesPanes of [true, false]) {
    test(`the band ${placesPanes ? 'waits while the dock is drawn' : 'shows when the dock is not drawn'}`, async ($, on) => {
      const reader = { viewers: 0, hasBook: true }
      const { clock } = world(on, reader, { placesPanes })
      await $.turn.start({ text: 'build', turnId: 't1' })
      await clock.advance(5_000)
      await $.turn.complete({ answer: 'ok', durationMs: 9_000, isAborted: false, turnId: 't1', reason: 'answer' })
      const band = await $.ui.mount({ plugin: 'book-reader', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
      const shown = await band.find({ type: 'Text', text: /Task finished/ })
      expect(shown === undefined).toBe(placesPanes)
      await band.unmount()
    })
  }

  test('with the server down at the start, the starting place comes from the first answer', async ($, on) => {
    const reader = { viewers: 0, hasBook: true, isUp: false }
    const { clock } = world(on, reader, { placesPanes: true })
    await $.turn.start({ text: 'build', turnId: 't1' })
    reader.isUp = true
    await clock.advance(5_000)
    Object.assign(reader, { book: { page: 45, readCount: 40 } })
    await clock.advance(2_000)
    await $.turn.complete({ answer: 'ok', durationMs: 61_000, isAborted: false, turnId: 't1', reason: 'answer' })
    const ui = await mountDock($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /you read 3 pages \(p\. 42 → 45\)/ })).toBeDefined()
    await ui.unmount()
  })

  test('with the server down and no task the dock says so', async ($, on) => {
    world(on, { viewers: 0, hasBook: true, isUp: false }, { placesPanes: true })
    const ui = await mountDock($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /S T A N D I N G/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Reader server not running/ })).toBeDefined()
    await ui.unmount()
  })
})

const OUTLINE = [
  { title: 'Arrakis', page: 1, level: 0 },
  { title: 'Muad’Dib', page: 40, level: 0 },
  { title: 'The Prophet', page: 200, level: 0 },
]

async function openOnTask($: TestDollar, on: TestOn, reader: Partial<Reader>) {
  const w = world(on, { viewers: 0, hasBook: true, ...reader }, { placesPanes: true })
  await $.turn.start({ text: 'build', turnId: 't1' })
  await w.clock.advance(5_000)
  return w
}

describe('reading dock face', () => {
  test('progress, heatmap and contents with ticks', async ($, on) => {
    await openOnTask($, on, { read: Array.from({ length: 39 }, (_, i) => i + 1), outline: OUTLINE })
    for (const surface of SURFACES) {
      const ui = await mountDock($, surface)
      expect(await ui.find({ type: 'Text', text: /p\. 42 \/ 300 · 12%/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /▀/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /C O N T E N T S/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^✓$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^▸$/ })).toBeDefined()
      expect(await ui.find({ key: 'ch-40-1' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('pressing a chapter puts the reader there', async ($, on) => {
    const { posted } = await openOnTask($, on, { outline: OUTLINE })
    const ui = await mountDock($, 'terminal')
    await ui.press({ key: 'ch-200-2' })
    expect(posted('/api/show').at(-1)?.body).toEqual({ window: 'app', page: 200 })
    await ui.unmount()
  })

  test('contents before the first open', async ($, on) => {
    await openOnTask($, on, { outline: null })
    const ui = await mountDock($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /Contents appear after the first open/ })).toBeDefined()
    await ui.unmount()
  })

  test('contents of a book without any', async ($, on) => {
    await openOnTask($, on, { outline: [] })
    const ui = await mountDock($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /No table of contents in this book/ })).toBeDefined()
    await ui.unmount()
  })

  test('the library lists books and switches to one', async ($, on) => {
    const { posted } = await openOnTask($, on, {})
    const ui = await mountDock($, 'terminal')
    await ui.press({ key: 'dock-library' })
    expect(await ui.find({ type: 'Text', text: /L I B R A R Y/ })).toBeDefined()
    await ui.press({ key: 'book-abc123abc123' })
    expect(posted('/api/books/abc123abc123/select')).toHaveLength(1)
    expect(await ui.find({ type: 'Text', text: /L I B R A R Y/ })).toBeUndefined()
    await ui.press({ key: 'dock-library' })
    await ui.press({ key: 'dock-back' })
    expect(await ui.find({ type: 'Text', text: /L I B R A R Y/ })).toBeUndefined()
    await ui.unmount()
  })

  test('open reader raises the reader', async ($, on) => {
    const { posted } = await openOnTask($, on, {})
    const before = posted('/api/show').length
    const ui = await mountDock($, 'terminal')
    await ui.press({ key: 'dock-open' })
    expect(posted('/api/show').length).toBe(before + 1)
    await ui.unmount()
  })

  test('narrower docks drop the spine, heatmap and contents; the narrowest keep three lines', async ($, on) => {
    await openOnTask($, on, { outline: OUTLINE })
    let ui = await mountDock($, 'terminal', 50)
    expect(await ui.find({ type: 'Text', text: /▀/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /C O N T E N T S/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Muad’Dib/ })).toBeDefined()
    await ui.unmount()
    ui = await mountDock($, 'terminal', 30)
    expect(await ui.find({ type: 'Text', text: /^Dune$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /p\. 42 \/ 300 · 12%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /● working/ })).toBeDefined()
    await ui.unmount()
  })
})
