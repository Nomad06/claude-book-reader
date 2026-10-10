// Tests of server/platform.mjs: what the reader server would run on macOS, Linux
// and Windows. The plans are pure, so every OS is checked on every machine; the
// Windows scripts are also parsed by PowerShell where it is installed.
//
//   node --test test/platform.test.mjs

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

import { readFileSync } from 'node:fs'

import {
  WINDOWS_CLOSE_READER,
  WINDOWS_FOCUS,
  WINDOWS_NOTIFICATION,
  WINDOWS_PICKER,
  appWindow,
  appleString,
  cleanTarget,
  closeAppWindow,
  defaultBrowser,
  filePicker,
  focusApp,
  noPickerReason,
  notification,
  profilePattern,
  raiseAppWindow,
} from '../server/platform.mjs'

// The mod's own PowerShell (it finds the window that runs the session).
const WINDOWS_HOST_PID = readFileSync(new URL('../hooks/register.tsx', import.meta.url), 'utf8').match(
  /const WINDOWS_HOST_PID = `([\s\S]*?)`/,
)[1]

const READER_URL = 'http://127.0.0.1:47321/'
const PROFILE = '/home/me/.claude/book-reader/reader-profile'
const nothing = () => false
const only = (...names) => name => names.includes(name)

function decodeScript(plan) {
  const encoded = plan.args[plan.args.indexOf('-EncodedCommand') + 1]
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

describe('macOS', () => {
  test('picks a PDF with osascript', () => {
    const plan = filePicker({ platform: 'darwin', has: nothing })
    assert.equal(plan.command, '/usr/bin/osascript')
    assert.match(plan.args.join(' '), /choose file with prompt "Choose a book[^"]*" of type \{"com.adobe.pdf"\}/)
  })

  test('notifies with text escaped into AppleScript strings', () => {
    const plan = notification({ platform: 'darwin', has: nothing, title: 'Claude Code', subtitle: 'Done', message: 'Say "hi" \\ bye' })
    assert.equal(plan.command, '/usr/bin/osascript')
    assert.ok(plan.args[1].includes('display notification "Say \\"hi\\" \\\\ bye"'))
  })

  test('opens an app window with the first Chromium browser installed', () => {
    const exists = file => file === '/Applications/Microsoft Edge.app'
    const plan = appWindow({ platform: 'darwin', url: READER_URL, profileDir: PROFILE, env: {}, has: nothing, exists, homedir: '/Users/me' })
    assert.deepEqual(plan.args.slice(0, 2), ['-na', 'Microsoft Edge'])
    assert.ok(plan.args.includes(`--app=${READER_URL}`))
  })

  test('the reader window runs in its own profile, so it can be closed', () => {
    const exists = file => file === '/Applications/Google Chrome.app'
    const plan = appWindow({ platform: 'darwin', url: READER_URL, profileDir: PROFILE, env: {}, has: nothing, exists, homedir: '/Users/me' })
    assert.ok(plan.args.includes(`--user-data-dir=${PROFILE}`))
    assert.ok(plan.args.includes('--no-first-run'))
    const close = closeAppWindow({ platform: 'darwin', profileDir: '/Users/me/.claude/book-reader/reader-profile', has: nothing })
    assert.equal(close.command, '/usr/bin/pkill')
    assert.deepEqual(close.args, ['-f', '--', '--user-data-dir=/Users/me/\\.claude/book-reader/reader-profile( |$)'])
  })

  test('switches back to the app of the session by its bundle id', () => {
    assert.deepEqual(focusApp({ platform: 'darwin', has: nothing, target: { bundleId: 'com.anthropic.claudefordesktop' } }), {
      command: '/usr/bin/open',
      args: ['-b', 'com.anthropic.claudefordesktop'],
    })
    assert.equal(focusApp({ platform: 'darwin', has: nothing, target: { bundleId: '-a Calculator' } }), null)
    assert.equal(focusApp({ platform: 'darwin', has: nothing, target: null }), null)
  })

  test('finds browsers in ~/Applications too', () => {
    const exists = file => file === '/Users/me/Applications/Google Chrome.app'
    const plan = appWindow({ platform: 'darwin', url: READER_URL, profileDir: PROFILE, env: {}, has: nothing, exists, homedir: '/Users/me' })
    assert.equal(plan.args[1], 'Google Chrome')
  })

  test('falls back to the default browser', () => {
    assert.equal(appWindow({ platform: 'darwin', url: READER_URL, profileDir: PROFILE, env: {}, has: nothing, exists: nothing, homedir: '/Users/me' }), null)
    assert.deepEqual(defaultBrowser({ platform: 'darwin', url: READER_URL }), { command: '/usr/bin/open', args: [READER_URL] })
  })

  test('appleString escapes backslashes before quotes', () => {
    assert.equal(appleString('a\\"b'), '"a\\\\\\"b"')
  })
})

describe('Linux', () => {
  test('picks with zenity, then kdialog, then yad', () => {
    assert.equal(filePicker({ platform: 'linux', has: only('zenity', 'kdialog') }).command, 'zenity')
    assert.equal(filePicker({ platform: 'linux', has: only('kdialog', 'yad') }).command, 'kdialog')
    assert.equal(filePicker({ platform: 'linux', has: only('yad') }).command, 'yad')
    const zenity = filePicker({ platform: 'linux', has: only('zenity') })
    assert.ok(zenity.args.includes('--file-selection'))
    assert.ok(zenity.args.some(a => a.startsWith('--file-filter=') && a.includes('*.pdf')))
  })

  test('without a dialog tool, says what to install', () => {
    assert.equal(filePicker({ platform: 'linux', has: nothing }), null)
    assert.match(noPickerReason('linux'), /zenity/)
  })

  test('notifies with notify-send, the text as plain arguments', () => {
    const plan = notification({ platform: 'linux', has: only('notify-send'), title: 'Claude Code', subtitle: 'Done', message: '$(rm -rf ~) "x"' })
    assert.equal(plan.command, 'notify-send')
    assert.equal(plan.args.at(-1), '$(rm -rf ~) "x"')
    assert.equal(notification({ platform: 'linux', has: nothing, title: 't', subtitle: 's', message: 'm' }), null)
  })

  test('closes the reader with pkill, and switches back by window id', () => {
    assert.equal(closeAppWindow({ platform: 'linux', profileDir: PROFILE, has: only('pkill') }).command, 'pkill')
    assert.equal(closeAppWindow({ platform: 'linux', profileDir: PROFILE, has: nothing }), null)
    assert.deepEqual(focusApp({ platform: 'linux', has: only('xdotool', 'wmctrl'), target: { windowId: '71303175' } }), {
      command: 'xdotool',
      args: ['windowactivate', '71303175'],
    })
    assert.deepEqual(focusApp({ platform: 'linux', has: only('wmctrl'), target: { windowId: '0x4400007' } }), {
      command: 'wmctrl',
      args: ['-i', '-a', '0x4400007'],
    })
    assert.equal(focusApp({ platform: 'linux', has: only('xdotool'), target: { windowId: '1; rm -rf ~' } }), null)
    assert.equal(focusApp({ platform: 'linux', has: nothing, target: { windowId: '71303175' } }), null)
  })

  test('opens an app window with a Chromium browser on PATH, else xdg-open', () => {
    const plan = appWindow({ platform: 'linux', url: READER_URL, profileDir: PROFILE, env: {}, has: only('chromium'), exists: nothing, homedir: '/home/me' })
    assert.equal(plan.command, 'chromium')
    assert.deepEqual(plan.args, [
      `--app=${READER_URL}`,
      '--window-size=1000,1200',
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
    ])
    assert.equal(plan.detached, true)
    assert.equal(appWindow({ platform: 'linux', url: READER_URL, profileDir: PROFILE, env: {}, has: nothing, exists: nothing, homedir: '/home/me' }), null)
    assert.equal(defaultBrowser({ platform: 'linux', url: READER_URL }).command, 'xdg-open')
  })
})

describe('Windows', () => {
  const env = {
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  }

  test('picks with a Windows Forms dialog over PowerShell, the title in the environment', () => {
    const plan = filePicker({ platform: 'win32', has: nothing })
    assert.equal(plan.command, 'powershell.exe')
    assert.ok(plan.args.includes('-STA'))
    assert.equal(decodeScript(plan), WINDOWS_PICKER)
    assert.match(plan.env.BOOK_READER_TITLE, /Choose a book/)
    assert.equal(plan.hidden, true)
  })

  test('notifies with a tray balloon, the text in the environment, never in the script', () => {
    const message = "'; Remove-Item C:\\ -Recurse; '"
    const plan = notification({ platform: 'win32', has: nothing, title: 'Claude Code', subtitle: 'Done', message })
    assert.equal(decodeScript(plan), WINDOWS_NOTIFICATION)
    assert.equal(plan.env.BOOK_READER_MESSAGE, message)
    assert.equal(plan.env.BOOK_READER_TITLE, 'Claude Code: Done')
  })

  test('opens an app window with Chrome, else Edge', () => {
    const chrome = 'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'
    const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    const withChrome = appWindow({ platform: 'win32', url: READER_URL, profileDir: PROFILE, env, has: nothing, exists: f => f === chrome || f === edge, homedir: '' })
    assert.equal(withChrome.command, chrome)
    assert.ok(withChrome.args.includes(`--app=${READER_URL}`))
    assert.ok(withChrome.args.includes(`--user-data-dir=${PROFILE}`))
    const withEdge = appWindow({ platform: 'win32', url: READER_URL, profileDir: PROFILE, env, has: nothing, exists: f => f === edge, homedir: '' })
    assert.equal(withEdge.command, edge)
  })

  test('closes the reader window and switches back by process id, with PowerShell', () => {
    const close = closeAppWindow({ platform: 'win32', profileDir: 'C:\\Users\\me\\.claude\\book-reader\\reader-profile', has: nothing })
    assert.equal(decodeScript(close), WINDOWS_CLOSE_READER)
    assert.equal(close.env.BOOK_READER_PROFILE, 'C:\\Users\\me\\.claude\\book-reader\\reader-profile')
    const focus = focusApp({ platform: 'win32', has: nothing, target: { pid: 4242 } })
    assert.equal(decodeScript(focus), WINDOWS_FOCUS)
    assert.equal(focus.env.BOOK_READER_PID, '4242')
    assert.equal(focusApp({ platform: 'win32', has: nothing, target: { pid: -1 } }), null)
  })

  test('ignores unset folders and falls back to the default browser', () => {
    assert.equal(appWindow({ platform: 'win32', url: READER_URL, profileDir: PROFILE, env: {}, has: nothing, exists: () => true, homedir: '' }), null)
    assert.deepEqual(defaultBrowser({ platform: 'win32', url: READER_URL }), {
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', READER_URL],
    })
  })

  // Parses (does not run) each script with the PowerShell on this machine:
  // Windows PowerShell on Windows, pwsh elsewhere when installed.
  const shell = ['powershell.exe', 'pwsh'].find(name => {
    try {
      execFileSync(name, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })
  for (const [name, script] of [
    ['picker', WINDOWS_PICKER],
    ['notification', WINDOWS_NOTIFICATION],
    ['close reader', WINDOWS_CLOSE_READER],
    ['focus', WINDOWS_FOCUS],
    ["mod's window search", WINDOWS_HOST_PID],
  ]) {
    test(`the ${name} script is valid PowerShell`, { skip: shell ? false : 'no PowerShell here' }, () => {
      const check =
        '$tokens = $null; $errors = $null; [System.Management.Automation.Language.Parser]::ParseInput($env:BOOK_READER_SCRIPT, [ref]$tokens, [ref]$errors) | Out-Null; if ($errors -and $errors.Count -gt 0) { $errors | ForEach-Object { $_.Message }; exit 1 }'
      execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', check], {
        env: { ...process.env, BOOK_READER_SCRIPT: script },
        stdio: 'pipe',
      })
    })
  }
})

describe('return targets', () => {
  test('keep only well-formed values', () => {
    assert.deepEqual(cleanTarget({ bundleId: 'com.apple.Terminal', windowId: '12', pid: 7, extra: 'x' }), {
      bundleId: 'com.apple.Terminal',
      windowId: '12',
      pid: 7,
    })
    assert.equal(cleanTarget({ bundleId: '../../evil', windowId: 'x', pid: '7' }), null)
    assert.equal(cleanTarget('com.apple.Terminal'), null)
    assert.equal(cleanTarget(null), null)
  })
})

describe('raising the reader window', () => {
  test('macOS finds the main process by the profile and activates it by pid', () => {
    const plan = raiseAppWindow({ platform: 'darwin', profileDir: '/Users/me/.claude/book-reader/reader-profile', has: nothing })
    assert.deepEqual(plan.find, {
      command: '/usr/bin/pgrep',
      args: ['-f', '-o', '--', '--user-data-dir=/Users/me/\\.claude/book-reader/reader-profile( |$)'],
    })
    const raise = plan.raise(98292)
    assert.equal(raise.command, '/usr/bin/osascript')
    assert.deepEqual(raise.args.slice(0, 2), ['-l', 'JavaScript'])
    assert.match(raise.args[3], /runningApplicationWithProcessIdentifier\(98292\)/)
    assert.match(raise.args[3], /activateWithOptions\(3\)/)
  })

  test('a pid that is not a positive integer gives no plan', () => {
    const plan = raiseAppWindow({ platform: 'darwin', profileDir: PROFILE, has: nothing })
    for (const bad of ['1); evil(', 0, -4, 1.5, NaN, null, undefined]) assert.equal(plan.raise(bad), null)
  })

  test('Linux needs pgrep and xdotool, and searches the windows of the pid', () => {
    assert.equal(raiseAppWindow({ platform: 'linux', profileDir: PROFILE, has: only('pgrep') }), null)
    assert.equal(raiseAppWindow({ platform: 'linux', profileDir: PROFILE, has: only('xdotool') }), null)
    const plan = raiseAppWindow({ platform: 'linux', profileDir: PROFILE, has: only('pgrep', 'xdotool') })
    assert.equal(plan.find.command, 'pgrep')
    assert.deepEqual(plan.raise(4242), { command: 'xdotool', args: ['search', '--onlyvisible', '--pid', '4242', 'windowactivate'] })
    assert.equal(plan.raise('4242; rm'), null)
  })

  test('Windows is one script that takes the profile from the environment', () => {
    const plan = raiseAppWindow({ platform: 'win32', profileDir: 'C:\\Users\\me\\reader-profile', has: nothing })
    assert.equal(plan.find, null)
    const raise = plan.raise()
    assert.equal(raise.command, 'powershell.exe')
    assert.deepEqual(raise.env, { BOOK_READER_PROFILE: 'C:\\Users\\me\\reader-profile' })
    assert.match(decodeScript(raise), /AppActivate/)
    assert.ok(!decodeScript(raise).includes('reader-profile'))
  })
})

describe('the profile of the reader is matched whole', () => {
  const profile = '/Users/me/.claude/book-reader/reader-profile'
  test('pgrep and pkill patterns do not match a sibling folder with the same prefix', () => {
    const raise = raiseAppWindow({ platform: 'darwin', profileDir: profile, has: nothing }).find.args.at(-1)
    const close = closeAppWindow({ platform: 'darwin', profileDir: profile, has: nothing }).args.at(-1)
    for (const pattern of [raise, close, profilePattern(profile)]) {
      const re = new RegExp(pattern)
      assert.ok(re.test(`Chrome --app=x --user-data-dir=${profile} --no-first-run`))
      assert.ok(re.test(`Chrome --user-data-dir=${profile}`))
      assert.ok(!re.test(`Chrome --user-data-dir=${profile}2 --no-first-run`))
      assert.ok(!re.test(`Chrome --user-data-dir=${profile}-old`))
    }
  })

  test('the Windows scripts compare the whole argument', () => {
    for (const plan of [raiseAppWindow({ platform: 'win32', profileDir: 'C:\\p', has: nothing }).raise(), closeAppWindow({ platform: 'win32', profileDir: 'C:\\p', has: nothing })]) {
      assert.doesNotMatch(decodeScript(plan), /CommandLine\.Contains\(\$marker\)/)
      assert.match(decodeScript(plan), /EndsWith\(\$marker\)/)
    }
  })
})
