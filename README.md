# Book Reader for Claude Code

Read a book while Claude works. When a task runs for more than a few seconds,
your PDF opens by itself at the exact place you stopped: in a browser window of
its own, or as text right in the terminal. When the task is done, the reader
tells you and asks whether to close the book or keep reading.

![The reader: contents with read chapters ticked, page progress and the task status](docs/reader.jpg)

![When the task finishes: close the book or keep reading](docs/task-finished.jpg)

> A community mod for Claude Code. Not affiliated with or endorsed by Anthropic.

## Features

- **Opens while Claude works.** Once a task has run for 5 seconds (configurable),
  the current book opens in its own window. Short tasks never open it.
- **Resumes where you stopped**: same page, same scroll position, same zoom.
  A new book starts at page 1.
- **Remembers what you read.** A page counts as read after it filled most of the
  window for 6 seconds (configurable) while you were there; mark pages by hand
  with `m`. The contents tick a chapter once all of its pages are read, a page
  grid shows every read page, and a bar tracks the whole book.
- **A complete PDF reader** built on [PDF.js](https://mozilla.github.io/pdf.js/):
  continuous scrolling, zoom (buttons, keys, ⌘+scroll, pinch, page width, whole
  page), go to page, search, clickable contents and links, a library of your
  books, and light, sepia and dark themes.
- **Tells you when the task is done**: a dialog in the reader with how long it
  took and the start of Claude's answer, a desktop notification, and a band above
  Claude's prompt, each offering **Close book** or **Keep reading**. Your place
  is saved either way.
- **A Reading Dock in the terminal.** In a wide fullscreen terminal, a pane
  beside the transcript shows the book's progress, a strip of the pages you
  have read, the chapters with ticks, and the running task with a timer. Press
  a chapter to jump there, `l` for your library, `o` to open the reader (or
  raise its window when it is already open). When the task ends it says how
  long it took and how many pages you read meanwhile. `/book dock` folds it to
  the status line and back.
- **Text mode: read inside the terminal.** `/book mode text` and the book opens
  as text in the Reading Dock instead of a browser window, one page at a time
  (`n` / `p`, `g` to go to a page): headings, paragraphs with the book's
  indents, lists, code blocks, and contents pages with their page numbers;
  running heads and page numbers are left out. Pictures on kitty and Ghostty,
  a one-line placeholder elsewhere (see [Text mode](#text-mode)). `o` opens the
  browser at the same page any time, for tables, figures or a scanned page.
  The desktop app's Code tab reads this way too.
- **Local and offline.** PDF.js is bundled, the reader server listens on
  `127.0.0.1` only, and nothing is sent anywhere.

## Requirements

| | |
| --- | --- |
| Claude Code | 2.1.288 or newer (terminal or the desktop app's Code tab). Mods built on function hooks are an early-access Claude Code feature and can change between releases. |
| Node.js | 22.13 or newer. The mod looks on your `PATH`, in your login shell and in the usual install folders (Homebrew, nvm, fnm, Volta, asdf, mise; `Program Files` and nvm-windows on Windows). Or set **Path to node** in `/config`. |
| OS | macOS, Linux or Windows 10/11. |
| Browser | Any modern browser (optional in text mode). With Chrome, Edge, Brave, Chromium or Vivaldi installed, the book opens in its own window without tabs or an address bar (Windows always has Edge). |
| Terminal | Any, for text mode. Pictures need **kitty** or **Ghostty**; other terminals (macOS Terminal, iTerm2, Windows Terminal, VS Code…) show a one-line placeholder for each picture. |

What each OS uses:

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| File picker (`/book choose`) | Finder dialog | `zenity`, `kdialog` or `yad`, whichever is installed | Windows file dialog (PowerShell) |
| Reader window | Chromium browser in app mode, else the default browser | Chromium browser in app mode, else `xdg-open` | Chrome, Edge or Brave in app mode, else the default browser |
| "Task finished" notification | Notification Center | `notify-send` (libnotify), when installed | Tray notification (PowerShell) |

Without a file picker, add books with `/book <file.pdf>`. Without `notify-send`,
the reader's own dialog and the band above Claude's prompt still tell you.

## Install

### From this repository (a plugin marketplace)

In Claude Code, send these as two separate messages:

```
/plugin marketplace add Nomad06/claude-book-reader
```

```
/plugin install book-reader@claude-book-reader
```

Or in a terminal:

```bash
claude plugin marketplace add Nomad06/claude-book-reader
```

```bash
claude plugin install book-reader@claude-book-reader
```

Then start a new Claude Code session. If the install says some "userConfig
options are not yet set", that's fine: every setting has a default (see
[Settings](#settings)).

To update later: `claude plugin marketplace update claude-book-reader`, then
`claude plugin update book-reader@claude-book-reader`. The first `/book` (or
task) after an update replaces the reader server of the older version.

### Optional: figures drawn as pictures in text mode

Some figures in a PDF are not pictures but drawings (lines, curves, shapes).
Text mode can render them as pictures with
[`@napi-rs/canvas`](https://www.npmjs.com/package/@napi-rs/canvas), an optional
native module of about 27 MB. A plugin installed from the marketplace comes
without it; each such figure is then one line,
`▣ <caption> · drawing · o opens in browser`.

To turn it on, run `npm install` in the plugin's folder, then `/book restart`.
Claude Code keeps an installed plugin in
`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, so for this one:

```bash
cd ~/.claude/plugins/cache/claude-book-reader/book-reader/0.2.0
npm install
```

(on Windows, `%USERPROFILE%\.claude\plugins\cache\claude-book-reader\book-reader\0.2.0`).
An update installs into a new version folder: run `npm install` there again.
For a clone loaded with `--plugin-dir`, run `npm install` in the clone. It only
shows where pictures are drawn (kitty, Ghostty).

### From a clone

```bash
git clone https://github.com/Nomad06/claude-book-reader.git ~/claude-book-reader
```

Then load it for one session:

```bash
claude --plugin-dir ~/claude-book-reader
```

or for every session (the desktop app included), in `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "~/claude-book-reader"
  }
}
```

On Windows, clone into a folder of your choice and use its full path, with
doubled backslashes in JSON:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "C:\\Users\\you\\claude-book-reader"
  }
}
```

## Use

Pick a book once, then just work:

```
/book choose
```

| Command | What it does |
| --- | --- |
| `/book` | Open the current book now (asks for one if there is none) |
| `/book choose` | Pick a PDF with the system file dialog |
| `/book <file.pdf>` | Read that PDF: absolute (`/…`, `C:\…`, `\\server\share\…`), `~/…`, or relative to the project |
| `/book list` | Your books with their progress |
| `/book <n>` | Switch to book number *n* of the list |
| `/book close` | Close the reader window (your place is kept) |
| `/book dock` | Show the Reading Dock beside the transcript, or fold it to the status line |
| `/book mode text` / `browser` | Read in the Reading Dock as text, or in the browser window |
| `/book open browser` | Open the browser window at the current page, whatever the mode |
| `/book auto on` / `off` | Open the book by itself while a task runs, or not |
| `/book delay <seconds>` | How long a task must run before the book opens (`0`: at once) |
| `/book status` | What is set up, and why the reader server last failed to start |
| `/book restart` | Restart the reader server (books and places are kept) |
| `/book help` | The list of commands (also `--help`, `-h`) |

`/book choose` waits while the file dialog is open, up to ten minutes.

### Browser mode and text mode

| | Browser mode (default) | Text mode |
| --- | --- | --- |
| Where the book opens | A window of its own (or a tab, see [Settings](#settings)) | The Reading Dock |
| What you see | The PDF itself, every page as printed | The page's text, laid out for the terminal |
| A page counts as read | After it filled most of the window for 6 seconds | After it was on screen in the dock for 6 seconds |
| When a task finishes | A dialog in the reader, a desktop notification and the band above the prompt | A box in the dock |

Switch with `/book mode text` or `/book mode browser` (or **Reading mode** in
`/config`). `/book open browser`, and `o` in the dock, open the browser at the
current page in either mode.

### Text mode

- One page at a time, from the PDF's own text: headings, paragraphs (indents
  kept), lists, code blocks and contents pages. Running heads and page numbers
  are left out.
- **Pictures** are drawn in **kitty** and **Ghostty**. macOS Terminal, iTerm2
  and other terminals show a one-line placeholder for each,
  `▣ <caption> · <size> · o opens in browser`; `o` shows the page in the
  browser.
- **Figures drawn with lines** rather than stored as pictures need the
  optional canvas module: see
  [above](#optional-figures-drawn-as-pictures-in-text-mode).
- A scanned page has no text: kitty and Ghostty show its picture, other
  terminals say so; `o` opens it in the browser.
- The dock opens by itself (when a task runs) from 144 terminal columns.
  `/book dock` opens it at any width: beside the transcript in the fullscreen
  layout from 110 columns, else above the prompt.

### Reader keys

| Key | |
| --- | --- |
| `→` `j` `n` / `←` `k` `p` | Next / previous page |
| `Space` / `⇧Space` | Scroll down / up |
| `Home` / `End` | First / last page |
| `g` | Go to page |
| `+` `−` `0` (or with ⌘ / Ctrl) | Zoom in / out / page width |
| ⌘ / Ctrl + scroll, pinch | Zoom |
| `⌘F` / `Ctrl+F` or `/` | Find |
| `m` | Mark the page read or unread |
| `u` | First unread page |
| `b` | Sidebar: contents, pages, library |
| `t` | Theme: light, sepia, dark |
| `?` | All shortcuts |

When a task finishes, `Esc` keeps reading and `C` closes the book.

### Reading Dock keys

With the Reading Dock focused, on its dashboard:

| Key | |
| --- | --- |
| `o` | Open the reader (in browser mode, raises its window when it is already open) |
| `r` | In text mode: read here, at your saved page |
| `l` | Your library; `b` goes back |
| a chapter | Jump there |

In the text reader:

| Key | |
| --- | --- |
| `n` / `p` | Next / previous page |
| `g` | Go to page: focuses the "page" field; type a number and press Enter |
| `m` | Mark the page read or unread |
| `o` | Open the browser at this page (raises its window when it is already open) |
| `d` | Back to the dashboard |
| `l` | Your library |

When a task finishes, the done box appears in the reader: `c` closes the book
(the pane returns to the dashboard), `k` keeps reading.

## Settings

In `/config` (or `/plugin configure book-reader@claude-book-reader`):

| Setting | Default | |
| --- | --- | --- |
| Open the book automatically | on | Same as `/book auto on` / `off` |
| Delay before opening (seconds) | 5 | Same as `/book delay` |
| Reading mode | browser | Same as `/book mode text` / `browser` |
| Reader window | `app` | `app`: its own window in Chrome, Edge, Brave, Chromium or Vivaldi; `browser`: a tab in your default browser |
| Desktop notification when a task finishes | on | On Linux this needs `notify-send` |
| Reader server port | 47321 | Change it if another program uses that port |
| Path to node | *(empty)* | Leave empty to find `node` on your `PATH` |

`/book auto` and `/book delay` override the first two.

## How it works

```
Claude Code ──hooks──▶ book-reader mod ──HTTP──▶ reader server (Node, 127.0.0.1:47321)
                       (hooks/*.tsx)              (server/server.mjs)
                       Reading Dock, text mode           │  serves PDF.js + your PDF
                                                         │  turns pages into text (PDF.js in Node)
                                                         │  pushes task events (SSE)
                                                         ▼
                                                  reader window (viewer/)
```

- The **mod** hooks the start and end of each of Claude's turns. When a turn
  runs past the delay, it starts the reader server if needed and asks it to
  show the book. When the turn ends, it tells the server, which tells the
  reader, and shows the band above the prompt. It also draws the Reading Dock
  and, in text mode, the page.
- The **reader server** keeps your library and progress in
  `~/.claude/book-reader/state.json`, serves the reader page and your PDF,
  turns pages into text for text mode, and pushes task events to the open
  reader. It stops by itself after 6 hours without use. One server is shared by
  all your Claude Code sessions; a server of an older version of the mod is
  replaced automatically, a newer one is kept.
- The **reader** is a PDF.js viewer that reports your place and read pages back
  to the server.

## Privacy

Everything runs on your machine. The reader server listens on `127.0.0.1`
only, and the mod talks to it and to nothing else. Your library, places and
read pages stay in `~/.claude/book-reader/` (`%USERPROFILE%\.claude\book-reader\`
on Windows), with the pictures text mode extracted, the reader window's
browser profile and the server's log. No telemetry and no network requests of
its own. What it runs on your machine, and why, is in [SECURITY.md](SECURITY.md).

## Troubleshooting

- **Something is off:** `/book status` says which book and mode, whether the
  reader server runs, and why it last failed to start. `/book restart` starts
  the server again; your books and places are kept. The server's log is
  `~/.claude/book-reader/server.log`.
- **"book-reader needs Node 22.13 or newer; found v…"**: install a newer
  Node.js, or point **Path to node** in `/config` at one.
- **"node was not found"**: install Node.js 22.13 or newer, or set **Path to
  node** in `/config`.
- **"port 47321 is taken by another program"**: pick another **Reader server
  port** in `/config`.
- **"no browser could be opened"**: open the address it gives by hand.
- **Pictures are one line in text mode**: the terminal is not kitty or
  Ghostty; `o` opens the page in the browser.
- **A figure says "drawing"**: install the optional canvas module, see
  [above](#optional-figures-drawn-as-pictures-in-text-mode).
- **The dock does not open by itself**: the terminal is under 144 columns;
  `/book dock` opens it at any width.

## Limitations

- **Linux needs a few desktop tools** for everything to work: `zenity` (or
  `kdialog`, `yad`) for the file picker, `notify-send` for notifications, and
  `xdg-open` or a Chromium browser for the reader window. Without a way to open
  a browser, `/book` gives you the address to open by hand.
- **WSL** counts as Linux: the reader server runs inside WSL, so the file
  picker, notification and browser come from WSL's desktop support, if any.
- **One server for all sessions.** If two Claude Code sessions run tasks at the
  same time, the reader shows the events of both.
- **Early-access Claude Code API.** The mod is built on function hooks, which
  Claude Code may change between releases.
- Text mode reads the PDF's own text: scanned books have none (use `o` for the
  browser), two-column layouts and tables come out as plain paragraphs, and
  mathematics is not laid out. Each page has caps on its work (text, pictures,
  figures and time), so a very heavy page shows less; `o` shows all of it.
- A browser only lets a page close windows it opened itself; when it refuses,
  the reader shows "Bookmarked" and you close the window yourself.

## Development

```
.claude-plugin/plugin.json        manifest and settings
.claude-plugin/marketplace.json   lets the repo be added as a marketplace
hooks/register.tsx                the mod: /book, turn hooks, the band above the prompt
hooks/dock.tsx, hooks/reader.tsx  the Reading Dock: dashboard and the text reader view
hooks/*-logic.ts                  their pure helpers (unit-tested)
hooks/*.test.tsx                  the mod's tests (claude plugin test)
types/index.d.ts                  the mod's state contract
server/server.mjs                 the reader server (optional dependency: @napi-rs/canvas)
server/shared.mjs, server/text.mjs  small helpers (unit-tested)
server/platform.mjs               what it runs on macOS, Linux and Windows (pure, unit-tested)
server/pdf-source.mjs             opens a PDF with PDF.js in Node: text items, images, outline
server/page-blocks.mjs            turns a page's text items into headings, paragraphs, lists, code (pure)
test/*.test.mjs                   server and extraction tests (node --test); platform tests parse the PowerShell scripts where PowerShell exists
viewer/                           the reader page; viewer/vendor/pdfjs is PDF.js
scripts/update-pdfjs.sh           re-vendors PDF.js
```

```bash
npm test
```

runs both suites (`node --test "test/*.test.mjs"` and `claude plugin test .`); it needs
Node 22.13 or newer, the floor of the reader server (pdf.js in Node). The tests
that render figures need `@napi-rs/canvas` (`npm install`) and are skipped
without it. CI runs the suites on macOS, Linux and Windows.

```bash
claude plugin validate .
```

(or `npm run validate`) checks the manifest and the mod as Claude Code loads them.

While developing, load your clone with `claude --plugin-dir .`: Claude Code
reloads the mod when you save. Run `/book restart` after changing anything in
`server/`. Claude Code writes the mod's type declarations to
`.claude-plugin/types/` when it loads the mod (git ignores them); after that,
`npx tsc -p .` type-checks the mod.

To move to another PDF.js version: `npm run update-pdfjs -- <version>`, then
update the version in `NOTICE` and check the reader and text mode. Only the
`legacy/` build of PDF.js is vendored; the server and the browser viewer both use it.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

[Apache-2.0](LICENSE). PDF.js and its bundled resources keep their own licenses;
see [NOTICE](NOTICE).
