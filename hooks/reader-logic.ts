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
