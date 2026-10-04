// Exercise the client half without a browser.
//
// The panel's navigation was added on 2026-10-04 after a live audit found that the
// projection carries no member activity (`{id, name, role, phase, error?}` and nothing
// else) and that the panel offered no way into a member's session. The first version of
// this panel shipped with two Theme tokens that do not exist — `state-warning-primary`
// and `state-danger-primary` — which made its chips render with a transparent
// background. Nothing caught it, because nothing had ever run this file.
//
// So this harness does the cheap part of a browser test: load `client.js` with a stubbed
// module loader and a stub React that renders the element tree, reach into the registered
// slot component, and assert on the result. It cannot judge appearance; it can judge
// structure, wiring and the navigation call.
//
// Usage: node test/client-half.test.js   (or `node --test test/*.test.js`)

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = readFileSync(join(ROOT, 'client.js'), 'utf8')

/**
 * A React stub that renders `createElement` trees into plain JSON-ish nodes.
 *
 * Hooks are backed by module-level slot arrays that the test resets per render pass:
 * effects run inline (so `ctx.effect` disposal is observable), and `useSessions`
 * reads a value the test installs. That is enough to drive the component's render
 * path and its event handlers, which is what these assertions are about.
 */
function makeHarness({ team, binding, sessions }) {
  const effects = []
  let sessionStore = { projectionsBySession: {} }
  const hookState = []
  let hookCursor = 0

  const React = {
    createElement: (type, props, ...children) =>
      ({ type, props: props ?? {}, children: children.flat().filter((child) => child !== null && child !== undefined && child !== false) }),
    useState: (initial) => {
      const at = hookCursor++
      if (!(at in hookState)) hookState[at] = initial
      const set = (next) => { hookState[at] = typeof next === 'function' ? next(hookState[at]) : next }
      return [hookState[at], set]
    },
    useRef: (initial) => {
      const at = hookCursor++
      if (!(at in hookState)) hookState[at] = { current: initial }
      // The panel measures the trigger at click time to place itself under it.
      if (hookState[at].current === null && initial === null) {
        hookState[at].current = { getBoundingClientRect: () => ({ bottom: 40, left: 100 }) }
      }
      return hookState[at]
    },
    useEffect: (fn) => {
      const at = hookCursor++
      hookState[at] = fn
    },
  }

  let registered = null
  const slots = {
    // `inject(key, () => register(options, Component))` — the callback's return value is
    // what the runtime records, so `register` mirrors that contract by returning options.
    inject: (ownerKey, register) => {
      const options = register()
      registered = { ownerKey, options, component: slots.lastComponent }
    },
    lastComponent: null,
    register: (options, component) => { slots.lastComponent = component; return options },
  }

  const ctx = {
    sessions: { binding: (id) => binding(id) },
    uiWorkspace: {
      calls: [],
      openSession(target) { this.calls.push(target) },
    },
    slots,
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
    },
    effect: (fn) => { effects.push(fn()) },
  }

  // The module loader is the browser's; give it one that just calls the factory.
  let exported = null
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ factory }) => { exported = factory((name) => (name === 'react' ? React : {})) },
    },
  }
  globalThis.document = {
    createElement: () => ({ setAttribute() {}, textContent: '' }),
    head: { append() {} },
    addEventListener() {},
    removeEventListener() {},
  }

  // eslint-disable-next-line no-eval
  const run = new Function('window', 'document', 'console', `${SOURCE}\nreturn undefined`)
  run(globalThis.window, globalThis.document, { log() {} })

  return {
    exported,
    ctx,
    effects,
    get registered() { return registered },
    /**
     * Render the registered component with `props`, resetting hook slots first.
     * The slot's own `inject` face is included, because that is where `tr`, `leadOf`
     * and `openMember` come from — the runtime spreads it into the component props.
     */
    render(props) {
      hookCursor = 0
      const injected = registered.options.inject?.() ?? {}
      return registered.component({ sessionId: 'lead-1', useSessions: (select) => select(sessionStore), ...injected, ...props })
    },
    setSessionStore(next) { sessionStore = next },
    /**
     * Render, then click the trigger, then render again.
     * Rows only exist while the panel is open, so every row assertion starts here.
     */
    open(props = {}) {
      const before = this.render(props)
      // Run the mount effects once, as React does on commit. They are NOT re-run after
      // the click: React only re-runs an effect whose dependencies changed, and the
      // panel's `[sessionId]` effect would otherwise fire again and close what we opened.
      this.runEffects()
      const trigger = find(before, (node) => node.props?.className === 'qrm-trigger')
      if (trigger === undefined) return before
      trigger.props.onClick()
      return this.render(props)
    },
    /** Run the effect callbacks the component registered on its last render. */
    runEffects() {
      for (const entry of hookState) if (typeof entry === 'function') entry()
    },
  }
}

