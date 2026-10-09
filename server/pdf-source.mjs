// pdf.js in Node (the vendored legacy build): opens books, reads their outline
// and, page by page, the text items with font flags, the pictures and the boxes
// of what is drawn with paths. Pictures are written as raw RGB files for the
// terminal to read itself; figures drawn with paths are rendered the same way
// when the optional @napi-rs/canvas is installed.

import fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { errorLine } from './text.mjs'

export const MAX_IMAGE_WIDTH = 800
export const MAX_IMAGE_HEIGHT = 4096 // the terminal engine's Image limit
export const MAX_IMAGE_FILES = 200
export const MAX_PAGE_IMAGES = 40 // pictures written for one page: a page never sweeps its own files
const MIN_IMAGE_SIDE = 24
// How long one page may wait, in all, for pictures pdf.js has not delivered; the rest are skipped.
export const PAGE_IMAGE_WAIT_MS = 10_000
const MAX_OUTLINE = 2000

// Figures drawn with paths, rendered when @napi-rs/canvas is there. Rendering is
// CPU work: a page renders a few, each within its own time and the page's budget,
// at most MAX_FIGURE_PIXELS each; the rest are shown as a line.
export const MAX_PAGE_FIGURES = 4
export const FIGURE_RENDER_MS = 5_000
export const FIGURE_PAGE_MS = 10_000
const MAX_FIGURE_PIXELS = 1_500_000
const MAX_FIGURE_SCALE = 3 // pixels per point: sharp enough for any terminal cell
const MAX_DRAWINGS = 5000 // path boxes reported for one page

// pdf.js warns once at import that it cannot render (no canvas, no DOMMatrix,
// no Path2D). Without the canvas nothing is rendered (figures become a line),
// so exactly those are dropped then; with it they mean rendering is broken and
// are shown.
const RENDER_WARNING = /^Warning: Cannot (load "@napi-rs\/canvas"|polyfill `(DOMMatrix|Path2D)`)/

async function importQuietly(href, quiet) {
  const warn = console.warn
  console.warn = (...args) => {
    if (quiet && typeof args[0] === 'string' && RENDER_WARNING.test(args[0])) return
    warn.apply(console, args)
  }
  try {
    return await import(href)
  } finally {
    console.warn = warn
  }
}

let canvasModule = null
/**
 * @napi-rs/canvas, an optional dependency, or null: an installed plugin has no
 * node_modules. Looked up once per process, from this file as pdf.js does from
 * its own; a package that is there but will not load (a binary for another
 * machine) is reported once.
 */
export function loadCanvas() {
  canvasModule ??= (async () => {
    try {
      return createRequire(import.meta.url)('@napi-rs/canvas')
    } catch (error) {
      if (error?.code !== 'MODULE_NOT_FOUND') console.warn(`@napi-rs/canvas did not load, figures are shown as a line: ${errorLine(error)}`)
      return null
    }
  })()
  return canvasModule
}

