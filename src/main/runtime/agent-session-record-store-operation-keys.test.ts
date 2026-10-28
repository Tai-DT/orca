import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import { openTestAgentSessionRecordStore } from './agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../native-chat/agent-session-journal/journal-host-database-test-support'

const NOW = 1_800_000_000_000

let directory: string
let counter = 0

function operationId(now = NOW): string {
  counter += 1
  return `${now}-${String(counter)
    .padStart(32, '0')
    .replaceAll(/[^0-9a-f]/g, '0')}`
}

async function open(hostId = 'local'): Promise<AgentSessionRecordStore> {
  return openTestAgentSessionRecordStore(directory, { hostId })
}

const SNAPSHOT_SQL =
  'SELECT hex(operation_key) AS keyHex, typeof(operation_key) AS keyType, row_json AS rowJson FROM agent_session_operations ORDER BY rowid'

function snapshotRows() {
  return openTestJournalHostDatabase(directory).db.prepare(SNAPSHOT_SQL).all()
}

describe('durable operation-key loading', () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-agent-session-store-'))
  })

  afterEach(async () => {
    closeTestJournalHostDatabase(directory)
    await rm(directory, { recursive: true, force: true })
  })

  it.each(['trusted-local:runtime', 'thiết-bị-🦈', '\uFEFFdevice'])(
    'replays durable outcomes after reopen for caller %s',
    async (callerKey) => {
      const first = operationId()
      const second = operationId()
      const store = await open()
      await store.admitAndClaimOperation(
        { callerKey, operationId: first, fingerprint: 'fp-a', now: NOW },
        (decision) => decision.decision === 'admit'
      )
      await store.recordOperationOutcome({
        callerKey,
        operationId: first,
        outcome: { status: 'failed', code: 'setup_choice', message: 'Setup decision required' }
      })
      await store.admitAndClaimOperation(
        { callerKey, operationId: second, fingerprint: 'fp-b', now: NOW },
        (decision) => decision.decision === 'admit'
      )
      await store.recordOperationOutcome({
        callerKey,
        operationId: second,
        outcome: { status: 'succeeded', sessionId: '' }
      })

      const storedBefore = snapshotRows()
      closeTestJournalHostDatabase(directory)
      const reopened = await open()
      expect(reopened.listOperationRows()).toHaveLength(2)
      expect(reopened.getOperationRow(callerKey, first)).toMatchObject({
        callerKey,
        operationId: first,
        outcome: { status: 'failed', code: 'setup_choice', message: 'Setup decision required' }
      })
      expect(reopened.getOperationRow(callerKey, second)).toMatchObject({
        callerKey,
        operationId: second,
        outcome: { status: 'succeeded', sessionId: '' }
      })
      expect(snapshotRows()).toEqual(storedBefore)

      const replayed = await reopened.admitAndClaimOperation(
        { callerKey, operationId: first, fingerprint: 'fp-a', now: NOW + 1 },
        (decision) => decision.decision === 'admit'
      )
      expect(replayed.decision).toMatchObject({
        decision: 'replay',
        row: {
          outcome: {
            status: 'failed',
            code: 'setup_choice',
            message: 'Setup decision required'
          }
        }
      })
    }
  )

  it('skips corrupted keys and keeps loading the remaining valid row', async () => {
    const badBase = {
      fingerprint: 'corrupt-fp',
      operationTimestamp: NOW,
      recordedAt: NOW,
      expiresAt: NOW + 60_000,
      outcome: { status: 'failed', code: 'setup_choice' }
    }
    const mismatchRow = { ...badBase, callerKey: 'mismatch', operationId: operationId() }
    const blobRow = { ...badBase, callerKey: 'blob-caller', operationId: operationId() }
    const invalidRow = { ...badBase, callerKey: '\uFFFDdevice', operationId: operationId() }

    await open()
    const db = openTestJournalHostDatabase(directory).db
    db.prepare('INSERT INTO agent_session_operations (operation_key, row_json) VALUES (?, ?)').run(
      'mismatched-key',
      JSON.stringify(mismatchRow)
    )
    db.prepare('INSERT INTO agent_session_operations (operation_key, row_json) VALUES (?, ?)').run(
      Buffer.from(`blob-caller\0${blobRow.operationId}`, 'utf8'),
      JSON.stringify(blobRow)
    )
    db.prepare(
      'INSERT INTO agent_session_operations (operation_key, row_json) VALUES (CAST(? AS TEXT), ?)'
    ).run(
      Uint8Array.from([0xff, ...Buffer.from(`device\0${invalidRow.operationId}`, 'utf8')]),
      JSON.stringify(invalidRow)
    )

    const goodId = operationId()
    const store = await open()
    await store.admitAndClaimOperation(
      { callerKey: 'good-caller', operationId: goodId, fingerprint: 'fp-g', now: NOW },
      (decision) => decision.decision === 'admit'
    )
    await store.recordOperationOutcome({
      callerKey: 'good-caller',
      operationId: goodId,
      outcome: { status: 'succeeded', sessionId: 'session-g' }
    })

    const storedBefore = snapshotRows()
    closeTestJournalHostDatabase(directory)
    const reopened = await open()
    expect(reopened.listOperationRows()).toHaveLength(1)
    expect(reopened.getOperationRow('good-caller', goodId)).toMatchObject({
      outcome: { status: 'succeeded', sessionId: 'session-g' }
    })
    expect(reopened.getOperationRow('mismatch', mismatchRow.operationId)).toBeNull()
    expect(reopened.getOperationRow('blob-caller', blobRow.operationId)).toBeNull()
    expect(reopened.getOperationRow('\uFFFDdevice', invalidRow.operationId)).toBeNull()
    expect(snapshotRows()).toEqual(storedBefore)
  })
})