/** Walk a rendered tree for the first node satisfying `predicate`. */
function find(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const hit = find(child, predicate)
    if (hit !== undefined) return hit
  }
  return undefined
}

const member = (id, name, role, phase) => ({ id, name, role, phase })
const TEAM = {
  members: [member('lead-1', 'lead', 'lead', 'active'), member('child-1', 'reviewer', 'teammate', 'active')],
  tasks: [],
}

// ── the module contract ───────────────────────────────────────────────────────

test('client half declares the services it needs, including uiWorkspace', () => {
  const h = makeHarness({
    team: TEAM,
    binding: () => undefined,
    sessions: {},
  })
  assert.deepEqual(h.exported.inject, ['sessions', 'uiWorkspace', 'slots', 'locale'])
  assert.equal(typeof h.exported.apply, 'function')
})

test('apply registers one header action and returns a locale disposer through ctx.effect', () => {
  const h = makeHarness({ team: TEAM, binding: () => undefined, sessions: {} })
  h.exported.apply(h.ctx)
  assert.equal(h.registered.ownerKey, 'conversation.session.header.actions')
  assert.equal(h.registered.options.id, 'quorum')
  assert.equal(h.registered.options.name, 'conversation.session.header.actions')
  assert.equal(h.effects.length, 1, 'dictionary registration must be an effect, so it is disposed with the plugin')
})

// ── rendering ─────────────────────────────────────────────────────────────────

test('renders nothing at all when the session has no Team projection', () => {
  const h = makeHarness({ team: TEAM, binding: () => undefined, sessions: {} })
  h.exported.apply(h.ctx)
  h.setSessionStore({ projectionsBySession: {} })
  assert.equal(h.render({}), null)
})

test('a teammate row is openable and the Lead row is not', () => {
  const h = makeHarness({ team: TEAM, binding: () => undefined, sessions: {} })
  h.exported.apply(h.ctx)
  h.setSessionStore({ projectionsBySession: { 'lead-1': { values: { agentTeam: TEAM } } } })
  const tree = h.open()

  const rows = []
  const collect = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(collect)
    if (node.props?.className === 'qrm-row') rows.push(node)
    ;(node.children ?? []).forEach(collect)
  }
  collect(tree)

  assert.equal(rows.length, 2, 'one row per rostered member')
  const [lead, reviewer] = rows
  assert.equal(lead.props['data-openable'], 'no')
  assert.equal(lead.props.role, undefined, 'the Lead row navigates to the session the panel is already in')
  assert.equal(reviewer.props['data-openable'], 'yes')
  assert.equal(reviewer.props.role, 'button')
  assert.equal(reviewer.props.tabIndex, 0, 'a clickable row must be keyboard reachable')
  assert.equal(typeof reviewer.props.onClick, 'function')
  assert.equal(typeof reviewer.props.onKeyDown, 'function')
})

// ── navigation ────────────────────────────────────────────────────────────────

test('clicking a teammate opens its own session through the durable parent address', () => {
  // No binding at all: this is the live case. A member spawned after the last page
  // load has never been loaded into the browser store, and the first version of
  // this panel read its address from `binding(memberId)` — so an ACTIVE member's
  // row refused every click. The address is now constructed and `retain()` loads
  // the child session on demand, which is what the official panel does.
  const h = makeHarness({ team: TEAM, binding: () => undefined, sessions: {} })
  h.exported.apply(h.ctx)
  h.setSessionStore({ projectionsBySession: { 'lead-1': { values: { agentTeam: TEAM } } } })
  const tree = h.open()

  const reviewerRow = find(tree, (node) => node.props?.['data-openable'] === 'yes')
  reviewerRow.props.onClick()
  assert.deepEqual(h.ctx.uiWorkspace.calls, [{
    parentSessionId: 'lead-1',
    childSessionId: 'child-1',
    mode: 'continuable',
  }], 'the panel opens the member session, not the Lead session')
})

