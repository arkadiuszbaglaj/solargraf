import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { App } from './App'

describe('App', () => {
  it('renderuje główny nagłówek w elemencie main', () => {
    const html = renderToString(<App />)
    expect(html).toContain('<main>')
    expect(html).toContain('<h1>Szkielet aplikacji</h1>')
  })
})