export function createPdfSource({ vendorDir, imagesDir, maxDocs = 2, loadCanvas: canvasLoader = loadCanvas }) {
  const url = p => pathToFileURL(path.join(vendorDir, p)).href
  let lib = null
  let canvasLib
  // Loaded on first use, never at import: the server checks the Node version first.
  async function pdfjs() {
    if (lib) return lib
    canvasLib ??= await Promise.resolve()
      .then(canvasLoader)
      .catch(() => null)
    const loaded = await importQuietly(url('build/pdf.min.mjs'), !canvasLib)
    loaded.GlobalWorkerOptions.workerSrc = url('build/pdf.worker.min.mjs')
    lib = loaded
    return lib
  }
  // pdf.js renders with the canvas it polyfilled DOMMatrix and Path2D from at import.
  const renderer = () => (canvasLib && typeof globalThis.Path2D === 'function' && typeof globalThis.DOMMatrix === 'function' ? canvasLib : null)
  const docs = new Map() // id -> Promise<Doc>, insertion order = age

  async function load(book) {
    const pdf = await pdfjs()
    const data = new Uint8Array(await fsp.readFile(book.path))
    const task = pdf.getDocument({
      data,
      cMapUrl: url('cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: url('standard_fonts/'),
      wasmUrl: url('wasm/'),
      isEvalSupported: false,
      verbosity: 0,
    })
    return makeDoc(pdf, await task.promise, task, book.id, imagesDir, renderer)
  }

  async function open(book) {
    const known = docs.get(book.id)
    if (known) {
      docs.delete(book.id)
      docs.set(book.id, known)
      return known
    }
    const opened = load(book)
    docs.set(book.id, opened)
    while (docs.size > maxDocs) {
      const [oldest] = docs.keys()
      const doc = docs.get(oldest)
      docs.delete(oldest)
      doc.then(d => d.destroy(), () => {})
    }
    try {
      return await opened
    } catch (error) {
      docs.delete(book.id)
      throw error
    }
  }

  async function closeAll() {
    for (const doc of docs.values()) await doc.then(d => d.destroy(), () => {})
    docs.clear()
  }

  return { open, size: () => docs.size, closeAll }
}

/** The non-empty text items of a page as Items; `fontOf(fontName)` gives pdf.js's font object, if any. */
function itemsOf(textContent, fontOf) {
  const items = []
  for (const it of textContent.items) {
    if (!('str' in it) || it.str === '') continue
    const style = textContent.styles[it.fontName] ?? {}
    const font = fontOf(it.fontName)
    const [a, b, , d] = it.transform
    items.push({
      text: it.str,
      x: it.transform[4],
      y: it.transform[5],
      size: Math.hypot(it.transform[0], it.transform[1]) || it.height || 0,
      width: it.width,
      family: style.fontFamily ?? 'serif',
      font: font?.name ?? '',
      mono: style.fontFamily === 'monospace' || font?.isMonospace === true,
      eol: it.hasEOL === true,
      // Not turned (a landscape figure's labels); a slant (fake italic) is fine: only then does its position place a figure.
      upright: a > 0 && d > 0 && Math.abs(b) <= 0.01 * Math.max(a, d),
    })
  }
  return items
}

function makeDoc(pdf, doc, task, id, imagesDir, renderer) {
  const pages = doc.numPages

  async function outline() {
    const out = []
    async function walk(list, level) {
      for (const entry of list ?? []) {
        if (out.length >= MAX_OUTLINE) return
        let dest = entry.dest
        try {
          if (typeof dest === 'string') dest = await doc.getDestination(dest)
        } catch {
          dest = null
        }
        let page = null
        try {
          if (Array.isArray(dest) && dest[0] != null) {
            page = typeof dest[0] === 'object' ? (await doc.getPageIndex(dest[0])) + 1 : Number(dest[0]) + 1
          }
        } catch {}
        if (Number.isInteger(page) && page >= 1 && page <= pages) out.push({ title: String(entry.title ?? ''), page, level })
        await walk(entry.items, level + 1)
      }
    }
    await walk(await doc.getOutline(), 0)
    return out
  }

  async function pageContent(n) {
    const page = await doc.getPage(n)
    try {
      const ops = await page.getOperatorList() // also loads the fonts into commonObjs
      const tc = await page.getTextContent()
      const fontOf = name => {
        try {
          return page.commonObjs.has(name) ? page.commonObjs.get(name) : null
        } catch {
          return null
        }
      }
      const items = itemsOf(tc, fontOf)
      const images = await imagesOf(pdf, page, ops, `${id}-${n}`, imagesDir)
      const [x0, y0, x1, y1] = page.view
      // What is drawn on the page, cut to the page box: page-blocks finds figures drawn with paths by it.
      const drawings = []
      for (const box of paintsOf(pdf.OPS, ops).drawings) {
        const cut = { left: Math.max(x0, box.left), bottom: Math.max(y0, box.bottom), right: Math.min(x1, box.right), top: Math.min(y1, box.top) }
        if (cut.left <= cut.right && cut.bottom <= cut.top) drawings.push(cut)
      }
      // top and bottom are the page box's edges in the items' coordinates: running heads are found by them.
      return { items, images, drawings, width: x1 - x0, height: y1 - y0, top: y1, bottom: y0 }
    } finally {
      page.cleanup()
    }
  }

  /**
   * Renders `region` of page `n` (page coordinates, as page-blocks marks it) to a
   * raw RGB file within the picture limits; null without a canvas, for a region
   * too small to show, or when the render takes longer than `timeoutMs` (it is
   * cancelled then).
   */
  async function renderFigure(n, region, { timeoutMs = FIGURE_RENDER_MS, index = 0 } = {}) {
    const canvasLib = renderer()
    if (!canvasLib) return null
    const page = await doc.getPage(n)
    let render = null
    try {
      const [x0, y0, x1, y1] = page.view
      const left = Math.max(x0, region.left)
      const right = Math.min(x1, region.right)
      const bottom = Math.max(y0, region.bottom)
      const top = Math.min(y1, region.top)
      if (!(right - left > 0 && top - bottom > 0)) return null
      // On a page turned a quarter, the region's width is drawn upright.
      const [w, h] = page.rotate % 180 === 0 ? [right - left, top - bottom] : [top - bottom, right - left]
      const scale = Math.min(MAX_FIGURE_SCALE, MAX_IMAGE_WIDTH / w, MAX_IMAGE_HEIGHT / h, Math.sqrt(MAX_FIGURE_PIXELS / (w * h)))
      const viewport = page.getViewport({ scale })
      // The region's corners on the rendered page (a rotated page turns them): the canvas shows just that.
      const [ax, ay] = viewport.convertToViewportPoint(left, top)
      const [bx, by] = viewport.convertToViewportPoint(right, bottom)
      const width = Math.min(MAX_IMAGE_WIDTH, Math.floor(Math.abs(bx - ax)))
      const height = Math.min(MAX_IMAGE_HEIGHT, Math.floor(Math.abs(by - ay)))
      if (width < MIN_IMAGE_SIDE || height < MIN_IMAGE_SIDE) return null
      const canvas = canvasLib.createCanvas(width, height)
      const context = canvas.getContext('2d')
      const deadline = Date.now() + timeoutMs
      let late = false
      const task = page.render({ canvasContext: context, viewport, transform: [1, 0, 0, 1, -Math.min(ax, bx), -Math.min(ay, by)], background: 'rgb(255,255,255)' })
      render = task
      // pdf.js draws in slices of about 15 ms; between them the server serves others, and past the deadline it stops.
      task.onContinue = next => {
        if (Date.now() < deadline) return void setImmediate(next)
        late = true
        render = null // cancelled here; the race below settles it
        task.cancel()
      }
      // While pdf.js waits (on its operator list, fonts or pictures) no slice runs: a timer stops that too.
      let timer
      const waited = new Promise(resolve => (timer = setTimeout(() => ((late = true), resolve()), timeoutMs)))
      try {
        await Promise.race([task.promise, waited])
      } catch (error) {
        if (!late) throw error
      } finally {
        clearTimeout(timer)
      }
      if (late) return null
      render = null
      const rgb = toRgb({ width, height, kind: 3, data: context.getImageData(0, 0, width, height).data })
      await fsp.mkdir(imagesDir, { recursive: true, mode: 0o700 })
      const file = path.join(imagesDir, `${id}-${n}-fig${index}.rgb`)
      await fsp.writeFile(file, rgb, { mode: 0o600 })
      await sweepImages(imagesDir, MAX_IMAGE_FILES)
      return { file, width, height }
    } finally {
      // A render still running (past its time) is stopped and settled before the page lets go of its resources.
      if (render) {
        render.cancel()
        await render.promise.catch(() => {})
      }
      page.cleanup()
    }
  }

  async function samples(count) {
    const wanted = Math.min(count, pages)
    const numbers = new Set()
    for (let i = 0; i < wanted; i++) numbers.add(Math.round(1 + (i * (pages - 1)) / Math.max(1, wanted - 1)))
    const out = []
    for (const n of numbers) {
      const page = await doc.getPage(n)
      try {
        out.push({ page: n, items: itemsOf(await page.getTextContent(), () => null) })
      } finally {
        page.cleanup()
      }
    }
    return out
  }

  return { id, pages, outline, pageContent, renderFigure, samples, destroy: () => task.destroy() }
}

/**
 * Page blocks with each `figure` mark of page-blocks made a picture (an image
 * block, alt the caption) or, without a canvas, past MAX_PAGE_FIGURES or the
 * page's time budget, or when the render fails, a `drawing` line. No `figure`
 * is left; a failure never fails the page.
 */
export async function withFigures(doc, n, blocks, { budgetMs = FIGURE_PAGE_MS, renderMs = FIGURE_RENDER_MS } = {}) {
  const deadline = Date.now() + budgetMs
  let rendered = 0
  const out = []
  for (const block of blocks) {
    if (block.kind !== 'figure') {
      out.push(block)
      continue
    }
    let picture = null
    const left = deadline - Date.now()
    if (rendered < MAX_PAGE_FIGURES && left > 0) {
      try {
        picture = await doc.renderFigure(n, block.region, { timeoutMs: Math.min(renderMs, left), index: rendered })
      } catch {
        picture = null
      }
      rendered++
    }
    out.push(picture ? { kind: 'image', file: picture.file, width: picture.width, height: picture.height, alt: block.alt } : { kind: 'drawing', alt: block.alt })
  }
  return out
}

// ---------------------------------------------------------------- images

/** m then t, as PDF's `cm` concatenates (pdf.js Util.transform(m, t)). */
function multiply(m, t) {
  return [
    m[0] * t[0] + m[2] * t[1],
    m[1] * t[0] + m[3] * t[1],
    m[0] * t[2] + m[2] * t[3],
    m[1] * t[2] + m[3] * t[3],
    m[0] * t[4] + m[2] * t[5] + m[4],
    m[1] * t[4] + m[3] * t[5] + m[5],
  ]
}

/** The box of [x0, y0, x1, y1] under the transform m, in page coordinates. */
function boxUnder(m, x0, y0, x1, y1) {
  const xs = []
  const ys = []
  for (const [x, y] of [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ]) {
    xs.push(m[0] * x + m[2] * y + m[4])
    ys.push(m[1] * x + m[3] * y + m[5])
  }
  return { left: Math.min(...xs), bottom: Math.min(...ys), right: Math.max(...xs), top: Math.max(...ys) }
}

/**
 * Walks the page's operators with the transform stack: the pictures painted
 * (each with its source and box, for imagesOf) and the boxes of everything
 * drawn — paths that are stroked or filled (not those that only clip) and
 * pictures of any size — at most MAX_DRAWINGS.
 */
export function paintsOf(OPS, ops) {
  const painting = new Set([OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke])
  const pictureOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintSolidColorImageMask])
  const stack = []
  let ctm = [1, 0, 0, 1, 0, 0]
  const pictures = []
  const drawings = []
  const draw = box => {
    if (drawings.length < MAX_DRAWINGS && [box.left, box.bottom, box.right, box.top].every(Number.isFinite)) drawings.push(box)
  }
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i]
    const args = ops.argsArray[i]
    if (fn === OPS.save) stack.push(ctm)
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm
    else if (fn === OPS.transform) ctm = multiply(ctm, args)
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm)
      if (Array.isArray(args[0])) ctm = multiply(ctm, args[0])
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm
    else if (fn === OPS.constructPath) {
      // [paint op, path data, [minX, minY, maxX, maxY]] in the current user space.
      const mm = args?.[2]
      if (painting.has(args?.[0]) && mm && mm.length >= 4) draw(boxUnder(ctm, mm[0], mm[1], mm[2], mm[3]))
    } else if (pictureOps.has(fn)) {
      draw(boxUnder(ctm, 0, 0, 1, 1))
      if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
        const w = Math.hypot(ctm[0], ctm[1])
        const h = Math.hypot(ctm[2], ctm[3])
        pictures.push({ source: args[0], x: ctm[4] + Math.min(0, ctm[2]), y: ctm[5] + Math.max(ctm[3], 0) + Math.max(ctm[1], 0), w, h })
      }
    }
  }
  return { pictures, drawings }
}

