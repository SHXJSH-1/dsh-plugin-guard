/**
 * Host half: the loopback gateway the browser half calls for precheck,
 * history, backups and rollback. Every mutation goes through the official
 * `dsh plugin` CLI; this half never edits a profile file itself.
 * @module dsh-plugin-guard/host
 */

import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { URL, fileURLToPath } from 'node:url'

import { analyze, registryOf, resolveTarget } from './precheck.js'
import { staticBootAudit, validateGraph } from './bootcheck.js'
import { collectEnvironment, dshCliBin, profileExists, readInstalledPlugins, readLocalRows, reconcileProfile, resolveProfileFacts, runDshPlugin } from './profile.js'
import { appendRollbackLog, backupProfile, cacheDir, deleteBackup, guardHome, listBackups, pruneBackups, readHistory, readRestoreLog, readRollbackLog, readSkips, recordBoot, recordSkip, restoreBackup, summarizeHistory } from './store.js'
import { autostartEnabled, autostartFile, disableAutostart, disableWatchdog, enableAutostart, enableWatchdog, ensureWatchdog, watchdogStatus } from './watchdog.js'

/** Stable cordis plugin name; matches the cordis.patch.yml insert id. */
export const name = 'ui-plugin-guard'
/**
 * No required services. Boot accounting is the half that must survive on every
 * profile — headless, sdk and acp ship no `webServer`, and recording their
 * versions is what makes `dsh-plugin-guard rollback` able to save them. The
 * HTTP gateway is registered later, through `ctx.inject(['webServer'])`, so it
 * appears on web profiles and stays absent everywhere else.
 */
