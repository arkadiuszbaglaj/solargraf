import { useEffect, useState } from 'react'

/** Bieżący czas odświeżany co `intervalMs` — do wyliczania wieku wartości. */
export function useNow(intervalMs = 5000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
