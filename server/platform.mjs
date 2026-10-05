// What the reader server runs on each OS to pick a PDF, show a notification and
// open the reader window. Every function here is pure: it returns a plan,
// { command, args, env?, detached? }, or null when the OS has no way to do it,
// and server.mjs runs the plan. Text from books or from Claude never goes into a
// script's source: it travels in argv (execFile, no shell) or in environment
// variables the script reads.

const PICKER_TITLE = 'Choose a book to read while Claude works'
const WINDOW_SIZE = '--window-size=1000,1200'

/** Chromium browsers that take --app=<url>, by OS. */
const MAC_APP_BROWSERS = ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium', 'Vivaldi']
const LINUX_APP_BROWSERS = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
  'microsoft-edge-stable',
  'brave-browser',
  'brave',
  'vivaldi',
  'vivaldi-stable',
]
const WINDOWS_APP_BROWSERS = [
  ['ProgramFiles', 'Google\\Chrome\\Application\\chrome.exe'],
  ['ProgramFiles(x86)', 'Google\\Chrome\\Application\\chrome.exe'],
  ['LOCALAPPDATA', 'Google\\Chrome\\Application\\chrome.exe'],
  ['ProgramFiles(x86)', 'Microsoft\\Edge\\Application\\msedge.exe'],
  ['ProgramFiles', 'Microsoft\\Edge\\Application\\msedge.exe'],
  ['ProgramFiles', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
  ['LOCALAPPDATA', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
  ['LOCALAPPDATA', 'Chromium\\Application\\chrome.exe'],
  ['LOCALAPPDATA', 'Vivaldi\\Application\\vivaldi.exe'],
]

/**
 * The native "open file" dialog, filtered to PDFs. It prints the chosen path
 * and exits 0; a cancel exits non-zero with nothing printed.
 *
 * @param {{ platform: string, has: (command: string) => boolean }} host
 */
export function filePicker({ platform, has }) {
  if (platform === 'darwin') {
    return {
      command: '/usr/bin/osascript',
      args: [
        '-e',
        'activate',
        '-e',
        `set f to choose file with prompt ${appleString(PICKER_TITLE)} of type {"com.adobe.pdf"}`,
        '-e',
        'POSIX path of f',
      ],
    }
  }
  if (platform === 'win32') {
    return powershell(WINDOWS_PICKER, { BOOK_READER_TITLE: PICKER_TITLE })
  }
  if (has('zenity')) {
    return {
      command: 'zenity',
      args: ['--file-selection', `--title=${PICKER_TITLE}`, '--file-filter=PDF files | *.pdf *.PDF'],
    }
  }
  if (has('kdialog')) {
    return { command: 'kdialog', args: ['--title', PICKER_TITLE, '--getopenfilename', '.', 'PDF files (*.pdf *.PDF)'] }
  }
  if (has('yad')) {
    return { command: 'yad', args: ['--file', `--title=${PICKER_TITLE}`, '--file-filter=PDF files | *.pdf *.PDF'] }
  }
  return null
}

/** Why there is no picker, for the person to act on. */
export function noPickerReason(platform) {
  return platform === 'linux'
    ? 'No file dialog found: install zenity (or kdialog), or use /book <file.pdf>.'
    : 'No file dialog on this system: use /book <file.pdf>.'
}

/**
 * A desktop notification.
 *
 * @param {{ platform: string, has: (command: string) => boolean,
 *           title: string, subtitle: string, message: string }} note
 */
export function notification({ platform, has, title, subtitle, message }) {
  if (platform === 'darwin') {
    return {
      command: '/usr/bin/osascript',
      args: [
        '-e',
        `display notification ${appleString(message)} with title ${appleString(title)} subtitle ${appleString(subtitle)} sound name "Glass"`,
      ],
    }
  }
  if (platform === 'win32') {
    return powershell(WINDOWS_NOTIFICATION, {
      BOOK_READER_TITLE: `${title}: ${subtitle}`,
      BOOK_READER_MESSAGE: message,
    })
  }
  if (has('notify-send')) {
    return { command: 'notify-send', args: ['--app-name=Claude Code', `${title}: ${subtitle}`, message] }
  }
  return null
}

/**
 * A window of its own for the reader (a Chromium browser's --app mode), or null
 * when no such browser is installed.
 *
 * @param {{ platform: string, url: string, env: Record<string, string | undefined>,
 *           has: (command: string) => boolean, exists: (file: string) => boolean,
 *           homedir: string }} host
 */
export function appWindow({ platform, url, env, has, exists, homedir }) {
  if (platform === 'darwin') {
    for (const name of MAC_APP_BROWSERS) {
      for (const dir of ['/Applications', `${homedir}/Applications`]) {
        if (exists(`${dir}/${name}.app`)) {
          return { command: '/usr/bin/open', args: ['-na', name, '--args', `--app=${url}`, WINDOW_SIZE] }
        }
      }
    }
    return null
  }
  if (platform === 'win32') {
    for (const [variable, rest] of WINDOWS_APP_BROWSERS) {
      const base = env[variable]
      if (!base) continue
      const exe = `${base.replace(/[\\/]+$/, '')}\\${rest}`
      if (exists(exe)) return { command: exe, args: [`--app=${url}`, WINDOW_SIZE], detached: true }
    }
    return null
  }
  for (const name of LINUX_APP_BROWSERS) {
    if (has(name)) return { command: name, args: [`--app=${url}`, WINDOW_SIZE], detached: true }
  }
  return null
}

/** The reader in the default browser. */
export function defaultBrowser({ platform, url }) {
  if (platform === 'darwin') return { command: '/usr/bin/open', args: [url] }
  if (platform === 'win32') return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] }
  return { command: 'xdg-open', args: [url], detached: true }
}

// ---------------------------------------------------------------- Windows

// Windows PowerShell 5.1 ships with every Windows 10 and 11. The scripts take
// their text from environment variables, and go over -EncodedCommand so no
// quoting rule of cmd.exe or PowerShell touches them.

export const WINDOWS_PICKER = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = $env:BOOK_READER_TITLE
$dialog.Filter = 'PDF files (*.pdf)|*.pdf'
$dialog.CheckFileExists = $true
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.FileName)
  exit 0
}
exit 1
`

export const WINDOWS_NOTIFICATION = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Information
$icon.BalloonTipTitle = $env:BOOK_READER_TITLE
$icon.BalloonTipText = $env:BOOK_READER_MESSAGE
$icon.Visible = $true
$icon.ShowBalloonTip(8000)
Start-Sleep -Seconds 9
$icon.Dispose()
`

function powershell(script, env) {
  return {
    command: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    env,
    hidden: true,
  }
}

// ---------------------------------------------------------------- macOS

/** An AppleScript string literal: backslashes and double quotes escaped. */
export function appleString(text) {
  return `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}
