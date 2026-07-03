// Vercel serverless function — thin wrapper around the shared analysis logic.
import { analyzePlanImage } from '../server/planAnalysis.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  try {
    const result = await analyzePlanImage(req.body, {
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL,
    })
    res.status(200).json(result)
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'Analysis failed' })
  }
}
