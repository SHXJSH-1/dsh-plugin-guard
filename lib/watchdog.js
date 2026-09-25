/**
 * Out-of-process watchdog: the piece that can still speak when DSH itself
 * cannot start.
 *
 * A plugin cannot run inside the start that aborts — the loader dies before or
 * while mounting rows, so anything in-process is gone. This daemon is started
 * by a *successful* boot and then lives outside the harness:
 *
 *   - it watches `profiles/<p>/cordis.yml`, which the launcher rewrites on every
 *     start attempt (verified: the file changes even when the boot then fails);
 *   - a start is confirmed when `plugin-guard/history.json` gets written by the
 *     host half (that only happens once a start has proved itself);
 *   - if no confirmation arrives within the grace period, it shows a native
 *     Windows dialog naming the suspects, offering to roll back or to remove
 *     the last installed plugin, and always printing the exact commands.
 *
 * The daemon talks to the harness only through the guard's own CLI, so every
 * action is the same tested code path the terminal uses.
 * @module dsh-plugin-guard/watchdog
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { staticBootAudit } from './bootcheck.js'
import { profileExists } from './profile.js'
import { guardHome, listBackups } from './store.js'

/** Poll cadence of the daemon. */
export const WATCHDOG_POLL_MS = 2000
/** How long a start may take before it counts as failed. */
export const WATCHDOG_GRACE_MS = 120000
/** Polls between proactive bootability audits (2s each). */
const AUDIT_EVERY_POLLS = 60
/**
 * How long after a boot record a start may die and still count as failed. Our
 * own record is written ~20s after our row mounts, while a *later* row can fail
 * afterwards (measured: the process died 1s after the record), so a record alone
 * is not proof of a healthy start — only serving a page is.
 */
const UNSERVED_FAILURE_MS = 120000
/**
 * How long a DSH-shaped process stays creditable to an attempt. Signal 1 (the
 * profile's include root being rewritten) can arrive a poll after the process.
 */
const PROCESS_CREDIT_MS = 60000
/** Safety ceiling so a forgotten daemon cannot live forever. */
const WATCHDOG_MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000

const DAEMON_PATH = fileURLToPath(new URL('./watchdog.js', import.meta.url))
const CLI_PATH = fileURLToPath(new URL('./cli.mjs', import.meta.url))

/** Files the daemon uses. */
export function watchdogPaths(env = process.env) {
  const home = guardHome(env)
  return {
    home,
    pid: join(home, 'watchdog.pid'),
    stop: join(home, 'watchdog.stop'),
    log: join(home, 'watchdog.log'),
    rescue: join(home, 'LAST-RESCUE.txt'),
  }
}

/** The watchdog is on unless the user turned it off with `watchdog off`. */
export function watchdogEnabled(env = process.env) {
  return !existsSync(watchdogPaths(env).stop)
}

/**
 * The per-user logon entry that keeps a watchdog present after a reboot. DSH
 * itself is never started by it: it only guards, so however the user launches
 * DSH stays theirs.
 * @param env - environment seam.
 * @returns the .vbs path in the Startup folder, or undefined without APPDATA.
 */
export function autostartFile(env = process.env) {
  if (typeof env.APPDATA !== 'string' || env.APPDATA === '') return undefined
  return join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'dsh-plugin-guard-watchdog.vbs')
}

/** Whether the logon entry is in place. */
export function autostartEnabled(env = process.env) {
  const file = autostartFile(env)
  return file !== undefined && existsSync(file)
}

/**
 * This package's own name, from its manifest. Needed because the installed
 * location depends on it: a scoped package lives at
 * `node_modules/@scope/name/…`, so a hard-coded `node_modules/<name>/…` path
 * would point at nothing for everyone who installs the scoped release.
 * @returns the manifest name, or a safe fallback.
 */
function ownPackageName() {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : 'dsh-plugin-guard'
  } catch {
    return 'dsh-plugin-guard'
  }
}

/**
 * The logon starter. Written as UTF-16 with a BOM (see `enableAutostart`), and
 * `%USERPROFILE%` is used where it keeps the path free of the account name.
 * @param env - environment seam.
 * @param facts - profile facts.
 * @returns the .vbs source.
 */
