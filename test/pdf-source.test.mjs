// Tests of server/pdf-source.mjs against the vendored pdf.js legacy build.
//
//   node --test test/pdf-source.test.mjs

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { MAX_IMAGE_HEIGHT, MAX_PAGE_IMAGES, MAX_IMAGE_WIDTH, createPdfSource, downscale, sweepImages, toRgb } from '../server/pdf-source.mjs'
import { cleanRun, errorLine, plainText } from '../server/text.mjs'
import { shared } from '../server/shared.mjs'
import { TEXT, buildPdf, buildScannedPdf } from './pdf-fixture.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR = path.join(ROOT, 'viewer', 'vendor', 'pdfjs')

let dir
let source

async function write(name, bytes) {
  const file = path.join(dir, name)
  await fs.writeFile(file, bytes)
  return { id: name.replace(/\W/g, '').slice(0, 12).padEnd(12, '0'), path: file }
}

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'book-reader-pdf-'))
  source = createPdfSource({ vendorDir: VENDOR, imagesDir: path.join(dir, 'pages'), maxDocs: 2 })
})

after(async () => {
  await source.closeAll()
  await fs.rm(dir, { recursive: true, force: true })
})

describe('text helpers', () => {
  test('plainText makes one clean line', () => {
    assert.equal(plainText('a\r\n\tb\u001b[31m  c\u0085 '), 'a b[31m c')
  })

  test('cleanRun drops control characters and keeps spacing, newlines and tabs', () => {
    assert.equal(cleanRun('  a\u001b[0m\tb\n  c\u0007\u0085'), '  a[0m\tb\n  c')
  })

  // Bidi controls reorder what the terminal draws (Trojan Source); the marks U+200E/F are kept.
  const BIDI = '\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069'

  test('plainText drops the bidi embedding, override and isolate controls', () => {
    assert.equal(plainText(`ab${BIDI}c \u202edcba\u202c`), 'abc dcba')
    assert.equal(plainText('a\u200eb\u200f'), 'a\u200eb\u200f')
  })

  test('cleanRun drops the bidi controls and keeps spacing', () => {
    assert.equal(cleanRun(`  a${BIDI}\tb `), '  a\tb ')
    assert.equal(cleanRun('a\u200eb'), 'a\u200eb')
  })
})

describe('documents', () => {
  test('opens a PDF and counts its pages', async () => {
    const doc = await source.open(await write('text.pdf', buildPdf(TEXT)))
    assert.equal(doc.pages, 2)
  })

  test('a missing file rejects with ENOENT', async () => {
    await assert.rejects(source.open({ id: 'missing000000', path: path.join(dir, 'nope.pdf') }), { code: 'ENOENT' })
  })

  test('a file that is not a PDF rejects with a message', async () => {
    await assert.rejects(source.open(await write('junk.pdf', Buffer.from('not a pdf'))), /Invalid PDF|PDF/)
  })

  test('keeps at most maxDocs documents open, oldest closed first', async () => {
    await source.open(await write('a.pdf', buildPdf(TEXT)))
    await source.open(await write('b.pdf', buildPdf(TEXT)))
    await source.open(await write('c.pdf', buildPdf(TEXT)))
    assert.equal(source.size(), 2)
  })
})

describe('outline', () => {
  test('resolves entries to page numbers', async () => {
    const doc = await source.open(await write('outline.pdf', buildPdf(TEXT)))
    assert.deepEqual(await doc.outline(), [
      { title: 'Chapter One', page: 1, level: 0 },
      { title: 'Chapter Two', page: 2, level: 0 },
    ])
  })

  test('an outline entry without a destination is dropped', async () => {
    const pages = [{ ...TEXT[0], outline: 'NOWHERE' }, TEXT[1]]
    const doc = await source.open(await write('nowhere.pdf', buildPdf(pages)))
    assert.deepEqual(await doc.outline(), [{ title: 'Chapter Two', page: 2, level: 0 }])
  })
})

describe('page content', () => {
  test('text items carry position, size, family and no empty strings', async () => {
    const doc = await source.open(await write('items.pdf', buildPdf(TEXT)))
    const { items, images, width, height } = await doc.pageContent(1)
    assert.equal(images.length, 0)
    assert.deepEqual([width, height], [612, 792])
    assert.ok(items.every(it => it.text !== ''))
    const [heading, body] = items
    assert.equal(heading.text, 'Chapter One')
    assert.equal(Math.round(heading.size), 18)
    assert.equal(heading.family, 'sans-serif')
    assert.equal(heading.mono, false)
    assert.equal(Math.round(heading.x), 72)
    assert.equal(Math.round(heading.y), 720)
    assert.equal(body.text, 'Hello world, this is body text.')
    assert.equal(body.eol, true)
  })

  test('Courier text is monospace', async () => {
    const doc = await source.open(await write('code.pdf', buildPdf(TEXT)))
    const { items } = await doc.pageContent(2)
    assert.equal(items[0].text, 'const x = 1')
    assert.equal(items[0].mono, true)
    assert.equal(items[0].family, 'monospace')
    assert.equal(Math.round(items[0].x), 96)
    assert.equal(items.at(-1).mono, false)
  })

  test('a page outside the book throws', async () => {
    const doc = await source.open(await write('range.pdf', buildPdf(TEXT)))
    await assert.rejects(doc.pageContent(3))
  })

  test('samples spread across the book', async () => {
    const doc = await source.open(await write('samples.pdf', buildPdf(TEXT)))
    const samples = await doc.samples(12)
    assert.equal(samples.length, 2)
    assert.equal(samples[0][0].text, 'Chapter One')
  })
})

