import { describe, expect, it } from 'vitest'
import { localDate, startOfLocalDay, timeZoneOffsetMinutes } from './time'

const TZ = 'Europe/Warsaw'

describe('strefa czasowa instalacji', () => {
  it('przesunięcie zimą +60, latem +120 min', () => {
    expect(timeZoneOffsetMinutes(new Date('2026-01-15T12:00:00Z'), TZ)).toBe(60)
    expect(timeZoneOffsetMinutes(new Date('2026-07-15T12:00:00Z'), TZ)).toBe(120)
  })

  it('data lokalna różni się od UTC tuż po północy lokalnej', () => {
    expect(localDate(new Date('2026-11-06T23:30:00Z'), TZ)).toBe('2026-11-07')
  })

  it('początek doby lokalnej zimą i latem', () => {
    expect(startOfLocalDay(new Date('2026-11-07T12:00:00Z'), TZ).toISOString()).toBe(
      '2026-11-06T23:00:00.000Z',
    )
    expect(startOfLocalDay(new Date('2026-07-07T12:00:00Z'), TZ).toISOString()).toBe(
      '2026-07-06T22:00:00.000Z',
    )
  })

  it('dzień zmiany czasu: północ ma przesunięcie sprzed zmiany', () => {
    // 2026-03-29: zmiana na czas letni o 02:00; północ jest jeszcze w CET (+1).
    expect(startOfLocalDay(new Date('2026-03-29T12:00:00Z'), TZ).toISOString()).toBe(
      '2026-03-28T23:00:00.000Z',
    )
    // 2026-10-25: powrót do czasu zimowego o 03:00; północ jest jeszcze w CEST (+2).
    expect(startOfLocalDay(new Date('2026-10-25T12:00:00Z'), TZ).toISOString()).toBe(
      '2026-10-24T22:00:00.000Z',
    )
  })
})
