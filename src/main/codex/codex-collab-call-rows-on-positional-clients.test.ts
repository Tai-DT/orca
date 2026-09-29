// A client that predates result call ids (an older mobile app, or an older desktop reading a newer
// host) projects the journal itself and pairs each tool result with the oldest unanswered call.
// So every finished collab call row must carry an output, or each later output in its run is drawn
// under the call before its own.

import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../shared/agent-session-journal-types'
import { foldToolMessages, pairToolBlocks } from '../../shared/native-chat-tool-fold'
import { pairNativeChatToolResults } from '../../shared/native-chat-tool-pairing'
import type { NativeChatBlock, NativeChatMessage } from '../../shared/native-chat-types'
import { projectStructuredAgentSessionMessages } from '../../shared/structured-agent-session-message-projection'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { fakeCodex, identityFor, THREAD_ID } from './codex-structured-session-adapter-fixture'
import { CodexStructuredSessionAdapter } from './codex-structured-session-adapter'

// Shapes as a live default-mode session sent them (codex-cli 0.157); only the sender is remapped.
const HELPER = '01a0ea72-80bc-7632-a97f-4a9a0d50d08f'
const PARENT_TURN = 'parent-turn-1'
const HELPER_TURN = 'helper-turn-1'
const PROMPT = 'Run exactly one foreground shell command: `sleep 150; echo LATE`.'

type Frame = { method: string; params: Record<string, unknown> }

const turn = (method: 'turn/started' | 'turn/completed', threadId: string, id: string): Frame => ({
  method,
  params: { threadId, turn: { id, status: 'completed' } }
})
const item = (
  method: 'item/started' | 'item/completed',
  threadId: string,
  turnId: string,
  fields: Record<string, unknown>
): Frame => ({ method, params: { threadId, turnId, item: fields } })
const collab = (
  method: 'item/started' | 'item/completed',
  fields: Record<string, unknown>
): Frame =>
  item(method, THREAD_ID, PARENT_TURN, {
    type: 'collabAgentToolCall',
    senderThreadId: THREAD_ID,
    prompt: null,
    model: null,
    reasoningEffort: null,
    agentsStates: {},
    ...fields
  })
const shell = (
  method: 'item/started' | 'item/completed',
  threadId: string,
  turnId: string,
  id: string,
  output: string
): Frame =>
  item(method, threadId, turnId, {
    type: 'commandExecution',
    id,
    command: `/bin/zsh -lc 'echo ${output}'`,
    cwd: '/work/repo',
    status: method === 'item/started' ? 'inProgress' : 'completed',
    ...(method === 'item/completed' ? { exitCode: 0, aggregatedOutput: `${output}\n` } : {})
  })

const spawn = (method: 'item/started' | 'item/completed'): Frame =>
  collab(method, {
    id: 'call-spawn',
    tool: 'spawnAgent',
    status: method === 'item/started' ? 'inProgress' : 'completed',
    receiverThreadIds: method === 'item/started' ? [] : [HELPER],
    prompt: PROMPT,
    model: 'gpt-5.5',
    reasoningEffort: 'medium',
    ...(method === 'item/completed'
      ? { agentsStates: { [HELPER]: { status: 'pendingInit', message: null } } }
      : {})
  })
const waitStarted = collab('item/started', {
  id: 'call-wait',
  tool: 'wait',
  status: 'inProgress',
  receiverThreadIds: [HELPER]
})

async function publishedRows(frames: Frame[]): Promise<AgentJournalRenderItem[]> {
  const codex = fakeCodex()
  const adapter = new CodexStructuredSessionAdapter({
    resolveLaunch: async () => ({
      command: 'codex',
      args: ['app-server'],
      cwd: '/work/repo',
      codexHome: null,
      resumeThreadId: null
    }),
    openConnection: codex.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => 1_700_000_000_500
  })
  // The latest revision of each row, in first-written order, as a client's journal holds it.
  const rows = new Map<string, AgentJournalRenderItem>()
  const journal: StructuredAgentSessionEventSink = {
    appendItem: (identity, body, options = {}) => {
      const itemId = JSON.stringify(identity)
      const previous = rows.get(itemId)
      const sequence = previous?.sequence ?? rows.size + 1
      const { agentId, parentAgentId, producerKind } = options
      rows.set(itemId, {
        ...previous,
        ...(agentId === undefined ? {} : { agentId }),
        ...(parentAgentId === undefined ? {} : { parentAgentId }),
        ...(producerKind === undefined ? {} : { producerKind }),
        itemId,
        sequence,
        revision: (previous?.revision ?? 0) + 1,
        observedAt: sequence,
        body
      })
    },
    appendTombstone: () => {},
    publish: () => {}
  }
  await adapter.acquire({
    identity: identityFor('session-1'),
    fence: 7,
    spawnToken: 'spawn-9',
    events: journal
  })
  for (const frame of frames) {
    codex.connections[0]!.handlers.onNotification?.(frame.method, frame.params)
  }
  return [...rows.values()]
}