describe('images', () => {
  test('a scanned page has no text and one page-sized image written as raw RGB', async () => {
    const doc = await source.open(await write('scan.pdf', buildScannedPdf()))
    const { items, images, width, height } = await doc.pageContent(1)
    assert.equal(items.length, 0)
    assert.equal(images.length, 1)
    const [img] = images
    assert.deepEqual([img.width, img.height], [32, 32])
    assert.deepEqual([img.x, Math.round(img.y), img.w, img.h], [0, height, width, height])
    assert.ok(img.file.startsWith(path.join(dir, 'pages')))
    assert.equal((await fs.stat(img.file)).size, 32 * 32 * 3)
    assert.equal((await fs.readFile(img.file))[0], 0x80)
  })

  test('an image shared by many pages is read on every page', async () => {
    // pdf.js keeps an image used on several pages in commonObjs, not page.objs.
    const doc = await source.open(await write('shared.pdf', buildScannedPdf({ pages: 4 })))
    for (let n = 1; n <= 4; n++) {
      let timer
      const { images } = await Promise.race([
        doc.pageContent(n),
        new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`page ${n} never answered`)), 5000))),
      ]).finally(() => clearTimeout(timer))
      assert.equal(images.length, 1, `page ${n}`)
      assert.equal((await fs.stat(images[0].file)).size, 32 * 32 * 3)
    }
  })

  test('toRgb handles RGB, RGBA and 1-bit gray', () => {
    assert.deepEqual([...toRgb({ kind: 2, width: 1, height: 1, data: Uint8Array.of(1, 2, 3) })], [1, 2, 3])
    assert.deepEqual([...toRgb({ kind: 3, width: 1, height: 1, data: Uint8Array.of(1, 2, 3, 255) })], [1, 2, 3])
    // two pixels, bits 1 0 → white, black
    assert.deepEqual([...toRgb({ kind: 1, width: 2, height: 1, data: Uint8Array.of(0b10000000) })], [255, 255, 255, 0, 0, 0])
    assert.equal(toRgb({ kind: 9, width: 1, height: 1, data: Uint8Array.of(0) }), null)
  })

  test('downscale averages boxes to at most maxWidth', () => {
    const rgb = Buffer.from([0, 0, 0, 100, 100, 100, 200, 200, 200, 50, 50, 50]) // 2×2, maxWidth 1 → 1×1
    assert.deepEqual(downscale(rgb, 2, 2, 1), { rgb: Buffer.from([88, 88, 88]), width: 1, height: 1 }) // (0+100+200+50)/4 = 87.5, rounded
    const same = downscale(rgb, 2, 2, MAX_IMAGE_WIDTH)
    assert.equal(same.rgb, rgb)
  })

  test('downscale also keeps a tall image within the height limit', () => {
    const width = 4
    const height = MAX_IMAGE_HEIGHT * 2
    const tall = downscale(Buffer.alloc(width * height * 3, 7), width, height, MAX_IMAGE_WIDTH)
    assert.deepEqual([tall.width, tall.height], [2, MAX_IMAGE_HEIGHT])
    assert.equal(tall.rgb.length, 2 * MAX_IMAGE_HEIGHT * 3)
    assert.equal(tall.rgb[0], 7)
  })

  test('sweepImages keeps the newest max files', async () => {
    const sweep = path.join(dir, 'sweep')
    await fs.mkdir(sweep)
    for (const n of [1, 2, 3]) {
      await fs.writeFile(path.join(sweep, `${n}.rgb`), 'x')
      await fs.utimes(path.join(sweep, `${n}.rgb`), n, n)
    }
    await sweepImages(sweep, 2)
    assert.deepEqual((await fs.readdir(sweep)).sort(), ['2.rgb', '3.rgb'])
    await sweepImages(sweep, 0)
    assert.deepEqual(await fs.readdir(sweep), [])
  })
})

describe('bounds', () => {
  test('a page with many pictures writes at most MAX_PAGE_IMAGES files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'book-reader-many-'))
    try {
      const file = path.join(dir, 'many.pdf')
      await fs.writeFile(file, buildScannedPdf({ copies: MAX_PAGE_IMAGES + 20 }))
      const source = createPdfSource({ vendorDir: VENDOR, imagesDir: path.join(dir, 'images') })
      try {
        const content = await (await source.open({ id: 'many', path: file })).pageContent(1)
        assert.equal(content.images.length, MAX_PAGE_IMAGES)
        assert.equal((await fs.readdir(path.join(dir, 'images'))).length, MAX_PAGE_IMAGES)
      } finally {
        await source.closeAll()
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test('concurrent callers of one key share one run', async () => {
    const map = new Map()
    let runs = 0
    const work = async () => (runs++, await new Promise(r => setTimeout(r, 20)), 'done')
    const all = await Promise.all([shared(map, 'a', work), shared(map, 'a', work), shared(map, 'a', work)])
    assert.deepEqual(all, ['done', 'done', 'done'])
    assert.equal(runs, 1)
    assert.equal(map.size, 0)
    await shared(map, 'a', work)
    assert.equal(runs, 2)
  })

  test('an error message is one short plain line', () => {
    const line = errorLine(new Error('bad \u001b[2J\nbytes ' + 'x'.repeat(1000)))
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(line))
    assert.equal(line.length, 300)
  })
})
