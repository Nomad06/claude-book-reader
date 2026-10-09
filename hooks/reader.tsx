import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'

import type { Block, Run } from '../types'
import { ACCENT_FROM, ACCENT_TO, CURRENT, GREEN, bar, dockModel, gradient, noBookLine, percent, phaseWord, spaced } from './dock-logic.ts'
import { drawingLine, fitTitle, imageBox, imageLine, pageLabel, splitUrls, textWidth, tocRows } from './reader-logic.ts'

// The reader view of the Reading Dock: one page of the book as text, drawn
// from the page register.tsx fetched. Presses that reach the server (page
// turns, mark read, open the browser) are answered by register.tsx's
// `ui.press` hook; this file draws, switches views and moves the focus.

const DOCK = 'book-dock'
const dock = atom({ plugin: 'book-reader', key: 'dock' } as const, null)
const dockTask = atom({ plugin: 'book-reader', key: 'dockTask' } as const, null)
const dockView = atom({ plugin: 'book-reader', key: 'dockView' } as const, 'main')
const blink = atom({ plugin: 'book-reader', key: 'blink' } as const, false)
const readerPage = atom({ plugin: 'book-reader', key: 'readerPage' } as const, null)
const readerNote = atom({ plugin: 'book-reader', key: 'readerNote' } as const, null)
const graphics = atom({ plugin: 'book-reader', key: 'graphics' } as const, false)

/** Narrower than this, the page is not drawn: the browser reads it better. */
const MIN_COLUMNS = 40

/** For a Button whose press register.tsx answers. */
const answeredByRegister = () => {}

/** A paragraph's first line starts this far in. */
const PARA_INDENT = '   '

/** How a block styles every run in it (a caption: dim italic). */
type RunStyle = { italic?: true; dimColor?: true }

