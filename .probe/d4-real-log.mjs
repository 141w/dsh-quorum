// D4 verification: run the shipped `judgeEvidence` over the REAL decoded session
// logs of the 2026-10-03 team round, and measure whether the handoff's literal
// boundary ("any tool/result before the delivered stamp") can distinguish a
// fabricated report from a worked one at all.
//
// Inputs: /tmp/rev.jsonl (teammate "reviewer", 131 events) and /tmp/lead.jsonl
// (its Lead, 258 events), both produced by:
//   ~/miniconda3/bin/zstd -dc ~/.dsh/sessions/--Users-<you>-Documents-deepseek-harness-default-workspace--/<id>/session.v4.jsonl.zstd
import { readFileSync } from 'node:fs'
import { judgeEvidence } from '../index.js'

const load = (file) => readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
const member = load('/tmp/rev.jsonl')
const lead = load('/tmp/lead.jsonl')

const REVIEWER = '5a8357c3-1355-4824-9ddc-5c38afc8c8a5'
const LEAD_ID = 'session-a86ccf90-ccdc-4365-b431-fc1419933cfe'

const queued = lead.filter((e) => e.type === 'team/message/queued' && e.data.message.senderId === REVIEWER)
const landed = queued
  .map((e) => ({ id: e.data.message.id, queuedTime: e.time }))
  .filter((entry) => lead.some((e) => e.type === 'team/message/delivered' && e.data.messageId === entry.id))

console.log(`reviewer messages to Lead: ${queued.length}, delivered: ${landed.length}`)
console.log('verdict over its own real log:', JSON.stringify(judgeEvidence({ events: member, messageIds: landed.map((l) => l.id) })))

// The vacuous-pass measurement: for every report, how does the Lead's `delivered`
// stamp sit relative to the member's own send_message result?
const nameByCall = new Map()
for (const e of member) if (e.type === 'tool/call') nameByCall.set(e.data.callId, e.data.name)
for (const entry of landed) {
  const delivered = lead.find((e) => e.type === 'team/message/delivered' && e.data.messageId === entry.id)
  const send = member.find((e) => e.type === 'tool/result'
    && nameByCall.get(e.data.message.toolCallId) === 'send_message'
    && JSON.stringify(e.data.message.content).includes(entry.id))
  console.log(
    `msg ${entry.id.slice(13, 21)}  queued=${entry.queuedTime}  member send result=${send?.time}`
    + `  lead delivered=${delivered?.time}  delivered-minus-sendresult=${delivered && send ? delivered.time - send.time : 'n/a'}ms`,
  )
}

// Negative control built from the same real events: strip every non-protocol
// result and keep only what "talked, never worked" would leave behind.
const onlyProtocol = member.filter((e) => {
  if (e.type === 'tool/result') {
    const name = nameByCall.get(e.data.message.toolCallId)
    return name === 'send_message' || name === 'list_agents' || name === 'present'
  }
  return e.type === 'tool/call' && ['send_message', 'list_agents', 'present'].includes(e.data.name)
})
console.log(`protocol-only log (${onlyProtocol.length} events):`, JSON.stringify(judgeEvidence({ events: onlyProtocol, messageIds: landed.map((l) => l.id) })))

// A fork child whose inherited prefix carries all the work and whose own events
// hold only the report: `ownEvents()` is what excludes the ancestor's history.
const inheritedCount = member.filter((e) => e.type === 'tool/result').length
console.log(`inherited-prefix control (drop every tool/result from own events):`, JSON.stringify(judgeEvidence({
  events: member.filter((e) => e.type !== 'tool/result'),
  messageIds: landed.map((l) => l.id),
}), `dropped=${inheritedCount}`))
