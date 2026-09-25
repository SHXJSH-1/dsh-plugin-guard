/**
 * Dependency-free compatibility and conflict analyzer shared by the guard's
 * host half and its terminal entry. Nothing here reads the harness directly:
 * callers hand in environment facts, so the same rules run inside a healthy
 * DSH and from the shell of a profile that no longer boots.
 * @module dsh-plugin-guard/precheck
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Registry used when neither the caller nor the environment names one. */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
const PARTIAL_RE = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * Parse a semver string.
 * @param value - e.g. `0.1.5-rc.2`.
 * @returns the parsed version, or undefined when malformed.
 */
export function parseVersion(value) {
  if (typeof value !== 'string') return undefined
  const match = VERSION_RE.exec(value.trim())
  if (match === null) return undefined
  const pre = match[4] === undefined ? [] : match[4].split('.')
  if (pre.some((part) => part === '')) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: pre.map((part) => (/^\d+$/.test(part) ? Number(part) : part)),
    raw: value.trim(),
  }
}

/** Compare prerelease identifier lists per semver (a release outranks a prerelease). */
function comparePre(left, right) {
  if (left.length === 0 || right.length === 0) {
    if (left.length === right.length) return 0
    return left.length === 0 ? 1 : -1
  }
  const size = Math.max(left.length, right.length)
  for (let index = 0; index < size; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    const aNumeric = typeof a === 'number'
    const bNumeric = typeof b === 'number'
    if (aNumeric && bNumeric) return a < b ? -1 : 1
    if (aNumeric) return -1
    if (bNumeric) return 1
    return String(a) < String(b) ? -1 : 1
  }
  return 0
}

/** Compare two parsed versions. */
function compareParsed(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  return comparePre(left.pre, right.pre)
}

/**
 * Compare two version strings.
 * @returns -1 / 0 / 1, or undefined when either side is malformed.
 */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === undefined || b === undefined) return undefined
  return compareParsed(a, b)
}

/** Parse a range operand; `x`/`*` parts stay undefined. */
function parsePartial(text) {
  const match = PARTIAL_RE.exec(text.trim())
  if (match === null) return undefined
  const read = (part) => (part === undefined || /^[xX*]$/.test(part) ? undefined : Number(part))
  const major = read(match[1])
  const minor = read(match[2])
  const patch = read(match[3])
  if (major === undefined) return { any: true }
  const pre = match[4] === undefined ? [] : match[4].split('.')
  return { major, minor, patch, pre, raw: text.trim() }
}

/** Format a partial range operand as a concrete version string. */
function partialAt(partial, bump) {
  const minor = partial.minor ?? 0
  const patch = partial.patch ?? 0
  if (partial.pre !== undefined && partial.pre.length > 0 && bump === 'exact') {
    return `${partial.major}.${minor}.${patch}-${partial.pre.join('.')}`
  }
  return `${partial.major}.${minor}.${patch}`
}

/** Expand one comparator token into inclusive/exclusive bounds. */
function boundsOfToken(token) {
  const text = token.trim()
  if (text === '') return undefined
  if (/^[xX*]$/.test(text)) return {}
  const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(text)
  if (match === null) return undefined
  const operator = match[1] ?? '='
  const partial = parsePartial(match[2])
  if (partial === undefined) return undefined
  if (partial.any === true) return {}
  const exact = partialAt(partial, 'exact')
  const missingMinor = partial.minor === undefined
  const missingPatch = partial.patch === undefined

  if (operator === '>=') return { gte: exact }
  if (operator === '>') {
    if (missingMinor) return { gte: `${partial.major + 1}.0.0` }
    if (missingPatch) return { gte: `${partial.major}.${partial.minor + 1}.0` }
    return { gt: exact }
  }
  if (operator === '<=') {
    if (missingMinor) return { lt: `${partial.major + 1}.0.0` }
    if (missingPatch) return { lt: `${partial.major}.${partial.minor + 1}.0` }
    return { lte: exact }
  }
  if (operator === '<') return { lt: exact }
  if (operator === '^') {
    const upper =
      partial.major > 0
        ? `${partial.major + 1}.0.0`
        : partial.minor === undefined
          ? '1.0.0'
          : partial.minor > 0
            ? `0.${partial.minor + 1}.0`
            : missingPatch
              ? '0.1.0'
              : `0.0.${partial.patch + 1}`
    return { gte: exact, lt: upper }
  }
  if (operator === '~') {
    const upper = missingMinor
      ? `${partial.major + 1}.0.0`
      : `${partial.major}.${partial.minor + 1}.0`
    return { gte: exact, lt: upper }
  }
  if (missingMinor) return { gte: `${partial.major}.0.0`, lt: `${partial.major + 1}.0.0` }
  if (missingPatch) return { gte: `${partial.major}.${partial.minor}.0`, lt: `${partial.major}.${partial.minor + 1}.0` }
  return { gte: exact, lte: exact }
}