export function autostartScript(env, facts) {
  const defaultHome = typeof env.USERPROFILE === 'string' ? join(env.USERPROFILE, '.dsh') : undefined
  const profileIsDefault = defaultHome !== undefined && facts.profileDir === join(defaultHome, 'profiles', facts.profileName)
  const prefix = profileIsDefault ? '%USERPROFILE%\\.dsh' : facts.profileDir.replace(/\\profiles\\[^\\]+$/, '')
  const installed = ['node_modules', ...ownPackageName().split('/'), 'lib', 'watchdog.js'].join('\\')
  const guard = `${prefix}\\profiles\\${facts.profileName}\\${installed}`
  const log = `${prefix}\\plugin-guard\\autostart.log`
  const inner = `cmd /c set DSH_HOME=${prefix}&& echo [%DATE% %TIME%] autostart>> ""${log}""&& ""${process.execPath}"" ""${guard}"" --daemon --profile ${facts.profileName} >> ""${log}"" 2>&1`
  return [
    "' Starts the DSH plugin guard watchdog at logon. Generated by dsh-plugin-guard.",
    "' It never starts DSH: you keep launching DSH however you like.",
    "' Disable with: dsh-plugin-guard watchdog autostart off   (or delete this file).",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run "${inner}", 0, False`,
    '',
  ].join('\r\n')
}

/**
 * Write the logon entry.
 * @returns its path, or undefined when APPDATA is missing.
 */
export async function enableAutostart(env, facts) {
  const file = autostartFile(env)
  if (file === undefined) return undefined
  // The Startup folder can be missing (fresh profile, or someone deleted it):
  // create it rather than failing the switch with ENOENT.
  await mkdir(dirname(file), { recursive: true })
  // Windows Script Host reads ANSI by default, which silently corrupts a
  // non-ASCII account name in the path (measured: the name was mangled).
  // UTF-16LE with a BOM is how a .vbs declares itself Unicode.
  await writeFile(file, `\uFEFF${autostartScript(env, facts)}`, 'utf16le')
  return file
}

/**
 * Remove the logon entry.
 * @returns whether one was there.
 */
export async function disableAutostart(env = process.env) {
  const file = autostartFile(env)
  if (file === undefined) return false
  const existed = existsSync(file)
  await rm(file, { force: true })
  return existed
}

/** Whether a pid refers to a live process. */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The running daemon's pid, when one is alive. */
export async function watchdogStatus(env = process.env) {
  const paths = watchdogPaths(env)
  let pid
  try {
    pid = Number((await readFile(paths.pid, 'utf8')).trim())
  } catch {}
  const running = pid !== undefined && Number.isFinite(pid) && alive(pid)
  let log = ''
  try {
    log = (await readFile(paths.log, 'utf8')).split('\n').filter((line) => line !== '').slice(-8).join('\n')
  } catch {}
  return { enabled: watchdogEnabled(env), pid: running ? pid : undefined, running, log, paths }
}

/** Time of a file's last write, or undefined when it does not exist. */
function mtimeMs(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}

/**
 * Make sure a daemon is running, starting a detached one when needed.
 * @param input - env and profile facts.
 * @returns the pid it started, or undefined when one was already alive / disabled.
 */
export async function ensureWatchdog(input) {
  const env = input.env ?? process.env
  const facts = input.facts
  if (facts?.profileName === undefined) return undefined
  if (!watchdogEnabled(env)) return undefined
  const status = await watchdogStatus(env)
  if (status.running) return undefined
  const child = spawn(process.execPath, [DAEMON_PATH, '--daemon', '--profile', facts.profileName], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  })
  child.unref()
  return child.pid
}

/** Stop the daemon and keep it from coming back until `watchdog on`. */
export async function disableWatchdog(env = process.env) {
  const paths = watchdogPaths(env)
  await writeFile(paths.stop, `${new Date().toISOString()}\n`)
  const status = await watchdogStatus(env)
  if (status.running && status.pid !== undefined) {
    try {
      process.kill(status.pid)
    } catch {}
  }
  return paths
}

/** Turn the watchdog back on (the next confirmed boot starts a daemon). */
export async function enableWatchdog(env = process.env) {
  const paths = watchdogPaths(env)
  await rm(paths.stop, { force: true })
  return paths
}

/** Append one line to the daemon log. */
async function logLine(env, line) {
  const paths = watchdogPaths(env)
  await writeFile(paths.log, `${new Date().toISOString()} ${line}\n`, { flag: 'a' }).catch(() => {})
}

/** Quote one string for a PowerShell single-quoted literal. */
function psQuote(text) {
  return `'${String(text).replace(/'/g, "''")}'`
}

