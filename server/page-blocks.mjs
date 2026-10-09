// Pure: pdf.js text items of one page → blocks the dock draws (headings,
// paragraphs, lists, captions, code, images). Heuristics on size, font and
// position; no pdf.js here, so this is tested on plain data.

import { cleanRun } from './text.mjs'

export const MAX_PAGE_CHARS = 20000
const HEADING_RATIO = 1.15
const LIST_MARK = /^(?:[•◦▪●\-–—]|\d{1,3}[.)])\s+\S/
const CAPTION = /^(?:Figure|Fig\.|Table|Listing|Example|Рис\.|Рисунок|Таблица|Листинг|Пример)\s+\d/i
const BOLD = /bold|semibold|black|heavy/i
const ITALIC = /italic|oblique/i

const round = n => Math.round(n * 2) / 2

// ---------------------------------------------------------------- lines

/** Items grouped by baseline (top of the page first), each line's items left to right. */
export function linesOf(items) {
  const sorted = items.filter(it => it.text !== '').sort((a, b) => b.y - a.y || a.x - b.x)
  const lines = []
  for (const it of sorted) {
    const last = lines.at(-1)
    if (last && Math.abs(last.y - it.y) <= 0.4 * Math.max(it.size, last.size)) last.items.push(it)
    else lines.push({ y: it.y, size: it.size, items: [it] })
  }
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x)
    line.x = line.items[0].x
    line.right = Math.max(...line.items.map(it => it.x + it.width))
    line.size = Math.max(...line.items.map(it => it.size))
    line.mono = line.items.every(it => it.mono)
    line.text = joinItems(line.items)
  }
  return lines
}

/** The line's text; a gap wider than a fifth of the size between items becomes a space. */
function joinItems(items) {
  let text = ''
  let end = null
  for (const it of items) {
    if (end !== null && it.x - end > 0.2 * it.size && !text.endsWith(' ') && !it.text.startsWith(' ')) text += ' '
    text += it.text
    end = it.x + it.width
  }
  return text
}

// ---------------------------------------------------------------- calibration

/** Sampled pages → the body size and the running header/footer lines to drop. */
export function calibrate(samples) {
  const sizes = new Map()
  const seenOn = new Map()
  for (const items of samples) {
    for (const it of items) {
      const s = round(it.size)
      sizes.set(s, (sizes.get(s) ?? 0) + it.text.length)
    }
    const onThisPage = new Set()
    for (const line of linesOf(items)) {
      const key = headerKey(line)
      if (!key || onThisPage.has(key)) continue
      onThisPage.add(key)
      seenOn.set(key, (seenOn.get(key) ?? 0) + 1)
    }
  }
  let bodySize = 10
  let best = -1
  for (const [s, n] of sizes) {
    if (n > best) {
      best = n
      bodySize = s
    }
  }
  const headers = []
  if (samples.length >= 2) {
    const floor = Math.max(2, Math.ceil(samples.length / 2))
    for (const [key, n] of seenOn) {
      if (n < floor) continue
      const at = key.indexOf('|')
      headers.push({ y: Number(key.slice(0, at)), text: key.slice(at + 1) })
    }
  }
  return { bodySize, headers }
}

function headerKey(line) {
  const text = line.text.replace(/\d+/g, '#').trim()
  return text ? `${Math.round(line.y)}|${text}` : null
}

function isHeader(line, headers) {
  const key = headerKey(line)
  return key !== null && headers.some(h => `${h.y}|${h.text}` === key)
}

// ---------------------------------------------------------------- blocks