/** Split one `||` group into comparator bounds, or undefined when unparseable. */
function boundsOfGroup(group) {
  const text = group.trim()
  if (text === '') return []
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text)
  if (hyphen !== null) {
    const low = parsePartial(hyphen[1])
    const high = parsePartial(hyphen[2])
    if (low === undefined || high === undefined) return undefined
    return [{ gte: partialAt(low, 'exact') }, { lte: partialAt(high, 'exact') }]
  }
  const bounds = []
  for (const token of text.split(/\s+/)) {
    const bound = boundsOfToken(token)
    if (bound === undefined) return undefined
    bounds.push(bound)
  }
  return bounds
}

/**
 * Whether a parsed version matches every bound of one comparator group.
 *
 * Bounds are compared by version order, including prereleases: a plugin asking
 * for `>=0.1.2-rc.1` is satisfied by `0.1.5-rc.2`, which is what its author
 * meant and what keeps a DSH prerelease from flagging every package in the
 * store. Strict node-semver would reject that pair, and pnpm reports it as an
 * unmet peer on install — noise the guard deliberately does not reproduce. A
 * requirement that is genuinely newer (`>=0.2.0`) still fails.
 */
function matchesGroup(version, bounds) {
  for (const bound of bounds) {
    const pairs = [
      ['gte', (a, b) => a >= b],
      ['gt', (a, b) => a > b],
      ['lte', (a, b) => a <= b],
      ['lt', (a, b) => a < b],
    ]
    for (const [key, test] of pairs) {
      if (bound[key] === undefined) continue
      const limit = parseVersion(bound[key])
      if (limit === undefined) return false
      if (!test(compareParsed(version, limit), 0)) return false
    }
  }
  return true
}

/**
 * Test a version against a semver range.
 * @param version - concrete version string.
 * @param range - npm range; supports `||`, space-joined comparators, caret,
 * tilde, hyphen ranges and partial operands.
 * @returns true/false, or undefined when either side cannot be parsed.
 */
export function satisfiesRange(version, range) {
  const parsed = parseVersion(version)
  if (parsed === undefined) return undefined
  if (typeof range !== 'string' || range.trim() === '') return undefined
  let comparable = false
  for (const group of range.split('||')) {
    const bounds = boundsOfGroup(group)
    if (bounds === undefined) continue
    comparable = true
    if (matchesGroup(parsed, bounds)) return true
  }
  return comparable ? false : undefined
}

/** Registry base URL, honoring the environment override. */
export function registryOf(env = process.env) {
  const raw = env.DSH_PLUGIN_GUARD_REGISTRY
  return (raw !== undefined && raw.trim() !== '' ? raw.trim() : DEFAULT_REGISTRY).replace(/\/+$/, '')
}

/**
 * Read a packument, using a small on-disk cache shared with the terminal entry.
 * @param name - package name.
 * @param options - registry, cacheDir, ttlMs, timeoutMs, fetchImpl, env.
 * @returns the parsed packument.
 */
