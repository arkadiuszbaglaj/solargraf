import { DemoBadge } from '../components/DemoBadge'
import { Panel } from '../components/Panel'
import { WidgetState } from '../components/WidgetState'
import type { LiveSite } from '../hooks/useLiveSite'
import { useNow } from '../hooks/useNow'
import { formatAge, formatQuantity, MISSING } from '../lib/format'
import { detailSections, sectionValues, type DetailRow, type DetailSection } from '../lib/siteDetails'
import styles from './SiteDetailsPanels.module.css'

/** Wartość ze znakiem (D39) jako moduł z opisem kierunku; reszta bez zmian. */
function valueText(r: DetailRow): { text: string; direction: string | null } {
  const v = r.value
  if (v.kind !== 'value') return { text: MISSING, direction: null }
  if (!r.signed) return { text: formatQuantity(v.value, r.unit), direction: null }
  const direction = v.value > 0 ? r.signed.positive : v.value < 0 ? r.signed.negative : 'brak przepływu'
  return { text: formatQuantity(Math.abs(v.value), r.unit), direction }
}

function status(r: DetailRow): string | null {
  const v = r.value
  switch (v.kind) {
    case 'value':
      return v.stale ? `nieaktualne, odczyt ${formatAge(v.ageSeconds)} temu` : null
    case 'no-data':
      return 'brak danych'
    case 'not-provided':
      return 'parametr niedostępny'
    case 'ambiguous':
      return `wiele źródeł (${v.sources}) — wartość niedostępna`
  }
}

function Row({ row }: { row: DetailRow }) {
  const { text, direction } = valueText(row)
  const meta = [direction, status(row)].filter(Boolean).join(' · ')
  const stale = row.value.kind === 'value' && row.value.stale
  return (
    <div className={`${styles.row} ${stale ? styles.stale : ''}`}>
      <dt className={styles.label}>{row.label}</dt>
      <dd className={styles.value}>
        <span className={styles.number}>{text}</span>
        {meta ? <span className={styles.meta}>{meta}</span> : null}
      </dd>
    </div>
  )
}

function SectionPanel({ section }: { section: DetailSection }) {
  const values = sectionValues(section)
  const simulated = values.some((v) => v.kind === 'value' && v.origin === 'SIMULATED')
  const ages = values.flatMap((v) => (v.kind === 'value' ? [v.ageSeconds] : []))
  return (
    <Panel
      title={section.title}
      actions={
        <>
          {ages.length > 0 ? <span className={styles.age}>Odczyt {formatAge(Math.max(...ages))} temu</span> : null}
          {simulated ? <DemoBadge origin="SIMULATED" /> : null}
        </>
      }
    >
      {section.groups.map((g) => (
        <div key={g.title ?? 'main'} className={styles.group}>
          {g.title ? <h3 className={styles.groupTitle}>{g.title}</h3> : null}
          <dl className={styles.list}>
            {g.rows.map((r) => (
              <Row key={r.id} row={r} />
            ))}
          </dl>
        </div>
      ))}
    </Panel>
  )
}

/**
 * Szczegóły PV, magazynu energii i sieci (D56) z tego samego strumienia co karty i diagram.
 * Panel i wiersz tylko dla metryk, które profil udostępnia; nic nie jest wyliczane.
 */
export function SiteDetailsPanels({ live, now: fixedNow }: { live: LiveSite; now?: Date }) {
  const tickingNow = useNow(1000)
  const now = fixedNow ?? tickingNow
  const { state, retry } = live

  if (state.status === 'connecting' || state.status === 'error') {
    return (
      <Panel title="Szczegóły instalacji">
        <WidgetState status={state.status === 'connecting' ? { kind: 'loading' } : { kind: 'error', onRetry: retry }} />
      </Panel>
    )
  }

  const sections = detailSections(state.devices, state.readings, now)
  if (sections.length === 0) return null
  return (
    <section aria-label="Szczegóły instalacji" className={styles.panels}>
      {sections.map((s) => (
        <SectionPanel key={s.key} section={s} />
      ))}
    </section>
  )
}
