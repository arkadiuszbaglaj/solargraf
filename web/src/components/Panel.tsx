import type { ReactNode } from 'react'
import { useId } from 'react'
import styles from './Panel.module.css'

export function Panel({
  title,
  actions,
  children,
  className,
}: {
  title: string
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  const headingId = useId()
  return (
    <section
      className={className ? `${styles.panel} ${className}` : styles.panel}
      aria-labelledby={headingId}
    >
      <header className={styles.header}>
        <h2 id={headingId} className={styles.title}>
          {title}
        </h2>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </header>
      {children}
    </section>
  )
}
