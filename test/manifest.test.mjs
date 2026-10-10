// The release's version is the same everywhere it is written. The mod replaces
// a running reader server only when that server reports an older version (read
// from .claude-plugin/plugin.json), so a release that forgets the bump keeps the
// old server running after an update.
//
//   node --test test/manifest.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const json = async file => JSON.parse(await fs.readFile(path.join(ROOT, file), 'utf8'))

test('plugin.json, marketplace.json, package.json and package-lock.json name one version', async () => {
  const plugin = await json('.claude-plugin/plugin.json')
  const marketplace = await json('.claude-plugin/marketplace.json')
  const pkg = await json('package.json')
  const lock = await json('package-lock.json')
  const listed = marketplace.plugins.find(entry => entry.name === plugin.name)

  assert.match(plugin.version, /^\d+\.\d+\.\d+$/)
  assert.equal(listed?.version, plugin.version)
  assert.equal(pkg.version, plugin.version)
  assert.equal(lock.version, plugin.version)
  assert.equal(lock.packages[''].version, plugin.version)
})
