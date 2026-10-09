import { describe, expect, test } from 'claude-code/testing'

import {
  SPINES, badge, bar, chapters, clock, dockModel, gradient, heatmap, initials, newTask, nextUp, noBookLine, percent,
  phaseWord, spaced, spineColor, spoken, summary, taskName, tier, withBaseline,
} from './dock-logic.ts'

const BOOK = { id: 'abc123abc123', path: '/books/dune.pdf', title: 'Dune', page: 42, pages: 300, readCount: 37, openedAt: 1 }

describe('dock text', () => {
  test('a task is named by the first clause of the prompt, about 40 characters', () => {
    expect(taskName('Refactor auth middleware. Then run the tests')).toBe('Refactor auth middleware')
    expect(taskName('  fix\n the build  ')).toBe('fix')
    expect(taskName('...why is CI red?')).toBe('why is CI red')
    expect(taskName('')).toBe('Claude is working')
    expect(taskName('   ')).toBe('Claude is working')
    expect(taskName('Research bakery pricing across every store in the downtown area')).toBe(
      'Research bakery pricing across every…',
    )
  })

  test('durations read as a clock and as words', () => {
    expect(clock(42_000)).toBe('0:42')
    expect(clock(134_000)).toBe('2:14')
    expect(clock(3_725_000)).toBe('1:02:05')
    expect(clock(-5)).toBe('0:00')
    expect(spoken(45_000)).toBe('45s')
    expect(spoken(134_000)).toBe('2m 14s')
    expect(spoken(120_000)).toBe('2m')
    expect(spoken(3_780_000)).toBe('1h 3m')
    expect(spoken(3_600_000)).toBe('1h')
    expect(spoken(400)).toBe('0s')
  })

  test('the masthead letters are spaced, words wider apart', () => {
    expect(spaced('Book Reader')).toBe('B O O K   R E A D E R')
    expect(spaced('Complete')).toBe('C O M P L E T E')
  })

  test('the accent gradient runs amber to gold', () => {
    expect(gradient(3)).toEqual(['#C8873A', '#D8A45A', '#E8C07A'])
    expect(gradient(1)).toEqual(['#C8873A'])
    expect(gradient(0)).toEqual([])
  })

  test('a spine shows up to four initials and keeps one color per title', () => {
    expect(initials('Designing Data-Intensive Applications')).toBe('DDIA')
    expect(initials('Dune')).toBe('DU')
    expect(initials('The Art of Computer Programming')).toBe('ACP')
    expect(initials('The')).toBe('TH')
    expect(initials('***')).toBe('?')
    expect(initials('été à Paris')).toBe('ÉÀP')
    expect(spineColor('Dune')).toBe(spineColor('Dune'))
    expect(SPINES).toContain(spineColor('Designing Data-Intensive Applications'))
  })

  test('progress reads as a percent, a badge and bar cells', () => {
    expect(percent(37, 300)).toBe(12)
    expect(percent(5, null)).toBe(0)
    expect(percent(400, 300)).toBe(100)
    expect(badge(BOOK)).toBe('📖 p.42/300 · 12%')
    expect(badge({ ...BOOK, pages: null })).toBe('📖 p.42')
    expect(bar(0.5, 10)).toEqual({ filled: 5, empty: 5 })
    expect(bar(1.5, 10)).toEqual({ filled: 10, empty: 0 })
    expect(bar(-1, 10)).toEqual({ filled: 0, empty: 10 })
    expect(bar(0.26, 0)).toEqual({ filled: 0, empty: 0 })
  })

  test('the dock picks a layout by its width', () => {
    expect(tier(72)).toBe('full')
    expect(tier(64)).toBe('full')
    expect(tier(63)).toBe('compact')
    expect(tier(40)).toBe('compact')
    expect(tier(39)).toBe('tiny')
  })

  test('the masthead names the phase; an empty dock says why', () => {
    expect(phaseWord('working')).toBe('R E A D I N G')
    expect(phaseWord('done')).toBe('C O M P L E T E')
    expect(phaseWord('idle')).toBe('S T A N D I N G   B Y')
    expect(noBookLine(true)).toBe('No book yet · run /book choose')
    expect(noBookLine(false)).toBe('Reader server not running · starts with the next task')
  })
})

