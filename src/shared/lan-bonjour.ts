import { EventEmitter } from 'node:events'

export async function createLanBonjour(onError: (error: unknown) => void) {
  const { default: Bonjour } = await import('bonjour-service')
  const bonjour = new Bonjour({}, onError)
  const instance: object = bonjour
  const server = 'server' in instance ? instance.server : undefined
  const mdns =
    server !== null && typeof server === 'object' && 'mdns' in server ? server.mdns : undefined
  if (!(mdns instanceof EventEmitter)) {
    bonjour.destroy()
    throw new Error('bonjour-service did not expose its multicast emitter for error handling')
  }
  mdns.on('error', onError)
  return bonjour
}
