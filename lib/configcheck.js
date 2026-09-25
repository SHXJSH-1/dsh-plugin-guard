/**
 * Configuration preflight: read the layers a mounted tree is built from — the
 * profile patch, the home patch, and every agent preset — and validate each
 * row's `config` against the row plugin's own schemastery schema. This is the
 * check that turns "preset failed to mount: invalid config: $.prefix missing
 * required value" from a dead session into a line you can read beforehand.
 *
 * It parses with DSH's own `!!js` YAML dialect, resolved from the DSH
 * installation, and runs in a short-lived process (see the CLI) because loading
 * third-party plugin modules has side effects.
 * @module dsh-plugin-guard/configcheck
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { dshInstallRoot, readJson, resolvePackageDir } from './profile.js'

/** Directory name that reads as a backup rather than a live preset. */
const BACKUPISH = /(^|[._-])(bak|backup|old|copy|orig)([._-]|$)|副本|备份/i

/** Per-import ceiling: a plugin module that hangs must not hang the check. */
const IMPORT_TIMEOUT_MS = 5000

let dialectCache

/**
 * Resolve the YAML dialect and the schema library from the DSH installation.
 * @param env - environment seam.
 * @returns `{ yaml, schema, z }` or `{ error }` when the install tree is unusable.
 */
export function loadDialect(env = process.env) {
  if (dialectCache !== undefined) return dialectCache
  const root = dshInstallRoot(env)
  if (root === undefined) {
    dialectCache = { error: 'DSH installation not found; cannot parse the cordis YAML dialect' }
    return dialectCache
  }
  try {
    const require = createRequire(join(root, 'lib', 'bin.js'))
    const yaml = require('js-yaml')
    const z = require('@deepseek-ai/schemastery')
    // Mirror `dsh-app-boot`'s expression node: `!!js` scalars round-trip as data
    // instead of evaluating here, because nothing in a preflight may run them.
    const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
      kind: 'scalar',
      resolve: () => true,
      construct: (data) => ({ __jsExpr: String(data) }),
    })
    dialectCache = { yaml, z, schema: yaml.DEFAULT_SCHEMA.extend([JsExpr]), root }
  } catch (error) {
    dialectCache = { error: `cannot load js-yaml/schemastery from ${root}: ${error instanceof Error ? error.message : String(error)}` }
  }
  return dialectCache
}

/** Flatten a cordis entry document into the rows the loader would mount. */
export function flattenRows(document) {
  const out = []
  const walk = (list) => {
    for (const entry of list ?? []) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      out.push(entry)
      if (Array.isArray(entry.insert)) walk(entry.insert)
      if (Array.isArray(entry.group)) walk(entry.group)
    }
  }
  walk(Array.isArray(document) ? document : [document])
  return out
}

/** Whether a config subtree contains a `!!js` expression node. */
function hasExpression(value) {
  if (value === null || typeof value !== 'object') return false
  if (typeof value.__jsExpr === 'string') return true
  return Object.values(value).some((item) => hasExpression(item))
}

/** Resolve the module file one row names, relative specs included. */
function moduleFileFor(spec, fileDir, facts, env) {
  if (spec.startsWith('.') || isAbsolute(spec)) {
    const target = isAbsolute(spec) ? spec : resolve(fileDir, spec)
    return existsSync(target) ? target : undefined
  }
  const dir = resolvePackageDir(spec, facts?.profileDir, env)
  if (dir === undefined) return undefined
  const manifest = readJson(join(dir, 'package.json'))
  if (manifest === undefined) return undefined
  if (typeof manifest.main === 'string') return join(dir, manifest.main)
  const field = manifest.exports
  const entry = typeof field === 'string' ? field : typeof field?.['.'] === 'string' ? field['.'] : typeof field?.['.']?.default === 'string' ? field['.'].default : undefined
  return entry === undefined ? undefined : join(dir, entry)
}

/** Import one module with a ceiling, returning its Config schema if exported. */
async function schemaFor(file, cache) {
  if (cache.has(file)) return cache.get(file)
  const result = await Promise.race([
    (async () => {
      try {
        const mod = await import(pathToFileURL(file).href)
        const schema = mod.Config ?? mod.default?.Config ?? mod.default?.default?.Config
        return schema === undefined ? { status: 'no-schema' } : { status: 'ok', schema }
      } catch (error) {
        return { status: 'unimportable', message: error instanceof Error ? error.message : String(error) }
      }
    })(),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout({ status: 'timeout' }), IMPORT_TIMEOUT_MS)),
  ])
  cache.set(file, result)
  return result
}