/**
 * Ask the operator what to do, through a native Windows dialog. A test seam
 * (`DSH_PLUGIN_GUARD_WATCHDOG_ANSWER`) answers without showing anything.
 * @returns 'yes' (roll back), 'no' (remove the last install), or 'cancel'.
 */
async function askOperator(env, text, title) {
  const forced = env.DSH_PLUGIN_GUARD_WATCHDOG_ANSWER
  if (typeof forced === 'string' && forced !== '') {
    await logLine(env, `[auto-answer] ${forced}`)
    return forced
  }
  if (process.platform !== 'win32') return 'cancel'
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    `$r=[System.Windows.Forms.MessageBox]::Show(${psQuote(text)}, ${psQuote(title)}, 'YesNoCancel', 'Warning')`,
    'exit [int]$r',
  ].join('; ')
  const code = await new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true, timeout: 10 * 60 * 1000 }, (error) => resolve(error === null ? 0 : (typeof error.code === 'number' ? error.code : 1)))
  })
  // 2/6/7 are MessageBox button results; anything else means the dialog never
  // ran, which must not be logged as "the operator cancelled".
  await logLine(env, code === 6 ? 'dialog: yes (roll back)' : code === 7 ? 'dialog: no (remove suspect)' : code === 2 ? 'dialog: cancel' : `dialog: did not run (exit ${String(code)})`)
  return code === 6 ? 'yes' : code === 7 ? 'no' : 'cancel'
}

/** Run one guard CLI command, ignoring its console output. */
function runCli(env, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI_PATH, ...args], { env, windowsHide: true, timeout: 10 * 60 * 1000 }, (error, stdout, stderr) => {
      resolve({ ok: error === null, output: `${stdout ?? ''}${stderr ?? ''}`.trim() })
    })
  })
}

/** Show a plain information dialog (no choices). */
async function notify(env, text, title) {
  const forced = env.DSH_PLUGIN_GUARD_WATCHDOG_ANSWER
  if (typeof forced === 'string' && forced !== '') return
  if (process.platform !== 'win32') return
  const script = ['Add-Type -AssemblyName System.Windows.Forms', `[System.Windows.Forms.MessageBox]::Show(${psQuote(text)}, ${psQuote(title)}, 'OK', 'Information') | Out-Null`].join('; ')
  await new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true, timeout: 10 * 60 * 1000 }, () => resolve())
  })
}

/**
 * PIDs of running `node.exe` processes. Cheap enough to poll: no command lines.
 * @returns pids, or an empty list where the tool is unavailable.
 */
function nodePids() {
  if (process.platform !== 'win32') return Promise.resolve([])
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq node.exe', '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 15000 }, (error, stdout) => {
      if (error) return resolve([])
      const pids = []
      for (const line of String(stdout).split('\n')) {
        const match = /^"node\.exe","(\d+)"/.exec(line.trim())
        if (match !== null) pids.push(Number(match[1]))
      }
      resolve(pids)
    })
  })
}

/** Command lines of the running node processes, keyed by pid. */
function nodeCommandLines() {
  const script = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { $_.ProcessId.ToString() + '|' + $_.CommandLine }"
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      const map = new Map()
      if (error) return resolve(map)
      for (const line of String(stdout).split('\n')) {
        const index = line.indexOf('|')
        if (index === -1) continue
        const pid = Number(line.slice(0, index).trim())
        if (Number.isFinite(pid)) map.set(pid, line.slice(index + 1).trim())
      }
      resolve(map)
    })
  })
}

