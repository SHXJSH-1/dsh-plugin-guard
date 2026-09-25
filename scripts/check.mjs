#!/usr/bin/env node
/**
 * Self-check for this package.
 *
 * It ships plain ESM with **no build step** (no bundler, no transpile, zero
 * dependencies), so "the artifact is usable" is verified by checking what a
 * build would otherwise guarantee:
 *
 *   1. every shipped module parses;
 *   2. the manifest points at files that really exist (`main`, `exports`,
 *      `bin`, `dsh.bundle.patch`) — a broken path here is a profile that will
 *      not boot;
 *   3. the row in `cordis.patch.yml` names this package, or nobody installing it
 *      could resolve that row;
 *   4. the browser bundle registers its settings tab and renders it.
 *
 * Run it directly (`node scripts/check.mjs`) or through `npm test`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const notes = []

/** Run a node script and capture failure without throwing. */
function run(args) {
  try {
    return { ok: true, output: execFileSync(process.execPath, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

// 1) every shipped module parses
const modules = readdirSync(join(root, 'lib')).filter((name) => name.endsWith('.js') || name.endsWith('.mjs'))
for (const name of modules) {
  const result = run(['--check', join(root, 'lib', name)])
  if (!result.ok) failures.push(`lib/${name} does not parse:\n${result.output.trim()}`)
}
notes.push(`${String(modules.length)} modules parse`)

// 2) the manifest points at files that exist
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const declared = [
  ['main', manifest.main],
  ['exports["."]', typeof manifest.exports?.['.'] === 'string' ? manifest.exports['.'] : undefined],
  ['exports["./client"]', manifest.exports?.['./client']],
  ['bin["dsh-plugin-guard"]', manifest.bin?.['dsh-plugin-guard']],
  ['dsh.bundle.patch', manifest.dsh?.bundle?.patch],
]
for (const [label, relative] of declared) {
  if (typeof relative !== 'string') {
    failures.push(`${label} is missing from package.json`)
    continue
  }
  if (!existsSync(join(root, relative))) failures.push(`${label} points at a missing file: ${relative}`)
}
for (const entry of manifest.files ?? []) {
  if (!existsSync(join(root, entry))) failures.push(`files[] lists a missing path: ${entry}`)
}
notes.push('manifest paths resolve')

// 3) the browser bundle renders its settings tab
const render = run([join(root, 'test', 'tab-render-check.mjs'), join(root, 'lib', 'client.js')])
if (!render.ok) failures.push(`the client bundle failed its render check:\n${render.output.trim()}`)
else notes.push(render.output.trim().split('\n').at(-1) ?? 'render check ok')

// 4) the row this plugin inserts must name this package: the profile resolves it
// by that string, so a mismatch means nobody who installs it can boot.
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
if (!patch.includes(`name: '${String(manifest.name)}'`)) {
  failures.push(`cordis.patch.yml does not insert a row named "${String(manifest.name)}" — the profile could not resolve it and DSH would not boot`)
} else {
  notes.push('patch row matches the package name')
}

for (const note of notes) console.log(`  ok  ${note}`)
if (failures.length > 0) {
  console.error('')
  for (const failure of failures) console.error(`  FAIL  ${failure}`)
  process.exit(1)
}
console.log('package check passed')
