/**
 * Profile, package-tree and CLI facts for the guard. Every write in this
 * package goes through the official `dsh plugin` command; this module owns the
 * read side plus the one spawn helper that performs those writes.
 * @module dsh-plugin-guard/profile
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { registryOf } from './precheck.js'

const DSL_PACKAGE = '@deepseek-ai/dsh'
let dshRootCache

/** Expand a leading `~` in a path. */
export function expandHome(path, home = homedir()) {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2))
  return path
}

/** Resolve the DSH home directory. */
export function resolveDshHome(env = process.env) {
  const raw = env.DSH_HOME
  if (raw !== undefined && raw.trim() !== '') {
    const expanded = expandHome(raw.trim())
    return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded)
  }
  return join(homedir(), '.dsh')
}

/** Read and parse JSON, tolerating a byte order mark. */
export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return undefined
  }
}

/** Persisted profile the packaged desktop app last selected, when present. */
function desktopSelectedProfile(env = process.env) {
  const explicit = env.DSH_DESKTOP_DEFAULT_PROFILE
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  const roots = [env.APPDATA === undefined ? undefined : join(env.APPDATA, 'DSH Desktop')].filter((value) => typeof value === 'string')
  for (const root of roots) {
    const state = readJson(join(root, 'profile-selection', 'state.json'))
    if (typeof state?.active === 'string' && state.active.trim() !== '') return state.active.trim()
  }
  return undefined
}

/**
 * Resolve the boot profile.
 * @param options - argv/env seams plus an explicit profile override.
 * @returns profile facts; `error` is set when the profile cannot be named.
 */
