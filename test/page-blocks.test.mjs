// Tests of server/page-blocks.mjs on synthetic text items shaped like real
// pages (positions, sizes, fonts) with neutral text.
//
//   node --test test/page-blocks.test.mjs

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { MAX_PAGE_CHARS, calibrate, isScanned, linesOf, pageBlocks } from '../server/page-blocks.mjs'

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

// The real book these are modelled on (AI-инженерия, 467×660 pt pages): body 10 pt on a 12.1 pt pitch,
// running heads 12 pt at y 608–614 with the folio first (even pages) or last (odd pages), contents 9.5 pt.
const BOOK = { top: 660.5, bottom: 0 }

/** One line from several items laid side by side, like pdf.js gives a contents line. */
function row(parts, { x = 56.7, y, size = 9.5, ...rest } = {}) {
  const out = []
  let at = x
  for (const part of parts) {
    const it = item(part, { x: at, y, size, ...rest })
    out.push(it)
    at += it.width
  }
  return out
}

const body = (texts, top = 579) => lines(texts, { top, x: 56.7, leading: 1.21 })

// The test book prints the PDF's own page number (offset 0), as calibrate learns from its samples.
const FOLIOS = { ...PROFILE, folioOffset: 0 }

describe('folio offset', () => {
  const page = (n, printed) => ({
    page: n,
    items: [item(`${printed} Глава 2. Знакомство с базовыми моделями`, { y: 613.9, size: 12 }), ...body([`Текст страницы ${'абвг'[n % 4]} достаточно длинный.`])],
  })

  test('calibrate learns how far the printed folios are from the PDF page numbers', () => {
    assert.equal(calibrate([page(50, 50), page(80, 80), page(120, 120)]).folioOffset, 0)
    // front matter counted apart: PDF page 50 prints 38
    assert.equal(calibrate([page(50, 38), page(80, 68), page(120, 108), page(200, 3)]).folioOffset, -12)
  })

  test('no offset when the sampled pages disagree, have no folios, or carry no page numbers', () => {
    assert.equal(calibrate([page(50, 50), page(80, 70), page(120, 101)]).folioOffset, null)
    assert.equal(calibrate([{ page: 3, items: body(['Только текст.']) }, { page: 9, items: body(['И еще текст.']) }]).folioOffset, null)
    assert.equal(calibrate([page(50, 50).items, page(80, 80).items]).folioOffset, null)
    assert.equal(calibrate([]).folioOffset, null)
  })

  test('two coincidences, an even split or impossible page numbers learn no offset', () => {
    const foot = (n, last) => ({ page: n, items: [...body(['Текст страницы.', last], 300)] })
    // "Total 15" on page 10 and "Total 25" on page 20: two pages agree on +5 by chance
    assert.equal(calibrate([foot(10, 'Total 15'), foot(20, 'Total 25')]).folioOffset, null)
    // plates: half the samples −4, half −12
    const split = Array.from({ length: 12 }, (_, i) => page(20 + i * 40, i < 6 ? 16 + i * 40 : 8 + i * 40))
    assert.equal(calibrate(split).folioOffset, null)
    assert.equal(calibrate([{ ...page(1, 5), page: -5 }, { ...page(1, 4), page: -6 }, { ...page(1, 3), page: -7 }]).folioOffset, null)
    assert.equal(calibrate([{ ...page(1, 5), page: 0.5 }, null, undefined, { page: 3 }, 5]).folioOffset, null)
  })
})

