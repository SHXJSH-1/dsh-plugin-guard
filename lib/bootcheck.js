/**
 * Client boot-graph audit. Two questions, both answerable before the browser
 * ever asks for a bundle: is every client declaration resolvable, and is the
 * graph the host would serve well formed? The second one is the exact check the
 * browser performs on `window.__DSH_BOOT__`, moved to where a failure can still
 * be reported instead of turning the whole Web GUI into a banner.
 * @module dsh-plugin-guard/bootcheck
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { dshInstallRoot, readAllPatchRows, readInstalledPlugins, readJson, readProfileManifest, resolvePackageDir } from './profile.js'

/** The only subpath the client module system accepts as a plugin bundle. */
const CLIENT_SUBPATH = './client'

/** One severity-tagged boot finding. */
function finding(severity, rule, title, detail, evidence) {
  return { severity, rule, title, detail, evidence }
}

/**
 * Mirror the host's own `exports["./client"]` rule: a string, or an object with
 * a string `default`.
 * @param manifest - the package manifest.
 * @returns the relative bundle path, an empty string when the package declares
 * no `./client`, or undefined when the field is malformed.
 */
export function clientExportOf(manifest) {
  const field = manifest?.exports
  if (field === undefined || field === null) return ''
  if (typeof field === 'string') return field
  if (typeof field !== 'object') return undefined
  const client = field[CLIENT_SUBPATH]
  if (client === undefined) return ''
  if (typeof client === 'string') return client
  if (client !== null && typeof client === 'object' && typeof client.default === 'string') return client.default
  return undefined
}

/** Validate one `dsh.client` declaration's shape, mirroring the host validators. */
function auditClientDeclaration(name, manifest, findings, severity = 'blocker') {
  const declaration = manifest.dsh.client
  if (typeof declaration !== 'object' || declaration === null) {
    findings.push(finding(severity, 'client-declaration-shape', `${name} 的 dsh.client 不是对象`, '浏览器启动检测无法解析这个声明。', { required: 'object', actual: typeof declaration }))
    return false
  }
  if (typeof declaration.platform !== 'string') {
    findings.push(finding(severity, 'client-platform', `${name} 缺少 dsh.client.platform`, 'client-modules 要求 platform 是字符串，否则启动检测构建时直接抛错。', { required: 'string', actual: typeof declaration.platform }))
  }
  for (const field of ['inject', 'external']) {
    const value = declaration[field]
    if (value === undefined) continue
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      findings.push(
        finding(severity, `client-${field}`, `${name} 的 dsh.client.${field} 不是字符串数组`, 'client-modules 会拒绝这个声明（报错带包名）。', { required: 'string[]', actual: JSON.stringify(value).slice(0, 80) }),
      )
    }
  }
  return true
}

/**
 * Audit every installed package that contributes client or bundle behaviour.
 * @param input - profile facts and environment.
 * @returns `{ ok, findings, packages }`; findings carry blocker/warn/info.
 */
