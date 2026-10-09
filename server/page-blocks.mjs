// Pure: pdf.js text items of one page → blocks the dock draws (headings,
// paragraphs, lists, captions, contents lines, code, images), and the places
// of figures drawn with paths, for the server to render. Heuristics on size,
// font and position; no pdf.js here, so this is tested on plain data.

import { cleanRun } from './text.mjs'

export const MAX_PAGE_CHARS = 20000
const HEADING_RATIO = 1.15
const LIST_MARK = /^(?:[•◦▪●\-–—]|\d{1,3}[.)])\s+\S/
const CAPTION = /^(?:Figure|Fig\.|Table|Listing|Example|Рис\.|Рисунок|Таблица|Листинг|Пример)\s+\d/i
const FIGURE_CAPTION = /^(?:Figure|Fig\.|Рис\.|Рисунок)\s+\d/i
const BOLD = /bold|semibold|black|heavy/i
const ITALIC = /italic|oblique/i

// Running heads and folios sit in a band at the top and the foot of the page
// (the test book's heads are 7–8% down from the top edge, chapter titles 13%+).
const RUNNING_BAND = 0.1 // of the page height
const RUNNING_MAX_RATIO = 1.35 // × body size: a head may be set a little larger than the text, a title is far larger
const RUNNING_MAX_CHARS = 120
const RUNNING_GAP = 2 // × the smaller line height of it and its neighbour: a head stands apart from the text
const FOLIO = /^\d{1,4}$/
// A footnote: a mark (a number and a space, superscript digits, * † ‡ §), then text smaller than the body.
const NOTE_MARK = /^(?:\d{1,3}\s+|[¹²³⁴⁵⁶⁷⁸⁹⁰]+\s*|[*†‡§]+\s*)\S/
const NOTE_RATIO = 0.96 // 9.5 pt under 10 pt body is small; 9.96 pt is body text
const isNote = (text, line, body) => NOTE_MARK.test(text) && line.size <= NOTE_RATIO * body
// Indented body lines set this much wider apart than the page's own line pitch are separate items
// (list items whose bullets are drawn, table rows); prose at the margin keeps the fixed rule, since
// a line with inline math may sit a little apart from its neighbours.
const PITCH_SPLIT = 1.2
// A contents line: a title, a leader (dots, middle dots, ellipses, spaced or not), the page it points at.
const PAGE_AT_END = /(\d{1,4}(?: \d{1,3})?|[ivxlcdm]{1,8})\s*$/ // "1 91": pdf.js may split the number
const LEADER_MARK = /[.·∙…]/
// A leader's strength counts dots, an ellipsis as three. From ALONE_LEADER on it makes a contents line
// by itself; from MIN_LEADER (a LaTeX row: long title, short spaced leader) only beside another leader
// line ending at the same right edge, a column of pages; so "1... 2... 3" or "values 0 ... 255" alone
// stay prose.
const ALONE_LEADER = 6
const MIN_LEADER = 3
// A page reference at a line's end, after a space or a leader mark (not the end of a word).
const PAGE_END = /(?:^|[\s.·∙…])(?:\d{1,4}|[ivxlcdm]{1,8})\s*$/

const round = n => Math.round(n * 2) / 2

// PDF content is untrusted: positions, sizes and text come straight from the file.
const MAX_ITEMS = 100000
const MAX_ITEM_CHARS = 5000
const MAX_SIZE = 1000
const MAX_INDENT = 80
const MAX_BLANK_LINES = 5
const MAX_IMAGES = 200
const MAX_DRAWINGS = 5000
const MAX_FIGURES = 20 // figure marks on one page; the server renders a few and shows the rest as a line

// A figure drawn with paths sits between the line above its caption and the caption: at least this many
// body lines tall, with a drawing in it. The region keeps clear of both lines' glyphs.
const FIGURE_MIN_LINES = 2
const FIGURE_PAD = 3 // pt around the drawing
const DESCENT = 0.3 // × size below a baseline
const RULE_HEIGHT = 1.5 // pt: a box no taller is a rule

