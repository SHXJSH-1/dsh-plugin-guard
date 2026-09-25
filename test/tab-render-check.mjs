/**
 * Render check for the guard's settings tab, run outside the browser.
 *
 * It stubs `window.__ModuleLoader__` (the bundle's envelope), a fake `react`
 * with the hooks the tab uses, and a fake fetch. Calling the registered tab
 * component then executes the real render path, which is what catches the class
 * of bug a screenshot cannot: a component that throws while rendering (dead
 * reference, temporal-dead-zone, missing prop).
 *
 * Usage: node tab-render-check.mjs <path to client.js>
 */
const target = process.argv[2]
if (target === undefined) {
  console.error('usage: node tab-render-check.mjs <client.js>')
  process.exit(2)
}
const { pathToFileURL } = await import('node:url')

const loaded = []
const warnings = []
globalThis.window = {
  __ModuleLoader__: { load: (definition) => loaded.push(definition) },
  addEventListener() {},
  removeEventListener() {},
  confirm: () => true,
  location: { href: 'http://localhost:3000/' },
  navigator: { userAgent: 'node-render-check' },
}
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '', style: {}, setAttribute() {}, appendChild() {}, remove() {} }),
  head: { appendChild() {} },
  body: { appendChild() {} },
  addEventListener() {},
}
globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => ({ ok: true }) })

const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (factory) => factory,
  useRef: (value) => ({ current: value }),
  Fragment: 'Fragment',
}
const originalWarn = console.warn
console.warn = (...args) => warnings.push(args.map(String).join(' '))

await import(pathToFileURL(target).href)
if (loaded.length !== 1) {
  console.error(`FAIL: expected exactly one __ModuleLoader__.load call, got ${String(loaded.length)}`)
  process.exit(1)
}
const mod = loaded[0].factory((name) => {
  if (name === 'react') return react
  throw new Error(`unexpected require(${name})`)
})

let Tab
const ctx = {
  slots: {
    inject: (_slot, callback) => callback(),
    register: (_options, component) => {
      Tab = component
      return () => {}
    },
  },
  get: () => undefined,
  on: () => {},
  effect: (fn) => { try { fn() } catch {} },
  inject: () => {},
  logger: { info() {}, warn() {}, error() {} },
}
mod.apply(ctx)
console.warn = originalWarn

if (typeof Tab !== 'function') {
  console.error('FAIL: the tab component was never registered')
  process.exit(1)
}

let tree
try {
  tree = Tab({})
} catch (error) {
  console.error(`FAIL: rendering the tab threw: ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
}

const texts = []
const inputs = []
const walk = (node, depth = 0) => {
  if (node === null || node === undefined || depth > 40) return
  if (typeof node === 'string' || typeof node === 'number') {
    texts.push(String(node))
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, depth + 1)
    return
  }
  if (typeof node.type === 'function') {
    // A nested component (a button renderer, a card): call it the way React would.
    try {
      walk(node.type(node.props ?? {}), depth + 1)
    } catch (error) {
      console.error(`FAIL: a nested component threw: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    }
    return
  }
  if (node.type === 'input') inputs.push(node)
  for (const child of [].concat(node.props?.children ?? [])) walk(child, depth + 1)
}

try {
  walk(tree)
} catch (error) {
  console.error(`FAIL: walking the rendered tree threw: ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
}

const checkbox = inputs.find((input) => input.props?.type === 'checkbox')
const label = texts.some((text) => text.includes('守护进程'))
const hint = texts.some((text) => text.includes('守护进程现在就在跑') || text.includes('守护进程已停止'))
const wired = typeof checkbox?.props?.onChange === 'function'

console.log(`rendered nodes: ${String(texts.length)} texts, ${String(inputs.length)} inputs`)
console.log(`  switch label present : ${String(label)}`)
console.log(`  checkbox present     : ${String(checkbox !== undefined)}`)
console.log(`  checkbox wired       : ${String(wired)}`)
console.log(`  hint text present    : ${String(hint)}`)
if (warnings.length > 0) console.log(`  warnings: ${warnings.slice(0, 3).join(' | ')}`)
if (label && checkbox !== undefined && wired && hint) {
  console.log('PASS')
  process.exit(0)
}
console.error('FAIL: the autostart switch is not fully present in the rendered tab')
process.exit(1)
