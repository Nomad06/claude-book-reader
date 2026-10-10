import { describe, expect, test } from 'claude-code/testing'

import { drawingLine, fitTitle, imageBox, imageLine, isGraphicsTerminal, listText, pageLabel, parseGoto, readerMode, splitUrls, textWidth, tocRows } from './reader-logic.ts'

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
    expect(drawingLine('Рис. 1.1. Пример того, как GPT-4 токенизирует фразу')).toBe('▣ Рис. 1.1. Пример того, как GPT-4 токенизирует фразу · drawing · o opens in browser')
    expect(listText([{ text: '• ' }, { text: 'bold', bold: true }, { text: ' item' }])).toBe('• bold item')
  })
})

/** A toc row as the pane draws it; a row that is not there fails the test. */
const line = (row: { text: string; leader: string; page: string } | undefined) => {
  if (!row) throw new Error('no such toc row')
  return `${row.text}${row.leader ? ` ${row.leader} ${row.page}` : ''}`
}

describe('reader layout helpers', () => {
  test('text width counts display columns', () => {
    expect(textWidth('Оглавление')).toBe(10)
    expect(textWidth('漢字')).toBe(4)
    expect(textWidth('a🙂')).toBe(3)
    expect(textWidth('e\u0301')).toBe(1)
    expect(textWidth('')).toBe(0)
  })

  test('a title is cut to its width with an ellipsis, never wider', () => {
    expect(fitTitle('Short', 10)).toBe('Short')
    expect(fitTitle('AI-инженерия. Построение приложений', 12)).toBe('AI-инженери…')
    expect(textWidth(fitTitle('漢字漢字漢字', 7))).toBeLessThanOrEqual(7)
    expect(fitTitle('漢字漢字漢字', 7)).toBe('漢字漢…')
    expect(fitTitle('anything', 0)).toBe('')
    expect(fitTitle('anything', 1)).toBe('…')
  })

  test('a toc entry fills the row: title, leader, right-aligned page', () => {
    const rows = tocRows('Введение', '12', 1, 24)
    expect(rows).toHaveLength(1)
    expect(line(rows[0])).toBe('Введение ············ 12')
    expect(textWidth(line(rows[0]))).toBe(24)
  })

  test('toc levels indent two columns each and keep the row width', () => {
    const rows = tocRows('Тест', 'xvii', 3, 30)
    expect(line(rows[0]).startsWith('    Тест ')).toBe(true)
    expect(line(rows[0]).endsWith(' xvii')).toBe(true)
    expect(textWidth(line(rows[0]))).toBe(30)
  })

  test('a long toc title wraps and the leader and number sit on its last line', () => {
    const rows = tocRows('Построение приложений с использованием моделей', '460', 1, 30)
    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows.slice(0, -1)) {
      expect(row.leader).toBe('')
      expect(textWidth(row.text)).toBeLessThanOrEqual(30)
    }
    const last = rows.at(-1)
    expect(last?.leader.length).toBeGreaterThanOrEqual(2)
    expect(textWidth(line(last))).toBe(30)
    expect(line(last).endsWith(' 460')).toBe(true)
    expect(rows.map(r => r.text).join(' ').replace(/\s+/g, ' ').trim()).toBe('Построение приложений с использованием моделей')
  })

  test('a title that fills its last line moves the leader to a row of its own', () => {
    const rows = tocRows('one two three four', '460', 1, 12)
    expect(rows.map(r => r.text.trim())).toEqual(['one two', 'three four', ''])
    expect(textWidth(line(rows[2]))).toBe(12)
    expect(line(rows[2]).endsWith(' 460')).toBe(true)
  })

  test('a word wider than the row is cut, and no row is wider than the pane', () => {
    const rows = tocRows('Pneumonoultramicroscopicsilicovolcanoconiosis', '9', 2, 20)
    for (const row of rows) expect(textWidth(line(row))).toBeLessThanOrEqual(20)
  })

  test('urls are found with their trailing punctuation left out', () => {
    expect(splitUrls('plain text')).toEqual([{ text: 'plain text', isUrl: false }])
    expect(splitUrls('see https://example.com/a?b=1, and oreil.ly/xyz12. Then www.site.org/p!')).toEqual([
      { text: 'see ', isUrl: false },
      { text: 'https://example.com/a?b=1', isUrl: true },
      { text: ', and ', isUrl: false },
      { text: 'oreil.ly/xyz12', isUrl: true },
      { text: '. Then ', isUrl: false },
      { text: 'www.site.org/p', isUrl: true },
      { text: '!', isUrl: false },
    ])
    expect(splitUrls('и/или, т.е. 3.5/4')).toEqual([{ text: 'и/или, т.е. 3.5/4', isUrl: false }])
    expect(splitUrls('')).toEqual([])
  })
})
