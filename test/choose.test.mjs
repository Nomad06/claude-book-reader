// Tests of the file dialog the mod waits on in pieces (server/shared.mjs):
// Claude Code gives one request 30 s, a person may keep the dialog open longer.
//
//   node --test test/choose.test.mjs

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { waitInPieces } from '../server/shared.mjs'

/** A dialog the test closes by hand: `settle(value)` or `fail(error)`. */
function dialog() {
  const opened = []
  const open = () =>
    new Promise((resolve, reject) => {
      opened.push({ resolve, reject })
    })
  return {
    open,
    opened,
    settle: value => opened.at(-1).resolve(value),
    fail: error => opened.at(-1).reject(error),
  }
}

describe('a file dialog waited on in pieces', () => {
  test('a poll answers "still open" after its wait, and the next one gets the pick', async () => {
    const d = dialog()
    const poll = waitInPieces(d.open)
    assert.deepEqual(await poll(20), { pending: true })
    assert.equal(d.opened.length, 1)
    const second = poll(5_000)
    d.settle({ book: { id: 'abc' } })
    assert.deepEqual(await second, { book: { id: 'abc' } })
    // The dialog opened once for both polls.
    assert.equal(d.opened.length, 1)
  })

  test('polls during one dialog share it; the outcome goes to each of them', async () => {
    const d = dialog()
    const poll = waitInPieces(d.open)
    const a = poll(5_000)
    const b = poll(5_000)
    d.settle({ cancelled: true })
    assert.deepEqual(await Promise.all([a, b]), [{ cancelled: true }, { cancelled: true }])
    assert.equal(d.opened.length, 1)
  })

  test('once its outcome is collected, the next poll opens a new dialog', async () => {
    const d = dialog()
    const poll = waitInPieces(d.open)
    const first = poll(5_000)
    d.settle({ cancelled: true })
    await first
    const again = poll(20)
    assert.equal(d.opened.length, 2)
    assert.deepEqual(await again, { pending: true })
  })

  test('an outcome that settled between two polls waits for the next one', async () => {
    const d = dialog()
    const poll = waitInPieces(d.open)
    assert.deepEqual(await poll(10), { pending: true })
    d.settle({ book: { id: 'abc' } })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(await poll(5_000), { book: { id: 'abc' } })
    assert.equal(d.opened.length, 1)
  })

  test('an outcome nobody collects in time is dropped: a later poll opens a new dialog', async () => {
    const d = dialog()
    let now = 1_000
    const poll = waitInPieces(d.open, { keepMs: 60_000, now: () => now })
    assert.deepEqual(await poll(10), { pending: true })
    d.settle({ book: { id: 'old' } })
    await new Promise(resolve => setImmediate(resolve))
    now += 60_001
    assert.deepEqual(await poll(10), { pending: true })
    assert.equal(d.opened.length, 2)
  })

  test('a failed dialog throws to the poll that collects it, then is gone', async () => {
    const d = dialog()
    const poll = waitInPieces(d.open)
    const first = poll(5_000)
    d.fail(new Error('no dialog here'))
    await assert.rejects(first, /no dialog here/)
    const again = poll(10)
    assert.equal(d.opened.length, 2)
    assert.deepEqual(await again, { pending: true })
  })

  test('without a wait (an older mod) the poll waits for the outcome itself', async () => {
    const d = dialog()
    const poll = waitInPieces(d.open)
    const whole = poll(undefined)
    setTimeout(() => d.settle({ book: { id: 'abc' } }), 30)
    assert.deepEqual(await whole, { book: { id: 'abc' } })
  })
})