/**
 * Whether a command line is DSH *starting a profile* (as opposed to one of the
 * short-lived `dsh plugin …` commands, or this daemon itself).
 *
 * This is the signal for the failure class that writes no files at all: a start
 * that aborts inside `loadProfile` (an unresolvable bundle entry, an unparsable
 * patch layer) leaves the profile directory untouched, so `cordis.yml` never
 * changes and nothing else can notice the attempt.
 */
export function isDshStart(cmdline, profileName) {
  if (typeof cmdline !== 'string' || cmdline === '') return false
  if (cmdline.includes('dsh-plugin-guard')) return false
  if (!/dsh[\\/]lib[\\/]bin\.js/.test(cmdline)) return false
  const tokens = cmdline.split('"').join(' ').split(/\s+/).filter((token) => token !== '')
  const entry = tokens.findIndex((token) => /dsh[\\/]lib[\\/]bin\.js$/.test(token))
  if (entry === -1) return false
  let sub
  for (let index = entry + 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--profile' || token === '-p') {
      if (token === '--profile' && tokens[index + 1] !== undefined && !tokens[index + 1].startsWith('-')) {
        if (tokens[index + 1] !== profileName) return false
        index += 1
      }
      continue
    }
    if (token.startsWith('-')) continue
    sub = token
    break
  }
  // `dsh plugin …` / `dsh preset …` are not profile starts.
  return sub === undefined || sub === 'web' || sub === 'tui' || sub === 'acp' || sub === 'sdk' || sub === 'run' || sub === 'serve'
}

/**
 * A stable fingerprint of the blocking findings, so the same broken profile is
 * only reported once.
 * @param findings - audit findings.
 */
export function blockerKey(findings) {
  return findings
    .filter((finding) => finding.severity === 'blocker')
    .map((finding) => finding.rule)
    .sort()
    .join(',')
}

/**
 * Name the suspects and ask, then act. Used both for a start that failed and
 * for a profile that is statically unbootable right now.
 * @param input - env, profile facts and the sentence explaining why we are here.
 */
export async function rescueFromFailedBoot(input) {
  const env = input.env ?? process.env
  const facts = input.facts
  const paths = watchdogPaths(env)
  const audit = staticBootAudit({ facts, env })
  const blockers = audit.findings.filter((finding) => finding.severity === 'blocker')
  const warnings = audit.findings.filter((finding) => finding.severity === 'warn').slice(0, 3)
  const snapshots = await listBackups(env)
  const snapshot = snapshots[0]
  const suspectLine =
    blockers.length === 0 && warnings.length === 0
      ? '（静态校验没有点出具体元凶，可能是启动期的其它错误）'
      : [...blockers.map((finding) => `× [${finding.rule}] ${finding.title}`), ...warnings.map((finding) => `! [${finding.rule}] ${finding.title}`)].join('\n')
  const lines = [
    input.why ?? `DSH 等了 ${String(Math.round(WATCHDOG_GRACE_MS / 1000))} 秒仍未启动成功，判定为启动失败。`,
    '',
    '可疑项：',
    suspectLine,
    '',
    `[是] 回退到最近一次备份${snapshot === undefined ? '（当前没有备份，此项不可用）' : `（${snapshot.id}）`}`,
    '[否] 只移除最近安装（或最近改动过）的插件',
    '[取消] 什么都不做，命令写进 LAST-RESCUE.txt',
    '',
    '对应命令（也可手动执行）：',
    `  node "${CLI_PATH}" restore latest --profile ${String(facts.profileName)}`,
    `  node "${CLI_PATH}" safe-mode --profile ${String(facts.profileName)}`,
  ]
  const text = lines.join('\n')
  await writeFile(paths.rescue, `${text}\n`).catch(() => {})
  await logLine(env, `${input.why === undefined ? 'failed boot detected' : 'unbootable profile detected'}; asking operator (${String(blockers.length)} blocker findings)`)
  const answer = await askOperator(env, text, 'DSH 插件守卫：启动失败')
  if (answer === 'yes') {
    const result = await runCli(env, ['restore', 'latest', '--profile', String(facts.profileName)])
    await logLine(env, `operator chose rollback: ${result.ok ? 'ok' : 'failed'} ${result.output.slice(0, 200)}`)
    await notify(env, `已按你的选择回退到最近一次备份，并对齐了依赖。\n\n${result.output.slice(-800)}\n\n日志：${paths.log}`, 'DSH 插件守卫：处理结果')
    return { answer, result }
  }
  if (answer === 'no') {
    const result = await runCli(env, ['safe-mode', '--profile', String(facts.profileName)])
    await logLine(env, `operator chose safe-mode: ${result.ok ? 'ok' : 'failed'} ${result.output.slice(0, 200)}`)
    await notify(env, `已按你的选择移除最近一次安装/最近改动的插件。\n\n${result.output.slice(-800)}\n\n日志：${paths.log}`, 'DSH 插件守卫：处理结果')
    return { answer, result }
  }
  await logLine(env, 'operator cancelled; commands left in LAST-RESCUE.txt')
  return { answer, result: undefined }
}