describe('running heads by position', () => {
  test('a running head with the folio first or last is dropped on its page, whatever its size', () => {
    const even = [item('36 Глава 1. Основы создания AI-приложений с использованием базовых моделей', { x: 56.7, y: 613.9, size: 12 }), ...body(['AI-приложений и сокращают время их выхода на рынок.'])]
    const odd = [item('Восход AI-инженерии 27', { x: 307.8, y: 613.9, size: 12 }), ...body(['основанная на английском языке, будет чаще предсказывать'])]
    const contents = [...row(['10', ' ', 'Оглавление'], { y: 608.2, size: 12 }), ...body(['Текст страницы.'])]
    for (const [items, n] of [[even, 36], [odd, 27], [contents, 10]]) {
      assert.deepEqual(pageBlocks(items, [], FOLIOS, { ...BOOK, pageNumber: n }).map(b => b.kind), ['para'], `page ${n}`)
      // The same page counted 12 pages on in the PDF, with that offset learned: still its head.
      assert.deepEqual(pageBlocks(items, [], { ...FOLIOS, folioOffset: -12 }, { ...BOOK, pageNumber: n + 12 }).map(b => b.kind), ['para'], `page ${n} + 12`)
      // No offset learned, or a number that is not this page's folio: nothing is dropped by position.
      assert.equal(pageBlocks(items, [], PROFILE, { ...BOOK, pageNumber: n }).length, 2, `page ${n}, no offset`)
      assert.equal(pageBlocks(items, [], FOLIOS, { ...BOOK, pageNumber: n + 1 }).length, 2, `page ${n}, other folio`)
    }
    // p21: a section heading right under the running head.
    const section = [
      item('Благодарности 21', { x: 329.4, y: 613.9, size: 12 }),
      item('Использование примеров кода', { x: 56.7, y: 571.8, size: 20 }),
      ...body(['Материалы к книге можно скачать на сайте.'], 550.4),
    ]
    assert.deepEqual(pageBlocks(section, [], FOLIOS, { ...BOOK, pageNumber: 21 }).map(b => [b.kind, text(b)]), [
      ['heading', 'Использование примеров кода'],
      ['para', 'Материалы к книге можно скачать на сайте.'],
    ])
  })

  test('a chapter-opening title survives: below the band, or too large for a running head', () => {
    const opening = [
      item('ГЛАВА 9', { x: 56.9, y: 573.3, size: 18 }),
      item('Оптимизация вывода', { x: 56.7, y: 535.9, size: 26 }),
      ...body(['Новые модели приходят и уходят, но сохраняет актуальность одна цель.'], 463.4),
    ]
    const high = [item('ГЛАВА 3', { x: 56.7, y: 625, size: 18 }), ...body(['Текст главы.'], 560)]
    assert.deepEqual(
      pageBlocks(opening, [], FOLIOS, { ...BOOK, pageNumber: 460 }).map(b => [b.kind, b.level, text(b)]),
      [
        ['heading', 2, 'ГЛАВА 9'],
        ['heading', 1, 'Оптимизация вывода'],
        ['para', undefined, 'Новые модели приходят и уходят, но сохраняет актуальность одна цель.'],
      ],
    )
    assert.deepEqual(pageBlocks(high, [], FOLIOS, { ...BOOK, pageNumber: 3 }).map(b => [b.kind, text(b)]), [
      ['heading', 'ГЛАВА 3'],
      ['para', 'Текст главы.'],
    ])
  })

  // Other layouts (US letter, 11 pt body): a number at the edge of a line is not a folio unless it is this page's.
  test('titles, parts, orphan lines and table rows with a number at the page edge stay', () => {
    const LETTER = { top: 792, bottom: 0 }
    const eleven = { bodySize: 11, headers: [], folioOffset: 0 }
    const text11 = (texts, top) => lines(texts, { top, x: 72, size: 11, leading: 1.2 })
    const cases = [
      ['Chapter 3', [item('Chapter 3', { x: 72, y: 745, size: 14 }), ...text11(['The chapter begins here and runs on.'], 700)], 57],
      ['1 Introduction', [item('1 Introduction', { x: 72, y: 745, size: 12, font: 'Minion-Bold' }), ...text11(['The chapter begins here and runs on.'], 700)], 9],
      ['PART 2', [item('PART 2', { x: 260, y: 750, size: 12 }), ...text11(['Text of the part opening.'], 690)], 151],
      ['models released in 2023', [item('models released in 2023', { x: 72, y: 745, size: 11 }), item('Benchmarks', { x: 72, y: 700, size: 16 }), ...text11(['Text after the heading.'], 670)], 101],
      ['Total 1234', [...text11(['Region A 600', 'Region B 634'], 120), item('Total 1234', { x: 72, y: 60, size: 11 })], 88],
    ]
    for (const [kept, items, n] of cases) {
      const shown = pageBlocks(items, [], eleven, { ...LETTER, pageNumber: n }).map(text).join(' | ')
      assert.ok(shown.includes(kept), `${kept} on page ${n}: ${shown}`)
    }
  })

  // A chapter opening on printed page 1 or 3: its title carries the page's folio at its edge.
  test('a page prints its folio once: a title carrying the same number stays', () => {
    const LETTER = { top: 792, bottom: 0 }
    const bodyText = [0, 1].map(i => item('The chapter begins here and runs on.', { x: 72, y: 700 - i * 12 }))
    const cases = [
      // thesis: front matter i–x on PDF pages 1–12, so "1" is printed on PDF page 13; the folio sits at the foot
      ['1 Introduction', [item('1 Introduction', { x: 72, y: 745, size: 12, font: 'Times-Bold' }), ...bodyText, item('1', { x: 300, y: 40 })], { bodySize: 10, folioOffset: -12 }, 13],
      // a regular-weight chapter label, folio at the foot
      ['Chapter 3', [item('Chapter 3', { x: 72, y: 760, size: 12 }), ...bodyText, item('3', { x: 290, y: 40, size: 9 })], { bodySize: 10, folioOffset: -37 }, 40],
      // no folio printed on the page at all: a bold first line is a numbered title, not a running head
      ['1 Introduction', [item('1 Introduction', { x: 72, y: 745, size: 11, font: 'Times-Bold' }), ...bodyText.map(it => ({ ...it, size: 11 }))], { bodySize: 11, folioOffset: 0 }, 1],
    ]
    for (const [title, items, profile, n] of cases) {
      const shown = pageBlocks(items, [], { headers: [], ...profile }, { ...LETTER, pageNumber: n }).map(text)
      assert.ok(shown.includes(title), `${title} on page ${n}: ${JSON.stringify(shown)}`)
      assert.ok(!shown.some(t => /^\d+$/.test(t)), `the folio line goes on page ${n}: ${JSON.stringify(shown)}`)
    }
  })

  test('the first body line is kept even near the top edge, number or not', () => {
    // A tight top margin: the text starts inside the band, on the normal pitch, with this page's number at its end.
    const items = lines(['в отчете за 2024', 'год приводятся такие данные.'], { top: 640, x: 56.7, leading: 1.21 })
    assert.equal(text(pageBlocks(items, [], FOLIOS, { ...BOOK, pageNumber: 2024 })[0]), 'в отчете за 2024 год приводятся такие данные.')
  })

  test('a folio at the foot is dropped; a footnote at the foot is kept whole', () => {
    const footer = [...body(['Последняя строка текста.'], 120), item('57', { x: 230, y: 30, size: 9 })]
    assert.deepEqual(pageBlocks(footer, [], FOLIOS, { ...BOOK, pageNumber: 57 }).map(text), ['Последняя строка текста.'])
    assert.deepEqual(pageBlocks(footer, [], FOLIOS, { ...BOOK, pageNumber: 58 }).map(text), ['Последняя строка текста.', '57'])
    // p27: a two-line footnote, the second line hanging under the text after the marker.
    const note = [
      ...body(['деляются разработчиками модели.'], 102.7),
      item('1 В других языках, не в английском, один символ кодировки Unicode порой может обо-', { x: 56.7, y: 70.7, size: 9 }),
      item('значаться несколькими токенами.', { x: 65.2, y: 56.7, size: 9 }),
    ]
    assert.deepEqual(pageBlocks(note, [], FOLIOS, { ...BOOK, pageNumber: 27 }).map(text), [
      'деляются разработчиками модели.',
      '1 В других языках, не в английском, один символ кодировки Unicode порой может обозначаться несколькими токенами.',
    ])
  })

  test('a one-line footnote at the foot stays, even when it ends with this page\'s number', () => {
    const notes = [
      ['3 См. https://oreil.ly/G_HBp', 9, 41],
      ['¹See Smith, p. 45', 9, 45],
      ['* First published in 1999', 9, 1999],
      ['2 Квантование рассматривается в главе 7', 9.5, 7], // 9.5 pt under 10 pt body
    ]
    for (const [note, size, n] of notes) {
      const items = [...body(['Текст страницы.'], 300), item(note, { x: 56.7, y: 56.7, size })]
      assert.deepEqual(pageBlocks(items, [], FOLIOS, { ...BOOK, pageNumber: n }).map(text), ['Текст страницы.', note], note)
    }
  })

  test('hostile page boxes, numbers and offsets never throw and drop nothing by position', () => {
    const items = [item('36 Running head', { x: 56.7, y: 613.9, size: 12 }), ...body(['Body.'])]
    for (const box of [{ top: NaN, bottom: 0 }, { top: 0, bottom: 660 }, { top: Infinity, bottom: -Infinity }, { top: '660', bottom: null, pageNumber: {} }]) {
      assert.equal(pageBlocks(items, [], FOLIOS, { pageNumber: 36, ...box }).length, 2, JSON.stringify(box))
    }
    for (const folioOffset of ['0', NaN, 0.5, 1e300, null, {}]) {
      assert.equal(pageBlocks(items, [], { ...PROFILE, folioOffset }, { ...BOOK, pageNumber: 36 }).length, 2, String(folioOffset))
    }
  })
})

