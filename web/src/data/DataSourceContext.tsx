import { createContext, useContext, type ReactNode } from 'react'
import type { DashboardDataSource } from './types'

const DataSourceContext = createContext<DashboardDataSource | null>(null)

export function DataSourceProvider({
  source,
  children,
}: {
  source: DashboardDataSource
  children: ReactNode
}) {
  return <DataSourceContext.Provider value={source}>{children}</DataSourceContext.Provider>
}

export function useDataSource(): DashboardDataSource {
  const source = useContext(DataSourceContext)
  if (!source) {
    throw new Error('Brak DataSourceProvider')
  }
  return source
}