export function pageBlocks(items, images, profile, { maxChars = MAX_PAGE_CHARS } = {}) {
  const body = profile?.bodySize ?? 10
  const headers = profile?.headers ?? []
  const lines = linesOf(items).filter(line => line.text.trim() !== '' && !isHeader(line, headers))
  const headingSizes = [...new Set(lines.filter(l => l.size >= body * HEADING_RATIO).map(l => round(l.size)))].sort((a, b) => b - a)
  const pending = [...images].sort((a, b) => b.y - a.y)
  const blocks = []
  let open = null // { kind: 'para' | 'list' | 'code', ... }
  let prev = null

  const flush = () => {
    if (!open) return
    if (open.kind === 'code') blocks.push({ kind: 'code', text: codeText(open) })
    else blocks.push({ kind: open.kind, runs: runsOf(open.items) })
    open = null
  }
  const placeImagesAbove = y => {
    while (pending.length > 0 && (y === null || pending[0].y >= y)) {
      flush()
      const img = pending.shift()
      blocks.push({ kind: 'image', file: img.file, width: img.width, height: img.height, alt: '' })
    }
  }

  for (const line of lines) {
    placeImagesAbove(line.y)
    const text = line.text.trim()
    const gap = prev ? prev.y - line.y : 0
    const lineHeight = line.size * 1.2
    if (line.mono) {
      if (open?.kind !== 'code') {
        flush()
        open = { kind: 'code', size: line.size, lines: [] }
      } else {
        const blanks = Math.max(0, Math.round(gap / lineHeight) - 1)
        for (let i = 0; i < blanks; i++) open.lines.push({ x: null, text: '' })
      }
      open.lines.push({ x: line.x, text })
    } else if (line.size >= body * HEADING_RATIO) {
      flush()
      blocks.push({ kind: 'heading', level: Math.min(3, headingSizes.indexOf(round(line.size)) + 1), runs: runsOf(line.items) })
    } else if (CAPTION.test(text)) {
      flush()
      blocks.push({ kind: 'caption', runs: runsOf(line.items) })
    } else if (LIST_MARK.test(text)) {
      flush()
      open = { kind: 'list', items: [...line.items], markerX: line.x, minX: line.x }
    } else if (open && open.kind !== 'code' && gap <= 1.5 * lineHeight && continues(open, line)) {
      joinLine(open, line)
    } else {
      flush()
      open = { kind: 'para', items: [...line.items], minX: line.x }
    }
    prev = line
  }
  flush()
  placeImagesAbove(null)
  nameImages(blocks)
  return cut(blocks, maxChars)
}

function continues(open, line) {
  if (open.kind === 'list') return line.x > open.markerX + 1
  return line.x <= open.minX + 1
}

/** Appends a line's items to an open paragraph: a space between, or a hyphen removed. */
function joinLine(open, line) {
  const last = open.items.at(-1)
  const first = line.items[0]
  const endsHyphen = /[-‐­]$/.test(last.text)
  const nextLower = /^[a-zа-яё]/.test(first.text)
  if (endsHyphen && nextLower) open.items[open.items.length - 1] = { ...last, text: last.text.slice(0, -1) }
  else if (!last.text.endsWith(' ') && !first.text.startsWith(' ')) open.items.push({ ...last, text: ' ' })
  open.items.push(...line.items)
  open.minX = Math.min(open.minX, line.x)
}

function codeText(open) {
  const xs = open.lines.map(l => l.x).filter(x => x !== null)
  const left = Math.min(...xs)
  const unit = 0.6 * open.size
  return open.lines
    .map(l => (l.x === null ? '' : ' '.repeat(Math.max(0, Math.round((l.x - left) / unit))) + cleanRun(l.text)))
    .join('\n')
}

/** Adjacent items with equal style flags become one run; control characters go. */
function runsOf(items) {
  const runs = []
  for (const it of items) {
    const run = { text: cleanRun(it.text) }
    if (it.mono) run.mono = true
    else {
      if (BOLD.test(it.font)) run.bold = true
      if (ITALIC.test(it.font)) run.italic = true
    }
    const last = runs.at(-1)
    if (last && last.bold === run.bold && last.italic === run.italic && last.mono === run.mono) last.text += run.text
    else runs.push(run)
  }
  return runs.map(run => ({ ...run, text: run.text.replace(/[\r\n\t]+/g, ' ') })).filter(run => run.text !== '')
}

/** An image's alt: the next caption within three blocks, else its size. */
function nameImages(blocks) {
  blocks.forEach((block, i) => {
    if (block.kind !== 'image') return
    const caption = blocks.slice(i + 1, i + 4).find(b => b.kind === 'caption')
    block.alt = caption ? caption.runs.map(r => r.text).join('').slice(0, 80) : `Image ${block.width}×${block.height}`
  })
}

function cut(blocks, maxChars) {
  let left = maxChars
  const out = []
  for (const block of blocks) {
    const length = block.kind === 'code' ? block.text.length : block.kind === 'image' ? 0 : block.runs.reduce((n, r) => n + r.text.length, 0)
    if (length <= left) {
      out.push(block)
      left -= length
      continue
    }
    if (block.kind === 'code') out.push({ kind: 'code', text: block.text.slice(0, left) })
    else if (block.kind !== 'image') {
      const runs = []
      for (const run of block.runs) {
        if (left <= 0) break
        runs.push({ ...run, text: run.text.slice(0, left) })
        left -= run.text.length
      }
      out.push({ ...block, runs })
    }
    out.push({ kind: 'para', runs: [{ text: `… page cut at ${maxChars} characters` }] })
    return out
  }
  return out
}
