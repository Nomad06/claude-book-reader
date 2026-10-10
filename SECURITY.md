# Security

## Reporting a vulnerability

Please report security problems privately through GitHub: open the repository's
**Security** tab and choose **Report a vulnerability**. Do not open a public
issue for them.

## What the mod does on your machine

### The reader server

- Runs a small Node.js server bound to `127.0.0.1` only (port 47321 by default),
  started by the mod with the `node` it finds (22.13 or newer). It stops by
  itself after 6 hours without use.
- The server reads only the PDF files you add to the library, and serves only
  the files in `viewer/`.
- It refuses requests whose `Host` is not its own (DNS rebinding), and API
  requests that a browser marks as coming from another site (`Origin`,
  `Sec-Fetch-Site`). Every response carries
  `Cross-Origin-Resource-Policy: same-origin`, and the reader page a strict
  `Content-Security-Policy`.

### Reading a PDF in Node (text mode)

- For text mode the server opens your PDF with PDF.js (the bundled copy in
  `viewer/vendor/pdfjs/`) inside its own Node process: a PDF is untrusted input,
  read by the same library a browser uses for it. It keeps at most two books
  open at a time and caches the last 50 pages.
- The work for one page is capped: 20,000 characters of text and 100,000 text
  items, 40 pictures (each scaled to at most 800 × 4096 pixels), 5,000 drawing
  boxes and 20 figure marks; it waits at most 10 seconds for a page's pictures.
- When the optional native module `@napi-rs/canvas` is installed (you run
  `npm install` in the plugin folder; a marketplace install has no
  `node_modules`), PDF.js also renders figures drawn with lines: at most 4 per
  page, 5 seconds each and 10 seconds per page, 1.5 million pixels each. Without
  it nothing is rendered. Installing it runs npm and downloads a prebuilt binary
  for your platform from the npm registry.
- Pictures for text mode are written as raw RGB files (no image decoder reads
  them back) to `~/.claude/book-reader/pages/`, readable by you only (folder
  `0700`, files `0600`). At most 200 files are kept, the oldest removed first,
  and the folder is emptied each time the server starts. Claude Code reads these
  files to draw the pictures in kitty and Ghostty.

### Programs it runs

The mod and the server start the system's own tools, never through a shell
with your data in it. Book titles, Claude's text and paths reach them only as
program arguments or as environment variables that a fixed PowerShell script
reads, never as code.

| What for | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Finding `node` | `/bin/sh` with a fixed script that also asks your login shell (`$SHELL -lc 'command -v node'`) | same | `where.exe node` |
| The file picker (`/book choose`) | `osascript` (`choose file`) | `zenity`, `kdialog` or `yad` | PowerShell (`OpenFileDialog`) |
| The reader window | `open -na <browser> --args --app=…`, or `open <url>` | the browser, or `xdg-open` | the browser's `.exe`, or `rundll32 url.dll,FileProtocolHandler` |
| Raising the reader's window when it is already open (`o`, `/book`) | `pgrep -f -o` to find its process by the reader's own browser profile folder, then `osascript -l JavaScript` (JXA: `NSRunningApplication` by that pid, `activateWithOptions`) | `pgrep -f -o`, then `xdotool search --onlyvisible --pid <pid> windowactivate` | PowerShell (`Get-CimInstance Win32_Process`, `AppActivate`) |
| Closing the reader's window | `pkill -f` on the reader's profile folder | `pkill -f` on the profile folder | PowerShell (`CloseMainWindow`) |
| Bringing Claude Code back to the front | `open -b <bundle id>` | `xdotool windowactivate` or `wmctrl -i -a` (X11) | PowerShell (`AppActivate` by pid); the mod finds the pid with a fixed PowerShell script |
| The "task finished" notification | `osascript` (`display notification`) | `notify-send` | PowerShell (tray balloon) |

The reader's window runs in a browser profile of its own,
`~/.claude/book-reader/reader-profile/`, so raising and closing it never touch
your other browser windows: the process is matched by that whole folder name.
A pid is checked to be a positive integer before it reaches the JXA script.

### What it stores

- Your library and reading progress in `~/.claude/book-reader/state.json`
  (`%USERPROFILE%\.claude\book-reader\state.json` on Windows), the server's log
  in `server.log` beside it, the pictures above in `pages/`, and the reader
  window's browser profile in `reader-profile/`.
- When a task ends, the first 600 characters of Claude's final answer are sent
  to the reader to show in the "task finished" dialog. They are kept in the
  server's memory only and never written to disk.

### Network

- On its own it makes no network requests beyond `127.0.0.1` and sends no
  telemetry; PDF.js is bundled. Links inside a book open only when you click them.