// Writes each picture of the page worth showing as raw RGB, with its box on the
// page (see paintsOf). The box math is for unrotated images (the common case);
// a rotated image lands in the wrong place among the lines and is out of scope.
// The page waits at most `waitMs` in all for pictures pdf.js is slow to deliver;
// once that is spent, the pictures left are skipped and those already written
// are kept.
export async function imagesOf(pdf, page, ops, prefix, imagesDir, { waitMs = PAGE_IMAGE_WAIT_MS } = {}) {
  const found = paintsOf(pdf.OPS, ops).pictures
  const images = []
  const deadline = Date.now() + waitMs
  for (const [k, hit] of found.entries()) {
    if (images.length >= MAX_PAGE_IMAGES) break
    let img = hit.source
    if (typeof img === 'string') {
      const left = deadline - Date.now()
      // Once the budget is spent only pictures pdf.js already holds are taken; inline ones still come.
      img = left > 0 ? await imageObject(page, img, left) : heldImage(page, img)
    }
    if (!img || !img.data || img.width < MIN_IMAGE_SIDE || img.height < MIN_IMAGE_SIDE) continue
    const rgb = toRgb(img)
    if (!rgb) continue
    const scaled = downscale(rgb, img.width, img.height, MAX_IMAGE_WIDTH)
    await fsp.mkdir(imagesDir, { recursive: true, mode: 0o700 })
    const file = path.join(imagesDir, `${prefix}-${k}.rgb`)
    await fsp.writeFile(file, scaled.rgb, { mode: 0o600 })
    images.push({ file, width: scaled.width, height: scaled.height, x: hit.x, y: hit.y, w: hit.w, h: hit.h })
  }
  if (images.length > 0) await sweepImages(imagesDir, MAX_IMAGE_FILES)
  return images
}

