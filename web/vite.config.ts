import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Fragment z ECharts (~520 kB, ~180 kB gzip) jest ładowany leniwie; główna paczka ~250 kB.
  build: { chunkSizeWarningLimit: 600 },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
  },
})
