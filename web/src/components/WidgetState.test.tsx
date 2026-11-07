import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { WidgetState } from './WidgetState'

describe('WidgetState', () => {
  it('ładowanie jest ogłaszane jako status', () => {
    render(<WidgetState status={{ kind: 'loading' }} />)
    expect(screen.getByRole('status').textContent).toContain('Ładowanie')
  })

  it('błąd jest alertem bez szczegółów technicznych i pozwala ponowić klawiaturą', async () => {
    const onRetry = vi.fn<() => void>()
    render(<WidgetState status={{ kind: 'error', onRetry }} />)
    expect(screen.getByRole('alert').textContent).toBe('Nie udało się pobrać danych.Spróbuj ponownie')
    await userEvent.tab()
    await userEvent.keyboard('{Enter}')
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('brak danych pokazuje komunikat zamiast treści', () => {
    render(
      <WidgetState status={{ kind: 'empty', message: 'Brak danych.' }}>
        <p>treść</p>
      </WidgetState>,
    )
    expect(screen.getByText('Brak danych.')).toBeTruthy()
    expect(screen.queryByText('treść')).toBeNull()
  })

  it('nieaktualne dane: treść widoczna razem z ostrzeżeniem', () => {
    render(
      <WidgetState status={{ kind: 'ready' }} staleNotice="Dane nieaktualne">
        <p>treść</p>
      </WidgetState>,
    )
    expect(screen.getByText('treść')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Dane nieaktualne')
  })
})