type PairedOutput = [call: string, output: string | undefined]

/** What a client without result call ids draws: each call with the output its pairing gives it. */
function positionalRuns(rows: AgentJournalRenderItem[]): {
  mobile: PairedOutput[][]
  desktop: PairedOutput[][]
} {
  const withoutCallIds = (message: NativeChatMessage): NativeChatMessage => ({
    ...message,
    blocks: message.blocks.map((block): NativeChatBlock => {
      if (block.type !== 'tool-result') {
        return block
      }
      const { callId: _callId, ...legacy } = block
      return legacy
    })
  })
  const runs = foldToolMessages(
    projectStructuredAgentSessionMessages(rows, [], []).map(withoutCallIds)
  ).filter((message) => message.blocks.some((block) => block.type === 'tool-call'))
  return {
    mobile: runs.map((message) =>
      pairToolBlocks(message.blocks).map((pair): PairedOutput => [
        pair.call?.name ?? '(none)',
        pair.result?.output.trim()
      ])
    ),
    desktop: runs.map((message) => {
      const pairing = pairNativeChatToolResults(message.blocks)
      return message.blocks.flatMap((block): PairedOutput[] =>
        block.type === 'tool-call'
          ? [[block.name, pairing.resultByCall.get(block)?.output.trim()]]
          : []
      )
    })
  }
}

const outputOf = (rows: AgentJournalRenderItem[], name: string): AgentJournalItemBody | undefined =>
  rows.map((row) => row.body).find((body) => body.kind === 'tool-call' && body.name === name)

