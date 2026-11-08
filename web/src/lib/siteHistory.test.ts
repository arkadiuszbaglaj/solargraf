import { describe, expect, it, vi } from 'vitest'
import { device, fakeServer, historyUrls, json, SITE_ID } from '../test/siteHistoryFixture'
import { loadSiteHistory, SessionExpiredError } from './siteHistory'

const RANGE = { from: new Date('2026-11-06T23:00:00Z'), to: new Date('2026-11-07T23:00:00Z') }

describe('loadSiteHistory (D66)', () => {
  it('pobiera każdą serię z jej urządzenia-źródła, z rozdzielczością auto', async () => {
    const fn = fakeServer([
      device('inv', ['pv_power', 'load_power', 'battery_power', 'battery_soc']),
      device('meter', ['grid_power']),
    ])
    const h = await loadSiteHistory(SITE_ID, RANGE, fn)
    expect(h.power.map((s) => s.metric)).toEqual(['pv_power', 'load_power', 'grid_power', 'battery_power'])
    expect(h.soc?.metric).toBe('battery_soc')
    expect(h.missing).toEqual([])
    expect(h.origins).toEqual(['SIMULATED'])
    expect(h.resolution).toBe('5m')
    const urls = historyUrls(fn)
    expect(urls).toHaveLength(5)
    const grid = urls.find((u) => u.searchParams.get('metric') === 'grid_power')
    expect(grid?.pathname).toBe(`/api/sites/${SITE_ID}/devices/meter/history`)
    expect(grid?.searchParams.get('resolution')).toBe('auto')
    expect(grid?.searchParams.get('from')).toBe('2026-11-06T23:00:00.000Z')
    expect(grid?.searchParams.get('to')).toBe('2026-11-07T23:00:00.000Z')
  })

  it('luka zostaje null, nigdy 0', async () => {
    const fn = fakeServer([device('inv', ['pv_power'])], { pv_power: [null, 500, null] })
    const h = await loadSiteHistory(SITE_ID, RANGE, fn)
    expect(h.power[0]?.history.points.map((p) => p.value)).toEqual([null, 500, null])
  })

  it('brak albo kilka źródeł — seria niedostępna, bez sumowania i bez zapytania', async () => {
    const fn = fakeServer([
      device('a', ['pv_power', 'grid_power']),
      device('b', ['grid_power']),
      device('off', ['battery_power', 'battery_soc'], false),
    ])
    const h = await loadSiteHistory(SITE_ID, RANGE, fn)
    expect(h.power.map((s) => s.metric)).toEqual(['pv_power'])
    expect(h.soc).toBeNull()
    expect(h.missing).toEqual([
      'Zużycie domu — brak źródła',
      'Sieć (+ pobór, − oddawanie) — wiele źródeł',
      'Bateria (+ rozładowanie, − ładowanie) — brak źródła',
      'Stan naładowania baterii — brak źródła',
    ])
    expect(historyUrls(fn).map((u) => u.searchParams.get('metric'))).toEqual(['pv_power'])
  })

  it('bez serii — brak rozdzielczości i pochodzeń', async () => {
    const h = await loadSiteHistory(SITE_ID, RANGE, fakeServer([]))
    expect(h).toMatchObject({ power: [], soc: null, origins: [], resolution: null })
    expect(h.missing).toHaveLength(5)
  })

  it('wygasła sesja i błąd serwera są zgłaszane', async () => {
    const anon = vi.fn<typeof fetch>(async () => json(401, {}))
    await expect(loadSiteHistory(SITE_ID, RANGE, anon)).rejects.toBeInstanceOf(SessionExpiredError)
    const broken = fakeServer([device('inv', ['pv_power'])], {}, 500)
    await expect(loadSiteHistory(SITE_ID, RANGE, broken)).rejects.toThrow('history')
  })
})
