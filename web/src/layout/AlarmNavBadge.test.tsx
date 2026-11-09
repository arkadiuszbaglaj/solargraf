import { act, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ALARMS_CHANGED_EVENT, type AlarmSummary } from '../api/alarms'
import { AlarmNavBadge, alarmBadge } from './AlarmNavBadge'

const SITE = '11111111-1111-4111-8111-111111111111'

const summary = (over: Partial<AlarmSummary> = {}): AlarmSummary => ({
  criticalActive: 0,
  warningActive: 0,
  unacknowledged: 0,
  unacknowledgedClosed: 0,
  closed: 0,
  ...over,
})

function page(s: Record<string, number>) {
  return {
    alarms: [],
    can_acknowledge: false,
    can_view_history: false,
    days: 1,
    total: 0,
    has_more: false,
    summary: { critical_active: 0, warning_active: 0, unacknowledged: 0, unacknowledged_closed: 0, closed: 0, ...s },
  }
}

const server = (...bodies: Array<Record<string, number>>) => {
  let i = 0
  return vi.fn<typeof fetch>(async () => {
    const body = bodies[Math.min(i++, bodies.length - 1)] ?? {}
    return new Response(JSON.stringify(page(body)), { status: 200 })
  })
}

describe('znacznik alarmów w menu', () => {
  it('aktywne liczbą (krytyczny wygrywa), zamknięte niepotwierdzone kropką, brak — nic', () => {
    expect(alarmBadge(summary({ criticalActive: 1, warningActive: 2 }))).toEqual({
      kind: 'active',
      count: 3,
      critical: true,
    })
    expect(alarmBadge(summary({ warningActive: 1 }))).toEqual({ kind: 'active', count: 1, critical: false })
    expect(alarmBadge(summary({ unacknowledged: 1, unacknowledgedClosed: 1 }))).toEqual({ kind: 'pending', count: 1 })
    expect(alarmBadge(summary({ closed: 3 }))).toEqual({ kind: 'none' })
  })

  it('pyta o 24 h instalacji i podaje tekst dla czytników ekranu', async () => {
    const fetchFn = server({ critical_active: 1, warning_active: 1, unacknowledged: 2 })
    render(<AlarmNavBadge siteId={SITE} fetchFn={fetchFn} />)
    expect(await screen.findByText('(aktywne: 2, w tym krytyczne)', { normalizer: (t) => t.trim() })).toBeTruthy()
    expect(fetchFn.mock.calls[0]?.[0]).toBe(`/api/sites/${SITE}/alarms?days=1&limit=1`)
  })

  it('kropka dla zamkniętego bez potwierdzenia; po potwierdzeniu znika od razu', async () => {
    const fetchFn = server({ unacknowledged: 1, unacknowledged_closed: 1, closed: 1 }, { closed: 1 })
    render(<AlarmNavBadge siteId={SITE} fetchFn={fetchFn} />)
    expect(await screen.findByText('(do potwierdzenia: 1)', { normalizer: (t) => t.trim() })).toBeTruthy()
    act(() => {
      window.dispatchEvent(new Event(ALARMS_CHANGED_EVENT))
    })
    await waitFor(() => expect(screen.queryByText(/do potwierdzenia/)).toBeNull())
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('błąd albo brak sesji — bez znacznika', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response('{}', { status: 401 }))
    const { container } = render(<AlarmNavBadge siteId={SITE} fetchFn={fetchFn} />)
    await waitFor(() => expect(fetchFn).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })
})
