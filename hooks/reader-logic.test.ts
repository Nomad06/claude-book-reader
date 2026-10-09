import { describe, expect, test } from 'claude-code/testing'

import { imageBox, imageLine, isGraphicsTerminal, listText, pageLabel, parseGoto, readerMode } from './reader-logic.ts'

describe('reader logic', () => {
  test('kitty and Ghostty draw pictures; others do not', () => {
    expect(isGraphicsTerminal({ TERM_PROGRAM: 'ghostty' })).toBe(true)
    expect(isGraphicsTerminal({ TERM: 'xterm-kitty' })).toBe(true)
    expect(isGraphicsTerminal({ KITTY_WINDOW_ID: '1' })).toBe(true)
    expect(isGraphicsTerminal({ GHOSTTY_RESOURCES_DIR: '/x' })).toBe(true)
    expect(isGraphicsTerminal({ TERM_PROGRAM: 'iTerm.app', TERM: 'xterm-256color' })).toBe(false)
    expect(isGraphicsTerminal({})).toBe(false)
  })

  test('an image box is at most 60 columns and keeps the aspect at 2.1 rows per column', () => {
    expect(imageBox(1980, 1055, 72)).toEqual({ columns: 60, rows: 15 })
    expect(imageBox(400, 400, 40)).toEqual({ columns: 40, rows: 19 })
    expect(imageBox(100, 10, 72)).toEqual({ columns: 60, rows: 3 })
    expect(imageBox(10, 1000, 72)).toEqual({ columns: 60, rows: 40 })
  })

  test('go to page takes a number within the book', () => {
    expect(parseGoto(' 12 ', 300)).toBe(12)
    expect(parseGoto('p. 12', 300)).toBe(12)
    expect(parseGoto('0', 300)).toBe(null)
    expect(parseGoto('301', 300)).toBe(null)
    expect(parseGoto('301', null)).toBe(301)
    expect(parseGoto('abc', 300)).toBe(null)
  })

  test('the mode is the server setting, else the config, else browser', () => {
    expect(readerMode('text', 'browser')).toBe('text')
    expect(readerMode(undefined, 'text')).toBe('text')
    expect(readerMode('pigeon', 'browser')).toBe('browser')
  })

  test('labels', () => {
    expect(pageLabel(201, 535, false)).toBe('p. 201 / 535')
    expect(pageLabel(201, 535, true)).toBe('p. 201 / 535 ✓')
    expect(pageLabel(3, null, false)).toBe('p. 3')
    expect(imageLine('Figure 1-12. Both under one roof', 1980, 1055)).toBe('▣ Figure 1-12. Both under one roof · 1980×1055 · o opens in browser')
    expect(imageLine('Image 800×450', 800, 450)).toBe('▣ Image 800×450 · o opens in browser')
    expect(listText([{ text: '• ' }, { text: 'bold', bold: true }, { text: ' item' }])).toBe('• bold item')
  })
})
