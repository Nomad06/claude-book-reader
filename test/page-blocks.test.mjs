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
    assert.deepEqual(blocks.map(b => b.kind), ['para', 'para'])
    assert.equal(text(blocks[0]).length, 500)
    assert.equal(text(blocks[1]), '… page cut at 500 characters')
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

  test('a cut that lands exactly on a block boundary adds no empty block', () => {
    const items = [...lines(['a'.repeat(10)], { top: 700 }), ...lines(['b'.repeat(10)], { top: 650 }), ...lines(['c'.repeat(10)], { top: 600 })]
    assert.deepEqual(pageBlocks(items, [], PROFILE, { maxChars: 20 }), [
      { kind: 'para', runs: [{ text: 'a'.repeat(10) }] },
      { kind: 'para', runs: [{ text: 'b'.repeat(10) }] },
      { kind: 'para', runs: [{ text: '… page cut at 20 characters' }] },
    ])
    const code = [...lines(['a'.repeat(10)], { top: 700 }), ...lines(['x = 1'], { top: 650, mono: true, family: 'monospace' })]
    assert.deepEqual(
      pageBlocks(code, [], PROFILE, { maxChars: 10 }).map(b => b.kind),
      ['para', 'para'],
    )
  })

  test('lines of only control characters leave no empty block', () => {
    const items = [
      item('\u0007', { y: 720, size: 18 }),
      ...lines(['\u001b', 'Figure 1. \u0007'], { top: 690 }),
      ...lines(['\u0000\u0001'], { top: 650, mono: true, family: 'monospace' }),
      ...lines(['Real text.'], { top: 630 }),
    ]
    const blocks = pageBlocks(items, [], PROFILE)
    assert.ok(blocks.every(b => (b.kind === 'code' ? b.text !== '' : b.runs.length > 0)))
    assert.deepEqual(
      blocks.map(b => [b.kind, text(b)]),
      [['caption', 'Figure 1. '], ['para', 'Real text.']],
    )
  })

  test('a page of only empty items gives no blocks', () => {
    const items = [item('', { y: 700 }), item('', { y: 687 }), item('', { y: 674 })]
    assert.deepEqual(pageBlocks(items, [], PROFILE), [])
  })

  test('hostile sizes and positions are bounded and never throw', () => {
    const mono = { mono: true, family: 'monospace' }
    const items = [
      item('code a', { x: 0, y: 700, size: 0, ...mono }),
      item('code b', { x: 1e9, y: 690, size: 1e-9, ...mono }),
      item('code c', { x: 1e9, y: 680, size: 8, ...mono }),
      item('code d', { x: 0, y: 1e12, size: 8, ...mono }),
      item('code e', { x: 0, y: -1e12, size: 8, ...mono }),
      item('nan x', { x: NaN, y: 600 }),
      item('nan y', { x: 72, y: NaN }),
      item('inf size', { x: 72, y: 590, size: Infinity }),
      item('neg size', { x: 72, y: 580, size: -5 }),
      { ...item('nan width', { x: 72, y: 570 }), width: NaN },
      item('huge', { x: 72, y: 560, size: 1e300 }),
      item('long ' + 'z'.repeat(1e6), { x: 72, y: 550 }),
    ]
    const images = [{ file: '/p/x.rgb', width: 10, height: 10, x: 0, y: NaN, w: 1, h: 1 }]
    const started = Date.now()
    const blocks = pageBlocks(items, images, PROFILE)
    assert.ok(Date.now() - started < 2000)
    const chars = blocks.reduce((n, b) => n + (b.kind === 'code' ? b.text.length : b.runs ? text(b).length : 0), 0)
    assert.ok(chars <= MAX_PAGE_CHARS + 100)
    for (const b of blocks) if (b.kind === 'code') assert.ok(b.text.split('\n').every(l => l.length <= 80 + 20))
    calibrate([items, items])
  })

  test('a huge baseline gap in code adds a few blank lines at most; a line of many items does not overflow the stack', () => {
    const mono = { mono: true, family: 'monospace', size: 8 }
    const code = pageBlocks([item('a', { y: 700, ...mono }), item('b', { y: -1e9, ...mono })], [], PROFILE)
    assert.ok(code[0].text.split('\n').length <= 8)
    const many = Array.from({ length: 150000 }, (_, i) => item('w', { x: 72 + i * 0.001, y: 700, eol: false }))
    assert.ok(pageBlocks(many, [], PROFILE).length >= 1)
  })

  test('an empty page gives no blocks', () => {
    assert.deepEqual(pageBlocks([], [], PROFILE), [])
  })
})