/** Items with finite position and a usable size; width and text made safe; at most MAX_ITEMS. */
function sane(items) {
  const out = []
  for (const it of items) {
    if (out.length >= MAX_ITEMS) break
    if (!it || typeof it.text !== 'string' || it.text === '') continue
    if (!Number.isFinite(it.x) || !Number.isFinite(it.y) || !Number.isFinite(it.size) || it.size <= 0) continue
    out.push({
      ...it,
      size: Math.min(it.size, MAX_SIZE),
      width: Number.isFinite(it.width) && it.width > 0 ? it.width : 0,
      font: typeof it.font === 'string' ? it.font : '',
      text: it.text.length > MAX_ITEM_CHARS ? it.text.slice(0, MAX_ITEM_CHARS) : it.text,
    })
  }
  return out
}

const maxOf = (list, f) => list.reduce((m, v) => Math.max(m, f(v)), -Infinity)

// ---------------------------------------------------------------- lines

/** Items grouped by baseline (top of the page first), each line's items left to right. */
export function linesOf(items) {
  const sorted = sane(items).sort((a, b) => b.y - a.y || a.x - b.x)
  const lines = []
  for (const it of sorted) {
    const last = lines.at(-1)
    if (last && Math.abs(last.y - it.y) <= 0.4 * Math.max(it.size, last.size)) last.items.push(it)
    else lines.push({ y: it.y, size: it.size, items: [it] })
  }
  for (const line of lines) {
    line.y = baselineOf(line.items)
    line.items.sort((a, b) => a.x - b.x)
    line.x = line.items[0].x
    line.right = maxOf(line.items, it => it.x + it.width)
    line.size = maxOf(line.items, it => it.size)
    line.mono = line.items.every(it => it.mono)
    line.text = joinItems(line.items)
  }
  return lines
}

