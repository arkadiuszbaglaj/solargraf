import type { Period } from '../lib/historyRange'
import styles from './PeriodControls.module.css'

export interface PeriodOption<P extends string> {
  value: P
  label: string
}

export const CALENDAR_PERIODS: Array<PeriodOption<Period>> = [
  { value: 'day', label: 'Dzień' },
  { value: 'week', label: 'Tydzień' },
  { value: 'month', label: 'Miesiąc' },
  { value: 'year', label: 'Rok' },
]

/**
 * Wybór okresu i nawigacja poprzedni / dziś / następny (D47, D66). Przyciski przełącznika
 * mają `aria-pressed`; bez nawigacji (`nav` = null), gdy okres nie ma kroku, np. zakres własny.
 */
export function PeriodControls<P extends string>({
  options,
  value,
  onChange,
  nav,
}: {
  options: ReadonlyArray<PeriodOption<P>>
  value: P
  onChange: (value: P) => void
  nav: {
    onPrev: () => void
    onToday: () => void
    onNext: () => void
    isCurrent: boolean
    nextDisabled: boolean
  } | null
}) {
  return (
    <>
      <div className={styles.group} role="group" aria-label="Okres">
        {options.map((p) => (
          <button
            key={p.value}
            type="button"
            className={styles.toggle}
            aria-pressed={value === p.value}
            onClick={() => onChange(p.value)}
          >
            {p.label}
          </button>
        ))}
      </div>
      {nav ? (
        <div className={styles.group} role="group" aria-label="Nawigacja po okresach">
          <button type="button" className={styles.toggle} aria-label="Poprzedni okres" onClick={nav.onPrev}>
            ←
          </button>
          <button type="button" className={styles.toggle} disabled={nav.isCurrent} onClick={nav.onToday}>
            Dziś
          </button>
          <button
            type="button"
            className={styles.toggle}
            aria-label="Następny okres"
            disabled={nav.nextDisabled}
            onClick={nav.onNext}
          >
            →
          </button>
        </div>
      ) : null}
    </>
  )
}
