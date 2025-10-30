// vite.config.js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    host: true,
    port: 5173,
    strictPort: false,
    proxy: {
      // Forward all /public/* calls to your Flask dev server (read-only menu API)
      '/public': {
        target: 'http://127.0.0.1:5055',
        changeOrigin: true,
        secure: false,
        configure: (proxy) => {
          proxy.on('proxyReq', (_req, req) =>
            console.log(`[vite-proxy] → ${req.method} ${req.url}`)
          )
          proxy.on('proxyRes', (res, req) =>
            console.log(`[vite-proxy] ← ${res.statusCode} ${req.method} ${req.url}`)
          )
        },
      },
      // Forward all /api/* calls to your Flask dev server
      '/api': {
        target: 'http://127.0.0.1:5055',
        changeOrigin: true,
        secure: false,
        configure: (proxy) => {
          proxy.on('proxyReq', (_req, req) =>
            console.log(`[vite-proxy] → ${req.method} ${req.url}`)
          )
          proxy.on('proxyRes', (res, req) =>
            console.log(`[vite-proxy] ← ${res.statusCode} ${req.method} ${req.url}`)
          )
        },
      },
    },
  },
  build: { target: 'esnext' },
})
