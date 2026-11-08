import type { ReactNode } from 'react'
import styles from './Ring.module.css'

const R = 42
const CIRCUMFERENCE = 2 * Math.PI * R

/**
 * Pierścień procentowy (SoC, samowystarczalność). Grafika jest dekoracyjna (`aria-hidden`) —
 * wartość zawsze stoi w tekście środka. Brak wartości: pusty pierścień, bez wypełnienia.
 */
export function Ring({ percent, children }: { percent: number | null; children: ReactNode }) {
  const clamped = percent === null ? null : Math.min(100, Math.max(0, percent))
  return (
    <div className={styles.ring}>
      <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
        <circle className={styles.track} cx="50" cy="50" r={R} />
        {clamped === null ? null : (
          <circle
            className={styles.fill}
            cx="50"
            cy="50"
            r={R}
            strokeDasharray={`${(clamped / 100) * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
          />
        )}
      </svg>
      <div className={styles.center}>{children}</div>
    </div>
  )
}