const OUTLINE = [
  { title: 'Arrakis', page: 1, level: 0 },
  { title: 'Paul', page: 3, level: 1 },
  { title: 'Muad’Dib', page: 5, level: 0 },
  { title: 'The Prophet', page: 8, level: 0 },
]
const DETAIL = { ...BOOK, read: [1, 2, 3], outline: OUTLINE }
const SNAPSHOT = { isServerUp: true, current: DETAIL, books: [BOOK], viewers: 1 }
const TASK = {
  name: 'Refactor auth middleware',
  bookId: BOOK.id,
  startPage: 42,
  startReadCount: 37,
  startedAt: 0,
  endedAt: 134_000,
  durationMs: 134_000,
  reason: 'answer' as const,
}

describe('dock chapters', () => {
  test('top-level chapters with ticks, the current one with its share read', () => {
    expect(chapters(OUTLINE, [1, 2, 3, 4, 5], 6, 10)).toEqual([
      { title: 'Arrakis', page: 1, endPage: 4, status: 'done', percent: 100, readPages: 4 },
      { title: 'Muad’Dib', page: 5, endPage: 7, status: 'current', percent: 33, readPages: 1 },
      { title: 'The Prophet', page: 8, endPage: 10, status: 'todo', percent: 0, readPages: 0 },
    ])
  })

  test('with fewer than three top-level entries the next level is listed too', () => {
    const outline = [
      { title: 'A', page: 1, level: 0 },
      { title: 'a1', page: 2, level: 1 },
      { title: 'B', page: 5, level: 0 },
    ]
    expect(chapters(outline, [], 1, 6).map(row => [row.title, row.page, row.endPage, row.status])).toEqual([
      ['A', 1, 1, 'current'],
      ['a1', 2, 4, 'todo'],
      ['B', 5, 6, 'todo'],
    ])
  })

  test('no outline, an empty one, a page before the first chapter, an unknown page count', () => {
    expect(chapters(null, [], 1, 10)).toEqual([])
    expect(chapters([], [], 1, 10)).toEqual([])
    const late = [
      { title: 'A', page: 3, level: 0 },
      { title: 'B', page: 5, level: 0 },
      { title: 'C', page: 8, level: 0 },
    ]
    expect(chapters(late, [], 1, 10).some(row => row.status === 'current')).toBe(false)
    expect(chapters(late, [], 9, null).at(-1)).toEqual({ title: 'C', page: 8, endPage: 9, status: 'current', percent: 0, readPages: 0 })
  })

  test('next up is the first chapter from the current one with pages left', () => {
    const rows = chapters(OUTLINE, [1, 2, 3, 4, 5], 6, 10)
    expect(nextUp(rows)).toEqual({ title: 'Muad’Dib', pagesLeft: 2 })
    expect(nextUp(chapters(OUTLINE, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 10, 10))).toBe(null)
    expect(nextUp([])).toBe(null)
  })
})

describe('dock heatmap', () => {
  test('one cell holds two page buckets; the current page shows on its own', () => {
    const cells = heatmap([1, 2], 3, 10, 10)
    expect(cells).toHaveLength(5)
    expect(cells.slice(0, 2)).toEqual([
      { top: 'read', bottom: 'read' },
      { top: 'current', bottom: 'unread' },
    ])
  })

  test('a long book fits the width; the last half-cell past the end is empty', () => {
    const all = Array.from({ length: 590 }, (_, i) => i + 1)
    const cells = heatmap(all, 1, 590, 56)
    expect(cells).toHaveLength(50)
    expect(cells[0]).toEqual({ top: 'current', bottom: 'read' })
    expect(cells[49]).toEqual({ top: 'read', bottom: 'none' })
  })

  test('a bucket counts as read when more than half of it is read', () => {
    expect(heatmap([1], 5, 12, 3)[0]).toEqual({ top: 'unread', bottom: 'unread' })
    expect(heatmap([1, 2], 5, 12, 3)[0]).toEqual({ top: 'read', bottom: 'unread' })
  })

  test('nothing to draw without a page count or room', () => {
    expect(heatmap([], 1, null, 10)).toEqual([])
    expect(heatmap([], 1, 10, 0)).toEqual([])
  })
})

