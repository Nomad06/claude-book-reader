// pdf.js in Node (the vendored legacy build): opens books, reads their outline
// and, page by page, the text items with font flags and the pictures. Pictures
// are written as raw RGB files for the terminal to read itself.

import fsp from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const MAX_IMAGE_WIDTH = 800
export const MAX_IMAGE_HEIGHT = 4096 // the terminal engine's Image limit
export const MAX_IMAGE_FILES = 200
export const MAX_PAGE_IMAGES = 40 // pictures written for one page: a page never sweeps its own files
const MIN_IMAGE_SIDE = 24
const IMAGE_WAIT_MS = 10_000
const MAX_OUTLINE = 2000

// pdf.js warns once at import that it cannot render (no canvas, no DOMMatrix,
// no Path2D). Text extraction never renders, so exactly those are dropped.
const RENDER_WARNING = /^Warning: Cannot (load "@napi-rs\/canvas"|polyfill `(DOMMatrix|Path2D)`)/

async function importQuietly(href) {
  const warn = console.warn
  console.warn = (...args) => {
    if (typeof args[0] === 'string' && RENDER_WARNING.test(args[0])) return
    warn.apply(console, args)
  }
  try {
    return await import(href)
  } finally {
    console.warn = warn
  }
}

export function createPdfSource({ vendorDir, imagesDir, maxDocs = 2 }) {
  const url = p => pathToFileURL(path.join(vendorDir, p)).href
  let lib = null
  // Loaded on first use, never at import: the server checks the Node version first.
  async function pdfjs() {
    if (lib) return lib
    const loaded = await importQuietly(url('build/pdf.min.mjs'))
    loaded.GlobalWorkerOptions.workerSrc = url('build/pdf.worker.min.mjs')
    lib = loaded
    return lib
  }
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
    return makeDoc(pdf, await task.promise, task, book.id, imagesDir)
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
    })
  }
  return items
}

function makeDoc(pdf, doc, task, id, imagesDir) {
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
      return { items, images, width: x1 - x0, height: y1 - y0 }
    } finally {
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
        out.push(itemsOf(await page.getTextContent(), () => null))
      } finally {
        page.cleanup()
      }
    }
    return out
  }

  return { id, pages, outline, pageContent, samples, destroy: () => task.destroy() }
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

// Walks the page's operators with the transform stack, so each image gets its
// box on the page; writes each picture worth showing as raw RGB. The box math
// is for unrotated images (the common case); a rotated image lands in the
// wrong place among the lines and is out of scope.
async function imagesOf(pdf, page, ops, prefix, imagesDir) {
  const OPS = pdf.OPS
  const stack = []
  let ctm = [1, 0, 0, 1, 0, 0]
  const found = []
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
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      const w = Math.hypot(ctm[0], ctm[1])
      const h = Math.hypot(ctm[2], ctm[3])
      found.push({ source: args[0], x: ctm[4] + Math.min(0, ctm[2]), y: ctm[5] + Math.max(ctm[3], 0) + Math.max(ctm[1], 0), w, h })
    }
  }
  const images = []
  for (const [k, hit] of found.entries()) {
    if (images.length >= MAX_PAGE_IMAGES) break
    const img = typeof hit.source === 'string' ? await imageObject(page, hit.source) : hit.source
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
// A picture pdf.js never delivers is skipped after IMAGE_WAIT_MS, so it cannot
// hold the page up.
function imageObject(page, id) {
  const objs = id.startsWith('g_') ? page.commonObjs : page.objs
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), IMAGE_WAIT_MS)
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
