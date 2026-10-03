/* Client half of dsh-quorum: one conversation-header action.
 *
 * The wire face of the `agentTeam` projection is `{members, tasks, failure}` only —
 * the mailbox (`messages` / `delivered`) stays server-side. So this panel reports what
 * the durable record actually publishes to the browser (role card, phase, task board,
 * upstream write-scope warnings) and never implies it observed quorum convergence.
 */
window.__ModuleLoader__.load({
  id: 'dsh-quorum',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement

    const NS = 'quorum'
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
      phase_active: '活跃',
      phase_provisioning: '准备中',
      phase_failed: '失败',
      note: '面板只镜像投影到浏览器的 Team 记录。汇报收敛与证据判定由服务端 quorum_wait 完成，不经此通道。'
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
      phase_active: 'active',
      phase_provisioning: 'provisioning',
      phase_failed: 'failed',
      note: 'This panel mirrors the Team record the projection publishes to the browser. Report convergence and evidence verdicts are made server-side by quorum_wait.'
    }

    const style = document.createElement('style')
    style.setAttribute('data-plugin-css', 'dsh-quorum')
    style.textContent = [
      '.qrm-trigger{min-height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;border-radius:6px;align-items:center;gap:5px;padding:3px 7px;font-size:12px;display:inline-flex}',
      '.qrm-trigger:hover,.qrm-trigger:focus-visible{color:var(--dsw-alias-label-primary)}',
      '.qrm-count{color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums;font-weight:400}',
      '.qrm-panel{box-sizing:border-box;width:min(420px,calc(100vw - 32px));max-height:min(560px,calc(100vh - 96px));overflow:auto;position:fixed;z-index:120;display:flex;flex-direction:column;gap:8px;padding:14px 16px 16px;border-radius:12px;box-shadow:var(--dsw-elevation-prominent);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}',
      '.qrm-head{font-size:13px;font-weight:600}',
      '.qrm-section{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);margin-top:4px}',
      '.qrm-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.qrm-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.qrm-meta{display:flex;align-items:center;gap:8px;flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.qrm-chip{border-radius:999px;padding:1px 8px;font-size:11px}',
      '.qrm-chip[data-state="ok"]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent)}',
      '.qrm-chip[data-state="warn"]{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary) 18%,transparent)}',
      '.qrm-chip[data-state="bad"]{background:color-mix(in srgb,var(--dsw-alias-state-danger-primary) 18%,transparent)}',
      '.qrm-task{display:flex;flex-direction:column;gap:2px;padding:6px 0;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.qrm-taskTitle{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.qrm-warn{font-size:11px;color:var(--dsw-alias-state-warning-primary)}',
      '.qrm-note{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:4px}'
    ].join('')
    document.head.append(style)

    module.exports.inject = ['sessions', 'slots', 'locale']

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

      const props = { tr, leadOf }
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'quorum',
        order: -19,
        label: () => tr('trigger'),
        inject: () => props
      }, QuorumAction))
      console.log('[dsh-quorum] header action registered')
    }

    function QuorumAction({ sessionId, useSessions, tr, leadOf }) {
      const [open, setOpen] = React.useState(false)
      const [pos, setPos] = React.useState(null)
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
          }, h('div', { className: 'qrm-warn' }, tr('failure') + team.failure)) : null
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
            left: Math.max(16, Math.min(box.left, window.innerWidth - 436))
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
          members.map((m) => h('div', { className: 'qrm-row', key: m.id },
            h('span', { className: 'qrm-name' }, m.name),
            h('span', { className: 'qrm-meta' },
              m.role === 'lead' ? null : h('span', null, tr('phase_' + m.phase)),
              m.phase === 'failed'
                ? h('span', { className: 'qrm-chip', 'data-state': 'bad' }, m.error ?? tr('phase_failed'))
                : null
            )
          )),

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
