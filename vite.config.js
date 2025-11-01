// vite.config.js
import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const TARGET = 'https://pizzapepperspos.onrender.com'

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    host: true,
    port: 5173,
    strictPort: false,
    proxy: {
      // All frontend calls to /pp-proxy/* get proxied to Render
      '/pp-proxy': {
        target: TARGET,
        changeOrigin: true,
        secure: true,
        ws: false,
        proxyTimeout: 30_000,
        timeout: 30_000,
        rewrite: (p) => p.replace(/^\/pp-proxy/, ''),
        configure: (proxy /*, options*/) => {
          proxy.on('error', (err, req, res) => {
            console.error('[vite-proxy] error:', err?.message || err)
            try {
              res.writeHead?.(502, { 'Content-Type': 'application/json' })
              res.end?.(JSON.stringify({ error: 'Proxy error', detail: String(err?.message || err) }))
            } catch {}
          })
          proxy.on('proxyReq', (proxyReq, req) => {
            console.log(`[vite-proxy] → ${TARGET}${req.url}`)
            proxyReq.setHeader('Origin', TARGET)
            proxyReq.setHeader('Referer', TARGET + '/')
          })
          proxy.on('proxyRes', (proxyRes, req) => {
            console.log(`[vite-proxy] ← ${proxyRes.statusCode} ${req.url}`)
          })
        }
      },
      '/public': {
        target: 'http://localhost:5055',
        changeOrigin: true,
        secure: false,
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
