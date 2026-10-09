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

describe('running heads by position', () => {
  test('a running head with the folio first or last is dropped on its page, whatever its size', () => {
    const even = [item('36 Глава 1. Основы создания AI-приложений с использованием базовых моделей', { x: 56.7, y: 613.9, size: 12 }), ...body(['AI-приложений и сокращают время их выхода на рынок.'])]
    const odd = [item('Восход AI-инженерии 27', { x: 307.8, y: 613.9, size: 12 }), ...body(['основанная на английском языке, будет чаще предсказывать'])]
    const contents = [...row(['10', ' ', 'Оглавление'], { y: 608.2, size: 12 }), ...body(['Текст страницы.'])]
    for (const [items, n] of [[even, 36], [odd, 27], [contents, 10]]) {
      assert.deepEqual(pageBlocks(items, [], PROFILE, { ...BOOK, pageNumber: n }).map(b => b.kind), ['para'], `page ${n}`)
      // The folio need not be the PDF's page number (front matter counts apart): still a running head.
      assert.deepEqual(pageBlocks(items, [], PROFILE, BOOK).map(b => b.kind), ['para'], `page ${n} without its number`)
    }
    // p21: a section heading right under the running head.
    const section = [
      item('Благодарности 21', { x: 329.4, y: 613.9, size: 12 }),
      item('Использование примеров кода', { x: 56.7, y: 571.8, size: 20 }),
      ...body(['Материалы к книге можно скачать на сайте.'], 550.4),
    ]
    assert.deepEqual(pageBlocks(section, [], PROFILE, { ...BOOK, pageNumber: 21 }).map(b => [b.kind, text(b)]), [
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
      pageBlocks(opening, [], PROFILE, { ...BOOK, pageNumber: 460 }).map(b => [b.kind, b.level, text(b)]),
      [
        ['heading', 2, 'ГЛАВА 9'],
        ['heading', 1, 'Оптимизация вывода'],
        ['para', undefined, 'Новые модели приходят и уходят, но сохраняет актуальность одна цель.'],
      ],
    )
    assert.deepEqual(pageBlocks(high, [], PROFILE, { ...BOOK, pageNumber: 3 }).map(b => [b.kind, text(b)]), [
      ['heading', 'ГЛАВА 3'],
      ['para', 'Текст главы.'],
    ])
  })

  test('the first body line is kept even near the top edge, number or not', () => {
    // A tight top margin: the text starts inside the band, on the normal pitch, with a number at its end.
    const items = lines(['в отчете за 2024', 'год приводятся такие данные.'], { top: 640, x: 56.7, leading: 1.21 })
    assert.equal(text(pageBlocks(items, [], PROFILE, { ...BOOK, pageNumber: 2024 })[0]), 'в отчете за 2024 год приводятся такие данные.')
  })

  test('a folio at the foot is dropped; a footnote at the foot is kept whole', () => {
    const footer = [...body(['Последняя строка текста.'], 120), item('57', { x: 230, y: 30, size: 9 })]
    assert.deepEqual(pageBlocks(footer, [], PROFILE, { ...BOOK, pageNumber: 57 }).map(text), ['Последняя строка текста.'])
    assert.deepEqual(pageBlocks(footer, [], PROFILE, BOOK).map(text), ['Последняя строка текста.'])
    // p27: a two-line footnote, the second line hanging under the text after the marker.
    const note = [
      ...body(['деляются разработчиками модели.'], 102.7),
      item('1 В других языках, не в английском, один символ кодировки Unicode порой может обо-', { x: 56.7, y: 70.7, size: 9 }),
      item('значаться несколькими токенами.', { x: 65.2, y: 56.7, size: 9 }),
    ]
    assert.deepEqual(pageBlocks(note, [], PROFILE, { ...BOOK, pageNumber: 27 }).map(text), [
      'деляются разработчиками модели.',
      '1 В других языках, не в английском, один символ кодировки Unicode порой может обозначаться несколькими токенами.',
    ])
  })

  test('a one-line footnote at the foot is not taken for a footer', () => {
    const items = [...body(['Текст страницы.'], 300), item('3 См. https://oreil.ly/G_HBp', { x: 56.7, y: 56.7, size: 9 })]
    assert.deepEqual(pageBlocks(items, [], PROFILE, { ...BOOK, pageNumber: 41 }).map(text), ['Текст страницы.', '3 См. https://oreil.ly/G_HBp'])
  })

  test('hostile page boxes and numbers never throw and drop nothing by position', () => {
    const items = [item('36 Running head', { x: 56.7, y: 613.9, size: 12 }), ...body(['Body.'])]
    for (const box of [{ top: NaN, bottom: 0 }, { top: 0, bottom: 660 }, { top: Infinity, bottom: -Infinity }, { top: '660', bottom: null, pageNumber: {} }]) {
      assert.equal(pageBlocks(items, [], PROFILE, box).length, 2, JSON.stringify(box))
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
    assert.deepEqual(pageBlocks(p10(), [], PROFILE, { ...BOOK, pageNumber: 10 }), [
      { kind: 'toc', runs: [{ text: 'Глава 9. Оптимизация вывода' }], page: '460', level: 1 },
      { kind: 'toc', runs: [{ text: 'Основы оптимизации вывода' }], page: '461', level: 2 },
      { kind: 'toc', runs: [{ text: 'Метрики эффективности вывода' }], page: '467', level: 3 },
      { kind: 'toc', runs: [{ text: 'Ускорители AI' }], page: '475', level: 3 },
      { kind: 'toc', runs: [{ text: 'Шаг 1. Расширьте контекст' }], page: '509', level: 3 },
      { kind: 'toc', runs: [{ text: 'Резюме' }], page: '191', level: 2 },
    ])
  })

  test('ellipses, middle dots and spaced dots are leaders too; bold stays on the title', () => {
    const items = [
      ...row(['Предисловие', '……………', '13'], { y: 500, font: 'Minion-Bold' }),
      ...row(['О чем эта книга ', '· · · · · · ·', ' 14'], { y: 487 }),
      ...row(['Для кого эта книга', ' . . . . . . . ', 'xvii'], { y: 474 }),
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
