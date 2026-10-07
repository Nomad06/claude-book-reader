/** What the band above the prompt shows once a task you read through has finished. */
export type DoneBand = {
  title: string
  page: number
  pages: number | null
  readCount: number
  durationMs: number
  reason: 'answer' | 'aborted' | 'refusal' | 'error'
}

/** One book as the reader server reports it. */
export type BookSummary = {
  id: string
  path: string
  title: string
  page: number
  pages: number | null
  readCount: number
  openedAt: number
}

/** One entry of a book's contents, as the reader found it in the PDF. */
export type OutlineEntry = { title: string; page: number; level: number }

/** The current book with what the dock draws from: read pages and contents. */
export type BookDetail = BookSummary & { read: number[]; outline: OutlineEntry[] | null }

/** `GET /api/state` of the reader server. */
export type ReaderState = {
  current: BookSummary | null
  books: BookSummary[]
  viewers: number
  task: { state: string; seq: number; acked: boolean }
}

/** What the Reading Dock last fetched from the reader server. */
export type DockSnapshot = {
  isServerUp: boolean
  current: BookDetail | null
  books: BookSummary[]
  viewers: number
}

/** The task the dock follows, from its start until the person closes the book or reads on. */
export type DockTask = {
  name: string
  /** The book when the task started; null until the server first answers with one. */
  bookId: string | null
  startPage: number
  startReadCount: number
  startedAt: number
  endedAt: number | null
  durationMs: number | null
  reason: DoneBand['reason'] | null
}

/** What the dock's body shows: the current book, or the library. */
export type DockView = 'main' | 'library'

declare module 'claude-code' {
  interface PluginState {
    'book-reader': {
      band: DoneBand | null
      dock: DockSnapshot | null
      dockTask: DockTask | null
      dockView: DockView
      blink: boolean
    }
  }
}
