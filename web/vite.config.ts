import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Fragment z ECharts (~520 kB, ~180 kB gzip) jest ładowany leniwie; główna paczka ~250 kB.
  build: { chunkSizeWarningLimit: 600 },
  // Dev: /api do backendu z deploy/compose.dev.yaml. Przeglądarki traktują http://localhost
  // jako bezpieczny kontekst, więc cookie `Secure` działa także bez TLS.
  server: { proxy: { '/api': 'http://127.0.0.1:8000' } },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
  },
})
