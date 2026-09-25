#!/usr/bin/env node
/**
 * Tests for the two report extras: the "how big / how old" lines in a precheck
 * report, and the per-backup disk usage in `backups`.
 *
 * Both are offline: the formatters are pure, and the backup listing is pointed
 * at a temporary guard home instead of a real one.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describeAge, describeSize } from '../lib/precheck.js'
import { listBackups } from '../lib/store.js'

let checks = 0
const failures = []
const check = (label, actual, expected) => {
  checks += 1
  if (actual !== expected) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// --- package size -----------------------------------------------------------
check('bytes', describeSize(512), '512 B')
check('kilobytes', describeSize(2048), '2.0 KB')
check('megabytes with file count', describeSize(1258291, 340), '1.2 MB（340 个文件）')
check('no size reported', describeSize(undefined), undefined)
check('zero size', describeSize(0), undefined)

// --- release age ------------------------------------------------------------
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString()
check('today', describeAge(ago(0), '1.0.0'), '今天（v1.0.0）')
check('yesterday', describeAge(ago(1), '1.0.0'), '昨天（v1.0.0）')
check('days', describeAge(ago(42), '1.0.0'), '42 天前（v1.0.0）')
check('months', describeAge(ago(100), '1.0.0'), '3 个月前（v1.0.0）')
check('years', describeAge(ago(800), '1.0.0'), '2.2 年前（v1.0.0）')
check('unparsable date', describeAge('not-a-date', '1.0.0'), undefined)

// --- backup disk usage ------------------------------------------------------
const home = mkdtempSync(join(tmpdir(), 'guard-backups-test-'))
const backupDir = join(home, 'backups', '2026-01-01T00-00-00-000Z')
mkdirSync(backupDir, { recursive: true })
const manifest = JSON.stringify({ at: '2026-01-01T00:00:00.000Z', files: ['package.json'] })
writeFileSync(join(backupDir, 'manifest.json'), manifest)
writeFileSync(join(backupDir, 'package.json'), 'x'.repeat(1500))

const backups = await listBackups({ DSH_PLUGIN_GUARD_HOME: home })
check('one backup listed', backups.length, 1)
check('backup bytes', backups[0]?.bytes, manifest.length + 1500)
check('backup id kept', backups[0]?.id, '2026-01-01T00-00-00-000Z')

if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL  ${failure}`)
  process.exit(1)
}
console.log(`  ok  ${String(checks)} report-extra assertions`)
