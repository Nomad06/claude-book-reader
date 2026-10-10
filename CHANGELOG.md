# Changelog

## 0.2.0

- **Text mode.** `/book mode text` reads the book inside the Reading Dock, one page at a time (`n` / `p`, `g` to go to a page, `m` to mark it read), instead of a browser window. The reader server extracts each page with pdf.js in Node: headings, paragraphs with the book's indents, lists, code blocks and contents pages with their page numbers; running heads and page numbers are left out. A page counts as read after 6 seconds on screen, and the "task finished" choice appears in the dock. `/book mode browser` goes back; **Reading mode** in `/config` sets the default.
- **Pictures in text mode** on kitty and Ghostty. Other terminals (macOS Terminal, iTerm2, …) show a one-line placeholder per picture. Figures drawn with lines rather than stored as pictures are rendered too when the optional `@napi-rs/canvas` module is installed (`npm install` in the plugin folder, see the README); without it each is one line, `▣ <caption> · drawing · o opens in browser`. Work per page is capped (text, pictures, figures, time).
- `/book open browser`, and `o` in the dock, open the browser at the current page whatever the mode. When the reader's own window (the `app` window, not a browser tab) is already open, `o` and `/book` now bring it to the front (macOS; Linux with `pgrep` and `xdotool`; Windows).
- **Reading Dock**: a pane beside the transcript (fullscreen terminal; it opens by itself from 144 columns) with the book's progress, a read-pages strip, chapters with ticks and the running task. It replaces the "task finished" band while it is shown. Press a chapter to jump there; `l` opens the library, `o` the reader. `/book dock` folds it to a status-line badge and back; a folded dock, or one closed by hand, stays closed through tasks until `/book` or `/book dock`.
- **Node 22.13 or newer is required** (pdf.js in Node); the server refuses to start on an older one, and `/book` and `/book status` say why. pdf.js is vendored as its legacy build, which the browser viewer uses too.
- `/book choose` waits as long as the file dialog is open (up to ten minutes) instead of failing after 30 seconds with "no complete answer within 30000ms".
- `/book --help` and `/book -h` print the help, like `/book help`, instead of looking for a file named `--help`.
- `/book status` shows the reading mode and why the reader server last failed to start.
- Updating from 0.1.1 replaces the running 0.1.1 reader server on the first `/book` or task.
- The reader reports each book's contents to the reader server, and `/api/show` takes a page.
- Book and chapter titles lose control characters (no terminal escape sequences from a PDF), and page counts over 100000 are refused.

## 0.1.1

- Two Claude Code sessions with different installs of the mod (or one session started before an update) no longer take turns restarting the shared reader server, which could also open a second reader window. Only a server of an older version is replaced now.
- README: install steps one command at a time, and a note that the "userConfig options not yet set" message after installing is harmless.

## 0.1.0

First release.

- `/book` command: pick a PDF (system file dialog or a path), list and switch books, close the reader, turn auto-open on or off, set the delay, restart the reader server.
- The book opens by itself once a task has run for a few seconds, at the exact place you stopped.
- Read pages are remembered: a page counts as read after it filled the view for a few seconds; mark pages by hand with `m`. Contents and a page grid show what is read.
- Reader: continuous scroll, zoom (buttons, keys, ⌘+scroll, pinch), go to page, search, contents, library, light / sepia / dark themes, keyboard shortcuts.
- When the task ends: a dialog in the reader, a desktop notification and a band above Claude's prompt offer to close the book or keep reading.
- Local reader server on 127.0.0.1 with Host, Origin and Sec-Fetch-Site checks, a strict Content-Security-Policy, and automatic replacement of a server left over from another version.
- macOS, Linux and Windows: the file picker, notification and reader window use each system's own tools (Finder dialog / zenity, kdialog or yad / Windows file dialog; Notification Center / notify-send / tray notification; Chromium app window or the default browser).
- node is found on PATH, in the login shell and in the usual install folders (Homebrew, nvm, fnm, Volta, asdf, mise, Program Files, nvm-windows).
- pdf.js 6.4.299 bundled; works offline.