/**
 * The daemon loop.
 * @param input - env and profile facts.
 */
export async function runWatchdog(input) {
  const env = input.env ?? process.env
  const facts = input.facts
  if (facts === undefined || !profileExists(facts)) {
    await logLine(env, 'watchdog cannot resolve the profile; exiting')
    return
  }
  const paths = watchdogPaths(env)
  // One daemon per guard data directory: the logon entry and a successful boot
  // can both ask for one, and two watchers would mean two dialogs for one crash.
  const existing = await watchdogStatus(env)
  if (existing.running && existing.pid !== process.pid) {
    await logLine(env, `another watchdog is already running (pid ${String(existing.pid)}); exiting`)
    return
  }
  await writeFile(paths.pid, String(process.pid)).catch(() => {})
  await logLine(env, `watchdog started pid=${String(process.pid)} profile=${String(facts.profileName)}`)
  const attemptFile = join(facts.profileDir, 'cordis.yml')
  const confirmFile = join(guardHome(env), 'history.json')
  const servedFile = join(guardHome(env), 'served.json')
  const startedAt = Date.now()
  const watchedProfile = String(facts.profileName)
  let lastAttempt = mtimeMs(attemptFile) ?? 0
  let pendingSince = 0
  // Pids we attributed to this attempt (kept after they exit) and those still
  // alive now. Only an attempt we actually saw as a process may be concluded
  // from its exit — otherwise a healthy start would be reported as a failure.
  let attemptPids = new Set()
  let livePids = new Set()
  let knownPids = new Set(await nodePids())
  /** DSH-shaped processes seen recently (pid → first seen), awaiting an attempt. */
  const recent = new Map()
  let polls = 0
  let lastBlockerKey = ''
  for (;;) {
    if (existsSync(paths.stop)) {
      await logLine(env, 'stop marker found; exiting')
      break
    }
    if (Date.now() - startedAt > WATCHDOG_MAX_LIFETIME_MS) {
      await logLine(env, 'max lifetime reached; exiting')
      break
    }

    // Signal 1: the start got far enough to rewrite the profile include root.
    const attempt = mtimeMs(attemptFile)
    if (attempt !== undefined && attempt > lastAttempt) {
      lastAttempt = attempt
      if (pendingSince === 0) pendingSince = Date.now()
      await logLine(env, `start attempt detected (cordis.yml ${new Date(attempt).toISOString()})`)
    }

    // Signal 2: a DSH process that belongs to this attempt. A start of another
    // DSH_HOME or another profile looks identical on the process list (measured:
    // a lab instance made the live watcher raise a dialog), so a process is only
    // *credited* once our own profile has shown intent (signal 1). The class
    // that writes no file at all is covered by the proactive audit instead.
    const pids = await nodePids()
    if (pids.length > 0) {
      const fresh = pids.filter((pid) => !knownPids.has(pid))
      for (const pid of pids) knownPids.add(pid)
      if (fresh.length > 0) {
        const lines = await nodeCommandLines()
        for (const pid of fresh) {
          if (!isDshStart(lines.get(pid), watchedProfile)) continue
          recent.set(pid, Date.now())
        }
      }
      if (pendingSince > 0) {
        for (const [pid, seenAt] of [...recent]) {
          if (Date.now() - seenAt > PROCESS_CREDIT_MS) {
            recent.delete(pid)
            continue
          }
          if (attemptPids.has(pid) || !pids.includes(pid)) continue
          attemptPids.add(pid)
          await logLine(env, `start attempt detected (process ${String(pid)})`)
        }
      }
      livePids = new Set([...attemptPids].filter((pid) => pids.includes(pid)))
    }

    if (pendingSince > 0) {
      const confirmed = mtimeMs(confirmFile)
      const served = mtimeMs(servedFile)
      const elapsed = Date.now() - pendingSince
      const recordSeen = confirmed !== undefined && confirmed > pendingSince
      // A page was actually served by *this* start: that is the only proof that
      // the loader came up, and it is what a dying boot never produces.
      const servedSeen = served !== undefined && served > pendingSince
      const reset = () => {
        pendingSince = 0
        attemptPids.clear()
      }
      if (servedSeen) {
        await logLine(env, 'start confirmed (served a page); back to watching')
        reset()
      } else if (recordSeen && livePids.size === 0) {
        const age = confirmed === undefined ? 0 : Date.now() - confirmed
        if (age < UNSERVED_FAILURE_MS) {
          await logLine(env, `start wrote a boot record, never served a page, died ${String(Math.round(age / 1000))}s later`)
          await rescueFromFailedBoot({
            env,
            facts,
            why: `这次启动写出了启动记录，却从来没有服务过页面，进程在 ${String(Math.round(age / 1000))} 秒后就退出了——它并没有真正起来（通常是靠后的插件行加载失败）。`,
          })
          reset()
        } else {
          await logLine(env, 'start recorded an old boot and has since ended; nothing to do')
          reset()
        }
      } else if (attemptPids.size > 0 && livePids.size === 0) {
        await logLine(env, 'start process exited without a boot record')
        await rescueFromFailedBoot({ env, facts })
        reset()
      } else if (elapsed > WATCHDOG_GRACE_MS + WATCHDOG_POLL_MS) {
        if (livePids.size > 0) {
          // A live process that has not been confirmed yet may still be booting;
          // never disturb a start that has not failed.
          await logLine(env, 'start still running past the grace period; keep waiting')
          pendingSince = Date.now()
        } else {
          await logLine(env, 'no boot record within the grace period')
          await rescueFromFailedBoot({ env, facts })
          reset()
        }
      }
    }
    // Proactive: a statically unbootable profile cannot start, whether or not
    // the attempt is observable. A start that dies inside `loadProfile` writes
    // nothing and can be gone between two polls, so this is the reliable signal
    // for that class.
    if (pendingSince === 0 && polls % AUDIT_EVERY_POLLS === 0) {
      const key = blockerKey(staticBootAudit({ facts, env }).findings)
      if (key === '') lastBlockerKey = ''
      else if (key !== lastBlockerKey) {
        lastBlockerKey = key
        await logLine(env, `profile is not bootable: ${key}`)
        await rescueFromFailedBoot({ env, facts, why: 'profile 现在有阻塞级问题：DSH 下次启动或插件加载会在这里失败。' })
        lastBlockerKey = blockerKey(staticBootAudit({ facts, env }).findings)
      }
    }
    polls += 1
    await new Promise((resolve) => setTimeout(resolve, WATCHDOG_POLL_MS))
  }
  await rm(paths.pid, { force: true }).catch(() => {})
}

/**
 * Whether this file is the process entry point. The comparison must resolve
 * junctions: the logon entry starts us through
 * `<profile>\node_modules\dsh-plugin-guard\lib\watchdog.js`, while
 * `import.meta.url` is already the real path — and a plain string compare there
 * silently turned the daemon into a no-op process that exits immediately.
 */
function invokedAsEntry() {
  const argument = process.argv[1]
  if (argument === undefined) return false
  const here = fileURLToPath(import.meta.url)
  try {
    return realpathSync(argument) === realpathSync(here)
  } catch {
    return argument === here
  }
}

// `node lib/watchdog.js --daemon --profile <name>` is how the host half starts it.
if (invokedAsEntry() && process.argv.includes('--daemon')) {
  const index = process.argv.indexOf('--profile')
  const profileName = index === -1 ? undefined : process.argv[index + 1]
  const { resolveProfileFacts } = await import('./profile.js')
  const facts = resolveProfileFacts({ profileName })
  await runWatchdog({ env: process.env, facts })
}
