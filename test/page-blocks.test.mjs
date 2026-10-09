// Tests of server/page-blocks.mjs on synthetic text items shaped like real
// pages (positions, sizes, fonts) with neutral text.
//
//   node --test test/page-blocks.test.mjs

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { MAX_PAGE_CHARS, calibrate, linesOf, pageBlocks } from '../server/page-blocks.mjs'

/** One text item; `width` is 0.5 × size per character, like a typical serif. */
function item(text, { x = 72, y, size = 10, font = 'ABCDEF+Minion-Regular', family = 'serif', mono = false, eol = true } = {}) {
  return { text, x, y, size, width: text.length * size * 0.5, family, font, mono, eol }
}

/** Lines of body text from the top of a page down, one item per line. */
function lines(texts, { top = 700, size = 10, x = 72, leading = 1.3, ...rest } = {}) {
  return texts.map((text, i) => item(text, { x, y: top - i * size * leading, size, ...rest }))
}

const PROFILE = { bodySize: 10, headers: [] }
const text = block => block.runs.map(r => r.text).join('')

describe('lines', () => {
  test('groups items by baseline, orders them by x and joins them with spaces across gaps', () => {
    const items = [
      item('world', { x: 110, y: 700, eol: true }),
      item('Hello', { x: 72, y: 700, eol: false }),
      item('Next line', { y: 687 }),
    ]
    const out = linesOf(items)
    assert.equal(out.length, 2)
    assert.equal(out[0].text, 'Hello world')
    assert.equal(out[1].text, 'Next line')
    assert.equal(out[0].x, 72)
  })

  test('skips empty items', () => {
    const items = [item('', { y: 700 }), item('A', { y: 700 }), item('', { y: 687 })]
    assert.deepEqual(
      linesOf(items).map(l => l.text),
      ['A'],
    )
    assert.deepEqual(pageBlocks(items, [], PROFILE), [{ kind: 'para', runs: [{ text: 'A' }] }])
  })
})

describe('calibration', () => {
  test('finds the body size by character count and the running header by repetition', () => {
    // Body and heading text differ per page (digits are ignored, letters are not), so only the header repeats.
    const page = n => [
      item(`${n} Part I. Foundations`, { y: 760, size: 8 }),
      ...lines([`Body text ${'abcd'[n % 4]} of the page, long enough to win.`, `More body text ${'wxyz'[n % 4]} here on this page.`], { top: 700 }),
      item(`Heading ${'ABCD'[n % 4]}`, { y: 720, size: 14 }),
    ]
    const profile = calibrate([page(50), page(51), page(52), page(53)])
    assert.equal(profile.bodySize, 10)
    assert.deepEqual(profile.headers, [{ y: 760, text: '# Part I. Foundations' }])
  })

  test('two sampled pages: only the line they share is a header, whatever the font', () => {
    const page = (n, body) => [
      item(`${n} Running title`, { y: 760, size: 8, font: '' }),
      ...lines([body], { top: 700, font: '' }),
    ]
    const profile = calibrate([page(10, 'First page body text.'), page(11, 'Second page other words.')])
    assert.deepEqual(profile.headers, [{ y: 760, text: '# Running title' }])
    assert.equal(profile.bodySize, 10)
  })

  test('one sampled page never yields headers', () => {
    assert.deepEqual(calibrate([lines(['A', 'B'])]).headers, [])
  })
})

