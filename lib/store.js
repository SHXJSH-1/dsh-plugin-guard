/**
 * Persistence for the guard: per-plugin version history, skipped warnings,
 * the rollback log, the registry cache, and profile file backups. Everything
 * lives outside the profile so the terminal entry can still read and repair a
 * profile that no longer boots.
 * @module dsh-plugin-guard/store
 */

import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { resolveDshHome } from './profile.js'
import { compareVersions } from './precheck.js'

const HISTORY_VERSION = 1
const MAX_BOOTS = 30

/** Root directory the guard owns. */
export function guardHome(env = process.env) {
  const override = env.DSH_PLUGIN_GUARD_HOME
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  return join(resolveDshHome(env), 'plugin-guard')
}

/** Registry cache directory shared with the analyzer. */
export function cacheDir(env = process.env) {
  return join(guardHome(env), 'cache')
}

/** Read a JSON document, falling back to a fresh value. */
async function readDocument(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

/** Write a JSON document atomically. */
async function writeDocument(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temporary, path)
}

/** Empty history document. */
function emptyHistory() {
  return { version: HISTORY_VERSION, boots: [], plugins: {} }
}

/** Read the version history. */
export function readHistory(env = process.env) {
  return readDocument(join(guardHome(env), 'history.json'), emptyHistory())
}

/**
 * Record one successful host start: the versions every installed plugin had at
 * the moment the harness came up. This is the record the rollback UI turns
 * into "the version that last worked".
 * @param input - env, profile facts, dsh version, installed entries.
 * @returns the updated history.
 */
export async function recordBoot(input) {
  const env = input.env ?? process.env
  const history = await readHistory(env)
  const at = new Date().toISOString()
  const installed = input.installed ?? []
  const profile = input.facts?.profileName ?? 'unknown'
  history.version = HISTORY_VERSION
  history.boots = [...(history.boots ?? []), { at, dshVersion: input.dshVersion, profile, plugins: Object.fromEntries(installed.map((item) => [item.name, item.version])) }].slice(-MAX_BOOTS)
  for (const item of installed) {
    // Keyed per profile: the same plugin can be installed at different versions
    // in different profiles, and one profile's boots must not rewrite another's
    // "current" version.
    const key = historyKey(profile, item.name)
    const record = history.plugins[key] ?? { current: undefined, entries: [] }
    record.current = item.version
    record.entries = record.entries ?? []
    let entry = record.entries.find((candidate) => candidate.version === item.version)
    if (entry === undefined) {
      entry = { version: item.version, bootCount: 0, firstSeenAt: at, spec: item.spec }
      record.entries.push(entry)
    }
    entry.bootCount += 1
    entry.lastSeenAt = at
    if (item.spec !== undefined) entry.spec = item.spec
    history.plugins[key] = record
  }
  await writeDocument(join(guardHome(env), 'history.json'), history)
  return history
}

/** History keys are `<profile>::<package>`; the name alone is the legacy shape. */
export function historyKey(profile, name) {
  return `${profile ?? 'unknown'}::${name}`
}

/** Look up a plugin's record for one profile, tolerating pre-profile data. */
export function historyRecord(history, profile, name) {
  const store = history?.plugins ?? {}
  return store[historyKey(profile, name)] ?? store[name]
}

/**
 * Turn one plugin's history record into the timeline the UI renders.
 * @param record - the stored record.
 * @returns current version, last known-good version, and versions newest first.
 */
export function pluginTimeline(record) {
  const entries = [...(record?.entries ?? [])]
  const sorted = entries.sort((left, right) => {
    const byDate = String(right.lastSeenAt ?? '').localeCompare(String(left.lastSeenAt ?? ''))
    if (byDate !== 0) return byDate
    return compareVersions(right.version, left.version) ?? 0
  })
  const lastGood = entries
    .filter((entry) => entry.version !== record?.current && (entry.bootCount ?? 0) > 0)
    .sort((left, right) => (right.bootCount ?? 0) - (left.bootCount ?? 0))[0]?.version
  return { current: record?.current, lastGood: lastGood ?? record?.current, versions: sorted }
}

/**
 * Per-plugin timeline joined with what is installed right now.
 * @param input - history, live installed entries, and the profile to read.
 * @returns one row per plugin, keyed by what this profile actually has.
 */
