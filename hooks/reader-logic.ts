import type { ReaderMode, Run } from '../types'

// Pure helpers of the reader view; nothing here touches `$`.

const MAX_IMAGE_COLUMNS = 60
const CELL_ASPECT = 2.1

/** The terminal draws pictures through the Image element: kitty and Ghostty. */
export function isGraphicsTerminal(env: { TERM_PROGRAM?: string; TERM?: string; KITTY_WINDOW_ID?: string; GHOSTTY_RESOURCES_DIR?: string }): boolean {
  const program = (env.TERM_PROGRAM ?? '').toLowerCase()
  return program === 'ghostty' || program === 'kitty' || (env.TERM ?? '').includes('kitty') || !!env.KITTY_WINDOW_ID || !!env.GHOSTTY_RESOURCES_DIR
}

/** Cells for a picture: at most 60 columns, rows from the aspect, 2 to 40. */
export function imageBox(width: number, height: number, bodyColumns: number): { columns: number; rows: number } {
  const columns = Math.max(1, Math.min(MAX_IMAGE_COLUMNS, bodyColumns))
  const rows = Math.round((columns * height) / Math.max(1, width) / CELL_ASPECT)
  return { columns, rows: Math.max(2, Math.min(40, rows)) }
}

/** The page typed into "go to": digits anywhere, within the book when its length is known. */
export function parseGoto(input: string, pages: number | null): number | null {
  const digits = /\d+/.exec(input)
  if (!digits) return null
  const page = Number(digits[0])
  if (page < 1 || (pages !== null && page > pages)) return null
  return page
}

export function readerMode(settingsMode: unknown, fallback: ReaderMode): ReaderMode {
  return settingsMode === 'text' || settingsMode === 'browser' ? settingsMode : fallback
}

export function pageLabel(page: number, pages: number | null, isRead: boolean): string {
  return `${pages ? `p. ${page} / ${pages}` : `p. ${page}`}${isRead ? ' ✓' : ''}`
}

/** The one-line stand-in for a picture where none can be drawn. */
export function imageLine(alt: string, width: number, height: number): string {
  const size = `${width}×${height}`
  // The server's fallback alt is already "Image W×H"; do not say the size twice.
  const label = alt === `Image ${size}` ? alt : `${alt} · ${size}`
  return `▣ ${label} · o opens in browser`
}

export function listText(runs: Run[]): string {
  return runs.map(run => run.text).join('')
}

// Display columns: combining marks 0, wide East Asian letters and emoji 2, the rest 1
// (Cyrillic and Latin letters are one column).
const isCombining = (cp: number) => (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)
const isWide = (cp: number) =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe6f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) ||
  (cp >= 0x1f300 && cp <= 0x1faff) ||
  (cp >= 0x20000 && cp <= 0x3fffd)

const charWidth = (ch: string) => {
  const cp = ch.codePointAt(0) ?? 0
  return isCombining(cp) ? 0 : isWide(cp) ? 2 : 1
}

export function textWidth(text: string): number {
  let width = 0
  for (const ch of text) width += charWidth(ch)
  return width
}

/** The text cut to at most `max` columns, an ellipsis in place of what is left out. */
export function fitTitle(title: string, max: number): string {
  if (max <= 0) return ''
  if (textWidth(title) <= max) return title
  let out = ''
  let width = 0
  for (const ch of title) {
    const w = charWidth(ch)
    if (width + w > max - 1) break
    out += ch
    width += w
  }
  return `${out}…`
}

/** A contents row: `text`, then (on the entry's last row) a leader and the page. */
export type TocRow = { text: string; leader: string; page: string }

const LEADER = '·'
const MIN_LEADER = 2

/** Cuts a word that is wider than `max` into pieces that fit. */
function cutWord(word: string, max: number): string[] {
  const pieces: string[] = []
  let piece = ''
  for (const ch of word) {
    if (piece && textWidth(piece) + charWidth(ch) > max) {
      pieces.push(piece)
      piece = ''
    }
    piece += ch
  }
  if (piece) pieces.push(piece)
  return pieces
}

/**
 * A contents entry fitted to `width` columns: indented two columns per level
 * below the first, the title wrapped, and on the last row the leader filling
 * the space up to the right-aligned page. A title that leaves no room for the
 * leader on its last row gets the leader and page on a row of their own.
 */
export function tocRows(title: string, page: string, level: number, width: number): TocRow[] {
  const indent = ' '.repeat(2 * Math.max(0, level - 1))
  const room = Math.max(1, width - indent.length)
  const lines: string[] = []
  let line = ''
  for (const word of title.split(/\s+/).filter(Boolean)) {
    for (const piece of textWidth(word) > room ? cutWord(word, room) : [word]) {
      if (line && textWidth(line) + 1 + textWidth(piece) <= room) line += ` ${piece}`
      else {
        if (line) lines.push(line)
        line = piece
      }
    }
  }
  if (line) lines.push(line)
  const rows: TocRow[] = lines.map(text => ({ text: indent + text, leader: '', page: '' }))
  const tail = (text: string): TocRow | null => {
    const fill = width - textWidth(text) - textWidth(page) - 2
    return fill >= MIN_LEADER ? { text, leader: LEADER.repeat(fill), page } : null
  }
  const last = rows.length ? tail(rows[rows.length - 1].text) : null
  if (last) rows[rows.length - 1] = last
  else rows.push(tail(indent) ?? { text: indent, leader: LEADER.repeat(MIN_LEADER), page })
  return rows
}

export type UrlPart = { text: string; isUrl: boolean }

// https://…, www.…, or a bare host with a path (oreil.ly/abc); the bare form needs the path.
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"«»]+|(?<![\p{L}\p{N}./@-])[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/[^\s<>"«»]+/giu

/** The text split into plain parts and urls; a url does not take its closing punctuation. */
export function splitUrls(text: string): UrlPart[] {
  const parts: UrlPart[] = []
  let at = 0
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0].replace(/[.,;:!?)\]'»]+$/u, '')
    const start = match.index ?? 0
    if (start > at) parts.push({ text: text.slice(at, start), isUrl: false })
    parts.push({ text: url, isUrl: true })
    at = start + url.length
  }
  if (at < text.length) parts.push({ text: text.slice(at), isUrl: false })
  return parts
}
