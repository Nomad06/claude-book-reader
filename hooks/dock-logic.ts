import type { BookDetail, BookSummary, DockSnapshot, DockTask, OutlineEntry } from '../types'

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

export type ChapterRow = {
  title: string
  page: number
  endPage: number
  status: 'done' | 'current' | 'todo'
  percent: number
  readPages: number
}

/** The chapters the dock lists: top level, or two levels when the top has fewer than three. */
export function chapters(outline: OutlineEntry[] | null, read: readonly number[], page: number, pages: number | null): ChapterRow[] {
  if (!outline || outline.length === 0) return []
  const top = outline.filter(entry => entry.level === 0)
  const picked = (top.length >= 3 ? top : outline.filter(entry => entry.level <= 1)).slice().sort((a, b) => a.page - b.page)
  const last = pages ?? Math.max(page, ...picked.map(entry => entry.page))
  const isRead = new Set(read)
  const current = picked.reduce((found, entry, i) => (entry.page <= page ? i : found), -1)
  return picked.map((entry, i) => {
    const endPage = Math.max(entry.page, (picked[i + 1]?.page ?? last + 1) - 1)
    let readPages = 0
    for (let p = entry.page; p <= endPage; p++) if (isRead.has(p)) readPages++
    const span = endPage - entry.page + 1
    const status = i === current ? 'current' : readPages === span ? 'done' : 'todo'
    return { title: entry.title, page: entry.page, endPage, status, percent: Math.round((100 * readPages) / span), readPages }
  })
}

/** The first chapter, from the current one on, that still has unread pages. */
export function nextUp(rows: ChapterRow[]): { title: string; pagesLeft: number } | null {
  const start = Math.max(0, rows.findIndex(row => row.status === 'current'))
  const row = rows.slice(start).find(one => one.readPages < one.endPage - one.page + 1)
  return row ? { title: row.title, pagesLeft: row.endPage - row.page + 1 - row.readPages } : null
}

export type Bucket = 'read' | 'unread' | 'current' | 'none'
export type HeatCell = { top: Bucket; bottom: Bucket }

/** The read-pages strip: `▀` cells, each an upper and a lower bucket of pages. */
export function heatmap(read: readonly number[], page: number, pages: number | null, width: number): HeatCell[] {
  if (!pages || width < 1) return []
  const size = Math.ceil(pages / (2 * width))
  const isRead = new Set(read)
  const bucket = (i: number): Bucket => {
    const first = i * size + 1
    if (first > pages) return 'none'
    const last = Math.min(pages, first + size - 1)
    if (page >= first && page <= last) return 'current'
    let count = 0
    for (let p = first; p <= last; p++) if (isRead.has(p)) count++
    return count * 2 > last - first + 1 ? 'read' : 'unread'
  }
  const cells = Math.ceil(Math.ceil(pages / size) / 2)
  return Array.from({ length: cells }, (_, i) => ({ top: bucket(2 * i), bottom: bucket(2 * i + 1) }))
}

/** The done line: how it ended, how long it took, and what you read meanwhile. */
export function summary(task: DockTask, book: BookSummary | null): string {
  const took = spoken(task.durationMs ?? (task.endedAt ?? task.startedAt) - task.startedAt)
  const head =
    task.reason === 'answer'
      ? `✓ Task finished in ${took}`
      : task.reason === 'aborted'
        ? `■ Task stopped after ${took}`
        : `⚠ Task ended with an error after ${took}`
  const count = book && book.id === task.bookId ? book.readCount - task.startReadCount : 0
  if (!book || count <= 0) return head
  return `${head} · you read ${count} ${count === 1 ? 'page' : 'pages'} (p. ${task.startPage} → ${book.page})`
}

/** Fills the task's starting place from the first snapshot that has a book. */
export function withBaseline(task: DockTask | null, snapshot: DockSnapshot | null): DockTask | null {
  const book = snapshot?.current
  if (!task || task.bookId !== null || !book) return task
  return { ...task, bookId: book.id, startPage: book.page, startReadCount: book.readCount }
}

export function newTask(text: string, now: number, snapshot: DockSnapshot | null): DockTask {
  const task: DockTask = {
    name: taskName(text),
    bookId: null,
    startPage: 1,
    startReadCount: 0,
    startedAt: now,
    endedAt: null,
    durationMs: null,
    reason: null,
  }
  return withBaseline(task, snapshot) ?? task
}

export type DockPhase = 'idle' | 'working' | 'done'

export type DockModel = {
  phase: DockPhase
  isServerUp: boolean
  book: BookDetail | null
  books: BookSummary[]
  chapters: ChapterRow[]
  next: { title: string; pagesLeft: number } | null
  task: { name: string; elapsed: string } | null
  summary: string | null
  reason: DockTask['reason']
}

/** Everything one drawing of the dock needs. */
export function dockModel(snapshot: DockSnapshot | null, task: DockTask | null, now: number): DockModel {
  const isServerUp = snapshot?.isServerUp ?? false
  const book = isServerUp ? (snapshot?.current ?? null) : null
  const rows = book ? chapters(book.outline, book.read, book.page, book.pages) : []
  const isWorking = task !== null && task.endedAt === null
  return {
    phase: isWorking ? 'working' : task ? 'done' : 'idle',
    isServerUp,
    book,
    books: isServerUp ? (snapshot?.books ?? []) : [],
    chapters: rows,
    next: nextUp(rows),
    task: isWorking ? { name: task.name, elapsed: clock(now - task.startedAt) } : null,
    summary: task && !isWorking ? summary(task, book) : null,
    reason: task?.reason ?? null,
  }
}