export function registerReader(on: On): void {
  on('ui.render', { component: 'Pane', requestId: DOCK }, async ($, e, next) => {
    if ((await read($, dockView)) !== 'reader') return next(e)
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    const model = dockModel(await read($, dock), await read($, dockTask), await $.clock.now())
    const book = model.book
    const held = await read($, readerPage)
    // A page left from another book (its own fetch failed) is not this book's.
    // With the server gone there is no book to ask: the last page stays (n/p retry).
    const isServerDown = !model.isServerUp
    const page = held && (book ? held.bookId === book.id : isServerDown) ? held : null
    const note = await read($, readerNote)
    const canDrawImages = e.surface === 'terminal' && (await read($, graphics))
    const isBlinkOn = await read($, blink)
    const columns = Math.max(20, e.props.bodyColumns)
    const isNarrow = columns < MIN_COLUMNS
    // The engine's mobile table has no Input; the test kit's resolve still hands
    // one over there (and draws nothing), so the surface is checked as well.
    const hasGotoField = e.surface !== 'mobile' && 'Input' in els
    const showView = (to: 'main' | 'library') => update($, dockView, () => to)
    const focusGoto = () =>
      $.ui
        .focus({ requestId: DOCK, key: 'reader-goto' })
        .then(result => {
          if (result.deny) $.ui.log(`book-reader: go to: ${result.deny}`, { to: 'debug' })
        })
        .catch(error => $.ui.log(`book-reader: go to: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' }))

    // The masthead, task row and done box are drawn as dock.tsx draws them: the
    // element constructors come from this hook's own `$.ui.resolve(e)`, so the
    // element-building code cannot be shared; their words come from dock-logic.ts.
    const gradientText = (text: string) => {
      const colors = gradient([...text].length)
      return [...text].map((ch, i) => <Text color={colors[i]}>{ch}</Text>)
    }

    const masthead = (
      <Box key="masthead" flexDirection="row" justifyContent="space-between">
        <Text>
          <Text color={ACCENT_FROM}>◆  </Text>
          {gradientText(isNarrow ? 'Book Reader' : spaced('Book Reader'))}
        </Text>
        {!isNarrow &&
          (model.phase === 'working' ? (
            <Text color={GREEN} dimColor={!isBlinkOn}>
              ● {phaseWord(model.phase)}
            </Text>
          ) : model.phase === 'done' ? (
            <Text color={GREEN}>{phaseWord(model.phase)}</Text>
          ) : (
            <Text dimColor>{phaseWord(model.phase)}</Text>
          ))}
      </Box>
    )
    const hairline = <Text dimColor>{'─'.repeat(columns)}</Text>

    const runs = (list: Run[], style: RunStyle = {}) =>
      list.flatMap(run =>
        run.mono
          ? [
              <Text color={CURRENT} {...style}>
                {run.text}
              </Text>,
            ]
          : // A url is drawn dim; the rest of the run keeps its own style.
            splitUrls(run.text).map(part => (
              <Text bold={run.bold} italic={run.italic ?? style.italic} dimColor={style.dimColor || part.isUrl || undefined}>
                {part.text}
              </Text>
            )),
      )

    const block = (b: Block, i: number) => {
      switch (b.kind) {
        case 'heading':
          return b.level === 1 ? (
            <Text bold color={ACCENT_TO} wrap="wrap">
              {runs(b.runs)}
            </Text>
          ) : (
            <Text bold wrap="wrap">
              {runs(b.runs)}
            </Text>
          )
        case 'para':
          return (
            <Text wrap="wrap">
              {PARA_INDENT}
              {runs(b.runs)}
            </Text>
          )
        case 'toc': {
          // The title may wrap; the leader and the page close its last row.
          const isBold = b.runs.length > 0 && b.runs.every(run => run.bold)
          const rows = tocRows(
            b.runs.map(run => run.text).join(''),
            b.page,
            b.level,
            columns,
          )
          return (
            <Box flexDirection="column">
              {rows.map(row => (
                <Text wrap="truncate-end">
                  <Text bold={isBold}>{row.text}</Text>
                  {row.leader && <Text dimColor> {row.leader} </Text>}
                  {row.leader && row.page}
                </Text>
              ))}
            </Box>
          )
        }
        case 'list':
          return (
            <Text wrap="wrap">
              {'  '}
              {runs(b.runs)}
            </Text>
          )
        case 'caption':
          return (
            <Text dimColor italic wrap="wrap">
              {runs(b.runs, { italic: true, dimColor: true })}
            </Text>
          )
        case 'code':
          return (
            <Box borderStyle="round" paddingX={1}>
              <els.Code source={b.text} />
            </Box>
          )
        case 'image': {
          if (canDrawImages && 'Image' in els) {
            const box = imageBox(b.width, b.height, columns)
            return (
              <els.Image
                key={`img-${page?.page ?? 0}-${i}`}
                source={{ file: b.file, format: 'rgb', width: b.width, height: b.height }}
                columns={box.columns}
                rows={box.rows}
                alt={b.alt}
              />
            )
          }
          return <Text dimColor>{imageLine(b.alt, b.width, b.height)}</Text>
        }
        case 'drawing':
          return <Text dimColor>{drawingLine(b.alt)}</Text>
      }
    }

    const header = () => {
      if (!book) {
        // The server gone: the page held, its title and read pages unknown until it is back.
        return (
          page && (
            <Box key="header" flexDirection="row" justifyContent="space-between">
              <Text dimColor wrap="truncate-end">
                Reader server not running · n/p retry
              </Text>
              <Text>{pageLabel(page.page, page.pages, false)}</Text>
            </Box>
          )
        )
      }
      // A book whose page count is still unknown has no bar (as dock.tsx's bookHeader).
      const progress = book.pages ? bar(book.readCount / book.pages, 10) : null
      const label = pageLabel(page?.page ?? book.page, page?.pages ?? book.pages, page ? book.read.includes(page.page) : false)
      // The title gives way so that label, bar and percent stay on its row; one column between.
      const rightWidth = textWidth(label) + (progress ? 1 + progress.filled + progress.empty + 1 + `${percent(book.readCount, book.pages)}%`.length : 0)
      return (
        <Box key="header" flexDirection="row" justifyContent="space-between">
          <Text bold wrap="truncate-end">
            {fitTitle(book.title, columns - rightWidth - 1)}
          </Text>
          <Text>
            {label}
            {progress && (
              <Text>
                {' '}
                {gradientText('━'.repeat(progress.filled))}
                <Text dimColor>{'─'.repeat(progress.empty)}</Text> {percent(book.readCount, book.pages)}%
              </Text>
            )}
          </Text>
        </Box>
      )
    }

    const body = () => {
      // The note line above already says why there is no page (loading, an error).
      if (!page) return note ? null : <Text dimColor>No page loaded yet</Text>
      if (page.scanned && !(canDrawImages && 'Image' in els)) return <Text dimColor>No text on this page · o opens in browser</Text>
      if (page.blocks.length === 0) return <Text dimColor>Nothing to show on this page · o opens in browser</Text>
      return (
        <Box flexDirection="column" rowGap={1}>
          {page.blocks.map((b, i) => block(b, i))}
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
        <Button key="reader-prev" plain label="← prev" hotkey="p" onPress={answeredByRegister} />
        <Button key="reader-next" plain label="next →" hotkey="n" onPress={answeredByRegister} />
        {/* No field, no g: the mobile app draws no Input yet (its table has none). */}
        {hasGotoField && <Button key="reader-go" plain label="go to" hotkey="g" onPress={focusGoto} />}
        {hasGotoField && 'Input' in els && <els.Input key="reader-goto" placeholder="page" onSubmit={answeredByRegister} />}
        <Button key="reader-mark" plain label="mark read" hotkey="m" onPress={answeredByRegister} />
        <Button key="reader-open" plain label="browser" hotkey="o" onPress={answeredByRegister} />
        <Button key="reader-dash" plain label="dashboard" hotkey="d" onPress={() => showView('main')} />
        <Button key="reader-library" plain label="library" hotkey="l" onPress={() => showView('library')} />
      </Box>
    )

    if (!book && !page) {
      // A task still runs or ends here (the server gone mid-task): its row and done box stay.
      return (
        <Box flexDirection="column">
          {masthead}
          {hairline}
          <Text dimColor>{noBookLine(model.isServerUp)}</Text>
          {taskRow()}
          {model.phase === 'done' && doneBox()}
          <Button key="reader-dash" plain label="dashboard" hotkey="d" onPress={() => showView('main')} />
        </Box>
      )
    }

    if (isNarrow) {
      return (
        <Box flexDirection="column">
          {masthead}
          {header()}
          <Text dimColor>Widen the terminal to read here · o opens in browser</Text>
          <Box flexDirection="row" columnGap={2}>
            <Button key="reader-open" plain label="browser" hotkey="o" onPress={answeredByRegister} />
            <Button key="reader-dash" plain label="dashboard" hotkey="d" onPress={() => showView('main')} />
          </Box>
          {model.phase === 'done' && doneBox()}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {masthead}
        {hairline}
        {header()}
        {note && <Text dimColor>{note}</Text>}
        {body()}
        {hairline}
        {taskRow()}
        {model.phase === 'done' && doneBox()}
        {footer()}
      </Box>
    )
  })
}