describe('contents lines', () => {
  // p10 of the book, item by item as pdf.js gives it (dots shortened).
  const p10 = () => [
    ...row(['10', ' ', 'Оглавление'], { y: 608.2, size: 12 }),
    ...row(['Глава 9', '.', ' ', 'Оптимизация вывода', ' ', '.'.repeat(108), ' ', '460'], { x: 56.7, y: 579.6 }),
    ...row(['Основы оптимизации вывода', ' ', '.'.repeat(102), ' ', '461'], { x: 70.9, y: 566.4 }),
    ...row(['Метрики эффективности вывода', ' ', '.'.repeat(88), ' ', '467'], { x: 85, y: 553.1 }),
    ...row(['Ускорители AI', ' ', '.'.repeat(128), ' ', '475'], { x: 85, y: 539.8 }),
    ...row(['Шаг 1. Расширьте контекст', '.'.repeat(102), ' ', '509'], { x: 85, y: 526.5 }),
    ...row(['Резюме', ' ', '.'.repeat(148), ' ', '1', '91'], { x: 70.9, y: 513.2 }),
  ]

  test('each entry is its own toc block: title without the leader, the page, the level from the indent', () => {
    assert.deepEqual(pageBlocks(p10(), [], FOLIOS, { ...BOOK, pageNumber: 10 }), [
      { kind: 'toc', runs: [{ text: 'Глава 9. Оптимизация вывода' }], page: '460', level: 1 },
      { kind: 'toc', runs: [{ text: 'Основы оптимизации вывода' }], page: '461', level: 2 },
      { kind: 'toc', runs: [{ text: 'Метрики эффективности вывода' }], page: '467', level: 3 },
      { kind: 'toc', runs: [{ text: 'Ускорители AI' }], page: '475', level: 3 },
      { kind: 'toc', runs: [{ text: 'Шаг 1. Расширьте контекст' }], page: '509', level: 3 },
      { kind: 'toc', runs: [{ text: 'Резюме' }], page: '191', level: 2 },
    ])
  })

  /** A row whose last item (the page number) ends at `right`, like a contents column. */
  const ruled = (parts, options, right = 300) => {
    const items = row(parts, options)
    items.at(-1).x = right - items.at(-1).width
    return items
  }

  test('ellipses, middle dots and spaced dots are leaders too; bold stays on the title', () => {
    const items = [
      ...ruled(['Предисловие', '……………', '13'], { y: 500, font: 'Minion-Bold' }),
      ...ruled(['О чем эта книга ', '· · · · · · ·', ' 14'], { y: 487 }),
      ...ruled(['Для кого эта книга', ' . . . . . . . ', 'xvii'], { y: 474 }),
    ]
    assert.deepEqual(
      pageBlocks(items, [], PROFILE, BOOK).map(b => [b.kind, b.runs, b.page]),
      [
        ['toc', [{ text: 'Предисловие', bold: true }], '13'],
        ['toc', [{ text: 'О чем эта книга' }], '14'],
        ['toc', [{ text: 'Для кого эта книга' }], 'xvii'],
      ],
    )
  })

  test('a title that wraps before its leader is one entry', () => {
    const items = [
      ...row(['Три уровня стека AI', ' ', '.'.repeat(119), ' ', '65'], { x: 70.9, y: 600 }),
      ...row(['Сравнение AI-инженерии и проектирования полного стека'], { x: 85, y: 586.8 }),
      ...row(['для веб-приложений', ' ', '.'.repeat(36), ' ', '75'], { x: 99.2, y: 573.6 }),
      ...row(['Резюме', ' ', '.'.repeat(148), ' ', '76'], { x: 56.7, y: 560.4 }),
    ]
    assert.deepEqual(
      pageBlocks(items, [], PROFILE, BOOK).map(b => [b.kind, text(b), b.page, b.level]),
      [
        ['toc', 'Три уровня стека AI', '65', 2],
        ['toc', 'Сравнение AI-инженерии и проектирования полного стека для веб-приложений', '75', 3],
        ['toc', 'Резюме', '76', 1],
      ],
    )
  })

  test('contents lines never merge with prose, before or after; a list or caption shaped entry is still an entry', () => {
    const items = [
      ...body(['В книге десять глав.'], 640),
      ...row(['1. Введение', ' ', '.'.repeat(60), ' ', '5'], { y: 627.9 }),
      ...row(['Рис. 1.1. Пример токенизации', ' ', '.'.repeat(40), ' ', '27'], { y: 615.8 }),
      ...lines(['Дальше идет обычный текст.'], { top: 603.7, x: 56.7 }),
    ]
    assert.deepEqual(
      pageBlocks(items, [], PROFILE, BOOK).map(b => [b.kind, text(b)]),
      [
        ['para', 'В книге десять глав.'],
        ['toc', '1. Введение'],
        ['toc', 'Рис. 1.1. Пример токенизации'],
        ['para', 'Дальше идет обычный текст.'],
      ],
    )
  })

  test('a short leader (3–5 marks) counts only beside another entry ending at the same right edge', () => {
    const alone = [...body(['Текст страницы.'], 600), ...ruled(['Он ждал', ' . . . . ', '12'], { y: 587.9, size: 10 })]
    assert.deepEqual(pageBlocks(alone, [], PROFILE, BOOK).map(b => b.kind), ['para'])
    const pair = [...ruled(['Он ждал', ' . . . ', '12'], { y: 600 }), ...ruled(['Она пришла', ' . . . . . . . . . . ', '14'], { y: 587 })]
    assert.deepEqual(pageBlocks(pair, [], PROFILE, BOOK).map(b => [b.kind, b.page]), [['toc', '12'], ['toc', '14']])
  })

  test('a leader of six marks or more is an entry on its own: the last entry of a contents page', () => {
    const items = [...ruled(['Index', ' ........ ', '523'], { y: 600, size: 10 }), ...body(['Some text after contents.'], 560)]
    assert.deepEqual(pageBlocks(items, [], PROFILE, BOOK).map(b => [b.kind, b.page]), [['toc', '523'], ['para', undefined]])
  })

  // LaTeX: long titles get a short spaced leader, every page number ends at the column's right edge.
  test('contents rows with a short leader, right-aligned with their neighbours, are entries of their own', () => {
    const items = [
      ...ruled(['1.1 Introduction', ' . . . . . . . . . . . . . . . . . . . . ', '3'], { x: 60, y: 600, size: 10 }, 430),
      ...ruled(['1.2 A rather long section title that nearly fills the line', ' . . . . ', '7'], { x: 60, y: 588, size: 10 }, 430),
      ...ruled(['1.3 Background', ' . . . . . . . . . . . . . . . . . . . . ', '9'], { x: 60, y: 576, size: 10 }, 430),
      ...ruled(['1.4 Another long section title that nearly fills the line', ' . . ', '12'], { x: 60, y: 564, size: 10 }, 430),
      ...ruled(['1.5 Methods', ' . . . . . . . . . . . . . . . . . . . . . ', '15'], { x: 60, y: 552, size: 10 }, 430),
    ]
    assert.deepEqual(pageBlocks(items, [], PROFILE, BOOK).map(b => [b.kind, text(b), b.page]), [
      ['toc', '1.1 Introduction', '3'],
      ['toc', '1.2 A rather long section title that nearly fills the line', '7'],
      ['toc', '1.3 Background', '9'],
      // two marks: not a leader, yet its page ends at the column's edge, so it never joins the next entry
      ['para', '1.4 Another long section title that nearly fills the line . . 12', undefined],
      ['toc', '1.5 Methods', '15'],
    ])
  })

  test('a line ending in an ellipsis and a number stays prose, and so does the line before it', () => {
    const cases = [
      ['Each byte holds a value in the range of possible', 'values 0 ... 255'],
      ['She looked at the door and waited.', 'She counted slowly: 1... 2... 3'],
      ['And then, as these stories always do, the story', 'goes on . . . i'],
      ['A loop that prints the numbers once more:', 'for i in range(10): ... 10'],
    ]
    for (const [before, line] of cases) {
      const blocks = pageBlocks(lines([before, line], { top: 600, x: 56.7 }), [], PROFILE, BOOK)
      assert.deepEqual(blocks.map(b => [b.kind, text(b)]), [['para', `${before} ${line}`]], line)
    }
  })

  test('a wrapped entry whose first line looks like a caption, a list item or a heading is one entry', () => {
    const dots = n => '.'.repeat(n)
    const figures = [
      ...row(['Рис. 1.2. Очень длинное описание рисунка, которое не помещается в одну'], { y: 600 }),
      ...row(['строку и переносится', ' ', dots(60), ' ', '12'], { x: 85, y: 586.8 }),
      ...row(['Рис. 1.3. Короткое', ' ', dots(80), ' ', '14'], { y: 573.6 }),
    ]
    assert.deepEqual(pageBlocks(figures, [], PROFILE, BOOK).map(b => [b.kind, text(b), b.page]), [
      ['toc', 'Рис. 1.2. Очень длинное описание рисунка, которое не помещается в одну строку и переносится', '12'],
      ['toc', 'Рис. 1.3. Короткое', '14'],
    ])
    const numbered = [
      ...row(['2. Очень длинное название главы, которое не помещается в одну строку'], { y: 600 }),
      ...row(['и переносится', ' ', dots(70), ' ', '45'], { x: 70.9, y: 586.8 }),
    ]
    assert.deepEqual(pageBlocks(numbered, [], PROFILE, BOOK).map(b => [b.kind, text(b), b.page]), [
      ['toc', '2. Очень длинное название главы, которое не помещается в одну строку и переносится', '45'],
    ])
    const chapter = [
      ...row(['Глава 3. Очень длинное название главы, которое переносится'], { y: 600, size: 12, font: 'Minion-Bold' }),
      ...row(['на вторую строку', ' ', dots(50), ' ', '146'], { y: 585, size: 12, font: 'Minion-Bold' }),
      ...row(['Трудности оценки', ' ', dots(90), ' ', '147'], { x: 70.9, y: 571 }),
    ]
    assert.deepEqual(pageBlocks(chapter, [], PROFILE, BOOK).map(b => [b.kind, text(b), b.page]), [
      ['toc', 'Глава 3. Очень длинное название главы, которое переносится на вторую строку', '146'],
      ['toc', 'Трудности оценки', '147'],
    ])
  })

  test('prose with an ellipsis, or dots without a page, stays prose', () => {
    const items = lines(['Он ждал... и ждал… 12 минут.', 'Заполните поле: ..........'], { top: 600, x: 56.7 })
    assert.deepEqual(pageBlocks(items, [], PROFILE, BOOK).map(b => b.kind), ['para'])
  })

  test('a hostile line of leader dots without a page is read in linear time', () => {
    const dots = Array.from({ length: 10 }, () => '. '.repeat(2500))
    for (const end of ['12x', '1 2 3 4', ' y']) {
      const items = row(['a', ...dots, end], { y: 600 })
      const started = Date.now()
      const blocks = pageBlocks(items, [], PROFILE, BOOK)
      assert.ok(Date.now() - started < 1000, `${end}: ${Date.now() - started} ms`)
      assert.ok(blocks.every(b => b.kind === 'para'), end) // the prose, then the cut notice: it is over MAX_PAGE_CHARS
    }
  })

  test('control characters never survive in a contents title', () => {
    const items = row(['Гла\u001b[31mва\u0007 1', ' ', '.'.repeat(20), ' ', '25'], { y: 600 })
    const [block] = pageBlocks(items, [], PROFILE, BOOK)
    assert.deepEqual(block, { kind: 'toc', runs: [{ text: 'Гла[31mва 1' }], page: '25', level: 1 })
  })
})

