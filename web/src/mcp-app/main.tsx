import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useApp } from '@modelcontextprotocol/ext-apps/react'
import type { ShoppingToolResult } from 'shopping-assistant/contract'

import { ProductResults } from '../ui/ProductTiles.tsx'
import '../ui/global.css'
import './mcp-app.css'

/**
 * The MCP App (11): the chat's product tiles, inside a host's sandboxed
 * iframe. The host sends the `findProducts` result; its `structuredContent` is
 * the `ShoppingToolResult`. A tool error (timeout, failure) has only text.
 */

type State =
  | { kind: 'waiting' }
  | { kind: 'result', result: ShoppingToolResult }
  | { kind: 'error', text: string }

function ProductTilesApp() {
  const [state, setState] = useState<State>({ kind: 'waiting' })
  const { error } = useApp({
    appInfo: { name: 'shopping-product-tiles', version: '0.0.0' },
    capabilities: {},
    onAppCreated: app => {
      app.ontoolresult = result => {
        if (result.isError || result.structuredContent === undefined) {
          const text = result.content?.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
          setState({ kind: 'error', text: text || 'The search failed.' })
        } else {
          setState({ kind: 'result', result: result.structuredContent as ShoppingToolResult })
        }
      }
    },
  })

  if (error !== null) return <p className="mcp-app-note">Couldn't connect to the host.</p>
  switch (state.kind) {
    case 'waiting':
      return <ProductResults result={undefined} />
    case 'result':
      return <ProductResults result={state.result} />
    case 'error':
      return <p className="mcp-app-note" role="alert">{state.text}</p>
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ProductTilesApp />
  </StrictMode>,
)
