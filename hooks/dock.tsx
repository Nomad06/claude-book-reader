import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'

import type { BookDetail, BookSummary, DockView } from '../types'
import {
  ACCENT_FROM,
  ACCENT_TO,
  CURRENT,
  GREEN,
  READ,
  SPINE_INK,
  UNREAD,
  bar,
  dockModel,
  gradient,
  heatmap,
  initials,
  noBookLine,
  percent,
  phaseWord,
  spaced,
  spineColor,
  tier,
} from './dock-logic.ts'
import type { Bucket } from './dock-logic.ts'

// The Reading Dock: a pane beside the transcript, drawn from the state that
// register.tsx keeps up to date. A press that reaches the reader server (open,
// jump, switch book, close, keep reading) is answered by register.tsx's
// `ui.press` hook, since `$` never crosses an import; such a Button's own
// onPress does nothing. This file only draws, and switches its own view.

const DOCK = 'book-dock'
const dock = atom({ plugin: 'book-reader', key: 'dock' } as const, null)
const dockTask = atom({ plugin: 'book-reader', key: 'dockTask' } as const, null)
const dockView = atom({ plugin: 'book-reader', key: 'dockView' } as const, 'main')
const blink = atom({ plugin: 'book-reader', key: 'blink' } as const, false)
const readerMode = atom({ plugin: 'book-reader', key: 'readerMode' } as const, 'browser')

/** Chapter rows shown at once; the list starts up to three rows before the current one. */
const MAX_ROWS = 12

const BUCKET_COLOR: Record<Bucket, string | undefined> = { read: READ, unread: UNREAD, current: CURRENT, none: undefined }

/** For a Button whose press register.tsx answers. */
const answeredByRegister = () => {}

