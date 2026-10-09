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
  settings?: { theme?: string; readSeconds?: number; mode?: string }
}

/** What the Reading Dock last fetched from the reader server. */
export type DockSnapshot = {
  isServerUp: boolean
  current: BookDetail | null
  books: BookSummary[]
  viewers: number
  /** The server's `settings.readSeconds`: how long a page stays on screen before it counts as read. */
  readSeconds?: number
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

/** One styled stretch of page text. */
export type Run = { text: string; bold?: true; italic?: true; mono?: true }

/** One block of a page, as the reader server extracts it. */
export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; runs: Run[] }
  | { kind: 'para'; runs: Run[] }
  | { kind: 'list'; runs: Run[] }
  | { kind: 'caption'; runs: Run[] }
  | { kind: 'code'; text: string }
  | { kind: 'image'; file: string; width: number; height: number; alt: string }

/** `GET /api/books/:id/page/:n`, plus which book and when it was fetched. */
export type ReaderPage = {
  bookId: string
  page: number
  pages: number
  blocks: Block[]
  scanned: boolean
  error?: string
  fetchedAt: number
}

/** Where the book is read: the browser window, or the dock pane as text. */
export type ReaderMode = 'browser' | 'text'

/** What the dock's body shows: the current book, the library, or a page of text. */
export type DockView = 'main' | 'library' | 'reader'

declare module 'claude-code' {
  interface PluginState {
    'book-reader': {
      band: DoneBand | null
      dock: DockSnapshot | null
      dockTask: DockTask | null
      dockView: DockView
      blink: boolean
      readerPage: ReaderPage | null
      /** When the current page landed on screen; null while it is not shown. */
      readerShownAt: number | null
      /** One line under the header: loading, or the last error. */
      readerNote: string | null
      /** The terminal draws pictures (kitty, Ghostty). */
      graphics: boolean
      /** The reading mode the server last reported: the dashboard offers `r` read here in text mode. */
      readerMode: ReaderMode
    }
  }
}