/** The baseline most of a line's text sits on: a superscript note mark does not lift the line. */
function baselineOf(items) {
  const chars = new Map()
  for (const it of items) chars.set(round(it.y), (chars.get(round(it.y)) ?? 0) + it.text.length)
  let y = items[0].y
  let best = -1
  for (const [at, n] of chars) {
    if (n > best) {
      best = n
      y = at
    }
  }
  return y
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

/**
 * Sampled pages → the body size, the running header/footer lines to drop, and
 * the folio offset: printed page number − PDF page number, when the sampled
 * pages agree on it (null when they do not, or carry no page numbers). A sample
 * is `{ page, items }`, or just its items.
 */
export function calibrate(samples) {
  const sizes = new Map()
  const seenOn = new Map()
  const offsets = new Map()
  let numbered = 0 // sampled pages with a number at an end of their top or bottom line
  for (const sample of samples) {
    const items = Array.isArray(sample) ? sample : (sample?.items ?? [])
    for (const it of sane(items)) {
      const s = round(it.size)
      sizes.set(s, (sizes.get(s) ?? 0) + it.text.length)
    }
    const onThisPage = new Set()
    const lines = linesOf(items)
    for (const line of lines) {
      const key = headerKey(line)
      if (!key || onThisPage.has(key)) continue
      onThisPage.add(key)
      seenOn.set(key, (seenOn.get(key) ?? 0) + 1)
    }
    const page = Array.isArray(sample) ? null : sample?.page
    if (!Number.isInteger(page) || page < 1) continue
    const found = new Set()
    const shown = lines.filter(line => cleanRun(line.text).trim() !== '')
    for (const line of new Set([shown[0], shown.at(-1)])) {
      for (const n of edgeNumbers(line)) found.add(n - page)
    }
    if (found.size > 0) numbered++
    for (const offset of found) offsets.set(offset, (offsets.get(offset) ?? 0) + 1)
  }
  let folioOffset = null
  let agree = 0
  for (const [offset, n] of offsets) {
    if (n > agree) {
      agree = n
      folioOffset = offset
    }
  }
  // At least three sampled pages, and more than half of those printing a number, agree: two "Total 15" lines do not.
  if (agree < 3 || agree * 2 <= numbered || !saneOffset(folioOffset)) folioOffset = null
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
  return { bodySize, headers, folioOffset }
}

const MAX_FOLIO_OFFSET = 100000
const saneOffset = n => Number.isInteger(n) && Math.abs(n) <= MAX_FOLIO_OFFSET

/** A short line's words, ornaments around a folio dropped; none for a long or empty line. */
function edgeWords(line) {
  if (!line) return []
  const text = cleanRun(line.text).trim()
  if (text === '' || text.length > RUNNING_MAX_CHARS) return []
  return text.replace(/[|·•–—]/g, ' ').trim().split(/\s+/)
}

/** The 1–4 digit numbers at either end of a short line: where a folio is printed. */
function edgeNumbers(line) {
  const words = edgeWords(line)
  return [...new Set([words[0], words.at(-1)])].filter(w => w !== undefined && FOLIO.test(w)).map(Number)
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

/** A scanned page: no text at all (blank items count as none) and a picture covering half the page or more. */
export function isScanned(items, images, width, height) {
  return items.every(item => !item.text.trim()) && images.some(img => img.w * img.h >= 0.5 * width * height)
}

/**
 * `top`/`bottom` are the page box's edges in the items' coordinates and
 * `pageNumber` the page's number in the PDF: with them and the profile's
 * `folioOffset`, the running head and folio that print this page's number are
 * dropped by position on every page, not only those calibrated.
 */
export function pageBlocks(items, images, profile, { maxChars = MAX_PAGE_CHARS, top, bottom, pageNumber, drawings = [] } = {}) {
  const body = profile?.bodySize ?? 10
  const headers = profile?.headers ?? []
  // Every line with text, running heads too: a figure's region stops below whatever is printed above it.
  const printed = linesOf(items).filter(line => cleanRun(line.text).trim() !== '')
  const kept = printed.filter(line => !isHeader(line, headers))
  const boxes = saneBoxes(drawings)
  let figures = 0
  markContents(kept)
  const lines = withoutRunning(kept, { top, bottom, pageNumber, body, folioOffset: profile?.folioOffset })
  const frame = { left: lines.reduce((m, l) => Math.min(m, l.x), Infinity), right: maxOf(lines, l => l.right) }
  const levelOf = tocLevels(lines, frame.left)
  const pitch = pitchOf(lines, body)
  const isBodySize = line => Math.abs(line.size - body) < 0.5
  const headingSizes = [...new Set(lines.filter(l => !l.toc && l.size >= body * HEADING_RATIO).map(l => round(l.size)))].sort((a, b) => b - a)
  const pending = images.filter(img => img && Number.isFinite(img.y)).slice(0, MAX_IMAGES).sort((a, b) => b.y - a.y)
  const blocks = []
  let open = null // { kind: 'para' | 'list' | 'code', ... }
  let prev = null

  const flush = () => {
    if (!open) return
    if (open.kind === 'code') blocks.push({ kind: 'code', text: codeText(open) })
    else blocks.push({ kind: open.kind, runs: runsOf(open.items) })
    open = null
  }
  const start = (kind, line, extra) => ({ kind, items: [...line.items], minX: line.x, right: line.right, size: line.size, rows: 1, pageEnd: line.pageEnd, ...extra })
  // Right above a contents line, at the page's start or after a heading or an entry: the first line of its title.
  const startsEntry = (line, next) => {
    if (line.toc || line.mono || !next?.toc) return false
    const before = open ? open.kind : blocks.at(-1)?.kind
    return (!before || before === 'toc' || before === 'heading') && wrapsInto(line, next, line.y - next.y)
  }
  const placeImagesAbove = y => {
    while (pending.length > 0 && (y === null || pending[0].y >= y)) {
      flush()
      const img = pending.shift()
      blocks.push({ kind: 'image', file: img.file, width: img.width, height: img.height, alt: '' })
    }
  }

  for (const [i, line] of lines.entries()) {
    placeImagesAbove(line.y)
    const text = line.text.trim()
    const gap = prev ? prev.y - line.y : 0
    const lineHeight = line.size * 1.2
    if (line.mono) {
      if (open?.kind !== 'code') {
        flush()
        open = { kind: 'code', size: line.size, lines: [] }
      } else {
        const blanks = Math.min(MAX_BLANK_LINES, Math.max(0, Math.round(gap / lineHeight) - 1))
        for (let i = 0; i < blanks; i++) open.lines.push({ x: null, text: '' })
      }
      open.lines.push({ x: line.x, text })
    } else if (line.toc) {
      // A title that wrapped before its leader: the line or two just above, as wide as the entry, join it.
      if (open?.titleFirst && open.rows <= 2 && wrapsInto({ x: open.minX, right: open.right, size: open.size, pageEnd: open.pageEnd }, line, gap)) {
        joinLine(open, line)
        blocks.push(tocBlock(open.items, levelOf(open.minX)))
        open = null
      } else {
        flush()
        blocks.push(tocBlock(line.items, levelOf(line.x)))
      }
    } else if (startsEntry(line, lines[i + 1])) {
      // The first line of a wrapped entry, whatever it looks like ("Рис. 1.2. …", "2. …", a large chapter entry).
      flush()
      open = start('para', line, { titleFirst: true })
    } else if (line.size >= body * HEADING_RATIO) {
      flush()
      blocks.push({ kind: 'heading', level: Math.min(3, headingSizes.indexOf(round(line.size)) + 1), runs: runsOf(line.items) })
    } else if (CAPTION.test(text)) {
      flush()
      const runs = runsOf(line.items)
      // A figure caption with no picture right above it: the drawing above, if any, is the figure.
      const upright = line.items.every(it => it.upright !== false)
      if (FIGURE_CAPTION.test(text) && upright && blocks.at(-1)?.kind !== 'image' && figures < MAX_FIGURES) {
        const region = figureRegion(line, printed, boxes, body, top)
        if (region) {
          figures++
          blocks.push({ kind: 'figure', alt: runs.map(r => r.text).join('').slice(0, 80), region })
        }
      }
      blocks.push({ kind: 'caption', runs })
    } else if (LIST_MARK.test(text)) {
      flush()
      open = start('list', line, { markerX: line.x })
    } else if (isNote(text, line, body)) {
      flush()
      open = start('para', line, { note: true })
    } else if (
      open &&
      open.kind !== 'code' &&
      gap <= 1.5 * lineHeight &&
      !(pitch !== null && line.x > frame.left + 1 && isBodySize(line) && isBodySize(prev) && gap > PITCH_SPLIT * pitch) &&
      continues(open, line, frame)
    ) {
      joinLine(open, line)
    } else {
      flush()
      // At the page's start or after a heading or contents line, a paragraph may be a contents title that wraps.
      const last = blocks.at(-1)
      open = start('para', line, { titleFirst: !last || last.kind === 'toc' || last.kind === 'heading' })
    }
    prev = line
  }
  flush()
  placeImagesAbove(null)
  const shown = blocks.filter(isShown)
  nameImages(shown)
  return cut(shown, maxChars)
}

/** A block that says something: no text block without text. */
function isShown(block) {
  if (block.kind === 'image' || block.kind === 'figure') return true
  if (block.kind === 'code') return block.text.trim() !== ''
  return block.runs.length > 0
}

// ---------------------------------------------------------------- figures

/** Drawing boxes with finite, ordered edges; at most MAX_DRAWINGS. */
function saneBoxes(drawings) {
  const out = []
  for (const d of Array.isArray(drawings) ? drawings : []) {
    if (out.length >= MAX_DRAWINGS) break
    if (!d || typeof d !== 'object') continue
    const { left, bottom, right, top } = d
    if (![left, bottom, right, top].every(Number.isFinite) || right < left || top < bottom) continue
    out.push({ left, bottom, right, top })
  }
  return out
}

/**
 * Where a figure drawn with paths sits above `caption`: from below the nearest
 * printed line above (or the page's top edge) down to the caption, cut to the
 * drawings in that band with FIGURE_PAD around them; null when the band is
 * under FIGURE_MIN_LINES body lines tall or has no drawing in it.
 */
function figureRegion(caption, printed, boxes, body, pageTop) {
  const above = printed.filter(l => l.y > caption.y + 0.5 * caption.size).reduce((low, l) => (!low || l.y < low.y ? l : low), null)
  const ceiling = above ? above.y - DESCENT * above.size : Number.isFinite(pageTop) ? pageTop : Infinity
  const floor = caption.y + caption.size
  if (ceiling - floor < FIGURE_MIN_LINES * 1.2 * body) return null
  const inside = withoutLoneRules(
    boxes.filter(b => b.top >= floor && b.bottom <= ceiling),
    1.2 * body,
  )
  if (inside.length === 0) return null
  const top = Math.min(ceiling, maxOf(inside, b => b.top) + FIGURE_PAD)
  const bottom = Math.max(floor, -maxOf(inside, b => -b.bottom) - FIGURE_PAD)
  if (top - bottom < FIGURE_MIN_LINES * 1.2 * body) return null
  return { left: -maxOf(inside, b => -b.left) - FIGURE_PAD, bottom, right: maxOf(inside, b => b.right) + FIGURE_PAD, top }
}

/**
 * The boxes without a rule (a hairline, at most RULE_HEIGHT tall) that is the
 * topmost or the lowest and stands more than `gap` apart from the rest: the rule
 * under a running head or above footnotes, not an edge of the figure.
 */
function withoutLoneRules(boxes, gap) {
  const isRule = b => b.top - b.bottom <= RULE_HEIGHT
  // Sorted by top, the next box reaches highest of the rest; sorted by bottom, lowest.
  const byTop = [...boxes].sort((a, b) => b.top - a.top)
  let first = 0
  while (first < byTop.length - 1 && isRule(byTop[first]) && byTop[first].bottom - byTop[first + 1].top > gap) first++
  const byBottom = byTop.slice(first).sort((a, b) => a.bottom - b.bottom)
  let low = 0
  while (low < byBottom.length - 1 && isRule(byBottom[low]) && byBottom[low + 1].bottom - byBottom[low].top > gap) low++
  return byBottom.slice(low)
}

function continues(open, line, frame) {
  if (open.kind === 'list') return line.x > open.markerX + 1
  // A footnote's lines hang under its text or sit at its marker; all are set small like it.
  if (open.note) return line.x >= open.minX - 1 && Math.abs(line.size - open.size) < 0.5
  if (line.x <= open.minX + 1) return true
  // Flush right and well in from the margin (an attribution under a quote): the lines run on.
  // A first-line indent is far smaller, so it still starts a paragraph.
  const inset = 0.2 * (frame.right - frame.left)
  const atRight = right => right >= frame.right - 0.5 * line.size
  return atRight(open.right) && atRight(line.right) && open.minX - frame.left > inset && line.x - frame.left > inset
}

/** Appends a line's items to an open paragraph: a space between, or a hyphen removed. */
function joinLine(open, line) {
  const last = open.items.at(-1)
  const first = line.items[0]
  const endsHyphen = /[-‐­]$/.test(last.text)
  const nextLower = /^[a-zа-яё]/.test(first.text)
  if (endsHyphen && nextLower) open.items[open.items.length - 1] = { ...last, text: last.text.slice(0, -1) }
  else if (!last.text.endsWith(' ') && !first.text.startsWith(' ')) open.items.push({ ...last, text: ' ' })
  for (const it of line.items) open.items.push(it)
  open.minX = Math.min(open.minX, line.x)
  open.right = line.right
  open.rows++
  open.pageEnd = line.pageEnd
}

/** The page's usual distance between body lines (the most common one, seen three times or more), or null. */
function pitchOf(lines, body) {
  const counts = new Map()
  for (let i = 1; i < lines.length; i++) {
    const [a, b] = [lines[i - 1], lines[i]]
    if (a.mono || b.mono || Math.abs(a.size - body) >= 0.5 || Math.abs(b.size - body) >= 0.5) continue
    const d = round(a.y - b.y)
    if (d > 0 && d < 3 * body) counts.set(d, (counts.get(d) ?? 0) + 1)
  }
  let pitch = null
  let seen = 2
  for (const [d, n] of counts) {
    if (n > seen) {
      seen = n
      pitch = d
    }
  }
  return pitch
}

// ---------------------------------------------------------------- running heads

/**
 * The lines without the running head at the top and the folio line at the foot:
 * the outermost line in its band, apart from the text, not much larger than it,
 * short, with this page's printed number (PDF page + the calibrated folio
 * offset) at either end. No offset learned, no line dropped by position: a
 * number at the edge of a line is otherwise as likely a title's, a table's or a
 * footnote's. At the foot a small line opening with a note mark stays.
 */
function withoutRunning(lines, { top, bottom, pageNumber, body, folioOffset }) {
  if (typeof top !== 'number' || typeof bottom !== 'number' || !Number.isFinite(top) || !Number.isFinite(bottom) || top <= bottom) return lines
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || !saneOffset(folioOffset) || pageNumber + folioOffset < 1) return lines
  const folio = String(pageNumber + folioOffset)
  const band = RUNNING_BAND * (top - bottom)
  const first = lines[0]
  const last = lines.at(-1)
  const atTop = first && first.y >= top - band && isRunning(first, lines[1], 'top', body, folio)
  const atFoot = last && last !== first && last.y <= bottom + band && isRunning(last, lines.at(-2), 'foot', body, folio)
  // A page prints its folio once; a title may carry the same number ("Chapter 3", "1 Introduction" on page 1).
  // Both edges: a bare number is the folio, else a bold or heading-sized top line is the title. Top only: a
  // bold line is a numbered title, not a running head.
  let drop = null
  if (atTop && atFoot) drop = isBare(last) ? last : isBare(first) ? first : isBold(first) || first.size >= HEADING_RATIO * body ? last : first
  else if (atTop) drop = isBold(first) ? null : first
  else if (atFoot) drop = last
  return drop ? lines.filter(line => line !== drop) : lines
}

/** A line of the folio alone ("57", "— 57 —"). */
const isBare = line => edgeWords(line).length === 1

/** Every word of the line set in a bold face. */
const isBold = line => line.items.every(it => !it.text.trim() || (!it.mono && BOLD.test(it.font)))

function isRunning(line, next, edge, body, folio) {
  const text = cleanRun(line.text).trim()
  if (line.mono || line.toc || text.length > RUNNING_MAX_CHARS || line.size > RUNNING_MAX_RATIO * body) return false
  if (next && Math.abs(line.y - next.y) < RUNNING_GAP * 1.2 * Math.min(line.size, next.size)) return false
  if (edge === 'foot' && isNote(text, line, body)) return false
  return edgeNumbers(line).includes(Number(folio))
}

// ---------------------------------------------------------------- contents lines

/**
 * Marks each line's `toc` (title and page) when it is a contents line: a leader
 * of ALONE_LEADER on its own, a shorter one only when another leader line on the
 * page ends at the same right edge (within 1 pt). Also marks `pageEnd`: the right
 * edge of a line ending in a page reference, entry or not.
 */
function markContents(lines) {
  const rights = new Map()
  for (const line of lines) {
    const text = cleanRun(line.text)
    line.toc = line.mono ? null : splitLeader(text)
    line.pageEnd = !line.mono && PAGE_END.test(text) ? line.right : null
    if (line.toc) rights.set(Math.round(line.right), (rights.get(Math.round(line.right)) ?? 0) + 1)
  }
  for (const line of lines) {
    if (!line.toc || line.toc.strength >= ALONE_LEADER) continue
    const r = Math.round(line.right)
    const beside = (rights.get(r - 1) ?? 0) + (rights.get(r) ?? 0) + (rights.get(r + 1) ?? 0) - 1
    if (beside < 1) line.toc = null
  }
}

/**
 * A contents line's title (untrimmed, from the line's start), page and leader
 * strength (dots, an ellipsis as three), or null when the leader is weaker than
 * MIN_LEADER. Read back from the line's end, so a hostile line of dots costs
 * linear time.
 */
function splitLeader(text) {
  const page = PAGE_AT_END.exec(text)
  if (!page) return null
  let i = page.index - 1
  let strength = 0
  for (; i >= 0; i--) {
    const c = text[i]
    if (LEADER_MARK.test(c)) strength += c === '…' ? 3 : 1
    else if (!/\s/.test(c)) break
  }
  if (strength < MIN_LEADER) return null
  const title = text.slice(0, i + 1)
  return /\S/.test(title) ? { title, page: page[1].replace(/ /g, ''), strength } : null
}

/**
 * A title's first line runs on into the contents line below it: close above, not
 * right of it, as large, about as wide, and not itself ending in a page at the
 * entry's right edge (then it is an entry of its own, whatever its leader).
 */
function wrapsInto(first, entry, gap) {
  return (
    (first.pageEnd == null || Math.abs(first.pageEnd - entry.right) > 1) &&
    gap <= 1.5 * 1.2 * entry.size &&
    entry.x >= first.x - 1 &&
    Math.abs(first.size - entry.size) < 0.5 &&
    first.right >= entry.right - 0.35 * (entry.right - first.x)
  )
}

/** Levels 1–3 from the indent: the step is the smallest indent between entries on the page, else 1.5 × their size. */
function tocLevels(lines, left) {
  const entries = lines.filter(l => l.toc)
  const xs = [...new Set(entries.map(l => round(l.x)))].sort((a, b) => a - b)
  const size = entries[0]?.size ?? 10
  let step = Infinity
  for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] >= 0.25 * size) step = Math.min(step, xs[i] - xs[i - 1])
  if (!Number.isFinite(step)) step = 1.5 * size
  return x => Math.min(3, Math.max(1, 1 + Math.round((x - left) / step)))
}

