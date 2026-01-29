import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Port configuration:
// - 5173: Vite dev server (client)
// - 3000: API server (main backend)
// - 3001: Traffic generator server

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,  // Fail if port is in use
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      },
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
        changeOrigin: true
      }
    }
  }
})
