import { useId, useState } from 'react'
import { exportDeviceCsv, saveBlob, type ExportResolution } from '../api/export'
import type { Period } from '../lib/historyRange'
import styles from './DeviceHistoryPage.module.css'

const OPTIONS: Array<{ value: ExportResolution; label: string }> = [
  { value: 'raw', label: 'surowe odczyty' },
  { value: '5m', label: '5 min' },
  { value: '1h', label: '1 h' },
  { value: '1d', label: '1 doba' },
]

/** Domyślna rozdzielczość dla okresu — mieści się w limicie wierszy serwera (D57). */
const DEFAULTS: Record<Period, ExportResolution> = { day: '5m', week: '1h', month: '1h', year: '1d' }

/** Surowe odczyty serwer wydaje najwyżej za 7 dni — tylko dla dnia i tygodnia. */
const rawAllowed = (period: Period) => period === 'day' || period === 'week'

/**
 * Pobranie CSV z wszystkimi pomiarami urządzenia za wybrany okres (D57). Komunikat serwera
 * (np. przekroczony limit wierszy) jest pokazywany zamiast pliku.
 */
export function DeviceCsvExport({
  siteId,
  deviceId,
  range,
  period,
  fetchFn,
  onExpired,
  save = saveBlob,
}: {
  siteId: string
  deviceId: string
  range: { from: Date; to: Date }
  period: Period
  fetchFn: typeof fetch
  onExpired: () => void
  save?: (blob: Blob, filename: string) => void
}) {
  const selectId = useId()
  const [choice, setChoice] = useState<Record<Period, ExportResolution>>(DEFAULTS)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)
  const resolution = choice[period]

  const download = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    const result = await exportDeviceCsv(siteId, deviceId, { ...range, resolution }, fetchFn)
    setBusy(false)
    if (result.kind === 'anonymous') {
      onExpired()
      return
    }
    if (result.kind === 'error') {
      setMessage({ error: true, text: result.message })
      return
    }
    save(result.blob, result.filename)
    setMessage({ error: false, text: `Pobrano plik ${result.filename}.` })
  }

  return (
    <div className={styles.export}>
      <div className={styles.controls}>
        <div className={styles.field}>
          <label htmlFor={selectId}>Rozdzielczość eksportu</label>
          <select
            id={selectId}
            value={resolution}
            onChange={(e) => setChoice((c) => ({ ...c, [period]: e.target.value as ExportResolution }))}
          >
            {OPTIONS.map((o) => (
              <option key={o.value} value={o.value} disabled={o.value === 'raw' && !rawAllowed(period)}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className={styles.toggle} onClick={() => void download()} disabled={busy}>
          {busy ? 'Przygotowywanie…' : 'Pobierz CSV'}
        </button>
      </div>
      <p className={styles.muted}>
        Wszystkie pomiary urządzenia z wybranego okresu. Separator „;”, przecinek dziesiętny, puste pole
        oznacza brak danych.
      </p>
      {message ? (
        <p role={message.error ? 'alert' : 'status'} className={message.error ? styles.error : styles.muted}>
          {message.text}
        </p>
      ) : null}
    </div>
  )
}
