import { describe, expect, it } from 'vitest'
import { rangeFor, shiftAnchor, today } from './historyRange'

const TZ = 'Europe/Warsaw'
const hours = (r: { from: Date; to: Date }) => (r.to.getTime() - r.from.getTime()) / 3_600_000

describe('zakresy historii (D47)', () => {
  it('dzień zaczyna się o północy czasu lokalnego', () => {
    const r = rangeFor('2026-11-07', 'day', TZ)
    expect(r.from.toISOString()).toBe('2026-11-06T23:00:00.000Z')
    expect(hours(r)).toBe(24)
    expect(r.label).toBe('7 listopada 2026')
  })

  it('doby zmiany czasu mają 23 i 25 godzin', () => {
    expect(hours(rangeFor('2026-03-29', 'day', TZ))).toBe(23)
    expect(hours(rangeFor('2026-10-25', 'day', TZ))).toBe(25)
  })

  it('tydzień od poniedziałku, miesiąc i rok', () => {
    const week = rangeFor('2026-11-07', 'week', TZ) // sobota
    expect(week.from.toISOString()).toBe('2026-11-01T23:00:00.000Z') // pon 2.11 lokalnie
    expect(week.label).toBe('02.11.2026 – 08.11.2026')
    const month = rangeFor('2026-10-15', 'month', TZ)
    expect(month.from.toISOString()).toBe('2026-09-30T22:00:00.000Z')
    expect(month.to.toISOString()).toBe('2026-10-31T23:00:00.000Z')
    expect(month.label).toBe('październik 2026')
    const year = rangeFor('2026-06-01', 'year', TZ)
    expect(year.from.toISOString()).toBe('2025-12-31T23:00:00.000Z')
    expect(year.label).toBe('2026')
  })

  it('przesuwa okres w obie strony, także przez przełom roku', () => {
    expect(shiftAnchor('2026-01-01', 'day', -1)).toBe('2025-12-31')
    expect(shiftAnchor('2026-11-07', 'week', 1)).toBe('2026-11-09')
    expect(shiftAnchor('2026-01-20', 'month', -1)).toBe('2025-12-01')
    expect(shiftAnchor('2026-12-20', 'month', 1)).toBe('2027-01-01')
    expect(shiftAnchor('2026-05-05', 'year', -1)).toBe('2025-01-01')
  })

  it('dzisiejsza data w strefie instalacji', () => {
    expect(today(new Date('2026-11-06T23:30:00Z'), TZ)).toBe('2026-11-07')
  })
})