/** Read and validate one composition file. */
async function checkFile(input) {
  const { dialect, facts, env } = input
  const record = {
    path: input.path,
    kind: input.kind,
    parsed: false,
    parseError: undefined,
    rows: 0,
    rowsWithConfig: 0,
    checked: 0,
    invalid: [],
    unchecked: [],
    expressions: 0,
  }
  let document
  try {
    document = dialect.yaml.load(readFileSync(input.path, 'utf8'), { schema: dialect.schema })
  } catch (error) {
    record.parseError = error instanceof Error ? error.message.split('\n')[0] : String(error)
    return record
  }
  record.parsed = true
  const rows = flattenRows(document)
  record.rows = rows.length
  const fileDir = resolve(input.path, '..')
  for (const row of rows) {
    if (typeof row.name !== 'string' || row.config === undefined) continue
    record.rowsWithConfig += 1
    if (hasExpression(row.config)) record.expressions += 1
    const file = moduleFileFor(row.name, fileDir, facts, env)
    if (file === undefined) {
      record.unchecked.push({ id: row.id, name: row.name, reason: '模块解析不到（可能是 cordis 内置行或未安装的包）' })
      continue
    }
    const found = await schemaFor(file, input.cache)
    if (found.status !== 'ok') {
      record.unchecked.push({ id: row.id, name: row.name, reason: found.status === 'no-schema' ? '该插件未导出 Config' : found.status === 'timeout' ? '导入超时' : `导入失败: ${found.message}` })
      continue
    }
    record.checked += 1
    try {
      found.schema(row.config)
    } catch (error) {
      const message = error instanceof Error ? error.message.split('\n').map((line) => line.trim()).filter((line) => line !== '' && line !== '-') : []
      record.invalid.push({ id: row.id, name: row.name, message: message.slice(1, 5).join(' | ') || message[0] || 'invalid', expression: hasExpression(row.config) })
    }
  }
  return record
}

/**
 * Run the whole preflight.
 * @param options - facts, env, extra files, and whether to scan presets.
 * @returns the report the CLI and the settings tab both render.
 */
