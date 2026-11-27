#!/usr/bin/env node
// @ts-check
/**
 * scripts/check-local-ops.mjs — verify the generated local-lane allow-list is fresh.
 *
 * config/local-ops.json is the single source for the no-GUI headless allow-list;
 * scripts/gen-local-ops.mjs renders runtime/contracts/local-lane.ts and src/contracts/local-lane.ts.
 * This gate fails when either file is missing, stale after a config edit, or was hand-edited
 * (the header hash no longer matches). Wired into npm run lint and npm run check:local-ops.
 */
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG_FILE, DEFAULT_ROOT, generateLocalOps } from './gen-local-ops.mjs'

const args = process.argv.slice(2)
let root = DEFAULT_ROOT
let json = false
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg === '--json') {
    json = true
  } else if (arg === '--root') {
    const value = args[index + 1]
    if (!value) {
      console.error('check-local-ops: --root needs a directory')
      process.exit(2)
    }
    root = path.resolve(value)
    index += 1
  } else {
    console.error('check-local-ops: unknown argument ' + arg)
    process.exit(2)
  }
}

const REGEN = 'run node scripts/gen-local-ops.mjs'
const failures = []
let generated = null
try {
  generated = await generateLocalOps(root)
} catch (error) {
  failures.push(String(error && error.message ? error.message : error))
}
if (generated) {
  for (const file of generated.files) {
    const target = path.join(root, file.file)
    let actual
    try {
      actual = fs.readFileSync(target, 'utf8')
    } catch {
      failures.push(file.file + ' is missing: ' + REGEN)
      continue
    }
    if (actual !== file.content) failures.push(file.file + ' is stale: ' + REGEN)
  }
}

const payload = {
  ok: failures.length === 0,
  tool: 'check-local-ops',
  root,
  source: CONFIG_FILE,
  hash: generated ? generated.hash : null,
  ops: generated ? generated.ops : 0,
  prefixes: generated ? generated.prefixes : 0,
  files: generated ? generated.files.map((file) => file.file) : [],
  failures,
}
if (json) {
  console.log(JSON.stringify(payload, null, 2))
} else if (payload.ok) {
  console.log(
    'check-local-ops: OK (' +
      payload.ops +
      ' ops · ' +
      payload.prefixes +
      ' prefixes · sha256 ' +
      String(payload.hash).slice(0, 12) +
      ')',
  )
} else {
  console.error('check-local-ops: FAIL')
  for (const failure of failures) console.error('- ' + failure)
}
process.exit(payload.ok ? 0 : 1)
