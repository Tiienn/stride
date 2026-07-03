import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Dev-only middleware that serves the same /api/analyze endpoint Vercel
// serves in production, so local dev and deploys behave identically.
function apiDevPlugin(env) {
  return {
    name: 'stride-api-dev',
    configureServer(server) {
      server.middlewares.use('/api/analyze', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ error: 'POST only' }))
          return
        }
        try {
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          const { analyzePlanImage } = await server.ssrLoadModule('/server/planAnalysis.js')
          const result = await analyzePlanImage(body, {
            apiKey: env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY,
            model: env.ANTHROPIC_MODEL || process.env.ANTHROPIC_MODEL,
          })
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(result))
        } catch (err) {
          res.statusCode = err.statusCode || 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: err.message || 'Analysis failed' }))
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), apiDevPlugin(env)],
    server: { port: 5183 },
  }
})
