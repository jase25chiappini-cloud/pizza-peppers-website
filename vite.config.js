import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")
  const RAW_KEY =
    env.PP_IMAGES_API_KEY ||
    env.PP_API_KEY ||
    env.VITE_PP_IMAGES_API_KEY ||
    env.VITE_PP_API_KEY ||
    ""
  const API_KEY = String(RAW_KEY)
    .replace(/^"(.*)"$/, "$1")
    .replace(/^'(.*)'$/, "$1")
    .replace(/\\\$/g, "$")
  console.log("[vite] X-API-Key length =", API_KEY.length)

  const TARGET =
    env.PP_PROXY_TARGET ||
    env.VITE_PP_PROXY_TARGET ||
    env.VITE_PP_RENDER_BASE_URL ||
    "https://pizzapepperspos.onrender.com"

  return {
    plugins: [react()],
    base: "./",
    server: {
      host: true,
      port: 5173,
      strictPort: false,
      headers: {},
      proxy: {
        "/pp-proxy": {
          target: TARGET,
          changeOrigin: true,
          secure: true,
          rewrite: (p) => p.replace(/^\/pp-proxy/, ""),
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              if (API_KEY) proxyReq.setHeader("X-API-Key", API_KEY)
              const sent = proxyReq.getHeader("X-API-Key")
              console.log(
                "[vite-proxy] ->",
                proxyReq.path,
                "X-API-Key len",
                String(sent || "").length,
              )
            })
            proxy.on("proxyRes", (proxyRes, req) => {
              proxyRes.headers["access-control-allow-origin"] = "*"
              proxyRes.headers["access-control-allow-credentials"] = "true"
              console.log("[vite-proxy] <-", proxyRes.statusCode, req.url)
            })
            proxy.on("error", (err, req) => {
              console.error("[vite-proxy] error", req.url, err.code || err.message)
            })
          },
        },
        "/public": {
          target: "http://localhost:5055",
          changeOrigin: true,
          secure: false,
        },
        "/api": {
          target: "http://127.0.0.1:5055",
          changeOrigin: true,
          secure: false,
          configure: (proxy) => {
            proxy.on("proxyReq", (_req, req) =>
              console.log(`[vite-proxy] ? ${req.method} ${req.url}`),
            )
            proxy.on("proxyRes", (res, req) =>
              console.log(`[vite-proxy] <- ${res.statusCode} ${req.method} ${req.url}`),
            )
          },
        },
      },
    },
    build: { target: "esnext" },
  }
})