describe('dock summary and model', () => {
  test('the summary says how long it took and what you read meanwhile', () => {
    const after = { ...BOOK, page: 48, readCount: 43 }
    expect(summary(TASK, after)).toBe('✓ Task finished in 2m 14s · you read 6 pages (p. 42 → 48)')
    expect(summary(TASK, { ...after, readCount: 38 })).toBe('✓ Task finished in 2m 14s · you read 1 page (p. 42 → 48)')
    expect(summary(TASK, { ...after, readCount: 37 })).toBe('✓ Task finished in 2m 14s')
    expect(summary(TASK, null)).toBe('✓ Task finished in 2m 14s')
    expect(summary({ ...TASK, reason: 'aborted' }, BOOK)).toBe('■ Task stopped after 2m 14s')
    expect(summary({ ...TASK, reason: 'error' }, BOOK)).toBe('⚠ Task ended with an error after 2m 14s')
  })

  test('after switching books the summary claims no pages', () => {
    expect(summary(TASK, { ...BOOK, id: 'ffffffffffff', page: 9, readCount: 80 })).toBe('✓ Task finished in 2m 14s')
  })

  test('the starting place comes from the first snapshot that has a book', () => {
    const blank = newTask('Fix it. Now', 1_000, null)
    expect(blank).toEqual({
      name: 'Fix it',
      bookId: null,
      startPage: 1,
      startReadCount: 0,
      startedAt: 1_000,
      endedAt: null,
      durationMs: null,
      reason: null,
    })
    expect(withBaseline(blank, SNAPSHOT)).toEqual({ ...blank, bookId: BOOK.id, startPage: 42, startReadCount: 37 })
    const later = { ...SNAPSHOT, current: { ...DETAIL, page: 50, readCount: 45 } }
    const filled = withBaseline(blank, SNAPSHOT)
    expect(withBaseline(filled, later)).toBe(filled)
    expect(withBaseline(blank, null)).toBe(blank)
    expect(withBaseline(null, SNAPSHOT)).toBe(null)
    expect(newTask('Go', 5, SNAPSHOT).startPage).toBe(42)
  })

  test('the model: idle, working with a timer, done with the summary', () => {
    expect(dockModel(null, null, 0)).toEqual({
      phase: 'idle',
      isServerUp: false,
      book: null,
      books: [],
      chapters: [],
      next: null,
      task: null,
      summary: null,
      reason: null,
    })
    const working = dockModel(SNAPSHOT, { ...TASK, startedAt: 1_000, endedAt: null, durationMs: null, reason: null }, 43_000)
    expect(working.phase).toBe('working')
    expect(working.task).toEqual({ name: 'Refactor auth middleware', elapsed: '0:42' })
    expect(working.book?.title).toBe('Dune')
    expect(working.summary).toBe(null)
    const done = dockModel(SNAPSHOT, TASK, 200_000)
    expect(done.phase).toBe('done')
    expect(done.task).toBe(null)
    expect(done.summary).toBe('✓ Task finished in 2m 14s')
    expect(done.reason).toBe('answer')
    const down = dockModel({ isServerUp: false, current: null, books: [], viewers: 0 }, null, 0)
    expect(down.isServerUp).toBe(false)
  })
})

describe('dock logic with absurd page counts', () => {
  // A page count comes from the reader; a bogus one must not stall the drawing.
  test('the heatmap does not walk every page of a huge book', () => {
    const cells = heatmap([1, 2, 3], 2, 10_000_000_000, 56)
    expect(cells).toHaveLength(56)
    expect(cells[0]).toEqual({ top: 'current', bottom: 'unread' })
  })

  test('chapters do not walk every page of a huge book', () => {
    const rows = chapters([{ title: 'A', page: 1, level: 0 }, { title: 'B', page: 2, level: 0 }, { title: 'C', page: 3, level: 0 }], [1, 3, 4], 1, 10_000_000_000)
    expect(rows.map(row => row.readPages)).toEqual([1, 0, 2])
  })

  test('two entries on one page both count it', () => {
    const rows = chapters([{ title: 'A', page: 1, level: 0 }, { title: 'B', page: 1, level: 0 }, { title: 'C', page: 3, level: 0 }], [1, 2], 3, 4)
    expect(rows.map(row => [row.title, row.readPages, row.status])).toEqual([['A', 1, 'done'], ['B', 2, 'done'], ['C', 0, 'current']])
  })
})