describe('paragraph boundaries', () => {
  // p11: a quote, then its attribution set flush right over three lines.
  test('a flush-right attribution is one paragraph; the quote before it stays apart', () => {
    const items = [
      ...body(['Это исчерпывающее, хорошо структурированное руководство по созданию', 'генеративных систем AI. Настоятельно рекомендую.'], 539.1),
      item('Андрей Лопатенко, директор отдела поиска', { x: 213.2, y: 499.4 }),
      item('и лаборатории AI в компании Neuron7', { x: 241.5, y: 487.4 }),
      ...body(['Ценное руководство по созданию масштабируемых продуктов на основе AI.'], 463.2),
    ]
    // full-width lines: widths reach the right margin like the real ones (x + width ≈ 411)
    items[0].width = 411 - 56.7
    items[2].width = 411 - 213.2
    items[3].width = 411 - 241.5
    assert.deepEqual(pageBlocks(items, [], PROFILE, BOOK).map(text), [
      'Это исчерпывающее, хорошо структурированное руководство по созданию генеративных систем AI. Настоятельно рекомендую.',
      'Андрей Лопатенко, директор отдела поиска и лаборатории AI в компании Neuron7',
      'Ценное руководство по созданию масштабируемых продуктов на основе AI.',
    ])
  })

  // p100: list items whose bullets are drawn, not text: indented, 16 pt apart where the text runs at 12.
  test('indented lines set wider apart than the page\'s own pitch are separate items', () => {
    const items = [
      ...body(['На момент написания книги LLM обучались на наборах данных, содержащих', 'триллионы токенов. Корпорация Meta постоянно увеличивала размеры наборов', 'данных, используемых для обучения моделей Llama:'], 273.5),
      item('1,4 трлн токенов для модели Llama 1 (https://arxiv.org/abs/2302.13971);', { x: 70.9, y: 231.9 }),
      item('2 трлн токенов для модели Llama 2 (https://arxiv.org/abs/2307.09288);', { x: 70.9, y: 215.9 }),
      item('15 трлн токенов для модели Llama 3 (https://oreil.ly/vfSQw).', { x: 70.9, y: 199.9 }),
      ...body(['В совокупности набор данных с открытым исходным кодом RedPajama-v2 от', 'компании Together насчитывает 30 трлн токенов.'], 180.6),
    ]
    assert.deepEqual(pageBlocks(items, [], PROFILE, BOOK).map(text), [
      'На момент написания книги LLM обучались на наборах данных, содержащих триллионы токенов. Корпорация Meta постоянно увеличивала размеры наборов данных, используемых для обучения моделей Llama:',
      '1,4 трлн токенов для модели Llama 1 (https://arxiv.org/abs/2302.13971);',
      '2 трлн токенов для модели Llama 2 (https://arxiv.org/abs/2307.09288);',
      '15 трлн токенов для модели Llama 3 (https://oreil.ly/vfSQw).',
      'В совокупности набор данных с открытым исходным кодом RedPajama-v2 от компании Together насчитывает 30 трлн токенов.',
    ])
  })

  // p13: a superscript note mark sits 3.5 pt above its line.
  test('a superscript note mark does not lift its line off the baseline', () => {
    const items = [
      ...lines(['Когда в 2012 году авторы', 'и их коллеги из сверхточной нейронной сети', 'в своей знаковой статье показали,'], { top: 300, x: 70.9, leading: 1.2 }),
      item('1', { x: 300, y: 288 + 3.5, size: 6 }),
    ]
    items[1].text += ' AlexNet'
    const out = linesOf(items)
    assert.deepEqual(out.map(l => l.y), [300, 288, 276])
    assert.equal(pageBlocks(items, [], PROFILE, BOOK).length, 1)
  })

  test('an indented first line after a full line still starts a paragraph', () => {
    const items = [
      ...lines(['Первый абзац, первая строка во всю ширину.', 'и вторая строка тоже во всю ширину полосы.'], { top: 700, x: 72 }),
      ...lines(['Второй абзац с отступом первой строки.', 'продолжение второго абзаца.'], { top: 674, x: 87 }),
    ]
    for (const it of items) it.width = 500 - it.x
    items[3].x = 72
    items[3].width = 428
    assert.deepEqual(pageBlocks(items, [], PROFILE).map(text), [
      'Первый абзац, первая строка во всю ширину. и вторая строка тоже во всю ширину полосы.',
      'Второй абзац с отступом первой строки. продолжение второго абзаца.',
    ])
  })
})