export function staticBootAudit(input) {
  const env = input.env ?? process.env
  const facts = input.facts
  const findings = []
  const packages = []

  const installed = readInstalledPlugins(facts, env)
  const rows = readAllPatchRows(facts, env)
  const rowNames = rows.map((row) => row.name).filter((name) => typeof name === 'string')
  const names = [...new Set([...installed.map((entry) => entry.name), ...rowNames])]
  const { bundles } = readProfileManifest(facts)
  // A package that is installed but never mounted cannot break the boot graph:
  // only a reachable row serves a bundle to the browser. Findings for inert
  // packages stay warnings so the check does not cry wolf.
  const isMounted = (name) =>
    bundles.includes(name) || rows.some((row) => typeof row.name === 'string' && (row.name === name || row.name.startsWith(`${name}/`)))
  const suffix = (mounted) => (mounted ? '' : '（已安装但未挂载：没有生效的补丁行，当前不影响启动检测）')

  for (const name of names) {
    const dir = resolveRowPackage(name, facts, env)
    if (dir === undefined) continue
    const manifest = readJson(join(dir, 'package.json'))
    if (manifest === undefined) continue
    const mounted = isMounted(manifest.name ?? name)
    const severity = mounted ? 'blocker' : 'warn'
    const record = { name: manifest.name ?? name, version: manifest.version, dir, client: false, bundle: false, mounted }
    if (manifest.dsh?.client !== undefined) {
      record.client = true
      if (auditClientDeclaration(record.name, manifest, findings, severity)) {
        const relative = clientExportOf(manifest)
        if (relative === undefined) {
          findings.push(
            finding(severity, 'client-export-shape', `${record.name} 的 exports["./client"] 形状不对`, `必须是字符串，或带字符串 default 的对象；否则 host 在构建启动检测时抛错。${suffix(mounted)}`, {
              required: 'string | { default: string }',
              actual: JSON.stringify(manifest.exports?.[CLIENT_SUBPATH] ?? null).slice(0, 80),
            }),
          )
        } else if (relative === '') {
          findings.push(
            finding(severity, 'client-export-missing', `${record.name} 声明了 dsh.client 却没有 ./client 导出`, `浏览器会报 "bundle script … failed to load"。${suffix(mounted)}`, {
              required: 'exports["./client"]',
              actual: '缺失',
            }),
          )
        } else if (!existsSync(join(dir, relative))) {
          findings.push(
            finding(severity, 'client-bundle-missing', `${record.name} 的客户端 bundle 文件不存在`, `页面会加载到 404，插件整批失败。${suffix(mounted)}`, {
              required: join(dir, relative),
              actual: '文件不存在',
            }),
          )
        }
      }
    }
    const patch = manifest.dsh?.bundle?.patch
    if (typeof patch === 'string') {
      record.bundle = true
      if (!existsSync(join(dir, patch))) {
        findings.push(
          finding(mounted ? 'blocker' : 'warn', 'bundle-patch-missing', `${record.name} 的 cordis.patch.yml 不存在`, `这一行挂载不上，组合树会缺插件。${suffix(mounted)}`, {
            required: join(dir, patch),
            actual: '文件不存在',
          }),
        )
      }
    }
    packages.push(record)
  }

  // A hard-linked install that no longer resolves is worth naming too.
  for (const row of readAllPatchRows(facts, env)) {
    if (typeof row.name !== 'string' || row.name.startsWith('cordis:') || row.name.startsWith('.')) continue
    if (resolveRowPackage(row.name, facts, env) === undefined) {
      findings.push(
        // A row naming a package that resolves nowhere cannot mount: the loader
        // fails the whole start with "Cannot find package …". That is a
        // guaranteed boot failure, not a warning.
        finding('blocker', 'row-package-missing', `补丁行 ${row.id ?? '?'} 引用的包解析不到`, `${row.name} 在 profile node_modules 与 DSH 安装树里都找不到；启动时 loader 会直接失败。`, { required: row.name, actual: '未安装' }),
      )
    }
  }

  // A `dsh.profile.bundles` entry that resolves nowhere aborts the start inside
  // `loadProfile`, before DSH writes anything at all (measured: a failing start
  // of this shape leaves zero files behind), so no other signal can see it.
  for (const name of bundles) {
    if (typeof name !== 'string' || name.startsWith('cordis:') || name.startsWith('.')) continue
    if (resolveRowPackage(name, facts, env) !== undefined) continue
    findings.push(
      finding('blocker', 'bundle-package-missing', `profile bundles 里的 ${name} 解析不到`, `启动时 DSH 在 loadProfile 阶段就抛出 cannot resolve profile bundle "${name}"，此时它还没写任何文件。补回依赖：dsh plugin --profile <名字> install`, {
        required: name,
        actual: '未安装',
      }),
    )
  }

  const ok = !findings.some((entry) => entry.severity === 'blocker')
  return { ok, findings, packages }
}

