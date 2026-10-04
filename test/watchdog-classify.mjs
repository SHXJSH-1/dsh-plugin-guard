#!/usr/bin/env node
/**
 * Command-line classification used by the crash watchdog.
 *
 * Two real bugs live here, so the truth table is pinned:
 *   1. a `dsh web` of *another* DSH_HOME/profile must not be mistaken for ours
 *      (measured: a lab instance made the live watcher raise a dialog);
 *   2. a `dsh plugin …` call composes the profile and rewrites `cordis.yml`
 *      without starting anything — counting that as a failed start is what used
 *      to interrupt normal use with a dialog 120s later.
 */
import { isDshCliCall, isDshStart } from '../lib/watchdog.js'

const node = 'C:\\Program Files\\nodejs\\node.exe'
const bin = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
const guard = 'C:\\Users\\me\\Desktop\\dsh-plugin-guard\\lib\\watchdog.js'

const cases = [
  { label: 'plain start', cmd: `"${node}" "${bin}" web`, start: true, cli: false },
  { label: 'start with port', cmd: `"${node}" "${bin}" web --port 3080`, start: true, cli: false },
  { label: 'start of another profile', cmd: `"${node}" "${bin}" web --profile other`, start: false, cli: false },
  { label: 'plugin call (the false-alarm source)', cmd: `"${node}" "${bin}" plugin --profile web install`, start: false, cli: true },
  { label: 'plugin call, flag first', cmd: `"${node}" "${bin}" --profile web plugin add dsh-quick-ask`, start: false, cli: true },
  { label: 'plugin call of another profile', cmd: `"${node}" "${bin}" plugin --profile other install`, start: false, cli: false },
  { label: 'the watchdog daemon itself', cmd: `"${node}" "${guard}" --daemon --profile web`, start: false, cli: false },
]

let checks = 0
const failures = []
const check = (label, actual, expected) => {
  checks += 1
  if (actual !== expected) failures.push(`${label}: expected ${String(expected)}, got ${String(actual)}`)
}

for (const item of cases) {
  check(`${item.label} / isDshStart`, isDshStart(item.cmd, 'web'), item.start)
  check(`${item.label} / isDshCliCall`, isDshCliCall(item.cmd, 'web'), item.cli)
}
check('empty command line', isDshStart('', 'web'), false)
check('unrelated node process', isDshCliCall(`"${node}" some-script.js`, 'web'), false)

if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL  ${failure}`)
  process.exit(1)
}
console.log(`  ok  ${String(checks)} watchdog classification assertions`)
