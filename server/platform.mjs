// What the reader server runs on each OS to pick a PDF, show a notification and
// open the reader window. Every function here is pure: it returns a plan,
// { command, args, env?, detached? }, or null when the OS has no way to do it,
// and server.mjs runs the plan. Text from books or from Claude never goes into a
// script's source: it travels in argv (execFile, no shell) or in environment
// variables the script reads.

const PICKER_TITLE = 'Choose a book to read while Claude works'

/**
 * The reader runs in a browser instance of its own (its own profile folder),
 * so the server can close it: a browser does not let a page close a window it
 * did not open by script.
 */
function readerFlags(url, profileDir) {
  return [
    `--app=${url}`,
    '--window-size=1000,1200',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ]
}

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
 * A window of its own for the reader (a Chromium browser's --app mode, in the
 * reader's own profile), or null when no such browser is installed.
 *
 * @param {{ platform: string, url: string, profileDir: string,
 *           env: Record<string, string | undefined>,
 *           has: (command: string) => boolean, exists: (file: string) => boolean,
 *           homedir: string }} host
 */
export function appWindow({ platform, url, profileDir, env, has, exists, homedir }) {
  const flags = readerFlags(url, profileDir)
  if (platform === 'darwin') {
    for (const name of MAC_APP_BROWSERS) {
      for (const dir of ['/Applications', `${homedir}/Applications`]) {
        if (exists(`${dir}/${name}.app`)) return { command: '/usr/bin/open', args: ['-na', name, '--args', ...flags] }
      }
    }
    return null
  }
  if (platform === 'win32') {
    for (const [variable, rest] of WINDOWS_APP_BROWSERS) {
      const base = env[variable]
      if (!base) continue
      const exe = `${base.replace(/[\\/]+$/, '')}\\${rest}`
      if (exists(exe)) return { command: exe, args: flags, detached: true }
    }
    return null
  }
  for (const name of LINUX_APP_BROWSERS) {
    if (has(name)) return { command: name, args: flags, detached: true }
  }
  return null
}

/**
 * Closes the reader's own browser instance, found by its profile folder: no
 * other browser window is touched.
 *
 * @param {{ platform: string, profileDir: string, has: (command: string) => boolean }} host
 */
export function closeAppWindow({ platform, profileDir, has }) {
  if (platform === 'win32') return powershell(WINDOWS_CLOSE_READER, { BOOK_READER_PROFILE: profileDir })
  const pkill = platform === 'darwin' ? '/usr/bin/pkill' : has('pkill') ? 'pkill' : null
  if (!pkill) return null
  return { command: pkill, args: ['-f', '--', profilePattern(profileDir)] }
}

/**
 * Raises the reader's own browser window above the other windows (a page in a
 * browser cannot raise its own window). The instance is found by its profile
 * folder, like closeAppWindow. Windows: one plan. macOS and Linux: `find` lists
 * the process ids that run the profile (the oldest first, which is the main
 * process: its helpers start later), and `raise(pid)` activates that one. Null
 * where there is no way to do it (Linux without pgrep and xdotool).
 *
 * @param {{ platform: string, profileDir: string, has: (command: string) => boolean }} host
 * @returns {{ find: object | null, raise: (pid: number) => object | null } | { find: null, raise: () => object } | null}
 */
export function raiseAppWindow({ platform, profileDir, has }) {
  if (platform === 'win32') {
    const plan = powershell(WINDOWS_RAISE_READER, { BOOK_READER_PROFILE: profileDir })
    return { find: null, raise: () => plan }
  }
  const pgrep = platform === 'darwin' ? '/usr/bin/pgrep' : has('pgrep') ? 'pgrep' : null
  if (!pgrep) return null
  const find = { command: pgrep, args: ['-f', '-o', '--', profilePattern(profileDir)] }
  if (platform === 'darwin') {
    return { find, raise: pid => (isPid(pid) ? { command: '/usr/bin/osascript', args: ['-l', 'JavaScript', '-e', MAC_ACTIVATE_PID.replace('PID', String(pid))] } : null) }
  }
  if (!has('xdotool')) return null
  return { find, raise: pid => (isPid(pid) ? { command: 'xdotool', args: ['search', '--onlyvisible', '--pid', String(pid), 'windowactivate'] } : null) }
}

/** The command-line argument of the profile, anchored: a sibling folder that starts with the same path is not it. */
export function profilePattern(profileDir) {
  return `--user-data-dir=${escapeRegex(profileDir)}( |$)`
}

function isPid(value) {
  return Number.isInteger(value) && value > 0
}

/**
 * Brings the app that runs the Claude Code session to the front: macOS by the
 * app's bundle id, Linux (X11) by the terminal's window id, Windows by the id
 * of the process that owns the window.
 *
 * @param {{ platform: string, has: (command: string) => boolean,
 *           target: { bundleId?: string, windowId?: string, pid?: number } | null }} host
 */
export function focusApp({ platform, has, target }) {
  if (!target) return null
  if (platform === 'darwin') {
    return isBundleId(target.bundleId) ? { command: '/usr/bin/open', args: ['-b', target.bundleId] } : null
  }
  if (platform === 'win32') {
    return Number.isInteger(target.pid) && target.pid > 0
      ? powershell(WINDOWS_FOCUS, { BOOK_READER_PID: String(target.pid) })
      : null
  }
  if (!isWindowId(target.windowId)) return null
  if (has('xdotool')) return { command: 'xdotool', args: ['windowactivate', String(Number(target.windowId))] }
  if (has('wmctrl')) return { command: 'wmctrl', args: ['-i', '-a', target.windowId] }
  return null
}

/** What the server keeps of a return target: only well-formed values. */
export function cleanTarget(target) {
  if (!target || typeof target !== 'object') return null
  const clean = {}
  if (isBundleId(target.bundleId)) clean.bundleId = target.bundleId
  if (isWindowId(target.windowId)) clean.windowId = target.windowId
  if (Number.isInteger(target.pid) && target.pid > 0) clean.pid = target.pid
  return Object.keys(clean).length ? clean : null
}

function isBundleId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9.-]{0,200}$/.test(value)
}

