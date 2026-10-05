# Changelog

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