export function summarizeHistory(input) {
  const history = input.history ?? emptyHistory()
  const profile = input.profile
  const liveNames = (input.installed ?? []).map((item) => item.name)
  const names = [...new Set([...liveNames, ...Object.keys(history.plugins ?? {}).map((key) => (key.includes('::') ? key.split('::').slice(1).join('::') : key))])]
  return names
    .map((name) => {
      const live = (input.installed ?? []).find((item) => item.name === name)
      const record = historyRecord(history, profile, name)
      return { name, live, record, own: (history.plugins ?? {})[historyKey(profile, name)] !== undefined }
    })
    // A row belongs to this profile when it is installed here, or when this
    // profile has its own record. Legacy pre-profile keys only enrich rows that
    // are already part of this profile — they never add another profile's rows.
    .filter((row) => row.live !== undefined || row.own)
    .map(({ name, live, record }) => {
      const timeline = pluginTimeline(record)
      return {
        name,
        installedVersion: live?.version,
        spec: live?.spec ?? record?.entries?.find((entry) => entry.version === record.current)?.spec,
        lastGood: timeline.lastGood,
        current: timeline.current,
        versions: timeline.versions,
        rollbackable: timeline.versions.filter((entry) => entry.version !== live?.version),
        lastSeenAt: timeline.versions[0]?.lastSeenAt,
      }
    })
}

/** Read the skipped-warning log. */
export function readSkips(env = process.env) {
  return readDocument(join(guardHome(env), 'skips.json'), { version: 1, entries: [] })
}

/**
 * Record a warning the user chose to bypass, so it stays auditable later.
 * @returns the updated log.
 */
export async function recordSkip(input) {
  const env = input.env ?? process.env
  const document = await readSkips(env)
  const entries = document.entries ?? []
  entries.unshift({
    at: new Date().toISOString(),
    profile: input.facts?.profileName,
    spec: input.spec,
    verdict: input.report?.verdict,
    resolved: input.report?.resolved,
    findings: (input.report?.findings ?? []).map((item) => ({ rule: item.rule, severity: item.severity, title: item.title, detail: item.detail })),
    target: input.targetVersion,
  })
  const trimmed = { version: 1, entries: entries.slice(0, 200) }
  await writeDocument(join(guardHome(env), 'skips.json'), trimmed)
  return trimmed
}

/** Read the rollback log. */
export function readRollbackLog(env = process.env) {
  return readDocument(join(guardHome(env), 'rollbacks.json'), { version: 1, entries: [] })
}

/** Append one rollback attempt. */
export async function appendRollbackLog(input) {
  const env = input.env ?? process.env
  const document = await readRollbackLog(env)
  const entries = document.entries ?? []
  entries.unshift({
    at: new Date().toISOString(),
    profile: input.facts?.profileName,
    name: input.name,
    from: input.from,
    to: input.to,
    ok: input.result?.ok ?? false,
    exitCode: input.result?.code,
    tail: `${input.result?.stdout ?? ''}${input.result?.stderr ?? ''}`.trim().slice(-2000),
    backup: input.backup,
  })
  const trimmed = { version: 1, entries: entries.slice(0, 100) }
  await writeDocument(join(guardHome(env), 'rollbacks.json'), trimmed)
  return trimmed
}

/** Timestamp safe for a directory name. */
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/**
 * Copy the profile's writable state aside before a mutation.
 * @param input - env, facts, reason, installed versions, kind.
 * @returns the backup directory and the files captured.
 */
export async function backupProfile(input) {
  const env = input.env ?? process.env
  const dir = join(guardHome(env), 'backups', stamp())
  await mkdir(dir, { recursive: true })
  const files = []
  for (const name of ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
    const source = join(input.facts.profileDir, name)
    if (!existsSync(source)) continue
    await copyFile(source, join(dir, name))
    files.push(name)
  }
  await writeFile(
    join(dir, 'manifest.json'),
    `${JSON.stringify({ at: new Date().toISOString(), profile: input.facts.profileName, reason: input.reason, kind: input.kind ?? 'manual', files, plugins: input.installed ?? [] }, null, 2)}\n`,
  )
  return { dir, files }
}

/**
 * Keep the backup directory bounded. Automatic pre-install snapshots are the
 * widest source, so they are trimmed to their own budget; everything else is
 * only trimmed past the overall cap.
 * @param input - env, overall keep count, automatic keep count.
 * @returns the ids removed.
 */
export async function pruneBackups(input = {}) {
  const env = input.env ?? process.env
  const all = await listBackups(env)
  const automatic = all.filter((entry) => entry.kind === 'auto')
  const doomed = [...all.slice(input.keep ?? 40), ...automatic.slice(input.autoKeep ?? 25)]
  const ids = [...new Set(doomed.map((entry) => entry.id))]
  for (const id of ids) {
    if (!BACKUP_ID.test(id)) continue
    await rm(join(guardHome(env), 'backups', id), { recursive: true, force: true })
  }
  return ids
}