/** Resolve a row name, tolerating `<package>/<subpath>` row names. */
export function resolveRowPackage(name, facts, env = process.env) {
  const segments = name.split('/')
  const floor = name.startsWith('@') ? 2 : 1
  for (let end = segments.length; end >= floor; end -= 1) {
    const dir = resolvePackageDir(segments.slice(0, end).join('/'), facts?.profileDir, env)
    if (dir !== undefined) return dir
  }
  return undefined
}

/**
 * Validate the graph the host serves as `window.__DSH_BOOT__`. This is the
 * browser's own parse, run early and with names attached.
 * @param graph - the value of `graph()`.
 * @param clientPathOf - resolves an entry id to its bundle path, if known.
 * @returns `{ ok, findings, counts }`.
 */
export function validateGraph(graph, clientPathOf) {
  const findings = []
  if (typeof graph !== 'object' || graph === null) {
    findings.push(finding('blocker', 'boot-graph-missing', '启动检测不存在', 'host 还没有组合出给浏览器的插件清单。', { required: 'object', actual: typeof graph }))
    return { ok: false, findings, counts: { entries: 0, batches: 0 } }
  }
  if (typeof graph.rev !== 'string') findings.push(finding('blocker', 'boot-rev', '启动检测 rev 不是字符串', '浏览器要求 rev 是字符串。', { required: 'string', actual: typeof graph.rev }))
  if (!Array.isArray(graph.entries)) findings.push(finding('blocker', 'boot-entries', '启动检测 entries 不是数组', '浏览器要求 entries 是数组。', { required: 'array', actual: typeof graph.entries }))
  if (!Array.isArray(graph.batches)) {
    // The exact failure this check exists for.
    findings.push(
      finding('blocker', 'boot-batches', '启动检测 batches 不是数组', '这正是 Web UI 上 "client-modules: boot manifest batches must be an array" 的成因；页面会停在 Failed to load plugins。', {
        required: 'array',
        actual: typeof graph.batches,
      }),
    )
  }
  const entries = Array.isArray(graph.entries) ? graph.entries : []
  const batches = Array.isArray(graph.batches) ? graph.batches : []
  for (const entry of entries) {
    const id = typeof entry?.id === 'string' ? entry.id : JSON.stringify(entry)?.slice(0, 60)
    if (typeof entry?.id !== 'string' || typeof entry?.url !== 'string') {
      findings.push(finding('blocker', 'boot-entry-shape', `启动检测条目 ${String(id)} 形状不对`, '每条必须带字符串 id 与 url。', { required: '{ id: string, url: string }', actual: JSON.stringify(entry)?.slice(0, 80) }))
      continue
    }
    if (typeof clientPathOf === 'function' && clientPathOf(entry.id) === undefined) {
      findings.push(
        finding('blocker', 'boot-entry-unresolvable', `启动检测条目 ${entry.id} 解析不出客户端 bundle`, '行声明了 URL，但 host 找不到对应的 bundle 路径——页面会报 bundle script failed to load。', {
          required: 'clientPath(id) 可解析',
          actual: 'undefined',
        }),
      )
    }
  }
  for (const batch of batches) {
    if (typeof batch?.url !== 'string' || typeof batch?.phase !== 'string') {
      findings.push(finding('blocker', 'boot-batch-shape', '启动检测批次形状不对', '每个批次必须带字符串 url 与 phase。', { required: '{ url: string, phase: string }', actual: JSON.stringify(batch)?.slice(0, 80) }))
      break
    }
  }
  const ok = !findings.some((entry) => entry.severity === 'blocker')
  return { ok, findings, counts: { entries: entries.length, batches: batches.length } }
}

/** Whether a DSH installation tree was found at all. */
export function bootAuditEnvironment(env = process.env) {
  return { dshRoot: dshInstallRoot(env), node: process.version }
}
