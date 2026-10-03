// Member-session event fixtures in the shape decoded from a real session log
// (`~/.dsh/sessions/--Users-<you>-Documents-deepseek-harness-default-workspace--/
// 5a8357c3-…/session.v4.jsonl.zstd`, see docs/verification.md D4): the envelope is
// `{type, seq, time, data}`, a `tool/call` carries `{callId, name, arguments}`, and
// a `tool/result` carries `data.message.{toolCallId, isError, content}`. Nothing
// here is invented; a field renamed upstream fails these tests rather than the
// running system.

/** One successful non-protocol tool result, followed by its report. */
export function report(messageId) {
  return { name: 'send_message', text: `{"messageId":"${messageId}","status":"queued"}` }
}

/**
 * Build a call/result pair per step, in log order with contiguous sequence numbers.
 * @param steps - `{name, text?, ok?, at?}`; `ok: false` records `isError: true`.
 * @param base - sequence number the first call lands on.
 */
export function memberLog(steps, base = 3) {
  const events = []
  let seq = base
  for (const step of steps) {
    const callId = `call-${step.at ?? seq}`
    events.push({
      type: 'tool/call',
      seq: seq++,
      time: 1791000000000 + seq,
      data: { turn: 1, step: seq, callId, name: step.name, arguments: '{}' },
    })
    events.push({
      type: 'tool/result',
      seq: seq++,
      time: 1791000000000 + seq,
      data: {
        turn: 1,
        step: seq,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId },
          toolCallId: callId,
          content: [{ type: 'text', text: step.text ?? 'ok' }],
          isError: step.ok === false,
        },
      },
    })
  }
  return events
}

/** A detached member session exposing only what the plugin is allowed to read. */
export function fakeSession(id, own, opts = {}) {
  return {
    id,
    ownEvents: () => {
      if (opts.throws) throw new Error(opts.throws)
      return own
    },
    // Present so a plugin that reached for the whole log instead of `ownEvents()`
    // is caught: the fork-inherited prefix lives here and must never count.
    snapshotEvents: () => [...(opts.inherited ?? []), ...own],
  }
}