export async function fetchPackument(name, options = {}) {
  const registry = (options.registry ?? registryOf(options.env)).replace(/\/+$/, '')
  const ttlMs = options.ttlMs ?? 10 * 60 * 1000
  const cacheDir = options.cacheDir
  const cachePath =
    cacheDir === undefined
      ? undefined
      : join(cacheDir, `${name.replace(/[^A-Za-z0-9._-]/g, '_')}-${createHash('sha1').update(registry).digest('hex').slice(0, 8)}.json`)
  if (cachePath !== undefined) {
    try {
      const cached = JSON.parse(await readFile(cachePath, 'utf8'))
      if (typeof cached.fetchedAt === 'number' && Date.now() - cached.fetchedAt < ttlMs) return cached.body
    } catch {}
  }
  const doFetch = options.fetchImpl ?? fetch
  const response = await doFetch(`${registry}/${name.replace('/', '%2f')}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(options.timeoutMs ?? 20000),
  })
  if (!response.ok) throw new Error(`registry ${registry} -> HTTP ${String(response.status)} for ${name}`)
  const text = await response.text()
  if (text.length > 32 * 1024 * 1024) throw new Error(`registry manifest for ${name} is unreasonably large`)
  const body = JSON.parse(text)
  if (cachePath !== undefined) {
    try {
      await mkdir(cacheDir, { recursive: true })
      await writeFile(cachePath, JSON.stringify({ fetchedAt: Date.now(), body }))
    } catch {}
  }
  return body
}

/** Decide whether a spec names a registry package, a local path, or a git remote. */
export function classifySpec(spec) {
  const text = String(spec ?? '').trim()
  if (text === '') return { kind: 'empty' }
  if (/^(git\+|git:|github:|gitlab:|bitbucket:|https?:\/\/.*\.git)/i.test(text)) return { kind: 'git', spec: text }
  if (/^(file:|link:|portal:)/i.test(text)) return { kind: 'local', dir: text.replace(/^[a-z]+:/i, ''), spec: text }
  // A backslash never appears in a registry spec, so it marks a Windows path.
  if (text.includes('\\')) return { kind: 'local', dir: text, spec: text }
  if (/^[./]|^[A-Za-z]:[\\/]/.test(text)) return { kind: 'local', dir: text, spec: text }
  const match = /^(@?[^@/\s]+(?:\/[^@/\s]+)?)(?:@(.+))?$/.exec(text)
  if (match === null) return { kind: 'unknown', spec: text }
  const version = match[2]
  if (version !== undefined && /^(git|file|link|portal|https?|npm):/i.test(version)) return { kind: 'git', spec: text }
  return { kind: 'npm', name: match[1], requested: version, spec: text }
}

/**
 * Resolve the manifest a spec would install, without installing anything.
 * @param spec - npm spec, local path, or git URL.
 * @param options - profileDir, registry, cacheDir, env, fetchImpl, versionsLimit.
 * @returns a target fact record; `error` is set when resolution failed.
 */
export async function resolveTarget(spec, options = {}) {
  const classified = classifySpec(spec)
  const base = { ...classified, versions: [] }
  if (classified.kind === 'empty') return { ...base, error: 'empty spec' }
  if (classified.kind === 'unknown') return { ...base, error: `unrecognized spec ${JSON.stringify(String(spec))}` }
  if (classified.kind === 'git') return { ...base, error: 'git sources cannot be prechecked before clone' }
  if (classified.kind === 'local') {
    const dir = classified.dir.startsWith('.') && options.profileDir !== undefined ? join(options.profileDir, classified.dir) : classified.dir
    let stats
    try {
      stats = await stat(dir)
    } catch {
      return { ...base, dir, error: `路径不存在：${dir}` }
    }
    if (!stats.isDirectory()) {
      return { ...base, dir, error: `${dir} 是文件，不是插件包；预检需要包名、git 地址，或含 package.json 的包目录` }
    }
    try {
      const manifest = JSON.parse((await readFile(join(dir, 'package.json'), 'utf8')).replace(/^\uFEFF/, ''))
      return { ...base, dir, name: manifest.name, version: manifest.version, manifest, rows: options.readLocalRows === undefined ? undefined : await options.readLocalRows(dir, manifest) }
    } catch (error) {
      return { ...base, dir, error: `${dir} 里没有可读的 package.json（不是插件包）：${error instanceof Error ? error.message : String(error)}` }
    }
  }
  if (classified.requested !== undefined && !/^[~^<>=*xX\d]/.test(classified.requested)) {
    return { ...base, error: `unsupported npm spec version ${JSON.stringify(classified.requested)}` }
  }
  try {
    const packument = await fetchPackument(classified.name, options)
    const versions = Object.keys(packument.versions ?? {})
    const wanted = classified.requested ?? packument['dist-tags']?.latest
    const pick =
      classified.requested !== undefined && packument.versions?.[classified.requested] !== undefined
        ? classified.requested
        : newestSatisfying(versions, classified.requested) ?? wanted
    const manifest = pick === undefined ? undefined : packument.versions?.[pick]
    if (manifest === undefined) return { ...base, error: `no published version matches ${JSON.stringify(String(spec))}` }
    return {
      ...base,
      name: manifest.name ?? classified.name,
      version: manifest.version ?? pick,
      manifest,
      latest: packument['dist-tags']?.latest,
      versions: [...versions].reverse().slice(0, options.versionsLimit ?? 60),
      tarball: manifest.dist?.tarball,
    }
  } catch (error) {
    return { ...base, error: `registry lookup failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** Newest published version satisfying a range, if any. */
function newestSatisfying(versions, range) {
  if (typeof range !== 'string' || range.trim() === '') return undefined
  const ordered = versions.filter((version) => parseVersion(version) !== undefined).sort((a, b) => compareVersions(b, a))
  return ordered.find((version) => satisfiesRange(version, range) === true)
}

/** Normalize one finding. */
function finding(rule, severity, title, detail, evidence) {
  return { rule, severity, title, detail, evidence }
}

/** Read the `dsh`/`engines` compatibility declaration of a manifest. */
export function declaredDshEngine(manifest) {
  return manifest?.dsh?.engines?.dsh ?? manifest?.engines?.dsh ?? manifest?.dsh?.engines ?? undefined
}

/** Whether a declared compatibility status reads as compatible. */
function isCompatibleStatus(value) {
  return /^compat/i.test(String(value))
}

/**
 * Community plugins declare `dsh.compatibility.dshReleases`, a map of tested
 * DSH releases to a status word. It is the only declarative compatibility data
 * this ecosystem publishes besides `engines.dsh`, so the guard uses it when it
 * is present: a matching release marked non-compatible is a blocker, the
 * nearest lower release marked non-compatible is a warning, and a version
 * simply missing from a list of compatible releases stays informational.
 * @param manifest - the target package manifest.
 * @param dshVersion - the running DSH version, when known.
 * @returns one finding, or undefined when the package declares nothing.
 */
function declaredCompatibility(manifest, dshVersion) {
  const releases = manifest?.dsh?.compatibility?.dshReleases
  if (releases === null || typeof releases !== 'object' || Array.isArray(releases)) return undefined
  const entries = Object.entries(releases).filter(([, value]) => typeof value === 'string')
  if (entries.length === 0) return undefined
  const listed = entries.map(([version]) => version).join(', ')
  if (typeof dshVersion !== 'string' || dshVersion === '') {
    return finding('compat-unknown-runtime', 'info', '插件声明了已验证版本表', `该包声明已验证：${listed}；当前 DSH 版本未知，无法比对。`, { required: listed, actual: '未知' })
  }
  const exact = entries.find(([version]) => version === dshVersion)
  if (exact !== undefined) {
    if (isCompatibleStatus(exact[1])) return undefined
    return finding('compat-declared-incompatible', 'blocker', '插件声明与当前 DSH 不兼容', `该包在 dsh.compatibility.dshReleases 里把 DSH ${dshVersion} 标为 "${exact[1]}"。`, {
      required: 'compatible',
      actual: `${dshVersion}: ${exact[1]}`,
    })
  }
  const lower = entries
    .filter(([version]) => {
      const order = compareVersions(version, dshVersion)
      return order !== undefined && order <= 0
    })
    .sort((left, right) => compareVersions(right[0], left[0]) ?? 0)[0]
  if (lower !== undefined && !isCompatibleStatus(lower[1])) {
    return finding('compat-nearest-incompatible', 'warn', '最近的可比版本被标为不兼容', `当前 DSH ${dshVersion} 不在已验证列表里，而最近的可比版本 ${lower[0]} 被标为 "${lower[1]}"。`, {
      required: 'compatible',
      actual: `${lower[0]}: ${lower[1]}`,
    })
  }
  return finding('compat-unlisted', 'info', '当前 DSH 不在已验证列表里', `该包声明已验证：${listed}；当前 ${dshVersion} 不在其中，通常只是发布滞后。`, {
    required: listed,
    actual: dshVersion,
  })
}

/**
 * Analyze one resolved target against the environment.
 * @param input - `{ spec, target, environment }`; environment carries
 * `dshVersion`, `nodeVersion`, `profileName`, installed packages and patch rows.
 * @returns the precheck report the UI and the CLI both render.
 */
export function analyze(input) {
  const { spec, target, environment } = input
  const findings = []
  const manifest = target?.manifest
  const installed = environment?.installed ?? []
  const rows = environment?.rows ?? []
  const bundles = environment?.bundles ?? []
  const dshVersion = environment?.dshVersion

  if (manifest === undefined) {
    findings.push(
      finding(
        'precheck-unavailable',
        'warn',
        '无法预检',
        `这个来源在安装前拿不到清单：${target?.error ?? '未知原因'}`,
        { required: '安装前静态预检', actual: target?.error ?? '清单不可用' },
      ),
    )
    return finish(spec, target, environment, findings)
  }

  const name = target.name ?? manifest.name
  const version = target.version ?? manifest.version

  const engine = declaredDshEngine(manifest)
  if (engine === undefined) {
    findings.push(
      finding('engines-dsh-missing', 'info', '未声明 DSH 版本要求', '该包没有声明 dsh.engines.dsh，所以只能用它自己声明的 @deepseek-ai/* 依赖版本反推兼容性。', {
        required: '≥ 某个 DSH 版本',
        actual: '未声明',
      }),
    )
  } else if (typeof engine !== 'string') {
    findings.push(finding('engines-dsh-shape', 'warn', 'DSH 版本要求格式可疑', 'dsh.engines.dsh 不是字符串，无法解析。', { required: 'semver range 字符串', actual: JSON.stringify(engine) }))
  } else if (dshVersion === undefined) {
    findings.push(finding('engines-dsh-unknown-runtime', 'warn', '无法确定当前 DSH 版本', '读不到运行中的 DSH 版本，无法核对该包要求的 ' + engine + '。', { required: engine, actual: '未知' }))
  } else {
    const verdict = satisfiesRange(dshVersion, engine)
    if (verdict === false) {
      findings.push(
        finding('engines-dsh', 'blocker', 'DSH 版本不匹配', `该包要求 DSH ${engine}，当前是 ${dshVersion}。装上后很可能直接无法启动。`, {
          required: engine,
          actual: dshVersion,
        }),
      )
    } else if (verdict === undefined) {
      findings.push(finding('engines-dsh-unparsed', 'warn', '版本区间无法解析', `无法解析该包声明的 DSH 区间 ${engine}。`, { required: engine, actual: dshVersion }))
    }
  }

  const declared = declaredCompatibility(manifest, dshVersion)
  if (declared !== undefined) findings.push(declared)

  const nodeEngine = manifest.engines?.node
  if (typeof nodeEngine === 'string') {
    const nodeVersion = environment?.nodeVersion ?? process.versions.node
    if (satisfiesRange(nodeVersion, nodeEngine) === false) {
      findings.push(finding('engines-node', 'warn', 'Node 版本不匹配', `该包要求 Node ${nodeEngine}，当前是 ${nodeVersion}。`, { required: nodeEngine, actual: nodeVersion }))
    }
  }

  /**
   * Resolve a dependency the target declares: the profile's own tree first,
   * then the DSH installation's shared tree (which is where every
   * `@deepseek-ai/dsh-*` package actually comes from).
   */
  const lookup = (dependency) => {
    const direct = installed.find((item) => item.name === dependency)
    if (direct !== undefined) return { ...direct, from: 'profile' }
    const provided = typeof environment?.provider === 'function' ? environment.provider(dependency) : undefined
    if (provided !== undefined) return { ...provided, from: provided.from ?? 'dsh' }
    return undefined
  }

  const outsideProfile = []
  for (const [peer, range] of Object.entries(manifest.peerDependencies ?? {})) {
    const present = lookup(peer)
    if (present === undefined) {
      findings.push(
        finding('peer-absent', 'info', 'peer 依赖找不到', `该包要求 peer ${peer}@${String(range)}，profile 与 DSH 安装目录里都没有（也可能是可选 peer）。`, {
          required: `${peer}@${String(range)}`,
          actual: '未找到',
        }),
      )
      continue
    }
    if (present.from === 'dsh') outsideProfile.push(peer)
    if (typeof range === 'string' && satisfiesRange(present.version, range) === false) {
      const core = peer.startsWith('@deepseek-ai/')
      findings.push(
        finding('peer-mismatch', 'warn', core ? 'DSH 核心包版本不匹配' : 'peer 依赖版本不匹配', `该包要求 ${peer}@${range}，当前可用的是 ${present.version}（来自 ${present.from}）。`, {
          required: `${peer}@${range}`,
          actual: `${peer}@${present.version}（${present.from}）`,
        }),
      )
    }
  }

  // The profile disables peer auto-install, so the plugin's peers live only in
  // the DSH installation tree. Node can still reach them through the harness
  // module fallback, but a plugin whose patch rows reference those subpaths is
  // rejected by the post-install row validation — say so before installing.
  if (environment?.autoInstallPeers === false && outsideProfile.length > 0) {
    const sample = outsideProfile.slice(0, 5).join('、')
    findings.push(
      finding(
        'peer-outside-profile',
        'warn',
        `${String(outsideProfile.length)} 个 peer 不在 profile 内`,
        `该包的 peer（${sample}${outsideProfile.length > 5 ? ' 等' : ''}）只存在于 DSH 安装树，而这个 profile 的 pnpm 配置是 autoInstallPeers: false，它们不会进 profile 的 node_modules。这类包的补丁行若引用这些包的子路径，装后校验会判「入口引用不可解析」并自动回滚。`,
        { required: 'peer 可在 profile 内解析', actual: `${String(outsideProfile.length)} 个仅在 DSH 安装树中` },
      ),
    )
  }

  for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
    const present = lookup(dep)
    if (present === undefined || typeof range !== 'string') continue
    if (satisfiesRange(present.version, range) === false) {
      findings.push(
        finding('dep-duplicate-version', 'warn', '依赖会并存两份', `该包依赖 ${dep}@${range}，当前可用的是 ${present.version}（来自 ${present.from}）；pnpm 会在 profile 里再装一份。`, {
          required: `${dep}@${range}`,
          actual: `${dep}@${present.version}（${present.from}）`,
        }),
      )
    }
  }

  const previous = installed.find((item) => item.name === name)
  if (previous !== undefined) {
    if (previous.version === version) {
      findings.push(finding('already-installed', 'warn', '已安装相同版本', `${name}@${version} 已在 profile 里，重复安装通常无意义。`, { required: '新版本或不同包', actual: `${name}@${version}` }))
    } else {
      const order = compareVersions(previous.version, version)
      const direction = order === undefined ? '替换' : order > 0 ? '降级' : '升级'
      findings.push(
        finding('version-change', 'warn', `将${direction} ${name}`, `profile 里是 ${previous.version}，本次会装 ${version}。回退目标：${previous.version}。`, {
          required: `当前 ${previous.version}`,
          actual: `目标 ${version}`,
        }),
      )
    }
  }

  const targetRows = target.rows ?? []
  for (const row of targetRows) {
    if (row.id === undefined) continue
    const owner = rows.find((existing) => existing.id === row.id)
    if (owner !== undefined) {
      findings.push(
        finding('row-id-collision', 'blocker', '配置行 id 冲突', `该包要插入的行 id "${row.id}" 已被 ${owner.from ?? 'profile'} 占用；loader 会因重复插入失败。`, {
          required: `未占用的 id ${row.id}`,
          actual: `${owner.from ?? 'profile'}: ${owner.name ?? owner.id}`,
        }),
      )
      continue
    }
    if (row.name !== undefined && rows.some((existing) => existing.name === row.name)) {
      findings.push(
        finding('row-name-collision', 'blocker', '插件名重复挂载', `该包要挂载的 "${row.name}" 已经在配置树里，重复挂载会失败。`, {
          required: `未挂载的 name ${row.name}`,
          actual: rows.find((existing) => existing.name === row.name)?.from ?? 'profile',
        }),
      )
    }
  }

  if (rows.some((row) => row.name === name) && targetRows.length === 0) {
    findings.push(
      finding('row-name-present', 'warn', '该包已被配置树挂载', `${name} 已经出现在补丁行里（${rows.find((row) => row.name === name)?.from ?? 'profile'}）；再次安装可能产生重复行。`, {
        required: '尚未挂载的包',
        actual: name,
      }),
    )
  }

  if (bundles.includes(name)) {
    findings.push(
      finding('bundle-entry', 'warn', '已在 bundles 清单中', `${name} 已在 dsh.profile.bundles 里；官方 CLI 安装后会把声明 dsh.bundle 的依赖再次加入 bundles，可能触发重复挂载。`, {
        required: 'bundles 里不重复',
        actual: name,
      }),
    )
  }

  if (target.kind === 'local' && target.rows !== undefined) {
    for (const row of target.rows) {
      const referenced = row.name
      if (referenced === undefined) continue
      const resolvable = installed.some((item) => item.name === referenced || referenced.startsWith(item.name + '/')) || resolvableFromDsh(referenced, environment)
      if (!resolvable && !referenced.startsWith('dsh-plugin-guard')) {
        findings.push(finding('row-unresolvable', 'warn', '补丁行引用不可解析的包', `行 ${row.id ?? ''} 引用 ${referenced}，profile 和 dsh 安装目录里都找不到它。`, { required: '可解析的包', actual: referenced }))
      }
    }
  }

  if (target.kind === 'npm' && target.rows === undefined) {
    findings.push(
      finding('row-check-skipped', 'info', '行级冲突未能检查', 'npm 发布包在安装前拿不到内部 cordis.patch.yml，只能按包名核对；安装后由插件管理器对账。', {
        required: '行级 id 比对',
        actual: '仅包名比对',
      }),
    )
  }

  return finish(spec, target, environment, findings)
}

/** Whether a bare module name exists in the dsh installation's own tree. */
function resolvableFromDsh(name, environment) {
  const known = environment?.dshPackages
  if (!Array.isArray(known)) return false
  return known.includes(name)
}

/** Assemble the report envelope and derive the verdict. */
function finish(spec, target, environment, findings) {
  const severity = findings.some((item) => item.severity === 'blocker') ? 'blocker' : findings.some((item) => item.severity === 'warn') ? 'warn' : 'ok'
  return {
    spec: String(spec),
    verdict: severity,
    resolved: {
      kind: target?.kind,
      name: target?.name,
      version: target?.version,
      requested: target?.requested,
      latest: target?.latest,
      versions: target?.versions ?? [],
      error: target?.error,
    },
    environment: {
      dshVersion: environment?.dshVersion,
      nodeVersion: environment?.nodeVersion ?? process.versions.node,
      profileName: environment?.profileName,
      installedCount: environment?.installed?.length ?? 0,
      rowCount: environment?.rows?.length ?? 0,
      registry: environment?.registry,
    },
    findings,
    generatedAt: new Date().toISOString(),
  }
}
