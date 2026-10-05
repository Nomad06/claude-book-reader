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

/** `GET /api/state` of the reader server. */
export type ReaderState = {
  current: BookSummary | null
  books: BookSummary[]
  viewers: number
  task: { state: string; seq: number; acked: boolean }
}

declare module 'claude-code' {
  interface PluginState {
    'book-reader': { band: DoneBand | null }
  }
}