// Review Focus 1: PDF.js gives `""` items with hasEOL between lines; only a page-sized picture makes a page scanned.
describe('scanned', () => {
  const blank = [item('', { y: 700 }), item('', { y: 687 }), item('  ', { y: 674 })]
  const picture = (w, h) => ({ file: '/data/pages/x.rgb', width: 32, height: 32, x: 0, y: h, w, h })

  test('blank items and no picture: not scanned', () => {
    assert.equal(isScanned(blank, [], 612, 792), false)
  })

  test('blank items and only a small picture: not scanned', () => {
    assert.equal(isScanned(blank, [picture(100, 100)], 612, 792), false)
  })

  test('blank items and a page-sized picture: scanned', () => {
    assert.equal(isScanned(blank, [picture(612, 792)], 612, 792), true)
  })

  test('text on the page: never scanned, whatever the picture', () => {
    assert.equal(isScanned([item('Body text.', { y: 700 })], [picture(612, 792)], 612, 792), false)
  })
})

// Part C: a figure caption with no picture above it, on a stretch of the page drawn with paths, marks a figure
// the server renders. Drawings are path (and painted picture) boxes in page coordinates, as pdf-source gives them.
describe('figures drawn with paths', () => {
  const box = (left, bottom, right, top) => ({ left, bottom, right, top })
  // Two body lines, a gap with the drawing, the caption, a line below; the page's running-head rule far above.
  const page = () => [
    ...lines(['First paragraph line one runs long.', 'and ends here.'], { top: 700 }),
    ...lines(['Figure 1. A box.', 'Text below the figure.'], { top: 540 }),
  ]
  const RULE = box(72, 760, 400, 760)

  test('marks a figure between the last line above and the caption, cut to the drawing', () => {
    const blocks = pageBlocks(page(), [], PROFILE, { top: 792, bottom: 0, drawings: [RULE, box(100, 560, 400, 660)] })
    assert.deepEqual(
      blocks.map(b => b.kind),
      ['para', 'figure', 'caption', 'para'],
    )
    assert.equal(blocks[1].alt, 'Figure 1. A box.')
    assert.deepEqual(blocks[1].region, { left: 97, bottom: 557, right: 403, top: 663 })
  })

  test('the region never reaches the line above or the caption', () => {
    // The drawing runs up to just under the line's descenders and below the caption: it is cut at both.
    const blocks = pageBlocks(page(), [], PROFILE, { top: 792, bottom: 0, drawings: [box(60, 400, 420, 683)] })
    const { region } = blocks.find(b => b.kind === 'figure')
    assert.ok(region.top <= 687 - 3, `top ${region.top}`)
    assert.ok(region.bottom >= 540 + 10, `bottom ${region.bottom}`)
    assert.deepEqual([region.left, region.right], [57, 423])
  })

  test('a raster picture right above the caption is the figure: nothing is marked', () => {
    const images = [{ file: '/p/1.rgb', width: 600, height: 300, x: 100, y: 660, w: 300, h: 100 }]
    const blocks = pageBlocks(page(), images, PROFILE, { top: 792, bottom: 0, drawings: [box(100, 560, 400, 660)] })
    assert.deepEqual(
      blocks.map(b => b.kind),
      ['para', 'image', 'caption', 'para'],
    )
  })

  test('no drawing between the line above and the caption: nothing is marked', () => {
    const blocks = pageBlocks(page(), [], PROFILE, { top: 792, bottom: 0, drawings: [RULE, box(72, 300, 400, 300)] })
    assert.deepEqual(
      blocks.map(b => b.kind),
      ['para', 'caption', 'para'],
    )
  })

  test('a table caption marks nothing: a table is text', () => {
    const items = [...lines(['First paragraph line one runs long.', 'and ends here.'], { top: 700 }), ...lines(['Table 1. Numbers.', 'Row one.'], { top: 540 })]
    const blocks = pageBlocks(items, [], PROFILE, { top: 792, bottom: 0, drawings: [box(100, 560, 400, 660)] })
    assert.ok(!blocks.some(b => b.kind === 'figure'))
  })

  test('a gap of about a line marks nothing, even with a rule in it', () => {
    const items = [...lines(['Body line above.'], { top: 700 }), ...lines(['Figure 2. Close.'], { top: 680 })]
    const blocks = pageBlocks(items, [], PROFILE, { top: 792, bottom: 0, drawings: [box(72, 692, 400, 692)] })
    assert.ok(!blocks.some(b => b.kind === 'figure'))
  })

  test('a running head dropped from the text still bounds the region', () => {
    const items = [item('Chapter One · Running Head', { y: 740 }), ...lines(['Рис. 1.1. Пример', 'Text below.'], { top: 580 })]
    const profile = { ...PROFILE, headers: [{ y: 740, text: 'Chapter One · Running Head' }] }
    // The drawing reaches into the head's descenders (738 > 740 − 3): the region still stops below the head.
    const blocks = pageBlocks(items, [], profile, { top: 792, bottom: 0, drawings: [box(100, 600, 400, 738)] })
    assert.deepEqual(
      blocks.map(b => b.kind),
      ['figure', 'caption', 'para'],
    )
    assert.ok(blocks[0].region.top <= 740 - 3)
  })

  test('a drawing that reaches up beside the line above (a QR code by a link) is left out, touching parts too', () => {
    // A short line at 687 with a QR code at its right (as on the test book's p. 27): the modules reaching above its
    // baseline lie wholly above the band (which stops at the descenders, 684); the ones touching them are in it.
    const qr = [box(300, 685, 310, 692), box(311, 684.5, 321, 690), box(300, 676, 310, 683.5), box(311, 671, 321, 679)]
    const blocks = pageBlocks(page(), [], PROFILE, { top: 792, bottom: 0, drawings: [...qr, box(100, 560, 250, 640)] })
    const { region } = blocks.find(b => b.kind === 'figure')
    assert.deepEqual(region, { left: 97, bottom: 557, right: 253, top: 643 })
  })

  test('a figure one line of text tall (the test book p. 27: a tokenized sentence) is still a figure; a rule alone is not', () => {
    const items = [...lines(['First paragraph line one runs long.', 'and ends here.'], { top: 700 }), ...lines(['Figure 1. Tokens.', 'Text below.'], { top: 650 })]
    // Band 684..660; the drawing 668..678 is under two lines tall.
    const blocks = pageBlocks(items, [], PROFILE, { top: 792, bottom: 0, drawings: [box(100, 668, 300, 678)] })
    assert.deepEqual(blocks.find(b => b.kind === 'figure')?.region, { left: 97, bottom: 665, right: 303, top: 681 })
    const ruled = pageBlocks(items, [], PROFILE, { top: 792, bottom: 0, drawings: [box(100, 672, 300, 672.5)] })
    assert.ok(!ruled.some(b => b.kind === 'figure'))
  })

  test('a small raster inside a vector figure is part of the figure: the band is rendered, the icon not shown alone', () => {
    // The test book's p. 34: a 52×60 icon among boxes and arrows drawn with paths.
    const icon = { file: '/p/icon.rgb', width: 52, height: 60, x: 120, y: 640, w: 26, h: 30 }
    const drawings = [box(100, 560, 400, 660), box(120, 610, 146, 640)]
    const blocks = pageBlocks(page(), [icon], PROFILE, { top: 792, bottom: 0, drawings })
    assert.deepEqual(
      blocks.map(b => b.kind),
      ['para', 'figure', 'caption', 'para'],
    )
    assert.deepEqual(blocks[1].region, { left: 97, bottom: 557, right: 403, top: 663 })
  })

  test('labels set as text inside the drawing do not cut the figure down: they go into it', () => {
    const items = [
      ...lines(['First paragraph line one runs long.', 'and ends here.'], { top: 700 }),
      item('Model', { x: 150, y: 640 }),
      item('Prompt', { x: 300, y: 620 }),
      ...lines(['Figure 1. A box.', 'Text below the figure.'], { top: 540 }),
    ]
    const drawings = [box(120, 630, 250, 655), box(280, 610, 400, 635), box(100, 560, 400, 600)]
    const blocks = pageBlocks(items, [], PROFILE, { top: 792, bottom: 0, drawings })
    assert.deepEqual(
      blocks.map(b => b.kind),
      ['para', 'figure', 'caption', 'para'],
    )
    assert.deepEqual(blocks[1].region, { left: 97, bottom: 557, right: 403, top: 658 })
  })

  test('a code line above a figure is never taken for a label', () => {
    const items = [
      ...lines(['First paragraph line one runs long.'], { top: 700 }),
      item('x = 1', { x: 150, y: 640, mono: true, family: 'monospace' }),
      ...lines(['Figure 1. A box.', 'Text below the figure.'], { top: 540 }),
    ]
    const drawings = [box(120, 630, 250, 655), box(100, 560, 400, 600)]
    const blocks = pageBlocks(items, [], PROFILE, { top: 792, bottom: 0, drawings })
    assert.ok(blocks.some(b => b.kind === 'code'))
    assert.ok(blocks.find(b => b.kind === 'figure').region.top <= 640 - 3)
  })

  test('a rule standing apart above or below the drawing (under a running head) is not part of the figure', () => {
    // The test book: running head at 614, its rule at 608, the figure from 590 down.
    const items = [item('Восход AI-инженерии 83', { x: 300, y: 614, size: 12 }), ...lines(['Рис. 2.1. Пример', 'Text below.'], { top: 380 })]
    const drawings = [box(56, 608, 410, 608), box(100, 420, 400, 590), box(56, 395, 410, 395.5)]
    const blocks = pageBlocks(items, [], PROFILE, { top: 660, bottom: 0, drawings })
    const { region } = blocks.find(b => b.kind === 'figure')
    assert.deepEqual(region, { left: 97, bottom: 417, right: 403, top: 593 })
    // A rule close to the drawing is its own edge, and stays.
    const framed = pageBlocks(items, [], PROFILE, { top: 660, bottom: 0, drawings: [box(56, 596, 410, 596), box(100, 420, 400, 590)] })
    assert.equal(framed.find(b => b.kind === 'figure').region.top, 599)
  })

  test('a caption set sideways (a landscape figure) marks nothing: its position says nothing of the figure', () => {
    const items = [...lines(['First paragraph line one runs long.', 'and ends here.'], { top: 700 }), ...lines(['Figure 1. A box.'], { top: 540 }).map(it => ({ ...it, upright: false }))]
    const blocks = pageBlocks(items, [], PROFILE, { top: 792, bottom: 0, drawings: [box(100, 560, 400, 660)] })
    assert.deepEqual(
      blocks.map(b => b.kind),
      ['para', 'caption'],
    )
  })

  test('a caption first on the page: the region goes up to the drawing', () => {
    const items = lines(['Figure 3. Top.', 'Text below.'], { top: 580 })
    const blocks = pageBlocks(items, [], PROFILE, { top: 792, bottom: 0, drawings: [box(100, 600, 400, 700)] })
    assert.deepEqual(blocks[0], { kind: 'figure', alt: 'Figure 3. Top.', region: { left: 97, bottom: 597, right: 403, top: 703 } })
  })

  test('hostile drawings (not finite, inverted) are ignored', () => {
    const drawings = [box(NaN, 560, 400, 660), box(100, 660, 400, 560), null, 'x']
    const blocks = pageBlocks(page(), [], PROFILE, { top: 792, bottom: 0, drawings })
    assert.ok(!blocks.some(b => b.kind === 'figure'))
  })

  test('a cut page keeps its figure marks and does not count them as text', () => {
    const blocks = pageBlocks(page(), [], PROFILE, { top: 792, bottom: 0, drawings: [box(100, 560, 400, 660)], maxChars: 60 })
    assert.equal(blocks[1].kind, 'figure')
    assert.match(text(blocks.at(-1)), /page cut at 60/)
  })
})
