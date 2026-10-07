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
