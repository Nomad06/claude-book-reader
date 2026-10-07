import { atom, read } from 'claude-code'
import type { On } from 'claude-code'

import { ACCENT_FROM, GREEN, dockModel, gradient, percent, spaced } from './dock-logic.ts'

// The Reading Dock: a pane beside the transcript, drawn from the state that
// register.tsx keeps up to date. A press that reaches the reader server (open,
// jump, switch book, close, keep reading) is answered by register.tsx's
// `ui.press` hook, since `$` never crosses an import; such a Button's own
// onPress does nothing. This file only draws, and switches its own view.

const DOCK = 'book-dock'
const dock = atom({ plugin: 'book-reader', key: 'dock' } as const, null)
const dockTask = atom({ plugin: 'book-reader', key: 'dockTask' } as const, null)
const blink = atom({ plugin: 'book-reader', key: 'blink' } as const, false)

/** For a Button whose press register.tsx answers. */
const answeredByRegister = () => {}

export function registerDock(on: On): void {
  on('ui.render', { component: 'Pane', requestId: DOCK }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const model = dockModel(await read($, dock), await read($, dockTask), await $.clock.now())
    const isBlinkOn = await read($, blink)
    const columns = Math.max(20, e.props.bodyColumns)

    const gradientText = (text: string) => {
      const colors = gradient([...text].length)
      return [...text].map((ch, i) => <Text color={colors[i]}>{ch}</Text>)
    }

    const state =
      model.phase === 'working' ? (
        <Text color={GREEN} dimColor={!isBlinkOn}>
          ● {spaced('Reading')}
        </Text>
      ) : model.phase === 'done' ? (
        <Text color={GREEN}>{spaced('Complete')}</Text>
      ) : (
        <Text dimColor>{spaced('Standing by')}</Text>
      )

    const book = model.book
    const place = book ? (book.pages ? `p. ${book.page} / ${book.pages} · ${percent(book.readCount, book.pages)}%` : `p. ${book.page}`) : ''

    return (
      <Box flexDirection="column">
        <Box key="masthead" flexDirection="row" justifyContent="space-between">
          <Text>
            <Text color={ACCENT_FROM}>◆  </Text>
            {gradientText(spaced('Book Reader'))}
          </Text>
          {state}
        </Box>
        <Text dimColor>{'─'.repeat(columns)}</Text>
        {book ? (
          <Box key="book" flexDirection="row" justifyContent="space-between">
            <Text bold wrap="truncate-end">
              {book.title}
            </Text>
            <Text>{place}</Text>
          </Box>
        ) : (
          <Text dimColor>{model.isServerUp ? 'No book yet · run /book choose' : 'Reader server not running · starts with the next task'}</Text>
        )}
        {model.task && (
          <Box key="task" flexDirection="row" justifyContent="space-between">
            <Text wrap="truncate-end">
              <Text dimColor>{spaced('Task')}   </Text>
              {model.task.name}
            </Text>
            <Text>
              <Text color={GREEN}>● working</Text>  {model.task.elapsed}
            </Text>
          </Box>
        )}
        {model.phase === 'done' && (
          <Box key="done" flexDirection="column" borderStyle="round" borderColor={model.reason === 'answer' ? GREEN : undefined}>
            <Text color={model.reason === 'answer' ? GREEN : undefined}>{model.summary}</Text>
            <Box flexDirection="row" columnGap={2}>
              <Button key="dock-close" label="Close book" hotkey="c" variant="primary" onPress={answeredByRegister} />
              <Button key="dock-keep" label="Keep reading" hotkey="k" onPress={answeredByRegister} />
            </Box>
          </Box>
        )}
      </Box>
    )
  })
}
