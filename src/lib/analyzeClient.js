// Client side of the analysis pipeline: image prep → /api/analyze → ScenePlan.
import { analysisToScenePlan } from './planProcess.js'

const MAX_DIM = 1568 // Claude vision sweet spot — larger adds tokens, not accuracy
const MIN_DIM = 1100 // below this, upscale: more visual tokens = thin walls survive
// Vercel serverless bodies cap at ~4.5MB; the refine pass sends image + JSON,
// so keep the encoded image comfortably under that.
const MAX_DATAURL = 3_500_000

export async function prepareImage(file) {
  const bitmap = await loadBitmap(file)
  const maxSide = Math.max(bitmap.width, bitmap.height)
  const scale = maxSide > MAX_DIM ? MAX_DIM / maxSide
    : maxSide < MIN_DIM ? Math.min(MAX_DIM / maxSide, 2.5)
    : 1
  const w = Math.round(bitmap.width * scale)
  const h = Math.round(bitmap.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.fillStyle = '#ffffff' // plans are often transparent PNGs/SVGs
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(bitmap, 0, 0, w, h)
  // Plans are line art: PNG keeps thin walls crisp where JPEG rings and
  // smears them — and mostly-white drawings compress small anyway. Fall back
  // to JPEG only when the PNG is too big (photos, scans).
  let dataUrl = canvas.toDataURL('image/png')
  let mediaType = 'image/png'
  if (dataUrl.length > MAX_DATAURL) {
    dataUrl = canvas.toDataURL('image/jpeg', 0.92)
    mediaType = 'image/jpeg'
  }
  return { base64: dataUrl.split(',')[1], mediaType, dataUrl, width: w, height: h }
}

async function loadBitmap(file) {
  if (typeof createImageBitmap === 'function' && !file.type.includes('svg')) {
    try {
      return await createImageBitmap(file)
    } catch {
      /* fall through to <img> path (svg, exotic formats) */
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    await img.decode()
    return img
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }
}

// Shown in sequence while the Claude call is in flight, so a 20-60s wait
// reads as progress instead of a frozen line.
const ANALYSIS_STAGES = [
  'Claude is reading the plan…',
  'Classifying it — floor plan, office or site…',
  'Tracing every wall, corner to corner…',
  'Finding doors, doorways and windows…',
  'Labeling the rooms…',
  'Reading printed dimensions to get the scale exactly right…',
  'Double-checking short walls that are easy to miss…',
  'Almost there — packaging the geometry…',
]

export async function analyzeUpload(file, onStatus, signal) {
  onStatus?.('Preparing image…')
  const prepped = await prepareImage(file)

  let stage = 0
  onStatus?.(ANALYSIS_STAGES[0])
  const rotate = setInterval(() => {
    stage = Math.min(stage + 1, ANALYSIS_STAGES.length - 1) // hold on the last line
    onStatus?.(ANALYSIS_STAGES[stage])
  }, 5000)

  let res
  try {
    res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: prepped.base64, mediaType: prepped.mediaType }),
      signal,
    })
  } finally {
    clearInterval(rotate)
  }
  const payload = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(payload.error || `Analysis failed (${res.status})`)
  if (!payload.analysis) throw new Error('The analyzer returned nothing usable.')

  let analysis = payload.analysis
  // Verification pass: Claude re-checks its own extraction against the image
  // and returns corrections (missed walls/doors/rooms, false walls, scale).
  // Interior plans only — that's where the wall/door errors live — and never
  // fatal: on any failure we build from the first pass.
  if (analysis.planType !== 'site') {
    try {
      onStatus?.('Cross-checking every wall and door against the drawing…')
      const res2 = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phase: 'refine',
          image: prepped.base64,
          mediaType: prepped.mediaType,
          analysis,
        }),
        signal,
      })
      const payload2 = await res2.json().catch(() => ({}))
      if (res2.ok && payload2.analysis) analysis = payload2.analysis
    } catch (err) {
      if (err?.name === 'AbortError') throw err
      // keep the first-pass analysis
    }
  }

  onStatus?.('Building the 3D world…')
  const plan = analysisToScenePlan(analysis)
  if (plan.planType !== 'site' && (!plan.walls?.length || !plan.rooms?.length)) {
    throw new Error(
      'No usable walls or rooms were detected. Try a clearer plan image — dark wall lines on a light background work best.'
    )
  }
  return { plan, preview: prepped.dataUrl }
}
