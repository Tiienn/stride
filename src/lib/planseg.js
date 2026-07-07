// In-browser plan segmentation: runs the trained U-Net (ONNX, ~31MB, fetched
// once and cached by the browser) on the uploaded plan and vectorizes the
// mask into analyzer-schema JSON. This gives instant, free, offline wall/
// door/window geometry; Claude supplies what pixels can't — room names,
// plan type, printed-dimension scale — and the two are merged in
// analyzeClient.js.
import { maskToAnalysis } from './maskVectorize.js'

const MODEL_URL = '/models/stride-planseg.onnx'
// ort's wasm runtime, staged into public/ort/ by scripts/fetch-model.mjs.
// The .mjs glue is fetched and imported via a blob URL: importing a
// public-dir module directly trips Vite's dev middleware, and letting the
// bundler own it crashes its dependency optimizer — blob: sidesteps both.
const ORT_WASM_URL = '/ort/ort-wasm-simd-threaded.wasm'
const ORT_MJS_URL = '/ort/ort-wasm-simd-threaded.mjs'
// U-Net has 4 pooling levels — inputs must be multiples of 16
const ALIGN = 16
// inference resolution cap: quality plateaus above this, wasm time doesn't
const MAX_INFER_DIM = 1280

let sessionPromise = null

async function getSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const ort = await import('onnxruntime-web/wasm')
      const mjsSource = await fetch(ORT_MJS_URL)
      if (!mjsSource.ok) throw new Error('ort runtime not deployed')
      const blob = new Blob([await mjsSource.text()], { type: 'text/javascript' })
      ort.env.wasm.wasmPaths = {
        wasm: new URL(ORT_WASM_URL, location.origin).href,
        mjs: URL.createObjectURL(blob),
      }
      // threads need cross-origin isolation headers; stay single-threaded
      // rather than silently failing on hosts without COOP/COEP
      ort.env.wasm.numThreads = 1
      const head = await fetch(MODEL_URL, { method: 'HEAD' })
      if (!head.ok) throw new Error('model not deployed')
      return { ort, session: await ort.InferenceSession.create(MODEL_URL, { executionProviders: ['wasm'] }) }
    })()
    sessionPromise.catch(() => { sessionPromise = null }) // allow retry
  }
  return sessionPromise
}

// dataUrl/canvas source → { data: Float32Array CHW, w, h, scale }
// Inference size comes from the image's OWN pixels (never upscale line art —
// bilinear blowups turn thin walls into gradients the net can't read);
// srcW/srcH only define the coordinate space the results are mapped into.
function preprocess(imageEl, srcW, srcH) {
  const natW = imageEl.naturalWidth || srcW
  const natH = imageEl.naturalHeight || srcH
  const f = Math.min(1, MAX_INFER_DIM / Math.max(natW, natH))
  const w = Math.round((natW * f) / ALIGN) * ALIGN || ALIGN
  const h = Math.round((natH * f) / ALIGN) * ALIGN || ALIGN
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(imageEl, 0, 0, w, h)
  const { data: rgba } = ctx.getImageData(0, 0, w, h)
  const chw = new Float32Array(3 * w * h)
  const plane = w * h
  for (let i = 0; i < plane; i++) {
    chw[i] = rgba[i * 4] / 255
    chw[plane + i] = rgba[i * 4 + 1] / 255
    chw[2 * plane + i] = rgba[i * 4 + 2] / 255
  }
  return { data: chw, w, h, scaleX: srcW / w, scaleY: srcH / h }
}

// Returns analyzer-schema JSON (coords in the ORIGINAL image's pixel space),
// or null when the model isn't available / fails — callers fall back to
// Claude-only analysis.
export async function segmentPlanImage(dataUrl, srcW, srcH) {
  try {
    const { ort, session } = await getSession()
    const img = new Image()
    img.src = dataUrl
    await img.decode()
    const t0 = performance.now()
    const { data, w, h, scaleX, scaleY } = preprocess(img, srcW, srcH)
    const output = await session.run({ image: new ort.Tensor('float32', data, [1, 3, h, w]) })
    const logits = output.logits.data // [1,4,h,w]
    const plane = w * h
    const classes = new Uint8Array(plane)
    for (let i = 0; i < plane; i++) {
      let best = 0
      let bestV = logits[i]
      for (let c = 1; c < 4; c++) {
        const v = logits[c * plane + i]
        if (v > bestV) { bestV = v; best = c }
      }
      classes[i] = best
    }
    const analysis = maskToAnalysis(classes, w, h)
    // map back to the original image's pixel space so Claude's room centers
    // (computed on the same original) line up with the model's walls
    for (const wall of analysis.walls) {
      wall.start.x *= scaleX; wall.start.y *= scaleY
      wall.end.x *= scaleX; wall.end.y *= scaleY
      wall.thickness *= (scaleX + scaleY) / 2
    }
    for (const o of [...analysis.doors, ...analysis.windows]) {
      o.center.x *= scaleX
      o.center.y *= scaleY
      o.width *= (scaleX + scaleY) / 2
    }
    analysis.imageSize = { width: srcW, height: srcH }
    analysis.inferenceMs = Math.round(performance.now() - t0)
    return analysis
  } catch (err) {
    console.warn('local plan segmentation unavailable:', err?.message || err)
    return null
  }
}

// A usable geometry extraction has a closed-ish set of walls and at least one
// way through them. Below this, Claude-only analysis is the better bet.
export function isUsableGeometry(analysis) {
  return !!analysis && analysis.walls.length >= 6 && analysis.doors.length >= 1
}
