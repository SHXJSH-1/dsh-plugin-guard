#!/usr/bin/env node
/**
 * Terminal entry of the guard. It shares the analyzer and the history store
 * with the host half and needs neither a running harness nor a healthy
 * profile, which is the whole point: it is the entry that still works when a
 * broken plugin stops DSH from booting.
 *
 * Usage:
 *   dsh-plugin-guard status [--profile <name>]
 *   dsh-plugin-guard precheck <spec> [--profile <name>]
 *   dsh-plugin-guard history [<plugin>] [--profile <name>]
 *   dsh-plugin-guard rollback <plugin>[@<version>] [--profile <name>] [--dry-run]
 *   dsh-plugin-guard backup [--profile <name>]
 *   dsh-plugin-guard skips [--profile <name>]
 * @module dsh-plugin-guard/cli
 */

import { existsSync, statSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'

import { analyze, registryOf, resolveTarget } from './precheck.js'
import { bootAuditEnvironment, staticBootAudit } from './bootcheck.js'
import { checkConfigs, renderConfigReport } from './configcheck.js'
import { collectEnvironment, dshCliBin, profileExists, readInstalledPlugins, readLocalRows, reconcileProfile, resolveProfileFacts, runDshPlugin, standaloneEnvironment } from './profile.js'
import { appendRollbackLog, backupProfile, cacheDir, deleteBackup, guardHome, listBackups, readHistory, readRestoreLog, readRollbackLog, readSkips, recordSkip, restoreBackup, summarizeHistory } from './store.js'
import { autostartEnabled, autostartFile, disableAutostart, disableWatchdog, enableAutostart, enableWatchdog, ensureWatchdog, runWatchdog, watchdogStatus } from './watchdog.js'

/** Run the install precheck for one spec against this profile. */
async function runPrecheck(spec, facts, env) {
  const target = await resolveTarget(spec, { profileDir: facts.profileDir, registry: registryOf(env), cacheDir: cacheDir(env), env, readLocalRows })
  const environment = profileExists(facts) ? await collectEnvironment(facts, { env }) : await standaloneEnvironment(env)
  return analyze({ spec, target, environment })
}

/** Ask one question on a TTY. */
async function askLine(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await rl.question(prompt)
  } finally {
    rl.close()
  }
}

/** Print one JSON document. */
function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

/** Human-readable byte size for the backup listing. */
function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? String(Math.round(value)) : value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

/** Severity tag for the human-readable precheck output. */
function tag(severity) {
  return severity === 'blocker' ? '× 阻断' : severity === 'warn' ? '! 警告' : '· 信息'
}

/** Render one precheck report as text. */
function renderReport(report) {
  const lines = []
  const resolved = report.resolved ?? {}
  lines.push(`预检对象: ${report.spec}`)
  lines.push(`解析结果: ${resolved.kind ?? '未知'} ${resolved.name ?? ''}${resolved.version === undefined ? '' : `@${resolved.version}`}${resolved.error === undefined ? '' : ` (${resolved.error})`}`)
  lines.push(`当前环境: DSH ${report.environment?.dshVersion ?? '未知'}, Node ${report.environment?.nodeVersion ?? '?'}, profile ${report.environment?.profileName ?? '?'}`)
  lines.push(`结论: ${report.verdict === 'blocker' ? '阻断（装上很可能起不来）' : report.verdict === 'warn' ? '警告（可强行继续）' : '通过'}`)
  for (const finding of report.findings) {
    lines.push(`  ${tag(finding.severity)} [${finding.rule}] ${finding.title}`)
    lines.push(`      ${finding.detail}`)
    if (finding.evidence !== undefined) lines.push(`      要求 ${String(finding.evidence.required)} / 实际 ${String(finding.evidence.actual)}`)
  }
  return lines.join('\n')
}

/** Split `<plugin>[@<version>]`, tolerating scoped names. */
function splitSpec(text) {
  const match = /^(@?[^@\s]+(?:\/[^@\s]+)?)(?:@(.+))?$/.exec(text.trim())
  if (match === null) return { name: text.trim() }
  return { name: match[1], version: match[2] }
}

