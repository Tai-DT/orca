import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createLanBonjour } from './lan-bonjour'

type BonjourTestState = {
  emitter: EventEmitter | object | undefined
  destroy: ReturnType<typeof vi.fn>
  constructorCallback: ((error: unknown) => void) | null
}

const state = vi.hoisted((): BonjourTestState => ({
  emitter: undefined,
  destroy: vi.fn(),
  constructorCallback: null
}))

vi.mock('bonjour-service', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeBonjour {
    server: { mdns: unknown }
    destroy = state.destroy

    constructor(_opts: unknown, onError?: (error: unknown) => void) {
      this.server = { mdns: state.emitter ?? new EventEmitter() }
      state.constructorCallback = onError ?? null
    }
  }
  return { default: FakeBonjour }
})

describe('createLanBonjour', () => {
  beforeEach(() => {
    state.emitter = undefined
    state.destroy.mockReset()
    state.constructorCallback = null
  })

  it('passes the supplied callback to the public constructor', async () => {
    const onError = vi.fn()
    await createLanBonjour(onError)
    state.constructorCallback?.(new Error('respond failed'))
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'respond failed' }))
  })

  it('routes asynchronous multicast errors without throwing', async () => {
    const emitter = new EventEmitter()
    state.emitter = emitter
    const onError = vi.fn()
    await createLanBonjour(onError)

    const failure = new Error('EACCES socket')
    expect(() => emitter.emit('error', failure)).not.toThrow()
    expect(onError).toHaveBeenCalledWith(failure)
  })

  it('destroys and rejects when the multicast emitter is missing', async () => {
    state.emitter = {}
    await expect(createLanBonjour(vi.fn())).rejects.toThrow(/multicast emitter/)
    expect(state.destroy).toHaveBeenCalledTimes(1)
  })
})
