/**
 * Browser half: the install gate and the 「插件守卫」settings tab.
 *
 * The gate wraps the shared `pluginManager` cordis service the moment it is
 * provided, so every install path that goes through that service — the market
 * card, the plugin-manager tab, the community preset center — runs the static
 * precheck first and, when the report is not clean, asks the user before
 * anything is written. Nothing here is loaded eagerly: the bundle only
 * registers a factory, and the module body runs on first use.
 * @module dsh-plugin-guard/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-guard',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const e = react.createElement

    /** Gateway prefix hosted by the host half. */
    const GATEWAY = '/api/plugin-guard'
    /** Marker so a second mount cannot double-wrap the shared service. */
    const WRAP_FLAG = '__pluginGuardWrapped'
    /**
     * Whether the install gate is really installed, and why not when it is not.
     * `verify` re-checks the live service instead of trusting a one-time flag, so
     * a later re-wrap by another plugin cannot leave a green light behind.
     */
    const gateState = {
      reason: '还在等待 pluginManager 服务（没装插件管理器时就是这样）',
      verify: () => false,
    }
    /** Services this plugin needs before it can run. */
    const inject = ['slots']

    /** Call one gateway route; throws with the host's message on failure. */
    async function call(path, init) {
      const response = await fetch(`${GATEWAY}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      })
      if (response.status === 403) throw new Error('插件守卫：仅限本机浏览器操作')
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.ok === false) throw new Error(body.error ?? `插件守卫：HTTP ${String(response.status)}`)
      return body
    }

    /** Inject the guard's stylesheet once. Token names follow the harness theme. */
    function injectStyles() {
      if (document.getElementById('dsh-plugin-guard-style') !== null) return
      const style = document.createElement('style')
      style.id = 'dsh-plugin-guard-style'
      style.textContent = `
/* Matches the sibling plugins in this settings page: plain sections with a 12px
   gap, primary content in bordered layer-1 cards (plugin-manager's rows), and
   borderless log lines. Buttons follow the Doctor card — bordered, bg-base,
   radius 6 — with the business-primary fill for the primary action. */
.dpg-tab{display:flex;flex-direction:column;gap:16px;font-size:13px;color:var(--dsw-alias-label-primary);line-height:1.6}
.dpg-section{display:flex;flex-direction:column;gap:12px}
.dpg-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dpg-section-title{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dpg-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:12px}
.dpg-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dpg-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto}
.dpg-stats{display:flex;flex-wrap:wrap;gap:24px}
.dpg-stat{display:flex;flex-direction:column;gap:2px;min-width:0}
.dpg-stat-value{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px}
.dpg-stat-label{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dpg-status{display:flex;align-items:center;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dpg-dot{display:inline-flex;align-items:center;gap:6px}
.dpg-dot::before{content:'';width:8px;height:8px;border-radius:999px;background:var(--dsw-alias-label-tertiary)}
.dpg-dot.on::before{background:var(--dsw-alias-state-success-primary,#22c55e)}
.dpg-hint{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dpg-switch-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px}
.dpg-switch{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dpg-switch input{width:15px;height:15px;margin:0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}
.dpg-switch input:disabled{cursor:default;opacity:.6}
.dpg-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;line-height:1.5;border-radius:6px;padding:4px 10px;cursor:pointer;transition:background .15s,color .15s,border-color .15s}
.dpg-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dpg-btn:disabled{opacity:.55;cursor:not-allowed}
.dpg-btn.small{padding:2px 8px;font-size:12px}
.dpg-btn.primary{border-color:var(--dsw-alias-state-business-primary,#4176e6);background:var(--dsw-alias-state-business-primary,#4176e6);color:var(--dsw-alias-label-on-primary,#fff);font-weight:500}
.dpg-btn.primary:hover:not(:disabled){background:var(--dsw-alias-state-business-primary,#4176e6);filter:brightness(1.07)}
.dpg-btn.danger{color:var(--dsw-alias-label-danger,#f25a5a)}
.dpg-btn.danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,rgba(242,90,90,.14))}
.dpg-btn:focus-visible,.dpg-input:focus-visible,.dpg-select:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:1px}
.dpg-input,.dpg-select{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:6px 10px;font:inherit;min-width:0}
.dpg-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.dpg-item{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:8px;display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:10px 12px}
.dpg-item-main{display:flex;flex-direction:column;gap:4px;min-width:0}
.dpg-item-title{font-weight:600;color:var(--dsw-alias-label-primary);word-break:break-all}
.dpg-item-sub{display:flex;flex-wrap:wrap;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dpg-log{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.dpg-log-item{display:flex;align-items:baseline;justify-content:space-between;gap:12px;font-size:12px}
.dpg-log-title{color:var(--dsw-alias-label-primary);min-width:0;word-break:break-all}
.dpg-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dpg-finding{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:8px;display:flex;flex-direction:column;gap:3px;padding:8px 12px}
.dpg-finding.blocker{background:var(--dsw-alias-bg-danger,rgba(242,90,90,.12))}
.dpg-finding-title{display:flex;align-items:baseline;gap:6px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dpg-finding.blocker .dpg-finding-title{color:var(--dsw-alias-label-danger,#f25a5a)}
.dpg-finding.warn .dpg-finding-title{color:var(--dsw-alias-state-warn-primary,#dd8629)}
.dpg-rule{font-family:ui-monospace,Consolas,monospace;font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary)}
.dpg-detail{color:var(--dsw-alias-label-secondary)}
.dpg-evidence{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-all}
.dpg-badge{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);border-radius:4px;padding:0 4px;font-size:11px;white-space:nowrap}
.dpg-ok{color:var(--dsw-alias-state-success-primary,#22c55e);font-size:12px;font-weight:600}
.dpg-error{color:var(--dsw-alias-label-danger,#f25a5a);font-size:12px;white-space:pre-wrap}
.dpg-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.42))}
.dpg-modal{width:min(560px,100%);max-height:84vh;overflow:auto;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 20px 56px rgba(0,0,0,.3);font-size:13px;line-height:1.6}
.dpg-modal-head{display:flex;flex-direction:column;gap:8px;padding:18px 20px 14px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dpg-chip{align-self:flex-start;border:1px solid transparent;border-radius:4px;padding:0 6px;font-size:11px;font-weight:600}
.dpg-chip.blocker{background:var(--dsw-alias-bg-danger,rgba(242,90,90,.14));color:var(--dsw-alias-label-danger,#f25a5a)}
.dpg-chip.warn{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-state-warn-primary,#dd8629)}
.dpg-chip.info{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dpg-title{font-size:15px;font-weight:600}
.dpg-sub{font-size:12px;color:var(--dsw-alias-label-tertiary);word-break:break-all}
.dpg-body{display:flex;flex-direction:column;gap:8px;padding:14px 20px 4px}
.dpg-foot{display:flex;align-items:center;gap:8px;justify-content:flex-end;padding:14px 20px 18px;border-top:1px solid var(--dsw-alias-border-l1)}
@media (prefers-reduced-motion:reduce){.dpg-btn{transition:none}}
`
      document.head.appendChild(style)
    }

    // Inject at module materialisation, the way the sibling plugins do: the tab
    // must be styled the moment it renders, not only after a modal opens.
    injectStyles()

    /** One severity badge label. */
    function severityLabel(severity) {
      if (severity === 'blocker') return '阻断'
      if (severity === 'warn') return '警告'
      return '信息'
    }

    /** CSS class for one severity. */
    function tone(severity) {
      return severity === 'blocker' ? 'blocker' : severity === 'warn' ? 'warn' : 'info'
    }

    /** Build one finding block (DOM, so the modal needs no framework). */
    function findingElement(finding) {
      const item = document.createElement('div')
      item.className = `dpg-finding ${tone(finding.severity)}`
      const heading = document.createElement('div')
      heading.className = 'dpg-finding-title'
      heading.textContent = `${severityLabel(finding.severity)} · ${finding.title ?? ''}`
      const rule = document.createElement('span')
      rule.className = 'dpg-rule'
      rule.textContent = finding.rule ?? ''
      heading.appendChild(rule)
      item.appendChild(heading)
      const detail = document.createElement('div')
      detail.className = 'dpg-detail'
      detail.textContent = finding.detail ?? ''
      item.appendChild(detail)
      if (finding.evidence !== undefined) {
        const evidence = document.createElement('div')
        evidence.className = 'dpg-evidence'
        evidence.textContent = `${String(finding.evidence.required)} ← ${String(finding.evidence.actual)}`
        item.appendChild(evidence)
      }
      return item
    }

    /** Shared modal shell: returns the overlay plus a finish() that resolves. */
    function openModal() {
      injectStyles()
      const overlay = document.createElement('div')
      overlay.className = 'dpg-overlay'
      const modal = document.createElement('div')
      modal.className = 'dpg-modal'
      overlay.appendChild(modal)
      return { overlay, modal }
    }

    /** Close helper that also drops the key listener. */
    function closer(overlay, onKey, done) {
      return (value) => {
        document.removeEventListener('keydown', onKey)
        overlay.remove()
        done(value)
      }
    }

    /**
     * Ask the user how to proceed with a non-clean precheck report.
     * @param report - the precheck report from the host half.
     * @returns the chosen action: cancel, force, or a concrete version.
     */
    function askDecision(report) {
      const { overlay, modal } = openModal()
      const blocked = report.verdict === 'blocker'

      const head = document.createElement('div')
      head.className = 'dpg-modal-head'
      const chip = document.createElement('div')
      chip.className = `dpg-chip ${blocked ? 'blocker' : 'warn'}`
      chip.textContent = blocked ? '阻断' : '警告'
      head.appendChild(chip)
      const title = document.createElement('div')
      title.className = 'dpg-title'
      title.textContent = `插件预检：${report.resolved?.name ?? report.spec}`
      head.appendChild(title)
      const sub = document.createElement('div')
      sub.className = 'dpg-sub'
      sub.textContent = `${report.spec}${report.resolved?.version === undefined ? '' : ` → ${report.resolved.version}`} · DSH ${report.environment?.dshVersion ?? '未知'}`
      head.appendChild(sub)
      modal.appendChild(head)

      const body = document.createElement('div')
      body.className = 'dpg-body'
      for (const finding of report.findings ?? []) body.appendChild(findingElement(finding))
      modal.appendChild(body)

      const versions = report.resolved?.versions ?? []
      let select
      if (versions.length > 0) {
        const picker = document.createElement('div')
        picker.className = 'dpg-row'
        picker.style.padding = '0 18px'
        select = document.createElement('select')
        select.className = 'dpg-select'
        for (const version of versions) {
          const option = document.createElement('option')
          option.value = version
          option.textContent = version
          if (version === report.resolved?.version) option.selected = true
          select.appendChild(option)
        }
        picker.appendChild(document.createTextNode('装指定版本'))
        picker.appendChild(select)
        modal.appendChild(picker)
      }

      const foot = document.createElement('div')
      foot.className = 'dpg-foot'
      const note = document.createElement('span')
      note.className = 'dpg-hint'
      note.style.marginRight = 'auto'
      note.textContent = '继续前自动快照 profile'
      foot.appendChild(note)
      modal.appendChild(foot)

      return new Promise((resolve) => {
        const onKey = (event) => {
          if (event.key === 'Escape') finish({ action: 'cancel' })
        }
        const finish = closer(overlay, onKey, resolve)
        const button = (label, className, onClick) => {
          const element = document.createElement('button')
          element.className = `dpg-btn ${className}`
          element.textContent = label
          element.addEventListener('click', onClick)
          foot.appendChild(element)
          return element
        }
        button('取消', '', () => finish({ action: 'cancel' }))
        if (select !== undefined) button('用所选版本安装', '', () => finish({ action: 'version', version: select.value }))
        button(blocked ? '仍然继续' : '继续安装', 'primary', () => finish({ action: 'force' }))
        overlay.addEventListener('click', (event) => {
          if (event.target === overlay) finish({ action: 'cancel' })
        })
        document.addEventListener('keydown', onKey)
        document.body.appendChild(overlay)
      })
    }

    /** A single-button modal for a warning the user must not miss. */
    function warnModal(title, findings, footer) {
      const { overlay, modal } = openModal()
      const head = document.createElement('div')
      head.className = 'dpg-modal-head'
      const chip = document.createElement('div')
      chip.className = 'dpg-chip blocker'
      chip.textContent = '自检未通过'
      head.appendChild(chip)
      const heading = document.createElement('div')
      heading.className = 'dpg-title'
      heading.textContent = title
      head.appendChild(heading)
      if (footer !== undefined) {
        const sub = document.createElement('div')
        sub.className = 'dpg-sub'
        sub.textContent = footer
        head.appendChild(sub)
      }
      modal.appendChild(head)
      const body = document.createElement('div')
      body.className = 'dpg-body'
      for (const finding of findings) body.appendChild(findingElement(finding))
      modal.appendChild(body)
      const foot = document.createElement('div')
      foot.className = 'dpg-foot'
      modal.appendChild(foot)
      return new Promise((resolve) => {
        const onKey = (event) => {
          if (event.key === 'Escape') finish()
        }
        const finish = () => {
          document.removeEventListener('keydown', onKey)
          overlay.remove()
          resolve(undefined)
        }
        const close = document.createElement('button')
        close.className = 'dpg-btn primary'
        close.textContent = '知道了'
        close.addEventListener('click', finish)
        foot.appendChild(close)
        overlay.addEventListener('click', (event) => {
          if (event.target === overlay) finish()
        })
        document.addEventListener('keydown', onKey)
        document.body.appendChild(overlay)
      })
    }

    /**
     * Snapshot the profile immediately before an install is allowed through, so
     * a restore point always exists.
     * @param spec - the spec about to be installed.
     * @returns the same spec, so callers can chain.
     */
    async function snapshotThen(spec) {
      try {
        await call('/snapshot', { method: 'POST', body: JSON.stringify({ spec }) })
      } catch (error) {
        console.warn('[plugin-guard] pre-install snapshot failed:', error instanceof Error ? error.message : String(error))
      }
      return spec
    }

    /**
     * Run the precheck gate for one spec.
     * @param spec - the npm spec or local path about to be installed.
     * @param depth - re-entry guard for the "install a chosen version" path.
     * @returns the spec that should actually be installed.
     */
    async function gate(spec, depth = 0) {
      let report
      try {
        report = (await call('/precheck', { method: 'POST', body: JSON.stringify({ spec }) })).report
      } catch (error) {
        report = {
          spec,
          verdict: 'warn',
          resolved: {},
          environment: {},
          findings: [
            {
              rule: 'precheck-error',
              severity: 'warn',
              title: '预检不可用',
              detail: error instanceof Error ? error.message : String(error),
              evidence: { required: '安装前静态预检', actual: '网关调用失败' },
            },
          ],
        }
      }
      if (report.verdict === 'ok') return snapshotThen(spec)
      const decision = await askDecision(report)
      if (decision.action === 'cancel') throw new Error('插件守卫：已取消安装')
      const name = report.resolved?.name
      const chosen =
        decision.action === 'version' && typeof decision.version === 'string' && typeof name === 'string' && name !== ''
          ? `${name}@${decision.version}`
          : spec
      if (decision.action === 'version' && chosen !== spec && depth < 3) return gate(chosen, depth + 1)
      try {
        await call('/skip', { method: 'POST', body: JSON.stringify({ spec, report, targetVersion: decision.version }) })
      } catch {}
      return snapshotThen(chosen)
    }

    /**
     * After an install, ask the host whether the graph it will serve is still
     * loadable. A broken graph turns the whole Web GUI into a banner.
     * @param spec - the spec that was just installed.
     */
    async function smokeAfterInstall(spec) {
      try {
        const report = await call('/bootcheck')
        if (report.verdict === 'pass') return
        const problems = [...(report.live?.findings ?? []), ...(report.static?.findings ?? [])].filter((finding) => finding.severity === 'blocker')
        if (problems.length === 0) return
        console.error('[plugin-guard] post-install boot check failed:', problems)
        await warnModal(`刚装的 ${spec} 可能让下次启动失败`, problems.slice(0, 6), '已自动快照；可用 dsh-plugin-guard restore latest 回到安装前。')
      } catch (error) {
        console.warn('[plugin-guard] post-install boot check unavailable:', error instanceof Error ? error.message : String(error))
      }
    }

    /**
     * Wrap the shared `pluginManager` service so no caller can install without
     * passing the gate. The service is provided by the plugin-manager plugin;
     * cordis resolves the injection when (and if) it appears.
     */
    function wrapManager(ctx) {
      ctx.inject(['pluginManager'], (inner) => {
        const face = inner.pluginManager
        if (face === null || face === undefined || typeof face.install !== 'function') {
          // Never fail silently: a gate that is not installed looks identical to
          // a gate that works, which is exactly the illusion this guards against.
          gateState.reason = 'pluginManager 服务没有可包裹的 install 方法'
          return
        }
        if (face[WRAP_FLAG] === true) {
          gateState.reason = ''
          gateState.verify = () => face.install === gateState.wrapper
          return
        }
        const originalInstall = face.install.bind(face)
        const wrapped = async (spec) => {
          const chosen = await gate(String(spec))
          const result = await originalInstall(chosen)
          void smokeAfterInstall(chosen)
          return result
        }
        face.install = wrapped
        Object.defineProperty(face, WRAP_FLAG, { value: true, enumerable: false })
        gateState.wrapper = wrapped
        gateState.reason = ''
        gateState.verify = () => face.install === wrapped
      }, 'plugin-guard: gate pluginManager.install')
    }

    /** Small hook that loads one gateway route on mount. */
    function useGateway(path, init) {
      const [state, setState] = react.useState({ loading: true, data: undefined, error: undefined })
      const load = react.useCallback(() => {
        call(path, init)
          .then((data) => setState({ loading: false, data, error: undefined }))
          .catch((error) => setState({ loading: false, data: undefined, error: error instanceof Error ? error.message : String(error) }))
      }, [path])
      react.useEffect(load, [load])
      return { ...state, reload: load }
    }

    /** Build one `value/label` cell. */
    function stat(label, value) {
      return e('div', { className: 'dpg-stat', key: label }, e('div', { className: 'dpg-stat-value' }, value), e('div', { className: 'dpg-stat-label' }, label))
    }

    /** Build one status dot. */
    function dotNode(label, on) {
      return e('span', { className: `dpg-dot${on ? ' on' : ''}`, key: label }, label)
    }

    /** The 插件守卫 settings tab. */
    function GuardTab() {
      injectStyles()
      const status = useGateway('/status')
      const history = useGateway('/history')
      const [busy, setBusy] = react.useState(undefined)
      const [message, setMessage] = react.useState(undefined)
      const [spec, setSpec] = react.useState('')
      const [report, setReport] = react.useState(undefined)
      const [checking, setChecking] = react.useState(false)
      const [selfCheck, setSelfCheck] = react.useState(undefined)
      const [running, setRunning] = react.useState(undefined)

      const note = (text) => setMessage(text)

      const runPrecheck = () => {
        const wanted = spec.trim()
        if (wanted === '' || checking) return
        setChecking(true)
        setReport(undefined)
        call('/precheck', { method: 'POST', body: JSON.stringify({ spec: wanted }) })
          .then((result) => setReport(result.report))
          .catch((error) =>
            setReport({
              spec: wanted,
              verdict: 'warn',
              resolved: {},
              findings: [{ rule: 'precheck-error', severity: 'warn', title: '预检失败', detail: error instanceof Error ? error.message : String(error) }],
            }),
          )
          .then(() => setChecking(false))
      }

      const runCheck = (kind) => {
        if (running !== undefined) return
        setRunning(kind)
        setSelfCheck(undefined)
        call(kind === 'config' ? '/configcheck' : '/bootcheck', { method: 'POST', body: JSON.stringify({}) })
          .then((result) => setSelfCheck({ kind, ok: result.verdict === 'pass', result }))
          .catch((error) => setSelfCheck({ kind, ok: false, error: error instanceof Error ? error.message : String(error) }))
          .then(() => setRunning(undefined))
      }

      const rollback = (row) => {
        const target = window.prompt(`把 ${row.name} 回退到哪个版本？`, String(row.lastGood ?? row.installedVersion ?? ''))
        if (target === null || target.trim() === '') return
        setBusy(row.name)
        note(`回退 ${row.name}@${target.trim()} …`)
        call('/rollback', { method: 'POST', body: JSON.stringify({ name: row.name, version: target.trim() }) })
          .then((result) => {
            note(`✓ ${row.name} → ${target.trim()}，重启后生效`)
            history.reload()
            return result
          })
          .catch((error) => note(`× 回退失败：${error instanceof Error ? error.message : String(error)}`))
          .then(() => setBusy(undefined))
      }

      const backupNow = () => {
        note('备份中 …')
        call('/backup', { method: 'POST', body: JSON.stringify({ reason: 'settings tab' }) })
          .then(() => {
            note('✓ 已备份')
            status.reload()
            history.reload()
          })
          .catch((error) => note(`× 备份失败：${error instanceof Error ? error.message : String(error)}`))
      }

      const toggleAutostart = (current) => {
        note(current ? '关闭守护进程 …' : '开启守护进程 …')
        call('/autostart', { method: 'POST', body: JSON.stringify({ enabled: !current }) })
          .then(() => {
            note(current ? '✓ 已关闭：守护进程已停止，重启电脑或下次启动 DSH 都不会再拉起' : '✓ 已开启：守护进程现在就在跑，登录后也会自动拉起')
            status.reload()
          })
          .catch((error) => note(`× 设置失败：${error instanceof Error ? error.message : String(error)}`))
      }

      const restore = (id) => {
        if (window.confirm(`用备份 ${id} 覆盖当前 profile 的清单与补丁？重启后生效。`) !== true) return
        note(`还原 ${id} …`)
        call('/restore', { method: 'POST', body: JSON.stringify({ id }) })
          .then((result) => {
            note(`✓ 已还原 ${(result.files ?? []).join('、')}`)
            status.reload()
            history.reload()
          })
          .catch((error) => note(`× 还原失败：${error instanceof Error ? error.message : String(error)}`))
      }

      const removeBackup = (id) => {
        if (window.confirm(`删除备份 ${id}？删除后无法再用它还原。`) !== true) return
        note(`删除备份 ${id} …`)
        call('/backup-delete', { method: 'POST', body: JSON.stringify({ id }) })
          .then(() => {
            note(`✓ 已删除备份 ${id}`)
            status.reload()
            history.reload()
          })
          .catch((error) => note(`× 删除失败：${error instanceof Error ? error.message : String(error)}`))
      }

      const findingNodes = (findings, prefix) =>
        (findings ?? []).map((finding, index) =>
          e(
            'div',
            { key: `${prefix}-${String(index)}`, className: `dpg-finding ${tone(finding.severity)}` },
            e(
              'div',
              { className: 'dpg-finding-title' },
              `${severityLabel(finding.severity)} · ${String(finding.title ?? '')}`,
              e('span', { className: 'dpg-rule' }, String(finding.rule ?? '')),
            ),
            e('div', { className: 'dpg-detail' }, String(finding.detail ?? '')),
            finding.evidence === undefined ? null : e('div', { className: 'dpg-evidence' }, `${String(finding.evidence.required)} ← ${String(finding.evidence.actual)}`),
          ),
        )

      const renderSelfCheck = (state) => {
        if (state.error !== undefined) return e('div', { className: 'dpg-error' }, state.error)
        if (state.kind === 'config') {
          const config = state.result.report ?? {}
          return e(
            'div',
            { className: 'dpg-list' },
            e(
              'div',
              { className: state.ok ? 'dpg-ok' : 'dpg-error' },
              `配置 ${state.ok ? '通过' : '有问题'} · 校验 ${String(config.checked ?? 0)} / 非法 ${String(config.invalid ?? 0)} / 未校验 ${String(config.unchecked ?? 0)}`,
            ),
            ...findingNodes(config.findings, 'cfg'),
          )
        }
        const live = state.result.live ?? {}
        const stat = state.result.static ?? {}
        return e(
          'div',
          { className: 'dpg-list' },
          e(
            'div',
            { className: state.ok ? 'dpg-ok' : 'dpg-error' },
            `启动检测 ${state.ok ? '通过' : '有问题'} · ${live.available === false ? '非 web 运行' : `entries ${String(live.counts?.entries ?? 0)} / batches ${String(live.counts?.batches ?? 0)}`} · 静态 ${String((stat.packages ?? []).length)} 包`,
          ),
          ...findingNodes(live.findings, 'live'),
          ...findingNodes(stat.findings, 'stat'),
        )
      }

      const s = status.data
      const gateActive = gateState.verify()
      const autostartOn = s?.autostart?.enabled === true
      const rows = history.data?.rows ?? []
      const backups = history.data?.backups ?? []
      const records = [
        ...(history.data?.rollbacks ?? []).map((entry) => ({ at: entry.at, label: `${entry.ok === true ? '回退' : '回退失败'} ${entry.name} ${entry.from ?? '?'}→${entry.to}` })),
        ...(history.data?.restores ?? []).map((entry) => ({ at: entry.at, label: `还原 ${entry.backup}` })),
        ...(history.data?.skips ?? { entries: [] }).entries.map((entry) => ({ at: entry.at, label: `跳过警告 ${entry.spec}` })),
      ]
        .sort((left, right) => String(right.at).localeCompare(String(left.at)))
        .slice(0, 6)

      return e(
        'div',
        { className: 'dpg-tab' },
        e(
          'div',
          { className: 'dpg-section' },
          e(
            'div',
            { className: 'dpg-section-head' },
            e('h4', { className: 'dpg-section-title' }, '插件守卫'),
            e(
              'div',
              { className: 'dpg-actions' },
              e('button', { className: 'dpg-btn small', onClick: () => { status.reload(); history.reload() } }, '刷新'),
              e('button', { className: 'dpg-btn small', onClick: backupNow }, '备份'),
            ),
          ),
          e(
            'div',
            { className: 'dpg-card' },
            status.error !== undefined ? e('div', { className: 'dpg-error' }, status.error) : null,
            e(
              'div',
              { className: 'dpg-stats' },
              stat('profile', s?.profile?.name ?? '—'),
              stat('DSH', s?.dshVersion ?? '—'),
              stat('已装插件', s === undefined ? '—' : String(s.installedCount)),
              stat('配置行', s === undefined ? '—' : String(s.rowCount)),
              stat('备份', s === undefined ? '—' : String((s.backups ?? []).length)),
            ),
            e(
              'div',
              { className: 'dpg-status' },
              dotNode('CLI', s?.cliAvailable === true),
              dotNode('客户端服务', s?.clientModulesAvailable === true),
              dotNode('数据目录', s?.dshHome !== undefined),
              dotNode('安装拦截', gateActive),
              dotNode('崩溃监视', s?.watchdog?.running === true),
            ),
            gateActive ? null : e('p', { className: 'dpg-hint' }, `安装拦截未生效：${gateState.reason}`),
            s?.watchdog !== undefined && s.watchdog.enabled === true && s.watchdog.running !== true
              ? e('p', { className: 'dpg-hint' }, '崩溃监视已开启但守护进程未在运行：下一次成功启动会重新拉起；要立刻拉起见终端 `dsh-plugin-guard watchdog on`。')
              : null,
            e(
              'div',
              { className: 'dpg-switch-row' },
              e(
                'label',
                { className: 'dpg-switch' },
                e('input', {
                  type: 'checkbox',
                  checked: autostartOn,
                  disabled: s === undefined,
                  onChange: () => toggleAutostart(autostartOn),
                }),
                e('span', {}, '常驻守护进程（开机自启）'),
              ),
              e(
                'span',
                { className: 'dpg-hint' },
                autostartOn
                  ? '已开启：守护进程现在就在跑，登录后也会自动拉起（不启动 DSH、不改你的启动方式）。'
                  : '已关闭：守护进程已停止，重启电脑或下次启动 DSH 都不会再拉起——崩溃时就没人弹窗了，要恢复请再打开这个开关。',
              ),
            ),
            message === undefined ? null : e('p', { className: 'dpg-hint' }, message),
          ),
        ),
        e(
          'div',
          { className: 'dpg-section' },
          e('h4', { className: 'dpg-section-title' }, '安装预检'),
          e(
            'div',
            { className: 'dpg-row' },
            e('input', {
              className: 'dpg-input',
              style: { flex: '1 1 240px' },
              value: spec,
              placeholder: '包名 / 包名@版本 / 本地路径',
              onChange: (event) => setSpec(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') runPrecheck()
              },
            }),
            e('button', { className: 'dpg-btn primary', disabled: checking, onClick: runPrecheck }, checking ? '预检中…' : '预检'),
          ),
          report === undefined
            ? null
            : e(
                'div',
                { className: 'dpg-list' },
                e(
                  'div',
                  { className: report.verdict === 'blocker' ? 'dpg-error' : report.verdict === 'warn' ? 'dpg-chip warn' : 'dpg-ok' },
                  `${report.verdict === 'blocker' ? '阻断' : report.verdict === 'warn' ? '警告' : '通过'} · ${report.resolved?.kind ?? '?'} ${report.resolved?.name ?? ''}${report.resolved?.version === undefined ? '' : `@${report.resolved.version}`}`,
                ),
                ...findingNodes(report.findings, 'pc'),
              ),
        ),
        e(
          'div',
          { className: 'dpg-section' },
          e(
            'div',
            { className: 'dpg-section-head' },
            e('h4', { className: 'dpg-section-title' }, '自检'),
            e(
              'div',
              { className: 'dpg-actions' },
              e('button', { className: 'dpg-btn small', disabled: running !== undefined, onClick: () => runCheck('config') }, running === 'config' ? '配置中…' : '配置'),
              e('button', { className: 'dpg-btn small', disabled: running !== undefined, onClick: () => runCheck('boot') }, running === 'boot' ? '检测中…' : '启动检测'),
            ),
          ),
          selfCheck === undefined ? null : renderSelfCheck(selfCheck),
        ),
        e(
          'div',
          { className: 'dpg-section' },
          e('h4', { className: 'dpg-section-title' }, '版本历史与回退'),
          rows.length === 0
            ? e('p', { className: 'dpg-hint' }, '每次成功启动记录一次。')
            : e(
                'ul',
                { className: 'dpg-list' },
                ...rows.map((row) =>
                  e(
                    'li',
                    { key: row.name, className: 'dpg-item' },
                    e(
                      'div',
                      { className: 'dpg-item-main' },
                      e('div', { className: 'dpg-item-title' }, row.name),
                      e(
                        'div',
                        { className: 'dpg-item-sub' },
                        e('span', null, `当前 ${row.installedVersion ?? '未装'}`),
                        e('span', null, `上次可用 ${row.lastGood ?? '—'}`),
                        (row.versions ?? []).length > 1 ? e('span', { className: 'dpg-badge' }, `${String(row.versions.length)} 个版本`) : null,
                      ),
                    ),
                    e(
                      'div',
                      { className: 'dpg-actions' },
                      e('button', { className: 'dpg-btn small', disabled: busy === row.name, onClick: () => rollback(row) }, busy === row.name ? '回退中…' : '回退'),
                    ),
                  ),
                ),
              ),
        ),
        e(
          'div',
          { className: 'dpg-section' },
          e('h4', { className: 'dpg-section-title' }, '备份'),
          backups.length === 0
            ? e('p', { className: 'dpg-hint' }, '安装前会自动快照。')
            : e(
                'ul',
                { className: 'dpg-list' },
                ...backups.slice(0, 12).map((entry) =>
                  e(
                    'li',
                    { key: entry.id, className: 'dpg-item' },
                    e(
                      'div',
                      { className: 'dpg-item-main' },
                      e('div', { className: 'dpg-item-title' }, entry.reason ?? entry.id),
                      e(
                        'div',
                        { className: 'dpg-item-sub' },
                        e('span', { className: 'dpg-badge' }, entry.kind === 'auto' ? '自动' : '手动'),
                        e('span', null, `${String((entry.files ?? []).length)} 个文件`),
                        e('span', { className: 'dpg-mono' }, String(entry.at ?? '')),
                      ),
                    ),
                    e(
                      'div',
                      { className: 'dpg-actions' },
                      e('button', { className: 'dpg-btn small', onClick: () => restore(entry.id) }, '还原'),
                      e('button', { className: 'dpg-btn small danger', onClick: () => removeBackup(entry.id) }, '删除'),
                    ),
                  ),
                ),
              ),
        ),
        e(
          'div',
          { className: 'dpg-section' },
          e('h4', { className: 'dpg-section-title' }, '记录'),
          records.length === 0
            ? e('p', { className: 'dpg-hint' }, '暂无记录。')
            : e(
                'ul',
                { className: 'dpg-log' },
                ...records.map((record, index) =>
                  e('li', { key: `${record.at}-${String(index)}`, className: 'dpg-log-item' }, e('span', { className: 'dpg-log-title' }, record.label), e('span', { className: 'dpg-mono' }, String(record.at ?? ''))),
                ),
              ),
        ),
      )
    }

    /** Register the tab; tolerate a slot definition drift instead of throwing. */
    function registerTab(ctx) {
      ctx.slots.inject('settings.plugins.tab', () => {
        try {
          return ctx.slots.register(
            {
              name: 'settings.plugins.tab',
              id: 'plugin-guard',
              order: 30,
              label: () => '插件守卫',
              inject: () => ({}),
            },
            GuardTab,
          )
        } catch (error) {
          console.warn('[plugin-guard] tab registration failed:', error instanceof Error ? error.message : String(error))
          return () => {}
        }
      })
    }

    /** Client half entry point. */
    function apply(ctx) {
      try {
        wrapManager(ctx)
      } catch (error) {
        gateState.reason = `包裹 pluginManager 失败：${error instanceof Error ? error.message : String(error)}`
        console.warn('[plugin-guard] install gate unavailable:', gateState.reason)
      }
      try {
        registerTab(ctx)
      } catch (error) {
        console.warn('[plugin-guard] tab unavailable:', error instanceof Error ? error.message : String(error))
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.gate = gate
    return module.exports
  },
})
