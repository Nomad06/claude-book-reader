import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { NODE_FLOOR, nodeVersionProblem } from '../server/node-version.mjs'

describe('node version check', () => {
  test('the floor is 22.13.0', () => {
    assert.equal(NODE_FLOOR, '22.13.0')
  })

  test('accepts the floor and anything newer, with or without a v', () => {
    assert.equal(nodeVersionProblem('22.13.0'), null)
    assert.equal(nodeVersionProblem('v22.14.1'), null)
    assert.equal(nodeVersionProblem('24.0.0'), null)
  })

  test('refuses older versions with a message naming both versions', () => {
    assert.equal(nodeVersionProblem('18.20.4'), 'book-reader needs Node 22.13 or newer; found v18.20.4')
    assert.equal(nodeVersionProblem('22.12.0'), 'book-reader needs Node 22.13 or newer; found v22.12.0')
  })

  test('the running node passes (the test suite itself needs it)', () => {
    assert.equal(nodeVersionProblem(), null)
  })
})