test('from a member session, the parent Lead is resolved through its binding', () => {
  // Opened inside a teammate's own conversation, `leadOf` must read the parent from
  // that session's subagent address, not assume the current session is the Lead.
  const h = makeHarness({
    team: TEAM,
    binding: (id) => (id === 'child-1'
      ? { session: { getSnapshot: () => ({ subagent: { address: { parentSessionId: 'lead-9', childSessionId: 'child-1', mode: 'continuable' } } }) } }
      : undefined),
    sessions: {},
  })
  h.exported.apply(h.ctx)
  h.setSessionStore({ projectionsBySession: { 'lead-9': { values: { agentTeam: TEAM } } } })
  const tree = h.open({ sessionId: 'child-1' })

  find(tree, (node) => node.props?.['data-openable'] === 'yes').props.onClick()
  assert.deepEqual(h.ctx.uiWorkspace.calls, [{
    parentSessionId: 'lead-9',
    childSessionId: 'child-1',
    mode: 'continuable',
  }])
})

test('the keyboard path works and ignores other keys', () => {
  const h = makeHarness({ team: TEAM, binding: () => undefined, sessions: {} })
  h.exported.apply(h.ctx)
  h.setSessionStore({ projectionsBySession: { 'lead-1': { values: { agentTeam: TEAM } } } })
  const tree = h.open()
  const row = find(tree, (node) => node.props?.['data-openable'] === 'yes')

  let prevented = 0
  const key = (value) => ({ key: value, preventDefault: () => { prevented += 1 } })
  row.props.onKeyDown(key('a'))
  assert.equal(h.ctx.uiWorkspace.calls.length, 0, 'a plain letter must not navigate')
  assert.equal(prevented, 0)
  row.props.onKeyDown(key('Enter'))
  assert.equal(h.ctx.uiWorkspace.calls.length, 1)
  assert.equal(prevented, 1, 'Enter must not also activate something else')
  row.props.onKeyDown(key(' '))
  assert.equal(h.ctx.uiWorkspace.calls.length, 2, 'Space activates the row too')
})

test('a row navigates even when its session was never loaded in this browser', () => {
  // Regression: the address used to come from `binding(memberId)`, which is
  // undefined for every member spawned since the last page load — including a
  // member that is still running. The click then produced a refusal notice and no
  // navigation. Constructing the durable parent address is what makes the first
  // click work.
  const h = makeHarness({ team: TEAM, binding: () => undefined, sessions: {} })
  h.exported.apply(h.ctx)
  h.setSessionStore({ projectionsBySession: { 'lead-1': { values: { agentTeam: TEAM } } } })
  const tree = h.open()
  find(tree, (node) => node.props?.['data-openable'] === 'yes').props.onClick()

  assert.equal(h.ctx.uiWorkspace.calls.length, 1, 'a never-loaded member session is still openable')
  const afterClick = h.render({})
  assert.equal(find(afterClick, (node) => node.props?.className === 'qrm-notice'), undefined,
    'a successful navigation must not also raise the refusal notice')
})

// ── the visual affordances ────────────────────────────────────────────────────
// These pin the cues that make the panel readable rather than decorative: a status
// dot per teammate, a hidden-from-AT chevron on the rows that navigate, and an
// explicit empty state. None of them can be judged by looking at a tree, but each
// one existing at all is a contract the next edit should have to break on purpose.

test('a teammate row carries a phase dot and the Lead row does not', () => {
  const h = makeHarness({ team: TEAM, binding: () => undefined, sessions: {} })
  h.exported.apply(h.ctx)
  h.setSessionStore({ projectionsBySession: { 'lead-1': { values: { agentTeam: TEAM } } } })
  const tree = h.open()

  const rows = []
  const collect = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(collect)
    if (node.props?.className === 'qrm-row') rows.push(node)
    ;(node.children ?? []).forEach(collect)
  }
  collect(tree)

  const dotIn = (row) => find(row, (node) => node.props?.className === 'qrm-dot')
  const [lead, reviewer] = rows
  assert.equal(dotIn(lead), undefined, 'the Lead is the session you are already in; it gets no status')
  const dot = dotIn(reviewer)
  assert.ok(dot !== undefined, 'a teammate shows its phase as a dot')
  assert.equal(dot.props['data-phase'], 'active', 'the dot is phase-addressed for styling')
  assert.equal(dot.props['aria-hidden'], 'true', 'the phase is already spoken by the text beside it')
})