describe('Codex collab call rows on a client that pairs results by position', () => {
  it('draws each output under its own call through spawn, shell, wait and close', async () => {
    const rows = await publishedRows([
      turn('turn/started', THREAD_ID, PARENT_TURN),
      spawn('item/started'),
      spawn('item/completed'),
      turn('turn/started', HELPER, HELPER_TURN),
      shell('item/started', THREAD_ID, PARENT_TURN, 'call-parent-shell', 'PARENT_DONE'),
      shell('item/completed', THREAD_ID, PARENT_TURN, 'call-parent-shell', 'PARENT_DONE'),
      shell('item/started', HELPER, HELPER_TURN, 'call-helper-shell', 'CHILD_DONE'),
      shell('item/completed', HELPER, HELPER_TURN, 'call-helper-shell', 'CHILD_DONE'),
      item('item/completed', HELPER, HELPER_TURN, {
        type: 'agentMessage',
        id: 'msg-child',
        text: 'CHILD_REPLY'
      }),
      turn('turn/completed', HELPER, HELPER_TURN),
      waitStarted,
      collab('item/completed', {
        id: 'call-wait',
        tool: 'wait',
        status: 'completed',
        receiverThreadIds: [HELPER],
        agentsStates: { [HELPER]: { status: 'completed', message: 'CHILD_REPLY' } }
      }),
      collab('item/started', {
        id: 'call-close',
        tool: 'closeAgent',
        status: 'inProgress',
        receiverThreadIds: [HELPER]
      }),
      collab('item/completed', {
        id: 'call-close',
        tool: 'closeAgent',
        status: 'completed',
        receiverThreadIds: [HELPER],
        agentsStates: { [HELPER]: { status: 'completed', message: 'CHILD_REPLY' } }
      }),
      shell('item/started', THREAD_ID, PARENT_TURN, 'call-parent-shell-2', 'AFTER_CLOSE'),
      shell('item/completed', THREAD_ID, PARENT_TURN, 'call-parent-shell-2', 'AFTER_CLOSE')
    ])
    // The helper's own shell is its own run, between the parent's two.
    const runs = [
      [
        ['spawn_agent', 'Spawned'],
        ['shell', 'PARENT_DONE']
      ],
      [['shell', 'CHILD_DONE']],
      [
        ['wait_agent', 'CHILD_REPLY'],
        ['close_agent', 'Closed'],
        ['shell', 'AFTER_CLOSE']
      ]
    ]
    const { mobile, desktop } = positionalRuns(rows)
    expect(mobile).toEqual(runs)
    expect(desktop).toEqual(runs)
  })

  it('gives a wait that timed out an output, and keeps naming the helpers it waited on', async () => {
    const rows = await publishedRows([
      turn('turn/started', THREAD_ID, PARENT_TURN),
      spawn('item/completed'),
      turn('turn/started', HELPER, HELPER_TURN),
      waitStarted,
      // Codex ends a timed-out wait naming no receiver and no state.
      collab('item/completed', {
        id: 'call-wait',
        tool: 'wait',
        status: 'completed',
        receiverThreadIds: [],
        agentsStates: {}
      }),
      collab('item/started', {
        id: 'call-close',
        tool: 'closeAgent',
        status: 'inProgress',
        receiverThreadIds: [HELPER]
      }),
      collab('item/completed', {
        id: 'call-close',
        tool: 'closeAgent',
        status: 'completed',
        receiverThreadIds: [HELPER],
        agentsStates: { [HELPER]: { status: 'running', message: null } }
      }),
      shell('item/started', THREAD_ID, PARENT_TURN, 'call-parent-shell', 'PARENT_DONE'),
      shell('item/completed', THREAD_ID, PARENT_TURN, 'call-parent-shell', 'PARENT_DONE')
    ])
    expect(outputOf(rows, 'wait_agent')).toMatchObject({
      state: 'completed',
      input: { description: PROMPT, agents: [HELPER] }
    })
    const runs = [
      [
        ['spawn_agent', 'Spawned'],
        ['wait_agent', 'Finished waiting'],
        // Its snapshot says `running`: the status from before the close.
        ['close_agent', 'Closed'],
        ['shell', 'PARENT_DONE']
      ]
    ]
    const { mobile, desktop } = positionalRuns(rows)
    expect(mobile).toEqual(runs)
    expect(desktop).toEqual(runs)
  })

  it('gives every other finished call what it did or what it reports', async () => {
    const OTHER = '01a0ea72-0000-7000-8000-000000000002'
    const finished = (id: string, tool: string, fields: Record<string, unknown>): Frame[] => [
      collab('item/started', { id, tool, status: 'inProgress', receiverThreadIds: [HELPER] }),
      collab('item/completed', {
        id,
        tool,
        status: 'completed',
        receiverThreadIds: [HELPER],
        ...fields
      })
    ]
    const rows = await publishedRows([
      turn('turn/started', THREAD_ID, PARENT_TURN),
      spawn('item/completed'),
      turn('turn/started', HELPER, HELPER_TURN),
      // A spawn that created no thread names nothing.
      collab('item/completed', {
        id: 'call-spawn-failed',
        tool: 'spawnAgent',
        status: 'failed',
        receiverThreadIds: [],
        prompt: 'second helper'
      }),
      ...finished('call-send', 'sendInput', {
        prompt: 'keep going',
        agentsStates: { [HELPER]: { status: 'running', message: null } }
      }),
      ...finished('call-resume', 'resumeAgent', {
        agentsStates: { [HELPER]: { status: 'completed', message: 'OLD_REPLY' } }
      }),
      collab('item/started', {
        id: 'call-wait',
        tool: 'wait',
        status: 'inProgress',
        receiverThreadIds: [HELPER, OTHER]
      }),
      // A wait's end names only the helpers that finished; an errored one's message is its error.
      collab('item/completed', {
        id: 'call-wait',
        tool: 'wait',
        status: 'failed',
        receiverThreadIds: [OTHER],
        agentsStates: { [OTHER]: { status: 'errored', message: 'boom' } }
      }),
      shell('item/started', THREAD_ID, PARENT_TURN, 'call-parent-shell', 'PARENT_DONE'),
      shell('item/completed', THREAD_ID, PARENT_TURN, 'call-parent-shell', 'PARENT_DONE')
    ])
    const runs = [
      [
        ['spawn_agent', 'Spawned'],
        ['spawn_agent', 'Agent spawn failed'],
        ['send_input', 'Sent input'],
        ['resume_agent', 'Completed - OLD_REPLY'],
        ['wait_agent', `${OTHER}: Error - boom`],
        ['shell', 'PARENT_DONE']
      ]
    ]
    const { mobile, desktop } = positionalRuns(rows)
    expect(mobile).toEqual(runs)
    expect(desktop).toEqual(runs)
    // The wait keeps naming both helpers it waited on.
    expect(outputOf(rows, 'wait_agent')).toMatchObject({ input: { agents: [HELPER, OTHER] } })
  })
})