/**
 * Delete one backup. Only a directory that carries this package's own
 * `manifest.json` is ever removed, and the browser route cannot point the
 * deletion outside the backup root.
 * @param input - env, backup id, optional explicit path for internal callers.
 * @returns the removed id, or a reason it was refused.
 */
export async function deleteBackup(input) {
  const env = input.env ?? process.env
  const raw = input.id === undefined || input.id === '' ? '' : String(input.id)
  if (raw === '') return { ok: false, error: 'id is required' }
  const root = join(guardHome(env), 'backups')
  let dir
  if (input.allowPath === true && (isAbsolute(raw) || /[\\/]/.test(raw))) dir = resolve(raw)
  else if (BACKUP_ID.test(raw)) dir = join(root, raw)
  else return { ok: false, error: `invalid backup id ${JSON.stringify(raw)}` }
  if (input.allowPath !== true && !resolve(dir).startsWith(resolve(root))) return { ok: false, error: 'refusing to delete outside the backup root' }
  const manifest = await readDocument(join(dir, 'manifest.json'), undefined)
  if (manifest === undefined) return { ok: false, error: `${basename(dir)} is not a backup (no manifest.json)` }
  await rm(dir, { recursive: true, force: true })
  return { ok: true, id: basename(dir), dir, at: manifest.at, reason: manifest.reason, kind: manifest.kind ?? 'manual' }
}

/** List available backups, newest first, each with the disk space it takes. */
export async function listBackups(env = process.env) {
  const root = join(guardHome(env), 'backups')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const manifest = await readDocument(join(dir, 'manifest.json'), undefined)
    if (manifest !== undefined) out.push({ id: entry.name, ...manifest, kind: manifest.kind ?? 'manual', bytes: await directoryBytes(dir) })
  }
  return out.sort((left, right) => String(right.at).localeCompare(String(left.at)))
}

/**
 * Total size of the files directly inside a backup directory. Backups hold a
 * handful of small manifests, so this is a readdir plus a few stats — but it is
 * what makes "how much would deleting this free" answerable.
 * @param dir - the backup directory.
 * @returns the summed size in bytes (0 when nothing is readable).
 */
async function directoryBytes(dir) {
  let names
  try {
    names = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const name of names) {
    if (!name.isFile()) continue
    try {
      total += (await stat(join(dir, name.name))).size
    } catch {
      // A file that vanished mid-listing simply does not count.
    }
  }
  return total
}

/** Read the restore log. */
export function readRestoreLog(env = process.env) {
  return readDocument(join(guardHome(env), 'restores.json'), { version: 1, entries: [] })
}

/** Backup ids are directory names produced by this package; nothing else is accepted. */
const BACKUP_ID = /^[A-Za-z0-9._-]+$/

/**
 * Put a profile back the way a backup captured it. This is the step that makes
 * a rollback safe: if the new version cannot be installed, or it installs and
 * the harness still fails to start, the four profile files can be restored
 * verbatim without any harness running.
 * @param input - env, profile facts, backup id (or `latest`, or an absolute
 * directory when `allowPath` is set by an internal caller).
 * @returns the restored file list, or a reason it could not run.
 */
export async function restoreBackup(input) {
  const env = input.env ?? process.env
  const raw = input.id === undefined || input.id === '' ? 'latest' : String(input.id)
  const root = join(guardHome(env), 'backups')
  let dir
  if (raw === 'latest') {
    const newest = (await listBackups(env))[0]
    if (newest === undefined) return { ok: false, error: 'no backup is available to restore' }
    dir = join(root, newest.id)
  } else if (input.allowPath === true && (isAbsolute(raw) || /[\\/]/.test(raw))) {
    dir = resolve(raw)
  } else if (BACKUP_ID.test(raw)) {
    dir = join(root, raw)
  } else {
    return { ok: false, error: `invalid backup id ${JSON.stringify(raw)}` }
  }
  const manifest = await readDocument(join(dir, 'manifest.json'), undefined)
  if (manifest === undefined) return { ok: false, error: `backup ${basename(dir)} has no manifest.json` }
  const restored = []
  for (const name of manifest.files ?? []) {
    const source = join(dir, name)
    if (!existsSync(source)) continue
    await copyFile(source, join(input.facts.profileDir, name))
    restored.push(name)
  }
  const log = await readRestoreLog(env)
  const entries = log.entries ?? []
  entries.unshift({ at: new Date().toISOString(), profile: input.facts?.profileName, backup: basename(dir), reason: input.reason, files: restored })
  await writeDocument(join(guardHome(env), 'restores.json'), { version: 1, entries: entries.slice(0, 100) })
  return { ok: true, id: basename(dir), dir, files: restored, manifest }
}