// pdf.js keeps an image used on several pages in the document's commonObjs under
// a `g_` id, and the rest in the page's objs; asking the wrong one never answers.
// A picture pdf.js never delivers is given up after `waitMs`: what is left of the
// page's budget, so it cannot hold the page up.
const objsOf = (page, id) => (id.startsWith('g_') ? page.commonObjs : page.objs)

/** A picture pdf.js has already decoded, without waiting; null otherwise. */
function heldImage(page, id) {
  const objs = objsOf(page, id)
  try {
    return objs.has(id) ? objs.get(id) : null
  } catch {
    return null
  }
}

function imageObject(page, id, waitMs) {
  const objs = objsOf(page, id)
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), waitMs)
    objs.get(id, img => {
      clearTimeout(timer)
      resolve(img)
    })
  })
}

/** pdf.js image data (kind 1 gray 1-bit, 2 RGB, 3 RGBA) as packed RGB, or null. */
export function toRgb(img) {
  const { width, height, kind, data } = img
  const out = Buffer.alloc(width * height * 3)
  if (kind === 2) {
    Buffer.from(data.buffer, data.byteOffset, Math.min(data.byteLength, out.length)).copy(out)
  } else if (kind === 3) {
    for (let p = 0, q = 0; q < out.length; p += 4, q += 3) {
      out[q] = data[p]
      out[q + 1] = data[p + 1]
      out[q + 2] = data[p + 2]
    }
  } else if (kind === 1) {
    const rowBytes = (width + 7) >> 3
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1
        const q = (y * width + x) * 3
        out[q] = out[q + 1] = out[q + 2] = bit ? 255 : 0
      }
    }
  } else {
    return null
  }
  return out
}

