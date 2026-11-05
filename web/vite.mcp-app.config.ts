import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

/**
 * The MCP App widget (11): `pnpm mcp-app` builds `mcp-app.html` into one
 * self-contained file (scripts and styles inlined), which the MCP server
 * serves as its `ui://` resource.
 */
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: 'dist-mcp-app',
    emptyOutDir: true,
    rollupOptions: { input: 'mcp-app.html' },
  },
})
