// vite.config.js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    proxy: {
      '/public': {
        target: 'https://pizzapepperspos.onrender.com',
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p, // keep /public path
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