/** When a package directory was last touched (its manifest, else the dir). */
function packageMtime(dir) {
  try {
    return statSync(join(dir, 'package.json')).mtimeMs
  } catch {
    try {
      return statSync(dir).mtimeMs
    } catch {
      return 0
    }
  }
}

/**
 * The dependency whose package directory was touched most recently, ignoring
 * protected names. Used only as a rescue heuristic, and always reported by name
 * before anything is removed.
 * @param installed - entries from `readInstalledPlugins`.
 * @param protectedNames - names the guard never removes.
 * @returns `{ name, mtime, at }`, or undefined when nothing is datable.
 */
function mostRecentPackage(installed, protectedNames) {
  let best
  for (const entry of installed) {
    if (typeof entry.dir !== 'string' || entry.dir === '') continue
    if (protectedNames.has(entry.name) || entry.name.startsWith('@deepseek-ai/')) continue
    const mtime = packageMtime(entry.dir)
    if (mtime === 0) continue
    if (best === undefined || mtime > best.mtime) best = { name: entry.name, mtime }
  }
  if (best === undefined) return undefined
  return { name: best.name, mtime: best.mtime, at: new Date(best.mtime).toISOString() }
}

/** Parse argv into a command plus options. */
function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      profile: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'no-restore-on-fail': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })
  return { values, positionals }
}

