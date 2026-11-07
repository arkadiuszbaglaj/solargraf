import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { filenameFrom } from '../api/export'
import type { Period } from '../lib/historyRange'
import { DeviceCsvExport } from './DeviceCsvExport'

const RANGE = { from: new Date('2026-11-06T23:00:00Z'), to: new Date('2026-11-07T23:00:00Z') }

function csv(status: number, body: string, headers: Record<string, string> = {}) {
  return vi.fn<typeof fetch>(async () => new Response(body, { status, headers }))
}

function setup(fetchFn: typeof fetch, period: Period = 'day') {
  const save = vi.fn<(blob: Blob, name: string) => void>()
  const onExpired = vi.fn<() => void>()
  const view = render(
    <DeviceCsvExport
      siteId="s 1"
      deviceId="d1"
      range={RANGE}
      period={period}
      fetchFn={fetchFn}
      onExpired={onExpired}
      save={save}
    />,
  )
  return { save, onExpired, view }
}

const select = () => screen.getByLabelText<HTMLSelectElement>('Rozdzielczość eksportu')
const raw = () => screen.getByRole<HTMLOptionElement>('option', { name: 'surowe odczyty' })

describe('DeviceCsvExport', () => {
  it('pobiera plik z zakresem i rozdzielczością, nazwa z nagłówka serwera', async () => {
    const fetchFn = csv(200, '﻿czas_utc;…\r\n', {
      'Content-Disposition': 'attachment; filename="historia_dom_falownik_20261107_20261107_5m_SIMULATED.csv"',
    })
    const { save } = setup(fetchFn)
    expect(select().value).toBe('5m')
    await userEvent.click(screen.getByRole('button', { name: 'Pobierz CSV' }))
    const url = new URL(String(fetchFn.mock.calls[0]?.[0]), 'https://x')
    expect(url.pathname).toBe('/api/sites/s%201/devices/d1/export.csv')
    expect(url.searchParams.get('from')).toBe(RANGE.from.toISOString())
    expect(url.searchParams.get('to')).toBe(RANGE.to.toISOString())
    expect(url.searchParams.get('resolution')).toBe('5m')
    expect(save).toHaveBeenCalledOnce()
    expect(save.mock.calls[0]?.[1]).toBe('historia_dom_falownik_20261107_20261107_5m_SIMULATED.csv')
    expect(screen.getByRole('status').textContent).toContain('Pobrano plik')
  })

  it('komunikat serwera przy przekroczonym limicie — bez pliku', async () => {
    const fetchFn = csv(422, JSON.stringify({ detail: 'Za dużo wierszy (limit 500000).' }), {
      'Content-Type': 'application/json',
    })
    const { save } = setup(fetchFn, 'year')
    await userEvent.selectOptions(select(), '1h')
    await userEvent.click(screen.getByRole('button', { name: 'Pobierz CSV' }))
    expect(new URL(String(fetchFn.mock.calls[0]?.[0]), 'https://x').searchParams.get('resolution')).toBe('1h')
    expect(screen.getByRole('alert').textContent).toBe('Za dużo wierszy (limit 500000).')
    expect(save).not.toHaveBeenCalled()
  })

  it('surowe odczyty tylko dla dnia i tygodnia; domyślne rozdzielczości okresów', () => {
    const { view } = setup(csv(200, ''), 'week')
    expect(select().value).toBe('1h')
    expect(raw().disabled).toBe(false)
    const props = { siteId: 's', deviceId: 'd', range: RANGE, fetchFn: csv(200, ''), onExpired: () => {} }
    view.rerender(<DeviceCsvExport {...props} period="month" />)
    expect(raw().disabled).toBe(true)
    view.rerender(<DeviceCsvExport {...props} period="year" />)
    expect(select().value).toBe('1d')
  })

  it('wygasła sesja i brak połączenia', async () => {
    const { onExpired, view } = setup(csv(401, ''))
    await userEvent.click(screen.getByRole('button', { name: 'Pobierz CSV' }))
    expect(onExpired).toHaveBeenCalledOnce()
    view.unmount()
    const offline = vi.fn<typeof fetch>(async () => {
      throw new TypeError('offline')
    })
    setup(offline)
    await userEvent.click(screen.getByRole('button', { name: 'Pobierz CSV' }))
    expect(screen.getByRole('alert').textContent).toBe('Brak połączenia z serwerem.')
  })

  it('filenameFrom przyjmuje tylko bezpieczną nazwę', () => {
    expect(filenameFrom('attachment; filename="a_b-1.csv"')).toBe('a_b-1.csv')
    expect(filenameFrom('attachment; filename="../x.csv"')).toBe('historia.csv')
    expect(filenameFrom(null)).toBe('historia.csv')
  })
})
