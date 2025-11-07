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
    headers: {
      // No COOP/COEP in dev so auth popups keep the same browsing context
    },
    proxy: {
      // All frontend calls to /pp-proxy/* get proxied to Render
      '/pp-proxy': {
        target: TARGET,
        changeOrigin: true,
        secure: false,
        rewrite: (p) => p.replace(/^\/pp-proxy/, ''),
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes, req) => {
            // Allow Vite origin during dev
            proxyRes.headers['access-control-allow-origin'] = '*';
            proxyRes.headers['access-control-allow-credentials'] = 'true';
            console.log('[vite-proxy] ←', proxyRes.statusCode, req.url)
          });
          proxy.on('proxyReq', (_, req) => {
            console.log('[vite-proxy] →', req.url)
          });
          proxy.on('error', (err, req) => {
            console.error('[vite-proxy] error', req.url, err.code || err.message)
          });
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
