import { describe, expect, it } from 'vitest'
import {
  formatAge,
  formatBytes,
  formatNumber,
  formatUptime,
  formatDateTime,
  formatDirectedPower,
  formatQuantity,
  MISSING,
  wattHoursToKilowattHours,
  wattsToKilowatts,
} from './format'

// Intl w pl-PL używa twardej spacji jako separatora tysięcy — normalizujemy do porównań.
const norm = (s: string): string => s.replace(/ | /g, ' ')

describe('konwersje jednostek', () => {
  it('W → kW i Wh → kWh dzielą przez 1000', () => {
    expect(wattsToKilowatts(4820)).toBe(4.82)
    expect(wattHoursToKilowattHours(28400)).toBe(28.4)
  })
})

describe('formatQuantity', () => {
  it('prezentuje moc w kW z dwoma miejscami', () => {
    expect(norm(formatQuantity(4820, 'W'))).toBe('4,82 kW')
    expect(norm(formatQuantity(0, 'W'))).toBe('0,00 kW')
  })

  it('prezentuje energię w kWh z jednym miejscem', () => {
    expect(norm(formatQuantity(28400, 'Wh'))).toBe('28,4 kWh')
    // pl-PL grupuje tysiące dopiero od 5 cyfr (CLDR: minimumGroupingDigits = 2).
    expect(norm(formatQuantity(1234567, 'Wh'))).toBe('1234,6 kWh')
    expect(norm(formatQuantity(12345678, 'Wh'))).toBe('12 345,7 kWh')
  })

  it('pozostałe jednostki bez konwersji', () => {
    expect(formatQuantity(68, '%')).toBe('68%')
    expect(norm(formatQuantity(230.4, 'V'))).toBe('230,4 V')
    expect(norm(formatQuantity(50.02, 'Hz'))).toBe('50,02 Hz')
  })

  it('napięcie z wybraną precyzją (ogniwo) i liczba bez jednostki', () => {
    expect(norm(formatQuantity(3.3019, 'V', 3))).toBe('3,302 V')
    expect(norm(formatQuantity(412, 'count'))).toBe('412')
    expect(formatQuantity(null, 'count')).toBe(MISSING)
  })

  it('brak wartości to „—”, nigdy 0', () => {
    expect(formatQuantity(null, 'W')).toBe(MISSING)
    expect(formatQuantity(Number.NaN, 'Wh')).toBe(MISSING)
    expect(formatQuantity(Number.POSITIVE_INFINITY, '%')).toBe(MISSING)
  })
})

describe('formatDirectedPower', () => {
  it('opisuje kierunek według znaku i pokazuje wartość bezwzględną', () => {
    expect(norm(formatDirectedPower(680, 'pobór', 'oddawanie').text)).toBe('0,68 kW')
    expect(formatDirectedPower(680, 'pobór', 'oddawanie').direction).toBe('pobór')
    expect(norm(formatDirectedPower(-1600, 'pobór', 'oddawanie').text)).toBe('1,60 kW')
    expect(formatDirectedPower(-1600, 'pobór', 'oddawanie').direction).toBe('oddawanie')
    expect(formatDirectedPower(0, 'pobór', 'oddawanie').direction).toBe('brak przepływu')
  })

  it('brak wartości nie ma kierunku', () => {
    expect(formatDirectedPower(null, 'a', 'b')).toEqual({ text: MISSING, direction: null })
  })
})

describe('czas', () => {
  it('pokazuje czas w strefie instalacji, nie przeglądarki', () => {
    expect(formatDateTime('2026-11-07T12:05:00Z', 'Europe/Warsaw')).toContain('13:05')
    expect(formatDateTime('2026-07-07T12:05:00Z', 'Europe/Warsaw')).toContain('14:05')
  })

  it('formatAge', () => {
    expect(formatAge(5.9)).toBe('5 s')
    expect(formatAge(-3)).toBe('0 s')
    expect(formatAge(125)).toBe('2 min')
    expect(formatAge(7200)).toBe('2 h')
    expect(formatAge(3 * 86400)).toBe('3 d')
  })
})

describe('formatBytes', () => {
  it('używa jednostek binarnych', () => {
    expect(norm(formatBytes(512))).toBe('512 B')
    expect(norm(formatBytes(1536))).toBe('1,5 KiB')
    expect(norm(formatBytes(3.5 * 1024 ** 3))).toBe('3,5 GiB')
    expect(norm(formatBytes(2 * 1024 ** 4))).toBe('2,0 TiB')
  })

  it('brak wartości to „—”, nie 0 B', () => {
    expect(formatBytes(null)).toBe(MISSING)
    expect(formatBytes(-1)).toBe(MISSING)
    expect(formatBytes(0)).toBe('0 B')
  })
})

describe('formatUptime', () => {
  it('pokazuje dwie największe jednostki', () => {
    expect(formatUptime(59)).toBe('0 min')
    expect(formatUptime(12 * 60 + 5)).toBe('12 min')
    expect(formatUptime(5 * 3600 + 12 * 60)).toBe('5 h 12 min')
    expect(formatUptime(3 * 86400 + 4 * 3600 + 59)).toBe('3 d 4 h')
    expect(formatUptime(null)).toBe(MISSING)
  })
})

describe('formatNumber', () => {
  it('formatuje albo zwraca „—”', () => {
    expect(formatNumber(0.5, 2)).toBe('0,50')
    expect(formatNumber(null, 2)).toBe(MISSING)
  })
})
