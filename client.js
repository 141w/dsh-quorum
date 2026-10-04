/* Client half of dsh-quorum: one conversation-header action.
 *
 * The wire face of the `agentTeam` projection is `{members, tasks, failure}` only —
 * the mailbox (`messages` / `delivered`) stays server-side. So this panel reports what
 * the durable record actually publishes to the browser (role card, phase, task board,
 * upstream write-scope warnings) and never implies it observed quorum convergence.
 *
 * What it does not get is anything about what a member is *doing*: the projection's
 * member schema is strict and carries exactly `{id, name, role, phase, error?}`, so
 * there is no live tool, output or progress to render. That view lives in the member's
 * own session, which is why each teammate row opens it — the same navigation the
 * official Agent Teams panel performs, entered from the role card rather than the name.
 */
window.__ModuleLoader__.load({
  id: 'dsh-quorum',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement

    const NS = 'quorum'

    // Click-time panel placement needs the panel's width before it is in the DOM.
    // Reading it back would mean measuring after a render that already put the panel in
    // the wrong place, so the two numbers the stylesheet uses are named here and the
    // clamp is derived from them. `.qrm-panel` is `width:min(420px, 100vw - 32px)`, and
    // PANEL_MARGIN is the 16px it keeps clear of the viewport edge.
    const PANEL_WIDTH = 420
    const PANEL_MARGIN = 16
    const zh = {
      trigger: 'Quorum',
      lead: '本会话：Team Lead',
      member: '本会话：团队成员',
      roster: '角色卡',
      tasks: '共享任务',
      ready: '可开始',
      blocked: '被依赖阻塞',
      scopeWarning: '写入范围警告',
      failure: 'Team 记录无效：',
      openMember: '打开该成员的会话，查看它实际在做什么',
      openUnavailable: '该成员的会话当前未加载，无法打开；先唤醒它再试',
      phase_active: '活跃',
      phase_provisioning: '准备中',
      phase_failed: '失败',
      self: '本会话',
      none: '尚无成员',
      note: '面板只镜像投影到浏览器的 Team 记录。汇报收敛与证据判定由服务端 quorum_wait 完成，不经此通道；点成员名可进入它的会话看过程。'
    }
    const en = {
      trigger: 'Quorum',
      lead: 'This session: Team Lead',
      member: 'This session: teammate',
      roster: 'Role cards',
      tasks: 'Shared tasks',
      ready: 'Ready',
      blocked: 'Blocked',
      scopeWarning: 'Write-scope warning',
      failure: 'Invalid persisted Team record: ',
      openMember: 'Open this member\'s session to see what it is actually doing',
      openUnavailable: 'This member\'s session is not loaded, so it cannot be opened yet; wake it and try again',
      phase_active: 'active',
      phase_provisioning: 'provisioning',
      phase_failed: 'failed',
      self: 'you are here',
      none: 'no members yet',
      note: 'This panel mirrors the Team record the projection publishes to the browser. Report convergence and evidence verdicts are made server-side by quorum_wait; click a member to open its session and watch the work.'
    }

    // An unexpected phase would put the literal string `phase_bogus` on screen. The
    // same failure shape as the rest of this plugin: never render an unknown state
    // as if it were a known one. Derive the set from the dictionary itself so it
    // cannot drift from what the UI can actually say, and so it stays checkable when
    // `tr` is an identity stub in tests.
    const PHASES = Object.keys(zh)
      .filter((key) => key.startsWith('phase_'))
      .map((key) => key.slice('phase_'.length))

    const style = document.createElement('style')
    style.setAttribute('data-plugin-css', 'dsh-quorum')
    style.textContent = [
      // Trigger: matches the neighbouring header actions, but the member count is a
      // badge rather than a whisper, because the count is the only thing this panel
      // says before you open it.
      '.qrm-trigger{min-height:28px;min-width:86px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:0;border-radius:var(--dsw-radius-sm);align-items:center;justify-content:center;gap:6px;padding:3px 8px;font-size:12px;display:inline-flex;transition:background .12s ease,color .12s ease}',
      '.qrm-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.qrm-trigger:focus-visible{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.qrm-trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.qrm-count{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-label-primary);font-size:10px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1}',
      // Panel: the same elevation tokens the host panels use, plus a deliberate 1px
      // border — the elevation tokens resolve to a 0.5px ring on their own, which is
      // too faint to separate a popover from the conversation behind it.
      '.qrm-panel{box-sizing:border-box;width:min(420px,calc(100vw - 32px));max-height:min(560px,calc(100vh - 96px));overflow:auto;position:fixed;z-index:120;display:flex;flex-direction:column;gap:10px;padding:16px 18px 14px;border-radius:var(--dsw-radius-lg);border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent),var(--dsw-shadow-lv2);font-size:13px;line-height:1.5}',
      '.qrm-head{font-size:13px;font-weight:600;letter-spacing:-.01em}',
      '.qrm-section{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-caption)}',
      '.qrm-row{display:flex;align-items:center;gap:8px;justify-content:space-between;padding:7px 8px;margin:0 -8px;border-top:.5px solid var(--dsw-alias-border-l2);transition:background .12s ease}',
      // A teammate row navigates into that member's session, so it has to read as
      // actionable and stay keyboard-reachable; the Lead row says so with data-openable.
      '.qrm-row[data-openable="yes"]{cursor:pointer;border-radius:var(--dsw-radius-sm)}',
      '.qrm-row[data-openable="yes"]:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.qrm-row[data-openable="yes"]:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}',
      '.qrm-row[data-openable="yes"]:hover .qrm-go,.qrm-row[data-openable="yes"]:focus-visible .qrm-go{opacity:1;transform:translateX(1px)}',
      // Lead row: present, but visibly not a link.
      '.qrm-row[data-openable="no"]{cursor:default}',
      '.qrm-id{display:flex;align-items:center;gap:8px;min-width:0}',
      '.qrm-dot{flex:none;width:8px;height:8px;border-radius:999px;background:var(--dsw-alias-state-idle-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-idle-primary) 22%,transparent)}',
      '.qrm-dot[data-phase="active"]{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-success-primary) 22%,transparent)}',
      '.qrm-dot[data-phase="failed"]{background:var(--dsw-alias-state-error-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-error-primary) 22%,transparent)}',
      '.qrm-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}',
      '.qrm-meta{display:flex;align-items:center;gap:8px;flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.qrm-phase{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.qrm-chip{border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:18px;white-space:nowrap}',
      '.qrm-chip[data-state="ok"]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent);color:var(--dsw-alias-state-business-primary)}',
      '.qrm-chip[data-state="warn"]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 18%,transparent);color:var(--dsw-alias-state-warn-primary)}',
      '.qrm-chip[data-state="bad"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 18%,transparent);color:var(--dsw-alias-state-error-primary)}',
      // The row's own affordance, revealed on hover/focus.
      '.qrm-go{flex:none;color:var(--dsw-alias-label-caption);font-size:14px;line-height:1;opacity:.45;transition:opacity .12s ease,transform .12s ease}',
      '.qrm-none{font-size:12px;color:var(--dsw-alias-label-caption);padding:2px 0 4px}',
      '.qrm-notice{font-size:11px;color:var(--dsw-alias-state-warn-primary);padding:5px 8px;margin:0 -2px;border-radius:var(--dsw-radius-xs);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent)}',
      '.qrm-task{display:flex;flex-direction:column;gap:3px;padding:7px 0;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.qrm-taskTitle{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.qrm-warn{font-size:11px;color:var(--dsw-alias-state-warn-primary)}',
      '.qrm-failure{font-size:12px;color:var(--dsw-alias-state-error-primary);line-height:1.5}',
      '.qrm-note{font-size:11px;color:var(--dsw-alias-label-caption);line-height:1.55;margin-top:2px;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l1)}'
    ].join('')
    document.head.append(style)

    module.exports.inject = ['sessions', 'uiWorkspace', 'slots', 'locale']

    module.exports.apply = (ctx) => {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-quorum: dictionaries')
      const tr = ctx.locale.bind(NS)

      // TeamIds are the Lead Session's id, so a teammate header resolves the same
      // projection row the Lead sees.
      const sessions = ctx.sessions
      const leadOf = (sessionId) => {
        const binding = sessions.binding(sessionId)
        const parent = binding?.session?.getSnapshot?.().subagent?.address?.parentSessionId
        return parent ?? sessionId
      }

      // Show one member's own conversation — the only place its running work is
      // visible. The projection carries no activity, so navigation is the answer;
      // this is the same call the official Agent Teams panel makes.
      //
      // The address is constructed, not read from a binding. `binding(memberId)` is
      // only defined for sessions this browser has already loaded, so every member
      // spawned since the last page load read as unopenable and its row refused —
      // measured live on 2026-10-04: an ACTIVE reviewer's row showed the refusal
      // notice on every click, because spawning never loads the child session into
      // the browser store. The official panel passes the durable direct-parent
      // address instead and lets `retain()` load the child session on demand; this
      // does the same, so a row works the first time it is clicked.
      const openMember = (sessionId, memberId) => {
        const parentSessionId = leadOf(sessionId)
        if (memberId === parentSessionId) return { ok: false, reason: 'openUnavailable' }
        ctx.uiWorkspace.openSession({ parentSessionId, childSessionId: memberId, mode: 'continuable' })
        return { ok: true }
      }

      const props = { tr, leadOf, openMember }
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'quorum',
        order: -19,
        label: () => tr('trigger'),
        inject: () => props
      }, QuorumAction))
      console.log('[dsh-quorum] header action registered')
    }

    function QuorumAction({ sessionId, useSessions, tr, leadOf, openMember }) {
      const [open, setOpen] = React.useState(false)
      const [pos, setPos] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const triggerRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const leadId = leadOf(sessionId)
      const team = useSessions((state) => state.projectionsBySession[leadId]?.values.agentTeam)
      if (team === undefined) return null

      if (team.failure !== undefined) {
        return h('span', { className: 'qrm-root' },
          h('button', {
            ref: triggerRef, type: 'button', className: 'qrm-trigger', 'aria-expanded': open,
            onClick: () => setOpen((v) => !v)
          }, tr('trigger'), h('span', { className: 'qrm-count' }, '!')),
          open ? h('div', {
            ref: panelRef, className: 'qrm-panel', role: 'dialog', 'aria-label': tr('trigger'),
            style: { right: 16, top: 64 }
          },
            h('div', { className: 'qrm-head' }, tr('failure')),
            h('div', { className: 'qrm-failure' }, team.failure)
          ) : null
        )
      }

      const members = team.members ?? []
      const teammates = members.filter((m) => m.role === 'teammate')
      const tasks = team.tasks ?? []
      const failed = teammates.filter((m) => m.phase === 'failed').length

      // The header reflows as the window narrows, so measure at click time rather than
      // pinning the panel to a corner that may not sit under the trigger.
      const toggle = () => {
        if (open) { setOpen(false); return }
        const box = triggerRef.current?.getBoundingClientRect()
        if (box !== undefined) {
          setPos({
            top: box.bottom + 6,
            left: Math.max(PANEL_MARGIN, Math.min(box.left, window.innerWidth - PANEL_WIDTH - PANEL_MARGIN))
          })
        }
        setOpen(true)
      }
      React.useEffect(() => {
        if (!open) return
        const dismiss = (event) => { if (event.key === 'Escape') setOpen(false) }
        const outside = (event) => {
          if (triggerRef.current?.contains(event.target)) return
          if (panelRef.current?.contains(event.target)) return
          setOpen(false)
        }
        document.addEventListener('keydown', dismiss)
        document.addEventListener('pointerdown', outside, true)
        return () => {
          document.removeEventListener('keydown', dismiss)
          document.removeEventListener('pointerdown', outside, true)
        }
      }, [open])
      React.useEffect(() => { setOpen(false) }, [sessionId])

      // A member row is the entry point into that member's own conversation: the
      // projection says which role it holds, and its session says what it is doing.
      // Only teammates are openable — the Lead's row would navigate to the session
      // the panel is already shown in.
      const memberRow = (member) => {
        const canOpen = member.role !== 'lead'
        const activate = () => {
          if (!canOpen) return
          const result = openMember(sessionId, member.id)
          setNotice(result.ok ? null : tr(result.reason))
        }
        const interactive = canOpen ? {
          role: 'button',
          tabIndex: 0,
          title: tr('openMember'),
          'aria-label': `${member.name} — ${tr('openMember')}`,
          onClick: activate,
          onKeyDown: (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            activate()
          }
        } : { 'aria-disabled': true }

        // Phase is a value read off the wire, not a closed set the browser enforces,
        // so an unexpected one would put the literal string `phase_bogus` on screen.
        const knownPhase = PHASES.includes(member.phase)
        const phaseLabel = tr('phase_' + member.phase)

        return h('div', {
          className: 'qrm-row',
          key: member.id,
          'data-openable': canOpen ? 'yes' : 'no',
          ...interactive
        },
          h('span', { className: 'qrm-id' },
            member.role === 'lead'
              ? null
              : h('span', { className: 'qrm-dot', 'data-phase': member.phase, 'aria-hidden': 'true' }),
            h('span', { className: 'qrm-name' }, member.name)
          ),
          h('span', { className: 'qrm-meta' },
            member.role === 'lead'
              // The Lead row has no dot and no phase, so without this it showed a bare
              // name next to rows that carry state — the one row in the roster that read
              // as unfinished. It is not openable because you are already in it, and
              // this label is where that is said.
              ? h('span', { className: 'qrm-phase' }, tr('self'))
              : h('span', { className: 'qrm-phase' }, knownPhase ? phaseLabel : '—'),
            member.phase === 'failed'
              ? h('span', { className: 'qrm-chip', 'data-state': 'bad' }, member.error ?? tr('phase_failed'))
              : null,
            canOpen ? h('span', { className: 'qrm-go', 'aria-hidden': 'true' }, '›') : null
          )
        )
      }

      return h('span', { className: 'qrm-root' },
        h('button', {
          ref: triggerRef,
          type: 'button', className: 'qrm-trigger', 'aria-expanded': open,
          onClick: toggle
        }, tr('trigger'), h('span', { className: 'qrm-count' }, String(teammates.length))),
        open ? h('div', {
          ref: panelRef, className: 'qrm-panel', role: 'dialog', 'aria-label': tr('trigger'),
          style: pos === null ? { right: 16, top: 64 } : { top: pos.top, left: pos.left }
        },
          h('div', { className: 'qrm-head' }, sessionId === leadId ? tr('lead') : tr('member')),

          h('div', { className: 'qrm-section' }, tr('roster')),
          teammates.length === 0 && members.length === 0
            ? h('div', { className: 'qrm-none' }, tr('none'))
            : members.map(memberRow),
          notice === null ? null : h('div', { className: 'qrm-notice', role: 'status' }, notice),

          tasks.length === 0 ? null : h('div', null,
            h('div', { className: 'qrm-section' }, tr('tasks')),
            tasks.map((task) => h('div', { className: 'qrm-task', key: task.id },
              h('div', { className: 'qrm-taskTitle' },
                h('span', { className: 'qrm-name' }, task.subject || task.id),
                h('span', { className: 'qrm-meta' },
                  task.status === 'completed'
                    ? h('span', { className: 'qrm-chip', 'data-state': 'ok' }, task.status)
                    : h('span', { className: 'qrm-chip', 'data-state': task.ready ? 'ok' : 'warn' },
                        task.ready ? tr('ready') : tr('blocked')),
                  task.ownerName ? h('span', null, task.ownerName) : null
                )
              ),
              (task.writeScopeWarnings ?? []).map((warning, i) =>
                h('div', { className: 'qrm-warn', key: i }, tr('scopeWarning') + ': ' + warning))
            ))
          ),

          failed > 0 || teammates.length > 0 ? h('div', { className: 'qrm-note' }, tr('note')) : null
        ) : null
      )
    }

    return module.exports
  }
})