export function registerDock(on: On): void {
  on('ui.render', { component: 'Pane', requestId: DOCK }, async ($, e, next) => {
    // The reader view (text mode) is reader.tsx's.
    if ((await read($, dockView)) === 'reader') return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const model = dockModel(await read($, dock), await read($, dockTask), await $.clock.now())
    const view = await read($, dockView)
    const isBlinkOn = await read($, blink)
    const isTextMode = (await read($, readerMode)) === 'text'
    const columns = Math.max(20, e.props.bodyColumns)
    const size = tier(columns)
    const showView = (to: DockView) => update($, dockView, () => to)

    const gradientText = (text: string) => {
      const colors = gradient([...text].length)
      return [...text].map((ch, i) => <Text color={colors[i]}>{ch}</Text>)
    }

    const progressBar = (fraction: number, width: number, label: string) => {
      const { filled, empty } = bar(fraction, width)
      return (
        <Text>
          {gradientText('━'.repeat(filled))}
          <Text dimColor>{'─'.repeat(empty)}</Text>
          <Text> {label}</Text>
        </Text>
      )
    }

    const spine = (title: string) => (
      <Text backgroundColor={spineColor(title)} color={SPINE_INK} bold>
        {` ${initials(title).padEnd(4)} `}
      </Text>
    )

    const place = (book: BookSummary) =>
      book.pages ? `p. ${book.page} / ${book.pages} · ${percent(book.readCount, book.pages)}%` : `p. ${book.page}`

    const masthead = () => {
      const state =
        model.phase === 'working' ? (
          <Text color={GREEN} dimColor={!isBlinkOn}>
            ● {phaseWord(model.phase)}
          </Text>
        ) : model.phase === 'done' ? (
          <Text color={GREEN}>{phaseWord(model.phase)}</Text>
        ) : (
          <Text dimColor>{phaseWord(model.phase)}</Text>
        )
      return (
        <Box key="masthead" flexDirection="row" justifyContent="space-between">
          <Text>
            <Text color={ACCENT_FROM}>◆  </Text>
            {gradientText(size === 'tiny' ? 'Book Reader' : spaced('Book Reader'))}
          </Text>
          {size !== 'tiny' && state}
        </Box>
      )
    }

    const heatRow = (book: BookDetail, width: number) => (
      <Text>
        {heatmap(book.read, book.page, book.pages, width).map(cell => (
          <Text color={BUCKET_COLOR[cell.top]} backgroundColor={BUCKET_COLOR[cell.bottom]}>
            ▀
          </Text>
        ))}
      </Text>
    )

    const bookHeader = (book: BookDetail) => {
      const width = size === 'full' ? columns - 9 : columns
      const current = model.chapters.find(row => row.status === 'current')
      const lines = (
        <Box flexDirection="column" width={width}>
          <Text bold wrap="truncate-end">
            {book.title}
          </Text>
          <Box flexDirection="row" justifyContent="space-between">
            <Text dimColor wrap="truncate-end">
              {current?.title ?? ''}
            </Text>
            <Text>{place(book)}</Text>
          </Box>
          {book.pages !== null && progressBar(book.readCount / book.pages, width - 6, `${String(percent(book.readCount, book.pages)).padStart(3)}%`)}
          {size === 'full' && heatRow(book, width)}
        </Box>
      )
      if (size !== 'full') return lines
      return (
        <Box key="book" flexDirection="row" columnGap={1}>
          {spine(book.title)}
          {lines}
        </Box>
      )
    }

    const contents = (book: BookDetail) => {
      if (book.outline === null) return <Text dimColor>Contents appear after the first open</Text>
      if (model.chapters.length === 0) return <Text dimColor>No table of contents in this book</Text>
      const at = Math.max(0, model.chapters.findIndex(row => row.status === 'current'))
      const start = Math.max(0, Math.min(at - 3, model.chapters.length - MAX_ROWS))
      const rows = model.chapters.slice(start, start + MAX_ROWS)
      const more = model.chapters.length - start - rows.length
      return (
        <Box key="contents" flexDirection="column">
          <Text dimColor>{spaced('Contents')}</Text>
          {rows.map((row, i) => (
            <Box flexDirection="row" columnGap={1}>
              <Text color={row.status === 'todo' ? undefined : ACCENT_TO}>
                {row.status === 'done' ? '✓' : row.status === 'current' ? '▸' : ' '}
              </Text>
              <Button key={`ch-${row.page}-${start + i}`} plain label={row.title} dimColor={row.status === 'todo'} onPress={answeredByRegister} />
              {row.status === 'current' && progressBar(row.readPages / (row.endPage - row.page + 1), 16, `${row.percent}%`)}
            </Box>
          ))}
          {more > 0 && <Text dimColor>  … {more} more</Text>}
        </Box>
      )
    }

    const taskRow = () =>
      model.task && (
        <Box key="task" flexDirection="row" justifyContent="space-between">
          <Text wrap="truncate-end">
            <Text dimColor>{spaced('Task')}   </Text>
            {model.task.name}
          </Text>
          <Text>
            <Text color={GREEN}>● working</Text>  {model.task.elapsed}
          </Text>
        </Box>
      )

    const doneBox = () => (
      <Box key="done" flexDirection="column" borderStyle="round" borderColor={model.reason === 'answer' ? GREEN : undefined}>
        <Text color={model.reason === 'answer' ? GREEN : undefined}>{model.summary}</Text>
        <Box flexDirection="row" columnGap={2}>
          <Button key="dock-close" label="Close book" hotkey="c" variant="primary" onPress={answeredByRegister} />
          <Button key="dock-keep" label="Keep reading" hotkey="k" onPress={answeredByRegister} />
        </Box>
      </Box>
    )

    const footer = () => (
      <Box key="keys" flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Button key="dock-open" label="Open reader" hotkey="o" onPress={answeredByRegister} />
        {/* Shows the reader view and loads the page: register.tsx answers it. */}
        {isTextMode && <Button key="reader-read" label="Read here" hotkey="r" onPress={answeredByRegister} />}
        <Button key="dock-library" label="Library" hotkey="l" onPress={() => showView('library')} />
        <Text dimColor>tab chapters · esc back</Text>
      </Box>
    )

    const library = () => (
      <Box key="library" flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor>{spaced('Library')}</Text>
          <Button key="dock-back" label="Back" hotkey="b" onPress={() => showView('main')} />
        </Box>
        {model.books.map(book => (
          <Box flexDirection="row" columnGap={1}>
            {spine(book.title)}
            <Button key={`book-${book.id}`} plain label={book.title} onPress={answeredByRegister} />
            {book.pages !== null && progressBar(book.readCount / book.pages, 12, `${percent(book.readCount, book.pages)}%`)}
            {book.id === model.book?.id && <Text dimColor>← current</Text>}
          </Box>
        ))}
      </Box>
    )

    const hairline = <Text dimColor>{'─'.repeat(columns)}</Text>
    const book = model.book

    if (!book) {
      return (
        <Box flexDirection="column">
          {masthead()}
          {hairline}
          <Text dimColor>{noBookLine(model.isServerUp)}</Text>
          {taskRow()}
          {model.phase === 'done' && doneBox()}
        </Box>
      )
    }

    if (size === 'tiny') {
      return (
        <Box flexDirection="column">
          {masthead()}
          <Text wrap="truncate-end">{book.title}</Text>
          <Text>{place(book)}</Text>
          {model.task && (
            <Text>
              <Text color={GREEN}>● working</Text> {model.task.elapsed}
            </Text>
          )}
          {model.phase === 'idle' && <Text dimColor>standing by</Text>}
          {model.phase === 'done' && doneBox()}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {masthead()}
        {hairline}
        {view === 'library' ? (
          library()
        ) : (
          <Box flexDirection="column" rowGap={1}>
            {bookHeader(book)}
            {model.phase === 'idle' && model.next && (
              <Text dimColor>
                Next up · {model.next.title} · {model.next.pagesLeft} {model.next.pagesLeft === 1 ? 'page' : 'pages'} left
              </Text>
            )}
            {size === 'full' && contents(book)}
            {taskRow()}
            {model.phase === 'done' && doneBox()}
            {footer()}
          </Box>
        )}
      </Box>
    )
  })
}
