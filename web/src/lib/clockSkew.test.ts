import { describe, expect, it } from 'vitest'
import { formatSkew, significantSkew } from './clockSkew'

const at = (iso: string) => new Date(iso)
const instant = (serverIso: string) => ({
  serverTime: at(serverIso),
  sentAt: at('2026-11-07T12:00:00Z'),
  receivedAt: at('2026-11-07T12:00:00Z'),
})

describe('significantSkew', () => {
  it('serwer spóźniony o 2 h 13 min (przypadek z serwera testowego) → ujemne przesunięcie', () => {
    const offset = significantSkew({
      serverTime: at('2026-11-07T15:15:44Z'),
      sentAt: at('2026-11-07T17:28:54Z'),
      receivedAt: at('2026-11-07T17:28:54.200Z'),
    })
    expect(offset).toBeCloseTo(-(2 * 3600 + 13 * 60 + 10.1), 1)
  })

  it('różnica w progu i dokładnie na progu → brak ostrzeżenia', () => {
    expect(significantSkew(instant('2026-11-07T12:00:30Z'))).toBeNull()
    expect(significantSkew(instant('2026-11-07T12:01:00Z'))).toBeNull()
    expect(significantSkew(instant('2026-11-07T12:01:01Z'))).toBe(61)
  })

  it('długa odpowiedź zwiększa niepewność: 70 s różnicy przy 30 s odpowiedzi to za mało', () => {
    const sample = {
      serverTime: at('2026-11-07T12:01:25Z'),
      sentAt: at('2026-11-07T12:00:00Z'),
      receivedAt: at('2026-11-07T12:00:30Z'),
    }
    // Środek zapytania 12:00:15, różnica 70 s, niepewność 15 s → 55 s < 60 s.
    expect(significantSkew(sample)).toBeNull()
  })
})

describe('formatSkew', () => {
  it.each([
    [-(2 * 3600 + 13 * 60 + 10), '2 h 13 min'],
    [61, '1 min'],
    [3600, '1 h'],
    [3 * 86400 + 4 * 3600 + 59, '3 d 4 h'],
    [86400, '1 d'],
  ])('%d s → %s', (s, text) => {
    expect(formatSkew(s)).toBe(text)
  })
})