function isWindowId(value) {
  return typeof value === 'string' && /^(0x[0-9a-fA-F]{1,16}|[0-9]{1,20})$/.test(value)
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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

export const WINDOWS_CLOSE_READER = `
$ErrorActionPreference = 'SilentlyContinue'
$marker = "--user-data-dir=$env:BOOK_READER_PROFILE"
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -and ($_.CommandLine.EndsWith($marker) -or $_.CommandLine.Contains($marker + ' ') -or $_.CommandLine.Contains($marker + '"')) } |
  ForEach-Object {
    $process = Get-Process -Id $_.ProcessId
    if ($process -and $process.MainWindowHandle -ne [IntPtr]::Zero) { [void]$process.CloseMainWindow() }
  }
`

export const WINDOWS_FOCUS = `
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
if ($shell.AppActivate([int]$env:BOOK_READER_PID)) { exit 0 }
exit 1
`

export const WINDOWS_RAISE_READER = `
$ErrorActionPreference = 'Stop'
$marker = "--user-data-dir=$env:BOOK_READER_PROFILE"
$shell = New-Object -ComObject WScript.Shell
$found = Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -and ($_.CommandLine.EndsWith($marker) -or $_.CommandLine.Contains($marker + ' ') -or $_.CommandLine.Contains($marker + '"')) } |
  Where-Object { (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).MainWindowHandle -ne [IntPtr]::Zero } |
  Select-Object -First 1
if ($found -and $shell.AppActivate([int]$found.ProcessId)) { exit 0 }
exit 1
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

// The pid is substituted for PID only after it passed isPid (an integer).
export const MAC_ACTIVATE_PID =
  'ObjC.import("AppKit"); const a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(PID); a.isNil() ? "no app" : String(a.activateWithOptions(3))'

/** An AppleScript string literal: backslashes and double quotes escaped. */
export function appleString(text) {
  return `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}