/** Entry point. */
async function main() {
  const { values, positionals } = parse(process.argv.slice(2))
  const command = positionals[0] ?? 'status'
  if (values.help === true) {
    process.stdout.write(
      [
        'dsh-plugin-guard — DSH 插件预检与版本回退（不需要 DSH 能启动）',
        '',
        '  status                          当前 profile、DSH 版本、CLI 可用性、历史与跳过计数',
        '  precheck <spec>                 安装前静态预检（npm 名@版本 / 本地路径 / git）',
        '  install <spec>                  预检 → 快照 → 经官方 CLI 安装 → 启动检测（命令行版守卫）',
        '  configcheck [<文件>...]         校验 profile 补丁层、home 补丁与所有 agent preset 的 config',
        '  bootcheck                       校验每个插件的 client bundle 声明与文件是否落盘',
        '  history [<plugin>]              每个插件的版本历史与"上次成功启动的版本"',
        '  rollback <plugin>[@<version>]   备份 profile 后用官方 CLI 装回指定版本',
        '  restore [<备份id>|latest]       把 profile 的清单与补丁还原到某个备份',
        '  safe-mode                       救援：移除「最近一次安装」或「最近改动过」的插件，识别不出就整体回退到最近备份',
        '  watchdog [on|off|status|run]    崩溃监视：启动失败时弹原生对话框，可当场回退（默认开启）',
        '  watchdog autostart [on|off]     开机自启守护进程（只起守护，不启动 DSH、不改你的启动方式）',
        '  backup                          只备份 profile 的 package.json / lock / patch',
        '  backups [delete <id>|latest]    列出或删除备份',
        '  skips                           查看被强行继续的警告记录',
        '',
        '  --profile <name>  目标 profile（默认从 --profile/DSH_PROFILE/web 推断）',
        '  --json            输出 JSON',
        '  --dry-run         rollback 只打印将要执行的命令',
        '  --no-restore-on-fail  rollback 失败时不自动还原（默认会自动还原）',
        '  --yes             install：结论不是「通过」时不再询问（给脚本用）',
        '',
      ].join('\n'),
    )
    return
  }

  const env = process.env
  const facts = resolveProfileFacts({ env, profileName: values.profile })
  if (facts.error !== undefined) {
    process.stderr.write(`dsh-plugin-guard: ${facts.error}\n`)
    if (['status', 'precheck', 'configcheck', 'bootcheck'].includes(command)) process.stderr.write('dsh-plugin-guard: 继续以「无 profile」模式运行（只报告能从磁盘读到的事实）\n')
    else {
      process.exitCode = 2
      return
    }
  }
  const environment = profileExists(facts) ? await collectEnvironment(facts, { env }) : await standaloneEnvironment(env)
  const installed = profileExists(facts) ? readInstalledPlugins(facts, env) : []

  /**
   * After any rescue: align `node_modules` with the manifest, then say whether
   * the profile can boot again. Restoring manifest files does not touch the
   * installed tree, so skipping the first step can turn a rescue into a loop.
   */
  async function repairAndVerify() {
    const repair = await reconcileProfile({ facts, env })
    process.stdout.write(repair.ok ? '✓ 依赖已对齐（dsh plugin install）\n' : `! 依赖对齐失败：${repair.output}\n`)
    const audit = staticBootAudit({ facts, env })
    const blockers = audit.findings.filter((entry) => entry.severity === 'blocker')
    if (blockers.length === 0) {
      process.stdout.write('启动检测（静态）：通过\n')
      // Honest caveat: the audit sees declarations and files, not module
      // resolution, so a loader-time failure looks clean to it.
      process.stdout.write('  注意：装载期失败（插件入口 import 不到文件等）静态查不出来，请再启动一次 DSH 确认。\n')
    } else {
      process.stdout.write(`启动检测（静态）：仍有 ${String(blockers.length)} 项问题\n`)
      for (const entry of blockers) process.stdout.write(`  × [${entry.rule}] ${entry.title}\n`)
    }
  }

  if (command === 'status') {
    const history = await readHistory(env)
    const skips = await readSkips(env)
    const status = {
      guardHome: guardHome(env),
      profile: { name: facts.profileName, dir: facts.profileDir, exists: profileExists(facts), error: facts.error },
      dsh: { version: environment.dshVersion, cli: dshCliBin(env) ?? null, installRootFound: environment.dshPackages.length > 0 },
      registry: registryOf(env),
      installed: installed.map((item) => ({ name: item.name, version: item.version, spec: item.spec })),
      rows: environment.rows.length,
      history: { boots: (history.boots ?? []).length, plugins: Object.keys(history.plugins ?? {}).length },
      skips: (skips.entries ?? []).length,
      backups: (await listBackups(env)).length,
      rollbacks: (await readRollbackLog(env)).entries.length,
    }
    if (values.json === true) print(status)
    else {
      process.stdout.write(
        [
          `profile      ${status.profile.name ?? '?'} (${status.profile.exists ? '存在' : '缺失'}) ${status.profile.dir}`,
          `DSH          ${status.dsh.version ?? '未知'}${status.dsh.cli === null ? ' / CLI 未找到（无法写入）' : ''}`,
          `registry     ${status.registry}`,
          `已装插件     ${status.installed.length} 个，配置行 ${status.rows} 条`,
          `历史         启动记录 ${status.history.boots} 次，覆盖 ${status.history.plugins} 个插件`,
          `跳过警告     ${status.skips} 条，备份 ${status.backups} 份，回退记录 ${status.rollbacks} 条`,
          `守卫数据目录 ${status.guardHome}`,
          '',
        ].join('\n'),
      )
    }
    return
  }

  if (command === 'precheck' || command === 'install') {
    const spec = positionals[1]
    if (spec === undefined) {
      process.stderr.write(`dsh-plugin-guard: ${command} needs a spec\n`)
      process.exitCode = 2
      return
    }
    const report = await runPrecheck(spec, facts, env)
    if (values.json === true) print(report)
    else process.stdout.write(`${renderReport(report)}\n`)

    if (command === 'precheck') {
      process.exitCode = report.verdict === 'blocker' ? 1 : 0
      return
    }

    // install: the wrapper that gives the command line the same protection the
    // browser gate gives the GUI — precheck, snapshot, official CLI, smoke.
    if (!profileExists(facts)) {
      process.stderr.write(`dsh-plugin-guard: profile ${String(facts.profileName)} has no manifest; refusing to write\n`)
      process.exitCode = 2
      return
    }
    const forced = report.verdict !== 'ok'
    if (forced && values.yes !== true) {
      if (process.stdin.isTTY !== true) {
        process.stderr.write('dsh-plugin-guard: 结论不是「通过」，而当前不是交互终端；确认要装请加 --yes\n')
        process.exitCode = 2
        return
      }
      const answer = await askLine(`结论：${report.verdict === 'blocker' ? '阻断' : '警告'}。仍要安装？[y/N] `)
      if (/^y(es)?$/i.test(answer.trim()) !== true) {
        process.stdout.write('已取消，未做任何改动。\n')
        process.exitCode = 2
        return
      }
    }

    const before = readInstalledPlugins(facts, env)
    // Same reason string as the browser gate uses, so `safe-mode` can later name
    // exactly what was installed last.
    const backup = await backupProfile({ env, facts, reason: `pre-install ${spec}`, kind: 'auto', installed: before })
    if (forced) await recordSkip({ env, facts, spec, report, targetVersion: undefined })
    const result = await runDshPlugin({ facts, env, args: ['add', spec] })
    if (result.ok !== true) {
      const restored = await restoreBackup({ env, facts, id: backup.dir, allowPath: true, reason: `auto restore after failed install ${spec}` })
      process.stdout.write(`× 安装失败（退出码 ${String(result.code)}）\n${result.stdout}${result.stderr}\n`)
      process.stdout.write(restored.ok ? `已自动还原 profile 清单：${restored.files.join(', ')}\n` : `自动还原未成功：${restored.error}\n`)
      process.exitCode = 1
      return
    }
    const audit = staticBootAudit({ facts, env })
    process.stdout.write(`✓ 已安装 ${spec}；备份：${backup.dir}\n`)
    if (audit.ok === true) {
      process.stdout.write('启动检测（静态）：通过（重启 dsh 后生效）\n')
      process.exitCode = 0
      return
    }
    const blockers = audit.findings.filter((finding) => finding.severity === 'blocker')
    process.stdout.write(`× 启动检测（静态）发现问题（${String(blockers.length)} 条阻断）：\n`)
    for (const finding of blockers) process.stdout.write(`   [${finding.rule}] ${finding.title}\n`)
    process.stdout.write(`   建议：dsh-plugin-guard restore ${backup.dir.split('\\').pop()} 回到安装前状态\n`)
    process.exitCode = 1
    return
  }

  if (command === 'configcheck') {
    const report = await checkConfigs({ facts, env, files: positionals.slice(1) })
    if (values.json === true) print(report)
    else process.stdout.write(`${renderConfigReport(report)}\n`)
    // A third-party module import may still be in flight; this process is done.
    process.exit(report.ok ? 0 : 1)
  }

  if (command === 'bootcheck') {
    const audit = profileExists(facts) ? staticBootAudit({ facts, env }) : { ok: true, findings: [], packages: [] }
    const report = { ...audit, environment: bootAuditEnvironment(env), generatedAt: new Date().toISOString() }
    if (values.json === true) print(report)
    else {
      process.stdout.write(`客户端启动检测（静态）: ${report.ok ? '通过' : '发现问题'}\n`)
      process.stdout.write(`  检查了 ${report.packages.length} 个包，其中声明 dsh.client 的 ${report.packages.filter((entry) => entry.client).length} 个、声明 bundle patch 的 ${report.packages.filter((entry) => entry.bundle).length} 个\n`)
      for (const finding of report.findings) {
        process.stdout.write(`  ${finding.severity === 'blocker' ? '×' : finding.severity === 'warn' ? '!' : '·'} [${finding.rule}] ${finding.title}\n      ${finding.detail}\n      要求 ${String(finding.evidence?.required)} / 实际 ${String(finding.evidence?.actual)}\n`)
      }
      if (report.findings.length === 0) process.stdout.write('  没有发现声明或文件缺失问题。\n')
      process.stdout.write('  注意：host 运行期的启动检测（rev/entries/batches 形状）只能在运行中的实例里校验，见设置页「插件守卫」。\n')
    }
    process.exitCode = report.ok ? 0 : 1
    return
  }

  if (command === 'watchdog') {
    const action = positionals[1] ?? 'status'
    if (action === 'autostart') {
      const sub = positionals[2] ?? 'status'
      if (autostartFile(env) === undefined) {
        process.stderr.write('dsh-plugin-guard: APPDATA is not set; cannot locate the Startup folder\n')
        process.exitCode = 2
        return
      }
      if (sub === 'on') {
        const file = await enableAutostart(env, facts)
        await enableWatchdog(env)
        const pid = await ensureWatchdog({ env, facts })
        process.stdout.write(`✓ 已开启开机自启：${String(file)}\n  登录后它只拉起守护进程（不会启动 DSH，也不改你的启动方式）\n`)
        process.stdout.write(`  守护进程现在也起了（${pid === undefined ? '已有实例在跑' : `pid ${String(pid)}`}）\n`)
        process.exitCode = 0
        return
      }
      if (sub === 'off') {
        // Off means off now: drop the logon entry *and* stop the running daemon,
        // otherwise it would keep watching until the next reboot.
        const existed = await disableAutostart(env)
        const paths = await disableWatchdog(env)
        process.stdout.write(existed ? `✓ 已关闭开机自启（已删除 ${String(autostartFile(env))}）\n` : '本来就没开启机自启\n')
        process.stdout.write(`✓ 守护进程也已停止（标记：${paths.stop}）；重启电脑或下次启动 DSH 都不会再拉起\n`)
        process.exitCode = 0
        return
      }
      process.stdout.write(`开机自启: ${autostartEnabled(env) ? '已开启' : '未开启'}\n文件    : ${String(autostartFile(env))}\n`)
      process.exitCode = 0
      return
    }
    if (action === 'on') {
      await enableWatchdog(env)
      const pid = await ensureWatchdog({ env, facts })
      process.stdout.write(`✓ 崩溃监视已开启${pid === undefined ? '（已有实例在跑或刚启动）' : `（pid ${String(pid)}）`}\n监视对象：${facts.profileDir}\\cordis.yml，成功信号：plugin-guard\\history.json\n`)
      process.exitCode = 0
      return
    }
    if (action === 'off') {
      const paths = await disableWatchdog(env)
      process.stdout.write(`✓ 崩溃监视已关闭（标记：${paths.stop}）；下次成功启动不会再拉起\n`)
      process.exitCode = 0
      return
    }
    if (action === 'run') {
      await runWatchdog({ env, facts })
      process.exitCode = 0
      return
    }
    const status = await watchdogStatus(env)
    if (values.json === true) print(status)
    else {
      process.stdout.write(`崩溃监视: ${status.enabled ? '已开启' : '已关闭'}\n`)
      process.stdout.write(`守护进程: ${status.running ? `运行中 (pid ${String(status.pid)})` : '未运行'}\n`)
      process.stdout.write(`pid 文件 : ${status.paths.pid}\n日志     : ${status.paths.log}\n`)
      if (status.log !== '') process.stdout.write(`最近日志:\n${status.log.split('\n').map((line) => `  ${line}`).join('\n')}\n`)
    }
    return
  }

  if (command === 'safe-mode') {
    if (!profileExists(facts)) {
      process.stderr.write(`dsh-plugin-guard: profile ${String(facts.profileName)} has no manifest; refusing to write\n`)
      process.exitCode = 2
      return
    }
    const installedNow = readInstalledPlugins(facts, env)
    // The most recent automatic snapshot records exactly what was about to be
    // installed, which is the best available answer to "who broke it".
    const snapshots = await listBackups(env)
    const lastInstall = snapshots.find((entry) => entry.kind === 'auto' && String(entry.reason ?? '').startsWith('pre-install '))
    const spec = lastInstall === undefined ? undefined : String(lastInstall.reason).slice('pre-install '.length).trim()
    const name = spec === undefined ? undefined : splitSpec(spec).name
    const protectedNames = new Set(['dsh-plugin-guard', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    // Two independent suspects, both chosen by evidence: what the guard last
    // installed, and which package directory changed most recently. The newer of
    // the two wins, because a raw `dsh plugin add` after a guard install leaves
    // no snapshot at all.
    const candidates = []
    if (name !== undefined && name !== '' && !protectedNames.has(name)) {
      const entry = installedNow.find((item) => item.name === name)
      if (typeof entry?.dir === 'string') candidates.push({ name, mtime: packageMtime(entry.dir), from: `最近一次安装（${String(spec)}）` })
    }
    const recent = mostRecentPackage(installedNow, protectedNames)
    if (recent !== undefined && !candidates.some((item) => item.name === recent.name)) candidates.push({ name: recent.name, mtime: recent.mtime, from: '最近改动' })
    candidates.sort((left, right) => right.mtime - left.mtime)
    const suspect = candidates[0]
    if (values.json === true) print({ suspect: suspect?.name, from: suspect?.from, spec, backups: snapshots.slice(0, 3).map((entry) => entry.id), candidates })
    if (suspect !== undefined) {
      process.stdout.write(`认出的可疑插件是：${suspect.name}（依据：${suspect.from}，目录时间 ${new Date(suspect.mtime).toISOString()}）\n`)
      const backup = await backupProfile({ env, facts, reason: `safe-mode remove ${suspect.name}`, kind: 'auto', installed: installedNow })
      const result = await runDshPlugin({ facts, env, args: ['remove', suspect.name] })
      process.stdout.write(result.ok ? `✓ 已移除 ${suspect.name}（备份：${backup.dir}）\n` : `× 移除失败：${result.stdout}${result.stderr}\n`)
      process.exitCode = result.ok ? 0 : 1
      if (result.ok) await repairAndVerify()
      return
    }
    process.stdout.write('认不出可疑插件，改用整体回退到最近一次备份。\n')
    const restored = await restoreBackup({ env, facts, id: 'latest', reason: 'safe-mode fallback' })
    process.stdout.write(restored.ok ? `✓ 已还原 ${restored.files.join(', ')}（来自 ${restored.id}）\n` : `× 还原失败：${restored.error}\n`)
    process.exitCode = restored.ok ? 0 : 1
    if (restored.ok) await repairAndVerify()
    return
  }

  if (command === 'history') {
    const rows = summarizeHistory({ history: await readHistory(env), installed, profile: facts.profileName })
    const only = positionals[1]
    const filtered = only === undefined ? rows : rows.filter((row) => row.name === only)
    if (values.json === true) print(filtered)
    else {
      for (const row of filtered) {
        process.stdout.write(`${row.name}\n  当前 ${row.installedVersion ?? '未装'} / 上次成功启动 ${row.lastGood ?? '未知'}\n`)
        for (const entry of row.versions) process.stdout.write(`    ${entry.version}  成功启动 ${entry.bootCount ?? 0} 次  最近 ${entry.lastSeenAt ?? '?'}\n`)
      }
      if (filtered.length === 0) process.stdout.write('（没有历史记录；守卫会在每次成功启动后记录一次）\n')
    }
    return
  }

  if (command === 'rollback') {
    const raw = positionals[1]
    if (raw === undefined) {
      process.stderr.write('dsh-plugin-guard: rollback needs <plugin>[@<version>]\n')
      process.exitCode = 2
      return
    }
    if (!profileExists(facts)) {
      process.stderr.write(`dsh-plugin-guard: profile ${String(facts.profileName)} has no manifest; refusing to write\n`)
      process.exitCode = 2
      return
    }
    const parsed = splitSpec(raw)
    const before = installed.find((item) => item.name === parsed.name)
    const history = await readHistory(env)
    const timeline = summarizeHistory({ history, installed, profile: facts.profileName }).find((row) => row.name === parsed.name)
    const version = parsed.version ?? timeline?.lastGood
    if (version === undefined) {
      process.stderr.write(`dsh-plugin-guard: no recorded version for ${parsed.name}; pass an explicit @version\n`)
      process.exitCode = 2
      return
    }
    const spec = `${parsed.name}@${version}`
    if (values['dry-run'] === true) {
      print({ dryRun: true, spec, from: before?.version, cli: dshCliBin(env) ?? null })
      return
    }
    const backup = await backupProfile({ env, facts, reason: `cli rollback ${spec}`, installed })
    const result = await runDshPlugin({ facts, env, args: ['add', spec] })
    // Never strand the profile in a half-written state: restore the captured
    // files when the install failed, unless the operator opted out.
    const restored = result.ok || values['no-restore-on-fail'] === true ? undefined : await restoreBackup({ env, facts, id: backup.dir, allowPath: true, reason: `auto restore after failed rollback ${spec}` })
    await appendRollbackLog({ env, facts, name: parsed.name, from: before?.version, to: version, result, backup: backup.dir })
    if (values.json === true) print({ spec, ok: result.ok, backup: backup.dir, restored, result })
    else {
      process.stdout.write(`${result.ok ? '✓' : '×'} ${spec}（原 ${before?.version ?? '未装'}）\n备份: ${backup.dir}\n${result.stdout}${result.stderr}\n`)
      if (restored !== undefined) {
        process.stdout.write(
          restored.ok
            ? `× 安装失败，已自动还原: ${restored.files.join(', ')}（来自 ${restored.id}）\n  node_modules 可能仍是半更新状态，建议再跑一次 dsh plugin --profile ${String(facts.profileName)} add 或 pnpm install\n`
            : `× 安装失败，且自动还原未成功: ${restored.error}\n  备份在 ${backup.dir}，可手工复制回去\n`,
        )
      }
    }
    process.exitCode = result.ok ? 0 : 1
    return
  }

  if (command === 'restore') {
    if (!profileExists(facts)) {
      process.stderr.write(`dsh-plugin-guard: profile ${String(facts.profileName)} has no manifest; refusing to write\n`)
      process.exitCode = 2
      return
    }
    const restored = await restoreBackup({ env, facts, id: positionals[1] ?? 'latest', allowPath: true, reason: 'cli restore' })
    if (values.json === true) print(restored)
    else if (restored.ok) process.stdout.write(`✓ 已从备份 ${restored.id} 还原: ${restored.files.join(', ')}\n源: ${restored.dir}\n`)
    else process.stderr.write(`× 还原失败: ${restored.error}\n`)
    process.exitCode = restored.ok ? 0 : 1
    // Restoring the manifest does not touch node_modules; without this the next
    // start can still fail (or the rescue loops).
    if (restored.ok && values.json !== true) await repairAndVerify()
    return
  }

  if (command === 'backups') {
    const action = positionals[1]
    if (action === 'delete' || action === 'rm') {
      const wanted = positionals[2] ?? 'latest'
      const id = wanted === 'latest' ? (await listBackups(env))[0]?.id : wanted
      if (id === undefined) {
        process.stderr.write('dsh-plugin-guard: 没有可删除的备份\n')
        process.exitCode = 2
        return
      }
      const removed = await deleteBackup({ env, id })
      if (values.json === true) print(removed)
      else if (removed.ok) process.stdout.write(`✓ 已删除备份 ${removed.id}（${removed.reason ?? ''} ${removed.at ?? ''}）\n`)
      else process.stderr.write(`× 删除失败: ${removed.error}\n`)
      process.exitCode = removed.ok ? 0 : 1
      return
    }
    const backups = await listBackups(env)
    if (values.json === true) print(backups)
    else {
      if (backups.length === 0) process.stdout.write('（没有备份）\n')
      for (const entry of backups) {
        process.stdout.write(`${entry.id}  ${entry.kind ?? 'manual'}  ${formatBytes(entry.bytes)}  ${String(entry.at ?? '')}  ${String(entry.reason ?? '')}  ${(entry.files ?? []).length} 个文件\n`)
      }
      if (backups.length > 0) {
        const total = backups.reduce((sum, entry) => sum + (typeof entry.bytes === 'number' ? entry.bytes : 0), 0)
        process.stdout.write(`\n共 ${String(backups.length)} 份，占用 ${formatBytes(total)}\n删除：dsh-plugin-guard backups delete <id|latest>\n`)
      }
    }
    return
  }

  if (command === 'backup') {
    const backup = await backupProfile({ env, facts, reason: 'cli manual', installed })
    if (values.json === true) print(backup)
    else process.stdout.write(`备份到 ${backup.dir}\n包含: ${backup.files.join(', ') || '(没有可备份的文件)'}\n`)
    return
  }

  if (command === 'skips') {
    const skips = await readSkips(env)
    if (values.json === true) print(skips)
    else {
      for (const entry of skips.entries ?? []) {
        process.stdout.write(`${entry.at}  ${entry.spec}  (${entry.verdict})\n`)
        for (const finding of entry.findings ?? []) process.stdout.write(`    [${finding.rule}] ${finding.title} — ${finding.detail}\n`)
      }
      if ((skips.entries ?? []).length === 0) process.stdout.write('（没有跳过记录）\n')
    }
    return
  }

  process.stderr.write(`dsh-plugin-guard: unknown command ${JSON.stringify(command)}; try --help\n`)
  process.exitCode = 2
}

main().catch((error) => {
  process.stderr.write(`dsh-plugin-guard: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