/** One contents entry from its items: the title's runs (leader and page cut off), the page, the level. */
function tocBlock(items, level) {
  const runs = runsOf(items)
  const found = splitLeader(runs.map(r => r.text).join(''))
  if (!found) return { kind: 'para', runs }
  const title = []
  let left = found.title.length
  for (const run of runs) {
    if (left <= 0) break
    title.push({ ...run, text: run.text.slice(0, left) })
    left -= run.text.length
  }
  title[0].text = title[0].text.trimStart()
  title[title.length - 1].text = title[title.length - 1].text.trimEnd()
  return { kind: 'toc', runs: title.filter(run => run.text !== ''), page: found.page, level }
}

function codeText(open) {
  const xs = open.lines.map(l => l.x).filter(x => x !== null)
  const left = xs.reduce((m, x) => Math.min(m, x), Infinity)
  const unit = 0.6 * open.size // size is finite and > 0 (see sane)
  const indent = x => Math.min(MAX_INDENT, Math.max(0, Math.round((x - left) / unit)))
  return open.lines
    .map(l => (l.x === null ? '' : ' '.repeat(indent(l.x)) + cleanRun(l.text)))
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
    const picture = block.kind === 'image' || block.kind === 'figure'
    const length = block.kind === 'code' ? block.text.length : picture ? 0 : block.runs.reduce((n, r) => n + r.text.length, 0)
    if (length <= left) {
      out.push(block)
      left -= length
      continue
    }
    if (left <= 0) {
      // nothing of this block fits: no empty block, just the notice
    } else if (block.kind === 'code') out.push({ kind: 'code', text: block.text.slice(0, left) })
    else if (!picture) {
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
