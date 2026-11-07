/**
 * Eksport historii urządzenia do CSV (D57): `GET …/devices/{did}/export.csv`. Plik pobierany
 * przez `fetch`, żeby pokazać komunikat serwera (np. limit wierszy) zamiast surowej strony błędu.
 */
export type ExportResolution = 'raw' | '5m' | '1h' | '1d'

export type ExportResult =
  | { kind: 'ok'; blob: Blob; filename: string }
  | { kind: 'anonymous' }
  | { kind: 'error'; message: string }

const FALLBACK_NAME = 'historia.csv'

/** Nazwa pliku z `Content-Disposition` (serwer podaje ASCII); w razie braku — nazwa domyślna. */
export function filenameFrom(disposition: string | null): string {
  const match = disposition?.match(/filename="([^"]+)"/)
  const name = match?.[1]
  return name && /^[\w.-]+$/.test(name) ? name : FALLBACK_NAME
}

async function errorMessage(response: Response): Promise<string> {
  if (response.status === 404) return 'Nie znaleziono urządzenia.'
  if (response.status === 422) {
    try {
      const body: unknown = await response.json()
      if (typeof body === 'object' && body !== null && 'detail' in body && typeof body.detail === 'string') {
        return body.detail
      }
    } catch {
      // treść nie jest JSON-em — komunikat ogólny niżej
    }
    return 'Nieprawidłowy zakres eksportu.'
  }
  return 'Nie udało się przygotować pliku.'
}

export async function exportDeviceCsv(
  siteId: string,
  deviceId: string,
  query: { from: Date; to: Date; resolution: ExportResolution },
  fetchFn: typeof fetch = fetch,
): Promise<ExportResult> {
  const params = new URLSearchParams({
    from: query.from.toISOString(),
    to: query.to.toISOString(),
    resolution: query.resolution,
  })
  const url = `/api/sites/${encodeURIComponent(siteId)}/devices/${encodeURIComponent(deviceId)}/export.csv?${params}`
  let response: Response
  try {
    response = await fetchFn(url, { credentials: 'same-origin' })
  } catch {
    return { kind: 'error', message: 'Brak połączenia z serwerem.' }
  }
  if (response.status === 401) return { kind: 'anonymous' }
  if (!response.ok) return { kind: 'error', message: await errorMessage(response) }
  try {
    const blob = await response.blob()
    return { kind: 'ok', blob, filename: filenameFrom(response.headers.get('Content-Disposition')) }
  } catch {
    return { kind: 'error', message: 'Przerwano pobieranie pliku.' }
  }
}

/** Zapis pliku w przeglądarce (link tymczasowy); w testach podmieniany. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  // Część przeglądarek zaczyna pobieranie asynchronicznie — adres zwalniany z opóźnieniem.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
