// Tests of server/platform.mjs: what the reader server would run on macOS, Linux
// and Windows. The plans are pure, so every OS is checked on every machine; the
// Windows scripts are also parsed by PowerShell where it is installed.
//
//   node --test test/platform.test.mjs

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

import {
  WINDOWS_NOTIFICATION,
  WINDOWS_PICKER,
  appWindow,
  appleString,
  defaultBrowser,
  filePicker,
  noPickerReason,
  notification,
} from '../server/platform.mjs'

const URL = 'http://127.0.0.1:47321/'
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
    const plan = appWindow({ platform: 'darwin', url: URL, env: {}, has: nothing, exists, homedir: '/Users/me' })
    assert.deepEqual(plan.args.slice(0, 2), ['-na', 'Microsoft Edge'])
    assert.ok(plan.args.includes(`--app=${URL}`))
  })

  test('finds browsers in ~/Applications too', () => {
    const exists = file => file === '/Users/me/Applications/Google Chrome.app'
    const plan = appWindow({ platform: 'darwin', url: URL, env: {}, has: nothing, exists, homedir: '/Users/me' })
    assert.equal(plan.args[1], 'Google Chrome')
  })

  test('falls back to the default browser', () => {
    assert.equal(appWindow({ platform: 'darwin', url: URL, env: {}, has: nothing, exists: nothing, homedir: '/Users/me' }), null)
    assert.deepEqual(defaultBrowser({ platform: 'darwin', url: URL }), { command: '/usr/bin/open', args: [URL] })
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

  test('opens an app window with a Chromium browser on PATH, else xdg-open', () => {
    const plan = appWindow({ platform: 'linux', url: URL, env: {}, has: only('chromium'), exists: nothing, homedir: '/home/me' })
    assert.equal(plan.command, 'chromium')
    assert.deepEqual(plan.args, [`--app=${URL}`, '--window-size=1000,1200'])
    assert.equal(plan.detached, true)
    assert.equal(appWindow({ platform: 'linux', url: URL, env: {}, has: nothing, exists: nothing, homedir: '/home/me' }), null)
    assert.equal(defaultBrowser({ platform: 'linux', url: URL }).command, 'xdg-open')
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
    const withChrome = appWindow({ platform: 'win32', url: URL, env, has: nothing, exists: f => f === chrome || f === edge, homedir: '' })
    assert.equal(withChrome.command, chrome)
    assert.deepEqual(withChrome.args, [`--app=${URL}`, '--window-size=1000,1200'])
    const withEdge = appWindow({ platform: 'win32', url: URL, env, has: nothing, exists: f => f === edge, homedir: '' })
    assert.equal(withEdge.command, edge)
  })

  test('ignores unset folders and falls back to the default browser', () => {
    assert.equal(appWindow({ platform: 'win32', url: URL, env: {}, has: nothing, exists: () => true, homedir: '' }), null)
    assert.deepEqual(defaultBrowser({ platform: 'win32', url: URL }), {
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', URL],
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