/** Box-averages `rgb` by an integer factor until it is at most `maxWidth` wide and MAX_IMAGE_HEIGHT tall. */
export function downscale(rgb, width, height, maxWidth) {
  const f = Math.max(Math.ceil(width / maxWidth), Math.ceil(height / MAX_IMAGE_HEIGHT))
  if (f <= 1) return { rgb, width, height }
  const w = Math.max(1, Math.floor(width / f))
  const h = Math.max(1, Math.floor(height / f))
  const out = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let dy = 0; dy < f && y * f + dy < height; dy++) {
        for (let dx = 0; dx < f && x * f + dx < width; dx++) {
          const p = ((y * f + dy) * width + (x * f + dx)) * 3
          r += rgb[p]
          g += rgb[p + 1]
          b += rgb[p + 2]
          n++
        }
      }
      const q = (y * w + x) * 3
      out[q] = Math.round(r / n)
      out[q + 1] = Math.round(g / n)
      out[q + 2] = Math.round(b / n)
    }
  }
  return { rgb: out, width: w, height: h }
}

/** Removes the oldest files of `dir` until at most `max` remain; a missing dir is fine. */
export async function sweepImages(dir, max) {
  let names
  try {
    names = await fsp.readdir(dir)
  } catch {
    return
  }
  const files = []
  for (const name of names) {
    try {
      const stat = await fsp.stat(path.join(dir, name))
      if (stat.isFile()) files.push({ name, mtime: stat.mtimeMs })
    } catch {}
  }
  files.sort((a, b) => a.mtime - b.mtime)
  for (const file of files.slice(0, Math.max(0, files.length - max))) {
    await fsp.rm(path.join(dir, file.name), { force: true })
  }
}
