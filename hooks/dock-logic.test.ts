import { describe, expect, test } from 'claude-code/testing'

import { SPINES, badge, bar, clock, gradient, initials, percent, spaced, spineColor, spoken, taskName, tier } from './dock-logic.ts'

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
})