export function resolveProfileFacts(options = {}) {
  const argv = options.argv ?? process.argv
  const env = options.env ?? process.env
  const home = resolveDshHome(env)
  let name = options.profileName
  let desktop = false
  if (name === undefined) {
    const flagIndex = argv.indexOf('--profile')
    if (flagIndex !== -1 && argv[flagIndex + 1] !== undefined && argv[flagIndex + 1] !== '') name = argv[flagIndex + 1]
    else if (typeof env.DSH_PROFILE === 'string' && env.DSH_PROFILE.trim() !== '') {
      name = env.DSH_PROFILE.trim()
      desktop = argv.length <= 1 && desktopSelectedProfile(env) === name
    } else if (argv.includes('web')) name = 'web'
    else {
      name = desktopSelectedProfile(env)
      desktop = name !== undefined
    }
  }
  if (name === undefined) {
    const candidates = profileCandidates(home)
    // `dsh web` is the launcher's own alias for this profile, so an ambiguous
    // machine still resolves the way the launcher would resolve it. Stale
    // backups such as `web.bak` must not make the rescue entry unusable.
    if (candidates.includes('web')) name = 'web'
    else if (candidates.length === 1) name = candidates[0]
    else {
      return {
        dshHome: home,
        error:
          candidates.length === 0
            ? `no profile found under ${join(home, 'profiles')}; pass --profile <name> or set DSH_PROFILE`
            : `cannot determine the boot profile; pass --profile <name> (available: ${candidates.join(', ')})`,
      }
    }
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return { dshHome: home, error: `invalid profile name ${JSON.stringify(name)}` }
  const profileDir = join(home, 'profiles', name)
  return {
    dshHome: home,
    profileName: name,
    profileDir,
    patchPath: join(profileDir, 'cordis.patch.yml'),
    packageJsonPath: join(profileDir, 'package.json'),
    desktop,
  }
}

/** Whether a profile directory holds a manifest. */
export function profileExists(facts) {
  return facts?.packageJsonPath !== undefined && existsSync(facts.packageJsonPath)
}

/** Profile names that carry a manifest, for error messages and single-profile inference. */
export function profileCandidates(home) {
  try {
    return readdirSync(join(home, 'profiles'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(home, 'profiles', entry.name, 'package.json')))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** Resolve a package from the DSH installation's own tree only. */
function dshTreeProvider(env) {
  return (name) => {
    const root = dshInstallRoot(env)
    if (root === undefined) return undefined
    const dir = join(root, 'node_modules', ...name.split('/'))
    const manifest = readJson(join(dir, 'package.json'))
    if (manifest === undefined) return undefined
    return { name: manifest.name ?? name, version: typeof manifest.version === 'string' ? manifest.version : 'unknown', from: 'dsh', dir }
  }
}

/**
 * Environment facts that do not depend on knowing the profile: used by the
 * terminal entry when the profile cannot be named, so a precheck still reports
 * the DSH version and resolves `@deepseek-ai/*` packages from the install tree.
 * @param env - environment seam.
 * @returns the partial environment record for `analyze`.
 */
export async function standaloneEnvironment(env = process.env) {
  return {
    dshVersion: await probeDshVersion(env),
    nodeVersion: process.versions.node,
    profileName: undefined,
    installed: [],
    rows: [],
    bundles: [],
    dshPackages: dshPackageNames(env),
    registry: registryOf(env),
    provider: dshTreeProvider(env),
  }
}

/** Strip one layer of matching quotes. */
function unquote(value) {
  const text = value.trim()
  if (text.length >= 2 && ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"')))) return text.slice(1, -1)
  return text
}

/**
 * Scan a cordis patch file for loader row declarations. The scanner is
 * line-based and tolerant: it reports the `id`/`name` pairs the loader would
 * mount, which is all the conflict rules need.
 * @param patchPath - absolute patch file path.
 * @param from - label recorded on each row (who declared it).
 * @returns rows in file order.
 */
export function readPatchRows(patchPath, from) {
  let text
  try {
    text = readFileSync(patchPath, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return []
  }
  const rows = []
  let current
  for (const line of text.split(/\r?\n/)) {
    const idMatch = /^\s*-\s*id:\s*(.+?)\s*$/.exec(line)
    if (idMatch !== null) {
      current = { id: unquote(idMatch[1]), from }
      rows.push(current)
      continue
    }
    if (current === undefined) continue
    const nameMatch = /^\s+name:\s*(.+?)\s*$/.exec(line)
    if (nameMatch !== null && current.name === undefined) {
      current.name = unquote(nameMatch[1])
      continue
    }
    if (/^\s*disabled:\s*(true|false)\s*$/.test(line)) current.disabled = /true/.test(line)
  }
  return rows
}

/** Resolve the installed tree of a package name, profile first, then the dsh install. */
export function resolvePackageDir(name, profileDir, env = process.env) {
  const segments = name.split('/')
  const candidates = []
  if (profileDir !== undefined) candidates.push(join(profileDir, 'node_modules', ...segments))
  const root = dshInstallRoot(env)
  if (root !== undefined) candidates.push(join(root, 'node_modules', ...segments))
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/** Resolve the installed `@deepseek-ai/dsh` package root. */
export function dshInstallRoot(env = process.env) {
  if (dshRootCache !== undefined) return dshRootCache
  const candidates = []
  const override = env.DSH_PLUGIN_GUARD_DSH
  if (typeof override === 'string' && override.trim() !== '') candidates.push(override.trim())
  const argv1 = process.argv[1]
  if (typeof argv1 === 'string' && argv1 !== '') {
    let dir = dirname(resolve(argv1))
    for (let depth = 0; depth < 6; depth += 1) {
      const manifest = readJson(join(dir, 'package.json'))
      if (manifest?.name === DSL_PACKAGE) {
        candidates.push(dir)
        break
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  for (const entry of (env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (entry.trim() === '') continue
    candidates.push(join(entry, 'node_modules', '@deepseek-ai', 'dsh'))
    candidates.push(join(entry, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh'))
  }
  if (process.platform === 'win32' && typeof env.APPDATA === 'string') candidates.push(join(env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh'))
  for (const candidate of candidates) {
    const manifest = readJson(join(candidate, 'package.json'))
    if (manifest?.name === DSL_PACKAGE) {
      dshRootCache = resolve(candidate)
      return dshRootCache
    }
  }
  return undefined
}

/** The launcher entry of the installed dsh CLI. */
export function dshCliBin(env = process.env) {
  const root = dshInstallRoot(env)
  if (root === undefined) return undefined
  const bin = join(root, 'lib', 'bin.js')
  return existsSync(bin) ? bin : undefined
}

/**
 * Probe the running DSH version: the installed package manifest first, the
 * launcher's own `--version` output as a fallback.
 * @param env - environment seam.
 * @returns the version string, or undefined.
 */
export async function probeDshVersion(env = process.env) {
  const root = dshInstallRoot(env)
  const manifest = root === undefined ? undefined : readJson(join(root, 'package.json'))
  if (typeof manifest?.version === 'string') return manifest.version
  const bin = dshCliBin(env)
  if (bin === undefined) return undefined
  try {
    const result = await new Promise((resolveRun) => {
      execFile(process.execPath, [bin, '--version'], { timeout: 20000, windowsHide: true, env }, (error, stdout) => resolveRun({ error, stdout }))
    })
    const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(String(result.stdout ?? ''))
    return match?.[1]
  } catch {
    return undefined
  }
}

/** The profile manifest's dependency and bundle lists. */
export function readProfileManifest(facts) {
  const manifest = readJson(facts.packageJsonPath)
  return {
    manifest,
    dependencies: manifest?.dependencies ?? {},
    bundles: Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [],
  }
}

/**
 * Read every installed plugin the profile declares, with resolved versions.
 * @param facts - profile facts.
 * @param env - environment seam.
 * @returns installed entries in declaration order.
 */
export function readInstalledPlugins(facts, env = process.env) {
  const { dependencies, bundles } = readProfileManifest(facts)
  const names = [...new Set([...Object.keys(dependencies), ...bundles])]
  return names.map((name) => {
    const dir = resolvePackageDir(name, facts.profileDir, env)
    const manifest = dir === undefined ? undefined : readJson(join(dir, 'package.json'))
    return {
      name,
      version: typeof manifest?.version === 'string' ? manifest.version : 'unknown',
      spec: typeof dependencies[name] === 'string' ? dependencies[name] : bundles.includes(name) ? 'bundle' : undefined,
      bundled: bundles.includes(name),
      dir,
    }
  })
}

/** Rows one installed package contributes through its `dsh.bundle.patch`. */
export function rowsOfPackage(entry) {
  if (entry?.dir === undefined) return []
  const manifest = readJson(join(entry.dir, 'package.json'))
  const patch = manifest?.dsh?.bundle?.patch
  if (typeof patch !== 'string') return []
  return readPatchRows(join(entry.dir, patch), `${entry.name}@${entry.version}`)
}

/**
 * Every loader row the profile would mount: the profile patch, the home patch,
 * and each installed bundle's own patch.
 * @param facts - profile facts.
 * @param env - environment seam.
 * @returns row list with provenance labels.
 */
export function readAllPatchRows(facts, env = process.env) {
  const rows = [
    ...readPatchRows(facts.patchPath, `${facts.profileName}:cordis.patch.yml`),
    ...readPatchRows(join(facts.dshHome, 'cordis.patch.yml'), 'home:cordis.patch.yml'),
  ]
  for (const entry of readInstalledPlugins(facts, env)) rows.push(...rowsOfPackage(entry))
  return rows
}

/** Package names shipped inside the dsh installation's own tree. */
export function dshPackageNames(env = process.env) {
  const root = dshInstallRoot(env)
  if (root === undefined) return []
  const names = []
  for (const scopeDir of [join(root, 'node_modules', '@deepseek-ai'), join(root, 'node_modules')]) {
    try {
      for (const entry of readdirSync(scopeDir, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        if (scopeDir.endsWith('@deepseek-ai')) names.push(`@deepseek-ai/${entry.name}`)
        else if (entry.name.startsWith('@')) {
          try {
            for (const scoped of readdirSync(join(scopeDir, entry.name))) names.push(`${entry.name}/${scoped}`)
          } catch {}
        }
      }
    } catch {}
  }
  return names
}

/**
 * Collect everything the analyzer needs about this machine and profile.
 * @param facts - profile facts.
 * @param options - env and registry seams.
 * @returns the environment record for `analyze`.
 */
export async function collectEnvironment(facts, options = {}) {
  const env = options.env ?? process.env
  const installed = profileExists(facts) ? readInstalledPlugins(facts, env) : []
  const { bundles } = readProfileManifest(facts)
  return {
    dshVersion: options.dshVersion ?? (await probeDshVersion(env)),
    nodeVersion: process.versions.node,
    profileName: facts.profileName,
    installed,
    rows: profileExists(facts) ? readAllPatchRows(facts, env) : [],
    bundles,
    dshPackages: dshPackageNames(env),
    autoInstallPeers: readAutoInstallPeers(facts),
    registry: registryOf(env),
    provider: (name) => {
      const dir = resolvePackageDir(name, facts.profileDir, env)
      if (dir === undefined) return undefined
      const manifest = readJson(join(dir, 'package.json'))
      if (manifest === undefined) return undefined
      const inProfile = dir.startsWith(join(facts.profileDir, 'node_modules'))
      return { name: manifest.name ?? name, version: typeof manifest.version === 'string' ? manifest.version : 'unknown', from: inProfile ? 'profile' : 'dsh', dir }
    },
  }
}

/**
 * Whether this profile installs peer dependencies automatically. The profile's
 * pnpm config decides it, and `false` means a plugin's peers are absent from
 * the profile's own `node_modules` — the setting that makes a peer-heavy
 * package fail its post-install row validation.
 * @param facts - profile facts.
 * @returns true/false when declared, undefined when the profile says nothing.
 */
export function readAutoInstallPeers(facts) {
  if (facts?.profileDir === undefined) return undefined
  const yaml = readFileText(join(facts.profileDir, 'pnpm-workspace.yaml'))
  if (yaml !== undefined) {
    const match = /^\s*autoInstallPeers\s*:\s*(true|false)\s*$/m.exec(yaml)
    if (match !== null) return match[1] === 'true'
  }
  for (const file of [join(facts.profileDir, '.npmrc'), join(facts.dshHome ?? '', '.npmrc')]) {
    const text = readFileText(file)
    if (text === undefined) continue
    const match = /^\s*auto-install-peers\s*=\s*(true|false)\s*$/m.exec(text)
    if (match !== null) return match[1] === 'true'
  }
  return undefined
}

/** Read a small text file, tolerating absence. */
function readFileText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Rows a local package would insert, read straight from its own patch file. */
export function readLocalRows(dir, manifest) {
  const patch = manifest?.dsh?.bundle?.patch
  if (typeof patch !== 'string') return []
  return readPatchRows(join(dir, patch), `${manifest?.name ?? 'local'}@${manifest?.version ?? '?'}`)
}

/**
 * Run one `dsh plugin` invocation — the only supported write path.
 * @param options - facts, extra CLI args, env, timeout.
 * @returns the finished run: exit code and captured output.
 */
export function runDshPlugin(options) {
  const env = options.env ?? process.env
  const bin = dshCliBin(env)
  if (bin === undefined) return Promise.resolve({ ok: false, code: null, stdout: '', stderr: 'dsh CLI not found; cannot install or roll back' })
  const args = [bin, 'plugin', '--profile', options.facts.profileName, ...options.args]
  return new Promise((resolveRun) => {
    execFile(
      process.execPath,
      args,
      { cwd: options.facts.profileDir, env, timeout: options.timeoutMs ?? 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        resolveRun({ ok: error === null, code: error === null ? 0 : (error.code ?? 1), stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      },
    )
  })
}

/**
 * Bring `node_modules` back in line with the profile manifest.
 *
 * Restoring or editing the manifest files does not touch the installed tree, so
 * a profile can end up listing a package whose directory is gone — and DSH then
 * aborts inside `loadProfile` with `cannot resolve profile bundle …`, before it
 * writes anything (measured: zero files). Without this step a rescue can loop:
 * restore → start fails → restore → start fails.
 * @param options - facts and env.
 * @returns `{ ok, output }` with the tail of the CLI output.
 */
export async function reconcileProfile(options) {
  const result = await runDshPlugin({ facts: options.facts, env: options.env, args: ['install'] })
  const output = `${result.stdout}${result.stderr}`.split('\n').filter((line) => line.trim() !== '').slice(-3).join(' / ')
  return { ok: result.ok, output }
}