describe('blocks', () => {
  test('joins body lines into a paragraph, de-hyphenating line ends', () => {
    const items = lines(['The quick brown fox jumps over the lazy dog and keeps run-', 'ning until the para-', 'graph ends here.'])
    assert.deepEqual(pageBlocks(items, [], PROFILE), [
      { kind: 'para', runs: [{ text: 'The quick brown fox jumps over the lazy dog and keeps running until the paragraph ends here.' }] },
    ])
  })

  test('keeps a hyphen before a capital and a U+2010 hyphen is treated like a dash', () => {
    const items = lines(['A well-', 'Known case', 'with a soft‐', 'break'])
    assert.equal(text(pageBlocks(items, [], PROFILE)[0]), 'A well- Known case with a softbreak')
  })

  test('a larger y gap or an indented first line starts a new paragraph', () => {
    const items = [
      ...lines(['First paragraph line one.', 'first paragraph line two.'], { top: 700 }),
      ...lines(['Second paragraph after a gap.'], { top: 660 }),
      ...lines(['Third paragraph, indented first line', 'continues at the margin.'], { top: 647, x: 90 }),
    ]
    items.at(-1).x = 72
    const blocks = pageBlocks(items, [], PROFILE)
    assert.deepEqual(
      blocks.map(text),
      ['First paragraph line one. first paragraph line two.', 'Second paragraph after a gap.', 'Third paragraph, indented first line continues at the margin.'],
    )
  })

  test('drops the running header and page number lines', () => {
    const profile = { bodySize: 10, headers: [{ y: 760, text: '# Part I. Foundations' }, { y: 40, text: '#' }] }
    const items = [item('52 Part I. Foundations', { y: 760, size: 8 }), ...lines(['Body.']), item('52', { y: 40, size: 8 })]
    assert.deepEqual(pageBlocks(items, [], profile), [{ kind: 'para', runs: [{ text: 'Body.' }] }])
  })

  test('headings by size, levels by rank on the page', () => {
    const items = [
      item('Chapter Title', { y: 720, size: 18, font: 'Myriad-Bold' }),
      item('A Section', { y: 690, size: 13, font: 'Myriad-Bold' }),
      ...lines(['Body under the section.'], { top: 670 }),
      item('Another Section', { y: 640, size: 13 }),
      item('Sub Section', { y: 620, size: 11.6 }),
    ]
    const blocks = pageBlocks(items, [], PROFILE)
    assert.deepEqual(
      blocks.map(b => [b.kind, b.level, text(b)]),
      [
        ['heading', 1, 'Chapter Title'],
        ['heading', 2, 'A Section'],
        ['para', undefined, 'Body under the section.'],
        ['heading', 2, 'Another Section'],
        ['heading', 3, 'Sub Section'],
      ],
    )
    assert.deepEqual(blocks[0].runs, [{ text: 'Chapter Title', bold: true }])
  })

  test('monospace lines become one code block with indentation and blank lines kept', () => {
    const items = [
      ...lines(['def f(x):'], { top: 700, x: 90, size: 8.8, family: 'monospace', mono: true, font: 'UbuntuMono-Regular' }),
      ...lines(['    return x'], { top: 689, x: 111, size: 8.8, family: 'monospace', mono: true, font: 'UbuntuMono-Regular' }),
      ...lines(['print(f(1))'], { top: 667, x: 90, size: 8.8, family: 'monospace', mono: true, font: 'UbuntuMono-Regular' }),
      ...lines(['Prose after the code.'], { top: 650 }),
    ]
    items[1].text = 'return x' // the indent comes from x, not from the string
    const blocks = pageBlocks(items, [], PROFILE)
    assert.deepEqual(blocks, [
      { kind: 'code', text: 'def f(x):\n    return x\n\nprint(f(1))' },
      { kind: 'para', runs: [{ text: 'Prose after the code.' }] },
    ])
  })

  test('a code block starting indented is re-based on its leftmost line', () => {
    const items = [
      ...lines(['inner()'], { top: 700, x: 111, size: 8.8, mono: true, family: 'monospace' }),
      ...lines(['outer()'], { top: 689, x: 90, size: 8.8, mono: true, family: 'monospace' }),
    ]
    assert.equal(pageBlocks(items, [], PROFILE)[0].text, '    inner()\nouter()')
  })

  test('list items: markers, numbers, continuation lines', () => {
    const items = [
      ...lines(['• First item that wraps onto', 'the next line.'], { top: 700, x: 77 }),
      ...lines(['• Second item.'], { top: 674, x: 77 }),
      ...lines(['1. Numbered one.', '2. Numbered two.'], { top: 650, x: 77 }),
    ]
    items[1].x = 90
    const blocks = pageBlocks(items, [], PROFILE)
    assert.deepEqual(
      blocks.map(b => [b.kind, text(b)]),
      [
        ['list', '• First item that wraps onto the next line.'],
        ['list', '• Second item.'],
        ['list', '1. Numbered one.'],
        ['list', '2. Numbered two.'],
      ],
    )
  })

  test('captions', () => {
    const items = lines(['Figure 1-12. Many companies put both under one roof.', 'Рис. 2.3. Схема.'])
    assert.deepEqual(
      pageBlocks(items, [], PROFILE).map(b => b.kind),
      ['caption', 'caption'],
    )
  })

  test('runs carry bold, italic and mono from the font, merged when equal', () => {
    const items = [
      item('Plain, ', { x: 72, y: 700, eol: false, font: 'Minion-Regular' }),
      item('bold', { x: 108, y: 700, eol: false, font: 'Minion-Bold' }),
      item(' and ', { x: 128, y: 700, eol: false, font: 'Minion-Regular' }),
      item('italic', { x: 153, y: 700, eol: false, font: 'Minion-Italic' }),
      item(' then ', { x: 183, y: 700, eol: false, font: 'Minion-SemiboldItalic' }),
      item('code', { x: 213, y: 700, eol: true, font: 'UbuntuMono-Regular', family: 'monospace', mono: true }),
    ]
    assert.deepEqual(pageBlocks(items, [], PROFILE)[0].runs, [
      { text: 'Plain, ' },
      { text: 'bold', bold: true },
      { text: ' and ' },
      { text: 'italic', italic: true },
      { text: ' then ', bold: true, italic: true },
      { text: 'code', mono: true },
    ])
  })

  test('images are placed by their top among the lines, with the caption below as alt', () => {
    const items = [...lines(['Above the figure.'], { top: 700 }), ...lines(['Figure 3-1. The thing.', 'Below the figure.'], { top: 500 })]
    const images = [{ file: '/p/1.rgb', width: 600, height: 300, x: 72, y: 680, w: 400, h: 160 }]
    const blocks = pageBlocks(items, images, PROFILE)
    assert.deepEqual(
      blocks.map(b => b.kind),
      ['para', 'image', 'caption', 'para'],
    )
    assert.deepEqual(blocks[1], { kind: 'image', file: '/p/1.rgb', width: 600, height: 300, alt: 'Figure 3-1. The thing.' })
  })

  test('an image without a caption is named by its size; one above all text comes first', () => {
    const items = lines(['Text.'], { top: 600 })
    const images = [{ file: '/p/2.rgb', width: 800, height: 450, x: 72, y: 760, w: 400, h: 200 }]
    const blocks = pageBlocks(items, images, PROFILE)
    assert.deepEqual(blocks[0], { kind: 'image', file: '/p/2.rgb', width: 800, height: 450, alt: 'Image 800×450' })
  })

  test('control characters never survive; tabs and newlines live only in code', () => {
    const items = [
      ...lines(['Esc \u001b[31mred\u001b[0m and bell\u0007.'], { top: 700 }),
      ...lines(['x = "\u001b"\tok'], { top: 680, mono: true, family: 'monospace' }),
    ]
    const [para, code] = pageBlocks(items, [], PROFILE)
    assert.equal(text(para), 'Esc [31mred[0m and bell.')
    assert.equal(code.text, 'x = ""\tok')
  })

  test('cuts a page at maxChars and says so', () => {
    const items = lines(Array.from({ length: 40 }, (_, i) => `Line ${i} ` + 'x'.repeat(90)), { top: 700, leading: 1.2 })
    const blocks = pageBlocks(items, [], PROFILE, { maxChars: 500 })
    const total = blocks.reduce((n, b) => n + (b.runs ? text(b).length : 0), 0)
    assert.ok(total <= 500 + 40)
    assert.match(text(blocks.at(-1)), /page cut at 500 characters/)
    assert.equal(MAX_PAGE_CHARS, 20000)
  })

  test('de-hyphenates Cyrillic prose and leaves the caller\'s items alone', () => {
    const items = lines(['Это слово про обра-', 'зование идёт дальше.'])
    const before = JSON.stringify(items)
    assert.deepEqual(pageBlocks(items, [], PROFILE), [{ kind: 'para', runs: [{ text: 'Это слово про образование идёт дальше.' }] }])
    assert.equal(JSON.stringify(items), before)
  })

  test('control characters are stripped from headings, captions, lists and code too', () => {
    const items = [
      item('Head\u001b[1ming', { y: 720, size: 18 }),
      ...lines(['Figure 1. Cap\u0007tion'], { top: 690 }),
      ...lines(['\u2022 It\u001bem'], { top: 670 }),
      ...lines(['co\u0000de'], { top: 650, mono: true, family: 'monospace' }),
    ]
    const blocks = pageBlocks(items, [], PROFILE)
    assert.deepEqual(blocks.map(b => b.kind), ['heading', 'caption', 'list', 'code'])
    assert.equal(text(blocks[0]), 'Head[1ming')
    assert.equal(text(blocks[1]), 'Figure 1. Caption')
    assert.equal(text(blocks[2]), '\u2022 Item')
    assert.equal(blocks[3].text, 'code')
  })

  test('an empty page gives no blocks', () => {
    assert.deepEqual(pageBlocks([], [], PROFILE), [])
  })
})
