// npm run typecheck: type-checks the mod (hooks/, types/) with the TypeScript
// in devDependencies, against the API types Claude Code writes to
// .claude-plugin/types/ when it loads the mod. No command writes them without
// loading it in a session, so a fresh clone (and CI) has none until then.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

if (!fs.existsSync(path.join(ROOT, '.claude-plugin', 'types', 'tsconfig.json'))) {
  console.error('No Claude Code API types yet: start a session with `claude --plugin-dir .` once (it writes .claude-plugin/types/), then run this again.')
  process.exit(1)
}

let tsc
try {
  tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
} catch {
  console.error('TypeScript is not installed: run `npm install` first.')
  process.exit(1)
}

const run = spawnSync(process.execPath, [tsc, '-p', ROOT], { stdio: 'inherit' })
process.exit(run.status ?? 1)
