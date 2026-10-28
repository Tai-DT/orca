import { describe, expect, it } from 'vitest'
import { extractDevicectlErrorDetail } from './devicectl-execution'

describe('extractDevicectlErrorDetail', () => {
  it('unwraps NSLocalized fields and the underlying error chain', () => {
    const detail = extractDevicectlErrorDetail({
      code: 10002,
      domain: 'com.apple.dt.CoreDeviceError',
      userInfo: {
        BundleIdentifier: { string: 'com.does.not.exist' },
        NSLocalizedDescription: { string: 'The application failed to launch.' },
        NSLocalizedFailureReason: {
          string: 'The requested application com.does.not.exist is not installed.'
        },
        NSLocalizedRecoverySuggestion: { string: 'Provide a valid bundle identifier.' },
        NSUnderlyingError: {
          error: {
            code: -10814,
            domain: 'NSOSStatusErrorDomain',
            userInfo: { _LSLine: { int: 1975 } }
          }
        }
      }
    })
    expect(detail).toBe(
      'The application failed to launch. ' +
        'The requested application com.does.not.exist is not installed. ' +
        'Provide a valid bundle identifier. ' +
        '(com.apple.dt.CoreDeviceError 10002 → NSOSStatusErrorDomain -10814)'
    )
  })

  it('dedupes repeated sentences across levels', () => {
    const detail = extractDevicectlErrorDetail({
      code: 1,
      domain: 'X',
      userInfo: {
        NSLocalizedDescription: { string: 'Outer.' },
        NSUnderlyingError: {
          error: {
            code: 2,
            domain: 'Y',
            userInfo: { NSLocalizedDescription: { string: 'Outer.' } }
          }
        }
      }
    })
    expect(detail).toBe('Outer. (X 1 → Y 2)')
  })

  it('returns null when no NSLocalized sentences exist', () => {
    expect(extractDevicectlErrorDetail({ code: 7, domain: 'Z', userInfo: {} })).toBeNull()
    expect(extractDevicectlErrorDetail('plain string')).toBeNull()
    expect(extractDevicectlErrorDetail(undefined)).toBeNull()
  })
})
