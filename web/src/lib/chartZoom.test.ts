import { describe, expect, it } from 'vitest'
import { FULL_ZOOM, isFullZoom, normalizeZoom, panZoom, visibleRange, zoomIn, zoomOut } from './chartZoom'

describe('chartZoom', () => {
  it('przybliża i oddala wokół środka, w granicach 0–100', () => {
    expect(zoomIn(FULL_ZOOM)).toEqual({ start: 25, end: 75 })
    expect(zoomIn({ start: 0, end: 20 })).toEqual({ start: 5, end: 15 })
    expect(zoomOut({ start: 25, end: 75 })).toEqual(FULL_ZOOM)
    // Przy krawędzi okno przesuwa się do środka zamiast wychodzić poza zakres.
    expect(zoomOut({ start: 0, end: 30 })).toEqual({ start: 0, end: 60 })
    expect(zoomOut({ start: 80, end: 100 })).toEqual({ start: 60, end: 100 })
  })

  it('najwęższe okno to 1 %', () => {
    let z = FULL_ZOOM
    for (let i = 0; i < 20; i++) z = zoomIn(z)
    expect(z.end - z.start).toBe(1)
  })

  it('przesuwa o pół okna, zatrzymując się na krawędzi', () => {
    expect(panZoom({ start: 25, end: 75 }, -1)).toEqual({ start: 0, end: 50 })
    expect(panZoom({ start: 10, end: 60 }, -1)).toEqual({ start: 0, end: 50 })
    expect(panZoom({ start: 25, end: 75 }, 1)).toEqual({ start: 50, end: 100 })
  })

  it('normalizacja: zaokrąglenie, granice, puste okno to cały zakres', () => {
    expect(normalizeZoom({ start: 10.123456, end: 99.99999 })).toEqual({ start: 10.123, end: 100 })
    expect(normalizeZoom({ start: -5, end: 120 })).toEqual(FULL_ZOOM)
    expect(normalizeZoom({ start: 40, end: 40 })).toEqual(FULL_ZOOM)
    expect(isFullZoom(FULL_ZOOM)).toBe(true)
    expect(isFullZoom({ start: 0, end: 99 })).toBe(false)
  })

  it('widoczny fragment zakresu czasu', () => {
    const range = { from: new Date('2026-11-06T23:00:00Z'), to: new Date('2026-11-07T23:00:00Z') }
    expect(visibleRange(range, { start: 25, end: 75 })).toEqual({
      from: new Date('2026-11-07T05:00:00Z'),
      to: new Date('2026-11-07T17:00:00Z'),
    })
  })
})
