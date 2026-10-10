// Tests of the file dialog the mod waits on in pieces (server/shared.mjs):
// Claude Code gives one request 30 s, a person may keep the dialog open longer.
//
//   node --test test/choose.test.mjs

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { chooseRequest, waitInPieces } from '../server/shared.mjs'

/** A dialog the test closes by hand: `settle(value)` or `fail(error)` closes the last one opened. */
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

const tick = () => new Promise(resolve => setImmediate(resolve))

/** Ids d1, d2, … in the order the dialogs open. */
function ids() {
  let n = 0
  return () => `d${++n}`
}

describe('a file dialog waited on in pieces', () => {
  test('a poll answers "still open" with the dialog id; a poll with that id gets the pick', async () => {
    const d = dialog()
    const poll = waitInPieces(d.open, { newId: ids() })
    assert.deepEqual(await poll(20), { pending: true, id: 'd1' })
    assert.equal(d.opened.length, 1)
    const second = poll(5_000, 'd1')
    d.settle({ book: { id: 'abc' } })
    assert.deepEqual(await second, { book: { id: 'abc' } })
    assert.equal(d.opened.length, 1)
  })

  test('requests without an id while a dialog is open join it; the outcome goes to each', async () => {
    const d = dialog()
    const poll = waitInPieces(d.open, { newId: ids() })
    const a = poll(5_000)
    const b = poll(5_000)
    d.settle({ cancelled: true })
    assert.deepEqual(await Promise.all([a, b]), [{ cancelled: true }, { cancelled: true }])
    assert.equal(d.opened.length, 1)
  })

  test('an outcome that settled between two polls goes to the next poll with its id', async () => {
    const d = dialog()
    const poll = waitInPieces(d.open, { newId: ids() })
    assert.deepEqual(await poll(10), { pending: true, id: 'd1' })
    d.settle({ book: { id: 'abc' } })
    await tick()
    assert.deepEqual(await poll(5_000, 'd1'), { book: { id: 'abc' } })
    assert.equal(d.opened.length, 1)
  })

  test("a request without an id never collects an earlier dialog's outcome: it opens a new dialog", async () => {
    const d = dialog()
    const poll = waitInPieces(d.open, { newId: ids() })
    assert.deepEqual(await poll(10), { pending: true, id: 'd1' })
    d.settle({ book: { id: 'abandoned' } })
    await tick()
    assert.deepEqual(await poll(10), { pending: true, id: 'd2' })
    assert.equal(d.opened.length, 2)
    // The abandoned dialog's id no longer reaches its outcome.
    assert.deepEqual(await poll(10, 'd1'), { gone: true })
  })

  test('an outcome its id does not collect within keepMs is gone', async () => {
    const d = dialog()
    let now = 1_000
    const poll = waitInPieces(d.open, { keepMs: 5_000, now: () => now, newId: ids() })
    assert.deepEqual(await poll(10), { pending: true, id: 'd1' })
    d.settle({ book: { id: 'late' } })
    await tick()
    now += 5_001
    assert.deepEqual(await poll(10, 'd1'), { gone: true })
    assert.equal(d.opened.length, 1)
  })

  test('an id this server never gave (a restart since) is gone, and opens nothing', async () => {
    const d = dialog()
    const poll = waitInPieces(d.open, { newId: ids() })
    assert.deepEqual(await poll(10, 'from-before'), { gone: true })
    assert.equal(d.opened.length, 0)
  })

  test('a failed dialog throws to the poll that collects it; a new request opens a new one', async () => {
    const d = dialog()
    const poll = waitInPieces(d.open, { newId: ids() })
    const first = poll(5_000)
    d.fail(new Error('no dialog here'))
    await assert.rejects(first, /no dialog here/)
    const again = poll(10)
    assert.equal(d.opened.length, 2)
    assert.deepEqual(await again, { pending: true, id: 'd2' })
  })

  test('without a wait (an older mod) a request waits for the outcome itself, joining an open dialog', async () => {
    const d = dialog()
    const poll = waitInPieces(d.open, { newId: ids() })
    assert.deepEqual(await poll(10), { pending: true, id: 'd1' })
    const whole = poll(undefined)
    setTimeout(() => d.settle({ book: { id: 'abc' } }), 30)
    assert.deepEqual(await whole, { book: { id: 'abc' } })
    assert.equal(d.opened.length, 1)
  })
})

describe('what one /api/choose request asks', () => {
  test("the mod's waitMs, at most 25 s; none (an older mod) or a bad one waits for the outcome", () => {
    assert.equal(chooseRequest({ waitMs: 20_000 }).waitMs, 20_000)
    assert.equal(chooseRequest({ waitMs: 0 }).waitMs, 0)
    assert.equal(chooseRequest({ waitMs: 90_000 }).waitMs, 25_000)
    assert.equal(chooseRequest({}).waitMs, undefined)
    assert.equal(chooseRequest({ waitMs: 'soon' }).waitMs, undefined)
    assert.equal(chooseRequest({ waitMs: -1 }).waitMs, undefined)
    assert.equal(chooseRequest(null).waitMs, undefined)
  })

  test('the dialog id it echoes: a short string, else none', () => {
    assert.equal(chooseRequest({ id: 'a1b2' }).id, 'a1b2')
    assert.equal(chooseRequest({}).id, undefined)
    assert.equal(chooseRequest({ id: 42 }).id, undefined)
    assert.equal(chooseRequest({ id: 'x'.repeat(65) }).id, undefined)
  })
})