export const inject = []
/** How long a start must survive before it counts as a real boot. */
const BOOT_CONFIRM_MS = 20000
/** Gateway prefix mirrored by the browser half. */
const PREFIX = '/api/plugin-guard'
const MOUNT_FLAG = '__dshPluginGuardMounted'
// Specs are passed as execFile arguments, never through a shell: shell
// metacharacters are refused, while unicode paths, spaces and Windows drive
// colons pass through as a single argument.
const UNSAFE_SPEC = /[;&|`$<>"'(){}[\]*?!^%\r\n\t]/

/** Default JSON response headers. */
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' }

/** Whether an IPv4 literal is loopback (127/8). */
function isIPv4Loopback(value) {
  const parts = value.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether a socket remote address is loopback. */
function isLoopbackAddress(address) {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice(7))
  return isIPv4Loopback(normalized)
}

/** Whether a hostname names a loopback authority. */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/** The shared loopback fence: socket address, Host header and same-origin markers. */
function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Write one JSON response. */
function writeJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

/** Read a bounded JSON request body. */
async function readJsonBody(req, maxBytes = 256 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) {
      req.destroy()
      return undefined
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return {}
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return undefined
  }
}

/** Wrap a handler with the loopback fence and error reporting. */
function fence(handler) {
  return async (req, res) => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
      return
    }
    try {
      await handler(req, res)
    } catch (error) {
      writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/** This package's own manifest, for the version shown in the UI. */
async function ownManifest() {
  try {
    return JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  } catch {
    return { name: 'dsh-plugin-guard', version: 'unknown' }
  }
}

/** Absolute path of the terminal entry, used to isolate module-loading checks. */
const CLI_PATH = fileURLToPath(new URL('./cli.mjs', import.meta.url))

/**
 * Run our own CLI in a child process. Configuration checks import third-party
 * plugin modules, which must never happen inside the live host.
 * @param args - CLI arguments.
 * @param env - environment for the child.
 * @param timeoutMs - ceiling for the whole run.
 * @returns exit status and captured streams.
 */
function runSelf(args, env, timeoutMs = 180000) {
  return new Promise((resolveRun) => {
    execFile(process.execPath, [CLI_PATH, ...args], { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolveRun({ ok: error === null, code: error === null ? 0 : (error.code ?? 1), stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

/** Build the gateway routes. */
function buildRoutes(state) {
  const { facts, env } = state
  const route = (path, handler) => ({
    kind: 'exact',
    path: `${PREFIX}${path}`,
    // Serving a request is proof this start is real, so the boot record (and the
    // watchdog) can be committed without waiting for the timer.
    handler: fence(async (req, res) => {
      state.onServing?.()
      await handler(req, res)
    }),
  })

  const precheck = async (spec) => {
    const target = await resolveTarget(spec, {
      profileDir: facts.profileDir,
      registry: registryOf(env),
      cacheDir: cacheDir(env),
      env,
      readLocalRows,
    })
    const environment = await collectEnvironment(facts, { env })
    environment.registry = registryOf(env)
    return analyze({ spec, target, environment })
  }

  return [
    route('/status', async (req, res) => {
      const manifest = await ownManifest()
      const installed = profileExists(facts) ? readInstalledPlugins(facts, env) : []
      const history = await readHistory(env)
      const skips = await readSkips(env)
      const environment = await collectEnvironment(facts, { env })
      writeJson(res, 200, {
        ok: true,
        plugin: { name: manifest.name, version: manifest.version },
        profile: { name: facts.profileName, dir: facts.profileDir, exists: profileExists(facts), error: facts.error },
        dshHome: facts.dshHome,
        dshVersion: environment.dshVersion,
        cliAvailable: state.cliAvailable(),
        clientModulesAvailable: state.clientModules() !== undefined,
        watchdog: await watchdogStatus(env),
        autostart: { enabled: autostartEnabled(env), file: autostartFile(env) ?? null },
        registry: registryOf(env),
        installedCount: installed.length,
        rowCount: environment.rows.length,
        historyBoots: (history.boots ?? []).length,
        skipCount: (skips.entries ?? []).length,
        backups: (await listBackups(env)).slice(0, 5),
      })
    }),

    // The logon entry is written through the same helper the CLI uses: one
    // implementation, so the settings switch and `watchdog autostart on` cannot
    // drift apart.
    route('/autostart', async (req, res) => {
      const body = await readJsonBody(req)
      if (typeof body?.enabled !== 'boolean') {
        writeJson(res, 400, { ok: false, error: 'enabled (boolean) is required' })
        return
      }
      if (body.enabled) {
        try {
          const file = await enableAutostart(env, facts)
          if (file === undefined) {
            writeJson(res, 400, { ok: false, error: 'APPDATA is not set; cannot locate the Startup folder' })
            return
          }
          // Both halves take effect now, not at the next boot: the entry is
          // written and a daemon is started immediately.
          await enableWatchdog(env)
          const pid = await ensureWatchdog({ env, facts })
          writeJson(res, 200, { ok: true, enabled: true, file, pid })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: `写入开机自启失败：${error instanceof Error ? error.message : String(error)}` })
        }
        return
      }
      try {
        // Switching it off stops the running daemon right away — "关闭后即刻关闭"
        // — and keeps it from coming back at logon or on the next boot.
        const existed = await disableAutostart(env)
        const paths = await disableWatchdog(env)
        writeJson(res, 200, { ok: true, enabled: false, removed: existed, stopMarker: paths?.stop ?? null })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: `关闭开机自启失败：${error instanceof Error ? error.message : String(error)}` })
      }
    }),

    route('/precheck', async (req, res) => {
      const body = await readJsonBody(req)
      if (body === undefined || typeof body.spec !== 'string' || body.spec.trim() === '') {
        writeJson(res, 400, { ok: false, error: 'spec is required' })
        return
      }
      if (UNSAFE_SPEC.test(body.spec.trim()) || body.spec.trim().startsWith('-')) {
        writeJson(res, 400, { ok: false, error: 'spec contains unsupported characters' })
        return
      }
      writeJson(res, 200, { ok: true, report: await precheck(body.spec.trim()) })
    }),

    route('/history', async (req, res) => {
      const installed = profileExists(facts) ? readInstalledPlugins(facts, env) : []
      const history = await readHistory(env)
      const skips = await readSkips(env)
      writeJson(res, 200, {
        ok: true,
        rows: summarizeHistory({ history, installed, profile: facts.profileName }),
        boots: (history.boots ?? []).slice(-10).reverse(),
        backups: (await listBackups(env)).slice(0, 20),
        rollbacks: (await readRollbackLog(env)).entries.slice(0, 20),
        skips,
        skipCount: (skips.entries ?? []).length,
        restores: (await readRestoreLog(env)).entries.slice(0, 20),
      })
    }),

    route('/rollback', async (req, res) => {
      const body = await readJsonBody(req)
      const version = typeof body?.version === 'string' ? body.version.trim() : ''
      const target = typeof body?.name === 'string' ? body.name.trim() : ''
      if (target === '' || UNSAFE_SPEC.test(target) || target.startsWith('-') || (version !== '' && UNSAFE_SPEC.test(version))) {
        writeJson(res, 400, { ok: false, error: 'name (and optional version) are required' })
        return
      }
      if (!profileExists(facts)) {
        writeJson(res, 409, { ok: false, error: `profile ${String(facts.profileName)} has no manifest; refusing to write` })
        return
      }
      const installed = readInstalledPlugins(facts, env)
      const before = installed.find((item) => item.name === target)
      const backup = await backupProfile({ env, facts, reason: version === '' ? `rollback ${target}` : `rollback ${target}@${version}`, installed })
      const spec = version === '' ? target : `${target}@${version}`
      const result = await runDshPlugin({ facts, env, args: ['add', spec] })
      // A failed install must not leave the profile in a half-written state we
      // cannot name: put the captured files back before reporting.
      const restored = result.ok ? undefined : await restoreBackup({ env, facts, id: backup.dir, allowPath: true, reason: `auto restore after failed rollback ${spec}` })
      // `node_modules` is not part of a backup: align it, otherwise the next
      // start can fail on a bundle entry whose directory is gone.
      const reconciled = restored?.ok === true ? await reconcileProfile({ facts, env }) : undefined
      await appendRollbackLog({ env, facts, name: target, from: before?.version, to: version === '' ? 'latest' : version, result, backup: backup.dir })
      writeJson(res, result.ok ? 200 : 500, { ok: result.ok, spec, backup: backup.dir, restored, reconciled, result })
    }),

    route('/snapshot', async (req, res) => {
      const body = await readJsonBody(req)
      if (!profileExists(facts)) {
        writeJson(res, 409, { ok: false, error: `profile ${String(facts.profileName)} has no manifest` })
        return
      }
      const spec = typeof body?.spec === 'string' ? body.spec : 'unknown'
      const installed = readInstalledPlugins(facts, env)
      const backup = await backupProfile({ env, facts, reason: `pre-install ${spec}`, kind: 'auto', installed })
      const pruned = await pruneBackups({ env })
      writeJson(res, 200, { ok: true, ...backup, kind: 'auto', pruned })
    }),

    route('/bootcheck', async (req, res) => {
      const service = state.clientModules()
      let live
      if (service === undefined || service === null) {
        live = { available: false, ok: true, findings: [], counts: {}, note: '这个 profile 没有 clientModules 服务（非 web 运行），只能做静态校验' }
      } else {
        try {
          live = { available: true, at: new Date().toISOString(), ...validateGraph(service.graph(), (id) => service.clientPath?.(id)) }
        } catch (error) {
          live = {
            available: true,
            ok: false,
            findings: [{ severity: 'blocker', rule: 'boot-graph-read', title: '读取启动检测失败', detail: error instanceof Error ? error.message : String(error), evidence: { required: 'clientModules.graph()', actual: '抛错' } }],
            counts: {},
          }
        }
      }
      const audit = profileExists(facts) ? staticBootAudit({ facts, env }) : { ok: true, findings: [], packages: [] }
      // `ok` means the call worked; the verdict is separate, so a failing check
      // is not mistaken for a transport error by the browser half.
      const passed = live.ok !== false && audit.ok
      writeJson(res, 200, { ok: true, verdict: passed ? 'pass' : 'fail', live, static: audit })
    }),

    route('/configcheck', async (req, res) => {
      const args = ['configcheck', '--json']
      if (typeof facts.profileName === 'string' && facts.profileName !== '') args.push('--profile', facts.profileName)
      const run = await runSelf(args, env)
      let report
      try {
        report = JSON.parse(run.stdout)
      } catch {}
      if (report === undefined) {
        writeJson(res, 500, { ok: false, error: `config check produced no report: ${(run.stderr || run.stdout).slice(-400)}` })
        return
      }
      writeJson(res, 200, { ok: true, verdict: report.ok === true ? 'pass' : 'fail', report })
    }),

    route('/backup-delete', async (req, res) => {
      const body = await readJsonBody(req)
      const id = typeof body?.id === 'string' ? body.id.trim() : ''
      if (id === '') {
        writeJson(res, 400, { ok: false, error: 'id is required' })
        return
      }
      const removed = await deleteBackup({ env, id })
      writeJson(res, removed.ok ? 200 : 404, removed)
    }),

    route('/restore', async (req, res) => {
      const body = await readJsonBody(req)
      if (!profileExists(facts)) {
        writeJson(res, 409, { ok: false, error: `profile ${String(facts.profileName)} has no manifest; refusing to write` })
        return
      }
      // An explicit id is required here: this route rewrites profile files, and
      // a stray request must not silently pick "the newest backup" for you.
      const id = typeof body?.id === 'string' ? body.id.trim() : ''
      if (id === '') {
        writeJson(res, 400, { ok: false, error: 'id is required; read the backup list from /history first' })
        return
      }
      const restored = await restoreBackup({ env, facts, id, reason: 'settings tab' })
      // Manifest-only restore; bring the installed tree back in line too, or the
      // next boot dies inside loadProfile with a missing bundle.
      const reconciled = restored.ok ? await reconcileProfile({ facts, env }) : undefined
      writeJson(res, restored.ok ? 200 : 404, { ...restored, reconciled })
    }),

    route('/skip', async (req, res) => {
      const body = await readJsonBody(req)
      if (typeof body?.spec !== 'string') {
        writeJson(res, 400, { ok: false, error: 'spec is required' })
        return
      }
      const document = await recordSkip({ env, facts, spec: body.spec, report: body.report, targetVersion: body.targetVersion })
      writeJson(res, 200, { ok: true, count: document.entries.length })
    }),

    route('/skips', async (req, res) => {
      writeJson(res, 200, { ok: true, skips: await readSkips(env) })
    }),

    route('/backup', async (req, res) => {
      const body = await readJsonBody(req)
      const installed = profileExists(facts) ? readInstalledPlugins(facts, env) : []
      const backup = await backupProfile({ env, facts, reason: typeof body?.reason === 'string' ? body.reason : 'manual', installed })
      writeJson(res, 200, { ok: true, ...backup })
    }),
  ]
}

/** Apply the host half once per process. */
export function apply(ctx) {
  if (globalThis[MOUNT_FLAG] === true) return
  globalThis[MOUNT_FLAG] = true
  const env = process.env
  const facts = resolveProfileFacts({ env })
  const state = {
    facts,
    env,
    cliAvailable: () => dshCliBin(env) !== undefined,
    clientModules: () => undefined,
  }
  // The client module registry owns the graph the browser boots from; hold a
  // reader for it and validate on demand instead of at one fixed moment.
  ctx.inject(
    ['clientModules'],
    (inner) => {
      try {
        state.clientModules = () => inner.clientModules
      } catch (error) {
        console.error('[plugin-guard] client graph reader unavailable:', error instanceof Error ? error.message : String(error))
      }
    },
    'plugin-guard: client graph',
  )
  // The gateway only exists where an HTTP server does; every other profile
  // still gets the boot record below.
  ctx.inject(
    ['webServer'],
    (inner) => {
      try {
        // Serving the SPA index is the one signal that proves a start really
        // came up: a boot that dies inside the loader never serves it. The
        // watchdog needs that distinction, because our own boot record can be
        // written (by the timer below) on the way down.
        inner.on('webserver/index-inject', () => state.onServing?.())
        inner.effect(() => {
          const disposers = buildRoutes(state).map((route) => inner.webServer.register(route))
          return () => {
            for (const dispose of disposers) dispose()
          }
        }, 'plugin-guard: gateway routes')
      } catch (error) {
        // A guard that breaks the boot it is supposed to protect would be worse
        // than useless: log and let the harness come up without the gateway.
        console.error('[plugin-guard] gateway registration failed:', error instanceof Error ? error.message : String(error))
      }
    },
    'plugin-guard: web gateway',
  )
  if (profileExists(facts)) {
    // Record the boot only once this start has proved it is a real one. A boot
    // that dies later in the tree (a broken patch row, a missing client bundle)
    // still applies our row first, and recording that would put a broken state
    // into "the last version that worked" — and it would tell the out-of-process
    // watchdog that a failed start had succeeded.
    let recorded = false
    const record = () => {
      if (recorded) return
      recorded = true
      void (async () => {
        try {
          const installed = readInstalledPlugins(facts, env)
          const environment = await collectEnvironment(facts, { env })
          await recordBoot({ env, facts, dshVersion: environment.dshVersion, installed })
          ensureWatchdog({ env, facts })
        } catch (error) {
          console.error('[plugin-guard] boot record failed:', error instanceof Error ? error.message : String(error))
        }
      })()
    }
    state.onServing = () => {
      // Always rewritten, even when the record below already exists: the
      // watchdog asks whether *this* start served a page, and a fresh mtime is
      // how it answers that.
      void writeFile(join(guardHome(env), 'served.json'), `${JSON.stringify({ at: new Date().toISOString(), profile: facts.profileName, pid: process.pid })}\n`).catch(() => {})
      record()
    }
    const timer = setTimeout(record, BOOT_CONFIRM_MS)
    if (typeof timer.unref === 'function') timer.unref()
  }
}

export default { name, inject, apply }
