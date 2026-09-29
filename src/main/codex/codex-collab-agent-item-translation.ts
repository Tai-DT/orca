// A Codex `collabAgentToolCall` item → a tool row that names the helper it acted on.
//
// The row is the call the agent made (`spawn_agent`, `wait_agent`, `close_agent`, …); the helper
// itself is the subagent roster's row. A helper is named the way the roster names it, so the two
// rows read as the same child.

import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import {
  boundInlineText,
  boundToolInput,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import {
  codexCollabHelperLabel,
  codexCollabToolName,
  readCodexCollabAgentToolCall,
  type CodexCollabAgentToolCall
} from './codex-collab-agent-tool-call'
import { readString } from './codex-item-field-readers'
import { codexItemRunState } from './codex-item-run-state'
import type { CodexThreadItem } from './codex-thread-item-identity'

/** The roster's name for a helper thread, or null for one it holds no name for. */
export type CodexHelperName = (threadId: string) => string | null

/** Who the call acted on. A spawn names its helper by its prompt until the roster holds the
 *  thread it became; a helper with no name (its spawn was never seen) is named by its thread id. */
function helperNames(call: CodexCollabAgentToolCall, helperName?: CodexHelperName): string {
  if (call.tool === 'spawnAgent') {
    const spawned = call.receiverThreadIds[0]
    return (spawned && helperName?.(spawned)) || codexCollabHelperLabel(call.prompt) || ''
  }
  return call.receiverThreadIds.map((threadId) => helperName?.(threadId) ?? threadId).join(', ')
}

/** Codex's own words for a helper's `CollabAgentStatus`, as its UI shows them. */
const HELPER_STATUS_TEXT = new Map<string, string>([
  ['pendingInit', 'Pending init'],
  ['running', 'Running'],
  ['interrupted', 'Interrupted'],
  ['completed', 'Completed'],
  ['errored', 'Error'],
  ['shutdown', 'Shutdown'],
  ['notFound', 'Not found']
])

const CALL_STATUS_TEXT = new Map<string, string>([
  ['completed', 'Completed'],
  ['failed', 'Failed'],
  ['interrupted', 'Interrupted']
])

/** What the call reports about one helper. Only a wait returns what its helper said; any other
 *  call reports the helper's status (a close's snapshot is the status it closed it in), and an
 *  errored helper's message is its error. */
function helperStateText(
  call: CodexCollabAgentToolCall,
  state: CodexCollabAgentToolCall['states'][number]
): string | null {
  if (state.message && (call.tool === 'wait' || state.status === 'errored')) {
    return state.message
  }
  return state.status === null ? null : (HELPER_STATUS_TEXT.get(state.status) ?? state.status)
}

/** A finished call's output, taken from the item. Every finished call has one: a client that pairs
 *  results by position (one predating result call ids) would otherwise draw each later output in
 *  the run under the call before its own. */
function outputText(call: CodexCollabAgentToolCall, helperName?: CodexHelperName): string | null {
  if (call.status === null || call.status === 'inProgress') {
    return null
  }
  const reports = call.states.flatMap((state) => {
    const text = helperStateText(call, state)
    return text === null ? [] : [{ threadId: state.threadId, text }]
  })
  if (reports.length === 0) {
    // A wait's end names only helpers that finished (none when it timed out; v2's never names any).
    return call.tool === 'wait'
      ? 'Finished waiting'
      : (CALL_STATUS_TEXT.get(call.status) ?? call.status)
  }
  if (reports.length === 1 && call.receiverThreadIds.length === 1) {
    return reports[0].text
  }
  return reports
    .map(({ threadId, text }) => `${helperName?.(threadId) ?? threadId}: ${text}`)
    .join('\n')
}

/** `started` is the call's started item, when the caller still holds it. */
export function codexCollabAgentToolCallBody(
  item: CodexThreadItem,
  helperName?: CodexHelperName,
  started?: CodexThreadItem
): AgentJournalItemBody | null {
  const call = readCodexCollabAgentToolCall(item, started)
  if (!call) {
    return null
  }
  const description = helperNames(call, helperName)
  const model = readString(item, 'model')
  const reasoningEffort = readString(item, 'reasoningEffort')
  const fields = {
    // `description` is the key the row label reads, so the helper's name leads the row.
    ...(description ? { description } : {}),
    ...(call.prompt ? { prompt: call.prompt } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(call.receiverThreadIds.length > 0 ? { agents: call.receiverThreadIds } : {})
  }
  const text = outputText(call, helperName)
  const output = text === null ? null : boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS)
  return {
    kind: 'tool-call',
    name: codexCollabToolName(call),
    callId: call.id,
    input: boundToolInput(
      Object.keys(fields).length > 0 ? fields : null,
      DEFAULT_JOURNAL_PAYLOAD_LIMITS
    ),
    state: codexItemRunState(item),
    ...(output === null ? {} : { output: output.bounded })
  }
}
