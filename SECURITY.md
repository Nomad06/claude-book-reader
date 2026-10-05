# Security

## Reporting a vulnerability

Please report security problems privately through GitHub: open the repository's
**Security** tab and choose **Report a vulnerability**. Do not open a public
issue for them.

## What the mod does on your machine

- Runs a small Node.js server bound to `127.0.0.1` only (port 47321 by default).
- The server reads only the PDF files you add to the library, and serves only
  the files in `viewer/`.
- It refuses requests whose `Host` is not its own (DNS rebinding), and API
  requests that a browser marks as coming from another site (`Origin`,
  `Sec-Fetch-Site`). Every response carries
  `Cross-Origin-Resource-Policy: same-origin`, and the reader page a strict
  `Content-Security-Policy`.
- To pick a file, notify you and open the reader it runs the system's own tools:
  `osascript` and `open` on macOS; `zenity`/`kdialog`/`yad`, `notify-send` and
  `xdg-open` on Linux; Windows PowerShell and `rundll32` on Windows. Book titles
  and Claude's text reach them only as program arguments (no shell) or as
  environment variables a fixed script reads (PowerShell), never as code.
- It stores your library and reading progress in `~/.claude/book-reader/state.json`
  (`%USERPROFILE%\.claude\book-reader\state.json` on Windows).
- When a task ends, the first 600 characters of Claude's final answer are sent
  to the reader to show in the "task finished" dialog. They are kept in the
  server's memory only and never written to disk.
- On its own it makes no network requests beyond `127.0.0.1` and sends no
  telemetry; pdf.js is bundled. Links inside a book open only when you click them.