export async function checkConfigs(options = {}) {
  const env = options.env ?? process.env
  const facts = options.facts
  const dialect = loadDialect(env)
  const findings = []
  const files = []
  const presets = []

  if (dialect.error !== undefined) {
    findings.push({ severity: 'warn', rule: 'dialect-unavailable', title: '无法使用 DSH 的 YAML 方言', detail: dialect.error, evidence: { required: 'js-yaml + schemastery', actual: '不可用' } })
    return { ok: false, dialect: { available: false, reason: dialect.error }, files, presets, findings, generatedAt: new Date().toISOString() }
  }

  const cache = new Map()
  const targets = []
  if (facts?.patchPath !== undefined) targets.push({ path: facts.patchPath, kind: 'profile-patch' })
  if (facts?.dshHome !== undefined) targets.push({ path: join(facts.dshHome, 'cordis.patch.yml'), kind: 'home-patch' })
  if (options.scanPresets !== false && facts?.dshHome !== undefined) {
    const root = join(facts.dshHome, '.agent-presets')
    let entries = []
    try {
      entries = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {}
    const byName = new Map()
    for (const dir of entries) {
      const dirPath = join(root, dir)
      // preset.yml is YAML, not JSON: the display name lives there.
      let meta
      try {
        meta = dialect.yaml.load(readFileSync(join(dirPath, 'preset.yml'), 'utf8'), { schema: dialect.schema })
      } catch {}
      const composition = join(dirPath, 'agent.cordis.yml')
      const record = {
        dir,
        id: dir,
        name: typeof meta?.name === 'string' ? meta.name : undefined,
        order: meta?.order,
        composition,
        hasComposition: existsSync(composition),
        backupish: BACKUPISH.test(dir),
      }
      if (record.name !== undefined) byName.set(record.name, [...(byName.get(record.name) ?? []), dir])
      presets.push(record)
      if (record.hasComposition) targets.push({ path: composition, kind: 'preset', dir })
      else findings.push({ severity: 'warn', rule: 'preset-composition-missing', title: `preset ${dir} 缺少 agent.cordis.yml`, detail: '这个 preset 无法挂载。', evidence: { required: composition, actual: '文件不存在' } })
      if (record.backupish) {
        findings.push({
          severity: 'warn',
          rule: 'preset-backup-dir',
          title: `preset 目录 ${dir} 看起来是备份`,
          detail: '备份目录留在 .agent-presets 里会作为第二个 preset 出现，并且常常带着旧的、已失效的配置。建议移到 .agent-presets 之外。',
          evidence: { required: '只放当前生效的 preset', actual: dir },
        })
      }
    }
    for (const [name, dirs] of byName) {
      if (dirs.length > 1) {
        findings.push({
          severity: 'warn',
          rule: 'preset-name-collision',
          title: `多个 preset 使用同一个显示名「${name}」`,
          detail: `预设列表里会出现同名条目，选错就挂载到另一份配置：${dirs.join(' , ')}`,
          evidence: { required: '唯一显示名', actual: dirs.join(', ') },
        })
      }
    }
  }
  for (const extra of options.files ?? []) targets.push({ path: extra, kind: 'extra' })

  for (const target of targets) {
    if (!existsSync(target.path)) continue
    const record = await checkFile({ ...target, dialect, facts, env, cache })
    files.push(record)
    if (record.parseError !== undefined) {
      findings.push({ severity: 'blocker', rule: 'config-parse', title: `${target.kind} 解析失败`, detail: record.parseError, evidence: { required: '合法 YAML', actual: target.path } })
    }
    for (const invalid of record.invalid) {
      findings.push({
        severity: 'blocker',
        rule: 'config-invalid',
        title: `${target.kind} 行 ${invalid.id ?? invalid.name} 配置非法`,
        detail: `${invalid.name}: ${invalid.message}${invalid.expression ? '（该行配置含 !!js 表达式，运行时可能还会算出别的值）' : ''}`,
        evidence: { required: '通过插件自己的 Config schema', actual: target.path },
      })
    }
  }

  const ok = !findings.some((entry) => entry.severity === 'blocker')
  return {
    ok,
    dialect: { available: true, root: dialect.root },
    files,
    presets,
    findings,
    checked: files.reduce((sum, file) => sum + file.checked, 0),
    invalid: files.reduce((sum, file) => sum + file.invalid.length, 0),
    unchecked: files.reduce((sum, file) => sum + file.unchecked.length, 0),
    generatedAt: new Date().toISOString(),
  }
}

/** Human-readable rendering shared by the CLI and the tab's copy button. */
export function renderConfigReport(report) {
  const lines = []
  lines.push(`配置预检: ${report.ok ? '通过' : '发现问题'}  (校验 ${report.checked ?? 0} 条带 config 的行，非法 ${report.invalid ?? 0} 条，未校验 ${report.unchecked ?? 0} 条)`)
  if (report.dialect?.available === false) lines.push(`  ! 方言不可用: ${report.dialect.reason}`)
  for (const finding of report.findings ?? []) {
    lines.push(`  ${finding.severity === 'blocker' ? '×' : finding.severity === 'warn' ? '!' : '·'} [${finding.rule}] ${finding.title}`)
    lines.push(`      ${finding.detail}`)
  }
  for (const file of report.files ?? []) {
    lines.push(`  ${file.kind.padEnd(13)} ${file.path}`)
    lines.push(`      行 ${file.rows} / 带 config ${file.rowsWithConfig} / 已校验 ${file.checked} / 非法 ${file.invalid.length} / 未校验 ${file.unchecked.length}${file.parseError === undefined ? '' : ` / 解析失败: ${file.parseError}`}`)
    for (const unchecked of file.unchecked.slice(0, 6)) lines.push(`      · 未校验 ${unchecked.name}: ${unchecked.reason}`)
  }
  if ((report.presets ?? []).length > 0) {
    lines.push('  presets:')
    for (const preset of report.presets) lines.push(`      ${preset.id}  显示名=${preset.name ?? '?'}  order=${preset.order ?? '?'}${preset.backupish ? '  [疑似备份]' : ''}`)
  }
  return lines.join('\n')
}
