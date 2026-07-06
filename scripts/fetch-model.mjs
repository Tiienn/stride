#!/usr/bin/env node
// Fetch the trained plan-segmentation ONNX model into public/models/ (it
// lives in a GitHub release, not git — 31MB of weights don't belong in
// history), and stage onnxruntime-web's wasm runtime into public/ort/ so the
// browser can load it same-origin. Runs before `dev` and `build`; both steps
// are no-ops when already done.
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODEL_URL = 'https://github.com/tiienn/stride/releases/download/model-v2/stride-planseg.onnx'
const MODEL_PATH = join(root, 'public/models/stride-planseg.onnx')
const MODEL_MIN_BYTES = 25_000_000 // guard against committed HTML error pages

async function fetchModel() {
  if (existsSync(MODEL_PATH) && statSync(MODEL_PATH).size > MODEL_MIN_BYTES) return
  mkdirSync(dirname(MODEL_PATH), { recursive: true })
  console.log(`fetching plan-segmentation model → public/models/ …`)
  try {
    const res = await fetch(MODEL_URL, { redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < MODEL_MIN_BYTES) throw new Error(`suspiciously small (${buf.length} bytes)`)
    writeFileSync(MODEL_PATH, buf)
    console.log(`model ready (${(buf.length / 1e6).toFixed(1)} MB)`)
  } catch (err) {
    // Non-fatal: the app runs without the local model (Claude-only analysis).
    console.warn(`could not fetch model (${err.message}) — uploads will use Claude-only analysis`)
  }
}

function stageOrtWasm() {
  const src = join(root, 'node_modules/onnxruntime-web/dist')
  const dst = join(root, 'public/ort')
  mkdirSync(dst, { recursive: true })
  for (const f of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']) {
    const from = join(src, f)
    const to = join(dst, f)
    if (existsSync(from) && (!existsSync(to) || statSync(from).size !== statSync(to).size)) {
      copyFileSync(from, to)
    }
  }
}

await fetchModel()
stageOrtWasm()
