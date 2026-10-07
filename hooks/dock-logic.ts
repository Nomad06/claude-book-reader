import type { BookSummary } from '../types'

// Everything the Reading Dock shows, worked out without `$`: dock.tsx draws
// it and the tests call it directly.

export const ACCENT_FROM = '#C8873A'
export const ACCENT_TO = '#E8C07A'
export const GREEN = '#7FB77E'
export const READ = '#C8873A'
export const UNREAD = '#5C5C5C'
export const CURRENT = '#F2D08B'
export const SPINE_INK = '#F4EBDD'

/** Muted book-cloth colors for the spine badge. */
export const SPINES: readonly string[] = ['#8C5E3C', '#5E7A8C', '#7A5E8C', '#5E8C6A', '#8C7A5E', '#8C5E6E', '#5E6A8C', '#6E8C5E']

const SMALL_WORDS = new Set(['a', 'an', 'the', 'of', 'and', 'in', 'on', 'for', 'to'])

/** "Refactor auth middleware. Then run the tests" → "Refactor auth middleware". */
export function taskName(text: string, max = 40): string {
  const clause =
    text
      .split(/[.!?\n]/)
      .map(part => part.replace(/\s+/g, ' ').trim())
      .find(part => part !== '') ?? ''
  if (clause === '') return 'Claude is working'
  if (clause.length <= max) return clause
  const cut = clause.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** A running timer: 0:42, 12:05, 1:02:05. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** A finished duration in words: 45s, 2m 14s, 1h 3m. */
export function spoken(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`
  return `${s}s`
}

/** "Book Reader" → "B O O K   R E A D E R". */
export function spaced(text: string): string {
  return text
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean)
    .map(word => [...word].join(' '))
    .join('   ')
}

/** `steps` colors from `from` to `to`, both ends included. */
export function gradient(steps: number, from = ACCENT_FROM, to = ACCENT_TO): string[] {
  const a = rgb(from)
  const b = rgb(to)
  return Array.from({ length: Math.max(0, steps) }, (_, i) => {
    const t = steps === 1 ? 0 : i / (steps - 1)
    return hex(a.map((channel, k) => Math.round(channel + (b[k]! - channel) * t)))
  })
}

function rgb(color: string): number[] {
  const n = Number.parseInt(color.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function hex(channels: number[]): string {
  return `#${channels.map(c => c.toString(16).padStart(2, '0')).join('').toUpperCase()}`
}

/** Up to four initials of the title's main words; one word gives two letters. */
export function initials(title: string): string {
  const words = title.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const main = words.filter(word => !SMALL_WORDS.has(word.toLowerCase()))
  const use = main.length > 0 ? main : words
  if (use.length === 0) return '?'
  if (use.length === 1) return [...use[0]!].slice(0, 2).join('').toUpperCase()
  return use
    .slice(0, 4)
    .map(word => [...word][0]!)
    .join('')
    .toUpperCase()
}

/** The same title always gets the same spine color. */
export function spineColor(title: string): string {
  let h = 0
  for (const ch of title) h = (h * 31 + ch.codePointAt(0)!) >>> 0
  return SPINES[h % SPINES.length]!
}

export function percent(readCount: number, pages: number | null): number {
  return pages ? Math.min(100, Math.round((100 * readCount) / pages)) : 0
}

/** The status line while the dock is folded. */
export function badge(book: BookSummary): string {
  return book.pages ? `📖 p.${book.page}/${book.pages} · ${percent(book.readCount, book.pages)}%` : `📖 p.${book.page}`
}

/** How many of `width` bar cells are filled for `fraction` (clamped to 0..1). */
export function bar(fraction: number, width: number): { filled: number; empty: number } {
  const cells = Math.max(0, Math.floor(width))
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * cells)
  return { filled, empty: cells - filled }
}

export type Tier = 'full' | 'compact' | 'tiny'

export function tier(columns: number): Tier {
  return columns >= 64 ? 'full' : columns >= 40 ? 'compact' : 'tiny'
}