test('the clickable row shows a chevron, and it is not announced', () => {
  const h = makeHarness({ team: TEAM, binding: () => undefined, sessions: {} })
  h.exported.apply(h.ctx)
  h.setSessionStore({ projectionsBySession: { 'lead-1': { values: { agentTeam: TEAM } } } })
  const tree = h.open()

  const chevron = find(tree, (node) => node.props?.className === 'qrm-go')
  assert.ok(chevron !== undefined, 'the navigating row advertises that it navigates')
  assert.equal(chevron.props['aria-hidden'], 'true', 'the row already carries an aria-label')
})

test('an empty roster says so instead of rendering an empty section', () => {
  const empty = { members: [], tasks: [] }
  const h = makeHarness({ team: empty, binding: () => undefined, sessions: {} })
  h.exported.apply(h.ctx)
  h.setSessionStore({ projectionsBySession: { 'lead-1': { values: { agentTeam: empty } } } })
  const tree = h.open()

  assert.equal(find(tree, (node) => node.props?.className === 'qrm-row'), undefined)
  const none = find(tree, (node) => node.props?.className === 'qrm-none')
  assert.ok(none !== undefined, 'a rostered-but-empty team states that plainly')
  // The harness's `tr` is an identity stub, so this asserts the dictionary KEY was
  // passed through — the copy itself is pinned by the dictionaries.
  assert.equal(none.children[0], 'none')
})

// ── tokens ────────────────────────────────────────────────────────────────────

test('every theme token it styles with is one the running Theme defines', () => {
  // The first version of this panel used `--dsw-alias-state-warning-primary` and
  // `--dsw-alias-state-danger-primary`; neither exists anywhere in the runtime, so the
  // chips' `color-mix()` background resolved to transparent. This cannot check how it
  // looks, but it can refuse a token that is not real.
  //
  // The expected set is READ FROM THE THEME, not hand-listed. A hand-list drifted once
  // already: this test used to wave through eight tokens as "used by the host's own
  // panels", which was an assumption rather than a check — and it named tokens the
  // theme does not define while missing ones it does. The Theme Inspect provider only
  // advertises a curated subset (15), so the definition file is the authority.
  const themeFile = join(
    homedir(), '.hermes/node/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
    'dsh-client-ui-theme/lib/client.js'
  )
  if (!existsSync(themeFile)) {
    // Do not silently pass: a missing authority means this check cannot run.
    assert.fail(`the Theme definition file is not installed, so tokens cannot be verified: ${themeFile}`)
  }
  const defined = new Set(
    (readFileSync(themeFile, 'utf8').match(/--dsw-[a-z0-9-]+(?=:)/g) ?? []).map((t) => t.replace('--dsw-', ''))
  )
  assert.ok(defined.size > 100, 'the Theme definition file parsed into its token set')

  const used = [...new Set(SOURCE.match(/--dsw-[a-z0-9-]+/g) ?? [])]
    .map((token) => token.replace('--dsw-', ''))
    // `--dsw-elevation-prominent,var(--dsw-shadow-lv2)` style lists can leave the regex
    // matching a bare prefix; only a full name followed by `:` is a real definition.
    .filter((token) => !token.endsWith('-'))
  assert.ok(used.length > 0, 'the panel styles itself with theme tokens')
  const unknown = used.filter((token) => !defined.has(token))
  assert.deepEqual(unknown, [], `unknown theme token(s): ${unknown.join(', ')}`)
})

// ── hook order across the early return ────────────────────────────────────────

test('the same mounted component survives the projection arriving late', () => {
  // `QuorumAction` returns null until the `agentTeam` projection exists for this
  // session, so on a cold load the first renders have no Team. React matches hooks by
  // position, and an early `return null` before the hooks would change the count when
  // the projection arrives. Every hook is declared above the return so the count is
  // constant; this pins that, because the failure mode is a blank slot entry and a
  // console error only visible in a browser.
  const h = makeHarness({ team: TEAM, binding: () => undefined, sessions: {} })
  h.exported.apply(h.ctx)

  h.setSessionStore({ projectionsBySession: {} })
  assert.equal(h.render({}), null, 'no projection yet: nothing rendered, no hooks used to decide it')

  h.setSessionStore({ projectionsBySession: { 'lead-1': { values: { agentTeam: TEAM } } } })
  const tree = h.open()
  assert.notEqual(tree, null, 'the same instance renders once the projection arrives')
  assert.ok(find(tree, (node) => node.props?.className === 'qrm-trigger') !== undefined)
})
